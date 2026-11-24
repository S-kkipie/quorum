/**
 * Arguments of slash commands run from a device. Plan 6 allowed only better-claude's
 * /after, /before and /timeline (the `plugin` command, kept as an alias); Plan 8 runs any
 * command the session lists (commands.ts) with the same args rules (`validateArgs`).
 */

export const TERMINAL_ONLY_ERROR = 'This command only works in the terminal.'

/**
 * better-claude's /after and /timeline open a pane when run bare: terminal-only without args.
 * Applies to the `command` type (commands.ts validateCommand) and the Plan 6 `plugin` alias.
 * Mirrored by the hub (internal/hub/commands.go terminalWhenBare) and the app (lib/slash.ts).
 */
export const TERMINAL_WHEN_BARE = new Set(['after', 'timeline'])

/** The Plan 6 `plugin` command's allow-list. */
export const PLUGIN_COMMANDS = new Set(['after', 'before', 'timeline'])
export const PLUGIN_ARGS_MAX = 2000
const TIMELINE_ARGS = /^(undo|redo|\d{1,4})$/
// eslint-disable-next-line no-control-regex
// C0, DEL, C1 and the Unicode line/paragraph separators
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/**
 * The args rules every device-run slash command shares (Plan 8 generalised Plan 6's): a
 * string of at most PLUGIN_ARGS_MAX UTF-16 units, one line without control characters, and
 * `/timeline` takes only undo, redo or a state number. null when fine, else an English error.
 */
export function validateArgs(command: string, args: string): string | null {
  if (typeof args !== 'string') return `Invalid arguments for /${command}`
  if (args.length > PLUGIN_ARGS_MAX) return `Arguments for /${command} exceed ${PLUGIN_ARGS_MAX} characters`
  if (CONTROL_CHARS.test(args)) return `Arguments for /${command} must be a single line without control characters`
  if (command === 'timeline' && !TIMELINE_ARGS.test(args)) return '/timeline takes undo, redo or a state number'
  return null
}

/**
 * The Plan 6 `plugin` command: the allow-list, a bare /after or /timeline is terminal-only
 * (TERMINAL_WHEN_BARE), then the shared args rules. null when it may run.
 */
export function validatePluginCommand(command: string, args: string): string | null {
  if (!PLUGIN_COMMANDS.has(command)) return `Unsupported plugin command: ${String(command).slice(0, 40)}`
  if (TERMINAL_WHEN_BARE.has(command) && typeof args === 'string' && !args.trim()) return TERMINAL_ONLY_ERROR
  return validateArgs(command, args)
}
