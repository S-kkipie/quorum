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
      <button onClick={() => onOpen?.(t.id)} className={`flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-zinc-900 ${active ? 'bg-zinc-900' : ''}`}>
        <span className="shrink-0 pt-0.5 font-mono text-[11px] text-zinc-500">{t.externalId}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{t.title}</span>
          <span className="block truncate text-xs">
            <span className={TONE_TEXT[line.tone]}>{line.text}</span>
            {raw && <span className="text-zinc-600"> · {raw}</span>}
            {t.assignee && <span className="text-zinc-600"> · {t.assignee}</span>}
          </span>
        </span>
        {!!pending && <Badge className="rounded bg-amber-500/15 px-1.5 text-[11px] text-amber-300" title="pending proposals">{pending}</Badge>}
      </button>
    </li>
  )
}
