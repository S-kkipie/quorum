# Quorum — Plan 1: Foundation + live sessions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** See and control from the browser/phone all Claude Code sessions on all machines: live list, streaming chat, prompts (now/queue/interrupt), permissions and questions, open and close sessions.

**Architecture:** A TS mod inside each session talks to `quorumd` (Go, one per machine): it uploads events over HTTP on loopback and receives commands through the standard output of a child process `quorumd attach` (push, no polling). Each `quorumd` keeps an outbound WebSocket with `quorum-hub` (Go + SQLite), which stores the state, routes commands and serves the React app over HTTP + WebSocket.

**Tech Stack:** Go 1.27 (`github.com/coder/websocket`, `modernc.org/sqlite` without cgo, `net/http` with Go 1.22+ patterns, `github.com/gzuidhof/tygo` to generate TS types), TypeScript for the mod (tests with `bun test`), React 19 + Vite + Tailwind v4 for the app (tests with `vitest`).

**Spec:** `docs/superpowers/specs/2026-11-22-quorum-design.md` (this plan covers Stage 1 except projects/tickets/status/summaries, which go in Plan 2).

## Global Constraints

- Go module: `github.com/S-kkipie/quorum`. Binaries: `quorumd` (per-machine daemon) and `quorum-hub`.
- No cgo in any binary (`CGO_ENABLED=0` must build for linux/amd64, linux/arm64, windows/amd64, darwin/arm64).
- Nothing compiled in git: `app/dist` and binaries ignored. The hub embeds the app with `go:embed`; only a placeholder `internal/hub/web/dist/index.html` is committed.
- Everything is push except ticket system sync (Plan 2). Polling between mod and daemon is forbidden.
- The mod never blocks Claude Code waiting for daemon or hub: every HTTP call from the mod has a timeout ≤ 2 s and failures are silently dropped (except `ask`, which falls back to the terminal).
- Hub and daemon listen only on `127.0.0.1` by default (`--addr` to change it). Publish with `tailscale serve`, never `funnel`.
- Tokens: 32 random bytes in base64url; only their SHA-256 is stored in the database. Pairing/link codes: 6 digits, single use, expire after 10 min.
- Daemon configuration: `~/.config/quorum/daemon.json` (permissions 0600). Hub database: `~/.local/share/quorum/hub.db`.
- User-visible texts are in English (this plan was originally written in Spanish and translated in Plan 4, Task 0).
- Sessions are always launched with `claude` resolved through the PATH of a login shell (`bash -lc`), to respect the whoas shims. Never an absolute path to `claude`.
- The ccapi session (`CCAPI_SERVER=1` in its environment) is a **service**: the mod does not inject prompts, does not answer permissions and does not report subagents.
- pastor is retired (no coexistence and no passive state).

## Review Focus

1. **The daemon restarts or dies in the middle of a session** → the `quorumd attach` process ends; the mod must relaunch `quorumd ensure` + `attach` with backoff (1 s, 2 s, 5 s, 10 s max) and register again, without losing the session. Test in Task 8.
2. **The hub goes down** → the daemon retries the connection with backoff and, on return, resends `MachineHello` with all live sessions; the app shows the machine "offline" meanwhile. Test in Task 6.
3. **Two devices answer the same question/permission**, or the owner answers in the terminal first → the first wins; the others receive `ask_resolved` and the card disappears. Test in Tasks 7 and 10.
4. **`/clear` or `/resume` change the session id without `session.start`** → the mod adopts the new id (`$.session.id()` after `session.end` with `reason` `clear`/`resume`) and the hub treats the change as the same card (`previousId` field). Test in Task 8.
5. **Burst of streaming text** (thousands of deltas per second) → the mod groups deltas every 150 ms and the hub does not persist deltas, only the step's final text. Test in Tasks 9 and 2.

---

### Task 1: Repo skeleton and shared protocol

**Files:**
- Create: `go.mod`, `Makefile`, `.gitignore`, `README.md`
- Create: `internal/proto/proto.go`, `internal/proto/tygo.yaml`, `internal/proto/proto_test.go`
- Create: `mod/src/proto.gen.ts`, `app/src/proto.gen.ts` (generated, they are committed: they are the source for TS)

