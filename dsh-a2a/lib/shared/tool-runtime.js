/**
 * Every tool's execution, host-agnostic.
 *
 * The DSH adapter (`tools.js`) and the MCP server (`mcp-server.js`) both call
 * `call(name, args, caller)`. What differs between them is only how they reach this
 * function:
 *
 *   DSH  → exec.agent.id            → caller.sessionId
 *   MCP  → the connection's identity → caller.sessionId
 *
 * That single mapping is why the logic lives here rather than in either adapter. Two
 * copies of nineteen tool bodies would drift, and the drift would show up as a tool that
 * behaves differently depending on which client called it.
 *
 * Dependencies arrive as parameters rather than as closures over a plugin context: the
 * same reason. A host that is not DSH has no `ctx` to close over.
 *
 * @module dsh-a2a/tool-runtime
 */

import { parseInviteLink } from '../dsh/tools.js';
import { probeReachability } from '../core/probe.js';
// The member's own address, composed from the MEMBER's config — this file runs on the member's
// machine when it joins, which is the only process that knows this.
import { ownEndpointFromConfig } from '../core/endpoint.js';

/**
 * Build the runtime over one set of dependencies.
 *
 * @param {object} deps - `{ config, registry, bridge, store, identities, server, sessions, logger, inbox }`.
 * @returns {{call: (name: string, args: object, caller?: object) => Promise<object>, has: (name: string) => boolean, names: () => string[]}} the runtime.
 */
export function createToolRuntime(deps = {}) {
  const { config, registry, bridge, store, identities, server, sessions, logger, inbox } = deps;

/** A non-empty string argument, or a coded error. */
function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw coded('invalid_arguments', `"${name}" must be a non-empty string`);
  }
  return value;
}

/** Parse an optional JSON-object argument supplied as a string. */
function parseJsonObject(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    throw coded('invalid_arguments', '"data" must be a JSON object');
  }
}

