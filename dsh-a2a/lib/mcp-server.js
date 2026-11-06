#!/usr/bin/env node
/**
 * An MCP server for collaboration groups, over stdio.
 *
 * WHAT THIS IS FOR
 *
 * The DSH plugin covers people who use DSH. Everyone else — CodeBuddy, Claude Code,
 * Cursor, any MCP client — could not reach these groups at all. MCP is the lingua franca
 * for "an agent with tools", so exposing the same nineteen tools here makes the groups
 * usable from any of them.
 *
 * WHAT IT IS NOT
 *
 * There is no UI. MCP has no concept of panels or buttons; it has tools, resources and
 * prompts. So the member panel, the tabs and the @ button exist only in the DSH plugin.
 * This server offers the tools and nothing else, which is the right shape: an agent that
 * can call `a2a_group_post` does not need to see a roster widget.
 *
 * WHY STDIO
 *
 * The host is a remote A2A service; MCP is only how a local agent reaches the tools. stdio
 * means the client spawns this process, so there is no port to open, no TLS to arrange,
 * and no credential to distribute beyond the one this process uses to talk to the host.
 * An HTTP transport can be added later without touching anything below, because the
 * request handling is transport-neutral.
 *
 * PROTOCOL
 *
 * JSON-RPC 2.0, one message per line on stdin, one response per line on stdout. Newline
 * framing only: MCP's stdio transport forbids embedded newlines in a message, which is
 * why every response is serialized compactly.
 *
 * @module dsh-a2a/mcp-server
 */

import { createInterface } from 'node:readline';

import { allSpecs, specOf } from './shared/tool-specs.js';
import { createToolRuntime } from './shared/tool-runtime.js';

/** The MCP revision this server implements. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Tools that need a Session id; on MCP the connection supplies one stable id. */
const CONNECTION_SESSION_ID = 'mcp';

/**
 * Build the request handler.
 *
 * Separated from the transport so a test — or a future HTTP transport — can drive it
 * directly without spawning a child process.
 *
 * @param {object} options - `{ deps, sessionId, version }`.
 * @returns {{handle: (request: object) => Promise<object|null>, listTools: () => object[]}} the handler.
 */
