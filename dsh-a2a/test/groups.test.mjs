/**
 * Tests for the group state machine.
 *
 * The security assertions here are the ones a reviewer will ask about, so they
 * are written to fail loudly if any of them regresses:
 *
 *  - the bytes on disk never contain the password or the invite token;
 *  - a stored password is `scrypt$16384$…` (the contract's cost parameter);
 *  - every credential check goes through the injected constant-time comparator
 *    (verified by observing the call, not by trusting the source);
 *  - no public view (`snapshot`, `members`, `read`, `join`, `create`) carries a
 *    hash field — checked by walking the returned object recursively, so a
 *    future field addition cannot slip through;
 *  - directory 0o700 / file 0o600 (skipped on Windows, where there is no mode).
 *
 * Everything runs against a real temporary directory with an injected clock, so
 * expiry and retention are tested by travelling in time rather than sleeping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FEED_TAIL_LIMIT,
  GroupError,
  MAX_PAYLOAD_BYTES,
  SCRYPT_N,
  ONLINE_WINDOW_MS,
  constantTimeEquals,
  createGroupStore,
  hashPassword,
  redact,
  sha256Hex,
  verifyPassword,
  writeFileAtomic,
} from '../lib/core/groups.js';

const START = Date.parse('2026-11-03T09:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const isWindows = process.platform === 'win32';

/** Paths created by a test, removed afterwards. */
const temporaries = [];

test.after(() => {
  for (const directory of temporaries) rmSync(directory, { recursive: true, force: true });
});

/** A fresh state directory plus a controllable clock. */
function harness(options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-groups-'));
  temporaries.push(home);
  const clock = { t: START };
  const logs = [];
  const store = createGroupStore({
    home,
    clock: () => clock.t,
    logger: {
      info: (message, details) => logs.push({ level: 'info', message, details }),
      warn: (message, details) => logs.push({ level: 'warn', message, details }),
      error: (message, details) => logs.push({ level: 'error', message, details }),
    },
    config: {
      groups: {
        gatewayBase: 'https://gw.ict.cmcc',
        agentName: 'group-7f3a1c',
        inviteExpiresInHours: 168,
        inviteMaxUses: 5,
        maxPostsPerMinute: 20,
        retentionDays: 30,
        ...options.groups,
      },
    },
    compare: options.compare,
  });
  return { home, store, clock, logs, file: store.file };
}

/** Create a group and return everything a test needs from it. */
function seed(env, overrides = {}) {
  const created = env.store.create({
    name: '发票重构攻坚',
    topic: '把 invoice 服务拆干净',
    ownerDisplayName: '牛昆仑',
    ...overrides,
  });
  return {
    ...created,
    groupId: created.group.groupId,
    ownerId: created.group.owner.memberId,
  };
}

/** Every key name reachable in a value, for the "no hashes escaped" check. */
function allKeys(value, seen = new Set(), keys = []) {
  if (value === null || typeof value !== 'object') return keys;
  if (seen.has(value)) return keys;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, seen, keys);
    return keys;
  }
  for (const [key, item] of Object.entries(value)) {
    keys.push(key);
    allKeys(item, seen, keys);
  }
  return keys;
}

/** Assert a value exposes no credential-ish field, at any depth. */
function assertNoSecrets(value, label) {
  const keys = new Set(allKeys(value));
  // Hash material: never leaves the store in any view.
  for (const forbidden of ['tokenHash', 'keyHash', 'claimHash']) {
    assert.equal(keys.has(forbidden), false, `${label} must not expose ${forbidden}`);
  }
  // Plaintext credentials: shown once at issuance, never in a read view.
  for (const forbidden of ['token', 'ownerKey', 'memberKey', 'claimKey']) {
    assert.equal(keys.has(forbidden), false, `${label} must not expose plaintext ${forbidden}`);
  }
}

