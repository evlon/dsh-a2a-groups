import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isHomeUnstable, resolveHome } from '../lib/core/config.js';

/**
 * These guard a data-loss bug that was found in the field, not in the suite.
 *
 * A DSH started without DSH_HOME in its environment resolved its ledger to `${cwd}/a2a`. On the
 * machine where this was found the live ledger was at `E:\a2a\memberships.json` because that DSH
 * had been launched from `E:\`. Restarting it from anywhere else would present an empty ledger —
 * the user would see every group disappear, with nothing in the UI connecting the two facts.
 */

const SETTINGS = { groups: { home: '' } };

test('configured groups.home always wins', () => {
  assert.equal(resolveHome({ groups: { home: 'D:/pinned/a2a' } }, { DSH_HOME: 'C:/x/.dsh' }), 'D:/pinned/a2a');
});

test('DSH_HOME is used when configured', () => {
  assert.equal(resolveHome(SETTINGS, { DSH_HOME: 'C:/Users/x/.dsh' }), 'C:/Users/x/.dsh/a2a');
});

test('a fresh install lands in a stable place, not in the current directory', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'a2a-fresh-'));
  try {
    const home = resolveHome(SETTINGS, { DSH_CWD: cwd });
    assert.ok(!home.startsWith(cwd), `expected a cwd-independent home, got ${home}`);
    assert.ok(home.endsWith('/.dsh/a2a'), `expected the home-dir default, got ${home}`);
    assert.equal(isHomeUnstable(SETTINGS, { DSH_CWD: cwd }), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an existing ledger in the current directory is still found after upgrade', () => {
  // Backward compatibility: never orphan the state an installed version is already using.
  const cwd = mkdtempSync(join(tmpdir(), 'a2a-legacy-'));
  try {
    mkdirSync(join(cwd, 'a2a'), { recursive: true });
    writeFileSync(join(cwd, 'a2a', 'memberships.json'), '{"version":1,"memberships":[]}', 'utf8');
    assert.equal(resolveHome(SETTINGS, { DSH_CWD: cwd }), `${cwd.replace(/[\\/]+$/u, '')}/a2a`);
    // ...and it is flagged as unstable so the operator is told to pin groups.home.
    assert.equal(isHomeUnstable(SETTINGS, { DSH_CWD: cwd }), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('pinning groups.home clears the unstable flag', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'a2a-pinned-'));
  try {
    mkdirSync(join(cwd, 'a2a'), { recursive: true });
    writeFileSync(join(cwd, 'a2a', 'memberships.json'), '{"version":1,"memberships":[]}', 'utf8');
    assert.equal(isHomeUnstable({ groups: { home: 'D:/pinned/a2a' } }, { DSH_CWD: cwd }), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
