import type { Ticket } from '../proto.gen'
import { TONE_TEXT, ticketLine } from '../lib/projects'
import type { AppState } from '../lib/store'
import { Badge } from '@/components/ui/badge'

export default function TicketRow({ state, ticket, pending, active, onOpen }: {
  state: AppState
  ticket: Ticket
  pending?: number
  active?: boolean
  onOpen?: (id: string) => void
}) {
  const t = ticket
  const line = ticketLine(state, t)
  const raw = t.rawStatus && t.rawStatus.toLowerCase().replace(/[_-]/g, ' ') !== t.status.replace(/_/g, ' ') ? t.rawStatus : ''
  return (
    <li>
      <button onClick={() => onOpen?.(t.id)} className={`flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-chip active:bg-chip ${active ? 'bg-chip' : ''}`}>
        <span className="shrink-0 pt-0.5 font-mono text-xs text-muted-foreground">{t.externalId}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{t.title}</span>
          <span className="block truncate text-xs">
            <span className={TONE_TEXT[line.tone]}>{line.text}</span>
            {raw && <span className="text-muted-foreground"> · {raw}</span>}
            {t.assignee && <span className="text-muted-foreground"> · {t.assignee}</span>}
          </span>
        </span>
        {!!pending && <Badge className="rounded-full bg-state-needs-soft px-1.5 text-xs text-state-needs" title="pending proposals">{pending}</Badge>}
      </button>
    </li>
  )
}