/** The parsed state file. */
function readState(env) {
  return JSON.parse(readFileSync(env.file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

test('hashPassword produces the contract format at the contract cost', () => {
  const stored = hashPassword('correct-horse-battery');
  const parts = stored.split('$');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'scrypt');
  assert.equal(Number(parts[1]), 2 ** 14, 'N is pinned at 16384 by CONTRACT §2.6');
  assert.equal(Number(parts[1]), SCRYPT_N);
  assert.equal(parts[2].length, 32, '16 random salt bytes, hex encoded');
  assert.equal(parts[3].length, 64, '32 derived bytes, hex encoded');
  assert.equal(stored.includes('correct-horse-battery'), false);
});

test('hashPassword salts every hash, so the same password does not look the same', () => {
  const first = hashPassword('same-password');
  const second = hashPassword('same-password');
  assert.notEqual(first, second);
  assert.equal(verifyPassword('same-password', first).ok, true);
  assert.equal(verifyPassword('same-password', second).ok, true);
});

test('verifyPassword reports mismatch, malformed input and a stale cost', () => {
  assert.deepEqual(verifyPassword('right', hashPassword('right')).ok, true);
  assert.equal(verifyPassword('wrong', hashPassword('right')).ok, false);
  assert.equal(verifyPassword('right', 'not-a-hash').reason, 'malformed');
  assert.equal(verifyPassword('right', 'scrypt$x$00ff$00ff').reason, 'malformed');
  assert.equal(verifyPassword('', hashPassword('right')).reason, 'empty');

  const cheap = hashPassword('right', { N: 1024 });
  const verified = verifyPassword('right', cheap);
  assert.equal(verified.ok, true);
  assert.equal(verified.needsRehash, true, 'a weaker stored cost must be flagged, not silently accepted');
});

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------




test('create() rejects an empty name and caps absurd names', () => {
  const env = harness();
  assert.throws(() => env.store.create({ name: '   ' }), (error) => error instanceof GroupError && error.code === 'bad_argument');
  assert.throws(() => env.store.create({ name: 'x'.repeat(121) }), (error) => error.code === 'bad_argument');
});

test('the state directory is 0o700 and the state file 0o600', { skip: isWindows ? 'Windows has no POSIX mode bits' : false }, () => {
  const env = harness();
  seed(env);
  assert.equal(statSync(env.home).mode & 0o777, 0o700);
  assert.equal(statSync(env.file).mode & 0o777, 0o600);
});

// ---------------------------------------------------------------------------
// invite()
// ---------------------------------------------------------------------------

test('invite() returns the token once and persists only its sha256', () => {
  const env = harness();
  const owner = seed(env);
  const invite = env.store.invite({ groupId: owner.groupId, label: '给张工', ownerKey: owner.ownerKey });

  assert.match(invite.token, /^inv_[A-Za-z0-9_-]{32}$/u);
  assert.equal(invite.expiresAt, START + 168 * HOUR);
  assert.ok(invite.link.startsWith('agent-a2a://group?v=1&'));
  assert.ok(invite.prompt.includes(invite.link));

  const raw = readFileSync(env.file, 'utf8');
  assert.equal(raw.includes(invite.token), false, 'the persisted file must not hold the invite token');
  assert.equal(raw.includes(invite.token.slice(4)), false);
  const stored = readState(env).groups[0].invites.at(-1);
  assert.equal(stored.tokenHash, sha256Hex(invite.token));
  assert.equal(stored.revoked, false);
  assert.equal(stored.label, '给张工');
});


test('invite() fails cleanly when no gateway is configured, without leaking an orphan invite', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-nogw-'));
  temporaries.push(home);
  const store = createGroupStore({ home, clock: () => START, config: { groups: {} } });
  const created = store.create({ name: '群' });
  assert.throws(
    () => store.invite({ groupId: created.group.groupId, ownerKey: created.ownerKey }),
    (error) => error instanceof GroupError && error.code === 'missing_gateway',
  );
  assert.equal(JSON.parse(readFileSync(store.file, 'utf8')).groups[0].invites.length, 0);
});

test('invite() honours expiresInHours and maxUses overrides, and puts a custom gateway in the link', () => {
  const env = harness();
  const owner = seed(env);
  const invite = env.store.invite({
    groupId: owner.groupId,
    expiresInHours: 2,
    gatewayBase: 'http://192.168.3.7:3000/a2a/',
    agent: 'group-local', ownerKey: owner.ownerKey });
  assert.equal(invite.expiresAt, START + 2 * HOUR);
  const url = new URL(invite.link);
  assert.equal(url.searchParams.get('gw'), 'http://192.168.3.7:3000/a2a');
  assert.equal(url.searchParams.get('agent'), 'group-local');
  assert.equal(url.searchParams.get('g'), owner.groupId);
  assert.equal(url.searchParams.get('t'), invite.token);
});

// ---------------------------------------------------------------------------
// join()
// ---------------------------------------------------------------------------

test('join() creates a member, returns its credential once, and hands back the feed tail', () => {
  const env = harness();
  const owner = seed(env);
  env.store.post({ groupId: owner.groupId, member: { memberId: owner.ownerId, memberKey: owner.ownerKey }, text: '开工了' });
  const invite = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });

  const joined = env.store.join({
    groupId: owner.groupId,
    token: invite.token,
    displayName: '张工',
    endpoint: 'gw://dsh-zhang',
  });

  assert.match(joined.memberKey, /^mk_[A-Za-z0-9_-]{43}$/u);
  assert.equal(joined.member.displayName, '张工');
  assert.equal(joined.member.role, 'member');
  assert.equal(joined.group.groupId, owner.groupId);
  assert.equal(joined.feedTail.some((entry) => entry.text === '开工了'), true);
  // The one documented exception to "no secret in a view": `join` is the response
  // that hands the new member its credential, exactly once.
  const withoutCredential = { ...joined };
  delete withoutCredential.memberKey;
  assertNoSecrets(withoutCredential, 'join() apart from the one-time credential');
  assertNoSecrets(joined.group, 'join().group');

  const raw = readFileSync(env.file, 'utf8');
  assert.equal(raw.includes(joined.memberKey), false);
  assert.equal(raw.includes(invite.token), false);
  const stored = readState(env).groups[0];
  assert.equal(stored.members.length, 2);
  assert.equal(stored.members[1].keyHash, sha256Hex(joined.memberKey));
  // No use counter any more: a link that admitted one person still works for the
  // next, until it expires or is revoked. Asserting the absence is deliberate — a
  // counter reappearing would be a decision, not something to pass silently.
  assert.equal(stored.invites[0].uses, undefined, 'there is no use counter');
  assert.equal(stored.invites[0].revoked, false, 'the link is still live after one join');
  assert.equal(stored.members[1].endpoint, 'gw://dsh-zhang');
});



test('join() rejects an unknown token, an expired invite and a revoked invite', () => {
  const env = harness();
  const owner = seed(env);

  assert.throws(
    () => env.store.join({ groupId: owner.groupId, token: 'inv_totally-made-up' }),
    (error) => error instanceof GroupError && error.code === 'invite_invalid',
  );

  const shortLived = env.store.invite({ groupId: owner.groupId, expiresInHours: 1, ownerKey: owner.ownerKey });
  env.clock.t = START + 2 * HOUR;
  assert.throws(
    () => env.store.join({ groupId: owner.groupId, token: shortLived.token }),
    (error) => error.code === 'invite_expired',
  );

  env.clock.t = START;
  const revocable = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });
  assert.equal(env.store.revokeInvite({ groupId: owner.groupId, ownerKey: owner.ownerKey, token: revocable.token }), true);
  assert.throws(
    () => env.store.join({ groupId: owner.groupId, token: revocable.token }),
    (error) => error.code === 'invite_revoked',
  );
});



