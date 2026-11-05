/**
 * The group inbox: a long-lived subscription per joined group, whose posts
 * become Session turns.
 *
 * This is the module that makes a group feel like a group. Everything below it
 * is transport (A2A over a gateway) and everything above it is a Session; this
 * file is the only place that decides *when* a message is worth waking somebody
 * for, and it is deliberately conservative about it:
 *
 *   - **A post by this Session is not delivered back to it.** Otherwise every
 *     message a Session sends costs it a turn to read its own words, and two
 *     Sessions in one group would ping-pong forever.
 *   - **A post already delivered is not delivered again.** Reconnects replay the
 *     feed from a sequence number; without a watermark, a flaky link would
 *     re-wake the Session for everything it already saw.
 *   - **A post is delivered as a task message, not as a user bubble.** The user
 *     did not type it, and a Session that thinks its human said something will
 *     answer the human instead of the group.
 *
 * The subscription itself is `bridge.stream` with a `sinceSeq`, which is why the
 * bridge's resume-on-reconnect exists: an inbox that gives up on the first
 * network blip is an inbox that quietly stops working, and nothing looks more
 * broken than a group where nobody answers.
 *
 * @module dsh-a2a/inbox
 */

/** How long one subscription waits for a heartbeat before considering the link dead. */
const DEFAULT_IDLE_MS = 120000;

/** How long to wait before re-subscribing after the stream closes on its own. */
const RESUBSCRIBE_BASE_MS = 1000;

/**
 * How often to check for one-to-one messages.
 *
 * A group feed streams; a direct message polls. Ten seconds is short enough that an invitation feels
 * immediate when both sides are up, and long enough that an idle instance is not making a request
 * every second to learn nothing — an invitation is a low-frequency event by nature.
 */
const DIRECT_POLL_MS = 10_000;

/** Largest re-subscribe backoff, so a down host is retried forever at a slow rate. */
const RESUBSCRIBE_MAX_MS = 60000;


/**
 * The sentinel meaning "everyone in the group", mirrored from groups.js.
 *
 * Duplicated as a constant rather than imported: inbox.js is deliberately free of a
 * dependency on the group store (it only ever sees feed entries), and a single string
 * literal is a smaller coupling than a module edge.
 */
const MENTION_ALL_LITERAL = '@all';

/**
 * How loudly one post should arrive for one membership.
 *
 * @param {object} post - the feed entry.
 * @param {object} membership - the receiving membership.
 * @param {boolean} muted - whether this group is muted for this Session.
 * @returns {'mention'|'notice'|'ambient'} the grade.
 */
export function gradeOf(post, membership, muted) {
  // A mute is an explicit instruction from the person, so it outranks everything.
  // A mention still arrives, just quietly, rather than being dropped.
  if (muted) return 'ambient';
  const mentions = Array.isArray(post.mentions) ? post.mentions : [];
  if (mentions.length === 0) return 'notice';
  if (mentions.includes(MENTION_ALL_LITERAL)) return 'mention';
  if (mentions.includes(membership.personId)) return 'mention';
  // The post addressed somebody, just not this member: deliberately ambient. Being
  // told "other people were mentioned" is noise, not signal.
  return 'ambient';
}

/**
 * Build the inbox.
 *
 * @param {object} deps - `{ ctx, logger, config, clock, groups, identities, registry, bridge, deliverer, sessions }`.
 * @returns {object} `{ enable, disable, enabled, state, resume, stop }`.
 */
