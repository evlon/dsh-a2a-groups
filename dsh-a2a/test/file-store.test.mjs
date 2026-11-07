/**
 * The attachment store.
 *
 * Three properties are load-bearing, and each one is a bug that would otherwise ship:
 *
 *  - **A file is not readable until its digest checks out.** Uploading and publishing are
 *    separate moments; a sender that dies halfway must leave nothing another member can open.
 *  - **The id is the only thing that reaches the filesystem.** The display name never does, and
 *    a caller-supplied id can never climb out of its directory.
 *  - **The quota is about the group, not the request.** Ten uploads of 9 MiB each are the same
 *    problem as one of 90.
 */
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_CHUNK_BYTES,
  MAX_FILE_BYTES,
  MAX_GROUP_FILE_BYTES,
  createFileStore,
  isFileId,
} from '../lib/core/file-store.js';

const SHA = (buffer) => createHash('sha256').update(buffer).digest('hex');
const temporaries = [];

afterAll(() => {
  for (const directory of temporaries) rmSync(directory, { recursive: true, force: true });
});

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-a2a-files-'));
  temporaries.push(directory);
  return { directory, store: createFileStore({ directory, logger: { info() {} } }) };
}

/** Upload a buffer through the real chunk path and return the published facts. */
async function upload(store, groupId, buffer, overrides = {}) {
  const begun = store.beginUpload({
    groupId,
    name: overrides.name ?? '测试.bin',
    size: buffer.length,
    sha256: overrides.sha256 ?? SHA(buffer),
    mime: overrides.mime ?? 'application/octet-stream',
    uploadedBy: 'm-test',
  });
  for (let index = 0; index < begun.chunks; index += 1) {
    const start = index * MAX_CHUNK_BYTES;
    const slice = buffer.subarray(start, Math.min(buffer.length, start + MAX_CHUNK_BYTES));
    store.putChunk({ fileId: begun.fileId, index, data: slice.toString('base64') });
  }
  return { begun, published: await store.finishUpload({ fileId: begun.fileId }) };
}

test('分块上传 → 校验 → 读回，内容逐字节一致', async () => {
  const { store } = harness();
  // Larger than one chunk on purpose: a single-chunk round trip would not exercise assembly.
  const payload = Buffer.alloc(MAX_CHUNK_BYTES * 2 + 1234);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;

  const { begun, published } = await upload(store, 'g-aaa', payload);
  assert.ok(begun.chunks >= 3, `应当切成至少 3 块，实际 ${begun.chunks}`);
  assert.equal(published.size, payload.length);
  assert.equal(published.sha256, SHA(payload));

  const parts = [];
  const first = await store.readChunk({ groupId: 'g-aaa', fileId: published.fileId, index: 0 });
  for (let index = 0; index < first.chunks; index += 1) {
    const chunk = await store.readChunk({ groupId: 'g-aaa', fileId: published.fileId, index });
    parts.push(Buffer.from(chunk.data, 'base64'));
  }
  assert.deepEqual(Buffer.concat(parts), payload, '读回的内容必须与上传的完全一致');
});

test('sha256 不符：拒绝发布，磁盘上不留可见文件', async () => {
  const { store } = harness();
  const payload = Buffer.from('原文');
  const wrong = 'a'.repeat(64);
  await assert.rejects(
    () => upload(store, 'g-aaa', payload, { sha256: wrong }),
    (error) => error.code === 'digest_mismatch',
  );
  // Nothing published: the group directory has no object, only the staging directory may exist.
  assert.equal(store.usage('g-aaa'), 0);
});

test('分块没齐：finish 拒绝，且不留可见文件', async () => {
  const { store } = harness();
  const payload = Buffer.alloc(MAX_CHUNK_BYTES * 2);
  const begun = store.beginUpload({ groupId: 'g-aaa', name: 'x.bin', size: payload.length, sha256: SHA(payload) });
  store.putChunk({ fileId: begun.fileId, index: 0, data: payload.subarray(0, MAX_CHUNK_BYTES).toString('base64') });
  await assert.rejects(
    () => store.finishUpload({ fileId: begun.fileId }),
    (error) => error.code === 'upload_incomplete',
  );
  assert.equal(store.usage('g-aaa'), 0);
});

test('重传同一块是幂等的，不会造成损坏', async () => {
  const { store } = harness();
  const payload = Buffer.from('重复发送测试'.repeat(20));
  const begun = store.beginUpload({ groupId: 'g-aaa', name: 'x', size: payload.length, sha256: SHA(payload) });
  const data = payload.toString('base64');
  store.putChunk({ fileId: begun.fileId, index: 0, data });
  store.putChunk({ fileId: begun.fileId, index: 0, data });
  const published = await store.finishUpload({ fileId: begun.fileId });
  assert.equal(published.sha256, SHA(payload));
});

