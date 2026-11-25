import type { ReactNode } from 'react'

/** One titled block of the inspector; the heading is sentence case, no caps or tracking (Plan 9). */
export default function InspectorCard({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-line bg-surface">
      <header className="flex items-baseline justify-between gap-2 px-3 pt-2.5 pb-1">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </header>
      {children}
    </section>
  )
}