**Interfaces:**
- Produces (Go, package `proto`; the same names in TS):
  - `type SessionState string` = `"working" | "needs_you" | "waiting" | "idle" | "closed"`
  - `type Role string` = `"work" | "service"`
  - `type SessionInfo struct { ID, PreviousID, Machine, Name, Cwd, Root, Model string; Role Role; State SessionState; ContextPct int; StartedAt, UpdatedAt int64 }`
  - `type Event struct { Seq int64; Session string; TS int64; Kind EventKind; Data json.RawMessage }` with `EventKind` = `user | assistant_delta | assistant | thinking | tool_start | tool_end | ask | ask_resolved | turn_start | turn_end | status | agent_start | agent_end | info`
  - Data per kind: `ToolStart{ID, Name, Summary, Agent string}`, `ToolEnd{ID string; OK bool; MS int64; Output string}`, `Ask{AskID string; Kind string /* permission|question */; Tool, Summary, Detail string; Questions json.RawMessage}`, `AskResolved{AskID, By string /* terminal|device:<id> */}`, `TurnEnd{Answer, Reason string; OutputTokens int}`, `AgentStart{ID, Type, Description string}`, `AgentEnd{ID, Status, Answer string}`
  - Commands to a session: `type Command struct { Type string /* prompt|decide|abort|close|presence */; Text, Mode /* now|queue|interrupt */, AskID, Decision /* allow|deny */, Reason string; Answers map[string]string; Away, Watching bool }`
  - WS envelope daemon↔hub and hub↔app: `type Envelope struct { Type string; Machine, Session string; Payload json.RawMessage }` with `Type` = `hello | session_upsert | session_gone | event | command | launch | launch_result | machine_status | backfill | watch | ack`
  - `type MachineHello struct { Machine, OS, Env, Version string; Sessions []SessionInfo }` (`Env` = `linux|wsl|windows|darwin`)
  - `type LaunchRequest struct { ReqID, Dir string; Continue bool; PermissionMode string }`, `type LaunchResult struct { ReqID string; OK bool; Error string }`
  - `const Version = "0.1.0"`

- [ ] **Step 1: Initialize the Go repo and Makefile**
  `go mod init github.com/S-kkipie/quorum`. Makefile targets: `proto` (runs `tygo generate` and copies to `mod/src` and `app/src`), `test` (`go test ./...` + `cd mod && bun test` + `cd app && npx vitest run`), `app` (Vite build → `internal/hub/web/dist`), `build` (`app` + `go build ./cmd/...` with `CGO_ENABLED=0`), `cross` (the 4 platforms). `.gitignore`: `/bin`, `app/dist`, `app/node_modules`, `mod/node_modules`, `internal/hub/web/dist/*` except `index.html`.

- [ ] **Step 2: Write a JSON round-trip test**
```go
func TestEnvelopeRoundTrip(t *testing.T) {
    ev := Event{Seq: 1, Session: "s1", TS: 10, Kind: KindToolStart, Data: mustJSON(ToolStart{ID: "t1", Name: "Bash", Summary: "ls"})}
    env := Envelope{Type: "event", Machine: "vps1", Session: "s1", Payload: mustJSON(ev)}
    var back Envelope
    require.NoError(t, json.Unmarshal(mustJSON(env), &back))
    require.Equal(t, env, back)
    require.Contains(t, string(mustJSON(ev)), `"kind":"tool_start"`)
}
```
  JSON tags in camelCase (`json:"previousId"`, etc.).

- [ ] **Step 3: Run** `go test ./internal/proto/` → FAIL (undefined types).
- [ ] **Step 4: Implement the Interfaces types in `proto.go`** and `tygo.yaml` pointing at `internal/proto` with output `mod/src/proto.gen.ts`.
- [ ] **Step 5: Run** `go test ./internal/proto/ && make proto` → PASS and `mod/src/proto.gen.ts` and `app/src/proto.gen.ts` appear.
- [ ] **Step 6: Commit** `feat: repo skeleton and shared protocol`

---

### Task 2: Hub store (SQLite)

**Files:**
- Create: `internal/hub/store/store.go`, `internal/hub/store/migrations.go`, `internal/hub/store/store_test.go`

**Interfaces:**
- Consumes: `proto.SessionInfo`, `proto.Event`
- Produces:
  - `func Open(path string) (*Store, error)` (applies migrations; `":memory:"` for tests)
  - `UpsertMachine(name, os, env, version string, online bool) error`, `ListMachines() ([]Machine, error)` with `Machine{Name, OS, Env, Version string; Online bool; LastSeen int64}`
  - `UpsertSession(s proto.SessionInfo) error` (if `PreviousID` != "" it renames the previous row to the new id), `ListSessions(includeClosed bool) ([]proto.SessionInfo, error)`, `MarkMachineSessionsClosed(machine string) error`
  - `AppendEvent(e proto.Event) (int64, error)` → assigns an increasing `Seq` per session; **ignores** `assistant_delta` (returns 0 without storing); keeps at most 2000 events per session.
  - `Events(session string, beforeSeq int64, limit int) ([]proto.Event, error)` (newest first)
  - Devices and codes: `CreateCode(kind string /* pair|link */) (string, error)`, `ConsumeCode(kind, code string) error` (error if it does not exist, is used or expired), `AddToken(kind /* device|machine */, name, token string) error`, `CheckToken(kind, token string) (name string, ok bool)`, `RevokeToken(kind, name string) error`, `ListDevices() ([]Device, error)`