/** An error carrying a stable code. */
function coded(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

/** Shorten a string for a one-line summary. */
function truncate(text, limit) {
  const single = String(text).replace(/\s+/g, ' ').trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}

/** Join a gateway base and an agent name. */
function joinUrl(base, agent) {
  return `${String(base).replace(/\/+$/, '')}/${String(agent).replace(/^\/+/, '')}`;
}

/**
 * Resolve a tool's `agent` argument to a bridge target.
 *
 * A raw URL and a registered name are both accepted because a user who pastes a
 * link should not have to register it first.
 */
function resolveTarget(registry, config, reference) {
  const text = requireText(reference, 'agent');
  if (/^https?:\/\//i.test(text)) {
    return {
      baseUrl: text,
      apiKey: config.client.apiKey,
      forwardProto: config.client.forwardProto,
      protocolVersion: config.client.protocolVersion,
    };
  }
  const entry = registry.get(text);
  if (entry === undefined) {
    throw coded('unknown_agent', `"${text}" is not a registered A2A agent; run a2a_agents to list them, or pass a full URL`);
  }
  return {
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey ?? config.client.apiKey,
    forwardProto: config.client.forwardProto,
    protocolVersion: entry.protocolVersion ?? config.client.protocolVersion,
  };
}

/** The bridge target for a joined (remote) membership. */
/**
 * The full address of a group host, from the two facts an invite link carries.
 *
 * `gw` is the gateway root and `agent` is the entry under it; the callable address is both. Keeping only
 * `gw` produces a path the gateway answers 404 for, because routing happens on `/a2a/<agent>`.
 *
 * An absent agent is left alone rather than guessed: a link that names no agent may be pointing straight
 * at a host (local development), where `gw` alone IS the address.
 *
 * @param {string} [base] the gateway base, e.g. `http://gw:3000/a2a`.
 * @param {string} [agent] the agent name, e.g. `agent-group-host`.
 * @returns {string|undefined} the address to call.
 */
function composeMemberBase(base, agent) {
  const trimmed = typeof base === 'string' ? base.replace(/\/+$/u, '') : '';
  if (trimmed === '') return undefined;
  const name = typeof agent === 'string' ? agent.trim() : '';
  if (name === '') return trimmed;
  // Already carries its agent (a hand-written `url` link, or a re-join of an older record).
  if (trimmed.endsWith('/' + name)) return trimmed;
  return trimmed + '/' + name;
}

function targetOf(membership, config) {
  return {
    baseUrl: membership.baseUrl ?? config.groups.gatewayBase,
    apiKey: config.client.apiKey,
    forwardProto: config.client.forwardProto,
    protocolVersion: config.client.protocolVersion,
  };
}

/**
 * The host a group lives on, for the paths that have no membership record yet.
 *
 * `a2a_group_request` runs BEFORE the applicant is a member, so there is no
 * `memberships.json` row to read a `baseUrl` from. The address therefore comes from
 * the caller (a registered agent name or a URL) or, failing that, from the
 * configured group host. This is the one place the plugin has to guess, and it
 * guesses only where the config says the host is.
 */
function hostTarget(registry, config, reference) {
  if (typeof reference === 'string' && reference !== '') {
    return resolveTarget(registry, config, reference);
  }
  if (config.groups.gatewayBase === '' || config.groups.agentName === '') {
    throw coded(
      'missing_endpoint',
      'this tool needs to know which host to talk to: pass `agent`, or configure groups.gatewayBase + groups.agentName.',
    );
  }
  return {
    baseUrl: joinUrl(config.groups.gatewayBase, config.groups.agentName),
    apiKey: config.client.apiKey,
    forwardProto: config.client.forwardProto,
    protocolVersion: config.client.protocolVersion,
  };
}

/** The gateway entry this instance needs, as YAML an operator can paste. */
function gatewayEntryFor(info, config) {
  return [
    'a2a_agents:',
    `  - name: "${config.groups.agentName || 'my-dsh'}"`,
    `    url: "${info.url}"`,
    `    protocol_version: "${info.protocolVersion}"`,
    '    auth_type: api_key',
    `    secret: "${info.tokenConfigured ? '<server.token from this profile>' : '<set server.token first, or this only works from loopback>'}"`,
    '    timeout_ms: 600000',
    '    enabled: true',
  ].join('\n');
}

/**
 * A local membership record for THIS Session, or a coded error.
 *
 * The Session is required: two Sessions of one instance may both be members of the
 * same group, and picking "the first record" would administer somebody else's
 * membership.
 */
function requireLocalMembership(identities, groupId, sessionId) {
  const record = identities.get(groupId, sessionId);
  if (record === undefined) {
    throw coded('unknown_group', `this Session has not joined "${groupId}"; run a2a_groups to list the groups it belongs to`);
  }
  if (record.local !== true) {
    throw coded('not_hosted_here', `"${groupId}" is hosted elsewhere; only this instance's own groups can be administered here`);
  }
  return record;
}

/** A membership record for any group, hosted here or joined elsewhere, for THIS Session. */
  /**
   * Every distinct person identity this Session holds, with one membership per identity.
   *
   * A person gets a DIFFERENT personId in each group (`group/join` allocates one per membership), so a personal
   * inbox is really "one inbox per identity". The first one is not a stand-in for the rest: an invitation addressed to
   * the identity in group B is invisible when only group A is asked.
   *
   * Grouped by personId because the same identity can appear under two memberships after a rejoin, and a single
   * message must not be counted twice.
   *
   * @param {object} identities - the membership ledger.
   * @param {string} sessionId - which Session.
   * @returns {Array<{personId: string, memberships: object[]}>} one entry per identity.
   */
  function identitiesOf(identities, sessionId) {
    if (identities === undefined || identities === null || typeof identities.list !== 'function') return [];
    const byPerson = new Map();
    for (const membership of identities.list({ sessionId })) {
      const personId = typeof membership.personId === 'string' ? membership.personId : '';
      if (personId === '') continue;
      const bucket = byPerson.get(personId);
      if (bucket === undefined) {
        byPerson.set(personId, { personId, memberships: [membership] });
      } else {
        bucket.memberships.push(membership);
      }
    }
    return [...byPerson.values()];
  }


function requireMembership(store, identities, groupId, sessionId) {
  const record = identities.get(groupId, sessionId);
  if (record !== undefined) return record;
  // A group hosted by this instance but not in the ledger should not happen (the
  // ledger is written when the group is created), and guessing a credential here
  // would be worse than saying so.
  if (store.has?.(groupId) === true) {
    throw coded('missing_identity', `"${groupId}" is hosted here but this Session has no stored credential for it; join it again`);
  }
  throw coded('unknown_group', `"${groupId}" is not one of this Session's groups; run a2a_groups to list them`);
}

/** Hosted-group summaries as a map, tolerant of a store that cannot list. */
function safeList(store, identities) {
  const map = new Map();
  try {
    for (const group of store.list() ?? []) map.set(group.groupId, group);
  } catch (error) {
    loggerless(error);
  }
  void identities;
  return map;
}

/** A one-line summary of the last message in a group summary. */
function lastMessageOf(summary, record) {
  const entry = summary?.feedTail?.at?.(-1);
  if (entry !== undefined && typeof entry.text === 'string') {
    return `${entry.from?.displayName ?? '?'}: ${truncate(entry.text, 120)}`;
  }
  void record;
  return '';
}

/** The registry as the flat list the tool returns. */
function listEntries(registry) {
  return registry.list().map((entry) => ({
    name: entry.name,
    baseUrl: entry.baseUrl,
    enabled: entry.enabled !== false,
    note: entry.note ?? '',
  }));
}

/** Swallow a diagnostic-only failure; the caller already has a fallback. */
function loggerless() {}

/** A one-line summary of the last message in a group summary. */
function lastMessageOf(summary, record) {
  const entry = summary?.feedTail?.at?.(-1);
  if (entry !== undefined && typeof entry.text === 'string') {
    return `${entry.from?.displayName ?? '?'}: ${truncate(entry.text, 120)}`;
  }
  void record;
  return '';
}


/**
 * The display name to record for the caller when they did not supply one.
 *
 * A display name is shown to every member in the group feed, so it has to read as a person.
 * A Session id does not: `session-1f3a9c` in a member list looks like a bug, and it also
 * leaks an internal identifier to everybody in the group.
 *
 * Order: an explicit name the adapter knows, then the store default. Returning `undefined`
 * rather than throwing is deliberate — creating a group must not fail because nobody has
 * named themselves yet, and the owner can rename themselves afterwards.
 *
 * @param {object} exec - the tool execution context from the host adapter.
 * @returns {string|undefined} a name, or undefined to let the store default apply.
 */
function displayNameOf(exec) {
  if (exec === null || typeof exec !== 'object') return undefined;
  // Adapters differ in where they expose the signed-in person; take the first usable one.
  const candidates = [
    exec.displayName,
    exec.agent?.displayName,
    exec.agent?.name,
    exec.user?.displayName,
    exec.user?.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  // Undefined means "use the store default", keeping that decision in one place.
  return undefined;
}

/**
 * The gateway agent name this host is registered under, if configured.
 *
 * Used only to word the "next steps" hint after creating a group, whose point is that a new
 * group needs no new gateway entry. An unconfigured host gets `undefined`, so the caller words
 * the hint without a name instead of printing "undefined".
 *
 * @param {object} config - normalized config.
 * @returns {string|undefined} the agent name.
 */
function settingsAgentName(config) {
  const name = config?.groups?.agentName;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined;
}

/**
 * The caller behind a tool invocation.
 *
 * Hosts differ in how they name the caller: DSH puts a Session id at `exec.agent.id`,
 * while an MCP connection has an id of its own and no Session at all. Both are reduced to
 * `{ id }` here, so every tool body can stay host-agnostic.
 *
 * A tool that genuinely needs a Session (all the group mutators do, because a membership
 * belongs to one) calls `requireSession`, which explains itself when the host cannot
 * supply one.
 *
 * @param {object} exec - `{ agent?: { id }, sessionId?: string }`.
 * @returns {{id: string|undefined}} the caller.
 */
function senderOf(exec) {
  if (exec === null || typeof exec !== 'object') return { id: undefined };
  if (typeof exec.sessionId === 'string' && exec.sessionId !== '') return { id: exec.sessionId };
  const agent = exec.agent;
  const id = agent !== null && typeof agent === 'object' && typeof agent.id === 'string' ? agent.id : undefined;
  return { id };
}

/**
 * A tool call must name its caller.
 *
 * Every group operation is scoped to one conversation, and a membership belongs to one —
 * so a host that cannot say who is calling cannot be served correctly. Failing loudly
 * beats guessing: a wrong guess would act on somebody else's membership.
 *
 * @param {string|undefined} sessionId - the caller's identity.
 * @param {string} tool - tool name, for the message.
 * @returns {string} the id.
 */
function requireSession(sessionId, tool) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw coded('no_session', `${tool} needs to know which conversation is calling, and the host did not provide one`);
  }
  return sessionId;
}

  /**
   * The caller acting through this tool.
   *
   * `sessionId` is what a DSH Session contributes; a host without Sessions passes a
   * stable id of its own (an MCP connection's id, say), which is enough because the group
   * tools only need something consistent to key a membership by.
   */
  const normaliseCaller = (caller) => {
    if (caller === null || typeof caller !== 'object') return { sessionId: undefined };
    return { sessionId: typeof caller.sessionId === 'string' ? caller.sessionId : undefined };
  };

  /** Every tool body, keyed by name. */
  const HANDLERS = {
  'a2a_agents': async function a2a_agents(args, exec) {
    const action = args.action ?? 'list';
    if (action === 'add') {
      const name = requireText(args.name, 'name');
      const entry = args.gatewayBase !== undefined && args.agent !== undefined
        ? { name, baseUrl: joinUrl(args.gatewayBase, args.agent), note: args.note, apiKey: args.apiKey }
        : { name, baseUrl: requireText(args.baseUrl, 'baseUrl, or gatewayBase together with agent'), note: args.note, apiKey: args.apiKey };
      registry.upsert(entry);
      await registry.flush();
      return { agents: listEntries(registry), changed: `added ${name}` };
    }
    if (action === 'remove') {
      const name = requireText(args.name, 'name');
      const removed = registry.remove(name);
      await registry.flush();
      return { agents: listEntries(registry), changed: removed ? `removed ${name}` : `${name} was not registered` };
    }
    return { agents: listEntries(registry) };
  },
  'a2a_discover': async function a2a_discover(args, exec) {
    const target = resolveTarget(registry, config, args.agent);
    const card = await bridge.discover(target);
    return {
      name: card.name,
      url: card.url,
      protocolVersion: card.protocolVersion ?? config.client.protocolVersion,
      streaming: card.capabilities?.streaming === true,
      skills: (card.skills ?? []).map((skill) => ({
        id: skill.id,
        name: skill.name ?? skill.id,
        description: skill.description ?? '',
      })),
    };
  },
  'a2a_send': async function a2a_send(args, exec) {
    // The schema marks message required, but the schema is enforced by whichever caller builds the arguments —
    // a model composing a call is not a validator. Without this a missing message reaches the peer as an empty
    // body, and the failure surfaces there instead of here.
    const message = requireText(args.message, 'message');
    const target = resolveTarget(registry, config, args.agent);
    const result = await bridge.send(target, {
      skill: args.skill ?? 'session/ask',
      text: message,
      data: parseJsonObject(args.data),
      timeoutMs: args.timeoutMs ?? config.client.timeoutMs,
      from: senderOf(exec).id,
    });
    return { state: result.state, text: result.text, taskId: result.taskId };
  },
  'a2a_stream': async function a2a_stream(args, exec) {
    const target = resolveTarget(registry, config, args.agent);
    const events = [];
    const result = await bridge.stream(target, {
      skill: args.skill ?? 'session/ask',
      text: args.message,
      data: parseJsonObject(args.data),
      from: senderOf(exec).id,
      onEvent: (event) => {
        if (event?.type === 'artifact' || event?.type === 'status') events.push(event);
      },
    });
    const printed = events
      .filter((event) => event.type === 'status' && typeof event.note === 'string' && event.note !== '')
      .map((event) => `· ${event.note}`);
    return {
      state: result.state,
      text: printed.length === 0 ? result.text : `${printed.join('\n')}\n\n${result.text}`,
      events: events.length,
    };
  },
  'a2a_person_send': async function a2a_person_send(args, exec) {
    const sessionId = requireSession(senderOf(exec).id, 'a2a_person_send');
    const to = requireText(args.to, 'to');
    const kind = requireText(args.kind, 'kind');
    // The sender is whoever this Session is in the group the message is about. For an invitation that
    // group is required, because the credential comes from it and the link is scoped to it.
    const groupId = typeof args.groupId === 'string' && args.groupId !== ''
      ? args.groupId
      : requireText(args.groupId, 'groupId for a group invitation');
    const membership = requireMembership(store, identities, groupId, sessionId);
    if (membership.local === true) {
      const sent = store.sendPersonMessage({
        fromPersonId: membership.personId,
        toPersonId: to,
        kind,
        text: args.text ?? '',
        payload: undefined,
      });
      await store.flush();
      return { dmId: sent.dmId, online: store.isPersonOnline(to), kind };
    }
    const result = await bridge.send(targetOf(membership, config), {
      skill: 'person/send',
      text: `send ${kind} to ${to}`,
      data: {
        groupId,
        personId: membership.personId,
        personKey: membership.personKey,
        fromPersonId: membership.personId,
        toPersonId: to,
        kind,
        text: args.text,
      },
      timeoutMs: config.client.timeoutMs,
    });
    const meta = result.data ?? {};
    return {
      dmId: typeof meta.dmId === 'string' ? meta.dmId : '',
      online: meta.online === true,
      kind,
    };
  },

  'a2a_person_inbox': async function a2a_person_inbox(args, exec) {
    const sessionId = requireSession(senderOf(exec).id, 'a2a_person_inbox');
    const identitiesHeld = identitiesOf(identities, sessionId);
    if (identitiesHeld.length === 0) {
      throw coded('not_member', '这个会话还没有加入任何协作群，因此没有收件箱。');
    }

    // One inbox per identity, and every one of them counts. A local membership is answered from this process; a
    // remote one is asked over the wire. Both are this person's mail.
    const collected = [];
    for (const held of identitiesHeld) {
      const localMembership = held.memberships.find((membership) => membership.local === true);
      if (localMembership !== undefined) {
        for (const message of store.listPersonMessages({ personId: held.personId, since: args.since })) {
          collected.push(message);
        }
        continue;
      }
      const remoteMembership = held.memberships[0];
      try {
        const result = await bridge.send(targetOf(remoteMembership, config), {
          skill: 'person/inbox',
          text: 'inbox',
          data: { personId: held.personId, since: args.since },
          timeoutMs: config.client.timeoutMs,
        });
        const meta = result.data ?? {};
        if (Array.isArray(meta.messages)) collected.push(...meta.messages);
      } catch {
        // One unreachable host must not hide the mail held by the others; the caller sees what could be read.
      }
    }

    // Newest first and de-duplicated by dmId: the same identity reached through two memberships must not report the
    // same message twice.
    const seen = new Set();
    const messages = [];
    for (const message of collected.sort((left, right) => (right.at ?? 0) - (left.at ?? 0))) {
      const id = typeof message.dmId === 'string' ? message.dmId : '';
      if (id !== '' && seen.has(id)) continue;
      if (id !== '') seen.add(id);
      messages.push(message);
    }
    return { messages };
  },

  'a2a_person_ack': async function a2a_person_ack(args, exec) {
    const sessionId = requireSession(senderOf(exec).id, 'a2a_person_ack');
    const dmIds = Array.isArray(args.dmIds) ? args.dmIds.filter((id) => typeof id === 'string') : [];
    if (dmIds.length === 0) throw coded('bad_argument', 'Nothing to confirm: dmIds is empty.');

    const identitiesHeld = identitiesOf(identities, sessionId);
    if (identitiesHeld.length === 0) {
      throw coded('not_member', '这个会话还没有加入任何协作群，因此没有收件箱。');
    }

    // Confirm on EVERY identity, because there is no way to know which one the message was addressed to: the caller
    // has a list of ids, not a host. Sending the ack to one side and stopping would leave the message pending
    // elsewhere, and the sender would never learn it arrived.
    let acked = 0;
    const unknown = [];
    for (const held of identitiesHeld) {
      const localMembership = held.memberships.find((membership) => membership.local === true);
      if (localMembership !== undefined) {
        const result = store.ackPersonMessages({ personId: held.personId, dmIds });
        acked += Number.isFinite(result?.acked) ? result.acked : 0;
        if (Array.isArray(result?.unknown)) unknown.push(...result.unknown);
        continue;
      }
      try {
        const result = await bridge.send(targetOf(held.memberships[0], config), {
          skill: 'person/ack',
          text: 'ack',
          data: { personId: held.personId, dmIds },
          timeoutMs: config.client.timeoutMs,
        });
        const meta = result.data ?? {};
        acked += Number.isFinite(meta.acked) ? meta.acked : 0;
        if (Array.isArray(meta.unknown)) unknown.push(...meta.unknown);
      } catch {
        // A host that cannot be reached simply does not confirm; the message stays pending there, which is correct.
      }
    }
    await store.flush();
    return { acked, unknown: [...new Set(unknown)] };
  },

  'a2a_pending': async function a2a_pending(args, exec) {
    const sessionId = requireSession(senderOf(exec).id, 'a2a_pending');
    const includeGroups = args.includeGroups !== false;

    // Direct messages first: an invitation blocks progress, a group message does not.
    // Direct messages first: an invitation blocks progress, a group message does not.
    //
    // Every identity, not the first one: a person has a different personId per group, so an invitation waiting on
    // another host is invisible when only one membership is consulted — and an invitation is the message kind that
    // actually stops somebody.
    const directMessages = [];
    const seenIds = new Set();
    for (const held of identitiesOf(identities, sessionId)) {
      const localMembership = held.memberships.find((membership) => membership.local === true);
      try {
        if (localMembership !== undefined) {
          for (const message of store.listPersonMessages({ personId: held.personId })) {
            // Only unconfirmed ones count as pending: a message already acked has been delivered and read.
            if (message.deliveredAt !== undefined) continue;
            const id = typeof message.dmId === 'string' ? message.dmId : '';
            if (id !== '' && seenIds.has(id)) continue;
            if (id !== '') seenIds.add(id);
            directMessages.push({ dmId: message.dmId, kind: message.kind, text: message.text });
          }
          continue;
        }
        const result = await bridge.send(targetOf(held.memberships[0], config), {
          skill: 'person/inbox',
          text: 'inbox',
          data: { personId: held.personId },
          timeoutMs: config.client.timeoutMs,
        });
        const list = Array.isArray(result?.data?.messages) ? result.data.messages : [];
        for (const message of list) {
          if (message.deliveredAt !== undefined) continue;
          const id = typeof message.dmId === 'string' ? message.dmId : '';
          if (id !== '' && seenIds.has(id)) continue;
          if (id !== '') seenIds.add(id);
          directMessages.push({ dmId: message.dmId, kind: message.kind, text: message.text });
        }
      } catch {
        // An unreachable host must not make this probe throw: the whole point is that it is cheap and safe to call
        // often. An empty contribution is honest — the caller still gets what the other hosts reported.
      }
    }

    // Then groups with unread messages. Unread is "the host's head minus what this Session last read", which
    // is already how the panel counts it — computed the same way here so the two agree.
    const groups = [];
    if (includeGroups === true) {
    for (const record of identities.list({ sessionId })) {
        if (record.local !== true) {
          // A remote group's head is only known after a read; without one there is no honest unread count, and
          // inventing zero would hide new messages. Reported as unknown rather than as zero.
          continue;
        }
        let head = 0;
        let name = record.groupName ?? record.groupId;
        try {
          const summary = store.snapshot({ groupId: record.groupId, member: { personId: record.personId, personKey: record.personKey } });
          head = summary.lastSeq ?? 0;
          name = summary.name ?? name;
        } catch {
          continue;
        }
        const seen = Number.isFinite(record.lastSeq) ? record.lastSeq : 0;
        const unread = Math.max(0, head - seen);
        if (unread > 0) groups.push({ groupId: record.groupId, name, unread });
      }
    }

    return {
      total: directMessages.length + groups.reduce((sum, entry) => sum + entry.unread, 0),
      directMessages,
      groups,
      summary: directMessages.length === 0 && groups.length === 0
        ? 'Nothing waiting.'
        : `${directMessages.length} direct message(s), ${groups.length} group(s) with unread.`,
    };
  },

  'a2a_group_create': async function a2a_group_create(args, exec) {
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_create');
    const name = requireText(args.name, 'name');
    const topic = args.topic ?? '';
    const visibility = args.visibility === 'unlisted' ? 'unlisted' : 'public';

    // A local store with groups enabled means this instance is itself a host. That
    // is the rarer setup now, but it stays supported: a single machine can host its
    // own groups with no gateway at all.
    const hostedHere = config.groups.embedded === true;
    const target = hostedHere ? undefined : hostTarget(registry, config, args.agent);

    let groupId;
    let personId;
    let ownerKey;
    let groupName;
    let remote;

    if (hostedHere) {
      const created = store.create({
        name,
        topic,
        ownerDisplayName: displayNameOf(exec),
        settings: { visibility },
      });
      groupId = created.group.groupId;
      personId = created.group.owner.personId;
      ownerKey = created.ownerKey;
      groupName = created.group.name;
      remote = false;
    } else {
      const result = await bridge.send(target, {
        skill: 'group/create',
        text: `create a group named ${name}`,
        data: {
          name,
          topic,
          ownerDisplayName: displayNameOf(exec),
          // The skill reads this from the top level, not from a nested settings bag.
          visibility,
        },
        timeoutMs: config.client.timeoutMs,
      });
      const meta = result.data ?? {};
      groupId = meta.groupId;
      personId = meta.personId;
      ownerKey = meta.ownerKey;
      groupName = meta.name ?? name;
      remote = true;
      if (typeof groupId !== 'string' || groupId === '') {
        throw coded('bad_response', 'the group host did not return a groupId; check that the host runs a compatible agent-groups version');
      }
    }

    // The membership record belongs to the Session that created the group: it is the
    // owner, and it is where invite/approve calls will be issued from.
    identities.upsert({
      sessionId,
      groupId,
      personId,
      personKey: ownerKey,
      local: remote === false,
      baseUrl: remote === true ? target.baseUrl : undefined,
      groupName,
      role: 'owner',
      lastSeq: 0,
    });
    await identities.flush();
    if (remote === false) await store.flush();

    const gatewayName = settingsAgentName(config);
    return {
      groupId,
      name: groupName,
      personId,
      ownerKey,
      agentName: gatewayName,
      remote,
      nextSteps: remote === true
        ? 'Next: a2a_group_invite to mint an invite link and a paste-ready message for a colleague.'
          + `\nThe host serves every group under one gateway entry (${gatewayName ?? 'not configured'}); a new group needs no gateway change.`
        : 'Next: a2a_group_invite to mint an invite link and a paste-ready message for a colleague.'
          + '\nThis group lives on this instance, so colleagues reach it directly or through a gateway you configure.',
    };
  },
  'a2a_group_invite': async function a2a_group_invite(args, exec) {
    const groupId = requireText(args.groupId, 'groupId');
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_invite');
    const membership = identities.get(groupId, sessionId);
    if (membership === undefined) {
      throw coded('unknown_group', `this Session has not joined "${groupId}"; run a2a_groups to list the groups it belongs to`);
    }
    // A group hosted elsewhere: the host owns the token table, so it mints. The owner credential travels
    // with the call and the host verifies it — this instance does not gain authority it does not have.
    if (membership.local !== true) {
      const target = targetOf(membership, config);
      // invite via bridge: the host is the only process that can mint a link it will itself accept.
      const result = await bridge.send(target, {
        skill: 'group/invite',
        text: 'invite for ' + groupId,
        data: {
          groupId,
          personId: membership.personId,
          personKey: membership.personKey,
          label: args.label,
          expiresInHours: args.expiresInHours,
        },
        timeoutMs: config.client.timeoutMs,
      });
      const meta = result.data ?? {};
      const link = typeof meta.link === 'string' ? meta.link : '';
      if (link === '') {
        throw coded('bad_response', 'the host did not return an invite link');
      }
      return {
        groupId,
        link,
        prompt: typeof meta.prompt === 'string' ? meta.prompt : link,
        expiresAt: meta.expiresAt,
        inviteId: meta.inviteId,
      };
    }

    const issued = store.invite({
      groupId,
      label: args.label,
      expiresInHours: args.expiresInHours ?? config.groups.inviteExpiresInHours,
      // The owner credential, not just the role: the store verifies it, so a
      // display-field role being wrong cannot mint an invite.
      ownerKey: membership.personKey,
      gatewayBase: config.groups.gatewayBase === '' ? undefined : config.groups.gatewayBase,
      agent: config.groups.agentName === '' ? undefined : config.groups.agentName,
    });
    await store.flush();
    return {
      link: issued.link,
      prompt: issued.prompt,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      neverExpires: issued.expiresAt === null,
    };
  },
  'a2a_group_join': async function a2a_group_join(args, exec) {
    // The Session that joins is the member: two Sessions of one instance may join
    // the same group as two distinct members, each with its own credential.
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_join');
    const displayName = args.displayName ?? senderOf(exec).id ?? 'member';
    // A link carries the gateway target as well as the group, so a remote group
    // needs no separate registration step — that is the point of the link.
    const parsed = typeof args.link === 'string' && args.link !== ''
      ? parseInviteLink(args.link)
      : { groupId: requireText(args.groupId, 'groupId'), token: args.token, baseUrl: undefined, groupName: undefined };

    const local = store.has?.(parsed.groupId) === true;
    if (local) {
      const joined = store.join({
        groupId: parsed.groupId,
        token: parsed.token,
        displayName,
        // Same reasoning as the remote path: this process knows its own address.
        endpoint: ownEndpointFromConfig(config),
      });
      identities.upsert({
        sessionId,
        groupId: parsed.groupId,
        personId: joined.member.personId,
        personKey: joined.personKey,
        local: true,
        groupName: joined.group.name,
        role: joined.member.role,
        lastSeq: joined.group.lastSeq ?? 0,
      });
      await store.flush();
      await identities.flush();
      return {
        groupId: parsed.groupId,
        groupName: joined.group.name,
        personId: joined.member.personId,
        remote: false,
        recentMessages: joined.feedTail.length,
      };
    }

    // The link already says which gateway and which agent host the group, so a
    // colleague needs nothing configured on their side: paste the link, say the
    // password. The configured gatewayBase is only a fallback for a hand-written
    // link that omitted it.
    // The link splits the address in two (`gw` + `agent`) because they are two facts; the ledger needs
    // one callable string, so they are joined here rather than at every use site.
    const baseUrl = parsed.endpoint
      ?? composeMemberBase(
        parsed.gatewayBase ?? (config.groups.gatewayBase === '' ? undefined : config.groups.gatewayBase),
        parsed.agent,
      );
    if (baseUrl === undefined || baseUrl === '') {
      throw coded(
        'missing_endpoint',
        'this invite link carries no gateway address, and no groups.gatewayBase is configured to fall back on. Ask the group owner for a fresh link.',
      );
    }
    const target = {
      baseUrl,
      apiKey: config.client.apiKey,
      forwardProto: config.client.forwardProto,
      protocolVersion: config.client.protocolVersion,
    };
    const result = await bridge.send(target, {
      skill: 'group/join',
      text: `join ${parsed.groupId}`,
      data: {
        groupId: parsed.groupId,
        token: parsed.token,
        displayName,
        // Our own address, so the host can record where to reach us. Composed here rather than
        // there: the host process only knows its own name, and composing from it recorded every
        // member at the host's address.
        //
        // Omitted when unconfigured, which the host reads as "no address" — the honest answer,
        // since nothing can dial a member that has no gateway name.
        endpoint: ownEndpointFromConfig(config),
      },
      timeoutMs: config.client.timeoutMs,
    });
    const meta = result.data ?? {};
      sessionId,
    identities.upsert({
      sessionId,
      groupId: parsed.groupId,
      personId: meta.personId,
      personKey: meta.personKey,
      local: false,
      baseUrl,
      groupName: meta.groupName ?? parsed.groupName,
      role: 'member',
      lastSeq: meta.lastSeq ?? 0,
    });
    await identities.flush();
    if (inbox !== undefined) await inbox.enable(parsed.groupId);
    return {
      groupId: parsed.groupId,
      groupName: meta.groupName ?? parsed.groupName ?? parsed.groupId,
      personId: meta.personId,
      remote: true,
      recentMessages: Array.isArray(meta.feedTail) ? meta.feedTail.length : 0,
    };
  },
  'a2a_group_post': async function a2a_group_post(args, exec) {
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_post');
    const groupId = requireText(args.groupId, 'groupId');
    const message = requireText(args.message, 'message');
    const membership = requireMembership(store, identities, groupId, sessionId);
    if (membership.local === true) {
      const posted = store.post({
        groupId,
        member: { personId: membership.personId, personKey: membership.personKey },
        text: message,
        // Both of these were missing here while the remote branch sent them, so mentioning somebody in a group this
        // instance HOSTS never woke them. The live group is remote, which is why nobody hit it.
        mentions: args.mentions,
        replyTo: args.replyTo,
      });
      await store.flush();
      return { seq: posted.seq, groupId, mentions: posted.mentions ?? [], replyTo: posted.replyTo };
    }
    const result = await bridge.send(targetOf(membership, config), {
      skill: 'group/post',
      text: message,
      data: {
        groupId,
        personId: membership.personId,
        personKey: membership.personKey,
        text: message,
        mentions: args.mentions,
        // Resolved on the host, which owns the feed: only it can map a seq to an author.
        replyTo: args.replyTo,
      },
      timeoutMs: config.client.timeoutMs,
    });
    return { seq: result.data?.seq ?? 0, groupId };
  },
  'a2a_group_role': async function a2a_group_role(args, exec) {
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_read');
    const groupId = requireText(args.groupId, 'groupId');
    const membership = requireMembership(store, identities, groupId, sessionId);
    // The member credential identifies the caller, so the store can only ever
    // change this caller's own row. There is deliberately no `targetPersonId`:
    // a role is what you say about yourself.
    const data = {
      groupId,
      personId: membership.personId,
      personKey: membership.personKey,
      about: args.about,
      tags: args.tags,
    };
    if (args.displayName !== undefined) data.displayName = args.displayName;

    if (membership.local === true) {
      const updated = store.setProfile({ groupId, member: data, about: data.about, tags: data.tags });
      // The headline lives on the PERSON row, not the membership row, so it needs its own write. Done after
      // the membership write because a caller who passes both expects both to land.
      if (args.headline !== undefined) {
        store.setPersonProfile({ groupId, member: data, headline: args.headline });
      }
      await store.flush();
      return {
        groupId,
        about: updated.roleAbout ?? '',
        tags: updated.tags ?? [],
        // Reported so a caller can tell "accepted" from "already that", and so an untouched headline is
        // visibly unchanged rather than silently absent.
        headline: args.headline === undefined
          ? (store.personProfile(membership.personId).headline ?? '')
          : args.headline,
      };
    }
    const result = await bridge.send(targetOf(membership, config), {
      skill: 'group/role',
      text: `role in ${groupId}`,
      data,
      timeoutMs: config.client.timeoutMs,
    });
    const meta = result.data ?? {};
    // `group/role` writes one membership. The headline is a person fact, so it travels as `person/profile` —
    // a second send rather than a broader first one, because the host keeps two separate stores.
    if (args.headline !== undefined) {
      await bridge.send(targetOf(membership, config), {
        skill: 'person/profile',
        text: `headline for ${membership.personId}`,
        data: {
          groupId,
          personId: membership.personId,
          personKey: membership.personKey,
          headline: args.headline,
        },
        timeoutMs: config.client.timeoutMs,
      });
    }
    return {
      groupId,
      about: meta.about ?? '',
      tags: meta.tags ?? [],
      headline: args.headline ?? '',
    };
  },
  'a2a_group_info': async function a2a_group_info(args, exec) {
    const groupId = requireText(args.groupId, 'groupId');
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_info');
    const membership = requireMembership(store, identities, groupId, sessionId);

    if (membership.local === true) {
      const snapshot = store.snapshot({
        groupId,
        member: { personId: membership.personId, personKey: membership.personKey },
      });
      return {
        groupId,
        name: snapshot.name,
        topic: snapshot.topic,
        memberCount: snapshot.memberCount,
        onlineCount: snapshot.onlineCount,
        lastSeq: snapshot.lastSeq,
        isOwner: snapshot.owner?.personId === membership.personId,
      };
    }

    const target = targetOf(membership, config);
    const result = await bridge.send(target, {
      skill: 'group/info',
      text: `info for ${groupId}`,
      data: { groupId, personId: membership.personId, personKey: membership.personKey },
      timeoutMs: config.client.timeoutMs,
    });
    const meta = result.data ?? {};
    // Cache everything the panel needs: it reads the ledger, not the network.
    // Without this a remote group keeps showing its id and "0 人", which reads as an
    // empty group rather than one that has simply not been fetched yet.
    identities.upsert({
      sessionId,
      groupId,
      groupName: typeof meta.name === 'string' && meta.name !== '' ? meta.name : undefined,
      groupTopic: typeof meta.topic === 'string' ? meta.topic : undefined,
      memberCount: Number.isFinite(meta.memberCount) ? meta.memberCount : undefined,
      onlineCount: Number.isFinite(meta.onlineCount) ? meta.onlineCount : undefined,
      lastSeq: Number.isFinite(meta.lastSeq) ? meta.lastSeq : undefined,
      lastTime: Number.isFinite(meta.lastPostAt) ? meta.lastPostAt : undefined,
      isOwner: meta.isOwner === true,
      // The roster is what makes a colleague card useful: without roleAbout and tags a card
      // can only say "in N groups", which is the one thing the reader already knows.
      // lastSeenAt is a fact about the past and stays true; online is a claim about NOW and is wrong the moment
      // it is stored. Keeping the timestamp and dropping the boolean is what lets the panel answer correctly an hour
      // later instead of repeating whatever was true at fetch time - the bug that showed one group three different
      // presence pictures depending on whose cache was newest.
      members: Array.isArray(meta.members)
        ? meta.members.map((member) => ({
            personId: member.personId,
            displayName: member.displayName,
            role: member.role,
            lastSeenAt: Number.isFinite(member.lastSeenAt) ? member.lastSeenAt : undefined,
            roleAbout: member.roleAbout,
            tags: Array.isArray(member.tags) ? member.tags : undefined,
          }))
        : undefined,
      rosterCachedAt: Array.isArray(meta.members) ? Date.now() : undefined,
    });
    await identities.flush();
    return {
      groupId,
      name: meta.name ?? groupId,
      topic: meta.topic ?? '',
      memberCount: Number.isFinite(meta.memberCount) ? meta.memberCount : 0,
      onlineCount: Number.isFinite(meta.onlineCount) ? meta.onlineCount : 0,
      lastSeq: Number.isFinite(meta.lastSeq) ? meta.lastSeq : 0,
      isOwner: meta.isOwner === true,
      rosterCount: Array.isArray(meta.members) ? meta.members.length : 0,
    };
  },
  'a2a_group_read': async function a2a_group_read(args, exec) {
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_role');
    const groupId = requireText(args.groupId, 'groupId');
    const sinceSeq = args.sinceSeq ?? 0;
    const limit = args.limit ?? 50;
    const membership = requireMembership(store, identities, groupId, sessionId);
    if (membership.local === true) {
      const page = store.read({
        groupId,
        member: { personId: membership.personId, personKey: membership.personKey },
        sinceSeq,
        limit,
      });
      return {
        lastSeq: page.lastSeq,
        entries: page.entries.map((entry) => ({
          seq: entry.seq,
          from: entry.from.displayName,
          text: entry.text,
          at: entry.atIso,
        })),
      };
    }
    const result = await bridge.send(targetOf(membership, config), {
      skill: 'group/read',
      text: `read ${groupId} after ${sinceSeq}`,
      data: { groupId, personId: membership.personId, personKey: membership.personKey, sinceSeq, limit },
    });
    const meta = result.data ?? {};
    return {
      lastSeq: meta.lastSeq ?? sinceSeq,
      entries: (meta.entries ?? []).map((entry) => ({
        seq: entry.seq,
        // The host produces from as { personId, displayName }, but this tool schema declares a plain
        // string — the same shape the local branch above already collapses to. Passing the object through
        // made every entry fail client-side validation, which is how reading group history broke for
        // every remote group while local groups kept working.
        from: typeof entry.from === 'string' ? entry.from : (entry.from?.displayName ?? ''),
        text: entry.text,
        at: entry.atIso ?? entry.at,
      })),
    };
  },
  'a2a_group_directory': async function a2a_group_directory(args, exec) {
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_directory');
    // Default to whatever host this instance already points at: the common case
    // is "what is on OUR host", and requiring an address for that would be noise.
    const reference = args.agent
      ?? (config.groups.agentName !== '' && config.groups.gatewayBase !== ''
        ? joinUrl(config.groups.gatewayBase, config.groups.agentName)
        : undefined);
    const target = resolveTarget(registry, config, requireText(reference, 'agent or groups.gatewayBase+agentName'));
    const result = await bridge.send(target, {
      skill: 'group/directory',
      text: 'list groups',
      data: {
        query: args.query,
        limit: args.limit,
      },
      timeoutMs: config.client.timeoutMs,
    });
    const meta = result.data ?? {};
    return {
      total: meta.total ?? 0,
      hasMore: meta.hasMore === true,
      groups: (meta.groups ?? []).map((group) => ({
        groupId: group.groupId,
        name: group.name,
        topic: group.topic ?? '',
        memberCount: group.memberCount ?? 0,
        onlineCount: group.onlineCount ?? 0,
        lastActivityAt: group.lastActivityAtIso ?? '',
      })),
    };
  },
  'a2a_groups': async function a2a_groups(args, exec) {
    const sessionId = requireSession(senderOf(exec).id, 'a2a_groups');
    // Hosted groups come from the group store; joined ones from the ledger.
    // Both are "my groups" to a person, so they are merged rather than split.
    const hosted = safeList(store, identities);
    const rows = [];
    for (const record of identities.list({ sessionId })) {
      if (args.groupId !== undefined && record.groupId !== args.groupId) continue;
      const summary = hosted.get(record.groupId);
      rows.push({
        groupId: record.groupId,
        name: summary?.name ?? record.groupName ?? record.groupId,
        role: summary?.owner?.personId === record.personId ? 'owner' : record.role,
        // `summary` comes from locally hosted groups only. For a remote group it is undefined, and falling back to
        // 0 made every remote group report 0 members while group_info showed the real count — a mismatch a member
        // reasonably read as data corruption. The ledger already caches the count from the last info call.
        members: summary?.memberCount ?? (Number.isFinite(record.memberCount) ? record.memberCount : 0),
        lastSeq: summary?.lastSeq ?? record.lastSeq ?? 0,
        lastMessage: lastMessageOf(summary, record),
      });
    }
    return { groups: rows };
  },
  'a2a_group_inbox': async function a2a_group_inbox(args, exec) {
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_requests');
    const action = args.action ?? 'status';
    if (action === 'on') await inbox.enable(args.groupId);
    if (action === 'off') await inbox.disable(args.groupId);
    return { enabled: inbox.enabled(), subscriptions: inbox.state() };
  },
  'a2a_group_request': async function a2a_group_request(args, exec) {
    const groupId = requireText(args.groupId, 'groupId');
    const displayName = requireText(args.displayName, 'displayName');
    // Applying happens BEFORE this Session is a member, so there is no membership
    // record to read an address from: the target comes from the caller or config.
    if (store.has?.(groupId) === true) {
      const issued = store.requestJoin({ groupId, displayName, reason: args.reason });
      await store.flush();
      return {
        requestId: issued.requestId,
        claimKey: issued.claimKey ?? '',
        groupName: issued.groupName,
        expiresAt: new Date(issued.expiresAt).toISOString(),
        duplicate: issued.duplicate === true,
      };
    }
    const target = hostTarget(registry, config, args.agent);
    const result = await bridge.send(target, {
      skill: 'group/request',
      text: `apply to join ${groupId}`,
      data: { groupId, displayName, reason: args.reason },
      timeoutMs: config.client.timeoutMs,
    });
    const meta = result.data ?? {};
    return {
      requestId: meta.requestId ?? '',
      claimKey: meta.claimKey ?? '',
      groupName: meta.groupName ?? groupId,
      expiresAt: meta.expiresAt ?? '',
      duplicate: meta.duplicate === true,
    };
  },
  'a2a_group_requests': async function a2a_group_requests(args, exec) {
    const groupId = requireText(args.groupId, 'groupId');
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_requests');
    const membership = requireLocalMembership(identities, groupId, sessionId);
    const requests = store.listRequests({
      groupId,
      member: { personId: membership.personId, personKey: membership.personKey },
      status: args.status ?? 'pending',
    });
    return {
      count: requests.length,
      requests: requests.map((entry) => ({
        requestId: entry.requestId,
        displayName: entry.displayName,
        reason: entry.reason,
        status: entry.status,
        expiresAt: entry.expiresAtIso,
      })),
    };
  },
  'a2a_group_decide': async function a2a_group_decide(args, exec) {
    const groupId = requireText(args.groupId, 'groupId');
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_decide');
    const membership = requireLocalMembership(identities, groupId, sessionId);
    const decided = store.decideRequest({
      groupId,
      member: { personId: membership.personId, personKey: membership.personKey },
      requestId: requireText(args.requestId, 'requestId'),
      approve: args.approve !== false,
    });
    await store.flush();
    return {
      requestId: decided.requestId,
      status: decided.status,
      displayName: decided.displayName,
    };
  },
  'a2a_group_remove': async function a2a_group_remove(args, exec) {
    const groupId = requireText(args.groupId, 'groupId');
    const targetPersonId = requireText(args.targetPersonId, 'targetPersonId');
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_remove');
    const membership = requireMembership(store, identities, groupId, sessionId);
    if (membership.local === true) {
      const removed = store.removeMember({
        groupId,
        member: { personId: membership.personId, personKey: membership.personKey },
        targetPersonId,
        reason: args.reason,
      });
      await store.flush();
      return { groupId, personId: removed.personId, displayName: removed.displayName };
    }
    const result = await bridge.send(targetOf(membership, config), {
      skill: 'group/remove',
      text: `remove ${targetPersonId}`,
      data: { groupId, personId: membership.personId, personKey: membership.personKey, targetPersonId, reason: args.reason },
      timeoutMs: config.client.timeoutMs,
    });
    const meta = result.data ?? {};
    return { groupId, personId: meta.personId ?? targetPersonId, displayName: meta.displayName ?? targetPersonId };
  },

  'a2a_group_leave': async function a2a_group_leave(args, exec) {
    const groupId = requireText(args.groupId, 'groupId');
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_leave');
    const membership = identities.get(groupId, sessionId);
    if (membership === undefined) {
      // Nothing to withdraw: the caller has no membership row, which is the desired end state.
      return { groupId, left: true, pending: false };
    }

    if (membership.local === true) {
      // A hosted group: this instance `is` the authority, so the store call is the whole operation.
      try {
        store.leave({ groupId, member: { personId: membership.personId, personKey: membership.personKey } });
      } catch (error) {
        // Already absent counts as left; any other refusal is real and must reach the caller.
        if (error?.code !== 'not_member') throw error;
      }
      identities.remove({ groupId, sessionId });
      await store.flush();
      return { groupId, left: true, pending: false };
    }

    // A remote group: the credential is the only thing that can withdraw the row on the host, so it must be used
    // BEFORE the local copy is deleted. Deleting first is what created the unrecoverable state.
    try {
      await bridge.send(targetOf(membership, config), {
        skill: 'group/leave',
        text: `leave ${groupId}`,
        data: {
          groupId,
          personId: membership.personId,
          personKey: membership.personKey,
        },
        timeoutMs: config.client.timeoutMs,
      });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : (typeof error?.data === 'string' ? error.data : '');
      // "You are already not a member" is the outcome we wanted, however it arrives.
      if (code !== 'not_member' && code !== 'unknown_group') {
        // Keep the row, record the intent, and let the caller retry. This is the branch that makes leave safe.
        identities.upsert({
          sessionId,
          groupId,
          personId: membership.personId,
          personKey: membership.personKey,
          leavingAt: Date.now(),
        });
        return { groupId, left: false, pending: true };
      }
    }

    // The host no longer has this member — or has no such group — so the local credential is spent either way.
    identities.remove({ groupId, sessionId });
    return { groupId, left: true, pending: false };
  },
  'a2a_group_rename': async function a2a_group_rename(args, exec) {
    const groupId = requireText(args.groupId, 'groupId');
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_rename');
    const membership = requireMembership(store, identities, groupId, sessionId);
    if (membership.local === true) {
      const renamed = store.renameGroup({
        groupId,
        member: { personId: membership.personId, personKey: membership.personKey },
        name: args.name,
        topic: args.topic,
      });
      await store.flush();
      return { groupId, name: renamed.name, topic: renamed.topic, changed: renamed.changed };
    }
    const result = await bridge.send(targetOf(membership, config), {
      skill: 'group/rename',
      text: 'rename',
      data: { groupId, personId: membership.personId, personKey: membership.personKey, name: args.name, topic: args.topic },
      timeoutMs: config.client.timeoutMs,
    });
    const meta = result.data ?? {};
    return { groupId, name: meta.name ?? '', topic: meta.topic ?? '', changed: Array.isArray(meta.changed) ? meta.changed : [] };
  },

  'a2a_group_archive': async function a2a_group_archive(args, exec) {
    const groupId = requireText(args.groupId, 'groupId');
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_archive');
    const membership = requireMembership(store, identities, groupId, sessionId);
    if (membership.local === true) {
      const result = store.archiveGroup({
        groupId,
        member: { personId: membership.personId, personKey: membership.personKey },
        archived: args.archived !== false,
      });
      await store.flush();
      return { groupId, archived: result.archived };
    }
    const result = await bridge.send(targetOf(membership, config), {
      skill: 'group/archive',
      text: 'archive',
      data: { groupId, personId: membership.personId, personKey: membership.personKey, archived: args.archived !== false },
      timeoutMs: config.client.timeoutMs,
    });
    const meta = result.data ?? {};
    return { groupId, archived: meta.archived === true };
  },

  'a2a_group_claim': async function a2a_group_claim(args, exec) {
    const groupId = requireText(args.groupId, 'groupId');
    const requestId = requireText(args.requestId, 'requestId');
    const claimKey = requireText(args.claimKey, 'claimKey');
    const sessionId = requireSession(senderOf(exec).id, 'a2a_group_claim');

    if (store.has?.(groupId) === true) {
      const claimed = store.claimJoin({ groupId, requestId, claimKey });
      identities.upsert({
        sessionId,
        groupId,
        personId: claimed.member.personId,
        personKey: claimed.personKey,
        local: true,
        groupName: claimed.group.name,
        role: claimed.member.role,
        lastSeq: claimed.group.lastSeq ?? 0,
      });
      await store.flush();
      await identities.flush();
      return {
        groupId,
        groupName: claimed.group.name,
        personId: claimed.member.personId,
        remote: false,
      };
    }
    const target = hostTarget(registry, config, args.agent);
    const result = await bridge.send(target, {
      skill: 'group/claim',
      text: `claim ${requestId}`,
      data: { groupId, requestId, claimKey, displayName: args.displayName },
      timeoutMs: config.client.timeoutMs,
    });
    const meta = result.data ?? {};
    identities.upsert({
      sessionId,
      groupId,
      personId: meta.personId,
      personKey: meta.personKey,
      local: false,
      baseUrl: target.baseUrl,
      groupName: meta.groupName ?? groupId,
      role: 'member',
      lastSeq: 0,
    });
    await identities.flush();
    if (inbox !== undefined) await inbox.enable(groupId);
    return {
      groupId,
      groupName: meta.groupName ?? groupId,
      personId: meta.personId,
      remote: true,
    };
  },
  'a2a_serve': async function a2a_serve(args, exec) {
    // Asking how this instance is exposed is the declaration of intent that
    // binds it: the Session asking is the Session this agent should answer for.
    const sender = senderOf(exec);
    if (sender.id !== undefined) sessions.offerBinding(sender.id);
    const info = server.info();
    const base = {
      enabled: info.attached === true,
      endpoint: info.url,
      cardUrl: `${String(info.url).replace(/\/a2a$/, '')}${info.card}`,
      tokenRequired: info.tokenConfigured === true,
      boundSessionId: sessions.resolveBoundSessionId() ?? '',
    };
    if (args.check === false || !base.enabled) {
      return { ...base, gatewayEntry: gatewayEntryFor(info, config) };
    }
    // The probe walks the same path a colleague's invite would. Reporting its
    // steps — not just a yes/no — is what turns "it does not work" into "this is
    // the one thing left to do".
    const report = await probeReachability({ config, server });
    const missingRegistration = report.checks.some((check) => check.step === 'gateway-registered' && !check.ok);
    return {
      ...base,
      reachable: report.ok === true,
      steps: report.checks.map((check) => ({ step: check.step, ok: check.ok, detail: check.detail })),
      hint: report.hint,
      gatewayEntry: missingRegistration ? gatewayEntryFor(info, config) : '',
    };
  },
  };

  /**
   * Drop the local membership when the host says the credential is dead.
   *
   * A removed member has no way to find out otherwise: nothing pushes to them, their panel
   * keeps listing the group, and every action fails with a code they never see. Deleting the
   * record is what turns an invisible revocation into a visible one — the group disappears
   * from their panel, which is exactly what happened.
   *
   * Scoped to one (groupId, sessionId) pair. A failure on one group says nothing about the
   * others, and a broader sweep would turn one stale credential into a wiped ledger.
   *
   * @param {Error} error - the failure from the handler.
   * @param {object} args - the tool arguments, for the group id.
   * @param {object} caller - `{ sessionId }`.
   * @returns {boolean} whether a record was removed.
   */
  /**
   * Clear the unreachable stamp after a call that worked.
   *
   * The counterpart to {@link reapStaleMembership}: that one records doubt, this one retracts it. Both exist so the
   * ledger reflects what we currently believe rather than what once happened — a host restarted against the wrong
   * data directory then comes back with the right one, and nobody should have to repair their own state.
   *
   * @param {object} args - tool arguments, for the group id.
   * @param {object} caller - 
ormalised, with sessionId.
   * @returns {void}
   */
  function clearUnreachable(args, caller) {
    if (identities === undefined || identities === null || typeof identities.upsert !== 'function') return;
    const groupId = typeof args?.groupId === 'string' ? args.groupId : '';
    const sessionId = typeof caller?.sessionId === 'string' ? caller.sessionId : '';
    if (groupId === '' || sessionId === '') return;
    try {
      const existing = typeof identities.get === 'function' ? identities.get(groupId, sessionId) : undefined;
      // Only worth a write when there is a stamp to retract; otherwise every tool call would persist the file.
      if (existing === undefined || existing.unreachableAt === undefined) return;
      identities.upsert({
        sessionId,
        groupId,
        personId: existing.personId,
        personKey: existing.personKey,
        local: existing.local,
        baseUrl: existing.baseUrl,
        groupName: existing.groupName,
        role: existing.role,
        lastSeq: existing.lastSeq,
        reachable: true,
      });
      if (typeof identities.flush === 'function') {
        Promise.resolve(identities.flush()).catch(() => {});
      }
      logger?.info?.('a2a: cleared the unreachable mark for ' + groupId);
    } catch {
      // A retraction that fails leaves the stamp in place, which is the safe direction: the group stays
      // visible-but-marked rather than silently disappearing.
    }
  }

  function reapStaleMembership(error, args, caller) {
    // The business sub-code lands in TWO places depending on the path: a local call throws with `code` set, while a
    // remote call wraps the JSON-RPC error and puts the sub-code in data (bridge.js rpcErrorOf). Reading only
    // code therefore meant a remote membership was NEVER marked — the whole point of this function — because
    // code was the numeric -32004 and the string it wanted sat one field over.
    const code = typeof error?.code === 'string'
      ? error.code
      : (typeof error?.data === 'string' ? error.data : '');
    // `not_member` is the host saying "this credential is not one of mine".
    // `unknown_group` covers a group that was deleted, a cache pointing at a host that no longer has it, and a
    // host briefly serving the wrong data directory.
    if (code !== 'not_member' && code !== 'unknown_group') return false;
    const groupId = typeof args?.groupId === 'string' ? args.groupId : '';
    const sessionId = typeof caller?.sessionId === 'string' ? caller.sessionId : '';
    if (groupId === '' || sessionId === '') return false;
    if (identities === undefined || identities === null || typeof identities.upsert !== 'function') return false;

    // NOT a deletion. `personKey` exists only in this row, so removing it would make the group unreachable
    // forever — and the evidence is one answer from one call, which a restarted host or a misdirected gateway
    // produces just as readily as a real removal. Stamping keeps the credential and lets the next success clear
    // the mark, so recovery needs no user action.
    try {
      const existing = typeof identities.get === 'function' ? identities.get(groupId, sessionId) : undefined;
      if (existing === undefined) return false;
      const at = Date.now();
      identities.upsert({
        sessionId,
        groupId,
        personId: existing.personId,
        personKey: existing.personKey,
        local: existing.local,
        baseUrl: existing.baseUrl,
        groupName: existing.groupName,
        role: existing.role,
        lastSeq: existing.lastSeq,
        unreachableAt: at,
      });
      if (typeof identities.flush === 'function') {
        Promise.resolve(identities.flush()).catch(() => {});
      }
      logger?.info?.(
        `a2a: marked the membership for ${groupId} unreachable after the host answered ${code}; the credential is kept`,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run one tool.
   *
   * @param {string} name - tool name.
   * @param {object} args - arguments, already validated by the adapter.
   * @param {object} [caller] - `{ sessionId }`.
   * @returns {Promise<object>} the tool result.
   */
  async function call(name, args, caller) {
    const handler = HANDLERS[name];
    if (typeof handler !== 'function') throw new Error(`unknown tool: ${name}`);
    const normalised = normaliseCaller(caller);
    try {
      const result = await handler(args ?? {}, normalised);
      // A call that reached the group clears any earlier "unreachable" stamp, so recovery from a host restart needs
      // no user action and no repair step. Scoped to this group: success here says nothing about the others.
      clearUnreachable(args, normalised);
      return result;
    } catch (error) {
      // One funnel for "this membership looks gone", so twelve group tools do not each carry their own copy.
      if (reapStaleMembership(error, args, normalised)) {
        // Annotate rather than replace: the caller still needs the original code, and this flag is what a UI can
        // use to say "this group is unreachable" instead of "not a member".
        if (error !== null && typeof error === 'object') error.membershipDropped = true;
      }
      throw error;
    }
  }

  /** Whether this runtime knows a tool. */
  function has(name) {
    return typeof HANDLERS[name] === 'function';
  }

  /** Every tool name the runtime can run. */
  function names() {
    return Object.keys(HANDLERS);
  }

  return { call, has, names };
}