/**
 * Every tool this package offers, as pure data.
 *
 * A spec is what a host needs in order to OFFER a tool: name, the description a model
 * reads to decide whether to call it, the JSON Schema for its arguments, and the JSON
 * Schema plus renderer for its result.
 *
 * `runtime` names the handler in tool-runtime.js. That indirection is what lets two
 * hosts share one definition:
 *
 *   - tools.js      adapts specs to `ctx.tools.register` (DSH)
 *   - mcp-server.js adapts specs to `tools/list` and `tools/call` (MCP)
 *
 * The description and schemas live here rather than in either adapter, which is what
 * guarantees the two hosts offer the SAME tools with the same contracts: a model that
 * learned `a2a_group_post` inside DSH finds the same shape in an MCP client.
 *
 * `render` stays here too. It is a pure function of (args, value) -> content parts,
 * depends on neither host, and an adapter that reimplemented it would drift.
 *
 * @module dsh-a2a/tool-specs
 */

/** Every tool spec, in registration order. */
export const TOOL_SPECS = Object.freeze([
  {
  
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
  runtime: 'a2a_agents',
  },
  {
  
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
  runtime: 'a2a_discover',
  },
  {
  
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
  runtime: 'a2a_send',
  },
  {
  
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
  runtime: 'a2a_stream',
  },
  {
  
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
  runtime: 'a2a_group_create',
  },
  {
  
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
  runtime: 'a2a_group_invite',
  },
  {
  
    name: 'a2a_group_join',
    description:
      'Join a group from an invite link (or a raw groupId plus token). No password is involved: the token IS the credential. Works for a group on this instance and for one behind the gateway — a remote group is joined over A2A. After joining, this Session receives the group\'s messages.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        link: { type: 'string', description: 'The agent-a2a://group?... invite link.' },
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
  runtime: 'a2a_group_join',
  },
  {
  
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
  runtime: 'a2a_group_post',
  },
  {
  
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
  runtime: 'a2a_group_role',
  },
  {
  
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
  runtime: 'a2a_group_info',
  },
  {
  
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
  runtime: 'a2a_group_read',
  },
  {
  
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
              // No join policy in this line: a group has no admission mode to advertise any
              // more. Anyone may ASK to join, and an invite link needs the owner to mint one.
              return `- ${group.name}（${group.memberCount} 人${online}）`
                + (group.topic === '' ? '' : `\n  ${group.topic}`)
                + `\n  id: ${group.groupId}`;
            }).join('\n')
            + '\n\n要加入某个群：用 a2a_group_request 申请（群主会看到），或向群主要一个邀请链接。',
      }],
    },
  runtime: 'a2a_group_directory',
  },
  {
  
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
  runtime: 'a2a_groups',
  },
  {
  
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
  runtime: 'a2a_group_inbox',
  },
  {
  
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
  runtime: 'a2a_group_request',
  },
  {
  
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
  runtime: 'a2a_group_requests',
  },
  {
  
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
  runtime: 'a2a_group_decide',
  },
  {
  
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
  runtime: 'a2a_group_claim',
  },
  {
  
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
  runtime: 'a2a_serve',
  },
]);

/** Specs by name, built once. */
const BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]));

/**
 * One spec by name.
 *
 * @param {string} name - tool name.
 * @returns {object|undefined} the spec.
 */
export function specOf(name) {
  return BY_NAME.get(name);
}

/** Every spec, as an array. */
export function allSpecs() {
  return TOOL_SPECS;
}
