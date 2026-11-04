/**
 * A page a colleague can open that hands them a sentence to paste into their assistant.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Installing the plugin puts a 「协作群」 button in the UI, and the button opens onto an empty panel — because
 * connecting needs a gateway address, an agent name, an API key and this instance's own token. Nothing in the UI
 * says which of those is missing or where they go. The knowledge lived only in the docs, and a colleague who does
 * not read docs is stuck at a blank panel with no clue.
 *
 * So the host publishes one page that says: here is your address, here is what you are joining, and here is a
 * paragraph that configures your assistant for you.
 *
 * WHY A SENTENCE AND NOT A DOWNLOAD
 *
 * Because a config file has to go to a machine-specific path with a machine-specific merge, and we would be
 * guessing at the DSH_HOME layout. The assistant on that machine knows it. Handing the sentence to the assistant
 * turns a distribution problem into an instruction the assistant can carry out with the tools it already has.
 *
 * WHY THE TOKEN IS SINGLE USE
 *
 * The page carries credentials: the group invitation and the caller key. An unauthored URL sitting in a chat
 * history must not stay valid. Each page load mints one token, it expires, and opening it again needs a fresh
 * one. A leaked link is a link that already stopped working.
 *
 * WHY THE SENTENCE SHOWS A DIFF FIRST
 *
 * It asks an assistant to modify a file on somebody's machine. A request that says "paste this and your config is
 * changed" is indistinguishable from an attack, and a colleague is right to refuse it. The sentence tells the
 * assistant to show the change and wait before writing.
 */

/** How long a join page token stays valid. Short: it is read on screen, not mailed. */
export const JOIN_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Path the join page is served at, under the host's own base. */
export const JOIN_PATH = '/join';

/** The sentence the page puts on the clipboard. */
const INSTRUCTION_TEMPLATE = `帮我配置 DSH 以加入协作群「{groupName}」。

要做两件事，请先给我看改动，我确认后再写：

1. 在 profile 的 cordis.patch.yml 里，把 a2a 段替换成：
   - id: a2a
     name: dsh-a2a-groups
     config:
       groups:
         enabled: true
         gatewayBase: {gatewayBase}
         agentName: {agentName}
       client:
         enabled: true
         apiKey: {apiKey}
         gatewayBase: {gatewayBase}
         forwardProto: http
       server:
         enabled: true
         publicUrl: {publicUrl}
         token: {serverToken}
       tools: true
       promptSection: true

2. 确认 <DSH_HOME>/profiles/web/package.json 的 dsh.profile.bundles 里有 dsh-a2a-groups。
   没有就加在数组最后。

改完重启 DSH，然后告诉我「协作群」按钮有没有出现。
如果出现空白面板，让我调 a2a_pending 看有没有待处理的邀请。

群信息：
- 群名：{groupName}
- 群 id：{groupId}
- 网关：{gatewayBase}
- 你在网关里的名字：{agentName}`;

/**
 * Mint a one-time token for a join page.
 *
 * Kept in memory rather than on disk on purpose: a join page is a convenience for somebody sitting at the
 * machine, not durable state. A restart invalidates outstanding pages, which is the correct default for
 * something carrying credentials.
 *
 * @param {object} options - creation options.
 * @param {() => string} options.newToken - token generator, injected so tests are deterministic.
 * @param {() => number} options.now - clock, injected for the same reason.
 * @returns {{token: string, expiresAt: number}} the token and its deadline.
 */
export function createJoinTokenStore({ newToken, now, ttlMs = JOIN_TOKEN_TTL_MS } = {}) {
  if (typeof newToken !== 'function') throw new Error('createJoinTokenStore needs newToken');
  if (typeof now !== 'function') throw new Error('createJoinTokenStore needs now');

  /** token → { expiresAt, used }. `used` rather than deletion so a second visit reports "expired" not "unknown". */
  const tokens = new Map();

  return {
    /**
     * Mint a token.
     *
     * @returns {{token: string, expiresAt: number}} the token and when it stops working.
     */
    mint() {
      const token = newToken();
      const expiresAt = now() + ttlMs;
      tokens.set(token, { expiresAt, used: false });
      return { token, expiresAt };
    },

    /**
     * Consume a token, once.
     *
     * @param {string} token - the token from the URL.
     * @returns {{ ok: true } | { ok: false, reason: 'unknown'|'used'|'expired' }} the outcome.
     */
    consume(token) {
      const entry = tokens.get(token);
      if (entry === undefined) return { ok: false, reason: 'unknown' };
      if (entry.used === true) return { ok: false, reason: 'used' };
      if (entry.expiresAt <= now()) return { ok: false, reason: 'expired' };
      entry.used = true;
      return { ok: true };
    },

    /** Drop expired entries so the map does not grow without bound. */
    sweep() {
      const at = now();
      for (const [token, entry] of tokens) {
        if (entry.expiresAt <= at) tokens.delete(token);
      }
    },
  };
}

/**
 * Fill the instruction template.
 *
 * @param {object} values - `{ groupName, groupId, gatewayBase, agentName, apiKey, publicUrl, serverToken }`.
 * @returns {string} the paragraph a colleague pastes.
 */
export function buildJoinInstruction(values) {
  let text = INSTRUCTION_TEMPLATE;
  for (const [key, value] of Object.entries(values)) {
    text = text.split(`{${key}}`).join(String(value ?? ''));
  }
  return text;
}

