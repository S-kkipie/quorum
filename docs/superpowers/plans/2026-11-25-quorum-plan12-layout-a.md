# Layout A, Terminal green and Seats — Implementation Plan (Plan 12)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rearrange the app the way the owner chose. On desktop that is three panes: a session sidebar, the session,
and a collapsible inspector. On the phone it is a session inbox with a bottom nav. The default palette becomes
Terminal green, Settings gets a palette selector, and the Seats logo appears everywhere the brand shows.

**Architecture:**
- The app shell (App.tsx) renders the Sidebar and a centre slot on desktop, or the phone navigation below 1024 px.
- The lazy Session screen renders the transcript plus its own inspector.
- Palettes are CSS variable sets selected by `data-palette` on `<html>`, applied before first paint.
- The logo is one SVG source, used both as a React component and as generated, committed icon assets.

**Tech Stack:**
- React 19, Vite 8 and Tailwind v4, with the shadcn and AI Elements components already in the app.
- vitest.
- Go, for the Windows icon resource (a pure-Go resource tool).
- The Capacitor Android project, for the launcher icons.

**Spec:** `docs/superpowers/specs/2026-11-25-quorum-layout-a-design.md`. Read the whole spec, including
"Decisions made after the builder check", which overrides the body where they differ. The mockups (values to copy)
are in `.superpowers/brainstorm/612831-1795566409/content/colors-logos.html` and `layouts-green.html`.

## Global Constraints

- All repo content is in English. No emojis, no personal data; fixtures use machines `vps-1` and `laptop`.
- Use semantic tokens only. `palette.test.ts` keeps banning Tailwind palette classes in `app/src` outside `dev/` and
  tests.
- Every preset palette passes AA in both themes: 4.5:1 for text and 3:1 for UI. This is tested.
- State colours are fixed and shared by all palettes:
  - light: needs `#B45309`, working `#2563EB`, background `#7C3AED`, done `#15803D`;
  - dark: needs `#F2A93B`, working `#60A5FA`, background `#B794F6`, done `#4ADE80`.
- Terminal green is the default palette:
  - light: bg `#F7F8F7`, sidebar `#EFF2F0`, surface `#FFFFFF`, ink `#111814`, muted `#5F6B64`, line `#E0E6E2`,
    chip `#EAEFEC`, bubble `#E6EEE9`, accent `#0E8A55`, on `#FFFFFF`;
  - dark: bg `#0E1311`, sidebar `#0A0E0C`, surface `#161C19`, ink `#E3ECE7`, muted `#8FA198`, line `#24302A`,
    chip `#1D2622`, bubble `#1F2A25`, accent `#3DDC97`, on `#06140D`.
- The palette is stored in localStorage key `quorum.palette`, with every access guarded by try/catch. It is applied
  before first paint.
- Breakpoints:
  - phone layout below 1024 px;
  - inspector overlay from 1024 to 1279 px;
  - inspector docked and open by default at 1280 px and wider.
- Keyboard: Ctrl/⌘+K focuses the sidebar search, Ctrl/⌘+B toggles the sidebar, Ctrl/⌘+. toggles the inspector.
- Session order everywhere is the existing `ATTENTION` order: needs you, done-unread, working, background, idle.
  Within a project, order by attention, then by last activity.
- Layout rules:
  - touch targets are 44 px or more;
  - 320 px works, with no horizontal page scroll;
  - reduced motion is respected;
  - initial JS stays at 655 kB or less, and the inspector code lives in the lazy Session chunk.
- Commits: author/committer `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`, message ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests: `cd app && npx vitest run` and `npm run build` (report the initial JS); `go test ./...` when Go changes.
- Browsers are controller-only. Subagents never use abw, agent-browser or any browser.

## Review Focus

1. **Switching sessions quickly in the sidebar.** The draft of each session survives, the right transcript shows
   with no flash of the previous one, and the seen mark is only sent for the session actually in the centre.
2. **A custom accent the owner picks that is too light, such as pale yellow.** Buttons and accent text still reach
   contrast after the runtime nudge, and a reload shows no flash.
3. **100+ sessions across 4 jobs, and names in CJK or emoji at 200 characters.** The sidebar stays usable and
   truncates on one line with a title tooltip, the search filters, and there is no horizontal scroll.
