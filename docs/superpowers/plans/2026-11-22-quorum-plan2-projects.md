# Quorum — Plan 2: control without modes, recap and projects/tickets/status

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Stage 1 of the spec: permissions and questions answerable from everywhere at once (no modes), sessions named by their recap, and the projects center — workspaces → projects → tickets and sessions, with generic ticket system connectors, each ticket's status without asking, and an automatic summary of each project.

**Architecture:** On top of what exists (Go hub + SQLite, `quorumd`, TS mod, React app). The mod gains its own permission dialog and the recap (Haiku via `$.model.complete`). The hub gains the projects model, a connector engine (GitHub via `gh`, Paperclip via REST, and a generic executable one with JSON over stdin/stdout), periodic sync, write proposals that the owner approves, and a summarizer (ccapi if present, otherwise `claude -p --model haiku`). The app gains the projects board.

**Tech Stack:** same as Plan 1 (Go 1.27, `modernc.org/sqlite`, `coder/websocket`, tygo; TS mod with `claude plugin test`; React 19 + Vite + Tailwind v4 + vitest).

**Spec:** `docs/superpowers/specs/2026-11-22-quorum-design.md` (§8–10, §14b and §18).

## Global Constraints

- Everything from Plan 1 stays in force (loopback by default, never `funnel`, SHA-256 tokens, no cgo, texts in English (translated in Plan 4, Task 0), nothing compiled in git, `claude` through a login shell).
- **No modes:** there is no `away`, `watch` or presence. No behavior depends on where the owner is.
- **Permissions:** race between the terminal's own dialog (`$.ui.ask`, exact options `Allow` / `Deny`) and the devices' cards; the first wins. Maximum wait `HOLD_MAX_MS` (19 min); once expired → `deny` with reason `"No answer in 19 min (Quorum)"`. `AskUserQuestion` and `ExitPlanMode` do not go through this dialog (AskUserQuestion already runs its own race).
- **Recap:** ≤ 60 characters, English, no quotes or final period; at most one generation every 5 min per session and only if there were new turns; model `haiku`; 8 s timeout; a failure keeps the previous recap.
- **Quorum never writes to a ticket system on its own:** every write (comment, change status) is a proposal that the owner approves in the app.
- **Credentials:** the hub does not store secrets that whoas handles. A workspace can have a `whoasProfile`; connectors that use CLIs run with `WHOAS_PROFILE=<profile>` in their environment. Connectors' own tokens (e.g. Paperclip) are stored in the hub's database and are **never** returned by the API (only `"hasToken": true`).
- Normalized ticket statuses, exact: `todo | in_progress | in_review | done | blocked`.
- Ticket system sync: every 5 min per project (configurable 1–60) + "Refresh" button. The only polling allowed.
- Project summary: Haiku, at most every 30 min per project and only if there were changes (tickets, sessions, turns); "No activity since <date>" spends no model. 1–2 lines, ≤ 200 characters.
- One ticket, one active session: opening a session from a ticket with a live session offers going to that one.

## Review Focus

1. **The owner answers the permission in the terminal while the phone shows the card** → the card disappears (`ask_resolved{by:'terminal'}`); if the phone answers first, the tool runs/is denied and a late answer in the terminal is ignored without breaking anything. Tests in Task 2.
2. **Connector down or with bad credentials** → the project shows "Sync error: <message>" and keeps the latest tickets; it never deletes tickets because of a failure. Test in Task 6.
3. **Executable connector that hangs or spits garbage** → 30 s timeout, output > 8 MiB rejected, invalid JSON = visible error; the hub does not block. Test in Task 6.
4. **Recap with Haiku failing or slow** → the session stays without a recap or with the previous one; it never blocks a turn. Test in Task 3.
5. **The same repo cloned on two machines** → two checkouts of the same project (by normalized remote URL: `git@github.com:o/r.git` ≡ `https://github.com/o/r`), sessions of both under the same project. Test in Task 5.

