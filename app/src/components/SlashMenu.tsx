import { useEffect, useRef } from 'react'
import { Plug, Server, Sparkles, SquareSlash, Terminal } from 'lucide-react'
import { selectable, type CommandGroup } from '../lib/slash'
import type { SessionCommand } from '../proto.gen'
import { ScrollArea } from '@/components/ui/scroll-area'

const LOOK: Record<CommandGroup, { Icon: typeof Plug; tint: string }> = {
  session: { Icon: SquareSlash, tint: 'bg-accent-soft text-accent' },
  skill: { Icon: Sparkles, tint: 'bg-state-background-soft text-state-background' },
  plugin: { Icon: Plug, tint: 'bg-chip text-muted-foreground' },
  mcp: { Icon: Server, tint: 'bg-chip text-muted-foreground' },
}

/** The DOM id of the i-th row (in list order): unique even when names differ only in punctuation. */
export const optionId = (i: number) => `slash-opt-${i}`

/**
 * The "/" typeahead above the composer (Plan 8, mockup A): commands grouped Session, Skills,
 * Plugins, MCP. Terminal-only rows are dimmed, tagged and cannot be picked. Presentational: the
 * composer owns the query, the active row and the keyboard.
 */
export default function SlashMenu({ groups, reported, active, hint, onPick }: {
  groups: { key: CommandGroup; label: string; items: SessionCommand[] }[]
  /** false: the session never reported a list (an older mod) */
  reported: boolean
  /** the highlighted command's name */
  active?: string
  /** a short note under the list (e.g. why a row cannot be picked) */
  hint?: string
  onPick: (c: SessionCommand) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const rows = groups.flatMap((g) => g.items)
  const activeIndex = active === undefined ? -1 : rows.findIndex((c) => c.name === active)
  useEffect(() => {
    if (activeIndex < 0) return
    const el = ref.current?.querySelector<HTMLElement>(`#${optionId(activeIndex)}`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])
  let index = 0

  const empty = !reported ? 'Update the Quorum plugin on this machine to see commands' : groups.length === 0 ? 'No matching commands' : ''
  return (
    <div className="absolute inset-x-2 bottom-full z-30 mb-1 overflow-hidden rounded-2xl border border-line bg-surface shadow-lg">
      <ScrollArea viewportClassName="max-h-[50dvh] overscroll-contain"><div ref={ref} id="slash-menu" role="listbox" aria-label="Commands" className="py-1">
        {empty && <p className="px-3 py-3 text-sm text-muted-foreground">{empty}</p>}
        {groups.map((g) => {
          const { Icon, tint } = LOOK[g.key]
          return (
            <div key={g.key} role="group" aria-label={g.label}>
              <div aria-hidden className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">{g.label}</div>
              {g.items.map((c) => {
                const i = index++
                const off = !selectable(c)
                const on = !off && c.name === active
                const RowIcon = off ? Terminal : Icon
                return (
                  <div
                    key={c.name}
                    id={optionId(i)}
                    data-name={c.name}
                    role="option"
                    aria-selected={on}
                    aria-disabled={off || undefined}
                    title={c.description || undefined}
                    // keep the focus (and the phone keyboard) in the composer
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPick(c)}
                    className={`flex min-h-11 cursor-pointer items-center gap-2.5 px-3 py-1.5 ${on ? 'bg-chip' : 'hover:bg-chip'} ${off ? 'opacity-50' : ''}`}
                  >
                    <span className={`flex size-6 shrink-0 items-center justify-center rounded-md ${off ? 'bg-chip text-muted-foreground' : tint}`}><RowIcon size={14} aria-hidden /></span>
                    <span className="max-w-[60%] shrink-0 truncate font-mono text-[12.5px] text-ink">{'/' + c.name}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {c.description}
                      {c.plugin && !c.name.startsWith(c.plugin + ':') && <span>{(c.description ? ' · ' : '') + c.plugin}</span>}
                    </span>
                    {off && <span className="shrink-0 rounded-md bg-chip px-1.5 py-px text-xs text-muted-foreground">terminal</span>}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div></ScrollArea>
      {hint && <p role="status" className="border-t border-line px-3 py-2 text-xs text-warning">{hint}</p>}
    </div>
  )
}
