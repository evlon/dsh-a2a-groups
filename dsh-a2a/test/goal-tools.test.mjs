/**
 * The organisation layer, at the tool boundary.
 *
 * The store is already covered directly; what this file proves is the wiring a caller actually
 * touches: the six tools exist, they resolve a membership before touching the goal, a local
 * call mutates the store, and the read tool answers a member without inventing anything.
 *
 * Remote groups are covered by the skill layer's own tests — here the membership is local, which
 * is the path a group hosted on this instance takes.
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
 * A store with one group, a ledger that reports the owner's credential as local, and a runtime
 * over both — i.e. exactly the shape the DSH adapter builds for a group hosted here.
 */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-goal-tools-'));
  temporaries.push(home);
  const clock = { t: START };
  const store = createGroupStore({
    home,
    clock: () => clock.t,
    logger: { info() {}, warn() {}, error() {} },
    config: { groups: { gatewayBase: 'https://gw.ict.cmcc', agentName: 'group-7f3a1c' } },
  });
  const created = store.create({ name: '结算中心重构', ownerDisplayName: '牛昆仑' });
  const groupId = created.group.groupId;
  const ownerId = created.group.owner.personId;
  const record = {
    sessionId: 's-owner',
    groupId,
    personId: ownerId,
    personKey: created.ownerKey,
    local: true,
    groupName: '结算中心重构',
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
    bridge: { send: () => { throw new Error('a local membership must not reach the bridge'); } },
    logger: { info() {}, warn() {}, error() {} },
  });
  return { store, runtime, groupId, ownerKey: created.ownerKey, caller: { sessionId: record.sessionId } };
}

test('六个工具都存在，且每个都有对应的 spec', () => {
  const { runtime } = harness();
  const names = [
    'a2a_goal_publish',
    'a2a_goal_close',
    'a2a_goal_status',
    'a2a_goal_challenge',
    'a2a_goal_emergency',
    'a2a_group_conventions',
  ];
  for (const name of names) {
    assert.equal(runtime.has(name), true, `${name} 必须能被执行`);
    assert.notEqual(specOf(name), undefined, `${name} 必须有 spec，否则模型看不见它`);
  }
});

test('本地群：发布 → 读取 → 结束 走通工具层', async () => {
  const { runtime, groupId, caller } = harness();

  const published = await runtime.call('a2a_goal_publish', {
    groupId,
    title: '两周内把结算服务拆到可独立发布',
    krs: ['结算链路可独立部署', '回归用例覆盖关键路径'],
  }, caller);
  assert.equal(published.goal.status, 'active');
  assert.equal(published.goal.krs.length, 2);

  const status = await runtime.call('a2a_goal_status', { groupId }, caller);
  assert.equal(status.enabled, true);
  assert.equal(status.goal.title, '两周内把结算服务拆到可独立发布');

  const closed = await runtime.call('a2a_goal_close', { groupId, reason: '目标已达成' }, caller);
  assert.equal(closed.goal.status, 'closed');
});

test('本地群：conventions 设置后，入群返回能读到', async () => {
  const { runtime, store, groupId, ownerKey, caller } = harness();

  const set = await runtime.call('a2a_group_conventions', {
    groupId,
    conventions: '只讨论当前主目标；先做完自己的部分再发消息。',
  }, caller);
  assert.equal(set.changed, true);

  const invite = store.invite({ groupId, ownerKey });
  const joined = store.join({ groupId, token: invite.token, displayName: '张工' });
  assert.ok(joined.group.settings.conventions.includes('先做完自己的部分'));
});

test('没有本地凭据的调用会在进入目标逻辑之前被拦住', async () => {
  const { runtime, store, groupId } = harness();
  // Hosted here but no ledger row: the runtime must say so rather than guess a credential. It
  // is a more specific error than "unknown group" on purpose — the two failures have different
  // fixes (join again vs. you were never in it).
  assert.equal(store.has(groupId), true);
  await assert.rejects(
    () => runtime.call('a2a_goal_publish', { groupId, title: 'x', krs: ['y'] }, { sessionId: 's-stranger' }),
    (error) => error.code === 'missing_identity',
  );
});
