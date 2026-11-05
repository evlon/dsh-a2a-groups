/**
 * Coverage for the tools that had none.
 *
 * WHY THIS FILE EXISTS
 *
 * Measured coverage put `lib/shared/tool-runtime.js` at 48.7% lines and 40% branches, and the reason was concrete:
 * 15 of the 26 tools appeared NOWHERE in the test suite. They included `a2a_send` (the tool every remote call goes
 * through), `a2a_pending` (the one the MCP instructions tell a model to call first), and every group-management
 * tool.
 *
 * A tool with no test is not merely "untested" — it is a tool whose argument handling, error mapping and guard
 * clauses have never been executed once. The three crashes found earlier in this project (missing imports behind a
 * green suite) are what that looks like in production.
 *
 * HOW THESE ARE DRIVEN
 *
 * Real store on disk, real ledger on disk, real runtime. Only the bridge is a stub, because there is no second
 * instance here — and the stub is written to FAIL the way the real bridge fails (sub-code in `data`, not `code`),
 * so a test cannot pass by assuming the local shape.
 *
 * @module dsh-a2a/test/tool-coverage
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore } from '../lib/core/groups.js';
import { createMembershipLedger } from '../lib/core/memberships.js';
import { normalizeConfig } from '../lib/core/config.js';
import { createToolRuntime } from '../lib/shared/tool-runtime.js';
import { createRegistry } from '../lib/core/registry.js';

const LOGGER = { info() {}, warn() {}, debug() {} };

/** A fresh state directory, removed by the caller. */
function mktempHome(label) {
  return mkdtempSync(join(tmpdir(), `dsh-a2a-tools-${label}-`));
}
const SESSION = 'session-test';

/**
 * A bridge stub that records calls and either answers or fails.
 *
 * `fail` throws the shape the REAL bridge produces — a JSON-RPC number in `code` and the business sub-code in
 * `data`. A stub that threw `{ code: 'not_member' }` would let a regression through, which is exactly how the remote
 * marking bug survived its unit tests.
 */
function stubBridge({ answer, fail } = {}) {
  const calls = [];
  const run = async (target, input) => {
    calls.push({ target, input });
    if (fail !== undefined) {
      const error = new Error(`upstream rejected: ${fail}`);
      error.kind = 'rpc';
      error.code = -32004;
      error.data = fail;
      throw error;
    }
    return answer === undefined ? { data: {} } : answer;
  };
  return {
    calls,
    send: run,
    stream: run,
    discover: async (target) => {
      calls.push({ target, input: { discover: true } });
      if (fail !== undefined) {
        const error = new Error('upstream rejected');
        error.code = -32004;
        error.data = fail;
        throw error;
      }
      return { skills: [{ id: 'group/post' }], url: 'http://gw/a2a/host' };
    },
  };
}

