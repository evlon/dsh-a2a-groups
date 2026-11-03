/**
 * The tool surface: what a Session can do with A2A.
 *
 * The tools are the user-facing half of this plugin. `a2a_group_create` and
 * `a2a_group_invite` matter most in practice, because they are how a person turns
 * "let us collaborate on this" into "here is a link, paste it in the IM" — the
 * invite carries both a link and a paste-ready message, so the user never has to
 * assemble either.
 *
 * Two shapes are load-bearing and easy to get wrong:
 *
 *   **Tool results are validated by the registry** with `additionalProperties:
 *   false`, which means a result carrying an undeclared field fails the call
 *   *after* the side effect happened. Every result below is built from its own
 *   schema's property list so that class of failure cannot occur.
 *
 *   **`additionalProperties: false` equally forbids a model from sending an
 *   undeclared argument**, so every argument a skill might want has to be
 *   declared here even when it is optional.
 *
 * Self-contained by design (no `@deepseek-ai/*` import).
 *
 * @module dsh-a2a/tools
 */

import { defineTool } from './toolkit.js';
import { probeReachability } from './probe.js';

/**
 * Register every tool on one Host.
 *
 * @param {object} ctx - plugin context carrying `tools`.
 * @param {object} deps - `{ config, registry, bridge, store, identities, server, sessions, inbox, logger }`.
 * @returns {void}
 */
