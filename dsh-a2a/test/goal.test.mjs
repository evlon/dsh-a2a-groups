/**
 * Tests for the organisation layer: one goal per group, plus the group's standing conventions.
 *
 * Two kinds of assertion matter here, and they pull in opposite directions:
 *
 *  1. **The new behaviour** — one goal at a time, owner-only publish, a challenge that suspends
 *     rather than blocks, an emergency that lapses on its own.
 *  2. **The absence of behaviour** — a group that never opted in must answer EXACTLY as it did
 *     before this layer existed. That is the red line that lets the feature ship on a
 *     maintenance line, so it is asserted by walking a reply's keys and by round-tripping the
 *     stored file, not by eyeballing a diff.
 *
 * The clock is injected, so the two timeouts are tested by travelling in time rather than
 * sleeping.
 */
import { test, afterAll, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GOAL_CHALLENGE_MS,
  GOAL_EMERGENCY_MS,
  GroupError,
  createGroupStore,
} from '../lib/core/groups.js';

const START = Date.parse('2026-11-07T09:00:00.000Z');
const HOUR = 3_600_000;

const temporaries = [];

afterAll(() => {
  for (const directory of temporaries) rmSync(directory, { recursive: true, force: true });
});

// The environment switch is process-wide, so a test that sets it must not leak into the next.
afterEach(() => {
  delete process.env.A2A_GOAL_ENABLED;
});

/** A fresh state directory plus a controllable clock. */
function harness(options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-goal-'));
  temporaries.push(home);
  return reopen(home, options);
}

/** A store over an existing directory — this is the restart path. */
function reopen(home, options = {}) {
  const clock = { t: START };
  const logs = [];
  const store = createGroupStore({
    home,
    clock: () => clock.t,
    logger: {
      info: (message, details) => logs.push({ level: 'info', message, details }),
      warn: (message, details) => logs.push({ level: 'warn', message, details }),
      error: (message, details) => logs.push({ level: 'error', message, details }),
    },
    config: { groups: { gatewayBase: 'https://gw.ict.cmcc', agentName: 'group-7f3a1c', ...options.groups } },
  });
  return { home, store, clock, logs, file: store.file };
}

/** Create a group and return the owner credential a mutating call needs. */
function seed(env, overrides = {}) {
  const created = env.store.create({
    name: '结算中心重构',
    topic: '把结算服务拆干净',
    ownerDisplayName: '牛昆仑',
    ...overrides,
  });
  return {
    groupId: created.group.groupId,
    owner: { personId: created.group.owner.personId, personKey: created.ownerKey },
  };
}

/** Add one extra member through the real invite path, so its credential is genuine. */
function addMember(env, groupId, owner, displayName) {
  const invite = env.store.invite({ groupId, ownerKey: owner.personKey });
  const joined = env.store.join({ groupId, token: invite.token, displayName });
  return { personId: joined.member.personId, personKey: joined.personKey };
}

/** Every key reachable in a value, for the "no new keys appeared" check. */
function allKeys(value, seen = new Set(), keys = []) {
  if (value === null || typeof value !== 'object') return keys;
  if (seen.has(value)) return keys;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, seen, keys);
    return keys;
  }
  for (const [key, item] of Object.entries(value)) {
    keys.push(key);
    allKeys(item, seen, keys);
  }
  return keys;
}

