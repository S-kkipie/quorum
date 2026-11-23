# Quorum — Plan 3: sessions and terminal on herdr (phone first)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the phone, in a project: "New session" in one tap, "Resume" a previous conversation and a real terminal. Everything lives in each machine's herdr, and the app navigates by itself to the new session.

**Architecture:**
- `quorumd` talks to the local herdr through its socket, with line-delimited JSON: a new client package, `internal/daemon/herdr`.
- Sessions are born as a new tab in the project's workspace, with `agent.start --kind claude`. If there is no herdr, the current launcher is used.
- Each launch carries a `reqId`. It travels as the environment variable `QUORUM_LAUNCH_REQ` up to the mod, which reports it in `SessionInfo`. That way the hub ties reqId → session and notifies the app (`launch_session`).
- Conversations and terminal go through a hub→daemon RPC over the existing WebSocket.
- Screen snapshots (`term_frame`) are published to the apps without being stored.

**Tech Stack:** same as Plan 2 (Go 1.27 without cgo, `modernc.org/sqlite`, `coder/websocket`, tygo; TS mod with `claude plugin test`; React 19 + Vite + Tailwind v4 + vitest). No new dependencies: the terminal's ANSI render is our own.

**Spec:** `docs/superpowers/specs/2026-11-23-quorum-herdr-sessions-design.md` (including §7.7).

**Adjustments to the spec**, decided when verifying herdr 0.9.5 on this PC:
- herdr has no "screen changed" event: `pane.updated` only fires on title changes. The terminal uses a bounded `pane.read` poll, only while someone is watching.
- The launch is tied by `QUORUM_LAUNCH_REQ`. herdr lets us pass `env` to `tab.create`, and that works the same with and without herdr. The pane (`HERDR_PANE_ID`) is still reported, for "View in terminal".
- The optional config is called `herdrSocket` (socket path) instead of `herdrSession`.
- herdr panes on Linux are interactive shells, not login shells. They load `.bashrc`/`.zshrc`, which is where the whoas shims live on the PC with WSL and on the Linux server, so there is no need to wrap `claude`.

## Global Constraints

- Everything from Plans 1 and 2 stays in force:
  - texts in English (translated in Plan 4, Task 0);
  - no modes;
  - tokens never printed or returned;
  - `claude` never by absolute path;
  - commits authored by `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`.
- herdr: protocol 22 (0.9.5).
  - Default socket `~/.config/herdr/herdr.sock`. It can be changed with `HERDR_SOCKET_PATH` or with `herdrSocket` in `daemon.json`.
  - Requests `{"id","method","params"}\n`. Responses `{"id","result":{...}}` or `{"id","error":{"code","message"}}`.
- A workspace or tab that Quorum did not create is **never** renamed, closed or reordered. Quorum closes only the terminal panes it opened, and only with "Close terminal".
- The phone **never** resizes panes.
- Always "New session": there are no types (feature/bug) or name on launch.
- claude flags:
  - "Skip permissions" → `--dangerously-skip-permissions`;
  - otherwise → `--permission-mode default`;
  - resume → `--resume <id>`.
  - "Skip permissions" is on by default and disabled if the machine runs as root (`os.Geteuid()==0`), with the reason `"Skip permissions does not work as root"`.
- `term_frame`:
  - only while someone is watching (15 s lease that the app renews every 5 s);
  - ≤ 8 per second per pane (`pane.read` poll every 125 ms; only sent if the text changed);
  - ≤ 256 KiB (if exceeded, lines from the start are trimmed);
  - droppable in the daemon's queue (`emit(..., droppable=true)`);
  - never stored in the database.
- Launched session's environment: `QUORUM_LAUNCH_REQ=<reqId>`. In herdr it goes as `env` of `tab.create`/`workspace.create`; in tmux/wt/osascript, as a prefix of the shell line.
- Navigation after launching: 60 s timeout. After that: `"Claude did not register within 60 s"` and, if there is a pane, the "View in terminal" button.
- Allowed keys (herdr names): `esc tab enter ctrl+c ctrl+d ctrl+l up down left right`. Anything else → 400.
- Conversations:
  - max 60, most recent first;
  - title: `custom-title` > `ai-title` > `summary` > the user's first prompt (trimmed to 80 runes);
  - folder `~/.claude/projects/<root with every non-[A-Za-z0-9] character changed to '-'>`.

## Review Focus

1. **The owner closes the pane in his herdr while the phone watches the terminal** → the daemon sends `term_closed`; the app shows "Terminal closed" with an "Open another" button and never leaves a frozen snapshot as if it were live. Test in Task 6 (daemon) and Task 10 (app).
2. **Double tap on "New session"** → a single session: the button stays disabled while a launch of that project is pending. Test in Task 9.
3. **Folder or project name with spaces, quotes or `;`** → reaches herdr intact: it goes as JSON, never through a shell. In the fallback it is quoted as today. Test in Task 3.
4. **"Resume" where Claude changes the session id** → the app navigates anyway, because it ties by `launchReq` and not by id. Test in Task 5.
5. **herdr down or uninstalled after `quorumd` starts:**
   - the next launch uses the fallback, without error;
   - the app stops offering "Terminal" within ≤ 30 s, because capabilities are re-evaluated every 30 s and sent if they change.

   Test in Task 4.

