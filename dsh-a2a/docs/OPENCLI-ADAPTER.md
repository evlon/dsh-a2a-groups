# DSH Web adapter for opencli

An opencli adapter that drives the DSH Web UI the way a person does — type into the composer, press Enter, read what
appears — so a test can prove the user's path works, not just that the code was written.

**Location:** `~/.opencli/clis/dsh/`

```
_ops.js    shared selectors, navigation, typing, transcript reading
open.js    open an instance by port
read.js    read the visible conversation
send.js    type a message and send it
```

---

## Why this exists

Verifying this project kept failing in the same way: a change was confirmed by unit tests and by inspecting code, and
then broke the first time a person used it. Two examples from the project's own history:

- A button filled the composer with an instruction the backend rejected with `invite_invalid`. The panel looked right
  and the backend looked right; the path between them was broken. Reading either side could never find it.
- A panel stopped re-rendering after a new message, because the change signature did not include the field that moves.
  The data was correct the whole time; only the screen was wrong.

Both are invisible to unit tests and obvious to a click. This adapter exists so that click can be automated.

---

## Commands

### `open` — open an instance by port

```bash
opencli dsh open --port 3096 --home C:\Users\niukl\.dsh-a2a-dev3 -f json
```

```json
[{ "url": "http://127.0.0.1:3096/", "ready": true }]
```

Addressing an instance **by port** rather than by URL is deliberate: each instance prints a URL with a one-time token
that changes on every restart, so a pasted URL makes tests unmaintainable. `--home` points at the instance's
`DSH_HOME`, and the token is read from its `out.log`.

Use `--path /join` to open the join page instead of the app shell.

### `read` — read the visible conversation

```bash
opencli dsh read --last 5 -f json
opencli dsh read --contains "已发送（seq 144）" --timeout 30 -f json
```

```json
[{ "index": 1, "text": "我认为最重要的盲点：…" }]
```

`--contains` is the important form: it asks the question a test actually has — *did this text become visible?* — in one
round trip, and reports absence explicitly instead of returning an empty table, which would read like "no messages".

### `send` — type and send

```bash
opencli dsh send --text "请回复两个字：收到" --timeout 90 -f json
```

```json
[{ "sent": true, "via": "enter", "typed": "请回复两个字：收到", "replied": true, "settled": true, "grew": 2 }]
```

`--port` is optional; omit it inside a test that already ran `open`, and the command uses the page that is open.

---

## A minimal test

```bash
opencli dsh open --port 3096 --home "$DSH_HOME"
opencli dsh send --text "用 a2a_group_join 重新加入「发票与对账平台」" --timeout 180
opencli dsh read --contains "已加入" --timeout 30
```

The third command is the assertion. It fails when the instruction was sent but the outcome never appeared — which is
exactly the bug class this adapter was built for.

---

## Findings that shape the implementation

Each of these cost a debugging round; none could be guessed.

### 1. The token URL renders its own 401 page

`GET /?token=…` answers **303 → `/`** with `Set-Cookie: dsh-auth-…; HttpOnly; SameSite=Strict`. The cookie therefore
arrives after the document for that first response was produced, and the page shows 「dsh web authentication
required」 even though every same-origin request from it now succeeds. Measured directly: an in-page XHR to `/` returned
**200** while the visible document still said authentication required.

**One reload fixes it.** `ensureOnInstance` navigates, checks whether the page authenticated, and reloads if not.

### 2. `<main>` does not exist

The shell is `<div class="_frame">` → `_sidebarCol` + `_centerCol` → `_root` → `header` + `_body` → `_scrollBody`.
Selectors keyed on `main`, `[data-message-id]` or `[data-testid]` match nothing, and the command reports "no visible
text" on a page showing a full conversation.

### 3. There are 37 elements whose class contains `_body`

Most are empty layout shells. Taking `querySelector` for that substring works only by document order, so the code
picks the **widest populated** one, and prefers `_scrollBody` when present.

### 4. Reading the center column returns the composer, not the conversation

