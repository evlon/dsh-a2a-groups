#!/usr/bin/env node
// Inspect the agent card the gateway serves, without any shell quoting games.
//
//   node probe-card.mjs [gatewayBase] [agent] [apiKey]
//
// Prints the URL fields the gateway rewrote, so a caller can tell whether it
// should reach the agent through the gateway or (wrongly) direct at the upstream.

const base = process.argv[2] ?? 'http://127.0.0.1:3000';
const agent = process.argv[3] ?? 'mock-a2a';
const key = process.argv[4] ?? (process.env.A2A_KEY ?? 'dev-caller-key-not-a-secret');
const scheme = process.env.X_FORWARDED_PROTO;

const url = `${base}/a2a/${agent}/.well-known/agent-card.json`;
const headers = { 'x-api-key': key };
if (scheme !== undefined) headers['x-forwarded-proto'] = scheme;

const res = await fetch(url, { headers });
const text = await res.text();
console.log(`status: ${res.status}`);
if (!res.ok) {
  console.log(text.slice(0, 400));
  process.exit(1);
}
const card = JSON.parse(text);
console.log(`name:              ${card.name}`);
console.log(`url:               ${card.url}`);
console.log(`protocolVersion:   ${card.protocolVersion}`);
const interfaces = card.supportedInterfaces ?? card.additionalInterfaces ?? [];
console.log(`interfaces:        ${JSON.stringify(interfaces)}`);
console.log(`skills:            ${(card.skills ?? []).map((skill) => skill.id).join(', ')}`);
console.log(`X-Forwarded-Proto: ${scheme ?? '(absent)'}`);
