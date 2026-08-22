package org.hashgraphonline.guard.springai;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;

import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.model.tool.ToolCallingChatOptions;
import org.springframework.ai.model.tool.ToolCallingManager;
import org.springframework.ai.model.tool.ToolExecutionResult;
import org.springframework.ai.tool.definition.ToolDefinition;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * A provider-neutral Spring AI {@link ToolCallingManager} decorator that evaluates every
 * requested tool call with HOL Guard before delegating any execution.
 *
 * <p>The wrapper deliberately preflights the entire tool-call batch before invoking the
 * delegate. A deny, review, malformed decision, timeout, process failure, or provider
 * exception therefore produces zero downstream tool execution.</p>
 */
public final class HolGuardToolCallingManager implements ToolCallingManager {

    public enum Action { ALLOW, DENY, REVIEW }

    public record GuardDecision(Action action) {
        public GuardDecision {
            Objects.requireNonNull(action, "action");
        }
        public static GuardDecision allow() { return new GuardDecision(Action.ALLOW); }
        public static GuardDecision deny() { return new GuardDecision(Action.DENY); }
        public static GuardDecision review() { return new GuardDecision(Action.REVIEW); }
    }

    public record ToolCallContext(String toolName, String argumentsJson, String toolCallId) {
        public ToolCallContext {
            if (toolName == null || toolName.isBlank()) {
                throw new IllegalArgumentException("toolName must not be blank");
            }
            argumentsJson = (argumentsJson == null || argumentsJson.isBlank()) ? "{}" : argumentsJson;
        }
    }

    @FunctionalInterface
    public interface GuardDecisionProvider {
        GuardDecision evaluate(ToolCallContext context);
    }

    public static class HolGuardDeniedException extends RuntimeException {
        public HolGuardDeniedException(String message) { super(message); }
    }

    public static final class HolGuardReviewRequiredException extends HolGuardDeniedException {
        public HolGuardReviewRequiredException(String message) { super(message); }
    }

    public static final class HolGuardUnavailableException extends HolGuardDeniedException {
        public HolGuardUnavailableException(String message) { super(message); }
        public HolGuardUnavailableException(String message, Throwable cause) { super(message); initCause(cause); }
    }

    private final ToolCallingManager delegate;
    private final GuardDecisionProvider decisionProvider;

    public HolGuardToolCallingManager(ToolCallingManager delegate, GuardDecisionProvider decisionProvider) {
        this.delegate = Objects.requireNonNull(delegate, "delegate");
        this.decisionProvider = Objects.requireNonNull(decisionProvider, "decisionProvider");
    }

    public static HolGuardToolCallingManager local(ToolCallingManager delegate) {
        return new HolGuardToolCallingManager(delegate,
                new CliGuardDecisionProvider(null, Duration.ofSeconds(5), "hol-guard"));
    }

    public static HolGuardToolCallingManager local(ToolCallingManager delegate, Path workspace) {
        return new HolGuardToolCallingManager(delegate,
                new CliGuardDecisionProvider(workspace, Duration.ofSeconds(5), "hol-guard"));
    }

    @Override
    public List<ToolDefinition> resolveToolDefinitions(ToolCallingChatOptions chatOptions) {
        return this.delegate.resolveToolDefinitions(chatOptions);
    }

