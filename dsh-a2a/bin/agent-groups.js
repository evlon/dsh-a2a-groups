#!/usr/bin/env node
/**
 * agent-groups — a standalone A2A group host.
 *
 * WHAT THIS IS
 *
 * A group host is a server that holds collaboration groups and speaks A2A so that
 * people's DSH instances can join them, post into them and read from them. It is
 * deliberately NOT a DSH instance:
 *
 *   - it runs no model, so it cannot think, and it never acts on a message;
 *   - it has no Sessions, so there is nothing to deliver into;
 *   - it is a plain Node program you can leave running on a server for months.
 *
 * Earlier this role was played by a DSH instance with the chat half disabled. That
 * worked, but it was the wrong shape: it made a stateful server depend on a desktop
 * application, put the host's logs inside somebody's DSH log, and — the symptom that
 * started this rewrite — forced the host to pretend it had a Session id so that
 * membership records could be keyed.
 *
 * The host has NO membership of its own groups. Members hold memberships; the host
 * holds groups. That is why nothing here writes to a membership ledger.
 *
 * HOW TO RUN
 *
 *   node bin/agent-groups.js --port 3095 --data /var/lib/agent-groups
 *   node bin/agent-groups.js --port 3095 --data ./data --token "$(openssl rand -hex 32)"
 *   AGENT_GROUPS_TOKEN=... node bin/agent-groups.js --port 3095 --data ./data
 *
 * It prints, on startup, the one line an operator needs: the agent card URL and the
 * AISIX entry that makes it reachable. Nothing else is required to deploy it —
 * behind a gateway it needs no TLS of its own, and in front of one it does.
 */

import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../lib/core/config.js';
import { createGroupStore } from '../lib/core/groups.js';
import { createSkillRegistry } from '../lib/core/skills.js';
import { createGroupSkills } from '../lib/core/skills-group.js';
import { createJoinTokenStore } from '../lib/core/join-page.js';
import { resolvePublicOrigin, buildJoinUrl } from '../lib/core/public-origin.js';
import { createServer } from '../lib/core/server.js';
import { TaskStore } from '../lib/core/wire.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = readVersion();

/** Print usage and exit. */
function usage() {
  process.stdout.write(`agent-groups ${VERSION} — an A2A collaboration group host

Usage: agent-groups [options]

  --port <n>        port to listen on (default 3095, or $AGENT_GROUPS_PORT)
  --host <addr>     address to bind (default 127.0.0.1, or $AGENT_GROUPS_HOST)
  --data <dir>      data directory (default ./data, or $AGENT_GROUPS_DATA)
  --token <secret>  bearer token for /a2a (default $AGENT_GROUPS_TOKEN, else none)
  --agent <name>    this host's agent name inside the gateway, for invite links
  --gateway <url>   gateway base for invite links, e.g. http://gw:3000/a2a
  --forward-proto   scheme the gateway should advertise (http or https)
  --public-url <u>  absolute URL peers should use, when not behind a gateway
  --help            print this message
  --version         print the version

Environment variables mirror the flags (AGENT_GROUPS_PORT, _HOST, _DATA, _TOKEN,
_AGENT, _GATEWAY, _FORWARD_PROTO, _PUBLIC_URL). Flags win over the environment.

The data directory holds groups.json and must persist across restarts. Back it up:
it contains every group's feed, and nothing else can reconstruct that.
`);
}

