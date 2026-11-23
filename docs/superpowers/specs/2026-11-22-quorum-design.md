# Quorum — design

Date: 2026-11-22 · Status: draft for approval · Replaces pastor (v1)

## 1. What it is and why

Quorum is the **personal command center** of one person who has ~4 jobs and, in one of them, maintains many projects. The work is done by Claude Code sessions spread over several machines (dedicated VPSs, a server, a laptop, a PC with WSL), sometimes several sessions of the same project on different machines.

**Today's pain is not managing sessions, it is managing projects.** Each project has its own context, its features and its own ticket system, and to know how something is going you have to ask: "what state is that ticket in?", "how is the project going?". Quorum has to have that **already assembled**, without asking, and also allow **directing the sessions remotely** from the phone or the computer.

pastor (github.com/S-kkipie/pastor) was v1: remote control of Claude Code from the phone (mod + bridge + hub + PWA + WhatsApp agent). It worked, but it was written in 4 days and is being redone from scratch with a different central unit (the project, not the session) and a clean architecture.

### Who uses it
Only the owner. Nobody else (clients, bosses, team) sees anything. There are no users, roles or multi-tenancy.

## 2. Goals

1. **Projects first.** Hierarchy: Workspace → Project → (Tickets, Sessions). The main board shows all projects with their progress and a short summary of "where it stands and what is blocking it".
2. **Status without asking.** Each ticket shows the status from its ticket system combined with that of the session working on it (working / needs you / finished / waiting for review). Each project has a 1–2 line summary that updates itself.
3. **Generic ticket systems.** A ticket model of our own and connectors. Connecting a custom ticket system must be easy (minutes, or ask a Claude session to do it).
4. **Own remote control** (without Claude's native Remote Control): see all sessions on all machines, open new sessions on any machine/project (also from a ticket), send prompts (now / queued / interrupt), answer permissions and `AskUserQuestion`, close sessions.
5. **Live chat** with each session: streaming text, tools, subagents and background tasks.
6. **Remote terminal** on any machine.
7. **Communication between sessions** across machines, with the same shape as Claude Code's native messaging.
8. **Phone and computer alike:** an adaptive web app — wide multi-panel view on desktop, thumb view on the phone, installable as a PWA.
9. **Lightweight:** the always-running processes (hub and per-machine agent) must use little RAM and build without blowing up memory.

## 2b. Delivery in stages (decided by the owner)

- **Stage 1 — the core:** workspaces, projects, tickets (GitHub, Paperclip and executable connectors), status and summaries, sessions from all machines, open/close sessions, live chat, prompts (now/queue/interrupt), permissions and questions. whoas and ccapi compatibility (§14b) from this stage.
- **Stage 2:** remote terminal and communication between sessions on different machines.
- **Afterwards:** the roadmap (§16), starting with the Tauri apps.

**Coexistence with pastor:** pastor is retired; there is no coexistence.

## 3. Non-goals (for now, they go to the roadmap)

- Git in the app (per-file diff, commit, push/pull, PR).
- File explorer, web in development over the tailnet, live browser.
- Scheduled routines.
- General WhatsApp agent.
- Native apps (desktop and APK with Tauri): they come right after the first version (see §7.2b).

## 4. Anti-goals (if this happens, it failed even if it "works")

- **Having to keep asking** the sessions how each thing is going.
- **Being an autonomous agent system** (Paperclip style: org chart, heartbeats, agents that run on their own). You direct the sessions; Quorum informs and facilitates.
- **Scraping the terminal** (tmux/screen scraping Collie style). Real events are used.
- **Depending on the native Remote Control** or on Anthropic's servers for control.
- **A monolith** like v1's 136 KB `bridge.mjs`.
- **Polling** as the main mechanism (v1 polled every 1 s / 250 ms).
- Mascots, animations and decorations that do not serve the problem (Clawd stays out).

## 5. Constraints

- A single person, everything inside the tailnet (Tailscale/Headscale). Never exposed to the internet (`funnel` forbidden).
- Machines: Linux (VPS, server), WSL2 and native Windows (launch sessions in Windows Terminal), possibly macOS. VPSs have no screen: sessions in tmux.
- Claude Code with a subscription; the **quota is shared** across everything (the owner's other services). What Quorum spends on the model (summaries) must be minimal and with Haiku.
- Claude Code's mod API is early-access and may change between versions.
- Limited RAM on the machines (in particular the small VPSs and the PC with WSL).

## 6. Approaches considered

| Approach | How it connects to each session | Pros | Cons |
|---|---|---|---|
| **A. Mod + per-machine agent + hub** ✅ | A mod inside each session emits real events and receives prompts/decisions | Sees and controls **any** session, even those opened by hand; the same session can be followed on the PC and on the phone at once | Depends on the mod API (early-access) |
| B. SDK / headless (`stream-json`) | The daemon launches and owns the processes | More stable API, full control | Sessions opened by hand do not exist for Quorum; the same session's terminal cannot be used at the same time. Goes against how the owner works |
| C. Read the terminal (tmux) | Scraping | — | Fragile, no real events; discarded since v1 |

**Chosen: A.** To bound the risk of the mod API, the mod is a small, dumb package (translates events ↔ protocol) and all the logic lives in the agent and the hub.

## 7. Architecture

```
 📱 / 💻  Quorum app (PWA, React)
        │  WebSocket + HTTP (tailnet)
        ▼
 ┌──────────────────────┐      connectors ──▶ GitHub · Paperclip · custom ticket systems
 │  quorum-hub (Go)    │      summarizer ──▶ claude -p (Haiku)
 │  SQLite · serves app │
 └──────────────────────┘
        ▲  WebSocket (each machine connects outbound to the hub)
        │
 ┌──────┴──────────┐   ┌─────────────────┐   ┌─────────────────┐
 │ quorumd (Go)   │   │ quorumd · VPS2 │   │ quorumd · PC   │
 │ VPS1            │   │                 │   │ (WSL / Windows) │
 └──────┬──────────┘   └─────────────────┘   └─────────────────┘
        │ local socket (unix / named pipe)
   ┌────┴─────┐
   │ session  │ … each Claude Code session loads quorum-mod (TS)
   │ + mod    │
   └──────────┘
```

### 7.1 Pieces

| Piece | Language | Where it runs | Responsibility |
|---|---|---|---|
| `quorum-mod` | TypeScript (Claude Code requires it) | Inside each session | Emit session events (registration, prompts, streaming text, tools, permissions, questions, subagents, background tasks, context usage, end of turn, close). Receive and apply: prompts (now/queue/interrupt), permission/question decisions, interrupt, close, messages from other sessions. No business logic. |
| `quorumd` | Go | One process per machine (systemd user service / Windows task) | Groups the local sessions, keeps a persistent outbound connection to the hub, launches sessions (tmux / Windows Terminal / WSL), provides PTYs for the remote terminal, delivers messages between sessions, reports local repos/projects and machine state. Reconnects by itself. |
| `quorum-hub` | Go | Always-on VPS | Source of truth: workspaces, projects, tickets, sessions, machines, devices. Ticket system connectors, summarizer, device pairing, message routing between machines, serves the app and its API. |
| `app` | React + Vite + Tailwind (TS) | Browser (PWA) | Adaptive desktop/phone UI. Compiled and embedded in the hub binary. |
| `protocol` | Shared schema | — | Single definition of mod↔daemon↔hub↔app messages. Go and TS types are generated from it (avoids v1's duplicated contracts). |

### 7.2 Why Go for hub and daemon (design author's decision)
The owner asked for performance and being friendly to RAM, also when compiling; he mentioned Rust or Go. Go: daemons of ~10–30 MB resident, fast and low-memory compilation, a single static binary, trivial cross-compile to linux/windows/darwin. Rust would perform somewhat better but its builds are heavy on RAM. SQLite in Go **without cgo** (e.g. `modernc.org/sqlite`) so cross-compiling stays trivial.

### 7.2b Interface: one frontend, three outputs (design author's decision, at the owner's request)
The owner suggested Tauri to get web, desktop and APK from one codebase. Decision:
- **A single React frontend** that the hub serves as web/PWA (first version).
- **Tauri v2 as a thin wrapper** of the same frontend for desktop (Windows/macOS/Linux) and Android: it brings native notifications, tray and APK. No business logic in Rust.
- **Tauri builds run in CI (GitHub Actions)**, not on the owner's machines: Rust compilation is heavy on RAM.
- Requirement from day one: the frontend does not assume it runs on the same origin as the hub (the hub URL is configurable and stored on the device) and does not use APIs that fail in a Tauri webview. Native capabilities are accessed behind a small layer (`native`) with a web implementation by default.

### 7.3 Connections
- **mod → daemon:** local socket (unix socket on Linux/mac/WSL, named pipe on Windows), restricted to the OS user. If the daemon is not running, the mod starts it (as v1 did with the bridge).
- **daemon → hub:** outbound WebSocket over the tailnet, authenticated with a machine token obtained when linking (`quorumd link <hub> <code>`). Since the connection is outbound, the hub does not need to reach each machine.
- **app → hub:** HTTP + WebSocket, with a per-device token obtained by pairing with a single-use code.
- **Everything is push.** No polling except ticket system sync (see §9).

### 7.4 Operation without the hub
If the hub goes down, sessions keep working normally (the mod never blocks Claude Code waiting for the daemon or the hub). When the hub comes back, the daemons reconnect and resend the current state.

## 8. Data model (hub)

- **Workspace:** name, color. Groups projects. E.g. "Client X", "ACME".
- **Project:** workspace, name, remote repo (if any), ticket system connector + its configuration, current summary, progress.
- **Checkout:** a project on a specific machine (machine, path, current branch). A project can have several checkouts on several machines. Sessions are linked to their project through the checkout where they run (git root path → checkout → project). Checkouts are discovered on their own (each daemon reports the repos where there were sessions) and assigned to a project with one tap (or automatically by git remote URL).
- **Ticket:** project, external id, title, status (normalized: `todo | in_progress | in_review | done | blocked` + the original status), description, assignee, recent comments, URL, updated.
- **Session:** machine, checkout, Claude Code session id, name, live state (`working | needs_you | waiting | idle | closed`), linked ticket (optional), model, context usage, last turn.
- **Machine:** name, OS, online/offline, daemon version.
- **Device:** paired phone/browser, token, last use.
- **Session event:** the history that feeds the chat (text, tools, permissions, etc.). The real transcript remains Claude Code's; the hub stores what is needed to display and summarize, with limited retention.

## 9. Ticket systems

### 9.1 Connectors
Common interface: `list(project, since)`, `get(id)`, `change_status(id, status)`, `comment(id, text)`, and a map of external → normalized statuses.

- **GitHub Issues** (included): uses `gh` / the GitHub API with the existing login.
- **Paperclip** (included): REST API of the instance on the VPS (`/api/companies/{id}/issues`), to see ACME's things as one more project without migrating anything.
- **Executable connector (generic):** any program that speaks JSON over stdin/stdout with the interface above. It is the path for custom ticket systems: a 50-line script in whatever language, or a Claude session is asked to write it from the ticket system's docs. It lives in the hub, configured per project.
- Jira/Linear remain as example executable connectors or integrated later.

### 9.2 Sync
- Poll per project every N minutes (configurable, default 5) plus manual refresh. Webhooks later.
- Quorum is **not** the owner of the tickets: the ticket system rules. Quorum only writes when the owner asks (or a session, on finishing a ticket, comments / moves status — optional per project).
- **One ticket, one active session at a time** (idea taken from Paperclip): when opening a session from a ticket that already has a live session, going to that one is offered instead of opening another.

### 9.2b Linking session ↔ ticket (design author's decision)
- If the session was opened from a ticket, it is linked.
- If it was opened by hand, Quorum **suggests** the ticket by branch name (`feat/41-…`, `GH-41`) or commit messages, and the owner confirms with a tap in the app. It is never linked silently.
- Claude can also declare it with a mod command (e.g. `/quorum ticket 41`).
- The owner can link or unlink by hand at any time.

### 9.2c Writing to the ticket system (design author's decision)
In the first version Quorum **never writes on its own** to a ticket system: it proposes the comment or status change (e.g. when a linked session finishes) and the owner approves it in the app. Reason: clients' ticket systems are visible to third parties.
"Waiting for your review" = the ticket system says `in_review`, **or** the linked session finished its turn and the owner marked it as ready.

### 9.2d Where workspaces and projects come from (design author's decision)
Quorum suggests projects from the repos where there were sessions (by git remote URL) and from what the connectors expose (GitHub repos, Paperclip companies). The owner accepts the suggestion or creates the project by hand. Workspaces are created by hand (there are few).

### 9.3 Open a session from a ticket
Pick machine + checkout (or clone if that machine does not have the repo — roadmap), and the session starts with the ticket as the first message (title, description, relevant comments, URL). The owner keeps directing from there.

## 10. Status and summaries

- **Per-turn summary:** it is Claude's last message of the turn, trimmed. It spends no model. (Design author's decision.)
- **Displayed ticket status** = normalized ticket system status + status of the linked session (if any). E.g.: "in progress · session vps-2 · working for 12 min", "ready, waiting for your review".
- **Project summary:** 1–2 lines ("where it stands and what is blocking it") generated by the hub with **Haiku** (through ccapi if available, otherwise `claude -p`; see §14b), from: tickets and their changes, end-of-turn summaries of the project's sessions, recent activity. Regenerated with debounce (e.g. at most every 30 min per project and only if there were changes). "No activity since X" spends no model.
- **Progress:** tickets done / total of the period or active milestone (defined by the connector; if there is no milestone, open vs. recently closed).

## 11. Remote control and chat

Inherits what worked in v1, reimplemented:
- **Session panel** inside each project and a global per-machine view. Live states; the order does not jump when the state changes.
- **New session:** machine + checkout (or folder), optionally continue the last conversation, permission mode.
- **Prompts while working:** send now (same turn), queue (when it finishes), interrupt and send.
- **Permissions and questions:** routed according to where the owner is (v1's hybrid logic: if the session is open on a device or one was used recently, it goes to the device; if he typed in the terminal recently, it goes to the terminal). With an explicit "away" mode. With no answer on the device in X minutes, it is resolved in the terminal.
- **Live chat:** streaming text, summarized tools with detail on tap, task plan, context usage, per-turn summary, subagents and background tasks (view, write to them, stop them).
- **Close session** (like `/exit`, first stopping background tasks).
- **Multi-session view** on desktop (tiled, like v1's Mission control).
- **Previous history:** when opening a session that started before the hub saw it (hub down, or session from before installing Quorum), the daemon reconstructs the chat by reading Claude Code's transcript (as v1 did). The parser is isolated because the format is internal and may change. (Design author's decision.)
- **PC with WSL:** Windows and WSL2 are different environments (a WSL unix socket does not talk to a Windows named pipe), so each runs its own `quorumd`. In the app they are grouped as **one PC with two environments**. (Design author's decision.)
- **Per-platform launchers** isolated in a daemon module: tmux (headless servers, with `bash -lc` for PATH/nvm), Windows Terminal (`wt.exe`, with `;` escaping), WSL from Windows.

## 12. Remote terminal
A real PTY through the daemon (not loose commands): `xterm.js` in the app ↔ WebSocket ↔ hub ↔ daemon ↔ PTY. Several terminals per machine; it can be opened in a checkout's folder.

## 13. Communication between sessions
- **Same machine:** Claude Code's native one (per-session sockets, `SendMessage`/`ListAgents`) works on its own; Quorum does not touch it.
- **Across machines:** the native one only works via Remote Control, which is not used. The mod exposes the sessions of other machines as destinations and delivers their messages as messages from another session (wrapper clearly marked as "not your user", as v1 did with `<pastor-message>`). The hub routes daemon→daemon. With an anti-loop brake.
- Messages never approve permissions or run commands (same rule as the native one).

## 14. Security
Quorum gives full remote control of the machines by design.
- Hub and daemons listen only on loopback/tailnet IP; publish with `tailscale serve`, never `funnel`.
- Devices: pairing with a single-use code → own token revocable from the app.
- Machines: link with a single-use code → revocable machine token.
- Local mod↔daemon socket restricted to the OS user.
- Connector secrets (ticket system tokens) stored in the hub, never sent to the app.

## 14b. Full compatibility with whoas and ccapi (owner's requirement)

### whoas (per-project identities)
whoas stores a sealed token per `provider@alias` and picks the alias per project with `.whoas.yaml` + profiles; the shims make `claude`, `gh`, etc. go through whoas.
- **Launch sessions respecting whoas:** the daemon launches `claude` in a login shell of the checkout folder, so the whoas shims are on the PATH and apply the repo's `.whoas.yaml` (the right Claude, gh, etc. account per project). It never invokes an absolute binary that skips the shim.
- **Connector credentials via whoas:** each Quorum Workspace can have an associated whoas profile. Connectors that use CLIs (GitHub through `gh`) run through whoas with that profile (e.g. `WHOAS_PROFILE` / checkout context), so each workspace uses its own account. The MCPs that whoas exposes (`whoas mcp proxy mcp-linear@…`) can serve as a connector. Quorum **neither stores nor sees secrets** that whoas already handles; it only stores its own secrets for ticket systems whoas does not cover.
- **Show the identity:** the app shows which account each session/project uses (what `whoas which claude` / `gh` would say in that checkout), to notice instantly if a session runs with the wrong account.
- Never do `/login` or touch global logins; follow the whoas-setup skill's rules.

### ccapi (the subscription as an Anthropic-compatible API)
ccapi runs a Claude Code session in tmux with its own mods and serves `/v1/messages` on `127.0.0.1:18787`; each request is a subagent of that session.
- **Coexistence:** the Quorum mod will also be loaded in ccapi's session. Quorum must **detect the ccapi session** (its mods / its folder / its tmux session `ccapi`) and show it as a machine **service** (state, queue, usage), not a work session: no prompt injection, no answering permissions, no notifications, and without listing its subagents one by one.
- **Using ccapi:** the hub's summarizer talks to a configurable Anthropic-compatible endpoint; if a ccapi is reachable (local or over the tailnet/tunnel), it uses it with Haiku; otherwise it falls back to `claude -p`. That way Quorum does not launch a Claude process per summary.
- Any other Quorum consumer that needs a model (e.g. the future agent) uses the same path.

## 15. Lessons from v1 that apply
- No compiled artifacts in git (v1 versioned 13 MB of `bridge/web`). The app is embedded in the binary at build time.
- Tests from the start in daemon and hub (v1 had a single test in the bridge).
- A single place for the protocol types.
- A single version for all the pieces; the daemon warns if the mod or the hub do not match.

## 16. Roadmap (after the first version)
1. Git: status, per-file diff, commit, push/pull, PR.
2. File explorer and "mention in the message".
3. Push notifications (web push / ntfy) when a session needs you.
4. Scheduled routines.
5. Web in development over the tailnet and local HTML pages.
6. Live browser (CDP).
7. General agent (WhatsApp) that answers with the status already assembled.
8. Native apps with Tauri (desktop + APK), built in CI.
9. Ticket system webhooks; clone a repo on a machine from the app.

## 17. Left to the builder's judgment
- Shared schema format and the type generation tool (JSON Schema, protobuf, or Go types as the source).
- Monorepo structure, concrete Go libraries (WebSocket, PTY, router), and UI components (may reuse v1's AI Elements / shadcn).
- Exact event retention and summary size.
- How the daemon is installed and updated on each machine (script, self-updating binary).
- Visual details, as long as desktop shows several panels and the phone is usable one-handed.

## 18. Changes decided after Stage 1 (2026-11-22)

- **No modes.** The "Away" mode, presence (`watch`/`away`) and all routing by where the owner is disappear. Everything is controlled from everywhere always: each permission and each question appears **at once** in the terminal and on all devices; the first answer wins and the others are withdrawn.
- **Permissions with their own dialog (decided by the owner).** Claude Code does not let its native permission dialog be answered from outside. Quorum replaces it: when the engine would ask for permission, the mod shows in the terminal its own dialog (Allow / Deny, via `$.ui.ask`) and the same card on the devices, and runs the race. Accepted costs: the native dialog's "always allow" is lost, and if a device wins, the terminal dialog stays open until it is closed (its late answer is ignored). Wait limit: whatever the engine allows (~19 min with `quorumd hold`); once expired, it denies with a reason.
- **Recap as session name.** Each session is shown with a short recap of what it is working on (≤ 60 characters, English), generated by the mod with Haiku (`$.model.complete`) after the first prompt and at the end of turns (at most every 5 min and only if there were new turns). If there is no recap, the folder. `/rename` (a name set by the owner) takes priority if the mod can read it.
- **Pastor retired**: no coexistence and no "passive" sessions.
