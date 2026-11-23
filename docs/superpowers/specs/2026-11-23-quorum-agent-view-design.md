# Quorum — agent view and local artifacts (phone first)

Date: 2026-11-23 · Status: draft for approval · Complements `2026-11-22-quorum-design.md` and `2026-11-23-quorum-herdr-sessions-design.md`

## 1. What and why

The view of a session (the chat with Claude) is ugly and hard to read on a phone:
- answers come out as plain text, with no formatting;
- every tool is a cramped gray line;
- you cannot tell at a glance what Claude did;
- there are no artifacts.

The owner wants, in this order:
1. **Read the answer** properly, with formatting.
2. **See local artifacts**, as in pastor: pages or files that Claude creates on the machine's disk, opened on the phone. Never claude.ai artifacts. Claude is not forbidden anything: it decides; Quorum only shows what is local.
3. **Quickly understand what Claude is doing**: skills, web search, reads, edits, commands and subagents, counted in plain language.

Also, the artifacts Claude makes today tend to be ugly. The Quorum plugin ships its own skill, **for artifacts only**, so they come out pretty and designed for the phone. It lives in the plugin and is not installed globally, so it does not clash with the owner's other app-design skills.

After this come Tauri and the Android app (another design).

## 2. Goals

- **G1. Timeline (direction B, chosen by the owner).** Each Claude action is a short row with an SVG icon and a clear phrase. **Everything closed by default**; a tap opens the detail.
- **G2. Formatted answers:** markdown with headings, lists, code, tables and links.
- **G3. Local artifacts:**
  - a card in the chat when Claude creates a viewable file;
  - "Open" shows it full screen;
  - an HTML loads its CSS and images from its folder.
- **G4. Header with status:** Working / Waiting for you / Needs permission / Idle / Closed, plus the name (recap), the machine and the branch. "Interrupt" only appears while it works; "Close" moves to the ⋯ menu.
- **G5. Artifacts skill in the Quorum plugin:** design guide for local pages that will be viewed on the phone.

## 3. Non-goals

- Editing files from the phone, file explorer, git in the app.
- Seeing agent-browser's live browser (pastor had it; left for later).
- Detecting files that Claude creates through `Bash` (only `Write` and `Edit`).
- Tauri / APK (next design).

## 4. Anti-goals

