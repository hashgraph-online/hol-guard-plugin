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

async function runWithDecision({
  provider,
  stdout,
  exitCode = 0,
  approve = undefined,
  workspace = process.cwd(),
}) {
  let executions = 0;
  const seenPayloads = [];
  const seenWorkspaces = [];
  const dangerousAction = toolDefinition({
    name: 'dangerousAction',
    description: 'A test action whose execution is observable',
  }).server(async () => {
    executions += 1;
    return { executed: true };
  });

  const middleware = createHolGuardMiddleware({
    workspace,
    runner: async ({ input, workspace: resolvedWorkspace }) => {
      seenPayloads.push(JSON.parse(input));
      seenWorkspaces.push(resolvedWorkspace);
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

  return { executions, seenPayloads, seenWorkspaces, chunks, error };
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

test('warn decisions remain allow-equivalent and execute exactly once', async () => {
  const byDecision = await runWithDecision({
    provider: 'provider-one',
    stdout: JSON.stringify({ decision: 'warn', reason: 'allowed with warning' }),
  });
  assert.equal(byDecision.executions, 1);

  const byPolicyAction = await runWithDecision({
    provider: 'provider-two',
    stdout: JSON.stringify({ policyAction: 'warn', reason: 'allowed with warning' }),
  });
  assert.equal(byPolicyAction.executions, 1);
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

test('native review approval allows exactly one execution for ask and review decisions', async () => {
  let askApprovals = 0;
  const askResult = await runWithDecision({
    provider: 'provider-two',
    stdout: JSON.stringify({ decision: 'ask', reason: 'confirm this action' }),
    approve: async ({ reason }) => {
      askApprovals += 1;
      assert.equal(reason, 'confirm this action');
      return true;
    },
  });

  assert.equal(askApprovals, 1);
  assert.equal(askResult.executions, 1);

  let reviewApprovals = 0;
  const reviewResult = await runWithDecision({
    provider: 'provider-one',
    stdout: JSON.stringify({ decision: 'review', reason: 'review this action' }),
    approve: async ({ reason }) => {
      reviewApprovals += 1;
      assert.equal(reason, 'review this action');
      return true;
    },
  });

  assert.equal(reviewApprovals, 1);
  assert.equal(reviewResult.executions, 1);
});

test('review without an approval resolver remains fail closed', async () => {
  const result = await runWithDecision({
    provider: 'provider-one',
    stdout: JSON.stringify({ policy_action: 'review', review_hint: 'approval required' }),
  });
  assert.equal(result.executions, 0);
});

test('camelCase policyAction is authoritative and deny wins over allow aliases', async () => {
  const camelCaseDeny = await runWithDecision({
    provider: 'provider-one',
    stdout: JSON.stringify({ policyAction: 'block', reason: 'blocked by camelCase policy action' }),
  });
  assert.equal(camelCaseDeny.executions, 0);

  const conflicting = await runWithDecision({
    provider: 'provider-two',
    stdout: JSON.stringify({ decision: 'allow', policyAction: 'sandbox-required' }),
  });
  assert.equal(conflicting.executions, 0);
});

test('workspace resolver output is normalized before it reaches Guard', async () => {
  const fallback = await runWithDecision({
    provider: 'provider-one',
    stdout: JSON.stringify({ decision: 'deny' }),
    workspace: () => '   ',
  });
  assert.deepEqual(fallback.seenWorkspaces, [process.cwd()]);
  assert.equal(fallback.seenPayloads[0].cwd, process.cwd());

  const normalized = await runWithDecision({
    provider: 'provider-two',
    stdout: JSON.stringify({ decision: 'deny' }),
    workspace: () => '  /tmp/tanstack-hol-guard  ',
  });
  assert.deepEqual(normalized.seenWorkspaces, ['/tmp/tanstack-hol-guard']);
  assert.equal(normalized.seenPayloads[0].cwd, '/tmp/tanstack-hol-guard');
});
