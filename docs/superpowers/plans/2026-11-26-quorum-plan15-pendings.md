# Plan 15 — Pending Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each project a list of pending items. Agents create them through Quorum tools in every Claude Code
session, the owner creates them by hand, and a meeting's open point becomes one with a tap. The list shows in the
project briefing and on the project page.

**Architecture:**
- A `pendings` table in the hub store, with device routes for the app and machine routes for the daemon.
- The Quorum mod registers three tools (`$.tool.register`) and answers them in `tool.run` hooks by calling the local
  daemon.
- The daemon forwards to the hub over HTTP with its machine token. The hub resolves the session's project on every
  call.
- Open items join the `Briefing` payload, so `project_briefing_changed` refreshes every view.

**Tech Stack:** Go hub and daemon (SQLite through the existing store), TypeScript Claude Code mod, React app with
shadcn components, tygo for the generated types.

**Spec:** `docs/superpowers/specs/2026-11-26-quorum-pendings-live-copilot-design.md` (the "Plan 15" section and
"Calls made while writing this up").

## Global Constraints

- Items are generic, with no kind and no assignee. Fields: `text` ≤ 300, `detail` ≤ 4000, `note` ≤ 2000. Lengths
  are counted in code points.
- `source` is one of `agent|manual|meeting`, and `status` is one of `open|done|dropped`.
- **Dedupe:** an open item whose text matches, ignoring case and collapsing whitespace, in the same project returns
  the existing id. Applies to agents and to manual adds.
- **Cap:** 50 open `agent` items per project. Over the cap the answer is an error: "This project already has 50 open
  pending items from agents; ask the owner to close some first".
- **`clientKey`** (≤ 64) makes an add idempotent: the same key in the same project returns the same item.
- **Hub unreachable** (tool error): "Quorum hub unreachable; the item was not saved".
- **No project** (tool error): "This session has no Quorum project; link the folder to a project in Quorum first".
- **`pending_list`:** open items by default, `detail` cut to 200 characters, at most 50 items, oldest first.
- **From meetings:** `source_ref` holds the meeting id. The same text from the same meeting twice answers 409, and
  the button shows "Added".
- **Order everywhere:** oldest first. Done and dropped items are kept forever.
- **"New" dot:** shown on agent items created after the briefing's `prevSeenAt`. There is no stored flag and no
  push.
- Repo content in English, with no personal data or real names (use made-up names like "Zorvan" in tests).
- Initial JS stays at 655 kB or less (now about 651). New UI goes in the already-lazy Project and meeting chunks.
- Use semantic tokens only, 44 px targets, 320 px layouts, and ScrollArea for scroll regions.
- Mod version bump: `0.2.4` → `0.2.5`.

## Review Focus

1. **Session from another machine.** A daemon asks for a session id that belongs to a different machine: expect 404,
   with nothing created or listed. Test in Task 3.
2. **A session linked after it started.** `pending_add` fails with the no-project error, the owner links the folder,
   and the next call works with no restart, because nothing is cached. Test in Task 3.
3. **Retry with the same `clientKey` after a lost answer.** It returns the same id and creates one row; the cap is
   not consumed twice. Test in Task 3.
4. **`pending_done` with an id from another project.** Refused with 404, and the item is unchanged. Test in Task 3.
5. **Ticking from the briefing while the project page list is open.** Both views update through
   `project_briefing_changed`, with no stale "open" row left. Test in Task 6.

---

## File Structure

