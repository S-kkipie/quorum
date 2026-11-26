import { apiFetch } from './api'
import { ago } from './background'
import type { BackgroundItem } from '../proto.gen'

/** What the machine knows of a background task: its output file and its processes. */
export interface TaskFacts {
  found: boolean
  size: number
  /** Unix ms */
  mtime: number
  tail: string
  procsKnown: boolean
  procs: { pid: number; state: string; cpuMs: number }[]
}

export const getTaskOutput = (sessionId: string, task: string) =>
  apiFetch<TaskFacts>(`/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(task)}/output`)

/**
 * A live item is dead only when its session is closed, or the machine can see processes, found the
 * output file and no process of the task is left. Nothing else (no silence, no timeout) counts.
 */
export function isDead(_item: BackgroundItem, facts: TaskFacts | undefined, sessionState: string): boolean {
  if (sessionState === 'closed') return true
  return !!facts && facts.procsKnown && facts.found && facts.procs.length === 0
}

const STATES: Record<string, string> = { R: 'running', S: 'sleeping', D: 'disk wait', Z: 'zombie', T: 'stopped' }

/** "last output 3 min ago · sleeping · 2.1 s CPU"; the process part only when processes are known and alive. */
export function factLine(f: TaskFacts, now = Date.now()): string {
  if (!f.found) return 'no output yet'
  const parts = [`last output ${ago(f.mtime, now)}`]
  if (f.procsKnown && f.procs.length) {
    parts.push(STATES[f.procs[0].state] ?? f.procs[0].state)
    parts.push(`${(f.procs.reduce((s, p) => s + p.cpuMs, 0) / 1000).toFixed(1)} s CPU`)
  }
  return parts.join(' · ')
}
