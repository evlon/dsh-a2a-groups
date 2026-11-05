/**
 * Refusal paths for the tools: the branches that run when a caller is wrong.
 *
 * WHY THIS IS SEPARATE FROM THE HAPPY-PATH COVERAGE
 *
 * Branch coverage on `tool-runtime.js` sat at 45% while every tool had at least one passing test. The reason is
 * that a test of the success path executes one branch of each guard and leaves the refusal side dead — and the
 * refusal side is where a codebase actually protects itself. A tool that accepts a bad argument and forwards it
 * fails somewhere else, in a shape nobody can trace back.
 *
 * Each test here asserts on the ERROR CODE, not the prose. The message is for a person; the code is the contract
 * that a caller (and the next test) can depend on.
 *
 * @module dsh-a2a/test/tool-refusals
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
const SESSION = 'session-test';

/** A bridge that always fails with a chosen business sub-code, in the REAL remote shape. */
function failingBridge(subCode) {
  const fail = async () => {
    const error = new Error(`upstream: ${subCode}`);
    error.kind = 'rpc';
    error.code = -32004;
    error.data = subCode;
    throw error;
  };
  return { send: fail, stream: fail, discover: async () => ({ skills: [] }) };
}

function harness({ bridge } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-refuse-'));
  const clock = () => Date.now();
  const config = normalizeConfig({
    groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test' },
    client: { apiKey: 'k', forwardProto: 'http', timeoutMs: 1000 },
  });
  const store = createGroupStore({ home, logger: LOGGER, clock, config });
  const identities = createMembershipLedger({ home, logger: LOGGER, clock });
  const registry = createRegistry({ home, logger: LOGGER, clock });

  const created = store.create({ name: '发票重构', ownerDisplayName: '张三' });
  const groupId = created.group.groupId;
  identities.upsert({
    sessionId: SESSION, groupId,
    personId: created.group.owner.personId,
    personKey: created.ownerKey,
    local: true, groupName: created.group.name, role: 'owner', lastSeq: 0,
  });
  identities.upsert({
    sessionId: SESSION, groupId: 'g-remote-1',
    personId: 'p-remote', personKey: 'mk_remote',
    local: false, baseUrl: 'http://gw/a2a/host', groupName: '远程群', role: 'member', lastSeq: 0,
  });

  const runtime = createToolRuntime({
    store, identities, registry,
    bridge: bridge ?? { send: async () => ({ data: {} }), stream: async () => ({ data: {} }), discover: async () => ({ skills: [] }) },
    config, logger: LOGGER, clock,
  });
  return {
    store, identities, registry, runtime, groupId, remoteGroupId: 'g-remote-1',
    sessionId: SESSION,
    owner: { personId: created.group.owner.personId, personKey: created.ownerKey },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** Assert a call fails with a coded error. */
async function refuses(promise, hint) {
  await assert.rejects(
    promise,
    (error) => typeof error.code === 'string' && error.code !== '',
    hint,
  );
}

// ---------------------------------------------------------------------------
// Missing or malformed arguments
// ---------------------------------------------------------------------------

test('group tools refuse a missing groupId', async () => {
  const env = harness();
  try {
    for (const tool of ['a2a_group_info', 'a2a_group_read', 'a2a_group_post', 'a2a_group_role', 'a2a_group_invite', 'a2a_group_rename', 'a2a_group_archive']) {
      await refuses(env.runtime.call(tool, {}, { sessionId: env.sessionId }), `${tool} must need a groupId`);
    }
  } finally {
    env.cleanup();
  }
});

test('a2a_group_remove refuses a missing targetPersonId', async () => {
  const env = harness();
  try {
    // Removing "somebody" with nobody named would either remove the caller or pick arbitrarily.
    await refuses(
      env.runtime.call('a2a_group_remove', { groupId: env.groupId }, { sessionId: env.sessionId }),
      'a remove needs a target',
    );
  } finally {
    env.cleanup();
  }
});

test('a2a_group_rename refuses an empty name', async () => {
  const env = harness();
  try {
    // An empty name makes the group unaddressable by a human, and the panel would draw a blank row.
    await refuses(
      env.runtime.call('a2a_group_rename', { groupId: env.groupId, name: '' }, { sessionId: env.sessionId }),
      'a name is required',
    );
  } finally {
    env.cleanup();
  }
});

test('a2a_group_post refuses an empty message', async () => {
  const env = harness();
  try {
    await refuses(
      env.runtime.call('a2a_group_post', { groupId: env.groupId, message: '' }, { sessionId: env.sessionId }),
      'an empty post is not a post',
    );
  } finally {
    env.cleanup();
  }
});

test('a2a_discover refuses no address at all', async () => {
  const env = harness();
  try {
    await refuses(
      env.runtime.call('a2a_discover', {}, { sessionId: env.sessionId }),
      'there is nothing to discover without a target',
    );
  } finally {
    env.cleanup();
  }
});

test('a2a_send refuses an unregistered agent name', async () => {
  const env = harness();
  try {
    // A name that was never registered has no address; guessing one would send to the wrong machine.
    await refuses(
      env.runtime.call('a2a_send', { agent: 'nobody', message: 'hi' }, { sessionId: env.sessionId }),
      'an unknown agent name must fail',
    );
  } finally {
    env.cleanup();
  }
});

test('a2a_agents reports that a name it never had was not registered', async () => {
  const env = harness();
  try {
    // Deliberately not an error: removing something absent is already the desired end state. But it must SAY so,
    // because a silent success leaves a caller believing they removed an entry that was never there.
    const result = await env.runtime.call('a2a_agents', { action: 'remove', name: 'ghost' }, { sessionId: env.sessionId });
    assert.match(result.changed, /not registered/u);
    assert.equal(result.agents.length, 0);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Membership guards
// ---------------------------------------------------------------------------

test('a tool for a group this Session never joined refuses with unknown_group', async () => {
  const env = harness();
  try {
    await assert.rejects(
      () => env.runtime.call('a2a_group_read', { groupId: 'g-missing' }, { sessionId: env.sessionId }),
      (error) => error.code === 'unknown_group',
    );
  } finally {
    env.cleanup();
  }
});

test('an owner-only operation refuses a member', async () => {
  const env = harness();
  try {
    const invite = env.store.invite({ groupId: env.groupId, ownerKey: env.owner.personKey });
    const joined = env.store.join({ groupId: env.groupId, token: invite.token, displayName: '李四' });
    env.identities.upsert({
      sessionId: 'other-session',
      groupId: env.groupId,
      personId: joined.member.personId,
      personKey: joined.personKey,
      local: true,
      groupName: '发票重构',
      role: 'member',
    });

    // Archive is an owner decision; a member must not be able to end everybody's access.
    await assert.rejects(
      () => env.runtime.call('a2a_group_archive', { groupId: env.groupId }, { sessionId: 'other-session' }),
      (error) => error.code === 'not_owner' || error.code === 'forbidden',
    );
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Remote failures keep their shape
// ---------------------------------------------------------------------------

test('a remote refusal surfaces the host sub-code, not just a JSON-RPC number', async () => {
  const env = harness({ bridge: failingBridge('not_member') });
  try {
    // A caller that only knows `-32004` cannot tell "you were removed" from "the group is gone"; the sub-code is the
    // difference between a clear message and a shrug.
    await assert.rejects(
      () => env.runtime.call('a2a_group_read', { groupId: env.remoteGroupId }, { sessionId: env.sessionId }),
      (error) => error.data === 'not_member',
    );
  } finally {
    env.cleanup();
  }
});

test('an unrelated remote failure does not mark the membership unreachable', async () => {
  const env = harness({ bridge: failingBridge('task_timeout') });
  try {
    await env.runtime.call('a2a_group_read', { groupId: env.remoteGroupId }, { sessionId: env.sessionId }).catch(() => {});
    // A timeout says nothing about the membership; stamping it would mark every group unreachable during a blip.
    assert.equal(env.identities.get(env.remoteGroupId, env.sessionId).unreachableAt, undefined);
  } finally {
    env.cleanup();
  }
});

test('a network-shaped failure is reported as a failure, not as success', async () => {
  const bridge = {
    send: async () => {
      throw new Error('connect ECONNREFUSED');
    },
    stream: async () => {
      throw new Error('connect ECONNREFUSED');
    },
    discover: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  };
  const env = harness({ bridge });
  try {
    // The worst possible outcome is a tool that swallows a transport error and returns an empty result, because the
    // model then reports "the group is empty" instead of "the host is down". Any rejection passes: the point is
    // that it is not reported as success.
    await assert.rejects(
      () => env.runtime.call('a2a_group_read', { groupId: env.remoteGroupId }, { sessionId: env.sessionId }),
      'a dead host must not look like an empty group',
    );
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tool lookup
// ---------------------------------------------------------------------------

test('an unknown tool name is refused rather than silently ignored', async () => {
  const env = harness();
  try {
    await assert.rejects(
      () => env.runtime.call('a2a_does_not_exist', {}, { sessionId: env.sessionId }),
      /unknown tool/u,
    );
  } finally {
    env.cleanup();
  }
});

test('the registry lists exactly the tools the spec advertises', async () => {
  const env = harness();
  try {
    const { TOOL_SPECS } = await import('../lib/shared/tool-specs.js');
    const names = env.runtime.names().slice().sort();
    const advertised = TOOL_SPECS.map((spec) => spec.name).slice().sort();
    // A tool in the spec but not the runtime is advertised and uncallable; the reverse is invisible to a model.
    assert.deepEqual(names, advertised);
  } finally {
    env.cleanup();
  }
});