- [ ] **Step 1: Tests**
```go
func TestDeltasAreNotPersisted(t *testing.T) {
    s := openMem(t)
    seq, err := s.AppendEvent(proto.Event{Session: "a", Kind: proto.KindAssistantDelta})
    require.NoError(t, err); require.Zero(t, seq)
    evs, _ := s.Events("a", 0, 10); require.Empty(t, evs)
}
func TestEventRetention(t *testing.T) { /* 2100 tool_start events → Events returns 2000 and the oldest has Seq 101 */ }
func TestSessionRenameOnClear(t *testing.T) { /* Upsert {ID:"old"}, Upsert {ID:"new", PreviousID:"old"} → ListSessions has 1 row with ID "new"; events of "old" end up under "new" */ }
func TestCodeSingleUseAndExpiry(t *testing.T) { /* ConsumeCode twice → second fails; with the clock moved forward 11 min → fails */ }
func TestTokenStoredHashed(t *testing.T) { /* AddToken and then a raw SELECT of the table does not contain the plain token */ }
```
  The store's clock is injectable (`Store.now func() time.Time`).
- [ ] **Step 2: Run** `go test ./internal/hub/store/` → FAIL.
- [ ] **Step 3: Implement** with `modernc.org/sqlite`, `PRAGMA journal_mode=WAL`, tables `machines`, `sessions`, `events(session, seq, ts, kind, data)`, `codes`, `tokens(kind, name, hash)`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(hub): SQLite store`

---

### Task 3: Hub CLI and pairing

**Files:**
- Create: `cmd/quorum-hub/main.go`, `internal/hub/auth.go`, `internal/hub/auth_test.go`, `internal/hub/server.go`

**Interfaces:**
- Consumes: `store.Store`
- Produces:
  - Subcommands: `quorum-hub serve [--addr 127.0.0.1:7420] [--db PATH]`, `quorum-hub pair` (prints a device code), `quorum-hub link-code` (prints a machine code), `quorum-hub devices`, `quorum-hub revoke <device|machine> <name>`.
  - `func NewServer(st *store.Store) *Server` with `Server.Handler() http.Handler`.
  - `POST /api/pair` body `{code, deviceName}` → `{token}`; `POST /api/link` body `{code, machine}` → `{token}`. Errors: 400 `{"error":"invalid or expired code"}`.
  - Middleware `requireDevice` (header `Authorization: Bearer <t>` or query `token=` only for WebSocket) and `requireMachine` (Bearer header).
  - `GET /api/ping` without auth → `{ok:true, version}`.

- [ ] **Step 1: Tests with `httptest`**: pair with a valid code returns a token that then passes `requireDevice`; the same code again → 400; `/api/sessions` without a token → 401; a machine token does not work as a device token.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `pair` and `link-code` open the same database as `serve` (WAL allows concurrency).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(hub): CLI and pairing of devices and machines`

---

### Task 4: Daemon local API and session registry

**Files:**
- Create: `cmd/quorumd/main.go`, `internal/daemon/config.go`, `internal/daemon/localapi.go`, `internal/daemon/registry.go`, `internal/daemon/localapi_test.go`

**Interfaces:**
- Consumes: `proto.*`
- Produces:
  - `type Config struct { Machine, Hub, MachineToken string; Port int; LocalToken string }` with `LoadConfig() (Config, error)` / `SaveConfig(Config) error` in `~/.config/quorum/daemon.json` (0600). `Machine` defaults to hostname (+ `-wsl` if running in WSL).
  - `quorumd ensure --json` → if `GET http://127.0.0.1:<port>/v1/health` answers, prints `{"ok":true,"port":N,"token":"…","machine":"…","version":"…"}`; if not, launches `quorumd serve` detached (setsid on Unix, `DETACHED_PROCESS` on Windows), waits up to 5 s for health and prints the same; if it fails, `{"ok":false,"error":"…"}` and exit code 1.
  - Local API (all with `Authorization: Bearer <LocalToken>` except `/v1/health`):
    - `POST /v1/sessions/register` body `proto.SessionInfo` → 204
    - `POST /v1/sessions/{id}/events` body `[]proto.Event` → 204 (the daemon assigns `Session` and `TS` if missing)
    - `POST /v1/sessions/{id}/gone` → 204
  - `type Registry struct` with `Upsert(proto.SessionInfo)`, `Gone(id string)`, `Snapshot() []proto.SessionInfo`, `Subscribe(id string) (<-chan proto.Command, func())`, `Send(id string, c proto.Command) bool`, and a channel `Out() <-chan proto.Envelope` with everything that has to be sent to the hub.

