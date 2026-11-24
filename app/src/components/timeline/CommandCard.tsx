import { useState } from 'react'
import { Cpu, Loader2, SquareSlash } from 'lucide-react'
import type { CommandItem } from '../../lib/timeline'

/** Output lines shown before "Show more". */
const COMMAND_LINES = 6

/** A slash command a device ran (Plan 8, mockup C): `/name args`, where it came from, its status and output. */
export default function CommandCard({ item }: { item: CommandItem }) {
  const [more, setMore] = useState(false)
  const Icon = item.name === 'model' ? Cpu : SquareSlash
  const label = `/${item.name}${item.args ? ' ' + item.args : ''}`
  const lines = item.text ? item.text.split('\n') : []
  const long = lines.length > COMMAND_LINES
  const shown = long && !more ? lines.slice(0, COMMAND_LINES).join('\n') : item.text
  const tone = item.status === 'failed' ? 'bg-del-soft text-danger' : 'bg-accent-soft text-accent'
  return (
    <article aria-label={`Command ${label}`} className="my-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`flex size-6 shrink-0 items-center justify-center rounded-md ${tone}`}><Icon size={14} aria-hidden /></span>
        <span title={label} className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{label}</span>
        <span className="shrink-0 text-muted-foreground">{item.origin === 'device' ? 'from phone' : item.origin}</span>
      </div>
      {item.status === 'queued' && (
        <p className="mt-1.5 flex items-center gap-1.5 text-muted-foreground"><Loader2 size={12} aria-hidden className="animate-spin" />Runs when Claude finishes this turn</p>
      )}
      {item.status === 'failed' && <p className="mt-1.5 break-words text-danger">{`Failed: ${item.error || 'the command did not run'}`}</p>}
      {item.status === 'done' && !item.text && <p className="mt-1.5 text-muted-foreground">Done</p>}
      {item.text && item.status !== 'queued' && (
        <>
          <pre data-testid="command-output" className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{shown}</pre>
          {long && (
            <button type="button" onClick={() => setMore(!more)} className="-mb-2 min-h-11 text-xs font-medium text-accent hover:underline">{more ? 'Show less' : 'Show more'}</button>
          )}
        </>
      )}
    </article>
  )
}
