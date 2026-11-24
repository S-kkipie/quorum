import { Badge } from '@/components/ui/badge'
import { stateStyle } from '../lib/projects'
import { displayState, stateText } from '../lib/sessions'
import { useWakeClock } from '../lib/useWakeClock'
import type { SessionInfo } from '../proto.gen'

/** Session state as a small rounded pill: the detail when there is one ("2 tasks"), the label in its tooltip. */
export default function StatePill({ session, onPress }: { session: Pick<SessionInfo, 'state' | 'unread' | 'background'>; onPress?: () => void }) {
  const d = displayState(session)
  const p = stateStyle(d)
  const { text, title } = stateText(session, useWakeClock([session]))
  const pill = (
    <Badge title={title} aria-label={onPress ? undefined : title} className={`min-w-0 gap-1.5 text-xs font-medium ${p.pill}`}>
      {d !== 'idle' && d !== 'closed' && <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.dot}`} />}
      <span className="min-w-0 truncate">{text}</span>
    </Badge>
  )
  // a background session's pill opens its Background sheet (Plan 10)
  if (!onPress || (session.state !== 'background' && !session.background?.items?.length)) return pill
  return (
    <button type="button" onClick={onPress} title={title} aria-label={`${text}: show background work`}
      className="press relative inline-flex min-w-0 rounded-full after:absolute after:-inset-y-3 after:inset-x-0 after:content-['']">{pill}</button>
  )
}