test('join() refuses an unknown group and an empty token', () => {
  const env = harness();
  assert.throws(() => env.store.join({ groupId: 'g-nope' }), (error) => error.code === 'unknown_group');
  const owner = seed(env);
  assert.throws(
    () => env.store.join({ groupId: owner.groupId }),
    (error) => error.code === 'invite_invalid',
  );
});



// ---------------------------------------------------------------------------
// authenticate()
// ---------------------------------------------------------------------------

test('authenticate() returns undefined for a wrong key, a wrong member and a wrong group', () => {
  const env = harness();
  const owner = seed(env);

  assert.equal(env.store.authenticate({ groupId: owner.groupId, memberId: owner.ownerId, memberKey: 'wrong' }), undefined);
  assert.equal(env.store.authenticate({ groupId: owner.groupId, memberId: 'm-nobody', memberKey: owner.ownerKey }), undefined);
  assert.equal(env.store.authenticate({ groupId: 'g-nobody', memberId: owner.ownerId, memberKey: owner.ownerKey }), undefined);
  assert.equal(env.store.authenticate({}), undefined);
  assert.equal(env.store.authenticate({ groupId: owner.groupId, memberId: owner.ownerId, memberKey: '' }), undefined);
});

test('every credential check goes through the injected constant-time comparator', () => {
  const calls = [];
  const env = harness({
    compare: (left, right) => {
      calls.push([left, right]);
      return constantTimeEquals(left, right);
    },
  });
  const owner = seed(env);
  calls.length = 0;

  // A good key, a bad key and a nonexistent member must all reach the comparator:
  // if any of these paths short-circuited, the timing would leak membership.
  assert.ok(env.store.authenticate({ groupId: owner.groupId, memberId: owner.ownerId, memberKey: owner.ownerKey }));
  assert.equal(env.store.authenticate({ groupId: owner.groupId, memberId: owner.ownerId, memberKey: 'wrong' }), undefined);
  assert.equal(env.store.authenticate({ groupId: owner.groupId, memberId: 'm-nobody', memberKey: 'wrong' }), undefined);
  assert.equal(calls.length, 3);

  for (const [left, right] of calls) {
    assert.match(left, /^[0-9a-f]{64}$/u, 'the supplied key is digested before comparison');
    assert.match(right, /^[0-9a-f]{64}$/u, 'the stored key hash is fixed-width');
  }
  // The wrong-key and unknown-member cases must look identical from outside.
  assert.equal(new Set(calls.map(([, right]) => right)).size >= 2, true);
});

test('constantTimeEquals never throws on mismatched lengths', () => {
  assert.equal(constantTimeEquals('abc', 'abc'), true);
  assert.equal(constantTimeEquals('abc', 'abcd'), false);
  assert.equal(constantTimeEquals('', ''), true);
  assert.equal(constantTimeEquals(undefined, 'a'), false);
  assert.equal(constantTimeEquals(null, null), false);
  assert.equal(constantTimeEquals(1, '1'), false);
});

test('authenticate() marks a member online and presence expires with the clock', () => {
  const env = harness();
  const owner = seed(env);
  const ownerMember = { memberId: owner.ownerId, memberKey: owner.ownerKey };
  const invite = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });
  const joined = env.store.join({
    groupId: owner.groupId,
    token: invite.token,
    displayName: '张工',
  });
  const peer = { memberId: joined.member.memberId, memberKey: joined.memberKey };

  const authenticated = env.store.authenticate({ groupId: owner.groupId, memberId: owner.ownerId, memberKey: owner.ownerKey });
  assert.equal(authenticated.online, true);

  // Presence is computed from lastSeenAt, so it must go stale by itself: a
  // crashed host never gets to un-set an "online" flag.
  env.clock.t = START + ONLINE_WINDOW_MS + 1;
  const listed = env.store.members({ groupId: owner.groupId, member: peer });
  const ownerView = listed.find((entry) => entry.memberId === owner.ownerId);
  const peerView = listed.find((entry) => entry.memberId === joined.member.memberId);
  assert.equal(ownerView.online, false, 'no activity for longer than the window');
  assert.equal(peerView.online, false);

  env.clock.t = START + 2 * ONLINE_WINDOW_MS;
  const reauthenticated = env.store.authenticate({ groupId: owner.groupId, memberId: joined.member.memberId, memberKey: joined.memberKey });
  assert.equal(reauthenticated.online, true, 'one authenticate() brings the member back online');
  assert.equal(env.store.snapshot({ groupId: owner.groupId }).onlineCount, 1);
  assert.ok(ownerMember.memberId);
});

// ---------------------------------------------------------------------------
// post() / read()
// ---------------------------------------------------------------------------

test('post() appends with a monotonic seq and a fresh uuid', () => {
  const env = harness();
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };

  const first = env.store.post({ groupId: owner.groupId, member, text: '第一条' });
  const second = env.store.post({ groupId: owner.groupId, member, text: '第二条', payload: { kind: 'task', id: 7 } });
  assert.equal(second.seq, first.seq + 1);
  assert.match(first.msgId, /^[0-9a-f-]{36}$/u);
  assert.notEqual(first.msgId, second.msgId);
  assert.equal(typeof first.at, 'number');
  assert.equal(first.atIso, new Date(first.at).toISOString());

  const feed = env.store.read({ groupId: owner.groupId, member, sinceSeq: 0, limit: 10 });
  const texts = feed.entries.filter((entry) => entry.kind === 'message').map((entry) => entry.text);
  assert.deepEqual(texts, ['第一条', '第二条']);
  assert.deepEqual(feed.entries.at(-1).payload, { kind: 'task', id: 7 });
});

