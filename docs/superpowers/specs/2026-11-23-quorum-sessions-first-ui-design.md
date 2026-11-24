# Quorum — sessions-first UI on shadcn + AI Elements

Date: 2026-11-23. Status: approved approach (option 1), design pending owner review.

## Intent

The owner uses Quorum to drive Claude Code sessions from the phone. Tickets are not core: today the project
screen is mostly a ticket board, and sessions show up twice ("Open sessions" and "Conversations") although
they are the same thing (a Claude conversation that is live or closed). Text typed in the session input is
lost when navigating away. The owner also wants the whole app built on AI Elements (Vercel's agent-UI
components, now distributed through the shadcn/ui registry) so it looks and behaves like a polished agent app.
After this work, the `break-ui` skill is run over the result.

Tauri + Android come after this (separate design).

## Goals

1. **Project screen = sessions only.** One unified **Sessions** list; tickets move behind the project's ⋯ menu.
2. **One session list** that merges live sessions and previous conversations, each conversation once.
3. **Board cards** show sessions and recent activity instead of ticket progress.
4. **Drafts survive navigation** (session composer).
5. **shadcn + AI Elements everywhere**: AI Elements in the session view, shadcn primitives in the other screens.
6. **Break UI pass** over the board, project screen and session view; report before fixing.

## Non-goals

- Removing tickets, connectors, sync, summaries or proposals from the hub (owner chose option A: hidden, not removed).
- New features in the session view beyond what exists (timeline, permissions, ask cards, artifacts, terminal).
- Tauri/Android, light theme (app stays dark-only, as today).
- Adopting the Vercel AI SDK runtime (`useChat`, transports). Only its message/part *types* may be used, if a component needs them.

## Anti-goals (failure even if it "works")

- Weakening Plan 4 security: remote images in Markdown must stay links (never `<img>` from the network);
  artifacts stay in the sandboxed viewer; no `dangerouslySetInnerHTML` of session data.
- Emojis in UI (icons/SVG only, lucide).
- Spanish anywhere in the repo.
- A noticeably slower first load on the phone: heavy pieces (syntax highlighting) load lazily.
- Losing behaviours that work today: timeline expand/collapse, permission dialog first-wins, Interrupt only
  while working, ⋯ menu, artifact cards, resume of closed conversations, terminal entry points.

## Current state (what the change touches)

- `app/src/screens/Project.tsx`: header, `NewSessionCard`, "Open sessions" (from `projectSessions`),
  "Conversations" (`components/Conversations.tsx`, only for the checkout picked in `NewSessionCard`),
  link suggestions, ticket groups by status, checkouts.
- `app/src/components/ProjectCard.tsx`: progress bar (tickets), summary, sync error, live sessions.
- `app/src/components/Composer.tsx`: local `useState` text, lost on unmount.
- Session view: `screens/Session.tsx`, `components/Transcript.tsx`, `components/timeline/*`,
  `components/Markdown.tsx`, `AskCard`, `StatePill`, permission UI.
- Styling: hand-written Tailwind v4, `index.css` has only `@import "tailwindcss"` and base colors; no shadcn,
  no `@/` path alias.

## Approaches considered

1. **shadcn + AI Elements for everything (chosen).** Session view built from AI Elements (conversation,
   message, response/markdown, tool, reasoning if present, prompt input, confirmation, code block, artifact,
   loader/shimmer); other screens from shadcn primitives (button, card, dropdown-menu, dialog, sheet, badge,
   input, textarea, tabs, collapsible, scroll-area). Consistent look; cost: new deps and bundle growth,
   an adapter from Quorum events to the components' props.
2. AI Elements only in the session view. Less work, mixed look. Rejected: owner said "for everything".
3. Copy the look without installing. Rejected: not what was asked.

## Design

### 1. Unified Sessions list (project screen)