---

### Task 1: Remove the modes (away/watch/presence) end to end

**Files:**
- Modify: `app/src/App.tsx`, `app/src/screens/Session.tsx`, `app/src/lib/live.ts`, `app/src/lib/store.ts`, `app/src/lib/api.ts` (+ tests)
- Modify: `internal/hub/appapi.go`, `internal/hub/live.go`, `internal/hub/machines.go`, `internal/hub/store/store.go`, `internal/hub/store/migrations.go` (+ tests)
- Modify: `internal/daemon/registry.go` (+ tests), `internal/proto/proto.go` (+ `make proto`)
- Modify: `mod/src/control.ts`, `mod/hooks/register.ts` (+ tests)

**Interfaces:**
- Produces: no `Command{type:'presence'}`, no `Away/Watching` in `Command`, no `away`/`watch` envelopes, no `POST /api/sessions/{id}/presence`, no `away` table in use (the migration leaves it; the code neither reads nor writes it), no presence replay in the daemon, no "Away" checkbox or `watch` message in the app. `Asks.permission` and the mod's 'watching' path are removed (Task 2 replaces them).

- [ ] **Step 1: Tests that pin the absence:** hub — `POST /api/sessions/x/presence` → 404; a `{"type":"watch"}` over `/api/live` is ignored without error; daemon — `Subscribe` does not forward anything on connect; app — the "Away" control does not exist (`queryByLabelText('Away')` is null); proto — `Command` has no `away`.
- [ ] **Step 2: Run** the suite → FAIL where they still exist.
- [ ] **Step 3: Remove** the code and the tests that covered it (presence tracker, awayMap, RenameAway/AwaySessions/PruneAway, `publishAway`, presence replay, `turnStart` of "last terminal prompt", `away` state of the reducer and of App).
- [ ] **Step 4: Run** `go test -race ./... && go vet ./... && claude plugin test mod && make typecheck && (cd app && npx vitest run && npm run build)` → PASS.
- [ ] **Step 5: Commit** `refactor: no modes — remove presence, away mode and watch`

---

### Task 2: Permissions answerable from everywhere at once

**Files:**
- Create: `mod/src/permission.ts`, `mod/test/permission.test.ts`
- Modify: `mod/hooks/register.ts`, `mod/src/control.ts` (Asks)

**Interfaces:**
- Consumes: `Asks` (`ask`, `resolve`, `withdraw`, `settle`), `hold.ts` (`keepAlive`), `Link.emit`
- Produces: `function permissionRace(deps: { termAsk: (q: string) => Promise<string>; asks: Asks; keepAlive: (until: Promise<unknown>) => Promise<void>; signal?: AbortSignal; now: () => number }, a: { tool: string; summary: string; detail: string }): Promise<{ decision: 'allow' | 'deny'; reason: string }>`