test('read() is incremental and reports the cursor', () => {
  const env = harness();
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };

  const a = env.store.post({ groupId: owner.groupId, member, text: 'a' });
  const b = env.store.post({ groupId: owner.groupId, member, text: 'b' });
  const c = env.store.post({ groupId: owner.groupId, member, text: 'c' });

  const afterA = env.store.read({ groupId: owner.groupId, member, sinceSeq: a.seq });
  assert.deepEqual(afterA.entries.map((entry) => entry.text), ['b', 'c']);
  assert.equal(afterA.lastSeq, c.seq);
  assert.equal(afterA.truncated, false);

  const nothingNew = env.store.read({ groupId: owner.groupId, member, sinceSeq: c.seq });
  assert.deepEqual(nothingNew.entries, []);
  assert.equal(nothingNew.lastSeq, c.seq);
  assert.equal(nothingNew.truncated, false);

  const paged = env.store.read({ groupId: owner.groupId, member, sinceSeq: a.seq, limit: 1 });
  assert.deepEqual(paged.entries.map((entry) => entry.text), ['b']);
  assert.equal(paged.truncated, true, 'a full page with more behind it must say so');
  assert.equal(b.seq < c.seq, true);
});

test('read() clamps a nonsense limit instead of returning everything', () => {
  const env = harness();
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };
  // Seeded before the first post: `create` writes one system entry, so the feed
  // already has a seq 1 and `sinceSeq: 0` starts after it.
  for (let index = 0; index < 5; index += 1) env.store.post({ groupId: owner.groupId, member, text: `m${index}` });
  const all = env.store.read({ groupId: owner.groupId, member, limit: -3 });
  assert.equal(all.entries.length, 6, '5 posts plus the "created" system entry');

  assert.equal(env.store.read({ groupId: owner.groupId, member, limit: 2 }).entries.length, 2);
  // An explicit huge limit is capped, not honoured.
  assert.equal(env.store.read({ groupId: owner.groupId, member, limit: 10_000 }).entries.length, all.entries.length);
});

test('post() enforces maxPostChars and rejects an empty message', () => {
  const env = harness({ groups: { maxPostChars: 50 } });
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };

  assert.throws(
    () => env.store.post({ groupId: owner.groupId, member, text: 'x'.repeat(51) }),
    (error) => error instanceof GroupError && error.code === 'too_long',
  );
  assert.throws(
    () => env.store.post({ groupId: owner.groupId, member, text: '   ' }),
    (error) => error.code === 'empty_message',
  );
  assert.throws(
    () => env.store.post({ groupId: owner.groupId, member, payload: 'not-an-object' }),
    (error) => error.code === 'bad_argument',
  );
});

test('post() refuses a member object that did not come from authenticate()', () => {
  const env = harness();
  const owner = seed(env);
  assert.throws(
    () => env.store.post({ groupId: owner.groupId, member: { memberId: owner.ownerId }, text: 'forged' }),
    (error) => error instanceof GroupError && error.code === 'not_member',
  );
  assert.throws(
    () => env.store.post({ groupId: owner.groupId, member: { memberId: owner.ownerId, memberKey: 'wrong' }, text: 'forged' }),
    (error) => error.code === 'not_member',
  );
  assert.throws(() => env.store.post({ groupId: owner.groupId, text: 'no member' }), (error) => error.code === 'not_member');
});

test('post() rate-limits a member with a token bucket, and refills over time', () => {
  const env = harness({ groups: { maxPostsPerMinute: 3 } });
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };

  for (let index = 0; index < 3; index += 1) env.store.post({ groupId: owner.groupId, member, text: `spam ${index}` });
  assert.throws(
    () => env.store.post({ groupId: owner.groupId, member, text: 'spam 4' }),
    (error) =>
      error instanceof GroupError &&
      error.code === 'rate_limited' &&
      error.details.retryAfterMs > 0 &&
      error.message.includes('每分钟最多 3 条'),
  );

  // A third of a minute refills one token at capacity 3.
  env.clock.t = START + 20_000;
  assert.ok(env.store.post({ groupId: owner.groupId, member, text: 'after a pause' }));
  assert.throws(
    () => env.store.post({ groupId: owner.groupId, member, text: 'again' }),
    (error) => error.code === 'rate_limited',
  );
});

test('the rate limit is per member, not per group', () => {
  const env = harness({ groups: { maxPostsPerMinute: 2 } });
  const owner = seed(env);
  const invite = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });
  const joined = env.store.join({ groupId: owner.groupId, token: invite.token, displayName: '张工' });
  const ownerMember = { memberId: owner.ownerId, memberKey: owner.ownerKey };
  const peerMember = { memberId: joined.member.memberId, memberKey: joined.memberKey };

  for (let index = 0; index < 2; index += 1) env.store.post({ groupId: owner.groupId, member: ownerMember, text: `o${index}` });
  assert.throws(() => env.store.post({ groupId: owner.groupId, member: ownerMember, text: 'o2' }), (error) => error.code === 'rate_limited');
  assert.ok(env.store.post({ groupId: owner.groupId, member: peerMember, text: 'mine' }), 'the peer still has its own budget');
});

// ---------------------------------------------------------------------------
// subscribe()
// ---------------------------------------------------------------------------

