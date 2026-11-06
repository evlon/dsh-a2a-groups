# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## Where the code is

The repository root holds one package, `dsh-a2a/` (npm package `dsh-a2a-groups`) — three
things in one package:

1. a Cordis plugin for DSH that lets a Session join collaboration groups;
2. a standalone group host (`bin/agent-groups.js`, zero-dependency Node, no DSH);
3. an MCP stdio server (`lib/mcp-server.js`) so CodeBuddy / Claude Code / Cursor can use the same tools.

`dsh-session-bus/` alongside is a SEPARATE repository (gitignored), not part of this tree.
Run every command from inside `dsh-a2a/`.

## Branches

Three long-lived branches, each with one job:

| Branch | Job | When to commit here |
|---|---|---|
| `master` | main development line (ahead toward 0.2.x) | everyday work, fixes, small features |
| `v0.1.x` | **bugfix-only** maintenance for the 0.1.x line | a fix for a shipped 0.1.x bug |
| `v0.2.x` | **refactor + new features** toward 0.2.x | breaking changes, new capability |

Rules:

- A **bug fix** goes to `v0.1.x` first (cherry-pick back), then forward to `master`.
- A **refactor or new feature** goes to `v0.2.x` (or `master`), never to `v0.1.x`.
- `v0.1.x` must stay releasable: no breaking changes, no new tools that change the contract.
- A `v0.1.x` release is a patch/minor bump off that branch; a `v0.2.x` release comes from `master`/`v0.2.x`.


- Node >= 22, ESM (`"type": "module"`), no build step, **no runtime or dev dependencies**
  (only `vitest`, `typescript`, `@types/node` as devDependencies).
- Package entry `lib/index.js`; MCP entry `lib/mcp-server.js`; host entry `bin/agent-groups.js`.
- The bundle patch is `cordis.patch.yml` (wired via `package.json` → `dsh.bundle.patch`).

## Commands

```powershell
cd dsh-a2a
node node_modules/vitest/vitest.mjs run --no-file-parallelism   # full suite (~750 tests)
node node_modules/vitest/vitest.mjs run test/groups.test.slow.mjs   # one file
node scripts/mcp-probe.mjs                                      # MCP stdio end-to-end
```

Use the vitest runner above, not `npm test` — `npm test` runs `vitest run` which can hit
`--no-file-parallelism` memory issues on this machine under concurrent files.

## Directory boundary: one sentence

- `lib/core/` — zero-DSH group state machine, reusable by any host. **No `ctx` here.**
- `lib/shared/` — `tool-specs.js` (27 tools' name/description/schema/render, pure data) +
  `tool-runtime.js` (execution bodies). DSH and MCP consume the SAME specs, so a tool
  behaves identically in both hosts.
- `lib/dsh/` — the only place that reads `ctx` (tools adapter, inbox delivery, panel).
- `lib/mcp/` — the only place that reads MCP protocol (`mcp-deps.js`).
- `lib/index.js` — DSH plugin entry; `lib/mcp-server.js` — MCP entry.
- `bin/agent-groups.js` — standalone host (zero-dependency Node program, NOT a DSH instance).

Self-check (should return nothing except `lib/dsh/` and `lib/index.js`):

```bash
grep -rn '\bctx\b' lib/ --include='*.js' | grep -v '^lib/dsh/' | grep -v '^lib/index.js'
```

## Cross-cutting conventions

- **Self-contained imports.** Only `node:*` and relative paths. No `@deepseek-ai/*` outside
  `lib/dsh/`; profile/workspace plugins are loaded by plain Node resolution.
- **Spec ↔ runtime 1:1.** Every tool in `tool-specs.js` must have a body in `tool-runtime.js`
  and vice versa (guarded by `test/tool-rename-guard.test.mjs`). A rename that touches one and
  not the other leaves a tool that throws `unknown tool` on first call.
- **Feed field parity.** `publicEntry` in `groups.js` publishes fields; `group/read` and the
  panel must forward every one. This has broken five times — `test/feed-field-parity.test.mjs`
  guards it structurally.
- **Errors are codes, not prose.** Callers branch on stable codes (`GroupError#code`,
  `A2aClientError#kind`). A remote call wraps the JSON-RPC sub-code in `error.data`, not
  `error.code` — the stub in `test/tool-coverage.test.slow.mjs` reproduces this on purpose.
- **A remote group's authority lives on the HOST.** Group tools branch on
  `membership.local !== true` and send a skill over the bridge (`group/post`, `group/requests`,
  …); `requireLocalMembership` is ONLY for things that genuinely require local hosting.
- **Presence is computed, not stored.** `lastSeenAt` is a fact; `online` is derived at read
  time. Never cache the boolean.
- **Credentials never leave the store.** Public views (`snapshot`, `members`, `read`) carry no
  `keyHash`/`tokenHash`; `personKey` is shown exactly once at issuance.

## Tool surface (27 tools, same in DSH and MCP)

`a2a_agents` `a2a_discover` `a2a_send` `a2a_stream` · `a2a_person_send` `a2a_person_inbox`
`a2a_person_ack` · `a2a_inbox_check` `a2a_self_check` `a2a_group_wait` · `a2a_group_create`
`a2a_group_invite` `a2a_group_join` `a2a_group_leave` · `a2a_group_post` `a2a_group_read`
`a2a_group_summary` `a2a_group_set_card` `a2a_groups` · `a2a_group_directory`
`a2a_group_request` `a2a_group_approvals` `a2a_group_decide` `a2a_group_claim` ·
`a2a_group_kick` `a2a_group_rename` `a2a_group_archive`.

MCP hides exactly two (`a2a_serve`, `a2a_group_inbox`) — they dereference DSH-only services.
MCP has no push channel; `a2a_inbox_check` + `a2a_group_wait` (long-poll) are how a client
stays current.

## Identity red line (MCP)

One `AGENT_GROUPS_DATA` directory = one person. The gateway token is shared; `personId` +
`personKey` (in `memberships.json`, 0600) are the identity. Never point MCP's
`AGENT_GROUPS_DATA` at the host's data dir or a DSH plugin's `a2a` dir. See `docs/MCP.md`.

## Key design decisions (do not regress)

- **No group password.** Admission is invite-link or request/approve; an existing member who
  moved working directories re-adopts their identity with their own credential (no second row).
- **Group posts grade who gets woken**: `@me` / `@all` wake, ordinary posts only raise unread.
- **`replyTo` vs `rootSeq`**: the former is who you answered, the latter which conversation.
- **Last-member leave is refused** (`last_member`): a group with nobody left to administer it
  is stranded. `join` still promotes into a stale ownerless group (dangling `ownerPersonId`).

## Test conventions

Fast tests are `*.test.mjs` (pure memory), slow are `*.test.slow.mjs` (real HTTP/disk). Each
slow file owns its own temp dir and port. When adding behavior, cover happy + refusal paths
and assert the refusal produced no side effect. Structural guards (`tool-rename-guard`,
`feed-field-parity`, `client-syntax`) exist because silent drift is the failure mode.
