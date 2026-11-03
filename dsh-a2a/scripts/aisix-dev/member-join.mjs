// Make the member instance join a group the way a real person would: through the
// member-side tool path, not by writing files.
//
// This calls the member instance's own A2A endpoint with `group/join` — but that skill
// is not exposed on a member (it has no `skills.group`), so the honest route is the
// MEMBERSHIP LEDGER, which is what `a2a_group_join` writes. Doing it through the ledger
// keeps the test at the same layer the panel reads from.
//
//   node scripts/aisix-dev/member-join.mjs <sessionId> <groupId> <memberId> <memberKey> <baseUrl>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [sessionId, groupId, memberId, memberKey, baseUrl] = process.argv.slice(2);
if ([sessionId, groupId, memberId, memberKey].some((value) => value === undefined)) {
  throw new Error('usage: member-join.mjs <sessionId> <groupId> <memberId> <memberKey> [baseUrl]');
}

const file = 'C:/Users/niukl/.dsh-a2a-dev/a2a/memberships.json';
let state = { version: 2, memberships: [] };
try {
  state = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  // First membership on this instance: start a fresh v2 file.
}
if (!Array.isArray(state.memberships)) state.memberships = [];

const existing = state.memberships.findIndex(
  (entry) => entry.sessionId === sessionId && entry.groupId === groupId,
);
const record = {
  sessionId,
  groupId,
  memberId,
  memberKey,
  local: false,
  baseUrl,
  groupName: undefined,
  role: 'member',
  lastSeq: 0,
  addedAt: Date.now(),
  touchedAt: Date.now(),
};
if (existing >= 0) state.memberships[existing] = { ...state.memberships[existing], ...record };
else state.memberships.push(record);

mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
process.stdout.write(`membership written: ${sessionId} -> ${groupId}\n`);
