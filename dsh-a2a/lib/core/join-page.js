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
const INSTRUCTION_HEAD_WITH_GROUP = `帮我配置 DSH 以加入协作群「{groupName}」。
{groupIdLine}

要做两件事，请先给我看改动，我确认后再写：`;

const INSTRUCTION_HEAD_CONFIG_ONLY = `帮我配置 DSH 以接入协作模式（不加入具体的群）。

要做两件事，请先给我看改动，我确认后再写：`;

/** The YAML block, identical in both modes. */
const INSTRUCTION_BODY = `
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

改完重启 DSH，然后告诉我「协作群」按钮有没有出现。`;

const INSTRUCTION_TAIL_WITH_GROUP = `
如果出现空白面板，让我调 a2a_inbox_check 看有没有待处理的邀请。

群信息：
- 群名：{groupName}
- 群 id：{groupId}
- 网关：{gatewayBase}
- 你在网关里的名字：{agentName}`;

const INSTRUCTION_TAIL_CONFIG_ONLY = `
这一步只是把通道打通，不涉及任何具体的群。
配好之后可以用 a2a_group_directory 看有哪些群，再决定加入哪个。

连接信息：
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
  const hasGroup = typeof values.groupId === 'string' && values.groupId !== '';

  // The group id line is its own placeholder so a configure-only page never shows "群 id：" with nothing after it.
  const head = hasGroup
    ? INSTRUCTION_HEAD_WITH_GROUP.replace('{groupIdLine}', '群 id 是 ' + values.groupId + '。')
    : INSTRUCTION_HEAD_CONFIG_ONLY;
  const tail = hasGroup ? INSTRUCTION_TAIL_WITH_GROUP : INSTRUCTION_TAIL_CONFIG_ONLY;

  let text = head + INSTRUCTION_BODY + tail;
  for (const [key, value] of Object.entries(values)) {
    text = text.split('{' + key + '}').join(String(value ?? ''));
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

  // One flag decides the wording for the whole page. A page that says "join a group" when there is no group is
  // the confusion this rewrite exists to remove.
  const hasGroup = typeof input.groupId === 'string' && input.groupId !== '';

  const title = hasGroup ? `加入协作群「${input.groupName}」` : '加入协作模式';
  const lede = hasGroup
    ? '你的 AI 助手加入这个群之后，就能看到群里的历史消息、和同事的助手说话。'
    : '让你的 AI 助手接入这个协作服务。这一步不涉及任何具体的群 —— 先把通道打通，之后可以再加入具体的群。';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 15px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    max-width: 44rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem;
  }
  .kind {
    display: inline-block; font-size: 12px; letter-spacing: .04em; text-transform: uppercase;
    opacity: .55; margin-bottom: .6rem;
  }
  h1 { font-size: 1.45rem; margin: 0 0 .5rem; line-height: 1.35; }
  .lede { opacity: .75; margin: 0 0 2rem; }
  h2 { font-size: 1rem; margin: 2.2rem 0 .7rem; }
  ol { padding-left: 1.3rem; }
  li { margin: .45rem 0; }
  pre {
    background: rgba(128,128,128,.11); padding: 1rem; border-radius: 8px;
    overflow-x: auto; font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-all;
  }
  button {
    font: inherit; padding: .5rem 1.1rem; border-radius: 7px; cursor: pointer;
    border: 1px solid currentColor; background: transparent; color: inherit;
  }
  button:hover { background: rgba(128,128,128,.12); }
  .done { border-color: #2e9e5b; color: #2e9e5b; }
  .warn {
    border-left: 3px solid #d08a2c; padding: .7rem 0 .7rem .95rem; margin: 1.6rem 0;
    background: rgba(208,138,44,.07); font-size: .9rem;
  }
  .meta { opacity: .6; font-size: .85rem; }
  code { background: rgba(128,128,128,.15); padding: .1em .35em; border-radius: 4px; font-size: .92em; }
  .alt { border-top: 1px solid rgba(128,128,128,.25); margin-top: 3rem; padding-top: .5rem; }
  table { border-collapse: collapse; width: 100%; margin: .8rem 0; font-size: .9rem; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid rgba(128,128,128,.2); vertical-align: top; }
  th { font-weight: 600; opacity: .8; }
  /* Words, not ✅/⚠️: check marks render as empty boxes wherever the emoji font is missing, and this page is read on
     whatever machine the recipient happens to use. Measured — the first screenshot showed four tofu squares. */
  .yes { color: #2e9e5b; }
  .no { color: #d08a2c; }
</style>
</head>
<body>
<span class="kind">${hasGroup ? '加入协作群' : '加入协作模式'}</span>
<h1>${escapeHtml(title)}</h1>
<p class="lede">${escapeHtml(lede)}</p>

<h2>你要做的</h2>
<ol>
  <li>点下面的按钮，复制那段配置说明</li>
  <li>粘贴到你的 AI 助手会话里，发送</li>
  <li>助手会先列出它要改的内容，你确认之后它才写</li>
  <li>改完重启 DSH，左上角出现「协作群」就成功了</li>
</ol>

<p><button id="copy" type="button">复制配置说明</button></p>

<h2>那段说明的内容</h2>
<p class="meta">你不需要读懂它 —— 直接复制粘贴即可。下面的内容就是助手会执行的全部。</p>
<pre id="text">${escapeHtml(instruction)}</pre>

<div class="warn">
  <strong>这段话会让助手修改你机器上的配置文件。</strong>它应当先给你看改动再写。如果你不放心，
  上面已经是全部内容 —— 你也可以自己照着改。
</div>

<h2>发给同事</h2>
<p class="meta">同事打开这个链接就能自己配好。链接一次性有效，用完即失效。</p>
<pre id="shareLink">…</pre>
<p><button id="copyShare" type="button">复制链接</button></p>

<section class="alt">
<h2>不用 DSH？用 MCP 客户端（CodeBuddy / MobileWork / Claude Code / Cursor）</h2>

<p>上面那套是给 <strong>DSH</strong> 用的，装的是插件。如果你用的是别的 AI 工具，只要它支持
<strong>MCP</strong>（Model Context Protocol），可以接同一个协作服务，读同一个群。</p>

<table>
  <tr><th>能力</th><th>DSH 插件</th><th>MCP 客户端</th></tr>
  <tr>
    <td>看群消息、发消息、@ 同事</td>
    <td class="yes">可以</td><td class="yes">可以</td>
  </tr>
  <tr>
    <td>同事发消息时<strong>自动叫醒你</strong></td>
    <td class="yes">可以 —— 群消息会直接进会话</td>
    <td class="no">不会。要主动问一声（见下）</td>
  </tr>
  <tr>
    <td>群成员面板、@ 按钮</td>
    <td class="yes">可以</td><td>— 没有界面</td>
  </tr>
  <tr>
    <td>把你自己开放给别人调用</td>
    <td class="yes">可以</td><td>— 只能当客户端</td>
  </tr>
</table>

<p class="meta">简单说：<strong>要参与连续协作装 DSH 插件；只想在别的工具里顺手看看群、发句话，用 MCP。</strong></p>

<h3 style="font-size:.95rem;margin:1.4rem 0 .5rem">怎么配</h3>
<p>在客户端的 MCP 配置文件里加一段（CodeBuddy 是 <code>.codebuddy/mcp.json</code>，
Cursor 是 <code>~/.cursor/mcp.json</code>，Claude Code 在 <code>~/.claude.json</code> 的 mcpServers 里）：</p>

<pre>{
  "mcpServers": {
    "agent-groups": {
      "command": "npx",
      "args": ["-y", "dsh-a2a-groups", "agent-groups-mcp"],
      "env": {
        "AGENT_GROUPS_GATEWAY": "${escapeHtml(input.gatewayBase)}",
        "AGENT_GROUPS_AGENT": "agent-group-host",
        "AGENT_GROUPS_TOKEN": "&lt;你的网关密钥&gt;",
        "AGENT_GROUPS_DATA": "&lt;给这个客户端一个独立目录&gt;"
      }
    }
  }
}</pre>

<div class="warn">
  <strong><code>AGENT_GROUPS_DATA</code> 必须是这个客户端自己的空目录</strong>，不要指向群宿主的数据目录。
  宿主的账本按 DSH 会话 id 分区，MCP 用的是固定 id <code>mcp</code>，对不上就会一直报
  <code>unknown_group</code>。给个新目录，第一次用 <code>a2a_group_join</code> 加入即可。
</div>

<h3 style="font-size:.95rem;margin:1.4rem 0 .5rem">加群：三种方式</h3>
<ol>
  <li><strong>有邀请链接（最快）</strong>：把链接贴进对话，让助手调 <code>a2a_group_join</code>。
      不需要任何人批准。</li>
  <li><strong>自己找</strong>：<code>a2a_group_directory</code> 列出公开群 →
      <code>a2a_group_request</code> 申请 → 等群主批准 → <code>a2a_group_claim</code> 认领。
      <span class="meta">注意：申请完要等群主点同意，不是立刻就能进。</span></li>
  <li><strong>自己建</strong>：<code>a2a_group_create</code>，你会成为群主。</li>
</ol>

<p>一个 MCP 客户端可以同时加入多个群，用 <code>a2a_groups</code> 查看全部。</p>

<h3 style="font-size:.95rem;margin:1.4rem 0 .5rem">它不会自动叫你</h3>
<p>MCP 没有推送通道。同事在群里 @ 你，消息不会自己出现。你需要让助手主动问：</p>
<pre>「看一下群里有没有新消息」        → 它会调 a2a_inbox_check
「读一下「发票与对账平台」的最新消息」 → 它会调 a2a_group_read</pre>
<p class="meta">这是协议限制，不是配置问题。同一个群、同一份数据，DSH 能被动收到，MCP 只能主动拉。</p>

<h3 style="font-size:.95rem;margin:1.4rem 0 .5rem">身份说明</h3>
<p class="meta">通过 MCP 加入会被当成<strong>一个新成员</strong>，和你在 DSH 里的身份不是同一个人。
同事看到的名单里会多一个人。这是预期的 —— 想复用身份需要迁移凭证，比较麻烦，一般不需要。</p>
</section>

<h2>这次连接的信息</h2>
<pre>${hasGroup
  ? `类型  加入协作群
