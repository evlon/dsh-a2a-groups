// Make a member instance show a remote group's counts and recent posts in its panel.
//
// The panel reads `memberships.json` plus, for a group this instance HOSTS, the local
// store. A remote group has no local store here, so the panel has only what was cached:
// name and head. Counts and the feed live on the host.
//
// The honest way to fill that gap is `a2a_group_info`, which the member-side tool calls
// over A2A — but a tool call needs a live Session turn. For a screenshot we write the
// cache the tool WOULD write, using values fetched from the host's own API. That keeps
// the demo faithful: every number in the panel came from the host, not from this file.
//
//   node scripts/aisix-dev/sync-member-panel.mjs <port> <groupId> <memberId> <memberKey>
import { readFileSync, writeFileSync } from 'node:fs';

const [port, groupId, memberId, memberKey] = process.argv.slice(2);
if ([port, groupId, memberId, memberKey].some((value) => value === undefined)) {
  throw new Error('usage: sync-member-panel.mjs <hostPort> <groupId> <memberId> <memberKey>');
}

const HOST = `http://127.0.0.1:${port}/a2a`;
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
      id: 'sync',
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

const info = await call('group/info', { groupId, memberId, memberKey });
const page = await call('group/read', { groupId, memberId, memberKey, sinceSeq: 0, limit: 20 });
process.stdout.write(`host says: ${info.name} / ${info.memberCount} 人 / ${page.entries.length} 条消息\n`);

const file = 'C:/Users/niukl/.dsh-a2a-dev/a2a/memberships.json';
const state = JSON.parse(readFileSync(file, 'utf8'));
const record = (state.memberships ?? []).find(
  (entry) => entry.groupId === groupId && entry.memberId === memberId,
);
if (record === undefined) throw new Error(`no membership for ${groupId}/${memberId} in ${file}`);

record.groupName = info.name;
record.groupTopic = info.topic;
record.memberCount = info.memberCount;
record.onlineCount = info.onlineCount;
record.lastSeq = info.lastSeq;
record.lastTime = info.lastPostAt ?? 0;
record.isOwner = info.isOwner === true;
// The feed the panel will draw. Trimmed the same way the panel trims it, so what is
// written here is what a live refresh would produce.
record.feed = page.entries.slice(-8).map((entry) => ({
  seq: entry.seq,
  at: entry.at,
  // group/read returns rom as the display name STRING, not an object.
  from: typeof entry.from === 'string' ? entry.from : entry.from?.displayName ?? '',
  text: entry.text ?? '',
  // kind is 'message' | 'system'; there is no boolean system field.
  system: entry.kind === 'system',
}));
record.touchedAt = Date.now();

writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
process.stdout.write(`panel cache updated: ${info.name}, ${info.memberCount} 人, ${record.feed.length} 条\n`);
