/**
 * What a human sees after posting to a group.
 *
 * The complaint that produced this file: "发给谁也没有显示，到底是发给了张三李四，还是苏虎虎" —
 * the collapsed tool block printed `Posted to g-1fad9113 at seq 712`, an internal id that answers
 * neither "which group" nor "who gets woken", and the message body was only visible by expanding
 * the raw arguments.
 *
 * A group post is a BROADCAST: every member can read it. `mentions` decides only who is actively
 * pinged. A receipt that does not separate those two facts teaches the reader the wrong model of
 * their own group.
 *
 * The store refuses to wake a non-member, which is why every mention below targets a real member
 * of the test group: a receipt test built on fictional ids would only prove the display layer,
 * not the path a caller actually takes.
 */
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore } from '../lib/core/groups.js';
import { createToolRuntime } from '../lib/shared/tool-runtime.js';
import { specOf } from '../lib/shared/tool-specs.js';

const START = Date.parse('2026-11-07T09:00:00.000Z');
const temporaries = [];

afterAll(() => {
  for (const directory of temporaries) rmSync(directory, { recursive: true, force: true });
});

/**
 * A store with one group and a runtime over it.
 *
 * @param {object} [options] - `{ roster, memberCount }`. `roster` overrides the cached display
 *   names in the ledger; `memberCount` is the cached audience size the receipt reports. They are
 *   separate on purpose: a real group can have three members while only one of them has a cached
 *   display name, and that is the case where the receipt must fall back to a person id.
 */
function harness(options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-receipt-'));
  temporaries.push(home);
  const store = createGroupStore({
    home,
    clock: () => START,
    logger: { info() {}, warn() {}, error() {} },
    config: { groups: { gatewayBase: 'https://gw.ict.cmcc', agentName: 'group-7f3a1c' } },
  });
  const created = store.create({ name: 'a2a-group研发测试群', ownerDisplayName: '牛昆亮' });
  const groupId = created.group.groupId;
  const ownerId = created.group.owner.personId;
  const record = {
    sessionId: 's-owner',
    groupId,
    personId: ownerId,
    personKey: created.ownerKey,
    local: true,
    groupName: 'a2a-group研发测试群',
    memberCount: Number.isFinite(options.memberCount) ? options.memberCount : 3,
    members: options.roster ?? [
      { personId: ownerId, displayName: '牛昆亮' },
      { personId: 'm-suhuhu', displayName: '苏虎虎' },
      { personId: 'm-liuliye', displayName: '刘立业' },
    ],
    lastSeq: 0,
  };
  const identities = {
    list: () => [record],
    get: (id, sessionId) => (id === groupId && sessionId === record.sessionId ? record : undefined),
    has: () => true,
    upsert: () => record,
    remove: () => 0,
    flush: () => Promise.resolve(),
  };
  const runtime = createToolRuntime({
    config: { client: { timeoutMs: 1_000 } },
    store,
    identities,
    bridge: { send: () => { throw new Error('local membership must not reach the bridge'); } },
    logger: { info() {}, warn() {}, error() {} },
  });
  return { runtime, store, groupId, ownerId, ownerKey: created.ownerKey, record, caller: { sessionId: record.sessionId } };
}

test('发群消息的收据说清「哪个群、谁能看见、唤醒了谁」', async () => {
  const { runtime, groupId, ownerId } = harness();
  const value = await runtime.call(
    'a2a_group_post',
    { groupId, message: '0.1.38 已发布，请按新 setup 页面装。', mentions: [ownerId] },
    { sessionId: 's-owner' },
  );

  assert.equal(typeof value.receipt, 'string', '必须给出人可读的收据');
  assert.ok(value.receipt.includes('a2a-group研发测试群'), `收据要写群名，实际：${value.receipt}`);
  assert.ok(!value.receipt.includes(groupId), '收据不能只写内部 groupId');
  assert.ok(value.receipt.includes('全群 3 人可见'), `必须说明是广播，实际：${value.receipt}`);
  assert.ok(value.receipt.includes('牛昆亮'), `必须点名被唤醒的人，实际：${value.receipt}`);
  assert.ok(!value.receipt.includes('苏虎虎'), '没被 @ 的人不能说成被唤醒');
  assert.deepEqual(value.wokeNames, ['牛昆亮']);
});

