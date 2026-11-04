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
    const target = resolveTarget(registry, config, args.agent);
    const result = await bridge.send(target, {
      skill: args.skill ?? 'session/ask',
      text: args.message,
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
    const membership = requireLocalMembership(identities, groupId, sessionId);
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
    const baseUrl = parsed.endpoint
      ?? parsed.baseUrl
      ?? (config.groups.gatewayBase === '' ? undefined : config.groups.gatewayBase);
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
      data: { groupId: parsed.groupId, token: parsed.token, displayName },
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
      });
      await store.flush();
      return { seq: posted.seq, groupId };
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
      await store.flush();
      return { groupId, about: updated.roleAbout ?? '', tags: updated.tags ?? [] };
    }
    const result = await bridge.send(targetOf(membership, config), {
      skill: 'group/role',
      text: `role in ${groupId}`,
      data,
      timeoutMs: config.client.timeoutMs,
    });
    const meta = result.data ?? {};
    return { groupId, about: meta.about ?? '', tags: meta.tags ?? [] };
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
      members: Array.isArray(meta.members) ? meta.members : undefined,
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
        from: entry.from,
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
        members: summary?.memberCount ?? 0,
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
  function reapStaleMembership(error, args, caller) {
    const code = typeof error?.code === 'string' ? error.code : '';
    // `not_member` is the host saying "this credential is not one of mine".
    // `unknown_group` covers a group that was deleted, or a cache pointing at a host that
    // no longer has it.
    if (code !== 'not_member' && code !== 'unknown_group') return false;
    const groupId = typeof args?.groupId === 'string' ? args.groupId : '';
    const sessionId = typeof caller?.sessionId === 'string' ? caller.sessionId : '';
    if (groupId === '' || sessionId === '') return false;
    if (identities === undefined || identities === null || typeof identities.remove !== 'function') return false;
    try {
      const removed = identities.remove({ groupId, sessionId });
      if (removed > 0) {
        // flush() is fire-and-forget: the in-memory ledger is already correct, and making a
        // failed disk write turn a clear error into a different one would help nobody.
        if (typeof identities.flush === 'function') {
          Promise.resolve(identities.flush()).catch(() => {});
        }
        logger?.info?.(
          `a2a: dropped the local membership for ${groupId} after the host answered ${code}`,
        );
      }
      return removed > 0;
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
      return await handler(args ?? {}, normalised);
    } catch (error) {
      // One funnel for "your membership is gone", so the twelve group tools do not each
      // need their own copy of the same eight lines.
      if (reapStaleMembership(error, args, normalised)) {
        // Annotate rather than replace: the caller still needs the original code, and the
        // new field is what a UI can use to say "you were removed" instead of "not a member".
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
