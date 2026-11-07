import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A ratchet on silent error handling.
 *
 * The rule (主人, 2026-11-07): a fallback is justified only for user-supplied data or for code we do
 * not control — a host API, the network, the filesystem. When OUR OWN logic fails, a `catch {}` does
 * not make the program robust; it hides the bug. The concrete damage: a goal cache whose write
 * failed behind a bare catch rendered as "this group has no goal", so a broken write looked like an
 * unimplemented feature for a day.
 *
 * This is a BUDGET, not a ban, on purpose. Sixty existing sites exist and many are legitimate
 * (parsing untrusted JSON, best-effort chmod on Windows). Rewriting them all in one pass would be a
 * large risky diff for little gain. So the budget may only ever shrink: a new bare catch fails the
 * suite unless someone deliberately lowers a number here after auditing the site, which forces the
 * question "is this one of the two legitimate kinds?" to be answered out loud.
 */

/** Reviewed baseline, 2026-11-07. Lower these as sites are converted; never raise. */
const BUDGET = {
  'lib/core/bridge.js': 8,
  'lib/core/card.js': 1,
  'lib/core/file-store.js': 3,
  'lib/core/groups.js': 6,
  'lib/core/invite.js': 1,
  'lib/core/memberships.js': 3,
  'lib/core/public-origin.js': 2,
  'lib/core/registry.js': 3,
  'lib/core/server.js': 5,
  'lib/core/skills-group.js': 3,
  'lib/core/wire.js': 5,
  'lib/dsh/deliver.js': 3,
  'lib/dsh/human-confirm.js': 1,
  'lib/dsh/inbox.js': 2,
  'lib/dsh/profile.js': 1,
  'lib/dsh/tools.js': 4,
  'lib/index.js': 0,
  'lib/mcp-server.js': 1,
  'lib/shared/tool-runtime.js': 7,
};

/** Source files under lib/, excluding the browser bundle which is not error-handling code. */
function sourceFiles(directory = 'lib', found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (entry.name.endsWith('.js') && entry.name !== 'client.js') found.push(path);
  }
  return found;
}

/** Count `} catch {` — a catch that binds no error and therefore cannot report anything. */
function countBare(text) {
  return (text.match(/^\s*\} catch \{/gmu) ?? []).length;
}

test('no file exceeds its reviewed budget of bare error handlers', () => {
  const over = [];
  let total = 0;
  for (const file of sourceFiles()) {
    const key = file.split('\\').join('/');
    const count = countBare(readFileSync(file, 'utf8'));
    total += count;
    const limit = BUDGET[key] ?? 0;
    if (count > limit) over.push(`${key}: ${count} > ${limit}`);
  }
  assert.deepEqual(over, [], `新的裸 catch 必须先审计再决定是否允许：\n${over.join('\n')}`);
  // The global number is informative, not asserted: it should trend down over time.
  assert.ok(total <= 60, `裸 catch 总数不得增长，当前 ${total}`);
});

test('a file with a zero budget has no bare catch at all', () => {
  // Where the baseline is already clean, keep it clean. This is the part that actually bites on a
  // new contribution: `lib/index.js` was taken to zero in this pass, so the next `catch {}` there
  // fails immediately instead of quietly raising a number.
  const cleaned = Object.entries(BUDGET)
    .filter(([, limit]) => limit === 0)
    .map(([file]) => file);
  const regressions = cleaned.filter((file) => countBare(readFileSync(file, 'utf8')) > 0);
  assert.deepEqual(regressions, [], `这些文件已经清零，不得重新出现裸 catch：\n${regressions.join('\n')}`);
});