export function createInbox({ ctx, logger, config, clock = () => Date.now(), groups, identities, registry, bridge, deliverer, sessions }) {
  /** groupId → { controller, attempt, timer, lastSeq, active } */
  const subscriptions = new Map();
  /** groupIds the operator turned off explicitly, so resume() does not fight them. */
  const disabled = new Set();
  /** messageIds already delivered, so a replay is not a second wake. */
  const delivered = new Map();
  /** Timer for the direct-message poll, or undefined when not running. */
  let directTimer;
  let stopped = false;

  const enabled = () => config.groups.enabled === true && stopped === false;

  /**
   * Start (or restart) the subscription for one group, or for every joined group.
   *
   * Awaiting this returns once subscriptions have been *started*, not once they
   * are connected: a group host that is unreachable right now must not make
   * `a2a_group_inbox on` hang, and the retry loop is the thing that handles it.
   *
   * @param {string} [groupId] - one group, or every known group when omitted.
   * @returns {Promise<void>} resolves once started.
   */
  const enable = async (groupId) => {
    stopped = false;
    const targets = groupId === undefined ? joinedGroupIds() : [groupId];
    for (const id of targets) {
      disabled.delete(id);
      start(id);
    }
    // Direct messages are pulled rather than streamed: this covers the case a subscription cannot —
    // an invitation sent while this instance was asleep.
    startDirectPoll();
  };

  /** Poll for direct messages on behalf of any membership this instance holds. */
  function startDirectPoll() {
    if (directTimer !== undefined) return;
    const tick = () => {
      if (!enabled()) return;
      const membership = identities.list()[0];
      if (membership === undefined) return;
      void pullDirect(membership);
    };
    // Once immediately, so an invitation sent while this DSH was closed is not delayed by a full
    // interval before it appears.
    tick();
    directTimer = setInterval(tick, DIRECT_POLL_MS);
    directTimer.unref?.();
  }

  /**
   * Stop one subscription, or all of them.
   *
   * The watermark is kept, so turning the inbox back on resumes where it left
   * off instead of replaying the group's whole history into the Session.
   *
   * @param {string} [groupId] - one group, or every group when omitted.
   * @returns {Promise<void>} resolves once stopped.
   */
  const disable = async (groupId) => {
    const targets = groupId === undefined ? [...subscriptions.keys()] : [groupId];
    for (const id of targets) {
      disabled.add(id);
      stop(id);
    }
  };

  /** Resume every joined group that is not explicitly disabled. */
  const resume = async () => {
    if (!enabled()) return;
    const ids = joinedGroupIds().filter((id) => !disabled.has(id));
    if (ids.length === 0) return;
    for (const id of ids) start(id);
    logger?.info?.(`a2a: group inbox resumed for ${ids.length} group(s)`);
  };

  /**
   * Stop one subscription, or every subscription when called with no argument.
   *
   * The no-argument form is what unload uses, and it has to actually stop
   * everything: an earlier version looked the group up by `undefined` and
   * stopped nothing, which left every SSE connection open after the plugin was
   * disposed. In a test that is a hanging process; in production it is a
   * connection that keeps waking a Session for a plugin the operator turned off.
   *
   * @param {string} [groupId] - one group, or every group when omitted.
   * @returns {void}
   */
  const stop = (groupId) => {
    if (groupId === undefined) {
      for (const id of [...subscriptions.keys()]) stop(id);
      stopped = true;
      // The direct-message poll answers to the same on/off switch as the group subscriptions: turning
      // the inbox off must stop everything that would insert text into a conversation.
      if (directTimer !== undefined) {
        clearInterval(directTimer);
        directTimer = undefined;
      }
      return;
    }
    const entry = subscriptions.get(groupId);
    if (entry === undefined) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    try {
      entry.controller?.abort();
    } catch {
      // An already-aborted controller throws nothing, but a foreign
      // implementation might; stopping must never be the thing that breaks.
    }
    subscriptions.delete(groupId);
  };

  /**
   * What the tools report for `a2a_group_inbox status`.
   *
   * `lastSeq` is the watermark actually used for the next resume, so a member
   * that received nothing still shows where it is in the feed.
   */
  const state = () => [...subscriptions.entries()].map(([groupId, entry]) => ({
    groupId,
    // How many Sessions of this instance this one stream feeds. Two means the same
    // group was joined twice on this machine — legitimate, and worth surfacing.
    sessions: identities.list({ groupId }).filter((record) => record.local !== true).length,
    active: entry.active === true,
    connecting: entry.connecting === true,
    lastSeq: entry.lastSeq ?? 0,
  }));

  /**
   * Groups this instance should watch.
   *
   * Only REMOTE memberships get a subscription: a group hosted by this very
   * instance already reaches its own Session through the local store's
   * `subscribe()`, and subscribing over A2A to oneself would put a network hop
   * (and an authentication round trip) between a post and the person who wrote it.
   */
  function joinedGroupIds() {
    return identities.remoteMemberships()
      .map((record) => record.groupId)
      .filter((id) => typeof id === 'string' && id !== '');
  }

  /** Open one subscription, with resubscribe on close. */
  function start(groupId) {
    if (stopped || !enabled()) return;
    const existing = subscriptions.get(groupId);
    if (existing !== undefined && existing.active === true) return;
    if (existing !== undefined) stop(groupId);

    const entry = {
      controller: new AbortController(),
      attempt: 0,
      lastSeq: existing?.lastSeq ?? watermarkOf(groupId),
      active: false,
      connecting: true,
    };
    subscriptions.set(groupId, entry);
    void run(groupId, entry);
  }

  /**
   * One subscription attempt, then reschedule if it ends.
   *
   * `entry.active` means "a stream is open right now" and nothing else — it is
   * set only after the bridge has accepted the call and cleared when the stream
   * ends. An earlier version set it before checking the membership record, which
   * made `state()` report a subscription that never opened, so the one diagnostic
   * a person has for "why am I not getting group messages" lied.
   */
  async function run(groupId, entry) {
    // The stream authenticates with ONE membership's credential — the group host
    // answers one subscriber. Posts are fanned out to every membership afterwards,
    // so which credential opened the stream does not decide who receives.
    const memberships = identities.list({ groupId }).filter((record) => record.local !== true);
    if (memberships.length === 0) {
      logger?.warn?.(`a2a: no remote membership record for group ${groupId}; not subscribing. Run a2a_groups to check it.`);
      return;
    }
    const membership = memberships[0];
    // The bridge calls this an idle timeout: it resets on every chunk, so a healthy
    // silent subscription is not killed by total elapsed time.
    const idleMs = config.client.streamIdleMs ?? DEFAULT_IDLE_MS;
    try {
      const result = await bridge.stream(sourceOf(membership), {
        skill: 'group/subscribe',
        text: `subscribe ${groupId} from ${entry.lastSeq}`,
        data: {
          groupId,
          personId: membership.personId,
          personKey: membership.personKey,
          sinceSeq: entry.lastSeq,
        },
        signal: entry.controller.signal,
        sinceSeq: entry.lastSeq,
        timeoutMs: idleMs,
        onEvent: (event) => {
          // The first frame — even a heartbeat status — is the proof the stream is
          // live. The bridge's promise only settles when the stream ENDS, so
          // waiting for it to mark "subscribed" would show nothing until the day
          // it stopped, which is the opposite of what the diagnostic is for.
          entry.connecting = false;
          entry.active = true;
          entry.attempt = 0;
          if (event?.type === 'reconnect') {
            logger?.info?.(`a2a: group ${groupId} stream reconnecting (attempt ${event.attempt})`);
            return;
          }
          if (event?.type !== 'artifact') return;
          const post = parsePost(event);
          if (post === undefined) return;
          if (post.seq > entry.lastSeq) entry.lastSeq = post.seq;
          saveWatermark(groupId, entry.lastSeq);
          void deliverPost(groupId, membership, post);
        },
      });
      if (typeof result?.lastSeq === 'number' && result.lastSeq > entry.lastSeq) {
        entry.lastSeq = result.lastSeq;
        saveWatermark(groupId, entry.lastSeq);
      }
      entry.active = false;
    } catch (error) {
      entry.active = false;
      entry.connecting = false;
      if (entry.controller.signal.aborted || stopped) return;
      logger?.warn?.(`a2a: group ${groupId} subscription ended (${describe(error)}); will retry`);
    }
    // A run that finished after `stop()` must not resurrect a subscription the
    // caller already cancelled: `stop` deletes the map entry, and `schedule`
    // checks for that, which is what keeps a disposed plugin from holding a timer.
    schedule(groupId, entry);
  }

  /** Re-subscribe after a pause, backing off so a dead host is cheap to retry. */
  function schedule(groupId, entry) {
    if (stopped || disabled.has(groupId)) return;
    if (!subscriptions.has(groupId)) return;
    entry.attempt += 1;
    const delay = Math.min(RESUBSCRIBE_BASE_MS * 2 ** (entry.attempt - 1), RESUBSCRIBE_MAX_MS);
    const timer = setTimeout(() => {
      const current = subscriptions.get(groupId);
      if (current === undefined || current !== entry) return;
      start(groupId);
    }, delay);
    if (typeof timer?.unref === 'function') timer.unref();
    // Keep the old entry so its watermark survives the gap; `start` reads it.
    entry.timer = timer;
  }

  /**
   * Turn one group post into one Session turn.
   *
   * Three refusals, each for a reason stated in the module comment: our own
   * post, an already-delivered post, and the case where this instance has no
   * bound Session to wake.
   */
  /**
   * Fetch and deliver any direct messages waiting for this Session, then confirm them.
   *
   * Renders the invitation as something actionable rather than as a notification: the link is right
   * there, so joining does not require the recipient to find and paste it.
   *
   * Confirmation happens here, immediately after delivery, because the ack is what the SENDER's
   * screen depends on. Leaving it to the reader would make every message look undelivered until
   * somebody happened to interact with their own inbox.
   *
   * @param {object} membership - a membership record, used only for its credential and personId.
   * @returns {Promise<number>} how many messages were delivered.
   */
  async function pullDirect(membership) {
    if (membership === undefined) return 0;
    let messages;
    try {
      if (membership.local === true) {
        messages = groups.listPersonMessages({ personId: membership.personId });
      } else {
        const result = await bridge.send(
          {
            baseUrl: membership.baseUrl,
            apiKey: membership.apiKey ?? config.client.apiKey,
            forwardProto: config.client.forwardProto,
            protocolVersion: config.client.protocolVersion,
          },
          {
            skill: 'person/inbox',
            text: 'inbox',
            data: { personId: membership.personId },
            timeoutMs: config.client.timeoutMs,
          },
        );
        messages = Array.isArray(result?.data?.messages) ? result.data.messages : [];
      }
    } catch (error) {
      // A host that is down must not throw from a poll: the next tick retries, and a thrown error
      // here would surface as an unhandled rejection in the plugin's startup path.
      logger?.warn?.(`a2a: could not read direct messages (${error?.message ?? error})`);
      return 0;
    }
    if (!Array.isArray(messages) || messages.length === 0) return 0;

    const deliveredIds = [];
    for (const message of messages) {
      if (message === null || typeof message !== 'object') continue;
      const dmId = typeof message.dmId === 'string' ? message.dmId : '';
      if (dmId === '') continue;
      // Already handled in this process: a poll that overlaps with itself must not deliver twice.
      if (delivered.has(dmId)) {
        deliveredIds.push(dmId);
        continue;
      }
      try {
        await deliverer.deliver({
          sessionId: membership.sessionId,
          text: renderDirect(message),
          // Reuse the message id as the delivery key, so the deliverer's own dedupe covers the case
          // where a poll retries before the ack lands.
          messageId: dmId,
          kind: message.kind,
        });
        delivered.set(dmId, true);
        deliveredIds.push(dmId);
      } catch (error) {
        // Leave it unacked on purpose: an undelivered message must stay in the queue, and claiming
        // otherwise would lose it.
        logger?.warn?.(`a2a: could not deliver direct message ${dmId} (${error?.message ?? error})`);
      }
    }

    if (deliveredIds.length > 0) {
      try {
        if (membership.local === true) {
          groups.ackPersonMessages({ personId: membership.personId, dmIds: deliveredIds });
        } else {
          await bridge.send(
            {
              baseUrl: membership.baseUrl,
              apiKey: membership.apiKey ?? config.client.apiKey,
              forwardProto: config.client.forwardProto,
              protocolVersion: config.client.protocolVersion,
            },
            {
              skill: 'person/ack',
              text: 'ack',
              data: { personId: membership.personId, dmIds: deliveredIds },
              timeoutMs: config.client.timeoutMs,
            },
          );
        }
      } catch (error) {
        // The message was delivered; failing to confirm only costs the sender an indicator. Retrying
        // the ack is safe because it is idempotent.
        logger?.warn?.(`a2a: could not confirm direct messages (${error?.message ?? error})`);
      }
    }
    return deliveredIds.length;
  }

  /**
   * How one direct message reads in a conversation.
   *
   * An invitation shows the link, because the point of pushing it is that the recipient does not have
   * to hunt for one. A notice or welcome is already a sentence and is passed through.
   *
   * @param {object} message - the delivered message.
   * @returns {string} the text to insert.
   */
  function renderDirect(message) {
    const payload = message.payload ?? {};
    if (message.kind === 'group-invite' && typeof payload.inviteLink === 'string') {
      const name = typeof payload.groupName === 'string' && payload.groupName !== ''
        ? payload.groupName
        : payload.groupId;
      const topic = typeof payload.topic === 'string' && payload.topic !== ''
        ? `\n主题：${payload.topic}`
        : '';
      return `邀请你加入协作群「${name}」${topic}\n\n`
        + `用 a2a_group_join 加入这个群：${payload.inviteLink}`;
    }
    return typeof message.text === 'string' && message.text !== ''
      ? message.text
      : '（收到一条消息）';
  }

  async function deliverPost(groupId, openingMembership, post) {
    /**
     * Every Session of this instance that belongs to this group, each delivered to
     * on its own behalf.
     *
     * `openingMembership` is the record whose credential opened the stream; it is
     * NOT necessarily the only one. A person who joined the same group from two
     * Sessions is two members, and both Sessions must see the post.
     */
    const memberships = identities.list({ groupId }).filter((record) => record.local !== true);
    if (memberships.length === 0) return;

    for (const membership of memberships) {
      // A Session does not receive its own post: its author already knows.
      if (post.from?.personId !== undefined && post.from.personId === membership.personId) continue;
      // Dedupe is keyed per (Session, message): one Session having seen a post must
      // not suppress delivery to another Session of the same instance.
      const dedupeKey = `${membership.sessionId}\u0000${post.msgId}`;
      if (delivered.has(dedupeKey)) continue;
      const sessionId = membership.sessionId;
      if (typeof sessionId !== 'string' || sessionId === '') {
        logger?.warn?.(`a2a: membership in ${groupId} has no Session; skipping delivery`);
        continue;
      }
      const muted = disabled.has(groupId);
      const grade = gradeOf(post, membership, muted);
      // Process-wide, from config. Not per group: the group store does not publish its settings through
      // `snapshot()`, so reading a per-group value here would mean inventing a call that does not exist. The
      // question "should an unaddressed post wake me" is a property of how this person works, not of one channel,
      // so a single switch is also the more honest place to ask it.
      const wakeMembers = config.groups.wakeMembers !== false;
      // Only a mention changes the rendering: the reader has to know the post is FOR
      // them, not merely in a group they belong to.
      const addressedMe = grade === 'mention'
        && (!Array.isArray(post.mentions) || post.mentions.includes('@all') || post.mentions.includes(membership.personId));
      try {
        await deliverer.deliver({
          sessionId,
          text: renderPost(membership.groupName ?? groupId, post, addressedMe),
          messageId: post.msgId,
          // A mention always starts a turn; anything else depends on `wakeMembers`.
          //
          // The old rule woke on `notice` too, and a "notice" is every post that mentions nobody — which is most of
          // them. That made an ordinary conversation wake everybody on every line, and each wake can produce another
          // message: three people talking produced six wakes per round. Off by default now, so an unaddressed post is
          // seated without waking anyone and read at the next natural moment.
          //
          // This is the whole difference between a chat room and a task channel, and it is one condition.
          mode: grade === 'mention' || (grade === 'notice' && wakeMembers !== false) ? 'queue' : 'inbox',
          source: {
            kind: 'a2a',
            skill: 'group/subscribe',
            groupId,
            seq: post.seq,
            from: post.from?.displayName,
            grade,
          },
          // A group post arrives on somebody else's schedule; it must not raise the
          // Session's permission level as a side effect of being delivered.
          elevate: false,
        });
        remembered(dedupeKey);
      } catch (error) {
        logger?.warn?.(`a2a: could not deliver group ${groupId} post #${post.seq} to ${sessionId} (${describe(error)})`);
        // A failed delivery must be retryable: no dedupe entry means the next resume
        // replays this post instead of losing it.
      }
    }
    void openingMembership;
  }


  /**
   * The wire watermark for one group: the LOWEST read position among its
   * memberships.
   *
   * The stream is per group, so it carries one `sinceSeq`. Taking the minimum means
   * the Session that was furthest ahead re-reads a few posts and per-Session dedupe
   * drops them, while the Session that was behind misses nothing. The other
   * direction would silently skip posts for the member who had read less.
   */
  function watermarkOf(groupId) {
    const records = identities.list({ groupId });
    let lowest = Number.POSITIVE_INFINITY;
    for (const record of records) {
      if (typeof record.lastSeq === 'number' && record.lastSeq < lowest) lowest = record.lastSeq;
    }
    return Number.isFinite(lowest) ? lowest : 0;
  }

  /** Persist a read position for every membership of a group. */
  function saveWatermark(groupId, seq) {
    try {
      for (const record of identities.list({ groupId })) {
        identities.upsert({ sessionId: record.sessionId, groupId, lastSeq: seq });
      }
    } catch (error) {
      logger?.warn?.(`a2a: could not persist the group ${groupId} watermark (${describe(error)})`);
    }
  }

  /**
   * The membership whose credential opens the stream for a group, or undefined.
   *
   * Only remote memberships are subscribable (see `joinedGroupIds`), so a local
   * record is skipped rather than subscribed to.
   */
  function membershipOf(groupId) {
    const records = identities.list({ groupId }).filter((record) => record.local !== true);
    return records.length === 0 ? undefined : records[0];
  }

  /** The bridge target for one membership. */
  function sourceOf(membership) {
    return {
      baseUrl: membership.baseUrl,
      apiKey: membership.apiKey ?? config.client.apiKey,
      forwardProto: config.client.forwardProto,
      protocolVersion: config.client.protocolVersion,
    };
  }

  /** Bounded memory for the delivered-id set. */
  function remembered(msgId) {
    delivered.set(msgId, clock());
    if (delivered.size <= 2000) return;
    const cutoff = clock() - (config.delivery.dedupeWindowMs ?? 600000);
    for (const [key, at] of delivered) {
      if (at < cutoff) delivered.delete(key);
    }
    // Still too big (a burst), so drop the oldest half rather than grow forever.
    if (delivered.size > 2000) {
      const keys = [...delivered.keys()].slice(0, delivered.size - 1000);
      for (const key of keys) delivered.delete(key);
    }
  }

  return {
    // Exposed so a caller can fetch pending invitations once at startup without waiting for the
    // first poll tick.
    pullDirect,
    enable, disable, enabled, state, resume, stop };
}

