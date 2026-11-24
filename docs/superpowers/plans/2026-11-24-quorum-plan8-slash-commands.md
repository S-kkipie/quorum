# Slash commands and quick model/effort — Implementation Plan (Plan 8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the composer's Haiku/Think-hard chips and the Timeline/Queue row with Claude Code's own slash commands: typing "/" in the composer opens an inline, filtered, grouped list of every command the session can run (built-ins, skills, plugin and MCP commands); model and effort sit in the session header as chips that open a bottom sheet; commands sent from the phone show as cards in the transcript.

**Design (approved in chat 2026-11-24, mockups A + B + C, "A with touches of B"):**
- **A — "/" typeahead.** Typing `/` at the start of the composer opens a list above it, filtered as you type (prefix match on name first, then substring in name/description). Groups in this order: **Session** (built-in commands), **Skills** (skill commands — source `user`, or plugin commands that are skills), **Plugins** (other plugin commands), **MCP**. Each row: icon tinted by group, `/name` in mono, one-line description, plugin name when known. Built-ins that only work in the terminal (interactive pickers/dialogs) are shown dimmed with a `terminal` tag and cannot be run from the phone. Keyboard: ↑/↓, Enter/Tab completes the name (adds a space for args), Esc closes. Tap = complete. Sending `/name args` runs the command instead of sending a prompt.
- **B — header chips.** Next to the account chip: `Opus 5.5 ▾` and `effort: high ▾`. Tap opens a bottom Sheet: model options (from the session's model config row options, with a short description) and an effort segmented control (low / medium / high / xhigh / max as the session supports). Choosing runs `/model <value>` / `/effort <value>` in the session. Values show the current state reported by the mod.
- **C — command cards.** A command run from a device shows in the transcript as a card: icon, `/name args`, `from phone`, status `queued` (Claude is working; it runs at turn end) / `done` / `failed: <reason>`, and the command's text output when there is one (collapsed beyond 6 lines).
- **Removed:** Haiku and Think-hard chips, the Timeline/Queue row and their sections (Queue/Timeline stay reachable as `/after` and `/timeline` in the list; their plugin_state/plugin routes stay for now but nothing in the UI uses them — delete dead UI code only).
- **Better than pastor:** no separate palette, no polling. The mod reports the command list and the model/effort choices once per session start and again only when they change (re-checked at turn end, compared by hash); the hub stores them; the app reads them from state instantly.

## Global Constraints
- All repo content in English; lucide icons, no emojis; no personal data (machines `vps-1`, `laptop`).
- Commits: author/committer `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- A device may run only a command present in that session's reported list and not marked terminal-only; args ≤ 2,000 chars, no newline/control chars (reuse the Plan 6 validator rules, generalised). Checked in the hub and again in the mod.
- Mod hooks stay within budget; `$.command.list()` / `$.config.list()` called defensively, never awaited inside a turn hook's critical path.
- Initial JS ≤ 655 kB; 320 px; touch targets ≥ 44 px.
- Tests: `go test ./...`, `claude plugin test mod`, `make typecheck`, `cd app && npx vitest run`, `npm run build`; proto via `make proto`.

## Review Focus
1. Typing `/` mid-sentence (not at the start) does not open the list and does not run a command.
2. A command that is interactive in the terminal (e.g. `/config`, `/resume`) cannot be run from the phone, and the UI says why.
3. Changing the model while Claude works: the card says queued, the header chip updates only when the mod reports the new model.
4. A session whose command list never arrived (older mod) still works: no "/" list (or an empty state "Update the Quorum plugin to see commands"), plain prompts still send.
5. A skill or plugin command added mid-session (plugin reload) appears in the list without reopening the app.

---

### Task 1: Mod reports commands, model and effort choices; runs any listed command

**Files:** `mod/src/commands.ts` (new), `mod/src/plugincmd.ts` (generalise), `mod/src/control.ts`, `mod/hooks/register.ts`, `internal/proto/proto.go` (+ `make proto`), mod tests. Plugin 0.2.0.

**Interfaces — produces:**
- `SessionCommand{Name, Description, Source ("builtin"|"plugin"|"user"|"mcp"), Plugin string, Group ("session"|"skill"|"plugin"|"mcp"), TerminalOnly bool}`; daemon→hub envelope `session_commands {session, commands: []SessionCommand, hash}` sent at session start and whenever the hash changes (re-checked at turn end, fire-and-forget).
- `SessionInfo.Effort string json:"effort"`, `SessionInfo.ModelOptions []ModelOption{Value, Label, Description}`, `SessionInfo.EffortOptions []string` (from `$.config.list()` rows for model/effort when present, else sensible defaults documented in code; current effort from the Stop hook input `effort.level` or the config row).
- `Command{type:"command", command, args}` → mod validates against its own current list (exists, not terminal-only, args rules) and runs `$.command.run({command, args})`; emits a `command` event `{id, name, args, origin:"device", status:"queued"|"done"|"failed", text?, error?}` (queued when a turn runs, done/failed when `run` settles; `text` capped at 8,000 chars).
- Terminal-only built-ins: a documented list in `commands.ts` of interactive built-ins (pickers/dialogs/TUI panes) — derive it from the mod API docs where possible; include at least config, resume, login, logout, permissions, agents, mcp, plugin, hooks, ide, memory, theme, vim, terminal-setup, statusline, export, doctor, bug/feedback, rewind; bare `after`/`timeline` with no args open panes → terminal-only only when args are empty (send as `-- ` for after is not needed here: `/after <text>` from the phone is a normal run).
- Skill detection: `Group = "skill"` when the command is a skill (check what CommandInfo/plugin manifests expose; if indistinguishable, `source==='user'` → skill and plugin commands from skill-only plugins → skill; document the rule).

- [ ] Tests first (mod): list mapping + grouping + terminal-only flags; hash change triggers one `session_commands`, unchanged does not; `command` device command: unknown name → `failed` event, terminal-only → `failed: This command only works in the terminal.`, valid → run called once, `queued` while a turn runs then `done` with text; args validation shared with Plan 6 rules. Model/effort options from mocked config rows; effort from Stop input.
- [ ] Implement; keep the Plan 6 `plugin` command type working (it becomes a thin alias of `command`). Commit `mod: report slash commands, model and effort; run commands from devices`.

### Task 2: Hub stores commands; device route to run a command

**Files:** `internal/hub/store` (table `session_commands(session_id PRIMARY KEY, hash, commands JSON, at)`), `internal/hub/machines.go` (`session_commands` envelope: owned sessions only, store, publish `session_commands` to apps only when the hash changed), `internal/hub/appapi.go` (`GET /api/sessions/{id}/commands`, `POST /api/sessions/{id}/command {command, args}` — validate against the stored list: exists, not terminal-only, args rules → forward `Command{type:"command"}`; 400 with English error otherwise; 409 if the session is closed/offline), app `lib/api.ts` (`listCommands`, `runCommand`), `lib/store.ts` (`commands[session]`), tests.

- [ ] Tests first: store round-trip; publish only on hash change; route validation (unknown, terminal-only, newline args, ok → command forwarded to the machine); non-owned session's envelope ignored. Commit `hub: session commands and the command route`.

### Task 3: App — "/" typeahead, header model/effort sheet, command cards; remove old UI

**Files:** `app/src/components/SlashMenu.tsx` (new), `app/src/components/ModelEffortSheet.tsx` (new), `app/src/components/Composer.tsx`, `app/src/screens/Session.tsx`, `app/src/components/Transcript.tsx` (+ `lib/timeline.ts` for the `command` event item), remove `QueueSection`/`TimelineSection`/chips UI and their tests (keep `lib/afterQueue.ts`/`lib/timemachine.ts` only if still imported; otherwise delete), `app/src/dev/fixtures.ts` (commands list with every group, terminal-only rows, long names/descriptions; model/effort options), tests.

- [ ] SlashMenu: opens only when the composer text starts with `/` and the caret is in the first token; filter + groups + keyboard (↑ ↓ Enter Tab Esc) + tap; terminal-only rows dimmed, tag `terminal`, not selectable (tap shows `Only in the terminal`); empty list → `No matching commands`; no list reported → `Update the Quorum plugin on this machine to see commands`. Max height 50 % of the viewport, scrolls.
- [ ] Sending text that starts with `/<listed name>` (+ optional args) calls `runCommand` instead of `sendPrompt`, clears the draft on success, keeps it on failure with the error; text starting with `/` that is not a listed command shows `Unknown command` and sends nothing (owner can prefix a space to send literal text — show that hint).
- [ ] Header chips (B): `<model label> ▾` and `effort: <level> ▾` after the account chip; tap → Sheet (side bottom) with model options (current checked) and effort segmented control; choosing runs `/model <value>` or `/effort <value>`; while the command is queued show a small spinner on the chip; chip text follows `SessionInfo.model`/`effort`. Hidden when the session has no options (older mod).
- [ ] Command cards (C) in the transcript for `command` events, per the design; long output collapsed beyond 6 lines with `Show more`.
- [ ] Remove chips + Timeline/Queue UI and tests; composer placeholder `Type a message or / for commands`.
- [ ] Tests: menu opens/filters/groups/keyboard/tap; mid-sentence `/` doesn't open; terminal-only can't run; unknown command not sent; send runs command; sheet runs /model and /effort; chip shows queued; cards render statuses and collapse; old-mod empty states. Build size reported. Commit `app: slash commands, model and effort sheet, command cards`.
