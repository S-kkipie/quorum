---
name: local-artifacts
description: Use ONLY when you create a standalone page or document for the user to view, typically on their phone - a report, write-up, HTML page, explanation, comparison, diagram, visual summary or presentation. Produces one self-contained, phone-first HTML file. Do NOT use for building an app's UI, components, a landing page, or a project's own pages or site.
---

# Local artifacts

A local artifact is a single HTML page you write so the user can read it on their phone (or desktop). Make it clear first, then beautiful.

## Format

- One self-contained `.html` file: inline CSS and JS, no CDNs, no remote fonts, no external requests (the viewer blocks the network).
- Images and icons as inline SVG or `data:` URIs. Charts and diagrams as inline SVG.
- Include `<meta name="viewport" content="width=device-width, initial-scale=1">` and a short, specific `<title>`.
- Keep JS to what the content needs (a toggle, a tab, a filter). Static is fine.

## Phone first

- Design for 390 px width first, then scale up to desktop with a centered column (about 60-72ch for text) and `min()`/`clamp()` sizing.
- Dark mode via `prefers-color-scheme`: define colors as CSS variables on `:root`, override them in the dark media query, and set `color-scheme: light dark`. Give `body` an explicit background.
- Body text at least 16px, comfortable line-height (1.5-1.65), tap targets at least 44px, no horizontal page scroll.
- Tables: never let a wide table squash or overflow the page. Wrap in an `overflow-x: auto` container with a sticky first column (give sticky cells an opaque background so scrolled cells do not show through), or restack rows as labeled blocks under about 600px. Keep columns few and numbers right-aligned.
- Respect `prefers-reduced-motion`; keep visible focus styles.

## Aesthetics with intent

Before writing code, decide in a few lines: the subject, the reader's main question, and one memorable element. Then choose:

- Color: 4-6 named values (background, surface, text, muted text, one accent, optionally one signal color). Pick them from the subject, not from habit. Check contrast in both themes.
- Type: system font stacks only. Choose a direction on purpose, e.g. `ui-serif, Georgia, "Iowan Old Style", serif` for editorial text, `ui-sans-serif, system-ui` for tools, `ui-monospace` for code and data. Set a clear scale with distinct weights; one family is enough.
- Hierarchy: the answer or conclusion first, details after. One idea per section. Structure (borders, dividers, numbering) must carry information; number items only if they are a real sequence.
- Spend boldness in one place and keep the rest quiet. Cut decoration that does not serve the content.

Avoid the generic AI look:

- Identical rounded cards with the same soft shadow around everything; gradient washes as decoration.
- A big-number-plus-gradient hero by default; a tracked-out all-caps label above every heading; one word accented in a headline.
- Defaults chosen out of habit: cream background with terracotta accent, near-black with a single neon accent, purple-to-blue gradients, emoji as icons.
- Fade-and-slide entrances on every section. At most one deliberate motion, or none.
- Filler copy. Write real, specific content in plain sentence case.

## Save and finish

1. Save to `<project root>/.claude/quorum/artifacts/<clear-name>.html` (create the folder; use a short descriptive kebab-case name), unless the user asks for another path.
2. Read the file back before finishing: check it is complete, has no external URLs, tables and long words do not overflow at 390 px, and both themes have readable contrast.
3. In your final answer, give the file path and a one-line summary of what the page shows.

Adapted from anthropics/skills (frontend-design), Apache-2.0