function publish(env, groupId, owner, extra = {}) {
  return env.store.publishGoal({
    groupId,
    member: owner,
    title: '两周内把结算服务拆到可独立发布',
    description: '目标是一件事，不是一批事。',
    krs: ['结算链路可独立部署', '回归用例覆盖关键路径'],
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// The red line: a group that never opted in is unchanged
// ---------------------------------------------------------------------------

test('未启用组织形态的群：快照与加入返回里不出现任何新字段', () => {
  const env = harness();
  const { groupId, owner } = seed(env);

  const snapshotKeys = allKeys(env.store.snapshot({ groupId }));
  assert.equal(snapshotKeys.includes('goal'), false, '未启用的群不应出现 goal');
  assert.equal(snapshotKeys.includes('goalHistory'), false, '未启用的群不应出现 goalHistory');
  // The settings keys are the sneaky ones: a defaulted `goalEnabled: true` would add a key to
  // EVERY stored group, which is exactly the silent shape change this red line exists to stop.
  assert.equal(snapshotKeys.includes('goalEnabled'), false, '未启用的群不应出现 goalEnabled 设置');
  assert.equal(snapshotKeys.includes('conventions'), false, '未启用的群不应出现 conventions 设置');

  const invite = env.store.invite({ groupId, ownerKey: owner.personKey });
  const joinedKeys = allKeys(env.store.join({ groupId, token: invite.token, displayName: '张工' }));
  assert.equal(joinedKeys.includes('goal'), false, '未启用的群，加入返回不应出现 goal');
});

test('未启用组织形态的群：存储文件与重启往返都不变', () => {
  const env = harness();
  const { groupId } = seed(env);
  const before = readFileSync(env.file, 'utf8');
  const stored = JSON.parse(before).groups.find((group) => group.groupId === groupId);
  assert.equal(stored.goal, undefined);
  assert.equal(stored.settings.goalEnabled, undefined);
  assert.equal(stored.settings.conventions, undefined);

  // A fresh store over the same directory IS the restart path: sanitizeGroup + mergeSettings
  // must not add anything on the way back in.
  const reloaded = reopen(env.home);
  assert.equal(readFileSync(reloaded.file, 'utf8'), before, '重启不得改写未启用的群');
  assert.equal(reloaded.store.snapshot({ groupId }).goal, undefined);
});

// ---------------------------------------------------------------------------
// One goal at a time
// ---------------------------------------------------------------------------

test('发布主目标：active、关键路径 id 由宿主生成、留一条 system 行', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  const created = publish(env, groupId, owner);

  assert.equal(created.goal.status, 'active');
  assert.equal(created.goal.krs.length, 2);
  assert.equal(created.goal.krs[0].id, 'kr1', '关键路径 id 必须由宿主生成');

  const page = env.store.read({ groupId, member: owner, limit: 5 });
  const lines = page.entries.filter((entry) => entry.kind === 'system').map((entry) => entry.text);
  assert.ok(lines.some((line) => line.includes('发布了主目标')), '发布应留下可追溯的 system 行');
});

test('已有进行中的主目标时，再发布报 goal_exists 且不覆盖原目标', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  publish(env, groupId, owner);

  assert.throws(
    () => publish(env, groupId, owner, { title: '换一个目标' }),
    (error) => error instanceof GroupError && error.code === 'goal_exists',
  );
  assert.equal(
    env.store.goalStatus({ groupId, member: owner }).goal.title,
    '两周内把结算服务拆到可独立发布',
    '被拒绝的发布不得留下部分写入',
  );
});

test('非群主不能发布主目标', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  const member = addMember(env, groupId, owner, '张工');

  assert.throws(
    () => publish(env, groupId, member),
    (error) => error instanceof GroupError && error.code === 'not_owner',
  );
});

test('关键路径为空时拒绝发布（没有 KR 的目标无法对齐任何讨论）', () => {
  const env = harness();
  const { groupId, owner } = seed(env);

  assert.throws(
    () => publish(env, groupId, owner, { krs: [] }),
    (error) => error instanceof GroupError && error.code === 'bad_argument',
  );
});

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

test('结束目标：群主可结束，理由必填，并替换为 closed 状态', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  publish(env, groupId, owner);

  assert.throws(
    () => env.store.closeGoal({ groupId, member: owner, reason: '   ' }),
    (error) => error instanceof GroupError && error.code === 'bad_argument',
    '结束理由不能为空',
  );

  const closed = env.store.closeGoal({ groupId, member: owner, reason: '目标已达成' });
  assert.equal(closed.goal.status, 'closed');
  assert.equal(closed.goal.closeReason, '目标已达成');

  // A closed goal must not block the next one: that is the whole point of closing it.
  const next = publish(env, groupId, owner, { title: '下一个目标' });
  assert.equal(next.goal.status, 'active');
  const history = env.store.goalStatus({ groupId, member: owner }).history;
  assert.equal(history.length, 1, '结束过的目标应进入历史');
  assert.equal(history[0].title, '两周内把结算服务拆到可独立发布');
});

test('普通成员不能结束目标', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  const member = addMember(env, groupId, owner, '张工');
  publish(env, groupId, owner);

  assert.throws(
    () => env.store.closeGoal({ groupId, member, reason: '我不想做了' }),
    (error) => error instanceof GroupError && error.code === 'not_owner',
  );
});

test('没有进行中的目标时结束报 goal_not_found', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  assert.throws(
    () => env.store.closeGoal({ groupId, member: owner, reason: '随便' }),
    (error) => error instanceof GroupError && error.code === 'goal_not_found',
  );
});

// ---------------------------------------------------------------------------
// Challenge: the exit from "do not reply when off-topic"
// ---------------------------------------------------------------------------

test('任何成员都能质疑目标；未答复超时后目标自动 suspended', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  const member = addMember(env, groupId, owner, '张工');
  publish(env, groupId, owner);

  const challenged = env.store.challengeGoal({
    groupId,
    member,
    reason: '这个目标的前提不成立，结算服务不该拆',
    alternative: '先做灰度分流，再谈拆分',
  });
  assert.equal(challenged.goal.challenges.length, 1);
  assert.equal(challenged.goal.challenges[0].alternative, '先做灰度分流，再谈拆分');
  // Not suspended immediately: one line from one member must not stall the whole group.
  assert.equal(challenged.goal.status, 'active');
  assert.ok(challenged.answerByIso === new Date(START + GOAL_CHALLENGE_MS).toISOString());

  // Unanswered past the deadline, the goal stops aligning — the cost lands on the owner.
  env.clock.t = START + GOAL_CHALLENGE_MS;
  const later = env.store.goalStatus({ groupId, member: owner });
  assert.equal(later.goal.status, 'suspended');
});

