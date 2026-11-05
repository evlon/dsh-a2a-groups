/**
 * A field the Host sends must survive the panel's normaliser, or no renderer will ever see it.
 *
 * THE BUG
 *
 * `lib/index.js` puts `rosterStale` and `unreachableAt` on every group row, because those two facts decide whether
 * the panel is allowed to present a cached roster as current. `normalizeGroup` in client.js rebuilds each row
 * field-by-field and did not copy them.
 *
 * So both warnings were dead code: the Host supplied the facts, the normaliser dropped them, and the brand-new
 * "名单来自缓存" line could never render. A user reading a 50-minute-old roster saw it as current, which is exactly
 * the failure the warning existed to prevent.
 *
 * WHY THIS CLASS OF BUG KEEPS HAPPENING
 *
 * There are two mappers between the Host and the screen — the snapshot builder and `normalizeGroup` — and each
 * rebuilds objects by whitelist. A new field has to be added to both, and forgetting the second produces no error
 * anywhere: the value is simply `undefined`, which reads the same as "not applicable".
 *
 * @module dsh-a2a/test/panel-health-flags
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('client.js', 'utf8');

/** The text of `function normalizeGroup(...) { ... }`, found by brace matching. */
function normalizeGroupBody() {
  const start = SOURCE.indexOf('function normalizeGroup(');
  if (start < 0) throw new Error('normalizeGroup not found in client.js');
  const open = SOURCE.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < SOURCE.length; index += 1) {
    const char = SOURCE[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(open, index + 1);
    }
  }
  throw new Error('normalizeGroup body did not close');
}

test('normalizeGroup carries rosterStale through', () => {
  const body = normalizeGroupBody();
  // Without this the stale-cache warning is unreachable regardless of what the Host sends.
  assert.match(body, /rosterStale/u, 'a field the renderer reads must survive the normaliser');
});

test('normalizeGroup carries unreachableAt through', () => {
  const body = normalizeGroupBody();
  assert.match(body, /unreachableAt/u, 'the unreachable warning depends on this field reaching the pane');
});

test('both flags are read from raw, not invented', () => {
  const body = normalizeGroupBody();
  // A defaulted constant would make every group look stale (or never stale); only the Host knows.
  assert.match(body, /rosterStale:\s*raw\.rosterStale/u);
  assert.match(body, /unreachableAt:\s*Number\.isFinite\(raw\.unreachableAt\)/u);
});

test('the Host actually sends both fields', () => {
  // The other half of the contract. If the Host stopped sending them, the panel would silently show "fresh".
  const host = readFileSync('lib/index.js', 'utf8');
  assert.match(host, /rosterStale:/u, 'lib/index.js must publish rosterStale');
  assert.match(host, /unreachableAt:/u, 'lib/index.js must publish unreachableAt');
});

test('the stale warning is gated on the flag, not shown unconditionally', () => {
  // A warning that always shows is noise and gets tuned out; this asserts the condition still exists.
  assert.match(SOURCE, /rosterStale === true/u);
  // And it must defer to the louder unreachable warning rather than stacking two messages about one problem.
  assert.match(SOURCE, /rosterStale === true && Number\(group\.unreachableAt \|\| 0\) === 0/u);
});

test('presence is derived, never read from a cached boolean', () => {
  // `online` describes NOW, so a stored copy is wrong the moment it is written. The panel must compute it.
  assert.match(SOURCE, /function presenceOf\(raw\)/u);
  const uses = SOURCE.match(/presenceOf\(/gu) ?? [];
  assert.ok(uses.length >= 3, `expected the helper plus at least two call sites, saw ${uses.length}`);

  // The old reads must be gone: `raw.online === true` is only allowed inside the helper's fallback.
  const outsideHelper = SOURCE.split('function presenceOf(raw)')[0]
    + (SOURCE.split('function presenceOf(raw)')[1] ?? '').split('}')[0];
  assert.equal(
    /online:\s*raw\.online === true/u.test(SOURCE.replace(outsideHelper, '')),
    false,
    'no mapper may copy a cached online boolean',
  );
});
