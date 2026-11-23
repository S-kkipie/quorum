# Quorum — Plan 4: agent view and local artifacts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a session's view on the phone easy to read and understand:
- formatted answers;
- an expandable timeline of what Claude does, with SVG icons;
- local artifacts that open full screen;
- a plugin skill so those artifacts come out pretty.

**Architecture:**
- The mod sends each tool's input, truncated (`ToolStart.Input`), and the transcript history does the same. With that the app builds one clear row per action.
- The hub serves the machine's files through a chunked `file_read` RPC, behind a temporary link `/v/<token>/…`. The HTML is isolated by CSP sandbox.
- The `local-artifacts` skill lives inside the Quorum plugin.

**Tech Stack:** that of Plans 1–3. New app dependencies, only these: `react-markdown`, `remark-gfm` and `lucide-react`.

**Spec:** `docs/superpowers/specs/2026-11-23-quorum-agent-view-design.md`

## Global Constraints

- **Already in force:** everything from Plans 1–3 (texts in English per Task 0, public repo with no internal names, commits authored by `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`).
- **Icons:** only SVG from `lucide-react`, **never emojis**, in any text or icon of the new UI.
- **`Input` truncation:**
  - each string ≤ 2000 runes;
  - arrays ≤ 50 elements;
  - total serialized ≤ 16 KiB;
  - if the total goes over, only the keys in the Task 1 table remain (each one truncated).
- **Mod output and version:** `TOOL_OUTPUT_MAX` (mod) = 8000. Plugin version `0.1.3`.
- **Viewable files:** `.html .htm .md .svg .png .jpg .jpeg .gif .webp .pdf`.
  - They get a card: a successful `Write` of any of them; a successful `Edit` or `MultiEdit` only of `.html .htm .svg`.
  - A file outside the session's base gets a card without "Open", with the text `outside the project folder`.
- **Session base:** `root` if not empty; otherwise `cwd`.
- **`/v/` links:**
  - random 128-bit token (32-character hex), TTL 6 h, tied to `{machine, base}`;
  - files ≤ 50 MiB, read in 1 MiB chunks;
  - expired or unknown token → 410 with the text `Open it again from Quorum`.
