/**
 * Layer B: the outward-facing profile, aggregated from group memberships.
 *
 * The whole point is that nobody maintains this. A person joins groups, says what
 * they do in each one (layer A), and their card — what any peer reads when it runs
 * `a2a_discover` — reflects that automatically. Asking people to fill in a profile
 * form would produce stale text within a month; aggregating from memberships
 * cannot go stale, because it is derived at read time.
 *
 * Two inputs, both already on disk:
 *
 *   - `groups.js` knows, for each group this instance hosts, what a member said
 *     about themselves (`roleAbout` / `tags`).
 *   - `memberships.js` knows which groups this instance belongs to, with which
 *     credential, and whether each is local.
 *
 * This module is the join of those two, plus the rule that turns them into prose.
 * It has no I/O of its own: the caller passes the stores in.
 *
 * @module dsh-a2a/profile
 */

/** How many roles to name in the auto-generated one-liner before summarising. */
const HEADLINE_LIMIT = 3;

/**
 * Build this instance's profile from its memberships.
 *
 * Deterministic and side-effect free, so it can be called on every card read
 * without cost or surprise: a card is fetched on every `a2a_discover`, and a
 * profile that did I/O would make discovery slow and failure-prone.
 *
 * @param {object} input - sources.
 * @param {object} input.identities - the membership ledger.
 * @param {object} input.store - the group store (for hosted groups' roles).
 * @param {object} [input.config] - normalized config, for explicit overrides.
 * @returns {{name: string|undefined, headline: string|undefined, groups: object[], tags: string[]}} the profile.
 */
export function buildProfile({ identities, store, config } = {}) {
  const records = typeof identities?.list === 'function' ? identities.list() : [];
  const groups = [];
  /** tag → how many groups declared it. */
  const tagCounts = new Map();
  /** displayName → how many groups use it. */
  const nameCounts = new Map();

  for (const record of records) {
    const groupId = record.groupId;
    if (typeof groupId !== 'string' || groupId === '') continue;

    // What this instance said about itself in THAT group. For a hosted group the
    // store is authoritative; for a joined one only the ledger knows, and it
    // carries no role detail, so `about` stays empty rather than being invented.
    const own = ownMembership(store, groupId, record.personId);
    groups.push({
      groupId,
      groupName: own?.groupName ?? record.groupName ?? groupId,
      roleAbout: own?.roleAbout ?? '',
      tags: own?.tags ?? [],
      // The permission bit, carried for completeness: a peer may care whether it
      // is talking to a group owner, and that is a different fact from the role.
      permission: own?.role ?? record.role ?? 'member',
      local: record.local === true,
    });

    for (const tag of own?.tags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    const display = own?.displayName;
    if (typeof display === 'string' && display !== '') {
      nameCounts.set(display, (nameCounts.get(display) ?? 0) + 1);
    }
  }

  // Most-used tag first; ties broken by the tag itself for a stable order, so two
  // reads of an unchanged instance produce byte-identical cards.
  const tags = [...tagCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([tag]) => tag);

  const name = pickName({ config, nameCounts, groups });
  const headline = pickHeadline({ config, tags, groups });

  return { name, headline, groups, tags };
}

/**
 * Placeholder display names that should never become an identity.
 *
 * These are the values a *tool* fills in when a human did not name themselves:
 * `owner` and `member` are the store's own defaults, `群主`/`成员` are its Chinese
 * renderings, and `member-3` is the shape the card client generates. Letting one
 * of them win the "most common name" vote would put "owner" on the agent card,
 * which reads as a bug to every peer that sees it.
 */
const PLACEHOLDER_NAMES = new Set([
  'owner', 'member', 'me', 'self', 'user',
  '群主', '成员', '我', '未知',
]);

/** Whether a display name carries no real identity. */
function isPlaceholder(name) {
  if (typeof name !== 'string') return true;
  const trimmed = name.trim();
  if (trimmed === '') return true;
  if (PLACEHOLDER_NAMES.has(trimmed.toLowerCase())) return true;
  // `member-1`, `member-12`: generated when a caller supplied no name at all.
  return /^member-\d+$/.test(trimmed);
}

/**
 * What this instance calls itself.
 *
 * An explicit `config.agent.name` always wins — an operator may want a stable
 * identity that does not shift when they join another group. Otherwise the most
 * common REAL display name across memberships is used. Placeholder names are
 * skipped: a card that says "owner" tells a peer nothing and looks broken.
 *
 * @returns {string|undefined} the name, or undefined when nothing real is known.
 */
function pickName({ config, nameCounts, groups }) {
  const configured = typeof config?.agent?.name === 'string' ? config.agent.name.trim() : '';
  if (configured !== '') return configured;
  const ranked = [...nameCounts.entries()]
    .filter(([name]) => !isPlaceholder(name))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (ranked.length > 0) return ranked[0][0];
  return groups.length > 0 ? undefined : undefined;
}

/**
 * One line describing what this instance does, for the card's `description`.
 *
 * Three cases, in order of how much is known:
 *   1. an explicit `config.agent.description` — the operator's own words;
 *   2. tags exist — name the busiest ones ("主要角色：产品、研发");
 *   3. nothing declared yet — say plainly that this is a DSH instance, rather
 *      than emitting an empty string a peer would render as a blank field.
 */
function pickHeadline({ config, tags, groups }) {
  const configured = typeof config?.agent?.description === 'string' ? config.agent.description.trim() : '';
  if (configured !== '') return configured;
  if (tags.length > 0) {
    const named = tags.slice(0, HEADLINE_LIMIT).join('、');
    const extra = tags.length > HEADLINE_LIMIT ? ` 等 ${tags.length} 类` : '';
    return `在 ${groups.length} 个协作群里，主要角色：${named}${extra}`;
  }
  if (groups.length > 0) {
    return `在 ${groups.length} 个协作群里，尚未声明角色`;
  }
  return undefined;
}

/**
 * This instance's own membership in one group, from the group store when hosted.
 *
 * Returns `undefined` for a joined group: the ledger records that the membership
 * exists, not what was declared there. Reading the host's member list to fill that
 * in would mean a network call inside card rendering — the opposite of what the
 * card is for.
 */
function ownMembership(store, groupId, personId) {
  if (typeof store?.has !== 'function' || store.has(groupId) !== true) return undefined;
  if (typeof personId !== 'string' || personId === '') return undefined;
  try {
    // `snapshot` is anonymous by design; the self-view needs the credential, which
    // this module deliberately does not hold. `memberView` (added for exactly this)
    // answers "what does the store know about member X" without one.
    if (typeof store.memberView === 'function') return store.memberView({ groupId, personId });
    return undefined;
  } catch {
    // A store that cannot answer must not break the card; the group just shows no
    // declared role.
    return undefined;
  }
}

/**
 * The card's extension field carrying the per-group profile.
 *
 * Prefix `x-` follows the JSON Schema convention for vendor extensions, and A2A
 * gateways (AISIX included) preserve unknown card fields verbatim, so a peer that
 * does not understand this simply ignores it.
 *
 * @param {object} profile - the value from {@link buildProfile}.
 * @returns {object|undefined} the field, or undefined when there is nothing to say.
 */
export function profileField(profile) {
  if (profile === undefined || profile === null) return undefined;
  if (!Array.isArray(profile.groups) || profile.groups.length === 0) return undefined;
  const entries = { groups: profile.groups };
  if (typeof profile.headline === 'string' && profile.headline !== '') entries.headline = profile.headline;
  if (Array.isArray(profile.tags) && profile.tags.length > 0) entries.tags = profile.tags;
  return entries;
}
