# End-to-end verification, Plan 3 (herdr)

**Run of 2026-11-23** against the real, already deployed hub, with the real app in the browser.

Setup: app in a phone viewport (390x844) in Chrome (Windows) paired as a test device (revoked at the
end); machines: an arm64 Linux server (herdr 0.9.5 headless via `scripts/install-herdr.sh`, user service) and
the PC with WSL (the owner's own herdr, untouched except for the tabs the test opened).

No project had a checkout on the Linux server. Case 1 was run with "Launch" (launch dialog) on a
disposable git repo created for the test on the server. "Resume" and "Terminal" only exist on the screen of a
project with a checkout on the chosen machine, so cases 2, 3 and 4 were run on the PC with WSL on a project
with a checkout there (the test's own tabs inside the owner's workspace).

Legend: OK / FAIL→FIXED (commit) / FAIL (not fixed) / PENDING / NOT RUN.

| # | Case | Result | Evidence |
|---|------|--------|----------|
| 1 | A project → "New session" (Linux server, Skip permissions): the app moves to "Starting…" and opens the chat by itself; `herdr pane list` shows a new tab in the project's workspace with Claude and `--dangerously-skip-permissions`; a prompt from the phone gets an answer | OK (via "Launch", no project) | Launch → server machine, disposable repo folder, Skip permissions: the app opened the chat by itself in ~5 s. In herdr a new workspace appeared named after the folder, one tab and one pane with `agent: claude`; the process is `claude --dangerously-skip-permissions` with cwd in the folder. "Reply only: OK" → "OK · end of turn · 4 tokens". The "Starting Claude on <machine>…" screen was seen in case 6 (here the switch was faster than the capture) |
| 2 | "Resume" a closed conversation: opens in a new tab and the app navigates to it | OK (on the PC) | Session from case 5 closed with "Close" (confirmation): it shows as "closed" and under CONVERSATIONS of the project. One tap → new tab in the same workspace with `claude --dangerously-skip-permissions --resume <id>`; the app navigated to the session by itself (same id), with the history and the composer active |
| 3 | "Terminal": the screen is visible; `git status` + ⏎ shows the output; Ctrl-C works; closing the view and coming back reuses the same pane | FAIL→FIXED (re-test OK) | **Re-test after the fix:** terminal opened, `echo` + ⏎, go back and tap "Terminal" again: same pane and the live screen appeared in ~1 s, with no "Connecting…". **First run:** | Screen visible, `git status` + ⏎ showed the output, `sleep 30` + Ctrl-C cut it (`^C`, prompt back, no process). Going back and tapping "Terminal" again reuses the same pane (no new one in herdr), **but the view stays at "Connecting to the terminal…"** until the pane's screen changes (sending an `echo` made it appear). Probable cause: if the daemon's watcher is still alive (15 s lease), `watch` only renews the lease and the loop only emits a snapshot when the text changes; the app deliberately discards the snapshot stored from the previous visit and waits for a new one that never arrives |
| 4 | Close the terminal pane from herdr: the app shows "Terminal closed" | FAIL→FIXED (re-test OK) | **Re-test after the fix (on the PC):** `herdr pane close` of the test pane with the app watching: "Terminal closed" in ~1 s. **First run:** | Run on the PC (no terminal possible on the server). `herdr pane close <pane>` with the app watching: the app kept showing the last snapshot, with no notice. Cause: herdr 0.9.5 answers `{"code":"pane_not_found"}` and the daemon only recognizes `not_found` (`isNotFound`), so it never emits the closing `term_frame`. Tapping "Terminal" again did open a new pane (the `herdr-terminals.json` cleanup works). "Close terminal" from the app's ⋯ menu does close the tab |
| 5 | PC with WSL (own herdr): "New session" on a project shows up as a tab in that project's existing workspace, without renaming it | OK | Before/after `herdr workspace list`: same workspaces and names; the project's went from 1 to 2 tabs (the new one, "claude"), without changing focus. `claude --dangerously-skip-permissions` in the project folder. "Reply only: OK" → "OK" |
| 6 | Quick double tap on "New session": a single session | OK | Double click on "New session": a single `POST /api/launch`, "Starting Claude on <machine>…", a single new tab and a single claude process |
| — | Launch from a ticket | NOT RUN | The only project with tickets has no checkout on any machine (only "Another folder…"), and its tickets are real: launching would send the ticket as the first prompt to a Claude with no permissions |

Summary: first run 4 OK and 2 FAIL (cases 3 and 4); after the fix (quorumd restarted on both machines) the re-test of cases 3 and 4 was OK. Launching from a ticket remains NOT RUN.

Findings without a case failure:

- First run: closing a session from the app ended Claude but left the herdr tab open with the shell.
  **Re-test after the fix:** "New session" on the PC → chat → "Close" (confirmation): the session's tab
  disappeared from `herdr tab list` in ~1 s; the owner's other workspaces and tabs stayed the same (before/after).
- `herdr-terminals.json` keeps the pane closed from herdr until the next "Terminal" opening, which cleans it.
- When launching with no project on a machine whose herdr has no workspaces, a new workspace is created named after the folder.

Cleanup: only the tabs created by the test were closed with `herdr tab close` (on the PC the workspace and tab lists
stayed the same as before; on the server herdr was left empty as at the start), the disposable repo was deleted and the
test device was revoked. In the re-test likewise: new device revoked at the end and the PC's workspace and tab lists
identical before and after.