---

### Task 1: Protocol and machine capabilities

**Files:**
- Modify: `internal/proto/proto.go`, `mod/src/proto.gen.ts` + `app/src/proto.gen.ts` (with `make proto`)
- Modify: `internal/hub/store/store.go`, `internal/hub/store/migrations.go`, `internal/hub/machines.go`
- Modify: `app/src/lib/api.ts` (`Machine` interface)
- Test: `internal/hub/store/store_test.go`, `internal/hub/machines_test.go`

**Interfaces — Produces:**
- `proto.MachineCaps{Herdr bool "herdr"; Terminal bool "terminal"; Root bool "root"}`.
- `proto.MachineHello.Caps MachineCaps "caps"`.
- `store.Machine.Caps proto.MachineCaps "caps"` (column `caps TEXT NOT NULL DEFAULT '{}'`, migration with `ALTER TABLE` like those of `sessions`).
- `(*store.Store).UpsertMachine(name, os, env, version string, online bool, caps proto.MachineCaps) error`.
- `(*store.Store).SetMachineCaps(name string, caps proto.MachineCaps) error`.
- `proto.SessionInfo` gains `LaunchReq string "launchReq"`, `HerdrPane string "herdrPane"` and `HerdrWorkspace string "herdrWorkspace"`.
- `proto.LaunchRequest` gains:
  - `Resume string "resume"`: the Claude session id;
  - `Label string "label"`: the project's name, for the new workspace;
  - `Trust bool "trust"`.
- `proto.LaunchResult` gains `Pane string "pane"` and `Via string "via"` (`herdr|tmux|wt|osascript`).
- `proto.Conversation{ID, Title, FirstPrompt string; Messages int; UpdatedAt int64; Open bool}`. JSON tags: `id title firstPrompt messages updatedAt open`.
- `proto.RPC{ReqID string "reqId"; Method string "method"; Params json.RawMessage "params"}`.
- `proto.RPCResult{ReqID string "reqId"; Result json.RawMessage "result"; Error string "error"}`.
- `proto.TermFrame{Pane string "pane"; Cols, Rows int; ANSI string "ansi"; Closed bool "closed"}`. Tags `cols`, `rows`.
- Document the new types in the `Envelope` comment:
  - `caps` (daemon→hub: Payload `MachineCaps`);
  - `rpc` / `rpc_result` (hub↔daemon);
  - `term_frame` (daemon→hub→app);
  - `launch_session` (hub→app: Payload `{reqId, sessionId}`).
- Hub:
  - `onHello` stores `hello.Caps`;
  - the `caps` message from a connected machine calls `SetMachineCaps` and `publishStatus`;
  - `machine_status` already serializes `store.Machine`, so it carries `caps`.

- [ ] **Step 1: Failing tests.**
  - `TestMachineCapsRoundTrip`: `UpsertMachine(..., MachineCaps{Herdr:true,Terminal:true})` and then `ListMachines()[0].Caps.Herdr == true`. A database created without the column migrates with `{}`.
  - `TestHelloAndCapsUpdatePublishStatus`: with `machines_test.go`'s `newFixture`, a hello with `Caps.Herdr=true` publishes a `machine_status` with `caps.herdr=true`. A later `caps` with `Herdr=false` publishes another with `false`.
