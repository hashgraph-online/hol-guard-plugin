import assert from 'node:assert/strict';
import test from 'node:test';

import { decisionFromGuardResponse } from '../index.js';

test('blocked responses dominate review signals', () => {
  assert.deepEqual(
    decisionFromGuardResponse({
      blocked: true,
      policy_action: 'review',
      review_hint: 'review was requested before the call became blocked',
    }),
    {
      kind: 'deny',
      reason: 'review was requested before the call became blocked',
    },
  );
});

test('continue false dominates an otherwise explicit allow', () => {
  assert.deepEqual(
    decisionFromGuardResponse({
      continue: false,
      hookSpecificOutput: {
        permissionDecision: 'allow',
        permissionDecisionReason: 'the inner decision would otherwise allow',
      },
    }),
    {
      kind: 'deny',
      reason: 'HOL Guard denied this DSH tool call.',
    },
  );
});

test('same-layer denial fields cannot be hidden by hook-specific decisions', () => {
  assert.deepEqual(
    decisionFromGuardResponse({
      hookSpecificOutput: {
        permissionDecision: 'ask',
        permissionDecisionReason: 'hook requested approval',
      },
      decision: 'deny',
      reason: 'top-level denial',
    }),
    {
      kind: 'deny',
      reason: 'top-level denial',
    },
  );
  assert.deepEqual(
    decisionFromGuardResponse({
      hookSpecificOutput: { permissionDecision: 'allow' },
      permissionDecision: 'ask',
    }),
    {
      kind: 'ask',
      reason: 'HOL Guard requires approval for this DSH tool call.',
    },
  );
  assert.deepEqual(
    decisionFromGuardResponse({
      hookSpecificOutput: { permissionDecision: 'allow' },
      permissionDecision: 'allow',
      decision: 'block',
      reason: 'explicit block wins',
    }),
    {
      kind: 'deny',
      reason: 'explicit block wins',
    },
  );
});

test('nested and sibling denial signals cannot be hidden by an outer allow', () => {
  assert.deepEqual(
    decisionFromGuardResponse({
      decision: 'allow',
      result: {
        policy_action: 'block',
        reason: 'nested policy denial',
      },
    }),
    {
      kind: 'deny',
      reason: 'nested policy denial',
    },
  );
  assert.deepEqual(
    decisionFromGuardResponse({
      data: { decision: 'allow' },
      result: {
        policy_action: 'sandbox-required',
        reason: 'sibling sandbox denial',
      },
    }),
    {
      kind: 'deny',
      reason: 'sibling sandbox denial',
    },
  );
});

test('review signals dominate allow signals when no denial is present', () => {
  assert.deepEqual(
    decisionFromGuardResponse({
      policy_action: 'review',
      result: { decision: 'allow' },
    }),
    {
      kind: 'ask',
      reason: 'HOL Guard requires approval for this DSH tool call.',
    },
  );
});

test('excessive response wrapper depth fails closed', () => {
  let payload = { decision: 'allow' };
  for (let index = 0; index < 32; index += 1) payload = { data: payload };
  assert.equal(decisionFromGuardResponse(payload), null);
});