- [ ] **Step 0 (spike, no product commit):** confirm in a real session (`claude --plugin-dir ./mod` in tmux, default permission mode, haiku model, a single prompt asking to write a file) that a test mod can call `$.ui.ask("…", ["Allow","Deny"])` **inside `tool.check`** and that its wait does not consume the 10 s budget. Record the result in the report. If it does not work: BLOCKED with the evidence (the controller decides).
- [ ] **Step 1: Tests (`permission.test.ts`, with fakes):**
  - the device resolves `allow` first → `{decision:'allow', reason:'Allowed from Quorum'}`, no `ask_resolved` is emitted from the mod (Plan 1's Ruling L), the pending `termAsk` stays hanging and its late answer changes nothing.
  - the terminal answers `Allow` first → `{decision:'allow', reason:'Allowed in the terminal'}` and `ask_resolved{askId, by:'terminal'}` is emitted.
  - the terminal answers `Deny` → `deny`, reason `'Denied in the terminal'`.
  - `termAsk` rejects (the owner closed the dialog with Esc) → keeps waiting for the device (it does not deny by itself just for closing).
  - nobody answers within `HOLD_MAX_MS` → `{decision:'deny', reason:'No answer in 19 min (Quorum)'}` and `ask_resolved{by:'terminal'}`.
  - `signal` aborted (turn interrupted) → withdraws the ask (`ask_resolved{by:'terminal'}`) and returns `deny` with reason `'Turn interrupted'`.
- [ ] **Step 2: Run** `claude plugin test mod` → FAIL.
- [ ] **Step 3: Implement** `permissionRace` and wire it into `tool.check` (main thread; when `next(e)` returns `ask` and the tool is not `AskUserQuestion`/`ExitPlanMode`; `service` role → return the verdict without touching). The terminal dialog: question `"<tool>: <summary>"` (≤ 120 characters), options `["Allow","Deny"]`, `header: "Permission"`.
- [ ] **Step 4: Run** the mod suite + `make typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(mod): permissions in the terminal and on all devices at once`

---

### Task 3: Recap as session name

**Files:**
- Create: `mod/src/recap.ts`, `mod/test/recap.test.ts`
- Modify: `internal/proto/proto.go` (`SessionInfo.Recap string \`json:"recap"\``; `make proto`), `internal/hub/store/{store.go,migrations.go}` (`recap` column), `mod/hooks/register.ts`, `mod/src/link.ts` (uses `update({recap})`), `app/src/lib/title.ts` (+ test)

**Interfaces:**
- Produces: `class Recap { constructor(deps: { complete: (prompt: string) => Promise<string>; now: () => number; update: (recap: string) => void }); onFirstPrompt(text: string): void; onTurnEnd(lastPrompt: string, answer: string): void }`; `function cleanRecap(raw: string): string` (removes quotes, final period, line breaks; cuts to 60 at a word boundary).
- `sessionTitle(s)` in the app: `recap` → `name` → basename(root|cwd).

- [ ] **Step 1: Tests:** `cleanRecap('"Fixing the login with OAuth."\n')` → `'Fixing the login with OAuth'`; cuts to ≤ 60; `onFirstPrompt` calls `complete` once and `update` with the cleaned result; two `onTurnEnd`s within < 5 min → a single generation; `onTurnEnd` without a new turn since the last generation → none; `complete` rejects or takes > 8 s → no `update` and it does not throw; app: `sessionTitle({recap:'X', root:'/a/b'})` → `'X'`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Fixed prompt (English): "Summarize in one phrase of at most 8 words, in English, what this programming session is working on. Only the phrase." + the user's last prompt (≤ 2000 characters) + the answer (≤ 2000). `complete` = `$.model.complete({model:'haiku', prompt, maxTokens:40, timeoutMs:8000})` (verify the signature in the build's types; if it does not exist in 2.1.325, the recap stays empty without error). Only in `work` role.
- [ ] **Step 4: Run** mod, Go and app suites → PASS.
- [ ] **Step 5: Commit** `feat: session recap as its name`

---

### Task 4: Projects model in the hub

**Files:**
- Create: `internal/hub/store/projects.go`, `internal/hub/store/projects_test.go`
- Modify: `internal/hub/store/migrations.go`, `internal/proto/proto.go` (+ `make proto`)

**Interfaces:**
- Produces (proto, camelCase JSON):
  - `Workspace{ID, Name, Color, WhoasProfile string}`
  - `Project{ID, WorkspaceID, Name, RepoURL string; Connector ConnectorConfig; Summary string; SummaryAt int64; Progress Progress; SyncError string; SyncedAt int64}` — `Progress{Done, Total int}`
  - `ConnectorConfig{Kind string /* github|paperclip|exec|none */; Settings map[string]string; HasToken bool; IntervalMin int}`
  - `Checkout{ID, ProjectID, Machine, Root, RepoURL, Branch string; UpdatedAt int64}`
  - `Ticket{ID, ProjectID, ExternalID, Title, Status /* normalized */, RawStatus, Assignee, URL, Body string; Comments []TicketComment; UpdatedAt int64}` — `TicketComment{Author, Body string; At int64}`
  - `SessionTicket{SessionID, TicketID string; Confirmed bool}`
  - `Proposal{ID, TicketID, Kind /* comment|status */, Body, Status string /* pending|sending|approved|rejected|failed */; Error string; CreatedAt int64}`
