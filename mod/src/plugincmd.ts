/**
 * Running another plugin's slash command (better-claude's /after, /before,
 * /timeline) from a device. Only the allow-listed commands run, with bounded
 * arguments: the device never gets a general way to type slash commands.
 */

/** Commands a device may run in its session. */
export const PLUGIN_COMMANDS = new Set(['after', 'before', 'timeline'])
export const PLUGIN_ARGS_MAX = 2000
const TIMELINE_ARGS = /^(undo|redo|\d{1,4})$/
// eslint-disable-next-line no-control-regex
// C0, DEL, C1 and the Unicode line/paragraph separators
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/** null when the command may run, else an English error for the device. */
export function validatePluginCommand(command: string, args: string): string | null {
  if (!PLUGIN_COMMANDS.has(command)) return `Unsupported plugin command: ${String(command).slice(0, 40)}`
  if (typeof args !== 'string') return `Invalid arguments for /${command}`
  if (args.length > PLUGIN_ARGS_MAX) return `Arguments for /${command} exceed ${PLUGIN_ARGS_MAX} characters`
  if (CONTROL_CHARS.test(args)) return `Arguments for /${command} must be a single line without control characters`
  if (command === 'timeline' && !TIMELINE_ARGS.test(args)) return '/timeline takes undo, redo or a state number'
  return null
}

export type PluginCommandDeps = {
  /**
   * `$.command.run({ command, args })`: reaches the plugin's own command.run hook.
   * Sent mid-turn it is queued until the turn ends, even for an `immediate` command.
   * (`$.prompt.submit` refuses text starting with `/`, so it is not an alternative.)
   */
  commandRun: (command: string, args: string) => Promise<unknown>
}

/**
 * Runs an allow-listed plugin command in this session.
 * Mechanism: `$.command.run` (docs/superpowers/specs/2026-11-23-plugin-command-spike.md).
 */
export async function runPluginCommand(
  deps: PluginCommandDeps, command: string, args: string,
): Promise<{ ok: boolean; error?: string }> {
  const bad = validatePluginCommand(command, args)
  if (bad) return { ok: false, error: bad }
  try {
    await deps.commandRun(command, args)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `Could not run /${command}: ${String((err as Error)?.message ?? err)}` }
  }
}
