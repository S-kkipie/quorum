# Layout A, Terminal green and the Seats logo — Design

Date: 2026-11-25. Status: chosen by the owner in chat from browser mockups (layouts A/B/C, 7 palettes, 6 logos). The mockups
are under `.superpowers/brainstorm/612831-1795566409/content/` (`layouts-green.html`, `colors-logos.html`) and are not
committed.

## Intent

The owner does not like today's layout.

- **Today's layout:** top tabs (Projects / Sessions), a board of project cards, and a session that opens as a separate
  screen.
- **What the owner wants instead:** the shape of the session managers they use: Codex app, Orca and Claude Code
  desktop. That means a persistent sidebar of sessions, the session in the middle, and its context on the side.
- **Colours:** they also did not like the colours, and chose a new palette, **Terminal green**, and a logo, **Seats**.
- **Colour selector:** they asked for a colour selector.

The UI itself stays the same: transcript, composer, cards, slash commands, sheets. What changes is the arrangement,
the colours and the brand.

## Goals

1. **Layout A on desktop: three panes.**
   - Left: a persistent session sidebar.
   - Centre: the selected session.
   - Right: a collapsible **inspector** for that session.

   Switching sessions never leaves the screen.
2. **Phone.** The home is a session inbox grouped by state. A session opens full screen, with back to return. The
   inspector becomes a bottom sheet. A bottom nav has Sessions / Projects / Settings.
3. **Terminal green** becomes the default palette, in light and dark, and replaces Quiet paper as the default.
   Settings → Appearance gains a **palette selector**: the presets from the mockup plus a custom accent. These sit
   next to System / Light / Dark.
4. **Seats logo** everywhere the brand shows:
   - sidebar and phone header;
   - favicon and PWA icons;
   - Android launcher icon;
   - Windows `Quorum.exe` icon;
   - the desktop first-run and offline pages, and the Android shell pages.

## Non-goals

- New features inside the session view. Transcript, composer, ask cards, command cards and task cards stay as they
  are, re-skinned only through tokens.
- Changing what tickets do. They stay behind the project's ⋯ (Plan 5).
- Drag-and-drop pane layouts (Claude Code desktop has them; YAGNI).

## Anti-goals

- **Regressing phone ergonomics.** Touch targets stay at 44 px or more, 320 px works, and there is no horizontal
  scroll.
- **Regressing load time.** Initial JS stays at 655 kB or less. The session view stays lazy.
- **Losing state on switch.** Drafts are kept per session, as today. The scroll position per session is kept within
  the app run.

## Approaches considered (owner picked A)

| Layout | Trade-off |
|---|---|
| **A. Three panes** (Codex, Orca, Claude Code desktop) | Everything visible, with the tree by job and project. Needs width; the inspector collapses. **Chosen.** |
| B. Inbox + session (Mail / Linear) | Flat attention-sorted list, denser, but no project tree and no side context. |
| C. Board by state + session drawer | Best overview, weakest for long conversations. |

