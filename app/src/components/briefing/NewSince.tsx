import { CircleCheck, NotebookText, Ticket } from 'lucide-react'
import type { BriefingItem } from '../../proto.gen'
import { since } from '../../lib/projects'
import Section, { wrap } from './Section'

const ICON = { session: CircleCheck, ticket: Ticket, note: NotebookText } as const

/** "New since you were here": sessions, ticket changes and meeting notes since the previous visit. */
export default function NewSince({ items, prevSeenAt, onOpenSession }: { items: BriefingItem[]; prevSeenAt: number; onOpenSession?: (id: string) => void }) {
  return (
    <Section title="New since you were here" aside={prevSeenAt ? since(prevSeenAt).replace(/ ago$/, '') : undefined}>
      <ul className="divide-y divide-line">
        {items.map((x, i) => {
          const Icon = ICON[x.kind as keyof typeof ICON] ?? Ticket
          const body = (
            <>
              <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className={`block text-sm text-ink ${wrap}`}>{x.title}</span>
                <span className={`block text-xs text-muted-foreground ${wrap}`}>{x.detail ? `${x.detail} · ` : ''}{since(x.at)}</span>
              </span>
            </>
          )
          return (
            <li key={x.kind + x.ref + i}>
              {x.kind === 'session' && x.ref && onOpenSession ? (
                <button type="button" onClick={() => onOpenSession(x.ref)} className="flex min-h-11 w-full items-start gap-2 py-1.5 text-left hover:bg-chip">{body}</button>
              ) : (
                <div className="flex min-h-11 items-start gap-2 py-1.5">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}
