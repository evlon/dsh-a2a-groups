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
function harness({ humanConfirm, seam, panelSettings } = {}) {
  const tools = new Map();
  const calls = [];
  const posted = [];
  const notices = [];
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
      // Record every post so a test can assert that a refusal TOLD the colleague instead of going silent.
      post: (input) => { posted.push(input); return { seq: 900 + posted.length, mentions: [], replyTo: input.replyTo }; },
      flush: async () => undefined,
      has: () => false,
      list: () => [],
      snapshot: () => undefined,
      flush: async () => undefined,
    },
    identities: {
      // One LOCAL group, so a post resolves through `store.post` instead of reaching for a bridge. The notice a refusal
      // sends is a real post, and a fake that cannot resolve membership would silently swallow it — which is exactly
      // what happened: the test passed the refusal but the colleague was never told.
      list: () => [{
        sessionId: 'session-x',
        groupId: 'g-1',
        personId: 'm-1',
        personKey: 'mk_test',
        local: true,
        groupName: 'G',
      }],
      get: (groupId) => (groupId === 'g-1'
        ? { sessionId: 'session-x', groupId: 'g-1', personId: 'm-1', personKey: 'mk_test', local: true, groupName: 'G' }
        : undefined),
      upsert: () => {},
      flush: async () => undefined,
      remoteMemberships: () => [],
    },
    server: { attach: () => {} },
    sessions: {},
    logger: { info: () => {}, warn: (m) => { notices.push(String(m)); }, debug: () => {} },
    inbox: undefined,
  };
  if (panelSettings !== undefined) runtimeDeps.panelSettings = panelSettings;
  const registered = registerTools(ctx, runtimeDeps);
  return { tools, calls, registered, injections, posted, notices };
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
  const { tools } = harness({ humanConfirm: { enabled: true, trigger: 'always' }, seam: { ask: async () => ({ answers: [{ id: 'a2a-human-confirm', selected: ['拒绝'] }] }) } });
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
  const { tools } = harness({ humanConfirm: { enabled: true, trigger: 'always' }, seam: { ask: async () => ({ answers: [{ id: 'a2a-human-confirm', selected: ['拒绝'] }] }) } });
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
      return { answers: [{ id: 'a2a-human-confirm', selected: ['拒绝'] }] };
    },
  };
  const { tools, posted, notices } = harness({
    humanConfirm: { enabled: true, trigger: 'mention', onTimeout: 'never' },
    seam,
  });
  await assert.rejects(
    () => tools.get('a2a_group_post').execute({ groupId: 'g-1', message: '收到', replyTo: 7 }, exec()),
    (error) => {
      // An ERROR, not a quiet result: otherwise the model reports success for something never approved.
      assert.equal(error.code, 'human_confirm_refused');
      // The message must also tell the model not to keep trying: a refusal that invites a retry produces a loop.
      assert.match(error.message, /不要再重试/);
      return true;
    },
  );
  assert.equal(asked.length, 1, 'the human must actually have been asked');
  // The card has to identify WHICH message, or the person cannot decide. The content lives in `detail` now — putting it
  // in the title turned a long message into a 16px headline wrapped into a narrow column.
  assert.match(asked[0].questions[0].detail, /收到/, 'the original message must appear in detail');
  assert.ok(asked[0].questions[0].header !== undefined, 'the group name must be shown');
  // THE COLLEAGUE IS TOLD.
  //
  // Silence is the one answer a sender cannot interpret — it reads as ignored, slow, or broken, and none of those is
  // what was chosen. A refusal must post a notice before failing.
  assert.equal(posted.length, 1, `a refusal must tell the colleague something; logger said: ${notices.join(' | ')}`);
  assert.match(posted[0].text, /不打算回复/);
});

