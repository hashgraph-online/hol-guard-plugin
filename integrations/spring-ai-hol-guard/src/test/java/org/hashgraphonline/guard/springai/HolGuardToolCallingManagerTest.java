package org.hashgraphonline.guard.springai;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.Test;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.model.Generation;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.model.tool.ToolCallingChatOptions;
import org.springframework.ai.model.tool.ToolCallingManager;
import org.springframework.ai.model.tool.ToolExecutionResult;
import org.springframework.ai.tool.definition.ToolDefinition;

class HolGuardToolCallingManagerTest {

    @Test
    void denyProducesZeroDownstreamExecution() {
        CountingDelegate delegate = new CountingDelegate();
        HolGuardToolCallingManager guarded = new HolGuardToolCallingManager(delegate, ctx -> HolGuardToolCallingManager.GuardDecision.deny());

        assertThrows(HolGuardToolCallingManager.HolGuardDeniedException.class,
                () -> guarded.executeToolCalls(new Prompt("test"), response(call("danger"))));
        assertEquals(0, delegate.executions.get());
    }

    @Test
    void reviewProducesZeroDownstreamExecution() {
        CountingDelegate delegate = new CountingDelegate();
        HolGuardToolCallingManager guarded = new HolGuardToolCallingManager(delegate, ctx -> HolGuardToolCallingManager.GuardDecision.review());

        assertThrows(HolGuardToolCallingManager.HolGuardReviewRequiredException.class,
                () -> guarded.executeToolCalls(new Prompt("test"), response(call("sensitive"))));
        assertEquals(0, delegate.executions.get());
    }

    @Test
    void providerFailureFailsClosedBeforeDelegate() {
        CountingDelegate delegate = new CountingDelegate();
        HolGuardToolCallingManager guarded = new HolGuardToolCallingManager(delegate, ctx -> { throw new IllegalStateException("unavailable"); });

        assertThrows(HolGuardToolCallingManager.HolGuardUnavailableException.class,
                () -> guarded.executeToolCalls(new Prompt("test"), response(call("shell"))));
        assertEquals(0, delegate.executions.get());
    }

    @Test
    void wholeBatchIsPreflightedBeforeSingleDelegateExecution() {
        CountingDelegate delegate = new CountingDelegate();
        AtomicInteger decisions = new AtomicInteger();
        HolGuardToolCallingManager guarded = new HolGuardToolCallingManager(delegate, ctx -> {
            decisions.incrementAndGet();
            return HolGuardToolCallingManager.GuardDecision.allow();
        });

        ToolExecutionResult result = guarded.executeToolCalls(new Prompt("test"), response(call("read"), call("write")));

        assertEquals(2, decisions.get());
        assertEquals(1, delegate.executions.get());
        assertSame(delegate.result, result);
    }

    @Test
    void lateBatchDenyStillProducesZeroDelegateExecution() {
        CountingDelegate delegate = new CountingDelegate();
        AtomicInteger decisions = new AtomicInteger();
        HolGuardToolCallingManager guarded = new HolGuardToolCallingManager(delegate, ctx ->
                decisions.incrementAndGet() == 1
                        ? HolGuardToolCallingManager.GuardDecision.allow()
                        : HolGuardToolCallingManager.GuardDecision.deny());

        assertThrows(HolGuardToolCallingManager.HolGuardDeniedException.class,
                () -> guarded.executeToolCalls(new Prompt("test"), response(call("read"), call("delete"))));
        assertEquals(2, decisions.get());
        assertEquals(0, delegate.executions.get());
    }

    private static AssistantMessage.ToolCall call(String name) {
        return new AssistantMessage.ToolCall("call-" + name, "function", name, "{\"path\":\"/tmp/example\"}");
    }

    private static ChatResponse response(AssistantMessage.ToolCall... calls) {
        AssistantMessage message = AssistantMessage.builder().toolCalls(List.of(calls)).build();
        return new ChatResponse(List.of(new Generation(message)));
    }

    private static final class CountingDelegate implements ToolCallingManager {
        private final AtomicInteger executions = new AtomicInteger();
        private final ToolExecutionResult result = ToolExecutionResult.builder()
                .conversationHistory(List.of(new UserMessage("executed")))
                .returnDirect(false)
                .build();

        @Override
        public List<ToolDefinition> resolveToolDefinitions(ToolCallingChatOptions chatOptions) {
            return List.of();
        }

        @Override
        public ToolExecutionResult executeToolCalls(Prompt prompt, ChatResponse chatResponse) {
            this.executions.incrementAndGet();
            return this.result;
        }
    }
}
