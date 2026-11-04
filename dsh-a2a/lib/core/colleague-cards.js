/**
 * Aggregate cached rosters into colleague cards.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * It was written inline in `index.js`, where it could only be exercised by mounting the whole
 * plugin. It is a pure function over data — rosters in, cards out — and the questions worth
 * testing ("does one person in two groups become two cards?", "does an absent role stay
 * absent?") have nothing to do with the DSH runtime. Moving it also puts it in `core/`, which
 * is where the boundary says pure logic belongs.
 *
 * WHAT A CARD IS
 *
 * A person's own description, collected across every group this instance shares with them:
 *
 *   name      the display name they use
 *   headline  the first role they declared, in group order
 *   tags      every tag they declared, deduplicated
 *   roles     all their declared roles, because layer A is per-group
 *   groups    which of MY groups they are in — a fact the server verified
 *   online    whether any roster saw them recently
 *   isSelf    whether this is the reader's own card, which is the only editable one
 *
 * WHAT IT REFUSES TO DO
 *
 * Invent identity. A tag is self-declared, so a card says "tags", never "department": one
 * person writing 测试 in one small group does not make them the tester, it makes them
 * somebody who once took the testing role there. An absent role stays empty rather than
 * becoming "member", because a placeholder reads as knowledge.
 *
 * @module dsh-a2a/colleague-cards
 */

/** Most cards one snapshot may carry, so a large host cannot inflate every page render. */
const MAX_CARDS = 100;

/** Most tags per card. A person with forty tags has a data problem, not a profile. */
const MAX_TAGS = 8;

/** Most roles per card, for the same reason. */
const MAX_ROLES = 4;

/** Most groups named per card. */
const MAX_GROUPS = 20;

/**
 * Build cards from membership records.
 *
 * @param {object[]} records - membership records, each possibly carrying a cached `members` roster.
 * @returns {object[]} cards, most-connected first.
 */
export function aggregateColleagueCards(records) {
  if (!Array.isArray(records)) return [];

  /** personId (or `name:<display>`) → accumulating card. */
  const byPerson = new Map();

  /**
   * Which roster rows are mine.
   *
   * A membership record names the member id this instance holds in that group, so the row
   * with the same id is me. Names are a fallback only for a roster that carries no ids at
   * all, because a display name is not unique.
   */
  const selfIds = new Set();
  const selfNames = new Set();
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    if (typeof record.personId === 'string' && record.personId !== '') selfIds.add(record.personId);
  }

  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    const roster = Array.isArray(record.members) ? record.members : [];
    const groupName = typeof record.groupName === 'string' && record.groupName !== ''
      ? record.groupName
      : (typeof record.groupId === 'string' ? record.groupId : '');

    for (const member of roster) {
      if (member === null || typeof member !== 'object') continue;
      const name = typeof member.displayName === 'string' ? member.displayName.trim() : '';
      // A row with no name cannot become a card: "unnamed person" is not a colleague.
      if (name === '') continue;

      const key = typeof member.personId === 'string' && member.personId !== ''
        ? member.personId
        : `name:${name}`;

      let card = byPerson.get(key);
      if (card === undefined) {
        card = {
          personId: typeof member.personId === 'string' ? member.personId : '',
          name,
          tags: [],
          roles: [],
          groups: [],
          online: false,
          // Set from the ledger's own member id, never from the name: two people can share a
          // display name, and mistaking somebody else's row for mine would offer an edit that
          // changes the wrong person's profile.
          isSelf: selfIds.has(member.personId) || (typeof member.personId !== 'string' && selfNames.has(name)),
        };
        byPerson.set(key, card);
      }

      // Any sighting counts: rosters are fetched at different times, and a person seen
      // online in one group is online.
      if (member.online === true) card.online = true;

      // Layer A is per-group, so the card keeps the union rather than picking one answer.
      const about = typeof member.roleAbout === 'string' ? member.roleAbout.trim() : '';
      if (about !== '' && !card.roles.includes(about)) card.roles.push(about);

      for (const tag of Array.isArray(member.tags) ? member.tags : []) {
        if (typeof tag === 'string' && tag !== '' && !card.tags.includes(tag)) card.tags.push(tag);
      }

      if (groupName !== '' && !card.groups.includes(groupName)) card.groups.push(groupName);

      // A roster row that carries my member id confirms which card is mine. Doing it here
      // rather than only at creation also covers the case where the first roster seen for a
      // group arrived without ids.
      if (selfIds.has(member.personId)) card.isSelf = true;
    }
  }

  const cards = [...byPerson.values()].map((card) => ({
    personId: card.personId,
    name: card.name,
    isSelf: card.isSelf === true,
    // The first role they declared. Empty when they never declared one — deliberately not a
    // placeholder, because a placeholder reads as knowledge.
    headline: card.roles[0] ?? '',
    tags: card.tags.slice(0, MAX_TAGS),
    roles: card.roles.slice(0, MAX_ROLES),
    groups: card.groups.slice(0, MAX_GROUPS),
    online: card.online,
  }));

  // Mine first, always. Every other card is read-only; mine is the one I own, and the
  // question "what do others see when they look at me" comes before "who else is around".
  // After that, most connected first — somebody in three of my groups is a likelier target
  // than somebody I share one group with — with alphabetical ties so the order is stable.
  cards.sort((left, right) => Number(right.isSelf) - Number(left.isSelf)
    || right.groups.length - left.groups.length
    || left.name.localeCompare(right.name));

  return cards.slice(0, MAX_CARDS);
}
