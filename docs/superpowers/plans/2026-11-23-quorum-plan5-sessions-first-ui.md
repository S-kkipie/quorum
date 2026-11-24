# Sessions-first UI on shadcn + AI Elements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut session-list noise (headless runs, empty sessions, closed sessions in the global list) and make the project screen and board sessions-first (one merged session list, tickets behind ⋯), keep composer drafts across navigation, and rebuild the app on shadcn + AI Elements, with a dev-only worst-case data toggle for the Break UI pass.

**Architecture:** Pure helpers in `app/src/lib/` (session merge, drafts, AI Elements adapter) with unit tests; screens consume them. shadcn primitives are vendored into `app/src/components/ui/`, AI Elements into `app/src/components/ai-elements/`. Navigation stays in `App.tsx` (`Nav` in `history.state`) with one new level for project tickets. Dev fixtures live in `app/src/dev/` and load only under `import.meta.env.DEV`.

**Tech Stack:** React 19, Vite 8, Tailwind v4, TypeScript, vitest + Testing Library (jsdom), shadcn/ui, AI Elements, lucide-react.

**Spec:** `docs/superpowers/specs/2026-11-23-quorum-sessions-first-ui-design.md` (read the "Calls made after the builder check" section too).

## Global Constraints

- All repo content in English: code, comments, identifiers, UI text, errors, commits, docs.
- No emojis in the UI; icons from lucide-react (or inline SVG).
- Public repo hygiene: no hostnames, IPs, user names, personal paths or real project names in code, tests, fixtures or docs. Fixture machines are `vps-1`, `laptop`, `desktop-wsl`; projects are fictional.
- Commits: author/committer `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`; message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Remote images in Markdown are never rendered as `<img>`; they render as links. Links open with `target="_blank" rel="noopener noreferrer"`. No `dangerouslySetInnerHTML` of session data.
- Artifacts keep opening in the existing sandboxed `Viewer`; `app/public/sw.js` keeps bypassing `/v/` and `/api`.
- Build output stays `internal/hub/web/dist` (Go embed); `dist/.keep` plugin stays.
- Phone-first: works at 320 px with no horizontal page scroll; touch targets ≥ 44 px (`min-h-11`).
- Dark-only theme matching today's zinc palette (body `#0b0d10`, text `#e5e7eb`, borders zinc-800, accent blue-600).
- Initial JS (the entry chunk(s) loaded by `index.html`) ≤ 655 kB minified; syntax highlighting loaded with dynamic `import()`.
- Install only the AI Elements / shadcn components used; never the all-in-one bundle. Install from the shadcn/ui registry (where AI Elements now lives); fall back to `npx shadcn@latest add @ai-elements/<name>` only for a component not available there.
- Only `import type` from the `ai` package if a component's props need its types; no AI SDK runtime (`useChat`, transports).
- Drafts: `localStorage` key `quorum.draft.<id>`, debounce 300 ms, max 30 drafts (oldest dropped), every storage access in try/catch.
- Merged list shows the first 8 closed rows; "See all (N)" reveals a title search.
- Test command: `cd app && npx vitest run`; build: `cd app && npm run build`.

## Review Focus

1. A session that closes after the user only opened it (no prompt) disappears from every app list live, without a reload.
2. A conversation that is live on one machine and also listed by another checkout → appears once, as the live row.
3. One checkout's `listConversations` rejects (machine offline or old daemon) → the other checkouts' rows still show, plus one muted line `<machine>: could not list conversations`.
4. `localStorage` throws (private mode, blocked storage) → composer types and sends normally; no crash.
5. Assistant text containing `![x](https://example.com/a.png)` and raw `<img src=…>` → rendered as a link / inert text, never an `<img>` with a remote `src`.
6. Phone: project → ⋯ → Tickets → ticket → Back → Back returns to tickets then to the project; on wide layout the tickets view renders in the right aside.

---

### Task 1: shadcn + AI Elements setup and spike

