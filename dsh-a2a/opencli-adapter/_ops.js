// Shared selectors and helpers for the DSH Web adapter.
//
// WHY A SHARED MODULE
//
// Every command needs the same few answers: where the composer is, how to send, how to read the transcript, whether a
// turn is running, and how to make sure the page is on the right instance. Duplicating them is how selectors drift
// apart — one command keeps working after a DOM change while another silently starts clicking the wrong thing.
//
// SELECTOR POLICY
//
// Nothing here uses a hashed CSS-module class. `uV2eYG_input` is a build artifact: it changes whenever the frontend is
// rebuilt, and a selector that changes under you turns a test suite into a source of false failures. Everything keys
// off semantically stable attributes — `contenteditable`, `data-placeholder`, visible text, ARIA roles.
//
// SESSIONS AND NAVIGATION
//
// Adapter commands are separate processes, and without `siteSession: 'persistent'` each one starts on `about:blank`.
// Every command that touches the page therefore calls `ensureOnInstance` first: it reads the current URL and navigates
// only when it is not already on the instance it wants. That makes each command work whether it is the first or the
// eleventh in a test, without re-navigating and losing state on every call.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandExecutionError } from '@jackwener/opencli/errors';

/** The composer: a contenteditable div, identified by placeholder text rather than a hashed class. */
export const COMPOSER_SELECTORS = [
  'div[contenteditable="true"][data-placeholder*="发消息"]',
  'div[contenteditable="true"][data-placeholder*="Message"]',
  'div[contenteditable="true"]',
];

/** The transcript container, once the shell has mounted. */
export const SHELL_READY_LENGTH = 40;

/**
 * Unwrap the envelope `page.evaluate` returns.
 *
 * The bridge wraps results as `{ data, session }`. Reading `.data` when present and falling through otherwise handles
 * both shapes, because a plain value has no `data` property.
 *
 * @param {unknown} payload - raw evaluate result.
 * @returns {unknown} the useful value.
 */
export function unwrap(payload) {
  if (payload !== null && typeof payload === 'object'
    && Object.prototype.hasOwnProperty.call(payload, 'data')
    && Object.prototype.hasOwnProperty.call(payload, 'session')) {
    return payload.data;
  }
  return payload;
}

/** Evaluate and unwrap in one step. */
export async function evaluate(page, script) {
  return unwrap(await page.evaluate(script));
}

/**
 * Pull the access token out of an instance's startup log.
 *
 * The Host writes `dsh web: http://127.0.0.1:<port>/?token=<token>` to `out.log` when launched; that is the only place
 * the token exists in plaintext. Addressing an instance by port — the stable identity — is what keeps tests
 * maintainable, because the URL changes on every restart.
 *
 * @param {string} home - the instance DSH_HOME.
 * @returns {string|undefined} the token, when found.
 */