- `internal/hub/store/pendings.go` (new): schema, `migratePendings`, CRUD, dedupe, cap and project delete.
- `internal/hub/pendings.go` (new): device and machine handlers, validation, the meeting route.
- `internal/proto/proto.go`: `Pending`, plus the `Briefing.Pendings` field.
- `internal/hub/briefing.go`: fill `Pendings`.
- `internal/daemon/pendings.go` (new): the local API routes that forward to the hub.
- `mod/src/pendings.ts` (new): tool specs and handlers.
- `mod/hooks/register.ts`: register tools at `session.start` and hook `tool.run`.
- `mod/src/io.ts`, `mod/src/link.ts`: a fetch that returns the body, and `Link.request`.
- `mod/skills/pendings/SKILL.md` (new).
- `app/src/lib/pendingsApi.ts` (new).
- `app/src/components/pendings/PendingRow.tsx` and `PendingList.tsx` (new).
- `app/src/components/briefing/Pendings.tsx` (new).
- Changes to `Briefing.tsx`, `lib/briefing.ts`, `screens/Project.tsx` and `meetings/MeetingPage.tsx`.

---

### Task 1: Store and proto

**Files:**
- Create: `internal/hub/store/pendings.go`, `internal/hub/store/pendings_test.go`
- Modify: `internal/proto/proto.go`, `internal/hub/store/store.go` (call `migratePendings` with the other
  migrations), the store's `DeleteProject` (also delete the project's pendings), and the generated
  `mod/src/proto.gen.ts` and `app/src/proto.gen.ts` (`make proto`).

**Interfaces:**
- Produces, in `proto`:
  ```go
  type Pending struct {
      ID string `json:"id"`; ProjectID string `json:"projectId"`; Text string `json:"text"`; Detail string `json:"detail"`
      Note string `json:"note"`; Source string `json:"source"`; SourceRef string `json:"sourceRef"`; Status string `json:"status"`
      CreatedAt int64 `json:"createdAt"`; UpdatedAt int64 `json:"updatedAt"`; DoneAt int64 `json:"doneAt"`
  }
  ```
  Add `Briefing.Pendings []Pending \`json:"pendings"\`` (open items, oldest first, never null).
- Produces, in `store`:
  - `ErrPendingCap = errors.New("pending cap")`
  - `AddPending(p proto.Pending, clientKey string, now int64) (proto.Pending, bool /*created*/, error)`.
    Order of checks:
    1. The `clientKey` match, which returns the existing item, open or not.
    2. The open-text dedupe, which returns the existing open item.
    3. The cap, counted for `agent` only, which returns `ErrPendingCap`.
    4. Otherwise insert, with `newID()`.
  - `Pendings(projectID string, all bool) ([]proto.Pending, error)`: oldest first. With `all=false`, open items
    only.
  - `Pending(id string) (proto.Pending, error)`: `sql.ErrNoRows` when missing.
  - `UpdatePending(id string, f PendingPatch, now int64) (proto.Pending, error)`, with
    `type PendingPatch struct{ Text, Detail, Note, Status *string }`. Setting `Status` to `done` or `dropped` sets
    `done_at = now`; `open` resets it to 0.
  - `DeletePending(id string) (projectID string, err error)`
  - `MeetingPendingExists(meetingID, text string) (string, bool, error)`: the same normalised text with
    `source='meeting'` and `source_ref=meetingID`, any status.

- [ ] **Step 1: Write the failing tests** in `pendings_test.go`:
  - `TestPendingAddDedupeAndOrder`:
    - Adding "Ask Zorvan about the  thickness" and then "ask zorvan about the thickness" returns the same id, with
      `created=false`.
    - After done, the same text creates a new item.
    - `Pendings(p,false)` is oldest first.
  - `TestPendingClientKeyIdempotent`: two adds with key "k1" and different text give one row and the same id.
  - `TestPendingAgentCap`:
    - 50 agent adds succeed and the 51st returns `ErrPendingCap`.
    - A `manual` add still succeeds.
    - After one agent item is done, an agent add succeeds.
  - `TestPendingUpdateStatus`: done sets `DoneAt`, and open resets it to 0. The note is stored.
  - `TestPendingDeletedWithProject`: deleting the project removes its rows.
