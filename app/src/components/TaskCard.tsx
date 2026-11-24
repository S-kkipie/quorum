import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { endTone, kindIcon } from '../lib/background'
import type { TaskEndItem } from '../lib/timeline'

const FOLD_LINES = 6

/** A background task ended (Claude Code's task notification): what it was, how it ended, its output tail. */
export default function TaskCard({ item }: { item: TaskEndItem }) {
  const [open, setOpen] = useState(false)
  const tone = endTone(item.status)
  const Icon = kindIcon(item.kind)
  const title = `Background task ${tone.verb}`
  const lines = item.outputTail ? item.outputTail.replace(/\n+$/, '').split('\n') : []
  const long = lines.length > FOLD_LINES
  const shown = long && !open ? lines.slice(-FOLD_LINES) : lines
  return (
    <div role="note" aria-label={title} className={`my-2 rounded-xl border bg-surface p-2.5 ${tone.error ? 'border-danger' : 'border-line'}`}>
      <div className="flex min-w-0 items-start gap-2.5">
        <span className={`mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-md ${tone.error ? 'bg-chip text-danger' : 'bg-state-background-soft text-state-background'}`}>
          <Icon size={13} aria-hidden />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <div className={`font-medium ${tone.error ? 'text-danger' : tone.muted ? 'text-muted-foreground' : 'text-ink'}`}>
            {title}{item.exitCode !== undefined && <span className="font-normal text-muted-foreground">{` · exit ${item.exitCode}`}</span>}
          </div>
          {item.summary && <div title={item.summary} className="line-clamp-2 text-muted-foreground [overflow-wrap:anywhere]">{item.summary}</div>}
        </div>
      </div>
      {lines.length > 0 && (
        <div className="mt-2">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-chip p-2 font-mono text-xs leading-relaxed text-ink [overflow-wrap:anywhere]">{shown.join('\n')}</pre>
          {long && (
            <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
              className="press mt-1 flex min-h-11 items-center gap-1 rounded-lg px-1 text-xs font-medium text-muted-foreground hover:text-ink">
              <ChevronDown size={14} aria-hidden className={open ? 'rotate-180' : ''} />{open ? 'Show less' : `Show all ${lines.length} lines`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
