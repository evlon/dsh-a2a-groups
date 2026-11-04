/**
 * Dependencies for the MCP server: everything the group tools need, wired for a process
 * that has no DSH, no Session, and no local group store.
 *
 * THE SHAPE OF THE PROBLEM
 *
 * In DSH the group tools are wired to a plugin context: a local store for groups this
 * instance hosts, a session service, an inbox. An MCP client has none of that. It has one
 * thing: an address for a remote group host, and a credential to reach it.
 *
 * That is not a limitation, it is the normal case. A colleague's DSH instance talks to the
 * shared host over A2A; this process does exactly the same, just without a DSH around it.
 * So `store` is empty (this instance hosts nothing), `sessions` is absent (there are no
 * Sessions to deliver into), and `bridge` does all the real work.
 *
 * WHAT IS REUSED
 *
 * `bridge.js`, `registry.js`, `memberships.js` and `config.js` are the same modules the
 * plugin uses. That is why the tools behave identically in both hosts: the transport
 * differs, the machinery does not.
 *
 * @module dsh-a2a/mcp-deps
 */

import { createBridge } from './bridge.js';
import { createMembershipLedger } from './memberships.js';
import { createRegistry } from './registry.js';
import { normalizeConfig } from './config.js';

/** A logger that writes to stderr: stdout is the MCP channel and must stay clean. */
function stderrLogger(verbose) {
  const stamp = () => new Date().toISOString();
  return {
    info: (line) => process.stderr.write(`${stamp()} info  ${line}\n`),
    warn: (line) => process.stderr.write(`${stamp()} warn  ${line}\n`),
    error: (line) => process.stderr.write(`${stamp()} error ${line}\n`),
    debug: (line) => {
      if (verbose) process.stderr.write(`${stamp()} debug ${line}\n`);
    },
  };
}

/**
 * A store that refuses to pretend.
 *
 * The group mutators branch on `store.has(groupId)` to choose between a local call and an
 * A2A call. In an MCP process nothing is hosted locally, so `has` is always false and the
 * A2A path is always taken. Every other method throws rather than returning a plausible
 * empty value: a silent empty answer from `list()` would look like "you are in no groups",
 * which is a lie about a remote state this process cannot see.
 */
function remoteOnlyStore() {
  const refuse = () => {
    throw new Error('this process hosts no groups; pass `agent` so the call goes to a remote host over A2A');
  };
  return {
    has: () => false,
    list: () => [],
    enabled: () => false,
    create: refuse,
    invite: refuse,
    join: refuse,
    post: refuse,
    read: refuse,
    members: refuse,
    leave: refuse,
    snapshot: refuse,
    authenticate: refuse,
    requestJoin: refuse,
    listRequests: refuse,
    decideRequest: refuse,
    claimJoin: refuse,
    listDirectory: refuse,
    revokeInvite: refuse,
    setProfile: refuse,
    memberView: refuse,
    lastEntry: refuse,
    subscribe: () => () => {},
    flush: async () => {},
  };
}

/**
 * Build the dependency bundle from the environment.
 *
 * Recognised variables, mirroring the host's own naming so one deployment can use the
 * same words on both sides:
 *
 *   AGENT_GROUPS_GATEWAY  gateway base, e.g. http://gw:3000/a2a
 *   AGENT_GROUPS_AGENT    the host's agent name in that gateway, e.g. agent-groups
 *   AGENT_GROUPS_TOKEN    bearer token for the host
 *   AGENT_GROUPS_DATA     directory for memberships.json (default ~/.agent-groups)
 *   AGENT_GROUPS_VERBOSE  "1" for debug logging on stderr
 *
 * @param {object} env - usually `process.env`.
 * @returns {object} the deps object `createToolRuntime` expects.
 */
export function createHostDepsFromEnv(env = process.env) {
  const gatewayBase = typeof env.AGENT_GROUPS_GATEWAY === 'string' ? env.AGENT_GROUPS_GATEWAY.trim() : '';
  const agentName = typeof env.AGENT_GROUPS_AGENT === 'string' ? env.AGENT_GROUPS_AGENT.trim() : '';
  const token = typeof env.AGENT_GROUPS_TOKEN === 'string' ? env.AGENT_GROUPS_TOKEN.trim() : '';
  const dataDir = typeof env.AGENT_GROUPS_DATA === 'string' && env.AGENT_GROUPS_DATA !== ''
    ? env.AGENT_GROUPS_DATA
    : `${process.cwd()}/.agent-groups`;
  const verbose = env.AGENT_GROUPS_VERBOSE === '1';

  const logger = stderrLogger(verbose);
  const config = normalizeConfig({
    groups: {
      gatewayBase,
      agentName,
      home: dataDir,
    },
    client: {
      apiKey: token,
    },
  });

  const clock = () => Date.now();
  const bridge = createBridge({ logger, config, clock });
  const registry = createRegistry({ home: dataDir, logger, clock });
  const identities = createMembershipLedger({ home: dataDir, logger, clock });

  if (gatewayBase === '' || agentName === '') {
    logger.warn(
      'AGENT_GROUPS_GATEWAY and AGENT_GROUPS_AGENT are not set: tools that need the host will fail. '
      + 'Set both, e.g. AGENT_GROUPS_GATEWAY=http://gw:3000/a2a AGENT_GROUPS_AGENT=agent-groups',
    );
  }

  return {
    config,
    registry,
    bridge,
    // Nothing is hosted in this process; every group operation goes over A2A.
    store: remoteOnlyStore(),
    identities,
    logger,
    // No Sessions exist here. The group tools that need one pass their own connection id,
    // and the ones that would deliver into a Session are simply never used.
    sessions: undefined,
    server: undefined,
    inbox: undefined,
  };
}
