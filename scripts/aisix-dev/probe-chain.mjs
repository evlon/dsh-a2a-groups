#!/usr/bin/env node
// End-to-end check of the whole chain: caller → AISIX gateway → DSH A2A server.
//
//   node probe-chain.mjs [gatewayBase] [agent] [callerKey]
//
// Every step is a real HTTP request through the real gateway. This is the probe
// that proves the three layers actually compose: the gateway's auth and ACL, the
// A2A 1.0 wire format, and the DSH server's skill dispatch.

const base = process.argv[2] ?? 'http://127.0.0.1:3000';
const agent = process.argv[3] ?? 'dsh-group';
const key = process.argv[4] ?? 'sk-dev-niukl-2026';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`);
  if (!ok) failed += 1;
};

const headers = { 'x-api-key': key, 'X-Forwarded-Proto': 'http' };

// 1. Card, discovered THROUGH the gateway, with its URLs rewritten to it.
const cardUrl = `${base}/a2a/${agent}/.well-known/agent-card.json`;
const cardRes = await fetch(cardUrl, { headers });
const card = cardRes.ok ? await cardRes.json() : undefined;
check('card is served through the gateway', cardRes.status === 200, `status ${cardRes.status}`);
if (card !== undefined) {
  check('card advertises A2A 1.0', card.protocolVersion === '1.0', card.protocolVersion);
  check('card url points at the gateway', String(card.url).includes(`/a2a/${agent}`), card.url);
  check('upstream address not leaked', !JSON.stringify(card).includes('3091'), 'no :3091');
  const ids = (card.skills ?? []).map((skill) => skill.id);
  check('card advertises the group skills', ids.includes('group/create') && ids.includes('session/ask'), `${ids.length} skills`);
}

// 2. The credential is enforced by the gateway, before any upstream call.
const anonymous = await fetch(cardUrl);
check('no gateway key → 401', anonymous.status === 401, `status ${anonymous.status}`);
const wrongKey = await fetch(cardUrl, { headers: { 'x-api-key': 'sk-wrong' } });
check('wrong gateway key → 401', wrongKey.status === 401, `status ${wrongKey.status}`);

// 3. A unary skill through the full chain.
const call = async (skill, data, text = skill) => {
  const response = await fetch(`${base}/a2a/${agent}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `probe-${Math.random().toString(36).slice(2)}`,
      method: 'SendMessage',
      params: {
        message: {
          role: 'user',
          messageId: `msg-${Math.random().toString(36).slice(2)}`,
          parts: [{ kind: 'text', text }],
          metadata: { skill, data },
        },
      },
    }),
  });
  const body = await response.json();
  return { status: response.status, body };
};

const ping = await call('ping', {});
const pingText = (ping.body?.result?.task?.artifacts ?? []).flatMap((a) => a.parts ?? []).map((p) => p.text ?? '').join('');
check('ping answers through the gateway', ping.status === 200 && /pong/.test(pingText), pingText.slice(0, 60).replace(/\n/g, ' '));
check('ping reports the plugin version', /"version"/.test(pingText), 'version present');

// 4. A group created through the gateway, proving the skill layer works.
const created = await call('group/create', { name: 'gateway proof', topic: 'proving the chain'}, 'create a group');
const createdText = (created.body?.result?.task?.artifacts ?? []).flatMap((a) => a.parts ?? []).map((p) => p.text ?? '').join('');
const groupId = /groupId\s*:\s*(\S+)/.exec(createdText)?.[1];
const ownerId = /personId:\s*(\S+)/.exec(createdText)?.[1];
const ownerKey = /ownerKey:\s*(\S+)/.exec(createdText)?.[1];
check('group/create works through the gateway', groupId !== undefined, groupId ?? createdText.slice(0, 80));
check('group/create returns an owner credential once', ownerId !== undefined && ownerKey !== undefined, 'credential issued');

// 5. An invite, which is the artifact a person actually sends to a colleague.
if (groupId !== undefined) {
  const invited = await call('group/invite', {
    groupId, personId: ownerId, personKey: ownerKey, label: 'probe',
  }, 'invite');
  const inviteText = (invited.body?.result?.task?.artifacts ?? []).flatMap((a) => a.parts ?? []).map((p) => p.text ?? '').join('');
  check('group/invite mints a link', /dsh-a2a:\/\/group\?/.test(inviteText), 'link present');
  check('the invite prompt is paste-ready and mentions no password', /a2a-join/.test(inviteText) && !/群密码|password/i.test(inviteText), 'prompt present');
}

// 6. The gateway's own telemetry saw the calls, keyed by agent.
const metricsText = await (await fetch('http://127.0.0.1:9090/metrics')).text();
check('gateway counted the agent calls', /aisix_a2a_requests_total\{agent="dsh-group"/.test(metricsText), 'per-agent counter');

console.log(`\nchain: ${failed === 0 ? 'OK' : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
