import type { ModelOption, SessionCommand, SessionCommands } from '../proto.gen'

/**
 * better-claude's /after and /timeline open a pane when run bare: terminal-only without arguments.
 * Mirrors TERMINAL_WHEN_BARE in mod/src/plugincmd.ts (and terminalWhenBare in internal/hub/commands.go).
 */
const TERMINAL_WHEN_BARE = new Set(['after', 'timeline'])

export type CommandGroup = 'session' | 'skill' | 'plugin' | 'mcp'
const GROUPS: { key: CommandGroup; label: string }[] = [
  { key: 'session', label: 'Session' },
  { key: 'skill', label: 'Skills' },
  { key: 'plugin', label: 'Plugins' },
  { key: 'mcp', label: 'MCP' },
]

const groupOf = (c: SessionCommand): CommandGroup =>
  c.group === 'session' || c.group === 'skill' || c.group === 'mcp' ? c.group : 'plugin'

/** End of the first token (the command name) of a text starting with `/`. */
const nameEnd = (text: string) => {
  const m = /\s/.exec(text)
  return m ? m.index : text.length
}

/**
 * The typeahead's query (the name typed so far, without the slash), or null when the list must not
 * open: the text does not start with `/`, or the caret left the first token.
 */
export function slashQuery(text: string, caret: number): string | null {
  if (!text.startsWith('/')) return null
  const end = nameEnd(text)
  if (caret > end) return null
  return text.slice(1, end)
}

/** `/name args` → its parts; null when the text does not start with `/`. */
export function parseSlash(text: string): { name: string; args: string } | null {
  if (!text.startsWith('/')) return null
  const end = nameEnd(text)
  return { name: text.slice(1, end), args: text.slice(end).trim() }
}

/** Whether a row can be picked in the menu, completed or sent at all (terminal-only rows cannot). */
export const selectable = (c: SessionCommand): boolean => !c.terminalOnly

/** Why a device may not run `/name args`, or null when it may (the hub and the mod check again). */
export function blockReason(c: SessionCommand, args: string): string | null {
  if (!selectable(c)) return 'Only in the terminal'
  if (TERMINAL_WHEN_BARE.has(c.name) && !args.trim()) return 'Only in the terminal without arguments'
  return null
}

/** False when the session never reported a list (an older mod: absent, or empty with an empty hash). */
export function commandsReported(sc: SessionCommands | undefined): sc is SessionCommands {
  return !!sc && Array.isArray(sc.commands) && (sc.hash !== '' || sc.commands.length > 0)
}

/**
 * Filters and groups the list for the typeahead: within each group, prefix matches on the name
 * first, then substring matches in the name or the description (case-insensitive), each in the
 * session's order. Groups without a match are dropped.
 */
export function filterCommands(list: readonly SessionCommand[], query: string): { key: CommandGroup; label: string; items: SessionCommand[] }[] {
  const q = query.toLowerCase()
  const prefix: Record<CommandGroup, SessionCommand[]> = { session: [], skill: [], plugin: [], mcp: [] }
  const sub: Record<CommandGroup, SessionCommand[]> = { session: [], skill: [], plugin: [], mcp: [] }
  for (const c of list) {
    const name = c.name.toLowerCase()
    if (name.startsWith(q)) prefix[groupOf(c)].push(c)
    else if (name.includes(q) || c.description.toLowerCase().includes(q)) sub[groupOf(c)].push(c)
  }
  return GROUPS.map((g) => ({ ...g, items: [...prefix[g.key], ...sub[g.key]] })).filter((g) => g.items.length > 0)
}

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable']
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** A short name for a model id: `claude-opus-5-5` → `Opus 5.5`, `claude-opus-4-6[1m]` → `Opus 4.6 (1M)`. */
export function modelLabel(model: string): string {
  if (!model) return ''
  const wide = /\[1m\]$/i.test(model)
  const id = wide ? model.slice(0, -4) : model
  const parts = id.toLowerCase().replace(/^claude-/, '').split('-')
  const fam = parts.find((p) => FAMILIES.includes(p))
  if (!fam) return model
  // version digits (1-2 chars each) around the family, never a date stamp
  const version = parts.filter((p) => /^\d{1,2}$/.test(p)).join('.')
  return `${cap(fam)}${version ? ' ' + version : ''}${wide ? ' (1M)' : ''}`
}

/** The option the session's model matches: the exact value, else the model family (1M variant when the id says so). */
export function currentModelOption(options: readonly ModelOption[], model: string): ModelOption | undefined {
  if (!model) return undefined
  const exact = options.find((o) => o.value === model)
  if (exact) return exact
  const wide = /\[1m\]$/i.test(model)
  const fam = model.toLowerCase().replace(/\[1m\]$/, '').split('-').find((p) => FAMILIES.includes(p))
  if (!fam) return undefined
  return options.find((o) => o.value.toLowerCase() === (wide ? `${fam}[1m]` : fam))
}
