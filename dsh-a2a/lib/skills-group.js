/**
 * The group skills: create, invite, join, post, read, subscribe, members, leave.
 *
 * A group is a DSH instance that registered itself as an A2A agent, so these
 * skills are the whole protocol between a group host and its members. Three
 * decisions deserve their reasons written down, because each looks odd without
 * one:
 *
 *   **Every member call carries `memberId` + `memberKey` in the payload, not in
 *   a header.** A2A's auth story is the transport's (the gateway's API key), and
 *   that credential says "this caller may reach this agent" — not "this caller
 *   is a member of this group". Keeping the membership proof in the payload
 *   means the gateway cannot see it (it only logs an opaque JSON body) and the
 *   group host does not need a second authentication scheme stacked on A2A.
 *
 *   **`group/subscribe` is a stream, everything else is unary.** A member has to
 *   learn about a post without polling, and A2A already has exactly one
 *   mechanism for "keep telling me as things happen". Using it means a member's
 *   plugin holds one long-lived SSE connection and never has to invent its own
 *   delta format.
 *
 *   **`group/invite` takes the owner key as well as the role check.** The role
 *   on a member view is a display field, not an authorization fact; passing the
 *   credential through to the store gives the store a cryptographic second line
 *   behind the caller-side check.
 *
 * @module dsh-a2a/skills-group
 */

import { randomFillSync } from 'node:crypto';

// A skill call arrives over A2A and therefore carries no Session: the caller is a
// remote agent, not a conversation. A pure group host is exactly that case, and it
// still keeps a membership record (the owner credential lives there). See
// `HOST_SESSION_ID` for why that record cannot simply be keyed on nothing.
import { HOST_SESSION_ID } from './memberships.js';

/** How many feed entries a join hands back so a new member has context. */
const JOIN_FEED_TAIL = 20;

/** How many entries one `group/read` returns when the caller names no limit. */
const DEFAULT_READ_LIMIT = 50;

/** Largest `group/read` page, so one call cannot return an unbounded feed. */
const MAX_READ_LIMIT = 200;

/**
 * Build every group skill over one store.
 *
 * @param {object} deps - `{ store, identities, config, logger, clock }`.
 *   `store` is `createGroupStore(...)`; `identities` is the membership ledger,
 *   which is how a local member proves itself without a network round trip.
 * @returns {object[]} the skill definitions, in card order.
 */