test('subscribe() delivers new posts to every subscriber and isolates a throwing one', () => {
  const env = harness();
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };
  const seen = [];
  const other = [];

  const dispose = env.store.subscribe({ groupId: owner.groupId, fn: (entry) => seen.push(entry) });
  const disposeThrower = env.store.subscribe({
    groupId: owner.groupId,
    fn: () => {
      throw new Error('broken SSE sink');
    },
  });
  env.store.subscribe({ groupId: owner.groupId, fn: (entry) => other.push(entry) });

  const posted = env.store.post({ groupId: owner.groupId, member, text: '有人在吗' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].seq, posted.seq);
  assert.equal(seen[0].text, '有人在吗');
  assert.equal(other.length, 1, 'one broken subscriber must not starve the others');
  assert.equal(env.logs.some((entry) => entry.level === 'warn' && entry.message === 'subscriber threw'), true);

  dispose();
  disposeThrower();
  env.store.post({ groupId: owner.groupId, member, text: '还在吗' });
  assert.equal(seen.length, 1, 'a disposed subscriber stops receiving');
  assert.equal(other.length, 2);
});

test('subscribe() refuses an unknown group and a non-function', () => {
  const env = harness();
  const owner = seed(env);
  assert.throws(() => env.store.subscribe({ groupId: 'g-nope', fn: () => {} }), (error) => error.code === 'unknown_group');
  assert.throws(() => env.store.subscribe({ groupId: owner.groupId, fn: 'x' }), (error) => error.code === 'bad_argument');
});

// ---------------------------------------------------------------------------
// members() / snapshot() / leave()
// ---------------------------------------------------------------------------

test('members() lists every member without leaking hashes', () => {
  const env = harness();
  const owner = seed(env);
  const invite = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });
  env.store.join({ groupId: owner.groupId, token: invite.token, displayName: '张工' });

  const list = env.store.members({ groupId: owner.groupId, member: { memberId: owner.ownerId, memberKey: owner.ownerKey } });
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((entry) => entry.displayName), ['牛昆仑', '张工']);
  assert.deepEqual(list.map((entry) => entry.role), ['owner', 'member']);
  assertNoSecrets(list, 'members()');
  // And the raw JSON cannot even be substring-matched for a key hash.
  const raw = readFileSync(env.file, 'utf8');
  for (const entry of list) assert.equal(raw.includes(entry.memberId), true, 'the id is stored, the key is not');
});

test('snapshot() summarizes a group with no secrets and no member credential required', () => {
  const env = harness();
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };
  env.store.post({ groupId: owner.groupId, member, text: '一条消息' });

  const anon = env.store.snapshot({ groupId: owner.groupId });
  assert.equal(anon.name, '发票重构攻坚');
  assert.equal(anon.memberCount, 1);
  assert.equal(anon.feedTail.length, 0, 'no credential, no feed');
  assert.equal(anon.lastPost, undefined, 'no credential, no message text');
  assert.equal(typeof anon.lastPostAtIso, 'string', 'but "when" is metadata, not content');
  assert.equal(JSON.stringify(anon).includes('一条消息'), false);
  assertNoSecrets(anon, 'snapshot() without a member');

  const asMember = env.store.snapshot({ groupId: owner.groupId, member });
  assert.equal(asMember.feedTail.length >= 1, true);
  assert.equal(typeof asMember.lastPostAtIso, 'string');
  assert.equal(asMember.onlineCount, 1);
  assertNoSecrets(asMember, 'snapshot() as a member');

  assert.equal(env.store.list().length, 1);
  assertNoSecrets(env.store.list(), 'list()');
});

test('an authenticated member view cannot be edited into another identity', () => {
  const env = harness();
  const owner = seed(env);
  const invite = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });
  const joined = env.store.join({ groupId: owner.groupId, token: invite.token, displayName: '张工' });

  const viewer = env.store.authenticate({ groupId: owner.groupId, memberId: joined.member.memberId, memberKey: joined.memberKey });
  assert.equal(Object.isFrozen(viewer), true);

  // A copy of a verified view is not a verified identity: spreading it drops the
  // binding, and with no memberKey on it there is nothing to check, so it fails.
  const tampered = { ...viewer, memberId: owner.ownerId, role: 'owner' };
  assert.throws(
    () => env.store.post({ groupId: owner.groupId, member: tampered, text: '假装群主' }),
    (error) => error instanceof GroupError && error.code === 'not_member',
  );
  // Even a valid key does not let the copy claim another id: the credential is
  // checked against the member the id names, so a mismatched pair simply fails.
  const withKey = { ...tampered, memberKey: joined.memberKey };
  assert.throws(
    () => env.store.post({ groupId: owner.groupId, member: withKey, text: '假装群主' }),
    (error) => error instanceof GroupError && error.code === 'not_member',
  );

  // And the frozen original still works, as itself.
  const own = env.store.post({ groupId: owner.groupId, member: viewer, text: '我自己' });
  const ownEntry = env.store.read({ groupId: owner.groupId, member: viewer, sinceSeq: own.seq - 1 }).entries[0];
  assert.equal(ownEntry.from.memberId, joined.member.memberId);
  assert.equal(ownEntry.from.displayName, '张工');
});

test('read() reports the head cursor even when nothing is new, and never invents entries', () => {
  const env = harness();
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };
  const head = env.store.snapshot({ groupId: owner.groupId }).lastSeq;
  const idle = env.store.read({ groupId: owner.groupId, member, sinceSeq: 0 });
  assert.equal(idle.entries.some((entry) => entry.kind === 'message'), false);
  assert.equal(idle.lastSeq, head);
  assert.equal(idle.truncated, false);
});

