# Quorum — app UI for the owner's Claude Code plugins (Plan 6)

Date: 2026-11-23. Status: approach approved in chat; design pending owner review.

## Intent

The owner runs a set of third-party Claude Code plugins (the "better-claude" marketplace) on their machines.
In the terminal those plugins add meters, prompt shortcuts, a task queue, per-turn snapshots and file/image
previews. From the phone (Quorum app) none of that is visible or usable. The owner wants every one of them,
except the narrator (speech) and commit (not used), to work as UI in the app, so the phone shows what the terminal shows.

The owner uses **several Claude Code accounts through whoas** (one identity per job; the repo's `.whoas.yaml`
or profile decides which account a session runs as). Usage figures are per account and must be shown per account.

## Goals

1. Subscription usage (5-hour and weekly windows, % and reset time) **per Claude account**, on the board.
2. Each session shows which account it runs as, its context % (warn 50 %, danger 75 %, `~` when estimated)
   and token counts (session totals; per-turn in, out, cache).
3. Composer chips **Haiku** (sends with `_` prefix) and **Think hard** (sends with `+` prefix); answers made by
   Haiku show "Answered by Haiku".
4. **Queue** (the `after` plugin): see the running and pending tasks of a session; add, add-before, remove,
   edit, move, top, pause, resume, undo, clear.
5. **Timeline** (the `time-machine` plugin): list the session's snapshot states (label, files with +/−, age,
   current position); go to a state, undo, redo; a clear message when a jump is refused because Claude is working.
6. File paths in assistant answers are tappable and open the existing viewer (Quick Peek equivalent).
7. Images pasted in the terminal show as thumbnails in the user's message; tap enlarges (Image Preview equivalent).

## Non-goals

- Narrator and commit plugins.
- Reimplementing any plugin's behaviour inside Quorum (Quorum shows and drives the plugin; it does not replace it).
  Exception: the meters, whose data comes from Claude Code itself, not from the plugins.
- Installing the plugins on machines that do not have them.
- Writing to other plugins' state files.

## Anti-goals

- Showing account emails, tokens or anything secret: only the whoas alias (e.g. `personal`) or "default".
- Mixing usage across accounts (one bar per account, never a single global bar).
- Breaking when a plugin is absent or a newer plugin version changes its files: features silently hide.
- Spanish anywhere in the repo; emojis in UI (lucide icons only).

## Facts the design rests on (from reading the plugins and the mod API)

