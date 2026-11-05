// Drive the exact tool path Wang Wu's instance would use, from its own on-disk state.
//
// This is not a simulation of the tools: it builds the same runtime `lib/index.js` builds, with 3096's real config
// and real membership ledger, and calls `a2a_group_post`. If it succeeds here, the tool works and the problem is
// above it; if it fails, the error is the answer.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createGroupStore } from '../../lib/core/groups.js';
import { createMembershipLedger } from '../../lib/core/memberships.js';
import { createRegistry } from '../../lib/core/registry.js';
import { createBridge } from '../../lib/core/bridge.js';
import { createToolRuntime } from '../../lib/shared/tool-runtime.js';
import { normalizeConfig } from '../../lib/core/config.js';

const HOME = process.argv[2] ?? 'C:/Users/niukl/.dsh-a2a-dev3';
const SESSION = process.argv[3] ?? 'session-7f475392-b6e4-4958-b280-e3d42120f425';

const logger = { info() {}, warn() {}, debug() {} };
const clock = () => Date.now();

// The same values 3096 carries in cordis.patch.yml.
const config = normalizeConfig({
  server: { enabled: true, publicUrl: 'http://127.0.0.1:3096/a2a', token: 'dsh-a2a-dev-token-3096', streaming: true },
  client: { enabled: true, apiKey: 'sk-dev-niukl-2026', gatewayBase: 'http://127.0.0.1:3000/a2a', forwardProto: 'http', timeoutMs: 20000 },
  groups: { enabled: true, gatewayBase: 'http://127.0.0.1:3000/a2a', agentName: 'agent-person-dev3' },
  tools: true,
});

const store = createGroupStore({ home: join(HOME, 'a2a'), logger, clock, config });
const identities = createMembershipLedger({ home: join(HOME, 'a2a'), logger, clock });
const registry = createRegistry({ home: join(HOME, 'a2a'), logger, clock });
const bridge = createBridge({ logger, config, clock });
const runtime = createToolRuntime({ store, identities, registry, bridge, config, logger, clock });

console.log('该会话的 membership:');
for (const record of identities.list({ sessionId: SESSION })) {
  console.log(`  ${record.groupId}  person=${record.personId}  local=${record.local}  baseUrl=${record.baseUrl}`);
}
console.log();

const record = identities.list({ sessionId: SESSION })[0];
if (record === undefined) {
  console.log('没有 membership，工具会直接报 not_member');
  process.exit(0);
}

try {
  const posted = await runtime.call('a2a_group_post', {
    groupId: record.groupId,
    message: `王五工具链路测试 ${new Date().toISOString().slice(11, 19)}`,
  }, { sessionId: SESSION });
  console.log('a2a_group_post 成功:', JSON.stringify(posted));
} catch (error) {
  console.log('a2a_group_post 失败:');
  console.log('  code   :', error.code);
  console.log('  data   :', error.data);
  console.log('  message:', error.message);
}
