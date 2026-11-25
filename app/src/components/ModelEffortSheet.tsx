import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check } from 'lucide-react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { ModelOption } from '../proto.gen'
import { ScrollArea } from '@/components/ui/scroll-area'

/**
 * The header chips' bottom sheet (Plan 8, mockup B): the session's models, the current one checked,
 * and its effort levels. Picking a model switches it (set_model, applied by the mod); effort is
 * read-only from devices, so its segmented control is disabled and says where to change it.
 */
export default function ModelEffortSheet({ open, onOpenChange, options, current, effort, efforts, onPick }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: ModelOption[]
  /** the value of the option the session's model matches */
  current?: string
  effort: string
  efforts: string[]
  onPick: (value: string) => void
}) {
  // roving tabindex: one radio in the tab order (the focused one, else the checked one, else the
  // first); arrows move the focus without switching the model (a switch is a deliberate pick)
  const radios = useRef<(HTMLButtonElement | null)[]>([])
  const [focused, setFocused] = useState<number | null>(null)
  useEffect(() => { if (!open) setFocused(null) }, [open])
  const checked = options.findIndex((o) => o.value === current)
  const stop = focused !== null && focused < options.length ? focused : checked >= 0 ? checked : 0
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = options.length
    const to = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? (i + 1) % n
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? (i + n - 1) % n
        : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (to < 0) return
    e.preventDefault()
    setFocused(to)
    radios.current[to]?.focus()
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] gap-0 overflow-hidden rounded-t-2xl border-line bg-surface">
<ScrollArea viewportClassName="max-h-[85dvh]"><div className="flex flex-col pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div aria-hidden className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-line" />
        <SheetHeader className="px-4 pt-2 pb-1">
          <SheetTitle className="text-sm text-ink">Model</SheetTitle>
          <SheetDescription className="sr-only">Choose the model of this session. Effort can be changed in the terminal.</SheetDescription>
        </SheetHeader>
        {options.length > 0 && (
          <div role="radiogroup" aria-label="Model" className="flex flex-col gap-1 px-3">
            {options.map((o, i) => {
              const on = o.value === current
              return (
                <button
                  key={o.value}
                  ref={(el) => { radios.current[i] = el }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={i === stop ? 0 : -1}
                  onFocus={() => setFocused(i)}
                  onKeyDown={(e) => onKey(e, i)}
                  onClick={() => onPick(o.value)}
                  className={`flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left ${on ? 'border-accent/40 bg-accent-soft' : 'border-transparent hover:bg-chip active:bg-chip'}`}
                >
                  <span className="w-4 shrink-0 text-accent">{on && <Check size={16} aria-hidden />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{o.label || o.value}</span>
                    {o.description && <span className="block truncate text-xs text-muted-foreground">{o.description}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {efforts.length > 0 && (
          <div className="px-4 pt-4">
            <div id="effort-label" className="text-sm font-semibold text-ink">Effort</div>
            <div role="group" aria-labelledby="effort-label" className="mt-2 flex gap-1.5">
              {efforts.map((l) => (
                <button key={l} type="button" disabled aria-pressed={l === effort}
                  className={`min-h-11 min-w-0 flex-1 rounded-lg border px-0 text-xs disabled:cursor-not-allowed ${l === effort ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-chip text-muted-foreground'}`}>
                  {l}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Change effort in the terminal (/effort).</p>
          </div>
        )}
        <p className="px-4 pt-3 text-xs text-muted-foreground">A new model applies from the next turn.</p>
      </div></ScrollArea>
</SheetContent>
    </Sheet>
  )
}