test('没有 @ 任何人时，收据明确说「未唤醒」，而不是留空', async () => {
  const { runtime, groupId } = harness();
  const value = await runtime.call('a2a_group_post', { groupId, message: '只是同步一下进度' }, { sessionId: 's-owner' });
  assert.ok(value.receipt.includes('未唤醒任何人'), `实际：${value.receipt}`);
  assert.deepEqual(value.wokeNames, []);
});

test('唤醒覆盖全群时收据写「唤醒 全群」，不把所有人名列一遍', async () => {
  // A one-person group: @all genuinely reaches everybody, so the receipt says so instead of
  // printing a single name that happens to be "everyone".
  const { runtime, groupId } = harness({ memberCount: 1 });
  const value = await runtime.call(
    'a2a_group_post',
    { groupId, message: '全员注意', mentions: ['@all'] },
    { sessionId: 's-owner' },
  );
  assert.ok(value.receipt.includes('唤醒 全群'), `实际：${value.receipt}`);
});

test('名单里查不到名字时退回到 personId，绝不假装没人被唤醒', async () => {
  // A group whose roster was never refreshed: the ledger has no display names at all.
  const { runtime, groupId, ownerId } = harness({ roster: [] });
  const value = await runtime.call('a2a_group_post', { groupId, message: '外部成员', mentions: [ownerId] }, { sessionId: 's-owner' });
  assert.deepEqual(value.wokeNames, [ownerId]);
  assert.ok(value.receipt.includes(ownerId), '解析不出名字也不能吞掉这条唤醒');
});

test('工具块的可见行就是那句收据，且附上正文', async () => {
  const { runtime, groupId, ownerId } = harness();
  const args = { groupId, message: '正文会出现在第二段', mentions: [ownerId] };
  const value = await runtime.call('a2a_group_post', args, { sessionId: 's-owner' });

  const spec = specOf('a2a_group_post');
  const parts = spec.output.render(args, value);
  assert.equal(parts[0].text, value.receipt, '折叠块的第一行必须就是收据');
  assert.ok(parts.some((part) => part.text.includes('正文会出现在第二段')), '展开后要能看到发出去的正文');
});

test('priority 必须真的送到 store，不能只写在 schema 里', async () => {
  // Dropped-parameter bug: the schema accepted `urgent`, the store supported it, and the runtime
  // forwarded neither — so a message meant to supersede an earlier instruction queued politely
  // behind it and the caller had no way to tell.
  const { runtime, store, groupId, ownerId, ownerKey } = harness();
  const value = await runtime.call(
    'a2a_group_post',
    { groupId, message: '覆盖前指令', priority: 'urgent' },
    { sessionId: 's-owner' },
  );
  assert.ok(value.receipt.includes('插队'), `urgent 的收据必须说明插队，实际：${value.receipt}`);

  // And the store must have recorded it, not just the receipt.
  const snapshot = store.snapshot({ groupId, member: { personId: ownerId, personKey: ownerKey } });
  const mine = (snapshot.feedTail ?? []).find((entry) => entry.text === '覆盖前指令');
  assert.ok(mine !== undefined, '刚发的消息必须在 feed 里');
  assert.equal(mine.priority, 'urgent', '落盘的条目必须带 priority');
});

test('urgent 且未点名时，收据写「插队到全群」而不是「未唤醒任何人」', async () => {
  const { runtime, groupId } = harness();
  const value = await runtime.call('a2a_group_post', { groupId, message: '通知', priority: 'urgent' }, { sessionId: 's-owner' });
  assert.ok(!value.receipt.includes('未唤醒任何人'), `不能把插队说成没唤醒，实际：${value.receipt}`);
  assert.ok(value.receipt.includes('插队到全群'), `实际：${value.receipt}`);
});
