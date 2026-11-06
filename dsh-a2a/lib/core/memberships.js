/**
 * The membership ledger: which SESSIONS of this instance belong to which groups.
 *
 * The unit of membership is a **Session**, not the instance. That distinction is
 * the whole reason this file exists in its current shape:
 *
 *   - one person runs several Sessions on one machine (workspaces, or several
 *     conversations in one workspace), and each may take part in a different group;
 *   - a group post must land in the Session that belongs to that group, not in
 *     whichever Session happened to call first;
 *   - the same group can legitimately be joined TWICE on one machine — a person
 *     responsible for two modules of one project is two members in that project's
 *     group, with two credentials and two unread cursors.
 *
 * So the key is `(sessionId, groupId)`. Keying on `groupId` alone was the earlier
 * design and it made every group belong to the whole instance, which is not how
 * people work.
 *
 * Why the credential lives here rather than in `groups.js`: a member credential is
 * handed out **exactly once** (by `create`/`join`/`claim`), and the store never
 * returns it again — the right design for a secret, but it means the caller has to
 * keep it. This ledger is that caller. It is also where the per-membership read
 * watermark lives, because "I am member X in group Y and have read up to N" is one
 * fact about one membership.
 *
 * Threat model, stated plainly: `personKey` is cleartext in a 0600 file. It has to
 * be — the plugin must present it on every call, so any local encryption would need
 * its key stored on the same machine, which protects nothing against the threat
 * that matters (another process on this machine). 0600 does protect against other
 * users of a shared box. Hashing locally, as the group host does, is impossible for
 * the same reason the host can hash: the host only verifies, while we must present.
 *
 * @module dsh-a2a/memberships
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** File name inside the plugin's home directory. */
const FILE_NAME = 'memberships.json';

/**
 * The `sessionId` used by a HOST that holds a group on behalf of others.
 *
 * A pure group host runs no model and therefore has no Session to deliver into. It
 * still needs a membership record — that record is what carries the owner
 * credential and the read watermark — so it is filed under this reserved id.
 *
 * Consequences, which are exactly what a host wants:
 *
 *   - nothing is ever delivered to it (there is no Session to deliver to);
 *   - a host and a real Session cannot collide, because a real Session id is a
 *     uuid-shaped string and this is a fixed sentinel;
 *   - a member instance never uses it, because its memberships are created from a
 *     tool call that has a Session.
 */
export const HOST_SESSION_ID = 'host';

/** Upper bound on remembered memberships, so a runaway join loop cannot grow the file. */
/**
 * How old a cached roster may be before the panel must stop presenting it as fact.
 *
 * A roster is fetched once and never refreshed on its own, so without a bound the panel would show a member list and
 * a count that could be weeks old — as confidently as a fresh one. Ten minutes is chosen to be longer than a person
 * takes to read the panel and shorter than a working session, so the common case shows live data and the rare case
 * admits it is stale.
 */
//
// Thirty seconds, not ten minutes. The number decides how long the panel is allowed to present cached names and a
// cached member count as current. Ten minutes was chosen to be "longer than reading the panel" — but a group is
// exactly the place where somebody joins or is removed while you are looking at it, and waiting ten minutes to
// admit that is not caution, it is a stale screen. Thirty seconds is long enough that the notice does not flicker
// on every render, and short enough that a refresh feels responsive.
export const ROSTER_STALE_MS = 30 * 1000;

const MAX_MEMBERSHIPS = 500;

/** Stable key for one (session, group) pair. `\u0000` cannot appear in either id. */
function keyOf(sessionId, groupId) {
  return `${sessionId}\u0000${groupId}`;
}

