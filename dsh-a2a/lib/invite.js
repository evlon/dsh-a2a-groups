/**
 * Invite links: the one artifact a human copies out of a Session into a chat.
 *
 * Why this is a separate module: the link format is a *wire* format shared with
 * three other parties — the left-hand group panel, the prompt template a model
 * pastes verbatim, and the invitee's `a2a_group_join`. Keeping the encoder and
 * the decoder in one file is what makes "what `invite()` emits" and "what
 * `join()` accepts" impossible to drift apart. A drift here is not a bug that
 * shows up loudly; it is an invite that silently fails to parse on the
 * invitee's machine, days later, in somebody else's chat window.
 *
 * Boundary: this module only *formats*. It never hashes, never stores, and
 * never decides whether a token is still valid — the token is opaque random
 * text minted by groups.js, and only the group host knows its hash, expiry and
 * use count. Parsing is deliberately forgiving about the prose *around* a link
 * and strict about the fields *inside* it, because the two failure modes
 * differ: a link embedded in a chat sentence must still work, while a link
 * missing its group id must fail loudly instead of producing a half-valid join
 * attempt that costs a round trip to reject.
 *
 * @module dsh-a2a/invite
 */

import { randomBytes } from 'node:crypto';

/** Custom scheme. Fixed: the UI and the prompt template match on it literally. */
export const LINK_SCHEME = 'dsh-a2a';

/** The only host this scheme defines. Anything else is a different link type. */
export const LINK_HOST = 'group';

/** Link schema version. A future incompatible format bumps this instead of lying. */
export const LINK_VERSION = '1';

/** Prefix of every invite link, without the query. */
export const LINK_PREFIX = `${LINK_SCHEME}://${LINK_HOST}`;

/**
 * How much of a link a query value may be.
 *
 * A link lives in one IM message, so it has to stay short enough that a chat
 * client will not wrap or truncate it. `gw` + `agent` + group id + a 32-char
 * token fits in ~200 characters; this cap only exists so a hostile paste cannot
 * make us parse a megabyte of "link".
 */
export const MAX_LINK_CHARS = 2048;

/**
 * Characters that end a link when it is embedded in prose.
 *
 * Chinese punctuation has to be listed explicitly: `/` `\S+/` looks correct and
 * then swallows `，群密码：abc` when a user pastes the prompt line without the
 * space that our own template happens to put there.
 */
