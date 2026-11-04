// Reproduce the panel write from inside the page, exactly as the panel does it.
//
// The panel's save goes through the plugin's own `saveProfile`, which uses
// `ctx.connection.rpc.call('/a2a-panel', 'profile', …)`. That client is not reachable from a console, so the
// fallback is to POST the same envelope to the same path with the page's own cookie — which exercises the
// Host handler and its error path, the two things under investigation.
import { execFileSync } from 'node:child_process';

const session = process.argv[2] ?? 'w1';
const groupId = process.argv[3];
const sessionId = process.argv[4];
const about = process.argv[5] ?? '诊断写入';

const payload = {
  type: 'client-request',
  rpcId: 'diag-' + Date.now(),
  method: 'profile',
  payload: { groupId, sessionId, about, tags: ['诊断'] },
};

// Send from the page so the request carries the app's own cookie and origin.
const script = '(function(){var p=' + JSON.stringify(JSON.stringify(payload)) + ';'
  + 'fetch("/a2a-panel/profile",{method:"POST",headers:{"content-type":"application/json"},body:p})'
  + '.then(function(r){return r.text().then(function(t){window.__diag=JSON.stringify({status:r.status,body:t.slice(0,400)});});})'
  + '.catch(function(e){window.__diag=JSON.stringify({status:0,body:String(e&&e.message||e)});});'
  + 'return "sent";})()';

const out = execFileSync('cmd.exe', ['/c', 'opencli', 'browser', session, 'eval', script], {
  encoding: 'utf8',
  timeout: 120_000,
});
console.log(out.trim());