**Files:**
- Create: `app/components.json`, `app/src/lib/utils.ts` (`cn`), `app/src/components/ui/*`, `app/src/components/ai-elements/*`, `docs/superpowers/specs/2026-11-23-ai-elements-spike.md`
- Modify: `app/tsconfig.json` (`baseUrl`/`paths` `@/*` → `src/*`), `app/vite.config.ts` (`resolve.alias` `@` → `src`), `app/src/index.css` (shadcn tokens, dark values), `app/package.json`
- Test: `app/src/components/ai-elements/spike.test.tsx`

**Interfaces:**
- Produces: `@/` alias; `cn(...classes)` in `@/lib/utils`; vendored shadcn `button, card, badge, dropdown-menu, dialog, sheet, input, textarea, collapsible, scroll-area, tooltip`; vendored AI Elements `conversation, message, response (or the current markdown-response component), tool, confirmation, prompt-input, code-block, artifact, loader, shimmer`. The spike doc records, for each AI Elements component: file path, props used, whether it works as-is, and the fallback adopted.

- [ ] **Step 1:** Initialise shadcn for Vite (CSS variables, dark tokens mapped to the zinc palette in Global Constraints; the root element always carries the `dark` class). Add the alias in tsconfig and vite.
- [ ] **Step 2:** Add the shadcn primitives and AI Elements components listed above. Run `npm run build`; expected: success.
- [ ] **Step 3: Write the spike test** `spike.test.tsx` (jsdom):
  - `markdown response renders remote images as links`: render the chosen markdown component with `'![chart](https://example.com/a.png)'` → `container.querySelector('img')` is null and a link with `href="https://example.com/a.png"` exists.
  - `markdown response does not render raw html`: input `'<img src="https://example.com/x.png" onerror="alert(1)">'` → no `img` element.
  - `tool hosts custom children`: render Tool with header title `"Read google.ts"` and a child `<pre>diff</pre>`, open it → `pre` text visible.
- [ ] **Step 4:** Run `npx vitest run src/components/ai-elements/spike.test.tsx`. If the AI Elements markdown component cannot satisfy the two Markdown tests through its props/components overrides, adopt the fallback: Message renders the existing `components/Markdown.tsx`; delete the failing assertions' target and point the tests at `Markdown`. Record which in the spike doc.
- [ ] **Step 5:** Record bundle impact: `npm run build` and note entry chunk size in the spike doc. If highlighting (shiki or similar) lands in the entry chunk, make the code-block component load it with dynamic `import()`.
- [ ] **Step 6:** Full suite `npx vitest run` passes (no screen changed yet). Commit `ui: set up shadcn and vendor AI Elements components`.

### Task 2: merged session list helpers and conversation cache

**Files:**
- Create: `app/src/lib/sessions.ts`, `app/src/lib/sessions.test.ts`
- Modify: `app/src/lib/store.ts` (state field + setter), `app/src/lib/store.test.ts`

**Interfaces:**
- Produces:
  - `type SessionRow = { kind: 'live'; id: string; session: SessionInfo } | { kind: 'closed'; id: string; machine: string; root: string; title: string; updatedAt: number; messages: number }`
  - `const ATTENTION: Record<string, number>` — `needs_you` 0, `waiting` 1, `working` 2, `idle` 3 (the keys of `SESSION_STATE` in `lib/projects.ts`); unknown states 3.
  - `mergeSessions(live: SessionInfo[], lists: { machine: string; root: string; list: Conversation[] }[]): SessionRow[]`
  - `lastActivity(s: AppState, projectId: string): number` (ms; 0 when unknown) — max of live sessions' `updatedAt` and cached conversations of the project's checkouts.
  - `AppState.conversations: Record<string, Conversation[]>` keyed `machine + '\u0000' + root`; `setConversations(s, machine, root, list): AppState`.

- [ ] **Step 1: Write failing tests** in `sessions.test.ts`:
  - `live wins over listed`: live `{id:'a'}` on `vps-1`, list from `laptop` containing `{id:'a', open:false}` → one row, `kind:'live'`.
  - `closed listed twice keeps the newest`: `{id:'b', updatedAt:100}` from `vps-1:/w/app` and `{id:'b', updatedAt:200}` from `laptop:/w/app` → one closed row, `updatedAt:200`, `machine:'laptop'`.
  - `order`: live rows sorted by ATTENTION then by input order; closed rows by `updatedAt` desc after all live rows.
  - `title fallback`: closed title = `title || firstPrompt || id`.
  - `open but not live`: listed `{open:true}` whose id is not among live sessions → `kind:'closed'` (the store is the source of truth for liveness).
  - `lastActivity` returns 0 for a project with nothing known, and the max otherwise.
  - store: `setConversations` stores under the composed key and does not touch other keys.