/** Read the package version without importing JSON (keeps the loader simple). */
function readVersion() {
  try {
    const packagePath = join(HERE, '..', 'package.json');
    return JSON.parse(readFileSync(packagePath, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Parse `--flag value` / `--flag` / `--flag=value`.
 *
 * Hand-rolled rather than `node:util.parseArgs` because this program has to keep its
 * dependency surface at zero for a server install, and `parseArgs` cannot express
 * "flag wins over env wins over default" as directly as the small table below.
 *
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {Record<string, string|boolean>} parsed flags.
 */
function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const eq = token.indexOf('=');
    if (eq > 0) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
      continue;
    }
    flags[name] = next;
    index += 1;
  }
  return flags;
}

/** First defined value, treated as text. Empty strings count as absent. */
function pick(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * A route registrar over a plain `http.Server`.
 *
 * The server facade asks for `{kind, path, handler}` registrations and expects a
 * disposer back. On a bare Node server there is nothing to unregister, so the
 * disposer removes the entry from a table the request handler consults — that keeps
 * `detach()` honest instead of pretending to clean up.
 *
 * @returns {{registrar: {register: (route: {kind: string, path: string, handler: Function}) => (() => void)}, handle: Function, routes: () => object[]}} the adapter.
 */
function createHttpRegistrar(logger) {
  /** @type {Array<{kind: string, path: string, handler: Function}>} */
  const routes = [];

  const registrar = {
    register({ kind, path, handler }) {
      if (typeof path !== 'string' || !path.startsWith('/')) {
        throw new Error(`agent-groups: a route path must start with "/" (got ${String(path)})`);
      }
      if (typeof handler !== 'function') throw new Error('agent-groups: a route handler must be a function');
      const route = { kind: kind === 'prefix' ? 'prefix' : 'exact', path, handler };
      routes.push(route);
      return () => {
        const at = routes.indexOf(route);
        if (at >= 0) routes.splice(at, 1);
      };
    },
  };

  /**
   * Dispatch one request.
   *
   * Exact matches win over prefix matches, and among prefixes the longest wins — the
   * same rule the DSH webserver applies, repeated here so the A2A surface behaves
   * identically whether the host is embedded or standalone.
   */
  function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    let chosen;
    for (const route of routes) {
      if (route.kind === 'exact' && route.path === pathname) {
        chosen = route;
        break;
      }
    }
    if (chosen === undefined) {
      let bestLength = -1;
      for (const route of routes) {
        if (route.kind !== 'prefix') continue;
        if (!pathname.startsWith(route.path)) continue;
        if (route.path.length > bestLength) {
          bestLength = route.path.length;
          chosen = route;
        }
      }
    }
    if (chosen === undefined) {
      // No SPA shell here, unlike DSH: a 404 with a JSON body is the honest answer for
      // a host that serves nothing but A2A.
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'not_found', path: pathname }));
      logger.debug?.(`agent-groups: 404 ${request.method} ${pathname}`);
      return;
    }
    try {
      const result = chosen.handler(request, response);
      // A handler may be async; an unhandled rejection would kill the process.
      if (result !== null && typeof result === 'object' && typeof result.catch === 'function') {
        result.catch((error) => {
          logger.warn?.(`agent-groups: handler failed for ${pathname}: ${error?.message ?? error}`);
          if (!response.headersSent) {
            response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: 'internal_error' }));
          }
        });
      }
    } catch (error) {
      logger.warn?.(`agent-groups: handler threw for ${pathname}: ${error?.message ?? error}`);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'internal_error' }));
      }
    }
  }

  return { registrar, handle, routes: () => [...routes] };
}

/** Log one line to stdout, timestamped: a server's log is read after the fact. */
function createLogger(verbose) {
  const stamp = () => new Date().toISOString();
  const emit = (level, line) => {
    process.stdout.write(`${stamp()} ${level} ${line}\n`);
  };
  return {
    info: (line) => emit('info ', line),
    warn: (line) => emit('warn ', line),
    // Debug output is per-request noise; only shown with AGENT_GROUPS_VERBOSE=1.
    debug: (line) => {
      if (verbose) emit('debug', line);
    },
    error: (line) => emit('error', line),
  };
}

/** Exit with a message an operator can act on, rather than a stack trace. */
function fail(message, code = 1) {
  process.stderr.write(`agent-groups: ${message}\n`);
  process.exit(code);
}

