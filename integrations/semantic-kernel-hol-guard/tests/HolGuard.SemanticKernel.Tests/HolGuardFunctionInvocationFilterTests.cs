using HolGuard.SemanticKernel;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.SemanticKernel;
using Xunit;

namespace HolGuard.SemanticKernel.Tests;

public sealed class HolGuardFunctionInvocationFilterTests
{
    [Fact]
    public async Task AllowInvokesFunctionExactlyOnce()
    {
        var calls = 0;
        var kernel = BuildKernel(new StaticDecisionProvider(new(HolGuardAction.Allow)));
        var function = KernelFunctionFactory.CreateFromMethod(() => ++calls, functionName: "write_file");

        var result = await kernel.InvokeAsync(function);

        Assert.Equal(1, calls);
        Assert.Equal(1, result.GetValue<int>());
    }

    [Fact]
    public async Task DenyPreventsFunctionExecution()
    {
        var calls = 0;
        var kernel = BuildKernel(new StaticDecisionProvider(new(HolGuardAction.Deny, "destructive command")));
        var function = KernelFunctionFactory.CreateFromMethod(() => ++calls, functionName: "delete_workspace");

        var result = await kernel.InvokeAsync(function);
        var blocked = result.GetValue<HolGuardBlockedResult>();

        Assert.Equal(0, calls);
        Assert.NotNull(blocked);
        Assert.True(blocked.Blocked);
        Assert.Equal("deny", blocked.Action);
        Assert.Equal("destructive command", blocked.Reason);
        Assert.Equal("delete_workspace", blocked.ToolName);
    }

    [Fact]
    public async Task ReviewWithoutApprovalHandlerFailsClosed()
    {
        var calls = 0;
        var kernel = BuildKernel(new StaticDecisionProvider(new(HolGuardAction.Review, "needs human approval")));
        var function = KernelFunctionFactory.CreateFromMethod(() => ++calls, functionName: "deploy");

        var result = await kernel.InvokeAsync(function);
        var blocked = result.GetValue<HolGuardBlockedResult>();

        Assert.Equal(0, calls);
        Assert.NotNull(blocked);
        Assert.Equal("review", blocked.Action);
    }

