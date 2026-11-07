import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyHome, resolveHome } from '../lib/core/config.js';

/**
 * These guard state-directory placement, after a real machine was found holding the plugin's live
 * ledger at `E:\a2a\memberships.json` while every other Harness file lived under `~/.dsh`.
 *
 * The cause was not a default, it was an invention: the plugin fell back to `process.cwd()` where
 * the Harness's own rule (`@deepseek-ai/dsh-home-paths`) is configured -> `$DSH_HOME` -> `~/.dsh`,
 * explicitly documenting that a blank `DSH_HOME` must never resolve to the current directory.
 */

const SETTINGS = { groups: { home: '' } };

test('configured groups.home always wins', () => {
  assert.equal(
    resolveHome({ groups: { home: 'D:/pinned/a2a' } }, { DSH_HOME: 'C:/x/.dsh' }, () => 'C:/ignored/a2a'),
    'D:/pinned/a2a',
  );
});

test('the host resolver outranks the environment', () => {
  // ctx.dshHomePath knows about a configured home that never reaches process.env.
  assert.equal(
    resolveHome(SETTINGS, { DSH_HOME: 'D:/from-env' }, (...segments) => `C:/from-host/${segments.join('/')}`),
    'C:/from-host/a2a',
  );
});

test('a throwing host resolver does not stop the plugin mounting', () => {
  assert.equal(
    resolveHome(SETTINGS, { DSH_HOME: 'D:/from-env' }, () => {
      throw new Error('boom');
    }),
    'D:/from-env/a2a',
  );
});

test('$DSH_HOME is honoured', () => {
  assert.equal(resolveHome(SETTINGS, { DSH_HOME: 'D:/alt' }), 'D:/alt/a2a');
});

test('a blank $DSH_HOME never resolves to the current directory', () => {
  // The Harness documents this explicitly; getting it wrong is what created the split state root.
  const home = resolveHome(SETTINGS, { DSH_HOME: '   ' });
  assert.ok(home.endsWith('/.dsh/a2a'), `expected the home-dir default, got ${home}`);
  assert.ok(!home.includes(process.cwd()), `must not depend on cwd, got ${home}`);
});

test('legacy state in the current directory is adopted, not abandoned', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'a2a-legacy-'));
  const target = mkdtempSync(join(tmpdir(), 'a2a-target-'));
  try {
    mkdirSync(join(cwd, 'a2a'), { recursive: true });
    writeFileSync(join(cwd, 'a2a', 'memberships.json'), '{"version":1,"memberships":[]}', 'utf8');
    writeFileSync(join(cwd, 'a2a', 'session-settings.json'), '{}', 'utf8');

    const lines = [];
    const result = migrateLegacyHome(join(target, 'a2a'), { DSH_CWD: cwd }, (line) => lines.push(line));

    assert.ok(result !== undefined, 'expected a migration');
    assert.deepEqual(result.moved.sort(), ['memberships.json', 'session-settings.json']);
    assert.deepEqual(result.failed, [], 'nothing should fail here');
    assert.ok(existsSync(join(target, 'a2a', 'memberships.json')), 'ledger must exist at the canonical path');
    // The old location explains itself rather than looking like a deletion.
    assert.match(readFileSync(join(cwd, 'a2a', 'MOVED-TO.txt'), 'utf8'), /state moved to/u);
    assert.equal(lines.length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('a migration that cannot read the legacy directory throws instead of pretending success', () => {
  // This is our own code, so a failure is a bug and must reach the caller. The earlier version
  // wrapped everything in `catch { return undefined }`, which turned a broken migration into an
  // empty ledger with no explanation — precisely the "all my groups are gone" symptom the migration
  // exists to prevent.
  const cwd = mkdtempSync(join(tmpdir(), 'a2a-broken-'));
  try {
    mkdirSync(join(cwd, 'a2a'), { recursive: true });
    writeFileSync(join(cwd, 'a2a', 'memberships.json'), '{"version":1,"memberships":[]}', 'utf8');
    // A target that cannot be created: a regular file sits where the directory must go.
    const blocked = join(cwd, 'blocked');
    writeFileSync(blocked, 'not a directory', 'utf8');
    assert.throws(() => migrateLegacyHome(join(blocked, 'a2a'), { DSH_CWD: cwd }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('migration never overwrites a canonical copy that already exists', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'a2a-legacy2-'));
  const target = mkdtempSync(join(tmpdir(), 'a2a-target2-'));
  try {
    mkdirSync(join(cwd, 'a2a'), { recursive: true });
    writeFileSync(join(cwd, 'a2a', 'memberships.json'), '{"from":"legacy"}', 'utf8');
    mkdirSync(join(target, 'a2a'), { recursive: true });
    writeFileSync(join(target, 'a2a', 'memberships.json'), '{"from":"canonical"}', 'utf8');

    const result = migrateLegacyHome(join(target, 'a2a'), { DSH_CWD: cwd });

    assert.equal(result, undefined, 'a populated canonical directory means nothing to do');
    assert.match(readFileSync(join(target, 'a2a', 'memberships.json'), 'utf8'), /canonical/u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('nothing to migrate is a quiet no-op', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'a2a-empty-'));
  try {
    assert.equal(migrateLegacyHome(join(cwd, 'canonical'), { DSH_CWD: cwd }), undefined);
    assert.equal(existsSync(join(cwd, 'canonical')), false, 'must not create a directory for nothing');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
