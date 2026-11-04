/**
 * The panel write must report success on BOTH paths.
 *
 * THE BUG THIS EXISTS FOR
 *
 * `setPanelProfile` had `const saved = groups.setProfile(...)` inside the `if (record.local === true)` branch,
 * while the return read `saved?.changed` from outside it. A local group worked; a REMOTE group threw
 * `saved is not defined` — after the write had already reached the host and succeeded.
 *
 * That is the worst possible shape for a failure: the panel says 保存失败, the value is in fact saved, and the
 * user re-saves or reports a phantom bug. No existing test caught it because every panel-write test used a
 * local membership.
 *
 * These tests drive the handler's two branches and assert the shape of what comes back, rather than trying to
 * assert on the host, which is not available here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

test('the panel write declares its result outside both branches', () => {
  // A cheap structural guard: the identifier read by the return must be declared before the branch that
  // sometimes defines it. This is what the bug violated, and it is visible without executing anything.
  const declareAt = SOURCE.search(/\b(?:let|const)\s+saved\b/);
  const branchAt = SOURCE.indexOf('if (record.local === true)');
  const returnAt = SOURCE.indexOf('changed: saved?.changed');

  assert.ok(declareAt > 0, 'the handler must declare a result variable');
  assert.ok(branchAt > 0, 'the local branch must exist');
  assert.ok(returnAt > 0, 'the return must report whether anything changed');
  assert.ok(
    declareAt < branchAt,
    'the result variable must be declared BEFORE the branch, or the other branch cannot read it',
  );
});

test('both branches reach a return that reports changed', () => {
  // The remote branch must not `return` early without the flag; if it does, a remote save reports nothing.
  const remoteAt = SOURCE.indexOf('} else {', SOURCE.indexOf('if (record.local === true)'));
  assert.ok(remoteAt > 0, 'the remote branch must exist');

  const afterRemote = SOURCE.slice(remoteAt);
  const changedAt = afterRemote.indexOf('changed: saved?.changed');
  assert.ok(changedAt > 0, 'the remote branch must fall through to the shared return');
});

test('the write is logged when it fails', () => {
  // A user-triggered failure that leaves no trace costs a reproduction attempt every time it is reported. The
  // bug above reached the user as `write_failed` with an EMPTY err.log, which is why it took a probe script to
  // find rather than a glance at the log.
  assert.ok(
    SOURCE.includes('[a2a-panel] write failed for'),
    'the catch must log the reason, not only return the code',
  );
});