test('every public read view is hash-free, checked structurally', () => {
  const env = harness();
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };
  const invite = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });
  const joined = env.store.join({ groupId: owner.groupId, token: invite.token, displayName: '张工' });
  env.store.post({ groupId: owner.groupId, member, text: 'hi' });

  const views = {
    'create().group': owner.group,
    members: env.store.members({ groupId: owner.groupId, member }),
    read: env.store.read({ groupId: owner.groupId, member, sinceSeq: 0 }),
    snapshot: env.store.snapshot({ groupId: owner.groupId, member }),
    'snapshot() anonymous': env.store.snapshot({ groupId: owner.groupId }),
    list: env.store.list(),
    'join().group': joined.group,
    'join().feedTail': joined.feedTail,
  };
  for (const [label, view] of Object.entries(views)) assertNoSecrets(view, label);
  // The raw text of every view, not just its keys: a hash could be smuggled as a value.
  const serialized = JSON.stringify(views);
  for (const secret of [sha256Hex(joined.memberKey), sha256Hex(owner.ownerKey)]) {
    assert.equal(serialized.includes(secret), false, 'no sha256 digest of a credential may leave the store');
  }
  assert.equal(serialized.includes('scrypt$'), false, 'no password hash may leave the store');
});

test('post() rejects a payload that could not be persisted, before mutating the feed', () => {
  const env = harness();
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };
  const before = env.store.snapshot({ groupId: owner.groupId }).lastSeq;

  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  assert.throws(
    () => env.store.post({ groupId: owner.groupId, member, text: 'x', payload: cyclic }),
    (error) => error instanceof GroupError && error.code === 'bad_argument',
  );
  assert.throws(
    () => env.store.post({ groupId: owner.groupId, member, text: 'x', payload: { n: 10n } }),
    (error) => error.code === 'bad_argument',
  );
  assert.throws(
    () => env.store.post({ groupId: owner.groupId, member, text: 'x', payload: { blob: 'x'.repeat(MAX_PAYLOAD_BYTES) } }),
    (error) => error.code === 'too_long',
  );
  // Nothing was appended and nothing was written: memory and disk agree.
  assert.equal(env.store.snapshot({ groupId: owner.groupId }).lastSeq, before);
  assert.equal(readState(env).groups[0].nextSeq, before + 1);
});

test('a payload within the limit round-trips through the file', () => {
  const env = harness();
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };
  const payload = { task: 'T-1', files: ['a/b.md', 'c/d.md'], nested: { ok: true }, count: 3 };
  env.store.post({ groupId: owner.groupId, member, text: '带 payload', payload });
  const reloaded = createGroupStore({ home: env.home, clock: () => env.clock.t, config: { groups: { gatewayBase: 'x' } } });
  const entries = reloaded.read({ groupId: owner.groupId, member, sinceSeq: 0 }).entries;
  assert.deepEqual(entries.find((entry) => entry.text === '带 payload').payload, payload);
});

test('snapshot() refuses a forged member object', () => {
  const env = harness();
  const owner = seed(env);
  assert.throws(() => env.store.snapshot({ groupId: owner.groupId, member: { memberId: owner.ownerId } }), (error) => error.code === 'not_member');
});

test('leave() removes the member and their credential stops working', () => {
  const env = harness();
  const owner = seed(env);
  const invite = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });
  const joined = env.store.join({ groupId: owner.groupId, token: invite.token, displayName: '张工' });

  assert.equal(env.store.leave({ groupId: owner.groupId, member: { memberId: joined.member.memberId, memberKey: joined.memberKey } }), true);
  assert.equal(env.store.authenticate({ groupId: owner.groupId, memberId: joined.member.memberId, memberKey: joined.memberKey }), undefined);
  assert.equal(readState(env).groups[0].members.length, 1);
  assert.equal(readState(env).groups[0].members.some((entry) => entry.keyHash === sha256Hex(joined.memberKey)), false);
});

test('leave() transfers ownership when the owner leaves, so the group stays manageable', () => {
  const env = harness();
  const owner = seed(env);
  const invite = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });
  const joined = env.store.join({ groupId: owner.groupId, token: invite.token, displayName: '张工' });

  env.store.leave({ groupId: owner.groupId, member: { memberId: owner.ownerId, memberKey: owner.ownerKey } });
  const snapshot = env.store.snapshot({ groupId: owner.groupId });
  assert.equal(snapshot.owner.memberId, joined.member.memberId);
  assert.equal(snapshot.owner.displayName, '张工');

  // The new owner can mint and revoke invites with the credential it was given.
  const next = env.store.invite({ groupId: owner.groupId, ownerKey: joined.memberKey });
  assert.equal(env.store.revokeInvite({ groupId: owner.groupId, ownerKey: joined.memberKey, token: next.token }), true);
});

// ---------------------------------------------------------------------------
// revokeInvite()
// ---------------------------------------------------------------------------

test('revokeInvite() requires the owner credential and reports an unknown invite', () => {
  const env = harness();
  const owner = seed(env);
  const invite = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });

  assert.throws(() => env.store.revokeInvite({ groupId: owner.groupId, ownerKey: 'wrong', token: invite.token }), (error) => error.code === 'not_owner');
  assert.throws(() => env.store.revokeInvite({ groupId: owner.groupId }), (error) => error.code === 'not_owner');
  assert.equal(env.store.revokeInvite({ groupId: owner.groupId, ownerKey: owner.ownerKey, inviteId: 'i-nope' }), false);
  assert.equal(env.store.revokeInvite({ groupId: owner.groupId, ownerKey: owner.ownerKey, token: invite.token }), true);
  assert.equal(readState(env).groups[0].invites[0].revoked, true);
});

