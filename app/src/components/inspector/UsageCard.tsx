import { Badge } from '../ui/badge'
import { Progress } from '../ui/progress'
import InspectorCard from './InspectorCard'
import { USAGE_STALE_MS, contextTone, formatTokens, resetIn, toneClass, usageTone, type Tone } from '../../lib/meters'
import type { AccountUsage, SessionInfo, UsageWindow } from '../../proto.gen'

const bar: Record<Tone, string> = { ok: 'bg-accent', warn: 'bg-warning', danger: 'bg-danger' }

/** One labelled meter: name, percentage (toned) and reset time on top, a progress bar under it. */
function Meter({ label, pct, tone, hint }: { label: string; pct: number; tone: Tone; hint?: string }) {
  const value = Math.round(pct)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ink">{label}</span>
        <span className="tabular-nums">
          <span data-tone={tone} className={tone === 'ok' ? 'text-ink' : toneClass[tone]}>{`${value}%`}</span>
          {hint && <span className="text-muted-foreground">{` · ${hint}`}</span>}
        </span>
      </div>
      <Progress value={value} aria-label={`${label} ${value}%`} indicatorClassName={bar[tone]} />
    </div>
  )
}

function windowMeter(label: string, w: UsageWindow, now: number) {
  // a window Claude Code did not report has no reset time: show nothing rather than "0%"
  if (!w.resetsAt) return null
  const reset = resetIn(w.resetsAt, now)
  return <Meter key={label} label={label} pct={w.pct} tone={usageTone(w.pct)} hint={reset ? `resets in ${reset}` : undefined} />
}

/** The session account's 5 h and weekly meters, plus context and tokens; hidden when the session has no account. */
export default function UsageCard({ session: s, usage, now = Date.now() }: { session: SessionInfo; usage?: AccountUsage; now?: number }) {
  if (!s.account && !s.accountKey) return null
  const tokens = s.tokens && s.tokens.in + s.tokens.out > 0 ? `↑${formatTokens(s.tokens.in)} ↓${formatTokens(s.tokens.out)}` : ''
  const stale = !!usage && now - usage.at > USAGE_STALE_MS
  return (
    <InspectorCard title="Usage">
      <div className="flex flex-col gap-3 px-3 pt-1 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary" className="max-w-full truncate">{usage?.alias || s.account}</Badge>
          {stale && <span className="text-xs text-muted-foreground">not updated recently</span>}
        </div>
        {usage && (
          <div data-testid="inspector-usage" data-stale={stale ? '' : undefined} className={`flex flex-col gap-2.5 ${stale ? 'opacity-50' : ''}`}>
            {windowMeter('5-hour window', usage.fiveHour, now)}
            {windowMeter('Week', usage.sevenDay, now)}
          </div>
        )}
        {s.contextPct > 0 && (
          <Meter label={`Context${s.contextEstimate ? ' (estimate)' : ''}`} pct={s.contextPct} tone={contextTone(s.contextPct)} />
        )}
        {tokens && <div className="text-xs text-muted-foreground tabular-nums">{`Tokens ${tokens}`}</div>}
      </div>
    </InspectorCard>
  )
}
