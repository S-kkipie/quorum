import { useEffect, useRef } from 'react'
import { Plug, Server, Sparkles, SquareSlash, Terminal } from 'lucide-react'
import { selectable, type CommandGroup } from '../lib/slash'
import type { SessionCommand } from '../proto.gen'

const LOOK: Record<CommandGroup, { Icon: typeof Plug; tint: string }> = {
  session: { Icon: SquareSlash, tint: 'bg-blue-500/15 text-blue-300' },
  skill: { Icon: Sparkles, tint: 'bg-violet-500/15 text-violet-300' },
  plugin: { Icon: Plug, tint: 'bg-emerald-500/15 text-emerald-300' },
  mcp: { Icon: Server, tint: 'bg-amber-500/15 text-amber-300' },
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
    <div className="absolute inset-x-2 bottom-full z-30 mb-1 overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/60">
      <div ref={ref} id="slash-menu" role="listbox" aria-label="Commands" className="max-h-[50dvh] overflow-y-auto overscroll-contain py-1">
        {empty && <p className="px-3 py-3 text-sm text-zinc-500">{empty}</p>}
        {groups.map((g) => {
          const { Icon, tint } = LOOK[g.key]
          return (
            <div key={g.key} role="group" aria-label={g.label}>
              <div aria-hidden className="px-3 pt-2 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-zinc-500">{g.label}</div>
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
                    className={`flex min-h-11 cursor-pointer items-center gap-2.5 px-3 py-1.5 ${on ? 'bg-zinc-800' : 'hover:bg-zinc-900'} ${off ? 'opacity-50' : ''}`}
                  >
                    <span className={`flex size-6 shrink-0 items-center justify-center rounded-md ${off ? 'bg-zinc-800 text-zinc-400' : tint}`}><RowIcon size={14} aria-hidden /></span>
                    <span className="max-w-[60%] shrink-0 truncate font-mono text-[12.5px] text-zinc-100">{'/' + c.name}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">
                      {c.description}
                      {c.plugin && !c.name.startsWith(c.plugin + ':') && <span className="text-zinc-600">{(c.description ? ' · ' : '') + c.plugin}</span>}
                    </span>
                    {off && <span className="shrink-0 rounded-md bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">terminal</span>}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      {hint && <p role="status" className="border-t border-zinc-800 px-3 py-2 text-xs text-amber-300">{hint}</p>}
    </div>
  )
}
