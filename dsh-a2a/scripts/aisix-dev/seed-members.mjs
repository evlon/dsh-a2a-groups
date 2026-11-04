// Put the member instance into the verification group, with a roster the panel can draw.
//
// The roster is fetched from the host over A2A with a real member credential, so every
// row the panel renders came from the server. Only the CACHE write is local — that is
// what `a2a_group_info` does, and the panel reads the ledger rather than the network.
//
//   node scripts/aisix-dev/seed-members.mjs <sessionId> <groupId> <personId> <personKey>
import { readFileSync, writeFileSync } from 'node:fs';

const [sessionId, groupId, personId, personKey] = process.argv.slice(2);
if ([sessionId, groupId, personId, personKey].some((value) => value === undefined)) {
  throw new Error('usage: seed-members.mjs <sessionId> <groupId> <personId> <personKey>');
}

const HOST = 'http://127.0.0.1:3095/a2a';
const TOKEN = process.env.AGENT_GROUPS_TOKEN ?? 'agent-groups-host-token-2026';

/** Call one skill on the host. */
async function call(skill, data) {
  const response = await fetch(HOST, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'a2a-version': '1.0',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'seed',
      method: 'SendMessage',
      params: {
        message: {
          role: 'user',
          messageId: `m-${Math.random().toString(36).slice(2)}`,
          parts: [{ kind: 'text', text: skill }],
          metadata: { skill, data },
        },
      },
    }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${skill}: ${body.error.message}`);
  return body.result.task.metadata?.result;
}

const creds = { groupId, personId, personKey };
const info = await call('group/info', creds);
const roster = await call('group/members', creds);
const page = await call('group/read', { ...creds, sinceSeq: 0, limit: 20 });

process.stdout.write(`host: ${info.name} / ${info.memberCount} 人 / ${page.entries.length} 条\n`);
process.stdout.write(`roster: ${roster.members.map((m) => m.displayName).join(', ')}\n`);

const file = 'C:/Users/niukl/.dsh-a2a-dev/a2a/memberships.json';
let state = { version: 2, memberships: [] };
try {
  state = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  state = { version: 2, memberships: [] };
}
if (!Array.isArray(state.memberships)) state.memberships = [];

const record = {
  sessionId,
  groupId,
  personId,
  personKey,
  local: false,
  baseUrl: HOST,
  groupName: info.name,
  groupTopic: info.topic,
  role: 'member',
  lastSeq: info.lastSeq,
  memberCount: info.memberCount,
  onlineCount: info.onlineCount,
  lastTime: info.lastPostAt ?? 0,
  isOwner: info.isOwner === true,
  // The roster the panel draws. `group/members` is the only source that may name
  // people, and it needs a member credential — which this script has.
  members: roster.members.map((member) => ({
    personId: member.personId,
    displayName: member.displayName,
    role: member.role,
    // These two are the whole point of a colleague card: without them it can only say "in N
    // groups", which the reader already knows. This script dropped them once and the cards came
    // out blank — the same mistake `a2a_group_info` had before it was fixed.
    roleAbout: member.roleAbout ?? '',
    tags: Array.isArray(member.tags) ? member.tags : [],
    online: member.online === true,
  })),
  feed: page.entries.slice(-8).map((entry) => ({
    seq: entry.seq,
    at: entry.at,
    from: typeof entry.from === 'string' ? entry.from : entry.from?.displayName ?? '',
    text: entry.text ?? '',
    system: entry.kind === 'system',
    mentions: Array.isArray(entry.mentions) ? entry.mentions : undefined,
  })),
  addedAt: Date.now(),
  touchedAt: Date.now(),
};

const existing = state.memberships.findIndex(
  (entry) => entry.sessionId === sessionId && entry.groupId === groupId,
);
if (existing >= 0) state.memberships[existing] = record;
else state.memberships.push(record);

writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
process.stdout.write(`cached: ${record.groupName}, ${record.memberCount} 人, roster ${record.members.length}, feed ${record.feed.length}\n`);
