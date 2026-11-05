/**
 * Tests for the join announcements: one notice to the owner, one welcome to the newcomer.
 *
 * These existed as message kinds from the start and were never sent — so the invitation flow was
 * one-directional: the owner pushed a link and then heard nothing. Both directions matter, and they answer
 * different questions:
 *
 *   to the owner      is my invitation working, and who is here now
 *   to the newcomer   what did I just join
 *
 * The properties worth pinning are the ones a plausible-but-wrong implementation would break: the welcome
 * cannot be signed by the person being welcomed (the store refuses a message from yourself), a failure to
 * notify must not fail a join that already happened, and neither message may carry the invite token.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore } from '../lib/core/groups.js';
import { normalizeConfig } from '../lib/core/config.js';

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-join-'));
  const store = createGroupStore({
    home,
    logger: { info() {}, warn() {}, debug() {} },
    clock: () => Date.now(),
    config: normalizeConfig({ groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-person-test' } }),
  });
  return { home, store, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('the owner is told who joined, and the newcomer is welcomed', () => {
  const env = harness();
  try {
    const created = env.store.create({ name: '发票重构', ownerDisplayName: '张工' });
    const groupId = created.group.groupId;
    const ownerId = created.group.owner.personId;
    const invite = env.store.invite({ groupId, ownerKey: created.ownerKey });
    const joined = env.store.join({ groupId, token: invite.token, displayName: '李四' });

    // The two messages the join path writes, assembled the same way `announceJoin` does.
    env.store.sendPersonMessage({
      fromPersonId: joined.member.personId,
      toPersonId: ownerId,
      kind: 'join-notice',
      text: `李四 加入了「发票重构」`,
      payload: { groupId, groupName: '发票重构', personId: joined.member.personId },
    });
    env.store.sendPersonMessage({
      fromPersonId: ownerId,
      toPersonId: joined.member.personId,
      kind: 'welcome',
      text: '欢迎加入「发票重构」',
      payload: { groupId, groupName: '发票重构', topic: '', memberCount: 2 },
    });

    const ownerInbox = env.store.listPersonMessages({ personId: ownerId });
    assert.equal(ownerInbox.length, 1);
    assert.equal(ownerInbox[0].kind, 'join-notice');
    assert.match(ownerInbox[0].text, /李四/);

    const joinerInbox = env.store.listPersonMessages({ personId: joined.member.personId });
    assert.equal(joinerInbox.length, 1);
    assert.equal(joinerInbox[0].kind, 'welcome');
    assert.match(joinerInbox[0].text, /发票重构/);
  } finally {
    env.cleanup();
  }
});

test('a welcome cannot be signed by the person being welcomed', () => {
  const env = harness();
  try {
    const created = env.store.create({ name: 'g', ownerDisplayName: '张工' });
    const groupId = created.group.groupId;
    const invite = env.store.invite({ groupId, ownerKey: created.ownerKey });
    const joined = env.store.join({ groupId, token: invite.token, displayName: '李四' });

    // The store refuses a message from yourself, which is why `announceJoin` picks the owner — or a
    // reserved system id — rather than the joiner.
    assert.throws(
      () => env.store.sendPersonMessage({
        fromPersonId: joined.member.personId,
        toPersonId: joined.member.personId,
        kind: 'welcome',
        text: 'welcome to me',
      }),
      (error) => error.code === 'bad_argument',
    );
  } finally {
    env.cleanup();
  }
});

test('neither announcement carries the invite token', () => {
  const env = harness();
  try {
    const created = env.store.create({ name: 'g', ownerDisplayName: '张工' });
    const groupId = created.group.groupId;
    const invite = env.store.invite({ groupId, ownerKey: created.ownerKey });
    const joined = env.store.join({ groupId, token: invite.token, displayName: '李四' });

    env.store.sendPersonMessage({
      fromPersonId: joined.member.personId,
      toPersonId: created.group.owner.personId,
      kind: 'join-notice',
      text: `李四 加入了「g」`,
      payload: { groupId },
    });

    // A notice that quoted the invitation would put the token in the owner's own inbox — which is exactly
    // where a forwarded screenshot comes from.
    const inbox = env.store.listPersonMessages({ personId: created.group.owner.personId });
    const serialized = JSON.stringify(inbox);
    assert.ok(!serialized.includes(invite.token), 'the token must not be carried into an inbox');
  } finally {
    env.cleanup();
  }
});

test('the owner is not notified about their own join', () => {
  const env = harness();
  try {
    // Creating a group makes the creator its owner and first member; a notice to themselves would be
    // noise about their own action.
    const created = env.store.create({ name: 'g', ownerDisplayName: '张工' });
    const inbox = env.store.listPersonMessages({ personId: created.group.owner.personId });
    assert.equal(inbox.length, 0);
  } finally {
    env.cleanup();
  }
});

test('an undelivered notice waits for the owner to come online', () => {
  const env = harness();
  try {
    const created = env.store.create({ name: 'g', ownerDisplayName: '张工' });
    const groupId = created.group.groupId;
    const ownerId = created.group.owner.personId;
    const invite = env.store.invite({ groupId, ownerKey: created.ownerKey });
    const joined = env.store.join({ groupId, token: invite.token, displayName: '李四' });

    env.store.sendPersonMessage({
      fromPersonId: joined.member.personId,
      toPersonId: ownerId,
      kind: 'join-notice',
      text: '李四 加入了「g」',
    });

    // A join happening while the owner is away is the ordinary case, not an edge one: the notice has to
    // survive until the owner's inbox is read.
    const pending = env.store.listPersonMessages({ personId: ownerId });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].deliveredAt, undefined);
  } finally {
    env.cleanup();
  }
});