/** Escape text for HTML, so a group name cannot break out of the page. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/**
 * Render the join page.
 *
 * Plain HTML with inline styles and one small script: no build step, no external assets, and it has to work on a
 * machine that may have no network beyond the gateway.
 *
 * @param {object} input - `{ groupName, groupId, gatewayBase, agentName, apiKey, publicUrl, serverToken, expiresAt }`.
 * @returns {string} the HTML document.
 */
export function renderJoinPage(input) {
  const instruction = buildJoinInstruction(input);
  const expiresIn = Math.max(0, Math.round((input.expiresAt - Date.now()) / 60000));

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>加入「${escapeHtml(input.groupName)}」</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 15px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem;
  }
  h1 { font-size: 1.4rem; margin: 0 0 .35rem; }
  .sub { opacity: .65; margin: 0 0 2rem; font-size: .9rem; }
  h2 { font-size: 1rem; margin: 2rem 0 .6rem; }
  ol { padding-left: 1.3rem; }
  li { margin: .4rem 0; }
  pre {
    background: rgba(128,128,128,.12); padding: 1rem; border-radius: 8px;
    overflow-x: auto; font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;
  }
  button {
    font: inherit; padding: .5rem 1.1rem; border-radius: 7px; cursor: pointer;
    border: 1px solid currentColor; background: transparent; color: inherit;
  }
  button:hover { background: rgba(128,128,128,.12); }
  .done { border-color: #2e9e5b; color: #2e9e5b; }
  .warn {
    border-left: 3px solid #d08a2c; padding: .6rem 0 .6rem .9rem; margin: 1.5rem 0;
    background: rgba(208,138,44,.08); font-size: .88rem;
  }
  code { background: rgba(128,128,128,.15); padding: .1em .35em; border-radius: 4px; font-size: .9em; }
</style>
</head>
<body>
<h1>加入「${escapeHtml(input.groupName)}」</h1>
<p class="sub">这个页面一次有效，${expiresIn} 分钟后作废。关掉后重新打开需要新链接。</p>

<h2>怎么做</h2>
<ol>
  <li>点下面的按钮，复制那段话</li>
  <li>粘贴到你的 AI 助手会话里，发送</li>
  <li>助手会先给你看它要改什么，确认后它改完重启，左上角出现「协作群」</li>
</ol>

<p><button id="copy" type="button">复制配置说明</button></p>

<h2>那段话的内容</h2>
<pre id="text">${escapeHtml(instruction)}</pre>

<div class="warn">
  <strong>这段话会让助手改你机器上的配置文件。</strong>它会先给你看改动再写。如果你不放心，
  上面的内容就是全部 —— 你也可以自己照着改。
</div>

<h2>发给同事</h2>
<p class="sub">同事打开这个链接就能自己配好。链接里带着一次性邀请，用完即失效。</p>
<pre id="shareLink">…</pre>
<p><button id="copyShare" type="button">复制链接</button></p>

<h2>群信息</h2>
<pre>群名  ${escapeHtml(input.groupName)}
群 id ${escapeHtml(input.groupId)}
网关  ${escapeHtml(input.gatewayBase)}</pre>

<script>
  // The page's own URL carries the token, so it is read here rather than templated twice.
  var token = new URLSearchParams(window.location.search).get('t') || '';

  // The shareable link, derived from the address the browser is ACTUALLY on. A gateway may mount this page
  // at /agent-groups/join and strip the prefix before forwarding, so the host only ever sees /join and cannot
  // reconstruct the prefix. location.pathname has it, which is why the browser computes this and not the host.
  function computeShareLink() {
    // RegExp from a string, not a literal: this page is emitted from a template literal, and a regex literal
    // here loses its escapes on the way out, which silently turned the pattern into a comment.
    var prefix = window.location.pathname.replace(new RegExp('/join/?' + '$'), '');
    return window.location.origin + prefix + '/join?t=' + encodeURIComponent(token);
  }

  var shareField = document.getElementById('shareLink');
  if (shareField !== null) shareField.textContent = computeShareLink();

  document.getElementById('copyShare').addEventListener('click', async function () {
    var button = this;
    try {
      await navigator.clipboard.writeText(computeShareLink());
    } catch (error) {
      // A plain http:// origin is not a secure context, so the clipboard API is unavailable. Selecting the
      // text is the honest fallback, and the button says what happened rather than claiming success.
      var range = document.createRange();
      range.selectNodeContents(shareField);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = '已选中，按 Ctrl+C 复制';
      button.classList.add('done');
      return;
    }
    button.textContent = '已复制';
    button.classList.add('done');
  });

  document.getElementById('copy').addEventListener('click', async function () {
    var button = this;
    var text = document.getElementById('text').textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      var range = document.createRange();
      range.selectNodeContents(document.getElementById('text'));
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = '已选中，按 Ctrl+C 复制';
      button.classList.add('done');
      return;
    }
    button.textContent = '已复制';
    button.classList.add('done');
  });
</script>
</body>
</html>`;
}

/**
 * Render the page shown when a join token is no longer usable.
 *
 * @param {'unknown'|'used'|'expired'} reason - why it failed.
 * @returns {string} the HTML document.
 */
export function renderJoinErrorPage(reason) {
  const message = {
    unknown: '这个链接无效。',
    used: '这个链接已经用过了，一个链接只能打开一次。',
    expired: '这个链接已过期。',
  }[reason] ?? '这个链接不能用了。';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>链接已失效</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 15px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    max-width: 34rem; margin: 0 auto; padding: 3.5rem 1.25rem;
  }
  h1 { font-size: 1.25rem; }
  p { opacity: .75; }
</style>
</head>
<body>
<h1>${escapeHtml(message)}</h1>
<p>让群主重新发一个链接给你。</p>
</body>
</html>`;
}