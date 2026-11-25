import { useState } from 'react'
import { since, stateStyle, toMs } from '../lib/projects'
import { displayState, stateDetail, type SessionRow } from '../lib/sessions'
import { sessionTitle } from '../lib/title'
import { useWakeClock } from '../lib/useWakeClock'
import SessionCloseMenu from './SessionCloseMenu'

/** One row of a merged session list: a live session opens, a closed conversation is resumed. */
export default function SessionRowView({ row, project, active, disabled, detailed, onOpen, onResume }: {
  row: SessionRow
  /** Project name shown before the details (lists that mix projects). */
  project?: string
  active?: boolean
  /** A launch is in progress: closed rows cannot be resumed. */
  disabled?: boolean
  /** Live rows also show the working directory, context usage and age. */
  detailed?: boolean
  onOpen?: (id: string) => void
  onResume?: (row: Extract<SessionRow, { kind: 'closed' }>) => void
}) {
  const [error, setError] = useState('')
  const now = useWakeClock(row.kind === 'live' ? [row.session] : [])
  const cls = `flex min-h-11 w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-chip active:bg-chip disabled:opacity-40 ${active ? 'bg-chip' : ''}`
  if (row.kind === 'live') {
    const s = row.session
    const display = displayState(s)
    const st = stateStyle(display)
    const detail = stateDetail(s, now)
    const { title, short } = sessionTitle(s)
    const closable = s.role !== 'service'
    return (
      <li>
        <div className="flex items-center">
          <button onClick={() => onOpen?.(s.id)} className={`${cls} min-w-0 flex-1`}>
            <span {...(display === 'done' ? { role: 'img', 'aria-label': 'Unread' } : {})} className={`h-2.5 w-2.5 shrink-0 rounded-full ${st.dot}`} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {project && `${project} · `}{short} · {detailed ? s.cwd : s.machine}
              </span>
            </span>
            <span className="shrink-0 text-right text-xs">
              <span className={`block ${st.text}`}>{st.label}</span>
              {detail && <span className={`block ${st.text} opacity-80`}>{detail}</span>}
              {detailed && <span className="block text-muted-foreground">{s.contextPct > 0 ? `${s.contextPct}% · ` : ''}{since(toMs(s.updatedAt))}</span>}
            </span>
          </button>
          {closable && <SessionCloseMenu id={s.id} onError={setError} />}
        </div>
        {error && <p role="alert" className="px-3 pb-1 text-xs text-danger">{error}</p>}
      </li>
    )
  }
  return (
    <li>
      <button disabled={disabled} onClick={() => onResume?.(row)} className={cls}>
        <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-line" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{row.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {project && `${project} · `}{row.machine}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{since(toMs(row.updatedAt))}{row.messages > 0 && ` · ${row.messages} ${row.messages === 1 ? 'message' : 'messages'}`}</span>
      </button>
    </li>
  )
}
