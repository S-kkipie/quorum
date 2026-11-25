import { useEffect, useState } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ago, hhmm, kindIcon } from '../lib/background'
import type { BackgroundInfo } from '../proto.gen'

/** True when there is anything to list: items, or a count from a mod too old to send them. */
export const hasBackground = (b?: BackgroundInfo) => !!b && (!!b.items?.length || (b.items === undefined && b.tasks > 0))

/** The session's pending background work (Plan 10): one row per item; counts only when the mod is older. */
export function BackgroundContent({ background }: { background?: BackgroundInfo }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  const items = background?.items
  const tasks = background?.tasks ?? 0
  return items === undefined && tasks > 0 ? (
    <div className="px-4 py-3 text-sm">
      <div className="text-ink">{tasks === 1 ? '1 background task' : `${tasks} background tasks`}</div>
      <div className="text-muted-foreground">Update the Quorum plugin to see details</div>
    </div>
  ) : !items?.length ? (
    <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing is running in the background.</p>
  ) : (
    <ul className="flex flex-col gap-1 px-3 pb-2">
      {items.map((it) => {
        const Icon = kindIcon(it.kind)
        return (
          <li key={it.id} className="flex min-h-11 items-start gap-2.5 rounded-xl bg-chip p-2.5">
            <span className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-md bg-state-background-soft text-state-background">
              <Icon size={13} role="img" aria-label={it.kind} />
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <div title={it.label} className="line-clamp-2 text-ink [overflow-wrap:anywhere]">{it.label || `Background ${it.kind}`}</div>
              <div className="text-xs text-muted-foreground">
                {`started ${ago(it.startedAt, now)}`}
                {!!it.nextWake && it.nextWake > now && (it.kind === 'loop' || it.kind === 'cron') && ` · next wake ${hhmm(it.nextWake)}`}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export default function BackgroundSheet({ open, onOpenChange, background }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  background?: BackgroundInfo
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] gap-0 overflow-y-auto rounded-t-2xl border-line bg-surface pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div aria-hidden className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-line" />
        <SheetHeader className="px-4 pt-2 pb-1">
          <SheetTitle className="text-sm text-ink">Background</SheetTitle>
          <SheetDescription className="sr-only">Work this session left running in the background.</SheetDescription>
        </SheetHeader>
        <BackgroundContent background={background} />
      </SheetContent>
    </Sheet>
  )
}