async function main() {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 2);
    return;
  }
  if (flags.help === true) {
    usage();
    return;
  }
  if (flags.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const port = Number(pick(flags.port, process.env.AGENT_GROUPS_PORT) ?? 3095);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid --port: ${String(flags.port)}`, 2);
  const host = pick(flags.host, process.env.AGENT_GROUPS_HOST) ?? '127.0.0.1';
  const dataDir = resolve(pick(flags.data, process.env.AGENT_GROUPS_DATA) ?? 'data');
  const token = pick(flags.token, process.env.AGENT_GROUPS_TOKEN);
  // `agent-group-host` is the HOST's name at the gateway: one entry serving every group, because a
  // group is data addressed by `groupId` inside the payload. Member instances are named
  // `agent-person-<who>` instead — one entry each, because each is a separate process on a
  // separate machine and one gateway path can only forward to one address.
  const agentName = pick(flags.agent, process.env.AGENT_GROUPS_AGENT) ?? 'agent-group-host';
  const gatewayBase = pick(flags.gateway, process.env.AGENT_GROUPS_GATEWAY);
  const forwardProto = pick(flags['forward-proto'], process.env.AGENT_GROUPS_FORWARD_PROTO);
  const publicUrl = pick(flags['public-url'], process.env.AGENT_GROUPS_PUBLIC_URL);
  const verbose = process.env.AGENT_GROUPS_VERBOSE === '1';
  const logger = createLogger(verbose);

  // Fail before doing any work if the data directory is unusable: a host that starts
  // and then cannot persist is worse than one that refuses to start.
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    fail(`cannot use --data ${dataDir}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const config = normalizeConfig({
    agent: {
      name: agentName,
      description: '协作群宿主：持有协作群，供同事的 DSH 实例通过 A2A 加入、发言与订阅。',
    },
    groups: {
      // The host holds groups; the membership ledger is for MEMBERS. Nothing in this
      // program writes to one, which is why `home` points at the data directory: the
      // store still needs somewhere to keep its own file.
      gatewayBase: gatewayBase ?? '',
      agentName,
      home: dataDir,
    },
    server: {
      token: token ?? '',
      // The address a LINK should use, which is often not the address this process bound to. Without it the join
      // page falls back to the listen address and produces links that only work on this machine.
      publicUrl: publicUrl ?? '',
    },
    client: {
      forwardProto: forwardProto ?? '',
    },
    delivery: { enabled: false },
  });

  const store = createGroupStore({
    home: dataDir,
    logger,
    config,
  });

  // One store for both sides: the invite skill mints a token, the join page consumes it. Two stores would
  // mean every printed link is rejected — a bug that reads as "the page does not work".
  // The origin a LINK should use. Configuration wins; otherwise the listener address, which is right for a
  // direct bind and wrong behind a rewriting proxy — so `server.publicUrl` is the setting an operator behind one
  // must fill in, and the startup log says which answer was used.
  const publicOrigin = resolvePublicOrigin({
    configured: config.server.publicUrl,
    // The listen address is the weakest answer, used only when nothing else is known.
    origin: () => 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + port,
  });

  const joinTokens = createJoinTokenStore({
    newToken: () => randomUUID().replace(/-/gu, ''),
    now: () => Date.now(),
  });

  if (publicOrigin === '') {
    logger.warn('agent-groups: no public origin known; join links will be relative and unusable off-machine. Set server.publicUrl.');
  } else {
    logger.info(`agent-groups: join links will use ${publicOrigin}`);
  }

  const registry = createSkillRegistry();
  for (const skill of createGroupSkills({
    mintJoinToken: () => joinTokens.mint(),
    joinOrigin: publicOrigin,
    
    store,
    // A host has no memberships of its own. The ledger is never read here; passing a
    // stub that refuses loudly stops a future edit from quietly reintroducing the
    // "host needs a Session" mistake this rewrite removed.
    identities: {
      // The host holds no memberships of its own — members do. But the skill bodies
      // are shared with the member build, and `group/create`/`group/join`/`group/claim`
      // each record "the caller became a member here". On a host that intent is
      // satisfied by the group itself (the owner IS a member of the group it created),
      // so the write is a no-op rather than an error.
      //
      // It used to throw. That was wrong in a subtle way: it made a shared code path
      // unusable, which pushed the host toward having fake memberships (the
      // `HOST_SESSION_ID` mistake this rewrite removes). Returning silently keeps the
      // host's ledger empty without pretending.
      upsert: () => {},
      get: () => undefined,
      list: () => [],
      has: () => false,
      // `group/leave` calls `identities.remove(groupId)` after `store.leave` succeeds. On a host there is no ledger
      // row to remove — the group IS the authority — so this is a no-op. It MUST exist, though: the skill body is
      // shared with the member build, and a missing method turns the first leave into a TypeError (`remove is not a
      // function`) that reads to the caller as "could not reach the host", while the store has already removed the
      // member — so the retry "succeeds" only because the member is gone. That is the "first call fails, second
      // works" report in its exact shape.
      remove: () => 0,
      flush: () => {},
    },
    config,
    logger,
    clock: () => Date.now(),
  })) {
    registry.register(skill);
  }

  const tasks = new TaskStore({
    ttlMs: config.server.taskTimeoutMs * 4,
    persistPath: null,
    clock: () => Date.now(),
  });
  const { registrar, handle, routes } = createHttpRegistrar(logger);
  const server = createServer({
    joinTokens,
    resolvedOrigin: publicOrigin,
    
    registrar,
    where: 'standalone agent-groups',
    logger,
    config,
    // The host never delivers: nobody is on the other end. Kept as a stub because the
    // facade asks for one, and a loud failure beats a silent no-op if that changes.
    deliverer: {
      deliver: async () => {
        throw new Error('agent-groups: a group host has no Sessions to deliver into; this is a bug');
      },
    },
    tasks,
    skills: registry,
    profileProvider: undefined,
    // Lets an operator force a flush over HTTP before copying groups.json.
    onFlush: () => store.flush(),
    // Content for the join page. The first listed group is the example: a page that demands a group id before
    // showing anything cannot be opened by the person who needs it.
    // `groupId` is optional. Absent means "configure this instance to reach the host" — the step that has
    // to happen before any group exists or applies. Present means the page also describes that group.
    joinContext: async (groupId) => {
      let group;
      if (typeof groupId === 'string' && groupId !== '') {
        const listed = (store.listDirectory({}).groups ?? []).filter((entry) => entry.archived !== true);
        group = listed.find((entry) => entry.groupId === groupId);
        // A link that names a group the host does not have (or has archived) must not fall back to some other
        // group: the reader would configure themselves into the wrong one.
        if (group === undefined) {
          throw new Error(`no such group: ${groupId}`);
        }
      }
      return {
        // Empty strings rather than placeholders: the page decides how to phrase "no group", and a fake group
        // name would read as a real invitation.
        groupName: group === undefined ? '' : (group.name ?? group.groupId),
        groupId: group === undefined ? '' : group.groupId,
        gatewayBase: config.groups.gatewayBase ?? '',
        agentName: config.groups.agentName ?? '',
        apiKey: config.client.apiKey ?? '',
        // The member chooses these, not the host: the page cannot know the colleague port or token. A
        // placeholder is used rather than omitting the key, because a missing key in a YAML block is a silent
        // hole while an obvious placeholder is a question the assistant will ask.
        publicUrl: 'http://<your-machine>:3091/a2a',
        serverToken: '<pick-a-long-random-string>',
      };
    },
  });

  server.attach();

  const httpServer = createHttpServer(handle);
  httpServer.on('clientError', (error, socket) => {
    logger.warn(`agent-groups: client error ${error?.message ?? error}`);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  await new Promise((settle, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, settle);
  });

  const actualPort = httpServer.address().port;
  const shown = publicUrl ?? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;
  const groups = store.list().length;

  logger.info(`agent-groups ${VERSION} listening on ${host}:${actualPort} (data: ${dataDir})`);
  logger.info(`agent card: ${shown}/a2a/.well-known/agent-card.json`);
  logger.info(`${groups} group(s) hosted`);
  if (token === undefined) {
    logger.warn('no token set: every caller is treated as a local, trusted client. Set --token before exposing this host.');
  }
  if (gatewayBase === undefined) {
    logger.warn('no --gateway set: invite links cannot be generated until you pass it (or set it later in the config).');
  } else {
    logger.info(`invite links will point at ${gatewayBase}/${agentName}`);
    logger.info(`AISIX entry (one per host, not per group) — resources.yaml:`);
    logger.info(`  - name: ${agentName}`);
    logger.info(`    url: ${shown}/a2a`);
  }
  logger.info(`routes: ${routes().map((route) => `${route.kind === 'prefix' ? '' : ''}${route.path}`).join(', ')}`);

  // The configure-only link: no group, no invitation, just "your DSH can reach this host". Printed at startup
  // because it is the ONLY entrance before a group exists — `group/invite` needs a group, and a host with none
  // would otherwise have no way to hand a colleague a link at all.
  if (typeof publicOrigin === 'string' && publicOrigin !== '') {
    const setup = joinTokens.mint();
    logger.info(`configure-only link (no group): ${publicOrigin}/join?t=${setup.token}`);
    logger.info('  hand this to a colleague whose DSH is not connected yet; it expires in 15 minutes');
  } else {
    logger.warn('cannot print a join link: no public origin known. Set --public-url so links are usable.');
  }

  /** Shut down in the order that loses no data: stop accepting, flush, exit. */
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received; flushing group data and stopping`);
    try {
      // A flush failure must not turn a clean shutdown into a crash: the in-memory
      // state is already correct and the next start will retry the write.
      await store.flush();
      server.detach();
      await new Promise((settle) => httpServer.close(settle));
    } catch (error) {
      logger.warn(`shutdown problem: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  // A server must not die on a stray rejection: log it and keep serving. Anything that
  // genuinely cannot continue will fail on the next request anyway, with a message
  // tied to that request rather than to nothing.
  process.on('unhandledRejection', (reason) => {
    logger.warn(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on('uncaughtException', (error) => {
    logger.warn(`uncaught exception: ${error instanceof Error ? error.message : String(error)}`);
  });
}

// Only run when invoked directly; importing this file must have no side effects
// (a test wants to import `createHttpRegistrar`).
const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}

export { createHttpRegistrar, parseFlags, usage };