export function registerTools(ctx, deps) {
  const { config, registry, bridge, store, identities, server, sessions, logger, inbox } = deps;

  /** The Session calling a tool. */
  const senderOf = (exec) => {
    const agent = exec?.agent;
    const session = agent?.session;
    const id = typeof agent?.id === 'string' ? agent.id : undefined;
    const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined;
    return { id, cwd };
  };

  /** A Session's display name for group records: the id, shortened for legibility. */
  const displayNameOf = (exec) => {
    const id = senderOf(exec).id;
    return typeof id === 'string' && id !== '' ? id.slice(0, 12) : 'owner';
  };

  /** The agent name this instance is known by in the gateway, or undefined. */
  const settingsAgentName = (settings) => (typeof settings?.groups?.agentName === 'string' && settings.groups.agentName !== ''
    ? settings.groups.agentName
    : undefined);
  // -------------------------------------------------------------------------
  // Discovery and calling other agents
  // -------------------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'a2a_agents',
    description:
      'List, add, or remove the remote A2A agents this Session knows about. Each entry names an agent (a colleague\'s DSH instance, a group, or any A2A agent) and how to reach it: through the gateway (`gatewayBase` + `agent`) or directly (`baseUrl`). Run action=list first; add only when the user gave you an address or a link.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove'],
          description: 'What to do. "list" shows every registered agent; "add" registers one; "remove" forgets one.',
        },
        name: { type: 'string', description: 'Local name for the agent, used by a2a_send and a2a_discover.' },
        gatewayBase: {
          type: 'string',
          description: 'AISIX gateway base including its path, e.g. "http://gw:3000/a2a". "/<agent>" is appended.',
        },
        agent: { type: 'string', description: 'The agent name as registered in the gateway.' },
        baseUrl: {
          type: 'string',
          description: 'Direct A2A endpoint for an agent not behind the gateway, e.g. "http://host:3091/a2a".',
        },
        apiKey: { type: 'string', description: 'Gateway API key for this agent. Omit to use the configured default.' },
        note: { type: 'string', description: 'Optional note about who or what this agent is.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agents: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                baseUrl: { type: 'string' },
                enabled: { type: 'boolean' },
                note: { type: 'string' },
              },
            },
          },
          changed: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.agents ?? []).length === 0
          ? 'No A2A agents registered yet. Add one with a2a_agents action=add, or join a group with an invite link.'
          : `Registered A2A agents (${value.agents.length}):\n`
            + value.agents.map((item) => `- ${item.name} → ${item.baseUrl}${item.enabled === false ? ' (disabled)' : ''}`).join('\n'),
      }],
    },
    async execute(args) {
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
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_discover',
    description:
      'Fetch a remote A2A agent\'s card and show what it can do: its skills, whether it streams, and the exact skill ids a2a_send accepts. Always discover before the first send — a wrong skill id is a rejected call, not a retryable one.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string', description: 'A registered agent name from a2a_agents, or a raw A2A base URL.' },
      },
      required: ['agent'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          url: { type: 'string' },
          protocolVersion: { type: 'string' },
          streaming: { type: 'boolean' },
          skills: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `${value.name} (A2A ${value.protocolVersion}, streaming=${value.streaming === true})\n`
          + `endpoint: ${value.url}\n\nskills:\n`
          + (value.skills ?? []).map((skill) => `- ${skill.id} — ${skill.description || skill.name}`).join('\n'),
      }],
    },
    async execute(args) {
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
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_send',
    description:
      'Send a task to a remote A2A agent and wait for its answer. Discover the agent first so you name a real skill. The remote agent does not share this conversation, so write a self-contained message. For anything that may take minutes, prefer a2a_stream so progress is visible.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string', description: 'A registered agent name or a raw A2A base URL.' },
        skill: { type: 'string', description: 'Skill id from a2a_discover, e.g. "session/ask".' },
        message: { type: 'string', description: 'The task text. Self-contained: the receiver has no context from this conversation.' },
        data: { type: 'string', description: 'Optional JSON object, as a string, for skills that need structured input.' },
        timeoutMs: { type: 'integer', description: 'How long to wait for an answer, in milliseconds.' },
      },
      required: ['agent', 'message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string' },
          text: { type: 'string' },
          taskId: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `[${value.state}] ${value.text}${value.taskId === undefined ? '' : `\n(task ${value.taskId})`}`,
      }],
    },
    async execute(args, exec) {
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
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_stream',
    description:
      'Stream a task to a remote A2A agent. Progress arrives as it happens and the answer arrives at the end. Use it for anything that may take minutes, so the user sees it working instead of a silent wait.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string', description: 'A registered agent name or a raw A2A base URL.' },
        skill: { type: 'string', description: 'Skill id from a2a_discover.' },
        message: { type: 'string', description: 'The task text.' },
        data: { type: 'string', description: 'Optional JSON object, as a string, for skills that need structured input.' },
      },
      required: ['agent', 'message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string' },
          text: { type: 'string' },
          events: { type: 'integer' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `[${value.state}] ${value.text}\n(${value.events} stream event(s) received)`,
      }],
    },
    async execute(args, exec) {
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
  }));

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'a2a_group_create',
    description:
      'Create a collaboration group on the group host and get the group id plus a one-time owner key. The group lives on the HOST (a standalone A2A server), not on this machine, so members reach it through the gateway. The calling Session becomes the owner. Use it when several people or Sessions should work on one thing together.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Group name, shown to members.' },
        topic: { type: 'string', description: 'One line about what the group is for.' },
        visibility: {
          type: 'string',
          enum: ['public', 'unlisted'],
          description: 'public: listed in the channel directory. unlisted: absent from it entirely, joinable by invite link only. Defaults to public.',
        },
        agent: { type: 'string', description: 'Host to create the group on: a registered agent name or a raw URL. Defaults to the configured group host.' },
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          name: { type: 'string' },
          memberId: { type: 'string' },
          ownerKey: { type: 'string' },
          agentName: { type: 'string' },
          remote: { type: 'boolean' },
          nextSteps: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Group "${value.name}" created on ${value.remote === true ? 'the group host' : 'this instance'}.

`
          + `groupId  : ${value.groupId}
`
          + `memberId : ${value.memberId}
`
          + `ownerKey : ${value.ownerKey}