4. **Resizing the window across the 1024 and 1280 px breakpoints while a session is open.** No state is lost, and the
   inspector moves between docked, overlay and sheet without errors.
5. **Old localStorage, meaning `quorum.theme` set and no `quorum.palette`.** The app starts in Terminal green with
   the stored theme mode kept.

---

### Task 1: Palettes, tokens, pre-paint and the palette selector

**Files:**
- `app/src/lib/palettes.ts` (new).
- `app/src/lib/theme.ts`: extended.
- `app/src/lib/tokens.ts` and `tokens.test.ts`: the AA table for every preset.
- `app/src/index.css`:
  - `[data-palette=…]` variable sets for light and dark;
  - the `--sidebar` token;
  - the fixed state tokens.
- `app/index.html`: the pre-paint script also sets `data-palette` and applies stored custom variables.
- `app/src/screens/Config.tsx`: the Appearance section.
- Tests.

**Interfaces — produces:**
- `type PaletteId = 'terminal-green'|'graphite'|'mono'|'violet'|'midnight'|'ember'|'quiet-paper'`.
- `PALETTES: Record<PaletteId, {name, description, light: Tokens, dark: Tokens}>`. Values are copied from
  `colors-logos.html`, plus `sidebar` for each; Quiet paper's sidebar is `#F4F2EE` / `#171614`.
- `getPalette(): {id: PaletteId, accent?: string}` and `setPalette(p)`.
  - `setPalette` stores in `quorum.palette`. For a custom accent it also stores the derived variables, so the
    pre-paint script can apply them.
- `deriveAccent(accent, theme, base: Tokens) → {accent, onAccent, accentSoft, ring}`.
  - `onAccent` is black or white, whichever has more contrast.
  - The accent is nudged in lightness until it reaches at least 3:1 against `background`, and at least 4.5:1 where it
    colours text. A separate `accentText` value is allowed if needed.
- `[data-palette]` CSS selectors drive presets. A custom accent sets inline CSS variables on `<html>`.

**Mono and AA:** in Mono, `accent-soft` = `chip`. Any preset value that fails AA is nudged minimally, with a
`// nudged for AA` note.

**Settings → Appearance:**
- System / Light / Dark, as today.
- One tile per palette, with name and swatches, that is selectable.
- A "Custom accent" colour input, plus "Reset to palette".
- The change applies instantly everywhere.

- [ ] **Tests first:**
  - every preset passes AA in both themes;
  - `deriveAccent('#FFF59D', 'light', terminal.light)` gives an accent with at least 3:1 against `#F7F8F7`, and an
    on-accent with at least 4.5:1 against it;
  - the default with no storage is terminal-green;
  - old storage with only `quorum.theme='dark'` gives terminal-green dark;
  - storage that throws falls back to the defaults;
  - the pre-paint script (tested as a pure function exported for the test) sets `data-palette` and the custom
    variables;
  - the Appearance tiles switch palette, the custom accent is applied and Reset clears it.
- [ ] **Commit** `app: palettes, Terminal green default, palette selector`.

### Task 2: Seats logo and icons

**Files:**
- `app/src/components/Logo.tsx`: props `size`, `className`, `title?`.
  - It uses `currentColor`, with the geometry from the spec §4.
  - It also exports `SEATS_SVG(color: string): string`.
- `scripts/gen-icons.mjs` (new, run with node). It regenerates:
  - `app/public/favicon.svg`;
  - `app/public/icons/icon-192.png`, `icon-512.png` and `maskable-512.png`. These are the mark on the dark Terminal
    green background `#0E1311` in accent `#3DDC97`, with a 12% safe-zone padding for the maskable one.
  - the Android `android-app/android/app/src/main/res/mipmap-*` adaptive launcher icons: a foreground layer with the
    mark, and a background colour of `#0E1311`.
  - `cmd/quorum-desktop/quorum.ico` with 16, 32, 48 and 256 px sizes.

  Use a small npm dev dependency for rasterising, such as `@resvg/resvg-js`, plus a pure-JS PNG-to-ICO encoder. The
  generated files are committed.
