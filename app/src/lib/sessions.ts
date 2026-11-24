import type { Conversation, SessionInfo } from '../proto.gen'
import { projectCheckouts, projectSessions, toMs } from './projects'
import type { AppState } from './store'
import { sessionTitle } from './title'

export type SessionRow =
  | { kind: 'live'; id: string; session: SessionInfo }
  | { kind: 'closed'; id: string; machine: string; root: string; title: string; updatedAt: number; messages: number }

/** Attention order: lower comes first. Unknown states sort like idle. */
export const ATTENTION: Record<string, number> = { needs_you: 0, waiting: 1, working: 2, idle: 3 }
const rank = (state: string) => ATTENTION[state] ?? 3

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
    .sort((a, b) => rank(a.session.state) - rank(b.session.state) || a.i - b.i)
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