/**
 * One membership record: what this instance knows about a Session in a group.
 *
 * Every field here is written by `upsert` and read by the panel, so this type is
 * the ledger's contract rather than a description of one call site. `personKey`
 * is the member credential and never leaves the process; the rest is either
 * addresses for A2A calls or cached facts for a panel that cannot make them.
 *
 * @typedef {object} MembershipRecord
 * @property {string} sessionId - the Session this membership belongs to.
 * @property {string} groupId - the group, as its host named it.
 * @property {string} [personId] - this person's id inside that group.
 * @property {string} [personKey] - member credential; plaintext, never published.
 * @property {string} [baseUrl] - host endpoint, for a remote group.
 * @property {boolean} [local] - true when this instance hosts the group.
 * @property {string} [groupName] - cached name, for a panel rendered offline.
 * @property {string} [role] - `owner` or `member`, as the host reported it.
 * @property {number} [lastSeq] - read watermark, for the unread count.
 * @property {number} [touchedAt] - epoch ms of the last write.
 * @property {object[]} [members] - cached roster, newest first.
 * @property {number} [rosterCachedAt] - epoch ms the roster was cached.
 * @property {object[]} [feed] - cached feed tail for a local group.
 * @property {string} [groupTopic]
 * @property {number} [memberCount]
 * @property {number} [onlineCount]
 * @property {number} [lastTime]
 * @property {boolean} [isOwner]
 */

/**
 * The filter `list()` accepts. Both fields are optional and combine.
 *
 * @typedef {object} MembershipFilter
 * @property {string} [sessionId]
 * @property {string} [groupId]
 */
/**
 * Build the ledger.
 *
 * @param {object} options - construction options.
 * @param {string} [options.home] - plugin home directory (`<DSH_HOME>/a2a`).
 * @param {object} [options.logger] - host logger.
 * @param {Function} [options.clock] - epoch-millisecond clock.
 * @returns {object} the ledger.
 */
