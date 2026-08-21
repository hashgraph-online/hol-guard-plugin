using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.SemanticKernel;

namespace HolGuard.SemanticKernel;

public enum HolGuardAction
{
    Allow,
    Review,
    Deny,
}

public sealed record HolGuardDecision(HolGuardAction Action, string Reason = "");

public sealed record HolGuardBlockedResult(
    bool Blocked,
    string Action,
    string Reason,
    string ToolName);

public sealed record HolGuardReviewRequest(
    string ToolName,
    IReadOnlyDictionary<string, object?> Arguments,
    string Reason);

public sealed record HolGuardOptions
{
    public string Executable { get; init; } = "hol-guard";
    public string? Workspace { get; init; }
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(5);
}

public sealed class HolGuardUnavailableException : Exception
{
    public HolGuardUnavailableException(string message) : base(message) { }
    public HolGuardUnavailableException(string message, Exception innerException) : base(message, innerException) { }
}

public interface IHolGuardDecisionProvider
{
    Task<HolGuardDecision> EvaluateAsync(
        string toolName,
        IReadOnlyDictionary<string, object?> arguments,
        CancellationToken cancellationToken = default);
}

public interface IHolGuardApprovalHandler
{
    Task<bool> ApproveAsync(HolGuardReviewRequest request, CancellationToken cancellationToken = default);
}

public sealed class CliHolGuardDecisionProvider : IHolGuardDecisionProvider
{
    private readonly HolGuardOptions _options;

