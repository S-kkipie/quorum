import { useCallback, useEffect, useRef, useState } from 'react'
import { seen } from './api'

/** Longest a new event waits before the hub hears the session was seen (its "done" grace is 5 s). */
export const SEEN_DEBOUNCE_MS = 2000

/**
 * Marks a session seen up to lastSeq while it is open and the page is visible: at once the first
 * time, then at most every 2 s as events arrive, and again when the page becomes visible. Never
 * while hidden. onSeen runs once the hub accepted a mark, so the caller can clear "unread" locally
 * before the hub's upsert arrives. A failed mark is retried 2 s later (while still open).
 */
interface Mark { id: string; sent: number; latest: number; timer?: ReturnType<typeof setTimeout>; dead?: boolean }

export function useMarkSeen(id: string, lastSeq: number, active: boolean, onSeen?: (id: string) => void) {
  const r = useRef<Mark>({ id, sent: 0, latest: 0 })
  const cb = useRef(onSeen)
  cb.current = onSeen
  const flush = useCallback(() => {
    const x = r.current
    clearTimeout(x.timer)
    x.timer = undefined
    if (document.visibilityState !== 'visible' || x.latest <= x.sent) return
    const prev = x.sent
    const seq = (x.sent = x.latest)
    seen(x.id, seq).then(
      () => { if (!x.dead) cb.current?.(x.id) },
      () => {
        if (x.dead) return
        if (x.sent === seq) x.sent = prev // nothing newer went out: this seq is still owed
        if (!x.timer) x.timer = setTimeout(flush, SEEN_DEBOUNCE_MS)
      },
    )
  }, [])
  useEffect(() => {
    const x: Mark = (r.current = { id, sent: 0, latest: 0 })
    return () => { x.dead = true; clearTimeout(x.timer) }
  }, [id])
  useEffect(() => {
    const x = r.current
    if (!active || lastSeq <= 0) return
    x.latest = lastSeq
    if (x.sent === 0) flush()
    else if (!x.timer) x.timer = setTimeout(flush, SEEN_DEBOUNCE_MS)
  }, [id, lastSeq, active, flush])
  useEffect(() => {
    const h = () => { if (active) flush() }
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }, [active, flush])
}

/** Whether the page is visible, updated on visibilitychange. */
export function usePageVisible() {
  const [v, setV] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const h = () => setV(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }, [])
  return v
}