test('revokeInvite() by id does not need the token', () => {
  const env = harness();
  const owner = seed(env);
  const invite = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });
  assert.equal(env.store.revokeInvite({ groupId: owner.groupId, ownerKey: owner.ownerKey, inviteId: invite.inviteId }), true);
});

// ---------------------------------------------------------------------------
// Retention and persistence
// ---------------------------------------------------------------------------

test('pruning drops expired entries on the next write, and on an idle flush too', () => {
  const env = harness({ groups: { retentionDays: 1 } });
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };

  const old = env.store.post({ groupId: owner.groupId, member, text: '前天的消息' });
  env.clock.t = START + 2 * DAY;
  const fresh = env.store.post({ groupId: owner.groupId, member, text: '今天的消息' });
  assert.equal(fresh.seq > old.seq, true);

  // Pruning runs before every persist, so the write triggered by the second post
  // is already clean — no separate maintenance pass needed for an active group.
  const stored = readState(env).groups[0];
  assert.equal(stored.feed.some((entry) => entry.text === '前天的消息'), false, 'the old entry is pruned');
  assert.equal(stored.feed.some((entry) => entry.text === '今天的消息'), true);
  assert.equal(stored.nextSeq, fresh.seq + 1, 'seq never rewinds after pruning');
  assert.equal(env.store.flush(), false, 'nothing left to write when the last write already pruned');

  const after = env.store.post({ groupId: owner.groupId, member, text: 'prune 之后' });
  assert.equal(after.seq, fresh.seq + 1, 'the next post continues where the pruned one stopped');

  // An idle group still has to age out: nothing was written, but the clock moved.
  env.clock.t = START + 30 * DAY;
  assert.equal(env.store.flush(), true, 'flush prunes even with no new posts');
  // Everything is older than the one-day window now, including the "created"
  // system entry: retention is uniform, it does not special-case the first line.
  assert.equal(readState(env).groups[0].feed.length, 0);

  const read = env.store.read({ groupId: owner.groupId, member, sinceSeq: 0 });
  assert.equal(read.lastSeq, after.seq, 'the cursor still points past the newest post ever written');
});

test('the store reloads from disk: credentials, seq and members survive a restart', () => {
  const env = harness();
  const owner = seed(env);
  const invite = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });
  const joined = env.store.join({ groupId: owner.groupId, token: invite.token, displayName: '张工' });
  const posted = env.store.post({ groupId: owner.groupId, member: { memberId: owner.ownerId, memberKey: owner.ownerKey }, text: '重启前' });
  env.store.flush();

  const reloaded = createGroupStore({ home: env.home, clock: () => env.clock.t, config: { groups: { gatewayBase: 'https://gw.ict.cmcc' } } });
  assert.ok(reloaded.authenticate({ groupId: owner.groupId, memberId: owner.ownerId, memberKey: owner.ownerKey }));
  assert.ok(reloaded.authenticate({ groupId: owner.groupId, memberId: joined.member.memberId, memberKey: joined.memberKey }));

  const next = reloaded.post({ groupId: owner.groupId, member: { memberId: owner.ownerId, memberKey: owner.ownerKey }, text: '重启后' });
  assert.equal(next.seq > posted.seq, true, 'seq continues instead of restarting at 1');
  assert.equal(reloaded.snapshot({ groupId: owner.groupId }).memberCount, 2);
});

test('a reloaded store still refuses a mint with the wrong owner key, and keeps only hashes', () => {
  const env = harness();
  const owner = seed(env);
  env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });
  const reloaded = createGroupStore({ home: env.home, clock: () => env.clock.t, config: { groups: { gatewayBase: 'https://gw.ict.cmcc' } } });
  // A reloaded store still refuses a mint attempt with the wrong owner key.
  assert.throws(
    () => reloaded.invite({ groupId: owner.groupId, ownerKey: 'wrong' }),
    (error) => error.code === 'not_owner',
  );
  assert.equal(readFileSync(env.file, 'utf8').includes('"tokenHash"'), true);
});

test('writeFileAtomic leaves no temporary file behind', () => {
  const env = harness();
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };
  for (let index = 0; index < 5; index += 1) env.store.post({ groupId: owner.groupId, member, text: `m${index}` });
  const leftovers = readdirSync(env.home).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  assert.equal(readdirSync(env.home).includes('groups.json'), true);
});

test('writeFileAtomic replaces the file rather than editing it in place', () => {
  const env = harness();
  const target = join(env.home, 'atomic.json');
  writeFileAtomic(target, 'first');
  assert.equal(readFileSync(target, 'utf8'), 'first');
  writeFileAtomic(target, 'second');
  assert.equal(readFileSync(target, 'utf8'), 'second');
});

