import { defineConfig } from 'vitest/config';

/**
 * Two tiers, selected by file EXTENSION rather than by directory.
 *
 *   *.test.mjs        fast  — pure in-memory logic: no listener, no temp directory, no child process. ~0.7s in total.
 *   *.test.slow.mjs   slow  — stands up a real HTTP listener, writes real files, or spawns a process. ~17s in total.
 *
 * Speed is the right axis, not module depth. `memberships-ledger` reads like a unit test and takes 2.7s because it
 * writes to disk; `client-syntax` inspects source text and takes milliseconds. Splitting by "which directory in lib/
 * does this cover" would put those in the wrong tiers and make the fast run useless for its only purpose: telling you
 * within a second whether you just broke something obvious.
 *
 * An extension (rather than a directory) keeps git history intact — no file moves — and keeps `ls test/` one flat,
 * greppable list. A directory split also implies a module boundary these tests do not have: `reply-to.test.mjs` covers
 * the store, the skill, the tool runtime and the tool spec at once.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs', 'test/**/*.test.slow.mjs'],
    // Each slow file owns its own temp directory and its own port, so they stay independent and can share one process.
    pool: 'forks',
    // A failing `assert.rejects` inside a real A2A round trip can take a few seconds; the default 5s was tight against
    // the timeout paths the failure tests exercise deliberately.
    testTimeout: 30000,
    hookTimeout: 30000,
    // The names carry the reasoning, so print them. A silent pass makes it impossible to see what actually ran.
    reporters: ['verbose'],
  },
});
