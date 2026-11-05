// Read the group feed and print who said what.
import { readFileSync } from 'node:fs';

const HOST = 'http://127.0.0.1:3095/a2a';
const TOKEN = 'agent-groups-host-token-2026';
const HOME = 'C:/Users/niukl/.dsh-a2a-dev';

const membership = JSON.parse(readFileSync(`${HOME}/a2a/memberships.json`, 'utf8')).memberships[0];

async function skill(id, data) {
  const response = await fetch(HOST, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'SendMessage',
      params: {
        message: {
          role: 'user',
          messageId: crypto.randomUUID(),
          parts: [{ kind: 'text', text: id }],
          metadata: { skill: id, data },
        },
      },
    }),
  });
  const body = await response.json();
  if (body.error !== undefined) throw new Error(`${id}: ${body.error.message}`);
  return body.result.task.metadata.result;
}

const sinceSeq = Number(process.argv[2] ?? '100');
const limit = Number(process.argv[3] ?? '12');

const page = await skill('group/read', {
  groupId: membership.groupId,
  personId: membership.personId,
  personKey: membership.personKey,
  sinceSeq,
});

const messages = page.entries.filter((entry) => entry.kind === 'message');
console.log(`entries=${page.entries.length} messages=${messages.length} head=${page.lastSeq}\n`);
for (const entry of messages.slice(-limit)) {
  const name = typeof entry.from === 'string' ? entry.from : (entry.from?.displayName ?? '?');
  const text = String(entry.text ?? '').replace(/\n+/gu, ' ');
  console.log(`--- seq ${entry.seq}  [${name}]`);
  console.log(text.slice(0, 400));
  console.log();
}
