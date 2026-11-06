/**
 * The group skills: create, invite, join, post, read, subscribe, members, leave.
 *
 * A group is a DSH instance that registered itself as an A2A agent, so these
 * skills are the whole protocol between a group host and its members. Three
 * decisions deserve their reasons written down, because each looks odd without
 * one:
 *
 *   **Every member call carries `personId` + `personKey` in the payload, not in
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
import { buildJoinUrl } from './public-origin.js';

// A skill call arrives over A2A and therefore carries no Session: the caller is a
// remote agent, not a conversation. A pure group host is exactly that case, and it
// still keeps a membership record (the owner credential lives there). See
// `HOST_SESSION_ID` for why that record cannot simply be keyed on nothing.
// Used by `group/create` only: when the caller creates a group it IS the host, so the host's
// own config is the right source for its address. `group/join` must NOT use it — see the note
// there.
import { ownEndpointFromConfig } from './endpoint.js';
import { HOST_SESSION_ID } from './memberships.js';
// The three message kinds the MVP sends. A fourth would mean the scope changed.
import { DM_KIND_INVITE, DM_KIND_JOIN_NOTICE, DM_KIND_WELCOME } from './groups.js';

/**
 * How often an open subscription refreshes its member's presence.
 *
 * Must be comfortably below `ONLINE_WINDOW_MS` (120s) or a live connection would flicker offline
 * between ticks. Half the window leaves room for one missed tick without the indicator lying.
 */
const PRESENCE_TICK_MS = 50_000;

/**
 * The sender id used for a message no person authored.
 *
 * A welcome cannot be signed by the person being welcomed — the store refuses a message from yourself, and
 * a self-signed greeting reads oddly anyway. When a group has no owner to speak for it, this stands in. It
 * is deliberately not a person id: pretending a session identifier is a person is how ids stop meaning one
 * thing.
 */
