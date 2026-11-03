// Authenticate an opencli browser session against a DSH web instance, then screenshot.
//
// The obstacle: `?token=` answers 303 with `Set-Cookie: ...; SameSite=Strict`. A
// navigation the browser did not initiate itself does not carry that cookie, so the
// page lands on the auth wall even though the token is valid. The only path that works
// is fetching the cookie over HTTP and injecting it with `document.cookie`.
//
//   node scripts/aisix-dev/shot-page.mjs <session> <port> <out.png>
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const session = process.argv[2] ?? 'shot2';
const port = process.argv[3] ?? '3091';
const outPath = process.argv[4];
const home = port === '3091' ? 'C:/Users/niukl/.dsh-a2a-dev' : 'C:/Users/niukl/.dsh-groups';

const log = readFileSync(`${home}/out.log`, 'utf8');
const token = /token=([A-Za-z0-9_-]+)/.exec(log)?.[1];
if (token === undefined) throw new Error(`no token in ${home}/out.log`);

const response = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' });
const raw = (response.headers.getSetCookie?.() ?? [])[0];
if (raw === undefined) throw new Error(`no Set-Cookie from :${port} (status ${response.status})`);
const cookie = raw.split(';')[0];
console.log(`cookie: ${cookie.slice(0, 32)}...`);

/** Run one opencli command, returning stdout. */
function cli(...args) {
  return execFileSync('cmd.exe', ['/c', 'opencli', 'browser', session, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
  });
}

cli('open', `http://127.0.0.1:${port}/`);
console.log(`opened :${port}`);

// Set the cookie and read it back: a silent failure (wrong Path, a CSP) would otherwise
// look like success and then fail confusingly on reload.
const setAndRead = cli('eval', `document.cookie=${JSON.stringify(`${cookie}; Path=/`)}; document.cookie.length`);
console.log(`cookie length after set: ${setAndRead.trim().split('\n')[0]}`);

cli('eval', 'location.reload(); "reloading"');
console.log('reloaded, waiting for the shell to mount');

// The shell mounts its panels asynchronously; a short wait is enough and cheap.
await new Promise((resolve) => setTimeout(resolve, 9000));

const text = cli('eval', 'document.body.innerText.slice(0, 200)');
console.log(`--- page text ---\n${text.trim().split('\n').slice(0, 6).join('\n')}`);

if (outPath !== undefined) {
  cli('screenshot', outPath);
  console.log(`screenshot: ${outPath}`);
}
