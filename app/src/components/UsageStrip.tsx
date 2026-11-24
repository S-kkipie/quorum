import { Fragment } from 'react'
import type { AccountUsage, UsageWindow } from '../proto.gen'
import { USAGE_STALE_MS as STALE_MS, resetIn, toneClass, usageTone } from '../lib/meters'

function Win({ label, w, now }: { label: string; w: UsageWindow; now: number }) {
  // a window Claude Code did not report has no reset time: show nothing rather than "0%"
  if (!w.resetsAt) return null
  const tone = usageTone(w.pct)
  const reset = resetIn(w.resetsAt, now)
  return (
    <span className="whitespace-nowrap">
      <span data-tone={tone} className={toneClass[tone]}>{`${label} ${Math.round(w.pct)}%`}</span>
      {reset && <span className="text-zinc-600">{` · ${reset}`}</span>}
    </span>
  )
}

/** Subscription usage per account (5 h and weekly windows), highest first; stale reports are dimmed. */
export default function UsageStrip({ usage, now = Date.now() }: { usage: Record<string, AccountUsage>; now?: number }) {
  const list = Object.values(usage).sort((a, b) => Math.max(b.fiveHour.pct, b.sevenDay.pct) - Math.max(a.fiveHour.pct, a.sevenDay.pct) || a.alias.localeCompare(b.alias))
  if (list.length === 0) return null
  return (
    <div aria-label="Account usage" className="flex flex-wrap gap-x-4 gap-y-1 border-b border-zinc-800 px-3 py-2 text-xs">
      {list.map((u) => {
        const stale = now - u.at > STALE_MS
        return (
          <div key={u.key} data-testid="usage-account" data-stale={stale ? '' : undefined} className={`flex min-w-0 items-baseline gap-x-2 ${stale ? 'opacity-50' : ''}`}>
            <span className="max-w-[10rem] truncate font-medium text-zinc-300">{u.alias}</span>{' '}
            <Win label="5h" w={u.fiveHour} now={now} />{' '}
            <Win label="week" w={u.sevenDay} now={now} />
          </div>
        )
      })}
    </div>
  )
}

/** One account's usage in a line, `5h 58% · week 24%` (no reset times): the session header's meter. */
export function UsageInline({ usage: u, now = Date.now() }: { usage: AccountUsage; now?: number }) {
  // a window Claude Code did not report has no reset time: omitted, as in the strip
  const wins = ([['5h', u.fiveHour], ['week', u.sevenDay]] as const).filter(([, w]) => w.resetsAt)
  if (wins.length === 0) return null
  const stale = now - u.at > STALE_MS
  return (
    <span data-testid="session-usage" data-stale={stale ? '' : undefined} className={`shrink-0 whitespace-nowrap ${stale ? 'opacity-50' : ''}`}>
      {wins.map(([label, w], k) => {
        const tone = usageTone(w.pct)
        return <Fragment key={label}>{k > 0 && ' · '}<span data-tone={tone} className={toneClass[tone]}>{`${label} ${Math.round(w.pct)}%`}</span></Fragment>
      })}
    </span>
  )
}
