// Check one instance's state against the host, end to end.
//
// Reads its membership, then asks the host three things: does the group exist, is this person a member, and can
// they post. The third is the one that matters for "cannot send messages to anybody".
import { readFileSync } from 'node:fs';

const HOST = 'http://127.0.0.1:3095/a2a';
const TOKEN = 'agent-groups-host-token-2026';
const HOME = process.argv[2] ?? 'C:/Users/niukl/.dsh-a2a-dev3';

const membership = JSON.parse(readFileSync(`${HOME}/a2a/memberships.json`, 'utf8')).memberships[0];
console.log(`本地记录: group=${membership.groupId} person=${membership.personId} local=${membership.local}`);
console.log(`          key=${String(membership.personKey).slice(0, 10)}... unreachableAt=${membership.unreachableAt ?? '-'}`);
console.log();

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
  if (body.error !== undefined) return { ok: false, error: body.error };
  const task = body.result?.task;
  if (task?.status?.state === 'TASK_STATE_FAILED') {
    return { ok: false, error: task.status.message ?? { code: 'failed' } };
  }
  return { ok: true, value: task?.metadata?.result };
}

const cred = { groupId: membership.groupId, personId: membership.personId, personKey: membership.personKey };

console.log('1. group/info');
const info = await skill('group/info', cred);
console.log(info.ok ? `   OK  ${info.value.name} / ${info.value.memberCount} 人` : `   FAIL ${info.error.message ?? info.error.code}`);
if (info.ok) {
  for (const member of info.value.members) console.log(`       ${member.displayName} [${member.role}] ${member.personId}`);
}

console.log('2. group/post');
const posted = await skill('group/post', { ...cred, text: `诊断消息 ${new Date().toISOString().slice(11, 19)}` });
console.log(posted.ok ? `   OK  seq=${posted.value.seq}` : `   FAIL ${posted.error.message ?? posted.error.code}`);

console.log('3. person/inbox');
const inbox = await skill('person/inbox', { personId: membership.personId });
console.log(inbox.ok ? `   OK  ${inbox.value.messages.length} 条` : `   FAIL ${inbox.error.message ?? inbox.error.code}`);
