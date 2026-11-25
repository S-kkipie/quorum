import type { ReactNode } from 'react'
import { Card } from '@/components/ui/card'

/** A briefing card: a labelled region with a small heading and an optional note on the right. */
export default function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Card role="region" aria-label={title} className="min-w-0 gap-2 px-3 py-3 shadow-none">
      <div className="flex min-w-0 items-baseline gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted-foreground">{title}</h3>
        {aside && <span className="shrink-0 text-xs text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </Card>
  )
}

/** Text that may hold long unbroken words or links: it wraps instead of widening the page. */
export const wrap = '[overflow-wrap:anywhere]'