export function tokenFromLog(home) {
  for (const name of ['out.log', 'stdout.log', 'web.out.log']) {
    const path = join(home, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    const match = /token=([A-Za-z0-9_-]{8,})/u.exec(text);
    if (match !== null) return match[1];
  }
  return undefined;
}

/** Build the URL for an instance, optionally with a token and a path. */
export function instanceUrl(port, token, path) {
  const suffix = typeof path === 'string' && path !== '' ? (path.startsWith('/') ? path : '/' + path) : '/';
  const withToken = typeof token === 'string' && token !== '';
  return `http://127.0.0.1:${port}${suffix}${withToken ? (suffix.includes('?') ? '&' : '?') + 'token=' + token : ''}`;
}

/**
 * Make sure the page is on the given instance AND actually authenticated.
 *
 * Two things make this more than a `goto`:
 *
 * 1. **Re-navigation.** The token URL answers 303 to `/` with `Set-Cookie: dsh-auth-…; HttpOnly; SameSite=Strict`. The
 *    cookie therefore lands AFTER the document for that first response was already produced, and the page renders its
 *    401 body even though every same-origin request from it now succeeds. Observed directly: an in-page XHR to `/`
 *    returned 200 while the document on screen still said 「authentication required」. One reload fixes it, because by
 *    then the cookie is present when the request goes out.
 *
 * 2. **Stale pages.** A test may call this repeatedly; re-navigating every time would discard the open conversation, so
 *    the current URL is checked first and left alone when already on the instance and authenticated.
 *
 * @param {object} page - browser page handle.
 * @param {object} options - `{ port, token, path, timeoutMs }`.
 * @returns {Promise<object>} `{ navigated, reloaded, url }`.
 */
export async function ensureOnInstance(page, { port, token, path, timeoutMs = 30000 }) {
  const wanted = Number(port);
  const href = String(await evaluate(page, '(function () { return location.href; })()') ?? '');

  let onInstance = false;
  try {
    const parsed = new URL(href);
    onInstance = parsed.hostname === '127.0.0.1' && Number(parsed.port) === wanted;
  } catch {
    onInstance = false;
  }

  const authenticated = await isAuthenticated(page);

  if (onInstance && authenticated) return { navigated: false, reloaded: false, url: href };

  if (!onInstance) {
    await page.goto(instanceUrl(wanted, token, path));
  }

  // Whether this is a first load or a stale unauthenticated one, a reload is what settles it: on the first load the
  // cookie arrived too late for the document that was already produced.
  if (!(await isAuthenticated(page))) {
    await evaluate(page, '(function () { location.reload(); return true; })()');
  }

  const ready = await waitFor(
    async () => (await isAuthenticated(page)) && (await shellReady(page)),
    { timeoutMs, intervalMs: 400 },
  );

  const finalUrl = String(await evaluate(page, '(function () { return location.href; })()') ?? '');
  return { navigated: !onInstance, reloaded: true, url: finalUrl, ready };
}

/**
 * Whether the page is the authenticated app rather than the 401 notice.
 *
 * @param {object} page - browser page handle.
 * @returns {Promise<boolean>} true when the app rendered.
 */
export async function isAuthenticated(page) {
  const length = await evaluate(page, `(function () {
    const text = (document.body && document.body.innerText) || '';
    if (text.includes('authentication required')) return 0;
    return text.length;
  })()`);
  return Number(length) > SHELL_READY_LENGTH;
}

/** Whether the shell has enough content to be the real app (not the 401 notice, not an empty div). */
export async function shellReady(page) {
  return isAuthenticated(page);
}

/**
 * Wait until the app shell has mounted.
 *
 * "HTML arrived" is not the same as "the app mounted": the SPA serves an empty div first, and proceeding on that div
 * fails later with a message pointing at the wrong thing.
 *
 * @param {object} page - browser page handle.
 * @param {number} timeoutMs - budget.
 * @returns {Promise<boolean>} whether the shell appeared.
 */
export async function waitForShell(page, timeoutMs = 30000) {
  return waitFor(
    async () => {
      const length = await evaluate(page, '(function () { return ((document.body && document.body.innerText) || "").length; })()');
      return Number(length) > SHELL_READY_LENGTH;
    },
    { timeoutMs, intervalMs: 300, label: 'app shell' },
  );
}

/**
 * Put text into the composer.
 *
 * WHY `page.fillText` AND NOT A HAND-ROLLED DOM WRITE
 *
 * Setting `textContent` (and even `execCommand('insertText')`) left the composer empty from the framework's point of
 * view: the box showed nothing, the send never fired, and the failure looked like a broken selector. `page.fillText` is
 * the bridge's own implementation — the same one `opencli browser fill` exposes — and it drives the input the way a
 * user's keystrokes do, so the framework's state updates and the value survives.
 *
 * Measured on this app: with `fillText` the composer reports `filled: true, verified: true` and the DOM holds the text;
 * with a scripted `textContent` write the DOM held it too, but the send did nothing.
 *
 * @param {object} page - browser page handle.
 * @param {string} text - what to write.
 * @returns {Promise<object>} `{ ok, actual }` — the text the DOM holds.
 */
export async function writeComposer(page, text) {
  try {
    await page.fillText('div[contenteditable="true"]', text);
  } catch (error) {
    return { ok: false, actual: '', reason: String((error && error.message) || error) };
  }
  const actual = await evaluate(page, `(function () {
    const el = document.querySelector('div[contenteditable="true"]');
    return el ? (el.textContent || '').trim() : '';
  })()`);
  return { ok: String(actual ?? '').trim() !== '', actual: String(actual ?? '') };
}

/** Whether the composer is empty — how "the send was accepted" is observed. */
export async function composerIsEmpty(page) {
  const result = await evaluate(page, `(function () {
    const el = document.querySelector('div[contenteditable="true"]');
    if (!el) return true;
    return (el.textContent || '').trim() === '';
  })()`);
  return result === true;
}

/**
 * Send the composed message with Enter, falling back to the send button.
 *
 * Enter is the path people actually use and it survives a restyle of the button. `page.pressKey` dispatches a real
 * keyboard event, which is what the framework listens for; a synthesised `.click()` often does nothing because no
 * trusted pointer sequence was seen.
 *
 * @param {object} page - browser page handle.
 * @returns {Promise<object>} `{ ok, via }`.
 */
export async function pressSend(page) {
  try {
    await page.pressKey('Enter');
    return { ok: true, via: 'enter' };
  } catch {
    // Fall through to the button.
  }
  const clicked = await evaluate(page, `(function () {
    const candidates = [
      'button[aria-label*="发送"]', 'button[aria-label*="Send"]',
      'button[title*="发送"]', 'button[type="submit"]',
    ];
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (el && el.offsetParent && !el.disabled) {
        el.click();
        return { ok: true };
      }
    }
    return { ok: false };
  })()`);
  return { ok: clicked !== null && clicked !== undefined && clicked.ok === true, via: 'button' };
}

/**
 * The visible conversation, one entry per rendered block, oldest first.
 *
 * WHERE THE TEXT LIVES
 *
 * Measured on a live instance: the app shell is `<div class="…_frame">` holding a sidebar column and a
 * `<div class="…_centerCol">`. The conversation is inside `centerCol`. There is no `<main>` element and no
 * `data-message-id` attribute, so the earlier selectors matched nothing at all and the command reported "no visible
 * text" on a page that was showing a full conversation.
 *
 * Classes are hashed per build (`pI_x6G_centerCol`), so they are matched by a stable SUFFIX rather than literally.
 * That survives a rebuild while still targeting the region the sidebar cannot pollute: reading `body.innerText` would
 * return the conversation list, the menus and the composer mixed into the transcript.
 *
 * @param {object} page - browser page handle.
 * @returns {Promise<string[]>} visible texts.
 */
export async function readTranscript(page) {
  const result = await evaluate(page, `(function () {
    // The transcript. Measured on a live instance:
    //
    //   div._centerCol
    //     div._root (2 children)
    //       header   「打招呼 | 标准模式 | 对话 | 轨迹」
    //       div._body
    //         div._scrollBody   <- the scrolling message list
    //         div._widthHandle  (x2, layout only)
    //
    // TWO TRAPS, both hit while building this:
    //
    // 1. There are 37 elements whose class contains "_body" — most are empty layout shells. Taking the first one that
    //    matched happened to be right, but only by document order, so the choice is made explicit below: the widest
    //    populated one wins.
    // 2. Reading the center column instead of the scroll body includes the composer and the status bar, which is why an
    //    earlier attempt returned the placeholder text 「发消息或创建任务…」 and the model name as if they were messages.
    var scroll = document.querySelector('div[class*="_scrollBody"]');
    var root = scroll;
    if (!root) {
      var candidates = Array.from(document.querySelectorAll('div[class*="_body"]'));
      var best = null;
      var bestLen = 0;
      for (var c = 0; c < candidates.length; c++) {
        var len = (candidates[c].innerText || '').length;
        if (len > bestLen) { bestLen = len; best = candidates[c]; }
      }
      root = best || document.querySelector('div[class*="_centerCol"]') || document.body;
    }

    var out = [];
    var seen = {};
    // Collect leaf-ish blocks that hold text, then drop the chrome.
    //
    // The earlier filter (children.length > 3) was wrong for this DOM: a rendered message is a fairly deep block with
    // several children (paragraphs, code, tables), so the rule excluded every real message and kept only the small
    // widgets — the output was the composer placeholder and the model name while the transcript sat right there.
    var nodes = root.querySelectorAll('div, p, pre, li, td, th, h1, h2, h3, h4');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el.offsetParent) continue;
      // Skip a block that only wraps other blocks we will visit anyway: its text would duplicate theirs.
      if (el.querySelector('div, p, pre, li, td, th') !== null) continue;
      var text = (el.textContent || '').trim();
      if (text.length < 2 || text.length > 6000) continue;
      if (seen[text]) continue;
      seen[text] = true;
      out.push(text);
      if (out.length >= 300) break;
    }
    return out.filter(function (text) {
      // The composer's placeholder is part of the shell, not the conversation. It sits inside the scroll body in this
      // DOM, so it would otherwise appear as the last "message" every time.
      if (text.indexOf('发消息或创建任务') === 0) return false;
      if (text.indexOf('Message or create') === 0) return false;
      return true;
    });
  })()`);
  return Array.isArray(result) ? result : [];
}

/**
 * Wait until a condition holds, with a hard deadline.
 *
 * Every wait in this adapter is bounded: an unbounded wait turns a broken selector into a hung test, which is worse
 * than a failure because nobody sees it.
 *
 * @param {function(): Promise<boolean>} probe - condition check.
 * @param {object} options - `{ timeoutMs, intervalMs }`.
 * @returns {Promise<boolean>} whether it became true.
 */
export async function waitFor(probe, { timeoutMs = 20000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Fail with a message that says what was expected and what to check. */
export function fail(message, hint) {
  throw new CommandExecutionError(message, hint);
}

/**
 * Whether the assistant is currently producing output.
 *
 * Read from visible state rather than an internal flag: a running turn shows a stop control or a busy marker.
 *
 * @param {object} page - browser page handle.
 * @returns {Promise<boolean>} true while a turn is in flight.
 */
export async function isBusy(page) {
  const result = await evaluate(page, `(function () {
    const stop = document.querySelector('button[aria-label*="停止"], button[title*="停止"], button[aria-label*="Stop"]');
    if (stop && stop.offsetParent) return true;
    const streaming = document.querySelector('[data-streaming="true"], [aria-busy="true"]');
    return !!(streaming && streaming.offsetParent);
  })()`);
  return result === true;
}
