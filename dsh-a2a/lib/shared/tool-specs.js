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
          to: { type: 'string', description: 'personId of the recipient. Get it from a2a_group_summary\'s roster or a colleague card.' },
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
              : list.map((entry) => `- [${entry.kind}] ${entry.text}`
                  // The dmId is what `a2a_person_ack` needs. A list that omits it cannot be acknowledged, which is
                  // how an invitation stays "undelivered" forever even though the reader saw it.
                  + (typeof entry.dmId === 'string' && entry.dmId !== '' ? `\n  (dmId: ${entry.dmId})` : '')).join('\n'),
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
    name: 'a2a_inbox_check',
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
          // How many groups this Session actually belongs to. Without it 「0 unread」 cannot be told apart from
          // 「0 groups」, and those mean opposite things to a first-time reader.
          joinedGroups: { type: 'number' },
          summary: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        // 「Nothing waiting」 and 「you have joined nothing」 look identical and mean opposite things: the first says the
        // system is fine and quiet, the second says you are not in the room yet. Measured on a fresh MCP data
        // directory — every group tool answered `unknown_group` while this answered a calm 「Nothing waiting」, and a
        // new user had no way to tell they had simply not joined anything.
        text: value.joinedGroups === 0 && value.total === 0
          ? 'No groups joined yet — this is an EMPTY account, not a quiet one.\n\n'
            + 'Join first, in one of three ways:\n'
            + '  1. a2a_group_join with an invite link from a colleague — fastest, no approval needed\n'
            + '  2. a2a_group_directory to browse, then a2a_group_request (a group owner must approve)\n'
            + '  3. a2a_group_create to start your own\n'
            + 'If a colleague offered a link, ask the user for it.'
          : (value.total === 0
            ? 'Nothing waiting.'
            : (value.directMessages.length > 0
                ? `${value.directMessages.length} direct message(s):\n`
                  + value.directMessages.map((entry) => `  - [${entry.kind}] ${entry.text}`).join('\n')
                : '')
              + (value.groups.length > 0
                ? `\n${value.groups.length} group(s) with unread messages:\n`
                  + value.groups.map((entry) => `  - ${entry.name}: ${entry.unread} new`).join('\n')
                : '')),
      }],
    },
    runtime: 'a2a_inbox_check',
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
      // The old text said "every member is woken by it", which stopped being true when unaddressed posts became
      // quiet. A model reading it either avoids posting for fear of interrupting everybody, or describes one group
      // post as "sent to 李四 and 王五 separately" — which is exactly what a live run produced. This spec used to
      // contradict its own `mentions` description; only that half was right.
      'Post ONE message to the group: a single entry every member can read, not a separate delivery to each person. ' +
      'Who gets WOKEN depends on `mentions` — the listed members start a turn, everybody else sees an unread count ' +
      'and reads it when they next look. Omit `mentions` for ordinary progress; add it when somebody must act. ' +
      'Say "posted to the group", never "sent to X and Y", because that happened. ' +
      'When you are answering somebody, pass `replyTo` with the seq you are answering — that wakes them, and the '
      + 'reply reports `rootSeq`, the message the whole exchange started from. `replyTo` is who you answered; '
      + '`rootSeq` is which conversation you are in. ' +
      'Read a2a_group_read first when you need to know what was already said.',
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
        priority: {
          type: 'string',
          enum: ['urgent'],
          description:
            'Omit for an ordinary post: it waits for the reader\'s next turn. `urgent` inserts into a turn that is '
            + 'already running, so use it only when waiting for that turn to finish would defeat the message — a '
            + 'correction the reader is about to act on wrongly, a stop order, a changed constraint. It costs the '
            + 'reader an interrupted step, so an `urgent` that could have waited teaches the group to ignore the level. '
            + 'A message that SUPERSEDES an earlier instruction belongs here: without it the older message is the one '
            + 'they act on first. `urgent` reaches every member\'s running turn regardless of `mentions`, so add '
            + '`mentions` when you also want specific people named as the ones who must act.',
        },
        replyTo: {
          type: 'integer',
          description:
            'The seq this message answers. Pass it WHENEVER you choose to answer somebody: the author of that '
            + 'message is woken automatically, and the reply records the thread. Without it a reply is just another '
            + 'unaddressed post — the person who asked waits for a message nobody sent them to. '
            + 'Answering an @all broadcast needs no mentions at all: the reply goes to whoever broadcast it, NOT to '
            + 'everybody again. Do not reach for @all out of habit when answering — that re-wakes the whole group for '
            + 'one answer. Pass @all explicitly only when the answer really does concern everyone (the plan changed, '
            + 'everybody re-read this).',
        },
      },
      required: ['groupId', 'message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          seq: { type: 'integer' },
          groupId: { type: 'string' },
          groupName: { type: 'string' },
          memberCount: { type: 'integer' },
          wokeNames: { type: 'array', items: { type: 'string' } },
          receipt: { type: 'string' },
        },
      },
      /**
       * Two parts, in this order, because of how a human reads a tool block.
       *
       * The collapsed block shows ONE line. That line used to be
       * `Posted to g-1fad9113 at seq 712` — an internal id that leaves the reader asking "did that
       * go to 苏虎虎 or to everyone?". The first part now answers it in words: the group's name,
       * how many people can see it, and who was actually woken. `mentions` only decides who is
       * pinged; the post itself is readable by every member, and that difference is the whole point.
       *
       * The second part carries the text that was sent, so expanding the block shows what went out
       * without re-reading the arguments.
       */
      render: (args, value) => {
        const first = typeof value?.receipt === 'string' && value.receipt !== ''
          ? value.receipt
          : `已发到「${value?.groupName ?? value?.groupId ?? '?'}」· #${value?.seq ?? 0}`;
        const sent = typeof args?.message === 'string' ? args.message.trim() : '';
        return sent === ''
          ? [{ type: 'text', text: first }]
          : [
            { type: 'text', text: first },
            { type: 'text', text: `正文：${sent}` },
          ];
      },
    },
  runtime: 'a2a_group_post',
  },
  {
  
    name: 'a2a_group_set_card',
    description:
      'Say what you do in ONE group, and change it whenever it changes. This is self-description, not a permission — it grants nothing, and nobody can set it for you. Use it when someone takes on a different hat in a project (a developer who is also acting as product), so the group sees the current role rather than the job title. Omit `about` or `tags` to leave that part unchanged; pass an empty string / empty array to clear it. `displayName` is how you appear in this group\'s member list and colleague cards — set it when your name shows as a long id (like a session id) instead of a name.',
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
        displayName: { type: 'string', description: 'How you appear in this group\'s member list and colleague cards, e.g. "小 D". Set it when your name shows as a long id instead of a name.' },
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
          displayName: { type: 'string' },
          about: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Your card in this group is now:\n`
          + (value.displayName === undefined || value.displayName === '' ? '' : `  name : ${value.displayName}\n`)
          + `  about: ${value.about === '' ? '(not set)' : value.about}\n`
          + `  tags : ${(value.tags ?? []).join('、') || '(none)'}\n\n`
          + 'This is self-description only — it grants no permission, and it only '
          + 'changes YOUR card, not anyone else\'s.',
      }],
    },
  runtime: 'a2a_group_set_card',
  },
  {
  
    name: 'a2a_group_summary',
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
          // WHO is in the group, not just how many.
          //
          // The host has always sent this; the tool dropped it, so the only way to learn a colleague's name was to read
          // message headers and guess. A card without names is a headcount.
          members: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                personId: { type: 'string' },
                displayName: { type: 'string' },
                role: { type: 'string' },
                // Which row is the caller. A roster of five names answers 「who is in this group」 and leaves 「which of them
                // am I」 unanswered; a person has a different personId per group, so it cannot be derived elsewhere.
                isSelf: { type: 'boolean' },
                roleAbout: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                clientVersion: { type: 'string' },
                lastSeenAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const roster = Array.isArray(value.members) ? value.members : [];
        // Presence from lastSeenAt, never from a stored boolean: the boolean is a claim about NOW and is stale the moment
        // it is cached. Same rule as the panel.
        const ONLINE_MS = 5 * 60 * 1000;
        const now = Date.now();
        const lines = roster.map((member) => {
          const role = member.role === 'owner' ? '（群主）' : '';
          // Marking the caller is what turns a roster into an answer to 「我是谁」.
          const self = member.isSelf === true ? '（我）' : '';
          const about = typeof member.roleAbout === 'string' && member.roleAbout !== '' ? ` — ${member.roleAbout}` : '';
          const tags = Array.isArray(member.tags) && member.tags.length > 0 ? ` [${member.tags.join(' ')}]` : '';
          const seen = Number.isFinite(member.lastSeenAt)
            ? (now - member.lastSeenAt <= ONLINE_MS ? '在线' : '不在线')
            : '状态未知';
          // The personId is what `a2a_person_send` / `a2a_group_kick` need; a roster that shows only names leaves the
          // caller unable to act on any row. It is not a secret — it is the same id the roster already carries — so
          // showing it turns the roster from a display list into an addressable one.
          const id = typeof member.personId === 'string' && member.personId !== '' ? ` [${member.personId}]` : '';
          return `  - ${member.displayName}${role}${self}${about}${tags} · ${seen}${id}`;
        });
        return [{
          type: 'text',
          text: `${value.name}`
            + (value.topic === '' ? '' : ` — ${value.topic}`)
            + `\n${value.memberCount} 人`
            + (value.onlineCount > 0 ? `，${value.onlineCount} 人在线` : '')
            + `\n我的角色：${value.isOwner === true ? '群主' : '成员'}`
            + (lines.length === 0 ? '' : `\n成员：\n${lines.join('\n')}`),
        }];
      },
    },
  runtime: 'a2a_group_summary',
  },
  {
    name: 'a2a_self_check',
    description:
      'Check whether THIS client is set up correctly, and report who it is. Answers one question in one call: can I reach the host, is my credential good, which groups am I in, and what is my identity in each. Use it first when anything looks wrong — a wrong gateway, an expired token and a genuinely empty account all produce the same "no groups" symptom, and only this tool tells them apart.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          gateway: { type: 'string' },
          agent: { type: 'string' },
          // Never the token itself: a diagnostic that echoes a secret into a transcript is how secrets leak into logs.
          tokenPresent: { type: 'boolean' },
          groups: { type: 'integer' },
          identities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                groupId: { type: 'string' },
                groupName: { type: 'string' },
                personId: { type: 'string' },
                displayName: { type: 'string' },
              },
            },
          },
          // Whether this host can PUSH. False on MCP, and the reader needs to know that before wondering why nothing
          // arrives on its own.
          push: { type: 'boolean' },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                ok: { type: 'boolean' },
                detail: { type: 'string' },
                fix: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const mark = (ok) => (ok === true ? '✓' : '✗');
        const lines = value.checks.map((check) => (
          `${mark(check.ok)} ${check.name}${check.detail === '' ? '' : `  ${check.detail}`}`
          // A failing check without a fix is a complaint, not a diagnosis. The whole point of this tool is that the
          // reader learns what to change.
          + (check.ok === true || check.fix === '' ? '' : `\n     → ${check.fix}`)
        ));
        const who = value.identities.length === 0
          ? '\n我的身份：（还没有加入任何群）'
          : `\n我的身份：\n${value.identities.map((row) => (
            `  - ${row.groupName === '' ? row.groupId : row.groupName}：${row.displayName === '' ? '(未命名)' : row.displayName} [${row.personId}]`
          )).join('\n')}`;
        return [{
          type: 'text',
          text: `${value.ok === true ? '配置可用' : '配置有问题'}\n${lines.join('\n')}${who}`
            + `\n推送通道：${value.push === true ? '有（群消息会自己到达）' : '无（需要主动 a2a_inbox_check 拉取）'}`
            + (value.push === true
              ? ''
              : '\n建议：检测到你处于无推送环境，可启用长轮询监听模式——用 a2a_group_wait 循环（timeoutMs≤30000），'
                + '有消息立即报告用户、超时静默续轮，即可准实时收消息并保持在线。'),
        }];
      },
    },
  runtime: 'a2a_self_check',
  },
  {
    name: 'a2a_group_wait',
    description:
      'Wait up to timeoutMs for NEW messages in one group, then report whether any arrived. This is long-polling: one call that holds until a message lands (answered immediately) or the window expires (answered hasNew=false). Use it when told to keep watching a group in the background — it is the closest thing to a push channel this server has. '
      + 'RECOMMENDED: a client with background-task capability should loop this tool to stay "always on" — pass timeoutMs of at most 30000 (a client tool timeout is usually ~30s), report new messages to the user immediately, and on hasNew=false just continue the loop silently; do not treat a timeout as a failure. Keep timeoutMs at or below 55 seconds; the host clamps it. Pass sinceSeq (the last seq you saw) so only genuinely new messages count. Timeout is NOT an error: hasNew=false means "nothing yet", so loop it rather than reporting a failure.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        sinceSeq: { type: 'integer', description: 'Only messages with seq above this count. Defaults to your already-seen lastSeq when omitted.' },
        timeoutMs: { type: 'integer', description: 'How long to wait, in milliseconds. Defaults to 30000; the host clamps to at most 55000. For a background watch loop use at most 30000.' },
      },
      required: ['groupId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hasNew: { type: 'boolean' },
          waitedMs: { type: 'number' },
          lastSeq: { type: 'integer' },
          entries: { type: 'array', items: { type: 'object' } },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.hasNew === true
          ? `${(value.entries ?? []).length} new message(s):\n`
            + value.entries.map((entry) => `#${entry.seq} ${entry.from?.displayName ?? '?'}: ${entry.text}`).join('\n')
          : `No new message within the wait window (waited ${value.waitedMs} ms).`,
      }],
    },
    runtime: 'a2a_group_wait',
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
                // WHO I AM in this group. A person has a different personId per group, so this is per-row fact rather
                // than a constant — and without it 「我是谁」 has no answer anywhere on the tool surface.
                personId: { type: 'string' },
                displayName: { type: 'string' },
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
            `- ${group.name} (${group.groupId}) — ${group.role}`
            // Who I am here. A person has a different personId per group, so it is worth printing on each row rather than
            // once at the top.
            + (typeof group.displayName === 'string' && group.displayName !== '' ? ` as ${group.displayName}` : '')
            + (typeof group.personId === 'string' && group.personId !== '' ? ` [${group.personId}]` : '')
            + `, ${group.members} member(s), last seq ${group.lastSeq}`
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
  
    name: 'a2a_group_approvals',
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
  runtime: 'a2a_group_approvals',
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
        requestId: { type: 'string', description: 'Request id from a2a_group_approvals.' },
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
    name: 'a2a_group_kick',
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
  runtime: 'a2a_group_kick',
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
    name: 'a2a_group_leave',
    description:
      'Leave a group and give up my membership. For a locally hosted group this removes my row here; for a remote group it asks the host FIRST and only then drops the local credential — so a failed call is retryable rather than final. Safe to call twice: a second call retries the host instead of claiming you already left. Never removes anybody else; that is a2a_group_kick.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
      },
      required: ['groupId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          left: { type: 'boolean' },
          pending: { type: 'boolean' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.left === true
          ? 'Left the group.'
          : (value.pending === true
              ? 'Could not reach the host yet; the membership is marked for retry and the credential is kept.'
              : 'You are not in that group.'),
      }],
    },
    runtime: 'a2a_group_leave',
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
  {
    name: 'a2a_group_conventions',
    description:
      'Set up or customise this group\'s standing rules — the "how we work here" notice every member receives when they join. Owner only. '
      + 'THE GROUP STARTS WITH EIGHT BUILT-IN RULES: focus on your own work; do not police colleagues who did not ask; discuss only what advances the goal; '
      + 'finish your part then speak; challenge the goal instead of staying silent; give verifiable evidence; do not reopen settled points; anyone may declare an emergency. '
      + 'Most groups only need to ADD a clause or two with `extra` — the defaults already cover the common failures, and a group that copies-then-edits the whole text stops '
      + 'receiving improvements to it. Use `conventions` only when the defaults are wrong for this group. `reset` goes back to the defaults, and on a NEW group it is how you '
      + 'turn the organisation layer on without typing anything. Kept apart from the goal on purpose: a goal is replaced every few weeks, the rules are the part that should not change with it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        extra: {
          type: 'string',
          description: 'Clauses to ADD to the built-in rules. This is the normal way to customise a group: the eight default rules already cover focus, boundaries and evidence, so a group usually needs one or two more, not a rewrite. An empty string removes the additions. Omit to leave them unchanged.',
        },
        conventions: {
          type: 'string',
          description: 'Replace the built-in rules ENTIRELY with this text. Use it only when the defaults are wrong for this group — a group that replaces them stops receiving improvements to the defaults. An empty string clears the override (back to defaults). Omit to leave it unchanged.',
        },
        reset: {
          type: 'boolean',
          description: 'Discard both the override and the additions, going back to the built-in rules. This is also how a NEW group turns the organisation layer on without typing anything out: pass reset=true on an untouched group.',
        },
      },
      required: ['groupId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          conventions: { type: 'string' },
          changed: { type: 'boolean' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.changed !== true
          ? 'Conventions unchanged.'
          : (value.conventions === undefined || value.conventions === ''
            ? 'Conventions cleared: new members will be told nothing.'
            : `Conventions set (${String(value.conventions).length} chars). Every member who joins from now on receives them, and any member can read them with a2a_goal_status.`),
      }],
    },
    runtime: 'a2a_group_conventions',
  },
  {
    name: 'a2a_goal_publish',
    description:
      'Publish the group\'s ONE main goal — the thing every discussion in this group is supposed to advance. Owner only. One goal at a time, and publishing while one is active FAILS instead of replacing it: ending the current goal first is the call that forces the group to notice a change of direction. Give 1-6 key results (krs); without at least one, "is this on topic" would be a judgement about a sentence rather than about the plan. This is the tool that turns a chat room into a team.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        title: { type: 'string', description: 'One sentence: what the group is trying to achieve.' },
        description: { type: 'string', description: 'Optional context: why this, why now, what is out of scope.' },
        krs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key results: 1-6 concrete checkpoints. Backticks-free plain text; the tool result numbers them kr1..krN.',
        },
        strictness: {
          type: 'string',
          enum: ['off', 'hint'],
          description: 'off = only display the goal; hint = every reply should remind the reader which key result it serves. Defaults to hint.',
        },
      },
      required: ['groupId', 'title', 'krs'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          goal: { type: 'object', additionalProperties: true },
        },
      },
      render: (args, value) => {
        const goal = value.goal ?? {};
        const krs = Array.isArray(goal.krs) ? goal.krs : [];
        return [{
          type: 'text',
          text: `Goal published: ${goal.title ?? ''}\n\nKey results (the anchors every reply should name):\n`
            + krs.map((kr) => `  ${kr.id}: ${kr.text}`).join('\n')
            + `\n\nStrictness: ${goal.strictness ?? 'hint'}. It stays the group's only goal until someone closes it — a second publish will be refused, not merged.`,
        }];
      },
    },
    runtime: 'a2a_goal_publish',
  },
  {
    name: 'a2a_goal_close',
    description:
      'End the group\'s current goal. Owner, or whoever published it. A reason is required — it is what the group reads afterwards instead of wondering why the target changed. After closing, a new goal can be published. Do not use this to "temporarily set the goal aside": that is a2a_goal_emergency, which lapses on its own and does not interrupt the goal\'s continuity.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        reason: { type: 'string', description: 'Why it is over: achieved, abandoned, superseded. Shown in the feed.' },
      },
      required: ['groupId', 'reason'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          goal: { type: 'object', additionalProperties: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Goal closed: ${value.goal?.title ?? ''}\nReason: ${value.goal?.closeReason ?? ''}\nThe group has no goal now; the owner can publish the next one.`,
      }],
    },
    runtime: 'a2a_goal_close',
  },
  {
    name: 'a2a_goal_status',
    description:
      'Read the group\'s current goal, its key results, its standing conventions, and recent closed goals. Any member can call it. This is the first call a newcomer should make: it is the only place that says what this group is for and how it works. When a goal has an unanswered challenge, this is also where the deadline shows up.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
      },
      required: ['groupId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          enabled: { type: 'boolean' },
          conventions: { type: 'string' },
          goal: { type: 'object', additionalProperties: true },
          history: { type: 'array', items: { type: 'object', additionalProperties: true } },
          answerByIso: { type: 'string' },
        },
      },
      render: (args, value) => {
        if (value.enabled === false) {
          return [{ type: 'text', text: 'This group has the organisation layer switched off (goal/conventions are not in use here).' }];
        }
        const lines = [];
        if (value.conventions !== undefined && value.conventions !== '') {
          lines.push('Conventions (how this group works):', value.conventions, '');
        }
        const goal = value.goal;
        if (goal === undefined) {
          lines.push('No goal right now. The owner can publish one with a2a_goal_publish.');
        } else {
          lines.push(`Goal (${goal.status}): ${goal.title}`);
          if (goal.description !== undefined && goal.description !== '') lines.push(`  why: ${goal.description}`);
          for (const kr of goal.krs ?? []) lines.push(`  ${kr.id}: ${kr.text}`);
          lines.push(`  strictness: ${goal.strictness}`);
          if (goal.emergency !== undefined) {
            lines.push(`  EMERGENCY in force until ${goal.emergency.untilIso}: ${goal.emergency.reason}`);
          }
          if (goal.status === 'suspended') {
            lines.push(`  SUSPENDED since ${goal.suspendedSinceIso ?? ''} — the challenge was not answered, so this goal no longer aligns anything until the owner answers it.`);
          }
          if (Array.isArray(goal.challenges) && goal.challenges.length > 0) {
            lines.push('  challenges:');
            for (const challenge of goal.challenges) {
              lines.push(`    - ${challenge.displayName}: ${challenge.reason}${challenge.alternative === undefined ? '' : ` (建议: ${challenge.alternative})`}`);
            }
          }
          if (goal.closeReason !== undefined) lines.push(`  closed: ${goal.closeReason}`);
        }
        if (Array.isArray(value.history) && value.history.length > 0) {
          lines.push('', 'Earlier goals:');
          for (const entry of value.history) lines.push(`  - ${entry.title} (${entry.closeReason ?? 'closed'})`);
        }
        if (value.answerByIso !== undefined) {
          lines.push('', `A challenge needs an answer by ${value.answerByIso}, or the goal suspends on its own.`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    runtime: 'a2a_goal_status',
  },
  {
    name: 'a2a_goal_challenge',
    description:
      'Disagree with the goal itself. Any member. This exists because every "stay on topic" rule creates the same hazard: it also silences the one person who noticed the topic is wrong. A challenge is the sanctioned way out, and it is NOT a reply — it is a recorded objection with a deadline. The goal is not suspended immediately (one line must not stall the group); it suspends automatically if the challenge goes unanswered for 24h, so the cost of ignoring it lands on the owner.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        reason: { type: 'string', description: 'What is wrong with the goal: the premise, the scope, the priority.' },
        alternative: { type: 'string', description: 'Optional: what to do instead. A challenge without one asks the group to stop without saying where to.' },
      },
      required: ['groupId', 'reason'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          goal: { type: 'object', additionalProperties: true },
          answerByIso: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Challenge recorded against "${value.goal?.title ?? ''}".\nThe owner has until ${value.answerByIso ?? '(unknown)'} to respond; after that the goal suspends on its own and stops being used to align discussion.`,
      }],
    },
    runtime: 'a2a_goal_challenge',
  },
  {
    name: 'a2a_goal_emergency',
    description:
      'Declare an emergency that sets the goal aside for 24 hours. ANY member, effective immediately — during an incident nobody waits for the owner. Deliberately not a close: closing and reopening is the state change people forget to undo, so this exception lapses by itself and the goal keeps its continuity. Use it when real work cannot wait for the plan to be revised.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        reason: { type: 'string', description: 'What is burning. Shown in the feed so the exception is auditable.' },
      },
      required: ['groupId', 'reason'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          goal: { type: 'object', additionalProperties: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Emergency declared: ${value.goal?.emergency?.reason ?? ''}\nThe goal "${value.goal?.title ?? ''}" is set aside until ${value.goal?.emergency?.untilIso ?? ''}. It expires on its own — nothing to undo.`,
      }],
    },
    runtime: 'a2a_goal_emergency',
  },
  {
    name: 'a2a_group_file_send',
    description:
      'Send ONE file from this machine into a group, and post a message that references it. The file is uploaded '
      + 'to the group host in chunks, its sha256 is verified there, and only then does it become downloadable by the '
      + 'other members — so a transfer that dies halfway leaves nothing anybody can open. Max 10 MiB per file, 200 MiB '
      + 'per group; older files are pruned on the group\'s retention window, the same one the message feed uses. The '
      + 'recipients get a reference (name, size, sha256), not the bytes: they call a2a_group_file_get to fetch it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        path: { type: 'string', description: 'Absolute path of the local file to send. It is read, not modified.' },
        message: { type: 'string', description: 'Text to post with the attachment. Omit to post just the file and its name.' },
        mentions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Who should ACT on this, same semantics as a2a_group_post. Omit for ordinary sharing.',
        },
      },
      required: ['groupId', 'path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          fileId: { type: 'string' },
          name: { type: 'string' },
          size: { type: 'integer' },
          sha256: { type: 'string' },
          seq: { type: 'integer' },
          chunks: { type: 'integer' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Sent «${value.name}» (${Math.max(1, Math.round((value.size ?? 0) / 1024))} KiB) to the group in ${value.chunks ?? 1} chunk(s).\n`
          + `posted as seq ${value.seq}; fileId ${value.fileId}\n`
          // The digest is the one verifiable fact about what was sent. Omitting it from the visible
          // text made a tester compute it themselves and note that the tool "did not report" it —
          // the value was in the result, but a model reads the rendered text, not the schema.
          + `sha256 ${value.sha256 ?? '(unknown)'}\n`
          + 'This means the file is stored and the message is in the feed — NOT that anyone has opened it yet.',
      }],
    },
    runtime: 'a2a_group_file_send',
  },
  {
    name: 'a2a_group_file_get',
    description:
      'Download ONE attachment from a group to this machine. The host verifies nothing at this end, so this tool '
      + 'recomputes the sha256 after assembling the chunks and REFUSES to write the file when it does not match — a '
      + 'corrupted transfer that silently succeeds is worse than one that fails. Pass the fileId from the message that '
      + 'references the attachment.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        fileId: { type: 'string', description: 'The attachment id from the attachments list of the message that references it.' },
        path: { type: 'string', description: 'Where to write the file. An existing file is NOT overwritten unless overwrite is true.' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing file at path. Defaults to false.' },
      },
      required: ['groupId', 'fileId', 'path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          fileId: { type: 'string' },
          path: { type: 'string' },
          name: { type: 'string' },
          size: { type: 'integer' },
          sha256: { type: 'string' },
          chunks: { type: 'integer' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Saved «${value.name}» to ${value.path} (${Math.max(1, Math.round((value.size ?? 0) / 1024))} KiB, ${value.chunks ?? 1} chunk(s)).\n`
          + 'sha256 verified against what the sender declared.',
      }],
    },
    runtime: 'a2a_group_file_get',
  },
  {
    name: 'a2a_group_file_list',
    description:
      'List the attachments a group still holds, with their sizes and how much of the quota is used. Use it before '
      + 'sending something large, and to find the fileId of an attachment whose message has scrolled away.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
      },
      required: ['groupId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          files: { type: 'array', items: { type: 'object', additionalProperties: true } },
          usedBytes: { type: 'integer' },
        },
      },
      render: (args, value) => {
        const files = Array.isArray(value.files) ? value.files : [];
        if (files.length === 0) return [{ type: 'text', text: 'This group holds no attachments.' }];
        const lines = files.map((file) => `  ${file.fileId}  ${Math.max(1, Math.round((file.size ?? 0) / 1024))} KiB  ${file.name}`);
        return [{
          type: 'text',
          text: `${files.length} attachment(s), ${Math.max(1, Math.round((value.usedBytes ?? 0) / 1024))} KiB used:\n`
            + lines.join('\n'),
        }];
      },
    },
    runtime: 'a2a_group_file_list',
  },
  {
    name: 'a2a_group_control',
    description:
      'Pause or resume THIS GROUP\'s delivery. Owner only. While paused, ordinary posts still go into the feed for anyone who looks, but they wake nobody — so the group goes quiet without anything being lost. This is a state, not a message, and that is the point: the failure it fixes is a "stop talking" post that everybody honoured, after which four later requests for input were silently swallowed because nobody remembered to lift it — including whoever set it. There is deliberately no auto-expiry: a group that believes it is paused while it is not is worse than one paused too long. Always read the returned state back; do not assume your call landed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'string', description: 'Group id.' },
        action: {
          type: 'string',
          enum: ['stop', 'resume'],
          description: 'stop pauses delivery for the whole group; resume lifts the pause. Both are recorded in the feed with who did it and why.',
        },
        reason: {
          type: 'string',
          description: 'Why. REQUIRED for stop — the group reads it later to understand the silence. Optional for resume.',
        },
      },
      required: ['groupId', 'action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string' },
          control: { type: 'object', additionalProperties: true },
        },
      },
      render: (args, value) => {
        const control = value.control ?? {};
        const when = typeof control.atIso === 'string' ? control.atIso : '';
        return [{
          type: 'text',
          text: control.stopped === true
            ? `Group delivery PAUSED by ${control.byPersonId ?? 'owner'} at ${when}: ${control.reason ?? ''}\nOrdinary posts are still recorded but wake nobody. Call this tool again with action=resume to lift it — nothing lifts it automatically.`
            : `Group delivery RESUMED at ${when}.${control.reason === undefined || control.reason === '' ? '' : `\n${control.reason}`}`,
        }];
      },
    },
    runtime: 'a2a_group_control',
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