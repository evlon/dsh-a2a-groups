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
      name: 'a2a_person_send',
      description:
        'Send ONE message to ONE person — a group invitation, a join notice, or a welcome. This is a doorbell, not a chat: sustained private conversation belongs in a group, and there is no message kind for it. Use it when a colleague should be pulled into a group rather than handed a link to paste. The result says whether they are online and gives the message id; delivery is confirmed separately, because an HTTP call returning is not evidence that anybody received it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          to: { type: 'string', description: 'personId of the recipient. Get it from a2a_group_info\'s roster or a colleague card.' },
          kind: {
            type: 'string',
            enum: ['group-invite', 'join-notice', 'welcome'],
            description: 'group-invite mints a fresh single-use link for this one person. join-notice tells an owner somebody joined. welcome greets a new member.',
          },
          groupId: { type: 'string', description: 'The group the message is about. Required for group-invite.' },
          text: { type: 'string', description: 'Optional line shown to the recipient. A group-invite ignores it and shows the group instead.' },
        },
        required: ['to', 'kind'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dmId: { type: 'string' },
            online: { type: 'boolean' },
            kind: { type: 'string' },
          },
        },
        render: (args, value) => [{
          type: 'text',
          text: value.online === true
            ? `Queued and the recipient is online (dmId ${value.dmId}). Delivery is confirmed when their Session acknowledges it.`
            : `Queued (dmId ${value.dmId}); the recipient is offline and will see it when they reconnect.`,
        }],
      },
      runtime: 'a2a_person_send',
    },
    {
      name: 'a2a_person_inbox',
      description:
        'Messages waiting for me — invitations to groups, notices, welcomes. Read this on startup and when asked "anything waiting?". Each message carries what to act on: a group invitation includes a ready invite link, so joining does not require pasting anything.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          since: { type: 'number', description: 'Only messages created after this epoch-ms. Omit for everything current.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            messages: { type: 'array', items: { type: 'object' } },
          },
        },
        render: (args, value) => {
          const list = Array.isArray(value.messages) ? value.messages : [];
          return [{
            type: 'text',
            text: list.length === 0
              ? 'Nothing waiting.'
              : list.map((entry) => `- [${entry.kind}] ${entry.text}`).join('\n'),
          }];
        },
      },
      runtime: 'a2a_person_inbox',
    },
    {
      name: 'a2a_person_ack',
      description:
        'Confirm that messages actually arrived. Called automatically after reading the inbox; without it the sender never learns whether the message was delivered, and a messenger that reports success for undelivered messages loses trust immediately.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dmIds: { type: 'array', items: { type: 'string' }, description: 'Message ids to confirm.' },
        },
        required: ['dmIds'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            acked: { type: 'number' },
            unknown: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (args, value) => [{
          type: 'text',
          text: `Confirmed ${value.acked} message(s)`
            + (Array.isArray(value.unknown) && value.unknown.length > 0
              ? `; ${value.unknown.length} were not mine and were ignored.`
              : '.'),
        }],
      },
      runtime: 'a2a_person_ack',
    },
  {
    name: 'a2a_pending',
    description:
      'Is anything waiting for me? One call that answers it: unread group messages plus one-to-one invitations and notices, with counts and a one-line summary each. Call this at the START of a turn, or every few minutes while working — this server cannot push to you, so polling this is how you notice a colleague. Say "nothing waiting" when it returns empty rather than silently moving on.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeGroups: {
          type: 'boolean',
          description: 'Also report groups with unread messages. Defaults to true; pass false for direct messages only.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number' },
          directMessages: { type: 'array', items: { type: 'object' } },
          groups: { type: 'array', items: { type: 'object' } },
          summary: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.total === 0
          ? 'Nothing waiting.'
          : (value.directMessages.length > 0
              ? `${value.directMessages.length} direct message(s):\n`
                + value.directMessages.map((entry) => `  - [${entry.kind}] ${entry.text}`).join('\n')
              : '')
            + (value.groups.length > 0
              ? `\n${value.groups.length} group(s) with unread messages:\n`
                + value.groups.map((entry) => `  - ${entry.name}: ${entry.unread} new`).join('\n')
              : ''),
      }],
    },
    runtime: 'a2a_pending',
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
          personId: { type: 'string' },
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
          + `personId : ${value.personId}
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
          personId: { type: 'string' },
          remote: { type: 'boolean' },
          recentMessages: { type: 'integer' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Joined "${value.groupName}" (${value.groupId})${value.remote ? ' over A2A' : ' locally'}.\n`
          + `personId: ${value.personId}\n`
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
        headline: { type: 'string', description: 'How you introduce yourself in ONE sentence, independent of any group - it appears on every colleague card. Different from about, which is what you do in THIS group. Empty string clears it. Omit to leave unchanged.' },
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
          personId: { type: 'string' },
          remote: { type: 'boolean' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Joined「${value.groupName}」(${value.groupId})${value.remote ? ' over A2A' : ' locally'}.
`
          + `personId: ${value.personId}

`
          + 'This Session stored the credential; new posts will arrive as task messages.',
      }],
    },
  runtime: 'a2a_group_claim',
  },
  {
    name: 'a2a_group_remove',
    description:
      'Remove another member from a group. Owner only. Their messages stay in the feed: deleting them would rewrite the conversation, and history is the group record rather than the leaver property. A system line records the removal so the remaining members know what happened. To leave yourself, use a2a_group_leave instead — that hands ownership on.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        targetPersonId: { type: 'string', description: 'personId of the person to remove.' },
        reason: { type: 'string', description: 'Optional one-liner for the system entry, e.g. "转岗".' },
      },
      required: ['groupId', 'targetPersonId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          personId: { type: 'string' },
          displayName: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Removed ${value.displayName} (${value.personId}) from the group.

`
          + 'Their messages remain. They will get "not a member" on their next post, which is how their client '
          + 'learns to drop its local record.',
      }],
    },
  runtime: 'a2a_group_remove',
  },
  {
    name: 'a2a_group_rename',
    description:
      'Rename a group, change its topic, or both. Owner only. This is ordinary maintenance for a long-lived group; before it existed the only fix for a wrong name was to create a new group and lose the history.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        name: { type: 'string', description: 'New display name. Omit to leave it unchanged.' },
        topic: { type: 'string', description: 'New topic. An empty string clears it. Omit to leave it unchanged.' },
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
          changed: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.changed ?? []).length === 0
          ? 'Nothing changed: those are the current values.'
          : `Updated ${value.changed.join(' and ')}.
` + `name : ${value.name}` + (value.topic === '' ? '' : `
topic: ${value.topic}`),
      }],
    },
  runtime: 'a2a_group_rename',
  },
  {
    name: 'a2a_group_archive',
    description:
      'Archive a group (or reopen it). Owner only. Archived means readable but not writable, and absent from the directory. Deliberately not a delete: a finished project conversation is worth keeping, and reopening an archive by mistake must be possible.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        archived: { type: 'boolean', description: 'true to archive (default), false to reopen.' },
      },
      required: ['groupId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          archived: { type: 'boolean' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.archived === true
          ? 'Archived: still readable, no longer writable, hidden from the directory. Call again with archived=false to reopen.'
          : 'Reopened: writable again and listed in the directory.',
      }],
    },
  runtime: 'a2a_group_archive',
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