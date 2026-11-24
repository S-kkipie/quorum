import { useEffect, useState } from 'react'
import type { SessionInfo } from '../proto.gen'
import { nextWake } from './sessions'

/**
 * "Now" for state labels: re-renders when a shown "wakes HH:MM" turns into "waking up" (checked at
 * least every minute while such a label is shown; no timer otherwise).
 */
export function useWakeClock(list: Pick<SessionInfo, 'state' | 'background'>[]): number {
  const [now, setNow] = useState(Date.now)
  const next = nextWake(list, now)
  useEffect(() => {
    if (!next) return
    const t = setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, next - Date.now()) + 50, 60_000))
    return () => clearTimeout(t)
  }, [next, now])
  return now
}