test('an approval lets the call through', async () => {
  const seam = { ask: async () => ({ answers: [{ id: 'a2a-human-confirm', selected: ['允许'] }] }) };
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

test('the gate reads the SESSION setting, not only the profile default', () => {
  // Measured bug: the gate consulted `deps.config` alone. That holds the profile default (`enabled: false`), so a
  // person who turned confirmation on for one conversation got nothing — a woken Session answered a colleague's
  // message with `replyTo` set and no prompt appeared, while session-settings.json said enabled=true,
  // trigger=always. The per-Session store has to be consulted or the whole feature is decorative.
  const { tools } = harness({
    humanConfirm: { enabled: false },
    seam: { ask: async () => ({ answers: [{ id: 'a2a-human-confirm', selected: ['拒绝'] }] }) },
    // This Session overrode the profile.
    panelSettings: {
      effectiveFor: () => ({ inherit: false, effective: { enabled: true, trigger: 'mention', channel: 'question', onTimeout: 'never', timeoutMs: 5000 }, override: {} }),
    },
  });
  return assert.rejects(
    () => tools.get('a2a_group_post').execute({ groupId: 'g-1', message: '收到', replyTo: 9 }, exec()),
    (error) => {
      assert.equal(error.code, 'human_confirm_refused', 'the Session asked to be stopped; it must be stopped');
      return true;
    },
  );
});

test('a Session that inherits follows the profile default', () => {
  const { tools } = harness({
    humanConfirm: { enabled: false },
    seam: { ask: async () => ({ answers: [{ id: 'a2a-human-confirm', selected: ['允许'] }] }) },
    panelSettings: { effectiveFor: () => ({ inherit: true, effective: { enabled: false, trigger: 'mention', channel: 'question', onTimeout: 'deny', timeoutMs: 5000 }, override: null }) },
  });
  // Nothing to ask, so it must not be a refusal.
  return tools.get('a2a_group_post').execute({ groupId: 'g-1', message: '收到', replyTo: 9 }, exec())
    .catch((error) => { assert.notEqual(error.code, 'human_confirm_refused'); })
    .then(() => assert.ok(true));
});

test('a failed sender lookup still produces an answerable card', async () => {
  // The name is read back from the group, which for a remote group is a network call. A lookup that throws must not
  // make the question unanswerable — the point of this path is to let a person answer, not to be informative first.
  const asked = [];
  const seam = { ask: async (request) => { asked.push(request); return { answers: [{ id: 'a2a-human-confirm', selected: ['允许'] }] }; } };
  const { tools } = harness({ humanConfirm: { enabled: true, trigger: 'always', onTimeout: 'never' }, seam });
  // deps.bridge.send is stubbed to reject in the harness, so the remote lookup fails; the gate must still ask.
  let error;
  try {
    await tools.get('a2a_group_post').execute({ groupId: 'g-1', message: '收到', replyTo: 7 }, exec());
  } catch (caught) {
    error = caught;
  }
  assert.equal(asked.length, 1, 'the question must still be asked when the name cannot be read');
  assert.equal(asked[0].questions[0].id, 'a2a-human-confirm');
  if (error !== undefined) assert.notEqual(error.code, 'human_confirm_refused');
});

test('稍后处理 also tells the colleague, and says it is NOT a refusal', async () => {
  // The two non-approvals are different promises. A sender who reads defer as reject stops waiting, so the notice has
  // to say explicitly that this is a delay rather than a no.
  const seam = { ask: async () => ({ answers: [{ id: 'a2a-human-confirm', selected: ['稍后处理'] }] }) };
  const { tools, posted } = harness({ humanConfirm: { enabled: true, trigger: 'mention', onTimeout: 'never' }, seam });
  await assert.rejects(
    () => tools.get('a2a_group_post').execute({ groupId: 'g-1', message: '收到', replyTo: 7 }, exec()),
    (error) => {
      assert.equal(error.code, 'human_confirm_refused');
      assert.match(error.message, /稍后处理/);
      return true;
    },
  );
  assert.equal(posted.length, 1, 'defer must also notify');
  assert.match(posted[0].text, /晚点/);
  assert.match(posted[0].text, /不是拒绝/, 'the notice must not read like a rejection');
});

test('允许 posts nothing extra and does not refuse', async () => {
  // The approval path must stay quiet: an extra notice on approval would be noise in the group.
  const seam = { ask: async () => ({ answers: [{ id: 'a2a-human-confirm', selected: ['允许'] }] }) };
  const { tools, posted } = harness({ humanConfirm: { enabled: true, trigger: 'mention', onTimeout: 'never' }, seam });
  let error;
  try {
    await tools.get('a2a_group_post').execute({ groupId: 'g-1', message: '收到', replyTo: 7 }, exec());
  } catch (caught) {
    error = caught;
  }
  if (error !== undefined) assert.notEqual(error.code, 'human_confirm_refused');
  assert.equal(posted.length, 1, 'only the real reply is posted, no extra notice');
});
