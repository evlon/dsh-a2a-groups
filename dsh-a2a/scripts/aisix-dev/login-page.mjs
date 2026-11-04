// Set the auth cookie in a running opencli browser session.
//
// `?token=` returns 303 + `Set-Cookie: ...; SameSite=Strict`. A browser navigation it
// did not initiate does not carry that cookie, so the page lands on the auth wall. This
// script fetches the cookie over HTTP and injects it with `document.cookie`, which is
// the only path that works for a page the browser did not navigate to itself.
//
//   node scripts/aisix-dev/login-page.mjs <session> <port>
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const session = process.argv[2] ?? 'shot1';
const port = process.argv[3] ?? '3091';

/** Read the one-time token from the instance's startup log. */
function tokenOf(logPath) {
  const text = readFileSync(logPath, 'utf8');
  const match = /token=([A-Za-z0-9_-]+)/.exec(text);
  if (match === null) throw new Error(`no token found in ${logPath}`);
  return match[1];
}

const home = port === '3091' ? 'C:\\Users\\niukl\\.dsh-a2a-dev' : 'C:\\Users\\niukl\\.agent-groups';
const token = tokenOf(`${home}\\out.log`);

// Fetch the Set-Cookie header without following the redirect: the cookie is issued on
// the 303 itself, and a followed redirect would drop the header from view.
const response = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' });
const setCookie = response.headers.getSetCookie?.() ?? [];
const raw = setCookie[0];
if (raw === undefined) throw new Error(`no Set-Cookie from :${port} (status ${response.status})`);
const cookie = raw.split(';')[0];
process.stdout.write(`cookie for :${port}: ${cookie.slice(0, 40)}...\n`);

/** Run one opencli command against the session. */
function opencli(args) {
  return execFileSync('cmd.exe', ['/c', 'opencli', 'browser', session, ...args], { encoding: 'utf8' });
}

opencli(['open', `http://127.0.0.1:${port}/`]);
// `eval` with an expression that sets the cookie and returns a marker, so a silent
// failure (a CSP, a wrong path) shows up as a wrong return value instead of nothing.
const marker = opencli(['eval', `document.cookie=${JSON.stringify(`${cookie}; Path=/`)}; 'set'`]);
process.stdout.write(`set: ${marker.trim().split('\n')[0]}\n`);
opencli(['eval', 'location.reload(); "reloading"']);
process.stdout.write('reloaded; waiting for the shell to mount\n');
