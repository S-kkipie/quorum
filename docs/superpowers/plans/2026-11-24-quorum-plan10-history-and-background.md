# Huge sessions and background tasks — Implementation Plan (Plan 10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Sessions with thousands of messages and many compacts stay light everywhere (daemon, hub, app), history can be scrolled back to the start of a session, compacts are visible, the app keeps a local cache and syncs only what changed; and background work (background commands, monitors, background subagents, loops) gets real UI.

**Design (approved in chat 2026-11-24), modelled on WhatsApp multi-device:** the machine (Claude Code's JSONL transcript) is the source of truth, like the phone; the hub is a relay with a short hot window and retention, like WhatsApp's server; each app device keeps its own local store and syncs deltas, like WhatsApp Web; small state (seen marks) syncs separately (Plan 7).

1. **Paged history from the source.** The daemon reads a session's JSONL transcript backwards in blocks (never the whole file), mapped to Quorum events, and serves pages via RPC `transcript_page {session, before: cursor|"", limit} → {events, cursor, done}`; the cursor is an opaque byte offset. The hub keeps its newest 2000 events per session (unchanged); when the app scrolls past what the hub has, it asks the hub for `GET /api/sessions/{id}/history?cursor=…`, which proxies to the machine. Backfill (when the hub has nothing) uses the same reader and only reads the last page(s).
2. **Compacts visible.** Each compact boundary in the transcript (and live, from the mod) becomes a `compact` event `{at, trigger: "auto"|"manual", preTokens?}`. The transcript shows a divider "Conversation compacted · 14:32"; everything before the newest compact is collapsed into one row "Earlier conversation (N messages)" that loads/expands on tap.
3. **Light app.** The transcript renders only what is on screen (virtualized list; lazy chunk; keep stick-to-bottom, load-older-on-top, scroll restoration). In memory at most 600 events per session; older ones dropped when far off screen (re-fetched from cache/hub/machine on demand). Events of sessions not open are evicted to the local cache after 2 minutes.
4. **Hub retention.** Events of sessions closed more than 90 days ago are deleted (session rows, seen marks and ticket links stay); daily job, in batches; incremental vacuum. 90 days, not 30: Claude Code deletes its own transcripts after `cleanupPeriodDays` (30 by default), so a 30-day hub retention could lose both copies at once. History remains reachable from the machine through point 1 while its transcript exists. The hub records `history_ok` once the machine served a page of a session's history (not used by retention).
5. **Background panel.** Tapping the session's Background state opens a sheet listing each pending background item: kind (command / monitor / subagent / loop / cron), what it is (command line, monitor target, subagent description, loop prompt), started-at (relative), and for loops/crons the next wake time. Live updates.
6. **Honest rows.** A Bash tool call with `run_in_background` shows as "Running in background" (not done) and turns done/failed when its task ends; same for background subagents and Monitor.
7. **Notifications as cards.** `<task-notification>` prompts that Claude Code injects are parsed by the mod into `task_end {taskId, kind, summary, status, exitCode?, outputTail?}` events, rendered as a card ("Background task finished · npm test · exit 0", output collapsible) and never as a user bubble; they never count as the owner typing (no seen mark).
8. **Local cache and delta sync (app).** IndexedDB store per device: events per session (bounded: 2,000 newest per session, 50 MB total, LRU by last opened), plus a `lastSeq` per session. Opening a session renders from the cache immediately, then fetches only `GET /api/sessions/{id}/events?after=<lastSeq>`; reconnects do the same for open sessions. All storage access guarded (private mode / quota → app works without cache). Logout/pair-reset clears the cache.

## Global Constraints
- All repo content in English; lucide icons, no emojis; no personal data; design tokens only (no palette classes — palette.test.ts).
- Daemon never reads a whole transcript into memory: bounded block reads (≤ 1 MiB per read, ≤ 8 MiB per page response); RPC results ≤ the hub's per-message limit.
- Device can only read history of a session through the hub route for that session's own machine and transcript path (as reported by the mod); cursors are validated (numeric, within file size).
- Initial JS ≤ 655 kB (virtualization + IndexedDB code live in the lazy Session chunk or a lazy module).
- Mod hooks stay within budget; parsing task notifications is synchronous string work.
- Commits: author/committer `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests: `go test ./...`, `claude plugin test mod`, `make typecheck`, `cd app && npx vitest run`, `npm run build`; proto via `make proto`.

## Review Focus
1. A 200 MB transcript with 5,000 compacts: opening the session costs one small page on the daemon and the app stays responsive while scrolling back through many pages.
2. Scrolling back past the hub window seamlessly continues from the machine; no duplicated or missing events at the seam (dedupe by a stable event key: transcript uuid / seq).
3. The machine is offline: history beyond the hub window shows "Older history is on <machine> (offline)" instead of an error; the cache still shows what was seen.
4. A background `npm test` started in a turn: row says running in background; the session is Background; the sheet lists it; when it finishes a card appears, the row turns done, the session becomes Done/unread (Plan 7) — and the notification is not a user bubble.
5. Private browsing / IndexedDB quota exceeded: the app works exactly as today (network only).

---

### Task 1: Daemon — backwards transcript pages and compact boundaries
**Files:** `internal/daemon/transcript/` (reverse block reader + page mapping), `internal/daemon/hublink.go` (backfill uses it), `internal/daemon/rpc.go`/new `history.go` (RPC `transcript_page`), `internal/proto/proto.go` (`compact` event kind + `CompactInfo`, `task_end` kind + `TaskEnd`, `transcript_page` params/result), tests with large synthetic transcripts (generated in tests, not committed).
- [ ] Tests first: a 50k-line synthetic JSONL: page 1 = newest N events with cursor; walking pages to `done` yields every event exactly once in order; memory bounded (reads ≤ 1 MiB blocks; assert via a counting reader); compact markers in the JSONL map to `compact` events; malformed lines skipped; cursor out of range → error; backfill reads only the tail.
- [ ] Implement. Commit `daemon: page transcripts backwards; compact boundaries`.

### Task 2: Mod — compact, background details, task notifications
**Files:** `mod/src/background.ts`, `mod/src/control.ts`, `mod/src/events.ts`, `mod/hooks/register.ts`, mod tests; plugin 0.2.2.
- [ ] Live `compact` event when Claude Code compacts (find the mod hook for compaction; fall back to detecting the transcript compact marker at turn start).
- [ ] Background registry carries details per item: `{id, kind, label (command / monitor target / subagent description / loop prompt), startedAt, nextWake?}`; reported in `SessionInfo.Background.items` (proto) whenever it changes.
- [ ] Tool events for background starts: `tool_end` of a `run_in_background` Bash / Monitor / background Agent carries `background: {taskId}` so the app marks the row "running in background"; the matching task end emits `task_end`.
- [ ] `<task-notification>` prompts: parse id/status/summary/output-file/exit; emit `task_end` (device-like: no seen mark) and suppress the raw user event. Tests with real-shaped notification text.
- [ ] Commit `mod: compact events, background details, task notification cards`.

### Task 3: Hub — history proxy, delta endpoint, retention
**Files:** `internal/hub/appapi.go` (+ `history.go`), `internal/hub/store` (events after seq; retention), tests.
- [ ] `GET /api/sessions/{id}/history?cursor=` → RPC `transcript_page` on the session's machine (409 offline/closed-without-machine with a clear message; 400 bad cursor); dedupe hint: returns events with their transcript keys.
- [ ] `GET /api/sessions/{id}/events?after=<seq>&limit=` (ascending, ≤ 500) for delta sync.
- [ ] Retention job: daily; delete events of sessions closed > 90 days (longer than Claude Code's 30-day transcript cleanup); `PRAGMA incremental_vacuum`; test with a fake clock.
- [ ] Commit `hub: history from the machine, delta events, retention`.

### Task 4: App — virtualized transcript, compacts, history paging, local cache
**Files:** `app/src/components/Transcript.tsx`, `app/src/lib/timeline.ts` (compact, task_end, background rows), `app/src/lib/cache.ts` (IndexedDB; new), `app/src/screens/Session.tsx`, `app/src/lib/store.ts` (caps/eviction), tests; dependency allowed: a small virtualizer (e.g. `@tanstack/react-virtual`) in the lazy chunk.
- [ ] Virtualized rendering preserving stick-to-bottom, load-older on top (hub pages, then machine history pages), scroll position restore; ≤ 600 events in memory per session; eviction of non-open sessions.
- [ ] Compact dividers; collapsed "Earlier conversation (N messages)" row.
- [ ] IndexedDB cache + `after=lastSeq` delta on open/reconnect; guarded storage; cleared on unpair.
- [ ] Offline machine message for history beyond the hub window.
- [ ] Tests (fake IndexedDB via `fake-indexeddb` dev dependency if needed), build size reported. Commit `app: virtualized history, compacts, local cache`.

### Task 5: App — background panel, honest rows, task cards
**Files:** `app/src/components/BackgroundSheet.tsx` (new), `components/StatePill.tsx`/`screens/Session.tsx` (open sheet), `components/timeline/ToolItem.tsx` (running-in-background state), `components/TaskCard.tsx` (new), `app/src/dev/fixtures.ts`, tests.
- [ ] Sheet per design point 5; rows per point 6; cards per point 7; fixtures for every kind; tests. Commit `app: background panel, background rows, task cards`.

### Task 6: Load test and visual QA (controller)
- [ ] Generate a 200 MB synthetic transcript in a scratch dir, register a fake session against a local hub+daemon (or the daemon RPC directly) and measure: first page latency and daemon RSS; app scroll-back through 20 pages in the dev server (fixtures or a local hub). Both themes at 390 px for the new UI.