- One section **Sessions**, below the new-session card.
- Sources, merged and de-duplicated by conversation id (live session id == Claude conversation id):
  - live sessions of the project (`projectSessions`), from every machine;
  - previous conversations from `listConversations(machine, root)` for **every checkout of the project on an
    online machine** (not only the one picked in `NewSessionCard`), fetched in parallel, failures per
    checkout shown inline as one muted line ("<machine>: could not list conversations").
- Order: live sessions first, by attention (needs permission → waiting for you → working → idle), then closed
  ones by `updatedAt` desc.
- Row (live): state dot + title (`sessionTitle`) + machine + state label; tap opens the session.
- Row (closed): title (`title || firstPrompt || id`) + machine + relative time + message count; tap resumes
  (on its own machine/root, same `launchIn` path as today). Disabled while a launch is pending.
- Show the first 8 closed rows; "See all (N)" expands and reveals a search box (title filter), as today.
- Machines that send no caps: one muted line "Update quorumd on <machine> to see its conversations".
- Empty: "No sessions yet. Start one above."

### 2. Tickets behind ⋯ (option A)

- Project header gets a ⋯ menu (shadcn dropdown) with: **Tickets (N)**, **Sync** (if a connector exists),
  **Edit**, **Checkouts**.
- **Tickets** opens a project-tickets screen containing exactly what the project screen shows today for tickets:
  status groups, link suggestions, proposals badge, ticket detail navigation. Same components, moved.
- **Checkouts** opens a small sheet with today's checkouts list.
- The project screen keeps: header, summary (if any), sync error (if any), new-session card, Sessions.
- Hub, connectors, sync, summaries and proposals keep working unchanged.

### 3. Board cards

- Card: project name, live sessions (up to 3 rows with state; "+N more"), and a "last activity" line
  (most recent of live session activity or conversation `updatedAt` known to the app; omit if unknown).
- Removed from the card: ticket progress bar, "No ticket source." text. Summary stays (2-line clamp) when present.
- Pending proposals badge stays (it is an owner action item).
- Attention ordering inside a workspace column: projects with a session needing permission/waiting first.

### 4. Drafts

- Session composer text is saved per session in `localStorage` key `quorum.draft.<sessionId>` (debounced
  ~300 ms), restored on mount, cleared on successful send. All storage access in try/catch; without storage
  the composer still works.
- Keep at most 30 drafts; when saving a new one beyond that, drop the oldest (track `{text, at}`).
- Same mechanism for any other free-text input that can be lost by navigation and is worth keeping: the
  new-session prompt if/when it exists, ask-card free text (`quorum.draft.ask.<askId>`). Forms in Config are out.

### 5. shadcn + AI Elements migration

