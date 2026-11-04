/**
 * Tests for the three owner operations: remove, rename, archive.
 *
 * The properties worth pinning are the ones a wrong implementation would violate silently:
 *
 *   - remove keeps the target's MESSAGES (deleting them would rewrite the conversation);
 *   - remove writes a system entry (the remaining members will notice the absence);
 *   - remove cannot target the owner (that is `leave`, which transfers ownership);
 *   - archive refuses new posts but still allows reads (the reason to archive is "we are
 *     done", the second reason is "what did we decide");
 *   - none of the three work for a non-owner.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore, GroupError } from '../lib/core/groups.js';
import { normalizeConfig } from '../lib/core/config.js';

/** A store in a throwaway directory. */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-admin-'));
  const store = createGroupStore({
    home,
    logger: { info() {}, warn() {}, debug() {} },
    clock: () => Date.now(),
    config: normalizeConfig({ groups: { gatewayBase: 'http://gw/a2a', agentName: 'host' } }),
  });
  return { home, store, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** A group with an owner and two members. */
function seed(store) {
  const created = store.create({ name: '发票重构', topic: '拆分服务', ownerDisplayName: '张工' });
  const groupId = created.group.groupId;
  const owner = { memberId: created.group.owner.memberId, memberKey: created.ownerKey };

  const addMember = (displayName) => {
    const invite = store.invite({ groupId, ownerKey: created.ownerKey });
    const joined = store.join({ groupId, token: invite.token, displayName });
    return { memberId: joined.member.memberId, memberKey: joined.memberKey };
  };

  return { groupId, owner, li: addMember('李四'), wang: addMember('王五') };
}

// ---------------------------------------------------------------------------
// remove

test('remove drops the member but keeps their messages', () => {
  const env = harness();
  try {
    const { groupId, owner, li } = seed(env.store);
    env.store.post({ groupId, member: li, text: '我发的这条不能消失' });

    const removed = env.store.removeMember({ groupId, member: owner, targetMemberId: li.memberId });
    assert.equal(removed.removed, true);
    assert.equal(removed.displayName, '李四');

    // The message survives. Deleting it would make the conversation read as if people had
    // been answering somebody who never spoke.
    const page = env.store.read({ groupId, member: owner, sinceSeq: 0 });
    assert.ok(page.entries.some((entry) => entry.text === '我发的这条不能消失'));
    assert.equal(
      page.entries.some((entry) => entry.from?.memberId === li.memberId),
      true,
      'the removed member still appears as the author of their own history',
    );
  } finally {
    env.cleanup();
  }
});

test('remove writes a system entry naming who and why', () => {
  const env = harness();
  try {
    const { groupId, owner, li } = seed(env.store);
    env.store.removeMember({ groupId, member: owner, targetMemberId: li.memberId, reason: '转岗' });

    const page = env.store.read({ groupId, member: owner, sinceSeq: 0 });
    const system = page.entries.filter((entry) => entry.kind === 'system');
    const line = system.find((entry) => entry.text.includes('移出'));
    assert.ok(line, 'a removal must leave a trace: the remaining members notice the absence');
    assert.match(line.text, /张工/);
    assert.match(line.text, /李四/);
    assert.match(line.text, /转岗/);
  } finally {
    env.cleanup();
  }
});

test('a removed member can no longer post', () => {
  const env = harness();
  try {
    const { groupId, owner, li } = seed(env.store);
    env.store.removeMember({ groupId, member: owner, targetMemberId: li.memberId });
    assert.throws(
      () => env.store.post({ groupId, member: li, text: '还能说话吗' }),
      (error) => error instanceof GroupError && error.code === 'not_member',
    );
  } finally {
    env.cleanup();
  }
});

test('the owner cannot remove themselves', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    assert.throws(
      () => env.store.removeMember({ groupId, member: owner, targetMemberId: owner.memberId }),
      (error) => error.code === 'bad_argument' && /leave/.test(error.message),
    );
  } finally {
    env.cleanup();
  }
});

test('a non-owner cannot remove anybody', () => {
  const env = harness();
  try {
    const { groupId, li, wang } = seed(env.store);
    assert.throws(
      () => env.store.removeMember({ groupId, member: li, targetMemberId: wang.memberId }),
      (error) => error.code === 'not_owner',
    );
  } finally {
    env.cleanup();
  }
});