- `$.session.usage()` gives `context.percent` (or an estimate via `breakdown`), and `rateLimits`
  (`five_hour`, `seven_day`: `percentUsed`, `resetsAt`) for the session's account. `turn.complete` gives
  `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `usage.model`.
- The session's whoas identity: `whoas which claude` run in the session's cwd prints `claude@<alias> via …`;
  sessions not under whoas have no identity ("default").
- `after` keeps its queue in its `$.store` file `~/.claude/plugins/store/after_better-claude-<hash>.json`,
  key `queue:<sessionId>` (`items[{id,text,createdAt}]`, `running`, `paused`, `done`, …). Commands:
  `/after <task>`, `/before <task>`, `rm n|n-m|last|all`, `edit n <text>`, `mv a b`, `top n`, `pause`, `resume`,
  `undo`, `clear`, `list`. Registered as immediate (works mid-turn when typed).
- `time-machine` keeps states in its store file `time-machine_better-claude-<hash>.json`, key `session:<id>`
  (`states[{id, kind, label, at, files[{path,status,added,removed}], prompt}]`, `cursor`), and git refs
  `refs/time-machine/<sessionId>/<id>`. Commands: `/timeline <n>`, `/timeline undo`, `/timeline redo`;
  a jump is refused while a turn or a writing tool runs.
- `use-haiku` (`_` prefix) and `think-hard` (`+` prefix) accept prompts submitted by another plugin
  (Quorum's `$.prompt.submit`), `_` only when idle.
- `image-preview` reads pasted images from `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>/<dashed project path>/<sessionId>/images/<N>.<ext>`.
- Store files are written by Claude Code; an outside process may only read them. Their `<hash>` suffix is not
  known in advance: match `<plugin>_better-claude-*.json`.
- Running another plugin's slash command from Quorum's mod: `$.command.run({command, args})` exists but
  queues until idle; whether a `$.prompt.submit('/after x')` is parsed as a command is undocumented. **Unproven:
  the plan starts with a spike.**

## Approaches considered

1. **Mod-centric (chosen).** Quorum's mod reports meters, account and plugin presence; the daemon reads the
   plugins' store files and images on request; commands go through the mod. Robust (meters don't depend on the
   plugins), and plugin features hide when the plugin is absent.
2. Daemon reads everything from files only. Rejected: context/token/usage meters are memory-only in the plugins.
3. Ask the plugin author for an API. Rejected: out of our control.

## Design

### A. Account and meters (mod → daemon → hub → app)
- Mod, on session start (and when cwd/root changes): resolve the account alias by running `whoas which claude`
  in the session cwd through a login shell (same rule as launches); parse `claude@<alias>`; on failure or no
  whoas → `default`. Report it in `SessionInfo.account` (new field).
- Mod, on `turn.complete` and on `session.measure` (rate-limited to once per 30 s): report
  `usage { rateLimits:[{kind, percentUsed, resetsAt}], contextPct, contextEstimate, turnTokens{in,out,cache},
  sessionTokens{in,out,cache}, model }` as a session event / SessionInfo fields (builder chooses the exact proto
  shape; it must be in `internal/proto` and generated with `make proto`).
- Hub keeps the latest rate limits **per account** (`account → {five_hour, seven_day, at}`), newest `at` wins,
  persisted in SQLite; sends them to apps (`usage_upsert` envelope + included in the initial REST load).
- App board: a compact strip at the top with one entry per account seen in the last 7 days:
  `<alias>  5h 58% · 2h 10m   week 22% · 3d`; colour warn ≥ 80 %, danger ≥ 95 %; stale (> 1 h old) shown dimmed.
- App session header: account alias chip, context % with the 50/75 colours and `~`, session tokens `↑12k ↓3k`.
  Each assistant turn in the timeline ends with a small muted line `↑1.2k ↓340 · cache 4.1k` and, when the
  turn's model is Haiku, `Answered by Haiku`.

### B. Plugin presence
- Mod reports which of the supported plugins are enabled for the session (`after`, `time-machine`, `use-haiku`,
  `think-hard`, `image-preview`, `quick-peek`) in `SessionInfo.plugins: string[]`, using the mod API's plugin
  listing if available, else the enabled plugins in Claude Code settings. Features in B–E show only when present.
  Quick Peek-equivalent (F) works regardless (it is Quorum's own viewer).

### C. Composer chips
- When `use-haiku` / `think-hard` are present: two toggle chips above the textarea, `Haiku` and `Think hard`
  (mutually independent; both set → `_+` order per the plugins' parsing: builder verifies which order both accept,
  or makes them exclusive if they cannot combine). The chip state resets after a send. Haiku chip disabled with a
  hint while the session is working (the plugin ignores `_` mid-turn).

### D. Queue (after)
- New device command `plugin_command {session, command, args}` app → hub → daemon → mod, executed by the mod with
  the mechanism proven in the spike. Allowed commands: `after`, `before`, `timeline` only (allow-list in the mod).
- Daemon RPC `plugin_state {session, plugin}` reads the plugin's store file (glob, read-only, ≤ 4 MiB, JSON) and
  returns only the entry for that session (`queue:<sid>` / `session:<sid>`).
- App: collapsible "Queue (N)" section above the composer: running item (spinner), pending items with ⋯ (Edit,
  Move to top, Remove), add box ("Add after" / "Add before"), Pause/Resume, Undo, Clear (confirm). The existing
  composer "Queue" mode sends `/after <text>` when `after` is present (otherwise keeps today's behaviour).
- Refresh: after every command and on the session's `turn.complete`; no polling faster than every 5 s while the
  section is open.

### E. Timeline (time-machine)
- App: "Timeline (N)" section (sheet on phone): one row per state, newest first: label, kind, age, file count with
  +/−; current state marked; expand a row to see its files. Actions: Go to this state, Undo, Redo. While the
  session is working, actions are disabled with "Wait until Claude finishes". The plugin's refusal text, if any,
  is shown.

### F. Paths in answers
- In assistant markdown, absolute or session-relative paths that exist under the session's root/cwd become links
  (detection client-side by pattern; existence checked lazily by the daemon `file_read` stat on tap). Tap → the
  existing Viewer (code shown as highlighted text, images, html/pdf as today). Paths outside the base stay text.

### G. Pasted images
- Mod reports pasted image references on `prompt.submit` (`[Image #N]` → file path in the session images dir).
  The app's user message shows thumbnails loaded through the existing `/v/` view-link mechanism with the images
  dir allowed as base for that session only; tap opens the Viewer.

## Constraints
- All repo content in English; no emojis in UI; lucide icons.
- No account emails/tokens anywhere; alias only. No real alias names in tests/docs (use `work`, `personal-test`).
- Mod must keep its hooks within their budgets (whoas lookup is async, cached per cwd, timeout 3 s).
- Reading other plugins' files is read-only and tolerant: unknown shape → feature hidden, logged once.
- Initial JS budget stays ≤ 655 kB (Queue/Timeline may live in the lazy session chunk).
- Phone-first: 320 px, touch targets ≥ 44 px. Break UI pass with dev fixtures extended to these features.

## Left to the builder
- Exact proto shapes and envelope names; SQLite schema for per-account usage.
- How the mod lists enabled plugins (API vs settings file).
- Chip combination rule for `_` and `+` after checking both plugins.

## Risks
- The spike may show `$.command.run` cannot run another plugin's command from the mod, or only when idle.
  Fallback: send the command text with `$.prompt.submit` if Claude Code parses it as a command; otherwise Queue and
  Timeline become read-only views and the owner is told.

## Calls made after the builder check (design author's calls)

1. **Command results.** `plugin_command` returns only "sent" / an error. The app learns the outcome by re-reading the
   plugin's state (D, E). For Timeline, if the cursor did not move after a jump the app shows
   "The timeline did not move. Claude may be working; try again when it finishes."
2. **Account key across machines.** The mod calls `$.session.identity()`; when it yields an email or organization id,
   the mod sends `accountKey = sha256("quorum-account:" + email-or-org)` (first 16 hex chars) — never the raw value.
   The hub keys usage by `accountKey`; the display name is the whoas alias seen most recently for that key (or
   "default"). Without identity data the key is `machine + "/" + alias`, so accounts are never merged by guess.
3. **Spike scope and fallback.** Goals A, B, C, F and G do not depend on the spike and are planned independently.
   The spike must prove, on a real session: (a) the mod can run `/after <task>` and `/timeline undo` for its own
   session; (b) whether `/after` added while a turn runs is queued immediately (pass) or only after the turn
   (acceptable, documented); (c) `queue:<id>` / `session:<id>` and the images dir use the same session id Quorum
   uses, including after `/clear` and resume. If (a) fails, Queue and Timeline ship read-only (no action buttons, no
   add box), the composer keeps today's Queue mode, and the owner is told.
4. **Store location.** The mod reports the session's Claude config dir (`CLAUDE_CONFIG_DIR` or the default
   `~/.claude`) in SessionInfo; the daemon looks for plugin store files under `<configDir>/plugins/store/`, so whoas
   identities with separate config dirs work.
5. **Freshness.** After a command the app re-reads once after 1 s and once after 3 s; while the section is open it
   also re-reads on the session's `turn.complete`; otherwise no polling.
6. **Argument hygiene.** The mod rejects plugin command args containing newlines or control characters and caps them
   at 2,000 characters; the command name must be on the allow-list (`after`, `before`, `timeline`); timeline args must
   match `^(undo|redo|\d{1,4})$`.
7. **Composer Queue.** Today "Queue" uses Claude Code's own prompt queue. When `after` is present the composer's
   "Queue" item sends `/after <text>` instead (one queue, the visible one); otherwise unchanged.
8. **API-key / third-party accounts.** No `rateLimits` → that account has no entry in the usage strip.