- Store: CRUD `CreateWorkspace/ListWorkspaces/UpdateWorkspace/DeleteWorkspace`, `CreateProject/ListProjects/GetProject/UpdateProject/DeleteProject` (token separate: `SetConnectorToken(projectID, token)`, `ConnectorToken(projectID) (string, error)` — never in `GetProject`), `UpsertCheckout`, `ListCheckouts(projectID)`, `CheckoutForRoot(machine, root)`, `ReplaceTickets(projectID string, ts []Ticket) error` (upsert by ExternalID; does **not** delete the missing ones: it marks them `done` only if the connector says so), `ListTickets(projectID)`, `LinkSessionTicket/UnlinkSessionTicket/SessionTickets`, `CreateProposal/ListProposals/SetProposalStatus`, `SetProjectSummary`, `SetSyncResult(projectID, err string, at int64)`.
- `func NormalizeRepoURL(u string) string` → `github.com/o/r` (lowercase, no `.git`, no scheme/user, `git@host:o/r` ≡ `https://host/o/r`).

- [ ] **Step 1: Tests:** `NormalizeRepoURL` (ssh, https, with `.git`, uppercase); `ReplaceTickets` twice with a ticket missing the second time → it still exists; `GetProject` does not expose the token and `HasToken` is true after `SetConnectorToken`; deleting a workspace with projects → error `ErrNotEmpty`; a migration over a Plan 1 database opens fine.
- [ ] **Step 2: Run** `go test ./internal/hub/store/` → FAIL.
- [ ] **Step 3: Implement** tables `workspaces, projects, project_tokens, checkouts, tickets, session_tickets, proposals` with indexes by `project_id` and unique `(project_id, external_id)`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(hub): model of workspaces, projects, checkouts, tickets and proposals`

---

### Task 5: Checkouts and suggested projects

**Files:**
- Modify: `internal/proto/proto.go` (`SessionInfo.RepoURL, Branch string`; `make proto`), `mod/hooks/register.ts` + `mod/src/link.ts` (send repo and branch: `$.session.repo()` if it exists in the build, otherwise `git -C <root> remote get-url origin` and `git -C <root> branch --show-current` via `$.process.run` with a 3 s timeout), `internal/hub/machines.go`, `internal/hub/projects.go` (new), `internal/hub/projects_test.go`

**Interfaces:**
- Produces: on each `session_upsert` with `RepoURL`, the hub does `UpsertCheckout(machine, root, repoURL, branch)` and, if `NormalizeRepoURL(repoURL)` matches a `Project.RepoURL`, links the checkout to that project. `GET /api/projects/suggestions` → `[{repoURL, roots:[{machine, root}], sessions:int}]` for remotes without a project.
- The session exposes its project: `SessionInfo` in REST/snapshot gains `projectId` (computed by the hub, not by the mod).

- [ ] **Step 1: Tests:** two sessions on two machines with remotes `git@github.com:o/r.git` and `https://github.com/O/r` → one project with two checkouts (Review Focus 5); a remote without a project → appears in suggestions; accepting the suggestion (`POST /api/projects {workspaceId, name, repoURL}`) links the existing checkouts; mod: without `$.session.repo` it falls back to `git` and if that fails it sends empty without error.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** suites → PASS.
- [ ] **Step 5: Commit** `feat: per-machine checkouts and projects suggested by git remote`

---

### Task 6: Connector engine + executable connector + sync

**Files:**
- Create: `internal/hub/connectors/connector.go`, `exec.go`, `sync.go`, `connectors_test.go`, `testdata/fake-connector.sh`
- Modify: `internal/hub/server.go` (starts the syncer)

