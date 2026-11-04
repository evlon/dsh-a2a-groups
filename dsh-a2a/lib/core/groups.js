/**
 * Group state machine: password, invites, members, feed, subscriptions.
 *
 * This is the security-critical half of the plugin, so the rules are written
 * down here rather than discovered by reading the code:
 *
 * **What is stored vs. what is shown.** The file on disk holds password hashes,
 * invite-token hashes and member-credential hashes. Plaintext secrets exist only
 * in the return value of `create` / `invite` / `join`, exactly once, because that
 * response is the only channel that can carry them: the owner pastes an invite
 * link into a chat, and the invitee's Session keeps the credential it got back.
 * After that single trip, the plaintext is unrecoverable from the host — a
 * compromised `groups.json` yields no usable password and no usable token, which
 * is the whole point of hashing them.
 *
 * **Why the two credential kinds are separate.** A group password is *shared*
 * and *long-lived*: everyone who joins learns it, and revoking it means rotating
 * it for everyone. A member key is *individual* and *revocable*: it identifies
 * exactly one member and is deleted when that member leaves. Folding them into
 * one secret would mean either "you cannot remove one member without locking out
 * the group" or "one leaked member key can mint invites forever". Invites are a
 * third kind again — *single-use, expiring, revocable* — and are hashed for the
 * same reason: the link travels through chat logs and screenshots, so what the
 * host keeps must be useless if the link leaks.
 *
 * **Why `feed` is a monotonically increasing `seq`.** A subscriber that drops
 * (SSE killed by a proxy, laptop lid, gateway timeout) must be able to reconnect
 * with `sinceSeq` and receive exactly what it missed. That requires an ordering
 * that never repeats and never goes backwards, so `seq` is allocated from a
 * persisted counter, not from array length or timestamps — array length breaks
 * under retention pruning, and timestamps break under clock skew. `msgId` is a
 * uuid and exists for the *other* job: end-to-end dedupe once the same message
 * can arrive by more than one path (reconnect overlap, retry after timeout).
 *
 * **Why comparisons are constant-time and hashes are fixed-width.** Every secret
 * is compared as a fixed-width sha256 hex digest (member keys) or as the scrypt
 * output buffer (passwords), so `timingSafeEqual` never sees mismatched lengths
 * and the comparison leaks neither content nor length. A wrong member key and a
 * nonexistent member both fail through the same path with the same error, so the
 * endpoint cannot be used to enumerate members.
 *
 * Boundary: pure state. No network, no DSH, no timers (only an injected clock).
 * The A2A layer decides who may call which method; this module decides what the
 * group's data means. Time is epoch milliseconds internally; ISO strings are
 * added only on the public serializers, because a feed entry is a boundary
 * object that goes straight into a UI or an artifact.
 *
 * @module dsh-a2a/groups
 */

/**
 * One member row, as the store keeps it.
 *
 * `keyHash` is the sha256 of the member credential — the plaintext exists only in
 * the `join` response and is never recoverable from this record. Anything that
 * publishes a member must go through the public projection, not this type.
 *
 * @typedef {object} GroupMemberRecord
 * @property {string} personId - this person’s id inside the group.
 * @property {string} displayName
 * @property {string} role - `owner` or `member`.
 * @property {string} keyHash - sha256 of the member credential.
 * @property {number} joinedAt - epoch ms.
 * @property {number} lastSeenAt - epoch ms; drives the online window.
 * @property {string} [endpoint] - the member’s A2A endpoint, when it reported one.
 * @property {string} [about] - layer A: self-described role in THIS group.
 * @property {string[]} [tags]
 * @property {number} [profileUpdatedAt]
 */

/**
 * One join request, from asking to be admitted to being decided.
 *
 * @typedef {object} GroupRequestRecord
 * @property {string} requestId
 * @property {string} displayName
 * @property {string} status - `pending`, `approved`, `denied`, or `expired`.
 * @property {number} createdAt - epoch ms.
 * @property {number} expiresAt - epoch ms; a pending row past this is expired.
 * @property {number} [decidedAt] - epoch ms.
 * @property {string} [reason]
 */

/**
 * One feed entry.
 *
 * @typedef {object} GroupFeedEntry
 * @property {number} seq - monotonic within the group.
 * @property {number} at - epoch ms.
 * @property {string} msgId
 * @property {string} kind - `message` or `system`.
 * @property {{personId: string, displayName: string}} from
 * @property {string} text
 * @property {object} [payload]
 * @property {string[]} [mentions]
 */

/**
 * The whole group record — the unit that `groups.json` persists.
 *
 * `passwordHash` is scrypt, `tokenHash`/`keyHash` are sha256; no plaintext secret
 * is ever a field here. `nextSeq` is the feed’s allocator, kept on the group so
 * sequence numbers survive a restart.
 *
 * @typedef {object} GroupRecord
 * @property {string} groupId
 * @property {string} name
 * @property {string} topic
 * @property {number} createdAt - epoch ms.
 * @property {string} joinPolicy - `invite` or `password`.
 * @property {string} ownerMemberId - which member row is the owner.
 * @property {string} passwordHash - `scrypt$N$salt$hash`.
 * @property {object} settings - per-group overrides of the store defaults.
 * @property {Array<{tokenHash: string, label?: string, createdAt: number, expiresAt: number, maxUses: number, uses: number, revoked: boolean}>} invites
 * @property {GroupMemberRecord[]} members
 * @property {GroupFeedEntry[]} feed
 * @property {number} nextSeq
 * @property {GroupRequestRecord[]} [requests]
 * @property {boolean} [archived]
 */

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join as joinPath } from 'node:path';

import { buildLink, buildPrompt, randomPassword, randomToken } from './invite.js';

/**
 * scrypt cost parameter. 2^14 = 16384, the value the contract pins.
 *
 * The tradeoff: scrypt's cost is N*r*128 bytes and N*r*p work. At N=2^14, r=8,
 * p=1 a single hash costs ~16 MiB and ~50 ms here, which is cheap enough to run
 * on the request path of a `join` (once per member) and expensive enough that an
 * attacker holding a stolen `groups.json` cannot brute-force a human-chosen
 * group password at scale. Raising N scales both sides; 2^14 is the point where
 * a login-shaped operation stays under a tenth of a second on the slowest
 * machine we support. The parameter is stored *in* the hash string so a future
 * bump stays verifiable: old hashes keep their old N, and `verifyPassword`
 * reports `needsRehash` instead of silently accepting a weaker hash forever.
 */
export const SCRYPT_N = 1 << 14;

/** scrypt block size. Fixed at the value Node's own defaults use. */
export const SCRYPT_R = 8;

/** scrypt parallelization. 1: parallelism would only help an attacker with many cores. */
export const SCRYPT_P = 1;

/** Salt length in bytes. 16 bytes = 128 bits, per the contract. */
export const SCRYPT_SALT_BYTES = 16;

/** Derived-key length in bytes (256 bits). */
export const SCRYPT_KEY_BYTES = 32;

/** scrypt's memory ceiling for the hash call; generous so a bigger N still runs. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/**
 * Digest of a string no credential is generated from, used as the "no such
 * member" comparison target. See the `dummyKeyHash()` helper for why this is a
 * constant rather than a random value.
 */
const DUMMY_KEY_HASH = createHash('sha256').update('dsh-a2a:no-such-credential', 'utf8').digest('hex');

/** How many entries `join` hands back so a new member can read the recent context. */
export const FEED_TAIL_LIMIT = 20;

/** Default page size for `read`, and its ceiling. */
export const READ_LIMIT_DEFAULT = 100;
export const READ_LIMIT_MAX = 500;

/**
 * Ceiling on a serialized `payload`.
 *
 * A group feed carries conversation plus structured extras (a task id, a file
 * path). Anything larger belongs in a file the message points at, not in a state
 * file that is rewritten in full on every post: an unbounded payload turns one
 * 3 MiB attachment into "every subsequent post costs 3 MiB of disk".
 */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** A member is shown as online if it authenticated this recently. */
export const ONLINE_WINDOW_MS = 120_000;

/** The only message kinds the MVP sends. A fourth kind means the scope changed. */
export const DM_KIND_INVITE = 'group-invite';
export const DM_KIND_JOIN_NOTICE = 'join-notice';
export const DM_KIND_WELCOME = 'welcome';

/** Message kinds the store will accept. */
const DM_KINDS = new Set([DM_KIND_INVITE, DM_KIND_JOIN_NOTICE, DM_KIND_WELCOME]);

/**
 * How long an undelivered message is kept.
 *
 * Seven days, matching the default invite lifetime: a link that has expired cannot be redeemed, so
 * keeping the envelope longer would only deliver a dead invitation and teach the recipient to
 * distrust the next one.
 */
export const DM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cap on stored messages, oldest undelivered dropped first. */
export const MAX_DIRECT_MESSAGES = 2000;

/** Most messages one read returns. */
export const MAX_DM_PAGE = 50;


/** Hard structural caps, so a hostile or buggy caller cannot grow one file forever. */
export const MAX_GROUPS = 200;
export const MAX_MEMBERS_PER_GROUP = 200;
export const MAX_INVITES_PER_GROUP = 500;
export const MAX_NAME_CHARS = 120;
export const MAX_TOPIC_CHARS = 2000;
export const MAX_DISPLAY_NAME_CHARS = 64;
export const MAX_ENDPOINT_CHARS = 512;
export const MAX_LABEL_CHARS = 120;

/** Longest `roleAbout` (one sentence about what someone does in a group). */
export const MAX_ROLE_ABOUT_CHARS = 120;

/** Most tags one member may carry in one group. */
export const MAX_TAGS = 5;

/** Longest single tag. */
export const MAX_TAG_CHARS = 16;

/** Default page size for the channel directory. */
export const DIRECTORY_DEFAULT_LIMIT = 20;

/** Largest page a directory caller may request, so one call cannot dump everything. */
export const DIRECTORY_MAX_LIMIT = 100;

/**
 * How long a join request stays answerable, in milliseconds.
 *
 * An application is a transient intent, not a standing invitation: a queue that
 * stays open forever lets a request approved months ago be redeemed from a machine
 * nobody remembers. Seven days matches the default invite lifetime, so the two
 * halves of "ask, then get in" expire together.
 */
export const REQUEST_TTL_MS = 7 * 24 * 3600 * 1000;

/** Most unanswered requests one group may hold, so a spammer cannot grow the file. */
export const MAX_PENDING_REQUESTS = 50;

/**
 * The sentinel that means "everybody in the group".
 *
 * A string rather than a boolean flag because a post carries ONE list of addressees:
 * `["@all"]` and `["m-1","m-2"]` are the same field, so a reader never has to
 * combine two things to know who was addressed.
 */
export const MENTION_ALL = '@all';

/** Most members one post may address, so a list cannot grow without bound. */
export const MAX_MENTIONS_PER_POST = 200;

/** Longest free-text reason on a join request. */
export const MAX_REQUEST_REASON_CHARS = 200;

/** Stable error codes. The A2A layer maps them onto JSON-RPC `data.code`. */
export const GROUP_ERROR_CODES = Object.freeze([
  'bad_argument',
  'unknown_group',
  'not_member',
  'bad_password',
  'invite_invalid',
  'invite_expired',
  'invite_exhausted',
  'invite_revoked',
  'rate_limited',
  'too_long',
  'empty_message',
  'group_full',
  'group_archived',
  'not_owner',
  'missing_gateway',
  'storage_unreadable',
  'too_many_attempts',
  // Join requests. Distinct codes because each one is a different thing for a
  // caller to do about it: apply again, wait, or stop asking.
  'request_invalid',
  'request_expired',
  'request_pending',
  'request_not_found',
  'request_rejected',
]);

/**
 * A group-layer failure with a stable, machine-readable code.
 *
 * `message` is written for a human reading a tool result (Chinese, actionable)
 * and never contains a secret: the whole point of the error surface is that a
 * caller can log it safely.
 */
