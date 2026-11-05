/**
 * The personal inbox belongs to a PERSON, but the tools reach it through whichever membership happens to be first.
 *
 * THE BUG
 *
 * `a2a_person_inbox`, `a2a_person_ack` and `a2a_pending` all start with:
 *
 *     const membership = identities.list({ sessionId })[0];
 *
 * The first row, whatever group it belongs to, and whatever order the ledger happens to return. Then they branch on
 * `membership.local`:
 *
 *     local   -> read this instance's own store
 *     remote  -> ask that host
 *
 * So the SAME person, in the same Session, with the same inbox, gets a different answer depending on which group the
 * ledger listed first. Two consequences:
 *
 *   1. a message that arrived through group B is invisible when group A sorts first
 *   2. the branch itself may be wrong: a `local` row answers from this process, but the message may live on a host
 *
 * This test failed on CI once already, in a form that looked like a flaky assertion. It was not flaky; the order is
 * genuinely unspecified, and the tool was depending on it.
 *
 * @module dsh-a2a/test/inbox-membership
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

const LOGGER = { info() {}, warn() {}, debug() {} };
const SESSION = 'session-test';

/** A runtime over a ledger where the FIRST row is a local group and the SECOND is remote. */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-inbox-'));
  const clock = () => Date.now();
  const config = normalizeConfig({
    groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test' },
    client: { apiKey: 'k', forwardProto: 'http', timeoutMs: 1000 },
  });
  const store = createGroupStore({ home, logger: LOGGER, clock, config });
  const identities = createMembershipLedger({ home, logger: LOGGER, clock });

  // A remote group FIRST, then a hosted one — because `list()` sorts by `touchedAt` descending, so the last row
  // written is the one `[0]` returns. A real instance updates `lastSeq` on every post, so which group sorts first
  // is effectively arbitrary; the test has to pin it rather than hope.
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

  // The hosted group, touched LAST so it is the row the tools currently see.
  const created = store.create({ name: '本地群', ownerDisplayName: '张三' });
  const localGroupId = created.group.groupId;
  identities.upsert({
    sessionId: SESSION,
    groupId: localGroupId,
    personId: created.group.owner.personId,
    personKey: created.ownerKey,
    local: true,
    groupName: '本地群',
    role: 'owner',
    lastSeq: 0,
  });

  const answered = [];
  const bridge = {
    send: async (target, input) => {
      answered.push(input.skill);
      return { data: { messages: [{ dmId: 'dm-remote', kind: 'welcome', text: '远程的欢迎' }] } };
    },
    stream: async () => ({ data: {} }),
    discover: async () => ({ skills: [] }),
  };

  const runtime = createToolRuntime({ store, identities, bridge, config, logger: LOGGER, clock });
  return {
    store, identities, runtime, localGroupId, remoteGroupId, sessionId: SESSION,
    answered,
    owner: { personId: created.group.owner.personId, personKey: created.ownerKey },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('the personal inbox reaches every host this Session belongs to, not only the first', async () => {
  const env = harness();
  try {
    // A direct message for the REMOTE person, delivered through the remote group.
    // (The local person has no messages; the remote one does.)
    const inbox = await env.runtime.call('a2a_person_inbox', {}, { sessionId: env.sessionId });

    // The bug: `identities.list(...)[0]` is the LOCAL row, so the tool reads this instance's (empty) store and never
    // asks the host where this person actually has a message.
    assert.equal(
      inbox.messages.some((message) => message.dmId === 'dm-remote'),
      true,
      'a message on the remote host must be visible; the person is one person across both groups',
    );
  } finally {
    env.cleanup();
  }
});

test('the personal inbox asks BOTH sides and merges them', async () => {
  const env = harness();
  try {
    // One local message for the local person, so both branches have something to return.
    env.store.sendPersonMessage({
      fromPersonId: env.owner.personId,
      toPersonId: 'p-someone',
      kind: 'join-notice',
      text: '本地的一条',
    });
    // The local person's own inbox, from somebody else.
    const invite = env.store.invite({ groupId: env.localGroupId, ownerKey: env.owner.personKey });
    const joined = env.store.join({ groupId: env.localGroupId, token: invite.token, displayName: '李四' });
    env.store.sendPersonMessage({
      fromPersonId: joined.member.personId,
      toPersonId: env.owner.personId,
      kind: 'join-notice',
      text: '本地来的一条',
    });

    const inbox = await env.runtime.call('a2a_person_inbox', {}, { sessionId: env.sessionId });

    // Both sources must contribute: a person's inbox is not scoped to one group.
    assert.ok(inbox.messages.length >= 1, 'the local message must appear');
    assert.equal(
      inbox.messages.some((message) => message.dmId === 'dm-remote'),
      true,
      'and so must the remote one',
    );
  } finally {
    env.cleanup();
  }
});

test('a2a_pending reports direct messages from every host too', async () => {
  const env = harness();
  try {
    const pending = await env.runtime.call('a2a_pending', {}, { sessionId: env.sessionId });

    // Same first-row pick, same consequence: an invitation waiting on the host is invisible if a local group sorts
    // first, and an invitation is exactly the thing that blocks progress.
    assert.equal(
      pending.directMessages.some((message) => message.dmId === 'dm-remote'),
      true,
      'a pending invitation on another host must be reported',
    );
  } finally {
    env.cleanup();
  }
});

test('a2a_person_ack confirms on the host that holds the message', async () => {
  const env = harness();
  try {
    const acked = await env.runtime.call('a2a_person_ack', { dmIds: ['dm-remote'] }, { sessionId: env.sessionId });

    // An ack sent to the wrong side leaves the message pending forever, and the sender never learns it arrived.
    assert.ok(
      env.answered.some((skill) => skill === 'person/ack'),
      'the ack must reach the host that holds the message',
    );
    assert.ok(acked !== undefined);
  } finally {
    env.cleanup();
  }
});
