# End-to-end verification, Plan 2 (projects)

**Run of 2026-11-22** on two real machines, with the real app in the browser.

Setup (the same isolation as the stage 1 e2e, `docs/e2e-stage1.md`):

- Hub on the VPS (aarch64, claude 2.1.330) on `127.0.0.1:7498`, database at `~/quorum-e2e/hub.db`. The PC reaches it
  through `ssh -L 17498:127.0.0.1:7498`.
- `quorumd` on the VPS with `CLAUDE_CONFIG_DIR=~/quorum-e2e/claude-config` (settings with
  `CLAUDE_CODE_PLUGIN_DIRS` pointing at the mod copy and `model: haiku`), its own `TMUX_TMPDIR` and `QUORUM_CONFIG_DIR`,
  and `~/quorum-e2e/bin` first in the PATH. Everything under `~/quorum-e2e`, deleted at the end.
- On the PC (WSL, claude 2.1.330): temporary `QUORUM_CONFIG_DIR` and the session `claude --plugin-dir ./mod --model haiku
  --permission-mode default` in a tmux with its own `TMUX_TMPDIR`.
- Test repo `demo` with the remote `https://github.com/e2e-quorum/demo.git` on both machines (PC on branch
  `feat/1-fix-login`, VPS on `main`). The exec connector is the example script from `docs/connectors.md`
  (two fixed tickets; `comment`/`set_status` are appended to a file).
