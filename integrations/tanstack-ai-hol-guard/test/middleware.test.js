import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EventType,
  chat,
  createChatOptions,
  maxIterations,
  toolDefinition,
} from '@tanstack/ai';

import { createHolGuardMiddleware } from '../src/index.js';

function toolCallingAdapter(name) {
  return {
    kind: 'text',
    name,
    model: name + '-model',
    '~types': {
      providerOptions: {},
      inputModalities: ['text'],
      messageMetadataByModality: {},
      toolCapabilities: [],
      toolCallMetadata: undefined,
      systemPromptMetadata: undefined,
    },
    async *chatStream(options) {
      const runId = options.runId ?? name + '-run';
      const threadId = options.threadId ?? name + '-thread';
      const messageId = runId + '-message';
      const toolCallId = 'call_dangerous';
      const hasToolResult = options.messages.some((message) => message.role === 'tool');

      yield {
        type: EventType.RUN_STARTED,
        runId,
        threadId,
        model: this.model,
        timestamp: Date.now(),
      };

      if (hasToolResult) {
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: 'assistant',
          model: this.model,
          timestamp: Date.now(),
        };
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: 'done',
          model: this.model,
          timestamp: Date.now(),
        };
        yield {
          type: EventType.TEXT_MESSAGE_END,
          messageId,
          model: this.model,
          timestamp: Date.now(),
        };
        yield {
          type: EventType.RUN_FINISHED,
          runId,
          threadId,
          model: this.model,
          finishReason: 'stop',
          timestamp: Date.now(),
        };
        return;
      }

      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: 'dangerousAction',
        toolName: 'dangerousAction',
        model: this.model,
        timestamp: Date.now(),
      };
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: '{}',
        model: this.model,
        timestamp: Date.now(),
      };
      yield {
        type: EventType.TOOL_CALL_END,
        toolCallId,
        toolCallName: 'dangerousAction',
        toolName: 'dangerousAction',
        input: {},
        model: this.model,
        timestamp: Date.now(),
      };
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId,
        model: this.model,
        finishReason: 'tool_calls',
        timestamp: Date.now(),
      };
    },
    structuredOutput: async () => ({ data: {}, rawText: '{}' }),
  };
}

async function runWithDecision({ provider, stdout, exitCode = 0, approve = undefined }) {
  let executions = 0;
  const seenPayloads = [];
  const dangerousAction = toolDefinition({
    name: 'dangerousAction',
    description: 'A test action whose execution is observable',
  }).server(async () => {
    executions += 1;
    return { executed: true };
  });

  const middleware = createHolGuardMiddleware({
    workspace: process.cwd(),
    runner: async ({ input }) => {
      seenPayloads.push(JSON.parse(input));
      return { exitCode, stdout, stderr: '' };
    },
    approve,
  });

  const chunks = [];
  let error = null;
  try {
    for await (const chunk of chat({
      ...createChatOptions({ adapter: toolCallingAdapter(provider) }),
      messages: [{ role: 'user', content: 'Run the action' }],
      tools: [dangerousAction],
      middleware: [middleware],
      agentLoopStrategy: maxIterations(2),
    })) {
      chunks.push(chunk);
    }
  } catch (caught) {
    error = caught;
  }

  return { executions, seenPayloads, chunks, error };
}

test('authoritative deny prevents the real TanStack server tool from executing', async () => {
  const result = await runWithDecision({
    provider: 'provider-one',
    stdout: JSON.stringify({ decision: 'deny', reason: 'blocked by policy' }),
  });

  assert.equal(result.executions, 0);
  assert.equal(result.seenPayloads.length, 1);
  assert.equal(result.seenPayloads[0].tool_name, 'dangerousAction');
  assert.equal(result.seenPayloads[0].runtime_context.framework, 'tanstack-ai');
});

test('malformed or unavailable Guard decisions fail closed before execution', async () => {
  const malformed = await runWithDecision({
    provider: 'provider-two',
    stdout: 'not-json',
  });
  assert.equal(malformed.executions, 0);

  const failing = await runWithDecision({
    provider: 'provider-two',
    stdout: JSON.stringify({ decision: 'allow' }),
    exitCode: 1,
  });
  assert.equal(failing.executions, 0);
});

test('native review approval allows exactly one execution', async () => {
  let approvals = 0;
  const result = await runWithDecision({
    provider: 'provider-two',
    stdout: JSON.stringify({ decision: 'ask', reason: 'confirm this action' }),
    approve: async ({ reason }) => {
      approvals += 1;
      assert.equal(reason, 'confirm this action');
      return true;
    },
  });

  assert.equal(approvals, 1);
  assert.equal(result.executions, 1);
});

test('review without an approval resolver remains fail closed', async () => {
  const result = await runWithDecision({
    provider: 'provider-one',
    stdout: JSON.stringify({ policy_action: 'review', review_hint: 'approval required' }),
  });
  assert.equal(result.executions, 0);
});
