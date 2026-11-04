/**
 * dsh-a2a — A2A protocol for DSH, both directions, plus invite-only groups.
 *
 * Three capabilities, one plugin, because they share one insight: a DSH Session
 * is already an agent, and A2A is just a way to address it from outside.
 *
 *   **Server** — this instance publishes itself as a standard A2A agent at
 *   `/a2a`. An inbound task becomes a real Session turn (the left-hand "task
 *   message received" card, never a bubble that looks like the user typed it),
 *   and the Session's answer becomes the artifact.
 *
 *   **Client** — `a2a_*` tools let a Session discover and call other agents
 *   through a gateway or directly.
 *
 *   **Groups** — a group is a DSH instance that registered itself as an A2A
 *   agent and keeps an invite-only membership list. That is the whole design:
 *   no new server, no new database, no new auth scheme. AISIX decides who may
 *   reach the agent; the group decides who is a member; the Session decides what
 *   to do about it.
 *
 * The plugin imports nothing but `node:*` and its own files. Bare
 * `@deepseek-ai/...` specifiers only resolve for plugins loaded from inside the
 * DSH installation; a profile or workspace plugin is loaded by plain Node
 * resolution, so it must stay self-contained to load from any location. Every
 * Host capability arrives through the injected `ctx`.
 *
 * @module dsh-a2a
 */

import { readFileSync } from 'node:fs';

import { DEFAULT_CONFIG, normalizeConfig, resolveHome } from './core/config.js';
import { createServer } from './core/server.js';
import { createBridge } from './core/bridge.js';
import { createRegistry } from './core/registry.js';
import { createDeliverer } from './dsh/deliver.js';
import { createGroupStore } from './core/groups.js';
import { createMembershipLedger } from './core/memberships.js';
import { createSessions } from './dsh/sessions.js';
import { createSkillRegistry } from './core/skills.js';
import { buildProfile } from './dsh/profile.js';
import { createPingSkill, createSessionAskSkill } from './core/skills-session.js';
import { createGroupSkills } from './core/skills-group.js';
import { createInbox } from './dsh/inbox.js';
import { registerTools } from './dsh/tools.js';
import { PROMPT_SECTION, PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER } from './dsh/prompt.js';
import { TaskStore } from './core/wire.js';

/** Cordis plugin name. */
export const name = 'a2a';

/**
 * Services this plugin needs before it can contribute anything.
 *
 * Cordis treats a bare `ctx.<name>` read as a *declared dependency* and throws
 * for anything not listed here, so this list is the plugin's whole Host contract:
 *
 *   - `webServer` — what makes this instance reachable at `/a2a`;
 *   - `sessionController` — what makes an inbound message become a real turn;
 *   - `systemPrompt` — where the etiquette section is registered (only needed when
 *     `promptSection` is on, but the read happens at mount time);
 *   - `tools` — the registry `a2a_*` tools are registered on.
 *
 * A Host missing any of these simply does not mount this row, which is better
 * than mounting an agent that cannot answer or a tool surface that cannot be
 * called. Found the hard way: a real Host rejects the mount with "cannot get
 * property X without inject", while a plain test double silently allows it.
 */
export const inject = ['webServer', 'sessionController', 'systemPrompt', 'tools'];