- [ ] **Step 1: Tests**: register + events come out of `Out()` as `session_upsert` and `event` in order; wrong token → 401; `Gone` emits `session_gone`; `Send` to a session with no subscriber → false.
- [ ] **Step 2: Run** `go test ./internal/daemon/` → FAIL.
- [ ] **Step 3: Implement.** Port: the one saved in config if free; otherwise a random one that is saved.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(daemon): local API and session registry`

---

### Task 5: Command channel to the mod (`quorumd attach`)

**Files:**
- Create: `internal/daemon/attach.go`, `internal/daemon/attach_test.go`

**Interfaces:**
- Consumes: `Registry.Subscribe`
- Produces:
  - Endpoint `GET /v1/sessions/{id}/attach` (local auth): streaming response, one JSON `proto.Command` line per command, plus a `{"type":"ping"}` line every 20 s.
  - Subcommand `quorumd attach --session <id>`: reads the config, opens that endpoint and copies each line to stdout as is; exits with code 0 if the server closes and 2 if it cannot connect (the mod retries).

- [ ] **Step 1: Test**: with a real `Registry` and `httptest`, a client reading the stream receives in order two `Command`s sent with `Send`; when the client is canceled, `Subscribe` is released (`Send` gives false again).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with `http.Flusher`; a single subscriber per session (a new one replaces the previous).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(daemon): push command channel to the mod`

---

### Task 6: Daemon ↔ hub link

**Files:**
- Create: `internal/daemon/hublink.go`, `internal/daemon/hublink_test.go`, `internal/hub/machines.go`, `internal/hub/machines_test.go`
- Modify: `cmd/quorumd/main.go` (`link` subcommand)

**Interfaces:**
- Consumes: `Registry.Out()`, `Registry.Send`, `Registry.Snapshot`, `store.*`
- Produces:
  - `quorumd link <hubURL> <code>` → `POST /api/link`, saves `Hub` and `MachineToken` in the config.
  - Hub: `GET /api/machine/ws` (`requireMachine`), WebSocket. The daemon's first message: `hello` with `MachineHello`. The hub marks the machine online, does `UpsertSession` for each one and marks closed those that are no longer there. On disconnect: machine offline and its sessions `closed`… only after 60 s without reconnection (to avoid flicker).
  - Hub: `func (h *Hub) SendToMachine(machine string, env proto.Envelope) bool`.
  - Daemon: `RunHubLink(ctx, cfg, reg)` reconnects with backoff 1 s → 30 s max; on each connection it sends `hello` with `Snapshot()`; it forwards `Out()`; incoming `command`s go to `Registry.Send`.

- [ ] **Step 1: Tests**:
  - `TestHelloRegistersMachineAndSessions` (hub with in-memory store).
  - `TestReconnectResendsSnapshot`: close the WS server, bring it back up, the daemon sends a second `hello` with the live sessions (Review Focus 2).
  - `TestCommandReachesSession`: the hub does `SendToMachine(command)` and the daemon's `Registry` delivers it to the subscriber.
  - `TestOfflineAfterGrace`: with an injected clock, at 59 s the machine is still online, at 61 s offline.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with `github.com/coder/websocket` and `wsjson`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: daemon-hub link with reconnection`

---

### Task 7: Hub app API and live broadcast

**Files:**
- Create: `internal/hub/appapi.go`, `internal/hub/live.go`, `internal/hub/appapi_test.go`

**Interfaces:**
- Consumes: `store.*`, `Hub.SendToMachine`
- Produces (all with `requireDevice`):
  - `GET /api/machines` → `[]Machine`; `GET /api/sessions?closed=1` → `[]proto.SessionInfo`
  - `GET /api/sessions/{id}/events?before=<seq>&limit=<n≤200>` → `[]proto.Event`
  - `POST /api/sessions/{id}/prompt` `{text, mode}`; `/decide` `{askId, decision, answers?, reason?}`; `/abort`; `/close` → 202, or 409 `{"error":"machine is offline"}`
  - `POST /api/sessions/{id}/presence` `{away}` → forwards `command{type:'presence', away, watching}`.
  - While any device has a session open (message `{type:'watch', session}` over `/api/live`, `session:''` on leaving), the hub sends `presence{watching:true}` to that session; when nobody is watching it any more, `watching:false`.
  - `GET /api/live?token=` (WebSocket): sends `machine_status`, `session_upsert`, `session_gone`, `event` (includes `assistant_delta`) to all connected devices.
  - First `decide` wins: the hub remembers the open `askId`s (from `ask` events) and closes them on seeing `ask_resolved`; a `decide` on an already resolved `askId` → 409 `{"error":"already answered"}` (Review Focus 3). The winning `decide` is forwarded as a `command` and the hub itself emits `ask_resolved{by:"device:<name>"}`.

- [ ] **Step 1: Tests**: a client sends `watch` → the session receives `presence{watching:true}`; it disconnects → `watching:false`; a prompt to a session on an online machine arrives as a `command` (mock of `SendToMachine`); offline machine → 409; two `decide`s on the same `askId` → the second 409; a `/api/live` client receives a published `event`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(hub): app API and live broadcast`

