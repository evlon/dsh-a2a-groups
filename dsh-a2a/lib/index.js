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

/**
 * The RPC channel the panel uses to write.
 *
 * A single absolute prefix, per `HostConnectionRpc.handle`. Endpoints live under it
 * (`/a2a-panel/profile`), so one registration serves every panel write.
 */
const PANEL_RPC_CHANNEL = '/a2a-panel';

import { DEFAULT_CONFIG, normalizeConfig, resolveHome } from './core/config.js';
import { createServer } from './core/server.js';
import { createBridge } from './core/bridge.js';
import { createRegistry } from './core/registry.js';
import { createDeliverer } from './dsh/deliver.js';
import { createGroupStore } from './core/groups.js';
import { createMembershipLedger, ROSTER_STALE_MS } from './core/memberships.js';
import { createPanelSettings } from './core/panel-settings.js';
import { createSessions } from './dsh/sessions.js';
import { createSkillRegistry } from './core/skills.js';
import { buildProfile } from './dsh/profile.js';
import { createPingSkill, createSessionAskSkill } from './core/skills-session.js';
import { createGroupSkills } from './core/skills-group.js';
import { createInbox } from './dsh/inbox.js';
import { registerTools } from './dsh/tools.js';
import { PROMPT_SECTION, PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER } from './dsh/prompt.js';
import { TaskStore } from './core/wire.js';
import { aggregateColleagueCards } from './core/colleague-cards.js';

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
export const inject = ['webServer', 'sessionController', 'systemPrompt', 'tools', 'connection'];

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
  // Per-Session overrides of the profile default. The profile holds the default; this file holds what a person changed
  // for one conversation, plus whether that conversation still follows the default at all.
  const panelSettings = createPanelSettings({ home, logger, clock });
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
  // The user-questions seam, captured by optional injection.
  //
  // Cordis will not let a plugin read `ctx.userQuestions` unless it is declared in `inject`; touching it anyway throws
  // and takes the whole plugin down. Keeping the resolved service here means the tool layer can ask whether the seam
  // exists without performing an illegal property read.
  let questionSeam;
  if (settings.server.enabled) {
    const detach = server.attach();
    if (typeof detach === 'function') disposers.push(detach);
  }

  // --- tool surface --------------------------------------------------------
  if (settings.tools) {
    // Record which capability seams this Host offers — WITHOUT touching them directly.
    //
    // Cordis refuses `ctx.userQuestions` unless the service is declared in `inject`, and it throws
    // 「cannot get property "userQuestions" without inject」 which takes the WHOLE plugin down at mount. So the probe is
    // an optional injection: the callback runs only when the service exists, and the plugin mounts either way.
    ctx.inject(['userQuestions'], (scoped) => {
      questionSeam = typeof scoped.userQuestions?.ask === 'function' ? scoped.userQuestions : undefined;
      info(ctx, `a2a: userQuestions seam = ${questionSeam === undefined ? 'absent' : 'available'}`);
    });
    info(ctx, 'a2a: seams probed (userQuestions via optional inject)');
    registerTools(ctx, {
      config: settings, registry, bridge, store: groups, identities, server, sessions, logger, inbox,
      // The tool gate needs per-Session settings, not just the profile default: a person who enabled confirmation for
      // one conversation must have it honoured for that conversation.
      panelSettings,
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

  /**
   * Write one person's group-scoped self-description, on behalf of the panel.
   *
   * The panel cannot call a tool: it renders before any Session exists and holds no member credential.
   * This runs in the Host process, where the ledger that holds that credential lives — so the write
   * happens with the same authority a Session turn would have, without the credential ever leaving.
   *
   * Scope is deliberately narrow: the caller names ONE group and this writes only the profile of the
   * person this instance already is in that group. There is no path here that names somebody else.
   *
   * @param {object} payload - `{ groupId, sessionId?, about?, tags?, headline?`.
   * @returns {Promise<object>} a Connection result.
   */
  const setPanelProfile = async (payload) => {
    const body = payload !== null && typeof payload === 'object' ? payload : {};
    const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
    if (groupId === '') {
      return { ok: false, error: { code: 'bad_argument', message: 'groupId is required', details: {} } };
    }
    // Which membership to act as. The panel sends the Session it belongs to; without one there is no
    // honest answer, because a person can hold different credentials per Session.
    const records = identities.list({ groupId });
    const record = body.sessionId === undefined
      ? records[0]
      : records.find((entry) => entry.sessionId === body.sessionId) ?? records[0];
    if (record === undefined) {
      return {
        ok: false,
        error: { code: 'not_member', message: 'this instance is not in that group', details: { groupId } },
      };
    }
    try {
      // Declared here, not inside the local branch: the return below reads it on BOTH paths, and scoping it to
      // one branch made the remote path throw "saved is not defined" — after the write had already succeeded.
      let saved;
      if (record.local === true) {
        saved = groups.setProfile({
          groupId,
          member: { personId: record.personId, personKey: record.personKey },
          about: body.about,
          tags: body.tags,
          displayName: body.displayName,
        });
        // A group-independent headline, when the panel edits the personal profile.
        if (body.headline !== undefined) {
          groups.setPersonProfile({
            groupId,
            member: { personId: record.personId, personKey: record.personKey },
            headline: body.headline,
          });
        }
        await groups.flush();
      } else {
        // A remote group: the host that owns it holds the authority, so the write goes there.
        await bridge.send(
          {
            baseUrl: record.baseUrl,
            apiKey: record.apiKey ?? config.client.apiKey,
            forwardProto: config.client.forwardProto,
            protocolVersion: config.client.protocolVersion,
          },
          {
            skill: 'group/role',
            text: 'set role',
            data: {
              groupId,
              personId: record.personId,
              personKey: record.personKey,
              about: body.about,
              tags: body.tags,
              displayName: body.displayName,
            },
            timeoutMs: config.client.timeoutMs,
          },
        );
        // The headline is a PERSON fact, so it needs its own skill: `group/role` writes one membership,
        // while the value that appears on every colleague card lives on the person row.
        if (body.headline !== undefined) {
          await bridge.send(
            {
              baseUrl: record.baseUrl,
              apiKey: record.apiKey ?? config.client.apiKey,
              forwardProto: config.client.forwardProto,
              protocolVersion: config.client.protocolVersion,
            },
            {
              skill: 'person/profile',
              text: 'set headline',
              data: {
                groupId,
                personId: record.personId,
                personKey: record.personKey,
                headline: body.headline,
              },
              timeoutMs: config.client.timeoutMs,
            },
          );
        }
      }
      // Re-read the roster so the panel's cached ledger reflects the save immediately.
      //
      // A profile write used to land on the host while the local ledger kept its old roster, so the panel showed the
      // pre-save name/headline until something else happened to refresh it. The read below closes that loop: the same
      // `group/info` the tool already uses, written back into the ledger the panel renders from. Best-effort — a
      // failed read-back must not turn a successful save into a reported failure, because the save DID land.
      try {
        if (record.local === true) {
          const info = groups.snapshot({ groupId, member: { personId: record.personId, personKey: record.personKey } });
          if (info !== undefined && info !== null) {
            identities.upsert({
              sessionId: record.sessionId,
              groupId,
              personId: record.personId,
              personKey: record.personKey,
              groupName: typeof info.name === 'string' ? info.name : undefined,
              groupTopic: typeof info.topic === 'string' ? info.topic : undefined,
              memberCount: Number.isFinite(info.memberCount) ? info.memberCount : undefined,
              onlineCount: Number.isFinite(info.onlineCount) ? info.onlineCount : undefined,
              isOwner: info.owner?.personId === record.personId,
              members: Array.isArray(info.members)
                ? info.members.map((member) => ({
                    personId: member.personId,
                    displayName: member.displayName,
                    role: member.role,
                    lastSeenAt: Number.isFinite(member.lastSeenAt) ? member.lastSeenAt : undefined,
                    clientVersion: typeof member.clientVersion === 'string' ? member.clientVersion : '',
                    roleAbout: member.roleAbout,
                    headline: typeof member.headline === 'string' ? member.headline : '',
                    tags: Array.isArray(member.tags) ? member.tags : undefined,
                  }))
                : undefined,
              rosterCachedAt: clock(),
              reachable: true,
            });
            await identities.flush();
          }
        } else {
          const result = await bridge.send(
            {
              baseUrl: record.baseUrl,
              apiKey: record.apiKey ?? config.client.apiKey,
              forwardProto: config.client.forwardProto,
              protocolVersion: config.client.protocolVersion,
            },
            {
              skill: 'group/info',
              text: 'info after save',
              data: { groupId, personId: record.personId, personKey: record.personKey },
              timeoutMs: config.client.timeoutMs,
            },
          );
          const info = result?.data;
          if (info !== undefined && info !== null) {
            identities.upsert({
              sessionId: record.sessionId,
              groupId,
              personId: record.personId,
              personKey: record.personKey,
              groupName: typeof info.name === 'string' ? info.name : undefined,
              groupTopic: typeof info.topic === 'string' ? info.topic : undefined,
              memberCount: Number.isFinite(info.memberCount) ? info.memberCount : undefined,
              onlineCount: Number.isFinite(info.onlineCount) ? info.onlineCount : undefined,
              isOwner: info.owner?.personId === record.personId,
              members: Array.isArray(info.members)
                ? info.members.map((member) => ({
                    personId: member.personId,
                    displayName: member.displayName,
                    role: member.role,
                    lastSeenAt: Number.isFinite(member.lastSeenAt) ? member.lastSeenAt : undefined,
                    clientVersion: typeof member.clientVersion === 'string' ? member.clientVersion : '',
                    roleAbout: member.roleAbout,
                    headline: typeof member.headline === 'string' ? member.headline : '',
                    tags: Array.isArray(member.tags) ? member.tags : undefined,
                  }))
                : undefined,
              rosterCachedAt: clock(),
              reachable: true,
            });
            await identities.flush();
          }
        }
      } catch (error) {
        // A read-back failure is a refresh problem, not a save problem. Log it, keep the save's success.
        info(ctx, `a2a: post-save roster refresh failed for ${groupId} (${describe(error)})`);
      }

      // `changed: false` means the value was already that — worth telling the reader, because the feed
      // no longer announces no-op saves and "已保存" for an unchanged value would be misleading.
      return { ok: true, value: { saved: true, changed: saved?.changed !== false, groupId, at: clock() } };
    } catch (error) {
      // Log it. The panel can only render a code, and a user-triggered failure that leaves no trace costs a
      // reproduction attempt every time it is reported.
      console.error('[a2a-panel] write failed for ' + groupId + ': ' + describe(error));
      return { ok: false, error: { code: 'write_failed', message: describe(error), details: { groupId } } };
    }
  };

  /**
   * Invite one person to one group, on behalf of the panel.
   *
   * Reuses `person/send` semantics rather than minting an invitation here: two paths that mint invites would
   * eventually disagree about `maxUses` or expiry, and the disagreement would be visible only to whoever got
   * the wrong link.
   *
   * @param {object} payload - `{ groupId, sessionId?, toPersonId }`.
   * @returns {Promise<object>} a Connection result with `{ dmId, online }`.
   */
        /**
       * Change this group's standing rules, on behalf of the PANEL.
       *
       * The panel cannot call the tool: it renders before any Session exists and deliberately
       * holds no credential. The credential lives here in the membership ledger, which is why this
       * has to be an RPC the Host performs rather than something the page does itself.
       *
       * Two shapes, matching the tool:
       *   { conventions: "<full text>" }  replaces the built-in rules for this group
       *   { reset: true }                 goes back to the built-in rules
       *
       * An override is a real decision with a real cost, so the caller is told what it costs
       * rather than discovering it when the defaults are improved and this group does not move.
       */
      const setPanelConventions = async (payload) => {
        const body = payload !== null && typeof payload === 'object' ? payload : {};
        const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (groupId === '') {
          return { ok: false, error: { code: 'bad_argument', message: 'groupId is required', details: {} } };
        }
        const candidates = identities.list({ groupId });
        const record = candidates.find((entry) => entry.sessionId === sessionId) ?? candidates[0];
        if (record === undefined) {
          return {
            ok: false,
            error: { code: 'not_member', message: 'this instance holds no membership for that group', details: { groupId } },
          };
        }
        const member = { personId: record.personId, personKey: record.personKey };
        try {
          let result;
          if (record.local === true) {
            result = groups.setConventions({
              groupId,
              member,
              conventions: typeof body.conventions === 'string' ? body.conventions : undefined,
              extra: typeof body.extra === 'string' ? body.extra : undefined,
              reset: body.reset === true,
            });
          } else {
            const answer = await bridge.send(
              {
                baseUrl: record.baseUrl,
                apiKey: record.apiKey ?? settings.client.apiKey,
                forwardProto: settings.client.forwardProto,
                protocolVersion: settings.client.protocolVersion,
              },
              {
                skill: 'group/conventions',
                text: 'conventions',
                data: {
                  groupId,
                  ...member,
                  ...(typeof body.conventions === 'string' ? { conventions: body.conventions } : {}),
                  ...(typeof body.extra === 'string' ? { extra: body.extra } : {}),
                  ...(body.reset === true ? { reset: true } : {}),
                },
                timeoutMs: settings.client.timeoutMs,
              },
            );
            result = answer?.data ?? undefined;
          }
          const conventions = typeof result?.conventions === 'string' ? result.conventions : '';
          // Update the panel cache in the same breath: the page renders from the ledger, so a
          // successful write that is not cached looks like a failed write until the next poll.
          try {
            identities.upsert({ sessionId: record.sessionId, groupId, conventions });
            if (typeof identities.flush === 'function') await identities.flush();
          } catch {
            // A stale panel is better than a failed save.
          }
          return { ok: true, conventions, changed: result?.changed === true };
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : 'panel_failed';
          // A refusal from the host is a real answer (only the owner may edit), so it keeps its own
          // code instead of being flattened into a generic failure.
          return { ok: false, error: { code, message: describe(error), details: {} } };
        }
      };

const setPanelInvite = async (payload) => {
    const body = payload !== null && typeof payload === 'object' ? payload : {};
    const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
    const toPersonId = typeof body.toPersonId === 'string' ? body.toPersonId.trim() : '';
    if (groupId === '') {
      return { ok: false, error: { code: 'bad_argument', message: 'groupId is required', details: {} } };
    }
    if (toPersonId === '') {
      return { ok: false, error: { code: 'bad_argument', message: 'toPersonId is required', details: {} } };
    }
    const records = identities.list({ groupId });
    const record = body.sessionId === undefined
      ? records[0]
      : records.find((entry) => entry.sessionId === body.sessionId) ?? records[0];
    if (record === undefined) {
      return {
        ok: false,
        error: { code: 'not_member', message: 'this instance is not in that group', details: { groupId } },
      };
    }
    try {
      if (record.local === true) {
        const sent = store.sendPersonMessage({
          fromPersonId: record.personId,
          toPersonId,
          kind: 'group-invite',
          text: '',
          payload: undefined,
        });
        await store.flush();
        return { ok: true, value: { dmId: sent.dmId, online: store.isPersonOnline(toPersonId) } };
      }
      const result = await bridge.send(
        {
          baseUrl: record.baseUrl,
          apiKey: record.apiKey ?? config.client.apiKey,
          forwardProto: config.client.forwardProto,
          protocolVersion: config.client.protocolVersion,
        },
        {
          skill: 'person/send',
          text: 'send group-invite to ' + toPersonId,
          data: {
            groupId,
            personId: record.personId,
            personKey: record.personKey,
            fromPersonId: record.personId,
            toPersonId,
            kind: 'group-invite',
          },
          timeoutMs: config.client.timeoutMs,
        },
      );
      const meta = result.data ?? {};
      return {
        ok: true,
        value: {
          dmId: typeof meta.dmId === 'string' ? meta.dmId : '',
          online: meta.online === true,
        },
      };
    } catch (error) {
      // Reported as a failed SEND, distinct from a failed invite: the person is told the invitation did not go
      // out rather than being left to assume it did.
      return { ok: false, error: { code: 'send_failed', message: describe(error), details: { groupId, toPersonId } } };
    }
  };

  /**
   * Save the a2a config from the panel's 「设置」 tab.
   *
   * The form is the point: a colleague who has never seen cordis.patch.yml must not have to learn YAML indentation to
   * wire up their instance. Each field is a flat, labelled input; this endpoint turns them into the plugin's config
   * object and hands it to the Host's own `configEditor` service, which owns validation, atomic writes, failure
   * rollback and the hot reload that makes the change live.
   *
   * @param {object} payload - flat fields: `gatewayBase`, `agentName`, `apiKey`, `publicUrl`, `token`.
   * @returns {Promise<object>} a Connection result.
   */
  const setPanelConfig = async (payload) => {
    const body = payload !== null && typeof payload === 'object' ? payload : {};

    // The editor is an OPTIONAL host service. Without it the page can still SHOW the config; it just cannot save.
    const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
    if (editor === undefined || typeof editor.edit !== 'function') {
      return {
        ok: false,
        error: {
          code: 'config_editor_unavailable',
          message: '当前 profile 未启用配置编辑服务（dsh-config-editor），无法从面板保存。请直接编辑 cordis.patch.yml。',
          details: {},
        },
      };
    }
    const entry = ctx.fiber !== undefined && ctx.fiber !== null ? ctx.fiber.entry : undefined;
    if (entry === undefined) {
      return { ok: false, error: { code: 'no_entry', message: '找不到这个插件的配置入口', details: {} } };
    }

    // Validate before touching anything: a wrong URL or empty name is a form error, not a file write.
    const gatewayBase = typeof body.gatewayBase === 'string' ? body.gatewayBase.trim() : '';
    const agentName = typeof body.agentName === 'string' ? body.agentName.trim() : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const publicUrl = typeof body.publicUrl === 'string' ? body.publicUrl.trim() : '';
    const token = typeof body.token === 'string' ? body.token : '';

    if (gatewayBase !== '' && !/^https?:\/\//i.test(gatewayBase)) {
      return { ok: false, error: { code: 'bad_argument', message: '网关地址必须以 http:// 或 https:// 开头', details: {} } };
    }
    if (agentName === '') {
      return { ok: false, error: { code: 'bad_argument', message: '「你在网关里的名字」不能为空', details: {} } };
    }
    if (publicUrl !== '' && !/^https?:\/\//i.test(publicUrl)) {
      return { ok: false, error: { code: 'bad_argument', message: '对外地址必须以 http:// 或 https:// 开头', details: {} } };
    }

    try {
      await editor.edit(entry, (current) => ({
        ...(current ?? {}),
        groups: {
          ...((current ?? {}).groups ?? {}),
          enabled: true,
          gatewayBase: gatewayBase === '' ? undefined : gatewayBase,
          agentName: agentName === '' ? undefined : agentName,
        },
        client: {
          ...((current ?? {}).client ?? {}),
          enabled: true,
          apiKey: apiKey === '' ? undefined : apiKey,
          gatewayBase: gatewayBase === '' ? undefined : gatewayBase,
          forwardProto: 'http',
        },
        server: {
          ...((current ?? {}).server ?? {}),
          enabled: true,
          publicUrl: publicUrl === '' ? undefined : publicUrl,
          token: token === '' ? undefined : token,
        },
        tools: true,
        promptSection: true,
      }));
      return { ok: true, value: { saved: true, at: clock() } };
    } catch (error) {
      return { ok: false, error: { code: 'config_save_failed', message: describe(error), details: {} } };
    }
  };

  /**
   * The host's public group directory, as last fetched.
   *
   * WHY A CACHE AND NOT A DIRECT CALL
   *
   * `publishGroups()` is SYNCHRONOUS: it also runs while rendering the page HTML, where awaiting is impossible. Asking the
   * host inside it would mean either blocking the render on a network round trip or dropping the feature.
   *
   * So the fetch is separate (`refreshDirectory`) and this holds its last answer. A stale list is acceptable — the panel
   * already shows group data that is a poll behind — while a blank panel is not.
   */
  let directoryCache = { at: 0, groups: [], error: '' };

  /**
   * Fetch the host's public directory and remember it.
   *
   * The list is what the host OFFERS, which is a different question from what this machine has JOINED. Without it the
   * panel could only ever show groups the person is already in, and 「宿主上还有 5 个群可以加入」 was invisible in the
   * UI even though `a2a_group_directory` answered it correctly on the tool surface. Measured: a panel showing 1 group
   * while the host listed 6.
   *
   * Failures are recorded rather than thrown: a directory is a convenience, and an unreachable host must not break the
   * panel that is otherwise fully usable from the ledger.
   *
   * @returns {Promise<void>} resolves when the attempt finishes, successfully or not.
   */
  const refreshDirectory = async () => {
    const record = identities.list()[0];
    const target = record !== undefined
      ? { baseUrl: record.baseUrl, personKey: record.personKey }
      : (settings.groups.gatewayBase !== '' && settings.groups.agentName !== ''
        ? { baseUrl: `${settings.groups.gatewayBase.replace(/\/+$/, '')}/${settings.groups.agentName}` }
        : undefined);
    if (target === undefined) {
      directoryCache = { at: clock(), groups: [], error: '还没有配置网关或宿主名，无法浏览群目录。' };
      return;
    }
    try {
      const result = await bridge.send(target, {
        skill: 'group/directory',
        text: 'list groups',
        data: { limit: 50 },
        timeoutMs: settings.client.timeoutMs,
      });
      const listed = Array.isArray(result?.data?.groups) ? result.data.groups : [];
      directoryCache = {
        at: clock(),
        // Only what the panel needs to render a row it can act on.
        groups: listed.map((group) => ({
          groupId: group.groupId,
          name: group.name ?? group.groupId,
          topic: group.topic ?? '',
          memberCount: Number.isFinite(group.memberCount) ? group.memberCount : 0,
          onlineCount: Number.isFinite(group.onlineCount) ? group.onlineCount : 0,
          lastTime: Number.isFinite(group.lastActivityAt) ? group.lastActivityAt : 0,
        })),
        error: '',
      };
    } catch (error) {
      directoryCache = { at: clock(), groups: directoryCache.groups, error: describe(error) };
    }
  };

  /**
   * The a2a config section, rendered as paste-ready YAML for the panel's 「设置」 tab.
   *
   * A colleague who has the plugin installed but not wired up does not know where the cordis.patch.yml file is; asking
   * them to find it is homework. The tab shows the exact section for THIS instance, so they can copy it, or read the
   * three fields a human actually cares about (gateway, agent name, key) without opening any file.
   *
   * The API key is a secret, so it is masked in the YAML text — a full copy must never leak it by accident. The
   * structured `fields` below carries the real values the panel decides how to display (masked or not).
   */
  const renderConfigSection = () => {
    const groups = settings.groups ?? {};
    const client = settings.client ?? {};
    const server = settings.server ?? {};
    // The section a colleague pastes into cordis.patch.yml. Deliberately matches the /setup page's shape so the two
    // entry points cannot drift apart.
    const yaml = [
      '- id: a2a',
      '  name: dsh-a2a-groups',
      '  config:',
      '    groups:',
      '      enabled: true',
      '      gatewayBase: ' + (groups.gatewayBase ?? ''),
      '      agentName: ' + (groups.agentName ?? ''),
      '    client:',
      '      enabled: true',
      // The key is masked here; the real value is in `fields.apiKey` and shown masked in the UI too.
      '      apiKey: ' + maskSecret(client.apiKey ?? ''),
      '      gatewayBase: ' + (client.gatewayBase ?? ''),
      '      forwardProto: ' + (client.forwardProto === '' ? 'http' : client.forwardProto),
      '    server:',
      '      enabled: ' + (server.enabled !== false),
      '      publicUrl: ' + (server.publicUrl ?? ''),
      '      token: ' + (typeof server.token === 'string' && server.token !== '' ? '<已配置，不展示>' : ''),
      '    tools: true',
      '    promptSection: true',
    ].join('\n');

    return {
      yaml,
      fields: {
        gatewayBase: groups.gatewayBase ?? '',
        agentName: groups.agentName ?? '',
        apiKey: client.apiKey ?? '',
        home: groups.home ?? '',
        serverEnabled: server.enabled !== false,
        publicUrl: server.publicUrl ?? '',
        token: typeof server.token === 'string' ? server.token : '',
        version: pluginVersion(),
      },
    };
  };

  /** Mask a secret so a copy-paste of the config never leaks it. */
  function maskSecret(value) {
    if (typeof value !== 'string' || value === '') return '';
    if (value.length <= 8) return '****';
    return value.slice(0, 4) + '****' + value.slice(-4);
  }

  const publishGroups = () => {
    try {
      const rows = [];
      // ONE ROW PER GROUP, not per ledger record.
      //
      // A person who has moved working directories has several records for the same group. Rendering one row each
      // made the panel list 「发票与对账平台」 four times with identical labels — reported as 「切换不同的会话，都显示在这
      // 个群里面」. The reader is looking at groups, not at ledger rows.
      //
      // The records still matter for the rejoin offer, so the surviving row carries the OTHER Sessions that hold the
      // group; the pane compares those against its own Session.
      const allRecords = identities.list();
      const byGroup = new Map();
      for (const record of allRecords) {
        const existing = byGroup.get(record.groupId);
        // Newest wins: it is the credential the host most recently issued.
        if (existing === undefined || (record.touchedAt ?? 0) > (existing.touchedAt ?? 0)) {
          byGroup.set(record.groupId, record);
        }
      }
      for (const record of byGroup.values()) {
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
          // Three sources, most authoritative first.
          //
          // `summary.owner` only exists for a group THIS instance hosts. Then the cached roster — the host's own answer
          // from the last info call. Only then the ledger's flat `role`, which is written at join time and was measured
          // stuck at `member` after the person was promoted: the panel filed a group under 「我参与」 while the host said
          // `isOwner: true`, and 「我管理」 showed 「还没有你管理的协作群」.
          role: summary?.owner?.personId === record.personId
            ? 'owner'
            : (Array.isArray(record.members) && record.members.some((member) => member.personId === record.personId && member.role === 'owner')
              ? 'owner'
              : (record.role ?? 'member')),
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
          // What the group is FOR, and the standing rules it operates under.
          //
          // Two sources, because the panel serves two kinds of group: a group hosted here has a
          // live snapshot, while a remote group only ever has whatever the member's last
          // a2a_goal_status cached in the ledger. Absent when neither has it — which is exactly
          // what a group that never adopted the organisation layer should look like.
          ...(summary?.goal === undefined && record.goal === undefined
            ? {}
            : { goal: summary?.goal ?? record.goal }),
          ...(summary?.conventions === undefined && record.conventions === undefined
            ? {}
            : { conventions: summary?.conventions ?? record.conventions }),
          // Which conversation this membership belongs to. The panel renders on the
          // index page, before any Session exists, so it cannot filter by "the current
          // Session" — but it can say which one each group belongs to, which is what
          // lets a person tell two memberships in one group apart.
          sessionId: record.sessionId ?? '',
          // Every Session that holds a credential for THIS group.
          //
          // Required because the row above is now one per group: without the full set, a conversation that is not the
          // newest holder could not tell that the group exists under a different Session, and the rejoin offer would
          // vanish for exactly the case it was built for.
          knownSessionIds: allRecords
            .filter((entry) => entry.groupId === record.groupId)
            .map((entry) => entry.sessionId)
            .filter((id) => typeof id === 'string' && id !== ''),
          // Which person this Session is in this group. The panel needs it to mark
          // "me" in the roster: without it there is no way to tell which row is the
          // reader, and the edit affordance has no target. The line above already
          // reads `record.personId` to decide `role`, so the value is present in the
          // record — it simply was not being passed on.
          personId: record.personId ?? '',
          local: hostedHere,
          // When the last attempt to reach this group was refused, the panel can say so. Without this it has
          // no way to distinguish a live membership from one whose credential the host no longer accepts —
          // which is how a person ends up believing they are in a group they cannot actually speak in.
          unreachableAt: typeof record.unreachableAt === 'number' ? record.unreachableAt : 0,
          // This machine holds a credential for this group, in THIS Session. The pane uses it together with the
          // row's own `sessionId` to decide whether to offer a rejoin: a credential held by another Session means
          // "you are still a member, you just moved", which is what the offer is for.
          //
          // Carried on the membership row rather than on a synthetic second row per Session — that duplication made
          // the snapshot contain every group twice and is why the group list looked wrong.
          canRejoinAs: true,
          knownAs: typeof record.groupName === 'string' ? record.groupName : '',
          // The roster a Session cached earlier, via a2a_group_summary / a2a_group_members.
          // Nothing is fetched at render time — this page is built before any Session
          // exists and holds no credential — so an absent roster means "not fetched yet"
          // and `rosterCachedAt` says how old a present one is.
          roster: Array.isArray(record.members) ? record.members : [],
          rosterCachedAt: typeof record.rosterCachedAt === 'number' ? record.rosterCachedAt : 0,
          // The panel must not present a cached roster as fact once it is old. This is the honest half of having a
          // cache at all: it says both what we know and how much to trust it.
          rosterStale: !Number.isFinite(record.rosterCachedAt) || (clock() - record.rosterCachedAt) > ROSTER_STALE_MS,
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
        // Groups this machine already belongs to, from ANY Session. Work moves between directories, so a person
        // rejoining a long-lived group usually has a ledger row already — and needing a fresh invite for it is
        // both unnecessary and, for them, impossible without asking the owner again.
        const knownByGroup = new Map();
        for (const record of identities.list()) {
          if (typeof record.groupId !== 'string' || record.groupId === '') continue;
          const existing = knownByGroup.get(record.groupId);
          // Most recently touched wins: if there are several, the newest is the one they last worked as.
          if (existing === undefined || (record.touchedAt ?? 0) > (existing.touchedAt ?? 0)) {
            knownByGroup.set(record.groupId, record);
          }
        }

        const joinedIds = new Set(rows.map((row) => row.groupId));
        for (const summary of groups.list() ?? []) {
          if (joinedIds.has(summary.groupId)) continue;
          if ((summary.settings?.visibility ?? 'public') === 'unlisted') continue;
          rows.push({
            id: summary.groupId,
            groupId: summary.groupId,
            joined: false,
            discovered: true,
            // Whether this machine can rejoin WITHOUT a link, and who it would rejoin as.
            knownAs: knownByGroup.get(summary.groupId)?.groupName ?? '',
            knownSessionId: knownByGroup.get(summary.groupId)?.sessionId ?? '',
            canRejoinAs: knownByGroup.has(summary.groupId),
            name: summary.name,
            topic: summary.topic ?? '',            role: 'member',
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
        // NOTE: no second row per record.
        //
        // The loop above already emits one `joined: true` row PER LEDGER RECORD, carrying that record's real
        // `sessionId`. An extra `joined: false` row per record was added here to make the rejoin offer reachable, and
        // it made the snapshot contain the same group twice for every Session — four rows for a group held by two
        // Sessions. The pane filters by `sessionId` and by `canRejoinAs`, both of which the first row already
        // carries, so the extras were pure duplication.
        //
        // The rejoin offer is therefore driven by `canRejoinAs` (set on each ledger-derived row above) plus the
        // pane's own comparison against the current Session — not by a shadow row.

        // Groups the HOST offers that this machine has not joined.
        //
        // `groups.list()` above only knows what THIS instance hosts — zero for every member instance, because the
        // groups live on a separate host. A member therefore saw only the groups it had already joined, and the six
        // public groups sitting on the host were invisible in the UI while `a2a_group_directory` answered them
        // correctly. These rows come from the cached directory instead, which is filled by `refreshDirectory()`.
        for (const entry of directoryCache.groups) {
          if (joinedIds.has(entry.groupId)) continue;
          if (rows.some((row) => row.groupId === entry.groupId)) continue;
          rows.push({
            id: entry.groupId,
            groupId: entry.groupId,
            joined: false,
            discovered: true,
            knownAs: '',
            knownSessionId: '',
            canRejoinAs: false,
            name: entry.name,
            topic: entry.topic,
            role: 'member',
            memberCount: entry.memberCount,
            onlineCount: entry.onlineCount,
            unreadCount: 0,
            lastSeq: 0,
            lastTime: entry.lastTime,
            sessionId: '',
            local: false,
            rosterInSession: false,
            lastFromName: '',
            lastIsSystem: false,
          });
        }

      } catch (error) {
        // A discover list is a convenience; failing to build it must not blank the panel.
        info(ctx, `a2a: could not list discoverable groups (${describe(error)})`);
      }
      return {
        // This instance's own build, so the panel can compare it against what each member reports. The panel
        // cannot read package.json itself — it is a page, not a process.
        selfVersion: pluginVersion(),
        updatedAt: clock(),
        groups: rows,
        // Why the 「可加入」 list is empty, when it is. An empty list means either 「nothing more exists」 or 「we could not
        // ask the host」, and only one of those is good news — saying which avoids presenting a network failure as a
        // fact about the world.
        directoryError: directoryCache.error,
        directoryAt: directoryCache.at,
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
            // Cards are aggregated from the cached ROSTERS, not from the local person table.
            //
            // The local `groups.listPersons()` is the wrong source for a MEMBER instance: it only holds people from
            // groups THIS machine hosts (zero for a member), so the colleague cards showed 张三/李四/王五 from one old
            // local group while the joined group "Codebuddy测试" (hosted on the remote host) listed 小C and 小D in its
            // roster. Two names for the same panel, one stale and one live.
            //
            // The roster is the host's own answer about who is in the group, already cached on each membership row
            // from the last `a2a_group_summary`. Aggregating it (the pure `aggregateColleagueCards`) makes the cards
            // come from the SAME data the member list reads, so a rename or a headline change shows up everywhere at
            // once instead of in one place only.
            const records = identities.list();
            return aggregateColleagueCards(records).map((card) => ({
              personId: card.personId,
              name: card.name,
              headline: card.headline,
              tags: card.tags,
              roles: card.roles,
              groups: card.groups,
              endpoint: '',
              isSelf: card.isSelf === true,
              online: card.online === true,
            }));
          } catch (error) {
            // Cards are reference material; a failure must not blank the panel.
            info(ctx, `a2a: could not build colleague cards (${describe(error)})`);
            return [];
          }
        })(),
        unreadTotal: rows.reduce((sum, row) => sum + row.unreadCount, 0),
        // The paste-ready config section, for the 「设置」 tab. Rendered here so the page holds no plugin code, just
        // the text it is allowed to show.
        settings: renderConfigSection(),
      };
    } catch (error) {
      // A panel with no data shows its empty state; it must never be a mount
      // failure or a broken page.
      info(ctx, `a2a: could not build the panel snapshot (${describe(error)})`);
      return { updatedAt: clock(), groups: [], cards: [], unreadTotal: 0 };
    }
  };

  // The panel's write path. Client → Host over DSH's own connection layer: same origin, authenticated by
  // the connection transport, and no credential ever placed in the page.
  //
  // Registered defensively because the service is optional: a host without the Connection plugin has no
  // panel, and that must not stop the A2A side from working.

  try {
    // The upstream bug (#8414): registration from a plugin fiber throws "cannot get property webServer
    // without inject" because the registration effect runs on a fiber that lacks the declaration. The
    // discussion notes the ROOT context registers fine, so try the plugin's root before giving up.
    const rootCtx = ctx.root ?? (typeof ctx.get === "function" ? ctx.get("root") : undefined) ?? ctx;
    const connection = (rootCtx.get ?? ctx.get)("connection");
    if (connection === undefined || connection === null || typeof connection.rpc?.handle !== 'function') {
      console.error("[a2a-panel] no connection.rpc available");
    } else {
      /**
       * Re-read one group's roster and write it back to the ledger.
       *
       * The panel cannot do this itself: the credential is here, and the page holds no credential on purpose. So the
       * refresh happens against the local ledger and only the resulting snapshot travels back.
       *
       * @param {object} payload - `{ groupId, sessionId }`.
       * @returns {Promise<object>} the Connection RPC envelope.
       */
      const refreshGroupRoster = async (payload) => {
        const body = payload !== null && typeof payload === 'object' ? payload : {};
        const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (groupId === '') {
          return { ok: false, error: { code: 'bad_argument', message: 'groupId is required', details: {} } };
        }

        // Any membership of this group will do: the credential identifies the person, and the roster is the same
        // regardless of which one presents it. Prefer the Session the panel belongs to, then any.
        const candidates = identities.list({ groupId });
        const record = candidates.find((entry) => entry.sessionId === sessionId) ?? candidates[0];
        if (record === undefined) {
          return {
            ok: false,
            error: { code: 'not_member', message: 'this instance holds no membership for that group', details: { groupId } },
          };
        }

        try {
          let info;
          if (record.local === true) {
            // Hosted here: the store is the authority, no network involved.
            info = groups.snapshot({ groupId, member: { personId: record.personId, personKey: record.personKey } });
          } else {
            const result = await bridge.send(
              {
                baseUrl: record.baseUrl,
                apiKey: record.apiKey ?? settings.client.apiKey,
                forwardProto: settings.client.forwardProto,
                protocolVersion: settings.client.protocolVersion,
              },
              {
                skill: 'group/info',
                text: 'info',
                data: { groupId, personId: record.personId, personKey: record.personKey },
                timeoutMs: settings.client.timeoutMs,
              },
            );
            info = result?.data ?? undefined;
          }
          if (info === undefined || info === null) {
            return { ok: false, error: { code: 'empty_answer', message: 'the host returned no group info', details: { groupId } } };
          }

          // Same shape the tool writes: keep the timestamp, drop the claim about now.
          identities.upsert({
            sessionId: record.sessionId,
            groupId,
            personId: record.personId,
            personKey: record.personKey,
            groupName: typeof info.name === 'string' ? info.name : undefined,
            groupTopic: typeof info.topic === 'string' ? info.topic : undefined,
            memberCount: Number.isFinite(info.memberCount) ? info.memberCount : undefined,
            onlineCount: Number.isFinite(info.onlineCount) ? info.onlineCount : undefined,
            isOwner: info.owner?.personId === record.personId,
            members: Array.isArray(info.members)
              ? info.members.map((member) => ({
                  personId: member.personId,
                  displayName: member.displayName,
                  role: member.role,
                  lastSeenAt: Number.isFinite(member.lastSeenAt) ? member.lastSeenAt : undefined,
                  // Which build this member reported on its last heartbeat. Carried so the panel can show a mixed
                  // group instead of letting a version skew look like a bug in the group.
                  clientVersion: typeof member.clientVersion === 'string' ? member.clientVersion : '',
                  roleAbout: member.roleAbout,
                  headline: typeof member.headline === 'string' ? member.headline : '',
                  tags: Array.isArray(member.tags) ? member.tags : undefined,
                }))
              : undefined,
            rosterCachedAt: clock(),
            reachable: true,
          });
          if (typeof identities.flush === 'function') await identities.flush();

          return {
            ok: true,
            value: {
              groupId,
              memberCount: Number.isFinite(info.memberCount) ? info.memberCount : 0,
              refreshedAt: clock(),
              groups: publishGroups(),
            },
          };
        } catch (error) {
          // A failed refresh must leave the old cache alone and say what happened: the reader still needs to know
          // the group exists, and the next attempt is theirs to make.
          const code = typeof error?.data === 'string' ? error.data : (typeof error?.code === 'string' ? error.code : 'refresh_failed');
          return { ok: false, error: { code, message: describe(error), details: { groupId } } };
        }
      };

      const disposePanelRpc = connection.rpc.handle(
        PANEL_RPC_CHANNEL,
        async (endpoint, payload) => {
          // `endpoint` is channel-relative, per the Connection contract, so it arrives without the
          // leading slash the channel itself has.
          const name = String(endpoint ?? '').replace(/^\/+/, '');
          try {
            if (name === 'ping') {
              return { ok: true, value: { pong: true, at: clock() } };
            }
            // The current group table, recomputed on demand.
            //
            // `webserver/index-inject` fires once, when the page is rendered, and freezes its value into the HTML.
            // The panel polls, but it was polling that frozen copy — so every change the panel made or observed was
            // invisible until a full page reload. Reported as "I could not see the members while operating, only after
            // refreshing", which is exactly what a poll over static data produces.
            if (name === 'groups') {
              // `.groups`, not the whole snapshot.
              //
              // `publishGroups()` returns `{ selfVersion, updatedAt, groups: rows, cards, unreadTotal }`. Handing that
              // object to the panel under the key `groups` made the response shape `value.groups === {…}`, so
              // `Array.isArray` was false, `replaceGroups` refused it, and EVERY POLL SILENTLY WROTE NOTHING — while
              // still reporting `ok: true`. The page therefore kept the snapshot injected at load time forever, which
              // is exactly the reported behaviour: 「操作的时候看不到，重新打开刷新以后能看到」.
              //
              // The directory is refreshed here, on the poll, rather than on every render: the page's initial HTML is
              // synchronous and cannot await a network call, while the poll is already async and has a natural cadence.
              await refreshDirectory();
              const snapshot = publishGroups();
              return {
                ok: true,
                value: {
                  groups: snapshot.groups,
                  // Cards travel with every poll, not only the page render. A profile save used to be invisible
                  // until the next full reload, because the page's injected copy was frozen at load time — the
                  // exact "saved but nothing changed" report. The poll already re-reads live state, so the cards
                  // come from the server each time instead of from a stale copy.
                  cards: snapshot.cards,
                  directoryError: snapshot.directoryError,
                  directoryAt: snapshot.directoryAt,
                  at: clock(),
                },
              };
            }
            // Human-confirmation settings for one Session.
            //
            // Three facts travel together because the panel needs all of them to be honest: the profile default, what
            // this Session overrode, and which of the two is actually in force. Returning only `effective` would leave
            // the person unable to tell whether they are looking at their own choice or the profile's.
            if (name === 'confirm-settings') {
              const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
              const resolved = panelSettings.effectiveFor(sessionId, settings.groups.humanConfirm);
              return {
                ok: true,
                value: {
                  sessionId,
                  profile: { ...settings.groups.humanConfirm },
                  inherit: resolved.inherit,
                  override: resolved.override,
                  effective: { ...resolved.effective },
                },
              };
            }
            if (name === 'set-confirm-settings') {
              const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
              if (sessionId === '') {
                return {
                  ok: false,
                  error: { code: 'bad_argument', message: '需要 sessionId：人工确认是每个会话单独设置的', details: {} },
                };
              }
              const resolved = panelSettings.set(
                { sessionId, inherit: payload?.inherit === true, humanConfirm: payload?.humanConfirm },
                settings.groups.humanConfirm,
              );
              return {
                ok: true,
                value: {
                  sessionId,
                  profile: { ...settings.groups.humanConfirm },
                  inherit: resolved.inherit,
                  override: resolved.override,
                  effective: { ...resolved.effective },
                },
              };
            }
            if (name === 'profile') {
              return await setPanelProfile(payload);
            }
            if (name === 'set-config') {
              return await setPanelConfig(payload);
            }
            if (name === 'refresh') {
              return await refreshGroupRoster(payload);
            }
            if (name === 'invite') {
              return await setPanelInvite(payload);
            }
            if (name === 'set-conventions') {
              return await setPanelConventions(payload);
            }
            // `details` is mandatory in ConnectionRpcFailure; omitting it yields a malformed response
            // rather than a clean refusal.
            return {
              ok: false,
              error: { code: 'not_found', message: 'unknown panel endpoint: ' + name, details: { endpoint: name } },
            };
          } catch (error) {
            return {
              ok: false,
              error: { code: 'panel_failed', message: describe(error), details: {} },
            };
          }
        },
      );
      if (typeof disposePanelRpc === "function") disposers.push(disposePanelRpc);
      console.error("[a2a-panel] registered " + PANEL_RPC_CHANNEL);
    }
  } catch (error) {
    // A probe that breaks the mount would be worse than no probe.
    console.error("[a2a-panel] register failed: " + describe(error));
  }

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

  // --- presence ---------------------------------------------------------
  // A running instance is present, whether or not anybody has the inbox open.
  //
  // The heartbeat used to live inside `group/subscribe`, which made presence a side effect of watching: an instance
  // that joined a group and never opened its inbox was shown as offline two minutes after starting, while it was
  // demonstrably alive. Presence is a property of the process.
  //
  // The tick is 50s against a 120s window, so a single missed tick does not flicker anybody offline. It touches only
  // remote groups: a hosted group is this instance's own store and needs no network to stay fresh.
  const PRESENCE_TICK_MS = 50_000;
  let presenceTimer;
  const presenceHeartbeat = () => {
    if (settings.groups.enabled !== true) return;
    for (const record of identities.remoteMemberships()) {
      void bridge
        .send(
          {
            baseUrl: record.baseUrl,
            apiKey: record.apiKey ?? settings.client.apiKey,
            forwardProto: settings.client.forwardProto,
            protocolVersion: settings.client.protocolVersion,
          },
          {
            skill: 'group/touch',
            text: 'touch',
            // The only process that knows which version is running is the one running it, so it reports.
            data: {
              groupId: record.groupId,
              personId: record.personId,
              personKey: record.personKey,
              version: pluginVersion(),
            },
            timeoutMs: settings.client.timeoutMs,
          },
        )
        .then(async () => {
          // A tick that worked retracts any earlier doubt.
          if (typeof record.unreachableAt === 'number') {
            identities.upsert({
              sessionId: record.sessionId,
              groupId: record.groupId,
              personId: record.personId,
              personKey: record.personKey,
              reachable: true,
            });
            void identities.flush?.();
          }
          // And refresh the roster when what we hold has gone stale.
          //
          // `group/touch` proves the instance is alive; it does not tell us who else is. Without this the member list
          // and every presence dot came from the last explicit `a2a_group_summary`, which could be hours old — reported
          // as "every member shows offline" while the host reported all three online. Refreshing only when already
          // stale keeps the cost to roughly one extra call per group per staleness window, not per tick.
          const rosterAge = Number.isFinite(record.rosterCachedAt) ? clock() - record.rosterCachedAt : Infinity;
          if (rosterAge > ROSTER_STALE_MS) {
            try {
              const info = await bridge.send(
                {
                  baseUrl: record.baseUrl,
                  apiKey: record.apiKey ?? settings.client.apiKey,
                  forwardProto: settings.client.forwardProto,
                  protocolVersion: settings.client.protocolVersion,
                },
                {
                  skill: 'group/info',
                  text: 'info',
                  data: { groupId: record.groupId, personId: record.personId, personKey: record.personKey },
                  timeoutMs: settings.client.timeoutMs,
                },
              );
              const snapshot = info?.data;
              if (snapshot !== undefined && snapshot !== null) {
                identities.upsert({
                  sessionId: record.sessionId,
                  groupId: record.groupId,
                  personId: record.personId,
                  personKey: record.personKey,
                  groupName: typeof snapshot.name === 'string' ? snapshot.name : undefined,
                  groupTopic: typeof snapshot.topic === 'string' ? snapshot.topic : undefined,
                  memberCount: Number.isFinite(snapshot.memberCount) ? snapshot.memberCount : undefined,
                  onlineCount: Number.isFinite(snapshot.onlineCount) ? snapshot.onlineCount : undefined,
                  // Same rule as everywhere else: keep the timestamp, drop the claim about now.
                  members: Array.isArray(snapshot.members)
                    ? snapshot.members.map((member) => ({
                      personId: member.personId,
                      displayName: member.displayName,
                      role: member.role,
                      lastSeenAt: Number.isFinite(member.lastSeenAt) ? member.lastSeenAt : undefined,
                      clientVersion: typeof member.clientVersion === 'string' ? member.clientVersion : undefined,
                      roleAbout: member.roleAbout,
                      tags: Array.isArray(member.tags) ? member.tags : undefined,
                    }))
                    : undefined,
                  rosterCachedAt: clock(),
                });
                void identities.flush?.();
              }
            } catch {
              // A failed refresh leaves the old roster in place and the age keeps the panel honest about it.
            }
          }
        })
        .catch((error) => {
          // An unreachable host must not produce a log line every fifty seconds for every group. But it MUST record
          // that the credential was refused, or the panel keeps presenting a stale roster as current — observed as
          // "every member shows offline" while the host reported all three online: the instance's credential had been
          // retired by a rejoin elsewhere, nothing was marked, and its cache sat at 229 minutes old with no signal.
          const code = typeof error?.data === 'string' ? error.data : (typeof error?.code === 'string' ? error.code : '');
          if (code !== 'not_member' && code !== 'unknown_group') return;
          identities.upsert({
            sessionId: record.sessionId,
            groupId: record.groupId,
            personId: record.personId,
            personKey: record.personKey,
            unreachableAt: Date.now(),
          });
          void identities.flush?.();
        });
    }
  };
  if (settings.groups.enabled === true) {
    presenceTimer = setInterval(presenceHeartbeat, PRESENCE_TICK_MS);
    presenceTimer.unref?.();
    // One immediate tick: a freshly started instance should appear online at once, not up to 50s later.
    presenceHeartbeat();
  }

  // A clean shutdown says goodbye. A killed process cannot, which is why the online window remains the backstop —
  // but when we do get the chance to speak, colleagues should not have to wait two minutes to learn we left.
  ctx.on('dispose', () => {
    if (presenceTimer !== undefined) clearInterval(presenceTimer);
    if (settings.groups.enabled !== true) return;
    for (const record of identities.remoteMemberships()) {
      void bridge
        .send(
          {
            baseUrl: record.baseUrl,
            apiKey: record.apiKey ?? settings.client.apiKey,
            forwardProto: settings.client.forwardProto,
            protocolVersion: settings.client.protocolVersion,
          },
          {
            skill: 'group/away',
            text: 'away',
            data: { groupId: record.groupId, personId: record.personId, personKey: record.personKey },
            timeoutMs: 2000,
          },
        )
        .catch(() => {
          // Disposal must never fail on a network error: the process is already going away.
        });
    }
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