- [ ] **Step 2:** Run `npx vitest run src/lib/sessions.test.ts src/lib/store.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Normalise `updatedAt` to ms where the source is seconds (same rule as `ago()` in `screens/Sessions.tsx`: `ts > 1e12 ? ts : ts * 1000`).
- [ ] **Step 4:** Tests PASS; full suite passes. Commit `app: merged session rows and conversation cache`.

### Task 3: project screen sessions-only, tickets screen, checkouts sheet

**Files:**
- Create: `app/src/components/SessionRow.tsx`, `app/src/components/ProjectSessions.tsx`, `app/src/screens/ProjectTickets.tsx`, `app/src/screens/ProjectTickets.test.tsx`, `app/src/components/ProjectSessions.test.tsx`
- Modify: `app/src/screens/Project.tsx`, `app/src/screens/Project.test.tsx`, `app/src/App.tsx` (Nav), `app/src/App.test.tsx`
- Delete: `app/src/components/Conversations.tsx` and its test (behaviour moves into `ProjectSessions`; keep its search/see-all tests, ported)

**Interfaces:**
- Consumes: `mergeSessions`, `SessionRow` type, `setConversations` (Task 2); shadcn `dropdown-menu`, `sheet`, `button`, `input` (Task 1).
- Produces:
  - `<SessionRowView row={SessionRow} project?: string; active?: boolean; disabled?: boolean; onOpen(id) ; onResume(row) />` in `components/SessionRow.tsx` (default export), used by Task 4's Sessions tab too.
  - `<ProjectSessions state projectId busy onOpen onResume onConversations(machine, root, list) />`
  - `Nav.projectTickets?: string | null`; `<ProjectTickets state id selectedTicket onBack onOpenTicket onTickets />`.

- [ ] **Step 1: Write failing tests:**
  - `ProjectSessions`: with two checkouts on online machines and stubbed `listConversations` (vi.mock `../lib/api`), renders live rows first then closed rows; one checkout rejecting → text `laptop: could not list conversations` and the other checkout's rows still present; machine without `caps` → `Update quorumd on laptop to see its conversations`; 10 closed rows → 8 shown and button `See all (10)`, clicking it shows input labelled `Search by title` filtering rows; no rows at all → `No sessions yet. Start one above.`; closed row click calls `onResume` with that row's machine/root/id; busy → closed rows disabled.
  - `Project`: renders no ticket rows and no "Conversations" heading; has heading `Sessions`; ⋯ button labelled `Project menu` exposes items `Tickets (3)`, `Sync` (only when connector kind ≠ none), `Edit`, `Checkouts`.
  - `ProjectTickets`: renders the status groups, link suggestions and the empty texts that `Project.tsx` renders today (port the existing ticket assertions from `Project.test.tsx`).
  - `App`: on a narrow viewport, project → `Tickets` pushes a history entry; `history.back()` returns to the project view. Choosing `Checkouts` opens a sheet; Back closes it.
- [ ] **Step 2:** Run those test files → FAIL.
- [ ] **Step 3:** Implement. Project screen keeps: header (workspace dot, name, ⋯), summary, sync error, `NewSessionCard`, `ProjectSessions`. Ticket groups, link suggestions and the `Suggestion` component move to `ProjectTickets`. Resume uses the row's own machine/root with the same `launchIn` call `Project.tsx` uses today (`loadPrefs(projectId).bypass`, `root` cap). `ProjectSessions` fetches conversations for every checkout of `projectCheckouts(state, id)` whose machine is online and has `caps`, in parallel, and reports each list via `onConversations` (App wires it to `setConversations`). The Checkouts sheet state lives in `Nav` (`checkouts?: boolean`) so Back closes it. Wide layout: the right aside shows `TicketDetail` if a ticket is selected, else `ProjectTickets` if `projectTickets`, else `Project`.
- [ ] **Step 4:** Tests PASS; full suite passes. Commit `app: sessions-only project screen, tickets behind the menu`.

### Task 4: board cards and Sessions tab rows

**Files:**
- Modify: `app/src/components/ProjectCard.tsx`, `app/src/components/ProjectCard.test.tsx`, `app/src/screens/Projects.tsx`, `app/src/screens/Sessions.tsx`, `app/src/lib/projects.ts` (+ test)

**Interfaces:**
- Consumes: `lastActivity`, `ATTENTION` (Task 2); `SessionRowView` (Task 3); shadcn `card`, `badge`.
- Produces: `projectAttention(s: AppState, projectId: string): number` in `lib/projects.ts` (lowest ATTENTION among its live sessions; 99 when none).

- [ ] **Step 1: Write failing tests:**
  - `ProjectCard` shows no progressbar role and never the text `No ticket source.`; shows up to 3 live session rows and `+2 more` for 5; shows `Last activity 5 min` style line from `lastActivity` (use `since()`), omitted when 0; summary clamps to 2 lines (`line-clamp-2` class or style); proposals badge `1 proposal` / `2 proposals` kept.
  - `projectAttention`: project with a `needs_you` session returns 0; none → 99.
  - `Projects`: inside a workspace column, a project with a `needs_you` session sorts before an idle one; ties by name.
  - `Sessions` tab renders rows through `SessionRowView` and lists **only non-closed sessions** (a closed session in the store renders no row; services section unchanged). Closed history lives in each project's Sessions list.
  - Live rows (work role, not closed) have a ⋯ button labelled `Session actions` with item `Close session`; choosing it opens a confirm dialog (`Close this session? Claude stops in its terminal.` / `Close` / `Cancel`); `Close` calls `closeSession(id)` once; errors show inline on the row. Same action in the project Sessions list (it uses the same row).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite. **Step 5:** Commit `app: session-first board cards`.

### Task 5: drafts

**Files:**
- Create: `app/src/lib/drafts.ts`, `app/src/lib/drafts.test.ts`
- Modify: `app/src/components/Composer.tsx` (+ test), `app/src/components/AskCard.tsx` (+ test) — free-text answer only

**Interfaces:**
- Produces: `loadDraft(id: string): string`, `saveDraft(id: string, text: string): void` (empty text removes), `clearDraft(id: string): void`, `useDraft(id: string): [string, (t: string) => void, () => void]` (debounced 300 ms save, flush on unmount). Index of drafts kept under `quorum.draft.index` as `{id, at}[]`; more than 30 → drop oldest.

- [ ] **Step 1: Write failing tests:**
  - `saveDraft/loadDraft round trip`; `clearDraft` removes; empty text removes the key.
  - `keeps at most 30`: save 31 ids → the first saved is gone, the 31st present.
  - `storage throws`: stub `localStorage.setItem/getItem` to throw → functions return `''`/no-throw.
  - Composer: type `hello`, unmount, remount same session → textarea value `hello`; successful send (Send, Queue and Interrupt) clears it; failed send (`sendPrompt` rejects) keeps it.
  - AskCard free text persists under `ask.<askId>` across remount and clears on submit.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite. **Step 5:** Commit `app: keep composer drafts across navigation`.

### Task 6: session view on AI Elements

**Files:**
- Create: `app/src/lib/elements.ts`, `app/src/lib/elements.test.ts`
- Modify: `app/src/components/Transcript.tsx`, `app/src/components/timeline/ToolItem.tsx`, `app/src/components/timeline/ArtifactCard.tsx`, `app/src/components/AskCard.tsx`, `app/src/components/Composer.tsx`, `app/src/screens/Session.tsx`, their tests

**Interfaces:**
- Consumes: Task 1 components and spike doc decisions; `useDraft` (Task 5); `buildTimeline` items (`lib/timeline.ts`, unchanged).
- Produces: `toolView(item: ToolItem | ReadsItem): { title: string; icon: ToolKind; state: 'running' | 'done' | 'error' | 'denied'; meta?: string }` and `messageRole(item: Item): 'user' | 'assistant' | 'system'` in `lib/elements.ts`.

- [ ] **Step 1: Write failing tests:**
  - `elements.test.ts`: `toolView` maps `ToolState` `running→running, ok→done, error→error, denied→denied`; `meta` is `+12 −3` for an edit with diff `{add:12, del:3}`; `messageRole` maps `info` → `system`.
  - Transcript: user and assistant turns render inside Message containers (query by the role/aria attributes the vendored component exposes); a tool row is collapsed by default and expands on click showing the same detail as today (keep the existing `ToolItem.test.tsx` expectations: file list, diff lines, command output, web search results, skill name, subagent status); assistant text `![x](https://example.com/a.png)` renders no `img` (Review Focus 4); artifact item renders a card with button `Open` calling `onOpenFile(machine, path)`.
  - AskCard permission ask renders through Confirmation with buttons `Allow` and `Deny`; choosing calls `decide` exactly once (existing first-wins tests keep passing).
  - Composer renders through PromptInput; buttons `Send`, `Queue`, `Interrupt and send` keep today's enable/disable rules (`composerBlock`), draft behaviour from Task 5 still passes.
  - Session: working state shows the Loader/Shimmer; `Interrupt` header button only while working (existing test).
- [ ] **Step 2:** FAIL. **Step 3:** Implement: Conversation wraps the transcript (stick-to-bottom + scroll-to-bottom button; keep load-more on scroll to top); today's per-kind detail renderers move inside Tool's content. **Step 4:** PASS + full suite.
- [ ] **Step 5:** `npm run build`; entry chunk ≤ 655 kB. If above, lazy-load `screens/Session.tsx` with `React.lazy` + `Suspense` in `App.tsx` and re-measure. Record the final size in the commit body. Commit `app: session view on AI Elements`.

### Task 7: other screens on shadcn primitives

**Files:**
- Modify: `app/src/App.tsx` (TopBar), `app/src/screens/{Config,Pair,Starting,Terminal,Viewer,ProjectTickets}.tsx`, `app/src/components/{LaunchDialog,NewSessionCard,TicketDetail,TicketRow,ProposalCard,ConnectorForm,WorkspaceForm,StatePill}.tsx`, their tests where markup queries change

**Interfaces:**
- Consumes: Task 1 primitives. No new exports.

- [ ] **Step 1:** Replace hand-rolled buttons, inputs, menus, dialogs and cards with `Button`, `Input`, `Textarea`, `DropdownMenu`, `Dialog`/`Sheet`, `Card`, `Badge`; layouts and texts unchanged. The Session ⋯ menu becomes `DropdownMenu`. `LaunchDialog` becomes `Dialog` with buttons `min-h-11`.
- [ ] **Step 2:** Update tests that queried by class to query by role/label; full suite passes.
- [ ] **Step 3:** `npm run build` succeeds, entry chunk still ≤ 655 kB. Commit `app: shadcn primitives across screens`.

### Task 8: dev-only worst-case data toggle

**Files:**
- Create: `app/src/dev/fixtures.ts`, `app/src/dev/DataToggle.tsx`, `app/src/dev/fixtures.test.ts`
- Modify: `app/src/App.tsx` (DEV-guarded injection)

**Interfaces:**
- Consumes: `AppState`, `initialState`, `setConversations`.
- Produces: `type DataMode = 'demo' | 'worst' | 'empty' | 'one' | 'huge'`; `fixtureState(mode: Exclude<DataMode,'demo'>): AppState`; `fixtureConversations(mode): (machine: string, root: string) => Promise<Conversation[]>`; `<DataToggle mode onChange />` (fixed bottom-center segmented control, labels `Demo data / Worst case / Empty / One / 1,000 rows`, writes `?data=` and reloads).

- [ ] **Step 1: Write failing tests** `fixtures.test.ts`:
  - `worst` has ≥ 3 workspaces, a project with a 120-char name, sessions whose titles are 200 chars, a single-letter title, a session in every state, a machine offline, an assistant message with a 300-char unbroken path and a fenced code block of 200 lines, a tool output of 8000 chars (the `TOOL_OUTPUT_MAX`), a conversation list of 40 per checkout.
  - `empty` has workspaces with zero projects and a project with zero sessions/conversations.
  - `one` has exactly one of each and counts of 1 (one proposal).
  - `huge` has 1,000 closed conversations in one project and 200 live sessions across 5 machines.
  - Fixture strings contain no real hostnames/IPs (assert no `/\d+\.\d+\.\d+\.\d+/`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. In `App.tsx`, only when `import.meta.env.DEV` and `?data=` is one of the non-demo modes: skip hub load/WS, seed `fixtureState(mode)`, route `listConversations` through `fixtureConversations` (inject via a module-level override in `lib/api.ts`: `setConversationsSource(fn | null)`), and render `DataToggle`. Import `dev/*` with a dynamic `import()` inside the DEV branch so production drops it.
- [ ] **Step 4:** PASS + full suite. `npm run build` then `grep -r "Worst case" ../internal/hub/web/dist` → no match. Commit `app: dev-only worst-case data toggle`.

### Task 9: mod ignores headless sessions

**Files:**
- Modify: `mod/hooks/register.ts` (the `session.start` handler, next to the `QUORUM_DISABLE` check), `mod/.claude-plugin/plugin.json` (version `0.1.5`)
- Test: the existing mod test for `register.ts` under `mod/test/` (add cases there)

**Interfaces:**
- Consumes: `SessionStartInput.isInteractive` (Claude Code mod API: false for `claude -p` and the SDK).

- [ ] **Step 1: Write failing tests:** `session.start` with `isInteractive: false` creates no Link (no `/v1/sessions/register` call, no control) and still calls `next(e)`; with `isInteractive: true` behaviour is unchanged; with `isInteractive` absent (older Claude Code) behaviour is unchanged (treated as interactive).
- [ ] **Step 2:** Run `claude plugin test mod` (or `make test`) → FAIL. **Step 3:** Implement the early return beside the `QUORUM_DISABLE` one. **Step 4:** PASS. **Step 5:** Commit `mod: do not register headless sessions` (version bump in the same commit).

### Task 10: hub drops sessions that never got a prompt

**Files:**
- Modify: `internal/hub/store/store.go` (`CloseSession`, `CloseMachineSessionsExcept`), `internal/hub/machines.go` (`session_gone` case and `publishGone`), `app/src/lib/store.ts` (new envelope), tests in `internal/hub/store/store_test.go`, `internal/hub/*_test.go`, `app/src/lib/store.test.ts`

**Interfaces:**
- Produces: `func (s *Store) CloseSession(machine, id string) (removed bool, err error)` — when the session has no event of kind `user`, deletes it from `sessions`, `events`, `away`, `session_tickets`, `session_ticket_dismissed` in one transaction and returns `removed=true`; otherwise marks it closed as today. `CloseMachineSessionsExcept` returns `(closed, removed []string, err error)` with the same rule. Hub publishes envelope type `session_removed` (`Session` set) for removed ids, `session_gone` for the rest. App reducer: `session_removed` deletes the session from `sessions`, `order`, `events`, `live`, `liveAgent`, `asks` of that session, and `worked`.

- [ ] **Step 1: Write failing tests:** store — a session with only `status`/`info` events is removed on close and `Session(id)` returns not found; a session with one `user` event is closed (state `closed`, `closed_at` set); both paths through `CloseMachineSessionsExcept`. Hub — `session_gone` for an empty session publishes `session_removed`. App — `reduce` with `session_removed` removes the id everywhere listed above and leaves others intact.
- [ ] **Step 2:** `go test ./internal/hub/...` and `cd app && npx vitest run src/lib/store.test.ts` → FAIL. **Step 3:** Implement. **Step 4:** PASS (`go test ./...`, full vitest). **Step 5:** Commit `hub: drop sessions that never received a prompt`.

---

After Task 10 and the final review, the controller runs the `break-ui` skill against `npm run dev` with `?data=worst|empty|one|huge` (board, project screen, session view; 320 px, 1024 px+, 200 % zoom) and reports to the owner before fixing anything.