    public CliHolGuardDecisionProvider(HolGuardOptions? options = null)
    {
        _options = options ?? new HolGuardOptions();
        if (_options.Timeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "HOL Guard timeout must be positive.");
        }
    }

    public async Task<HolGuardDecision> EvaluateAsync(
        string toolName,
        IReadOnlyDictionary<string, object?> arguments,
        CancellationToken cancellationToken = default)
    {
        var payload = new Dictionary<string, object?>
        {
            ["hook_event_name"] = "PreToolUse",
            ["tool_name"] = toolName,
            ["tool_input"] = arguments,
            ["source_scope"] = string.IsNullOrWhiteSpace(_options.Workspace) ? "global" : "project",
            ["framework"] = "semantic-kernel",
        };

        string serialized;
        try
        {
            serialized = JsonSerializer.Serialize(payload);
        }
        catch (Exception ex) when (ex is JsonException or NotSupportedException)
        {
            throw new HolGuardUnavailableException(
                "HOL Guard decision unavailable: Semantic Kernel arguments are not JSON serializable.", ex);
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = _options.Executable,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add("guard");
        startInfo.ArgumentList.Add("hook");
        startInfo.ArgumentList.Add("--harness");
        startInfo.ArgumentList.Add("semantic-kernel");
        if (!string.IsNullOrWhiteSpace(_options.Workspace))
        {
            startInfo.ArgumentList.Add("--workspace");
            startInfo.ArgumentList.Add(Path.GetFullPath(_options.Workspace));
        }
        startInfo.ArgumentList.Add("--json");

        using var process = new Process { StartInfo = startInfo };
        try
        {
            if (!process.Start())
            {
                throw new HolGuardUnavailableException("HOL Guard decision unavailable: process did not start.");
            }
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            throw new HolGuardUnavailableException($"HOL Guard decision unavailable: {ex.Message}", ex);
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.StandardInput.WriteAsync(serialized.AsMemory(), cancellationToken);
        await process.StandardInput.FlushAsync(cancellationToken);
        process.StandardInput.Close();

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(_options.Timeout);
        try
        {
            await process.WaitForExitAsync(timeoutCts.Token);
        }
        catch (OperationCanceledException ex) when (!cancellationToken.IsCancellationRequested)
        {
            TryKill(process);
            throw new HolGuardUnavailableException(
                $"HOL Guard decision unavailable: timed out after {_options.Timeout.TotalSeconds:0.###}s.", ex);
        }

        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        var decision = ParseDecision(stdout);

        if (decision.Action == HolGuardAction.Allow && process.ExitCode != 0)
        {
            var detail = string.IsNullOrWhiteSpace(stderr) ? $"exit status {process.ExitCode}" : stderr.Trim();
            throw new HolGuardUnavailableException(
                $"HOL Guard allow decision rejected because the process exited non-zero: {detail}");
        }

        return decision;
    }

    private static HolGuardDecision ParseDecision(string stdout)
    {
        var lines = stdout.Split(
            '\n',
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var candidates = new List<string>(lines.Length + 1) { stdout.Trim() };
        for (var index = lines.Length - 1; index >= 0; index--)
        {
            candidates.Add(lines[index]);
        }

        foreach (var candidate in candidates)
        {
            if (!candidate.StartsWith('{'))
            {
                continue;
            }

            try
            {
                using var document = JsonDocument.Parse(candidate);
                if (document.RootElement.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var root = document.RootElement;
                var reason = FirstString(root, "reason", "stopReason", "review_hint", "systemMessage", "message", "error");

                if (TryBoolean(root, "blocked", out var blocked) && blocked)
                {
                    return new(HolGuardAction.Deny, reason);
                }
                if (TryBoolean(root, "continue", out var shouldContinue) && !shouldContinue)
                {
                    return new(HolGuardAction.Deny, reason);
                }

                var policyAction = FirstString(root, "policy_action", "policyAction").ToLowerInvariant();
                if (policyAction is "allow" or "warn") return new(HolGuardAction.Allow, reason);
                if (policyAction is "review" or "require-reapproval") return new(HolGuardAction.Review, reason);
                if (policyAction is "block" or "sandbox-required") return new(HolGuardAction.Deny, reason);

                var decision = FirstString(root, "decision").ToLowerInvariant();
                if (decision is "allow" or "warn") return new(HolGuardAction.Allow, reason);
                if (decision is "ask" or "review") return new(HolGuardAction.Review, reason);
                if (decision is "deny" or "block") return new(HolGuardAction.Deny, reason);

                if (root.TryGetProperty("hookSpecificOutput", out var hook) && hook.ValueKind == JsonValueKind.Object)
                {
                    var hookReason = FirstString(hook, "permissionDecisionReason", "additionalContext");
                    if (!string.IsNullOrWhiteSpace(hookReason)) reason = hookReason;
                    var permission = FirstString(hook, "permissionDecision").ToLowerInvariant();
                    if (permission == "allow") return new(HolGuardAction.Allow, reason);
                    if (permission == "ask") return new(HolGuardAction.Review, reason);
                    if (permission == "deny") return new(HolGuardAction.Deny, reason);
                }
            }
            catch (JsonException)
            {
                // Continue to the next candidate. HOL Guard may emit non-JSON diagnostic lines first.
            }
        }

        throw new HolGuardUnavailableException("HOL Guard returned no unambiguous tool decision.");
    }

    private static string FirstString(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
            {
                var text = value.GetString();
                if (!string.IsNullOrWhiteSpace(text)) return text.Trim();
            }
        }
        return string.Empty;
    }

    private static bool TryBoolean(JsonElement element, string name, out bool value)
    {
        value = false;
        if (!element.TryGetProperty(name, out var property)
            || (property.ValueKind != JsonValueKind.True && property.ValueKind != JsonValueKind.False))
        {
            return false;
        }

        value = property.GetBoolean();
        return true;
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch
        {
            // Best-effort cleanup only; the caller still receives a fail-closed unavailable decision.
        }
    }
}

public sealed class HolGuardFunctionInvocationFilter : IFunctionInvocationFilter
{
    private readonly IHolGuardDecisionProvider _decisionProvider;
    private readonly IHolGuardApprovalHandler? _approvalHandler;

    public HolGuardFunctionInvocationFilter(
        IHolGuardDecisionProvider decisionProvider,
        IHolGuardApprovalHandler? approvalHandler = null)
    {
        _decisionProvider = decisionProvider ?? throw new ArgumentNullException(nameof(decisionProvider));
        _approvalHandler = approvalHandler;
    }

    public async Task OnFunctionInvocationAsync(
        FunctionInvocationContext context,
        Func<FunctionInvocationContext, Task> next)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(next);

        var toolName = string.IsNullOrWhiteSpace(context.Function.PluginName)
            ? context.Function.Name
            : $"{context.Function.PluginName}.{context.Function.Name}";
        var arguments = context.Arguments.ToDictionary(pair => pair.Key, pair => pair.Value);

        HolGuardDecision decision;
        try
        {
            decision = await _decisionProvider.EvaluateAsync(toolName, arguments).ConfigureAwait(false);
        }
        catch (HolGuardUnavailableException ex)
        {
            Block(context, toolName, "unavailable", ex.Message);
            return;
        }

        if (decision.Action == HolGuardAction.Allow)
        {
            await next(context).ConfigureAwait(false);
            return;
        }

        if (decision.Action == HolGuardAction.Review)
        {
            var approved = _approvalHandler is not null
                && await _approvalHandler.ApproveAsync(
                    new HolGuardReviewRequest(toolName, arguments, decision.Reason)).ConfigureAwait(false);
            if (approved)
            {
                await next(context).ConfigureAwait(false);
                return;
            }

            Block(context, toolName, "review", decision.Reason.Length > 0 ? decision.Reason : "HOL Guard requires approval.");
            return;
        }

        Block(context, toolName, "deny", decision.Reason.Length > 0 ? decision.Reason : "HOL Guard denied the function invocation.");
    }

    private static void Block(FunctionInvocationContext context, string toolName, string action, string reason)
    {
        context.Result = new FunctionResult(
            context.Result,
            new HolGuardBlockedResult(true, action, reason, toolName));
    }
}

public static class HolGuardSemanticKernelExtensions
{
    public static IKernelBuilder AddHolGuard(
        this IKernelBuilder builder,
        HolGuardOptions? options = null,
        IHolGuardApprovalHandler? approvalHandler = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var provider = new CliHolGuardDecisionProvider(options);
        builder.Services.AddSingleton<IFunctionInvocationFilter>(
            new HolGuardFunctionInvocationFilter(provider, approvalHandler));
        return builder;
    }
}
