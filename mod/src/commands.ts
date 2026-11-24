/**
 * The session's slash commands, models and effort levels as Quorum's devices see them.
 *
 * - `$.command.list()` gives every command the person can run (typeahead order) with its
 *   source (builtin | plugin | user | mcp) and, for a plugin's, the plugin.
 * - Built-ins a device may run: an allowlist (BUILTIN_RUNNABLE), everything else terminal-only.
 * - Skills: `CommandInfo` does not say whether a command is a skill. The context's skill
 *   listing does (`$.session.usage({ breakdown: 'summary' })` → `context.breakdown.skills`,
 *   computed locally, no request): a command whose name is in it is a skill, whatever its
 *   source (a user skill, a plugin's `<plugin>:<skill>`, a bundled one like `dataviz`).
 *   Without that listing (older builds): `user` → skill, and a plugin command named
 *   `<plugin>:<name>` → skill (plugins' markdown commands and skills carry the prefix, a
 *   mod's `$.command.register` does not).
 * - Models: the `/config` Model row's options (`$.config.list()`, key `model`), labelled here.
 *   Effort: an effort row's options when a build has one, else the five levels of
 *   `ModelEffort`; the current level from the classic Stop hook's `effort.level`.
 *
 * Pure: `$` reaches it only through the deps of `makeCommandsReporter`.
 */

import { TERMINAL_ONLY_ERROR, TERMINAL_WHEN_BARE, validateArgs } from './plugincmd'
import type { ModelOption, SessionCommand } from './proto.gen'

type CommandInfo = { name?: unknown; description?: unknown; source?: unknown; plugin?: unknown }
type SkillRef = { name?: unknown; pluginName?: unknown }
type ConfigRow = { key?: unknown; value?: unknown; options?: unknown }

const SOURCES = new Set(['builtin', 'plugin', 'user', 'mcp'])
const NAME_MAX = 200
const DESCRIPTION_MAX = 300
const LIST_MAX = 2000
/** A command's output in its `command` event is capped at this many characters. */
export const COMMAND_TEXT_MAX = 8000
export { TERMINAL_ONLY_ERROR, TERMINAL_WHEN_BARE }

/**
 * Built-ins a device may run: an ALLOWLIST. Any other built-in (an interactive one, or one a later
 * Claude Code version adds) is terminal-only. Skills that Claude Code bundles count as built-ins too:
 * a built-in in the session's skill listing runs as well (see `toSessionCommands`).
 *
 * Derived from the Claude Code 2.1.331 binary (`~/.local/share/claude/versions/2.1.331`, the
 * command definitions in its bundled JS, read with `strings`):
 * - `type:"local"` commands marked `supportsNonInteractive:!0` with no `type:"local-jsx"` twin
 *   (a twin, even one behind a flag, is the variant an interactive session may resolve): clear,
 *   compact, reload-plugins, reload-skills, list-agents, project, design-consent,
 *   design-revoke, agents (prints where agents now live), heapdump.
 * - `type:"prompt"` commands (a turn for the model): init, insights, team-onboarding. statusline
 *   is a prompt too but is left out: it is marked `terminalOriented` and `disableNonInteractive`.
 * - Bundled skills registered in the binary (prompts): batch, claude-in-chrome, debug, doctor,
 *   fewer-permission-prompts, keybindings-help, run, run-skill-generator, update-config.
 * Left out on purpose: every command with a `local-jsx` variant (pickers, dialogs, panes: config,
 * resume, login, permissions, diff, usage, rename, color, branch, fork, plan, goal, output-style,
 * ...), including /model and /effort: with arguments they still render a confirm dialog ("Switch
 * model?" / "Change effort level?") when the prompt cache may be warm, the normal case right after
 * a turn, and /model also when a PreModelSwitch hook asks. A device switches the model with the
 * `set_model` command instead (control.ts). Also left out: `local` commands marked
 * `supportsNonInteractive:!1` (rewind, keybindings, radio, stickers, install-slack-app), restart,
 * voice and the internal __remote-workflow / workflow-launch-exec.
 * Also left out: recap. Its 2.1.331 implementation answers a run that the person did not submit
 * themselves (`zyl(o)`: local stdin or a verified human turn; a mod's `$.command.run` is neither)
 * with "/recap only runs when you ask for it yourself in this session: ..." instead of running.
 * (control.ts also turns that kind of refusal text into a failed command, for any build.)
 */
export const BUILTIN_RUNNABLE = new Set([
  'clear', 'compact', 'reload-plugins', 'reload-skills', 'list-agents', 'project',
  'design-consent', 'design-revoke', 'agents', 'heapdump',
  'init', 'insights', 'team-onboarding',
  'batch', 'claude-in-chrome', 'debug', 'doctor', 'fewer-permission-prompts', 'keybindings-help', 'run',
  'run-skill-generator', 'update-config',
])

/**
 * How long a device command may run, once it actually started (not while queued behind a turn),
 * before its card says it waits for the terminal (it may have opened a dialog there). The card
 * is not final: the command keeps running and its late done/failed (same id) replaces it.
 */