- [ ] **Step 2: Run** `go test ./internal/hub/store -run Pending`. Expected: FAIL (undefined).
- [ ] **Step 3: Implement.**
  - Table `pendings(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text, detail, note, source, source_ref, client_key, status, created_at, updated_at, done_at)`.
  - Indexes on `(project_id, status, created_at)` and a unique index on `(project_id, client_key) WHERE client_key<>''`.
  - Normalise text for the dedupe in Go: `strings.ToLower` plus `strings.Fields` joined by one space. Store the
    normalised form in a `norm` column with an index on `(project_id, norm)`.
- [ ] **Step 4: Run** `go test ./internal/hub/store`, then `make proto`. Expected: PASS, and `proto.gen.ts` gains
  `Pending`.
- [ ] **Step 5: Commit** "hub: pendings store".

### Task 2: Device API, briefing and the meeting route

**Files:**
- Create: `internal/hub/pendings.go`, `internal/hub/pendings_test.go`
- Modify: `internal/hub/server.go` (routes), `internal/hub/briefing.go` (fill `b.Pendings`)

**Interfaces:**
- Consumes the Task 1 store functions.
- Produces these device routes (registered with `dev(...)`, as the pinned routes are):
  - `GET /api/projects/{id}/pendings?status=open|all`: returns `[]Pending`. A missing status means open.
  - `POST /api/projects/{id}/pendings {text, detail?, clientKey?}`: 201 with the item (source `manual`), or 200
    with the existing one when deduped.
  - `PATCH /api/pendings/{id} {text?, detail?, note?, status?}`: returns the item.
  - `DELETE /api/pendings/{id}`: 204.
  - `POST /api/meetings/{id}/pendings {text}`: needs a meeting that has a project. Creates source `meeting` with
    `sourceRef` set to the meeting id and returns 201. If the text already came from that meeting it answers 409
    `{error:"already added", id}`. A meeting with no project answers 400 "assign the meeting to a project first".
  - Every change calls `s.hub.briefingChanged(projectID)`.
- Validation errors (400, English):
  - "text is required"
  - "text is longer than 300 characters"
  - "detail is longer than 4000 characters"
  - "note is longer than 2000 characters"
  - "status must be open, done or dropped"
  - an unknown project or item answers 404.

- [ ] **Step 1: Write the failing tests:**
  - `TestPendingsDeviceCRUD`:
    - Covers add, list, patch (done with a note), list open (empty) and list all (1). A
      `project_briefing_changed` is published.
    - DELETE answers 204, and then GET all is empty.
  - `TestPendingsValidation`: one case per error message above, plus an unknown project (404).
  - `TestBriefingIncludesOpenPendings`: two open items and one done; `GET …/briefing` returns `pendings` with the
    two open ones, oldest first.
  - `TestMeetingPendingOnceAndNeedsProject`:
    - The first POST answers 201, the second 409 with the same id.
    - A meeting without a project answers 400.
- [ ] **Step 2: Run** `go test ./internal/hub -run 'Pending|BriefingIncludes'`. Expected: FAIL.
- [ ] **Step 3: Implement** the handlers in `internal/hub/pendings.go`, and add
  `b.Pendings, err = s.st.Pendings(projectID, false)` next to `Pinned`.
- [ ] **Step 4: Run** `go test ./internal/hub/...`. Expected: PASS.
- [ ] **Step 5: Commit** "hub: pendings device API and briefing".

### Task 3: Machine API (the agents' path)

**Files:**
- Modify: `internal/hub/pendings.go`, `internal/hub/server.go`, `internal/hub/pendings_test.go`

**Interfaces:**
- Produces these routes, wrapped in `s.requireMachine`. The machine name comes from `AuthName(ctx)`.
  - `GET /api/machine/sessions/{sid}/pendings?status=open|all`: returns
    `{projectId, projectName, items: []Pending}`. Items are at most 50 and `detail` is cut to 200 code points, with
    "…" added when cut.
  - `POST /api/machine/sessions/{sid}/pendings {text, detail?, clientKey?}`: returns
    `{item, created}`, with source `agent` and `sourceRef` set to `sid`.
  - `POST /api/machine/sessions/{sid}/pendings/{id}/done {note?}`: returns `{item}`.