    [Fact]
    public async Task ReviewWithApprovalHandlerContinues()
    {
        var calls = 0;
        var kernel = BuildKernel(
            new StaticDecisionProvider(new(HolGuardAction.Review, "needs approval")),
            new StaticApprovalHandler(true));
        var function = KernelFunctionFactory.CreateFromMethod(() => ++calls, functionName: "deploy");

        await kernel.InvokeAsync(function);

        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task GuardUnavailableFailsClosedWithoutLeakingDiagnosticDetails()
    {
        var calls = 0;
        var kernel = BuildKernel(new ThrowingDecisionProvider());
        var function = KernelFunctionFactory.CreateFromMethod(() => ++calls, functionName: "shell");

        var result = await kernel.InvokeAsync(function);
        var blocked = result.GetValue<HolGuardBlockedResult>();

        Assert.Equal(0, calls);
        Assert.NotNull(blocked);
        Assert.Equal("unavailable", blocked.Action);
        Assert.Equal("HOL Guard is unavailable; function execution was blocked.", blocked.Reason);
        Assert.DoesNotContain("secret-path", blocked.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task UnexpectedProviderErrorFailsClosedBeforeFunctionExecution()
    {
        var calls = 0;
        var kernel = BuildKernel(new UnexpectedThrowingDecisionProvider());
        var function = KernelFunctionFactory.CreateFromMethod(() => ++calls, functionName: "shell");

        var result = await kernel.InvokeAsync(function);
        var blocked = result.GetValue<HolGuardBlockedResult>();

        Assert.Equal(0, calls);
        Assert.NotNull(blocked);
        Assert.Equal("unavailable", blocked.Action);
        Assert.Equal("HOL Guard is unavailable; function execution was blocked.", blocked.Reason);
    }

    [Fact]
    public async Task ApprovalHandlerErrorFailsClosedBeforeFunctionExecution()
    {
        var calls = 0;
        var kernel = BuildKernel(
            new StaticDecisionProvider(new(HolGuardAction.Review, "needs approval")),
            new ThrowingApprovalHandler());
        var function = KernelFunctionFactory.CreateFromMethod(() => ++calls, functionName: "deploy");

        var result = await kernel.InvokeAsync(function);
        var blocked = result.GetValue<HolGuardBlockedResult>();

        Assert.Equal(0, calls);
        Assert.NotNull(blocked);
        Assert.Equal("unavailable", blocked.Action);
        Assert.Equal("HOL Guard approval is unavailable; function execution was blocked.", blocked.Reason);
    }

    [Fact]
    public async Task FilterPassesFunctionNameArgumentsAndCancellationTokenToGuard()
    {
        var provider = new CapturingDecisionProvider();
        var kernel = BuildKernel(provider);
        var function = KernelFunctionFactory.CreateFromMethod(
            (string path, string content) => $"{path}:{content}",
            functionName: "write_file");
        var arguments = new KernelArguments
        {
            ["path"] = "/tmp/demo.txt",
            ["content"] = "hello",
        };
        using var cancellationSource = new CancellationTokenSource();

        await kernel.InvokeAsync(function, arguments, cancellationSource.Token);

        Assert.Equal("write_file", provider.ToolName);
        Assert.Equal("/tmp/demo.txt", provider.Arguments!["path"]);
        Assert.Equal("hello", provider.Arguments["content"]);
        Assert.Equal(cancellationSource.Token, provider.CancellationToken);
    }

    private static Kernel BuildKernel(
        IHolGuardDecisionProvider provider,
        IHolGuardApprovalHandler? approvalHandler = null)
    {
        var builder = Kernel.CreateBuilder();
        builder.Services.AddSingleton<IFunctionInvocationFilter>(
            new HolGuardFunctionInvocationFilter(provider, approvalHandler));
        return builder.Build();
    }

    private sealed class StaticDecisionProvider(HolGuardDecision decision) : IHolGuardDecisionProvider
    {
        public Task<HolGuardDecision> EvaluateAsync(
            string toolName,
            IReadOnlyDictionary<string, object?> arguments,
            CancellationToken cancellationToken = default) => Task.FromResult(decision);
    }

    private sealed class ThrowingDecisionProvider : IHolGuardDecisionProvider
    {
        public Task<HolGuardDecision> EvaluateAsync(
            string toolName,
            IReadOnlyDictionary<string, object?> arguments,
            CancellationToken cancellationToken = default) =>
            throw new HolGuardUnavailableException("HOL Guard failed at /secret-path/internal.sock");
    }

    private sealed class UnexpectedThrowingDecisionProvider : IHolGuardDecisionProvider
    {
        public Task<HolGuardDecision> EvaluateAsync(
            string toolName,
            IReadOnlyDictionary<string, object?> arguments,
            CancellationToken cancellationToken = default) =>
            throw new IOException("unexpected provider failure");
    }

    private sealed class CapturingDecisionProvider : IHolGuardDecisionProvider
    {
        public string? ToolName { get; private set; }
        public IReadOnlyDictionary<string, object?>? Arguments { get; private set; }
        public CancellationToken CancellationToken { get; private set; }

        public Task<HolGuardDecision> EvaluateAsync(
            string toolName,
            IReadOnlyDictionary<string, object?> arguments,
            CancellationToken cancellationToken = default)
        {
            ToolName = toolName;
            Arguments = arguments;
            CancellationToken = cancellationToken;
            return Task.FromResult(new HolGuardDecision(HolGuardAction.Allow));
        }
    }

    private sealed class StaticApprovalHandler(bool approved) : IHolGuardApprovalHandler
    {
        public Task<bool> ApproveAsync(
            HolGuardReviewRequest request,
            CancellationToken cancellationToken = default) => Task.FromResult(approved);
    }

    private sealed class ThrowingApprovalHandler : IHolGuardApprovalHandler
    {
        public Task<bool> ApproveAsync(
            HolGuardReviewRequest request,
            CancellationToken cancellationToken = default) =>
            throw new IOException("approval backend unavailable");
    }
}
