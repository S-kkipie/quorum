import type { Project, SessionInfo } from '../proto.gen'
import { since, stateStyle } from '../lib/projects'
import { byAttention, displayState, stateText } from '../lib/sessions'
import { useWakeClock } from '../lib/useWakeClock'
import { sessionTitle } from '../lib/title'

const SHOWN = 3

export default function ProjectCard({ project, sessions, pending, lastActivity = 0, active, onOpen, onOpenSession }: {
  project: Project
  sessions: SessionInfo[]
  pending: number
  /** Latest activity in ms; 0 hides the line. */
  lastActivity?: number
  active?: boolean
  onOpen?: (id: string) => void
  onOpenSession?: (id: string) => void
}) {
  const p = project
  const ranked = byAttention(sessions)
  const unread = sessions.some((x) => displayState(x) === 'done')
  const shown = ranked.slice(0, SHOWN)
  const more = ranked.length - shown.length
  const now = useWakeClock(shown)
  return (
    <article className={`rounded-xl border bg-surface ${active ? 'border-accent' : 'border-line'}`}>
      <button onClick={() => onOpen?.(p.id)} className="block w-full p-3 text-left hover:bg-chip active:bg-chip">
        <span className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{p.name}</span>
            {unread && <span role="img" aria-label="Unread sessions" className="h-2 w-2 shrink-0 rounded-full bg-state-done" />}
          </span>
          {pending > 0 && (
            <span className="shrink-0 rounded-full bg-state-needs-soft px-1.5 py-0.5 text-xs text-state-needs">
              {pending} {pending === 1 ? 'proposal' : 'proposals'}
            </span>
          )}
        </span>
        {p.summary && <span className="mt-2 line-clamp-2 text-xs leading-snug text-ink">{p.summary}</span>}
        {lastActivity > 0 && <span className="mt-2 block text-xs text-muted-foreground">Last activity {since(lastActivity)}</span>}
        {p.syncError && (
          <span role="alert" title={p.syncError} className="mt-2 line-clamp-3 rounded-lg bg-del-soft px-2 py-1 text-xs [overflow-wrap:anywhere] text-danger">
            Sync error: {p.syncError}
          </span>
        )}
      </button>
      {sessions.length > 0 && (
        <ul className="border-t border-line py-1">
          {shown.map((s) => {
            const st = stateStyle(displayState(s))
            const { text, title } = stateText(s, now)
            return (
              <li key={s.id}>
                <button onClick={() => onOpenSession?.(s.id)} className="flex min-h-11 w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-chip active:bg-chip">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
                  <span className="min-w-0 flex-1 truncate">{sessionTitle(s).title}</span>
                  <span title={title} className={`min-w-0 truncate ${st.text}`}>{text}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {more > 0 && (
        <button onClick={() => onOpen?.(p.id)} className="block min-h-11 w-full border-t border-line px-3 text-left text-xs text-muted-foreground hover:bg-chip active:bg-chip">+{more} more</button>
      )}
    </article>
  )
}
