# Spike: running another plugin's command from the Quorum mod

Date: 2026-11-23. Claude Code v2.1.331, better-claude `after` 0.2.0 and `time-machine` 0.1.3.

## Question

When a device sends `Command{type:'plugin', command, args}`, can the Quorum mod run
`/after`, `/before` or `/timeline` in its own session, and do the other plugins' store
keys use the same session id Quorum reports?

## Setup

- Scratch git repo in a temp folder, interactive `claude` in a detached tmux session on its
  own socket (`tmux -L <spike socket>`), launched through a login shell.
- Working-tree mod loaded with `--plugin-dir ./mod`; the installed `quorum@quorum` disabled
  for that run only with `--settings '{"enabledPlugins":{"quorum@quorum":false}}'` (a flag
  settings layer: no settings file was changed). A fixed `--session-id` was passed.
- Trigger: a temporary, env-gated slash command registered only by the working-tree mod
  (removed before commit). It returned at once and, 500 ms later, called
  `control.handle({type:'plugin', command, args})` with the `$` captured in
  `session.start`, the same way a WebSocket command reaches `control.handle` (outside any
  hook). The real hub path was not used (it needs device credentials).
- Store files read: `<configDir>/plugins/store/after_better-claude-*.json` (key
  `queue:<sid>`) and `time-machine_better-claude-*.json` (key `session:<sid>`).

## Mechanism

| Mechanism | Result |
| --- | --- |
| `$.command.run({ command, args })` | Works. Reaches the plugin's `command.run` hook; the transcript shows `/after` with the plugin's card, as if typed. |
| `$.prompt.submit({ text: '/after …', asUser: true })` | Refused by a host check: "prompt.submit: submits a prompt to the model; a text beginning with / would run a command as the user; run one with $.command.run({ command })". Nothing runs. |

`runPluginCommand` therefore uses `$.command.run` only.

## Findings

(a) **`/after <task>` lands in `queue:<sid>`.** Idle: `/after pause`, then
`/after create a file b.txt …` → `items: [{id:1, text:"create a file b.txt …"}]`,
`paused: true` under `queue:<sid>` within a second. `/after resume` started it as a turn.

(b) **Mid-turn.** `/after` is `immediate: true`, but `$.command.run` is queued until the
session is idle: sent during a turn it showed as "Prompt from the quorum plugin
`/after …`" and the store did not change until the turn ended. At turn end it ran first
(item appended, `running` still the finished task), then After started it as the next
task. Order is preserved (appended at the end of the queue); the only cost is that the
queue shown on the device lags until the current turn ends. The app should say the
command is queued ("runs when the current turn ends") rather than expect an immediate
store change.

(c) **`/timeline undo` moves `cursor`.** With states `[1,2,3]` and `cursor: 3`,
`/timeline undo` → `cursor: 2` in `session:<sid>` and the file created in state 3 was
removed from the working tree. `/timeline 3` after `/clear` answered "there is no #3"
(the timeline restarts with the conversation).

(d) **Session ids match.**
- Fresh session: `$.session.id()` = Quorum's link session id = `--session-id` =
  `queue:<sid>` = `session:<sid>`.
- After `/clear`: the new id is used everywhere: Quorum's link follows it, After moved the
  queue to `queue:<newId>` (old key deleted). Time Machine resets its states and writes
  `session:<newId>` on its next save; until then only the old `session:<oldId>` exists, so
  a missing key must read as an empty timeline.
- After `claude --resume <id>`: same id; `queue:<id>` kept its state (paused, done list).
- Images: image-preview looks for `<tmp>/<project path, dashed>/<sid>/images`; the per
  session temp folder `<tmp>/<project path, dashed>/<sid>/` existed with the same id (no
  image was pasted, so `images/` itself was not created in the spike).

## Side effects

The spike session registered with the running quorumd (and the hub) like any session; its
two permission asks reached the devices and were answered in the terminal. It was closed
with `/exit`. Claude Code recorded folder trust for the scratch folder, as it does for any
new folder.
