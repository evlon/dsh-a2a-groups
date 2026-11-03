# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## Where the code is

The repository root holds one package, `dsh-session-bus/` — a Cordis plugin for DSH
(DeepSeek Harness) that pushes messages between Sessions and wakes the receiver. Run every
command from inside `dsh-session-bus/`.

- Node >= 22, ESM (`"type": "module"`), no build step, **no runtime or dev dependencies**.
- Package entry `lib/index.js`; the bundle patch is `cordis.patch.yml` (wired via
  `package.json` → `dsh.bundle.patch`).

## Commands

```powershell
cd dsh-session-bus
npm test                                   # 162 tests, listed file by file
node --test test/threads.test.mjs          # one file
node --test --test-name-pattern "hop" test/bus.test.mjs   # one test by name
```

Use `npm test`, not `node --test test/`: on Node 24 the directory form fails with
`MODULE_NOT_FOUND`. Adding a test file means adding it to the `test` script in
`package.json` — the glob is not picked up automatically.

```powershell
pwsh -NoProfile -File scripts/install.ps1                    # copy into the DSH profile (hot-reloaded)
pwsh -NoProfile -File scripts/install.ps1 -Mode path         # mount this source tree directly
pwsh -NoProfile -File scripts/install.ps1 -Mode copy -Suffix 2   # force a fresh ES module after edits
pwsh -NoProfile -File scripts/install.ps1 -Mode bundle       # visible on the Plugins page (needs restart)
pwsh -NoProfile -File scripts/install.ps1 -Uninstall
```

Node caches an ES module by resolved path, so edits to `lib/` only take effect in a running
Host after a new `-Suffix` directory or a DSH restart.

Publishing is release-driven: creating a GitHub Release runs `.github/workflows/publish.yml`
(tests, then `npm publish --provenance` via OIDC trusted publishing — there is no npm token).
CI (`test.yml`) runs `npm test` on windows-latest for Node 22 and 24.

## Architecture

Layers, outermost first:

| File | Role |
| --- | --- |
| `lib/index.js` | Cordis entry: `name`, `inject: ['tools','sessionController']`, `apply()` wires bus → event hook → tools → prompt section |
| `lib/tools.js` | The twelve `bus_*` tool definitions: raw JSON Schema in/out, plus per-tool text renderers |
| `lib/bus.js` | `SessionBus`: host I/O, target resolution, delivery pipeline, permission elevation, persistence, audit |
| `lib/coordination.js` | `RoleRegistry`, `TaskLedger`, `AttentionLedger` (v0.8 main/dev model) |
| `lib/leases.js` | `LeaseLedger`: path-prefix write claims with TTL and overlap detection |
| `lib/envelope.js` | Wire format: render/parse `[session-bus v1] …` header + `--- message ---` / `--- reply ---` sections |
| `lib/resolve.js` | Pure target/workspace resolution, strictly ordered rungs, ambiguity is a failure |
| `lib/config.js` | `DEFAULT_CONFIG` and `normalizeConfig()` (every malformed value falls back, never throws) |
| `lib/toolkit.js` | Dependency-free `defineTool`: argument validation + output projection |
| `lib/prompt.js` | The system-prompt section injected into every Session (token-compressed on purpose) |

`SessionBus` is the only module that touches the host, and it does so exclusively through the
injected `ctx`: `sessionController` (`list/prompt/inspect/create`), and lazily via
`ctx.get(name)` for `workspaceRegistry`, `permissionPresets`, `sessions`, and `sessionQuery`.
Every optional service is checked for existence, and the bus degrades rather than throwing.
This is what lets the whole suite run against fake hosts with no DSH runtime.

### The delivery pipeline (`SessionBus#deliver`, lib/bus.js:1292)

Order matters and the comments state the invariants:

1. Validate and refuse with a stable `BusError` code (`no_sender`, `empty_message`,
   `self_send_disabled`, `cross_workspace_disabled`, `hop_budget_exhausted`, `invalid_payload`,
   `message_too_long`, …). A refusal is audited, performs no delivery, and leaves no permission change.
