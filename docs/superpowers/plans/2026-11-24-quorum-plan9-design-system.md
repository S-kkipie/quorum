# Design system: "Quiet paper", light and dark — Implementation Plan (Plan 9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give Quorum a professional, calm identity — direction A "Quiet paper" chosen by the owner — with a real light theme and a real dark theme, semantic colour tokens everywhere (no hard-coded palette classes), deliberate typography, and interaction polish that feels native on a phone.

**Design (approved in chat 2026-11-24; mockup `.superpowers/brainstorm/1328429-1795537819/content/directions.html`, direction A, "use Geist"):**
- **Feeling:** a professional work environment in the spirit of the Claude desktop/mobile apps — calm, warm neutrals, generous space, colour only where it carries meaning. Do NOT copy Anthropic's brand: no terracotta/clay accent (#D97757-ish), no cream #F4F1EA, no Claude logo or wordmark.
- **Palette (tokens):**

| Token | Light | Dark |
|---|---|---|
| background | #FAF9F6 | #1B1A18 |
| surface (cards, composer, menus) | #FFFFFF | #232220 |
| ink (foreground) | #1D1C1A | #ECEAE5 |
| muted text | #6E6A64 | #A19D96 |
| line (borders) | #E8E5DF | #33312E |
| chip / subtle fill | #F1EFEA | #2C2A27 |
| user bubble | #EEECE7 | #2E2C29 |
| accent (primary actions, focus, links) | #1F5F5B | #6FB8B1 |
| on-accent | #FFFFFF | #0F1F1E |
| accent soft (status pill bg) | #E6F0EE | #22312F |
| success | #2E7D4F | #7CC497 |
| warning (needs you) | #A15C07 | #E3A857 |
| danger | #B3261E | #F08A80 |
| info / working | accent | accent |
| background-state (violet family, muted) | #6B4FA0 | #B49BE0 |

  Semantic state colours (needs_you, working, background, done, idle, closed; usage tones; diff +/−; tool kinds) are derived tokens, each defined for both themes with WCAG AA contrast (4.5:1 text, 3:1 large/UI) against their background.