- **`/v/` headers:**
  - `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors 'self'`
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: no-store`
  - `Access-Control-Allow-Origin: *`
- **Viewer iframe:** `sandbox="allow-scripts allow-popups allow-forms allow-modals"`, never `allow-same-origin`.
- **Markdown:** `react-markdown` + `remark-gfm`, no `rehype-raw` (no raw HTML). Links with `target="_blank" rel="noopener noreferrer"`. Only `http:`, `https:` and `mailto:` URLs are allowed; anything else stays as text.
- **Status pills:**
  - `working` → "Working", blue with an animated dot;
  - `needs_you` → "Needs permission", amber;
  - `waiting` and `idle` → "Waiting for you", gray;
  - `closed` → "Closed".
- **Header:**
  - "Interrupt" visible only in `working`;
  - the ⋯ menu has "Close session", "New session here" and "View in terminal" (the last one per the current rules);
  - row 2 reads `machine · model · branch`, without the path.
- **End of turn:** the "end of turn · N tokens" row is removed.

## Review Focus

1. **A tool with a huge input** (a 2 MB `Write`, a `Bash` with a giant heredoc) → the event goes out truncated (≤ 16 KiB of `input`) and the app does not choke. Tests in Tasks 1 and 2.
2. **A path trying to leave the base** (`../../etc/passwd`, `%2e%2e/`, a symlink inside the base pointing outside) → 403 in the hub and rejection in the daemon. Tests in Tasks 3 and 4.
3. **An artifact's HTML trying to read the token or the app** (`localStorage`, `parent.document`) → it cannot: it ships with the CSP sandbox header and the iframe has no `allow-same-origin`. Header tests in Task 4 and attribute test in Task 8.
4. **Old events without `input`** (sessions from before the update, earlier history) → the row uses `summary` and stays clear, without breaking. Test in Task 6.
5. **Malicious or odd markdown** (`<script>`, `[x](javascript:alert(1))`, a 30-column table) → it does not run, the link stays as text and the table scrolls. Test in Task 5.

---

### Task 0: Translate the whole repository to English (owner request, before anything else)

The owner wants EVERYTHING in the repo in English: code comments, user-facing UI strings, error messages (API and daemon), log lines, test names and expectations, README, docs, specs, plans, scripts' output, the plugin skill and descriptions. Done in five batches (0a–0e), each its own commit with tests green. Identifiers are already English; keep them. From now on commit messages are English.

**Data values (ruling — they are stored, so they need a migration):**
- Normalized ticket statuses `por_hacer|en_curso|en_review|hecho|bloqueado` → `todo|in_progress|in_review|done|blocked`.
- Proposal statuses `pendiente|enviando|aprobada|rechazada|fallida` → `pending|sending|approved|rejected|failed`.
- Hub store migration (idempotent): rewrite `tickets.status`, `proposals.status`, `proposals.body` where `kind='status'`, and the values inside each project's connector `settings.statusMap` JSON.
- The connector status normalizer accepts the old Spanish values as aliases (so an old exec connector keeps working).
- Docs file names in Spanish are renamed to English (e.g. `docs/connectors.md`, `docs/e2e-stage1.md`); specs/plans keep their dated names but their slugs become English (`…-quorum-agent-view-design.md`, `…-quorum-plan4-agent-view.md`, etc.); update every reference.
- The skill in Task 9 is named `local-artifacts` (folder `mod/skills/local-artifacts/`).
- This plan's own Spanish UI strings (Global Constraints and tasks) are translated in batch 0e; the English versions become the binding values.

**Batches:**
- **0a Go hub** (`internal/hub/**`, `internal/proto`, `cmd/quorum-hub`): comments, API error strings, logs, tests; the status migration + aliases; `make proto` (generated TS comments follow).
- **0b Go daemon** (`internal/daemon/**`, `cmd/quorumd`): comments, RPC error strings (e.g. "la terminal está desactivada en esta máquina" → "terminal is disabled on this machine"), logs, tests. The hub and app match daemon error strings only by passing them through — check `git grep` for any string comparison across packages and update both sides.
- **0c Mod** (`mod/**`): comments, `/quorum` command output, permission dialog labels (`Permitir`/`Denegar` → `Allow`/`Deny`), deny reason (`Sin respuesta en 19 min (Quorum)` → `No answer in 19 min (Quorum)`), the recap prompt (ask for a short English phrase; non-answer filters accept English and Spanish), `ERROR_ANSWER`, plugin description; bump plugin version to `0.1.3`.
- **0d App** (`app/src/**`, `app/index.html`): every UI string and test expectation; status labels follow the new data values.
- **0e Docs & scripts** (`README.md`, `docs/**`, `scripts/**`, this plan and the agent-view spec included): translate, rename files per the ruling, fix links.

**Each batch:** `git grep -nP '[áéíóúñ¿¡]'` over the batch's paths must return nothing except intentional data (e.g. a test fixture proving Unicode handling, or the Spanish status aliases); the full relevant test suite passes; commit `chore(i18n): translate <area> to English`.

### Task 1: `ToolStart.Input` from the mod

**Files:**
- Modify: `internal/proto/proto.go` (+ `make proto`), `mod/src/events.ts`, `mod/.claude-plugin/plugin.json`
- Create: `mod/src/trim.ts`
- Test: `mod/test/trim.test.ts`, `mod/test/events.test.ts`

**Interfaces — Produces:**
- `proto.ToolStart.Input json.RawMessage "input,omitempty"`. It comes out in TS as `input?: any`.
- `trimInput(tool: string, input: unknown): Record<string, unknown>` in `mod/src/trim.ts`:
  - removes the internal keys `tool`, `tool_use_id` and `agentId`;
  - applies the truncations from Global Constraints.
- Table of keys kept when the total goes over 16 KiB:

  | Tool | Keys |
  |---|---|
  | Bash | `command`, `description` |
  | Read | `file_path`, `offset`, `limit` |
  | Write | `file_path`, `content` |
  | Edit | `file_path`, `old_string`, `new_string`, `replace_all` |
  | MultiEdit | `file_path`, `edits` |
  | Grep | `pattern`, `path`, `glob` |
  | Glob | `pattern`, `path` |
  | WebSearch | `query` |
  | WebFetch | `url`, `prompt` |
  | Skill | `skill`, `args` |
  | Agent / Task | `description`, `subagent_type`, `prompt` |
  | TodoWrite | `todos` |

  Any other tool keeps its first 8 keys.
- `tool_start` emits `{id, name, summary, input: trimInput(...)}`. `TOOL_OUTPUT_MAX` goes to 8000. The plugin goes to `0.1.3`.

- [ ] **Step 1: Failing tests.**
  - `trimInput truncates strings to 2000 runes`, including a string with emojis: it counts runes, not UTF-16 units.
  - `trimInput keeps 50 elements of an array`.
  - `trimInput of a 2 MB Write stays at ≤ 16384 bytes serialized and keeps file_path`.
  - `trimInput removes tool, tool_use_id and agentId`.
  - `tool_start carries input` (events.test).
- [ ] **Step 2:** `claude plugin test mod`. Expected: FAIL.
- [ ] **Step 3:** Implement. Run `make proto`.
- [ ] **Step 4:** `claude plugin test mod && make typecheck && go test ./internal/...`. Expected: PASS.
- [ ] **Step 5:** Commit `mod: each tool's input, truncated, in tool_start`.

### Task 2: `Input` in the transcript history (daemon)

**Files:**
- Modify: `internal/daemon/transcript/transcript.go`
- Create: `internal/daemon/transcript/trim.go`
- Test: `internal/daemon/transcript/trim_test.go`, `transcript_test.go`

**Interfaces:**
- Consumes: `proto.ToolStart.Input` (Task 1).
- Produces: `func TrimInput(tool string, input json.RawMessage) json.RawMessage`, with the same rules and the same table as the mod's `trimInput` (Task 1). `parseLine` uses it on every `tool_use`.

- [ ] **Step 1: Failing tests.**
  - `TestTrimInputMatchesModRules`: strings, arrays, a large total with the table, and runes (emojis).
  - `TestParseToolUseCarriesInput`: an `Edit` `tool_use` line produces a `ToolStart` with `Input.file_path`, `old_string` and `new_string`.
- [ ] **Step 2:** `go test ./internal/daemon/transcript/`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `go test ./internal/daemon/...`. Expected: PASS.
- [ ] **Step 5:** Commit `daemon: history carries each tool's truncated input`.

### Task 3: Daemon — `file_read` RPC

**Files:**
- Create: `internal/daemon/fileread.go`
- Modify: `internal/daemon/rpc.go` (register the method)
- Test: `internal/daemon/fileread_test.go`

**Interfaces:**
- Consumes: `rpcHandlers` and `Host` (Plan 3).
- Produces: method `file_read`.
  - Params `{path, base string; offset int64; length int}`.
  - Result `{data string (base64); size int64; eof bool}`.
- Rules:
  - `path` and `base` must be absolute.
  - Both get `filepath.EvalSymlinks`, and the resolved path must end up inside the resolved base (`filepath.Rel` without `..`).
  - It must be a regular file of ≤ 50 MiB.
  - `length` is capped at 1 MiB; a `length` ≤ 0 means 1 MiB.
  - It does not depend on herdr or on the terminal switch.
- Errors (English):
  - `"outside the project folder"`;
  - `"does not exist"`;
  - `"not a file"`;
  - `"file too large"`.

- [ ] **Step 1: Failing tests** (all in `t.TempDir()`):
  - `TestFileReadChunks`: a 2.5 MiB file is read in 3 chunks and the concatenation equals the original.
  - `TestFileReadRejectsTraversal`: `base/../secret` gives `"outside the project folder"`.
  - `TestFileReadRejectsSymlinkOut`: a symlink inside the base pointing outside is rejected.
  - `TestFileReadTooBig`: with the limit as a test variable.
  - `TestFileReadNotRegular`: a directory gives `"not a file"`.
- [ ] **Step 2:** `go test ./internal/daemon/ -run FileRead`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `go test ./internal/daemon/...`. Expected: PASS.
- [ ] **Step 5:** Commit `daemon: file_read for local artifacts`.

### Task 4: Hub — view links and `/v/`

**Files:**
- Create: `internal/hub/views.go`
- Modify: `internal/hub/appapi.go` (routes)
- Test: `internal/hub/views_test.go`

**Interfaces:**
- Consumes: `h.call(ctx, machine, "file_read", params, &out)` (Plan 3) and `s.st.Session(id)`.
- Produces:
  - `POST /api/machines/{m}/views` (device) with body `{sessionId, path}`. Responds `{url}`, with `url = "/v/" + token + "/" + rel`, where `rel` is encoded per segment.
    - Errors: nonexistent session or one from another machine → 404 `"session not found"`; `path` not absolute or outside the base → 403 `"outside the project folder"`.
    - To compare paths, use the hub's `normRoot` normalization, with case folding according to the machine's OS.
  - `GET /v/{token}/{rest...}` with no device auth:
    - Resolves `base + rest`, after `path.Clean`. If it leaves the base → 403.
    - Fetches the file through `file_read` in chunks and writes each chunk as it arrives (`http.Flusher`).
    - `Content-Type` by extension, with `text/plain; charset=utf-8` for `.md`.
    - Daemon errors: `"does not exist"` → 404; `"outside…"` → 403; machine offline → 503.
  - Tokens in an in-memory map with a sweep of expired ones. A hub restart invalidates them and gives 410.
  - Register `/v/` in the mux before `"/"`.

- [ ] **Step 1: Failing tests.** Use the fake machine with RPC from the `terminalapi_test.go` tests.
  - `TestViewLinkAndServe`: the response carries the four headers from Global Constraints, the full body of a 2-chunk file and the `.html` Content-Type.
  - `TestViewRelativeAsset`: with a token for `docs/r.html`, requesting `/v/<t>/img/a.png` resolves `base/img/a.png`.
  - `TestViewTraversal403`: `/v/<t>/../../x` and `%2e%2e` give 403.
  - `TestViewOutsideBase403`: the POST with a path outside `root` gives 403.
  - `TestViewExpired410`: with the injectable clock.
  - `TestViewNeedsNoDeviceToken`: the GET works without `Authorization` and the POST without it gives 401.
- [ ] **Step 2:** `go test ./internal/hub/ -run View`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `go test ./internal/hub/...`. Expected: PASS.
- [ ] **Step 5:** Commit `hub: /v/ links to view local artifacts`.

### Task 5: App — Markdown and icons

**Files:**
- Modify: `app/package.json` (add `react-markdown`, `remark-gfm` and `lucide-react` with `npm install`)
- Create: `app/src/components/Markdown.tsx`
- Test: `app/src/components/Markdown.test.tsx`

**Interfaces — Produces:** `<Markdown text={string} />`.
- Uses `react-markdown` + `remark-gfm` without raw HTML, with a `urlTransform` that keeps only `http`, `https` and `mailto`.
- Links carry `target="_blank" rel="noopener noreferrer"`.
- `pre` blocks carry a "Copy" button (lucide `Copy` icon; `navigator.clipboard.writeText`) and `overflow-x-auto`.
- Tables are wrapped in a `div` with `overflow-x-auto`.
- Tailwind styles for h1–h4, lists, inline `code` and quotes, within the dark zinc theme.

- [ ] **Step 1: Failing tests.**
  - `renders headings, lists and gfm tables`.
  - `does not render raw <script> or <img onerror>`: the text stays escaped and there is no `script` element.
  - `javascript: link is not a link`.
  - `code block has copy button that writes to clipboard`.
- [ ] **Step 2:** `cd app && npx vitest run src/components/Markdown.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cd app && npx vitest run && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `app: safe markdown and lucide-react`.

### Task 6: App — timeline model

**Files:**
- Create: `app/src/lib/timeline.ts`
- Modify: `app/src/components/Transcript.tsx` (only to use the model; the views go in Task 7)
- Test: `app/src/lib/timeline.test.ts`

**Interfaces — Produces:**
- `type Item`:
  - `{t:'user'|'assistant'|'info'; seq; text; agent?}`;
  - `{t:'tool'; seq; id; name; kind: ToolKind; title: string; detail?: string; input?: any; output?: string; state:'running'|'ok'|'error'|'denied'; ms?; agent?; file?: string; diff?: {add:number; del:number}}`;
  - `{t:'reads'; seq; files: string[]; state; agent?}`;
  - `{t:'agent'; …}` (like the current one);
  - `{t:'artifact'; seq; path: string; name: string; inBase: boolean}`.
- `type ToolKind = 'read'|'search'|'edit'|'write'|'bash'|'web_search'|'web_fetch'|'skill'|'agent'|'todo'|'mcp'|'other'`.
- `buildTimeline(events: Event[], base: string): Item[]`:
  - pairs `tool_start` with `tool_end`;
  - merges **consecutive** `Read`s (no other item in between, same `agent`) into a single `reads`;
  - creates the `artifact` items per the Global Constraints rules, without duplicates: the last one wins and the earlier card is removed;
  - no longer produces `turn_end`.
- Titles in English, which Task 7 uses as is:
  - read: `Read <basename>` / `Read <basename> and N more`;
  - search: `Searched <pattern>`;
  - edit: `Edited <basename>`, with a line `diff` of old/new;
  - write: `Created <basename>`;
  - bash: the `description` if present; otherwise the command (first line);
  - web_search: `Searched "<query>"`;
  - web_fetch: `Read <host>`;
  - skill: `Used skill <name after ':'>`;
  - agent: `Subagent: <description>`;
  - todo: `Updated the plan (<n> tasks, <m> done)`;
  - mcp: `Used <tool> (<server>)`;
  - other: `<name>`.
- States: `denied` if the output matches `/deneg|denied|rechaz/i` and `ok` is false. (The Spanish alternatives are kept on purpose: they match deny reasons from older mods.)
- `diffLines(a, b): {add, del}`: LCS-based line diff (no dependency).
- `inBase(path, base)`: prefix with a separator; false if `base` is empty.

- [ ] **Step 1: Failing tests.**
  - `groups consecutive reads`, `does not group reads across a bash`.
  - `edit item has file and diff counts`, `write of html creates one artifact; second write moves it`.
  - `edit of md creates no artifact; edit of html does`.
  - `artifact outside base has inBase false`.
  - `old event without input falls back to summary for title` (Review Focus 4).
  - `denied state from output`.
  - `todo title counts`.
  - `no turn_end items`.
- [ ] **Step 2:** `cd app && npx vitest run src/lib/timeline.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cd app && npx vitest run`. Expected: PASS; update the Transcript tests that depended on `buildRows`.
- [ ] **Step 5:** Commit `app: agent timeline model`.

### Task 7: App — timeline views and header

**Files:**
- Create: `app/src/components/timeline/ToolItem.tsx`, `app/src/components/timeline/ArtifactCard.tsx`, `app/src/components/StatePill.tsx`
- Modify: `app/src/components/Transcript.tsx`, `app/src/screens/Session.tsx`, `app/src/components/AskCard.tsx`, `app/src/components/Composer.tsx`
- Test: `app/src/components/timeline/ToolItem.test.tsx`, `app/src/screens/Session.test.tsx`, `app/src/components/Transcript.test.tsx`

**Interfaces:**
- Consumes: `buildTimeline` and `Item` (Task 6); `Markdown` (Task 5).
- Produces:
  - `<ToolItem item />`: row closed by default (lucide icon by `kind`, title, ✓/✗/spinner as icons). Tapping opens it, by type:
    - read: list of paths;
    - edit: old/new diff as colored `-`/`+` lines, from `input`;
    - write: truncated content;
    - bash, web_search, web_fetch, mcp, other: the output, and for mcp and other also the input as JSON;
    - skill: the arguments;
    - agent: the answer;
    - todo: the list with each task's status.
  - On an edit of a `.md` or an image, the open row carries an "Open" link (`onOpenFile(path)`).
  - `<ArtifactCard item onOpen(path) />`:
    - name, machine and folder (dirname relative to the base);
    - "Open" button;
    - without a base, it comes out with no button and with the text `outside the project folder`.
  - `<StatePill state />`, per Global Constraints.
  - In the `Session.tsx` header:
    - row 1 carries ‹, title, `StatePill` and ⋯;
    - row 2 carries `machine · model · branch`;
    - "Interrupt" only in `working`;
    - the ⋯ menu adds "Close session", with `confirm`, to what it already had.
  - User messages go in a bubble on the right; answers use `<Markdown>` at full width.
  - `AskCard` and `Composer` are restyled with the same radii and colors, and carry lucide icons. Their behavior does not change.
  - `Transcript` receives `onOpenFile(path)` and passes it to the cards.

- [ ] **Step 1: Failing tests.**
  - `tool row is collapsed by default and expands on tap`.
  - `edit row shows -/+ lines when expanded`.
  - `running tool shows spinner icon, no emoji`: it contains no emoji-range characters.
  - `artifact card outside base has no Open`.
  - `Session header: Interrupt only when working`, `menu has Close session`, `subtitle has no cwd path`.
  - `assistant text renders markdown heading`.
- [ ] **Step 2:** `cd app && npx vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cd app && npx vitest run && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `app: expandable timeline, status header and markdown`.

### Task 8: App — artifact viewer

**Files:**
- Create: `app/src/screens/Viewer.tsx`
- Modify: `app/src/lib/api.ts`, `app/src/App.tsx`, `app/src/screens/Session.tsx`
- Test: `app/src/screens/Viewer.test.tsx`, `app/src/lib/api.test.ts`

**Interfaces:**
- Consumes: `POST /api/machines/{m}/views` (Task 4); `onOpenFile` (Task 7).
- Produces:
  - `api.createView(machine, sessionId, path): Promise<{url}>`.
  - New navigation `viewer: {machine, sessionId, path}` in App, full screen on the phone and the main area on desktop.
  - `Viewer`:
    - requests the link on mount;
    - header with ✕ (back), name, `machine · folder`, reload and "open in new tab" (`window.open(hubUrl()+url, '_blank', 'noopener')`).
  - `Viewer` body by extension:
    - `.html`, `.htm`, `.svg`: `<iframe src={hubUrl()+url} sandbox="allow-scripts allow-popups allow-forms allow-modals">`;
    - `.md`: `fetch(hubUrl()+url)` and then `<Markdown>`;
    - images: `<img>` with zoom (+/− buttons) and scroll;
    - `.pdf`: `<iframe>` without sandbox (the browser's PDF viewer needs it; a PDF does not run app code) and an "open in new tab" button.
  - If it fails, it shows the hub's error, for example `outside the project folder`, with "Back".

- [ ] **Step 1: Failing tests.**
  - `html viewer iframe has sandbox without allow-same-origin` (Review Focus 3).
  - `md viewer renders markdown from fetched text`.
  - `image viewer zoom buttons`.
  - `error from createView is shown`.
  - `createView posts sessionId and path`.
- [ ] **Step 2:** `cd app && npx vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cd app && npx vitest run && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `app: local artifact viewer`.

### Task 9: `local-artifacts` skill in the plugin

**Files:**
- Create: `mod/skills/local-artifacts/SKILL.md`
- Modify: `README.md` (one line in the plugin section)

**Interfaces — Produces:** a skill of the `quorum` plugin (`skills/` folder at the plugin root).
- Frontmatter `name: local-artifacts`. The `description` says:
  - that it is **only** for creating a page or document for the user to view (report, explanation, comparison, diagram, visual summary, presentation);
  - that it is **not** for designing an app's UI, components or the project's pages.
- The body, in English, says exactly this:
  1. A single self-contained `.html`, with inline CSS and JS, no CDNs or remote fonts; images as inline SVG or data URI.
  2. Designed first for 390 px width and scaling up to desktop; dark mode with `prefers-color-scheme`.
  3. Aesthetics with intent: chosen typography and palette, clear hierarchy, tables readable on the phone, no "generic AI look".
  4. Save it at `<project root>/.claude/quorum/artifacts/<clear-name>.html`, unless the user asks for another path, and mention the path in the final answer.
  5. Check the result by reading the file before finishing.
- The aesthetics guide is adapted from `frontend-design` (anthropics/skills). At the bottom: `Adapted from anthropics/skills (frontend-design), Apache-2.0`.
- It neither mentions nor forbids other tools.

- [ ] **Step 1:** Verify that Claude Code loads the skill: `claude plugin validate mod` if it exists; otherwise `claude --plugin-dir ./mod -p "list your skills" --tools ""` with `QUORUM_DISABLE=1`. It is a single cheap call. Expected: `local-artifacts` appears.
- [ ] **Step 2:** `claude plugin test mod`. Expected: PASS (no code changes).
- [ ] **Step 3:** Commit `plugin: local-artifacts skill`.

### Task 10: Deployment and e2e from the phone

**Files:**
- Create: `docs/e2e-plan4.md` (sanitized)

- [ ] **Step 1:** `make test && make cross`. Expected: PASS.
- [ ] **Step 2: Push and deploy.**
  - Push to GitHub; the owner already approved it for this flow.
  - Update `quorum-hub` and `quorumd` on the VPS and `quorumd` on this PC.
  - Run `claude plugin marketplace update quorum && claude plugin update quorum@quorum` on both machines.
- [ ] **Step 3: e2e with `abw`** in a 390×844 viewport, with a test device that is revoked at the end.
  1. A new session on this PC with the prompt "Read README.md, search the web for 'herdr terminal', and make me a local artifact with a summary". It must:
     - show the closed rows with icons, no emojis;
     - open each row with a tap;
     - show the answer with markdown;
     - show the "Open" card, which opens the HTML full screen;
     - have used `local-artifacts` (row "Used skill local-artifacts").
  2. An `Edit` of a file shows the diff when its row is opened.
  3. With the session open on the phone, from DevTools or the console, the artifact's iframe cannot read the app's `localStorage`.

  Cleanup: close the session (its tab closes by itself) and delete the test artifact.
- [ ] **Step 4:** Commit `docs/e2e-plan4.md` and push it.