The first working version returned the placeholder 「发消息或创建任务…」 and the model name as if they were messages,
because `_centerCol` includes the header and the composer. `_scrollBody` is the narrowest region holding only messages.

### 5. A message block has several children, so "leaf-ish only" excluded every message

`children.length > 3` was meant to avoid duplication. It filtered out every real message and kept the small widgets.
The correct rule is: skip a block **only if it contains another block we will visit anyway**.

### 6. `textContent`, `execCommand('insertText')` and synthetic events all fail here

The DOM accepted the text and the send did nothing, because the framework never saw a trusted input. `page.fillText`
— the bridge's own implementation, the same one `opencli browser fill` uses — works:

```
filled: true, verified: true
```

with a scripted write the box held the text but the send never fired.

### 7. Do not wait on a "busy" flag

The stop control appears only while tokens stream, so a slow model start looks idle. `settled` came back `false` on a
message that had already been delivered and answered. Waiting on **the transcript growing** is direct evidence; the
busy check is now only used to let the answer finish, bounded and best-effort.

### 8. `fillText` only works on a focused box

It returned without error and `send` reported `sent: true` — on a message that was never typed. The box was empty, the
send button stayed disabled, and the transcript never grew. Measured:

```
click-ok | fill-ok | value="PROBE-AFTER-FOCUS"     <- after page.click first
```

`writeComposer` now clicks the composer and pauses before filling.

### 9. `fillText` does not replace existing text

With something already in the box, the new text is NOT written: the old content stays, the send button stays enabled
for the OLD text, and a second `send` in the same test silently re-sends the first message — the transcript still grows,
so the test passes while measuring the wrong thing.

```
before="PROBE-AFTER-FOCUS" | sel-all-ok | del-ok | afterClear="" | afterFill="CLEAR-TEST"
```

`Control+a` then `Delete` before the fill, with a pause after each step (without the pauses the keys arrive before focus
takes effect and the clear silently does nothing).

### 10. Enter does not send, and `pressKey` does not report that

`await page.pressKey('Enter')` resolves successfully while the composer keeps its text. `pressSend` returned `ok: true`
on that basis, so `send` reported `sent: true, replied: false` and the conclusion drawn was "the model did not answer".

The fix is to verify the only observable proof — the box emptying — and fall back to the send button:

```
press Enter -> composer still has text -> click the button -> composer empty
```

`send` now reports `composerAfter`, so this failure mode names itself instead of looking like a silent model.

### 11. The transcript reader was reading chips, tables and tool summaries as messages

Entries arrived as one per table cell (「快照层」/「行号、计数、SHA1」), one per terminal-code line, the model picker, the
token counter, and collapsed tool records (「执行了命令思考…运行命令…思考…」). `--contains` then passed or failed for
reasons unrelated to the conversation.

`_flowItem` is used for BOTH message bodies and one-line status chips, so position cannot separate them. The reader now:

- locates the container by measurement (the element with the most text-bearing direct children under `_viewArea`),
  never by `div[class*="_root"]` — the FIRST `_root` on the page is the SIDEBAR, and reading it returned
  「新会话 | 插件 | 自动化任务 | 协作群」
- drops status chips (「已完成，用时 18秒」), usage lines (「用量 254K tok」), inbound-task notices, the model picker, and
  process records — the last by matching 执行了命令 together with 思考 or 运行命令, because those blocks run to hundreds of
  characters and a length bound lets every one through

---

## Rules for editing these files

**Never put a backtick in a comment inside the `page.evaluate` template strings.** The script is a template literal; a
backtick in a comment closes it early and the module fails with `missing ) after argument list` — with the message
pointing at the wrong line. This happened twice while writing this adapter.

**Every wait must be bounded.** An unbounded wait turns a broken selector into a hung test, which is worse than a
failure because nobody sees it.

**Key off semantics, not hashed classes.** `_scrollBody` is matched as a class *suffix* so a rebuild that changes the
hash does not silently break the selector.

**Restart the daemon after editing.** `opencli daemon restart` — the adapter modules are loaded once.
