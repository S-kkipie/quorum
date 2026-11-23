# Quorum — sessions and terminal on herdr (phone first)

Date: 2026-11-23 · Status: draft for approval · Complements the general design (`2026-11-22-quorum-design.md`)

## 1. What and why

The owner works every day inside **herdr** (terminal multiplexer for agents: persistent workspaces, tabs and panes, with Claude state detection). Quorum today launches sessions with tmux / Windows Terminal and has no remote terminal. The owner wants, **phone first**:

1. **Open a new Claude Code session directly in the project he is in**, on any machine (especially servers), with whoas and with `--dangerously-skip-permissions` one tap away. It is always "New session": no "feature" or "bug"; Claude inside the session handles branches and the rest.
2. **Resume a previous conversation** of the project.
3. **Use the servers' real terminals** from the phone.

All of that must live inside herdr: what is opened from the phone appears in the owner's herdr and vice versa.

## 2. Goals

- **G1. New session in one tap** from a project's screen (or from a session of that project), with the options remembered.
- **G2. Resume conversation**: list of the project's previous conversations on that machine; one tap resumes it (`claude --resume <id>`).
- **G3. Sessions are born in herdr**: a new tab of the project's herdr workspace on that machine, with Claude started by herdr (`herdr agent start --kind claude`), through a login shell (whoas).
- **G4. Real terminal** on the phone: a herdr pane in the project folder, seen live (colors) with keyboard and special keys; persistent.
- **G5. On launch, the phone takes you to the new session** (not waiting for it to show up in the list).
- **G6.** herdr installed and running as a service on every Quorum machine (starting with the arm64 Linux server and the PC with WSL).

## 3. Non-goals

- Choosing model, session name or worktree on launch (Claude takes care of it; can be added later).
- Cloning repos / new folders from the phone (pastor did it; left for later).
- File explorer, git in the app.
- Replacing herdr's TUI on desktop.

## 4. Anti-goals

- Opening a session from the phone requiring more than 2 taps in the normal case.
- A session launched from Quorum **not** appearing in the owner's herdr (or appearing in a weird place).
- A "terminal" that only runs commands one at a time (pastor's mistake).
- Skipping whoas (launching `claude` by absolute path or without a login shell).
- Breaking or reorganizing the workspaces the owner already has open in herdr.

## 5. Constraints

- herdr 0.9.5 (protocol 22) on the PC with WSL; the arm64 Linux server does not have it yet. herdr exposes an API over a socket (`$XDG_RUNTIME_DIR`/`~/.config/herdr/herdr.sock`) and a CLI with JSON output: `workspace list/create`, `tab create`, `pane split/read/send-keys/send-text/close`, `agent start/list/get/wait`, `events.subscribe` (events `pane.updated`, `pane.agent_status_changed`, `pane.created/closed`, …), `pane.read --format ansi --source visible|recent`.
- `herdr agent start` requires a pane at the shell prompt and returns when Claude is ready; claude's arguments go after `--`.
- The mod keeps registering the session in Quorum as today; inside a herdr pane it has `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`.
- Machines without herdr must keep working with the current launcher (tmux / wt.exe).
- Phone first: screens designed for one hand; desktop uses the same with more space.

## 6. Approaches (A chosen)

| Approach | Summary | Why not / why |
|---|---|---|
| **A. quorumd drives each machine's local herdr** ✅ | Each `quorumd` talks to its herdr over socket/CLI; sessions = tabs in the project's workspace; terminal = herdr pane mirrored to the phone | A single experience on all machines; what the phone does appears in herdr |
| B. herdr only where it already exists, tmux on servers | Less installation | Two experiences; no real terminal on servers |
| C. herdr's SSH remote mode | herdr-to-herdr | Does not work for a phone |

## 7. Design

### 7.1 Quorum ↔ herdr mapping (per machine)
- **Project/checkout → herdr workspace**: the daemon looks for a workspace whose root cwd is the checkout's `root` (via `workspace list` + `pane list`/cwd); if there is none, it creates one (`workspace create --cwd <root>`, label = the project's name in Quorum or the basename). It never renames or closes existing workspaces.
- **Session → new tab** in that workspace (`tab create`), with its root pane in `<root>`; there `herdr agent start q<shortid> --kind claude --pane <pane> -- <flags>`.
- **Terminal → "terminal" tab** in that workspace (one per project and machine, reused; a "New terminal" button creates another), with a login shell.
- The mod reports in `SessionInfo` its `herdrPane` (from `HERDR_PANE_ID`) and `herdrWorkspace`; that way the hub knows which herdr pane corresponds to each session (for "open terminal here", and to tie the launch).

### 7.2 Launch (New session / Resume)
- claude flags: `--dangerously-skip-permissions` if "Skip permissions", otherwise `--permission-mode <mode>`; `--resume <id>` to resume. Always through a login shell in the pane (the pane is already a herdr login shell; verify that herdr starts login shells — if not, `agent start` is done after `exec bash -l` in the pane). whoas applies through the PATH.
- Trusting the folder: like pastor, the daemon marks the folder as trusted in `~/.claude.json` before launching (atomic write), so the trust dialog does not appear. Option on by default.
- Immediate response to the phone with `reqId`; when the new session's mod registers with that `herdrPane`, the hub links it and the app **navigates by itself** to the session ("Starting…" screen meanwhile; 60 s timeout with a clear error and a "View in terminal" button).
- Machines without herdr: the current launcher (tmux/wt) as a fallback, same flow in the app.

