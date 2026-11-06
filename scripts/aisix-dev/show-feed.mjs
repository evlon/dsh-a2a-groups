#!/usr/bin/env node
// Show what the tests actually wrote into the group host.
//
// Reads groups.json directly rather than going through the API: the point is to
// show the durable artefact a test leaves behind, not a view the API chose to
// render. Feed entries are printed verbatim, so a probe's wording is visible.
//
//   node scripts/aisix-dev/show-feed.mjs [--limit N] [--groups-only]
import { readFileSync } from 'node:fs';

// The group store's groups.json, driven by env rather than a hard-coded home: a path that works on one machine is a
// trap on every other. Default to the standalone host's temp data dir; point GROUPS_FILE at a member instance's
// <DSH_HOME>/a2a/groups.json to read that instead.
const file = process.env.GROUPS_FILE
  ?? (process.env.AGENT_GROUPS_DATA ? `${process.env.AGENT_GROUPS_DATA}/groups.json` : undefined)
  ?? 'groups.json';
const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 8;
const groupsOnly = args.includes('--groups-only');

const state = JSON.parse(readFileSync(file, 'utf8'));
const groups = state.groups ?? [];
console.log(`groups.json: ${groups.length} group(s)\n`);

for (const group of groups) {
  const visibility = group.settings?.visibility ?? 'public';
  console.log(`── ${group.name}  (${group.groupId}, ${group.members.length} member(s), ${visibility})`);
  for (const member of group.members) {
    const tags = member.tags?.length ? ` tags=${JSON.stringify(member.tags)}` : '';
    const about = member.roleAbout ? ` about="${member.roleAbout}"` : '';
    console.log(`   · ${member.displayName} [${member.role}]${about}${tags}`);
  }
  if (!groupsOnly) {
    const feed = group.feed ?? [];
    const shown = feed.slice(-limit);
    if (feed.length > shown.length) console.log(`   … ${feed.length - shown.length} earlier entries`);
    for (const entry of shown) {
      const when = new Date(entry.at).toISOString().slice(11, 19);
      const from = entry.from?.displayName ?? '?';
      const tag = entry.kind === 'system' ? ' [system]' : '';
      console.log(`   #${entry.seq} ${when} ${from}${tag}: ${entry.text}`);
    }
  }
  console.log('');
}