- `cmd/quorum-desktop`:
  - a committed `rsrc_windows_amd64.syso` generated from `quorum.ico`, through a `go generate` directive using a
    pure-Go tool such as `github.com/tc-hib/go-winres` (`go run` at generate time);
  - `main_windows.go` uses `IconId: 1`, or whatever id the resource gets.
- The web manifest and `index.html` icon links.
- Logo placement:
  - the desktop first-run and offline pages (`cmd/quorum-desktop/pages.go`): inline mark and Terminal green tokens;
  - the Android shell pages (`android-app/www/*.html`): inline mark and Terminal green tokens.
- Tests.

- [ ] **Tests first:**
  - `Logo` renders 7 circles and 1 rect, has `role="img"` with the title, and is aria-hidden without a title;
  - `SEATS_SVG('#3DDC97')` contains the colour;
  - the manifest lists the three icons, and the files exist;
  - a Go test checks the `.syso` exists and is non-empty;
  - `pages.go` tests still pass, and the pages contain the mark.
- [ ] **Run** `node scripts/gen-icons.mjs` and `go generate ./cmd/quorum-desktop`. Build with `make desktop` (the exe
  must still be about 7–8 MB) and `make apk` (it builds without Firebase).
- [ ] **Commit** `brand: Seats logo, favicon, PWA, Android and Windows icons`.

### Task 3: Desktop shell — sidebar and centre pane

**Files:**
- `app/src/components/shell/AppShell.tsx` (new).
- `app/src/components/shell/Sidebar.tsx` (new).
- `app/src/components/shell/SessionTree.tsx` (new).
- `app/src/lib/useLayout.ts` (new): breakpoint, sidebar width and collapse state, persisted.
- `app/src/App.tsx`: wire the shell; remove the desktop tabs.
- Screens that become centre pages: `Project.tsx`, `ProjectTickets.tsx`, `Config.tsx`, `Terminal.tsx`,
  `Starting.tsx`, `Projects.tsx`. Projects is the landing view.
- Tests.

**Interfaces — produces:**
- `useLayout(): {mode:'phone'|'desktop', inspector:'docked'|'overlay'|'sheet', sidebarWidth, setSidebarWidth,
  sidebarOpen, toggleSidebar, inspectorOpen, toggleInspector}`. It reads `matchMedia`, and persists to
  `quorum.layout`, guarded.
- `Centre` content type:
  `{kind:'projects'} | {kind:'session', id} | {kind:'project', id} | {kind:'tickets', projectId} |
  {kind:'settings'} | {kind:'terminal', …} | {kind:'starting', …}`.
  - It maps one-to-one onto history entries (`history.state`), so Back works.
  - The Viewer stays a full overlay.

**Sidebar:**
- **Header:** Logo + "Quorum", search, Settings.
  - Search does a case-insensitive substring match on name, project and machine, and Ctrl/⌘+K focuses it.
- **Needs you:** shown only when non-empty.
- **Jobs:** each has a colour dot, its name and a `+` that opens the existing launch dialog scoped to the job.
- **Projects:** expandable, with sessions indented under them. The expanded state is persisted.
  - Session rows show the dot, the name (truncated on one line, with a title attribute) and the meta: relative time,
    or `bg`.
  - A project with no sessions shows "No sessions · Start one".
- **Footer:** "New session" + the connection state.
- **Resize:** 220–380 px through a drag handle, with keyboard resizing via arrow keys on the handle.
- **Accessibility:** use `role="tree"` / `treeitem`, or nested lists with `aria-current` on the open session.

**Seen marks:** a session is "viewed" only when the centre is that session and the document is visible. Update the
existing logic (today `tab === 'sessions' && config === null`) to use the centre.

- [ ] **Tests first:**
  - the tree groups jobs, projects and sessions in ATTENTION order, then by last activity;
  - Needs you is pinned and hidden when empty;
  - search filters by name, project and machine;
  - Ctrl+K focuses search;
  - Ctrl+B toggles the sidebar;
  - clicking a session sets the centre and pushes history, and Back restores the previous centre;
  - the draft is kept when switching A → B → A;
  - a seen mark is sent only for the centred session;
  - 120 sessions with 200-character CJK and emoji names render with no horizontal overflow (row `min-w-0` and
    truncate);
  - the width persists, and a throwing storage gives the defaults.