---

### Task 8: Mod — connection, role and lifecycle

**Files:**
- Create: `.claude-plugin/marketplace.json` (source `./mod`), `mod/.claude-plugin/plugin.json`, `mod/hooks/hooks.json` (`{"modules":["./register.ts"]}`), `mod/hooks/register.ts`, `mod/src/link.ts`, `mod/src/role.ts`, `mod/package.json`, `mod/test/link.test.ts`, `mod/test/role.test.ts`

**Interfaces:**
- Consumes: protocol (`mod/src/proto.gen.ts`), local API (Task 4), `quorumd attach` (Task 5)
- Produces:
  - `detectRole(env: (k: string) => string | undefined): { role: 'work' | 'service' }` → `service` if `CCAPI_SERVER === '1'`.
  - `class Link` with `constructor(io: LinkIO)`, `start(info: SessionInfo): Promise<void>`, `emit(ev: Omit<Event,'seq'|'session'|'ts'>): void`, `onCommand(fn: (c: Command) => void): void`, `adoptId(newId: string): void`, `stop(): void`.
    `LinkIO` abstracts `$`: `{ run(argv): Promise<{exitCode, stdout}>, fetch(url, init): Promise<{status}>, spawn(argv): AsyncIterable<{stream, text}>, sleep(ms): Promise<void> }`.
  - `Link` behavior: `start` runs `quorumd ensure --json`, registers the session and launches the `attach` loop; if the child ends, it retries with backoff 1/2/5/10 s and registers again (Review Focus 1). `emit` queues and flushes every 150 ms in a single `POST …/events` (merges consecutive `assistant_delta`s into one); 2 s timeout, error → drop. The child's lines are split on `\n` even if they arrive in chunks; `{"type":"ping"}` is ignored.
  - `register.ts`: on `session.start` it builds `SessionInfo` (`$.session.id()`, `$.session.cwd()`, `$.session.root()`, `$.session.model()`), calls `detectRole` (`$.env.get`), starts `Link`, registers the `/quorum` command (shows machine, connection state). On `session.end` with `reason` `clear`/`resume`, after 300 ms `adoptId(await $.session.id())` and registers again with `previousId` (Review Focus 4).

- [ ] **Step 1: Tests (`bun test`) with a fake `LinkIO`**:
  - `role`: `CCAPI_SERVER=1` → service; empty → work.
  - `link`: 300 `assistant_delta`s emitted in <150 ms produce a single POST with a single concatenated delta.
  - `link`: the `attach` child ends → there is a new `run(['quorumd','ensure','--json'])` and a new register after 1 s (fake clock).
  - `link`: a JSON line split into two chunks produces a single `Command`.
  - `link`: a `fetch` that rejects does not throw outward.
- [ ] **Step 2: Run** `cd mod && bun test` → FAIL.
- [ ] **Step 3: Implement** `role.ts`, `link.ts`, `register.ts`.
- [ ] **Step 4: Run** → PASS. Also `claude plugin validate ./mod` (or `claude plugin details ./mod`) with no errors.
- [ ] **Step 5: Commit** `feat(mod): connection with quorumd, role and lifecycle`

---

### Task 9: Mod — session events

**Files:**
- Create: `mod/src/events.ts`, `mod/test/events.test.ts`
- Modify: `mod/hooks/register.ts`