`
          + value.nextSteps,
      }],
    },
    async execute(args, exec) {
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
      let memberId;
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
        memberId = created.group.owner.memberId;
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
        memberId = meta.memberId;
        ownerKey = meta.ownerKey;
        groupName = meta.name ?? name;
        remote = true;
        if (typeof groupId !== 'string' || groupId === '') {
          throw coded('bad_response', 'the group host did not return a groupId; check that the host runs a compatible dsh-groups version');
        }
      }

      // The membership record belongs to the Session that created the group: it is the
      // owner, and it is where invite/approve calls will be issued from.
      identities.upsert({
        sessionId,
        groupId,
        memberId,
        memberKey: ownerKey,
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
        memberId,
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
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_group_invite',
    description:
      'Mint a group invite: a link plus a message ready to paste into an IM. The link carries a token the owner can revoke at any time; by default it expires in 7 days, and it has no use counter so it works for everyone you send it to. Only the group owner may mint one. Give the user the prompt and let them decide where to send it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id from a2a_group_create or a2a_groups.' },
        label: { type: 'string', description: 'Who this invite is for, e.g. "for 张工". Shown in the invite list.' },
        expiresInHours: { type: 'integer', description: 'How long the link stays valid. Defaults to the configured value.' },
      },
      required: ['groupId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          link: { type: 'string' },
          prompt: { type: 'string' },
          expiresAt: { type: 'string' },
          },
      },
      render: (args, value) => [{
        type: 'text',
        text: `${value.neverExpires === true ? 'Invite created (never expires).' : `Invite created (valid until ${value.expiresAt}).`}\n\n`
          + 'Paste this into the IM:\n---\n'
          + value.prompt
          + '\n---\n\nLink on its own:\n'
          + value.link,
      }],
    },
    async execute(args) {
      const groupId = requireText(args.groupId, 'groupId');
      const sessionId = requireSession(senderOf(exec).id, 'a2a_group_invite');
      const membership = requireLocalMembership(identities, groupId, sessionId);
      const issued = store.invite({
        groupId,
        label: args.label,
        expiresInHours: args.expiresInHours ?? config.groups.inviteExpiresInHours,
        // The owner credential, not just the role: the store verifies it, so a
        // display-field role being wrong cannot mint an invite.
        ownerKey: membership.memberKey,
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
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_group_join',
    description:
      'Join a group from an invite link (or a raw groupId plus token). No password is involved: the token IS the credential. Works for a group on this instance and for one behind the gateway — a remote group is joined over A2A. After joining, this Session receives the group\'s messages.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        link: { type: 'string', description: 'The dsh-a2a://group?... invite link.' },
        groupId: { type: 'string', description: 'Group id, when joining without a link.' },
        token: { type: 'string', description: 'Invite token, when joining without a link.' },
        displayName: { type: 'string', description: 'How this member appears to the others.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          groupName: { type: 'string' },
          memberId: { type: 'string' },
          remote: { type: 'boolean' },
          recentMessages: { type: 'integer' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Joined "${value.groupName}" (${value.groupId})${value.remote ? ' over A2A' : ' locally'}.\n`
          + `memberId: ${value.memberId}\n`
          + (value.recentMessages === 0
            ? 'The group has no messages yet.'
            : `${value.recentMessages} recent message(s) were fetched.`)
          + '\nNew posts will arrive in this Session as task messages.',
      }],
    },
    async execute(args, exec) {
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
          memberId: joined.member.memberId,
          memberKey: joined.memberKey,
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
          memberId: joined.member.memberId,
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
        memberId: meta.memberId,
        memberKey: meta.memberKey,
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
        memberId: meta.memberId,
        remote: true,
        recentMessages: Array.isArray(meta.feedTail) ? meta.feedTail.length : 0,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_group_post',
    description:
      'Post a message to a group. Every member is woken by it, so post what a member should act on, not a running commentary. Read a2a_group_read first when you need to know what was already said.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        mentions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Who should ACT on this: member ids, display names that resolve to exactly one member, or ["@all"] for everyone. Those members are woken; everyone else only sees an unread count. Omit it for ordinary progress.',
        },
        message: { type: 'string', description: 'The text to post.' },
      },
      required: ['groupId', 'message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { seq: { type: 'integer' }, groupId: { type: 'string' } },
      },
      render: (args, value) => [{ type: 'text', text: `Posted to ${value.groupId} at seq ${value.seq}.` }],
    },
    async execute(args, exec) {
      const sessionId = requireSession(senderOf(exec).id, 'a2a_group_post');
      const groupId = requireText(args.groupId, 'groupId');
      const message = requireText(args.message, 'message');
      const membership = requireMembership(store, identities, groupId, sessionId);
      if (membership.local === true) {
        const posted = store.post({
          groupId,
          member: { memberId: membership.memberId, memberKey: membership.memberKey },
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
          memberId: membership.memberId,
          memberKey: membership.memberKey,
          text: message,
          mentions: args.mentions,
        },
        timeoutMs: config.client.timeoutMs,
      });
      return { seq: result.data?.seq ?? 0, groupId };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_group_role',
    description:
      'Say what you do in ONE group, and change it whenever it changes. This is self-description, not a permission — it grants nothing, and nobody can set it for you. Use it when someone takes on a different hat in a project (a developer who is also acting as product), so the group sees the current role rather than the job title. Omit `about` or `tags` to leave that part unchanged; pass an empty string / empty array to clear it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        about: { type: 'string', description: 'One sentence: what you do in this group. Max 120 characters. Empty string clears it.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 5 short labels describing your role here, e.g. ["产品","验收"]. An empty array clears them.',
        },
        displayName: { type: 'string', description: 'Optional: how you appear in this group, if you want to change it too.' },
      },
      required: ['groupId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          about: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Your role in this group is now:\n`
          + `  about: ${value.about === '' ? '(not set)' : value.about}\n`
          + `  tags : ${(value.tags ?? []).join('、') || '(none)'}\n\n`
          + 'This is self-description only — it grants no permission, and it only '
          + 'changes YOUR role, not anyone else\'s.',
      }],
    },
    async execute(args, exec) {
      const sessionId = requireSession(senderOf(exec).id, 'a2a_group_read');
      const groupId = requireText(args.groupId, 'groupId');
      const membership = requireMembership(store, identities, groupId, sessionId);
      // The member credential identifies the caller, so the store can only ever
      // change this caller's own row. There is deliberately no `targetMemberId`:
      // a role is what you say about yourself.
      const data = {
        groupId,
        memberId: membership.memberId,
        memberKey: membership.memberKey,
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
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_group_info',
    description:
      'Fetch one group name, topic, member count and your role in it. Use it after joining a remote group so the panel can show a real name instead of an id, or to check whether anybody is online.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        refresh: { type: 'boolean', description: 'Re-fetch from the host even if a cached value exists. Defaults to true for a remote group.' },
      },
      required: ['groupId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          name: { type: 'string' },
          topic: { type: 'string' },
          memberCount: { type: 'integer' },
          onlineCount: { type: 'integer' },
          lastSeq: { type: 'integer' },
          isOwner: { type: 'boolean' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `${value.name}`
          + (value.topic === '' ? '' : ` — ${value.topic}`)
          + `\n${value.memberCount} 人`
          + (value.onlineCount > 0 ? `，${value.onlineCount} 人在线` : '')
          + `\n我的角色：${value.isOwner === true ? '群主' : '成员'}`,
      }],
    },
    async execute(args, exec) {
      const groupId = requireText(args.groupId, 'groupId');
      const sessionId = requireSession(senderOf(exec).id, 'a2a_group_info');
      const membership = requireMembership(store, identities, groupId, sessionId);

      if (membership.local === true) {
        const snapshot = store.snapshot({
          groupId,
          member: { memberId: membership.memberId, memberKey: membership.memberKey },
        });
        return {
          groupId,
          name: snapshot.name,
          topic: snapshot.topic,
          memberCount: snapshot.memberCount,
          onlineCount: snapshot.onlineCount,
          lastSeq: snapshot.lastSeq,
          isOwner: snapshot.owner?.memberId === membership.memberId,
        };
      }

      const target = targetOf(membership, config);
      const result = await bridge.send(target, {
        skill: 'group/info',
        text: `info for ${groupId}`,
        data: { groupId, memberId: membership.memberId, memberKey: membership.memberKey },
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
      };
    },
  }));
  ctx.tools.register(defineTool({
    name: 'a2a_group_read',
    description:
      'Read recent messages in a group. Pass sinceSeq to get only what is new — that is what a reconnect needs. Read-only: it never wakes a Session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        sinceSeq: { type: 'integer', description: 'Return only messages with a sequence number above this.' },
        limit: { type: 'integer', description: 'Maximum number of messages to return.' },
      },
      required: ['groupId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lastSeq: { type: 'integer' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'integer' },
                from: { type: 'string' },
                text: { type: 'string' },
                at: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.entries.length === 0
          ? 'No new messages.'
          : value.entries.map((entry) => `#${entry.seq} ${entry.from}: ${entry.text}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const sessionId = requireSession(senderOf(exec).id, 'a2a_group_role');
      const groupId = requireText(args.groupId, 'groupId');
      const sinceSeq = args.sinceSeq ?? 0;
      const limit = args.limit ?? 50;
      const membership = requireMembership(store, identities, groupId, sessionId);
      if (membership.local === true) {
        const page = store.read({
          groupId,
          member: { memberId: membership.memberId, memberKey: membership.memberKey },
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
        data: { groupId, memberId: membership.memberId, memberKey: membership.memberKey, sinceSeq, limit },
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
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_group_directory',
    description:
      'Browse the groups a HOST offers, before joining any of them: name, topic, join policy, member count, last activity. Needs no membership, so it is the right tool when someone asks "what groups are there" or "is there anything about X". It never returns member names or message content — for those, join and use a2a_groups / a2a_group_read. Groups the host marked unlisted do not appear at all.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: {
          type: 'string',
          description: 'Which host to browse: a registered agent name from a2a_agents, or a raw A2A base URL. Defaults to the configured group host.',
        },
        query: { type: 'string', description: 'Optional filter over group name and topic.' },
        limit: { type: 'integer', description: 'Maximum groups to return. Defaults to the host\'s page size.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          hasMore: { type: 'boolean' },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                groupId: { type: 'string' },
                name: { type: 'string' },
                topic: { type: 'string' },
                memberCount: { type: 'integer' },
                onlineCount: { type: 'integer' },
                lastActivityAt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.groups ?? []).length === 0
          ? 'That host lists no public groups.'
          : `${value.total} group(s)${value.hasMore === true ? ', showing the first page' : ''}:\n`
            + value.groups.map((group) => {
                const online = group.onlineCount > 0 ? `，${group.onlineCount} 人在线` : '';
              return `- ${group.name}（${group.memberCount} 人${online}，${policy}）`
                + (group.topic === '' ? '' : `\n  ${group.topic}`)
                + `\n  id: ${group.groupId}`;
            }).join('\n')
            + '\n\n要加入某个群，向群主要一个邀请链接（群密码会另外给你）。',
      }],
    },
    async execute(args, exec) {
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
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_groups',
    description:
      'List the groups this instance hosts or has joined, with member count and the last message. Use it to answer "which groups am I in" instead of reading transcripts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Optional: only this group.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groups: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                groupId: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string' },
                members: { type: 'integer' },
                lastSeq: { type: 'integer' },
                lastMessage: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.groups.length === 0
          ? 'No groups yet. Create one with a2a_group_create, or join one with a2a_group_join.'
          : value.groups.map((group) => (
            `- ${group.name} (${group.groupId}) — ${group.role}, ${group.members} member(s), last seq ${group.lastSeq}`
            + (group.lastMessage === '' ? '' : `\n  "${group.lastMessage}"`)
          )).join('\n'),
      }],
    },
    async execute(args, exec) {
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
          role: summary?.owner?.memberId === record.memberId ? 'owner' : record.role,
          members: summary?.memberCount ?? 0,
          lastSeq: summary?.lastSeq ?? record.lastSeq ?? 0,
          lastMessage: lastMessageOf(summary, record),
        });
      }
      return { groups: rows };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_group_inbox',
    description:
      'Turn this instance\'s group subscription on or off, or report its state. While on, a group post wakes this Session as a task message; while off, the group is readable but silent. Use status to diagnose "why did I not get the message".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['on', 'off', 'status'], description: 'What to do.' },
        groupId: { type: 'string', description: 'Optional: apply to one group only.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          subscriptions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                groupId: { type: 'string' },
                active: { type: 'boolean' },
                lastSeq: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `group inbox: ${value.enabled ? 'on' : 'off'}\n`
          + ((value.subscriptions ?? []).length === 0
            ? '(no subscriptions)'
            : value.subscriptions
              .map((item) => `- ${item.groupId}: ${item.active ? 'subscribed' : 'idle'}, last seq ${item.lastSeq}`)
              .join('\n')),
      }],
    },
    async execute(args, exec) {
      const sessionId = requireSession(senderOf(exec).id, 'a2a_group_requests');
      const action = args.action ?? 'status';
      if (action === 'on') await inbox.enable(args.groupId);
      if (action === 'off') await inbox.disable(args.groupId);
      return { enabled: inbox.enabled(), subscriptions: inbox.state() };
    },
  }));

  // -------------------------------------------------------------------------
  // This instance as an agent
  // -------------------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'a2a_group_request',
    description:
      'Apply to join a group you found with a2a_group_directory. Needs no invitation and no password — you are asking, not entering. Returns a requestId (a queue index, safe to share) and a claimKey (SECRET: keep it, it collects the membership once the group owner approves). The owner decides on their own schedule; then use a2a_group_claim.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id from a2a_group_directory.' },
        displayName: { type: 'string', description: 'Your name as the owner will see it.' },
        reason: { type: 'string', description: 'One line about why you want in, so the owner can judge. Optional but strongly recommended.' },
        agent: { type: 'string', description: 'Host to apply to: a registered agent name or a raw URL. Defaults to the configured group host.' },
      },
      required: ['groupId', 'displayName'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string' },
          claimKey: { type: 'string' },
          groupName: { type: 'string' },
          expiresAt: { type: 'string' },
          duplicate: { type: 'boolean' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.duplicate === true
          ? `You already have a pending request for「${value.groupName}」(${value.requestId}). Wait for the owner.
`
            + '(The claimKey from your FIRST request is the one that works; this call does not issue a new one.)'
          : `Applied to join「${value.groupName}」.

`
            + `requestId : ${value.requestId}
`
            + `claimKey  : ${value.claimKey}

`
            + 'Keep the claimKey — it is shown once and is what collects your membership.\n'
            + `Valid until ${value.expiresAt}.`,
      }],
    },
    async execute(args) {
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
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_group_requests',
    description:
      'List the applications waiting for YOUR decision. Owner only: the queue holds other people\'s names and stated reasons. Use a2a_group_decide to answer one.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'claimed', 'all'], description: 'Which requests to list. Defaults to pending.' },
      },
      required: ['groupId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          requests: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                requestId: { type: 'string' },
                displayName: { type: 'string' },
                reason: { type: 'string' },
                status: { type: 'string' },
                expiresAt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.requests ?? []).length === 0
          ? 'No requests to review.'
          : `${value.count} request(s):\n`
            + value.requests.map((entry) => `- ${entry.displayName} [${entry.status}] (${entry.requestId})`
              + (entry.reason === '' ? '' : `\n  "${entry.reason}"`)
              + `\n  expires ${entry.expiresAt}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const groupId = requireText(args.groupId, 'groupId');
      const sessionId = requireSession(senderOf(exec).id, 'a2a_group_requests');
      const membership = requireLocalMembership(identities, groupId, sessionId);
      const requests = store.listRequests({
        groupId,
        member: { memberId: membership.memberId, memberKey: membership.memberKey },
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
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_group_decide',
    description:
      'Approve or reject one join request. Owner only. Approving does NOT create the membership: the applicant collects it with the claimKey they already hold — that is what keeps "one person vouched for one person" true.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        requestId: { type: 'string', description: 'Request id from a2a_group_requests.' },
        approve: { type: 'boolean', description: 'true to approve, false to reject. Defaults to true.' },
      },
      required: ['groupId', 'requestId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string' },
          status: { type: 'string' },
          displayName: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `${value.status === 'approved' ? 'Approved' : 'Rejected'} ${value.displayName}'s request.`
          + (value.status === 'approved'
            ? '\nThey collect the membership with their own claimKey — you do not need to send an invite.'
            : ''),
      }],
    },
    async execute(args, exec) {
      const groupId = requireText(args.groupId, 'groupId');
      const sessionId = requireSession(senderOf(exec).id, 'a2a_group_decide');
      const membership = requireLocalMembership(identities, groupId, sessionId);
      const decided = store.decideRequest({
        groupId,
        member: { memberId: membership.memberId, memberKey: membership.memberKey },
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
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_group_claim',
    description:
      'Collect an approved membership using the claimKey you got when you applied. Needs NO group password: the owner already vouched for you. The claimKey is single-use and only you hold it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id you applied to.' },
        requestId: { type: 'string', description: 'requestId from a2a_group_request.' },
        claimKey: { type: 'string', description: 'The claimKey returned when you applied.' },
        agent: { type: 'string', description: 'Host the group lives on. Defaults to the configured group host.' },
        displayName: { type: 'string', description: 'Optional: how you appear in the group.' },
      },
      required: ['groupId', 'requestId', 'claimKey'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          groupName: { type: 'string' },
          memberId: { type: 'string' },
          remote: { type: 'boolean' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Joined「${value.groupName}」(${value.groupId})${value.remote ? ' over A2A' : ' locally'}.
`
          + `memberId: ${value.memberId}

`
          + 'This Session stored the credential; new posts will arrive as task messages.',
      }],
    },
    async execute(args, exec) {
      const groupId = requireText(args.groupId, 'groupId');
      const requestId = requireText(args.requestId, 'requestId');
      const claimKey = requireText(args.claimKey, 'claimKey');
      const sessionId = requireSession(senderOf(exec).id, 'a2a_group_claim');

      if (store.has?.(groupId) === true) {
        const claimed = store.claimJoin({ groupId, requestId, claimKey });
        identities.upsert({
          sessionId,
          groupId,
          memberId: claimed.member.memberId,
          memberKey: claimed.memberKey,
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
          memberId: claimed.member.memberId,
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
        memberId: meta.memberId,
        memberKey: meta.memberKey,
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
        memberId: meta.memberId,
        remote: true,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'a2a_serve',
    description:
      'Check whether this DSH instance is reachable as an A2A agent — and if not, which step is missing. Runs a real end-to-end probe through the gateway (card, credential, card rewrite, ping round trip), so it answers "will a colleague\'s invite link actually work" rather than "does the config look right". Use it before asking anyone to join a group, and whenever a caller says they cannot reach this instance. Pass check=false for just the local endpoint and the gateway entry to register.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        check: {
          type: 'boolean',
          description: 'Run the live reachability probe. Defaults to true. Pass false to only describe the local endpoint and the gateway entry.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          endpoint: { type: 'string' },
          cardUrl: { type: 'string' },
          tokenRequired: { type: 'boolean' },
          boundSessionId: { type: 'string' },
          reachable: { type: 'boolean' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                step: { type: 'string' },
                ok: { type: 'boolean' },
                detail: { type: 'string' },
              },
            },
          },
          hint: { type: 'string' },
          gatewayEntry: { type: 'string' },
        },
      },
      render: (args, value) => {
        if (!value.enabled) return [{ type: 'text', text: 'The A2A server is disabled in this profile (server.enabled = false).' }];
        const lines = [
          `A2A server: ${value.endpoint}`,
          `card      : ${value.cardUrl}`,
          `auth      : ${value.tokenRequired ? 'token required (use it as the gateway agent\'s secret)' : 'loopback only (no token configured)'}`,
          `session   : ${value.boundSessionId || '(not bound yet — the next call binds it)'}`,
        ];
        if (value.steps !== undefined) {
          lines.push('', value.reachable ? 'Reachability: OK' : 'Reachability: BLOCKED');
          for (const step of value.steps) lines.push(`  ${step.ok ? 'OK  ' : 'FAIL'} ${step.step}: ${step.detail}`);
          if (value.hint !== undefined && value.hint !== '') lines.push('', value.hint);
        }
        if (value.gatewayEntry !== undefined && value.gatewayEntry !== '') {
          lines.push('', 'Gateway entry for this instance (one entry, all groups):', value.gatewayEntry);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
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
  }));
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

/** The registry as the flat list the tool returns. */
function listEntries(registry) {
  return registry.list().map((entry) => ({
    name: entry.name,
    baseUrl: entry.baseUrl,
    enabled: entry.enabled !== false,
    note: entry.note ?? '',
  }));
}

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

/** Join a gateway base and an agent name. */
export function joinUrl(base, agent) {
  return `${String(base).replace(/\/+$/, '')}/${String(agent).replace(/^\/+/, '')}`;
}

/** An error carrying a stable code. */
export function coded(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

/** Shorten a string for a one-line summary. */
function truncate(text, limit) {
  const single = String(text).replace(/\s+/g, ' ').trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}

/**
 * Parse a `dsh-a2a://group?v=1&...` invite link.
 *
 * Kept here rather than imported from `invite.js` so a tool call cannot fail on a
 * module cycle, and deliberately strict: a hand-edited link with a missing field
 * gets a readable error instead of a confusing join failure later.
 */
export function parseInviteLink(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    throw coded('invalid_link', 'that does not look like an invite link (expected dsh-a2a://group?...).');
  }
  if (url.protocol !== 'dsh-a2a:' || url.hostname !== 'group') {
    throw coded('invalid_link', 'that is not a dsh-a2a group invite link.');
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