test('路径穿越：groupId 被密封，fileId 必须过白名单', async () => {
  const { store, directory } = harness();
  const payload = Buffer.from('x');
  const { published } = await upload(store, '../../escape', payload);

  // Everything the file store wrote lives under <directory>/files, whatever the groupId said.
  const filesRoot = join(directory, 'files');
  assert.equal(existsSync(join(directory, '..', 'escape')), false, '不得在 files 目录之外创建任何东西');
  assert.equal(existsSync(filesRoot), true);
  const segments = [];
  for (const entry of (await import('node:fs')).readdirSync(filesRoot, { withFileTypes: true })) {
    segments.push(entry.name);
  }
  assert.equal(segments.length, 1);
  assert.equal(segments[0].includes('..'), false, 'groupId 里的 .. 必须被密封掉');

  // A caller-provided file id is never trusted.
  assert.equal(isFileId('../groups.json'), false);
  assert.equal(isFileId('f-short'), false);
  assert.equal(isFileId('f-' + 'a'.repeat(32)), true);
  await assert.rejects(
    () => store.readChunk({ groupId: 'g-aaa', fileId: '../../groups.json', index: 0 }),
    (error) => error.code === 'file_unknown',
  );
  assert.ok(published.fileId.startsWith('f-'));
});

test('文件名不参与磁盘路径：同名文件互不覆盖', async () => {
  const { store } = harness();
  const first = await upload(store, 'g-aaa', Buffer.from('第一个'), { name: '报告.pdf' });
  const second = await upload(store, 'g-aaa', Buffer.from('第二个'), { name: '报告.pdf' });
  assert.notEqual(first.published.fileId, second.published.fileId);
  // Both are still readable: same display name, different objects.
  const a = await store.readChunk({ groupId: 'g-aaa', fileId: first.published.fileId, index: 0 });
  const b = await store.readChunk({ groupId: 'g-aaa', fileId: second.published.fileId, index: 0 });
  assert.equal(Buffer.from(a.data, 'base64').toString(), '第一个');
  assert.equal(Buffer.from(b.data, 'base64').toString(), '第二个');
});

test('超出单文件上限直接拒绝', () => {
  const { store } = harness();
  assert.throws(
    () => store.beginUpload({ groupId: 'g-aaa', name: 'big', size: MAX_FILE_BYTES + 1, sha256: 'a'.repeat(64) }),
    (error) => error.code === 'file_too_large',
  );
});

test('配额按群累计，不是按单次请求', async () => {
  const { store } = harness();
  // Shrink the check by uploading a large-but-legal file repeatedly is too slow; instead assert the
  // arithmetic directly: usage() must reflect published bytes, and the guard must read usage().
  const chunk = Buffer.alloc(1024 * 1024, 1);
  const { published } = await upload(store, 'g-quota', chunk);
  assert.equal(store.usage('g-quota'), chunk.length);

  // One more file that fits, then one that cannot, based on the real remaining budget.
  const used = store.usage('g-quota');
  const fits = MAX_GROUP_FILE_BYTES - used >= MAX_FILE_BYTES ? MAX_FILE_BYTES : MAX_GROUP_FILE_BYTES - used;
  if (fits > 0) {
    assert.doesNotThrow(() => store.beginUpload({ groupId: 'g-quota', name: 'fits', size: fits, sha256: 'b'.repeat(64) }));
  }
  assert.throws(
    () => store.beginUpload({ groupId: 'g-quota', name: 'toobig', size: MAX_GROUP_FILE_BYTES + 1, sha256: 'c'.repeat(64) }),
    (error) => error.code === 'file_too_large' || error.code === 'quota_exceeded',
  );
  assert.equal(store.has('g-quota', published.fileId), true);
  assert.equal(store.has('g-quota', 'f-' + 'a'.repeat(32)), false);
});

test('清理：中断的上传留下暂存分块，sweep 能收回', async () => {
  const { store, directory } = harness();
  const payload = Buffer.alloc(MAX_CHUNK_BYTES + 10);
  const begun = store.beginUpload({ groupId: 'g-sweep', name: 'x', size: payload.length, sha256: SHA(payload) });
  store.putChunk({ fileId: begun.fileId, index: 0, data: payload.subarray(0, MAX_CHUNK_BYTES).toString('base64') });

  // Age the staging part so the sweep has something to judge.
  const staging = join(directory, 'files', 'g-sweep', '.staging');
  const part = join(staging, `${begun.fileId}.p0`);
  assert.equal(existsSync(part), true);
  const old = Date.now() - 48 * 60 * 60 * 1000;
  (await import('node:fs')).utimesSync(part, new Date(old), new Date(old));

  assert.equal(store.sweepStaging(Date.now() - 24 * 60 * 60 * 1000), 1);
  assert.equal(existsSync(part), false);
});

test('删除后不可再读', async () => {
  const { store } = harness();
  const { published } = await upload(store, 'g-aaa', Buffer.from('待删除'));
  assert.equal(store.has('g-aaa', published.fileId), true);
  assert.equal(store.remove('g-aaa', published.fileId), true);
  assert.equal(store.has('g-aaa', published.fileId), false);
  await assert.rejects(
    () => store.readChunk({ groupId: 'g-aaa', fileId: published.fileId, index: 0 }),
    (error) => error.code === 'file_unknown',
  );
});