- [ ] **Step 2:** `go test ./internal/hub/...`. Expected: FAIL (nonexistent fields).
- [ ] **Step 3:** Implement what is under Produces and adapt the existing calls to `UpsertMachine` (including tests). Run `make proto` and add `caps: { herdr: boolean; terminal: boolean; root: boolean }` to `Machine` in `app/src/lib/api.ts`.
- [ ] **Step 4:** `go test ./... && cd app && npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit `proto: machine capabilities, launchReq/herdrPane, conversations, rpc and term_frame`.

### Task 2: herdr client and a fake herdr for tests

**Files:**
- Create: `internal/daemon/herdr/client.go`, `internal/daemon/herdr/herdrtest/fake.go`
- Test: `internal/daemon/herdr/client_test.go`

**Interfaces — Produces:**
- `type Client struct{ Socket string }`.
- `func SocketPath(override string) string`: override > `$HERDR_SOCKET_PATH` > `~/.config/herdr/herdr.sock`.
- `func (c *Client) Available(ctx) bool`: the socket exists and `workspace.list` answers in < 1 s.
- `func (c *Client) Call(ctx, method string, params, out any) error`: one connection per call. Reads one line and deserializes `result` into `out`. A server `error` becomes `*Error{Code, Message string}`.
- Types:
  - `Workspace{ID "workspace_id", Label, Focused bool, Number int}`;
  - `Pane{ID "pane_id", WorkspaceID "workspace_id", TabID "tab_id", Cwd, Focused bool, Agent string, AgentSession *struct{Value string}}`.
- Methods:
  - `ListWorkspaces(ctx) ([]Workspace, error)`;
  - `ListPanes(ctx, workspaceID string) ([]Pane, error)`;
  - `CreateWorkspace(ctx, cwd, label string, env map[string]string) (wsID, rootPane string, err error)`;
  - `CreateTab(ctx, wsID, cwd, label string, env map[string]string) (rootPane string, err error)`;
  - `StartAgent(ctx, name, kind, pane string, args []string, timeoutMs int) error`;
  - `ReadPane(ctx, pane, source string, lines int) (text string, err error)`: always `format:"ansi"` and `strip_ansi:false`;
  - `PaneSize(ctx, pane string) (cols, rows int, err error)`: the pane's rect in `pane.layout`;
  - `SendText`, `SendKeys(ctx, pane string, keys []string)`, `ClosePane(ctx, pane string) error`.
- The response shapes are verified on this PC:
  - `workspace.list` → `result.workspaces[]`;
  - `pane.list` → `result.panes[]`;
  - `pane.read` → `result.read.text`;
  - `pane.layout` → `result.layout.panes[].rect.{width,height}`;
  - `workspace.create` → `result.workspace.workspace_id` and `result.root_pane.pane_id`;
  - `tab.create` → `result.root_pane.pane_id`.
- `herdrtest.New(t) *Fake`: listens on a temporary unix socket. `Fake.Socket`. `Fake.Handle(method string, fn func(params json.RawMessage) (result any, errCode string))`. `Fake.Calls() []Call{Method string; Params json.RawMessage}`.

- [ ] **Step 1: Failing tests.**
  - `TestCallDecodesResult`.
  - `TestCallServerError`: the fake answers code `not_found`, and `errors.As` gives `*Error` with `Code=="not_found"`.
  - `TestCreateTabSendsEnvAndCwd`: with cwd `/tmp/a b;c` and env `{QUORUM_LAUNCH_REQ:"r1"}`, the fake receives those exact params.
  - `TestAvailableFalseWithoutSocket`.
- [ ] **Step 2:** `go test ./internal/daemon/herdr/...`. Expected: FAIL.
- [ ] **Step 3:** Implement. Deadline per call: the ctx's, with 10 s by default if it has none. `StartAgent` uses `timeout_ms` + 5 s.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `daemon: herdr socket client`.

### Task 3: Launch in herdr (and fallback with reqId, resume, trust)

**Files:**
- Create: `internal/daemon/launch/herdr.go`, `internal/daemon/launch/trust.go`
- Modify: `internal/daemon/launch/launch.go`
- Test: `internal/daemon/launch/herdr_test.go`, `internal/daemon/launch/trust_test.go`, `internal/daemon/launch/launch_test.go`

**Interfaces:**
- Consumes: `herdr.Client` (Task 2).
- Produces:
  - `type Workspaces struct{ Path string }`: memory `root → workspaceID` in `<ConfigDir>/herdr-workspaces.json`, with atomic writes. Methods `Get(root) string` and `Set(root, id string) error`.
  - `func ResolveWorkspace(ctx, c *herdr.Client, ws *Workspaces, root, label string, env map[string]string) (wsID, freshPane string, err error)`: steps 3a–3c of the algorithm. `freshPane` is not empty only if it created the workspace. Task 6 reuses it for the terminal.
  - `func RunHerdr(ctx, c *herdr.Client, ws *Workspaces, req proto.LaunchRequest) proto.LaunchResult`.
  - `func TrustDir(home, dir string) error`.
  - `claudeArgs` adds `--resume <id>` (with `Resume` validated against `^[0-9a-fA-F-]{8,64}$`; if it does not validate, error `"invalid conversation id"`).
  - `claudeLine` prefixes `QUORUM_LAUNCH_REQ=<sanitized [A-Za-z0-9] reqId> `.
  - `Run` rejects `PermissionMode=="bypass"` when `geteuid()==0`, with the text from Global Constraints (`geteuid` is a variable for tests).

**`RunHerdr` algorithm, order matters:**
1. Validate like `Run`: mode, absolute path, folder exists, root.
2. If `req.Trust`, call `TrustDir`. If it fails, log it and carry on.
3. Choose the workspace:
   - (a) `ws.Get(root)`, if it is still in `ListWorkspaces`;
   - (b) otherwise, among the panes of `ListPanes("")` whose `Cwd == root`, the focused workspace or, if none, the one with the lowest `Number`;
   - (c) otherwise, `CreateWorkspace(root, label, env)`. `label` is `req.Label` or the basename. Its root pane **is** the session's, without an extra tab.
4. In (a) and (b): `CreateTab(wsID, root, "claude", env)`. `env = {QUORUM_LAUNCH_REQ: reqId}`. Save `ws.Set(root, wsID)`.
5. `StartAgent("q"+suffix(reqId), "claude", pane, args, 60000)`. An `agent_not_ready` error counts as OK: Claude ended up at a startup dialog and the app will offer "View in terminal". Any other error → `OK=false` with the message.
6. Result: `OK`, `Pane=pane`, `Via="herdr"`.

**`TrustDir`:**
- Reads `<home>/.claude.json`. If `projects[dir].hasTrustDialogAccepted` is already true, it writes nothing.
- Otherwise it sets it to true (creating the entry if missing) and writes with tmp + rename in the same directory and the same file mode.
- Before renaming, if the mtime changed since the read, it retries up to 3 times.
- It never deletes or reorders other keys: it uses `map[string]json.RawMessage`.

- [ ] **Step 1: Failing tests**, using `herdrtest.Fake`:
  - `TestRunHerdrReusesRememberedWorkspace`: creates a tab with env and cwd and calls `agent.start` with args `["--dangerously-skip-permissions"]` for `PermissionMode:"bypass"`.
  - `TestRunHerdrPicksWorkspaceByCwd`.
  - `TestRunHerdrCreatesWorkspaceAndUsesItsRootPane`: there is no `tab.create`; the label is `req.Label`.
  - `TestRunHerdrResumeArgs`: `["--permission-mode","default","--resume","<id>"]`.
  - `TestRunHerdrAgentNotReadyIsOK`.
  - `TestRunHerdrOddPath`: root `/tmp/x "y";z` arrives unchanged in the params.
  - `TestTrustDirPreservesOtherKeys`.
  - `TestTrustDirNoopWhenTrusted`: the mtime does not change.
  - `TestClaudeLineCarriesLaunchReq`.
  - `TestBypassRejectedAsRoot`.
- [ ] **Step 2:** `go test ./internal/daemon/launch/...`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `daemon: launch sessions in herdr; resume; trust folder; reqId in the environment`.

### Task 4: Daemon — choose launcher, capabilities and RPC

**Files:**
- Modify: `internal/daemon/config.go`, `internal/daemon/hublink.go`, `internal/daemon/run.go`
- Create: `internal/daemon/rpc.go`
- Test: `internal/daemon/hublink_test.go`, `internal/daemon/rpc_test.go`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  - `Config` gains `HerdrSocket string "herdrSocket"` and `Terminal *bool "terminal"`. `nil` equals true; helper `cfg.TerminalOn() bool`.
  - `type Host struct{ Herdr *herdr.Client; WS *launch.Workspaces; TerminalOn bool }`. Created in `Serve` and passed to `RunHubLink` (signature changes: `RunHubLink(ctx, cfg, reg, host *Host)`).
  - `func (h *Host) Caps(ctx) proto.MachineCaps`: `Herdr` is `Available()`, `Terminal` is `Herdr && TerminalOn`, `Root` is `geteuid()==0`.
  - The hello carries `Caps`. While the link lives, a 30 s ticker recomputes `Caps` and, if it changed, emits the `caps` envelope.
  - In `readLoop`, `launch` uses `launch.RunHerdr` if `host.Herdr.Available()`; otherwise `launch.Run`. If `RunHerdr` fails because herdr does not respond (a connection error, not a herdr error), it retries with `launch.Run`.
  - `rpc`: `go handleRPC(ctx, host, reg, env)` answers `rpc_result` with the same `reqId`. It dispatches by `Method` to `rpcHandlers map[string]func(ctx, *Host, json.RawMessage) (any, error)`, which are filled in Tasks 5 and 6. An unknown method gives the error `"unknown method"`.

- [ ] **Step 1: Failing tests.**
  - `TestHelloCarriesCaps`: with an available herdr fake, `caps.herdr=true` and `terminal=true`.
  - `TestCapsReemittedOnChange`: the fake is closed, the ticker is shortened (variable `capsEvery`) and `caps` arrives with `herdr=false`.
  - `TestLaunchPrefersHerdr`: `launchRun` is not called and the `launch_result` carries `via:"herdr"`.
  - `TestLaunchFallsBackWithoutHerdr`.
  - `TestRPCUnknownMethod`.
- [ ] **Step 2:** `go test ./internal/daemon/...`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `daemon: herdr as the default launcher, capabilities and rpc`.

### Task 5: Mod reports reqId/pane and the hub ties the launch to the session

**Files:**
- Modify: `mod/hooks/register.ts`, `mod/.claude-plugin/plugin.json` (version `0.1.2`) and `.claude-plugin/marketplace.json` if it repeats the version
- Modify: `internal/hub/ticketlaunch.go`, `internal/hub/appapi.go`, `internal/hub/machines.go`
- Test: `mod/test/register.test.ts`, `internal/hub/ticketlaunch_test.go`, `internal/hub/appapi_test.go`

**Interfaces — Produces:**
- Mod: `link.start` sends `launchReq`, `herdrPane` and `herdrWorkspace`, read with `optional(() => $.env.get('QUORUM_LAUNCH_REQ' | 'HERDR_PANE_ID' | 'HERDR_WORKSPACE_ID'), '')`.
- Hub:
  - `pendingLaunch` gains `reqID string`; `ticketID` becomes optional.
  - `addPending` deduplicates by ticket only if `ticketID != ""`.
  - `matchPending(si)`:
    - first looks for an exact match `si.LaunchReq == reqID` on the same machine (also valid for sessions with `PreviousID` applied and for already existing ones);
    - if there is none, it applies the current rule by folder, **only** for pending ones with a ticket.
    - On consuming: if it has a ticket, `confirmLink` as today. **Always** publishes `launch_session {reqId, sessionId}`.
  - `matchPending` is now called on every `session_upsert` with `LaunchReq != ""`, not only on new sessions. A pending one is consumed only once.
  - `POST /api/launch`:
    - body `{machine, dir, permissionMode, resume, label, projectId}`;
    - if `projectId` is given and `label` is not, the label is the project's name;
    - `trust` is always true;
    - registers `addPending(reqId, pendingLaunch{machine, root: dir})`;
    - responds `{reqId}`.
  - `handleTicketLaunch` also passes `Trust:true` and `Label`.

- [ ] **Step 1: Failing tests.**
  - Mod: `register sends launchReq and herdr pane from env`.
  - Hub, `TestLaunchSessionPublishedByLaunchReq`: `POST /api/launch` and then a `session_upsert` with an equal `launchReq` → `launch_session{reqId, sessionId}` is published.
  - Hub, `TestLaunchSessionAfterIDChange`: the first session with `launchReq` already existed with another id; it is still published only once. A second upsert does not publish again.
  - Hub, `TestTicketLaunchStillLinksByReq`.
  - Hub: the by-folder rule stays the same for the earlier ticket launches (the existing tests keep passing).
- [ ] **Step 2:** `claude plugin test mod && go test ./internal/hub/...`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `make test`. Expected: PASS.
- [ ] **Step 5:** Commit `hub+mod: tie each launch to its session (launch_session)`.

### Task 6: Daemon — conversations and terminal

**Files:**
- Create: `internal/daemon/convos/convos.go`, `internal/daemon/terminal.go`
- Modify: `internal/daemon/rpc.go` (register the methods)
- Test: `internal/daemon/convos/convos_test.go` (with JSONL testdata), `internal/daemon/terminal_test.go`

**Interfaces:**
- Consumes: Tasks 2 and 4; `Registry.Snapshot()` to know which sessions are live.
- Produces:
  - `convos.Dir(home, root string) string`.
  - `convos.List(dir string, live map[string]bool, max int) ([]proto.Conversation, error)`. If the folder does not exist → `[]` without error. Sorts by mtime and takes `max`.
    - Reads each `.jsonl`, up to 200 MiB; lines over 1 MiB are skipped.
    - Counts the `type` `user`/`assistant` lines that have text.
    - The title follows the precedence in Global Constraints.
    - `FirstPrompt`: the first `user` whose content is a string and is not synthetic. Reuses the `transcript.skipUserText` criterion, exporting it as `transcript.SkipUserText`.
    - In-memory cache by `(path, size, mtime)`.
  - RPC methods (params → result):
    - `conversations` `{root}` → `[]Conversation`.
    - `term_open` `{root, label, new bool}` → `{pane, cols, rows}`:
      - reuses that root's remembered terminal pane if it is still in `ListPanes` and `new` is false;
      - otherwise, `launch.ResolveWorkspace(..., root, label, nil)`: if it returned `freshPane`, that is the pane; if not, it creates `CreateTab(ws, root, "terminal", nil)`;
      - remembers `root → pane` in `<ConfigDir>/herdr-terminals.json`.
    - `term_watch` `{pane}` → `{}`: starts or renews a 15 s lease.
    - `term_input` `{pane, text, keys []string}` → `{}`: `text` → `SendText`; `keys` (validated against the list in Global Constraints) → `SendKeys`.
    - `term_read` `{pane, lines}` → `{ansi}`: `source:"recent"`, `lines` capped to 2000.
    - `term_close` `{pane}` → `{}`: only closes panes that **Quorum** opened (those in `herdr-terminals.json`). Any other → error `"Quorum only closes terminals it opened"`.
    - All `term_*` → error `"terminal is disabled on this machine"` if `!host.TerminalOn` or there is no herdr.
  - The watcher is a goroutine per pane while the lease is valid:
    - every 125 ms, `ReadPane(visible)`;
    - every 2 s, `PaneSize`;
    - if the text or the size change, emits a droppable `term_frame`;
    - if `ReadPane` returns `not_found`, emits `term_frame{Closed:true}` and ends;
    - if the lease expires, ends.
  - Bounds: the intervals (`termPoll`, `termSize`, `termLease`) are variables for tests. Trimmed to 256 KiB from the start, at a line boundary.

- [ ] **Step 1: Failing tests.**
  - `TestListTitlesAndOrder`: testdata with ai-title, custom-title, summary, prompt only and a synthetic `<command-name>`.
  - `TestListMissingDirEmpty`.
  - `TestListMarksOpen`.
  - `TestDirEncoding`: `/home/u/work/proj-x` → `-home-u-work-proj-x`; `/a/b.c_d` → `-a-b-c-d`.
  - `TestTermOpenReuses`.
  - `TestTermOpenNewCreatesTab`.
  - `TestTermWatchEmitsOnlyOnChange`: the fake returns the same text 3 times and then another, and 2 frames arrive.
  - `TestTermWatchClosed`.
  - `TestTermWatchLeaseExpires`.
  - `TestTermFrameTruncated`: 300 KiB → ≤ 256 KiB and keeps the end.
  - `TestTermInputRejectsUnknownKey`.
  - `TestTermCloseOnlyOwn`.
  - `TestTermDisabled`.
- [ ] **Step 2:** `go test ./internal/daemon/...`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `daemon: previous conversations and terminal on herdr`.

### Task 7: Hub — RPC, conversations, terminal, frames and audit

**Files:**
- Create: `internal/hub/rpc.go`, `internal/hub/terminalapi.go`
- Modify: `internal/hub/machines.go` (`rpc_result`, `term_frame` messages), `internal/hub/appapi.go` (routes), `internal/hub/store/migrations.go`, `internal/hub/store/store.go`
- Test: `internal/hub/terminalapi_test.go`

**Interfaces:**
- Consumes: the RPC methods of Task 6.
- Produces:
  - `func (h *Hub) call(ctx, machine, method string, params any, out any) error`:
    - random `reqId`; waits for `rpc_result` in a waiters map with a 10 s timeout;
    - disconnected machine → `errOffline`;
    - a non-empty `Error` comes back as an error with that text.
  - Routes (all `dev(...)`; `{pane}` arrives with `:` unencoded or encoded, and `r.PathValue` is used):
    - `GET /api/machines/{m}/conversations?root=` → `[]Conversation`;
    - `POST /api/machines/{m}/terminals` `{root, label, new}` → `{pane, cols, rows}` and audit `open`;
    - `POST /api/machines/{m}/terminals/{pane}/watch` → 204;
    - `POST /api/machines/{m}/terminals/{pane}/input` `{text, keys}` → 204;
    - `GET /api/machines/{m}/terminals/{pane}/read?lines=` → `{ansi}`;
    - `DELETE /api/machines/{m}/terminals/{pane}` → 204 and audit `close`.
  - Error codes:
    - offline → 409 `"machine is offline"`;
    - daemon error → 409 with its text;
    - timeout → 504 `"machine did not respond"`.
  - `term_frame` from the machine → `h.publish` as is, with `Machine` = the authenticated name. It is not stored.
  - `rpc_result` → wakes the waiter and is not broadcast.
  - Table `terminal_audit(id INTEGER PRIMARY KEY, at INTEGER, device TEXT, machine TEXT, pane TEXT, action TEXT)`.
  - `(*store.Store).AuditTerminal(device, machine, pane, action string) error`. The device comes from `AuthName(r.Context())`.

- [ ] **Step 1: Failing tests.** Use the fake machine fixture (`newFixture` + `sendHello`) answering `rpc`:
  - `TestConversationsProxied`.
  - `TestRPCTimeout504`: with `rpcTimeout` as a variable.
  - `TestTerminalOpenAudited`: there is an `open` row with the device.
  - `TestTermFrameRelayedNotStored`: there is no event in the database.
  - `TestTerminalOffline409`.
  - `TestRPCResultFromOtherMachineIgnored`: a `reqId` from another machine does not wake the waiter.
- [ ] **Step 2:** `go test ./internal/hub/...`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `hub: rpc to machines, conversations and terminal with audit`.

### Task 8: App — API, per-project preferences and "Starting…"

**Files:**
- Modify: `app/src/lib/api.ts`, `app/src/App.tsx`, `app/src/components/LaunchDialog.tsx`, `app/src/components/TicketDetail.tsx`
- Create: `app/src/lib/launch.ts`, `app/src/screens/Starting.tsx`
- Test: `app/src/lib/launch.test.ts`, `app/src/App.test.tsx`

**Interfaces — Produces:**
- api:
  - `launch(b: {machine; dir; permissionMode?; resume?; label?; projectId?}): Promise<{reqId}>`;
  - `listConversations(machine, root): Promise<Conversation[]>`;
  - `openTerminal(machine, root, label, fresh=false): Promise<{pane; cols; rows}>`;
  - `watchTerminal(machine, pane)`;
  - `sendTerminal(machine, pane, {text?, keys?})`;
  - `readTerminal(machine, pane, lines): Promise<{ansi}>`;
  - `closeTerminal(machine, pane)`.
  - All encode `pane` with `encodeURIComponent`.
- `launch.ts`:
  - `loadPrefs(projectId): {machine?: string; bypass: boolean}`, with `bypass` true by default. `savePrefs(projectId, p)` uses the key `quorum.launch.<projectId>`.
  - `type Pending = {reqId; machine; label; startedAt; pane?; error?}`.
  - `pendingReducer(p: Pending|null, env: Envelope, now: number): {pending: Pending|null; open?: string}`:
    - `launch_session` with the same reqId → `open = sessionId`, `pending = null`;
    - `launch_result` with `!ok` → `error`;
    - `launch_result` with `ok` → saves `pane`.
  - `timedOut(p, now)` is `now - p.startedAt > 60000`.
- App: new navigation state `starting: true` and `Pending` in the state. When `open` arrives, `openSession(id)` replaces the "Starting…" history entry (`go(..., true)`).
- `Starting.tsx`:
  - shows "Starting Claude on <machine>…";
  - if there is an error, shows it with the "Back" button;
  - on timeout, shows "Claude did not register within 60 s" and "View in terminal" if there is a `pane`, which opens Task 10's Terminal on that pane.
- `LaunchDialog` and launching from a ticket move to this flow: navigate to "Starting…" instead of "It will appear in the list".

- [ ] **Step 1: Failing tests.**
  - `pendingReducer opens session on launch_session`.
  - `ignores other reqId`.
  - `keeps pane from launch_result`.
  - `timedOut after 60s`.
  - `prefs default bypass true and persist machine`.
  - App: with a fake live, launching from LaunchDialog shows "Starting Claude on vps-1…", and a `launch_session` opens the session.
- [ ] **Step 2:** `cd app && npx vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cd app && npx vitest run && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `app: launch and navigate by itself to the new session`.