2. Normalize `payload` (JSON ≤ `maxPayloadChars`) and `attachments` (path/sha256/note, capped).
3. `ThreadLedger.next()` decides thread and hop. Hops count **hand-offs per thread**, not sends
   per Session; a new peer always starts at hop 1; `closing` bypasses the budget.
4. A reply to the peer's own message is upgraded from `queue` to `interrupt` when the kind is a
   conclusion/correction (only the unnamed default; an explicit `mode` wins).
5. `renderEnvelope()` builds the user message text; long bodies spool to
   `<DSH_HOME>/session-bus/spool/<msg>.md` with a pointer in the envelope.
6. Raise the target's permission preset to the caller's level (`targetPermission: 'delegate'`),
   then admit. If admission throws, the preset is rolled back and `delivery_failed` is raised.
7. Record the thread, debounce-persist state, append one audit line, return the receipt.

Two delivery paths, selected by `inboundPresentation`:

- `notice` (default): `agent.followup()` / `agent.steer()` / `agent.inject()` with a durable
  `agent-message` source, so the Web UI renders a left "task message received" card. This is the
  same Agent API DSH's own schedule/tool-jobs/subagent plugins use.
- `bubble`: legacy `sessionController.prompt()` with a `requestId` for idempotency.

A host lacking the Agent API falls back to `bubble` automatically; `inbox` mode without
`inject` falls back to a normal wake.

### Persistent state

All under `<DSH_HOME>/session-bus/`, versioned together at `version: 3`:

- `state.json` — threads/hops/message index, pending permission restores, leases, roles, tasks,
  attentions. Written debounced; bounded maps (threads 400, messages 1000, leases 300,
  tasks 300, attentions 200) with TTL pruning.
- `audit.jsonl` — one JSON line per deliver/reject/lease/release/permission_restore/role/task/attention.
- `spool/` — long message bodies.

Persistence is controlled by the **constructor option** `persist`, while `config.persistState`
is what `apply()` passes in. Tests must pass `persist: false` directly so they can never write
into a real `DSH_HOME`. The DSH home is captured at construction, not read fresh on every write.

### Cross-cutting conventions

- **Self-contained imports.** Only `node:*` and relative paths. `@deepseek-ai/*` resolves solely
  for plugins inside the DSH installation, and profile/workspace plugins are loaded by plain
  Node resolution — that is why `toolkit.js` and `config.js` exist instead of `defineTool` and
  `schemastery`. Do not add a dependency.
- **Schema is the contract.** The registry validates tool results with
  `additionalProperties: false` *after* the tool body has run, so `defineTool` projects each
  result down to `output.schema` before returning. When adding a field: add it to the schema,
  not just the return value.
- **Envelope parsing is backward compatible.** New header attributes are optional; a header with
  no `thread`/`re` still parses under the old semantics.
- **Errors are codes, not prose.** Callers and audits branch on `BusError#code`; keep codes stable
  and add new ones deliberately.
- **Windows is the primary target** (CI runs windows-latest). Path comparison folds case on
  `win32`, normalizes separators, and strips trailing separators; relative paths resolve against
  the calling Session's cwd.
- **`lib/prompt.js` is a token budget.** v0.8.1 cut it from ~11.2K to ~6.1K characters; it is a
  stable prompt-cache prefix, so edits should stay terse and keep every behavioral rule.

## Test conventions

Each test file stands alone with a hand-written fake host:

- `test/bus.test.mjs` — `createHost()` double + `createBus()` with injected `clock` and
  `idFactory`, asserting on the requests the host received.
- `test/plugin.test.mjs` — mounts the real plugin through `apply()` with `createFakeContext()`
  and calls every tool; `assertDeclared()` re-checks each result against `output.schema`,
  catching drift the host would reject after side effects.
- `test/presentation.test.mjs` — fakes the Agent API (`followup/steer/inject`) to pin which
  path each mode takes, including the interrupt upgrade and idempotency.
- Pure modules (`envelope`, `resolve`, `toolkit`, `config`, `leases`, `coordination`) are tested
  directly, with no host at all.

When adding behavior, cover both the happy path and the refusal path, and assert the refusal
produced no audit/delivery/permission side effect.