test('removing somebody who is not in the group is a clear error', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    assert.throws(
      () => env.store.removeMember({ groupId, member: owner, targetMemberId: 'm-nobody' }),
      (error) => error.code === 'not_member',
    );
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// rename

test('rename changes name and topic, and records what changed', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    const result = env.store.renameGroup({
      groupId,
      member: owner,
      name: '发票与对账',
      topic: '范围扩大了',
    });
    assert.deepEqual(result.changed.sort(), ['name', 'topic']);
    assert.equal(result.name, '发票与对账');
    assert.equal(result.topic, '范围扩大了');

    const page = env.store.read({ groupId, member: owner, sinceSeq: 0 });
    assert.ok(page.entries.some((entry) => entry.kind === 'system' && entry.text.includes('修改了')));
  } finally {
    env.cleanup();
  }
});

test('rename with no actual change reports nothing changed and writes no entry', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    const before = env.store.read({ groupId, member: owner, sinceSeq: 0 }).entries.length;
    const result = env.store.renameGroup({ groupId, member: owner, name: '发票重构' });
    assert.deepEqual(result.changed, []);
    const after = env.store.read({ groupId, member: owner, sinceSeq: 0 }).entries.length;
    assert.equal(after, before, 'a no-op rename must not add noise to the feed');
  } finally {
    env.cleanup();
  }
});

test('an empty topic clears it', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    const result = env.store.renameGroup({ groupId, member: owner, topic: '' });
    assert.equal(result.topic, '');
    assert.deepEqual(result.changed, ['topic']);
  } finally {
    env.cleanup();
  }
});

test('a non-owner cannot rename', () => {
  const env = harness();
  try {
    const { groupId, li } = seed(env.store);
    assert.throws(
      () => env.store.renameGroup({ groupId, member: li, name: '我改的' }),
      (error) => error.code === 'not_owner',
    );
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// archive

test('an archived group refuses new posts but still allows reads', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    env.store.post({ groupId, member: owner, text: '归档前的消息' });
    const result = env.store.archiveGroup({ groupId, member: owner });
    assert.equal(result.archived, true);

    assert.throws(
      () => env.store.post({ groupId, member: owner, text: '归档后还想说' }),
      (error) => error.code === 'group_archived',
    );

    // Reading is the point: "we are done" is why you archive, "what did we decide" is why
    // you go back.
    const page = env.store.read({ groupId, member: owner, sinceSeq: 0 });
    assert.ok(page.entries.some((entry) => entry.text === '归档前的消息'));
  } finally {
    env.cleanup();
  }
});

test('archiving twice is idempotent and adds no second entry', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    env.store.archiveGroup({ groupId, member: owner });
    const after = env.store.read({ groupId, member: owner, sinceSeq: 0 }).entries.length;
    const again = env.store.archiveGroup({ groupId, member: owner });
    assert.equal(again.archived, true);
    assert.equal(env.store.read({ groupId, member: owner, sinceSeq: 0 }).entries.length, after);
  } finally {
    env.cleanup();
  }
});

test('an archived group is writable again after reopening', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    env.store.archiveGroup({ groupId, member: owner });
    env.store.archiveGroup({ groupId, member: owner, archived: false });
    assert.doesNotThrow(() => env.store.post({ groupId, member: owner, text: '又回来了' }));
  } finally {
    env.cleanup();
  }
});

test('an archived group disappears from the directory', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    assert.equal(env.store.listDirectory({}).groups.some((row) => row.groupId === groupId), true);
    env.store.archiveGroup({ groupId, member: owner });
    // Not on offer: it accepts no new members, so listing it would invite a request nobody
    // can act on.
    assert.equal(env.store.listDirectory({}).groups.some((row) => row.groupId === groupId), false);
  } finally {
    env.cleanup();
  }
});

test('a non-owner cannot archive', () => {
  const env = harness();
  try {
    const { groupId, li } = seed(env.store);
    assert.throws(
      () => env.store.archiveGroup({ groupId, member: li }),
      (error) => error.code === 'not_owner',
    );
  } finally {
    env.cleanup();
  }
});

test('the archived flag survives a reload', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    env.store.archiveGroup({ groupId, member: owner });
    env.store.flush();

    const reloaded = createGroupStore({
      home: env.home,
      logger: { info() {}, warn() {}, debug() {} },
      clock: () => Date.now(),
      config: normalizeConfig({ groups: { gatewayBase: 'http://gw/a2a', agentName: 'host' } }),
    });
    assert.throws(
      () => reloaded.post({ groupId, member: owner, text: '重启后能发吗' }),
      (error) => error.code === 'group_archived',
    );
  } finally {
    env.cleanup();
  }
});
