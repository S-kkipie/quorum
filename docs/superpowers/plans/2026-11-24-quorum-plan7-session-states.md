# Session states and attention events — Implementation Plan (Plan 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Quorum knows precisely what each session is doing — needs you, working (incl. waiting on a subagent or command), background (turn ended but background tasks or a scheduled wake-up pending), done-unread, idle — tracks "seen" across devices, terminal and herdr, and emits attention events that the future desktop/Android apps will turn into native notifications.

**Design (approved in chat 2026-11-24):**

| State | When | UI |
|---|---|---|
| needs_you | permission or question pending | amber, first |
| working | a turn runs (waiting on a subagent or a command counts) | blue, animated |
| background | the turn ended but background tasks are pending (background Bash, Monitor, background subagents) or a `/loop` / scheduled wake-up is set | violet, "2 background tasks" / "wakes at 14:30" |
| done | everything finished and the owner has not seen it since | green, "Done · unread" |
| idle | finished and seen | grey |
| closed | closed | unchanged |

Seen = the session opened in the app on any device, a prompt typed in the terminal, or its herdr pane focused. The hub stores a per-session seen mark so all devices agree. Board and Sessions order: needs_you, done, working, background, idle. On every transition into needs_you or done the hub publishes an `attention` envelope — the hook for native notifications later (no notification UI in this plan).

**Tech:** Go hub/daemon, TS mod (`claude plugin test mod`), React app (vitest). Same repo rules as Plans 5–6.

## Global Constraints
- All repo content in English; lucide icons, no emojis; no personal data in code/tests/docs (machines `vps-1`, `laptop`).
- Commits: author/committer `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Mod hooks stay within budget; optional mod APIs called defensively.
- Initial JS ≤ 655 kB; 320 px, touch targets ≥ 44 px.
- Tests: `go test ./...`, `claude plugin test mod`, `make typecheck`, `cd app && npx vitest run`, `npm run build`; proto via `make proto`.

## Review Focus
1. A turn that ends while a background Bash runs → background, not done; when Claude resumes on the task's completion → working; when everything ends → done.
2. `/loop` with a wake-up in 30 min → background with the wake time, not done; the wake-up turn → working.
3. Opening the session on the phone marks it seen on every device; a new turn after that makes it unread again when it ends.
4. A session that ends while the owner is looking at it in the app (view open, page visible) never becomes "done".
5. Hub restart / daemon reconnect does not turn every session into "done" (seen marks persist; no attention storm).

---

### Task 1: Mod — background state

**Files:** `mod/src/control.ts`, `mod/src/events.ts`, `mod/hooks/register.ts`, `internal/proto/proto.go` (+ `make proto`), mod tests.

**Interfaces — produces:** `StateBackground SessionState = "background"`; `SessionInfo.Background BackgroundInfo json:"background"` with `BackgroundInfo{Tasks int json:"tasks"; WakeAt int64 json:"wakeAt"}` (ms, 0 = none); `turn_end` event data gains `background: BackgroundInfo`.

- [ ] Investigate in the mod API types (`mod/.claude-plugin/types/claude-code/index.d.ts`) how background work ends: background Bash / Monitor / background Agent completion (hooks or events such as task notifications), `ScheduleWakeup` / `CronCreate` tool calls (delay field), and what starts the follow-up turn. Write the findings at the top of the test file as a comment.
- [ ] Tests first: (a) turn ends with one background Bash pending → state `background`, `background.tasks=1`; its completion → `tasks=0`; the next turn → `working`; ending with nothing pending → `idle`. (b) `ScheduleWakeup {delaySeconds:1800}` in a turn → at turn end `background.wakeAt ≈ now+1 800 000`; the next turn clears it. (c) A subagent running in the foreground keeps `working` (no change). (d) TaskStop of a task removes it. (e) Session close clears background.
- [ ] Implement using the existing `tasks` set in control.ts (add removal on the completion signal found above). Bump plugin to 0.1.9. Commit `mod: background state for pending tasks and scheduled wake-ups`.

### Task 2: Hub — seen marks, done/unread, attention events

**Files:** `internal/hub/store/migrations.go`, `internal/hub/store/store.go` (+tests), `internal/hub/machines.go`, `internal/hub/appapi.go` (+tests), `internal/proto/proto.go` (envelope doc), `app/src/lib/api.ts`, `app/src/lib/store.ts` (+tests).

**Interfaces — produces:** sessions columns `seen_seq INTEGER`, `end_seq INTEGER` (seq of the last `turn_end`); `SessionInfo.Unread bool json:"unread"` computed by the hub = state idle AND end_seq > seen_seq (background/working/needs_you are never "unread"); `POST /api/sessions/{id}/seen {seq}` (device; seen_seq = max(old, min(seq, latest seq))) → publishes `session_upsert`; the mod's terminal-typed prompts (user events not from a device) set seen_seq to that event's seq; envelope `attention` (hub→app) `{session, kind: "needs_you"|"done", at}` published on each transition INTO needs_you, and INTO unread-done (once per end_seq). On hub start no attention is replayed.

- [ ] Tests first: seen marks persist and only move forward; turn_end after seen → unread true; seen after → false; terminal prompt marks seen; transitions publish exactly one `attention` each; reconnect/hello re-registration with unchanged end_seq publishes nothing; `background` state never unread. App: `seen` API helper; reducer handles `attention` (keeps `lastAttention` per session for later native use) and `unread`.
- [ ] Implement. Commit `hub: seen marks, unread done and attention events`.

### Task 3: Daemon — herdr focus marks seen

**Files:** `internal/daemon/herdr/*`, the daemon's herdr polling/registry code, `internal/proto` (command/RPC if needed), tests.

- [ ] Find how the daemon already reads herdr panes (pane list with `focused`, `agent_session.value` = Claude session id). When a pane with a Claude session becomes focused (edge false→true) while that session is unread, the daemon reports "seen" for it to the hub (new daemon→hub envelope `session_seen {session}`; hub sets seen_seq to latest). Debounce: at most once per session per 10 s. Tests with the herdr test double. Commit `daemon: focusing a herdr pane marks the session seen`.

### Task 4: App — states, seen, ordering

**Files:** `app/src/lib/projects.ts` (SESSION_STATE, ATTENTION), `app/src/lib/sessions.ts`, `app/src/components/StatePill.tsx`, `app/src/components/SessionRow.tsx`, `app/src/components/ProjectCard.tsx`, `app/src/screens/Session.tsx`, `app/src/screens/Sessions.tsx`, `app/src/dev/fixtures.ts`, tests.

- [ ] States and labels: needs_you "Needs you" (amber), working "Working" (blue, pulse), background "Background" + detail `N background tasks` / `wakes at HH:MM` (violet), done "Done · unread" (green, when `unread`), idle "Idle" (grey). ATTENTION order: needs_you 0, done 1, working 2, background 3, idle 4.
- [ ] Seen: while the Session view is open and `document.visibilityState === 'visible'`, call `seen(id, lastSeq)` on mount and whenever new events arrive (debounced 2 s); never when hidden. Optimistically clear `unread` locally.
- [ ] Unread badge: board card and Sessions tab rows show a small green dot for unread done; the Sessions tab label shows the count of needs_you + done (`Sessions 3`).
- [ ] Dev fixtures cover every state (incl. background with wakeAt) for the Break UI pass.
- [ ] Tests for labels, ordering, seen calls (visible vs hidden, debounce), badge counts. Commit `app: session states, seen and unread`.
