# AI Elements spike (Plan 5, Task 1)

Source: `npx shadcn@latest add @ai-elements/<name>` (the unprefixed shadcn registry does not carry the AI Elements components, except an unrelated `message` item that is not used). Vendored under `app/src/components/ai-elements/`. shadcn primitives are under `app/src/components/ui/` (new-york style, zinc base, CSS variables). Tokens are in `app/src/index.css`; `<html class="dark">` is always set.

Import rule: only `import type` from `ai`. `ai` is a devDependency.

## Mapping from the brief

| Brief name | What exists | Decision |
| --- | --- | --- |
| `response` | No such component. It was merged into `message.tsx` as `MessageResponse` (Streamdown) | Use `MessageResponse` |
| `loader` | Not in the registry (404) | Use `ui/spinner.tsx` (pulled in as a dependency) or `Shimmer` |
| `conversation`, `message`, `tool`, `confirmation`, `prompt-input`, `code-block`, `artifact`, `shimmer` | Present | Vendored |

Extra shadcn primitives pulled in by dependencies: `alert, button-group, command, hover-card, input-group, select, separator, spinner`.

## Components

### message.tsx
- Exports: `Message` (`from: "user" | "assistant" | ...`), `MessageContent`, `MessageResponse`, `MessageActions`/`MessageAction`, `MessageToolbar`, `MessageBranch*`.
- `MessageResponse` props: Streamdown props (`children` = markdown string, `className`, `isAnimating`, ...).
- Works as-is? No. Defaults render raw HTML `<img>` and remote markdown images as `<img>`. Fixed inside the vendored file: `skipHtml`, `components.img` (remote images become `[image: alt]` links with `target=_blank rel="noopener noreferrer"`, other sources become inert text), `linkSafety={{ enabled: false }}` (otherwise links are buttons behind a modal; now plain anchors with `target=_blank rel="noopener noreferrer"`; `javascript:` links are blocked by Streamdown). Both Markdown tests pass through these props, so the `components/Markdown.tsx` fallback was NOT needed.
- Removed plugins: `@streamdown/math`, `mermaid`, `cjk` (not installed). `@streamdown/code` is loaded with a dynamic `import()` inside `MessageResponse` (an effect), so code is unhighlighted for one frame.
- Note: hrefs are normalized by the markdown pipeline (`https://example.com` becomes `https://example.com/`).
- Note: its styling is shadcn-token based (`text-primary`, `bg-muted`); the existing `Markdown.tsx` is still available and unchanged.

### tool.tsx
- Exports: `Tool` (a `Collapsible`, closed by default; `defaultOpen` to open), `ToolHeader`, `ToolContent`, `ToolInput`, `ToolOutput`.
- Props used: `ToolHeader type="dynamic-tool" toolName="Read" title="Read google.ts" state="output-available"` (state is one of the AI SDK `ToolUIPart` states). `ToolContent` accepts arbitrary children.
- Works as-is? Yes. Custom children (a `<pre>`) render inside `ToolContent` after the header is clicked. `ToolInput`/`ToolOutput` use `CodeBlock`; we can skip them and put our own diff/body components in `ToolContent`.
- Fallback: none.

### code-block.tsx
- Exports: `CodeBlock` (`code`, `language`, `showLineNumbers`), `CodeBlockHeader/Title/Filename/Actions`, `CodeBlockCopyButton`, `CodeBlockContent`, `highlightCode`, language selector parts.
- Works as-is? Mostly. Vendored version imported `createHighlighter` from `shiki` statically (entry chunk 1.4 MB). Changed to `import("shiki")` inside `getHighlighter`. Highlighting is async; raw tokens show first.
- Fallback: none.

### conversation.tsx
- Exports: `Conversation` (use-stick-to-bottom wrapper; props = StickToBottom), `ConversationContent`, `ConversationEmptyState`, `ConversationScrollButton`, `ConversationDownload`.
- Works as-is? Not exercised by tests; typechecks and bundles.

### prompt-input.tsx
- Exports: `PromptInput` (`onSubmit(message: {text, files}, event)`), `PromptInputBody`, `PromptInputTextarea`, `PromptInputFooter`, `PromptInputTools`, `PromptInputSubmit` (`status`), `PromptInputProvider`, attachments/command/select helpers.
- Works as-is? Not exercised by tests; typechecks and bundles. It is large (1.4k lines) and pulls `select`, `command` (cmdk), `hover-card`, `nanoid`. Later tasks may use only the subset they need.

