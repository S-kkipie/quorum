import type { Ticket } from '../../proto.gen'
import { statusText, ticketWhen } from '../../lib/briefing'
import { Badge } from '@/components/ui/badge'
import Section, { wrap } from './Section'

/** The owner's open tickets with status and planned dates; overdue ones in the warning tone. */
export default function MyTickets({ tickets, now = Date.now() }: { tickets: Ticket[]; now?: number }) {
  return (
    <Section title="Your tickets" aside={`${tickets.length} open`}>
      <ul className="divide-y divide-line">
        {tickets.map((t) => {
          const when = ticketWhen(t, now)
          return (
            <li key={t.id} className="flex min-h-11 items-start gap-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className={`block text-sm text-ink ${wrap}`}>{t.title}</span>
                <span className={`block text-xs ${when.overdue ? 'font-medium text-warning' : 'text-muted-foreground'}`}>{when.text}</span>
              </span>
              <Badge variant="secondary" className="shrink-0 rounded-full text-xs">{statusText(t)}</Badge>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}
