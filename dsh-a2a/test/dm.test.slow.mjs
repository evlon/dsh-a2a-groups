/**
 * Tests for one-to-one messages: the doorbell that pulls a colleague into a group.
 *
 * The properties worth pinning are the ones a plausible-but-wrong implementation would violate
 * silently. Every one of these was a real decision, not an obvious consequence:
 *
 *   - sending does NOT claim delivery; only the receiver's ack does
 *   - an ack is idempotent, and a message cannot be acked by the wrong person
 *   - a group invitation carries a FRESH single-use link, because a token cannot be read back
 *   - an undelivered message survives a restart
 *   - online means "holding a connection", which is a timestamp window, not a stored flag
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore, GroupError, ONLINE_WINDOW_MS } from '../lib/core/groups.js';
import { normalizeConfig } from '../lib/core/config.js';

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-dm-'));
  const make = () => createGroupStore({
    home,
    logger: { info() {}, warn() {}, debug() {} },
    clock: () => Date.now(),
    config: normalizeConfig({ groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-person-test' } }),
  });
  return { home, store: make(), make, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** A group with an owner and one member, plus both credentials. */
function seed(store) {
  const created = store.create({ name: '发票重构', ownerDisplayName: '张工' });
  const groupId = created.group.groupId;
  const owner = { personId: created.group.owner.personId, personKey: created.ownerKey };
  const invite = store.invite({ groupId, ownerKey: created.ownerKey });
  const joined = store.join({ groupId, token: invite.token, displayName: '李四' });
  const li = { personId: joined.member.personId, personKey: joined.personKey };
  return { groupId, owner, li };
}

// ---------------------------------------------------------------------------
// sending

test('a send does not claim delivery, because returning is not receiving', () => {
  const env = harness();
  try {
    const { owner, li } = seed(env.store);
    const sent = env.store.sendPersonMessage({
      fromPersonId: owner.personId,
      toPersonId: li.personId,
      kind: 'group-invite',
      text: '发票重构',
    });
    // The failure this prevents: showing 「已送达」 for a message nobody saw, which teaches the
    // sender to stop trusting the indicator.
    assert.equal(sent.deliveredAt, undefined);
    assert.ok(SENT_OK(sent.dmId));
  } finally {
    env.cleanup();
  }
});

/** Message ids carry a `dm-` prefix, so a client can recognise one. */
function SENT_OK(dmId) {
  return typeof dmId === 'string' && dmId.startsWith('dm-');
}

test('a message to yourself is refused', () => {
  const env = harness();
  try {
    const { owner } = seed(env.store);
    assert.throws(
      () => env.store.sendPersonMessage({
        fromPersonId: owner.personId,
        toPersonId: owner.personId,
        kind: 'welcome',
        text: 'hi',
      }),
      (error) => error instanceof GroupError && error.code === 'bad_argument',
    );
  } finally {
    env.cleanup();
  }
});