### 7.3 Previous conversations (Resume)
- The daemon lists `~/.claude/projects/<encoded cwd>/*.jsonl` of the `root`: id, title (Claude's summary if there is one, otherwise the user's first prompt, trimmed), first prompt, messages, last activity; it marks the ones that are open now (live session with that id). Max 60, most recent first. Hub endpoint that asks the machine for the list (`GET /api/machines/{m}/conversations?root=`).
- Tapping an open one → go to that session; tapping a closed one → resume in a new tab.

### 7.4 Terminal on the phone
- The daemon subscribes to the local herdr's `events.subscribe` and, for the panes a device is watching, sends **screen snapshots** (`pane.read --source visible --format ansi`) when there is `pane.updated`, at most ~8 per second, over the hub channel (`term_frame {machine, pane, cols, rows, ansi}`); only while someone is watching.
- Input: text (`pane.send_text`) and keys (`pane.send_keys`: Esc, Tab, Enter, Ctrl-C, Ctrl-D, Ctrl-L, arrows, PgUp/PgDn).
- The app draws with xterm.js (or a read-only ANSI render) fitted to the phone's width (a font that fits the pane's width; horizontal scroll if it does not).
- Persistent: closing the view does not close the pane. "Close terminal" closes it (`pane close`) with confirmation.

### 7.5 Phone screens

Project (when entering from the board):
```
← My project                      Workspace
┌───────────────────────────────────────┐
│  ▶ New session           vps-1 ▾      │  ← big button; machine chip
│  ⛔ Skip permissions  ✓                │  ← remembered per project
└───────────────────────────────────────┘
  ⌨ Terminal                              ← opens/reuses the project's terminal
OPEN SESSIONS
  ● Fixing the login with OAuth   working
CONVERSATIONS
  Checkout refactor   2 h ago · 48 msgs
  Tweak header styles   yesterday · 12 msgs
  …                                (search if > 6)
TICKETS · SUMMARY · PROGRESS (Plan 2's content, below)
```

Terminal:
```
← Terminal · project · vps-1          ⋯
┌───────────────────────────────────────┐
│ user@vps:~/project$ git status        │  live screen with colors
│ On branch main …                      │
└───────────────────────────────────────┘
[Esc][Tab][Ctrl-C][↑][↓][←][→][Ctrl-D]
[ type and Enter…                   ⏎ ]
```

New session starting: the app moves to the session screen with "Starting Claude on vps-1…" and the chat appears when it arrives.

### 7.6 herdr installation
- Script `scripts/install-herdr.sh`: installs herdr's official binary (linux amd64/arm64) in `~/.local/bin` if missing, installs its Claude integration (`herdr integration install claude` or equivalent, for agent states), and creates a systemd user service `herdr-server` (`herdr server`, default session). On the owner's PC herdr already runs: its server is not touched.
- `quorumd` detects herdr (binary + socket); if it is not there, it uses the fallback launcher and the app shows "Terminal not available on this machine (herdr missing)".

## 7.7 Decisions after the builder's review (design author's decisions; the owner can correct them)
- **Terminal authorization:** any paired device can open terminals and send keys, just as it can today send prompts and approve permissions: Quorum has a single owner and pairing already equals full control (§14 of the general design). A **log** is added in the hub (who opened which terminal and when) and each machine has a `terminal: true|false` switch in `quorumd`'s config (true by default).
- **Which herdr to use:** the `default` herdr session of each machine (the one the owner uses; on this PC it is `~/.config/herdr/herdr.sock`). Optional `herdrSession` config in `quorumd` to use another.
- **Tying the launch to the session:** by the herdr pane id: the daemon remembers `{reqId → pane}` when creating the tab; the mod reports `HERDR_PANE_ID`; the first registration in that pane within 60 s is linked (and if it is "Resume", the app navigates to whatever registers in that pane, whatever its id). "Open now" in the conversation list compares by Claude session id (`--resume` keeps the id; if Claude changes it, the mod already reports `previousId`).
- **Ambiguous workspace:** 1) the workspace Quorum used before for that root on that machine (the daemon remembers it by workspace id while it exists); 2) otherwise, the workspace whose root pane has that cwd and is focused or was used most recently; 3) otherwise, a new one. Several checkouts of the same project on a machine: the chosen checkout is used (that of the session it is launched from or the last used one).
- **Pane size on the phone:** the phone **never** resizes panes (it does not break the owner's layout). It is seen at the pane's real size with the font fitted to the width, pinch zoom and horizontal scroll; history is read with `--source recent` (PgUp/PgDn scroll the view in the app, they do not send keys). The terminals Quorum opens are their own tabs, so their size is herdr's.
- **Screen snapshot transport:** over the existing daemon↔hub↔app WebSocket, `term_frame` message, **only the latest snapshot** per pane (coalescing; never more than one queued), ≤ 8/s, ≤ 256 KiB per snapshot.
- **"Skip permissions" by default:** on the first time (owner's request). If the machine runs as root, Claude rejects that flag: the daemon detects it and the app shows it disabled with the reason. Today the machines use normal (non-root) users.
- **Platforms with herdr:** Linux amd64/arm64 and WSL (herdr inside WSL, as on this PC). macOS and native Windows use the fallback launcher for now.

## 8. Left to the builder
- herdr client: CLI with JSON vs. direct socket (prefer CLI except for `events.subscribe`).
- Details of the terminal render on the phone (xterm.js vs. own render), font size and snapshot rate within the limit.
- How to detect the project's workspace (by the root pane's cwd or `workspace report-metadata` metadata).
- Cleanup of finished sessions' tabs (leave to herdr/the owner; Quorum does not close tabs except "Close session").