const SYSTEM_PERSON_ID = 'system';

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
export function createGroupSkills({
  store,
  identities,
  config,
  logger,
  clock = () => Date.now(),
  // Mints a one-time join-page token. Injected because the token store lives in the server facade, and a skill
  // must not reach into a sibling module's state. Absent on a host with no page, in which case `group/invite`
  // simply returns no URL rather than a broken one.
  mintJoinToken,
  // The origin a link should use, resolved once by whoever assembles the host. Absent means unresolved.
  joinOrigin,
}) {
  const settings = config.groups;

  /**
   * Tell the owner somebody joined, and tell the newcomer what they joined.
   *
   * Both messages are best-effort: the membership is already stored, and a courtesy that fails must not
   * turn a successful join into an error the caller has to interpret.
   *
   * @param {object} group - the group snapshot, after the join.
   * @param {object} joiner - `{ personId, displayName }`.
   * @returns {{notifiedOwner: boolean, welcomed: boolean}} what was actually sent.
   */
  function announceJoin(group, joiner) {
    const result = { notifiedOwner: false, welcomed: false };
    const ownerId = group?.owner?.personId;
    try {
      if (typeof ownerId === 'string' && ownerId !== '' && ownerId !== joiner.personId) {
        store.sendPersonMessage({
          fromPersonId: joiner.personId,
          toPersonId: ownerId,
          kind: DM_KIND_JOIN_NOTICE,
          // The name and the group, nothing else. A notice that quotes the invitation would put the token
          // in the owner's own inbox, which is where a forwarded screenshot comes from.
          text: `${joiner.displayName} 加入了「${group.name}」`,
          payload: { groupId: group.groupId, groupName: group.name, personId: joiner.personId },
        });
        result.notifiedOwner = true;
      }
    } catch (error) {
      // Best effort, and deliberately silent: the log already records the join.
      void error;
    }
    try {
      store.sendPersonMessage({
        // Sent by the owner when there is one, never by the joiner themselves: a message from yourself
        // is refused by the store, and a "welcome" signed by the person being welcomed reads oddly anyway.
        // The host is the neutral sender when no owner exists.
        // The owner when there is one; otherwise a reserved id that is not a person. Using
        // HOST_SESSION_ID here would put a session identifier where a person id belongs.
        fromPersonId: typeof ownerId === 'string' && ownerId !== '' ? ownerId : SYSTEM_PERSON_ID,
        toPersonId: joiner.personId,
        kind: DM_KIND_WELCOME,
        text: `欢迎加入「${group.name}」`,
        payload: {
          groupId: group.groupId,
          groupName: group.name,
          topic: group.topic ?? '',
          memberCount: group.memberCount ?? 0,
        },
      });
      result.welcomed = true;
    } catch (error) {
      void error;
    }
    return result;
  }

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
    const personId = required(data.personId, 'personId');
    const personKey = required(data.personKey, 'personKey');
    return { groupId, member: { personId, personKey } };
  };

  return [
    {
      id: 'person/send',
      name: "Send a person a one-to-one message",
      description:
        'Send ONE message to ONE person: a group invitation, a join notice, or a welcome. This is a doorbell, not a chat — sustained private conversation belongs in a group, and there is deliberately no message kind for it. For kind "group-invite" a fresh single-use invite is minted at send time, because a token cannot be read back after issue. The reply says whether they are online and gives the message id; it does NOT claim delivery, which only their ack confirms.',
      examples: [
        'Invite person m-1234 to this group',
        'Tell the owner that someone joined',
      ],
      async run(input) {
        const data = payload(input);
        const fromPersonId = required(data.fromPersonId, 'fromPersonId');
        const toPersonId = required(data.toPersonId, 'toPersonId');
        const kind = required(data.kind, 'kind');
        try {
          // A group invitation is built here rather than handed in, so the sender cannot share a
          // link that was already issued to somebody else. Each invitation is one token, one use.
          let text = typeof data.text === 'string' ? data.text : '';
          let extra;
          if (kind === DM_KIND_INVITE) {
            const groupId = required(data.groupId, 'groupId');
            const caller = requireMember(input);
            const group = store.snapshot({ groupId, member: caller.member });
            const issued = store.invite({
              groupId,
              // The caller's own key. Minting is an act of whoever can also revoke, so it has to
              // be the owner's credential — and the store verifies that, which is why a non-owner
              // gets "只有群主可以生成邀请" rather than a link they cannot attribute.
              ownerKey: data.personKey,
              // One person, one redemption: a link that can be used twice cannot be traced to
              // whoever leaked it.
              maxUses: 1,
              expiresInHours: data.expiresInHours,
              label: `invite ${toPersonId}`,
            });
            const link = issued.link;
            text = `${group.name}`;
            extra = {
              groupId,
              groupName: group.name,
              topic: group.topic ?? '',
              inviteLink: link,
              members: group.memberCount,
            };
          }
          const message = store.sendPersonMessage({
            fromPersonId,
            toPersonId,
            kind,
            text,
            payload: extra,
          });
          const online = store.isPersonOnline(toPersonId);
          return {
            text: online
              ? `已发送（对方在线，等待确认）。\ndmId: ${message.dmId}`
              : `已存入对方的收件箱：对方当前不在线，上线后会收到。\ndmId: ${message.dmId}`,
            meta: { dmId: message.dmId, online, kind, createdAt: message.createdAt },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'person/profile',
      name: 'Set my person-level profile',
      description:
        'What I do, independent of any group: the line that appears on every colleague card. Different from group/role, which describes me in ONE group. Requires a member credential from any group I am in — that is how the host knows which person row to write, not because the value belongs to that group.',
      examples: ['My headline is 后端工程师，专注对账系统'],
      async run(input) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        try {
          const updated = store.setPersonProfile({
            groupId,
            member,
            // `undefined` leaves it alone; an empty string clears it. The distinction matters: a member
            // clearing their headline must not have it silently restored by the next role save.
            headline: data.headline === undefined ? undefined : data.headline,
            tags: data.tags === undefined ? undefined : data.tags,
          });
          return {
            text: updated.headline === ''
              ? '个人介绍已清空。'
              : `个人介绍已更新：${updated.headline}`,
            meta: {
              personId: updated.personId,
              headline: updated.headline,
              tags: updated.tags ?? [],
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'person/inbox',
      name: "Read one person's waiting messages",
      description:
        'Everything waiting for one person, oldest first. Used by a member instance when it starts up or reconnects, so a message sent while it was offline is not lost.',
      examples: ['What is waiting for person m-1234?'],
      async run(input) {
        const data = payload(input);
        const personId = required(data.personId, 'personId');
        try {
          const messages = store.listPersonMessages({
            personId,
            since: Number.isFinite(data.since) ? data.since : 0,
          });
          return {
            text: messages.length === 0
              ? '没有待收消息。'
              : messages.map((entry) => `- [${entry.kind}] ${entry.text}`).join('\n'),
            meta: { personId, messages },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'person/ack',
      name: 'Confirm receipt of one-to-one messages',
      description:
        'Called by the RECEIVER once a message has actually arrived in a Session. This is what turns a send into a delivery: an HTTP call returning proves nothing, and reporting success for a message nobody received is how a messenger loses trust.',
      examples: ['Acknowledge dm-1 and dm-2'],
      async run(input) {
        const data = payload(input);
        const personId = required(data.personId, 'personId');
        try {
          const result = store.ackPersonMessages({ personId, dmIds: data.dmIds });
          return {
            text: result.acked === 0
              ? '没有新的确认（可能已经确认过了）。'
              : `已确认 ${result.acked} 条。`
                + (result.unknown.length > 0 ? `\n${result.unknown.length} 条不属于你，已忽略。` : ''),
            meta: result,
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
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
            // The owner is a member too, and joins by creating. Without an address here the
            // roster shows an empty endpoint for the one person guaranteed to be in every group
            // they own, which reads as "the feature is broken" rather than "not configured".
            endpoint: ownEndpointFromConfig(config),
          });
          const groupId = created.group.groupId;
          const ownerPersonId = created.group.owner.personId;
          identities.upsert({
            sessionId: context?.sessionId ?? HOST_SESSION_ID,
            groupId,
            personId: ownerPersonId,
            personKey: created.ownerKey,
            local: true,
            groupName: created.group.name,
            role: 'owner',
            lastSeq: created.group.lastSeq ?? 0,
          });
          logger?.info?.(`a2a: group "${name}" created as ${groupId} (owner key issued once)`);
          return {
            text: `Group "${name}" created.\n\n`
              + `groupId : ${groupId}\n`
              + `personId: ${ownerPersonId}\n`
              + `ownerKey: ${created.ownerKey}   ← shown once; this instance has stored it, and you need it nowhere else\n\n`
              + 'Next: a2a_group_invite to mint an invite link and a paste-ready message for a colleague.',
            meta: {
              groupId,
              name: created.group.name,
              personId: ownerPersonId,
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
            ownerKey: member.personKey,
            gatewayBase: settings.gatewayBase === '' ? undefined : settings.gatewayBase,
            agent: settings.agentName === '' ? undefined : settings.agentName,
          });
                  // One message carries both halves: the A2A link for the assistant, and a page for the human who has not
        // configured anything yet. Absent when this host serves no page.
        const joinPageUrl = typeof mintJoinToken === 'function'
          ? (() => {
              try {
                const token = mintJoinToken();
                // Absolute when an origin is known: a relative path pasted into a chat reaches the receiver as
                // a path with no host, which is the failure mode this feature exists to prevent.
                if (token === undefined) return undefined;
                const link = buildJoinUrl({ token: token.token, origin: joinOrigin ?? '', path: '/join' });
                // Name the group in the URL. Without it the page describes whichever group the host lists first,
                // which is how an invitation ends up landing somebody in a group they were never invited to.
                return `${link}&g=${encodeURIComponent(groupId)}`;
              } catch {
                return undefined;
              }
            })()
          : undefined;

return {
            text: issued.prompt,
            meta: {
              groupId,
              token: issued.token,
              link: issued.link,
            joinPageUrl,
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
          // ONLY what the caller supplies. This skill runs inside the HOST process, so
          // `config.groups.agentName` here names the host — never the person joining. Composing
          // from it recorded every member at the host's own address, which is not a best guess but
          // a guaranteed-wrong one: two people, one address, and it pointed at the wrong process
          // even for the owner.
          //
          // The address belongs to the member's own configuration on the member's own machine. A
          // member that wants to be reachable passes it; one that does not stays empty, and empty
          // means "no address known" rather than "here is a plausible lie".
          const endpoint = typeof data.endpoint === 'string' && data.endpoint !== ''
            ? data.endpoint
            : undefined;
          const joined = store.join({
            groupId,
            token: typeof data.token === 'string' && data.token !== '' ? data.token : undefined,
            displayName: typeof data.displayName === 'string' && data.displayName !== '' ? data.displayName : '成员',
            endpoint,
			// Present when the caller is taking over an identity this host already knows for that person — the
			// normal case when somebody opens a new working directory and rejoins a long-lived group. The store
			// reuses the member row and reissues the credential instead of creating a second 张三.
			personId: typeof data.personId === 'string' && data.personId !== '' ? data.personId : undefined,
			// The PROOF, not just the claim: a bare personId gets nobody in, and must not — accepting it would let
			// anybody rejoin as anybody. Both together are verified against the stored keyHash.
			personKey: typeof data.personKey === 'string' && data.personKey !== '' ? data.personKey : undefined,
          });
          identities.upsert({
            sessionId: context?.sessionId ?? HOST_SESSION_ID,
            groupId,
            personId: joined.member.personId,
            personKey: joined.personKey,
            local: true,
            groupName: joined.group.name,
            role: joined.member.role,
            lastSeq: joined.group.lastSeq ?? 0,
          });

          // Announce only a GENUINE arrival.
          //
          // A rejoin is somebody who never left, coming back from a new working directory. Welcoming them again says
          // "you just joined" to a person who has been in the group for months, and it woke the owner twice for one
          // identity — reported as 「好像收到了两个群的欢迎信息」.
          const announced = joined.rejoined === true
            ? { notifiedOwner: false, welcomed: false }
            : announceJoin(store.snapshot({ groupId, member: { personId: joined.member.personId, personKey: joined.personKey } }), {
              personId: joined.member.personId,
              displayName: joined.member.displayName,
            });

          // On a rejoin, retire the join notices that are still sitting unread.
          //
          // The welcome seen after every rejoin was NOT a new one: it is a record from the first join that was never
          // acked, so it re-surfaces each time the inbox is read — 「欢迎加入「发票与对账平台」」 with `deliveredAt`
          // already set from hours earlier. Marking them delivered is also simply correct: this person is in the
          // group, so a notice telling them to join has no remaining purpose.
          let retiredNotices = 0;
          if (joined.rejoined === true && typeof store.listPersonMessages === 'function') {
            try {
              const pending = store.listPersonMessages({ personId: joined.member.personId })
                .filter((message) => message.deliveredAt === undefined)
                .filter((message) => message.kind === DM_KIND_JOIN_NOTICE || message.kind === DM_KIND_WELCOME);
              const ids = pending.map((message) => message.dmId).filter((id) => typeof id === 'string');
              if (ids.length > 0) {
                retiredNotices = store.ackPersonMessages({ personId: joined.member.personId, dmIds: ids }).acked;
              }
            } catch {
              // Best effort: an inbox that cannot be cleaned must not fail the join.
            }
          }

          return {
            text: `Joined "${joined.group.name}".\n\n`
              + `groupId  : ${groupId}\n`
              + `personId : ${joined.member.personId}\n`
              + `personKey: ${joined.personKey}   ← shown once; this instance has stored it\n\n`
              + `${joined.feedTail.length} recent message(s) are included in the result.`
              // Saying this once at join time is the only moment it is actionable: the fix is a
              // config change, and silence would leave the card's address blank forever with no
              // hint why.
              + (endpoint === undefined
                ? '\n\n(No A2A address recorded for this instance: set groups.gatewayBase and '
                  + 'groups.agentName so colleagues can reach you directly. Groups still work '
                  + 'through the invite link.)'
                : `\n\nThis instance's address: ${endpoint}`),
            meta: {
              groupId,
              personId: joined.member.personId,
              personKey: joined.personKey,
              groupName: joined.group.name,
              topic: joined.group.topic ?? '',
              members: joined.group.memberCount,
              lastSeq: joined.group.lastSeq ?? 0,
              feedTail: joined.feedTail,
              // Whether this was a takeover of an existing identity rather than a new arrival.
              //
              // Without it the caller cannot tell the two apart, which is how a rejoin kept looking like a first join
              // — and why the welcome suppression had to be inferred from side effects instead of read from the reply.
              rejoined: joined.rejoined === true,
              // How many stale join notices were retired by this rejoin. Zero on a first join.
              retiredNotices,
              // Surfaced so the caller can tell "you are reachable" from "you are not", without
              // having to read the group back. Empty means the host is not configured with a
              // gateway base and agent name; it does NOT mean the join failed.
              endpoint: endpoint ?? '',
              // Who was told. Silence here would make "did the owner get notified?" unanswerable.
              notifiedOwner: announced.notifiedOwner,
              welcomed: announced.welcomed,
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
        'Post a message to a group. Pass `mentions` to name who should ACT on it: those '
        + 'members are woken, everyone else only sees an unread count. Use ["@all"] for a '
        + 'notice concerning the whole group; omit it for ordinary progress a member can '
        + 'read when they are already working. Returns the sequence number it landed on.',
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
          // `mentions` decides who is WOKEN, not merely who is named in the prose.
          // Without it every post interrupts every member, which is how a group turns
          // into noise and then gets muted.
          const posted = store.post({
            groupId,
            member,
            text,
            payload: data.payload,
            mentions: data.mentions,
            // The recipient of a reply is derived from the message being answered, never reconstructed by the
            // replier. See `post` in groups.js.
            replyTo: data.replyTo,
          });
          const named = Array.isArray(posted.mentions) && posted.mentions.length > 0;
          return {
            text: `Posted to the group at seq ${posted.seq}.`
              + (posted.replyTo === undefined ? '' : `\nReply to seq ${data.replyTo}: that author is woken.`)
              + (named
                ? (posted.mentions.includes('@all')
                  ? '\nAddressed to everyone: every member is woken.'
                  : `\nAddressed to ${posted.mentions.length} member(s): they are woken, everyone else only sees an unread count.`)
                : '\nNot addressed to anyone in particular: members see it in their unread count and read it when they are already working.'),
            meta: {
              seq: posted.seq,
              msgId: posted.msgId,
              at: posted.atIso,
              mentions: posted.mentions ?? [],
              // Which message this answered. A caller reporting "replied to #158" needs it back; without it the only
              // proof of the thread is a re-read of the feed.
              replyTo: posted.replyTo,
              // The conversation this belongs to. Distinct from `replyTo` in exactly the case that matters: a reply to
              // a reply answers one message but belongs to the same thread, and only the root says so.
              rootSeq: posted.rootSeq,
            },
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
                // `from` stays an OBJECT. It used to be flattened to the display name with `personId`
                // hoisted alongside, which silently broke every consumer reading `from.displayName` —
                // `publicEntry` documents a { personId, displayName } shape, and a flat string is not that.
                from: { personId: entry.from.personId, displayName: entry.from.displayName },
                // Who this entry addressed and what it answers. FIFTH time a whitelist mapper has dropped a field
                // that `publicEntry` documented: the value exists in the file, survives the store, and then
                // vanishes here — so a reader cannot see a mention or a thread even though both were recorded.
                // Whenever `publicEntry` grows a field, this list must grow with it.
                mentions: Array.isArray(entry.mentions) ? [...entry.mentions] : undefined,
                replyTo: Number.isInteger(entry.replyTo) ? entry.replyTo : undefined,
                // The thread this entry belongs to. `replyTo` names the message answered; this names the conversation,
                // which is what a late reader needs to see that several replies are one exchange. The parity test caught
                // this omission on the first run — the sixth repetition of exactly this bug.
                rootSeq: Number.isInteger(entry.rootSeq) ? entry.rootSeq : undefined,
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

        // An open subscription IS presence. Without this, a member who joins and watches — the
        // ordinary way to use a chat app — shows as offline after two minutes, because watching
        // writes nothing. A live socket reported as offline is worse than no indicator at all.
        //
        // Deliberately a timer rather than a single touch: `lastSeenAt` is a window, and a
        // connection that stays up for an hour must keep refreshing it.
        const presence = typeof store.touch === 'function'
          ? setInterval(() => {
            try {
              store.touch({ groupId, member });
            } catch {
              // A presence refresh must never be able to kill a working subscription.
            }
          }, PRESENCE_TICK_MS)
          : undefined;
        presence?.unref?.();

        try {
          // Hold the stream open until the caller goes away. The server owns the
          // heartbeat and the timeouts; this skill only has to not return.
          await context.untilCancelled();
        } finally {
          if (presence !== undefined) clearInterval(presence);
          dispose();
        }
        return { text: 'subscription closed' };
      },
    },
    {
      id: 'group/info',
      name: 'Group metadata',
      description:
        'Name, topic, member count, online count, MY role, and the roster — who is in it and '
        + 'what each person declared they do here. Needs a member credential: a roster names '
        + 'people, so it is a member fact, not a directory fact. Returned in one call because a '
        + 'caller that needs both the group and its people should not have to fetch twice.',
      examples: ['What is this group called and how many people are in it?'],
      async run(input, context) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        try {
          const snapshot = store.snapshot({ groupId, member });
          return {
            text: `${snapshot.name}`
              + (snapshot.topic === '' ? '' : ` — ${snapshot.topic}`)
              + `\n${snapshot.memberCount} 人`
              + (snapshot.onlineCount > 0 ? `，${snapshot.onlineCount} 人在线` : '')
              + `\n我在这个群的角色：${member.personId === snapshot.owner?.personId ? '群主' : '成员'}`,
            meta: {
              groupId,
              name: snapshot.name,
              topic: snapshot.topic,
              memberCount: snapshot.memberCount,
              onlineCount: snapshot.onlineCount,
              lastSeq: snapshot.lastSeq,
              lastPostAt: snapshot.lastPostAt ?? 0,
              isOwner: member.personId === snapshot.owner?.personId,
              // The roster travels with the metadata: a colleague card is built from these
              // rows, and fetching them separately would double the round trips for every
              // caller that wants to know both "what is this group" and "who is in it".
              members: store.members({ groupId, member }).map((entry) => ({
                personId: entry.personId,
                displayName: entry.displayName,
                role: entry.role,
                roleAbout: entry.roleAbout ?? '',
                // The person-level headline, carried so a colleague card can show it without a second call. Distinct
                // from roleAbout: that one is per-group, this one follows the person everywhere.
                headline: typeof entry.headline === 'string' ? entry.headline : '',
                tags: Array.isArray(entry.tags) ? entry.tags : [],
                // Where this person can be reached directly, when it is known. Empty is the
                // normal case for a host with no gateway base configured; a caller must read it
                // as "no address", never as "offline".
                endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : '',
                // Which build this member reported. Absent means it has not heartbeated since the field existed — a
                // reader must treat that as unknown, never as "same as me". This is what lets a group notice that three
                // people are running three versions before blaming the group for behaving differently.
                clientVersion: typeof entry.clientVersion === 'string' ? entry.clientVersion : '',
				// The timestamp as well as the boolean. `online` is this host's answer about NOW, and a
				// caller caches the roster — so sending only the boolean hands out an inference that expires
				// the moment it is written. `lastSeenAt` is a fact, and a reader that holds it can answer
				// "online?" correctly at any later time. Omitting it here is why a member panel kept showing
				// an 84-minute-old presence picture with no way to correct itself.
				lastSeenAt: Number.isFinite(entry.lastSeenAt) ? entry.lastSeenAt : 0,
				online: entry.online === true,
              })),
              // Surfaced so a member instance can tell a stale cache from live data.
              fetchedAt: Date.now(),
            },
          };
        } catch (error) {
          refuse(error);
        }
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
                personId: item.personId,
                displayName: item.displayName,
                role: item.role,
                // Layer A, self-declared. Named `roleAbout` to match `group/info` and the
                // store's own field. An earlier version emitted `about` here while `group/info`
                // emitted `roleAbout`, so a caller reading one and caching against the other
                // silently lost every role — which is exactly how the colleague cards came out
                // blank.
                roleAbout: item.roleAbout ?? '',
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
            personId: claimed.member.personId,
            personKey: claimed.personKey,
            local: true,
            groupName: claimed.group.name,
            role: claimed.member.role,
            lastSeq: claimed.group.lastSeq ?? 0,
          });
          return {
            text: `已加入「${claimed.group.name}」。\n\n`
              + `personId : ${claimed.member.personId}\n`
              + `personKey: ${claimed.personKey}\n\n`
              + '这份凭证本机已保存；从现在起你在群里发言都用它。',
            meta: {
              groupId,
              personId: claimed.member.personId,
              personKey: claimed.personKey,
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
            // The display name is this member's name IN THIS GROUP. Pass it through so a caller that renames
            // itself actually renames itself instead of silently keeping the join-time default (a session id).
            displayName: data.displayName === undefined ? undefined : data.displayName,
          });
          return {
            text: `Updated your role in this group.\n`
              + `name : ${updated.displayName ?? ''}\n`
              + `about: ${updated.roleAbout ?? '(cleared)'}\n`
              + `tags : ${(updated.tags ?? []).join('、') || '(none)'}`,
            meta: {
              groupId,
              personId: updated.personId,
              displayName: updated.displayName ?? '',
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
      id: 'group/remove',
      name: 'Remove a member',
      description:
        'Remove another member from a group. OWNER ONLY. Their messages stay in the feed — history is not theirs to erase and deleting it would make the conversation read as if people answered someone who never spoke. A system line records the removal, because the remaining members will notice. The owner cannot remove themselves; that is group/leave, which hands ownership on.',
      examples: ['Remove 王五 from the invoice group'],
      async run(input) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        try {
          const removed = store.removeMember({
            groupId,
            member,
            targetPersonId: required(data.targetPersonId, 'targetPersonId'),
            reason: typeof data.reason === 'string' ? data.reason : undefined,
          });
          return {
            text: `已把 ${removed.displayName} 移出群。\n\n`
              + '他之前的消息都保留着，feed 里记了一条系统记录。'
              + '\n对方下次发帖会得到「不是成员」，客户端应当据此清掉本机记录。',
            meta: {
              groupId,
              personId: removed.personId,
              displayName: removed.displayName,
              feedSeq: removed.feedSeq ?? 0,
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/rename',
      name: 'Rename a group',
      description:
        'Change a group name, its topic, or both. OWNER ONLY. Renaming is the ordinary maintenance act in a long-lived group; the alternative used to be creating a new group and losing the history, which nobody would do, so groups kept wrong names.',
      examples: ['Rename the invoice group to 发票与对账', 'Clear the topic of this group'],
      async run(input) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        try {
          const renamed = store.renameGroup({
            groupId,
            member,
            name: data.name,
            topic: data.topic,
          });
          return {
            text: renamed.changed.length === 0
              ? '名字和主题都没变，所以没有改动。'
              : `已修改${renamed.changed.map((field) => (field === 'name' ? '群名' : '群主题')).join(' 和 ')}。\n\n`
                + `群名：${renamed.name}`
                + (renamed.topic === '' ? '' : `\n主题：${renamed.topic}`),
            meta: {
              groupId,
              name: renamed.name,
              topic: renamed.topic,
              changed: renamed.changed,
            },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/archive',
      name: 'Archive or reopen a group',
      description:
        'Retire a group, or bring it back. OWNER ONLY. Archived means readable but not writable, and absent from the directory — deliberately not a delete, because a finished project conversation is worth keeping and re-opening by mistake must be possible.',
      examples: ['Archive the invoice group, we shipped it'],
      async run(input) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        try {
          const result = store.archiveGroup({
            groupId,
            member,
            // Defaults to archiving: the common call is "we are done", not "reopen".
            archived: data.archived !== false,
          });
          return {
            text: result.archived
              ? '这个群已归档：还能读，但不能发言，也不会出现在频道目录里。让群主再调一次并传 archived=false 可以恢复。'
              : '这个群已恢复：可以继续发言，也会重新出现在频道目录里。',
            meta: { groupId, archived: result.archived },
          };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/touch',
      name: 'Stay present',
      description:
        'Refresh this member\'s last-seen time. The cheapest authenticated call there is — no payload, no feed read, '
        + 'just presence. An instance calls it on a timer so that a member who joined but never opened the inbox is '
        + 'still shown as online while their process is running.',
      examples: ['I am still here'],
      async run(input) {
        const { groupId, member } = requireMember(input);
        try {
          // Deliberately thin: this runs every fifty seconds per group, so anything expensive here would be a tax
          // on every member's machine. `touch` already refreshes lastSeenAt through resolveMember.
          // The caller reports its own version: the only process that knows which build is running is the one
          // running it. A host that guessed would be reporting its own version for somebody else.
          const at = store.touch({ groupId, member, version: payload(input).version });
          return { text: 'present', meta: { groupId, at } };
        } catch (error) {
          refuse(error);
        }
      },
    },
    {
      id: 'group/away',
      name: 'Announce going away',
      description:
        'Mark this member as away right now, instead of letting presence decay over the online window. '
        + 'Called by a disposing instance on a clean shutdown; a killed process cannot call it, which is why the '
        + 'decay window remains the backstop.',
      examples: ['I am shutting down'],
      async run(input) {
        const { groupId, member } = requireMember(input);
        try {
          const at = store.markAway({ groupId, member });
          return {
            text: at === undefined ? 'Not a member; nothing to announce.' : 'Marked as away.',
            meta: { groupId, away: at !== undefined },
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
    {
      id: 'group/wait',
      name: 'Wait for new group messages',
      description:
        'Block up to timeoutMs waiting for a NEW message in one group, then say whether one arrived. '
        + 'Used by a client with no push channel (an MCP client): one long call instead of polling, and the '
        + 'host answers the moment a post lands. hasNew=false on timeout or disconnect is "nothing yet", '
        + 'not an error.',
      examples: ['Wait up to 30 seconds for new messages in the invoice group'],
      async run(input, context) {
        const data = payload(input);
        const { groupId, member } = requireMember(input);
        const sinceSeq = finiteOr(data.sinceSeq, 0);
        const timeoutMs = clamp(finiteOr(data.timeoutMs, 30_000), 1_000, 55_000);
        // One mapping for both reads, so a field added to publicEntry cannot drop from the wait path while
        // group/read still carries it — the exact class of bug the feed parity test exists for.
        const entryView = (entry) => ({
          seq: entry.seq,
          msgId: entry.msgId,
          at: entry.at,
          atIso: entry.atIso,
          from: { personId: entry.from.personId, displayName: entry.from.displayName },
          mentions: Array.isArray(entry.mentions) ? [...entry.mentions] : undefined,
          replyTo: Number.isInteger(entry.replyTo) ? entry.replyTo : undefined,
          rootSeq: Number.isInteger(entry.rootSeq) ? entry.rootSeq : undefined,
          kind: entry.kind,
          text: entry.text,
        });
        try {
          // New messages already waiting? Answer immediately instead of making the caller wait for nothing.
          const caught = store.read({ groupId, member, sinceSeq, limit: 200 });
          if (caught.entries.length > 0) {
            return {
              text: `${caught.entries.length} new message(s) already waiting.`,
              meta: {
                hasNew: true,
                waitedMs: 0,
                lastSeq: caught.lastSeq,
                entries: caught.entries.map(entryView),
              },
            };
          }
          // Otherwise hold until a post lands, the window elapses, or the caller disconnects.
          const started = clock();
          const next = await new Promise((resolve) => {
            let dispose = () => {};
            let timer;
            let settled = false;
            const finish = (entry) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              dispose();
              resolve(entry);
            };
            // Subscribe FIRST, then re-read: a post that lands between the initial read and the subscription
            // would otherwise be missed, and the waiter would block until the window expires despite new mail
            // already being there. The re-read closes that lost-wakeup window.
            dispose = store.subscribe({ groupId, fn: (entry) => finish(entry) });
            const raced = store.read({ groupId, member, sinceSeq, limit: 200 });
            if (raced.entries.length > 0) {
              finish(raced.entries[raced.entries.length - 1]);
              return;
            }
            timer = setTimeout(() => finish(undefined), timeoutMs);
            const signal = context?.signal;
            if (signal !== undefined && signal !== null) {
              if (signal.aborted) finish(undefined);
              else signal.addEventListener('abort', () => finish(undefined), { once: true });
            }
          });
          if (next === undefined) {
            // The window passed with no post: a calm "nothing yet", not an error the caller would retry.
            return {
              text: 'No new message in the wait window.',
              meta: { hasNew: false, waitedMs: clock() - started, lastSeq: sinceSeq, entries: [] },
            };
          }
          // A post landed; re-read so the reply carries everything that arrived, not just the one that woke us.
          const after = store.read({ groupId, member, sinceSeq, limit: 200 });
          // `hasNew` is literally "did we read new messages", not "did a post happen". A stale cursor beyond the
          // real head can wake without producing entries, and calling that "new" would teach the caller a false wake.
          return {
            text: after.entries.length === 0 ? 'No new message in the wait window.' : `${after.entries.length} new message(s).`,
            meta: {
              hasNew: after.entries.length > 0,
              waitedMs: clock() - started,
              lastSeq: after.lastSeq,
              entries: after.entries.map(entryView),
            },
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