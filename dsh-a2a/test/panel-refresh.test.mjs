/**
 * A stale roster must be fixable from the panel, not from a different tool.
 *
 * THE INTERACTION
 *
 * The panel used to say 「名单来自缓存，可能已变化。在会话里查一次群成员即可刷新。」 — it announced the data was old and
 * then sent the reader out of the interface to fix it. That is homework, and it assumes they know what a tool call is.
 *
 * TWO HALVES, BOTH REQUIRED
 *
 *   server   a `refresh` panel endpoint that re-reads one group and writes the cache, because the credential lives
 *            here and the page holds none on purpose
 *   panel    auto-refresh when the group opens already-stale, a button for everything else, and a visible note saying
 *            what happened
 *
 * The signature matters more than it looks: without roster fields in it, a successful refresh produces an identical
 * change signature and the panel simply does not re-render. The refresh would work and the screen would not move.
 *
 * @module dsh-a2a/test/panel-refresh
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';

const CLIENT = readFileSync('client.js', 'utf8');
const HOST = readFileSync('lib/index.js', 'utf8');

test('the host exposes a refresh endpoint', () => {
  // The credential lives on the server; the browser has none, so the refresh has to happen there.
  assert.match(HOST, /const refreshGroupRoster = async/u);
  assert.match(HOST, /name === 'refresh'/u, 'the endpoint must be routed');
});

test('refresh re-reads the group and writes the cache back', () => {
  // The whole point is that the cache changes, or the next page load shows the same stale roster.
  const body = HOST.slice(HOST.indexOf('const refreshGroupRoster'));
  assert.match(body, /identities\.upsert\(/u, 'the refreshed roster must be persisted');
  assert.match(body, /rosterCachedAt: clock\(\)/u, 'writing it back without a new timestamp would stay stale');
});

test('refresh keeps the timestamp and drops the claim about now', () => {
  const body = HOST.slice(HOST.indexOf('const refreshGroupRoster'), HOST.indexOf('const disposePanelRpc'));
  // Same rule as a2a_group_info: `lastSeenAt` is a fact, `online` is an inference that expires.
  assert.match(body, /lastSeenAt: Number\.isFinite\(member\.lastSeenAt\)/u);
  assert.equal(/online: member\.online/u.test(body), false, 'a refresh must not copy a cached presence boolean');
});

test('a failed refresh leaves the old cache alone and says why', () => {
  const body = HOST.slice(HOST.indexOf('const refreshGroupRoster'), HOST.indexOf('const disposePanelRpc'));
  // Deleting the cache on a failed refresh would lose a group the person is still in.
  assert.match(body, /catch \(error\)/u);
  assert.match(body, /refresh_failed/u, 'the failure must carry a code the panel can name');
});

test('the change signature notices a roster change', () => {
  // Without this a refresh succeeds, the signature is identical, and nothing re-renders.
  const start = CLIENT.indexOf('function signatureOf(');
  const body = CLIENT.slice(start, CLIENT.indexOf('function ', start + 20));
  assert.match(body, /rosterStale/u, 'staleness must move the signature');
  assert.match(body, /group\.members/u, 'so must the roster itself');
});

test('the panel can replace the injected table', () => {
  // The page renders from a global injected once. A refresh changes the ledger, not that global.
  assert.match(CLIENT, /function replaceGroups\(groups\)/u);
  const body = CLIENT.slice(CLIENT.indexOf('function replaceGroups('));
  assert.match(body, /CHANGE_EVENT/u, 'subscribers must be woken, or the poll is the only path to a re-render');
});

test('the refresh button is always reachable, not only when stale', () => {
  // The old copy told the reader to go run a tool call. Assert the affordance exists and the homework is gone.
  assert.match(CLIENT, /refreshButton/u, 'the control must exist');
  assert.match(CLIENT, /refreshRoster\(String\(group\.id\)\)/u);
  // It lives in the header, OUTSIDE the stale branch: a reader whose cache happens to be 20 seconds old still needs a
  // way to ask "is this current?". Rendering it only when already stale gave them none.
  const headerAt = CLIENT.indexOf('membersLayout.headerMeta }, countLine)');
  const noticeAt = CLIENT.indexOf('group.rosterStale === true && Number(group.unreachableAt || 0) === 0');
  assert.ok(headerAt > -1 && noticeAt > -1);
  assert.ok(headerAt < noticeAt, 'the button must precede the conditional notice, i.e. live in the header');
  assert.match(CLIENT, /"data-role": "refresh"/u, 'it needs a marker so roster queries can exclude it');
  // The stale-cache notice must not tell the reader to leave the UI. The same phrase survives once as a
  // presence tooltip ("还没有这个人的在线信息"), which is about one member's state and is not homework.
  const staleNoticeAt = CLIENT.indexOf("名单来自缓存");
  assert.ok(staleNoticeAt > -1, "the notice must still exist");
  const notice = CLIENT.slice(staleNoticeAt - 400, staleNoticeAt + 900);
  assert.equal(
    /在会话里查一次群成员即可刷新/u.test(notice),
    false,
    "the notice must offer the button, not an instruction to go elsewhere",
  );
});

test('auto refresh is bounded to one attempt per group', () => {
  // A failed refresh that re-fires on every render would hammer an unreachable host.
  assert.match(CLIENT, /autoTried\[id\] === true/u);
});

test('a refresh reports its outcome either way', () => {
  // An automatic action with no visible result is indistinguishable from one that did nothing.
  assert.match(CLIENT, /setRefreshNote\("已刷新。"\)/u);
  assert.match(CLIENT, /刷新失败/u);
});