- The app was driven with agent-browser on the visible Windows Chrome (desktop and 390 px).
- Haiku: 3 user prompts, about 4 recaps and the project summaries (through the owner's ccapi on the VPS): 2 during the run and at
  least 2 more while the hub stayed on unattended (see step 10). About 11 short calls.
- The run was cut by a network error and the PC lost `/tmp`: the PC session and the screenshots of the
  first pass were gone. The VPS hub kept running for about 6 h until cleanup.

Legend: OK / FAIL→FIXED (commit) / PENDING.

| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1 | Permission in the terminal and in the app at the same time | FAIL→FIXED (57deb94) | Prompt "create uno.txt with Write": in tmux the dialog "Permission · Write: … · 1. Allow 2. Deny" appeared and in the app the card. But the app also showed an `AskUserQuestion` row and a second question card: the mod's own `$.ui.ask` runs as an AskUserQuestion `tool.call` and the hook mirrored it. Answered in the terminal: `ask_resolved{by:terminal}`, the file was created and both cards disappeared. Fix: mod calls (`next.origin` other than `engine`, or id `toolu_plugin_…`) pass through without events. After hot reload, a second prompt (dos.txt) from the Composer: a single card. Allow in the app → `ask_resolved{by:device:Chrome · Windows}` and `dos.txt` created. The terminal dialog stayed open; answering it afterwards only showed "quorum: Already decided from Quorum", with no new events |
| 2 | Recap as name | OK | After the first prompt the session was named "Creating the file uno.txt with the text "hello"" in the list and the header; after the second, "Creating the file dos.txt…". The session opened from the ticket came out as "Drafting documentation for ticket 2 of the project" |
| 3 | Workspace + project with exec connector | OK | From Settings: "New workspace" (E2E Quorum) and "Create project" on the suggestion, with "Executable (custom script)" and the script command. Tickets: `1 Fix login` `rawStatus open` → `todo`; `2 Write docs` `in progress` → `in_progress`, assignee `ana`; progress 0/2 |
| 4 | GitHub connector (local hub on the PC, read-only) | Partial OK | Ruling Y: local hub on `127.0.0.1:17499` with `S-kkipie/ccapi` and `labelsAsStatus`. It synced without error and fetched 0 tickets, same as `gh issue list --state all` (the repo has no issues), so the normalization could not be seen. With a nonexistent repo: "GitHub: repository not found (S-kkipie/no-existe-quorum-e2e)". Nothing was written to GitHub |
| 5 | Paperclip connector against the VPS (read-only) | OK | Project with `baseURL http://127.0.0.1:3100` and the ACME company. The board token was read on the VPS and sent with `PUT /api/projects/{id}/token` without printing it; the API only returned `hasToken:true` and the hub log does not contain it. 136 tickets: `[AID-138] Server check` `done` → done, `[AID-52] …` `in_progress` → in_progress, progress 129/136. No proposals were created or approved against Paperclip |
| 6 | Project suggested from the remote; two checkouts | OK | With both sessions open (PC and VPS on `demo`), Settings showed the suggestion `https://github.com/e2e-quorum/demo.git` with both roots and "2 sessions". When created, both sessions got a `projectId` and `GET /api/projects/{id}/checkouts` returned two checkouts (pc-wsl on `feat/1-fix-login`, the VPS on `main`); the Project screen lists them under "CHECKOUTS" |
| 7 | Branch `feat/1-…` → suggestion → confirm | FAIL→FIXED (f7dfa28) | The PC session was already open when the project was created: the checkout was adopted before the first sync brought the tickets and nobody looked at the branch again (ticket 1 ended up with `sessions: []`). Fix: when adopting checkouts and when a sync changes tickets, the branches of the project's live sessions are looked up. After the redeploy the project was deleted and recreated from the UI: the suggestion "… → 1 Fix login" appeared under "ASSOCIATION SUGGESTIONS", Confirm → `confirmed:true` and the ticket says "session on pc-wsl" |
| 8 | Open a session from the ticket on the VPS; second attempt → 409 | OK | Ticket 2, machine vps-arm64, Normal, checkout `/home/user/quorum-e2e/work/demo` → "Open session": tmux `quorum-toxagi-…` with the first prompt "Ticket 2: Write docs" (the script's ticket has no body or comments), the session was linked and confirmed. Second `POST /api/tickets/{id}/launch` → 409 `{"error":"a session is already working on this ticket","session":"aa40d6f6-…"}`; the ticket screen shows "A session already has this ticket … Go to session" and the button leads to it. The 409 branch when pressing "Open session" (race) is covered by `TicketDetail.test.tsx`; it was not forced in the browser |
| 9 | `turn_end` → proposal; approve against exec; reject another | OK | After allowing a read-only `Bash` and denying another from the app, at the end of the turn the pending `comment` proposal "Progress (Quorum, vps-arm64): …" appeared, visible and editable on the ticket. Approve → `approved` and the script's `writes.log` received `{"op":"comment","externalId":"2","body":"Progress …"}`. Propose "in review" → Reject → `rejected`; the log stayed at a single line |
| 10 | Project summary; not regenerated before 30 min | OK | The owner's ccapi runs on the VPS (`127.0.0.1:18787`, key in `~/.config/ccapi/token`), so the hub summarized through its API with Haiku. The ccapi process was not touched: "Project "demo": there is 1 ticket to do (fix login) and 1 in progress (write docs), with two inactive sessions…". Afterwards there was activity (new session, proposals, broken connector) and `summaryAt` did not change on the queries of the following minutes. demo's regeneration happened at 22:02:12 UTC, 31 min after the first (21:31:12). ACME was last regenerated at 01:36 UTC when its issues changed (131/138) |
| 11 | Broken exec connector (exit 1) | OK | Editing the project with `broken.sh` (`exit 1` and "manager down (e2e)" on stderr): the card and the Project screen show "Sync error: the connector failed: exit status 1: manager down (e2e)" and "last attempt … ago". Both tickets were kept |
| 12 | UI smoke test (desktop and 390 px) | OK | Projects, Project, Ticket and Settings on desktop and at 390 px: no overflow; on mobile each screen fills the width with "←" to go back. The screenshots of the first pass were lost with `/tmp`; on resuming, Projects, Project, Ticket, Settings and Projects at 390 px were repeated in `.superpowers/sdd/2026-11-22-quorum-plan2-projects/task-15-shots/` |

Summary: 10 OK (one partial, #4) and 2 FAIL→FIXED (steps 1 and 7) with 2 commits. None PENDING.
Full log: `.superpowers/sdd/2026-11-22-quorum-plan2-projects/task-15-report.md`.

Findings with no code change (environment):

- The Windows clock was about 7 min ahead of WSL and the VPS, which agreed. So the app in Chrome
  said "inactive 8 min" or "synced 7 min ago" for recent things.
- The WSL clock jumped forward about 6.5 min during the first turn and then went back. Claude Code showed
  "Churned for 7m 2s" and the tool row came out with `-390258 ms`: the `tool_start` carried a later time than the
  `tool_end`. Times are set by the mod with the machine's clock.
- In the VPS session, the denial arrived as "denied by plugins quorum, cc-plugin-privacy": that machine has
  another plugin that also votes in tool.check. It did not affect the result.
- The agreed GitHub test repo (`S-kkipie/ccapi`) has no issues. To see the GitHub normalization a repo with
  issues is needed.
