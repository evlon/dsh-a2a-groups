// Call the panel RPC channel over plain HTTP, using the documented ClientRequest envelope.
//
// WHY NOT THE BROWSER
//
// The pane needs a Session to render, and the UI walk depends on page state that keeps resetting between
// restarts. The transport contract, however, is documented and simple:
//
//     POST /a2a-panel/ping
//     { type: 'client-request', rpcId, method: 'ping', payload: {...} }
//
// If that answers, the channel is live and the remaining work is rendering, not plumbing. If it 405s, the
// registration still is not taking effect and no UI work would help.
import { readFileSync } from 'node:fs';

const port = process.argv[2] ?? '3091';
const home = process.argv[3] ?? 'C:/Users/niukl/.dsh-a2a-dev';

// The page token is printed to out.log at boot; it is also what mints the browser cookie.
const log = readFileSync(home + '/out.log', 'utf8');
const token = /token=([A-Za-z0-9_-]+)/.exec(log)?.[1];
if (token === undefined) throw new Error('no token in out.log');

// Authenticate like a browser would: exchange the token for the session cookie.
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
  const text = await response.text();
  return { status: response.status, text };
}

for (const [endpoint, payload] of [['ping', { at: Date.now() }], ['nope', {}]]) {
  const result = await call(endpoint, payload);
  console.log(`${endpoint}: status=${result.status} body=${result.text.slice(0, 200)}`);
}