/**
 * Mount A2A on one Host.
 *
 * Everything is assembled here and nowhere else: the store, the registry, the
 * bridge and the server have no knowledge of each other, and this function is
 * the single place their wiring is decided. That keeps each module testable with
 * fakes and makes "why is this setting doing nothing" a question with one place
 * to look.
 *
 * @param {object} ctx - plugin context.
 * @param {object} [config] - plugin configuration from the profile patch.
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  if (!settings.enabled) {
    info(ctx, 'a2a is disabled by configuration');
    return;
  }

  const logger = ctx.logger;
  const home = resolveHome(settings);
  const clock = () => Date.now();

  // --- durable state -------------------------------------------------------
  const groups = createGroupStore({ home, logger, clock, config: settings });
  const registry = createRegistry({ home, logger, clock });
  // The membership ledger is separate from the group store on purpose: the group
  // store holds what a HOST knows about its groups (and therefore only hashes),
  // while the ledger holds what THIS INSTANCE must present (and therefore the
  // credential itself). Two different trust boundaries, two files.
  const identities = createMembershipLedger({ home, logger, clock });
  const tasks = new TaskStore({
    ttlMs: settings.server.taskTimeoutMs * 4,
    persistPath: null,
    clock,
  });

  // --- Host-facing pieces --------------------------------------------------
  const sessions = createSessions({ ctx, config: settings, logger, clock });
  const deliverer = createDeliverer({ ctx, logger, config: settings, clock });
  const bridge = createBridge({ logger, config: settings, clock });

  // --- skills --------------------------------------------------------------
  const skills = createSkillRegistry();
  skills.register(createPingSkill({
    version: pluginVersion(),
    sessionIdOf: () => sessions.resolveBoundSessionId(),
  }));
  if (settings.server.skills.session) {
    skills.register(createSessionAskSkill({ deliverer, sessions, logger, config: settings }));
  }
  if (settings.server.skills.group) {
    for (const skill of createGroupSkills({ store: groups, identities, config: settings, logger, clock })) {
      skills.register(skill);
    }
  }

  // --- server --------------------------------------------------------------
  const server = createServer({
    ctx,
    logger,
    config: settings,
    deliverer,
    tasks,
    skills,
    // Layer B: the identity in the card is derived from memberships on every read,
    // so joining a group or changing a role shows up the next time a peer
    // discovers this agent. Nothing to maintain, nothing to go stale.
    profileProvider: () => buildProfile({ identities, store: groups, config: settings }),
  });

  // --- group inbox (subscription → Session delivery) -----------------------
  const inbox = createInbox({
    ctx, logger, config: settings, clock,
    groups, identities, registry, bridge, deliverer, sessions,
  });

  const disposers = [];
  if (settings.server.enabled) {
    const detach = server.attach();
    if (typeof detach === 'function') disposers.push(detach);
  }

  // --- tool surface --------------------------------------------------------
  if (settings.tools) {
    registerTools(ctx, {
      config: settings, registry, bridge, store: groups, identities, server, sessions, logger, inbox,
    });
  }

  // --- prompt section ------------------------------------------------------
  if (settings.promptSection) {
    ctx.inject(['systemPrompt'], (scoped) => {
      scoped.systemPrompt.section({
        name: PROMPT_SECTION_NAME,
        order: PROMPT_SECTION_ORDER,
        interpolate: false,
        text: PROMPT_SECTION,
      });
    });
  }

  // --- browser panel data --------------------------------------------------

/** How many recent posts the panel shows per group. */
const PANEL_FEED_TAIL = 8;
  // The 「协作群」 panel is a browser bundle that cannot call this Host directly,
  // so the Host publishes its groups where the panel reads them. The channel is
  // the webserver's structured index-injection table, not a hand-written script:
  // the table's rows are JSON-serializable data rendered by the shell, which keeps
  // this side free of escaping rules and keeps the value a value.
  //
  // Read on every index render, so a page refresh always sees the current groups
  // and a group created after boot appears without a restart. Pushing into an
  // open page is the panel's own 2s signature poll — one mechanism, not two.

  const publishGroups = () => {
    try {
      const rows = [];
      for (const record of identities.list()) {
        const hostedHere = groups.has?.(record.groupId) === true;
        const summary = hostedHere ? groups.snapshot({ groupId: record.groupId }) : undefined;
        const lastSeq = summary?.lastSeq ?? record.lastSeq ?? 0;

        // Only the routing facts of the last entry, never its words.
        //
        // This snapshot goes into the page HTML, which a proxy may cache, a screenshot may capture and
        // an extension may read. A member is entitled to read the group; that is not the same as the
        // body being written into every page render. It also used to leak ACROSS conversations: the
        // snapshot is global while groups are bound per Session, so one conversation's messages showed
        // up in another's page.
        //
        // What remains answers "should I open this?": who spoke, when, and how much is unread. Reading
        // the actual feed is a deliberate act — `a2a_group_read` with a member credential — which is a
        // different thing from every page load carrying the content.
        const tail = summary === undefined
          ? (Array.isArray(record.feed) ? record.feed : [])
          : (summary.feedTail ?? []);
        const lastEntry = tail.length === 0 ? undefined : tail[tail.length - 1];
        const lastFromName = lastEntry === undefined
          ? ''
          : (typeof lastEntry.from === 'string' ? lastEntry.from : (lastEntry.from?.displayName ?? ''));
        const lastIsSystem = lastEntry !== undefined && lastEntry.kind === 'system';

        rows.push({
          id: record.groupId,
          groupId: record.groupId,
          // Explicit so the panel can tell a membership row from a directory row without
          // inferring it from the presence of a role.
          joined: true,
          discovered: false,
          name: summary?.name ?? record.groupName ?? record.groupId,
          topic: summary?.topic ?? '',
          role: summary?.owner?.personId === record.personId ? 'owner' : record.role ?? 'member',
          // A remote group has no local snapshot, so the counts come from what the
          // member-side tool cached after calling group/info. Zero would read as
          // \"this group is empty\" rather than \"not fetched yet\", which is the difference
          // between a wrong answer and a missing one.
          memberCount: summary?.memberCount ?? record.memberCount ?? 0,
          onlineCount: summary?.onlineCount ?? record.onlineCount ?? 0,
          // Unread is a consumer-side cursor: the group's head minus what this
          // member has read. Floored at 0 because system entries (created /
          // joined) can push the head past the stored watermark legitimately.
          unreadCount: Math.max(0, lastSeq - (record.lastSeq ?? 0)),
          lastSeq,
          lastTime: summary?.lastPostAt ?? record.lastTime ?? 0,
          // Which conversation this membership belongs to. The panel renders on the
          // index page, before any Session exists, so it cannot filter by "the current
          // Session" — but it can say which one each group belongs to, which is what
          // lets a person tell two memberships in one group apart.
          sessionId: record.sessionId ?? '',
          // Which person this Session is in this group. The panel needs it to mark
          // "me" in the roster: without it there is no way to tell which row is the
          // reader, and the edit affordance has no target. The line above already
          // reads `record.personId` to decide `role`, so the value is present in the
          // record — it simply was not being passed on.
          personId: record.personId ?? '',
          local: hostedHere,
          // The roster a Session cached earlier, via a2a_group_info / a2a_group_members.
          // Nothing is fetched at render time — this page is built before any Session
          // exists and holds no credential — so an absent roster means "not fetched yet"
          // and `rosterCachedAt` says how old a present one is.
          roster: Array.isArray(record.members) ? record.members : [],
          rosterCachedAt: typeof record.rosterCachedAt === 'number' ? record.rosterCachedAt : 0,
          // Kept for the card's hint: with a cached roster the panel draws people, without
          // one it points at the Session rather than implying the group is empty.
          rosterInSession: !Array.isArray(record.members) || record.members.length === 0,
          // No `feed` array: the panel does not need one, and carrying it wrote message bodies into
          // the page. See the note above the tail extraction.
          lastFromName,
          lastIsSystem,
        });
      }
      // Groups hosted here that this instance is not a member of: these are exactly what
      // "可加入" means, and they are readable without a network call because the store is
      // local. A group hosted elsewhere is discovered through a2a_group_directory instead.
      try {
        const joinedIds = new Set(rows.map((row) => row.groupId));
        for (const summary of groups.list() ?? []) {
          if (joinedIds.has(summary.groupId)) continue;
          if ((summary.settings?.visibility ?? 'public') === 'unlisted') continue;
          rows.push({
            id: summary.groupId,
            groupId: summary.groupId,
            joined: false,
            discovered: true,
            name: summary.name,
            topic: summary.topic ?? '',
            role: 'member',
            memberCount: summary.memberCount ?? 0,
            onlineCount: summary.onlineCount ?? 0,
            unreadCount: 0,
            lastSeq: summary.lastSeq ?? 0,
            lastTime: summary.lastPostAt ?? 0,
            sessionId: '',
            local: true,
            rosterInSession: true,
            lastFromName: '',
          lastIsSystem: false,
          });
        }
      } catch (error) {
        // A discover list is a convenience; failing to build it must not blank the panel.
        info(ctx, `a2a: could not list discoverable groups (${describe(error)})`);
      }
      return {
        updatedAt: clock(),
        groups: rows,
        // Colleague cards travel with the group list because the panel renders both from one
        // snapshot: a second channel would mean a second way for the two to disagree.
        // The aggregator is a pure function in core/: rosters in, cards out. Keeping it here
        // would make it testable only by mounting the whole plugin.
        // One source: the host's own person table, which already merges stored profiles with
        // membership rows so somebody who joined before the table existed still appears.
        // Deriving cards from memberships instead was a workaround with the wrong shape — one
        // card per group, stitched together from whichever rosters happened to be cached.
        cards: (() => {
          try {
            const people = typeof groups.listPersons === 'function' ? groups.listPersons() : [];
            return people.map((person) => ({
              personId: person.personId,
              name: person.displayName,
              headline: person.headline,
              tags: Array.isArray(person.tags) ? person.tags : [],
              endpoint: typeof person.endpoint === 'string' ? person.endpoint : '',
              // "Mine" is decided by the ledger: it knows which person ids this instance holds.
              // Matching on a display name would mark a stranger's card as mine, and offer an
              // edit that changes the wrong profile.
              isSelf: identities.list().some((record) => record.personId === person.personId),
              // Presence is the one fact a profile cannot carry: it changes by the minute. It is
              // read from the cached rosters, and absence simply means "unknown", not "offline".
              online: identities.list().some((record) => (record.members ?? [])
                .some((member) => member.personId === person.personId && member.online === true)),
            }));
          } catch (error) {
            // Cards are reference material; a failure must not blank the panel.
            info(ctx, `a2a: could not build colleague cards (${describe(error)})`);
            return [];
          }
        })(),
        unreadTotal: rows.reduce((sum, row) => sum + row.unreadCount, 0),
      };
    } catch (error) {
      // A panel with no data shows its empty state; it must never be a mount
      // failure or a broken page.
      info(ctx, `a2a: could not build the panel snapshot (${describe(error)})`);
      return { updatedAt: clock(), groups: [], cards: [], unreadTotal: 0 };
    }
  };

  try {
    const disposeInject = ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_A2A_GROUPS__', value: publishGroups() });
    });
    if (typeof disposeInject === 'function') disposers.push(disposeInject);
  } catch (error) {
    info(ctx, `a2a: the browser panel data channel is unavailable (${describe(error)})`);
  }

  // --- startup -------------------------------------------------------------
  // The inbox is resumed for every group this instance has joined, so a restart
  // does not silently stop the Session receiving group messages. Failures are
  // logged rather than thrown: a group host that is down must not prevent the
  // plugin from mounting.
  if (settings.groups.enabled) {
    void inbox.resume().catch((error) => {
      info(ctx, `a2a: the group inbox could not resume (${describe(error)}); use a2a_group_inbox on to retry`);
    });
  }

  // Restore the task store lazily: `flush` on unload keeps a restart from losing
  // the tasks a caller may still poll.
  ctx.on('dispose', () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // A failing disposer must not stop the rest of the unload.
      }
    }
    void Promise.allSettled([groups.flush(), registry.flush(), identities.flush(), tasks.flush()]);
  });

  info(
    ctx,
    `a2a ready (server=${settings.server.enabled}, client=${settings.client.enabled}, `
    + `groups=${settings.groups.enabled}, tools=${settings.tools}, `
    + `skills=${skills.ids().join(',') || 'none'}, home=${home})`,
  );
}

/** The configuration an operator can set, exported for documentation and tests. */
export { DEFAULT_CONFIG };

/** The package version, read once from the manifest next to this file. */
function pluginVersion() {
  try {
    // A synchronous read at mount time, not per request: the version cannot
    // change while the process runs, and `ping` is called in hot paths.
    const url = new URL('../package.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(url, 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Log one informational line without depending on a particular logger shape. */
function info(ctx, message) {
  if (typeof ctx.logger?.info === 'function') ctx.logger.info(message);
}

/** One line about an error, without a stack. */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