/**
 * One group post out of a stream artifact event.
 *
 * The bridge hands back the artifact text as JSON because that is what the
 * group's `group/subscribe` skill emits; a malformed payload is skipped rather
 * than delivered, since a Session woken to read garbage is worse than a Session
 * not woken at all.
 */
function parsePost(event) {
  const raw = typeof event?.text === 'string' ? event.text : '';
  if (raw.trim() === '') return undefined;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof payload?.msgId !== 'string' || typeof payload?.seq !== 'number') return undefined;
  return payload;
}

/**
 * What a Session actually reads when a group post arrives.
 *
 * Named sender, sequence number, and an explicit instruction to answer in the
 * group: a Session that receives "fix the invoice bug" with no return address
 * will fix it and tell its human, and the group will never hear about it.
 */
function renderPost(groupName, post, addressedMe = false) {
  const sender = post.from?.displayName ?? post.from?.personId ?? 'a member';
  const when = typeof post.at === 'number' ? new Date(post.at).toISOString() : 'just now';
  const toEveryone = Array.isArray(post.mentions) && post.mentions.includes('@all');
  // The first line is what a reader sees in the collapsed card, so the addressing has
  // to be there. "You were named" is the difference between "read this now" and "read
  // this when you get to it" — which is the entire point of mentions.
  const addressing = addressedMe === true
    ? (toEveryone ? ' — @everyone' : ' — you were mentioned')
    : (toEveryone ? ' — to everyone' : '');
  const lines = [
    `Group message in 「${groupName}」 from ${sender}${addressing} (#${post.seq}, ${when}):`,
    '',
    typeof post.text === 'string' && post.text !== '' ? post.text : '(no text)',
  ];
  if (post.payload !== undefined && post.payload !== null) {
    lines.push('', 'Structured payload:', '```json', JSON.stringify(post.payload, null, 2), '```');
  }
  lines.push(
    '',
    addressedMe === true
      ? 'This one names you. Answer with a2a_group_post to the same group — a reply told only to your user leaves the rest of the group blind.'
      : 'Answer with a2a_group_post to the same group — a reply told only to your user leaves the rest of the group blind.',
  );
  return lines.join('\n');
}

/** One line about an error, without a stack. */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