test('质疑也要理由，且必须有进行中的目标', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  const member = addMember(env, groupId, owner, '张工');

  assert.throws(
    () => env.store.challengeGoal({ groupId, member, reason: '因为' }),
    (error) => error instanceof GroupError && error.code === 'goal_not_found',
  );
  publish(env, groupId, owner);
  assert.throws(
    () => env.store.challengeGoal({ groupId, member, reason: '  ' }),
    (error) => error instanceof GroupError && error.code === 'bad_argument',
  );
});

// ---------------------------------------------------------------------------
// Emergency: any member, effective now, lapses on its own
// ---------------------------------------------------------------------------

test('任何成员都能触发紧急例外，24 小时后自动失效', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  const member = addMember(env, groupId, owner, '张工');
  publish(env, groupId, owner);

  const fired = env.store.emergencyGoal({ groupId, member, reason: '线上结算大面积失败，先灭火' });
  assert.equal(fired.goal.status, 'active', '紧急插入不结束目标，只暂停对齐');
  assert.ok(fired.goal.emergency !== undefined);
  assert.equal(fired.goal.emergency.until, START + GOAL_EMERGENCY_MS);

  // Forgetting to stand down is safe by construction: the exception expires by itself.
  env.clock.t = START + GOAL_EMERGENCY_MS;
  assert.equal(
    env.store.goalStatus({ groupId, member: owner }).goal.emergency,
    undefined,
    '紧急例外必须自动过期，否则没人会记得撤销',
  );
});

// ---------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------

test('群约定：群主可设置、加入返回携带、可显式清空', () => {
  const env = harness();
  const { groupId, owner } = seed(env);

  const set = env.store.setConventions({
    groupId,
    member: owner,
    conventions: '一、只讨论当前主目标。\n二、先做完自己的部分再发消息。',
  });
  assert.equal(set.changed, true);

  const invite = env.store.invite({ groupId, ownerKey: owner.personKey });
  const joined = env.store.join({ groupId, token: invite.token, displayName: '张工' });
  assert.ok(
    joined.group.settings.conventions?.includes('先做完自己的部分'),
    '入群返回必须携带群约定，否则新成员无从知悉',
  );

  const cleared = env.store.setConventions({ groupId, member: owner, conventions: '' });
  assert.equal(cleared.changed, true);
  assert.equal(cleared.conventions, undefined);
  assert.equal(env.store.snapshot({ groupId }).settings.conventions, undefined);
});

test('普通成员不能修改群约定', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  const member = addMember(env, groupId, owner, '张工');

  assert.throws(
    () => env.store.setConventions({ groupId, member, conventions: '我说了算' }),
    (error) => error instanceof GroupError && error.code === 'not_owner',
  );
});

// ---------------------------------------------------------------------------
// The two kill switches
// ---------------------------------------------------------------------------

test('运维级急停：A2A_GOAL_ENABLED=false 时整个特性不可用，且群记录不被改写', () => {
  const env = harness();
  const { groupId, owner } = seed(env);

  process.env.A2A_GOAL_ENABLED = 'false';
  const reloaded = reopen(env.home);
  assert.throws(
    () => publish(reloaded, groupId, owner),
    (error) => error instanceof GroupError && error.code === 'feature_disabled',
  );
  // The switch must not reach into stored data: turning it back on restores the feature.
  delete process.env.A2A_GOAL_ENABLED;
  const back = reopen(env.home);
  assert.equal(publish(back, groupId, owner).goal.status, 'active');
});

test('群级开关：单个群可以退出组织形态，不影响其他群', () => {
  const env = harness();
  const optedOut = seed(env, { settings: { goalEnabled: false } });
  const normal = seed(env, { name: '另一个群' });

  assert.throws(
    () => publish(env, optedOut.groupId, optedOut.owner),
    (error) => error instanceof GroupError && error.code === 'feature_disabled',
  );
  assert.equal(publish(env, normal.groupId, normal.owner).goal.status, 'active');
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

test('goalStatus 只对成员开放；目标内容不进入公开快照的猜测面', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  publish(env, groupId, owner);

  assert.throws(
    () => env.store.goalStatus({ groupId, member: { personId: 'p-unknown', personKey: 'mk_nope' } }),
    (error) => error instanceof GroupError,
    '非成员不得读到目标内容',
  );
  const status = env.store.goalStatus({ groupId, member: owner });
  assert.equal(status.enabled, true);
  assert.equal(status.goal.krs.length, 2);
});
