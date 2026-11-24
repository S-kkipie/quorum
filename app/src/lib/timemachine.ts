/** Helpers for the better-claude `time-machine` plugin's per-session timeline. */

export interface TmFile { path: string; status: string; added: number; removed: number }
/** `id` is the number the plugin's `/timeline <n>` takes: it is not a position and may have gaps. */
export interface TmState { id: number; kind: string; label: string; at: number; files: TmFile[] }
export interface TmTimeline { states: TmState[]; cursor: number | null }

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
const str = (x: unknown) => (typeof x === 'string' ? x : '')
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object'

/** The plugin's `session:<sid>` JSON (states oldest first), tolerating missing fields; null when it is not one. */
export function parseTimeMachine(raw: unknown): TmTimeline | null {
  if (!obj(raw)) return null
  const states: TmState[] = []
  for (const s of Array.isArray(raw.states) ? raw.states : []) {
    if (!obj(s) || typeof s.id !== 'number' || !Number.isInteger(s.id) || s.id < 1) continue
    const files = (Array.isArray(s.files) ? s.files : [])
      .filter((f): f is Record<string, unknown> => obj(f) && typeof f.path === 'string')
      .map((f) => ({ path: str(f.path), status: str(f.status), added: num(f.added), removed: num(f.removed) }))
    states.push({ id: s.id, kind: str(s.kind), label: str(s.label), at: num(s.at), files })
  }
  return { states, cursor: typeof raw.cursor === 'number' ? raw.cursor : null }
}

/** `3 files +12 −4`; `no files` when the state changed none. */
export function digest(files: TmFile[]): string {
  if (files.length === 0) return 'no files'
  const a = files.reduce((n, f) => n + f.added, 0)
  const r = files.reduce((n, f) => n + f.removed, 0)
  return `${files.length} ${files.length === 1 ? 'file' : 'files'} +${a} −${r}`
}