const LINK_IN_TEXT = /dsh-a2a:\/\/group\?[^\s"'<>`，。、；：（）【】「」！？]+/gu;

/** Unambiguous alphabet: no O/0, no I/l/1 — these get retyped from paper and IM. */
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** An invite-link problem a human can act on. `code` is stable for the RPC layer. */
export class InviteLinkError extends Error {
  /**
   * @param {string} code stable machine code (`bad_link`, `incomplete_link`, …)
   * @param {string} message human-readable Chinese text, safe to show in a tool result
   * @param {object} [details] structured extras; never contains a token or password
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'InviteLinkError';
    this.code = code;
    this.details = details ?? {};
  }
}

/**
 * Build the canonical invite link.
 *
 * Field order is fixed (`v,gw,agent,g,t,n,e`) because the prompt and the UI both
 * show this string to humans, and two spellings of the same invite invite
 * "which one is right?" questions in a review.
 *
 * @param {object} input
 * @param {string} input.groupId group id, e.g. `g-7f3a1c`
 * @param {string} input.token one-time invite token (plaintext, this is the only channel it travels on)
 * @param {string} input.gatewayBase gateway base that routes to the group agent
 * @param {string} input.agent agent name inside that gateway
 * @param {string} [input.name] group display name
 * @param {number|string|Date} [input.expiresAt] epoch ms (or ISO) the invite stops working
 * @returns {string} the link, ready to paste
 */
export function buildLink(input) {
  const groupId = requireText(input?.groupId, 'groupId');
  const token = requireText(input?.token, 'token');
  const gatewayBase = stripTrailingSlash(requireText(input?.gatewayBase, 'gatewayBase'));
  const agent = requireText(input?.agent, 'agent');
  const name = optionalText(input?.name);
  const expiresAt = input?.expiresAt === undefined ? undefined : toIso(input.expiresAt);

  const params = new URLSearchParams();
  params.set('v', LINK_VERSION);
  params.set('gw', gatewayBase);
  params.set('agent', agent);
  params.set('g', groupId);
  params.set('t', token);
  if (name !== undefined) params.set('n', name);
  if (expiresAt !== undefined) params.set('e', expiresAt);
  return `${LINK_PREFIX}?${params.toString()}`;
}

/**
 * Parse a link back into its fields, for `a2a_group_join`.
 *
 * Accepts either a bare link or the whole prompt/message the link arrived in:
 * a user pastes "用 a2a_group_join 加入这个群：<link> ，群密码：xxx" at least as
 * often as they paste the link alone, and rejecting that would be a UX bug
 * masquerading as validation.
 *
 * @param {unknown} input link or free text containing one
 * @param {object} [options]
 * @param {number} [options.now] epoch ms, only used to report `expired`; parsing never refuses an expired link
 * @returns {{version:number, gatewayBase:string|undefined, agent:string|undefined, url:string|undefined,
 *   groupId:string, token:string, name:string|undefined, expiresAt:number|undefined,
 *   expiresAtIso:string|undefined, expired:boolean, raw:string}}
 * @throws {InviteLinkError} `bad_link` / `unsupported_version` / `incomplete_link` / `bad_expiry`
 */
export function parseLink(input, options = {}) {
  const raw = extractLink(input);
  if (raw.length > MAX_LINK_CHARS) {
    throw new InviteLinkError('bad_link', `邀请链接过长（超过 ${MAX_LINK_CHARS} 字符），可能粘贴错了。`);
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new InviteLinkError('bad_link', '这不是有效的邀请链接：格式无法解析。请确认完整粘贴了 dsh-a2a://group?... 开头的整行。');
  }
  // `URL` lowercases the protocol/host, so a hand-typed DSH-A2A://Group still works.
  if (url.protocol !== `${LINK_SCHEME}:` || url.host !== LINK_HOST) {
    throw new InviteLinkError('bad_link', `这不是群邀请链接：期望 ${LINK_PREFIX}?… ，实际是 ${url.protocol}//${url.host}。`);
  }

  const version = url.searchParams.get('v') ?? '';
  if (version !== LINK_VERSION) {
    throw new InviteLinkError(
      'unsupported_version',
      version === ''
        ? '邀请链接缺少版本号 v=1，可能是旧版或手工拼的链接。'
        : `不支持的邀请链接版本 v=${version}，本插件只支持 v=${LINK_VERSION}。`,
      { version },
    );
  }

  const groupId = optionalText(url.searchParams.get('g'));
  const token = optionalText(url.searchParams.get('t'));
  if (groupId === undefined || token === undefined) {
    throw new InviteLinkError(
      'incomplete_link',
      `邀请链接缺少${groupId === undefined ? '群 id（g=）' : ''}${groupId === undefined && token === undefined ? '和' : ''}${
        token === undefined ? '邀请令牌（t=）' : ''
      }，请让群主重新生成链接。`,
      { hasGroupId: groupId !== undefined, hasToken: token !== undefined },
    );
  }

  const gatewayBase = optionalText(url.searchParams.get('gw'));
  const agent = optionalText(url.searchParams.get('agent'));
  // The contract's form is gw+agent (a gateway routes to the group agent). `url`
  // is the local-development alternative from PLAN §5.2; we accept it on input
  // so a direct-connect invite is not rejected, but we never emit it.
  const direct = optionalText(url.searchParams.get('url'));
  if (direct === undefined && (gatewayBase === undefined || agent === undefined)) {
    throw new InviteLinkError(
      'incomplete_link',
      '邀请链接缺少网关信息（gw= 与 agent=），无法定位群所在的 agent。请让群主检查网关配置后重新生成。',
      { hasGateway: gatewayBase !== undefined, hasAgent: agent !== undefined },
    );
  }

  const name = optionalText(url.searchParams.get('n'));
  const expiresAtIso = optionalText(url.searchParams.get('e'));
  let expiresAt;
  if (expiresAtIso !== undefined) {
    expiresAt = Date.parse(expiresAtIso);
    if (!Number.isFinite(expiresAt)) {
      throw new InviteLinkError('bad_expiry', `邀请链接的过期时间（e=${expiresAtIso}）不是合法时间，请让群主重新生成。`, {
        expiresAtIso,
      });
    }
  }

  const now = typeof options.now === 'number' ? options.now : Date.now();
  return {
    version: Number(version),
    gatewayBase,
    agent,
    url: direct,
    // The one field a caller should use to actually reach the group: a direct
    // address when the link carries one, otherwise the gateway route built from
    // `gw` + `agent`. Without it every consumer had to know which of the two
    // spellings this particular link used and join them itself — and a joiner who
    // gets that wrong has to be told the gateway address by a human, which is
    // exactly the manual step the invite link exists to remove.
    endpoint: direct ?? (gatewayBase === undefined || agent === undefined
      ? undefined
      : `${gatewayBase.replace(/\/+$/, '')}/${agent}`),
    groupId,
    token,
    name,
    expiresAt,
    expiresAtIso: expiresAt === undefined ? undefined : new Date(expiresAt).toISOString(),
    expired: expiresAt === undefined ? false : expiresAt <= now,
    raw,
  };
}

/**
 * The Chinese prompt an owner pastes into IM. Text is copied verbatim from
 * CONTRACT §2.6: models and humans both key off these exact lines, and the
 * `/a2a-join` command form is parsed by the invitee's own Session, so a
 * "nicer" rewording would break the paste-and-send path.
 *
 * Interpolation is plain replacement, not a template engine: a group named
 * `${x}` must come out as `${x}`.
 *
 * @param {object} input
 * @param {string} input.name group display name
 * @param {string} input.link invite link
 * @param {number|string|Date} [input.expiresAt] epoch ms or ISO; omitted means the
 *   link never expires, and the text says so instead of printing a fake date
 * @returns {string} ready-to-paste text
 */
export function buildPrompt(input) {
  const name = requireText(input?.name, 'name');
  const link = requireText(input?.link, 'link');
  const expiresAt = input?.expiresAt === undefined ? undefined : toIso(input.expiresAt);

  return [
    `我在 DSH 里建了个协作群「${name}」，邀请你加入。`,
    '',
    '把下面这一行贴到你的 DSH 会话里直接发送即可：',
    `/a2a-join ${link}`,
    '',
    '也可以直接用自然语言让我加群：',
    `  用 a2a_group_join 加入这个群：${link}`,
    '',
    '入群后：群里有人发言或派活时会自动出现在你会话里（左侧「收到任务消息」卡片），',
    '直接回复就是在群里回话。想静音用 a2a_group_inbox off，想退出用 a2a_group_leave。',
    expiresAt === undefined
      ? '（此邀请长期有效；群主可以随时撤销这条链接。）'
      : `（此邀请在 ${expiresAt} 前有效；群主可以随时撤销。链接谁拿到谁能用，别转发到无关的地方。）`,
  ].join('\n');
}

/**
 * A high-entropy opaque secret, URL-safe.
 *
 * 24 random bytes = 192 bits. Invite tokens are the thing that leaks (they get
 * forwarded in chat), so they are sized so that guessing is not a thing that
 * happens — the only real defence needed is per-invite expiry/use-count, which
 * is what groups.js enforces. base64url keeps it paste-safe inside a query
 * string with no encoding.
 *
 * @param {number} [bytes] entropy in bytes
 * @returns {string} base64url text
 */
export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * A generated group password a human has to retype.
 *
 * Rejection sampling, not `% alphabet.length`: modulo bias on a 57-character
 * alphabet is small but real, and "we generate weak passwords on purpose" is not
 * a sentence to have to write in a review. The alphabet drops visually
 * confusable glyphs (O/0, I/l/1) because this string travels by screen-share
 * and phone.
 *
 * @param {number} [length] characters to generate
 * @returns {string} the password
 */
export function randomPassword(length = 12) {
  const requested = Number(length);
  const size = Number.isFinite(requested) && requested > 0 ? Math.max(4, Math.trunc(requested)) : 12;
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  const out = [];
  while (out.length < size) {
    for (const byte of randomBytes(size * 2)) {
      if (byte >= limit) continue; // biased tail of the byte range, discard
      out.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]);
      if (out.length === size) break;
    }
  }
  return out.join('');
}