- **Type:** Geist (UI: labels, buttons, chips, lists, headers) and Newsreader (Claude's answers in the transcript, rendered markdown, artifact titles). Both self-hosted (npm `@fontsource-variable/geist`, `@fontsource-variable/newsreader` or equivalent), `font-display: swap`. Code: the platform monospace stack (no extra font). Scale: 12 / 13 / 14 (UI body) / 15.5 (answers) / 17 / 20, line-height 1.5 UI, 1.6 prose; answers max line length ~70ch on wide screens.
- **Theme switching:** System (default, follows `prefers-color-scheme`), Light, Dark — chosen in Settings, stored per device (localStorage, try/catch), applied before first paint (inline script in index.html sets `class="dark"` to avoid a flash), `<meta name="theme-color">` per theme, `color-scheme` set.
- **Shape and depth:** radius hierarchy instead of one radius for everything — 8 px controls, 12 px cards/rows, 16 px sheets/composer, full pills only for status. Borders over shadows; one soft shadow only for floating layers (menus, sheets, popovers).
- **Motion and feel (emil-design-eng + mobile-native skills in `.claude/skills/`):** buttons scale 0.97 on press (transform, 120 ms ease-out); menus/popovers origin-aware, 150 ms, never from scale(0); sheets slide with a spring-like ease, interruptible (CSS transitions, not keyframes); `prefers-reduced-motion` respected; no hover-only affordances on touch (`@media (hover:hover)`), no tap highlight flash, inputs ≥ 16 px on phones (no iOS zoom), `100dvh` and safe-area insets.
- **Avoid generic tells** (frontend-design skill): no all-caps tracked eyebrow labels, no monospace for small data labels, no tinted near-black, no identical-card kit; meta lines may keep `·` separators only where they separate genuinely different facts.

## Global Constraints
- All repo content in English; lucide icons, no emojis; no personal data.
- No hard-coded Tailwind palette colour classes (`zinc-*`, `blue-*`, `emerald-*`, `amber-*`, `red-*`, `violet-*`, …) remain in `app/src` outside `dev/` fixtures and tests — every colour comes from a semantic token (enforced by a test that greps the source).
- Contrast AA for every text/background token pair in both themes (a unit test computes it from the token table).
- Initial JS ≤ 655 kB (fonts are CSS/woff2 assets, not JS); fonts subset to Latin + Latin-ext.
- 320 px, touch targets ≥ 44 px, no horizontal page scroll — in both themes.
- Commits: author/committer `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests: `cd app && npx vitest run`, `npm run build`.

## Review Focus
1. Light theme on a phone in daylight: every state pill, diff colour and muted text stays readable (contrast).
2. Switching theme in Settings applies instantly everywhere, including code blocks, the slash menu, sheets and the Viewer chrome (the artifact iframe content itself is the artifact's own).
3. First load in light mode does not flash dark (and vice versa).
4. Long answers in Newsreader stay readable on 320 px (no overflow, sensible size).
5. Reduced-motion users get no transforms/slides.

---

### Task 1: Tokens, fonts, theme switching, base styles

**Files:** `app/src/index.css`, `app/index.html` (pre-paint theme script, theme-color, color-scheme), `app/src/lib/theme.ts` (+test), `app/src/screens/Config.tsx` (Appearance: System / Light / Dark), `app/src/lib/tokens.ts` (+test: the token table mirrored for contrast checks), `app/package.json` (fonts).
- [ ] Tokens as CSS variables for both themes (table above + derived state tokens), mapped into shadcn variables and Tailwind `@theme` colour names: `background, surface, ink, muted, line, chip, bubble, accent, accent-soft, on-accent, success, warning, danger, state-*`.
- [ ] `theme.ts`: `getTheme()/setTheme('system'|'light'|'dark')`, applies `.dark` on `<html>`, listens to `prefers-color-scheme` when system, updates theme-color meta. Tests (jsdom matchMedia stub).
- [ ] Fonts self-hosted; `--font-sans: Geist`, `--font-serif: Newsreader`; base layer: body uses tokens, font smoothing, `-webkit-tap-highlight-color: transparent`, `text-size-adjust`, inputs 16 px under 640 px.
- [ ] `tokens.test.ts`: every text-on-background pair used by the app meets AA in both themes.
- [ ] Commit `app: Quiet paper tokens, fonts and theme switching`.

### Task 2: Migrate the session view to tokens

**Files:** `screens/Session.tsx`, `components/Transcript.tsx`, `components/timeline/*`, `components/AskCard.tsx`, `components/Composer.tsx`, `components/SlashMenu.tsx`, `components/ModelEffortSheet.tsx`, `components/CommandCard.tsx`, `components/StatePill.tsx`, `components/ViewThumb.tsx`/`PastedImages.tsx`, `components/ai-elements/*` (vendored: message/response prose in Newsreader, code-block light+dark shiki themes, tool, confirmation, prompt-input, conversation, shimmer), tests.
- [ ] Replace every palette class with token classes; assistant answers in `font-serif` at 15.5 px / 1.6; user bubble token; tool rows/cards per the radius hierarchy; code blocks use a light shiki theme in light mode and a dark one in dark mode (both lazy).
- [ ] Commit `app: session view on design tokens`.

### Task 3: Migrate every other screen to tokens

**Files:** `App.tsx` (TopBar), `screens/{Projects,Project,ProjectTickets,Sessions,Config,Pair,Starting,Terminal,Viewer}.tsx`, `components/{ProjectCard,ProjectSessions,SessionRow,UsageStrip,NewSessionCard,LaunchDialog,TicketDetail,TicketRow,ProposalCard,ConnectorForm,WorkspaceForm,LazyBoundary}.tsx`, `components/ui/*` (shadcn primitives read tokens), tests.
- [ ] Replace palette classes; workspace colour dots keep the workspace's own colour (data), everything else tokens. Terminal screen: its terminal surface stays dark in both themes (it renders a terminal), chrome follows the theme.
- [ ] Add the source-grep test from Global Constraints (no palette classes outside dev/ and tests).
- [ ] Commit `app: all screens on design tokens`.

### Task 4: Interaction polish (emil-design-eng, mobile-native)

**Files:** `components/ui/button.tsx`, `components/ui/{dropdown-menu,sheet,dialog,tooltip,collapsible}.tsx`, `index.css`, selected components.
- [ ] Press feedback (scale 0.97), origin-aware menus, sheet/dialog transitions interruptible and short, collapsible rows animate height cheaply, reduced-motion fallbacks, hover styles only under `(hover:hover)`, focus-visible rings in accent, safe-area padding on composer/top bar, `100dvh`.
- [ ] Read `.claude/skills/emil-design-eng/SKILL.md` and `.claude/skills/mobile-native/SKILL.md` first; apply what fits; list in the report what you applied and what you skipped and why.
- [ ] Commit `app: interaction polish`.

### Task 5: Visual QA in both themes

- [ ] Controller-run: dev fixtures (`?data=worst|empty|one|huge`) at 320 / 390 / 1280 px in light and dark (Chrome via the agent-browser skill), plus a pass with `review-animations`; fix what breaks; final screenshots for the owner.
