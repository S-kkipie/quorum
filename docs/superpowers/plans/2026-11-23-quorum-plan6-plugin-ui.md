# Plugin UI in the app — Implementation Plan (Plan 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show and drive the owner's better-claude plugins (meters, Haiku/Think-hard prefixes, `after` queue, `time-machine` timeline, file-path peek, pasted images) from the Quorum app, with subscription usage per Claude account.

**Architecture:** The mod reports account, config dir, enabled plugins and usage meters on the session and on `turn_end`; the hub persists per-account usage and relays it; the daemon reads plugin store files read-only on request; plugin commands travel app → hub → daemon → mod as a new `Command` type. The app adds a usage strip, session header meters, composer chips, Queue and Timeline sections, path links and image thumbnails.

**Tech Stack:** Go (hub, daemon, SQLite modernc), TypeScript Claude Code mod (`claude plugin test mod`), React 19 + Vite + Tailwind v4 + vendored shadcn/AI Elements (vitest + Testing Library).

**Spec:** `docs/superpowers/specs/2026-11-23-quorum-plugin-ui-design.md` (read the "Calls made after the builder check" section too).

## Global Constraints

- All repo content in English: code, comments, identifiers, UI text, errors, commits, docs. No emojis in UI; lucide icons.
- Never send, store or log account emails, organization ids or tokens: only `accountKey = first 16 hex of sha256("quorum-account:" + email-or-org)` and the whoas alias (or `default`).
- No real aliases, hostnames, IPs, user names or personal paths in code/tests/docs; test aliases `work`, `personal-test`; machines `vps-1`, `laptop`.
- Other plugins' files are read-only for Quorum; unknown shape → feature hidden, logged once per daemon run.
- Store files live under `<configDir>/plugins/store/` and are matched by glob `<plugin>_better-claude-*.json`; reads capped at 4 MiB.
- Plugin command allow-list: `after`, `before`, `timeline`; args ≤ 2,000 chars, no newlines/control chars; timeline args match `^(undo|redo|\d{1,4})$`.
- Mod hooks stay within budget: whoas lookup async, cached per cwd, timeout 3 s; usage reports at most once per 30 s per session (turn_end always carries its tokens).
- Usage colours: board strip warn ≥ 80 %, danger ≥ 95 %, stale (> 1 h) dimmed; context warn ≥ 50 %, danger ≥ 75 %, `~` prefix when estimated.
- Initial JS ≤ 655 kB (sum of index + lib + preload-helper + runtime chunks in dist/index.html); new session-only UI goes in the lazy Session chunk.
- Phone-first: 320 px, no horizontal page scroll, touch targets ≥ 44 px (`min-h-11`).
- Commits: author/committer `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests: `export PATH=$PATH:$HOME/.local/go/bin; go test ./...`, `claude plugin test mod`, `cd app && npx vitest run`, `npm run build`; proto changes via `make proto`.

## Review Focus

1. Two machines report the same account (same `accountKey`) with different aliases → one usage entry, labelled with the most recent alias; two different accounts with the same alias → two entries.
2. A session whose machine lacks the plugins (e.g. the VPS) → no chips, no Queue, no Timeline, no thumbnails; meters still shown.
3. Plugin store file missing, empty, malformed or from a newer plugin version with a different shape → the section hides; no error toast, no crash.
4. `/timeline 3` sent while Claude is working → the app shows "The timeline did not move. Claude may be working; try again when it finishes." and nothing else breaks.
5. Queue task text containing a newline or starting with `/` → rejected in the app before sending, and again by the mod.

---

### Task 1: Spike — running another plugin's command from the mod

**Files:**
- Create: `mod/src/plugincmd.ts`, `mod/test/plugincmd.test.ts`, `docs/superpowers/specs/2026-11-23-plugin-command-spike.md`
- Modify: `mod/src/control.ts` (new `case 'plugin'`), `internal/proto/proto.go` (`Command` gains `Command string json:"command"` and `Args string json:"args"`; `Type` doc adds `plugin`), generated `proto.gen.ts` via `make proto`

**Interfaces:**
- Produces: `validatePluginCommand(command: string, args: string): string | null` (null = ok, else an English error) and `runPluginCommand(deps, command, args): Promise<{ok: boolean, error?: string}>` in `mod/src/plugincmd.ts`; `Command{type:'plugin', command, args}` handled in `control.handle`. The spike doc records which mechanism works (`$.command.run({command, args})` vs `$.prompt.submit({text: '/' + command + ' ' + args, asUser: true})`), mid-turn behaviour for `after`, and whether `queue:<id>` / `session:<id>` / the images dir use Quorum's session id (also after `/clear` and resume).

- [ ] **Step 1: Unit tests** in `mod/test/plugincmd.test.ts`: `validatePluginCommand('after','fix the build')` → null; `('rm','x')` → error; `('after','a\nb')` → error; `('after', 'x'.repeat(2001))` → error; `('timeline','undo')`, `('timeline','42')` → null; `('timeline','3; rm')` → error. `control.handle({type:'plugin', command:'after', args:'x'})` calls the run dependency once with `('after','x')`; an invalid one emits an `info` event with the error and runs nothing.
- [ ] **Step 2:** `claude plugin test mod` → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Live spike** on this machine (it has the better-claude plugins): start an interactive `claude` in a scratch git repo inside a detached tmux session (own tmux socket via `-L quorum-spike`), with the working-tree mod loaded and the installed `quorum@quorum` disabled for that run only (e.g. a temporary `CLAUDE_CONFIG_DIR` copy or `--plugin-dir` plus settings override — choose and document; never modify the owner's real settings or tabs). Drive a device command through the real path if practical, otherwise through a temporary test-only trigger that is removed before commit. Prove: (a) `/after <task>` lands in the after store `queue:<sid>`; (b) behaviour when sent mid-turn; (c) `/timeline undo` moves `cursor`; (d) the session ids match. Clean up tmux, temp dirs and any test session (close it). Write the findings to the spike doc.
- [ ] **Step 6:** Commit `mod: plugin commands (spike)` including the spike doc. If (a) or (c) cannot work by any mechanism, report BLOCKED with the doc: the controller then rules Queue/Timeline read-only (spec call 3).

### Task 2: Mod reports account, config dir, plugins and meters

**Files:**
- Create: `mod/src/account.ts`, `mod/src/meters.ts`, tests `mod/test/account.test.ts`, `mod/test/meters.test.ts`
- Modify: `internal/proto/proto.go` (SessionInfo fields below; `TurnEnd`-event data doc), `mod/hooks/register.ts`, `mod/src/events.ts`, `make proto`

**Interfaces:**
- Produces (proto): `SessionInfo.Account string json:"account"` (alias or `default`), `AccountKey string json:"accountKey"`, `ConfigDir string json:"configDir"`, `Plugins []string json:"plugins"` (subset of `after,time-machine,use-haiku,think-hard,image-preview,quick-peek`), `ContextEstimate bool json:"contextEstimate"`, `Tokens TokenCount json:"tokens"` (session totals) with `TokenCount{In,Out,Cache int}`; `RateLimit{Kind string ("five_hour"|"seven_day"), PercentUsed float64, ResetsAt string}` and `SessionInfo.RateLimits []RateLimit json:"rateLimits"`. `turn_end` event data gains `tokens: TokenCount` and `model: string`.
- Produces (mod): `parseWhoasWhich(out: string): string` (`claude@work via …` → `work`; anything else → `default`), `accountKey(idValue: string): Promise<string>`, `enabledPlugins(...)`, `sumTokens(usage): TokenCount`.

- [ ] **Step 1: Tests:** `parseWhoasWhich('claude@work via default profile (profile work)')` → `work`; `('')`/`('not found')` → `default`. `accountKey('a@example.com')` is 16 lowercase hex and stable; differs for another input. `sumTokens({input_tokens:1000, output_tokens:200, cache_read_input_tokens:50, cache_creation_input_tokens:25})` → `{in:1000,out:200,cache:75}`. Register test: on `session.start` the registered SessionInfo carries `account`, `accountKey` (or empty when identity unavailable — then the hub uses machine/alias), `configDir`, `plugins`; `turn.complete` emits `turn_end` with `tokens` and `model` and updates session `tokens` totals; `rateLimits` update is throttled to once per 30 s. The email/org value never appears in any emitted payload (assert on JSON of all calls).
- [ ] **Step 2:** FAIL. **Step 3:** Implement: whoas lookup via `$.process.run(['bash','-lc','whoas which claude'], {cwd, timeoutMs:3000})` cached per cwd; identity via `$.session.identity()` defensively (`optional()`); config dir from `CLAUDE_CONFIG_DIR` env or `~/.claude`; plugins via the mod API's plugin listing if present, else `enabledPlugins` in `<configDir>/settings.json` (keys `<name>@better-claude: true`). **Step 4:** PASS. **Step 5:** Commit `mod: report account, plugins and usage meters` and bump plugin to `0.1.6`.

### Task 3: Hub persists per-account usage and the new session fields

**Files:**
- Modify: `internal/hub/store/migrations.go`, `internal/hub/store/store.go` (+tests), `internal/hub/machines.go` (session_upsert path), `internal/hub/appapi.go` (REST), `internal/proto/proto.go` (envelope doc), `app/src/lib/store.ts` (+test)

**Interfaces:**
- Produces: table `account_usage(account_key TEXT PRIMARY KEY, alias TEXT, five_hour_pct REAL, five_hour_resets TEXT, seven_day_pct REAL, seven_day_resets TEXT, at INTEGER)`; key = `accountKey` or `machine + "/" + account` when empty. Session columns for `account`, `account_key`, `config_dir`, `plugins` (JSON), `context_estimate`, `tokens` (JSON). `GET /api/usage` → `[]AccountUsage{key, alias, fiveHour{pct,resetsAt}, sevenDay{pct,resetsAt}, at}` (only rows with at < 7 days). Envelope `usage_upsert` (hub→app, Payload AccountUsage) on change. App: `AppState.usage: Record<string, AccountUsage>`, reducer for `usage_upsert`, initial load of `/api/usage`.

- [ ] **Step 1: Tests:** store upsert keeps newest `at`; alias updated to the latest report; same key from two machines → one row; empty accountKey → key `vps-1/work`; rows older than 7 days excluded from the REST list; session fields round-trip; a session_upsert with rateLimits publishes `usage_upsert` once (not when unchanged). App reducer test.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (`go test ./...`, vitest). **Step 5:** Commit `hub: per-account usage and plugin session fields`.

### Task 4: App meters — usage strip, session header, per-turn tokens

**Files:**
- Create: `app/src/components/UsageStrip.tsx`, `app/src/lib/meters.ts` (+tests)
- Modify: `app/src/screens/Projects.tsx` (strip on top), `app/src/screens/Session.tsx` (header), `app/src/components/Transcript.tsx` (turn footer), `app/src/dev/fixtures.ts` (usage + tokens in worst/one/huge)

**Interfaces:**
- Produces: `formatTokens(n: number): string` (`999`, `1.2k`, `12k`, `1.2M`), `usageTone(pct: number): 'ok'|'warn'|'danger'` (≥80 warn, ≥95 danger), `contextTone(pct)` (≥50 warn, ≥75 danger), `resetIn(iso: string, now): string` (`2h 10m`, `3d`).

- [ ] **Step 1: Tests:** helpers above with boundary values (79/80/94/95, 49/50/74/75). UsageStrip renders one entry per account `work  5h 58% · 2h 10m   week 22% · 3d`, sorted by highest pct; stale (> 1 h) entry has `data-stale`; no accounts → renders nothing. Session header shows the account chip (`work`), `ctx ~58%` with tone class when estimated, `↑12k ↓3k`. A turn_end with `{tokens:{in:1200,out:340,cache:4100}, model:'claude-haiku-5-5'}` renders `↑1.2k ↓340 · cache 4.1k` and `Answered by Haiku`; a non-Haiku model shows no "Answered by".
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + build (budget). **Step 5:** Commit `app: usage per account, context and token meters`.

### Task 5: Composer chips — Haiku and Think hard

**Files:**
- Modify: `app/src/components/Composer.tsx` (+test)

**Interfaces:**
- Consumes: `SessionInfo.plugins` (Task 2/3).
- Produces: `applyPrefixes(text: string, o: {haiku: boolean, think: boolean}): string` exported from Composer (or `lib/prefix.ts`).

- [ ] **Step 1: Read** `use-haiku` and `think-hard` `prompt.submit` handlers (`~/.claude/plugins/cache/better-claude/{use-haiku,think-hard}/*/hooks/register.ts*`) and decide the combined order that both accept; if none, make the chips mutually exclusive. Record the decision in the commit body.
- [ ] **Step 2: Tests:** chips render only when the session's plugins include `use-haiku` / `think-hard`; toggled chips have `aria-pressed="true"`; sending with Haiku sends `_text`, Think hard `+text`, both per Step 1; chips reset after a successful send; Haiku chip disabled with title `Haiku applies when Claude is idle` while state is `working`; text already starting with `_`/`+` is not double-prefixed.
- [ ] **Step 3:** FAIL → implement → PASS. **Step 4:** Commit `app: Haiku and Think hard chips`.

### Task 6: Plugin state RPC and command route

**Files:**
- Create: `internal/daemon/pluginstate.go` (+test)
- Modify: `internal/hub/appapi.go` (routes), hub tests, `app/src/lib/api.ts` (+test)

**Interfaces:**
- Consumes: `Command{type:'plugin', command, args}` (Task 1); `SessionInfo.ConfigDir` (Task 2/3).
- Produces: daemon RPC `plugin_state` params `{configDir, plugin: "after"|"time-machine", session}` → the JSON value of key `queue:<session>` (after) or `session:<session>` (time-machine), or `null`; errors "unknown plugin", "state too large". Hub: `GET /api/sessions/{id}/plugins/{plugin}` (uses the session's machine + configDir) and `POST /api/sessions/{id}/plugin` body `{command, args}` → validates with the same rules as the mod (Go copy, tested against the same cases) → sends the Command to the session's daemon; 204 or 400 with the English error. App: `pluginState(id, plugin)`, `pluginCommand(id, command, args)`.

- [ ] **Step 1: Tests:** daemon reads `<configDir>/plugins/store/after_better-claude-abc123.json` via glob and returns only `queue:<sid>`; missing file → null; malformed JSON → null + one log line; file > 4 MiB → "state too large"; `plugin` not in allow-list → "unknown plugin"; configDir must be absolute and is cleaned (no `..`). Hub: route 400 on `{command:'rm'}` and on newline args; 204 forwards a Command with type `plugin`.
- [ ] **Step 2:** FAIL → implement → PASS. **Step 3:** Commit `daemon, hub: plugin state and plugin commands`.

### Task 7: Queue section (after)

**Files:**
- Create: `app/src/components/QueueSection.tsx` (+test)
- Modify: `app/src/screens/Session.tsx`, `app/src/components/Composer.tsx` (Queue menu item → `/after` when `after` present), `app/src/dev/fixtures.ts`

**Interfaces:**
- Consumes: `pluginState(id,'after')`, `pluginCommand(id, cmd, args)` (Task 6). Queue shape (from the plugin): `{items:[{id,text,createdAt}], running:{id,text}|null, paused:boolean, done:[…]}` — tolerate missing fields.

- [ ] **Step 1: Tests:** hidden when plugins lack `after` or state is null; header `Queue (2)` collapsed by default; expanded shows the running item with a spinner and pending items numbered 1..n; item ⋯ menu `Edit`, `Move to top`, `Remove` sends `edit n <text>`, `top n`, `rm n` via `pluginCommand(id,'after', …)`; add box with `Add after` / `Add before` (sends command `after`/`before` with the text); text with a newline or leading `/` shows `Use one line that does not start with /` and sends nothing; `Pause`/`Resume` per `paused`; `Undo`; `Clear` asks to confirm (`Clear the queue?`); after a command the state is re-read at 1 s and 3 s (fake timers) and on the session's next `turn_end`. Composer "Queue" menu item sends `pluginCommand(id,'after',text)` when `after` is present, else `sendPrompt(...,'queue')`.
- [ ] **Step 2:** FAIL → implement → PASS. **Step 3:** Commit `app: queue section for the after plugin`. If Task 1 ruled read-only: no action controls, composer unchanged; tests adjusted accordingly.

### Task 8: Timeline section (time-machine)

**Files:**
- Create: `app/src/components/TimelineSection.tsx` (+test)
- Modify: `app/src/screens/Session.tsx`, `app/src/dev/fixtures.ts`

**Interfaces:**
- Consumes: `pluginState(id,'time-machine')` → `{states:[{id, kind, label, at, files:[{path,status,added,removed}]}], cursor}`; `pluginCommand(id,'timeline', 'undo'|'redo'|'<n>')`.

- [ ] **Step 1: Tests:** hidden without the plugin or state; `Timeline (5)` opens a Sheet listing states newest first with label, age (`since`), `3 files +12 −4`; the state whose id equals `cursor` is marked `Current`; expanding a row lists its files; `Go to this state` sends `timeline <n>` where n is the state's 1-based position as the plugin numbers it (verify against the plugin's `/timeline <n>` parser and pin it in the test); `Undo`/`Redo` send `timeline undo|redo`; while the session state is `working` all actions are disabled with `Wait until Claude finishes`; if after the 3 s re-read `cursor` is unchanged, show `The timeline did not move. Claude may be working; try again when it finishes.`
- [ ] **Step 2:** FAIL → implement → PASS. **Step 3:** Commit `app: timeline section for the time-machine plugin`.

### Task 9: Tappable file paths in answers

**Files:**
- Create: `app/src/lib/paths.ts` (+test)
- Modify: `app/src/components/ai-elements/message.tsx` (MessageResponse text renderer hook) or `components/Transcript.tsx`, Session wiring to the existing `onOpenFile(machine, path)`

**Interfaces:**
- Produces: `findPaths(text: string, base: string): {start: number, end: number, path: string}[]` — absolute paths under `base` and relative paths with a `/` and an extension (`src/a.ts`, `./docs/x.md`), resolved against `base`; ignores URLs, paths outside base, and code fences (paths inside inline code count).

- [ ] **Step 1: Tests:** `findPaths('Edited src/auth/google.ts and /home/u/app/README.md', '/home/u/app')` → two paths (`/home/u/app/src/auth/google.ts`, `/home/u/app/README.md`); `https://x.dev/a.ts` ignored; `/etc/passwd` ignored (outside base); trailing punctuation `google.ts.` excluded; rendering an assistant message turns them into buttons that call `onOpenFile(machine, absPath)`; a missing file opens the Viewer which shows its existing "does not exist" error.
- [ ] **Step 2:** FAIL → implement → PASS. **Step 3:** Commit `app: open file paths from answers`.

### Task 10: Pasted image thumbnails

**Files:**
- Modify: `mod/src/events.ts` / `mod/hooks/register.ts` (user event gains `images:[{n:number, path:string}]` when the prompt contains `[Image #N]` and the file exists in the session images dir), mod tests; `internal/hub/views.go` (allow creating a view link whose base is the session's images dir: `POST /api/machines/{m}/views {sessionId, path, images:true}` → base = dir of path, only if the path matches the images dir pattern of that session), hub tests; `app/src/components/Transcript.tsx` (thumbnails) + test

**Interfaces:**
- Produces: `imagesDir(tmpRoot: string, uid: number, projectPath: string, sessionId: string): string` in the mod (`<tmp>/claude-<uid>/<projectPath with / → ->/<sessionId>/images`), using `CLAUDE_CODE_TMPDIR` or `/tmp`.

- [ ] **Step 1: Tests:** mod — prompt `look at [Image #1] and [Image #2]` with files `1.png` present and `2.jpg` missing → `images:[{n:1, path:…/1.png}]`; `imagesDir('/tmp', 1000, '/home/u/app', 'S1')` → `/tmp/claude-1000/-home-u-app/S1/images`. Hub — images view link refused for a path outside that pattern or another session's dir; accepted inside. App — a user message with `images` renders a 64 px thumbnail per image (`img` src from the view link, `alt="Image #1"`), tap opens the Viewer; this is the only `<img>` with a non-data src in the transcript and its src is same-origin `/v/…`.
- [ ] **Step 2:** FAIL → implement → PASS. **Step 3:** Commit `mod, hub, app: thumbnails for pasted images`.

---

After Task 10 and the final review: the controller extends the Break UI pass to the new UI with the dev fixtures (`?data=worst|empty|one|huge` at 320 px and 1280 px), deploys hub + daemon + plugin 0.1.6 to both machines when the owner asks, and checks one real session on this PC (meters, chips, Queue, Timeline).