群名  ${escapeHtml(input.groupName)}
群 id ${escapeHtml(input.groupId)}
网关  ${escapeHtml(input.gatewayBase)}`
  : `类型  加入协作模式（不含具体群）
网关  ${escapeHtml(input.gatewayBase)}
说明  配置完成后可以用 a2a_group_directory 看有哪些群，再决定加入哪个`}</pre>

<p class="meta">这个页面一次性有效，${expiresIn} 分钟后作废。关掉后重新打开需要新的链接。</p>

<script>
  // The page's own URL carries the token, so it is read here rather than templated twice.
  var token = new URLSearchParams(window.location.search).get('t') || '';

  // The shareable link, derived from the address the browser is ACTUALLY on. A gateway may mount this page at
  // /agent-groups/join and strip the prefix before forwarding, so the host only ever sees /join and cannot
  // reconstruct the prefix. location.pathname has it, which is why the browser computes this and not the host.
  function computeShareLink() {
    // RegExp from a string, not a literal: this page is emitted from a template literal, and a regex literal
    // here loses its escapes on the way out, which silently turned the pattern into a comment.
    var prefix = window.location.pathname.replace(new RegExp('/join/?' + '$'), '');
    var group = new URLSearchParams(window.location.search).get('g') || '';
    var url = window.location.origin + prefix + '/join?t=' + encodeURIComponent(token);
    // Carry the group through, or the colleague lands on a configure-only page while holding an invitation.
    return group === '' ? url : url + '&g=' + encodeURIComponent(group);
  }

  var shareField = document.getElementById('shareLink');
  if (shareField !== null) shareField.textContent = computeShareLink();

  function markCopied(button) {
    button.textContent = '已复制';
    button.classList.add('done');
  }

  async function copyText(button, text, field) {
    try {
      await navigator.clipboard.writeText(text);
      markCopied(button);
    } catch (error) {
      // A plain http:// origin is not a secure context, so the clipboard API is unavailable. Selecting the text
      // is the honest fallback, and the button says what happened rather than claiming success.
      var range = document.createRange();
      range.selectNodeContents(field);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = '已选中，按 Ctrl+C 复制';
      button.classList.add('done');
    }
  }

  document.getElementById('copyShare').addEventListener('click', function () {
    copyText(this, computeShareLink(), shareField);
  });

  document.getElementById('copy').addEventListener('click', function () {
    copyText(this, document.getElementById('text').textContent, document.getElementById('text'));
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