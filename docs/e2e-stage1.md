# End-to-end verification, stage 1

Manual checklist with the expected result of each step and the actual result of the last run.

**Run of 2026-11-22: isolated local smoke test** on the PC (WSL), installing nothing: hub on `127.0.0.1:7498` with a temporary database,
temporary `QUORUM_CONFIG_DIR`, mod loaded with `claude --plugin-dir ./mod` inside tmux, and the hub API and the `/api/live` WebSocket
driven with curl and a node script. Steps that need a VPS, or ccapi, remain pending.

Legend: OK / FAIL / pending.

| # | Step | Expected result | Result |
|---|------|-----------------|--------|
| 1 | Hub on the VPS, `quorum-hub pair`, pair the phone | The app shows "no machines" | VPS and phone: pending. Local smoke: OK (`pair` + `POST /api/pair` returned a device token and an authenticated `GET /api/machines` answered) |
| 2 | `quorumd link` on the PC (WSL) and on a VPS | Both show up online | PC: OK (`link` said "linked as pc-wsl", `online:true`). VPS: pending (needs a VPS) |
| 3 | Open `claude` by hand on the PC | The session appears in under 2 s with state "idle" | OK. After accepting the folder trust prompt, the session arrived via `/api/live` and `/api/sessions` with `state:idle` |
| 4 | Prompt from the phone | Visible streaming, tools as rows, back to "idle" | Partial OK. `POST .../prompt` (mode now): `user`, `turn_start`, `status working`, `assistant_delta`, `assistant`, `turn_end`, `status idle` arrived. Tool rows not tested (the prompt used no tools) |
| 5 | `/quorum` in the terminal | Shows machine and "connected" | OK. Output: `machine: pc-wsl`, `connection: connected`, `role: work` |
| 6 | Turn on "away" and ask for something that needs permission | Card on the phone; Allow and the tool runs | pending (not tested to avoid spending quota or requiring permissions; the session ran in auto mode) |
| 7 | `AskUserQuestion` answered in the terminal | The phone card disappears | pending (not tested) |
| 8 | Kill `quorumd` | Within 10 s or less the session is connected again | OK. The daemon PID was killed; within 1 s there was another `quorumd serve` (relaunched by the mod), the machine came back `online:true` and the session stayed `idle` |
| 9 | Stop the hub for 30 s and start it again | Everything comes back without closing sessions | OK. Hub stopped for 30 s and relaunched with the same database: machine online and session `idle` within 10 s; a later prompt produced events normally |
| 10 | Launch a session on the VPS from the app | It appears; `tmux ls` shows `quorum-...`; `whoas which claude` matches | pending on VPS. Local: `POST /api/launch` returned 202 and `launch_result ok:true`, but on WSL the daemon uses `wt.exe` (Windows Terminal), not tmux, so `tmux ls` does not apply. A `claude` was seen in the requested folder; since the mod was not installed no session appeared in the hub (expected in this smoke test). The process was closed by hand |
| 11 | With ccapi running | It appears under "Services"; the Composer is disabled | pending (needs ccapi) |
| 12 | Machine with pastor enabled | NOT APPLICABLE (pastor retired) | NOT APPLICABLE |
| 13 | `/clear` in a session | The card keeps its place and the chat continues | OK. The hub emitted `session_upsert` with `previousId` = previous id; `/api/sessions` ended up with a single card (new id), the event history was kept and a later prompt produced `user`/`assistant`/`turn_end` on the new id. Note: `previousId` only travels in the live upsert; the REST list returns it empty |
| 14 | Close the session from the app | It disappears and the process ends | OK. `POST .../close` returned 202; `/api/sessions` ended up empty and the tmux pane closed |

Summary: 8 OK (some partial or local only), 0 FAIL, 6 pending (VPS in 1, 2 and 10; 6, 7, 11, 12).

## Local smoke test procedure