    @Override
    public ToolExecutionResult executeToolCalls(Prompt prompt, ChatResponse chatResponse) {
        Objects.requireNonNull(prompt, "prompt");
        Objects.requireNonNull(chatResponse, "chatResponse");

        AssistantMessage message = chatResponse.getResults().stream()
                .map(generation -> generation.getOutput())
                .filter(AssistantMessage::hasToolCalls)
                .findFirst()
                .orElse(null);

        // Preserve the delegate's native error/empty-call behavior when there is no call
        // to gate. No side effect can occur before this delegation.
        if (message == null) {
            return this.delegate.executeToolCalls(prompt, chatResponse);
        }

        // Preflight the whole batch first so a later denied call cannot arrive after an
        // earlier tool has already produced a side effect.
        for (AssistantMessage.ToolCall toolCall : message.getToolCalls()) {
            ToolCallContext context = new ToolCallContext(toolCall.name(), toolCall.arguments(), toolCall.id());
            final GuardDecision decision;
            try {
                decision = this.decisionProvider.evaluate(context);
            }
            catch (HolGuardDeniedException ex) {
                throw ex;
            }
            catch (RuntimeException ex) {
                throw new HolGuardUnavailableException("HOL Guard decision provider failed closed", ex);
            }
            enforce(decision, context.toolName());
        }

        return this.delegate.executeToolCalls(prompt, chatResponse);
    }

    private static void enforce(GuardDecision decision, String toolName) {
        if (decision == null) {
            throw new HolGuardUnavailableException("HOL Guard returned no decision for tool: " + toolName);
        }
        switch (decision.action()) {
            case ALLOW -> { }
            case REVIEW -> throw new HolGuardReviewRequiredException(
                    "HOL Guard requires approval before Spring AI tool execution: " + toolName);
            case DENY -> throw new HolGuardDeniedException(
                    "HOL Guard denied Spring AI tool execution: " + toolName);
        }
    }

    /**
     * Local-only CLI bridge. It sends a bounded generic PreToolUse envelope to HOL Guard
     * and never requires Guard Cloud credentials.
     */
    public static final class CliGuardDecisionProvider implements GuardDecisionProvider {
        private static final int MAX_PAYLOAD_BYTES = 24 * 1024;
        private static final Duration MAX_TIMEOUT = Duration.ofSeconds(10);

        private final Path workspace;
        private final Duration timeout;
        private final String executable;
        private final ObjectMapper mapper = new ObjectMapper();

        public CliGuardDecisionProvider(Path workspace, Duration timeout, String executable) {
            if (timeout == null || timeout.isZero() || timeout.isNegative() || timeout.compareTo(MAX_TIMEOUT) > 0) {
                throw new IllegalArgumentException("timeout must be > 0 and <= 10 seconds");
            }
            if (executable == null || executable.isBlank()) {
                throw new IllegalArgumentException("executable must not be blank");
            }
            this.workspace = workspace;
            this.timeout = timeout;
            this.executable = executable;
        }

