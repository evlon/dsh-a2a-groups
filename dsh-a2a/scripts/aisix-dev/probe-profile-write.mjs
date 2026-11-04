// Verify the `profile` endpoint actually writes, before building a form on top of it.
//
// A form over an endpoint that silently does nothing is the worst outcome: the user presses save, sees
// "已保存", and the value is gone on reload. So the endpoint is proven first, with the write read back.
import { readFileSync } from 'node:fs';

const port = process.argv[2] ?? '3091';
const home = process.argv[3] ?? 'C:/Users/niukl/.dsh-a2a-dev';

const log = readFileSync(home + '/out.log', 'utf8');
const token = /token=([A-Za-z0-9_-]+)/.exec(log)?.[1];
if (token === undefined) throw new Error('no token in out.log');

const authResponse = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' });
const rawCookie = (authResponse.headers.getSetCookie?.() ?? [])[0];
if (rawCookie === undefined) throw new Error(`no Set-Cookie (status ${authResponse.status})`);
const cookie = rawCookie.split(';')[0];

async function call(endpoint, payload) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'probe-' + Date.now(),
    method: endpoint,
    payload,
  });
  const response = await fetch(`http://127.0.0.1:${port}/a2a-panel/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body,
  });
  return { status: response.status, json: await response.json() };
}

// Discover a group this instance is in, so the probe writes to something real.
const memberships = JSON.parse(readFileSync(home + '/a2a/memberships.json', 'utf8'));
const record = memberships.memberships?.[0];
if (record === undefined) {
  console.log('no membership on disk; cannot probe the write path');
  process.exit(0);
}
console.log(`group=${record.groupId} session=${record.sessionId} person=${record.personId}`);

const marker = '自检写入 ' + new Date().toISOString().slice(11, 19);
const write = await call('profile', {
  groupId: record.groupId,
  sessionId: record.sessionId,
  about: marker,
  tags: ['自检'],
});
console.log('write:', JSON.stringify(write));

// Read it back from the file rather than trusting the response.
const groups = JSON.parse(readFileSync(home + '/a2a/groups.json', 'utf8'));
const group = (groups.groups ?? []).find((entry) => entry.groupId === record.groupId);
const member = (group?.members ?? []).find((entry) => entry.personId === record.personId);
console.log('on disk: about=' + JSON.stringify(member?.roleAbout ?? null)
  + ' tags=' + JSON.stringify(member?.tags ?? null));
console.log('matches: ' + (member?.roleAbout === marker));

// A bad request must be refused, not silently accepted.
const bad = await call('profile', { groupId: '' });
console.log('empty groupId:', JSON.stringify(bad.json.result ?? bad.json));
