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
 * WHY THERE IS A CLICK BEFORE THE FILL
 *
 * `fillText` alone is not enough. It returned without error and reported the text written, the composer was empty, the
 * send button stayed disabled, and the transcript never grew — `send` therefore reported `sent: true, replied: false` on
 * a message that had never been typed. The box accepts synthetic text only when it already holds focus; clicking it
 * first was the whole difference:
 *
 *   click-ok | fill-ok | value="PROBE-AFTER-FOCUS"
 *
 * So: click, then fill, then read back. The read-back is what turns a false positive into a failure.
 *
 * @param {object} page - browser page handle.
 * @param {string} text - what to write.
 * @returns {Promise<object>} `{ ok, actual }` — the text the DOM holds.
 */
export async function writeComposer(page, text) {
  try {
    // A click focuses the box; without a pause the following keys can arrive before the focus took effect, and the
    // clear silently does nothing while the fill reports success.
    await page.click('div[contenteditable="true"]');
    await new Promise((resolve) => setTimeout(resolve, 200));
  } catch {
    // A missing composer surfaces on the fill below, which reports a usable reason.
  }
  // CLEAR, then fill.
  //
  // `fillText` does not replace existing content here: a composer already holding something kept it, the new text was
  // never written, the send button stayed enabled for the OLD text, and `send` returned `sent: true` for a message that
  // was never typed. Measured:
  //
  //   before="PROBE-AFTER-FOCUS" | sel-all-ok | del-ok | afterClear="" | afterFill="CLEAR-TEST"
  //
  // Without the clear, a second send in the same test silently re-sends the first message — the worst kind of failure,
  // because the transcript still grows and the test passes.
  try {
    await page.pressKey('Control+a');
    await page.pressKey('Delete');
    await new Promise((resolve) => setTimeout(resolve, 200));
  } catch {
    // A composer that cannot be cleared still gets the fill attempt; the read-back decides.
  }
  try {
    await page.fillText('div[contenteditable="true"]', text);
    await new Promise((resolve) => setTimeout(resolve, 200));
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
 * Send the composed message with Enter, falling back to the send button — and VERIFY it left the box.
 *
 * Enter is the path people actually use and it survives a restyle of the button. But `page.pressKey('Enter')` resolves
 * without error even when the app never acts on it: the composer still held the text, the transcript never grew, and
 * `send` reported `sent: true, replied: false` for a message that had never left the box. That false positive is worse
 * than a failure, because the caller concludes the model stayed silent.
 *
 * So the sequence is: press Enter, look at the composer, and if the text is still there, click the button.
 * `composerAfter: 'STILL-HAS-TEXT'` in the result is the signal that neither path worked.
 *
 * @param {object} page - browser page handle.
 * @returns {Promise<object>} `{ ok, via }`.
 */
export async function pressSend(page) {
  try {
    await page.pressKey('Enter');
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The box emptying is the only proof the send was accepted.
    if (await composerIsEmpty(page)) return { ok: true, via: 'enter' };
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
    // WHERE THE MESSAGES ACTUALLY ARE — measured, not assumed.
    //
    //   div._scrollBody
    //     div                       (no class)
    //       div._viewArea
    //         div                   (the scroller)
    //           div._root (5 children — but the FIRST _root on the page is the SIDEBAR)
    //             header
    //             div._body
    //               ... _flowItem ...   <- one entry per turn: message, status chip, or notice
    //     div._composerSeat         <- the input box; must never be read as a message
    //
    // Three selector mistakes were paid for here, so they are written down:
    //
    // 1. 'div[class*="_root"]' matches the SIDEBAR first. Reading it returned 「新会话 | 插件 | 自动化任务 | 协作群」 as if
    //    that were the conversation.
    // 2. The transcript is not the direct children of '_scrollBody'; it sits two levels deeper under '_viewArea'.
    // 3. '_flowItem' is used for BOTH message bodies and one-line status chips (「已完成，用时 18秒」, 「用量 254K tok」,
    //    「收到任务消息」). Position alone cannot separate them, so they are filtered by shape below.
    var view = document.querySelector('div[class*="_viewArea"]');
    var root = view !== null ? view : document.querySelector('div[class*="_scrollBody"]');
    if (root === null) root = document.body;

    // Locate the container whose children are the per-turn blocks: the element with the most text-bearing direct
    // children inside the view area. Chosen by measurement rather than by class name, so a rebuild that renames the
    // container does not silently break the reader.
    var container = null;
    var bestCount = 0;
    var all = root.querySelectorAll('div');
    for (var i = 0; i < all.length; i++) {
      var kids = all[i].children;
      var withText = 0;
      for (var k = 0; k < kids.length; k++) {
        if ((kids[k].innerText || '').length > 0) withText += 1;
      }
      if (withText > bestCount) {
        bestCount = withText;
        container = all[i];
      }
    }
    if (container === null) return [];

    var out = [];
    var seen = {};
    var blocks = Array.from(container.children);
    for (var b = 0; b < blocks.length; b++) {
      var el = blocks[b];
      if (!el.offsetParent) continue;
      var text = (el.innerText || el.textContent || '').trim();
      if (text.length < 2) continue;
      if (seen[text]) continue;
      seen[text] = true;
      out.push(text);
      if (out.length >= 300) break;
    }

    // Drop the chrome that shares the block type with real messages.
    //
    // Each rule below was produced by looking at a live transcript, not guessed: these are exactly the entries that
    // appeared as "messages" and made assertions unreliable.
    return out.filter(function (text) {
      // The composer's placeholder, inside the seat rather than the transcript.
      if (text.indexOf('发消息或创建任务') === 0) return false;
      if (text.indexOf('Message or create') === 0) return false;
      // A turn's status chip: 「已完成」/「已完成，用时 18秒」/「深度求索中」. Two lines at most, no body text.
      if (text.indexOf('已完成') === 0 && text.split(String.fromCharCode(10)).length <= 2) return false;
      if (text.indexOf('深度求索中') === 0) return false;
      if (text.indexOf('加载更早') === 0) return false;
      // A token/usage line: 「用量 254K tok」/「10.5M tok·缓存命中 97%」.
      if (text.indexOf('用量 ') === 0) return false;
      if (text.indexOf('tok') > -1 && text.length < 60) return false;
      // The system notice that a turn was started by an inbound task message.
      if (text.indexOf('收到任务消息') === 0 && text.split(String.fromCharCode(10)).length <= 2) return false;
      // A collapsed run of process records: 「执行了命令思考…运行命令…思考…」. The turn view folds the model's reasoning
      // and its tool calls into the same block, so this arrives looking like a message.
      //
      // Matched as a SUBSTRING and WITHOUT a length bound: the live text is hundreds of characters (reasoning plus
      // several tool runs), so an earlier 'length < 200' test let every one of them through. The phrases themselves are
      // the signal — a real message does not contain 「思考」 immediately followed by another 「运行命令」.
      var runCount = (text.match(/运行命令/g) ?? []).length;
      if (text.indexOf('执行了命令') > -1 && (runCount >= 1 || text.indexOf('思考') > -1)) return false;
      if (text.indexOf('调用了工具') > -1 && text.indexOf('思考') > -1) return false;
      if (text.indexOf('Ran command') > -1 && text.indexOf('Thinking') > -1) return false;
      // The model picker.
      if (/^[a-z0-9._-]+-(flash|pro|chat)$/i.test(text)) return false;
      if (/^\d+%\s*$/.test(text)) return false;
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
