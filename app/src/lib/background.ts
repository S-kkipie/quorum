import { Bot, CalendarClock, Eye, Repeat, Terminal, type LucideIcon } from 'lucide-react'

/** Icon per background kind (a task's or an item's); unknown kinds fall back to the terminal. */
export const KIND_ICON: Record<string, LucideIcon> = { command: Terminal, monitor: Eye, subagent: Bot, loop: Repeat, cron: CalendarClock }
export const kindIcon = (kind: string): LucideIcon => KIND_ICON[kind] ?? Terminal

/** "just now", "4 min ago", "2 h ago", "3 d ago". */
export function ago(ms: number, now = Date.now()): string {
  const m = Math.floor(Math.max(0, now - ms) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

/** How a finished task reads: its verb, whether it is an error and whether it is merely muted. */
export function endTone(status: string): { verb: string; error: boolean; muted: boolean } {
  if (status === 'failed' || status === 'killed') return { verb: status === 'killed' ? 'was killed' : 'failed', error: true, muted: false }
  if (status === 'stopped') return { verb: 'stopped', error: false, muted: true }
  return { verb: 'finished', error: false, muted: false }
}

/** Local wall-clock time, HH:MM. */
export const hhmm = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
