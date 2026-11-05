import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suite is `.mjs` and imports the plugin's real ESM sources directly — no transform step, no jsdom. These are
    // integration tests against a real store and a real HTTP listener, not component tests.
    include: ['test/**/*.test.mjs'],
    // Real listeners and on-disk state per test mean these are slower than pure unit tests, but each file owns its
    // temp directory, so they stay independent and can run in one process without colliding.
    pool: 'forks',
    // A failing `assert.rejects` inside a real A2A round trip can take a few seconds; the default 5s was tight
    // against the timeout paths the failure tests exercise.
    testTimeout: 30000,
    hookTimeout: 30000,
    // The old runner printed per-test lines; keep that, because these names carry the reasoning and a silent pass
    // makes it impossible to see what actually ran.
    reporters: ['verbose'],
  },
});
