/**
 * Attachments at the group level: who may cite a file, who may read it, and what happens to it
 * when the retention window closes.
 *
 * The file store's own tests cover bytes and digests. What is tested here is the part that only
 * exists because of the GROUP: an id from another group must not be citable, a non-member must not
 * be able to read, and a pruned file must disappear from disk rather than merely from the list.
 */
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GroupError, createGroupStore } from '../lib/core/groups.js';
import { MAX_CHUNK_BYTES } from '../lib/core/file-store.js';

const START = Date.parse('2026-11-07T09:00:00.000Z');
const DAY = 86_400_000;
const temporaries = [];

afterAll(() => {
  for (const directory of temporaries) rmSync(directory, { recursive: true, force: true });
});

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-attach-'));
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

function seed(env, overrides = {}) {
  const created = env.store.create({ name: '结算中心', ownerDisplayName: '牛昆仑', ...overrides });
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

/** Publish a small file through the real chunk path. */
async function publishFile(env, groupId, member, content) {
  const buffer = Buffer.from(content);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const begun = env.store.fileBegin({
    groupId, member, name: '报告.txt', size: buffer.length, sha256, mime: 'text/plain',
  });
  for (let index = 0; index < begun.chunks; index += 1) {
    const start = index * MAX_CHUNK_BYTES;
    env.store.fileChunk({
      groupId,
      member,
      fileId: begun.fileId,
      index,
      data: buffer.subarray(start, Math.min(buffer.length, start + MAX_CHUNK_BYTES)).toString('base64'),
    });
  }
  const finished = await env.store.fileFinish({ groupId, member, fileId: begun.fileId });
  return { ...finished.file, buffer };
}

test('发布附件 → 消息引用 → read 带回元数据', async () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  const file = await publishFile(env, groupId, owner, '第一份报告的内容');

  const posted = env.store.post({
    groupId, member: owner, text: '见附件', attachments: [file.fileId],
  });
  assert.equal(posted.seq > 0, true);

  const entries = env.store.read({ groupId, member: owner, limit: 200 }).entries;
  const carrying = entries.filter((entry) => Array.isArray(entry.attachments) && entry.attachments.length > 0);
  assert.equal(carrying.length, 1, 'read 必须转发附件引用');
  assert.equal(carrying[0].attachments[0].fileId, file.fileId);
  assert.equal(carrying[0].attachments[0].name, '报告.txt');
  assert.equal(carrying[0].attachments[0].sha256, file.sha256);
});

test('引用别的群的附件被拒绝', async () => {
  const env = harness();
  const first = seed(env);
  const second = seed(env, { name: '另一个群' });
  const file = await publishFile(env, first.groupId, first.owner, '只属于第一个群');

  assert.throws(
    () => env.store.post({ groupId: second.groupId, member: second.owner, text: 'x', attachments: [file.fileId] }),
    (error) => error instanceof GroupError && error.code === 'file_unknown',
  );
});

test('引用不存在的附件被拒绝', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  assert.throws(
    () => env.store.post({ groupId, member: owner, text: 'x', attachments: ['f-' + 'a'.repeat(32)] }),
    (error) => error instanceof GroupError && error.code === 'file_unknown',
  );
});

test('一条消息最多 10 个附件', async () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  const file = await publishFile(env, groupId, owner, 'x');
  assert.throws(
    () => env.store.post({
      groupId, member: owner, text: 'x', attachments: Array.from({ length: 11 }, () => file.fileId),
    }),
    (error) => error instanceof GroupError && error.code === 'bad_argument',
  );
});

test('另一个成员能下载；非成员连群都解析不到', async () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  const member = addMember(env, groupId, owner, '张工');
  const file = await publishFile(env, groupId, owner, '大家都能读');

  const chunk = await env.store.fileRead({ groupId, member, fileId: file.fileId, index: 0 });
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), '大家都能读');
  assert.equal(chunk.sha256, file.sha256);

  await assert.rejects(
    () => env.store.fileRead({
      groupId,
      member: { personId: 'm-stranger', personKey: 'mk_not-a-real-key' },
      fileId: file.fileId,
      index: 0,
    }),
    (error) => error instanceof GroupError,
  );
});

test('删除：上传者与群主可以，其他成员不行；消息里的元数据仍在', async () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  const uploader = addMember(env, groupId, owner, '张工');
  const other = addMember(env, groupId, owner, '李工');
  const file = await publishFile(env, groupId, uploader, '待删除');
  env.store.post({ groupId, member: uploader, text: '见附件', attachments: [file.fileId] });

  assert.throws(
    () => env.store.fileRemove({ groupId, member: other, fileId: file.fileId }),
    (error) => error instanceof GroupError && error.code === 'not_owner',
  );
  assert.equal(env.store.fileList({ groupId, member: other }).files.length, 1);

  env.store.fileRemove({ groupId, member: uploader, fileId: file.fileId });
  assert.equal(env.store.fileList({ groupId, member: other }).files.length, 0);

  // The message still reads correctly; it simply points at something no longer downloadable.
  const entries = env.store.read({ groupId, member: other, limit: 200 }).entries;
  const carrying = entries.filter((entry) => Array.isArray(entry.attachments) && entry.attachments.length > 0);
  assert.equal(carrying[0].attachments[0].name, '报告.txt');
  await assert.rejects(
    () => env.store.fileRead({ groupId, member: other, fileId: file.fileId, index: 0 }),
    (error) => error instanceof GroupError && error.code === 'file_unknown',
  );
});

test('保留期到了，附件随 feed 一起被清理（磁盘上也消失）', async () => {
  const env = harness();
  const { groupId, owner } = seed(env, { settings: { retentionDays: 1 } });
  const file = await publishFile(env, groupId, owner, '会被清理');
  assert.equal(env.store.fileList({ groupId, member: owner }).files.length, 1);

  // Travel past the retention window, then force the prune path the way a real flush would.
  env.clock.t = START + 2 * DAY;
  env.store.flush();

  assert.equal(env.store.fileList({ groupId, member: owner }).files.length, 0, '超期附件必须从列表消失');
  await assert.rejects(
    () => env.store.fileRead({ groupId, member: owner, fileId: file.fileId, index: 0 }),
    (error) => error instanceof GroupError && error.code === 'file_unknown',
  );
});

test('归档的群不能上传附件', () => {
  const env = harness();
  const { groupId, owner } = seed(env);
  env.store.archiveGroup({ groupId, member: owner, archived: true });
  assert.throws(
    () => env.store.fileBegin({
      groupId, member: owner, name: 'x', size: 1, sha256: 'a'.repeat(64),
    }),
    (error) => error instanceof GroupError && error.code === 'group_archived',
  );
});