**Interfaces:**
- Produces:
  - `type Connector interface { List(ctx context.Context, since int64) ([]proto.Ticket, error); Comment(ctx context.Context, externalID, body string) error; SetStatus(ctx context.Context, externalID, status string) error }`
  - `func New(cfg proto.ConnectorConfig, token string, env []string) (Connector, error)` — `kind` → implementation; `none` → error `ErrNoConnector`.
  - **Executable connector protocol** (documented in `docs/connectors.md`): `Settings["command"]` is run (argv split on spaces, no shell) with stdin = one JSON line `{"op":"list"|"comment"|"set_status","since":<ms>,"externalId":"…","body":"…","status":"<normalized>","settings":{…},"token":"…"}`; stdout = JSON `{"tickets":[…]}` (for list, with the fields of `proto.Ticket` and `rawStatus`) or `{"ok":true}`; code ≠ 0 or `{"error":"…"}` = error. Timeout 30 s, stdout ≤ 8 MiB, stderr is attached to the error trimmed to 500 characters.
  - `func StatusMap(raw string, custom map[string]string) string` → normalized (default map: open/todo/backlog→todo; in progress/doing→in_progress; review/in review→in_review; closed/done/resolved→done; blocked→blocked; custom first; unknown → todo).
  - `type Syncer struct` with `Start(ctx)`, `SyncNow(projectID) error`; per project, every `IntervalMin` (default 5): `List` → `ReplaceTickets` → `SetSyncResult("", now)`; error → `SetSyncResult(msg, now)` without touching tickets (Review Focus 2); publishes `project_upsert` and `tickets` over `/api/live`.
  - Connector env: `WHOAS_PROFILE=<workspace.whoasProfile>` if any, plus the hub's environment.
- [ ] **Step 1: Tests** with `testdata/fake-connector.sh` (modes by settings: ok, sleep 60, garbage, exit 1, huge output): list ok → tickets stored and normalized; sleep → timeout error within ≤ 31 s (use a short injectable timeout in the test); garbage → error "invalid connector response"; exit 1 → error with stderr; huge → error "response too large"; error after a good sync → tickets are kept and `SyncError` is set; `StatusMap` default and custom cases.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** + `POST /api/projects/{id}/sync` (202) + `docs/connectors.md` with the protocol and a 30-line bash example.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(hub): connector engine, executable connector and sync`

---

### Task 7: GitHub connector

**Files:**
- Create: `internal/hub/connectors/github.go`, `github_test.go`

**Interfaces:**
- Produces: `kind: "github"`, `Settings{"repo":"owner/name", "labelsAsStatus":"true|false"}`. `List` = `gh api --paginate "repos/<repo>/issues?state=all&since=<ISO>&per_page=100"` (excludes PRs: `pull_request` field), `RawStatus` = `state` + status label if `labelsAsStatus` (labels `en curso|in progress|review|blocked`); comments: the latest 5 via `gh api repos/<repo>/issues/<n>/comments?per_page=5` only for open tickets updated since the last sync. `Comment` = `gh api -X POST …/comments -f body=…`. `SetStatus(done)` = close; `todo` = reopen; other statuses = label. `gh` is run via `exec` (no shell) with the connector's env (whoas). Injectable runner for tests.
- [ ] **Step 1: Tests** with a fake runner returning recorded JSON (hand-written): PRs excluded; `since` in ISO; mapping closed→done, open+label "in progress"→in_progress; `Comment` builds the exact argv `["api","-X","POST","repos/o/r/issues/7/comments","-f","body=hello"]`; `gh` error (exit 1, "HTTP 401") → readable error "GitHub: invalid credentials (check the whoas profile)".
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(hub): GitHub Issues connector via gh`

---

### Task 8: Paperclip connector

**Files:**
- Create: `internal/hub/connectors/paperclip.go`, `paperclip_test.go`

