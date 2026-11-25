import { Win } from '../UsageStrip'
import InspectorCard from './InspectorCard'
import { USAGE_STALE_MS, contextTone, formatTokens, toneClass } from '../../lib/meters'
import type { AccountUsage, SessionInfo } from '../../proto.gen'

/** The session account's 5 h and weekly meters, plus context and tokens; hidden when the session has no account. */
export default function UsageCard({ session: s, usage, now = Date.now() }: { session: SessionInfo; usage?: AccountUsage; now?: number }) {
  if (!s.account && !s.accountKey) return null
  const tone = contextTone(s.contextPct)
  const tokens = s.tokens && s.tokens.in + s.tokens.out > 0 ? `↑${formatTokens(s.tokens.in)} ↓${formatTokens(s.tokens.out)}` : ''
  const stale = !!usage && now - usage.at > USAGE_STALE_MS
  return (
    <InspectorCard title="Usage">
      <div className="flex flex-col gap-1 px-3 pt-0.5 pb-2.5 text-xs">
        <div className="truncate font-medium text-ink">{usage?.alias || s.account}</div>
        {usage && (
          <div data-testid="inspector-usage" data-stale={stale ? '' : undefined} className={`flex flex-col gap-0.5 ${stale ? 'opacity-50' : ''}`}>
            <Win label="5h" w={usage.fiveHour} now={now} />
            <Win label="week" w={usage.sevenDay} now={now} />
          </div>
        )}
        {s.contextPct > 0 && <span data-tone={tone} className={toneClass[tone]}>{`Context ${s.contextEstimate ? '~' : ''}${Math.round(s.contextPct)}%`}</span>}
        {tokens && <span className="text-muted-foreground">{tokens}</span>}
      </div>
    </InspectorCard>
  )
}