Palettes considered: Graphite, Mono, Violet, **Terminal green** (chosen), Midnight, Ember, Quiet paper (today's).
Logos considered: **Seats** (chosen), Monogram, Q + cursor, Majority, Speech Q, Quorum grid.

## Design

### 1. Desktop, 1024 px and wider

**Sidebar** (about 270 px; resizable from 220 to 380; width persisted per device; Ctrl/⌘+B hides it):

- **Header.** The Seats mark plus "Quorum", search (Ctrl/⌘+K focuses the filter over session name, project and
  machine), and Settings.
- **Needs you.** Pinned at the top, and shown only when non-empty: every session in `needs_you` across all
  projects. Each row shows its project name.
- **Jobs and projects.** For each job (workspace) in the existing order:
  - a job header with its colour dot and a `+` that starts a new session in that job, using the current launch
    dialog;
  - then each project, expandable, with its sessions indented under it;
  - each session row shows a state dot (needs you, working, background, done-unread, idle), the name (the recap,
    as today), and a short right-hand meta (relative time, or `bg`);
  - closed sessions are hidden, as today;
  - a project with no open sessions shows "No sessions · Start one".
- **Project page.** Clicking a project name opens its page in the centre: summary, sessions, and the tickets ⋯
  entry. This reuses `Project.tsx` content.
- **Footer.** A New session button and the connection state.

**Centre:**

- The current session screen: header chips, transcript and composer.
- The header keeps the state pill and the model/effort chips, and adds an inspector toggle (◧).
- When nothing is selected, the centre shows the projects board as an overview (today's Projects content). It is the
  landing view on desktop.

**Inspector** (about 280 px, collapsible, open by default at 1280 px and wider, persisted; Ctrl/⌘+. toggles it). It
shows cards for the selected session:

- **Background:** today's `BackgroundSheet` content.
- **Usage:** the account's 5 h / week meters and context %. This is today's usage strip data for that session's
  account.
- **Changed files:** aggregated from the session's Edit/Write tool events in memory, as `path +N −M`. A click scrolls
  to the tool row.
- **Artifacts:** local artifact links seen in the session. A click opens the Viewer.

Empty cards are hidden.

**Responsive behaviour:**
- From 1024 to 1279 px, the inspector starts collapsed and overlays the centre when opened.
- Below 1024 px, the phone layout applies.

### 2. Phone, under 1024 px

- **Bottom nav:** Sessions, Projects, Settings. It is hidden inside a session.
- **Sessions inbox.** Sections in Plan 7 order: Needs you, Working, Background, Done · unread, Idle.
  - Rows show dot, name, then `project · machine · reason`. The reason is the ask kind, the last tool, "N background
    tasks" or "Finished".
  - There are filter chips per job.
  - The header has the Seats mark and `+` for a new session.
- **Session.** Full screen, as today. The inspector button opens a bottom sheet with the same cards.
- **Projects tab.** Today's projects board.

### 3. Palette system

- **Tokens.** Tokens stay semantic, as in Plan 9 (`background, surface, ink, muted, line, chip, bubble, accent,
  on-accent, accent-soft, sidebar` plus the state tokens). Add `sidebar`, the side pane background.
- **Palettes** are defined in `app/src/lib/palettes.ts`, each with light and dark values. The exact values are in
  `colors-logos.html`; copy them.
  - Terminal green, the default: light accent `#0E8A55`, dark accent `#3DDC97`.
  - Graphite, Mono, Violet, Midnight, Ember, Quiet paper.
- **Selection.** Settings → Appearance shows the palette tiles, a custom accent colour input, and the System / Light /
  Dark choice.
  - The selection is stored per device in localStorage, guarded with try/catch.
  - It is applied before first paint by the existing pre-paint script, which grows to set the palette's CSS
    variables.
  - `meta theme-color` follows the palette.
- **Custom accent.** `on-accent` is computed for contrast (black or white). `accent-soft` and the focus ring are
  derived from the accent. The accent is nudged in lightness until it reaches 3:1 against `background` for UI and
  4.5:1 for text where the accent colours text.
- **Contrast tests.** `tokens.test.ts` runs the AA checks for every preset in both themes.
- **State colours.** Needs-you amber, done green and background violet follow the mockup values per theme. They are
  shared across palettes, so states read the same in any palette.

### 4. Logo (Seats)

- **The mark.** Seven dots on a ring (angles −90, −45, 0, 90, 135, 180, 225 degrees; radius 15 in a 48 viewBox; dot
  radius 4.3). The tail is a rounded bar from about (29,31), 15×5.4, rotated 45°. The geometry is in
  `colors-logos.html`.
- **The component.** `app/src/components/Logo.tsx` renders the mark. It inherits `currentColor` (the accent) and
  takes a size.
- **Wordmark.** The mark plus "Quorum" in Geist 600.
- **Generated assets**, produced by a script from the same SVG and committed:
  - `app/public/favicon.svg` and `app/public/icons/*` (192 and 512 maskable PNGs on the dark palette's background);
  - the Android launcher icons, adaptive: foreground mark on a dark green background;
  - a Windows `.ico` embedded in `Quorum.exe` through a generated `.syso`, using a pure-Go resource tool such as
    `github.com/tc-hib/winres`;
  - the desktop and Android first-run and offline pages use the new tokens and the inline mark.

## Constraints

- All repo content in English, with no personal data in committed fixtures or docs (machines `vps-1`, `laptop`).
- Semantic tokens only. `palette.test.ts` keeps banning palette classes.
- Touch targets of 44 px or more; 320 px works; no horizontal page scroll; reduced motion respected.
- Initial JS stays at 655 kB or less. The inspector's Changed files and Artifacts live in the lazy session chunk.
- Existing tests are kept, or updated where the layout moved things.
- Visual QA by the controller only, in its own browser session, at 390, 1024, 1280 and 1600 px, in both themes and
  for at least 3 palettes.

## Left to the builder

- How the sidebar tree is fed. Reuse `lib/projects.ts` and `lib/sessions.ts` groupings.
- Keyboard focus details and ARIA for the tree. Use a `tree`/`treeitem` pattern or a list with nested lists.
- Exact resize-handle behaviour.
- The icon generation tooling, as long as no cgo is needed and the generated files are committed.

## Decisions made after the builder check (designer's calls)

1. **State colours are fixed per theme and shared by every palette**, so a state reads the same in any palette and
   never collides with the accent.
   - Light: needs you `#B45309`, working `#2563EB`, background `#7C3AED`, done `#15803D`.
   - Dark: needs you `#F2A93B`, working `#60A5FA`, background `#B794F6`, done `#4ADE80`.
   - Working no longer follows the accent: with a green accent it would look like done.
   - **What a preset overrides:** each preset sets only `background, sidebar, surface, ink, muted, line, chip, bubble,
     accent, on-accent`. `accent-soft` and the focus ring are derived from the accent.
   - **Shared base per theme:** `success`, `danger`, `add`, `del` and the state `*-soft` variants come from a shared
     base for each theme.
   - **Quiet paper's sidebar:** `#F4F2EE` light, `#171614` dark.
2. **The inspector is rendered by the lazy Session screen itself.**
   - The app shell renders the sidebar and a centre slot. When the centre holds a session, Session lays out
     transcript + inspector.
   - Changed files and Artifacts cover the events loaded in memory, with a "from loaded history" note when older
     pages exist. A click on a row that is not loaded does nothing.
   - Artifacts are detected from the hub's local-artifact links (`/v/` URLs) in tool results and answers. Reuse a
     helper if one exists.
   - The Usage card shows the session's account when `SessionInfo` carries it (Plan 6), and is hidden otherwise.
3. **Desktop centre pane:**
   - **Pages that open in the centre:** Project, ProjectTickets, TicketDetail, Settings (Config), Starting, Terminal.
   - **Full-screen overlay:** Viewer stays one, as today.
   - **Inspector:** only shown for a session.
   - **Tabs:** the Projects/Sessions tabs are removed on desktop.
   - **Seen marks:** a session counts as viewed when it is the centre content and the document is visible.
   - **Back and deep links:** history entries are kept for each centre change, so Back works as today.
4. **Ordering:** keep the existing `ATTENTION` order everywhere: needs you, done-unread, working, background, idle.
   This applies to the phone inbox sections, and to sessions within a project in the sidebar (then by last activity).
   The pinned sidebar section holds only needs-you. This replaces "Plan 7 order" above.
5. **Palette storage:**
   - **Key:** the palette is stored under its own localStorage key, `quorum.palette`: a preset id, or a custom accent
     plus its base preset. The custom accent is applied on top of the current preset.
   - **Presets before first paint:** the pre-paint script sets `data-palette` on `<html>`, and `index.css` holds the
     preset variables under `[data-palette=…]` selectors.
   - **Custom accent before first paint:** when the accent is chosen, the derived variables are computed and stored
     too, and the pre-paint script applies the stored values, so there is no flash.
   - **Existing users:** anyone with no stored palette gets Terminal green.
6. **Preset contrast:** presets must pass the AA tests. If a mockup value fails, nudge that preset's value minimally
   and note it in the code. For Mono, `accent-soft` is the chip colour, because the accent is the ink. Only custom
   accents are nudged at runtime.