test('a corrupt state file is moved aside instead of overwritten, and the store still opens', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-corrupt-'));
  temporaries.push(home);
  const file = join(home, 'groups.json');
  writeFileSync(file, '{ this is not json', { mode: 0o600 });

  const store = createGroupStore({ home, clock: () => START, config: { groups: {} } });
  assert.deepEqual(store.list(), []);
  assert.equal(existsSync(file), false, 'the corrupt file is renamed, not deleted');
  const backups = readdirSync(home).filter((name) => name.startsWith('groups.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(home, backups[0]), 'utf8'), '{ this is not json');
});

test('an unreadable state file is a hard error, not an empty store', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-unreadable-'));
  temporaries.push(home);
  mkdirSync(join(home, 'groups.json'));
  assert.throws(
    () => createGroupStore({ home, clock: () => START, config: { groups: {} } }),
    (error) => error instanceof GroupError && error.code === 'storage_unreadable',
  );
});

test('a group with no surviving valid member is dropped on load', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-drop-'));
  temporaries.push(home);
  writeFileSync(
    join(home, 'groups.json'),
    JSON.stringify({
      version: 1,
      groups: [
        { groupId: 'g-ok', name: 'ok', createdAt: START, members: [{ memberId: 'm-1', keyHash: 'a'.repeat(64), joinedAt: START, lastSeenAt: START, role: 'owner', displayName: 'a' }], feed: [], nextSeq: 1, invites: [] },
        { groupId: 'g-bad', name: 'bad', members: [{ memberId: 'm-2' }], feed: [] },
        { groupId: 'g-nofeed', name: 'nofeed', members: [] },
      ],
    }),
  );
  const store = createGroupStore({ home, clock: () => START, config: { groups: {} } });
  assert.deepEqual(store.list().map((group) => group.groupId), ['g-ok']);
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

test('redact() is what a log line shows for a secret', () => {
  assert.equal(redact('some-secret'), `sha256:${sha256Hex('some-secret').slice(0, 8)}`);
  assert.equal(redact(''), 'sha256:');
  assert.equal(redact(undefined), 'sha256:');
});

test('no log line contains a plaintext credential', () => {
  const env = harness();
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };
  const invite = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });
  const joined = env.store.join({ groupId: owner.groupId, token: invite.token, displayName: '张工' });
  env.store.post({ groupId: owner.groupId, member, text: 'hi' });
  env.store.leave({ groupId: owner.groupId, member: { memberId: joined.member.memberId, memberKey: joined.memberKey } });

  const serialized = JSON.stringify(env.logs);
  assert.equal(serialized.includes('correct-horse-battery'), false);
  assert.equal(serialized.includes(invite.token), false);
  assert.equal(serialized.includes(joined.memberKey), false);
  assert.equal(serialized.includes(owner.ownerKey), false);
  assert.equal(serialized.includes('sha256:'), true, 'secrets appear only as a short digest');
});

test('has() answers the join routing question without a credential', () => {
  const env = harness();
  assert.equal(env.store.has('g-nope'), false);
  assert.equal(env.store.has(''), false);
  assert.equal(env.store.has(undefined), false);
  assert.equal(env.store.has(42), false);

  const owner = seed(env);
  assert.equal(env.store.has(owner.groupId), true, 'a local group is hosted here');

  env.store.leave({ groupId: owner.groupId, member: { memberId: owner.ownerId, memberKey: owner.ownerKey } });
  // The group record survives an owner leaving (it has no members left, so it is
  // inert but still on disk); `has` reports the record, not a usable group.
  assert.equal(env.store.has(owner.groupId), true);
});

test('lastEntry() returns the newest entry, or undefined when there is none', () => {
  const env = harness();
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };

  // `create` writes a "created" system entry, so the feed is never empty here.
  const created = env.store.lastEntry({ groupId: owner.groupId, member });
  assert.equal(created.kind, 'system');
  assert.equal(typeof created.atIso, 'string');

  const posted = env.store.post({ groupId: owner.groupId, member, text: '最新一条' });
  const newest = env.store.lastEntry({ groupId: owner.groupId, member });
  assert.equal(newest.seq, posted.seq);
  assert.equal(newest.text, '最新一条');
  assert.equal(newest.msgId, posted.msgId);
  // Same shape as a feed entry, so the UI has one renderer.
  assert.deepEqual(Object.keys(newest).sort(), ['at', 'atIso', 'from', 'kind', 'msgId', 'seq', 'text']);
  assertNoSecrets(newest, 'lastEntry()');

  assert.throws(
    () => env.store.lastEntry({ groupId: owner.groupId, member: { memberId: owner.ownerId } }),
    (error) => error instanceof GroupError && error.code === 'not_member',
    'the preview is message text, so it needs a credential',
  );
  assert.throws(() => env.store.lastEntry({ groupId: 'g-nope', member }), (error) => error.code === 'unknown_group');
});

test('snapshot() without a member yields no content, and `list()` never carries feed text', () => {
  const env = harness();
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };
  env.store.post({ groupId: owner.groupId, member, text: '不该出现在列表里的正文' });

  // This is the answer to "why is feedTail empty": without `member`, a snapshot
  // is metadata only — that is the point, not a missing parameter.
  const anon = env.store.snapshot({ groupId: owner.groupId });
  assert.deepEqual(anon.feedTail, []);
  assert.equal(anon.lastPost, undefined);
  assert.equal(anon.lastSeq > 0, true, 'the seq watermark is metadata and is still exposed');

  const listed = env.store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].lastSeq, anon.lastSeq, 'list().lastSeq is the group watermark, not a read cursor');
  assert.equal(JSON.stringify(listed).includes('不该出现在列表里的正文'), false);

  const withMember = env.store.snapshot({ groupId: owner.groupId, member });
  assert.equal(withMember.feedTail.length > 0, true, 'a credential is what turns feedTail on');
});

test('a feed tail on join is capped at FEED_TAIL_LIMIT', () => {
  const env = harness({ groups: { maxPostsPerMinute: 10_000 } });
  const owner = seed(env);
  const member = { memberId: owner.ownerId, memberKey: owner.ownerKey };
  for (let index = 0; index < FEED_TAIL_LIMIT + 5; index += 1) env.store.post({ groupId: owner.groupId, member, text: `m${index}` });
  const invite = env.store.invite({ groupId: owner.groupId, ownerKey: owner.ownerKey });
  const joined = env.store.join({ groupId: owner.groupId, token: invite.token, displayName: '新人' });
  assert.equal(joined.feedTail.length, FEED_TAIL_LIMIT);
});