1. `make build`.
2. Hub: `./bin/quorum-hub serve --addr 127.0.0.1:7498 --db $TMP/hub.db`; `quorum-hub pair --db ...` and `link-code --db ...`.
3. Daemon: `export QUORUM_CONFIG_DIR=$TMP/qcfg`, `./bin` first in the PATH, `quorumd link http://127.0.0.1:7498 <code>`, `quorumd ensure --json`.
4. Session: `tmux new-session -d -s quorum-smoke -c <folder> "QUORUM_CONFIG_DIR=$TMP/qcfg PATH=$PWD/bin:\$PATH claude --plugin-dir $PWD/mod"`.
5. Verify through the API with `Authorization: Bearer <token>` and through the WebSocket `/api/live?token=<token>`.
6. Clean up: stop hub and daemon, close tmux, delete `$TMP`.

## Findings

- On WSL, launching from the app opens Windows Terminal (`wt.exe`) instead of tmux; step 10 of this list assumes tmux, which only applies to Linux VPSs.
- A freshly killed `quorumd` is relaunched by the mod in about 1 s, well under the 10 s goal.

## Functional E2E 2026-11-22 (PC WSL + arm64 VPS)

Real run on two machines, installing nothing:

- Hub on the VPS (aarch64, claude 2.1.325) on `127.0.0.1:7498`, with its database at `~/quorum-e2e/hub.db`. The PC reaches it through an `ssh -L 17498:127.0.0.1:7498` tunnel.
- `quorumd` on the VPS with an isolated environment: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PLUGIN_DIRS=~/quorum-e2e/repo/mod`, its own tmux with `TMUX_TMPDIR` and `QUORUM_CONFIG_DIR`.
- On the PC (WSL, claude 2.1.330), temporary `QUORUM_CONFIG_DIR` and `claude --plugin-dir ./mod` sessions in a dedicated tmux `-L`.
- The app was tested with agent-browser on a headless Windows Chrome with a temporary profile.
- 11 short prompts were used in total.

Legend: OK / FAIL→FIXED (commit) / NOT APPLICABLE.

| # | Result | Evidence |
|---|--------|----------|
| 1 | OK | `quorum-hub pair --db …` + `POST /api/pair` through the tunnel returned the token; `GET /api/machines` answered `[]`. In the UI, pairing with the code showed the list |
| 2 | OK | `quorumd link` on the PC (`http://127.0.0.1:17498`) and on the VPS (`http://127.0.0.1:7498`). Both machines came up `online:true` in the API and in the UI |
| 3 | FAIL→FIXED (a73c7a5, abe1969) | PC: `session_upsert` 1.7 s after accepting the folder trust prompt. VPS: with `POST /api/launch`, the isolated tmux showed `quorum-…` and the line was `bash -lc 'claude …'` (no absolute path), but the session was not registered: in 2.1.325 `$.session.info` does not exist and session.start threw a TypeError. Fixed: the upsert now arrives about 2.4 s after the launch. Also, the "Normal (asks permission)" mode opened in auto mode (no flag, claude used the account's defaultMode). It now passes `--permission-mode default` and the session shows "manual mode on" |
| 4 | OK | Prompt "list the files… with ls": `user`, `turn_start`, `status working`, `tool_start Bash ls`/`tool_end leeme.txt`, `assistant_delta`×2, `assistant`, `turn_end`, `status idle` |
| 5 | OK | `/quorum` in both terminals: `machine: pc-wsl` / `vps-arm64`, `connection: connected`, `role: work` |
| 6 | FAIL→FIXED (43d56b0) | With "away", the permission went to the terminal: the tool.check hook has its own 10 s (`remainingMs=10000`), so the wait came out negative and, with no cap, the engine cut the hook at 10 s (`ask_resolved{by:terminal}` at exactly 10 s). Fixed with `quorumd hold` launched with the hook's `$`. On the VPS: card via `/api/live`, Allow at 32 s → `prueba.txt` created; Deny with a reason → `tool_end ok:false … not needed` |
| 7 | OK | Two AskUserQuestion in one turn. The first, answered in the terminal: `ask_resolved{by:terminal}` and the card was withdrawn. The second, from the device (`answers`): the model answered "Favorite color: blue / Favorite fruit: apple" |
| 8 | OK | VPS with a pending permission: `kill` of the quorumd PID; the mod relaunched it in 1 s and the session came back (`session_upsert needs_you`) in 1.3 s. The pending card was denied after reconnecting (202 and `tool_end ok:false`). PC: daemon relaunched in 1 s |
| 9 | FAIL→FIXED (284cd1b) | Hub stopped for 30 s and relaunched with the same database: machines online in 2-30 s depending on the daemon's backoff (30 s cap) and sessions back, but `away {}`: away mode was lost. Fixed: persisted `away` table. Run again: snapshot with `away {dc2b…: true}` and, after the restart, the permission from the UI step reached the device (presence forwarded to the mod) |
| 10 | OK (VPS) / partial NOT APPLICABLE (PC) | VPS: two launches via API → `launch_result ok`, `tmux ls` with `quorum-tox2…` and the session registered; afterwards they were closed via API. PC: `launch_result ok` and a `claude --permission-mode default` appeared in the folder, under `wt.exe → wsl.exe → bash -lic`. It was not registered because the new Windows Terminal tab does not inherit the isolated environment (`QUORUM_CONFIG_DIR`, `--plugin-dir`, `quorumd` outside the login PATH); with the real installation it would be. It was closed by killing the process, since being unregistered it had no card |
| 11 | OK (isolated instance) | The owner's ccapi was not running on the PC and the repo was not touched. An isolated instance was started: the `bin/ccapi start` line in a dedicated tmux, `CCAPI_PORT=18799`, temporary folder and env, plus `--plugin-dir ./mod`. `/health` answered ok; the session arrived with `role:service` and showed under "SERVICES" in the UI with the Composer disabled. A prompt via API produced only `info "Service session: Quorum does not control it"`; it was not applied |
| 12 | NOT APPLICABLE (pastor retired) | Detection removed |
| 13 | OK | `/clear` twice: `session_upsert previousId=<previous>`, `session_gone` for the old one, away moved to the new id, a single card. Ruling Q: with `claude --resume d273…` (old id of 7c9d…) both stayed alive and visible, with no `previousId` while the old one lives. Away on d273 from the UI: the permission card arrived on d273, not on 7c9d, and Deny was applied to d273's terminal |
| 14 | OK | `POST …/close` on the PC and on the VPS: `info "Closing the session from Quorum"` + `session_gone`; the `claude` process ended and the tmux window closed |
| UI | FAIL→FIXED (aa97309, 9914e93) | With agent-browser: pairing with the code, both machines, sessions and "Services". From the Composer, the prompt arrived and the reply was seen streaming, but an "Unexpected end of JSON input" alert appeared and the text was not cleared (202 with no body). Fixed: after redeploy, no alert and a clean Composer. Permission card answered by click (Allow on the VPS, Deny on the PC). The pairing screen said `quorum pair` and now says `quorum-hub pair` |

Summary: 9 OK (plus one, #10, OK on the VPS and partial NOT APPLICABLE on the PC), 4 FAIL→FIXED (steps 3, 6 and 9, and the UI) with 6 commits, 1 NOT APPLICABLE (step 12). Full log: `.superpowers/sdd/2026-11-22-quorum-plan1-foundation/e2e-report.md`.

Findings with no code change:

- When the VPS daemon was killed, the hub published a `session_gone` followed by a `session_upsert` about 170 ms later; the card flickers, but keeps state, away and asks.
- If the mod is edited while the session is open (`--plugin-dir` with hot reload), the reloaded mod starts with away/watching false and the hub does not resend presence until it changes. Only happens in development.
- After a hub restart, the daemon takes up to 30 s to come back because of its exponential backoff cap.