- Setup: shadcn initialised for Vite (CSS-variables mode, dark theme tokens mapped to today's zinc palette),
  `@/*` alias in `tsconfig.json` and `vite.config.ts`. Components are vendored into
  `app/src/components/ui/` (shadcn) and `app/src/components/ai-elements/` (AI Elements), installed from the
  shadcn/ui registry where AI Elements now lives (the standalone `ai-elements` CLI is being deprecated at the
  end of November 2026); fall back to the `@ai-elements` registry namespace only for a component not yet moved.
- Install only the components used (not the all-in-one bundle).
- **Adapter** `app/src/lib/elements.ts`: maps Quorum's timeline items (`buildTimeline`) to the props the
  components take (tool name/state/input/output, message role/text, etc.). If a component's prop type comes
  from the `ai` package, import types only (`import type`), no runtime.
- Session view mapping:
  - transcript container → Conversation (stick-to-bottom, scroll-to-bottom button);
  - user/assistant turns → Message; assistant text → the AI Elements markdown response component,
    **configured so remote images render as links** and links open in a new tab with `rel="noopener noreferrer"`;
    if the component cannot be configured that way, keep `Markdown.tsx` inside Message;
  - tool rows → Tool (collapsible header with icon + summary; body shows the same per-tool detail as Plan 4:
    file lists, diffs, command output, web search results, skill name, subagent);
  - permission request → Confirmation (Allow / Deny);
  - ask (multiple choice) → the existing AskCard rebuilt with shadcn primitives;
  - local artifacts → Artifact card (title, machine, size, Open) linking to the existing Viewer;
  - composer → PromptInput (textarea + Send; Queue and "Interrupt and send" kept as secondary actions);
  - working indicator → Loader/Shimmer.
- Code highlighting (shiki or what the code-block component uses) is loaded lazily (dynamic import) so the
  initial bundle does not grow by it; target: initial JS ≤ today's 505 kB + 150 kB.
- Other screens (board, project, tickets, ticket detail, sessions tab, config, pair, launch dialog, terminal
  chrome, viewer chrome) use shadcn primitives with the same layout; touch targets ≥ 44 px.
- Existing tests keep passing or are updated to the new markup (queries by role/label, not by class).

### 6. Break UI pass

- After 1–5, run the `break-ui` skill on: board (ProjectCard), project screen (Sessions list), session view
  (timeline rows, messages, composer).
- Dev-only toggle via `?data=worst|empty|one|huge` read where fixtures are chosen; never active in production builds.
- Report (what broke / decisions / what held) goes to the owner **before** fixing; fixes only on request.

## Constraints

- All repo content in English (code, comments, UI, errors, commits, docs).
- No emojis in UI; lucide icons.
- Public repo hygiene: no hostnames, IPs, user names, personal paths, real project names in code/docs/tests.
- React 19, Tailwind v4, Vite 8 (existing). Build output stays in `internal/hub/web/dist` (Go embed).
- The service worker bypass of `/v/` and `/api` stays.
- Phone-first: 320 px width works, no horizontal page scroll.

## Left to the builder

- Exact shadcn component set and token values (match today's dark zinc look).
- Whether a component is used as-is or lightly edited after vendoring (vendored code is ours to edit).
- Debounce and pruning details for drafts within the stated bounds.

## Calls made after the builder check (design author's calls)

1. **Break UI toggle:** dev-only seeded store. When `import.meta.env.DEV` and `?data=worst|empty|one|huge`,
   App replaces the hub-loaded state with a fixture `AppState` and a stubbed `listConversations`; the module is
   imported behind the `DEV` guard so production builds drop it. Fixtures live in `app/src/dev/fixtures/`.
2. **Sessions tab** (`screens/Sessions.tsx`) stays as the global cross-project list; it shares the session row
   component with the project Sessions list (no second row implementation).
3. **Board "last activity":** from live sessions in the store plus conversations already fetched by a project
   screen (kept in a small in-memory cache in the store). The board makes no extra requests; the line is omitted
   when nothing is known.
4. **Navigation:** Tickets is a new `Nav` level (`projectTickets: <projectId>`), so Back, deep links,
   `selectedTicket` and the wide two-pane layout keep working. The Checkouts sheet also pushes a history entry
   so Back closes it.
5. **Dedupe:** a live session wins over any listed conversation with the same id. A closed conversation listed
   by several checkouts appears once, with the most recent `updatedAt`, on the machine/root that reported it;
   resume uses that machine/root.
6. **Risky components first:** the plan starts with a spike task that vendors Conversation, Message, the markdown
   response, Tool, Confirmation and PromptInput and checks (a) remote images can be forced to links, (b) Tool can
   host today's per-tool detail, (c) bundle impact. Where a check fails, the fallback is fixed: keep
   `Markdown.tsx` inside Message; put today's detail renderers inside the Tool body.
7. **Bundle:** if the initial JS budget (≤ 655 kB) is exceeded, lazy-load the session view route first; dropping
   components is the last resort.
8. **Drafts:** kept when the send fails; cleared after any successful send (Send, Queue, Interrupt and send).
   `NewSessionCard` has no free-text prompt today, so drafts there are out of scope.