export function createGroupSkills({ store, identities, config, logger, clock = () => Date.now() }) {
  const settings = config.groups;

  /**
   * Turn a store refusal into the A2A error shape the server expects.
   *
   * The store speaks in `GroupError` with a stable `code`; re-throwing keeps the
   * code so the server can put it in `error.data.code` and a caller can branch on
   * "wrong password" versus "expired invite" without parsing Chinese prose.
   */
  const refuse = (error) => {
    const wrapped = new Error(describe(error));
    wrapped.code = typeof error?.code === 'string' ? error.code : 'group_error';
    throw wrapped;
  };

  /**
   * The structured payload of one call.
   *
   * The server hands a skill `{text, message, data, metadata, skill, messageId}`,
   * where `data` is the caller's `params.message.metadata.data` already unwrapped.
   * Skills read their fields from here rather than from the top level, so the wire
   * envelope has exactly one shape: a caller never has to guess whether `groupId`
   * belongs beside `skill` or under `data`.
   */
  const payload = (input) => (isPlainObject(input?.data) ? input.data : {});

  /**
   * Every member call starts by proving membership.
   *
   * The proof is accepted in the payload form the store understands, so the
   * store's own constant-time comparison is what decides — this function only
   * checks that the fields are present.
   */
  const requireMember = (input) => {
    const data = payload(input);
    const groupId = required(data.groupId, 'groupId');
    const memberId = required(data.memberId, 'memberId');
    const memberKey = required(data.memberKey, 'memberKey');
    return { groupId, member: { memberId, memberKey } };
  };

  return [
    {
      id: 'group/create',
      name: 'Create a group',
      description:
        'Create a collaboration group on this instance. Returns the group id and a one-time owner key: the caller must keep that key, because it is what authenticates the owner to the group from now on.',
      examples: ['Create a group called "invoice refactor" about splitting the invoice service'],
      async run(input, context) {
        const name = required(payload(input).name, 'name');
        const data = payload(input);
        try {
          // No password: admission is an invite token or an approved request, both
          // of which the owner can revoke per person. See `groups.js#create`.
          const created = store.create({
            name,
            topic: typeof data.topic === 'string' ? data.topic : '',
            ownerDisplayName: typeof data.ownerDisplayName === 'string' && data.ownerDisplayName !== ''
              ? data.ownerDisplayName
              : 'owner',
            // `visibility` decides whether the group appears in the channel
            // directory. Passing it through is what makes `settings` meaningful
            // from a caller: without it, `unlisted` could only be set by editing
            // groups.json by hand.
            settings: {
              visibility: data.visibility === 'unlisted' ? 'unlisted' : 'public',
            },
          });
          const groupId = created.group.groupId;
          const ownerMemberId = created.group.owner.memberId;
          identities.upsert({
            sessionId: context?.sessionId ?? HOST_SESSION_ID,
            groupId,
            memberId: ownerMemberId,
            memberKey: created.ownerKey,
            local: true,
            groupName: created.group.name,
            role: 'owner',
            lastSeq: created.group.lastSeq ?? 0,
          });
          logger?.info?.(`a2a: group "${name}" created as ${groupId} (owner key issued once)`);
          return {
            text: `Group "${name}" created.\n\n`
              + `groupId : ${groupId}\n`
              + `memberId: ${ownerMemberId}\n`
              + `ownerKey: ${created.ownerKey}   ← shown once; this instance has stored it, and you need it nowhere else\n\n`
              + 'Next: a2a_group_invite to mint an invite link and a paste-ready message for a colleague.',
            meta: {
              groupId,
              name: created.group.name,
              memberId: ownerMemberId,
              ownerKey: created.ownerKey,
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/invite',
      name: 'Invite someone to a group',
      description:
        'Mint an invite: a link plus a paste-ready message for an IM. The link carries a token that the owner can revoke at any time; it has no use counter, so it works for everyone you send it to until it expires or is revoked. Only the group owner may mint one.',
      examples: ['Make an invite for the invoice group, labelled for 张工, valid 7 days', 'Make a permanent invite for the announcements group'],
      async run(input) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        try {
          const issued = store.invite({
            groupId,
            label: typeof data.label === 'string' ? data.label : undefined,
            // `undefined` = configured default; `null` = never expires. The store
            // tells them apart, so passing the field through unchanged is correct.
            expiresInHours: data.expiresInHours === undefined ? undefined : data.expiresInHours,
            // Only the owner may mint, and the store enforces it against the owner
            // credential itself — the caller-side role check is a courtesy.
            ownerKey: member.memberKey,
            gatewayBase: settings.gatewayBase === '' ? undefined : settings.gatewayBase,
            agent: settings.agentName === '' ? undefined : settings.agentName,
          });
          return {
            text: issued.prompt,
            meta: {
              groupId,
              token: issued.token,
              link: issued.link,
              prompt: issued.prompt,
              expiresAt: issued.expiresAt === null ? '' : new Date(issued.expiresAt).toISOString(),
              neverExpires: issued.expiresAt === null,
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/join',
      name: 'Join a group',
      description:
        'Join a group with an invite link token and a display name. Returns a member key, shown once: it authenticates every later call. No password is involved — the token is the credential.',
      examples: ['Join group g-7f3a1c with token inv_xxx'],
      async run(input, context) {
        const data = payload(input);
        const groupId = required(data.groupId, 'groupId');
        try {
          const joined = store.join({
            groupId,
            token: typeof data.token === 'string' && data.token !== '' ? data.token : undefined,
            displayName: typeof data.displayName === 'string' && data.displayName !== '' ? data.displayName : 'member',
            endpoint: typeof data.endpoint === 'string' ? data.endpoint : undefined,
          });
          identities.upsert({
            sessionId: context?.sessionId ?? HOST_SESSION_ID,
            groupId,
            memberId: joined.member.memberId,
            memberKey: joined.memberKey,
            local: true,
            groupName: joined.group.name,
            role: joined.member.role,
            lastSeq: joined.group.lastSeq ?? 0,
          });
          return {
            text: `Joined "${joined.group.name}".\n\n`
              + `groupId  : ${groupId}\n`
              + `memberId : ${joined.member.memberId}\n`
              + `memberKey: ${joined.memberKey}   ← shown once; this instance has stored it\n\n`
              + `${joined.feedTail.length} recent message(s) are included in the result.`,
            meta: {
              groupId,
              memberId: joined.member.memberId,
              memberKey: joined.memberKey,
              groupName: joined.group.name,
              topic: joined.group.topic ?? '',
              members: joined.group.memberCount,
              lastSeq: joined.group.lastSeq ?? 0,
              feedTail: joined.feedTail,
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/post',
      name: 'Post to a group',
      description:
        'Post a message to a group. Every member is woken by it, so post what a member should act on, not a running commentary. Returns the sequence number the post landed on.',
      examples: ['Tell the group the migration is done and the branch is merged'],
      async run(input) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        // Two spellings, one meaning: the A2A message's own text part (what a
        // human-facing caller sends) and `data.text` (what a programmatic caller
        // sends when it has no prose to put in a part). Taking either keeps a
        // simple caller from having to know which one this skill reads.
        // `data.text` wins over the message's own text part.
        //
        // Reasoning, because the opposite looks equally plausible: the A2A
        // envelope always has a `parts` array, and a caller that carries its real
        // payload in `metadata.data` still has to put SOMETHING in that part —
        // so what arrives as `input.text` is often a label like "group/post",
        // not the message. The structured field is the one the caller chose
        // deliberately, so it is the truthful source. `input.text` remains the
        // fallback for a human-facing caller that typed prose with no metadata.
        const fromPayload = typeof data.text === 'string' ? data.text : '';
        const text = fromPayload !== ''
          ? fromPayload
          : (typeof input.text === 'string' ? input.text : '');
        if (text.trim() === '' && data.payload === undefined) {
          throw coded('empty_message', 'group/post needs a non-empty text');
        }
        try {
          const posted = store.post({ groupId, member, text, payload: data.payload });
          return {
            text: `Posted to the group at seq ${posted.seq}.`,
            meta: { seq: posted.seq, msgId: posted.msgId, at: posted.atIso },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/read',
      name: 'Read a group feed',
      description:
        'Read group messages newer than a sequence number. Use it after a reconnect (pass the last seq you saw) or when a stream is unavailable. Read-only — it never wakes a Session.',
      examples: ['Read everything after seq 41'],
      async run(input) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        try {
          const page = store.read({
            groupId,
            member,
            sinceSeq: finiteOr(data.sinceSeq, 0),
            limit: clamp(finiteOr(data.limit, DEFAULT_READ_LIMIT), 1, MAX_READ_LIMIT),
          });
          return {
            text: page.entries.length === 0
              ? 'No new messages.'
              : page.entries
                .map((entry) => `#${entry.seq} ${entry.from.displayName} (${entry.atIso}): ${entry.text}`)
                .join('\n'),
            meta: {
              // `lastSeq` is the group head, not the last entry returned: a caller
              // that stores it will read forward from the right place even when a
              // page was empty because nothing new had arrived.
              lastSeq: page.lastSeq,
              truncated: page.truncated,
              entries: page.entries.map((entry) => ({
                seq: entry.seq,
                msgId: entry.msgId,
                at: entry.at,
                atIso: entry.atIso,
                from: entry.from.displayName,
                memberId: entry.from.memberId,
                kind: entry.kind,
                text: entry.text,
              })),
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/subscribe',
      name: 'Subscribe to a group feed',
      description:
        'Open a stream of new group messages. Each new post arrives as an artifact update; a heartbeat keeps the connection alive. Reconnect with sinceSeq to resume where you left off.',
      examples: ['Subscribe to the invoice group from seq 41'],
      streaming: true,
      async run(input, context) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        const sinceSeq = finiteOr(data.sinceSeq, 0);
        const emit = context.emit;
        if (typeof emit !== 'function') {
          throw coded('not_streaming', 'group/subscribe requires a streaming caller');
        }
        // Catch up first. A member restarting its subscription must not miss what
        // was posted while it was away, and replaying from the durable feed is
        // more truthful than asking posters to re-send.
        const backlog = store.read({ groupId, member, sinceSeq, limit: MAX_READ_LIMIT });
        for (const entry of backlog.entries) emit('post', entry);

        const dispose = store.subscribe({ groupId, fn: (entry) => emit('post', entry) });
        try {
          // Hold the stream open until the caller goes away. The server owns the
          // heartbeat and the timeouts; this skill only has to not return.
          await context.untilCancelled();
        } finally {
          dispose();
        }
        return { text: 'subscription closed' };
      },
    },
    {
      id: 'group/members',
      name: 'List group members',
      description: 'List the members of a group: display name, permission role, what each person says they do here, and whether they are online.',
      examples: ['Who is in the invoice group?'],
      async run(input) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        try {
          const members = store.members({ groupId, member });
          return {
            // `role` is the permission bit; `about`/`tags` are what each person
            // said about themselves in this group. Kept visibly distinct in the
            // rendered text so nobody reads "产品" as an entitlement.
            text: members.map((item) => {
              const label = item.role === 'owner' ? '群主' : '成员';
              const declared = [
                item.roleAbout === undefined || item.roleAbout === '' ? '' : item.roleAbout,
                (item.tags ?? []).join('、'),
              ].filter((part) => part !== '').join(' · ');
              const presence = item.online === true ? ', 在线' : '';
              return `- ${item.displayName} [${label}${presence}]${declared === '' ? '' : ` — ${declared}`}`;
            }).join('\n'),
            meta: {
              groupId,
              members: members.map((item) => ({
                memberId: item.memberId,
                displayName: item.displayName,
                role: item.role,
                // Layer A, self-declared. An older member that never set these
                // reads as an empty about and no tags, not as a missing field.
                about: item.roleAbout ?? '',
                tags: item.tags ?? [],
                joinedAt: item.joinedAt,
                lastSeenAt: item.lastSeenAt,
                online: item.online === true,
              })),
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/directory',
      name: 'Browse this host\'s groups',
      description:
        'List the groups this host offers: name, topic, join policy, member count and when each was last active. Needs no credential — it is a directory, not a roster. Member identities and message content are never returned here; use group/members and group/read with a member credential for those. Groups marked unlisted are omitted entirely.',
      examples: ['What groups are there on this host?', 'Is there anything about invoices?'],
      async run(input) {
        const data = payload(input);
        try {
          // Deliberately no `requireMember`: this is the browse-before-you-join
          // path, and requiring a credential would make the directory useless to
          // exactly the person who needs it.
          const page = store.listDirectory({
            query: typeof data.query === 'string' ? data.query : undefined,
            limit: data.limit,
            offset: data.offset,
          });
          return {
            text: page.groups.length === 0
              ? 'No public groups on this host.'
              : page.groups.map((group) => {
                // Two ways in, and the directory says which one applies: asking is
                // always possible (the owner decides), while an invite link needs
                // somebody to mint one. Saying "ask to join" is more useful than a
                // policy enum a person has to decode.
                const online = group.onlineCount > 0 ? `，${group.onlineCount} 人在线` : '';
                return `- ${group.name}（${group.memberCount} 人${online}）`
                  + (group.topic === '' ? '' : `\n  ${group.topic}`)
                  + `\n  id: ${group.groupId} — 可以用 a2a_group_request 申请加入`;
              }).join('\n'),
            meta: {
              total: page.total,
              returned: page.returned,
              hasMore: page.hasMore,
              groups: page.groups.map((group) => ({
                groupId: group.groupId,
                name: group.name,
                topic: group.topic,
                memberCount: group.memberCount,
                onlineCount: group.onlineCount,
                lastActivityAt: group.lastActivityAt,
                lastActivityAtIso: group.lastActivityAtIso,
              })),
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/request',
      name: 'Apply to join a group',
      description:
        'Apply to join a group you found in the directory. Needs NO credential — you are not a member yet, which is the point. Returns a requestId (public, a queue index) and a claimKey (SECRET: keep it, it is what collects the membership once the owner approves). The owner decides out of band; come back with group/claim.',
      examples: ['Ask to join the invoice group, saying I work on the billing service'],
      async run(input) {
        const data = payload(input);
        try {
          const issued = store.requestJoin({
            groupId: required(data.groupId, 'groupId'),
            displayName: required(data.displayName, 'displayName'),
            reason: typeof data.reason === 'string' ? data.reason : undefined,
          });
          return {
            text: issued.duplicate === true
              ? `你之前已经申请过「${issued.groupName}」，申请还在队列里（${issued.requestId}）。\n\n`
                + '请等待群主确认。注意：最初那次返回的 claimKey 才是领取成员身份的凭证，这次不会再给你一份。'
              : `已提交加入「${issued.groupName}」的申请。\n\n`
                + `requestId : ${issued.requestId}\n`
                + `claimKey  : ${issued.claimKey}\n\n`
                + 'claimKey 只显示这一次，请保存好——群主同意后要用它领取成员身份。\n'
                + `申请有效期至 ${new Date(issued.expiresAt).toISOString()}。`,
            meta: {
              groupId: required(data.groupId, 'groupId'),
              requestId: issued.requestId,
              // Only present on the first call: re-issuing would invalidate the key
              // the applicant may already have saved.
              claimKey: issued.claimKey ?? '',
              duplicate: issued.duplicate === true,
              expiresAt: new Date(issued.expiresAt).toISOString(),
              groupName: issued.groupName,
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/requests',
      name: 'Review join requests',
      description:
        'List the applications waiting for a decision. OWNER ONLY: the queue holds other people\'s names and stated reasons, which is the same class of information as the member list. Use group/decide to answer one.',
      examples: ['Who is waiting to join?'],
      async run(input) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        try {
          const requests = store.listRequests({
            groupId,
            member,
            status: typeof data.status === 'string' ? data.status : 'pending',
          });
          return {
            text: requests.length === 0
              ? '没有待处理的申请。'
              : requests.map((entry) => `- ${entry.displayName}（${entry.requestId}）`
                + (entry.reason === '' ? '' : `\n  ${entry.reason}`)).join('\n'),
            meta: {
              groupId,
              count: requests.length,
              requests: requests.map((entry) => ({
                requestId: entry.requestId,
                displayName: entry.displayName,
                reason: entry.reason,
                status: entry.status,
                createdAt: entry.createdAtIso,
                expiresAt: entry.expiresAtIso,
              })),
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/decide',
      name: 'Approve or reject a join request',
      description:
        'Answer one application. OWNER ONLY. Approving does not create the membership by itself — the applicant collects it with their own claimKey, which is how "one person vouched for one person" stays true. Rejecting is final for that request; the person may apply again.',
      examples: ['Approve the request from 李四', 'Reject r-ab12cd34'],
      async run(input) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        try {
          const decided = store.decideRequest({
            groupId,
            member,
            requestId: required(data.requestId, 'requestId'),
            // Defaulting to approve would be the wrong default: an accidental call
            // with no opinion should not open the door. decide() requires an
            // explicit answer.
            approve: data.approve !== false,
          });
          return {
            text: `已${decided.status === 'approved' ? '同意' : '拒绝'} ${decided.displayName} 的申请。`
              + (decided.status === 'approved'
                ? '\n对方会用自己的 claimKey 领取成员身份，你不需要再发邀请链接。'
                : ''),
            meta: {
              groupId,
              requestId: decided.requestId,
              status: decided.status,
              displayName: decided.displayName,
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/claim',
      name: 'Collect an approved membership',
      description:
        'Turn an approved request into a membership, using the claimKey you got when you applied. Needs NO group password: the owner already vouched for you. The claimKey is single-use and only you have it.',
      examples: ['Collect my membership for request r-ab12cd34'],
      async run(input, context) {
        const data = payload(input);
        try {
          const groupId = required(data.groupId, 'groupId');
          const claimed = store.claimJoin({
            groupId,
            requestId: required(data.requestId, 'requestId'),
            claimKey: required(data.claimKey, 'claimKey'),
          });
          identities.upsert({
            sessionId: context?.sessionId ?? HOST_SESSION_ID,
            groupId,
            memberId: claimed.member.memberId,
            memberKey: claimed.memberKey,
            local: true,
            groupName: claimed.group.name,
            role: claimed.member.role,
            lastSeq: claimed.group.lastSeq ?? 0,
          });
          return {
            text: `已加入「${claimed.group.name}」。\n\n`
              + `memberId : ${claimed.member.memberId}\n`
              + `memberKey: ${claimed.memberKey}\n\n`
              + '这份凭证本机已保存；从现在起你在群里发言都用它。',
            meta: {
              groupId,
              memberId: claimed.member.memberId,
              memberKey: claimed.memberKey,
              groupName: claimed.group.name,
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/role',
      name: 'Declare your role in this group',
      description:
        'Say what you do in ONE group and update it whenever it changes. This is self-description, not a permission: it does not grant any ability, and nobody can set it for you. Use it when you take on a different hat in a project (a developer who is also acting as product).',
      examples: ['In this group I am the product owner, tags 产品, 验收', 'I switched to doing the backend here: 研发, 后端'],
      async run(input) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        try {
          const updated = store.setProfile({
            groupId,
            member,
            // `undefined` means "leave it alone"; an empty string clears it.
            about: data.about === undefined ? undefined : data.about,
            tags: data.tags === undefined ? undefined : data.tags,
          });
          return {
            text: `Updated your role in this group.\n`
              + `about: ${updated.roleAbout ?? '(cleared)'}\n`
              + `tags : ${(updated.tags ?? []).join('、') || '(none)'}`,
            meta: {
              groupId,
              memberId: updated.memberId,
              about: updated.roleAbout ?? '',
              tags: updated.tags ?? [],
              updatedAt: updated.updatedAt,
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/leave',
      name: 'Leave a group',
      description: 'Remove a member from a group. Anyone may remove themselves; only the owner may remove someone else.',
      examples: ['Leave the invoice group'],
      async run(input) {
        const { groupId, member } = requireMember(input);
        try {
          // Only self-removal is expressible here: the store keys removal on the
          // authenticated caller, so "owner removes another member" is a separate
          // operation (a future `group/remove`) rather than a field on this one.
          const removed = store.leave({ groupId, member });
          if (removed) identities.remove(groupId);
          return {
            text: removed ? 'Left the group.' : 'You were already not a member.',
            meta: { groupId, removed: removed === true },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
  ];

  /** A caller-named field the skill cannot proceed without. */
  function required(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw coded('invalid_payload', `this skill needs "${name}"`);
    }
    return value;
  }
}

/** An error carrying a stable code, for the model and for tests. */
function coded(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

/** One line about an error, without a stack. */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/** A generated password: unambiguous alphabet, so it survives being read aloud. */
export function randomPassword(length = 12) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  randomFillSync(bytes);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

/** A finite number, or the fallback. */
function finiteOr(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Clamp a number into `[min, max]`. */
function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

/** Whether a value is a plain JSON object (not an array, not null). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}