**Interfaces:**
- Consumes: `Link.emit`
- Produces: hooks that emit:
  - `turn.start` (no `agentId`) → `turn_start` + `user {text}` + `status {state:'working'}`.
  - `turn.step` → for each `text` chunk: `assistant_delta {text}`; `thinking`: `thinking {text}` (only the block's first chunk, to show "thinking"); `tool`: `tool_start {id, name, summary:''}`. When the step closes, `assistant {text}` with the step's full text if not empty. With `agentId`, the same events carry `agent` and do not change the session state.
  - `tool.call` → wraps `next(e)`: on return, `tool_end {id: e.tool_use_id, ok: !r.isError, ms, output: trimmed to 4000 chars}`; before, it updates the `tool_start`'s `summary` with `summarize(tool, input)`.
  - `agent.spawn` → `agent_start {id, type, description}`; `turn.complete` with `agentId` → `agent_end {id, status, answer trimmed to 2000}`.
  - `turn.complete` without `agentId` → `turn_end {answer, reason, outputTokens}` + `status {state:'idle'}`; with `reason:'error'` and empty `answer`, `answer` = "⚠️ Claude returned an error (expired session, usage limit or API failure). Check it in the terminal."
  - `contextPct` in `SessionInfo` is updated on each `turn_end` with `$.session.usage()` and registered again.
  - `summarize(tool: string, input: unknown): string` → Bash: `command`; Read/Write/Edit: `file_path`; Grep/Glob: `pattern`; WebFetch: `url`; rest: first keys as `k=v` up to 120 chars.
  - In `service` role, no hook of this task emits anything except `status`.

- [ ] **Step 1: Tests** of `summarize` (the 5 cases above) and of a simulated turn: sequence of calls to the handlers with a fake `Link` → exact list of emitted `kind`s: `turn_start, user, status, assistant_delta, assistant_delta, tool_start, tool_end, assistant, turn_end, status`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** pure functions `makeHandlers(link, role)` in `events.ts` and wire them in `register.ts` (pattern of `turn.step` as an async generator that forwards each chunk with `yield`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mod): turn, tool and subagent events`

---

### Task 10: Mod — commands, permissions and questions

**Files:**
- Create: `mod/src/control.ts`, `mod/test/control.test.ts`
- Modify: `mod/hooks/register.ts`

**Interfaces:**
- Consumes: `Link.onCommand`, `Link.emit`
- Produces:
  - Commands: `prompt` with `mode:'queue'` → `$.prompt.submit({text, asUser:true})`; `'interrupt'` → `$.turn.abort({turnId})` and then submit; `'now'` → if a turn is in progress, it is kept and added as `context` to the result of the main thread's next `tool.call` (`{...r, context:[...(r.context ?? []), text]}`); if undelivered when the turn ends, it is sent with submit. `abort` → `$.turn.abort`. `close` → `TaskStop` of the known background tasks and then `$.command.run({command:'exit'})`. `presence` → updates `away`/`watching`.
  - The text of a prompt that came from the device is not re-emitted as a duplicated `user` (a `fromDevice` list as in v1).
  - `class Asks` with `ask(a: Omit<Ask,'askId'>, waitMs: number): Promise<Decision | undefined>`, `resolve(askId, decision)`, `withdraw(askId)`; emits `ask` + `status{state:'needs_you'}` and, when resolved by any route, `ask_resolved {by}` + `status{state:'working'}`.
  - `tool.check` (main thread, `decision==='ask'`, tool is not in `AskUserQuestion|ExitPlanMode`): if `away` → `ask(…, 30 min)`; if `watching` → `ask(…, 2 min)`; otherwise it returns the verdict (terminal). With a decision: `{decision:'allow', reason:'Allowed from Quorum'}` or `{decision:'deny', reason: d.reason || 'Denied from Quorum'}`. No decision in time → original verdict (terminal).
  - `tool.call` of `AskUserQuestion` (main thread): race between the terminal (`next(e)`) and the device (`ask(kind:'question', questions)`); if the terminal wins, `withdraw` + `ask_resolved{by:'terminal'}`; if the device wins, it returns the answers as the tool's result with the same format as the terminal.
  - In `service` role, no command is applied (an `info` event "Service session: Quorum does not control it" is answered).

- [ ] **Step 1: Tests** with a fake `$`:
  - `prompt now` during a turn → the next `tool.call` returns `context` with the text; `submit` is not called.
  - `prompt interrupt` → `abort` before `submit`.
  - `tool.check` with `away=false, watching=false` → returns the verdict without emitting `ask`.
  - `tool.check` with `away=true` and `resolve(allow)` → `{decision:'allow'}` and `ask_resolved{by:'device:…'}` is emitted.
  - `AskUserQuestion`: the terminal resolves first → `ask_resolved{by:'terminal'}` is emitted (Review Focus 3).
  - `service` role + `prompt` command → `submit` is not called.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mod): prompts, permissions and questions from Quorum`

---

### Task 11: Launch sessions on any machine

**Files:**
- Create: `internal/daemon/launch/launch.go`, `internal/daemon/launch/launch_test.go`
- Modify: `internal/daemon/hublink.go` (handle `launch`), `internal/hub/appapi.go` (`POST /api/launch`)

**Interfaces:**
- Consumes: `proto.LaunchRequest`, `proto.LaunchResult`
- Produces:
  - `func Argv(env Env, req proto.LaunchRequest, hasDisplay bool) (bin string, args []string)` with `Env` = `Linux | WSL | Windows | Darwin`. Claude's line is `claude` + `--continue` if `Continue` + `--permission-mode <m>` if given (or `--dangerously-skip-permissions` if `m == "bypass"`), quoted for the shell.
    - Linux without a display (or always on servers): `tmux new-session -d -s quorum-<base36(now)> -c <dir> bash -lc '<line>'`.
    - WSL: `wt.exe wsl.exe -d <distro> --cd <dir> -- bash -lic '<line>'` (distro from `WSL_DISTRO_NAME`).
    - Windows: `wt.exe -d <dir> claude …` with `;` escaped as `\;`.
    - Darwin: `osascript -e 'tell app "Terminal" to do script "cd <dir> && <line>"'`.
  - `func Run(ctx, req) proto.LaunchResult` (validates that `Dir` exists; error "the folder does not exist: <dir>").
  - `POST /api/launch` `{machine, dir, continue, permissionMode}` → 202 `{reqId}`; the result arrives as `launch_result` over `/api/live`.

- [ ] **Step 1: Table tests for `Argv`**: Linux with `Continue` → contains `bash -lc` and `claude --continue`; never contains an absolute path to `claude`; Windows with a `dir` that contains `;` → escaped; WSL uses `bash -lic` and the variable's distro; `bypass` → `--dangerously-skip-permissions`. `Run` test with a nonexistent folder → `OK:false` and the exact message.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: launch sessions on any machine respecting whoas`

---

### Task 12: History from the transcript

**Files:**
- Create: `internal/daemon/transcript/transcript.go`, `internal/daemon/transcript/transcript_test.go`, `internal/daemon/transcript/testdata/sample.jsonl`
- Modify: `mod/src/link.ts` (include `transcriptPath` from `$.session.info()` in the register), `internal/proto/proto.go` (`SessionInfo.TranscriptPath string`), `internal/daemon/hublink.go`, `internal/hub/appapi.go`

**Interfaces:**
- Produces:
  - `func Parse(r io.Reader, limit int) ([]proto.Event, error)`: reads Claude Code's JSONL and returns at most the last `limit` events of kind `user` (user text, without `tool_result` blocks), `assistant` (text blocks), `tool_start` (`tool_use` blocks: id, name, summary). Lines it does not understand are skipped without error (the format is internal).
  - Hub: if `GET /api/sessions/{id}/events` has no stored events, it asks the machine for `{"type":"backfill"}` (`Envelope.Type = "backfill"`), the daemon parses `TranscriptPath` (limit 500) and answers with `event`s that the hub stores with ascending negative `Seq`s (to land before the live events).

- [ ] **Step 1: Test** with `testdata/sample.jsonl` (hand-built with 1 user, 1 assistant with text + tool_use, 1 user with tool_result, 1 junk line) → exactly `[user, assistant, tool_start]` with the expected texts.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: session history from the transcript`

---

### Task 13: App — base, pairing and session list

**Files:**
- Create: `app/` (Vite React TS + Tailwind v4), `app/src/lib/api.ts`, `app/src/lib/live.ts`, `app/src/lib/store.ts`, `app/src/lib/native.ts`, `app/src/screens/Pair.tsx`, `app/src/screens/Sessions.tsx`, `app/src/App.tsx`, `app/src/lib/store.test.ts`

**Interfaces:**
- Consumes: API from Task 7, `app/src/proto.gen.ts`
- Produces:
  - `api.ts`: `hubUrl()` / `setHub(url, token)` stored in `localStorage` (the app does **not** assume same origin: Tauri requirement); `apiFetch(path, init)`.
  - `live.ts`: `connectLive(onEnvelope)` with reconnection 1 s → 15 s.
  - `store.ts` (pure reducer): `reduce(state: AppState, env: Envelope): AppState`. `AppState = { machines: Record<string, Machine>; sessions: Record<string, SessionInfo>; order: string[]; events: Record<string, Event[]>; live: Record<string, string> /* streaming text per session */; asks: Record<string, Ask> }`. Rules: `assistant_delta` concatenates into `live[session]`; `assistant` clears it and appends the event; `ask` adds to `asks`; `ask_resolved` removes it; `session_upsert` with `previousId` moves events and position; `order` appends new ones at the end and **never reorders on state change**.
  - PWA: `public/manifest.webmanifest` (name "Quorum", `display: standalone`) and a minimal service worker that only caches the app shell.
  - `native.ts`: `notify(title, body)` with a web implementation (Notification API) by default.
  - `Pair.tsx`: hub address + code fields → `POST /api/pair` → saves token. Visible error "invalid or expired code".
  - `Sessions.tsx`: sessions grouped by machine (offline machine in gray with "offline"), state with color (`working` blue, `needs_you` amber, `idle` gray, `closed` dimmed), `service` sessions in a separate "Services" section (e.g. ccapi).

- [ ] **Step 1: Reducer tests (vitest)**: deltas concatenated and cleared by `assistant`; `ask_resolved` removes the card; state change does not alter `order`; `previousId` keeps the position.
- [ ] **Step 2: Run** `cd app && npx vitest run` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS. `npm run build` with no errors.
- [ ] **Step 5: Commit** `feat(app): base, pairing and session list`

---

### Task 14: App — chat, prompts, permissions, launch; embedded in the hub

**Files:**
- Create: `app/src/screens/Session.tsx`, `app/src/components/Transcript.tsx`, `app/src/components/Composer.tsx`, `app/src/components/AskCard.tsx`, `app/src/components/LaunchDialog.tsx`, `app/src/components/Composer.test.tsx`
- Create: `internal/hub/web/web.go` (`//go:embed all:dist`), `internal/hub/web/dist/index.html` (placeholder "Build the app with `make app`")
- Modify: `internal/hub/server.go` (serve the app at `/` with fallback to `index.html`)

**Interfaces:**
- Consumes: `store.ts`, `api.ts`
- Produces:
  - `Transcript`: events in order with the streaming text at the end; `tool_start`/`tool_end` as a collapsible row (name + summary, detail with output on tap); subagents as rows with their state; backward loading with `?before=` on reaching the top.
  - `Composer`: textarea + three actions: "Send" (`queue` if the session is idle, otherwise `now`), "Queue" (`queue`), "Interrupt and send" (`interrupt`). Disabled with "Service session" or "Passive session" depending on the role.
  - `AskCard`: permission (tool, summary, detail, Allow/Deny buttons) or questions (each question's options, `answers` submission); on 409 it shows "already answered" and closes.
  - `LaunchDialog`: machine (online only) + folder (text, with the known sessions' folders on that machine as suggestions) + "continue the last conversation" + permission mode.
  - Buttons in the session header: Interrupt, Close (with confirmation) and an "Away" switch (`POST …/presence`).
  - When opening a session the app sends `{type:'watch', session}` over `/api/live`, and `session:''` on leaving.
  - Layout: on screens ≥ 1024 px, list on the left and session on the right; on the phone, list → session navigation with the browser's back button.

- [ ] **Step 1: Test (vitest + Testing Library)** of `Composer`: with a `working` session, "Send" calls `POST …/prompt` with `mode:'now'`; with `idle`, with `mode:'queue'`; with the `service` role the button is disabled.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** components, embedding and serving.
- [ ] **Step 4: Run** `make test && make build` → PASS; `./bin/quorum-hub serve` serves the app at `http://127.0.0.1:7420/`.
- [ ] **Step 5: Commit** `feat(app): chat, prompts, permissions and launcher`

---

### Task 15: Installation and end-to-end test

**Files:**
- Create: `scripts/install-hub.sh`, `scripts/install-daemon.sh`, `docs/e2e-stage1.md`
- Modify: `README.md`

**Interfaces:**
- Produces:
  - `install-hub.sh`: copies `quorum-hub` to `~/.local/bin`, creates the systemd user unit `quorum-hub.service` (`serve --addr 127.0.0.1:7420`), `loginctl enable-linger`, and prints how to publish it with `tailscale serve --bg 7420`.
  - `install-daemon.sh`: copies `quorumd` to `~/.local/bin` and adds the marketplace + plugin: `claude plugin marketplace add S-kkipie/quorum && claude plugin install quorum@quorum`.
  - `docs/e2e-stage1.md`: manual checklist with the expected result at each step.

- [ ] **Step 1: Write `docs/e2e-stage1.md`** with these steps and their expected result:
  1. Hub on the VPS, `quorum-hub pair` → pair the phone → the app shows "no machines".
  2. `quorumd link` on the PC (WSL) and on a VPS → both show up online.
  3. Open `claude` by hand on the PC → the session appears in <2 s with state "idle".
  4. Send a prompt from the phone → visible streaming, tools as rows, state goes back to "idle".
  5. `/quorum` in the terminal → shows machine and "connected".
  6. Turn on "away" (presence) and ask for something that needs permission → card on the phone; Allow → the tool runs.
  7. `AskUserQuestion` answered in the terminal → the phone's card disappears.
  8. Kill `quorumd` (`pkill -x quorumd`) → within ≤10 s the session is connected again.
  9. Stop the hub for 30 s and bring it back → everything returns without closing sessions.
  10. Launch a session on the VPS from the app → it appears; `tmux ls` shows `quorum-…`; `whoas which claude` in that folder matches the session's account.
  11. With ccapi running → it appears under "Services" and the Composer is disabled.
  12. (Not applicable: pastor retired.)
  13. `/clear` in a session → the card keeps its place and the chat continues.
  14. Close the session from the app → it disappears and the process ends.
- [ ] **Step 2: Write the scripts and the README** (install, pair, link, security: tailnet only).
- [ ] **Step 3: Run** `make test && make cross` → PASS and 4 pairs of binaries in `bin/`.
- [ ] **Step 4: Run the e2e list** on the PC + a VPS and record each step's result in the same document.
- [ ] **Step 5: Commit** `docs: installation and end-to-end verification of stage 1`