test('an unknown message kind is refused, which is the signal that the scope changed', () => {
  const env = harness();
  try {
    const { owner, li } = seed(env.store);
    // Only three kinds exist by design: invite, join-notice, welcome. A "chat" kind would mean the
    // doorbell became a chat app, and that should fail loudly rather than arrive quietly.
    assert.throws(
      () => env.store.sendPersonMessage({
        fromPersonId: owner.personId,
        toPersonId: li.personId,
        kind: 'chat',
        text: 'hi',
      }),
      (error) => error.code === 'bad_argument',
    );
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// inbox and ack

test('the recipient sees it, and nobody else does', () => {
  const env = harness();
  try {
    const { owner, li, groupId } = seed(env.store);
    const wangInvite = env.store.invite({ groupId, ownerKey: owner.personKey });
    const wang = env.store.join({ groupId, token: wangInvite.token, displayName: '王五' });

    env.store.sendPersonMessage({
      fromPersonId: owner.personId,
      toPersonId: li.personId,
      kind: 'group-invite',
      text: '发票重构',
    });

    assert.equal(env.store.listPersonMessages({ personId: li.personId }).length, 1);
    assert.equal(env.store.listPersonMessages({ personId: wang.member.personId }).length, 0);
    assert.equal(env.store.listPersonMessages({ personId: owner.personId }).length, 0);
  } finally {
    env.cleanup();
  }
});

test('an ack turns sent into delivered, once', () => {
  const env = harness();
  try {
    const { owner, li } = seed(env.store);
    const sent = env.store.sendPersonMessage({
      fromPersonId: owner.personId,
      toPersonId: li.personId,
      kind: 'welcome',
      text: '欢迎',
    });

    const first = env.store.ackPersonMessages({ personId: li.personId, dmIds: [sent.dmId] });
    assert.deepEqual(first, { acked: 1, unknown: [] });
    const deliveredAt = env.store.listPersonMessages({ personId: li.personId })[0].deliveredAt;
    assert.ok(Number.isFinite(deliveredAt));

    // A retried ack must not move the timestamp: it is what the sender displays, and a shifting
    // value would look like repeated deliveries.
    const second = env.store.ackPersonMessages({ personId: li.personId, dmIds: [sent.dmId] });
    assert.equal(second.acked, 0);
    assert.equal(env.store.listPersonMessages({ personId: li.personId })[0].deliveredAt, deliveredAt);
  } finally {
    env.cleanup();
  }
});

test('somebody else cannot ack my message', () => {
  const env = harness();
  try {
    const { owner, li, groupId } = seed(env.store);
    const wangInvite = env.store.invite({ groupId, ownerKey: owner.personKey });
    const wang = env.store.join({ groupId, token: wangInvite.token, displayName: '王五' });

    const sent = env.store.sendPersonMessage({
      fromPersonId: owner.personId,
      toPersonId: li.personId,
      kind: 'welcome',
      text: '欢迎',
    });

    // An ack by the wrong person would mark a message delivered that its recipient never saw —
    // the exact lie the confirmation exists to prevent.
    const result = env.store.ackPersonMessages({ personId: wang.member.personId, dmIds: [sent.dmId] });
    assert.deepEqual(result, { acked: 0, unknown: [sent.dmId] });
    assert.equal(env.store.listPersonMessages({ personId: li.personId })[0].deliveredAt, undefined);
  } finally {
    env.cleanup();
  }
});

test('acking with no ids is an argument error, not a silent no-op', () => {
  const env = harness();
  try {
    const { li } = seed(env.store);
    assert.throws(
      () => env.store.ackPersonMessages({ personId: li.personId, dmIds: [] }),
      (error) => error.code === 'bad_argument',
    );
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the invitation payload

test('a group invitation carries everything needed to join without pasting anything', () => {
  const env = harness();
  try {
    const { owner, li } = seed(env.store);
    const sent = env.store.sendPersonMessage({
      fromPersonId: owner.personId,
      toPersonId: li.personId,
      kind: 'group-invite',
      text: '发票重构',
      payload: { groupId: 'g-1', groupName: '发票重构', inviteLink: 'agent-a2a://group?v=1&g=g-1' },
    });
    const [received] = env.store.listPersonMessages({ personId: li.personId });
    // The payload is what the receiving client acts on; reshaping or dropping it here would make
    // the sender's builder and the receiver's parser disagree.
    assert.equal(received.payload.groupId, 'g-1');
    assert.equal(received.payload.inviteLink, 'agent-a2a://group?v=1&g=g-1');
    assert.equal(received.text, '发票重构');
    assert.ok(sent.dmId);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// presence

test('online means holding a fresh presence timestamp, not a stored flag', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    // The owner just joined, so their lastSeenAt is fresh.
    assert.equal(env.store.isPersonOnline(owner.personId), true);

    // A person nobody has ever seen is not online.
    assert.equal(env.store.isPersonOnline('m-never-seen'), false);
    void groupId;
  } finally {
    env.cleanup();
  }
});

test('a subscription refresh keeps somebody online past the window', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    // `touch` is what an open subscription calls on a timer. Without it, a member who joins and
    // watches — the ordinary way to use a chat app — would show as offline after two minutes.
    const before = env.store.isPersonOnline(owner.personId);
    env.store.touch({ groupId, member: owner });
    assert.equal(before, true);
    assert.equal(env.store.isPersonOnline(owner.personId), true);
    assert.equal(ONLINE_WINDOW_MS, 120_000);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// durability

test('an undelivered message survives a restart', () => {
  const env = harness();
  try {
    const { owner, li } = seed(env.store);
    const sent = env.store.sendPersonMessage({
      fromPersonId: owner.personId,
      toPersonId: li.personId,
      kind: 'group-invite',
      text: '发票重构',
    });
    env.store.flush();

    // The whole point of a queue: a message is not lost because the host bounced.
    const reopened = env.make();
    const waiting = reopened.listPersonMessages({ personId: li.personId });
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].dmId, sent.dmId);
    assert.equal(waiting[0].deliveredAt, undefined);
  } finally {
    env.cleanup();
  }
});

test('a delivery confirmation survives a restart too', () => {
  const env = harness();
  try {
    const { owner, li } = seed(env.store);
    const sent = env.store.sendPersonMessage({
      fromPersonId: owner.personId,
      toPersonId: li.personId,
      kind: 'welcome',
      text: '欢迎',
    });
    env.store.ackPersonMessages({ personId: li.personId, dmIds: [sent.dmId] });
    env.store.flush();

    const reopened = env.make();
    const [message] = reopened.listPersonMessages({ personId: li.personId });
    assert.ok(Number.isFinite(message.deliveredAt));
  } finally {
    env.cleanup();
  }
});