- Emojis as icons (the owner rejected them): SVG icons only.
- Letting an answer or an artifact read the device token or run anything with the app's permissions.
- Quorum serving any file on disk: only those in the folder of a session on that machine.
- The artifacts skill activating for work that is not an artifact (for example, designing an app's UI).
- Blocking claude.ai's `Artifact` or any tool.

## 5. Constraints

- Today the mod sends in `tool_start` only `summary` (one line, max 120). `tool_end.output` is truncated to 4000.
- The history backfilled from the transcript (daemon `transcript.Parse`) does not carry the tool input either.
- The hub↔daemon channel is the WebSocket with RPC (Plan 3). A message is at most 8 MiB, and the RPC waits 10 s.
- The app is React 19 + Tailwind v4, with no UI libraries. Phone first.
- The repo is public: no internal names.

## 6. Approaches

| Approach | Summary | Verdict |
|---|---|---|
| **Timeline B, expandable, with rich data from the mod and files served by the hub** ✅ | The mod sends each tool's input, truncated. The app builds rows by type. The hub fetches the machine's files over RPC in chunks and serves them with a temporary link | The only reasonable way: the servers are not reachable from the phone, and without the tool input there are no diffs or searches |
| A. Answer first, grouped activity | Summarized blocks ("Explored the code · 6 files") | The owner chose B |
| Phone straight to the machine | The daemon serves the files over HTTP | The machines are not reachable from the phone; the hub already acts as the bridge |
| `frontend-design` skill installed globally | It would activate for all design | The owner rejected it: it clashes with the owner's other skills; better a dedicated skill for artifacts only |

## 7. Design

### 7.1 Tool data (mod, daemon, proto)
- Commands, edits and written content (truncated) reach the hub and are stored with the events, just as the `summary` and the output are today. Quorum has a single owner, so there is no secret redaction *(design author's decision)*.
- `proto.ToolStart` gains `Input json.RawMessage "input"`: the tool input as a JSON object, **truncated**.
  - Each string stays at ≤ 2000 runes.
  - Arrays stay at ≤ 50 elements.
  - The total stays ≤ 16 KiB. If it goes over, only that tool's known keys are kept (table 7.2).
  - The current `summary` stays, as a fallback and for old clients.
- Mod (`mod/src/events.ts`): emits the truncated `input` in `tool_start`. `TOOL_OUTPUT_MAX` goes up to 8000 so command and search output is visible.
- Daemon (`internal/daemon/transcript`): the backfilled history also carries `input`, with the same truncation (equivalent Go function).
- Plugin version: 0.1.3.

### 7.2 Timeline rows (app)
Each tool is a row. Consecutive `Read` calls are merged into one row ("Read X and N more") that opens into the list.

| Tool | Row (closed) | When opened |
|---|---|---|
| Read (groupable) | Read `file` and N more | list of paths |
| Grep / Glob | Searched `pattern` | output |
| Edit / MultiEdit | Edited `file` +A −B | diff (old→new) |
| Write | Created `file` (and an artifact card if visible) | content (truncated) |
| Bash | `command` + ✓/✗ | output |
| WebSearch | Searched "query" | results (output) |
| WebFetch | Read `host` | URL + output |
| Skill | Used skill **name** | arguments |
| Agent / Task | Subagent: description · status | its answer |
| TodoWrite | Updated the plan (N tasks, M done) | task list with status |
| mcp__x__y | Used `y` (`x`) | input + output |
| other | name + summary | input + output |

- SVG icons from `lucide-react`, one per type. In progress: a spinner; error: in red; denied: "denied".
- A subagent's rows are indented under its Agent row.
- "end of turn · N tokens" goes away. The turn is separated with a gap and, at most, the time.
- User message: bubble on the right. Claude's answer: full-width markdown.
- Questions and permissions stay as fixed cards above the text box, redesigned with the same style.

### 7.3 Markdown
- `react-markdown` + `remark-gfm`, **no raw HTML**.
- Links open in a new tab with `rel="noopener noreferrer"`.
- Code blocks have a copy button and horizontal scroll; they have no syntax highlighting (left for later).
- Tables have horizontal scroll.

### 7.4 Local artifacts
- **Viewable files:** those ending in `.html .htm .md .svg .png .jpg .jpeg .gif .webp .pdf`.
- **Detection (app):**
  - They show an **"Open" card** (name, machine, folder), after their row:
    - a successful `Write` of a viewable file;
    - a successful `Edit` of an `.html`, `.htm` or `.svg`.
  - An `Edit` of a `.md` or of an image does **not** get a card. Editing `README.md` while coding must not fill the chat. Its open row shows an "Open" link.
  - If the same file is written several times, a single card is shown, at its last position.
  - A file outside the session's `root` and `cwd` (for example `/tmp/x.html`): the card comes out without "Open", with the text "outside the project folder". The app knows `root` and `cwd` from `SessionInfo`.
  - *(Design author's decision, after review.)*
- **Link (hub):** `POST /api/machines/{m}/views {sessionId, path}` → `{url}`.
  - The hub looks up the session and checks that `path` (absolute) is **inside that session's `root`**, or its `cwd` if there is no `root`. That folder is the **base**.
  - It creates a random 128-bit token, valid for 6 h, tied to `{machine, base}`.
  - It returns `/v/<token>/<file path relative to the base>`. That way the HTML's relative links (`img/a.png`, `../assets/x.css`) work as long as they do not leave the base.
- **Serving (hub):** `GET /v/<token>/<path relative to the base…>`.
  - It does not need the device token, because the link token is the authorization; that way an iframe can load it.
  - It resolves inside the base and rejects paths that leave it. The daemon checks it again; both layers count.
  - `Access-Control-Allow-Origin: *`, so the isolated page (opaque origin) can `fetch` its data and load fonts from its folder. The token is still required.
  - It fetches the file by RPC `file_read {path, base, offset, length}` in 1 MiB chunks, up to 50 MiB, and streams it to the browser as it arrives.
  - Content-Type according to the extension.
  - Headers:
    - `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors 'self'`. Opaque origin: the HTML cannot read the app's `localStorage`.
    - `X-Content-Type-Options: nosniff`.
    - `Cache-Control: no-store`.
  - An expired token gives 410 with a short page that says "Open it again from Quorum".
- **Daemon, `file_read`:**
  - Params `{path, base, offset, length}`. `EvalSymlinks` of the path and the base; the path must end up inside the base; it must be a regular file of ≤ 50 MiB.
  - Errors: "outside the project folder", "does not exist", "not a file", "file too large".
  - Returns `{data: base64, size, eof}`.
  - It does not depend on the terminal switch or on herdr: it is read-only.
- **Viewer (app):** full screen with a header (✕, name, machine, folder) and the reload and open-in-new-tab buttons.
  - HTML and SVG: `<iframe sandbox="allow-scripts allow-popups allow-forms allow-modals">`.
  - Markdown: the text is fetched and drawn with the same renderer as 7.3.
  - Images: `<img>` with zoom.
  - PDF: `<iframe>` (the browser's viewer) and an "open in new tab" button.

### 7.5 Session header
- Row 1: ‹ · name (recap) · status pill · ⋯.
- Row 2: machine · model · branch (no full path).
- Pills:
  - `working`: blue with an animated dot, "Working";
  - `needs_you`: amber, "Needs permission";
  - `waiting` / `idle`: gray, "Waiting for you";
  - `closed`: "Closed".
- "Interrupt" is a button visible only in `working`. The ⋯ menu has "Close session", "New session here" and "View in terminal".

### 7.6 Artifacts skill in the plugin
- `mod/skills/local-artifacts/SKILL.md`. The `description` restricts use to creating **a page or document for the owner to view** (report, explanation, comparison, diagram, visual summary, presentation). The same `description` states explicitly that it is **not** for designing an app's UI or the project's components.
- The skill's content says how to make the page:
  - **File:** a single self-contained `.html`, with inline CSS and JS; no CDNs or remote fonts (it must work offline and in an isolated iframe); images inline (data URI/SVG) or in the same folder.
  - **Screen:** design for 390 px width first, scaling up to desktop too; dark mode with `prefers-color-scheme`.
  - **Aesthetics and legibility:** typography and palette with intent; tables readable on the phone; no "generic AI look".
  - **Where to save it:** at `<project root>/.claude/quorum/artifacts/<clear-name>.html`, unless the user asks for another path. The final answer mentions the path.
- The aesthetics guide is adapted from `frontend-design` (anthropics/skills, Apache-2.0), with attribution in the file. It stays **scoped to artifacts**.
- Quorum blocks nothing: if Claude decides to use something else, it does.

## 8. Left to the builder
- Fine visual design of each row and of the viewer, within the current style (dark zinc).
- The exact truncation of `input` per tool, respecting the limits in 7.1.
- How consecutive reads are merged (window, breaks by another tool).
- Whether the diff is computed by lines (Edit's old/new) with a small library or with a custom line diff.