### confirmation.tsx
- Exports: `Confirmation` (`approval`, `state`), `ConfirmationTitle`, `ConfirmationRequest`, `ConfirmationAccepted`, `ConfirmationRejected`, `ConfirmationActions`, `ConfirmationAction`.
- Works as-is? Not exercised by tests. Its props are typed on AI SDK tool-part `state`/`approval`; map Quorum permission requests onto those.

### artifact.tsx
- Exports: `Artifact`, `ArtifactHeader`, `ArtifactTitle`, `ArtifactDescription`, `ArtifactActions`, `ArtifactAction`, `ArtifactClose`, `ArtifactContent`.
- Works as-is? Pure layout card; yes.

### shimmer.tsx
- Exports: `Shimmer` (`children: string`, `as`, `duration`, `spread`).
- Works as-is? No: vendored version used `motion` (about 500 kB unminified in the entry chunk). Rewritten with the same props and a CSS keyframe (`shimmer-sweep` in `index.css`); `motion` removed from dependencies.

## Test status
`app/src/components/ai-elements/spike.test.tsx` (jsdom): remote images become links, raw HTML does not render an `img`, links open in a new tab and unsafe schemes are inert, `Tool` hosts custom children.

## Bundle impact (`npm run build`)
- Before (HEAD): entry `index-*.js` 509.34 kB (gzip 153.78 kB).
- After, nothing imports the new components yet (tree-shaken): 509.34 kB (unchanged).
- Worst case, a temporary probe importing every vendored AI Elements module from `main.tsx`: 527 kB (gzip about 160 kB), within the 655 kB budget. Without the dynamic imports and the Shimmer rewrite the same probe was 1,418 kB.
- Side effect: shiki language and theme chunks (about 300 files) are emitted into `internal/hub/web/dist/assets/` once something imports `code-block` or `MessageResponse`. They load only on demand. Later tasks can trim this by importing `shiki/core` with an explicit language list if the dist size matters.

## Other setup notes
- `@/` alias in `tsconfig.json` (`paths` only; TypeScript 7 removed `baseUrl`) and `vite.config.ts`.
- The shadcn CLI rewrote the `cn` import to a bogus `"cn"` package in some generated files; they were fixed to `@/lib/utils`. Watch for this when adding components later.
- Dependencies added: `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, `lucide-react` (existing), `streamdown`, `@streamdown/code`, `shiki`, `use-stick-to-bottom`, `cmdk`, `nanoid`; dev: `ai` (types).

## Task 6 adaptations (session view)

- `tool.tsx`: `ToolHeader` takes optional `icon`, `meta` and `status` (ReactNode). They replace the wrench icon, add a right-aligned detail (the diff count) and replace the status badge (Quorum shows a small state icon labelled `running` / `done` / `failed` / `denied`). Without them it renders as vendored. The title span truncates.
- `prompt-input.tsx`: `PromptInputTextarea` takes `submitOn?: "enter" | "mod-enter"` (default `"enter"`, the vendored behaviour). The composer uses `"mod-enter"`: Enter stays a new line, as before, and Ctrl/Cmd+Enter submits. The composer's text is controlled by `useDraft`, not by the form; `PromptInput`'s `form.reset()` is harmless because React keeps a controlled textarea's `defaultValue` equal to its value. Send is the submit button; Queue and Interrupt and send are plain buttons.
- `conversation.tsx`: unchanged. Load-more on scroll to top and keeping the reading position when earlier events are prepended live in `HistoryLoader` inside `components/Transcript.tsx`, which reads `scrollRef` / `state` from `useStickToBottomContext()`.
- `confirmation.tsx`: unchanged. The Alert's `role="alert"` is overridden per use (`role="group"`, `aria-label="Permission request"`) so error alerts stay the only `alert` role in the card. The permission card moves to `approval-responded` after a successful decision, which hides the actions (first choice wins).
- Tests: `use-stick-to-bottom` needs `ResizeObserver`, which jsdom lacks; `app/src/test-setup.ts` (vitest `setupFiles`) stubs it.
- `components/Markdown.tsx` stays: `screens/Viewer.tsx` still renders markdown files with it. The transcript uses `MessageResponse`.
- Bundle: `screens/Session.tsx` is lazy-loaded from `App.tsx` (`React.lazy` + `Suspense`, spinner fallback). Initial JS: `index` 417.26 kB + `lib` 185.45 kB + `preload-helper` 20.22 kB + `rolldown-runtime` 0.72 kB = 623.65 kB (budget 655 kB); `Session` chunk 416.31 kB. Without the lazy load the entry was 1,017.57 kB.
