/**
 * The human gate in front of the tools that act on a colleague's behalf.
 *
 * WHY THIS IS TESTED AT THE ADAPTER LAYER
 *
 * `gateOnHuman` decides whether a tool call stops to ask, and what a refusal looks like to the model. Two failure modes
 * matter and neither is visible from the policy unit tests:
 *
 *   1. A refusal must arrive as an ERROR. If it came back as an ordinary result the model would report "posted" for
 *      something the person never approved.
 *   2. Reading tools must not be gated. Prompting for `a2a_groups` would make the feature unbearable and people would
 *      turn it off, losing the protection where it counts.
 *
 * The seam is verified against a live Host separately (test-report/PROBE-VERIFICATION.md).
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { registerTools } from '../lib/dsh/tools.js';
import { normalizeConfig } from '../lib/core/config.js';

/**
 * Build a registration context that records what the tools were registered with.
 *
 * @param {object} options - `{ humanConfirm, seam }`.
 * @returns {object} `{ ctx, tools, calls }`.
 */
function harness({ humanConfirm, seam } = {}) {
  const tools = new Map();
  const calls = [];
  const injections = [];
  const ctx = {
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    // Cordis refuses a direct property read, so the adapter must go through inject. This double mimics that: the
    // callback runs only when a seam was supplied, and reading `ctx.userQuestions` is deliberately absent.
    inject: (names, callback) => {
      injections.push(names);
      if (seam !== undefined) callback({ userQuestions: seam });
    },
  };
  const config = normalizeConfig({ groups: { humanConfirm: humanConfirm ?? {} } });
  const runtimeDeps = {
    config,
    registry: { list: () => [] },
    bridge: { send: async () => ({ data: {} }) },
    store: {
      has: () => false,
      list: () => [],
      snapshot: () => undefined,
      flush: async () => undefined,
    },
    identities: {
      list: () => [{
        sessionId: 'session-x',
        groupId: 'g-1',
        personId: 'm-1',
        personKey: 'mk_test',
        local: false,
        baseUrl: 'http://127.0.0.1:1/a2a',
        groupName: 'G',
      }],
      get: () => undefined,
      upsert: () => {},
      flush: async () => undefined,
      remoteMemberships: () => [],
    },
    server: { attach: () => {} },
    sessions: {},
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    inbox: undefined,
  };
  const registered = registerTools(ctx, runtimeDeps);
  return { tools, calls, registered, injections };
}

/** The execution object DSH hands a tool. */
function exec(overrides) {
  return { agent: { id: 'session-x', ...overrides }, arguments: {} };
}

test('the seam is resolved through inject, never by a direct property read', () => {
  // Reading ctx.userQuestions directly throws in Cordis and takes the whole plugin down; the adapter must only ever
  // discover the seam through inject().
  const { injections } = harness({ seam: { ask: async () => ({}) } });
  assert.ok(injections.some((names) => names.includes('userQuestions')), 'must probe via inject');
});

test('a reading tool is never gated, even with confirmation enabled', async () => {
  const { tools } = harness({ humanConfirm: { enabled: true, trigger: 'always' }, seam: { ask: async () => ({ answers: [{ label: '拒绝' }] }) } });
  // a2a_groups does a listing; it must run without asking. It will fail for unrelated reasons (no groups), which is
  // fine — the point is that no confirmation error was raised.
  let refusal;
  try {
    await tools.get('a2a_groups').execute({}, exec());
  } catch (error) {
    refusal = error;
  }
  if (refusal !== undefined) {
    assert.notEqual(refusal.code, 'human_confirm_refused', 'a listing must not require confirmation');
  }
});

test('posting a NEW message is not gated: it is the person’s own words', async () => {
  // No replyTo means this Session started the conversation, so there is nothing to approve.
  const { tools } = harness({ humanConfirm: { enabled: true, trigger: 'always' }, seam: { ask: async () => ({ answers: [{ label: '拒绝' }] }) } });
  let refusal;
  try {
    await tools.get('a2a_group_post').execute({ groupId: 'g-1', message: 'hello' }, exec());
  } catch (error) {
    refusal = error;
  }
  if (refusal !== undefined) {
    assert.notEqual(refusal.code, 'human_confirm_refused', 'a self-initiated post must not require confirmation');
  }
});

test('replying to a colleague is gated, and a denial reaches the model as an error', async () => {
  const asked = [];
  const seam = {
    ask: async (request) => {
      asked.push(request);
      return { answers: [{ label: '拒绝' }] };
    },
  };
  const { tools } = harness({
    humanConfirm: { enabled: true, trigger: 'mention', onTimeout: 'never' },
    seam,
  });
  await assert.rejects(
    () => tools.get('a2a_group_post').execute({ groupId: 'g-1', message: '收到', replyTo: 7 }, exec()),
    (error) => {
      // An ERROR, not a quiet result: otherwise the model reports success for something never approved.
      assert.equal(error.code, 'human_confirm_refused');
      assert.match(error.message, /需要你本人确认/);
      return true;
    },
  );
  assert.equal(asked.length, 1, 'the human must actually have been asked');
  // The question has to identify WHICH message, or the person cannot decide.
  assert.match(asked[0].questions[0].question, /收到/);
});

test('an approval lets the call through', async () => {
  const seam = { ask: async () => ({ answers: [{ label: '允许' }] }) };
  const { tools } = harness({ humanConfirm: { enabled: true, trigger: 'mention', onTimeout: 'never' }, seam });
  let error;
  try {
    await tools.get('a2a_group_post').execute({ groupId: 'g-1', message: '收到', replyTo: 7 }, exec());
  } catch (caught) {
    error = caught;
  }
  // It may still fail for unrelated reasons (no host), but it must NOT be a confirmation refusal.
  if (error !== undefined) assert.notEqual(error.code, 'human_confirm_refused');
});

test('the unimplemented IM channel refuses loudly instead of skipping the check', async () => {
  // Silently proceeding would remove the protection while the setting looks applied — the worst possible outcome.
  const { tools } = harness({ humanConfirm: { enabled: true, trigger: 'mention', channel: 'im' }, seam: { ask: async () => ({}) } });
  await assert.rejects(
    () => tools.get('a2a_group_post').execute({ groupId: 'g-1', message: '收到', replyTo: 7 }, exec()),
    (error) => {
      assert.equal(error.code, 'human_confirm_refused');
      assert.match(error.message, /即时通讯消息.*尚未实现/);
      return true;
    },
  );
});

test('a missing seam refuses rather than proceeding', async () => {
  // No seam supplied: the Host cannot ask, so the action must not happen.
  const { tools } = harness({ humanConfirm: { enabled: true, trigger: 'mention' } });
  await assert.rejects(
    () => tools.get('a2a_group_post').execute({ groupId: 'g-1', message: '收到', replyTo: 7 }, exec()),
    (error) => {
      assert.equal(error.code, 'human_confirm_refused');
      return true;
    },
  );
});
