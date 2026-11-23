const STR_MAX = 2000 // runes
const ARR_MAX = 50
const TOTAL_MAX = 16 * 1024 // bytes, serialized
const INTERNAL = new Set(['tool', 'tool_use_id', 'agentId'])

/** Keys kept when the total goes over TOTAL_MAX. */
const KEEP: Record<string, string[]> = {
  Bash: ['command', 'description'],
  Read: ['file_path', 'offset', 'limit'],
  Write: ['file_path', 'content'],
  Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  MultiEdit: ['file_path', 'edits'],
  Grep: ['pattern', 'path', 'glob'],
  Glob: ['pattern', 'path'],
  WebSearch: ['query'],
  WebFetch: ['url', 'prompt'],
  Skill: ['skill', 'args'],
  Agent: ['description', 'subagent_type', 'prompt'],
  Task: ['description', 'subagent_type', 'prompt'],
  TodoWrite: ['todos'],
}
const FALLBACK_KEYS = 8
const KEY_MAX = 64 // runes, for object key names

const bytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v) ?? '').length

function cut(s: string, max: number): string {
  if (s.length <= max) return s // UTF-16 units >= code points, so this is safely short
  let out = ''
  let n = 0
  for (const ch of s) {
    if (n++ >= max) break
    out += ch
  }
  return out
}

function clip(v: unknown, max: number, depth = 0): unknown {
  if (typeof v === 'string') return cut(v, max)
  if (depth > 8) return null
  if (Array.isArray(v)) return v.slice(0, ARR_MAX).map(x => clip(x, max, depth + 1))
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) o[cut(k, KEY_MAX)] = clip(x, max, depth + 1)
    return o
  }
  return v
}

/**
 * Trimmed copy of a tool's input for tool_start: internal keys removed, strings <= 2000 runes,
 * arrays <= 50 elements, total <= 16 KiB (otherwise only the tool's main keys remain).
 */
export function trimInput(tool: string, input: unknown): Record<string, unknown> {
  const src = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>
  const own: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) if (!INTERNAL.has(k)) own[k] = v

  let out = clip(own, STR_MAX) as Record<string, unknown>
  if (bytes(out) <= TOTAL_MAX) return out

  const keys = KEEP[tool] ?? Object.keys(own).slice(0, FALLBACK_KEYS)
  const kept: Record<string, unknown> = {}
  for (const k of keys) if (k in own) kept[k] = own[k]
  // still too big (e.g. many long strings in an array): shrink the per-string limit until it fits
  for (let max = STR_MAX; max >= 1; max = Math.floor(max / 2)) {
    out = clip(kept, max) as Record<string, unknown>
    if (bytes(out) <= TOTAL_MAX) return out
  }
  // last resort: only scalar values of the kept keys, tightly trimmed; the bound must always hold
  const scalars: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(kept)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) scalars[cut(k, KEY_MAX)] = clip(v, 256)
  }
  return bytes(scalars) <= TOTAL_MAX ? scalars : {}
}