**Interfaces:**
- Produces: `kind: "paperclip"`, `Settings{"baseURL":"…", "companyId":"…", "projectId":"(optional)"}`, connector token (Bearer). `List` = `GET <baseURL>/api/companies/<companyId>/issues` (filter by `projectId` if present; paginate if the API paginates — read `GET <baseURL>/api/openapi.json` in the manual integration test to confirm fields; tests use `httptest` with hand-written responses). Mapping of Paperclip statuses (`todo, in_progress, in_review, done, blocked, cancelled`→done). `Comment` = `POST /api/issues/<id>/comments {body}`; `SetStatus` = `PATCH /api/issues/<id> {status}`.
- [ ] **Step 1: Tests** with `httptest`: Bearer auth sent; status mapping; 401 → "Paperclip: invalid token"; injectable 15 s timeout.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(hub): Paperclip connector`

---

### Task 9: Session ↔ ticket (suggestions, command and confirmation)

**Files:**
- Create: `internal/hub/links.go`, `internal/hub/links_test.go`, `mod/test/ticketcmd.test.ts`
- Modify: `mod/hooks/register.ts` (`/quorum ticket <id>` and `/quorum ticket -` to unlink), `internal/proto/proto.go` (new `KindTicket` with data `{ticket:"<externalId>"}`, empty = unlink; `make proto`)

**Interfaces:**
- Produces:
  - Suggestion: on seeing the `Branch` of a session with a project, the hub looks for `(?i)(?:^|[/_-])(?:gh-|#)?(\d+)(?:[/_-]|$)` and, if there is a ticket with that `ExternalID` in the project, creates `SessionTicket{Confirmed:false}` (suggested). Also on `turn_end` events whose text mentions `#<n>` (suggestion only).
  - `POST /api/sessions/{id}/ticket {ticketId, confirmed:true}` confirms/links; `DELETE /api/sessions/{id}/ticket` unlinks.
  - `ticket` event from the mod (via `/quorum ticket 41`) → the hub links it as confirmed if the ticket exists in the session's project; otherwise it answers with an `info` event "Ticket 41 not found in this project".
  - It is never linked silently: what is suggested shows as a suggestion until the owner confirms (or Claude declares it with the command).
- [ ] **Step 1: Tests:** branches `feat/41-login`, `GH-41`, `fix_41`, `release-2026` (does not suggest 2026 if no ticket 2026 exists), no project → nothing; confirm/unlink; the mod's command emits the right event.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat: link sessions and tickets (suggestion, command and confirmation)`

---

### Task 10: Open a session from a ticket

**Files:**
- Modify: `internal/proto/proto.go` (`LaunchRequest.Prompt string`, `TicketID string`; `make proto`), `internal/daemon/launch/launch.go` (+ tests), `internal/hub/appapi.go` (or `projects.go`) (+ tests)

**Interfaces:**
- Produces: `POST /api/tickets/{id}/launch {machine, checkoutRoot, permissionMode}` → if the ticket has a non-closed linked session → 409 `{"error":"a session is already working on this ticket","session":"<id>"}`; otherwise it builds the prompt `"Ticket <externalId>: <title>\n\n<body (≤ 4000)>\n\nLatest comments:\n<…>\n\nURL: <url>"` and launches with `Prompt`. The launcher passes the prompt as a positional argument of `claude` (quoted with `shellQuote`; on Windows/osascript with the existing escaping) and the session is linked (confirmed) to the ticket when it registers at that `checkoutRoot` within the next 2 min (match by machine+root+pending reqId).
- [ ] **Step 1: Tests:** argv with a prompt containing quotes, `$`, line breaks (the three environments); 409 with a live session; automatic link on registering.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat: open a session from a ticket with its context`

---

### Task 11: Write proposals to the ticket system

**Files:**
- Create: `internal/hub/proposals.go`, `internal/hub/proposals_test.go`

**Interfaces:**
- Produces: on the `turn_end` of a linked (confirmed) session whose `answer` is not empty, the hub creates at most **one** pending `comment` proposal per ticket (if there is already a pending one, it replaces it with the new text) with body `"Progress (Quorum, <machine>):\n<answer trimmed to 1500>"`. `POST /api/proposals/{id}/approve {body?}` (editable body) → connector `Comment`/`SetStatus` → `approved` or `failed` with error; `POST /api/proposals/{id}/reject`. `POST /api/tickets/{id}/proposals {kind:'status', status}` to propose a manual status change. Everything publishes `proposal_upsert` live.
- [ ] **Step 1: Tests:** two `turn_end`s → a single pending one with the latest text; approving calls the fake connector with the edited body; connector failure → `failed` with the message; nothing is written without approval.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(hub): write proposals that the owner approves`

---

### Task 12: Summaries and progress of each project

**Files:**
- Create: `internal/hub/summary/summary.go`, `summary_test.go`
- Modify: `cmd/quorum-hub/main.go` (flags `--ccapi-url`, `--ccapi-token-file`; by default `http://127.0.0.1:18787` and `~/.ccapi/token` if it exists), `internal/hub/server.go`

**Interfaces:**
- Produces: `type Model interface { Complete(ctx, prompt string) (string, error) }` with two implementations: `ccapi` (`POST <url>/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`, model `haiku` (alias ccapi accepts); max_tokens 120; 20 s timeout) and `claudeCLI` (`claude -p --model haiku --output-format text "<prompt>"`, 60 s timeout, via login shell for whoas). Choice: ccapi if it answers `GET /v1/models` with the token; otherwise CLI.
  - `type Summarizer struct` with `Touch(projectID)` (marks a change) and a loop: per touched project, if ≥ 30 min have passed since `SummaryAt` → generate; no activity (neither tickets nor turns) in 7 days → `Summary = "No activity since <date>"` without a model.
  - Prompt (English): project data (tickets by status with titles, live sessions with recap, latest trimmed turn_ends) → "In 1 or 2 sentences (max. 200 characters): where the project stands and what is blocking it." Result trimmed to 200.
  - `Progress{Done, Total}` = tickets `done` / total updated in the last 30 days (or all if the connector gives no dates).
  - `Touch` is called on: sync with changes, `turn_end` of the project's sessions, link changes.
- [ ] **Step 1: Tests:** with a fake `Model`: two `Touch`es within 10 min → one generation; 31 min → another; 7 days of inactivity → fixed text without calling the model; model error → the previous `Summary` is kept; ccapi vs CLI selection with `httptest`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(hub): summary and progress of each project (Haiku via ccapi or claude -p)`

---

### Task 13: Projects API for the app

**Files:**
- Create: `internal/hub/projectapi.go`, `internal/hub/projectapi_test.go`

**Interfaces:**
- Produces (requireDevice, errors in English):
  - `GET/POST /api/workspaces`, `PATCH/DELETE /api/workspaces/{id}`
  - `GET/POST /api/projects` (`?workspace=`), `GET/PATCH/DELETE /api/projects/{id}`, `PUT /api/projects/{id}/token {token}` (204; never returned)
  - `GET /api/projects/{id}/tickets`, `GET /api/tickets/{id}` (includes linked sessions and proposals)
  - `GET /api/projects/suggestions` (Task 5), `POST /api/projects/{id}/sync` (Task 6), `POST /api/tickets/{id}/launch` (Task 10), proposals (Task 11), `POST/DELETE /api/sessions/{id}/ticket` (Task 9)
  - Live: `project_upsert`, `project_gone`, `workspace_upsert`, `tickets` (batch per project), `proposal_upsert`, `session_ticket`; the initial snapshot includes workspaces and projects.
- [ ] **Step 1: Tests** of each route (including that no response contains the token) and of the snapshot envelopes.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(hub): projects, tickets and proposals API`

---

### Task 14: App — projects board

**Files:**
- Create: `app/src/screens/Projects.tsx`, `app/src/screens/Project.tsx`, `app/src/components/{ProjectCard,TicketRow,TicketDetail,ProposalCard,ConnectorForm,WorkspaceForm}.tsx`, tests
- Modify: `app/src/App.tsx` (navigation: Projects | Sessions), `app/src/lib/store.ts` (+ projects state), `app/src/lib/api.ts`

**Interfaces:**
- Produces:
  - **Projects** (initial screen): grouped by workspace; each `ProjectCard` shows name, `done/total` progress bar, summary, live sessions (recap + state with color), "Sync error" if there is one, and how many proposals are pending. At ≥ 1024 px: columns per workspace; on the phone: a list.
  - **Project:** tickets grouped by normalized status (todo, in_progress, in_review, blocked, done collapsed); each `TicketRow` shows the combined status ("in progress · <machine> · working for 12 min" / "ready, waiting for your review"); detail with body, comments, linked sessions, an "Open session" button (machine + checkout) and pending proposals (edit, approve, reject). Link suggestions with "Confirm". "Checkouts" section and "Refresh" button.
  - **Settings:** create/edit workspaces (name, color, whoas profile) and projects (name, repo, connector with its per-kind form, write-only token, interval); project suggestions with "Create project".
  - Sessions: the existing list stays as the second tab and each session shows its project.
- [ ] **Step 1: Tests (vitest + Testing Library):** reducer of projects/tickets/proposals; `ProjectCard` with sync error; `TicketRow` combined status; `ProposalCard` sends the edited body; `ConnectorForm` never preloads the token.
- [ ] **Step 2–4:** FAIL → implement → PASS; `npm run build`.
- [ ] **Step 5: Commit** `feat(app): projects board, tickets and proposals`

---

### Task 15: Functional E2E of Plan 2

**Files:**
- Modify: `docs/e2e-stage1.md` → create `docs/e2e-plan2.md`

- [ ] **Step 1: Write `docs/e2e-plan2.md`** with these steps and their expected result, and run them with the same isolation as the previous e2e (PC WSL + VPS in `~/quorum-e2e`, hub on 127.0.0.1 through an SSH tunnel, isolated `CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_PLUGIN_DIRS`/`TMUX_TMPDIR`; ≤ 12 short prompts with Haiku; clean everything at the end):
  1. Permission requested in a session → appears at once in the terminal (Quorum dialog) and in the app; answering in the terminal → the card disappears; another answered in the app → the tool runs and the terminal dialog has no effect.
  2. Recap: after the first prompt the session changes its name to a short phrase.
  3. Create workspace + project with an **exec** connector (example script from `docs/connectors.md`) → tickets appear normalized.
  4. **GitHub** connector against one of the owner's test repos **read-only** (list issues; do not comment) — if there is no agreed test repo, use `S-kkipie/quorum` itself once created or mark pending.
  5. **Paperclip** connector against the VPS **read-only** (list ACME's issues using the board token without printing it) — do not approve proposals against Paperclip.
  6. Project suggested by git remote → create → existing sessions end up under the project; same repo on PC and VPS → two checkouts.
  7. Branch `feat/<n>-…` → ticket suggestion → confirm in the app.
  8. Open a session from a ticket on the VPS → it starts with the ticket's context and is linked; second attempt → 409 and the app offers going to the existing one.
  9. `turn_end` → pending proposal; approve it against the **exec** connector (which logs to a file) → `approved`; reject another.
  10. The project summary appears (via local ccapi if running; otherwise `claude -p`) and is not regenerated before 30 min.
  11. Broken exec connector (exit 1) → "Sync error" and the tickets are kept.
  12. UI: smoke test with the browser (skill `agent-browser`) of the Projects, Project, Ticket and Settings screens; 3–4 screenshots.
- [ ] **Step 2:** record OK / FAIL→FIXED (commit) / PENDING per step; bugs are fixed with a regression test and a green suite.
- [ ] **Step 3: Commit** `docs: Plan 2 e2e`