export class GroupError extends Error {
  /**
   * @param {string} code one of {@link GROUP_ERROR_CODES}
   * @param {string} message human-readable, secret-free
   * @param {object} [details] structured extras, secret-free
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'GroupError';
    this.code = code;
    this.details = details ?? {};
  }
}

/**
 * Compare two strings without leaking where they differ.
 *
 * `timingSafeEqual` throws on unequal lengths, so the length check comes first
 * and returns `false` rather than throwing: an auth helper that throws on a
 * malformed credential is an auth helper somebody will wrap in a try/catch that
 * returns `true` by accident. Callers here always pass fixed-width digests, so
 * the early length return is not reachable in the auth path — it only protects
 * the function against misuse.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function constantTimeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * sha256 of a secret, as lowercase hex.
 *
 * Tokens and member keys are hashed rather than scrypt-hashed on purpose: they
 * are generated with 192-256 bits of entropy, so there is nothing to brute-force
 * and the host needs the lookup to be fast (every request authenticates). A
 * password is the opposite case — human-chosen, low entropy — which is why it
 * alone gets scrypt.
 *
 * @param {string} value
 * @returns {string} 64 hex characters
 */
export function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * Hash a group password into the stored form `scrypt$N$saltHex$hashHex`.
 *
 * The parameter is embedded so the format is self-describing: an operator can
 * read `groups.json`, see the cost, and know what it was hashed with without a
 * version lookup. A random salt per hash means two groups with the same password
 * produce different records — no cross-group rainbow table, and no "this person
 * reused their password" signal in the file.
 *
 * @param {string} password plaintext (never logged, never stored)
 * @param {object} [options]
 * @param {number} [options.N] cost parameter, default {@link SCRYPT_N}
 * @param {Buffer} [options.salt] explicit salt, for tests only
 * @returns {string} the stored hash string
 */
export function hashPassword(password, options = {}) {
  if (typeof password !== 'string' || password === '') {
    throw new GroupError('bad_argument', '群密码不能为空。');
  }
  const N = Number.isInteger(options.N) && options.N > 1 ? options.N : SCRYPT_N;
  const salt = options.salt instanceof Buffer ? options.salt : randomBytes(SCRYPT_SALT_BYTES);
  const derived = scryptSync(password, salt, SCRYPT_KEY_BYTES, {
    N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${N}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Check a password against a stored hash, without throwing on malformed input.
 *
 * Returns an object instead of a boolean so the caller can distinguish "wrong
 * password" (a normal user error) from "this record is not a hash we can read"
 * (an operator problem) without parsing an exception. Both are failures; only
 * the log line differs.
 *
 * @param {string} password
 * @param {string} stored `scrypt$N$salt$hash`
 * @returns {{ok: boolean, reason?: string, needsRehash?: boolean}}
 */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password === '') return { ok: false, reason: 'empty' };
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 4 || parts[0] !== 'scrypt') return { ok: false, reason: 'malformed' };
  const N = Number(parts[1]);
  if (!Number.isInteger(N) || N < 2 || N > 1 << 24) return { ok: false, reason: 'malformed' };
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  if (salt.length < 8 || expected.length < 16) return { ok: false, reason: 'malformed' };

  let derived;
  try {
    derived = scryptSync(password, salt, expected.length, {
      N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    // A cost the machine cannot pay is a configuration failure, not a valid login.
    return { ok: false, reason: 'error' };
  }
  // Buffers are the same length by construction, so this is a pure content compare.
  const ok = timingSafeEqual(derived, expected);
  return ok ? { ok: true, needsRehash: N < SCRYPT_N } : { ok: false, reason: 'mismatch' };
}

/**
 * The group store: one JSON file, one in-memory state, synchronous mutations.
 *
 * Writes are synchronous and atomic (temp file + `rename`) rather than debounced:
 * a group's durable facts are *credentials* — a `join` that returns a member key
 * which was never written to disk is a member that disappears on restart, and a
 * debounced write is exactly the window where that happens. The file is small and
 * mutations are human-paced, so the cost is acceptable.
 *
 * @param {object} options
 * @param {string} [options.home] directory holding `groups.json`
 * @param {object} [options.logger] `{info,warn,error}` (optional)
 * @param {() => number} [options.clock] epoch-ms source; injected so tests can travel in time
 * @param {object} [options.config] normalized plugin config (or a flat groups config)
 * @param {(a: unknown, b: unknown) => boolean} [options.compare] secret comparator; defaults to
 *   {@link constantTimeEquals}. Injected so a test (or an audit harness) can observe that every
 *   credential check really goes through a constant-time path, without reaching into module state.
 * @returns {object} the store API described in CONTRACT §2.6
 */
export function createGroupStore({ home, logger, clock, config, compare } = {}) {
  const log = createLogger(logger);
  const now = typeof clock === 'function' ? clock : Date.now;
  const compareSecrets = typeof compare === 'function' ? compare : constantTimeEquals;
  const settings = readGroupConfig(config);
  const directory = typeof home === 'string' && home !== '' ? home : resolveDirectory(config);
  const file = joinPath(directory, 'groups.json');

  /**
   * Objects that came out of `authenticate()`, mapped to the member id they were
   * authenticated *as*.
   *
   * A WeakMap instead of a WeakSet, and frozen views, because a verified object
   * that the caller can still edit is not a verified identity: with a WeakSet,
   * `member.personId = victimId` on your own view would make `post()` act as the
   * victim. Binding the id inside the WeakMap means the identity used for the
   * lookup is the one captured at authentication time, and freezing the view
   * stops the mutation from happening in the first place.
   */
  const authenticated = new WeakMap();
  /** In-memory token buckets, keyed `groupId\u0000personId`. Never persisted: see `consume`. */
  const buckets = new Map();
  /**
   * Wrong-password timestamps, keyed by group id.
   *
   * In memory on purpose: persisting failed attempts would turn every typo into a
   * disk write, and a restart is not something an attacker can trigger, so the
   * reset-on-restart behaviour costs nothing.
   */
  /** Live subscribers, keyed by group id. */
  const subscribers = new Map();

  /**
   * personId → the person's own profile.
   *
   * Keyed by `personId`, which identifies a person across every group on this host. One row
   * per person, so "what I do" is stored once rather than repeated per membership.
   *
   * Declared BEFORE `loadState()` because the load hydrates it: a `const` sits in the temporal
   * dead zone until its own line runs, and touching it earlier throws.
   */
  const persons = new Map();

  /**
   * Undelivered and recently delivered one-to-one messages, oldest first.
   *
   * An array rather than a per-person map because the two questions asked of it are "what is waiting
   * for this person" and "did this one get delivered", and both scan. The cap keeps a runaway
   * sender from growing the file without bound.
   */
  let directMessages = [];

  let state = loadState();
  // Populated once at startup: a profile read is far more common than a profile write.
  // Undelivered messages survive a restart: the whole point of a queue is that a message is not
  // lost because the host bounced.
  directMessages = Array.isArray(state.directMessages) ? state.directMessages : [];
  for (const entry of state.persons ?? []) {
    persons.set(entry.personId, {
      personId: entry.personId,
      displayName: typeof entry.displayName === 'string' ? entry.displayName : '',
      headline: typeof entry.headline === 'string' ? entry.headline : '',
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string') : [],
      endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : '',
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
    });
  }
  let dirty = false;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Create a group and its owner.
   *
   * A group has NO password. Admission is one of two things and only these two:
   *
   *   - an invite token, which the owner mints and can revoke at any time;
   *   - an approved join request, which the owner answers one person at a time.
   *
   * A shared password was dropped deliberately. It solved "the link got forwarded"
   * by adding a second secret that has to be delivered out of band, while the
   * actual control an owner wants — revoke exactly that link — was already there
   * and is strictly sharper: a password change invalidates every pending invite at
   * once, while a revocation hits only the link that leaked.
   *
   * @param {object} input
   * @param {string} [input.name] group display name
   * @param {string} [input.about]
   * @param {string[]} [input.tags]
   * @param {string} [input.topic]
   * @param {string} [input.ownerDisplayName]
   * @param {object} [input.settings] per-group overrides of the store defaults
   * @param {string} [input.personId] the id this person already holds in another group, so
   *   creating a second group does not mint a second identity for the same human
   * @returns {{group: object, ownerKey: string}}
   */
  function create(input = {}) {
    const name = requireText(input.name, 'name', MAX_NAME_CHARS, '群名');
    const topic = optionalText(input.topic, MAX_TOPIC_CHARS, '群主题') ?? '';
    const ownerDisplayName = optionalText(input.ownerDisplayName, MAX_DISPLAY_NAME_CHARS, '昵称') ?? '群主';

    if (state.groups.length >= MAX_GROUPS) {
      throw new GroupError('group_full', `本机群数量已达上限（${MAX_GROUPS}），请先退出不用的群。`);
    }

    const groupId = allocateGroupId();
    const createdAt = now();
    const ownerPersonId = allocatePersonId(input.personId);
    const ownerKey = randomToken(32);

    const group = {
      groupId,
      name,
      topic,
      createdAt,
      ownerPersonId,
      // No `passwordHash`: see the doc comment on `create`. Admission is an invite
      // token or an approved request, both of which are revocable per person.
      settings: mergeSettings(input.settings),
      invites: [],
      // Applications to join, answered by the owner. Kept on the group record so a
      // restart does not silently drop somebody's unanswered request.
      requests: [],
      members: [
        {
          personId: ownerPersonId,
          displayName: ownerDisplayName,
          role: 'owner',
          keyHash: sha256Hex(ownerKey),
          joinedAt: createdAt,
          lastSeenAt: createdAt,
          // The owner is a member like any other, and creating a group is how they join it. An
          // address here keeps the one person guaranteed to be present from showing a blank
          // endpoint, which reads as a broken feature rather than an unconfigured host.
          endpoint: optionalText(input.endpoint, MAX_ENDPOINT_CHARS, 'endpoint') ?? undefined,
          // Layer A: what this person is IN THIS GROUP. Deliberately separate from
          // `role`: `role` is a permission bit (owner may mint invites), while
          // these are self-described identity. Folding them together would make
          // "I am the PM" mean "I can kick people".
          roleAbout: optionalText(input.about, MAX_ROLE_ABOUT_CHARS, '角色说明') ?? undefined,
          tags: normalizeTags(input.tags),
          profileUpdatedAt: createdAt,
        },
      ],
      feed: [],
      nextSeq: 1,
    };

    state.groups.push(group);
    appendSystem(group, `${ownerDisplayName} 创建了群`);
    persist();

    log.info('group created', { groupId, name });
    return {
      group: publicGroup(group),
      ownerKey,
    };
  }

  /**
   * Mint an invite.
   *
   * Authorized by the OWNER credential only. There is no shared password any more,
   * so "any member can mint an invite" is no longer expressible — minting is an
   * owner act, and the owner is the one who can revoke.
   *
   * The invite has exactly one bound: an expiry. Deliberately no use counter — an
   * owner who wants to stop a link revokes it, which is precise; a counter only
   * makes the sixth colleague wait for a fresh link while the leak it was meant to
   * contain continues to work.
   * caller cannot tell which factor failed.
   *
   * `invites` is a third secret with its own lifecycle: the token itself is
   * returned once, only its sha256 is kept, and use/expiry/revocation are
   * enforced at `join`. That is what makes a forwarded link a bounded problem
   * instead of a permanent group membership.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {string} [input.ownerKey] owner credential; REQUIRED — only the owner
   *   may mint, because only the owner may later revoke
   * @param {string} [input.label] who this invite is for, for later revocation
   * @param {number|null} [input.expiresInHours] hours until it expires; pass
   *   `null` explicitly for a link that never expires. Omitted means the
   *   configured default (7 days), NOT "never" — a long-lived public link has to be
   *   asked for on purpose.
   * @param {string} [input.gatewayBase] gateway base to put in the link (default: config)
   * @param {string} [input.agent] agent name inside that gateway (default: config)
   * @returns {{token: string, link: string, prompt: string, expiresAt: number|null,
   *   inviteId: string, groupId: string, label: string|undefined}}
   */
  function invite(input = {}) {
    const group = requireGroup(input.groupId);
    const label = optionalText(input.label, MAX_LABEL_CHARS, '备注') ?? undefined;

    // Owner-only, unconditionally. The owner credential is what makes minting an
    // act of the person who can also revoke; allowing any member to mint would let
    // somebody create links the owner cannot attribute.
    const owner = group.members.find((entry) => entry.personId === group.ownerPersonId);
    if (owner === undefined) {
      throw new GroupError('not_owner', '这个群现在没有群主，无法生成邀请。');
    }
    if (typeof input.ownerKey !== 'string' || input.ownerKey === ''
      || !compareSecrets(sha256Hex(input.ownerKey), owner.keyHash)) {
      throw new GroupError('not_owner', '只有群主可以生成邀请。');
    }

    if (group.invites.length >= MAX_INVITES_PER_GROUP) {
      throw new GroupError('group_full', `该群的邀请数量已达上限（${MAX_INVITES_PER_GROUP}），请撤销一些旧邀请。`);
    }

    // Resolve the link target before minting anything: a missing gateway is an
    // operator misconfiguration, and failing after the insert would leave an
    // orphan invite in the file that nobody can ever use.
    //
    // The agent name is the HOST, not the group. One DSH instance registered once
    // behind the gateway serves every group it hosts, and the group is named in
    // the payload — which is why the link always carries `g=<groupId>` as well as
    // `agent=`. An earlier version fell back to `agent = groupId`, and that turned
    // "create a group" into "create a group AND add an entry to the gateway's
    // resources.yaml": an operator step per group, for no reason at all.
    const gatewayBase = optionalText(input.gatewayBase, 2048, '网关地址') ?? settings.gatewayBase;
    const agent = optionalText(input.agent, 200, 'agent 名') ?? settings.agentName ?? undefined;
    if (gatewayBase === undefined || gatewayBase === '') {
      throw new GroupError(
        'missing_gateway',
        '还没有配置群网关：请先在插件设置里填 groups.gatewayBase（AISIX 网关基址）与 groups.agentName（本实例在网关里的 agent 名，所有群共用），否则邀请链接里的地址无法被同事访问。',
      );
    }
    if (agent === undefined || agent === '') {
      throw new GroupError(
        'missing_agent_name',
        '还没有配置本实例的 agent 名：请在插件设置里填 groups.agentName（例如 "agent-person-zhangsan"）。'
        + '它是本实例在网关里的名字，建一次即可，所有群共用，不需要每个群单独配置。'
        + '注意区分两个命名空间：群宿主叫 agent-group-host（一个入口承载所有群，因为群是数据、'
        + '靠报文里的 groupId 区分），成员实例叫 agent-person-<谁>（一个人一个入口，因为每个人'
        + '是不同机器上的进程，网关的一条路径只能转发到一个地址）。',
      );
    }

    // Expiry is the ONLY bound on an invite. `null` means "never"; omitting the
    // field means the configured default, and the two must not be confused — a
    // caller who forgot to pass a value must not accidentally mint a permanent
    // public link. `Object.hasOwn` is what tells them apart.
    const createdAt = now();
    const expiresAt = resolveInviteExpiry(input, settings, createdAt);
    const token = `inv_${randomToken(24)}`;
    const inviteId = `i-${randomBytes(4).toString('hex')}`;

    group.invites.push({
      inviteId,
      tokenHash: sha256Hex(token),
      label,
      createdAt,
      // `null` = never expires. No use counter: see the doc comment above.
      expiresAt,
      revoked: false,
    });
    persist();

    const link = buildLink({
      groupId: group.groupId,
      token,
      gatewayBase,
      agent,
      name: group.name,
      expiresAt: expiresAt === null ? undefined : expiresAt,
    });
    const prompt = buildPrompt({
      name: group.name,
      link,
      expiresAt: expiresAt === null ? undefined : expiresAt,
    });

    log.info('invite created', {
      groupId: group.groupId,
      inviteId,
      token: redact(token),
      expiresAt: expiresAt === null ? 'never' : new Date(expiresAt).toISOString(),
    });
    return { token, link, prompt, expiresAt, inviteId, groupId: group.groupId, label };
  }

  /**
   * Redeem an invite.
   *
   * Order of checks is deliberate. The cheap, non-secret checks (does the group
   * exist, is this token a known hash, is it expired/revoked/spent) run before
   * scrypt, so that a flood of bogus tokens cannot make the host burn 50 ms of
   * CPU per attempt. The information this reveals — "this token was once real" —
   * is known to the invitee already and is not a group secret.
   *
   * The use counter increments only after *every* check passes, including the
   * password: a typo must not consume one of five uses, or a forwarded link
   * becomes unusable through no fault of the owner.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {string} [input.personId]
   * @param {string} [input.about]
   * @param {string[]} [input.tags]
   * @param {string} [input.token] invite token
   * @param {string} [input.displayName]
   * @param {string} [input.endpoint] optional callback address for the member
   * @returns {{member: object, personKey: string, group: object, feedTail: object[]}}
   */
  function join(input = {}) {
    const group = requireGroup(input.groupId);
    const displayName = optionalText(input.displayName, MAX_DISPLAY_NAME_CHARS, '昵称') ?? '成员';
    const endpoint = optionalText(input.endpoint, MAX_ENDPOINT_CHARS, 'endpoint') ?? undefined;
    const at = now();

    if (group.members.length >= MAX_MEMBERS_PER_GROUP) {
      throw new GroupError('group_full', `该群成员已达上限（${MAX_MEMBERS_PER_GROUP}）。`);
    }

    // A token is the ONLY way in by this path. There is no password to fall back
    // on, so the check is unconditional rather than gated on a join policy.
    const token = optionalText(input.token, 2048, '邀请令牌');
    if (token === undefined) {
      throw new GroupError('invite_invalid', '缺少邀请令牌：入群需要凭群主给你的邀请链接。');
    }
    const usedInvite = findInvite(group, token);
    if (usedInvite === undefined) {
      throw new GroupError('invite_invalid', '邀请无效：这个令牌不存在，可能已被群主撤销或删除了。');
    }
    if (usedInvite.revoked === true) {
      throw new GroupError('invite_revoked', '该邀请已被群主撤销，请让群主重新生成一个。', { inviteId: usedInvite.inviteId });
    }
    // `expiresAt === null` is a link minted as permanent on purpose.
    if (usedInvite.expiresAt !== null && usedInvite.expiresAt <= at) {
      throw new GroupError('invite_expired', '该邀请已过期，请让群主重新生成一个。', {
        expiresAt: new Date(usedInvite.expiresAt).toISOString(),
      });
    }

    const personKey = `mk_${randomToken(32)}`;
    const member = {
      // The caller may present an id it already holds from another group; reusing it is what
      // makes this person the same person here.
      personId: allocatePersonId(input.personId),
      displayName,
      role: 'member',
      keyHash: sha256Hex(personKey),
      joinedAt: at,
      lastSeenAt: at,
      endpoint,
      // Layer A, self-described at join time. Optional: a colleague who just
      // wants in should not be blocked by a form, and can set it later with
      // `setProfile`.
      roleAbout: optionalText(input.about, MAX_ROLE_ABOUT_CHARS, '角色说明') ?? undefined,
      tags: normalizeTags(input.tags),
      profileUpdatedAt: at,
    };
    group.members.push(member);
    // Join is the only chance to learn a member's address, so it is kept on their profile as
    // well as the membership row.
    noteEndpoint(member.personId, endpoint);
    appendSystem(group, `${displayName} 加入了群`);
    persist();

    log.info('member joined', {
      groupId: group.groupId,
      personId: member.personId,
      inviteId: usedInvite?.inviteId,
      personKey: redact(personKey),
    });

    return {
      member: publicMember(member, at),
      personKey,
      group: withFeedTail(group, at),
      feedTail: group.feed.slice(-FEED_TAIL_LIMIT).map((entry) => publicEntry(entry)),
    };
  }

  /**
   * Resolve a member from its credential, or `undefined`.
   *
   * A wrong key, an unknown member id and an unknown group all flow through the
   * same digest comparison and return `undefined`: the A2A layer must not be able
   * to tell a caller whether a member id exists. The comparison is over 64-char
   * sha256 hex, so it is fixed-width and constant-time even though the supplied
   * key length varies.
   *
   * The returned object is registered in a WeakMap. That is what lets later calls
   * (`post`, `read`, …) accept it without asking for the key again, while still
   * refusing a hand-built `{personId}` object — the difference between "came out
   * of authenticate()" and "was constructed by the caller" is unforgeable.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {string} [input.personId]
   * @param {string} [input.personKey]
   * @returns {object|undefined} a public member view (never contains `keyHash`)
   */
  function authenticate(input = {}) {
    const group = findGroup(input.groupId);
    const supplied = sha256Hex(typeof input.personKey === 'string' ? input.personKey : '');
    if (group === undefined) {
      // Compare against a dummy digest so an unknown group costs the same as a
      // wrong key; a fast "no such group" path would leak group existence.
      compareSecrets(supplied, dummyKeyHash());
      return undefined;
    }
    const personId = typeof input.personId === 'string' ? input.personId : '';
    const member = group.members.find((entry) => entry.personId === personId);
    if (member === undefined) {
      compareSecrets(supplied, dummyKeyHash());
      return undefined;
    }
    // Fixed-width: both sides are 64-char hex, so the comparison leaks neither
    // content nor length and a wrong key is indistinguishable from a wrong id.
    if (!compareSecrets(supplied, member.keyHash)) return undefined;

    const at = now();
    member.lastSeenAt = at; // in-memory only; the next mutation or flush persists it
    dirty = true;
    const view = deepFreeze(publicMember(member, at));
    authenticated.set(view, member.personId);
    return view;
  }

  /**
   * Append a message to the feed.
   *
   * Two limits, both checked before appending: message length (`maxPostChars`)
   * and a per-member token bucket. The bucket is deliberately memory-only — a
   * restart resets it, which is fine (restarts are rare and an attacker cannot
   * trigger one), and persisting it would turn every chat message into a disk
   * write of the rate-limit table.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {object} [input.member] authenticated member (or `{personId, personKey}`)
   * @param {string} [input.mentions]
   * @param {string} [input.text]
   * @param {object} [input.payload] structured payload; not interpreted here
   * @returns {{seq: number, msgId: string, at: number, atIso: string}}
   */
  function post(input = {}) {
    const group = requireGroup(input.groupId);
    const member = resolveMember(group, input.member);
    const text = typeof input.text === 'string' ? input.text : '';
    const payload = input.payload === undefined ? undefined : input.payload;
    // Validate the payload on the way in, before anything mutates: a cyclic or
    // BigInt payload would otherwise throw from JSON.stringify inside persist()
    // and leave the feed grown in memory but the file unwritten.
    validatePayload(payload);

    if (text.trim() === '' && payload === undefined) {
      throw new GroupError('empty_message', '发帖内容为空：请给 text 或 payload。');
    }
    const maxPostChars = group.settings.maxPostChars;
    if (text.length > maxPostChars) {
      throw new GroupError('too_long', `单条消息超过 ${maxPostChars} 字上限，请拆条发送或改用附件路径。`, {
        length: text.length,
        maxPostChars,
      });
    }

    if (group.settings?.archived === true) {
      // An archived group is a record, not a place to talk. Refusing the write is the whole
      // meaning of archive; allowing it would make the flag decorative.
      throw new GroupError('group_archived', '这个群已归档，不能再发言。需要继续讨论请让群主恢复它。');
    }

    consume(group, member);

    const at = now();
    const seq = group.nextSeq;
    group.nextSeq += 1;
    const mentions = resolveMentions(group, input.mentions);
    const entry = {
      seq,
      at,
      msgId: randomUUID(),
      kind: 'message',
      from: { personId: member.personId, displayName: member.displayName },
      text,
      payload,
      // Absent rather than an empty array when nobody was addressed: the distinction
      // between "addressed nobody" and "addressed everyone" must survive the file, and
      // an empty array would read as the former for both.
      ...(mentions.length === 0 ? {} : { mentions }),
    };
    group.feed.push(entry);
    member.lastSeenAt = at;
    persist();
    notify(group, entry);
    return { seq, msgId: entry.msgId, at, atIso: new Date(at).toISOString(), mentions };
  }

  /**
   * Turn a caller's mention list into member ids, or the `@all` sentinel.
   *
   * Accepted forms, because a model writing "@李四" should not have to resolve the id
   * itself:
   *
   *   - `"@all"` / `"all"` / `"@所有人"` → `["@all"]`
   *   - a member id                  → kept if that member exists
   *   - a display name               → resolved when exactly ONE member has that name
   *
   * An ambiguous display name is dropped rather than guessed: waking the wrong person is
   * worse than not waking anyone, and the poster can retry with an id.
   *
   * @param {GroupRecord} group - internal group record.
   * @param {unknown} raw - the caller's mention list.
   * @returns {string[]} resolved ids, or `[MENTION_ALL]`; empty array for no mentions.
   */
  function resolveMentions(group, raw) {
    if (raw === undefined || raw === null) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const out = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const token = item.trim();
      if (token === '') continue;
      const lowered = token.toLowerCase();
      if (lowered === MENTION_ALL || lowered === 'all' || token === '@所有人' || token === '所有人') {
        // "everyone" subsumes any individual name in the same list: the post addressed
        // the whole group, and keeping both would make the grading logic pick one.
        return [MENTION_ALL];
      }
      const byId = group.members.find((member) => member.personId === token);
      if (byId !== undefined) {
        if (!out.includes(byId.personId)) out.push(byId.personId);
        continue;
      }
      const byName = group.members.filter((member) => member.displayName === token);
      if (byName.length === 1) {
        if (!out.includes(byName[0].personId)) out.push(byName[0].personId);
      }
    }
    return out.slice(0, MAX_MENTIONS_PER_POST);
  }

  /**
   * Incremental read: everything after `sinceSeq`, oldest first.
   *
   * `lastSeq` is the cursor the caller should store, and `truncated` says "there
   * is more right now" so a subscriber can loop instead of waiting a full
   * heartbeat. Neither is derived from `feed.length`: retention pruning removes
   * from the front, and a length-derived cursor would silently rewind.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {object} [input.member]
   * @param {number} [input.sinceSeq]
   * @param {number} [input.limit]
   * @returns {{entries: object[], lastSeq: number, truncated: boolean}}
   */
  function read(input = {}) {
    const group = requireGroup(input.groupId);
    const member = resolveMember(group, input.member);
    const sinceSeq = numberOf(input.sinceSeq, -Infinity);
    const limit = clampLimit(input.limit);
    const head = group.nextSeq - 1;
    const entries = group.feed.filter((entry) => entry.seq > sinceSeq).slice(0, limit).map(publicEntry);
    const lastSeq = entries.length > 0 ? entries[entries.length - 1].seq : head;
    member.lastSeenAt = now();
    dirty = true;
    return { entries, lastSeq, truncated: entries.length === limit && lastSeq < head };
  }

  /**
   * Whether this host keeps the group.
   *
   * The `a2a_group_join` tool has to branch on this before it knows which side it
   * is on: a link for a group hosted here is joined in-process, a link for
   * somebody else's group is joined by calling their A2A endpoint. Answering it
   * needs no credential — knowing that a group id exists on this host is not a
   * secret, and refusing to answer would only turn a routing decision into a
   * failed join.
   *
   * @param {string} groupId
   * @returns {boolean}
   */
  function has(groupId) {
    return findGroup(groupId) !== undefined;
  }

  /**
   * The newest feed entry, or `undefined` for an empty feed.
   *
   * For the group list ("last message" preview). Requires a member: the preview
   * is message text, which is exactly what the password protects, so an
   * anonymous caller gets `undefined` rather than a redacted string — a partial
   * preview is still a leak.
   *
   * @param {object} input
   * @param {string} input.groupId
   * @param {object} input.member
   * @returns {object|undefined} public entry view
   */
  /**
   * One member's own record in a group, without a credential.
   *
   * Exists for ONE caller inside this process: the layer B profile builder, which
   * needs to know what this instance said about itself in a group it hosts, and
   * runs while rendering an agent card. Doing that through `members()` would
   * require the credential, which the card builder deliberately does not hold, and
   * doing it over the network would put a round trip inside card rendering.
   *
   * This is safe to expose because it is not a lookup service: it returns a view
   * only for a `personId` the caller already knows, and it reveals nothing beyond
   * what `members()` would show to any member of that group. It cannot be used to
   * enumerate members (`members()` requires a credential for that) and it exposes
   * no key material.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {string} [input.personId]
   * @returns {object|undefined} the public member view, or undefined.
   */
  function memberView(input = {}) {
    const group = findGroup(input.groupId);
    if (group === undefined) return undefined;
    const personId = typeof input.personId === 'string' ? input.personId : '';
    if (personId === '') return undefined;
    const member = group.members.find((entry) => entry.personId === personId);
    if (member === undefined) return undefined;
    return publicMember(member, now());
  }

  function lastEntry(input = {}) {
    const group = requireGroup(input.groupId);
    resolveMember(group, input.member);
    const entry = group.feed.length === 0 ? undefined : group.feed[group.feed.length - 1];
    return entry === undefined ? undefined : publicEntry(entry);
  }

  /**
   * Public member list, with presence derived from `lastSeenAt`.
   *
   * Presence is computed, not stored: a stored "online" flag has to be un-set by
   * something, and a crashed host never un-sets it. A timestamp is always honest.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {object} [input.member]
   * @returns {object[]} public member views (no `keyHash`)
   */
  function members(input = {}) {
    const group = requireGroup(input.groupId);
    resolveMember(group, input.member);
    const at = now();
    return group.members.map((member) => publicMember(member, at));
  }

    /**
   * Post one message to one person.
   *
   * @param {object} input
   * @param {string} input.fromPersonId who is sending.
   * @param {string} input.toPersonId who should receive it.
   * @param {string} input.kind one of the `DM_KIND_*` values.
   * @param {string} input.text one line, shown as-is.
   * @param {object} [input.payload] structured data the client acts on, e.g. `{ inviteLink, groupId }`.
   * @returns {object} the stored message.
   */
  function sendPersonMessage(input = {}) {
    const fromPersonId = requireText(input.fromPersonId, 'fromPersonId');
    const toPersonId = requireText(input.toPersonId, 'toPersonId');
    const kind = requireText(input.kind, 'kind');
    if (!DM_KINDS.has(kind)) {
      throw new GroupError('bad_argument', `不支持的一对一消息类型：${kind}。`);
    }
    if (fromPersonId === toPersonId) {
      // Not an error worth failing on, but not something to store either: a note to yourself
      // arrives with no sender, and the UI would have to special-case it.
      throw new GroupError('bad_argument', '不能给自己发消息。');
    }
    const text = requireText(input.text, 'text');
    const at = now();

    const message = {
      dmId: `dm-${randomBytes(6).toString('hex')}`,
      fromPersonId,
      toPersonId,
      kind,
      text,
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      createdAt: at,
      // Absent until the receiver confirms. The sender's HTTP call returning is NOT delivery:
      // reporting "sent" for a message nobody received is how a messenger loses trust.
      deliveredAt: undefined,
      readAt: undefined,
      expiresAt: at + DM_TTL_MS,
    };

    directMessages.push(message);
    // Drop the oldest delivered messages first, then the oldest overall, so an overflowing queue
    // loses history rather than anything still waiting to be read.
    if (directMessages.length > MAX_DIRECT_MESSAGES) {
      const delivered = directMessages.filter((entry) => entry.deliveredAt !== undefined);
      const dropCount = directMessages.length - MAX_DIRECT_MESSAGES;
      const doomed = new Set(
        [...delivered, ...directMessages].slice(0, dropCount).map((entry) => entry.dmId),
      );
      directMessages = directMessages.filter((entry) => !doomed.has(entry.dmId));
    }
    persist();
    log.info('direct message stored', { dmId: message.dmId, kind });
    return publicDirectMessage(message);
  }

  /**
   * Messages waiting for one person, including any already delivered but unread.
   *
   * @param {object} input - `{ personId, since }`.
   * @returns {object[]} messages, oldest first.
   */
  function listPersonMessages(input = {}) {
    const personId = requireText(input.personId, 'personId');
    const since = Number.isFinite(input.since) ? input.since : 0;
    const at = now();
    return directMessages
      .filter((entry) => entry.toPersonId === personId)
      .filter((entry) => entry.expiresAt > at)
      .filter((entry) => entry.createdAt > since)
      .slice(-MAX_DM_PAGE)
      .map(publicDirectMessage);
  }

  /**
   * Confirm receipt, which is what turns "sent" into "delivered".
   *
   * Idempotent: a retried ack must not move the timestamp, because `deliveredAt` is what the sender
   * shows and a shifting value would look like repeated deliveries.
   *
   * @param {object} input - `{ personId, dmIds }`.
   * @returns {{acked: number, unknown: string[]}} how many were confirmed, and which were not found.
   */
  function ackPersonMessages(input = {}) {
    const personId = requireText(input.personId, 'personId');
    const ids = Array.isArray(input.dmIds) ? input.dmIds.filter((id) => typeof id === 'string') : [];
    if (ids.length === 0) throw new GroupError('bad_argument', '缺少要确认的 dmIds。');
    const at = now();
    let acked = 0;
    const unknown = [];
    for (const dmId of ids) {
      const message = directMessages.find((entry) => entry.dmId === dmId);
      // A message addressed to somebody else is reported as unknown rather than acknowledged: an ack
      // by the wrong person would mark a message delivered that its recipient never saw.
      if (message === undefined || message.toPersonId !== personId) {
        unknown.push(dmId);
        continue;
      }
      if (message.deliveredAt === undefined) {
        message.deliveredAt = at;
        acked += 1;
      }
    }
    if (acked > 0) persist();
    return { acked, unknown };
  }

  /**
   * Whether a person is currently holding a connection this host can push into.
   *
   * The same rule the roster uses for presence: a subscription refreshes `lastSeenAt`, so a recent
   * timestamp means a live socket. Kept as a question rather than a flag because a flag would need
   * clearing on every disconnect path, and one missed path leaves someone "online" forever.
   *
   * @param {string} personId - the person.
   * @returns {boolean} whether they are reachable now.
   */
  function isPersonOnline(personId) {
    const at = now();
    for (const group of state.groups) {
      for (const member of group.members) {
        if (member.personId !== personId) continue;
        if (at - member.lastSeenAt <= ONLINE_WINDOW_MS) return true;
      }
    }
    return false;
  }

  /**
   * Refresh a member's presence timestamp, and nothing else.
   *
   * Called on a timer by an open subscription, which is the real evidence that somebody is
   * reachable. Every other writer of `lastSeenAt` also does something visible (authenticate, post,
   * read), so reusing one of those for a presence tick would put noise in the feed or move a
   * sequence number just to say "still here".
   *
   * Silent on failure by design: the caller suppresses errors too, because a presence refresh must
   * never be able to kill a working subscription.
   *
   * @param {object} input - `{ groupId, member }`.
   * @returns {number} the timestamp written.
   */
  function touch(input = {}) {
    const group = requireGroup(input.groupId);
    const member = resolveMember(group, input.member);
    const at = now();
    member.lastSeenAt = at;
    dirty = true;
    return at;
  }

/**
   * Change what this member is IN THIS GROUP.
   *
   * Layer A of identity: a colleague may be a developer all year and take on the
   * product role in one project. Re-declaring is the ordinary case, not an
   * exception, so this overwrites rather than versioning — the group shows who
   * somebody is now, not a history of job titles.
   *
   * Two rules that are not negotiable:
   *
   *  - **Only the member itself.** `resolveMember` proves the caller holds that
   *    member's credential, so there is no way to pass somebody else's identity —
   *    a role is self-description, not a label others stick on you. (Contrast
   *    with `role`, the permission bit, which the store owns.)
   *  - **Never touches `role`.** Business identity and the ability to mint invites
   *    are different axes; conflating them would turn "I am the PM" into a
   *    privilege escalation.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {object} [input.member] authenticated member view, or `{personId, personKey}`
   * @param {string} [input.about] one sentence; omit to leave unchanged
   * @param {string[]} [input.tags] up to MAX_TAGS short labels; `[]` clears them
   * @returns {{personId: string, roleAbout: (string|undefined), tags: string[], updatedAt: number}}
   */
  function setProfile(input = {}) {
    const group = requireGroup(input.groupId);
    const member = resolveMember(group, input.member);
    const at = now();

    // Compare against the stored values so a save that changes nothing is not announced. A feed where
    // every open-and-save adds a line makes the notification useless, because a member can no longer
    // tell an update from a repeat — and the report that started this was exactly that.
    const beforeAbout = member.roleAbout ?? '';
    const beforeTags = JSON.stringify([...(member.tags ?? [])].sort());

    if (input.about !== undefined) {
      member.roleAbout = input.about === null || input.about === ''
        ? undefined
        : requireText(input.about, 'about', MAX_ROLE_ABOUT_CHARS, '角色说明');
    }
    if (input.tags !== undefined) member.tags = normalizeTags(input.tags);

    // Normalised on both sides: comparing a raw array against a normalised one would report a change on
    // every save, which is the same bug wearing a different hat.
    const afterAbout = member.roleAbout ?? '';
    const afterTags = JSON.stringify([...(member.tags ?? [])].sort());
    const profileChanged = beforeAbout !== afterAbout || beforeTags !== afterTags;

    if (profileChanged === false) {
      // A no-op save: return the current state and touch nothing. `profileUpdatedAt` in particular stays,
      // because it means "when this last changed" and bumping it would make the value lie.
      return {
        personId: member.personId,
        roleAbout: member.roleAbout,
        tags: [...member.tags],
        updatedAt: member.profileUpdatedAt ?? at,
        changed: false,
      };
    }

    member.profileUpdatedAt = at;
    dirty = true;
    persist();

    // A system line so other members can notice a role change without re-reading the member list. It
    // carries no identity detail, only the fact of the change — and now only when there IS one.
    appendSystem(group, `${member.displayName} 更新了本群角色`);
    log.info('member profile updated', {
      groupId: group.groupId,
      personId: member.personId,
      tags: member.tags,
    });
    return {
      personId: member.personId,
      roleAbout: member.roleAbout,
      tags: [...member.tags],
      updatedAt: at,
      changed: true,
    };
  }

  /**
   * Remove another member. Owner only.
   *
   * Their messages stay. Deleting them would rewrite the conversation — a reader would see
   * people answering somebody who no longer appears to have spoken — and history is the
   * group's product, not the leaver's property to erase.
   *
   * A system entry records the removal, because the remaining members will notice that a
   * person disappeared. Silence would leave them guessing, and guessing in a group about
   * people is how rumours start.
   *
   * The owner cannot remove themselves: that is `leave`, which transfers ownership. Doing
   * it here would leave a group with an owner who is not in it.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {object} [input.member] owner credential
   * @param {string} [input.targetPersonId] who to remove
   * @param {string} [input.reason] one line for the system entry
   * @returns {{removed: boolean, personId: string, feedSeq: number|undefined}}
   */
  function removeMember(input = {}) {
    const group = requireGroup(input.groupId);
    const owner = resolveMember(group, input.member);
    if (owner.personId !== group.ownerPersonId) {
      throw new GroupError('not_owner', '只有群主可以移除成员。');
    }
    const targetId = typeof input.targetPersonId === 'string' ? input.targetPersonId.trim() : '';
    if (targetId === '') throw new GroupError('bad_argument', '缺少 targetPersonId。');
    if (targetId === owner.personId) {
      throw new GroupError(
        'bad_argument',
        '群主不能用移除操作离开：请用 group/leave，它会把群主身份交给下一位成员。',
      );
    }
    const index = group.members.findIndex((entry) => entry.personId === targetId);
    if (index < 0) throw new GroupError('not_member', '要移除的人不在这个群里。');

    const target = group.members[index];
    group.members.splice(index, 1);
    // The rate-limit bucket is keyed by group+member; leaving it behind would leak one
    // entry per removal for the life of the process.
    for (const key of buckets.keys()) {
      if (key === `${group.groupId}\u0000${target.personId}`) buckets.delete(key);
    }

    const reason = optionalText(input.reason, MAX_REQUEST_REASON_CHARS, '原因');
    appendSystem(
      group,
      `${owner.displayName} 将 ${target.displayName} 移出了群${reason === undefined ? '' : `（${reason}）`}`,
    );
    persist();
    log.info('member removed', { groupId: group.groupId, personId: target.personId, by: owner.personId });
    return {
      removed: true,
      personId: target.personId,
      displayName: target.displayName,
      feedSeq: group.nextSeq - 1,
    };
  }

  /**
   * Rename a group, or change its topic, or both. Owner only.
   *
   * The most frequent maintenance act in a real group, and until now the only remedy for a
   * wrong name was to create a new group and lose its history — which nobody would do, so
   * groups kept wrong names.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {object} [input.member] owner credential
   * @param {string} [input.name] new display name
   * @param {string} [input.topic] new topic; an empty string clears it
   * @returns {{name: string, topic: string, changed: string[]}}
   */
  function renameGroup(input = {}) {
    const group = requireGroup(input.groupId);
    const owner = resolveMember(group, input.member);
    if (owner.personId !== group.ownerPersonId) {
      throw new GroupError('not_owner', '只有群主可以改群名或主题。');
    }

    const changed = [];
    if (input.name !== undefined) {
      const name = requireText(input.name, 'name', MAX_NAME_CHARS, '群名');
      if (name !== group.name) {
        group.name = name;
        changed.push('name');
      }
    }
    if (input.topic !== undefined) {
      const topic = optionalText(input.topic, MAX_TOPIC_CHARS, '群主题') ?? '';
      if (topic !== group.topic) {
        group.topic = topic;
        changed.push('topic');
      }
    }
    if (changed.length === 0) {
      // Not an error: a caller that sends the current values is asking "did anything
      // change", and the honest answer is no. Reporting it beats a silent no-op.
      return { name: group.name, topic: group.topic, changed: [] };
    }

    appendSystem(group, `${owner.displayName} 修改了${changed.map((field) => (field === 'name' ? '群名' : '群主题')).join(' 和 ')}`);
    persist();
    log.info('group renamed', { groupId: group.groupId, changed });
    return { name: group.name, topic: group.topic, changed };
  }

  /**
   * Archive or unarchive a group. Owner only.
   *
   * Archived means readable but not writable, and absent from the directory. That is
   * deliberately NOT a delete: a finished project's conversation is worth keeping, and
   * re-opening an archive by mistake must be possible — a delete is not reversible.
   *
   * Read is still allowed because the most common reason to archive is "we are done" and
   * the second most common is "let me check what we decided". Refusing to read an archive
   * would make the feature useless.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {object} [input.member] owner credential
   * @param {boolean} [input.archived] defaults to true
   * @returns {{archived: boolean}}
   */
  function archiveGroup(input = {}) {
    const group = requireGroup(input.groupId);
    const owner = resolveMember(group, input.member);
    if (owner.personId !== group.ownerPersonId) {
      throw new GroupError('not_owner', '只有群主可以归档或恢复群。');
    }
    const archived = input.archived !== false;
    if (archived === (group.settings.archived === true)) {
      return { archived };
    }
    group.settings.archived = archived;
    appendSystem(group, `${owner.displayName} ${archived ? '归档' : '恢复'}了这个群`);
    persist();
    log.info('group archived', { groupId: group.groupId, archived });
    return { archived };
  }

  /**
   * Remove a member.
   *
   * If the owner leaves while others remain, ownership transfers to the
   * earliest-joined remaining member instead of leaving the group unmanageable:
   * an owner-less group can never mint or revoke another invite. (The contract
   * does not specify this case; it is recorded as a deviation in the delivery
   * notes.)
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {object} [input.member]
   * @returns {boolean} whether a member was removed
   */
  function leave(input = {}) {    const group = requireGroup(input.groupId);
    const member = resolveMember(group, input.member);
    const index = group.members.findIndex((entry) => entry.personId === member.personId);
    group.members.splice(index, 1);
    for (const key of buckets.keys()) {
      if (key === `${group.groupId}\u0000${member.personId}`) buckets.delete(key);
    }
    appendSystem(group, `${member.displayName} 退出了群`);

    if (member.personId === group.ownerPersonId) {
      const next = [...group.members].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (next === undefined) {
        group.ownerPersonId = undefined; // no members left; the group is inert but retained
      } else {
        next.role = 'owner';
        group.ownerPersonId = next.personId;
        appendSystem(group, `${next.displayName} 成为新群主`);
      }
    }
    persist();
    log.info('member left', { groupId: group.groupId, personId: member.personId });
    return true;
  }

  /**
   * Revoke an invite so its tokens stop working immediately.
   *
   * Requires the *owner* credential, not the group password: a shared password
   * must not be enough to kick other people's pending invites out from under
   * them.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {string} [input.ownerKey]
   * @param {string} [input.token]
   * @param {string} [input.inviteId]
   * @returns {boolean} whether an invite was revoked
   */
  function revokeInvite(input = {}) {
    const group = requireGroup(input.groupId);
    const owner = group.members.find((entry) => entry.personId === group.ownerPersonId);
    const supplied = sha256Hex(typeof input.ownerKey === 'string' ? input.ownerKey : '');
    if (owner === undefined || !compareSecrets(supplied, owner.keyHash)) {
      throw new GroupError('not_owner', '只有群主可以撤销邀请。');
    }
    const inviteId = optionalText(input.inviteId, 200, 'inviteId');
    const token = optionalText(input.token, 2048, '邀请令牌');
    if (inviteId === undefined && token === undefined) {
      throw new GroupError('bad_argument', '撤销邀请需要提供 inviteId 或邀请令牌。');
    }
    const tokenHash = token === undefined ? undefined : sha256Hex(token);
    let found;
    for (const candidate of group.invites) {
      if (inviteId !== undefined && candidate.inviteId === inviteId) found = candidate;
      else if (tokenHash !== undefined && compareSecrets(tokenHash, candidate.tokenHash)) found = candidate;
    }
    if (found === undefined) return false;
    found.revoked = true;
    persist();
    log.info('invite revoked', { groupId: group.groupId, inviteId: found.inviteId });
    return true;
  }

  /**
   * Subscribe to a group's new entries.
   *
   * The callback is isolated: one subscriber that throws (a broken SSE sink, a
   * disposed session) must not stop the others or fail the `post` that triggered
   * it, because the post is already durable at that point.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {(entry: object) => void} [input.fn]
   * @returns {() => void} unsubscribe
   */
  function subscribe(input = {}) {
    const groupId = requireGroup(input.groupId).groupId;
    if (typeof input.fn !== 'function') throw new GroupError('bad_argument', 'subscribe 需要一个回调函数。');
    let set = subscribers.get(groupId);
    if (set === undefined) {
      set = new Set();
      subscribers.set(groupId, set);
    }
    set.add(input.fn);
    return () => {
      const current = subscribers.get(groupId);
      if (current === undefined) return;
      current.delete(input.fn);
      if (current.size === 0) subscribers.delete(groupId);
    };
  }

  /**
   * A summary of one group, safe to show in a panel.
   *
   * `member` is optional so the read-only UI can render a joined group's header
   * before the panel has a credential in hand. Without a credential the result
   * carries *metadata only* — counts, timestamps, settings — and deliberately no
   * message text, not even the last line: "how many messages and when" is a
   * group's shape, while what was said is the thing a password protects.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {object} [input.member]
   * @returns {object} summary without any hash field
   */
  function snapshot(input = {}) {
    const group = requireGroup(input.groupId);
    const at = now();
    let viewer;
    if (input.member !== undefined) viewer = resolveMember(group, input.member);
    const lastEntry = group.feed.length === 0 ? undefined : group.feed[group.feed.length - 1];
    const withContent = viewer !== undefined && lastEntry !== undefined;
    return {
      ...publicGroup(group),
      feedTail: viewer === undefined ? [] : group.feed.slice(-FEED_TAIL_LIMIT).map(publicEntry),
      // Text only for a credential holder; the timestamp is metadata either way.
      lastPost: withContent ? publicEntry(lastEntry) : undefined,
      lastPostAt: lastEntry?.at,
      lastPostAtIso: lastEntry === undefined ? undefined : new Date(lastEntry.at).toISOString(),
      onlineCount: group.members.filter((member) => at - member.lastSeenAt <= ONLINE_WINDOW_MS).length,
    };
  }

  /**
   * Every group on this host, as summaries.
   *
   * Not in CONTRACT §2.6 (the panel and `a2a_group_*` listing need it); additive,
   * and it returns the same hash-free shape as `snapshot` with no feed.
   *
   * @returns {object[]}
   */
  function list() {
    const at = now();
    return state.groups.map((group) => ({
      ...publicGroup(group),
      onlineCount: group.members.filter((member) => at - member.lastSeenAt <= ONLINE_WINDOW_MS).length,
    }));
  }

  /**
   * Apply to join a group, without a credential.
   *
   * This is the "I saw the group in the directory and want in" path. The applicant
   * has no member key yet — that is the whole point — so the store cannot know who
   * they are. What it CAN do is hand back a secret that only the applicant holds,
   * and let the owner decide out of band.
   *
   * The returned `requestId` is public (it is a queue index); the returned
   * `claimKey` is the secret. Splitting them matters: an approval is addressed by
   * `requestId` (the owner reads that list anyway), while claiming the resulting
   * membership requires `claimKey` (only the applicant ever saw it). If the claim
   * accepted the id alone, anyone who guessed or saw an id in a log could collect
   * somebody else's membership.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {string} [input.displayName] who is asking
   * @param {string} [input.reason] one line about why
   * @returns {{requestId: string, claimKey: string, expiresAt: number, groupName: string}}
   */
  function requestJoin(input = {}) {
    const group = requireGroup(input.groupId);
    if ((group.settings?.visibility ?? 'public') === 'unlisted') {
      // An unlisted group does not admit to existing, so it cannot acknowledge a
      // request either: a "pending" answer would confirm the id.
      throw new GroupError('unknown_group', '找不到这个群。');
    }
    const displayName = optionalText(input.displayName, MAX_DISPLAY_NAME_CHARS, '昵称');
    if (displayName === undefined) {
      throw new GroupError('bad_argument', '申请入群需要填写你的名字（displayName）。');
    }
    const reason = optionalText(input.reason, MAX_REQUEST_REASON_CHARS, '申请理由') ?? '';

    const at = now();
    // Expire the queue before looking at its size: a burst of stale requests must
    // not make a group look full to the next honest applicant.
    pruneRequests(group, at);
    if (group.requests.length >= MAX_PENDING_REQUESTS) {
      throw new GroupError('group_full', `该群待处理的申请已达上限（${MAX_PENDING_REQUESTS}），请稍后再试。`);
    }
    // One person, one open request. Re-applying refreshes the reason and the
    // deadline instead of queueing a duplicate the owner would see twice.
    const existing = group.requests.find(
      (entry) => entry.status === 'pending' && entry.displayName === displayName,
    );
    if (existing !== undefined) {
      existing.reason = reason;
      existing.expiresAt = at + REQUEST_TTL_MS;
      persist();
      return {
        requestId: existing.requestId,
        claimKey: undefined, // already handed out; re-issuing would invalidate it
        expiresAt: existing.expiresAt,
        groupName: group.name,
        duplicate: true,
      };
    }

    const claimKey = `ck_${randomToken(32)}`;
    const request = {
      requestId: `r-${randomBytes(4).toString('hex')}`,
      displayName,
      reason,
      claimHash: sha256Hex(claimKey),
      status: 'pending',
      createdAt: at,
      expiresAt: at + REQUEST_TTL_MS,
    };
    group.requests.push(request);
    persist();
    log.info('join requested', {
      groupId: group.groupId,
      requestId: request.requestId,
      displayName,
    });
    return {
      requestId: request.requestId,
      claimKey,
      expiresAt: request.expiresAt,
      groupName: group.name,
      duplicate: false,
    };
  }

  /**
   * The pending queue, for the owner only.
   *
   * Requires the owner's credential because the queue contains other people's
   * names and stated reasons — the same class of information as the member list.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {object} [input.member] owner credential
   * @param {string} [input.status] 'pending' (default) | 'approved' | 'rejected' | 'all'
   * @returns {object[]} public request views
   */
  function listRequests(input = {}) {
    const group = requireGroup(input.groupId);
    const member = resolveMember(group, input.member);
    if (member.personId !== group.ownerPersonId) {
      throw new GroupError('not_owner', '只有群主可以查看入群申请。');
    }
    const at = now();
    pruneRequests(group, at);
    const wanted = typeof input.status === 'string' ? input.status : 'pending';
    return group.requests
      // The claim hash never leaves the store: it is the applicant's secret.
      .filter((entry) => (wanted === 'all' ? true : entry.status === wanted))
      .map((entry) => ({
        requestId: entry.requestId,
        displayName: entry.displayName,
        reason: entry.reason,
        status: entry.status,
        createdAt: entry.createdAt,
        createdAtIso: new Date(entry.createdAt).toISOString(),
        expiresAt: entry.expiresAt,
        expiresAtIso: new Date(entry.expiresAt).toISOString(),
      }));
  }

  /**
   * Approve or reject one request. Owner only.
   *
   * Approving does NOT create the membership yet. It only flips the request to
   * `approved` and records who did it, because the applicant is the one holding the
   * `claimKey` — they collect the membership with `claimJoin`. Creating the member
   * here would hand an unusable row to someone who cannot authenticate with it.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {object} [input.member] owner credential
   * @param {string} [input.requestId]
   * @param {boolean} [input.approve] true to approve, false to reject
   * @returns {{requestId: string, status: string, displayName: string}}
   */
  function decideRequest(input = {}) {
    const group = requireGroup(input.groupId);
    const member = resolveMember(group, input.member);
    if (member.personId !== group.ownerPersonId) {
      throw new GroupError('not_owner', '只有群主可以审批入群申请。');
    }
    const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
    if (requestId === '') throw new GroupError('bad_argument', '缺少 requestId。');
    const request = group.requests.find((entry) => entry.requestId === requestId);
    if (request === undefined) {
      throw new GroupError('request_not_found', '找不到这条申请：它可能已被处理或已过期。');
    }
    const at = now();
    if (request.expiresAt <= at) {
      request.status = 'expired';
      persist();
      throw new GroupError('request_expired', '这条申请已过期，请让申请人重新提交。');
    }
    if (request.status !== 'pending') {
      throw new GroupError('request_pending', `这条申请已经是「${request.status}」，不能重复处理。`);
    }
    request.status = input.approve === false ? 'rejected' : 'approved';
    request.decidedAt = at;
    request.decidedBy = member.displayName;
    persist();
    log.info('join decided', {
      groupId: group.groupId,
      requestId,
      status: request.status,
      by: member.personId,
    });
    // A system line so members can see the door working, without naming the
    // applicant's stated reason (that was written for the owner, not the group).
    appendSystem(group, `${request.displayName} 的入群申请已${request.status === 'approved' ? '通过' : '被拒绝'}`);
    return {
      requestId: request.requestId,
      status: request.status,
      displayName: request.displayName,
      // The owner needs the link to send the applicant... except they no longer do:
      // the applicant claims it with their own key. Returned for a UI that wants to
      // show what happened.
      decidedAt: request.decidedAt,
    };
  }

  /**
   * Redeem an approved request for a membership. Applicant only — via `claimKey`.
   *
   * This is where "approval IS the admission" becomes concrete: the applicant does
   * not need the group password, because the owner already vouched for them. That
   * is a deliberate weakening of the password model, and it is bounded:
   *
   *   - the password still guards `invite` (the owner's own admission path);
   *   - a claim needs the secret handed out at request time, so an approved
   *     `requestId` alone is worthless;
   *   - a request is single-use: claiming flips it to `claimed`.
   *
   * The trade is stated plainly: a password is a shared secret anyone can leak to
   * anyone, while an approval is one person vouching for one other person. For
   * admitting colleagues, the voucher is the stronger signal — and it is why the
   * approval path skips the password.
   *
   * @param {object} input
   * @param {string} [input.groupId]
   * @param {string} [input.requestId]
   * @param {string} [input.claimKey] the secret from `requestJoin`
   * @returns {{member: object, personKey: string, group: object}}
   */
  function claimJoin(input = {}) {
    const group = requireGroup(input.groupId);
    const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
    const claimKey = typeof input.claimKey === 'string' ? input.claimKey : '';
    if (requestId === '' || claimKey === '') {
      throw new GroupError('bad_argument', '领取成员身份需要 requestId 与 claimKey。');
    }
    const request = group.requests.find((entry) => entry.requestId === requestId);
    if (request === undefined) {
      throw new GroupError('request_not_found', '找不到这条申请。');
    }
    // Constant-time compare: the claim key is a credential, not an index.
    if (!compareSecrets(sha256Hex(claimKey), request.claimHash)) {
      throw new GroupError('request_invalid', '领取凭证不正确。');
    }
    const at = now();
    if (request.status === 'rejected') {
      throw new GroupError('request_rejected', '这条申请已被拒绝。');
    }
    if (request.status === 'claimed') {
      // Idempotency matters here: a flaky link means the applicant retries, and a
      // retry must not mint a second membership or invalidate the first key.
      throw new GroupError('request_pending', '这条申请已经领取过了；请用当时拿到的成员凭证。');
    }
    if (request.status !== 'approved') {
      throw new GroupError('request_pending', '这条申请还没有被审批，请等待群主确认。');
    }
    if (request.expiresAt <= at) {
      request.status = 'expired';
      persist();
      throw new GroupError('request_expired', '这条申请已过期，请重新提交。');
    }
    if (group.members.length >= MAX_MEMBERS_PER_GROUP) {
      throw new GroupError('group_full', `该群成员已达上限（${MAX_MEMBERS_PER_GROUP}）。`);
    }

    const personKey = `mk_${randomToken(32)}`;
    const member = {
      personId: allocatePersonId(),
      displayName: request.displayName,
      role: 'member',
      keyHash: sha256Hex(personKey),
      joinedAt: at,
      lastSeenAt: at,
      endpoint: undefined,
      roleAbout: undefined,
      tags: [],
      profileUpdatedAt: at,
    };
    group.members.push(member);
    request.status = 'claimed';
    request.claimedAt = at;
    appendSystem(group, `${request.displayName} 通过申请加入了群`);
    persist();
    log.info('join claimed', { groupId: group.groupId, personId: member.personId });
    return { member: publicMember(member, at), personKey, group: publicGroup(group) };
  }

  /**
   * Mark stale pending requests expired and drop the ones nobody can act on.
   *
   * Run before every read of the queue so an operator opening the list never sees
   * applications that died a week ago, and before every insert so a stale backlog
   * cannot make the group look full.
   *
   * @param {object} group - internal group record.
   * @param {number} at - current epoch ms.
   */
  function pruneRequests(group, at) {
    if (!Array.isArray(group.requests)) {
      group.requests = [];
      return;
    }
    for (const request of group.requests) {
      if (request.status === 'pending' && request.expiresAt <= at) request.status = 'expired';
    }
    // Bound the file: keep pending plus the most recent decided rows, drop the rest.
    if (group.requests.length > MAX_PENDING_REQUESTS * 4) {
      const pending = group.requests.filter((entry) => entry.status === 'pending');
      const decided = group.requests
        .filter((entry) => entry.status !== 'pending')
        .sort((left, right) => (right.decidedAt ?? right.createdAt) - (left.decidedAt ?? left.createdAt))
        .slice(0, MAX_PENDING_REQUESTS);
      group.requests = [...pending, ...decided];
    }
  }

  /**
   * The channel directory: which groups this host offers, without a credential.
   *
   * This is the one read in the whole store that needs no member key, so it is
   * also the one that has to be most careful about what it returns. The rule is a
   * single sentence: **say a group exists, never say who is in it or what was
   * said in it.**
   *
   * Concretely, each row carries the group's name, topic, join policy, member
   * count and last-activity time — the things a person needs to decide whether to
   * ask for an invite — and nothing else. No member identities, no `personId`
   * list, no feed text, no invite tokens, no owner id. A caller who wants any of
   * that must present a member credential and use `members()` / `read()`.
   *
   * `unlisted` groups are omitted entirely rather than returned with a flag: an
   * existence oracle is exactly what "unlisted" is supposed to prevent, and a
   * per-group flag would still tell a caller that a group with that id exists.
   *
   * @param {object} [input]
   * @param {string} [input.query] optional case-insensitive filter over name+topic
   * @param {number} [input.limit] page size, clamped
   * @param {number} [input.offset] page start
   * @returns {{groups: object[], total: number, returned: number, hasMore: boolean}} the directory page
   */
  function listDirectory(input = {}) {
    const at = now();
    const needle = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
    const limit = clampInteger(input.limit, DIRECTORY_DEFAULT_LIMIT, 1, DIRECTORY_MAX_LIMIT);
    const offset = clampInteger(input.offset, 0, 0, 100_000);

    const visible = state.groups
      // `unlisted` never appears: see the doc comment for why a flag is not enough.
      .filter((group) => (group.settings?.visibility ?? 'public') !== 'unlisted')
      // An archived group is not on offer: it accepts no new members, so listing it would
      // invite a request nobody can act on.
      .filter((group) => group.settings?.archived !== true)
      .filter((group) => needle === ''
        || group.name.toLowerCase().includes(needle)
        || (typeof group.topic === 'string' && group.topic.toLowerCase().includes(needle)))
      // Most recently active first: a directory is for finding what is happening
      // now, and an idle group is rarely the one somebody wants.
      .sort((left, right) => lastActivityOf(right, at) - lastActivityOf(left, at));

    const page = visible.slice(offset, offset + limit).map((group) => ({
      groupId: group.groupId,
      name: group.name,
      topic: group.topic,
      // A count, not a roster. "5 people are in this" is useful for judging
      // whether a group is alive; naming them is a privacy decision the members
      // made by joining, not one this endpoint gets to make.
      memberCount: group.members.length,
      onlineCount: group.members.filter((member) => at - member.lastSeenAt <= ONLINE_WINDOW_MS).length,
      // Coarse activity: when something last happened, so a caller can tell a live
      // group from an abandoned one without reading the feed.
      lastActivityAt: lastActivityOf(group, at),
      lastActivityAtIso: new Date(lastActivityOf(group, at)).toISOString(),
      lastSeq: group.nextSeq - 1,
      createdAt: group.createdAt,
      createdAtIso: new Date(group.createdAt).toISOString(),
    }));

    return {
      groups: page,
      total: visible.length,
      returned: page.length,
      hasMore: offset + page.length < visible.length,
    };
  }

  /**
   * Force a durable write. Best-effort: a slow disk must not fail a request whose
   * in-memory state is already correct.
   *
   * Retention pruning runs here (and before every write), so an idle host does
   * not hold feed entries forever just because nobody posted.
   *
   * @returns {boolean} whether anything was written
   */
  function flush() {
    try {
      prune();
      if (!dirty) return false;
      persist();
      return true;
    } catch (error) {
      log.warn('group flush failed', { error: error?.message ?? String(error) });
      return false;
    }
  }

  return {
    create,
    invite,
    join,
    authenticate,
    post,
    read,
    members,
    // Layer A: re-declare what I am in this group. Only ever applies to the
    // caller's own membership — never another member's.
    // Presence refresh for an open subscription. Separate from the mutators above because it
    // changes only a timestamp.
    touch,
    // One-to-one invitations. A doorbell, not a chat: see the module note above.
    sendPersonMessage,
    listPersonMessages,
    ackPersonMessages,
    isPersonOnline,
    setProfile,
    // The person layer: one profile per person, independent of any group. Kept beside the
    // group API because it lives in the same file, not because it is the same concept.
    personProfile,
    setPersonProfile,
    listPersons,
    // Owner-only group administration. `remove` keeps the target's messages, `rename`
    // fixes a name without losing history, and `archive` retires a group reversibly.
    removeMember,
    renameGroup,
    archiveGroup,
    leave,
    revokeInvite,
    subscribe,
    snapshot,
    list,
    has,
    lastEntry,
    // Layer B support: one member's own record, for the profile builder. See the
    // function's doc for why this needs no credential and cannot enumerate.
    memberView,
    // The channel directory: a credential-free listing that says a group exists
    // and never who is in it. See the function's doc for the exact contract.
    listDirectory,
    // The other way in: apply, and let the owner decide. `requestJoin` needs no
    // credential (the applicant has none yet); `listRequests` and `decideRequest`
    // need the OWNER's; `claimJoin` needs the applicant's own `claimKey`.
    requestJoin,
    listRequests,
    decideRequest,
    claimJoin,
    flush,
    /** The file this store owns; exposed for diagnostics and tests. */
    file,
    /** Directory holding the file. */
    home: directory,
  };

  // -------------------------------------------------------------------------
  // Membership and authentication helpers
  // -------------------------------------------------------------------------

  /** Look up a group by id, without throwing. */
  function findGroup(groupId) {
    if (typeof groupId !== 'string' || groupId === '') return undefined;
    return state.groups.find((group) => group.groupId === groupId);
  }

  /** Look up a group by id, throwing a readable error when absent. */
  function requireGroup(groupId) {
    const group = findGroup(groupId);
    if (group === undefined) {
      throw new GroupError('unknown_group', `找不到群 ${typeof groupId === 'string' ? groupId : ''}：它可能已被删除，或这个 id 打错了。`);
    }
    return group;
  }

  /**
   * Resolve the caller to a member record, requiring proof of identity.
   *
   * Two accepted forms, and only two: an object that came out of
   * `authenticate()` in this process (unforgeable, tracked in a WeakMap), or an
   * object carrying `personId` + `personKey`. A bare `{personId}` is rejected —
   * that is the shape a JSON body has, and accepting it would turn any A2A caller
   * into any member.
   */
  function resolveMember(group, candidate) {
    if (!isPlainObject(candidate)) {
      throw new GroupError('not_member', '缺少成员身份：请先入群，或用 personId + personKey 调用。');
    }
    // An authenticated view carries its identity inside the WeakMap, not in a
    // field, so editing `candidate.personId` cannot change who the caller is.
    const authenticatedId = authenticated.get(candidate);
    const personId = authenticatedId ?? (typeof candidate.personId === 'string' ? candidate.personId : '');
    const record = group.members.find((entry) => entry.personId === personId);

    if (authenticatedId !== undefined) {
      if (record === undefined) throw new GroupError('not_member', '你已不在这个群里。', { personId });
      return record;
    }

    const supplied = sha256Hex(typeof candidate.personKey === 'string' ? candidate.personKey : '');
    if (record === undefined) {
      compareSecrets(supplied, dummyKeyHash());
      throw new GroupError('not_member', '成员凭证无效：你已不在这个群里，或凭证已失效。', { personId });
    }
    if (!compareSecrets(supplied, record.keyHash)) {
      throw new GroupError('not_member', '成员凭证无效：你已不在这个群里，或凭证已失效。', { personId });
    }
    return record;
  }

  /**
   * A stand-in digest for the "no such group / no such member" path.
   *
   * A fixed, published constant: it lets a failed lookup pay the same
   * constant-time comparison as a wrong credential so the two are
   * indistinguishable from outside. It cannot be matched by a real credential —
   * that would require a sha256 preimage — and it is not a secret, so committing
   * it to source is the point.
   */
  function dummyKeyHash() {
    return DUMMY_KEY_HASH;
  }

  /**
   * Decide when one invite stops working.
   *
   * Three cases, and the distinction between the first two is the whole point:
   *
   *   - the caller passed `expiresInHours: null` → **never** (`null` returned);
   *   - the caller passed a number → that many hours;
   *   - the caller passed nothing → the configured default.
   *
   * "Nothing" and "null" must not collapse into one another: a caller who simply
   * omitted the field is the common case and must get a bounded link, while a
   * permanent link is a deliberate request. `Object.hasOwn` is what separates them,
   * and a nonsense value (negative, NaN) falls back to the default rather than
   * becoming an unintended permanent link.
   *
   * @param {object} input - the caller's args.
   * @param {object} settings - store settings.
   * @param {number} createdAt - epoch ms the invite is minted.
   * @returns {number|null} expiry epoch ms, or null for never.
   */
  function resolveInviteExpiry(input, settings, createdAt) {
    if (Object.hasOwn(input, 'expiresInHours')) {
      if (input.expiresInHours === null) return null;
      const hours = Number(input.expiresInHours);
      if (Number.isFinite(hours) && hours > 0) {
        return createdAt + Math.round(hours * 3600 * 1000);
      }
      // An unusable value is a caller mistake; fall through to the default rather
      // than minting something permanent by accident.
    }
    const fallback = settings.inviteExpiresInHours;
    if (fallback === null) return null;
    const hours = Number(fallback);
    return createdAt + Math.round((Number.isFinite(hours) && hours > 0 ? hours : 168) * 3600 * 1000);
  }

  /** Find a pending invite by the plaintext token, comparing hashes in constant time. */
  function findInvite(group, token) {
    const tokenHash = sha256Hex(token);
    let found;
    for (const candidate of group.invites) {
      // No early exit: comparing every hash keeps the timing independent of which
      // invite (if any) matched, and the list is small and bounded.
      if (compareSecrets(tokenHash, candidate.tokenHash)) found = candidate;
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  /**
   * Spend one token from a member's bucket.
   *
   * A plain token bucket (capacity = maxPostsPerMinute, refill = capacity per
   * minute) rather than a fixed window: a fixed window lets a member send 2x the
   * limit across a window boundary, which is exactly the burst a spam bot would
   * use. The bucket is keyed by group+member so two groups do not share a budget.
   */
  function consume(group, member) {
    const capacity = group.settings.maxPostsPerMinute;
    const key = `${group.groupId}\u0000${member.personId}`;
    const at = now();
    const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: at };
    const elapsed = Math.max(0, at - bucket.updatedAt);
    const refilled = Math.min(capacity, bucket.tokens + (elapsed * capacity) / 60_000);
    if (refilled < 1) {
      const waitMs = Math.ceil(((1 - refilled) / capacity) * 60_000);
      buckets.set(key, { tokens: refilled, updatedAt: at });
      throw new GroupError('rate_limited', `发得太快了：每分钟最多 ${capacity} 条，请等 ${Math.ceil(waitMs / 1000)} 秒再发。`, {
        maxPostsPerMinute: capacity,
        retryAfterMs: waitMs,
      });
    }
    buckets.set(key, { tokens: refilled - 1, updatedAt: at });
  }

  // -------------------------------------------------------------------------
  // Feed helpers
  // -------------------------------------------------------------------------

  /** Append a `kind: 'system'` entry (join / leave / created) and notify subscribers. */
  function appendSystem(group, text) {
    if (group.nextSeq === undefined) group.nextSeq = 1;
    const entry = {
      seq: group.nextSeq,
      at: now(),
      msgId: randomUUID(),
      kind: 'system',
      from: { personId: 'system', displayName: '系统' },
      text,
    };
    group.nextSeq += 1;
    group.feed.push(entry);
    notify(group, entry);
    return entry;
  }

  /** Fan an entry out to subscribers, isolating failures. */
  function notify(group, entry) {
    const set = subscribers.get(group.groupId);
    if (set === undefined) return;
    const view = publicEntry(entry);
    for (const fn of [...set]) {
      try {
        // An async subscriber rejects into a floating promise; catch it so it
        // cannot become an unhandled rejection and take the process down long
        // after the post that caused it was already acknowledged.
        const result = fn(view);
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          result.then(undefined, (error) => {
            log.warn('subscriber rejected', { groupId: group.groupId, error: error?.message ?? String(error) });
          });
        }
      } catch (error) {
        log.warn('subscriber threw', { groupId: group.groupId, error: error?.message ?? String(error) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Load the state file, degrading to an empty store only when that is safe. */
  function loadState() {
    ensureDirectory();
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, groups: [], persons: [] };
      // Unreadable for any other reason (permissions, EIO) must not be treated as
      // "empty": starting empty would silently drop every group and credential.
      throw new GroupError('storage_unreadable', `无法读取群状态文件 ${file}：${error?.code ?? error?.message ?? 'unknown'}。`, {
        file,
        cause: error?.code,
      });
    }

    try {
      // A file we just wrote is 0o600, but a file that predates this version may
      // not be; tightening it on load is cheap and closes the window where an
      // old install kept credentials world-readable.
      bestEffortChmod(file, 0o600);
      const parsed = JSON.parse(raw);
      const loadedGroups = Array.isArray(parsed?.groups)
        ? parsed.groups.map(sanitizeGroup).filter((group) => group !== undefined)
        : [];
      // A file written before this table existed yields an empty one, and `listPersons`
      // reconstructs names and endpoints from the membership rows. Nobody is lost; they simply
      // have no headline until somebody sets one.
      const loadedPersons = Array.isArray(parsed?.persons)
        ? parsed.persons.filter((entry) => isPlainObject(entry) && typeof entry.personId === 'string')
        : [];
      const loadedMessages = Array.isArray(parsed?.directMessages)
        ? parsed.directMessages.filter((entry) => isPlainObject(entry) && typeof entry.dmId === 'string')
        : [];
      return { version: 1, groups: loadedGroups, persons: loadedPersons, directMessages: loadedMessages };
    } catch (error) {
      // Corrupt JSON: keep the bytes for a human, start clean, and make noise. The
      // alternative (refusing to mount) turns a single bad byte into "the plugin
      // will not start", and the alternative of silently overwriting destroys the
      // only copy of the credentials.
      const backup = `${file}.corrupt-${now()}`;
      try {
        renameSync(file, backup);
      } catch {
        /* best effort */
      }
      log.error('groups.json is corrupt; moved aside and starting empty', {
        file,
        backup,
        error: error?.message ?? String(error),
      });
      return { version: 1, groups: [], persons: [] };
    }
  }

  /** Prune feed entries older than the group's retention window. */
  function prune() {
    const at = now();
    for (const group of state.groups) {
      const retentionMs = group.settings.retentionDays * 86_400_000;
      if (!Number.isFinite(retentionMs) || retentionMs <= 0) continue;
      const cutoff = at - retentionMs;
      const kept = group.feed.filter((entry) => entry.at >= cutoff);
      if (kept.length !== group.feed.length) {
        group.feed = kept;
        dirty = true;
      }
    }
  }

  /**
   * Serialize and write atomically, then clear the dirty flag.
   *
   * Serialization happens before any file operation. A `JSON.stringify` that
   * throws here (a payload mutated by a subscriber between `post` and `persist`,
   * say) would otherwise leave a temp file behind and the dirty flag set, so the
   * error is reported as a group error and the state stays loadable from the last
   * good file.
   */
  function persist() {
    prune();
    let payload;
    try {
      // One file for everything the host owns. A second file would be a second write that can
      // half-succeed, and the two halves would drift after a crash.
      payload = JSON.stringify(
        { version: 1, groups: state.groups, persons: [...persons.values()], directMessages },
        null,
        2,
      );
    } catch (error) {
      throw new GroupError('bad_argument', `群状态无法序列化：${error?.message ?? String(error)}。`, {
        cause: error?.name,
      });
    }
    writeFileAtomic(file, payload);
    dirty = false;
  }

  /** Create the directory (0o700) if needed, and keep its mode tight. */
  function ensureDirectory() {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new GroupError('storage_unreadable', `无法创建群状态目录 ${directory}：${error?.code ?? error?.message ?? 'unknown'}。`, {
        directory,
        cause: error?.code,
      });
    }
    bestEffortChmod(directory, 0o700);
  }

  /** Allocate an unused group id. */
  function allocateGroupId() {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = `g-${randomBytes(4).toString('hex')}`;
      if (!state.groups.some((group) => group.groupId === candidate)) return candidate;
    }
    throw new GroupError('group_full', '无法分配新的群 id，请重试。');
  }

  /** Allocate an unused member id within the current state. */
  /**
   * Read one person's profile, or a blank one for somebody never seen.
   *
   * @param {string} personId - the person.
   * @returns {object} the profile.
   */
  function personProfile(personId) {
    const record = persons.get(personId);
    if (record === undefined) {
      return { personId, displayName: '', headline: '', tags: [], endpoint: '', updatedAt: 0 };
    }
    return {
      personId: record.personId,
      displayName: record.displayName,
      headline: record.headline,
      tags: [...record.tags],
      endpoint: record.endpoint,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Update a person's own profile. Self-service only.
   *
   * The credential comes from any group the caller belongs to, and it can only ever write
   * its own row: there is no path here that names somebody else.
   *
   * @param {object} input - `{ groupId, member, displayName?, headline?, tags?, endpoint? }`.
   * @returns {object} the stored profile.
   */
  function setPersonProfile(input = {}) {
    const group = requireGroup(input.groupId);
    const member = resolveMember(group, input.member);
    const at = now();

    const previous = persons.get(member.personId);
    const record = {
      personId: member.personId,
      displayName: optionalText(input.displayName, MAX_DISPLAY_NAME_CHARS, '昵称')
        ?? previous?.displayName
        ?? member.displayName,
      // A group-independent self-description. An empty string clears it; undefined leaves it.
      headline: input.headline === undefined
        ? (previous?.headline ?? '')
        : (input.headline === null ? '' : optionalText(input.headline, MAX_ROLE_ABOUT_CHARS, '简介') ?? ''),
      tags: input.tags === undefined ? (previous?.tags ?? []) : normalizeTags(input.tags),
      endpoint: input.endpoint === undefined
        ? (previous?.endpoint ?? '')
        : (input.endpoint === null ? '' : optionalText(input.endpoint, MAX_ENDPOINT_CHARS, 'endpoint') ?? ''),
      updatedAt: at,
    };
    persons.set(member.personId, record);
    persist();
    log.info('person profile updated', { personId: member.personId });
    return personProfile(member.personId);
  }

  /**
   * Every known person's profile.
   *
   * Built from the table plus the membership rows, so somebody who joined before this table
   * existed still appears: name and endpoint come from the membership, and the headline stays
   * empty rather than being invented.
   *
   * @returns {object[]} one profile per person.
   */
  function listPersons() {
    /** personId → the first membership row seen, for fields the table may not have. */
    const fromMembers = new Map();
    for (const group of state.groups) {
      for (const member of group.members) {
        if (!fromMembers.has(member.personId)) fromMembers.set(member.personId, member);
      }
    }

    const out = [];
    for (const personId of new Set([...persons.keys(), ...fromMembers.keys()])) {
      const stored = persons.get(personId);
      const seen = fromMembers.get(personId);
      out.push({
        personId,
        displayName: stored?.displayName || seen?.displayName || '',
        headline: stored?.headline ?? '',
        tags: stored?.tags ?? [],
        endpoint: stored?.endpoint || seen?.endpoint || '',
        updatedAt: stored?.updatedAt ?? 0,
      });
    }
    return out;
  }

  /** Record an endpoint a member presented at join time, so others can reach them. */
  function noteEndpoint(personId, endpoint) {
    if (typeof endpoint !== 'string' || endpoint === '') return;
    const previous = persons.get(personId);
    persons.set(personId, {
      personId,
      displayName: previous?.displayName ?? '',
      headline: previous?.headline ?? '',
      tags: previous?.tags ?? [],
      endpoint,
      updatedAt: now(),
    });
  }
  /**
   * A member id for this person, reusing one they already hold when they have it.
   *
   * The id identifies a PERSON across every group on this host, so joining a second group
   * keeps the id instead of minting a new one. That is what makes `@` work the same way
   * everywhere and lets a colleague card be one card rather than a per-group fragment.
   *
   * A preferred id is accepted only when nobody else holds it. If it is taken — a stale value
   * from another instance, or a hand-written one — a fresh id is allocated rather than
   * failing: joining a group matters more than the id a caller happened to suggest.
   *
   * @param {string} [preferred] an id the caller already owns, e.g. from a previous join.
   * @returns {string} the member id.
   */
  /**
   * The member id for this person, reusing the one they already hold.
   *
   * The id identifies a PERSON across every group on this host, so joining a second group keeps
   * it instead of minting a new one. That is what makes `@` work the same way everywhere and
   * lets a colleague card be one card rather than a per-group fragment.
   *
   * A preferred id is honoured unconditionally. It is, by construction, this host's own id for
   * the caller — it must already appear in the groups the caller belongs to, so checking "is it
   * taken" would reject exactly the case reuse exists for. The first version did that and minted
   * a second identity for the same person on every new group.
   *
   * A malformed id falls back to a fresh one: joining a group matters more than the exact shape
   * of a caller-supplied value.
   *
   * @param {string} [preferred] the id this person already holds.
   * @returns {string} the member id.
   */
  function allocatePersonId(preferred) {
    if (typeof preferred === 'string') {
      const candidate = preferred.trim();
      // Keep the shape check: an id from a future or foreign version must not enter this store,
      // where every other id follows \`m-<hex>\`.
      if (/^m-[0-9a-f]{4,32}$/u.test(candidate)) return candidate;
    }
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = `m-${randomBytes(4).toString('hex')}`;
      const taken = state.groups.some((group) => group.members.some((member) => member.personId === candidate));
      if (!taken) return candidate;
    }
    throw new GroupError('group_full', '无法分配新的成员 id，请重试。');
  }

  // -------------------------------------------------------------------------
  /**
   * The public shape of one message.
   *
   * `payload` is passed through untouched: it is what the receiving client acts on (a link to redeem,
   * a group to open), and reshaping it here would mean the client's parser and the sender's builder
   * could disagree.
   *
   * @param {object} message - the stored record.
   * @returns {object} the public copy.
   */
  function publicDirectMessage(message) {
    return {
      dmId: message.dmId,
      fromPersonId: message.fromPersonId,
      toPersonId: message.toPersonId,
      kind: message.kind,
      text: message.text,
      ...(message.payload === undefined ? {} : { payload: message.payload }),
      createdAt: message.createdAt,
      deliveredAt: message.deliveredAt,
      expiresAt: message.expiresAt,
    };
  }

  // Serializers: the only place a record becomes something a caller sees
  // -------------------------------------------------------------------------

  /**
   * When something last happened in a group, for directory ordering.
   *
   * Uses the newest of three signals rather than the feed alone: a group that was
   * just created but not yet posted in is alive, and a group whose members keep
   * arriving without posting is alive too. Falling back to `createdAt` keeps the
   * value total, so a caller never has to handle "no activity" as a special case.
   *
   * @param {object} group - internal group record.
   * @param {number} at - current time; accepted for signature symmetry, not used
   *   as a candidate because "now" would make every group look equally fresh.
   * @returns {number} epoch ms.
   */
  function lastActivityOf(group, at) {
    void at;
    const lastFeedEntry = group.feed.length === 0 ? 0 : group.feed[group.feed.length - 1].at;
    const lastMemberSeen = group.members.reduce(
      (newest, member) => (member.lastSeenAt > newest ? member.lastSeenAt : newest),
      0,
    );
    return Math.max(lastFeedEntry, lastMemberSeen, group.createdAt);
  }

  /** Public view of a group. Never includes `passwordHash` or `tokenHash`. */
  function publicGroup(group) {
    return {
      groupId: group.groupId,
      name: group.name,
      topic: group.topic,
      createdAt: group.createdAt,
      createdAtIso: new Date(group.createdAt).toISOString(),
      owner: {
        personId: group.ownerPersonId,
        displayName: group.members.find((member) => member.personId === group.ownerPersonId)?.displayName,
      },
      settings: { ...group.settings },
      memberCount: group.members.length,
      // A permanent invite (xpiresAt === null) counts as long as it is not revoked.
      inviteCount: group.invites.filter((invite) => invite.revoked !== true && (invite.expiresAt === null || invite.expiresAt > now())).length,
      lastSeq: group.nextSeq - 1,
    };
  }

  /** Public view of a member. Never includes `keyHash`. */
  function publicMember(member, at) {
    return {
      personId: member.personId,
      displayName: member.displayName,
      role: member.role,
      joinedAt: member.joinedAt,
      joinedAtIso: new Date(member.joinedAt).toISOString(),
      lastSeenAt: member.lastSeenAt,
      lastSeenAtIso: new Date(member.lastSeenAt).toISOString(),
      online: at - member.lastSeenAt <= ONLINE_WINDOW_MS,
      endpoint: member.endpoint,
      // Layer A: what this person is IN THIS GROUP. Deliberately beside `role`
      // and never folded into it — `role` answers "may they mint invites", this
      // answers "who are they here". Defaulted so a member stored before these
      // fields existed reads as "no declared role" rather than a broken view.
      roleAbout: member.roleAbout,
      tags: Array.isArray(member.tags) ? [...member.tags] : [],
      profileUpdatedAt: member.profileUpdatedAt,
    };
  }

  /** Public view of a feed entry: epoch ms plus ISO, because this is a boundary. */
  function publicEntry(entry) {
    const view = {
      seq: entry.seq,
      at: entry.at,
      atIso: new Date(entry.at).toISOString(),
      msgId: entry.msgId,
      kind: entry.kind,
      from: { ...entry.from },
      text: entry.text,
    };
    if (entry.payload !== undefined) view.payload = entry.payload;
    // Who this post addressed. Omitted when nobody was, so a reader can tell an
    // ordinary message from one that summons the whole group.
    if (Array.isArray(entry.mentions) && entry.mentions.length > 0) view.mentions = [...entry.mentions];
    return view;
  }

  /** Group summary with the recent tail, used by `join` so a new member sees context. */
  function withFeedTail(group, at) {
    return {
      ...publicGroup(group),
      onlineCount: group.members.filter((member) => at - member.lastSeenAt <= ONLINE_WINDOW_MS).length,
    };
  }

  // -------------------------------------------------------------------------
  // Config and coercion
  // -------------------------------------------------------------------------

  /**
   * Read the group settings from either a normalized plugin config or a flat object.
   *
   * `inviteExpiresInHours` accepts a number of hours, or `null` for "invites minted
   * here never expire unless the caller says otherwise". It is read with
   * `Object.hasOwn` semantics — an absent key means the 7-day default, while an
   * explicit `null` means permanent. Collapsing the two would make a typo in the
   * config silently mint permanent public links.
   */
  function readGroupConfig(raw) {
    const source = isPlainObject(raw?.groups) ? raw.groups : isPlainObject(raw) ? raw : {};
    const rawExpiry = source.inviteExpiresInHours;
    const inviteExpiresInHours = rawExpiry === null
      ? null
      : positiveNumber(rawExpiry, 168);
    return {
      inviteExpiresInHours,
      maxPostChars: positiveInteger(source.maxPostChars, 32_000),
      maxPostsPerMinute: positiveInteger(source.maxPostsPerMinute, 20),
      retentionDays: positiveNumber(source.retentionDays, 30),
      wakeMembers: source.wakeMembers !== false,
      gatewayBase: typeof source.gatewayBase === 'string' && source.gatewayBase !== '' ? source.gatewayBase : undefined,
      agentName: typeof source.agentName === 'string' && source.agentName !== '' ? source.agentName : undefined,
    };
  }

  /** Per-group settings, defaulted from the store settings and capped. */
  function mergeSettings(raw) {
    const source = isPlainObject(raw) ? raw : {};
    return {
      maxPostChars: clampInteger(source.maxPostChars, settings.maxPostChars, 1, 1_048_576),
      maxPostsPerMinute: clampInteger(source.maxPostsPerMinute, settings.maxPostsPerMinute, 1, 10_000),
      retentionDays: clampInteger(source.retentionDays, settings.retentionDays, 1, 3650),
      wakeMembers: typeof source.wakeMembers === 'boolean' ? source.wakeMembers : settings.wakeMembers,
      /**
       * Whether the group appears in a channel directory.
       *
       * `public` means: listed by name, topic, member COUNT and join policy —
       * never by member identities or feed content. `unlisted` means a host will
       * not even confirm it exists to someone who is not a member; joining still
       * works from an invite link, which is the ordinary case for a sensitive
       * project.
       *
       * Defaulted to `public` deliberately: directories are useful only when they
       * are populated, and a group whose existence is a secret can be marked so at
       * creation time.
       */
      visibility: source.visibility === 'unlisted' ? 'unlisted' : 'public',
      /**
       * Whether the group is archived: readable, not writable, absent from the directory.
       *
       * Not a delete. A finished project's conversation is worth keeping, and re-opening
       * an archive by mistake must be possible — a delete is not.
       */
      archived: source.archived === true,
    };
  }

  /** Normalize a loaded group record, or drop it when it cannot be trusted. */
  function sanitizeGroup(raw) {
    if (!isPlainObject(raw)) return undefined;
    const groupId = typeof raw.groupId === 'string' ? raw.groupId : undefined;
    if (groupId === undefined || !Array.isArray(raw.members) || !Array.isArray(raw.feed)) return undefined;
    const members = raw.members.filter(
      (member) =>
        isPlainObject(member) &&
        typeof member.personId === 'string' &&
        typeof member.keyHash === 'string' &&
        member.keyHash.length === 64,
    );
    if (members.length === 0) return undefined; // a group with no valid member cannot authenticate anyone
    const nextSeqCandidate = Number.isInteger(raw.nextSeq) ? raw.nextSeq : 1;
    const highestSeq = raw.feed.reduce((max, entry) => (Number.isInteger(entry?.seq) && entry.seq > max ? entry.seq : max), 0);
    return {
      groupId,
      name: typeof raw.name === 'string' ? raw.name : groupId,
      topic: typeof raw.topic === 'string' ? raw.topic : '',
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now(),
      ownerPersonId: members.some((member) => member.personId === raw.ownerPersonId)
        ? raw.ownerPersonId
        : members.find((member) => member.role === 'owner')?.personId,
      settings: mergeSettings(raw.settings),
      invites: Array.isArray(raw.invites)
        ? raw.invites.filter((invite) => isPlainObject(invite) && typeof invite.tokenHash === 'string' && invite.tokenHash.length === 64)
        : [],
      // The application queue survives a restart: a person who applied and is
      // waiting must not be silently dropped because the host rebooted. Only rows
      // that carry the fields an approval needs are kept — a half-written row could
      // never be acted on, and keeping it would show the owner a name with no way
      // to say yes.
      requests: Array.isArray(raw.requests)
        ? raw.requests.filter((request) => isPlainObject(request)
          && typeof request.requestId === 'string'
          && request.requestId !== ''
          && typeof request.displayName === 'string'
          && typeof request.claimHash === 'string'
          && request.claimHash.length === 64
          && Number.isFinite(request.createdAt)
          && Number.isFinite(request.expiresAt)
          && typeof request.status === 'string')
        : [],
      members,
      // A feed entry survives a reload with its mentions intact; without this the
      // addressing would be lost on every restart and every wake decision would fall
      // back to "ordinary message".
      feed: raw.feed
        .filter((entry) => isPlainObject(entry) && Number.isInteger(entry.seq))
        .map((entry) => {
          if (!Array.isArray(entry.mentions)) return entry;
          const mentions = entry.mentions.filter((item) => typeof item === 'string' && item !== '');
          return mentions.length === 0 ? { ...entry, mentions: undefined } : { ...entry, mentions };
        }),
      nextSeq: Math.max(nextSeqCandidate, highestSeq + 1),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (no store state)
// ---------------------------------------------------------------------------

/**
 * Write a file atomically: temp file in the same directory, fsync, rename.
 *
 * `rename` within a directory is atomic on Windows and POSIX, so a reader (or a
 * crash) sees either the old file or the new one — never a half-written
 * `groups.json`, which for this file would mean losing credentials. The temp
 * file is created `0o600` so there is no instant where the content exists with
 * looser permissions, and it is removed on failure so a crash loop cannot litter
 * the directory with credential copies.
 *
 * @param {string} file destination path
 * @param {string} content the serialized state
 */
export function writeFileAtomic(file, content) {
  const temp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeSync(fd, content, null, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

/** `chmod` that ignores failure: Windows has no POSIX mode, and that is fine. */
function bestEffortChmod(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    /* Windows: mode is advisory; the code still passes it for POSIX hosts. */
  }
}

/** Resolve the state directory from config, mirroring `config.resolveHome`. */
function resolveDirectory(raw) {
  const source = isPlainObject(raw?.groups) ? raw.groups : isPlainObject(raw) ? raw : {};
  if (typeof source.home === 'string' && source.home !== '') return source.home;
  const env = process.env;
  const base = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : process.cwd();
  return `${base.replace(/[\\/]+$/u, '')}/a2a`;
}

/** A logger that tolerates a missing or partially-shaped one. */
function createLogger(logger) {
  const call = (level, message, details) => {
    const fn = logger?.[level];
    if (typeof fn !== 'function') return;
    try {
      fn.call(logger, message, details);
    } catch {
      /* logging must never break a state transition */
    }
  };
  return {
    info: (message, details) => call('info', message, details),
    warn: (message, details) => call('warn', message, details),
    error: (message, details) => call('error', message, details),
  };
}

/**
 * A secret in a log line: `sha256:` + first 8 hex characters.
 *
 * Enough to correlate two log lines about the same token, useless for using it.
 * This is the contract's §0.6 rule, implemented once so no call site can forget.
 *
 * @param {unknown} secret
 * @returns {string}
 */
export function redact(secret) {
  if (typeof secret !== 'string' || secret === '') return 'sha256:';
  return `sha256:${sha256Hex(secret).slice(0, 8)}`;
}

/**
 * Clean a member's self-declared tags.
 *
 * Tags are free text on purpose: "兼产品", "临时支援" and "PM" are all legitimate in
 * a real team, and forcing a fixed vocabulary would make people pick the wrong
 * one. What is enforced is only what would break the display or the file:
 * trimming, case-insensitive de-duplication (keeping the first spelling), the
 * count cap, and the length cap. An empty array is a legitimate value meaning "no
 * tags", which is why `[]` clears rather than being ignored.
 *
 * @param {unknown} value - the caller's tags.
 * @returns {string[]} normalized tags; `[]` for anything unusable.
 */
export function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = item.trim();
    if (tag === '' || tag.length > MAX_TAG_CHARS) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Require a non-blank, length-capped string; throws a readable group error. */
function requireText(value, field, maxChars, label) {  if (typeof value !== 'string' || value.trim() === '') {
    throw new GroupError('bad_argument', `${label}（${field}）不能为空。`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length > maxChars) {
    throw new GroupError('bad_argument', `${label}过长：最多 ${maxChars} 字。`, { field, length: trimmed.length });
  }
  return trimmed;
}

/** Optional string: `undefined` when absent or blank, an error when over-long. */
function optionalText(value, maxChars, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new GroupError('bad_argument', `${label}必须是字符串。`);
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > maxChars) {
    throw new GroupError('bad_argument', `${label}过长：最多 ${maxChars} 字。`, { length: trimmed.length });
  }
  return trimmed;
}

/** A positive number, or the fallback when unusable. */
function positiveNumber(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return number;
}

/** A positive integer, or the fallback when unusable. */
function positiveInteger(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.trunc(number);
}

/** An integer clamped into `[min, max]`, falling back when not a number. */
function clampInteger(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/** `read`'s page size: default when absent, clamped when silly. */
function clampLimit(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return READ_LIMIT_DEFAULT;
  return Math.min(READ_LIMIT_MAX, Math.max(1, Math.trunc(number)));
}

/** A number from an optional input, falling back when absent or invalid. */
function numberOf(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Reject a payload that could not survive `JSON.stringify`.
 *
 * `payload` is caller-supplied structure that gets persisted verbatim. A cyclic
 * object or a BigInt would throw from inside `persist()` *after* the feed was
 * mutated in memory, which is the worst moment to fail: the caller sees an error,
 * the file disagrees, and the next write silently drops the entry. Checking it
 * before the mutation keeps memory and disk in step.
 *
 * @param {unknown} payload
 */
function validatePayload(payload) {
  if (payload === undefined) return;
  if (typeof payload !== 'object' || payload === null) {
    throw new GroupError('bad_argument', 'payload 必须是对象。');
  }
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new GroupError('bad_argument', 'payload 里含有无法序列化为 JSON 的值（循环引用或 BigInt）。');
  }
  if (typeof serialized !== 'string') {
    throw new GroupError('bad_argument', 'payload 必须是可序列化为 JSON 对象的对象。');
  }
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    throw new GroupError('too_long', `payload 超过 ${MAX_PAYLOAD_BYTES} 字节上限，请改用附件路径。`, {
      bytes: serialized.length,
      maxBytes: MAX_PAYLOAD_BYTES,
    });
  }
}

/** Whether a value is a plain JSON object (not an array, not null). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Freeze a public view, recursively.
 *
 * The views this module returns are the boundary between "verified" and "caller
 * controlled": a caller that holds a member view from `authenticate()` and can
 * still assign to it is a caller that can try to rename the identity it was
 * verified as. `null` prototype is not used (a view is a normal object for
 * JSON.stringify and for the UI), freezing is enough — the views never need to
 * be mutated by anyone, including us.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}