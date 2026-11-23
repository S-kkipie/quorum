# End-to-end verification, Plan 4 (agent view + local artifacts)

**Run of 2026-11-23** against the real, already deployed hub (plugin 0.1.3 with the `local-artifacts` skill on
both machines), with the real app in the browser.

Setup: app in a phone viewport (390x844) in Chrome (Windows) paired as a test device (revoked at the end).
One new session on the WSL PC, launched from the top-bar "New session" dialog (machine: the WSL PC, folder: a
project's checkout, Skip permissions on). Prompts sent from the app:

1. "Read README.md, search the web for 'herdr terminal', and make me a local artifact with a short summary of what Quorum is."
2. "Add a final line 'Checked from the phone' to that artifact."

The model did choose the skill: the transcript shows `Read`, `ToolSearch`, `Skill (quorum:local-artifacts)`,
`WebSearch`, `Bash` in turn 1 and `Edit` in turn 2.

Legend: PASS / FAIL / PARTIAL.

| # | Case | Result | Evidence |
|---|------|--------|----------|
| 1 | Timeline rows collapsed by default with SVG icons (no emojis); Read, web search, "Used skill local-artifacts" and "Created …html" rows; each expands on tap | PARTIAL | Rows after turn 1: "Read README.md", "ToolSearch", "Used skill local-artifacts", "Searched \"herdr terminal\"", and a Bash row "Write Quorum summary artifact and check for external URLs". All `aria-expanded=false` at first, each with SVG icons (3 `svg` per row: kind icon, status check, chevron); no `Extended_Pictographic` character anywhere in the page text. Taps: Read → the file path; search → the tool output (query, link list, summary); skill → `{"skill": "quorum:local-artifacts"}`; Bash → the command and "(Bash completed with no output)". **No "Created …html" row**: the model wrote the file with a Bash heredoc (`mkdir -p … && cat > …/what-is-quorum.html <<'EOF'`), not with `Write` |
| 2 | The answer renders Markdown | PASS | Paragraphs, inline `code` for the path, a bullet list with 4 `strong` lead-ins, and a "Sources" list of 4 real links. No raw `**` and no lines starting with `#` in the page text |
| 3 | Artifact card "Open" opens the HTML full-screen; renders dark/phone; iframe sandbox without `allow-same-origin` | PARTIAL | **Turn 1 produced no card** (same cause as case 1: a Bash write gets no card, by spec only a successful `Write`/`Edit` does). After turn 2's `Edit` a card "what-is-quorum.html · <machine> · .claude/quorum/artifacts" with "Open" appeared. "Open" → full-screen viewer (iframe 390x791 under a bar with Close / Reload / Open in new tab), page rendered in dark theme at phone width with its inline SVG diagram. iframe `sandbox="allow-scripts allow-popups allow-forms allow-modals"` (no `allow-same-origin`); `iframe.contentDocument` is `null` from the app. Opening the same `/v/` URL top-level: `origin` is `null` and `localStorage` throws `SecurityError` |
| 4 | Follow-up edit → "Edited …html" row with a diff; card at the latest position; opens the updated file | PASS | Row "Edited what-is-quorum.html +1 -0"; tap → green `+ <p class="muted" …>Checked from the phone</p>` (a pure insertion, so no `-` line). The card sits right after that row, before the final answer, and it is the latest one. The viewer's `/v/` response contains "Checked from the phone" |
| 5 | Security spot-check from the app page console | PASS | `fetch` of the artifact's `/v/` URL: 200, `content-security-policy: sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors 'self'; default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'; form-action 'none'; base-uri 'none'`, `x-content-type-options: nosniff`, `cache-control: no-store`, `access-control-allow-origin: *`, `referrer-policy: no-referrer`. `/v/<token>/.env` → 403 "this file is not served"; `/v/<token>/..%2f..%2fetc%2fpasswd` → 403. A browser `fetch` of `/v/<token>/../../etc/passwd` is normalized by the URL parser to `/etc/passwd` (hub root, served the SPA's `index.html`, not the file). Sent raw with `curl --path-as-is`: `../../etc/passwd`, `../../../../../../etc/passwd`, `%2e%2e/%2e%2e/etc/passwd`, `.claude/quorum/../../.env` → all 403 |
| 6 | Header: "Working" while running, "Waiting for you" after; "Interrupt" only while working; ⋯ has "Close session" | PASS | Before the prompt and after each turn: gray "Waiting for you", no Interrupt button in the header. While running: blue "Working" with dot and an "Interrupt" header button (both turns). ⋯ menu: "New session here", "View in terminal", "Close session". The header title became the session's summary ("Writing a Quorum summary artifact…") |

Summary: 4 PASS, 2 PARTIAL (cases 1 and 3), both from the same cause.

## Findings

- **The artifact from turn 1 got no card and no "Created" row.** The `local-artifacts` skill says "Save to
  `<project root>/.claude/quorum/artifacts/<name>.html` (create the folder …)". The model read "create the
  folder" as a reason to use Bash (`mkdir -p … && cat > … <<'EOF'`), and Bash writes are not detected. Likely
  fix in `mod/skills/local-artifacts/SKILL.md`: tell it to save with the `Write` tool (which creates missing
  folders) and never via shell redirection. Optionally the timeline could also detect `cat > <viewable file>`
  in Bash, but the skill fix is simpler.
- The skill also asks to "read the file back"; the model checked it with a search inside the same Bash call and
  did not `Read` it. Harmless.
- The composer always shows "Interrupt and send" and "Queue" next to "Send" (disabled while empty), also when
  the session is waiting. Not a header issue; noted only.
- Test tooling note: the `abw` wrapper translates any argument starting with `/` into a Windows path, so typing
  a Linux folder into the dialog needed the leading `/` inserted via `insertText`. Not an app bug.

## Cleanup

- Session closed from the app (⋯ → Close session → confirm): status "Closed"; its herdr tab disappeared by
  itself, and `herdr tab list` matched the list taken before the test.
- The artifact file and the `.claude/quorum/artifacts` folders it created (none existed before) were deleted;
  `git status --short` showed no leftovers from the test.
- The test device was revoked (`quorum-hub devices` no longer lists it); the browser was closed. Nothing on the
  Linux server was touched besides reading hub state.