### Task 9: App — project screen: New session, Terminal, Conversations

**Files:**
- Create: `app/src/components/NewSessionCard.tsx`, `app/src/components/Conversations.tsx`
- Modify: `app/src/screens/Project.tsx`, `app/src/screens/Session.tsx`
- Test: `app/src/components/NewSessionCard.test.tsx`, `app/src/components/Conversations.test.tsx`

**Interfaces:**
- Consumes: Task 8 (`launch`, `loadPrefs`/`savePrefs`, `listConversations`, App's `Pending`).
- Produces:
  - `NewSessionCard({state, projectId, pending: boolean, onLaunched(reqId, machine, label), onTerminal(machine, root)})`:
    - **Candidate machines:** the project's checkouts (`projectCheckouts`). The machine chip shows the chosen one: first the one from the preferences if it is online; otherwise the first online one. The selector is native.
    - **"Skip permissions":** checkbox with the preferences' value. It is disabled, with the reason, if `machines[m].caps.root`.
    - **Big "New session" button:** disabled if `pending` or there is no online machine. Launches with `dir = checkout.root`, `permissionMode = bypass ? 'bypass' : 'default'` and `projectId`. Saves the preferences.
    - **"Terminal":** only if `caps.terminal`; otherwise it shows the text "Terminal not available on this machine (herdr missing)".
    - **No checkouts:** the text "This project has no folder on any machine yet" and an "Another folder…" link that opens the LaunchDialog.
  - `Conversations({machine, root, liveIds, onOpen(sessionId), onResume(convId)})`:
    - loads `listConversations`;
    - shows 6, and "See all (n)" expands them with a title search box;
    - each row: title, `since(updatedAt)` and `· N msgs`;
    - an open conversation carries the green dot and opens the session;
    - a closed one calls `onResume`, which launches with `resume`.
  - Order in `Project.tsx`: card, Open sessions, Conversations and then the existing stuff (suggestions, tickets, checkouts).
  - In `Session.tsx`'s header, a `⋯` menu with:
    - "New session here": launches on the session's `machine` + `root` with its project's preferences;
    - "View in terminal": only if `herdrPane` and `caps.terminal`; opens the Terminal on that pane.

- [ ] **Step 1: Failing tests.**
  - `NewSessionCard`: one tap calls `launch` with `{machine:'vps-1', dir:'/srv/repo', permissionMode:'bypass', projectId}`; it is disabled with `pending`; with `root` it shows "Skip permissions" disabled and the reason; without terminal it shows the herdr-missing text.
  - `Conversations`: shows 6 of 10 and "See all (10)"; an open one calls `onOpen`, a closed one `onResume(id)`; with an empty list it shows "No previous conversations on this machine".
- [ ] **Step 2:** `cd app && npx vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement with the current style (Tailwind, zinc, `rounded` buttons). The big button takes the full width and is ≥ 48 px tall (a thumb).
- [ ] **Step 4:** `cd app && npx vitest run && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `app: new session, terminal and conversations in the project`.

### Task 10: App — Terminal screen

**Files:**
- Create: `app/src/lib/ansi.ts`, `app/src/lib/frames.ts`, `app/src/screens/Terminal.tsx`
- Modify: `app/src/App.tsx` (nav `terminal: {machine, pane, root?}` and dispatch of `term_frame` to `frames`)
- Test: `app/src/lib/ansi.test.ts`, `app/src/lib/frames.test.ts`, `app/src/screens/Terminal.test.tsx`

**Interfaces — Produces:**
- `ansi.ts`:
  - `type Span = {text: string; fg?: string; bg?: string; bold?; dim?; italic?; underline?; inverse?}`;
  - `parseAnsi(s: string): Span[][]`: one list per line. Splits on `\r\n`/`\n` and ignores lone `\r`.
  - Supported SGR: 0, 1, 2, 3, 4, 7, 22, 23, 24, 27, 30–37, 39, 40–47, 49, 90–97, 100–107, `38;5;n`, `48;5;n`, `38;2;r;g;b` and `48;2;r;g;b`.
  - Non-SGR sequences are discarded.
  - xterm 256-color palette.
- `frames.ts`:
  - `frames.set(machine, pane, f: TermFrame)`;
  - `frames.get(machine, pane)`;
  - `frames.subscribe(key, fn) → unsubscribe`;
  - keeps only the latest snapshot per key.
- `Terminal({machine, pane, root?, label?, onBack})`:
  - while mounted, `watchTerminal` every 5 s;
  - draws the latest snapshot with `parseAnsi` in a monospaced `<pre>`;
  - font = `clamp(8, 15, containerWidth / (cols * 0.6))` px, with `A−`/`A+` buttons (±1 px) and horizontal scroll;
  - key bar: `Esc Tab Ctrl-C ↑ ↓ ← → Ctrl-D Ctrl-L`;
  - text field + `⏎`, which sends `{text}` and then `{keys:['enter']}`; if the field is empty, `⏎` only sends Enter;
  - "History" switches to a static view with `readTerminal(…, 400)`, and "Live" goes back;
  - with `Closed`, shows "Terminal closed" with "Open another" (`openTerminal(machine, root, label, true)`) if there is a `root`;
  - the `⋯` menu has "Close terminal", with `confirm`, which calls `closeTerminal` and goes back;
  - with no frames in 3 s it shows "Connecting to the terminal…".
- Entry from the card: `onTerminal` calls `openTerminal(machine, root, label)` and navigates with the returned `pane`.

- [ ] **Step 1: Failing tests.**
  - `parseAnsi`: 8, 256 and truecolor colors, reset, bold and inverse; a string with `\x1b[2J\x1b[H` discards them; the real example's text (`\u001b[1m\u001b[38;5;2muser@host \u001b[0m…`) gives spans with `bold` and the color of index 2.
  - `frames keeps only latest`.
  - Terminal:
    - a snapshot is shown;
    - tapping `Ctrl-C` calls `sendTerminal` with `{keys:['ctrl+c']}`;
    - typing `ls` + `⏎` sends text and then enter;
    - `Closed` shows "Terminal closed";
    - it renews `watch` at 5 s (fake timers).
- [ ] **Step 2:** `cd app && npx vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cd app && npx vitest run && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `app: live terminal on herdr`.

### Task 11: herdr installation, deployment and real e2e from the phone

**Files:**
- Create: `scripts/install-herdr.sh`, `docs/e2e-plan3.md`
- Modify: `README.md` (herdr section), `scripts/install-daemon.sh` (warning if herdr is missing)

**`install-herdr.sh` (idempotent, POSIX sh, no root):**
- If `herdr` is missing from PATH and from `~/.local/bin`, it installs it with `curl -fsSL https://herdr.dev/install.sh | sh`. Then it requires `herdr --version` ≥ 0.9.5.
- `herdr integration install claude`, if `~/.claude` exists.
- If the default socket already answers (for example, the owner's herdr on his PC), it **touches nothing else** and says so.
- Otherwise, it creates `~/.config/systemd/user/herdr-server.service`:
  - `ExecStart=%h/.local/bin/herdr server`;
  - `Restart=on-failure`;
  - `Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin`.
  - Then `systemctl --user daemon-reload && systemctl --user enable --now herdr-server`.
  - Warns if `loginctl show-user $USER -p Linger` is not `yes`. It does not enable it by itself.
- It only touches `~/.local/bin`, `~/.config/systemd/user/herdr-server.service` and whatever `herdr integration` writes.

- [ ] **Step 1:** `sh -n scripts/install-herdr.sh` and `shellcheck` if available. Expected: no errors.
- [ ] **Step 2:** `make test && make cross`. Expected: PASS.
- [ ] **Step 3: Deploy.**
  - **arm64 Linux server**, with its service user, touching nothing outside what is ours:
    - run `install-herdr.sh`;
    - update the `quorum-hub` and `quorumd` binary and restart their user services;
    - `claude plugin update quorum@quorum`.
  - **The PC with WSL:** update `quorumd` and the plugin. The owner's herdr is not touched.
  - Verify that in a herdr pane on the server, `command -v claude` resolves as in an interactive shell of the owner (whoas through `.bashrc`).
- [ ] **Step 4: e2e with agent-browser (`abw`) in a phone viewport (390×844) against the hub URL.** Save evidence and results in `docs/e2e-plan3.md`, sanitized like the previous ones, with no internal data. Cases:
  1. A server project → "New session" (server, Skip permissions):
     - the app moves to "Starting…" and opens the chat by itself;
     - the server's `herdr pane list` shows a new tab in the project's workspace, with Claude and `--dangerously-skip-permissions`;
     - a prompt from the phone gets an answer.
  2. "Resume" a closed conversation → opens in a new tab and the app navigates to it.
  3. "Terminal": the screen is visible. With `git status` + `⏎` the output appears. Ctrl-C works. Closing the view and coming back reuses the same pane.
  4. Close the terminal pane from herdr on the server → the app shows "Terminal closed".
  5. The PC with WSL (owner's herdr): "New session" in a project shows up as a tab in the owner's already existing workspace for that folder, without renaming it.
  6. Quick double tap on "New session" → a single session.

  When done: close the test sessions and tabs that Quorum opened, with `herdr tab close` only on those the test created.
- [ ] **Step 5:** Commit `herdr: installation, deployment and e2e from the phone`.
