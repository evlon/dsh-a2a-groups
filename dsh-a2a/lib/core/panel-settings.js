/**
 * Per-Session settings that override the profile defaults.
 *
 * WHY A SEPARATE FILE
 *
 * The Host's configuration is profile-wide: `normalizeConfig` produces one object for the whole instance, and there is
 * no per-Session configuration seam to hang a value on. But the honest unit for "should my Session stop and ask me
 * before acting on a colleague's message" is the Session, because the same person works differently in a scratch
 * conversation and in a long-running project.
 *
 * So the profile holds the DEFAULT and this file holds the OVERRIDES. Every override carries `inherit`: when it is
 * true the stored values are ignored and the profile default applies. That flag is what makes the model maintainable —
 * without it, a Session that was tuned once would silently stop following a later change to the default, and nobody
 * would remember why.
 *
 * SHAPE
 *
 *   { "sessions": { "<sessionId>": { "inherit": false, "humanConfirm": { ... } } } }
 *
 * Only fields the person actually changed are stored; anything absent falls back to the profile.
 *
 * @module dsh-a2a/panel-settings
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Fields a Session may override. Kept explicit so a stray key cannot smuggle in an unvalidated setting. */
export const OVERRIDABLE_FIELDS = Object.freeze(['enabled', 'trigger', 'channel', 'onTimeout', 'timeoutMs']);

/**
 * Build the settings store.
 *
 * @param {object} options - `{ home, logger, clock }`.
 * @returns {object} store.
 */
export function createPanelSettings({ home, logger, clock = () => Date.now() }) {
  const file = join(home, 'session-settings.json');

  /** @type {{sessions: Object<string, object>}} */
  let state = { sessions: {} };
  let loaded = false;

  /** Read from disk once, tolerating a missing or corrupt file. */
  function load() {
    if (loaded) return;
    loaded = true;
    try {
      if (!existsSync(file)) return;
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.sessions === 'object' && parsed.sessions !== null) {
        state = { sessions: parsed.sessions };
      }
    } catch (error) {
      // A corrupt file must not stop the panel. Starting empty means every Session inherits the profile default, which
      // is the safe direction: it cannot invent an override nobody set.
      logger?.warn?.(`panel settings unreadable, starting empty: ${String(error?.message ?? error)}`);
      state = { sessions: {} };
    }
  }

  /** Write atomically, so a crash mid-write cannot leave a half file. */
  function persist() {
    try {
      mkdirSync(home, { recursive: true });
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
      renameSync(temp, file);
    } catch (error) {
      logger?.warn?.(`panel settings not persisted: ${String(error?.message ?? error)}`);
    }
  }

  /**
   * The values a Session actually uses.
   *
   * @param {string} sessionId - the Session.
   * @param {object} profileDefault - the profile's `humanConfirm` block.
   * @returns {{ inherit: boolean, effective: object, override: object|null }} what applies, and where it came from.
   */
  function effectiveFor(sessionId, profileDefault) {
    load();
    const stored = typeof sessionId === 'string' && sessionId !== '' ? state.sessions[sessionId] : undefined;
    // No record, or an explicit inherit: the profile decides.
    if (stored === undefined || stored.inherit !== false) {
      return { inherit: true, effective: { ...profileDefault }, override: null };
    }
    const override = stored.humanConfirm !== null && typeof stored.humanConfirm === 'object'
      ? stored.humanConfirm
      : {};
    // Merge field by field so an override that changed only `onTimeout` still follows the profile for everything else.
    const effective = { ...profileDefault };
    for (const field of OVERRIDABLE_FIELDS) {
      if (override[field] !== undefined) effective[field] = override[field];
    }
    return { inherit: false, effective, override };
  }

  /**
   * Record a Session's own values, or its decision to inherit again.
   *
   * @param {object} input - `{ sessionId, inherit, humanConfirm }`.
   * @returns {{ inherit: boolean, effective: object }} what now applies.
   */
  function set({ sessionId, inherit, humanConfirm }, profileDefault) {
    load();
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('set() needs a sessionId: settings are per Session');
    }
    if (inherit === true) {
      // Keep the record but mark it as following the profile. Deleting it instead would lose the person's earlier
      // choices, so re-enabling inherit would have to start from scratch.
      state.sessions[sessionId] = { inherit: true, updatedAt: clock() };
      persist();
      return effectiveFor(sessionId, profileDefault);
    }
    // MERGE, do not replace.
    //
    // The panel sends one field per change (see its save()), so replacing the stored block would discard every earlier
    // choice: enabling confirmation, then changing the trigger, would silently turn confirmation back off. Measured by
    // test — three successive single-field writes left only the last one in force.
    const existing = state.sessions[sessionId];
    const previous = existing !== null && typeof existing === 'object'
      && existing.inherit === false && existing.humanConfirm !== null && typeof existing.humanConfirm === 'object'
      ? existing.humanConfirm
      : {};
    const merged = { ...previous };
    for (const field of OVERRIDABLE_FIELDS) {
      if (humanConfirm !== null && typeof humanConfirm === 'object' && humanConfirm[field] !== undefined) {
        merged[field] = humanConfirm[field];
      }
    }
    state.sessions[sessionId] = { inherit: false, humanConfirm: merged, updatedAt: clock() };
    persist();
    return effectiveFor(sessionId, profileDefault);
  }

  /** Everything stored, for the panel's summary view. @returns {object} a copy. */
  function all() {
    load();
    return JSON.parse(JSON.stringify(state.sessions));
  }

  return { effectiveFor, set, all, file };
}
