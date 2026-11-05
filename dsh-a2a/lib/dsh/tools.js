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
import { allSpecs } from '../shared/tool-specs.js';
import { createToolRuntime } from '../shared/tool-runtime.js';
import {
  askHuman,
  confirmationPolicy,
  confirmationQuestion,
  decideFromAnswer,
} from './human-confirm.js';

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

  // The seam is resolved by OPTIONAL INJECTION. Reading `ctx.userQuestions` directly throws
  // 「cannot get property "userQuestions" without inject」 and — when that happens inside apply() — takes the whole
  // plugin down, so every a2a tool disappears. Measured.
  let questionSeam;
  try {
    ctx.inject(['userQuestions'], (scoped) => {
      questionSeam = typeof scoped?.userQuestions?.ask === 'function'
        || typeof scoped?.userQuestions?.askTimed === 'function'
        ? scoped.userQuestions
        : undefined;
    });
  } catch {
    questionSeam = undefined;
  }

  /**
   * Ask this Session's human before doing something on a colleague's behalf.
   *
   * Returns `null` when no confirmation is needed, or a refusal result when it was needed and did not happen. The caller
   * turns a refusal into an error for the model, which is what makes the check visible to the sender instead of silent.
   *
   * @param {object} exec - tool execution object, source of the live agent.
   * @param {string} toolName - the tool about to run.
   * @param {object} args - its arguments.
   * @returns {Promise<object|null>} a refusal payload, or null to proceed.
   */
  async function gateOnHuman(exec, toolName, args) {
    // Only the tools that ACT for the reader are gated. Reading a group or listing agents changes nothing a colleague
    // can see, and asking about them would train the person to click through prompts without reading.
    if (toolName !== 'a2a_group_post' && toolName !== 'a2a_send') return null;

    // Only an INBOUND task is gated.
    //
    // The observable signal is `replyTo`: a post that answers a specific message is, by definition, a response to
    // something a colleague sent. A post with no `replyTo` is the person's own new message, and asking them to approve
    // their own words would train them to click through prompts without reading — which is how a confirmation stops
    // being a confirmation.
    const inbound = typeof args?.replyTo === 'number';
    if (inbound !== true) return null;

    const verdict = confirmationPolicy({
      settings: deps.config,
      post: args,
      grade: args?.replyTo === undefined ? 'notice' : 'mention',
    });
    if (verdict.ask !== true) return null;
    if (verdict.reason === 'channel-unimplemented') {
      // Refuse loudly. Silently proceeding would remove the protection the person asked for.
      return {
        refused: true,
        reason: 'channel-unimplemented',
        message: '人工确认通道「即时通讯消息」尚未实现。请改用「界面提问」，或在设置中关闭人工确认。',
      };
    }

    const decision = decideFromAnswer(await askHuman({
      seam: questionSeam,
      agent: exec?.agent,
      question: confirmationQuestion({
        groupName: args?.groupName ?? '',
        sender: args?.from ?? '',
        text: args?.message ?? '',
      }),
      onTimeout: verdict.onTimeout,
      timeoutMs: verdict.timeoutMs,
    }));
    if (decision.proceed === true) return null;
    return {
      refused: true,
      reason: decision.reason,
      message: `这条动作需要你本人确认后才能执行，但没有得到许可（${decision.reason}）。`,
    };
  }

  const registered = [];
  for (const spec of allSpecs()) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: spec.output,
      // The human gate runs BEFORE the tool body, so a refusal costs nothing and is reported as a tool error the model
      // can read. Reading tools are untouched: `gateOnHuman` decides from the tool name and the arguments.
      execute: async (args, exec) => {
        const refusal = await gateOnHuman(exec, spec.name, args);
        if (refusal !== null) {
          // A refusal is an ERROR, not an empty success. Returning a normal result would let the model report "posted"
          // for something the person never approved.
          const error = new Error(`[human_confirm_${refusal.reason}] ${refusal.message}`);
          error.code = 'human_confirm_refused';
          error.data = { reason: refusal.reason };
          throw error;
        }
        return runtime.call(spec.name, args, callerOf(exec));
      },
    }));
    registered.push(spec.name);
  }

  // TEMPORARY PROBE — only when A2A_PROBE_EXEC is set. Deleted once the answer is recorded.
  //
  // The open question is narrow: a tool call made from a turn that a GROUP MESSAGE woke may not receive the same live
  // runtime root that a user-typed turn does. `ask()` refuses an owned child (`DELEGATED_CALLER`) and blocks forever, so
  // if group-woken turns get a different agent, "confirm before acting on a colleague's task" would hang exactly when
  // nobody is watching. This records enough to tell the two cases apart.
  if (typeof process !== 'undefined' && process.env !== undefined && process.env.A2A_PROBE_EXEC === '1') {
    ctx.tools.register(defineTool({
      name: 'a2a_probe_exec',
      description: 'TEMPORARY: report whether this turn has a live root agent able to ask its human a question.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: {
            written: { type: 'boolean' },
            agentId: { type: 'string' },
            owned: { type: 'boolean' },
            seam: { type: 'boolean' },
          },
        },
        render: (args, value) => [{
          type: 'text',
          text: `probe written=${value?.written === true} agent=${value?.agentId ?? '(none)'}`
            + ` owned=${value?.owned === true} seam=${value?.seam === true}`,
        }],
      },
      execute: async (args, exec) => {
        const report = {
          at: new Date().toISOString(),
          agentId: typeof exec?.agent?.id === 'string' ? exec.agent.id : null,
          agentKeys: exec?.agent !== null && exec?.agent !== undefined && typeof exec.agent === 'object'
            ? Object.keys(exec.agent)
            : null,
          agentLooksOwned: exec?.agent?.parent !== undefined || exec?.agent?.owner !== undefined
            || exec?.agent?.parentAgent !== undefined,
          agentParentType: typeof exec?.agent?.parent,
          // Is there a parent SESSION? A group-woken turn may be a fork of the Session rather than the root itself.
          sessionId: typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : null,
          sessionKeys: exec?.agent?.session !== null && exec?.agent?.session !== undefined
            && typeof exec.agent.session === 'object' ? Object.keys(exec.agent.session) : null,
          // The runtime context may name the wake source; recording it is how "woken by a group message" is proven.
          runtimeContext: (() => {
            try {
              return JSON.stringify(exec?.agent?.runtimeContext ?? null).slice(0, 400);
            } catch {
              return '(unserialisable)';
            }
          })(),
          seamProbed: false,
          seamAvailable: false,
          askIsFunction: false,
          askTimedIsFunction: false,
        };
        await new Promise((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          try {
            ctx.inject(['userQuestions'], (scoped) => {
              report.seamProbed = true;
              report.seamAvailable = scoped.userQuestions !== undefined && scoped.userQuestions !== null;
              report.askIsFunction = typeof scoped?.userQuestions?.ask === 'function';
              report.askTimedIsFunction = typeof scoped?.userQuestions?.askTimed === 'function';
              done();
            });
          } catch (error) {
            report.seamProbeError = String(error?.message ?? error);
            done();
          }
          setTimeout(done, 1500);
        });
        const { writeFileSync } = await import('node:fs');
        writeFileSync(process.env.A2A_PROBE_EXEC_FILE ?? 'a2a-probe-exec.json', JSON.stringify(report, null, 2), 'utf8');
        return {
          written: true,
          agentId: report.agentId ?? '',
          owned: report.agentLooksOwned === true,
          seam: report.askIsFunction === true,
        };
      },
    }));
    registered.push('a2a_probe_exec');
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