- **Resolution on every call:**
  1. `h.sessionOwnedBy(machine, sid)`. A false answer is 404 "unknown session".
  2. `st.Session(sid).ProjectID`. An empty one is 409 with the exact no-project message from Global Constraints.
- An item id from another project is 404 "unknown pending item".
- The cap answers 429 with the exact cap message.

- [ ] **Step 1: Write the failing tests:**
  - `TestMachinePendingsResolveProject`:
    - A session registered by machine "m1" on a project: add, then list.
    - The same `sid` asked by "m2" answers 404 (Review Focus 1).
  - `TestMachinePendingsNoProjectThenLinked`:
    - The first add answers 409 with the exact message.
    - After the hub assigns the session's project, through the same path the app uses to link a checkout, the next
      add answers 200 (Review Focus 2).
  - `TestMachinePendingsClientKeyRetry`: the same key twice gives the same id and one row (Review Focus 3).
  - `TestMachinePendingsDoneOtherProject`: an id from another project answers 404 and stays open (Review Focus 4).
  - `TestMachinePendingsCapAndTrim`:
    - The 51st add answers 429 with the message.
    - A list item whose `detail` is 300 runes comes back as 200 runes plus "…".
- [ ] **Step 2: Run** `go test ./internal/hub -run MachinePendings`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test -race ./internal/hub/...`. Expected: PASS.
- [ ] **Step 5: Commit** "hub: machine pendings API for agent tools".

### Task 4: Daemon forwarding

**Files:**
- Create: `internal/daemon/pendings.go`, `internal/daemon/pendings_test.go`
- Modify: `internal/daemon/localapi.go` (mount the routes, behind the existing `auth(token, …)`), and the place that
  builds the local API so it receives the config getter.

**Interfaces:**
- Produces these local routes:
  - `GET /v1/sessions/{id}/pendings?status=`
  - `POST /v1/sessions/{id}/pendings`
  - `POST /v1/sessions/{id}/pendings/{pid}/done`

  Each forwards to the matching hub machine route, using `cfg.Hub` and `Authorization: Bearer cfg.MachineToken`.
  Bodies are capped at 64 KiB in both directions, with a 10 s timeout.
- The hub's status and JSON body are passed through unchanged.
- A network error, a timeout, or no hub configured answers 502 `{"error":"Quorum hub unreachable; the item was not saved"}`.

- [ ] **Step 1: Write the failing tests** against an `httptest` hub:
  - `TestPendingsForwardAddsMachineToken`: the hub sees the bearer token and the same path, query and body.
  - `TestPendingsForwardPassesHubErrors`: a hub 409 JSON reaches the caller unchanged.
  - `TestPendingsForwardHubDown`: the hub is closed, so the answer is 502 with the exact message.
  - `TestPendingsForwardNeedsLocalToken`: no local token answers 401.
- [ ] **Step 2: Run** `go test ./internal/daemon -run PendingsForward`. Expected: FAIL.
- [ ] **Step 3: Implement.** Read the config through the same accessor the hub link uses, so a reload (`/v1/reload`)
  takes effect.
- [ ] **Step 4: Run** `go test ./internal/daemon/...`. Expected: PASS.
- [ ] **Step 5: Commit** "daemon: forward pendings calls to the hub".

### Task 5: Mod tools and skill

**Files:**
- Create: `mod/src/pendings.ts`, `mod/test/pendings.test.ts`, `mod/skills/pendings/SKILL.md`
- Modify:
  - `mod/src/io.ts`: `fetch` also returns `text`.
  - `mod/src/link.ts`: add `LinkIO.fetch` returning `{status, text}`, plus `request()`.
  - `mod/hooks/register.ts`.
  - `mod/.claude-plugin/plugin.json`: version `0.2.5`.

**Interfaces:**
- Consumes the Task 4 local routes.
- Produces:
  - `Link.request(method: 'GET'|'POST', path: string, body?: unknown): Promise<{ status: number; json: any }>`. It
    uses the daemon address and token the link already holds. A missing connection resolves to `{status: 0, json: null}`.
  - In `mod/src/pendings.ts`:
    - `PENDING_TOOLS`: three specs for `$.tool.register`, named `pending_add`, `pending_list` and `pending_done`.
      They become `mcp__quorum__pending_*`. The descriptions say what each does, that items are generic (questions
      for someone, tasks, points to raise), and that the agent must tell the owner what it added.
    - Input schemas:
      - add: `{text: string ≤300, detail?: string ≤4000}`, required `text`;
      - list: `{status?: "open"|"all"}`;
      - done: `{id: string, note?: string ≤2000}`, required `id`.
    - `runPendingTool(link: Link, sessionId: string, name: string, input: Record<string, unknown>, newKey: () => string)`.
      It resolves to `{ ok: true; text: string; result: unknown } | { ok: false; text: string }`. For add it sends
      `clientKey = newKey()`, and the same key is reused for one automatic retry after a status-0 or 502 answer.
- **Hooks in `register.ts`:**
  - At `session.start`, after `$.command.register`, call `$.tool.register` for each spec. Do not await it on the
    start path, and log failures to debug.
  - For `{ tool: 'mcp__quorum__pending_*' }`, hook `tool.run` to answer from `runPendingTool`. Failures go back as
    an error result the model reads; use the `ToolCallResult` shape from the host types.
- **Text the model reads:**
  - add: `Added to <projectName>: "<text>" (id <id>)`, or `Already pending in <projectName>: "<text>" (id <id>)`
    when not created.
  - list: one line per item, `- [<id>] <text> — <detail snippet>`, or `No open pending items in <projectName>.`.
  - done: `Marked done: "<text>"`.
  - errors: the hub's or the daemon's `error` string verbatim, otherwise "Quorum is not connected; the item was not
    saved".
- **Skill** `mod/skills/pendings/SKILL.md`, about 25 lines:
  - When to use: anything the owner must not forget for a project (a question for the client, a task, a point to
    raise), or the owner saying "anota", "recuérdame" or "pendiente".
  - Prefer one item per point, with short text and context in `detail`.
  - Never use it for the agent's own to-do list.
  - Always tell the owner what was added.

- [ ] **Step 1: Write the failing tests** in `mod/test/pendings.test.ts`, with a fake `LinkIO`:
  - `adds with a client key and retries once with the same key on 502`;
  - `reports "Already pending" when created is false`;
  - `passes the no-project error verbatim`;
  - `list formats items and the empty case`;
  - `done sends the note`;
  - `not connected gives the not-saved message`.

  Also extend `register.test.ts`: the three tools are registered at `session.start`, and a `tool.run` for
  `mcp__quorum__pending_add` answers through `runPendingTool`.
- [ ] **Step 2: Run** the mod tests (`claude plugin test mod` or the repo's mod test command). Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the mod tests and `npx tsc -p mod`. Expected: PASS.
- [ ] **Step 5: Commit** "mod: pending tools for agents".

### Task 6: App — the briefing section and the project list

**Files:**
- Create:
  - `app/src/lib/pendingsApi.ts`
  - `app/src/components/pendings/PendingRow.tsx`
  - `app/src/components/pendings/PendingList.tsx`
  - `app/src/components/briefing/Pendings.tsx`
  - tests next to each.
- Modify:
  - `app/src/components/briefing/Briefing.tsx`: the section order becomes "Where you left off", "Pending",
    "New since you were here", …
  - `app/src/lib/briefing.ts`: `normalizeBriefing` defaults `pendings: []`. `briefingPrompt` adds a "Pending" block
    and drops those lines just before the open tickets.
  - `app/src/screens/Project.tsx`: `PendingList` sits under the briefing, above `ProjectMeetings`.
  - `app/src/dev/fixtures.ts`: the demo and worst-case data. The worst case has a 300-character text, a
    4000-character detail, 60 items, and a long unbroken token.

**Interfaces:**
- Produces in `pendingsApi.ts`:
  - `listPendings(projectId, all: boolean)`
  - `addPending(projectId, {text, detail?})`
  - `patchPending(id, {text?, detail?, note?, status?})`
  - `deletePending(id)`
  - `addMeetingPending(meetingId, text)`: resolves `{id, added: boolean}`, where a 409 gives `added: false`.
- **`PendingRow`:**
  - A checkbox, then the text, then a "new" dot when `source==='agent' && createdAt > prevSeenAt`, then a source
    label: "agent", "meeting", or nothing for manual.
  - Ticking opens an inline optional note field with "Done" and "Skip note". Both close the item; the note is saved
    only if typed.
  - The overflow menu holds "Edit", "Drop" and "Delete".
- **Briefing "Pending" section:** open items only (from `b.pendings`), at most 8, then "Show all (N)", which scrolls
  to `PendingList`. It is hidden when empty.
- **`PendingList`:**
  - An add field (Enter adds, Shift+Enter makes a new line in `detail`, as the composer does), and an
    "Open | All" toggle.
  - It refetches on `briefingRev`, and the list sits in a ScrollArea.

- [ ] **Step 1: Write the failing tests:**
  - `Pendings.test.tsx`:
    - Renders the open items oldest first.
    - The "new" dot appears only on agent items newer than `prevSeenAt`.
    - Ticking with a note calls `patchPending(id,{status:'done',note})`.
    - "Skip note" sends no note.
  - `PendingList.test.tsx`:
    - Adding calls `addPending`.
    - "All" shows done items struck through.
    - Drop and delete call the API.
    - A `briefingRev` bump refetches (Review Focus 5).
  - `briefing.test.ts`: `briefingPrompt` includes a "Pending" block, and drops it before the tickets when long.
  - `Briefing.test.tsx`: the region order now includes "Pending" second.
- [ ] **Step 2: Run** `cd app && npx vitest run src/components/pendings src/components/briefing src/lib/briefing`.
  Expected: FAIL.
- [ ] **Step 3: Implement** with the existing shadcn `Checkbox`, `Button`, `DropdownMenu`, `Textarea` and
  `ScrollArea`.
- [ ] **Step 4: Run** `npx vitest run`, then `npm run build`, and check the initial JS budget script. Expected: all
  pass, and initial JS ≤ 655 kB.
- [ ] **Step 5: Commit** "app: pending items in the briefing and project page".

### Task 7: App — "Add as pending" on meeting open points

**Files:**
- Modify: `app/src/components/meetings/MeetingPage.tsx` (`Points`) and its test.

**Interfaces:**
- Consumes `addMeetingPending` from Task 6.
- Only for the "Open points" list, and only when the meeting has a project: a 44 px "Add as pending" button per
  point. After a success or a 409, it shows "Added", disabled.
- A meeting without a project shows no button.

- [ ] **Step 1: Write the failing tests** in `MeetingPage.test.tsx`:
  - `add as pending calls the API and shows Added`;
  - `a 409 also shows Added`;
  - `no button when the meeting has no project`;
  - `decisions have no button`.
- [ ] **Step 2: Run** `npx vitest run src/components/meetings`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** "app: turn a meeting open point into a pending item".

### Task 8: End-to-end (controller)

- [ ] Deploy the hub, both daemons and the mod (plugin update on both machines), as in the usual deploy steps.
- [ ] Use a real Claude Code session in a repo linked to a scratch project:
  - Ask the agent to "anota que tengo que preguntarle a Zorvan por el grosor". It calls
    `mcp__quorum__pending_add` and says what it added.
  - Ask the same again: the item is not duplicated.
- [ ] Check the app:
  - The item shows in the briefing with the "new" dot and on the project page.
  - Ticking it with a note works.
  - Phone width (390 px) and desktop both look right.
- [ ] Use a session in an unlinked folder: the tool answers the no-project message.
- [ ] Delete the scratch project and session data.