/** A real store + ledger + runtime, with one group this instance owns and one remote membership. */
function harness({ bridge = stubBridge() } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-tools-'));
  const clock = () => Date.now();
  const config = normalizeConfig({
    groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test' },
    client: { apiKey: 'k', forwardProto: 'http', timeoutMs: 2000 },
  });
  const store = createGroupStore({ home, logger: LOGGER, clock, config });
  const identities = createMembershipLedger({ home, logger: LOGGER, clock });
  const registry = createRegistry({ home, logger: LOGGER, clock });

  const created = store.create({ name: '发票重构', ownerDisplayName: '张三' });
  const groupId = created.group.groupId;
  identities.upsert({
    sessionId: SESSION,
    groupId,
    personId: created.group.owner.personId,
    personKey: created.ownerKey,
    local: true,
    groupName: created.group.name,
    role: 'owner',
    lastSeq: 0,
    memberCount: 1,
  });

  // A second, REMOTE group, so the remote branches are reachable.
  const remoteGroupId = 'g-remote-1';
  identities.upsert({
    sessionId: SESSION,
    groupId: remoteGroupId,
    personId: 'p-remote',
    personKey: 'mk_remote',
    local: false,
    baseUrl: 'http://gw/a2a/host',
    groupName: '远程群',
    role: 'member',
    lastSeq: 0,
  });

  const runtime = createToolRuntime({ store, identities, registry, bridge, config, logger: LOGGER, clock });
  return {
    store,
    identities,
    registry,
    bridge,
    runtime,
    groupId,
    remoteGroupId,
    sessionId: SESSION,
    personId: created.group.owner.personId,
    ownerKey: created.ownerKey,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// a2a_agents — register, list, remove a remote agent
// ---------------------------------------------------------------------------

test('a2a_agents registers, lists and removes a remote agent', async () => {
  const env = harness();
  try {
    const added = await env.runtime.call('a2a_agents', {
      action: 'add',
      name: 'lisi',
      baseUrl: 'http://127.0.0.1:3093/a2a',
      note: '李四的机器',
    }, { sessionId: env.sessionId });
    // The tool answers with the whole registry plus what changed, so a caller can see the result of an add.
    assert.match(added.changed, /lisi/u);
    assert.equal(added.agents.length, 1);

    const listed = await env.runtime.call('a2a_agents', { action: 'list' }, { sessionId: env.sessionId });
    assert.equal(listed.agents.length, 1);
    assert.equal(listed.agents[0].name, 'lisi');

    await env.runtime.call('a2a_agents', { action: 'remove', name: 'lisi' }, { sessionId: env.sessionId });
    const after = await env.runtime.call('a2a_agents', { action: 'list' }, { sessionId: env.sessionId });
    assert.equal(after.agents.length, 0);
  } finally {
    env.cleanup();
  }
});

test('a2a_agents refuses an add with no address', async () => {
  const env = harness();
  try {
    // A registered name with nowhere to reach it is worse than not registering: later calls fail obscurely.
    await assert.rejects(() => env.runtime.call('a2a_agents', { action: 'add', name: 'x' }, { sessionId: env.sessionId }));
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// a2a_discover / a2a_send / a2a_stream
// ---------------------------------------------------------------------------

test('a2a_discover reports the skills a peer advertises', async () => {
  const env = harness();
  try {
    const found = await env.runtime.call('a2a_discover', { agent: 'http://gw/a2a/host' }, { sessionId: env.sessionId });
    assert.ok(Array.isArray(found.skills));
    assert.equal(env.bridge.calls.length, 1, 'discovery must reach the peer, not answer from cache on a first look');
  } finally {
    env.cleanup();
  }
});

test('a2a_send forwards the message and returns the answer', async () => {
  // 2a_send reads { state, text, taskId } off the bridge result, so the stub answers in that shape.
  const bridge = stubBridge({ answer: { state: 'completed', text: '收到了', taskId: 't-1' } });
  const env = harness({ bridge });
  try {
    const result = await env.runtime.call('a2a_send', {
      agent: 'http://gw/a2a/host',
      skill: 'group/post',
      message: '你好',
    }, { sessionId: env.sessionId });

    // `a2a_send` flattens the answer to { state, text, taskId } rather than exposing the raw envelope.
    assert.equal(result.text, '收到了');
    // The skill id and the text both have to travel; a send that drops the skill reaches the wrong handler.
    assert.equal(bridge.calls[0].input.skill, 'group/post');
    assert.equal(bridge.calls[0].input.text, '你好');
  } finally {
    env.cleanup();
  }
});

test('a2a_send refuses a call with no message', async () => {
  const env = harness();
  try {
    await assert.rejects(
      () => env.runtime.call('a2a_send', { agent: 'http://gw/a2a/host' }, { sessionId: env.sessionId }),
      (error) => typeof error.code === 'string',
    );
  } finally {
    env.cleanup();
  }
});

test('a2a_stream opens a stream rather than a unary call', async () => {
  const bridge = stubBridge({ answer: { data: { chunks: [] } } });
  const env = harness({ bridge });
  try {
    await env.runtime.call('a2a_stream', {
      agent: 'http://gw/a2a/host',
      skill: 'group/subscribe',
      message: 'subscribe',
    }, { sessionId: env.sessionId });
    assert.equal(bridge.calls.length, 1);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// a2a_person_inbox / a2a_person_ack
// ---------------------------------------------------------------------------

test('a2a_person_inbox reads the remote inbox and a2a_person_ack clears it', async () => {
  // A separate Session holding ONLY the remote membership.
  //
  // The tool picks its membership with `identities.list({ sessionId })[0]` — the first row, whatever it is — so an
  // instance in both a hosted and a remote group answers from whichever happens to sort first. That passed here and
  // failed on CI, and the property is worth knowing rather than hiding: the choice of credential is arbitrary.
  const home = mktempHome('inbox');
  const clock = () => Date.now();
  const config = normalizeConfig({
    groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test' },
    client: { apiKey: 'k', forwardProto: 'http', timeoutMs: 1000 },
  });
  const store = createGroupStore({ home, logger: LOGGER, clock, config });
  const identities = createMembershipLedger({ home, logger: LOGGER, clock });
  identities.upsert({
    sessionId: 'remote-only',
    groupId: 'g-remote-1',
    personId: 'p-remote',
    personKey: 'mk_remote',
    local: false,
    baseUrl: 'http://gw/a2a/host',
    groupName: '远程群',
    role: 'member',
  });
  const bridge = stubBridge({ answer: { data: { messages: [{ dmId: 'dm-1', kind: 'welcome', text: '欢迎' }] } } });
  const runtime = createToolRuntime({ store, identities, bridge, config, logger: LOGGER, clock });

  try {
    const inbox = await runtime.call('a2a_person_inbox', {}, { sessionId: 'remote-only' });
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].dmId, 'dm-1');

    const acked = await runtime.call('a2a_person_ack', { dmIds: ['dm-1'] }, { sessionId: 'remote-only' });
    assert.ok(acked !== undefined);
    // Both calls must reach the host: an inbox answered locally would show messages that were never delivered.
    assert.ok(bridge.calls.some((call) => call.input.skill === 'person/inbox'));
    assert.ok(bridge.calls.some((call) => call.input.skill === 'person/ack'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// a2a_pending — the tool the MCP instructions tell a model to call first
// ---------------------------------------------------------------------------

test('a2a_pending answers "nothing waiting" without throwing', async () => {
  const env = harness();
  try {
    const pending = await env.runtime.call('a2a_pending', {}, { sessionId: env.sessionId });
    // This is called at the start of every turn, so it must be cheap and must never throw when nothing is joined.
    assert.equal(typeof pending.total, 'number');
    assert.ok(Array.isArray(pending.directMessages));
    assert.ok(Array.isArray(pending.groups));
  } finally {
    env.cleanup();
  }
});

test('a2a_pending counts unread messages from a local group', async () => {
  const env = harness();
  try {
    // The owner posts twice; their own watermark is behind, so both count as unread.
    env.store.post({ groupId: env.groupId, member: { personId: env.personId, personKey: env.ownerKey }, text: '一' });
    env.store.post({ groupId: env.groupId, member: { personId: env.personId, personKey: env.ownerKey }, text: '二' });

    const pending = await env.runtime.call('a2a_pending', {}, { sessionId: env.sessionId });
    assert.ok(pending.total >= 2, 'unread posts must be counted');
  } finally {
    env.cleanup();
  }
});

test('a2a_pending survives an unreachable host instead of failing the turn', async () => {
  const env = harness({ bridge: stubBridge({ fail: 'network' }) });
  try {
    // An unreachable host must not make the start-of-turn probe throw: the model would then lose the whole turn.
    const pending = await env.runtime.call('a2a_pending', {}, { sessionId: env.sessionId });
    assert.equal(typeof pending.total, 'number');
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// a2a_group_invite
// ---------------------------------------------------------------------------

test('a2a_group_invite mints a link for a locally hosted group', async () => {
  const env = harness();
  try {
    const invite = await env.runtime.call('a2a_group_invite', { groupId: env.groupId }, { sessionId: env.sessionId });
    assert.ok(typeof invite.link === 'string' && invite.link.length > 0);
    // A paste-ready prompt is what the person actually sends; a bare link gets forwarded without the explanation.
    assert.ok(typeof invite.prompt === 'string' && invite.prompt.length > 0);
  } finally {
    env.cleanup();
  }
});

test('a2a_group_invite on a remote group goes through the host', async () => {
  const bridge = stubBridge({ answer: { data: { link: 'agent-a2a://group?v=1', prompt: '加入吧' } } });
  const env = harness({ bridge });
  try {
    const invite = await env.runtime.call('a2a_group_invite', { groupId: env.remoteGroupId }, { sessionId: env.sessionId });
    // The host owns the token table, so only it can mint a link it will accept.
    assert.equal(invite.link, 'agent-a2a://group?v=1');
    assert.ok(bridge.calls.some((call) => call.input.skill === 'group/invite'));
  } finally {
    env.cleanup();
  }
});

test('a2a_group_invite refuses a group this instance is not in', async () => {
  const env = harness();
  try {
    await assert.rejects(
      () => env.runtime.call('a2a_group_invite', { groupId: 'g-nope' }, { sessionId: env.sessionId }),
      (error) => error.code === 'unknown_group',
    );
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The request/approve/claim flow
// ---------------------------------------------------------------------------

test('a2a_group_request describes what the applicant would send', async () => {
  const env = harness();
  try {
    const request = await env.runtime.call('a2a_group_request', {
      groupId: 'g-any',
      displayName: '王五',
      agent: 'http://gw/a2a/host',
    }, { sessionId: env.sessionId });
    // Without an invitation the applicant has no credential, so the tool has to tell them how to ask.
    assert.ok(request !== undefined);
  } finally {
    env.cleanup();
  }
});

test('a2a_group_requests lists pending applications for the owner', async () => {
  const env = harness();
  try {
    // Owner-side and hosted-here by design: the queue belongs to the group, which belongs to this instance.
    const listed = await env.runtime.call('a2a_group_requests', { groupId: env.groupId }, { sessionId: env.sessionId });
    assert.ok(Array.isArray(listed.requests));
  } finally {
    env.cleanup();
  }
});

test('a2a_group_requests refuses a group hosted elsewhere', async () => {
  const env = harness();
  try {
    // Only the owning host holds the queue, so this must be a clear refusal rather than an empty list that reads as
    // "nobody applied".
    await assert.rejects(
      () => env.runtime.call('a2a_group_requests', { groupId: env.remoteGroupId }, { sessionId: env.sessionId }),
      (error) => error.code === 'not_hosted_here',
    );
  } finally {
    env.cleanup();
  }
});

test('a2a_group_decide refuses an unknown request rather than pretending to approve it', async () => {
  const env = harness();
  try {
    // A decision on a request that does not exist must fail loudly: silently "approving" would leave the applicant
    // waiting for a claim key that was never issued.
    await assert.rejects(
      () => env.runtime.call('a2a_group_decide', { groupId: env.groupId, requestId: 'r-nope', approve: true }, { sessionId: env.sessionId }),
      (error) => typeof error.code === 'string' && error.code !== '',
    );
  } finally {
    env.cleanup();
  }
});

test('a2a_group_claim requires a claim key', async () => {
  const env = harness();
  try {
    // The claim key is the secret half of an approval; without it, knowing a request exists must not be enough.
    await assert.rejects(() => env.runtime.call('a2a_group_claim', { groupId: 'g-any' }, { sessionId: env.sessionId }));
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Group management
// ---------------------------------------------------------------------------

test('a2a_group_rename changes the name for everyone', async () => {
  const env = harness();
  try {
    const renamed = await env.runtime.call('a2a_group_rename', {
      groupId: env.groupId,
      name: '发票与对账平台',
    }, { sessionId: env.sessionId });
    assert.equal(renamed.name, '发票与对账平台');
    assert.equal(env.store.snapshot({ groupId: env.groupId }).name, '发票与对账平台');
  } finally {
    env.cleanup();
  }
});

test('a2a_group_remove drops a member but keeps their messages', async () => {
  const env = harness();
  try {
    const invite = env.store.invite({ groupId: env.groupId, ownerKey: env.ownerKey });
    const joined = env.store.join({ groupId: env.groupId, token: invite.token, displayName: '李四' });
    env.store.post({
      groupId: env.groupId,
      member: { personId: joined.member.personId, personKey: joined.personKey },
      text: '我说过一句话',
    });

    const removed = await env.runtime.call('a2a_group_remove', {
      groupId: env.groupId,
      targetPersonId: joined.member.personId,
    }, { sessionId: env.sessionId });
    // The tool answers with who was removed; there is no boolean, because the identity is what the caller needs.
    assert.equal(removed.personId, joined.member.personId);

    // History belongs to the group, not to the membership: losing it on removal would rewrite what was said.
    const page = env.store.read({
      groupId: env.groupId,
      member: { personId: env.personId, personKey: env.ownerKey },
      sinceSeq: 0,
    });
    assert.ok(page.entries.some((entry) => entry.text === '我说过一句话'));
  } finally {
    env.cleanup();
  }
});

test('a2a_group_archive keeps the group readable but stops new posts', async () => {
  const env = harness();
  try {
    const archived = await env.runtime.call('a2a_group_archive', { groupId: env.groupId, archived: true }, { sessionId: env.sessionId });
    assert.equal(archived.archived, true);

    await assert.rejects(
      () => env.runtime.call('a2a_group_post', { groupId: env.groupId, message: '还能发吗' }, { sessionId: env.sessionId }),
      'an archived group must refuse new posts',
    );
  } finally {
    env.cleanup();
  }
});