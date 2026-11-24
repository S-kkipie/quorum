import { Badge } from '@/components/ui/badge'
import { stateStyle } from '../lib/projects'
import { displayState, stateText } from '../lib/sessions'
import { useWakeClock } from '../lib/useWakeClock'
import type { SessionInfo } from '../proto.gen'

/** Session state as a small rounded pill: the detail when there is one ("2 tasks"), the label in its tooltip. */
export default function StatePill({ session }: { session: Pick<SessionInfo, 'state' | 'unread' | 'background'> }) {
  const d = displayState(session)
  const p = stateStyle(d)
  const { text, title } = stateText(session, useWakeClock([session]))
  return (
    <Badge title={title} aria-label={title} className={`min-w-0 gap-1.5 text-[11px] ring-1 ${p.pill}`}>
      {d !== 'idle' && d !== 'closed' && <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.dot}`} />}
      <span className="min-w-0 truncate">{text}</span>
    </Badge>
  )
}