        @Override
        public GuardDecision evaluate(ToolCallContext context) {
            final String serialized;
            try {
                JsonNode toolInput = this.mapper.readTree(context.argumentsJson());
                if (toolInput == null || !toolInput.isObject()) {
                    throw new HolGuardUnavailableException("Spring AI tool arguments are not a JSON object");
                }

                ObjectNode payload = this.mapper.createObjectNode();
                payload.put("hook_event_name", "PreToolUse");
                payload.put("tool_name", context.toolName());
                payload.set("tool_input", toolInput);
                payload.put("source_scope", this.workspace == null ? "global" : "project");
                payload.put("framework", "spring-ai");
                if (context.toolCallId() != null && !context.toolCallId().isBlank()) {
                    payload.putObject("framework_context").put("tool_call_id", context.toolCallId());
                }
                serialized = this.mapper.writeValueAsString(payload);
            }
            catch (HolGuardUnavailableException ex) {
                throw ex;
            }
            catch (Exception ex) {
                throw new HolGuardUnavailableException("Unable to serialize bounded HOL Guard request", ex);
            }

            if (serialized.getBytes(StandardCharsets.UTF_8).length > MAX_PAYLOAD_BYTES) {
                throw new HolGuardUnavailableException("HOL Guard request exceeds the 24 KiB adapter limit");
            }

            List<String> command = new ArrayList<>();
            command.add(this.executable);
            command.add("guard");
            command.add("hook");
            command.add("--harness");
            command.add("generic");
            if (this.workspace != null) {
                command.add("--workspace");
                command.add(this.workspace.toAbsolutePath().normalize().toString());
            }
            command.add("--json");

            final Process process;
            try {
                process = new ProcessBuilder(command).redirectErrorStream(true).start();
            }
            catch (IOException ex) {
                throw new HolGuardUnavailableException("HOL Guard process could not start", ex);
            }

            CompletableFuture<String> outputFuture = CompletableFuture.supplyAsync(() -> {
                try {
                    return new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
                }
                catch (IOException ex) {
                    throw new CompletionException(ex);
                }
            });

            try (var stdin = process.getOutputStream()) {
                stdin.write(serialized.getBytes(StandardCharsets.UTF_8));
            }
            catch (IOException ex) {
                process.destroyForcibly();
                throw new HolGuardUnavailableException("HOL Guard request write failed", ex);
            }

            try {
                if (!process.waitFor(this.timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                    process.destroyForcibly();
                    throw new HolGuardUnavailableException("HOL Guard decision timed out");
                }
                String output = outputFuture.get(1, TimeUnit.SECONDS);
                JsonNode response = lastJsonObject(output);
                if (response == null) {
                    throw new HolGuardUnavailableException("HOL Guard returned no structured decision");
                }
                GuardDecision decision = classify(response);
                if (decision.action() == Action.ALLOW && process.exitValue() != 0) {
                    throw new HolGuardUnavailableException("HOL Guard allow decision exited non-zero");
                }
                return decision;
            }
            catch (HolGuardUnavailableException ex) {
                throw ex;
            }
            catch (Exception ex) {
                process.destroyForcibly();
                throw new HolGuardUnavailableException("HOL Guard decision failed closed", ex);
            }
        }

        private JsonNode lastJsonObject(String output) {
            if (output == null || output.isBlank()) {
                return null;
            }
            String[] lines = output.split("\\R");
            for (int i = lines.length - 1; i >= 0; i--) {
                String candidate = lines[i].trim();
                if (!candidate.startsWith("{")) {
                    continue;
                }
                try {
                    JsonNode node = this.mapper.readTree(candidate);
                    if (node != null && node.isObject()) {
                        return node;
                    }
                }
                catch (Exception ignored) {
                    // Try earlier output lines. Do not surface raw process output.
                }
            }
            return null;
        }

        private static GuardDecision classify(JsonNode payload) {
            if (payload.path("blocked").asBoolean(false)
                    || (payload.path("continue").isBoolean() && !payload.path("continue").asBoolean())) {
                return GuardDecision.deny();
            }

            String policyAction = text(payload, "policy_action", "policyAction");
            if (policyAction != null) {
                GuardDecision decision = classifyText(policyAction);
                if (decision != null) return decision;
            }

            String decisionText = text(payload, "decision");
            if (decisionText != null) {
                GuardDecision decision = classifyText(decisionText);
                if (decision != null) return decision;
            }

            JsonNode hook = payload.path("hookSpecificOutput");
            if (hook.isObject()) {
                String permission = text(hook, "permissionDecision");
                if (permission != null) {
                    GuardDecision decision = classifyText(permission);
                    if (decision != null) return decision;
                }
            }

            throw new HolGuardUnavailableException("HOL Guard returned no unambiguous tool decision");
        }

        private static GuardDecision classifyText(String value) {
            return switch (value.trim().toLowerCase(Locale.ROOT)) {
                case "allow", "warn" -> GuardDecision.allow();
                case "ask", "review", "require-reapproval" -> GuardDecision.review();
                case "deny", "block", "sandbox-required" -> GuardDecision.deny();
                default -> null;
            };
        }

        private static String text(JsonNode node, String... keys) {
            for (String key : keys) {
                JsonNode value = node.path(key);
                if (value.isTextual() && !value.asText().isBlank()) {
                    return value.asText();
                }
            }
            return null;
        }
    }
}