- [ ] **Commit** `app: desktop shell with session sidebar and centre pane`.

### Task 4: Inspector in the session

**Files:**
- `app/src/components/inspector/Inspector.tsx` (new).
- Cards (new):
  - `BackgroundCard.tsx`: reuses the `BackgroundSheet` content;
  - `UsageCard.tsx`: reuses the meters and usage-strip logic for the session's account; hidden when the session has
    no account;
  - `ChangedFilesCard.tsx`;
  - `ArtifactsCard.tsx`.
- `app/src/lib/changedFiles.ts` (new).
- `app/src/lib/artifacts.ts`: new, or reuse an existing helper.
- `app/src/screens/Session.tsx`: lays out transcript + inspector; the header gets an inspector toggle (◧, 44 px
  target).
- Tests.

**Interfaces:**
- **Consumes:** `useLayout()` (Task 3), for the inspector mode and open state.
- **Produces:**
  - `changedFiles(events): {path, add, del, eventKey}[]`. It aggregates Edit/Write/MultiEdit tool events per path
    (summed +/−) in first-seen order, and uses the same +/− parsing the tool rows already show.
  - `artifactLinks(events): {title, url, eventKey}[]`. It finds hub local-artifact `/v/` links in tool results and
    assistant text, and dedupes by URL.

**Behaviour:**
- **Docked** (1280 px and wider): about 280 px.
- **Overlay** (1024–1279 px): over the transcript, closed by Esc or an outside click.
- **Sheet** (phone): the bottom Sheet that already exists.
- **Cards:** empty cards are hidden.
- **Changed files** shows "From loaded history" when older pages exist. A click scrolls to the tool row when it is
  loaded.
- **Artifacts:** a click opens the Viewer.
- **Toggling:** Ctrl/⌘+. toggles the inspector, and its open state is persisted per mode.

- [ ] **Tests first:**
  - `changedFiles` sums repeated edits of one path;
  - `artifactLinks` dedupes;
  - the cards are hidden when empty;
  - the Usage card is hidden without an account;
  - the toggle and Ctrl+. work;
  - the overlay closes on Esc;
  - the phone opens a sheet;
  - crossing breakpoints keeps the open session and draft (render at 1300, then resize the matchMedia mock to 1100
    and then 800);
  - initial JS stays at 655 kB or less, with the inspector in the Session chunk.
- [ ] **Commit** `app: session inspector (background, usage, changed files, artifacts)`.

### Task 5: Phone — session inbox and bottom nav

**Files:**
- `app/src/screens/Inbox.tsx` (new; it replaces the phone use of `Sessions.tsx`).
- `app/src/components/shell/BottomNav.tsx` (new).
- `app/src/App.tsx`.
- Tests.

**Behaviour:**
- **Bottom nav:** Sessions, Projects, Settings. It has a 44 px target, sits on the safe area, and is hidden inside a
  session and the Viewer.
- **Inbox sections** in ATTENTION order: Needs you, Done · unread, Working, Background, Idle. Empty sections are
  hidden.
- **Rows:** dot, name, then `project · machine · reason`. The reason is one of:
  - `Permission: <Tool>` or `Question` for asks;
  - the last tool label for working sessions;
  - `N background tasks`;
  - `Finished`;
  - relative time for idle sessions.
- **Filter chips per job:** "All" plus each job. The selection is persisted.
- **Header:** the Logo + "Sessions" and a `+` for a new session.
- **Session:** opens full screen with Back.

- [ ] **Tests first:**
  - section order, with empty sections hidden;
  - every reason wording;
  - the chips filter and persist;
  - the nav is hidden in a session;
  - 320 px with long names has no overflow.
- [ ] **Commit** `app: phone session inbox and bottom navigation`.

### Task 6: Controller — visual QA and fixes

- [ ] With dev fixtures (`?data=worst|one|huge|empty`), check 390, 1024, 1280 and 1600 px in light and dark, for
  Terminal green, Mono and Ember. Use the controller's own abw session (`ABW_SESSION=quorumqa ABW_PROFILE=none`).
  - Fix what breaks.
  - Add screenshots for the owner.
- [ ] Run a real check against the hub in the desktop app `Quorum.exe` after the deploy, with the owner's OK.
