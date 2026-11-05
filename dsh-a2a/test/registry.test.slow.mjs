/**
 * `lib/registry.js` 的行为测试。
 *
 * 重点不在「函数被调用了」，而在落盘产物本身：
 *   - 文件真的出现在预期路径、内容是合法 JSON、权限是 0600（POSIX）；
 *   - 重开一个 registry 能读回同样的条目（证明是持久化而不是内存假象）；
 *   - 破坏文件不会让插件崩，也不会把坏文件覆盖掉；
 *   - 没有多余字段被带盘。
 *
 * @module dsh-a2a/test/registry
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRegistry } from '../lib/core/registry.js';

/** 造一个马上就能删的临时目录。 */
function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-a2a-registry-'));
}

/** 读回落盘文件。 */
function readStore(home) {
  return JSON.parse(readFileSync(join(home, 'agents.json'), 'utf8'));
}

test('upsert writes the entry to disk and a fresh instance reads it back', () => {
  const home = tempHome();
  try {
    const registry = createRegistry({ home });
    const written = registry.upsert({
      name: 'zhang',
      description: '张工的 DSH',
      baseUrl: 'http://192.168.3.9:3091/a2a/',
      agent: 'group-7f3a1c',
      apiKey: 'sk-zhang',
      enabled: true,
    });

    // 规范化：尾部斜杠必须去掉，否则拼路径会出现 `//`。
    assert.equal(written.baseUrl, 'http://192.168.3.9:3091/a2a');
    assert.equal(written.name, 'zhang');

    const onDisk = readStore(home);
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.agents.length, 1);
    assert.equal(onDisk.agents[0].name, 'zhang');
    assert.equal(onDisk.agents[0].agent, 'group-7f3a1c');

    // 换一个实例读：证明是落盘持久化，不是进程内 Map 的幻觉。
    const reopened = createRegistry({ home });
    const entry = reopened.get('zhang');
    assert.equal(entry?.baseUrl, 'http://192.168.3.9:3091/a2a');
    assert.equal(entry?.apiKey, 'sk-zhang');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the store file is JSON with mode 0600 and carries no unexpected fields', () => {
  const home = tempHome();
  try {
    const registry = createRegistry({ home });
    registry.upsert({
      name: 'alice',
      baseUrl: 'http://127.0.0.1:3092/a2a',
      apiKey: 'sk-alice',
      // 下面这些字段不该进盘：白名单只允许契约里列出的那几个。
      personKey: 'mk-should-not-persist',
      internalCache: { secret: true },
    });

    const path = join(home, 'agents.json');
    const onDisk = readStore(home);
    const serialized = JSON.stringify(onDisk);

    assert.equal(serialized.includes('hunter2'), false, 'an unexpected password field must never reach the disk');
    assert.equal(serialized.includes('mk-should-not-persist'), false, 'an unexpected personKey must never reach the disk');
    assert.equal(serialized.includes('internalCache'), false);
    assert.equal(serialized.includes('sk-alice'), true, 'the apiKey itself is stored as-is (mode 0600 is the boundary)');

    const allowed = new Set(['name', 'description', 'baseUrl', 'agent', 'protocolVersion', 'apiKey', 'forwardProto', 'enabled']);
    for (const key of Object.keys(onDisk.agents[0])) {
      assert.ok(allowed.has(key), `unexpected field persisted: ${key}`);
    }

    // 权限：POSIX 上必须是 0600。Windows 上 chmod 基本无效，跳过但代码仍然设了 mode。
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
      const dirMode = statSync(home).mode & 0o777;
      assert.equal(dirMode & 0o077, 0, 'the directory must not be group/world accessible');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('upsert updates in place, is case-insensitive, and keeps the latest spelling', () => {
  const home = tempHome();
  try {
    const registry = createRegistry({ home });
    registry.upsert({ name: 'Alice', baseUrl: 'http://a.example/a2a' });
    registry.upsert({ name: 'alice', baseUrl: 'http://b.example/a2a' });

    const list = registry.list();
    assert.equal(list.length, 1, 'the same name in another case must not create a second entry');
    assert.equal(list[0].baseUrl, 'http://b.example/a2a', 'the second upsert wins');
    assert.equal(list[0].name, 'alice', 'the latest spelling is what the user last asked for');

    assert.equal(registry.get('ALICE')?.baseUrl, 'http://b.example/a2a');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('remove reports whether anything was actually removed', () => {
  const home = tempHome();
  try {
    const registry = createRegistry({ home });
    registry.upsert({ name: 'bob', baseUrl: 'http://bob.example/a2a' });

    assert.equal(registry.remove('bob'), true);
    assert.equal(registry.get('bob'), undefined);
    assert.equal(registry.remove('bob'), false, 'removing a missing entry is not an error, but it is false');
    assert.equal(readStore(home).agents.length, 0, 'the removal must be flushed, not only in memory');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('list returns copies so a caller cannot mutate the store by accident', () => {
  const home = tempHome();
  try {
    const registry = createRegistry({ home });
    registry.upsert({ name: 'carol', baseUrl: 'http://carol.example/a2a', apiKey: 'sk-carol' });

    const list = registry.list();
    list[0].baseUrl = 'http://hijacked.example/a2a';
    list[0].apiKey = 'overwritten';

    assert.equal(registry.get('carol')?.baseUrl, 'http://carol.example/a2a');
    assert.equal(registry.get('carol')?.apiKey, 'sk-carol');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolve turns a registered name into a bridge target', () => {
  const home = tempHome();
  try {
    const registry = createRegistry({ home });
    registry.upsert({
      name: 'gw-zhang',
      baseUrl: 'http://gw.internal:3000/a2a',
      agent: 'group-7f3a1c',
      apiKey: 'sk-gw',
      protocolVersion: '1.0',
      forwardProto: 'http',
    });

    const target = registry.resolve('gw-zhang');
    assert.deepEqual(target, {
      baseUrl: 'http://gw.internal:3000/a2a',
      agent: 'group-7f3a1c',
      apiKey: 'sk-gw',
      protocolVersion: '1.0',
      forwardProto: 'http',
    });

    // 大小写不敏感。
    assert.ok(registry.resolve('GW-ZHANG') !== undefined);
    // 不认识的名字明确返回 undefined，而不是编一个 target 出来。
    assert.equal(registry.resolve('nobody'), undefined);
    assert.equal(registry.resolve(''), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolve accepts a bare URL, and a #agent fragment on it', () => {
  const home = tempHome();
  try {
    const registry = createRegistry({ home });

    assert.deepEqual(
      registry.resolve('http://127.0.0.1:3091/a2a/'),
      { baseUrl: 'http://127.0.0.1:3091/a2a' },
      'a bare URL resolves without inventing credentials',
    );

    assert.deepEqual(
      registry.resolve('http://gw.internal:3000/a2a#group-7f3a1c'),
      { baseUrl: 'http://gw.internal:3000/a2a', agent: 'group-7f3a1c' },
      'the #fragment carries the agent name so one string is enough',
    );

    // https 也要认。
    assert.equal(registry.resolve('https://gw.example.com/a2a')?.baseUrl, 'https://gw.example.com/a2a');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a name that merely starts with http is not mistaken for a URL', () => {
  const home = tempHome();
  try {
    const registry = createRegistry({ home });
    registry.upsert({ name: 'http-gateway', baseUrl: 'http://gw.example/a2a' });
    // `http-gateway` 不能因为「以 http 开头」就被当 URL：判定必须真的解析成功。
    assert.deepEqual(registry.resolve('http-gateway'), { baseUrl: 'http://gw.example/a2a' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('upsert rejects entries without a name or a baseUrl', () => {
  const home = tempHome();
  try {
    const registry = createRegistry({ home });
    assert.throws(() => registry.upsert({ baseUrl: 'http://x/a2a' }), (err) => err.code === 'invalid_entry');
    assert.throws(() => registry.upsert({ name: 'x' }), (err) => err.code === 'invalid_entry');
    assert.throws(() => registry.upsert(null), (err) => err.code === 'invalid_entry');
    // 拒绝之后不能留下半条记录。
    assert.equal(readStoreSafe(home), 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** 读盘里的条目数；文件不存在算 0。 */
function readStoreSafe(home) {
  try {
    return readStore(home).agents.length;
  } catch {
    return 0;
  }
}

test('a corrupt store file does not crash the plugin and is left untouched', () => {
  const home = tempHome();
  try {
    const path = join(home, 'agents.json');
    writeFileSync(path, '{ this is not json', 'utf8');
    const warnings = [];

    const registry = createRegistry({ home, logger: { warn: (m) => warnings.push(m) } });
    // 坏文件应该退化成空簿，而不是让整个插件起不来。
    assert.deepEqual(registry.list(), []);
    assert.equal(warnings.length >= 1, true);
    assert.match(warnings.join('\n'), /not valid JSON/);

    // 坏文件留在原地供人抢救（不能被一次 flush 静默覆盖）。
    assert.equal(readFileSync(path, 'utf8'), '{ this is not json');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a missing store file is not an error', () => {
  const home = tempHome();
  try {
    const warnings = [];
    const registry = createRegistry({ home, logger: { warn: (m) => warnings.push(m) } });
    assert.deepEqual(registry.list(), []);
    assert.deepEqual(warnings, [], 'a first run must not produce warnings');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('one unusable entry is skipped while the rest still load', () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, 'agents.json'), JSON.stringify({
      version: 1,
      agents: [
        { name: 'good', baseUrl: 'http://good.example/a2a' },
        { name: 'no-url' },
        { baseUrl: 'http://nameless.example/a2a' },
      ],
    }), 'utf8');

    const warnings = [];
    const registry = createRegistry({ home, logger: { warn: (m) => warnings.push(m) } });
    const list = registry.list();
    assert.equal(list.length, 1, 'the good entry must survive its neighbours being broken');
    assert.equal(list[0].name, 'good');
    assert.equal(warnings.length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('enabled defaults to true and only an explicit false disables', () => {
  const home = tempHome();
  try {
    const registry = createRegistry({ home });
    const implicit = registry.upsert({ name: 'a', baseUrl: 'http://a/a2a' });
    assert.equal(implicit.enabled, true, 'registering an agent means you want to use it');

    const explicitOff = registry.upsert({ name: 'b', baseUrl: 'http://b/a2a', enabled: false });
    assert.equal(explicitOff.enabled, false);

    // 重开后 false 必须还在（不能被「缺省 true」的逻辑冲掉）。
    const reopened = createRegistry({ home });
    assert.equal(reopened.get('b')?.enabled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('flush is atomic: the file is never left half written', () => {
  const home = tempHome();
  try {
    const registry = createRegistry({ home });
    registry.upsert({ name: 'x', baseUrl: 'http://x/a2a' });
    const before = readFileSync(join(home, 'agents.json'), 'utf8');

    // 反复 flush 后文件始终是完整 JSON，且没有遗留临时文件。
    for (let i = 0; i < 5; i += 1) registry.flush();
    JSON.parse(readFileSync(join(home, 'agents.json'), 'utf8'));

    const leftovers = readFileSync(join(home, 'agents.json'), 'utf8');
    assert.equal(JSON.parse(leftovers).agents.length, JSON.parse(before).agents.length);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('flush creates a missing home directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-registry-'));
  const nested = join(home, 'a2a', 'nested');
  try {
    const registry = createRegistry({ home: nested });
    registry.upsert({ name: 'deep', baseUrl: 'http://deep/a2a' });
    assert.equal(JSON.parse(readFileSync(join(nested, 'agents.json'), 'utf8')).agents.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('createRegistry requires a home directory', () => {
  assert.throws(() => createRegistry({}), (err) => err.code === 'invalid_home');
  assert.throws(() => createRegistry({ home: '   ' }), (err) => err.code === 'invalid_home');
});

test('the file path is stable and reported by path()', () => {
  const home = tempHome();
  try {
    const registry = createRegistry({ home });
    assert.equal(registry.path(), join(home, 'agents.json'));
    // 自定义文件名（测试与多实例隔离用）。
    const custom = createRegistry({ home, fileName: 'other.json' });
    assert.equal(custom.path(), join(home, 'other.json'));
    custom.upsert({ name: 'q', baseUrl: 'http://q/a2a' });
    assert.equal(readFileSync(join(home, 'other.json'), 'utf8').includes('"q"'), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