export function createMembershipLedger({ home, logger, clock = () => Date.now() } = {}) {
  if (typeof home !== 'string' || home === '') throw new Error('dsh-a2a: the membership ledger needs a home directory');
  const file = join(home, FILE_NAME);
  /** `${sessionId}\u0000${groupId}` → record */
  const records = load();

  /**
   * Every membership, most recently touched first.
   *
   * Returned as copies: a caller must not be able to change a credential by
   * assigning to a field of a view it was handed.
   *
   * @param {MembershipFilter} [filter] - one field, the other, or both.
   * @returns {MembershipRecord[]} matching records.
   */
  function list(filter = {}) {
    const wantSession = typeof filter.sessionId === 'string' ? filter.sessionId : undefined;
    const wantGroup = typeof filter.groupId === 'string' ? filter.groupId : undefined;
    return [...records.values()]
      .filter((record) => (wantSession === undefined || record.sessionId === wantSession)
        && (wantGroup === undefined || record.groupId === wantGroup))
      .sort((left, right) => (right.touchedAt ?? 0) - (left.touchedAt ?? 0))
      .map((record) => ({ ...record }));
  }

  /**
   * One membership.
   *
   * `get(groupId)` (one argument) is the "any session" form, kept for the paths that
   * only need to know that SOME session on this instance belongs to the group —
   * `a2a_groups` and the inbox's own routing both start from a record they already
   * have, so they always pass the session. Passing it is strongly preferred: with
   * one argument the answer depends on iteration order when two Sessions joined the
   * same group, which is exactly the ambiguity the key was designed to remove.
   *
   * @param {string} groupId - group id.
   * @param {string} [sessionId] - the Session; omit only for an existence check.
   * @returns {object|undefined} the record.
   */
  function get(groupId, sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') {
      const record = records.get(keyOf(sessionId, groupId));
      return record === undefined ? undefined : { ...record };
    }
    const candidates = list({ groupId });
    return candidates.length === 0 ? undefined : candidates[0];
  }

  /** Whether this instance is a member of the group at all, from any Session. */
  function has(groupId) {
    return list({ groupId }).length > 0;
  }

  /** Every membership of one Session. */
  function membershipsOf(sessionId) {
    return list({ sessionId });
  }

  /** Groups this instance hosts itself (a hosted group is joined locally). */
  function localMemberships() {
    return list().filter((record) => record.local === true);
  }

  /** Memberships that need a subscription: the group lives somewhere else. */
  function remoteMemberships() {
    return list().filter((record) => record.local !== true);
  }

  /**
   * Insert or update one membership.
   *
   * A partial update is supported on purpose: the inbox updates `lastSeq` on every
   * post, and asking it to re-supply the credential each time would mean the
   * credential travels through one more function than it has to.
   *
   * `sessionId` is required — it is the first half of the key. A caller with no
   * Session (a pure group host, which runs no model) passes {@link HOST_SESSION_ID}.
   * Accepting a missing id instead would create a membership that can never be
   * delivered to and can collide with another such record.
   *
   * @param {object} input - `{sessionId, groupId, personId, personKey, baseUrl, local, groupName, role, lastSeq}`.
   * @returns {object} the stored record.
   */
  function upsert(input = {}) {
    const groupId = typeof input.groupId === 'string' ? input.groupId : '';
    if (groupId === '') throw new Error('dsh-a2a: a membership needs a groupId');
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
    if (sessionId === '') {
      throw new Error(`dsh-a2a: a membership needs a sessionId (use "${HOST_SESSION_ID}" for a host that has no Session)`);
    }
    const key = keyOf(sessionId, groupId);
    const previous = records.get(key) ?? {};
    const record = {
      sessionId,
      groupId,
      personId: input.personId ?? previous.personId,
      personKey: input.personKey ?? previous.personKey,
      // `local` means the group is hosted by this very instance, so a call never
      // leaves the process. Kept on the record because the answer decides the code
      // path (a local call has no gateway and no network failure mode).
      local: typeof input.local === 'boolean' ? input.local : previous.local === true,
      baseUrl: input.baseUrl ?? previous.baseUrl,
      groupName: input.groupName ?? previous.groupName,
      role: input.role ?? previous.role ?? 'member',
      lastSeq: typeof input.lastSeq === 'number' ? input.lastSeq : previous.lastSeq ?? 0,
      // A cached view of the group, filled by `a2a_group_summary`. Kept on the record
      // because the panel renders from this ledger, not from the network: without it a
      // remote group shows an id and "0 人", which reads as an empty group rather than
      // one that has simply not been fetched yet.
      groupTopic: input.groupTopic ?? previous.groupTopic,
      memberCount: typeof input.memberCount === 'number' ? input.memberCount : previous.memberCount,
      onlineCount: typeof input.onlineCount === 'number' ? input.onlineCount : previous.onlineCount,
      lastTime: typeof input.lastTime === 'number' ? input.lastTime : previous.lastTime,
      isOwner: typeof input.isOwner === 'boolean' ? input.isOwner : previous.isOwner,
      feed: Array.isArray(input.feed) ? input.feed : previous.feed,
      // The roster a Session fetched with a member credential. Cached so the panel can
      // draw people without a network call, and stamped so a stale list is visibly stale.
      members: Array.isArray(input.members) ? input.members : previous.members,
      rosterCachedAt: typeof input.rosterCachedAt === 'number' ? input.rosterCachedAt : previous.rosterCachedAt,
      // Set when the host answered as if this membership did not exist. NOT a deletion: the credential lives
      // only here, so dropping the row would make the group unreachable forever. Cleared by the next success.
      unreachableAt: typeof input.unreachableAt === 'number'
        ? input.unreachableAt
        : (input.reachable === true ? undefined : previous.unreachableAt),
      // The intent to leave, recorded when the host could not be told. Kept rather than acted on locally: the
      // remote row still exists, and only a successful call can withdraw it. Cleared on the next success.
      leavingAt: typeof input.leavingAt === 'number'
        ? input.leavingAt
        : (input.leaveCompleted === true ? undefined : previous.leavingAt),
      addedAt: previous.addedAt ?? clock(),
      touchedAt: clock(),
    };
    records.set(key, record);
    // Bound the file: an instance that joins hundreds of groups has a bug, and a
    // silently unbounded state file is worse than forgetting an ancient one.
    if (records.size > MAX_MEMBERSHIPS) {
      const oldest = [...records.values()].sort((left, right) => left.touchedAt - right.touchedAt);
      for (const stale of oldest.slice(0, records.size - MAX_MEMBERSHIPS)) {
        records.delete(keyOf(stale.sessionId, stale.groupId));
      }
    }
    persist();
    return { ...record };
  }

  /**
   * Forget one membership, or every membership of one Session.
   *
   * The Session-wide form is what the caller uses when a Session is archived or
   * deleted: its memberships are still in the groups, but nothing here could ever
   * deliver to it again, so keeping the credentials would be a leak with no use.
   *
   * @param {object} where - `{groupId, sessionId?}` or `{sessionId}`.
   * @returns {number} how many records were removed.
   */
  function remove(where = {}) {
    const wantGroup = typeof where.groupId === 'string' ? where.groupId : undefined;
    const wantSession = typeof where.sessionId === 'string' ? where.sessionId : undefined;
    if (wantGroup === undefined && wantSession === undefined) return 0;
    let removed = 0;
    for (const record of [...records.values()]) {
      if (wantGroup !== undefined && record.groupId !== wantGroup) continue;
      if (wantSession !== undefined && record.sessionId !== wantSession) continue;
      records.delete(keyOf(record.sessionId, record.groupId));
      removed += 1;
    }
    if (removed > 0) persist();
    return removed;
  }

  /** Write the file now. Never throws: a ledger that cannot be written still works in memory. */
  function flush() {
    persist();
  }

  function persist() {
    const payload = JSON.stringify({
      version: 2,
      savedAt: new Date(clock()).toISOString(),
      memberships: [...records.values()],
    }, null, 2);
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      // Write beside the target and rename: a crash mid-write must not leave a
      // half-file that reads as "this instance has no groups".
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, file);
      try {
        chmodSync(file, 0o600);
      } catch {
        // Windows ignores POSIX modes; the rename above is what matters there.
      }
    } catch (error) {
      logger?.warn?.(`a2a: could not persist memberships (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  function load() {
    const map = new Map();
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return map;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger?.warn?.('a2a: memberships.json is not valid JSON; starting with no memberships (the file is left in place)');
      return map;
    }
    // Version 1 records had no `sessionId` (membership was instance-wide). They are
    // dropped rather than guessed at: there is no correct Session to attach them to,
    // and a wrong guess would deliver somebody else's group posts into this one.
    if (parsed?.version !== 2) {
      logger?.info?.('a2a: memberships.json is from an older version and had instance-wide memberships; starting fresh (re-join your groups)');
      return map;
    }
    const entries = Array.isArray(parsed?.memberships) ? parsed.memberships : [];
    for (const entry of entries) {
      if (typeof entry?.groupId !== 'string' || entry.groupId === '') continue;
      if (typeof entry?.sessionId !== 'string' || entry.sessionId === '') continue;
      map.set(keyOf(entry.sessionId, entry.groupId), {
        sessionId: entry.sessionId,
        groupId: entry.groupId,
        personId: typeof entry.personId === 'string' ? entry.personId : undefined,
        personKey: typeof entry.personKey === 'string' ? entry.personKey : undefined,
        local: entry.local === true,
        baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : undefined,
        groupName: typeof entry.groupName === 'string' ? entry.groupName : undefined,
        role: typeof entry.role === 'string' ? entry.role : 'member',
        lastSeq: Number.isFinite(entry.lastSeq) ? entry.lastSeq : 0,
        // Cached group view (see `upsert`): restored so a restart does not blank the
        // panel back to ids and zeros.
        groupTopic: typeof entry.groupTopic === 'string' ? entry.groupTopic : undefined,
        memberCount: Number.isFinite(entry.memberCount) ? entry.memberCount : undefined,
        onlineCount: Number.isFinite(entry.onlineCount) ? entry.onlineCount : undefined,
        lastTime: Number.isFinite(entry.lastTime) ? entry.lastTime : undefined,
        isOwner: typeof entry.isOwner === 'boolean' ? entry.isOwner : undefined,
        feed: Array.isArray(entry.feed) ? entry.feed : undefined,
        members: Array.isArray(entry.members) ? entry.members : undefined,
        rosterCachedAt: Number.isFinite(entry.rosterCachedAt) ? entry.rosterCachedAt : undefined,
        addedAt: Number.isFinite(entry.addedAt) ? entry.addedAt : 0,
        // A stamp that only lived in memory would be lost on restart — exactly when a host is most likely to
        // come back with its real data, which is when recovery has to work.
        unreachableAt: Number.isFinite(entry.unreachableAt) ? entry.unreachableAt : undefined,
        leavingAt: Number.isFinite(entry.leavingAt) ? entry.leavingAt : undefined,
        touchedAt: Number.isFinite(entry.touchedAt) ? entry.touchedAt : 0,
      });
    }
    return map;
  }

  return {
    list,
    get,
    has,
    membershipsOf,
    localMemberships,
    remoteMemberships,
    upsert,
    remove,
    flush,
    /** The file this ledger lives in, for diagnostics. */
    path: () => file,
  };
}