export const COMMAND_WAIT_MS = 30_000
/** /compact summarises the whole conversation: it gets a longer budget. */
export const COMPACT_WAIT_MS = 300_000
export const COMMAND_WAIT_ERROR = 'Waiting for an answer in the terminal.'

/** The wait budget of a device command (see COMMAND_WAIT_MS). */
export const commandWaitMs = (name: string): number => (name === 'compact' ? COMPACT_WAIT_MS : COMMAND_WAIT_MS)

/** The effort levels when no settings row lists them (`ModelEffort`). */
export const DEFAULT_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** The models when the session has no /config Model row. */
const DEFAULT_MODELS = ['default', 'opus', 'sonnet', 'haiku']
const MODEL_TEXT: Record<string, [string, string]> = {
  default: ['Default', 'The recommended model for this account'],
  best: ['Best', 'The most capable model available'],
  opus: ['Opus', 'Most capable, for complex work'],
  sonnet: ['Sonnet', 'Fast and capable, for everyday work'],
  haiku: ['Haiku', 'Fastest, for quick answers'],
  fable: ['Fable', ''],
  opusplan: ['Opus Plan', 'Opus in plan mode, Sonnet otherwise'],
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

function isSkill(c: { name: string; source: string; plugin: string }, skills: Set<string> | undefined): boolean {
  if (c.source === 'mcp') return false
  if (skills) return skills.has(c.name)
  if (c.source === 'user') return true
  return c.source === 'plugin' && c.name.includes(':')
}

/** Maps `$.command.list()` (in its order) to what the devices get. */
export function toSessionCommands(list: readonly unknown[] | undefined, skills: readonly unknown[] | undefined): SessionCommand[] {
  const known = Array.isArray(skills)
    ? new Set((skills as SkillRef[]).filter(s => s && typeof s.name === 'string').map(s => String(s.name)))
    : undefined
  const out: SessionCommand[] = []
  const seen = new Set<string>()
  for (const raw of (Array.isArray(list) ? list : []).slice(0, LIST_MAX)) {
    const r = raw as CommandInfo | null
    if (!r || typeof r !== 'object') continue
    const name = str(r.name, NAME_MAX)
    if (!name || seen.has(name)) continue
    seen.add(name)
    const source = SOURCES.has(String(r.source)) ? String(r.source) : 'builtin'
    const plugin = str(r.plugin, NAME_MAX)
    const base = { name, source, plugin }
    const skill = isSkill(base, known)
    const group = skill ? 'skill' : source === 'mcp' ? 'mcp' : source === 'plugin' ? 'plugin' : 'session'
    // built-ins: allowlist (a bundled skill in the listing runs too); plugin, user and MCP commands run
    const runnable = source !== 'builtin' || BUILTIN_RUNNABLE.has(name) || (skill && !!known)
    out.push({ name, description: str(r.description, DESCRIPTION_MAX), source, plugin, group, terminalOnly: !runnable })
  }
  return out
}

/** A short stable hash of the list (FNV-1a, two lanes): equal lists give equal hashes. */
export function hashCommands(cmds: readonly SessionCommand[]): string {
  const s = JSON.stringify(cmds.map(c => [c.name, c.description, c.source, c.plugin, c.group, c.terminalOnly]))
  let a = 0x811c9dc5
  let b = 0x01000193 ^ s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/**
 * Whether a device may run `/command args` in a session whose list is `list`: null when it
 * may, else the English reason (unknown, terminal-only, args rules).
 */
export function validateCommand(list: readonly SessionCommand[] | undefined, command: string, args: string): string | null {
  if (!list) return 'The command list of this session is not available yet'
  const c = list.find(x => x.name === command)
  if (!c) return `Unknown command: /${String(command).slice(0, 60)}`
  if (c.terminalOnly) return TERMINAL_ONLY_ERROR
  if (TERMINAL_WHEN_BARE.has(command) && typeof args === 'string' && !args.trim()) return TERMINAL_ONLY_ERROR
  return validateArgs(command, args)
}

function modelOption(value: string): ModelOption {
  const wide = /\[1m\]$/i.test(value)
  const base = wide ? value.slice(0, -4) : value
  const known = MODEL_TEXT[base.toLowerCase()]
  const label = known?.[0] ?? (base ? base[0]!.toUpperCase() + base.slice(1) : value)
  const description = known?.[1] ?? ''
  return wide
    ? { value, label: `${label} (1M context)`, description: description ? `${description}, 1M-token context` : '1M-token context' }
    : { value, label, description }
}

const rowsOf = (rows: readonly unknown[] | undefined) => (Array.isArray(rows) ? rows as ConfigRow[] : []).filter(r => r && typeof r === 'object')
const optionsOf = (r: ConfigRow | undefined) =>
  Array.isArray(r?.options) ? (r!.options as unknown[]).filter((o): o is string => typeof o === 'string' && o.length > 0 && o.length <= 100) : []

/** The models `/model` takes: the /config Model row's options, else DEFAULT_MODELS. */
export function modelOptions(rows: readonly unknown[] | undefined): ModelOption[] {
  const opts = optionsOf(rowsOf(rows).find(r => r.key === 'model'))
  return (opts.length ? opts : DEFAULT_MODELS).slice(0, 50).map(modelOption)
}

const isEffortRow = (r: ConfigRow) => typeof r.key === 'string' && /^effort(level)?$/i.test(r.key)

/** The levels `/effort` takes: an effort row's options when a build has one, else DEFAULT_EFFORTS. */
export function effortOptions(rows: readonly unknown[] | undefined): string[] {
  const opts = optionsOf(rowsOf(rows).find(isEffortRow))
  return opts.length ? opts.slice(0, 20) : [...DEFAULT_EFFORTS]
}

/** The current effort in a classic Stop hook input (`effort.level`), if any. */
export function effortFromStop(e: unknown): string | undefined {
  const l = (e as { effort?: { level?: unknown } } | undefined)?.effort?.level
  return typeof l === 'string' && l && l.length <= 20 ? l : undefined
}

export type ReporterDeps = {
  /** `$.command.list()` */
  list: () => Promise<readonly unknown[]>
  /** The context's skill listing (`skillFrontmatter`), undefined when unavailable. */
  skills: () => Promise<readonly unknown[] | undefined>
  /** `$.config.list()` */
  config: () => Promise<readonly unknown[]>
  /** `$.session.model()` */
  model: () => Promise<string>
  /** Link.setCommands: POSTs the list to the daemon (session_commands); true when it took it. */
  send: (p: { commands: SessionCommand[]; hash: string }) => Promise<boolean>
  /** Link.update */
  update: (patch: { model?: string; effort?: string; modelOptions?: ModelOption[]; effortOptions?: string[] }) => void
  /** The model already registered (so an unchanged one is not re-sent). */
  initialModel?: string
}

/**
 * Keeps the devices' copy of the command list, model/effort options, model and effort current.
 * `check()` is called without awaiting (session start, turn end, after a device command or a
 * plugin reload): it lists, and sends only what changed. Concurrent checks share one run.
 * Never throws.
 */
export function makeCommandsReporter(deps: ReporterDeps) {
  let current: SessionCommand[] | undefined
  let rawKey = ''
  let hash = ''
  let optionsKey = ''
  let models: ModelOption[] | undefined
  let model = deps.initialModel ?? ''
  let effort = ''
  let running: Promise<void> | undefined
  let again = false

  // the hash of `current` and the one the daemon last took (only after a successful POST, so a
  // failed send is retried at the next check)
  let currentHash = ''

  async function commands(): Promise<void> {
    const list = await deps.list()
    if (!Array.isArray(list)) return
    const key = JSON.stringify(list)
    if (key !== rawKey || !current) {
      const skills = await deps.skills().catch(() => undefined)
      current = toSessionCommands(list, skills)
      rawKey = key
      currentHash = hashCommands(current)
    }
    if (currentHash === hash) return
    const h = currentHash
    if (await deps.send({ commands: current, hash: h }).catch(() => false)) hash = h
  }

  async function options(): Promise<void> {
    const rows = await deps.config().catch(() => undefined)
    const p = { modelOptions: modelOptions(rows), effortOptions: effortOptions(rows) }
    const k = JSON.stringify(p)
    models = p.modelOptions
    if (k !== optionsKey) { optionsKey = k; deps.update(p) }
    // a build with an effort row: its value is the current effort until a Stop says otherwise
    const row = rowsOf(rows).find(isEffortRow)
    if (!effort && typeof row?.value === 'string') setEffort(row.value)
  }

  async function currentModel(): Promise<void> {
    const m = await deps.model()
    if (typeof m === 'string' && m && m !== model) { model = m; deps.update({ model: m }) }
  }

  function setEffort(level: string | undefined): void {
    if (!level || level === effort) return
    effort = level
    try { deps.update({ effort: level }) } catch { /* never toward Claude Code */ }
  }

  async function run(): Promise<void> {
    do {
      again = false
      await Promise.all([
        commands().catch(() => {}),
        options().catch(() => {}),
        currentModel().catch(() => {}),
      ])
    } while (again)
  }

  return {
    /** Re-reads everything and sends what changed. */
    check(): Promise<void> {
      if (running) { again = true; return running }
      running = run().finally(() => { running = undefined })
      return running
    },
    /** The last list read (undefined until the first one). */
    current: () => current,
    /** The last model options reported (undefined until the first check). */
    modelOptions: () => models,
    /** The effort of the turn that just ended (Stop hook) or one a device just set. */
    effort: setEffort,
    /** The model Claude Code switched to (PostModelSwitch). */
    model(m: string | undefined): void {
      if (typeof m === 'string' && m && m !== model) { model = m; try { deps.update({ model: m }) } catch { /* same */ } }
    },
  }
}

export type CommandsReporter = ReturnType<typeof makeCommandsReporter>