/** Find the first invite-looking substring in a string, or fail readably. */
function extractLink(input) {
  if (typeof input !== 'string') {
    throw new InviteLinkError('bad_link', `邀请链接必须是字符串，收到的是 ${describeType(input)}。`);
  }
  const text = input.trim();
  if (text === '') {
    throw new InviteLinkError('bad_link', '邀请链接是空的，请完整复制群主发来的那一行。');
  }
  if (text.length > 64 * 1024) {
    throw new InviteLinkError('bad_link', '粘贴的内容太长（超过 64KB），请只粘贴邀请链接那一行。');
  }
  if (text.startsWith(LINK_PREFIX)) return text.split(/\s+/u)[0];
  const found = text.match(LINK_IN_TEXT);
  if (found !== null) return found[0];
  // No link at all. Distinguish "you pasted the wrong kind of URL" (a common
  // mistake: a web link, an https gateway card) from "you pasted prose", because
  // the two need different fixes.
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):\/\/([^\s/?#]*)/iu);
  if (scheme !== null) {
    throw new InviteLinkError(
      'bad_link',
      `这不是群邀请链接：收到的是 ${scheme[1]}://${scheme[2]} ，群邀请必须是 ${LINK_PREFIX}?... 开头。`,
    );
  }
  throw new InviteLinkError(
    'bad_link',
    `没有找到邀请链接：需要以 ${LINK_PREFIX}? 开头，例如 ${LINK_PREFIX}?v=1&gw=…&g=…&t=…。`,
  );
}

/** Require a non-blank string, or throw a link error naming the field. */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InviteLinkError('incomplete_link', `邀请链接缺少必填字段 ${field}，请让群主重新生成。`, { field });
  }
  return value;
}

/** Trimmed non-empty string, else `undefined` (an absent or blank param is absent). */
function optionalText(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Normalize epoch ms / ISO / Date to an ISO string for the link and the prompt. */
function toIso(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new InviteLinkError('bad_expiry', '过期时间是空日期。', { value: String(value) });
    }
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  throw new InviteLinkError('bad_expiry', `过期时间不是合法时间：${String(value)}。`, { value: String(value) });
}

/** Drop trailing slashes so `http://gw/` and `http://gw` produce the same link. */
function stripTrailingSlash(value) {
  return value.replace(/\/+$/u, '');
}

/** Type name for an error message, without `Object` for null. */
function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
