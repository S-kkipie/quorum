import type { Conversation, SessionInfo } from '../proto.gen'
import { projectCheckouts, projectSessions, stateStyle, toMs } from './projects'
import type { AppState } from './store'
import { sessionTitle } from './title'

export type SessionRow =
  | { kind: 'live'; id: string; session: SessionInfo }
  | { kind: 'closed'; id: string; machine: string; root: string; title: string; updatedAt: number; messages: number }

/**
 * The state shown for a session. "done" is not a server state: it is an idle session whose last
 * turn the owner has not seen yet. The legacy "waiting" shows as idle. Every consumer goes through this.
 */
export function displayState(s: Pick<SessionInfo, 'state' | 'unread'>): string {
  if (s.state === 'idle' && s.unread) return 'done'
  return s.state === 'waiting' ? 'idle' : s.state
}

/** Attention order: lower comes first. Unknown states sort like idle. */
export const ATTENTION: Record<string, number> = { needs_you: 0, done: 1, working: 2, background: 3, idle: 4 }
export const attentionRank = (s: Pick<SessionInfo, 'state' | 'unread'>) => ATTENTION[displayState(s)] ?? ATTENTION.idle

/** Sessions by attention, keeping the input order within a rank. */
export function byAttention<T extends Pick<SessionInfo, 'state' | 'unread'>>(list: T[]): T[] {
  return list.map((x, i) => ({ x, i })).sort((a, b) => attentionRank(a.x) - attentionRank(b.x) || a.i - b.i).map((e) => e.x)
}

/** Sessions that want the owner: needs_you plus done (unread). */
export const attentionCount = (list: Pick<SessionInfo, 'state' | 'unread'>[]) =>
  list.filter((x) => { const d = displayState(x); return d === 'needs_you' || d === 'done' }).length

const pad = (n: number) => String(n).padStart(2, '0')

/** Detail of a background session: "2 tasks", "wakes 14:30", "waking up" or both ("" otherwise). */
export function stateDetail(s: Pick<SessionInfo, 'state' | 'background'>, now = Date.now()): string {
  if (s.state !== 'background') return ''
  const parts: string[] = []
  const tasks = s.background?.tasks ?? 0
  if (tasks > 0) parts.push(`${tasks} ${tasks === 1 ? 'task' : 'tasks'}`)
  const wakeAt = s.background?.wakeAt ?? 0
  if (wakeAt > 0) {
    if (wakeAt <= now) parts.push('waking up')
    else { const d = new Date(wakeAt); parts.push(`wakes ${pad(d.getHours())}:${pad(d.getMinutes())}`) }
  }
  return parts.join(' · ')
}

/**
 * The short state text for a compact place (pill, card row): the detail when there is one, else the
 * label; title (tooltip and accessible name) always carries the label too.
 */
export function stateText(s: Pick<SessionInfo, 'state' | 'unread' | 'background'>, now = Date.now()): { text: string; title: string } {
  const label = stateStyle(displayState(s)).label
  const detail = stateDetail(s, now)
  return detail ? { text: detail, title: `${label} · ${detail}` } : { text: label, title: label }
}

/** The earliest wake-up still ahead among background sessions (ms), or 0: when a "wakes" label changes. */
export function nextWake(list: Pick<SessionInfo, 'state' | 'background'>[], now = Date.now()): number {
  let next = 0
  for (const s of list) {
    const w = s.state === 'background' ? s.background?.wakeAt ?? 0 : 0
    if (w > now && (!next || w < next)) next = w
  }
  return next
}

/**
 * Live sessions (by attention, then input order) followed by previous conversations
 * (newest first). A live session hides its listed conversation; a conversation listed
 * on several checkouts keeps the newest copy.
 */
export function mergeSessions(
  live: SessionInfo[],
  lists: { machine: string; root: string; list: Conversation[] }[],
  /** Closed sessions the app still knows (started and closed while the list was open). */
  closedSessions: SessionInfo[] = [],
): SessionRow[] {
  const liveIds = new Set(live.map((x) => x.id))
  const liveRows: SessionRow[] = live
    .map((session, i) => ({ session, i }))
    .sort((a, b) => attentionRank(a.session) - attentionRank(b.session) || a.i - b.i)
    .map(({ session }) => ({ kind: 'live', id: session.id, session }))
  const closed = new Map<string, Extract<SessionRow, { kind: 'closed' }>>()
  for (const { machine, root, list } of lists) {
    for (const c of list) {
      if (liveIds.has(c.id)) continue
      const updatedAt = toMs(c.updatedAt)
      const prev = closed.get(c.id)
      if (prev && prev.updatedAt >= updatedAt) continue
      closed.set(c.id, { kind: 'closed', id: c.id, machine, root, title: c.title || c.firstPrompt || c.id, updatedAt, messages: c.messages })
    }
  }
  for (const s of closedSessions) {
    if (liveIds.has(s.id)) continue
    const updatedAt = toMs(s.updatedAt)
    const prev = closed.get(s.id)
    // the listed conversation wins for title/messages; the newest timestamp wins
    if (prev) { if (updatedAt > prev.updatedAt) closed.set(s.id, { ...prev, updatedAt }); continue }
    closed.set(s.id, { kind: 'closed', id: s.id, machine: s.machine, root: s.root || s.cwd, title: sessionTitle(s).title, updatedAt, messages: 0 })
  }
  return [...liveRows, ...[...closed.values()].sort((a, b) => b.updatedAt - a.updatedAt)]
}

/** Latest activity of a project in ms (0 when unknown): live sessions and cached conversations. */
export function lastActivity(s: AppState, projectId: string): number {
  let max = 0
  for (const x of projectSessions(s, projectId)) max = Math.max(max, toMs(x.updatedAt))
  for (const c of projectCheckouts(s, projectId)) {
    for (const conv of s.conversations[c.machine + '\u0000' + c.root] ?? []) max = Math.max(max, toMs(conv.updatedAt))
  }
  return max
}
