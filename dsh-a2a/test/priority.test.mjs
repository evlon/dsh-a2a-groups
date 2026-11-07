/**
 * Message priority and the delivery pause.
 *
 * The failure these exist for is on record: a "stop talking" instruction went out as an ordinary
 * post, everyone honoured it, and then four later requests for input were silently swallowed
 * because nobody remembered to lift it — including the person who set it. A pause that is a
 * MESSAGE cannot fix that. A pause that is a STATE can, because the next message can ask about it.
 *
 * Two properties are load-bearing and are tested hardest here:
 *  - the pause travels in the feed (a remote member cannot read the host's control state);
 *  - a control post still cuts through the pause (otherwise the lift is swallowed by the thing
 *    it exists to end).
 */
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GroupError, createGroupStore } from '../lib/core/groups.js';

const START = Date.parse('2026-11-07T09:00:00.000Z');
const temporaries = [];

afterAll(() => {
  for (const directory of temporaries) rmSync(directory, { recursive: true, force: true });
});

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-priority-'));
  temporaries.push(home);
  const clock = { t: START };
  const store = createGroupStore({
    home,
    clock: () => clock.t,
    logger: { info() {}, warn() {}, error() {} },
    config: { groups: { gatewayBase: 'https://gw.ict.cmcc', agentName: 'group-7f3a1c' } },
  });
  return { store, clock, home };
}

function seed(env) {
  const created = env.store.create({ name: '结算中心重构', ownerDisplayName: '牛昆仑' });
  return {
    groupId: created.group.groupId,
    owner: { personId: created.group.owner.personId, personKey: created.ownerKey },
  };
}

function addMember(env, groupId, owner, displayName) {
  const invite = env.store.invite({ groupId, ownerKey: owner.personKey });
  const joined = env.store.join({ groupId, token: invite.token, displayName });
  return { personId: joined.member.personId, personKey: joined.personKey };
}

// ---------------------------------------------------------------------------
// Priority is an optional field, like every other optional field in this layer
// ---------------------------------------------------------------------------

test('普通发言不写 priority 字段（未使用的消息与上一版逐字节一致）', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  const posted = env.store.post({ groupId, member: owner, text: '普通一句' });
  assert.equal(posted.priority, undefined);
  const stored = JSON.parse(readFileSync(env.store.file, 'utf8')).groups[0].feed.at(-1);
  assert.equal(stored.priority, undefined);
});

test('urgent 会写进记录，并经 publicEntry 传到读者（白名单不得吞掉）', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  env.store.post({ groupId, member: owner, text: '先停一下', priority: 'urgent' });
  const page = env.store.read({ groupId, member: owner, limit: 5 });
  const entry = page.entries.at(-1);
  assert.equal(entry.priority, 'urgent', 'read 返回必须带 priority，否则投递侧永远看不到它');
});

// ---------------------------------------------------------------------------
// The pause is a state
// ---------------------------------------------------------------------------

test('暂停是状态：能写上、能查、能解除，且留痕', () => {
  const env = harness();
  const { groupId, owner } = seed(env);

  const stopped = env.store.setControl({ groupId, member: owner, action: 'stop', reason: '线上事故' });
  assert.equal(stopped.control.stopped, true);
  assert.equal(env.store.snapshot({ groupId }).control.stopped, true, '状态必须能从快照查到');

  const resumed = env.store.setControl({ groupId, member: owner, action: 'resume', reason: '处理完' });
  assert.equal(resumed.control.stopped, false);
  assert.equal(env.store.snapshot({ groupId }).control.stopped, false);
});

test('停止原因必填，恢复不必填', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  assert.throws(
    () => env.store.setControl({ groupId, member: owner, action: 'stop', reason: '  ' }),
    (error) => error instanceof GroupError && error.code === 'bad_argument',
  );
  assert.equal(env.store.setControl({ groupId, member: owner, action: 'resume' }).control.stopped, false);
});

test('只有群主能暂停或恢复；普通成员发控制指令被拒', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  const member = addMember(env, groupId, owner, '张工');

  assert.throws(
    () => env.store.setControl({ groupId, member, action: 'stop', reason: '我说停就停' }),
    (error) => error instanceof GroupError && error.code === 'not_owner',
  );
  assert.throws(
    () => env.store.post({ groupId, member, text: 'stop', priority: 'control' }),
    (error) => error instanceof GroupError && error.code === 'not_owner',
    'control 优先级不是发言，是控制，不能让普通成员用',
  );
});

// ---------------------------------------------------------------------------
// The pause travels in the feed, because a remote member cannot read the host
// ---------------------------------------------------------------------------

test('暂停与恢复各产生一条 control 消息，携带机器可读状态', () => {
  const env = harness();
  const { groupId, owner } = seed(env);

  env.store.setControl({ groupId, member: owner, action: 'stop', reason: '事故' });
  env.store.setControl({ groupId, member: owner, action: 'resume', reason: '恢复' });

  const entries = env.store.read({ groupId, member: owner, limit: 20 })
    .entries.filter((entry) => entry.priority === 'control');
  assert.equal(entries.length, 2, '两次状态变更都必须进 feed');
  // The payload is what a member applies while streaming; the text is for people.
  assert.equal(entries[0].payload.control.stopped, true);
  assert.equal(entries[1].payload.control.stopped, false);
  assert.ok(entries[0].text.includes('暂停'));
});

test('解除指令是 control 级别——否则它会被自己引发的暂停吞掉', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  env.store.setControl({ groupId, member: owner, action: 'stop', reason: '事故' });
  const resume = env.store.read({ groupId, member: owner, limit: 10 })
    .entries.filter((entry) => entry.priority === 'control').at(-1);
  assert.equal(resume.priority, 'control');
  assert.equal(resume.payload.control.stopped, true);
});

// ---------------------------------------------------------------------------
// The red line again: a group that never paused grows no key
// ---------------------------------------------------------------------------

test('未使用控制能力的群：快照与存储都不出现 control 字段', () => {
  const env = harness();
  const { groupId } = seed(env);
  assert.equal('control' in env.store.snapshot({ groupId }), false);
  const stored = JSON.parse(readFileSync(env.store.file, 'utf8')).groups[0];
  assert.equal(stored.control, undefined);
});

test('暂停状态跨重启保留（不能因为重启就把群悄悄解除静默）', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  env.store.setControl({ groupId, member: owner, action: 'stop', reason: '事故' });

  const reloaded = createGroupStore({
    home: env.home,
    clock: () => START,
    logger: { info() {}, warn() {}, error() {} },
    config: { groups: {} },
  });
  assert.equal(reloaded.snapshot({ groupId }).control.stopped, true);
});