export function createMcpHandler({ deps = {}, sessionId = CONNECTION_SESSION_ID, version = '0.1.0' } = {}) {
  const runtime = createToolRuntime(deps);

  /**
   * Tools this host offers to an MCP client.
   *
   * Every spec is shared with the DSH plugin, so the two hosts present one contract — except where an MCP client
   * genuinely cannot do the thing:
   *
   *   a2a_serve         exposes this instance as an A2A server. An MCP server has no DSH Session to bind, and the tool
   *                     dereferenced `sessions` unconditionally — measured: `Cannot read properties of undefined
   *                     (reading 'offerBinding')`. A tool that always throws is worse than an absent one, because a
   *                     model reads the stack-shaped failure as "try again" and loops.
   *
   *   a2a_group_inbox   subscribes to group pushes. MCP has no push channel: a notification would land in the client
   *                     program, and no mainstream MCP client turns one into a turn. It used to answer 「没有订阅」,
   *                     which is a LIE in the worst direction — the reader believes delivery is armed. Reading is done
   *                     with a2a_group_read, and the preamble says so.
   *
   * Removing them changes the list a client sees, which is why the preamble names the substitute explicitly instead of
   * leaving the reader to infer one.
   */
  const HIDDEN_ON_MCP = Object.freeze(['a2a_serve', 'a2a_group_inbox']);

  /**
   * The tool list MCP clients see.
   *
   * `inputSchema` is the same JSON Schema the DSH plugin registers, which is the whole
   * point of splitting the specs out: a model that learned the tool in one host meets the
   * identical contract in the other.
   */
  function listTools() {
    return allSpecs()
      .filter((spec) => HIDDEN_ON_MCP.includes(spec.name) === false)
      .map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.parameters,
      }));
  }

  /**
   * Run one tool and shape the result as MCP content.
   *
   * The spec's own `render` produces the human-readable parts, so the text an MCP client
   * shows is the same text a DSH user sees in a tool card — not a JSON dump that happens
   * to be in the same shape.
   */
  async function callTool(params) {
    const name = typeof params?.name === 'string' ? params.name : '';
    const spec = specOf(name);
    if (spec === undefined) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
      };
    }
    // A hidden tool can still be named by a client that cached the list before an upgrade. Answer with the substitute
    // instead of letting it reach code that assumes a DSH host.
    if (HIDDEN_ON_MCP.includes(name) === true) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: name === 'a2a_serve'
            ? '这个工具在 MCP 客户端里不可用：MCP 服务端没有可以对外绑定的 DSH 会话，无法把自己暴露成 A2A 服务。'
              + '要对外提供服务，请在 DSH 里装插件，或者直接运行 agent-groups 宿主。'
            : '这个工具在 MCP 客户端里不可用：MCP 没有推送通道，同事的新消息不会自动到达。'
              + '请用 a2a_group_read 主动拉取（带 sinceSeq 可以只取增量）。',
        }],
      };
    }
    const args = params?.arguments;
    try {
      const value = await runtime.call(name, args ?? {}, { sessionId });
      // `render` is the spec's own presenter; using it keeps the two hosts consistent.
      const parts = spec.output.render(args ?? {}, value);
      return {
        content: parts.map((part) => ({
          type: 'text',
          text: typeof part?.text === 'string' ? part.text : JSON.stringify(value),
        })),
        // The structured value rides along for a client that wants to act on it rather
        // than display it. Non-standard but additive: clients that ignore it lose nothing.
        structuredContent: value,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error?.code === undefined ? '' : `[${error.code}] `;
      return {
        isError: true,
        content: [{ type: 'text', text: `${code}${message}` }],
      };
    }
  }

  /**
   * Dispatch one JSON-RPC request.
   *
   * @param {object} request - the parsed message.
   * @returns {Promise<object|null>} the response, or null for a notification.
   */
  async function handle(request) {
    if (request === null || typeof request !== 'object') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
    }
    const { id, method, params } = request;
    // A request without an id is a notification: answer nothing, not even an error.
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'agent-groups', version },
              // This preamble is the only place a model learns that it has to ASK. MCP notifications cannot reach
              // it — they land in the client program, and no mainstream client turns one into a turn — so without
              // this paragraph a colleague's message sits unread forever and the model has no reason to suspect it
              // exists.
              //
              // It also has to say HOW TO START. Measured on a fresh data directory: every group tool answers
              // `unknown_group`, and `a2a_pending` answers 「Nothing waiting.」 — which reads as "all quiet" while the
              // truth is "you have joined nothing". A new user cannot tell those apart, and the model cannot either.
              instructions:
                'Collaboration groups for this machine. THIS SERVER CANNOT REACH YOU: it cannot notify you when '
                + 'a colleague posts or invites you, so checking is your job.\n\n'

                + '=== START HERE (first run, or when a2a_groups is empty) ===\n'
                + 'Read a2a_groups first. If it lists nothing, you have not joined any group yet, and THREE routes exist:\n'
                + '  1. A colleague gave you an invite link (looks like `agent-a2a://group?v=1&...`).\n'
                + '     Paste it into a2a_group_join. This is the fastest route and needs nobody\'s approval.\n'
                + '  2. Browse with a2a_group_directory, then a2a_group_request. A human owner must approve, so tell the\n'
                + '     user plainly: "已申请加入 X，等群主批准后我再认领" and keep the requestId + claimKey. Come back with\n'
                + '     a2a_group_claim when they say it is approved. If claim reports request_pending, it simply has not\n'
                + '     been approved yet — say so and stop; do not retry in a loop.\n'
                + '  3. Create your own with a2a_group_create.\n'
                + 'If none of these fit, ASK THE USER for an invite link. Do not sit there trying tools.\n\n'

                + '=== KEEPING UP DURING WORK ===\n'
                + 'Call a2a_pending at the START of a turn, and again every few minutes during long work. It returns unread\n'
                + 'group messages plus one-to-one invitations in one call. If it reports nothing, say so briefly and carry\n'
                + 'on — do not silently skip it.\n\n'
                + 'There is no push channel here: a2a_group_inbox does not exist and would be a lie. To catch up on a\n'
                + 'specific group, use a2a_group_read with sinceSeq (the last seq you saw) so you fetch only what is new.\n\n'

                + '=== ACTING ===\n'
                + 'An invitation blocks progress: join with a2a_group_join (the message carries a ready link) or decline\n'
                + 'it, then a2a_person_ack so the sender learns it arrived.\n\n'
                + 'Speak with a2a_group_post — add `mentions` to summon specific people, omit it for ordinary progress that\n'
                + 'only raises an unread count. You can belong to several groups at once; pass groupId to say which.',
            },
          };
        case 'notifications/initialized':
        case 'initialized':
          // Acknowledged by doing nothing: the client is telling us it is ready.
          return null;
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: listTools() } };
        case 'tools/call':
          return { jsonrpc: '2.0', id, result: await callTool(params) };
        case 'resources/list':
          // No resources: this server exposes actions, not documents. Answering with an
          // empty list is better than method-not-found, because a client that probes will
          // stop asking once it sees the capability is present but empty.
          return { jsonrpc: '2.0', id, result: { resources: [] } };
        case 'prompts/list':
          return { jsonrpc: '2.0', id, result: { prompts: [] } };
        default:
          if (isNotification) return null;
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `method not found: ${String(method)}` },
          };
      }
    } catch (error) {
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  return { handle, listTools, runtime };
}

/**
 * Serve MCP over stdio until stdin closes.
 *
 * @param {object} options - passed through to `createMcpHandler`.
 * @returns {Promise<void>} resolves when the input stream ends.
 */
export async function serveStdio(options = {}) {
  const handler = createMcpHandler(options);

  /** Write one response as a single line. A newline inside the JSON would break framing. */
  const write = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  // Work through messages in order: tools may touch the store, and interleaving two calls
  // that both mutate a group would be a race the group code does not expect.
  let pending = Promise.resolve();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  lines.on('line', (line) => {
    const text = line.trim();
    if (text === '') return;
    pending = pending.then(async () => {
      let request;
      try {
        request = JSON.parse(text);
      } catch {
        // A malformed line gets a parse error and the stream continues: killing the
        // server over one bad byte would take down every later call.
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        return;
      }
      const response = await handler.handle(request);
      if (response !== null) write(response);
    }).catch((error) => {
      write({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    });
  });

  await new Promise((resolve) => {
    lines.on('close', resolve);
  });
  await pending;
}

// Only run when invoked directly: importing this file must have no side effects, because
// the tests import the handler.
const invokedDirectly = process.argv[1] !== undefined
  && /mcp-server\.js$/.test(process.argv[1].replace(/\\/g, '/'));

if (invokedDirectly) {
  // The dependencies a real run needs. `deps` is intentionally empty here: the group tools
  // reach a REMOTE host over A2A, so the only state this process needs is its own
  // configuration, which arrives through the environment.
  // Dynamic because importing the deps would construct a bridge, a registry and a ledger
  // at module load — side effects a test that only wants the handler must not inherit.
  const { createHostDepsFromEnv } = await import('./mcp/mcp-deps.js');
  serveStdio({ deps: createHostDepsFromEnv(process.env) }).catch((error) => {
    process.stderr.write(`agent-groups-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
