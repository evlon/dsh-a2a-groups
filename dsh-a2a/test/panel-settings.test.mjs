/**
 * Per-Session override of the profile default, and the inherit flag that makes it maintainable.
 *
 * The dangerous bug here is not a crash: it is an override that silently outlives the profile default. If a Session
 * that was tuned once keeps its old values after the default changes, nobody can explain the difference six months
 * later. So most of these tests are about `inherit` being honoured, and about a partial override following the profile
 * for every field it did not set.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { createPanelSettings } from '../lib/core/panel-settings.js';

const PROFILE = Object.freeze({
  enabled: false,
  trigger: 'mention',
  channel: 'question',
  onTimeout: 'deny',
  timeoutMs: 300000,
});

/** A store over a throwaway directory. */
function store() {
  const home = mkdtempSync(join(tmpdir(), 'a2a-panel-settings-'));
  return {
    home,
    settings: createPanelSettings({ home, logger: { info() {}, warn() {}, debug() {} }, clock: () => 1000 }),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('a Session with no record inherits the profile', () => {
  const { settings, cleanup } = store();
  try {
    const result = settings.effectiveFor('session-a', PROFILE);
    assert.equal(result.inherit, true);
    assert.deepEqual(result.effective, { ...PROFILE });
  } finally {
    cleanup();
  }
});

test('an override changes only what it names and follows the profile for the rest', () => {
  const { settings, cleanup } = store();
  try {
    settings.set({ sessionId: 'session-a', inherit: false, humanConfirm: { onTimeout: 'allow' } }, PROFILE);
    const result = settings.effectiveFor('session-a', PROFILE);
    assert.equal(result.inherit, false);
    assert.equal(result.effective.onTimeout, 'allow');
    // Everything else still comes from the profile.
    assert.equal(result.effective.trigger, PROFILE.trigger);
    assert.equal(result.effective.timeoutMs, PROFILE.timeoutMs);
  } finally {
    cleanup();
  }
});

test('switching back to inherit ignores the stored values without losing them', () => {
  const { settings, cleanup } = store();
  try {
    settings.set({ sessionId: 'session-a', inherit: false, humanConfirm: { enabled: true } }, PROFILE);
    assert.equal(settings.effectiveFor('session-a', PROFILE).effective.enabled, true);
    // Turn inheritance back on.
    settings.set({ sessionId: 'session-a', inherit: true }, PROFILE);
    assert.equal(settings.effectiveFor('session-a', PROFILE).effective.enabled, PROFILE.enabled);
    assert.equal(settings.effectiveFor('session-a', PROFILE).inherit, true);
  } finally {
    cleanup();
  }
});

test('the profile default changing takes effect for an inheriting Session', () => {
  // This is the whole reason `inherit` exists.
  const { settings, cleanup } = store();
  try {
    const before = settings.effectiveFor('session-a', PROFILE);
    assert.equal(before.effective.enabled, false);
    const changed = { ...PROFILE, enabled: true };
    const after = settings.effectiveFor('session-a', changed);
    assert.equal(after.effective.enabled, true, 'an inheriting Session must follow the profile');
  } finally {
    cleanup();
  }
});

test('the profile default changing does NOT touch an overriding Session', () => {
  const { settings, cleanup } = store();
  try {
    settings.set({ sessionId: 'session-a', inherit: false, humanConfirm: { timeoutMs: 60000 } }, PROFILE);
    const after = settings.effectiveFor('session-a', { ...PROFILE, timeoutMs: 9000, enabled: true });
    assert.equal(after.effective.timeoutMs, 60000, 'the Session chose this value');
    assert.equal(after.effective.enabled, true, 'a field it did not choose follows the profile');
  } finally {
    cleanup();
  }
});

test('two Sessions keep independent settings', () => {
  const { settings, cleanup } = store();
  try {
    settings.set({ sessionId: 'session-a', inherit: false, humanConfirm: { enabled: true } }, PROFILE);
    settings.set({ sessionId: 'session-b', inherit: false, humanConfirm: { enabled: false, onTimeout: 'never' } }, PROFILE);
    assert.equal(settings.effectiveFor('session-a', PROFILE).effective.enabled, true);
    assert.equal(settings.effectiveFor('session-b', PROFILE).effective.enabled, false);
    assert.equal(settings.effectiveFor('session-b', PROFILE).effective.onTimeout, 'never');
  } finally {
    cleanup();
  }
});

test('settings survive a restart', () => {
  const home = mkdtempSync(join(tmpdir(), 'a2a-panel-settings-'));
  try {
    const logger = { info() {}, warn() {}, debug() {} };
    const first = createPanelSettings({ home, logger, clock: () => 1 });
    first.set({ sessionId: 'session-a', inherit: false, humanConfirm: { onTimeout: 'allow' } }, PROFILE);
    // A fresh store over the same directory, as a process restart would produce.
    const second = createPanelSettings({ home, logger, clock: () => 2 });
    assert.equal(second.effectiveFor('session-a', PROFILE).effective.onTimeout, 'allow');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a corrupt settings file falls back to inherit rather than inventing an override', () => {
  const home = mkdtempSync(join(tmpdir(), 'a2a-panel-settings-'));
  try {
    writeFileSync(join(home, 'session-settings.json'), '{ not json', 'utf8');
    const settings = createPanelSettings({ home, logger: { info() {}, warn() {}, debug() {} }, clock: () => 1 });
    const result = settings.effectiveFor('session-a', PROFILE);
    // Safe direction: cannot invent values nobody set.
    assert.equal(result.inherit, true);
    assert.deepEqual(result.effective, { ...PROFILE });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an unknown field in a stored override is ignored', () => {
  const { settings, cleanup } = store();
  try {
    settings.set({ sessionId: 'session-a', inherit: false, humanConfirm: { enabled: true, bogus: 'x' } }, PROFILE);
    assert.equal(settings.effectiveFor('session-a', PROFILE).effective.bogus, undefined);
  } finally {
    cleanup();
  }
});

test('set() without a Session is refused instead of writing a shared value', () => {
  const { settings, cleanup } = store();
  try {
    assert.throws(() => settings.set({ inherit: false, humanConfirm: {} }, PROFILE), /sessionId/);
  } finally {
    cleanup();
  }
});
