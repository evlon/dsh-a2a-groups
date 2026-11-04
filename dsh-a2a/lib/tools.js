/**
 * The DSH adapter for the tool surface.
 *
 * Three things happen here and nothing else: read the shared specs, hand each one to the
 * Host's `defineTool`, and route execution through the shared runtime.
 *
 * The split exists because a second host is being added. An MCP server needs the same
 * nineteen tools with the same descriptions and the same results; if this file also held
 * the logic, that server would either duplicate it or drift from it. Now the two hosts
 * differ only in how they are called:
 *
 *   DSH  ctx.tools.register(spec + execute)   →  execute(args, exec) → runtime.call(name, args, { sessionId: exec.agent.id })
 *   MCP  tools/list + tools/call              →  runtime.call(name, args, { sessionId })
 *
 * @module dsh-a2a/tools
 */

import { defineTool } from './toolkit.js';
import { allSpecs } from './tool-specs.js';
import { createToolRuntime } from './tool-runtime.js';

/**
 * Register every tool on the Host.
 *
 * @param {object} ctx - Host context; `ctx.tools.register` is the only capability used.
 * @param {object} deps - the store, registry, bridge and friends the runtime needs.
 * @returns {{names: string[], runtime: object}} what was registered, for tests and logs.
 */
export function registerTools(ctx, deps) {
  const runtime = createToolRuntime(deps);

  /** The Session a tool call arrives from. DSH puts it at `exec.agent.id`. */
  const callerOf = (exec) => ({
    sessionId: exec?.agent?.id,
  });

  const registered = [];
  for (const spec of allSpecs()) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: spec.output,
      // One line of glue: hand the call to the shared runtime with the Session identity.
      // These tool bodies are host-agnostic, so the adapter supplies the one fact only
      // this host knows.
      execute: (args, exec) => runtime.call(spec.name, args, callerOf(exec)),
    }));
    registered.push(spec.name);
  }

  return { names: registered, runtime };
}

export function joinUrl(base, agent) {
  return `${String(base).replace(/\/+$/, '')}/${String(agent).replace(/^\/+/, '')}`;
}

export function coded(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

export function parseInviteLink(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    throw coded('invalid_link', 'that does not look like an invite link (expected agent-a2a://group?...).');
  }
  if (url.protocol !== 'agent-a2a:' || url.hostname !== 'group') {
    throw coded('invalid_link', 'that is not an agent-a2a group invite link.');
  }
  const params = url.searchParams;
  const groupId = params.get('g') ?? '';
  if (groupId === '') throw coded('invalid_link', 'the invite link carries no group id.');
  // The gateway base and agent name are what make the link usable from another
  // machine; a link without them can only address a group on this instance.
  const gatewayBase = params.get('gw') ?? '';
  const agent = params.get('agent') ?? '';
  const direct = params.get('url') ?? '';
  const token = params.get('t') ?? '';
  // `agent` is the HOST's name in the gateway, not the group id. Falling back to
  // the group id here would send a colleague to an agent that does not exist —
  // and because a group id looks plausible, the failure reads as "the gateway is
  // broken" rather than "this link is malformed".
  const endpoint = direct !== ''
    ? direct
    : (gatewayBase === '' || agent === '' ? undefined : joinUrl(gatewayBase, agent));
  return {
    groupId,
    token: token === '' ? undefined : token,
    gatewayBase: gatewayBase === '' ? undefined : gatewayBase,
    agent: agent === '' ? undefined : agent,
    endpoint,
    baseUrl: endpoint,
    groupName: params.get('n') ?? undefined,
    expiresAt: params.get('e') ?? undefined,
  };
}
