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
  inboundQuestion,
  noticeFor,
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
   * Who wrote the message this post answers, if that can be learned without risk.
   *
   * The tool arguments carry only a seq, so the name has to be read back out of the group. For a group this instance
   * hosts that is a memory lookup; for a remote one it is a network call to the host's A2A endpoint.
   *
   * Every failure returns `''`, and the caller falls back to wording that names nobody. That asymmetry is deliberate: a
   * missing name makes the card slightly less informative, while a thrown error would make it impossible to answer at
   * all — and the whole point of this path is to let a person answer.
   *
   * @param {object} args - the tool arguments (`groupId`, `replyTo`).
   * @param {object} groupRow - the identity row, when the ledger knows this group.
   * @returns {Promise<string>} the sender's display name, or `''`.
   */
  async function lookedUpSender(args, groupRow) {
    const replyTo = typeof args?.replyTo === 'number' ? args.replyTo : undefined;
    const groupId = typeof args?.groupId === 'string' ? args.groupId : '';
    if (replyTo === undefined || groupId === '' || groupRow === undefined) return '';
    try {
      // Read exactly the one entry: `sinceSeq` is the seq before it, and a limit of 1 keeps the reply small.
      if (groupRow.local === true) {
        const member = deps.identities?.get?.(groupId, sessionId) ?? {
          personId: groupRow.personId,
          personKey: groupRow.personKey,
        };
        const page = deps.store?.read?.({ groupId, member, sinceSeq: replyTo - 1, limit: 1 });
        const entry = page?.entries?.[0];
        return typeof entry?.from?.displayName === 'string' ? entry.from.displayName : '';
      }
      const result = await deps.bridge.send(
        { baseUrl: groupRow.baseUrl, personKey: groupRow.personKey },
        {
          skill: 'group/read',
          text: `read ${groupId} at ${replyTo}`,
          data: {
            groupId,
            personId: groupRow.personId,
            personKey: groupRow.personKey,
            sinceSeq: replyTo - 1,
            limit: 1,
          },
        },
      );
      const entry = (result?.data?.entries ?? [])[0];
      if (entry === undefined) return '';
      return typeof entry.from === 'string' ? entry.from : (entry.from?.displayName ?? '');
    } catch {
      // Silent by design: an unavailable name must not block the question.
      return '';
    }
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

    // THE SESSION'S settings, not the profile's.
    //
    // This looked up `deps.config` only, which holds the profile default — `enabled: false` — so a person who enabled
    // confirmation for THIS conversation saw nothing happen: the gate read the default, decided "not enabled", and let
    // the reply through. Measured: a woken Session answered a colleague's message with replyTo set and no prompt
    // appeared, while session-settings.json clearly said enabled=true, trigger=always.
    const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : '';
    const profileDefault = deps.config?.groups?.humanConfirm ?? {};
    const resolved = deps.panelSettings !== undefined && deps.panelSettings !== null && sessionId !== ''
      ? deps.panelSettings.effectiveFor(sessionId, profileDefault)
      : { inherit: true, effective: profileDefault };
    const verdict = confirmationPolicy({
      settings: { groups: { humanConfirm: resolved.effective } },
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

    // The card shows what the person is actually being asked to approve.
    //
    // `a2a_group_post`'s arguments are `{ groupId, message, mentions, replyTo }` — there is no `from` and no `groupName`,
    // so an earlier version passed empty strings for both and the card fell back to 「一位同事」 / 「协作群」 / 「(没有正文)」
    // no matter what had really been said. Reported as 「不如 user question 总结得好」.
    //
    // Two things are worth showing, and they are different: the draft that would go out (`message`), and which group it
    // would land in (`groupId`, resolved to a name when the ledger knows it).
    const groupRow = typeof args?.groupId === 'string'
      ? deps.identities?.list?.().find((row) => row.groupId === args.groupId && row.groupName !== undefined)
      : undefined;
    // WHO is being answered, when it can be learned cheaply.
    //
    // The title is supposed to answer 「谁要你做什么」, and without a sender it can only say 「做什么」. The name is not in
    // the tool arguments, so it has to be read back from the group — which is a network call for a remote group.
    //
    // This is best-effort ON PURPOSE: a lookup failure must never turn a confirmation into an unanswerable card. On any
    // error the sender is simply omitted and the title falls back to the neutral wording.
    const repliedSender = await lookedUpSender(args, groupRow, sessionId);
    const decision = decideFromAnswer(await askHuman({
      seam: questionSeam,
      agent: exec?.agent,
      question: confirmationQuestion({
        groupName: groupRow?.groupName ?? '',
        draft: typeof args?.message === 'string' ? args.message : '',
        replyingTo: typeof args?.replyTo === 'number' ? args.replyTo : undefined,
        sender: repliedSender,
      }),
      onTimeout: verdict.onTimeout,
      timeoutMs: verdict.timeoutMs,
    }));
    if (decision.proceed === true) return null;

    // TELL THE COLLEAGUE, THEN REFUSE.
    //
    // The person chose 「稍后处理」 or 「拒绝」. Either way a colleague is left waiting on a message that will never
    // arrive, and silence is the one answer they cannot interpret — it reads as ignored, slow, or broken, and none of
    // those is what was chosen. So a one-line notice goes to the group first, and only then does the tool fail.
    //
    // This notify post is NOT gated. It runs inside the gate that was just answered, and asking again would loop.
    // It is best-effort: if it fails, the refusal still stands — the person's decision is not undone by a network error.
    if (decision.notify === 'defer' || decision.notify === 'refuse') {
      try {
        await runtime.call('a2a_group_post', {
          groupId: args.groupId,
          message: noticeFor({
            kind: decision.notify,
            draft: typeof args?.message === 'string' ? args.message : '',
            sender: repliedSender,
          }),
        }, callerOf(exec));
      } catch (error) {
        deps.logger?.warn?.(`human-confirm notice not delivered: ${String(error?.message ?? error)}`);
      }
    }
    return {
      refused: true,
      reason: decision.reason,
      message: decision.notify === 'defer'
        ? '用户选择了稍后处理，并且已经把这件事告诉了对方。不要再重试或改用别的方式发送。'
        : '用户拒绝了这次回复，并且已经告诉了对方。不要再重试。',
    };
  }

  const registered = [];
  /**
   * Hand a held-back message over, but only after this Session's human says yes.
   *
   * This is the other half of the content gate. Delivery replaced the body with a stub because the
   * seam that asks a human needs a LIVE AGENT and delivery happens outside any turn. Here there IS a
   * turn, so the question can be asked properly — and until it is answered, the body stays in the
   * queue rather than in the model's context.
   *
   * A refusal keeps the entry: 「稍后处理」 means later, and the post is still in the group. The TTL
   * in the queue is what eventually forgets it.
   *
   * @param {object} input - `{ groupId, seq, sessionId, agent }`.
   * @returns {Promise<object>} `{ approved, text?, sender?, seq, reason? }`.
   */
  async function confirmInbound(input) {
    const queue = deps.pendingInbound;
    if (queue === undefined || queue === null) {
      return { approved: false, seq: input.seq, reason: 'no-queue' };
    }
    const entry = queue.get(input.sessionId, input.groupId, input.seq);
    if (entry === undefined) {
      // Nothing waiting: either already handed over, or this Session was never the one holding it.
      // Reporting that plainly beats returning an empty body the model might read as 「empty message」.
      return { approved: false, seq: input.seq, reason: 'nothing-pending' };
    }
    const sessionId = input.sessionId;
    const profileDefault = deps.config?.groups?.humanConfirm ?? {};
    const resolved = deps.panelSettings !== undefined && deps.panelSettings !== null && sessionId !== ''
      ? deps.panelSettings.effectiveFor(sessionId, profileDefault)
      : { inherit: true, effective: profileDefault };
    const effective = resolved.effective ?? profileDefault;
    const decision = decideFromAnswer(await askHuman({
      seam: questionSeam,
      agent: input.agent,
      question: inboundQuestion({
        groupName: entry.groupName,
        sender: entry.sender,
        text: entry.text,
        seq: entry.seq,
      }),
      onTimeout: effective.onTimeout ?? 'deny',
      timeoutMs: Number.isFinite(effective.timeoutMs) ? effective.timeoutMs : 300000,
    }));
    if (decision.proceed !== true) {
      return { approved: false, seq: entry.seq, reason: decision.reason ?? 'denied' };
    }
    queue.remove(sessionId, input.groupId, input.seq);
    return { approved: true, text: entry.text, sender: entry.sender, seq: entry.seq };
  }

  for (const spec of allSpecs()) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: spec.output,
      // Presentation hooks. A tool call is rendered by the UI from these or, without them, from the
      // tool name plus its first argument — which is why posting to a group showed up as
      // 「a2a_group_post · g-1fad9113」: an internal id, no group name, no indication of who was woken.
      presentCall: spec.presentCall,
      presentResult: spec.presentResult,
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
        // This tool IS the gate, so it runs here rather than in the shared runtime: asking a human is a
        // host capability (`ctx.userQuestions`), and the MCP adapter has nobody to ask.
        if (spec.name === 'a2a_confirm_inbound') {
          const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : '';
          return confirmInbound({
            groupId: String(args?.groupId ?? ''),
            seq: Number(args?.seq ?? 0),
            sessionId,
            agent: exec?.agent,
          });
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
