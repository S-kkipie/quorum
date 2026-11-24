import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, eventsAfter, history, listEvents, usingDevApi } from './api'
import { cacheGeneration, loadCached, saveCached } from './cache'
import { freshHistory, isHistory, maxSeq, mergeEvents, newestGap, oldestHubSeq } from './store'
import type { Event } from '../proto.gen'

/** Events per hub page (newest first). */
export const PAGE = 50
/** Most events a delta (`after=`) answer holds; a full one means more were missed. */
export const DELTA = 500
/** Events kept in memory per open session once the reader is back at the bottom. */
export const MAX_EVENTS = 600
/**
 * Most events kept in memory while the reader is scrolled up: past it the newest go (they are far
 * below the viewport) and are read again (eventsAfter, or the newest hub page) back at the bottom.
 */
export const MAX_SCROLLED = 3000
/** Machine pages that brought nothing new (filtered by the hub) read in a row before asking the reader. */
export const MAX_EMPTY_PAGES = 10
/** Cache writes wait this long after the last change. */
const SAVE_MS = 2000

export type Trim = { max?: number; below?: number; keepOldest?: number }

/**
 * Loads and keeps a session's events: renders from the local cache at once, then fetches only what
 * is newer (`after=lastSeq`, again after every reconnect of the live feed), fills a hole left while
 * the session was not open, and pages older history on demand — hub pages first, then pages read
 * from the session's machine until the start of the session. Memory is capped at MAX_EVENTS while
 * the reader is at the bottom and at MAX_SCROLLED while scrolled up (dropped events are read again
 * from the cache, hub or machine). `lastSeq` is the newest hub seq known, also when the newest
 * events were dropped (seen marks).
 */
export function useSessionEvents({ id, events, reconnects, onEvents, onTrim }: {
  id: string
  events: Event[]
  reconnects: number
  onEvents: (id: string, evs: Event[]) => void
  onTrim?: (id: string, o: Trim) => void
}) {
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [failed, setFailed] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(atBottom)
  atBottomRef.current = atBottom
  // the newest hub seq seen, also once those events were dropped while scrolled up
  const [newest, setNewest] = useState(0)
  // restoring the newest events failed: not retried until Try again (retryNewest) or a reconnect
  const [restoreFailed, setRestoreFailed] = useState(false)

  const ev = useRef(events)
  ev.current = events
  const cbs = useRef({ onEvents, onTrim })
  cbs.current = { onEvents, onTrim }
  /** Older history goes through the hub's pages, then the machine's, until done. */
  const paging = useRef<{ phase: 'hub' | 'machine' | 'done'; cursor: string }>({ phase: 'hub', cursor: '' })
  /**
   * Where the machine's pages first brought events, for the hub window that ended at hubOldest:
   * after memory is trimmed, paging resumes there instead of reading the newest pages again.
   */
  const seam = useRef<{ hubOldest: number; cursor: string } | null>(null)
  const hubOldest = useRef(0)
  const busy = useRef(false)
  /** The newest events were dropped while scrolled up: they are read again back at the bottom. */
  const cut = useRef(false)
  /** History keys in memory (kept as pages come; rebuilt after a trim). */
  const keys = useRef<Set<string> | null>(null)
  // the id the async work started for: answers for a session no longer shown are dropped
  const live = useRef(id)
  live.current = id
  const cache = !usingDevApi()

  const trim = useCallback((sid: string, o: Trim) => {
    keys.current = null
    cbs.current.onTrim?.(sid, o)
  }, [])

  const restartPaging = useCallback(() => {
    paging.current = { phase: 'hub', cursor: '' }
    setHasMore(true)
    setNotice('')
  }, [])

  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : 'error')
    setFailed(true)
  }

  /**
   * One step of older history: a hub page, or machine pages until one brings something new (the hub
   * filters out what it holds itself, so a page can come back empty without being the last), at most
   * MAX_EMPTY_PAGES in a row before the reader is asked again.
   */
  const loadOlder = useCallback(async () => {
    if (busy.current || paging.current.phase === 'done') return
    busy.current = true
    const sid = id
    setLoading(true)
    setNotice('')
    try {
      setFailed(false)
      if (paging.current.phase === 'hub') {
        const page = await listEvents(sid, oldestHubSeq(ev.current) ?? 0, PAGE)
        if (live.current !== sid) return
        if (page.length) cbs.current.onEvents(sid, page)
        if (page.length < PAGE) {
          const oldest = Math.min(oldestHubSeq(ev.current) ?? 0, ...page.map((e) => e.seq))
          hubOldest.current = oldest
          paging.current = { phase: 'machine', cursor: seam.current?.hubOldest === oldest ? seam.current.cursor : '' }
        }
        return
      }
      for (let empty = 0; empty < MAX_EMPTY_PAGES;) {
        const cursor = paging.current.cursor
        const p = await history(sid, cursor)
        if (live.current !== sid) return
        if (p.events?.length && seam.current?.hubOldest !== hubOldest.current) seam.current = { hubOldest: hubOldest.current, cursor }
        let known = keys.current
        if (!known) {
          known = keys.current = new Set()
          for (const e of ev.current) { if (!isHistory(e)) break; if (e.key) known.add(e.key) }
        }
        // only what the merge keeps is new (the same seam: a page of what the hub or cache holds is empty)
        const fresh = freshHistory(ev.current, p.events ?? [], known)
        for (const e of fresh) if (e.key) known.add(e.key)
        if (fresh.length) cbs.current.onEvents(sid, fresh)
        if (p.done || !p.cursor) {
          paging.current = { phase: 'done', cursor: '' }
          setHasMore(false)
          return
        }
        paging.current = { phase: 'machine', cursor: p.cursor }
        if (fresh.length) return
        empty++
      }
    } catch (e) {
      if (live.current !== sid) return
      const status = e instanceof ApiError ? e.status : 0
      const machine = paging.current.phase === 'machine'
      if (status === 409 || status === 504) setNotice((e as Error).message) // offline or no answer: not an error, try again later
      else if (status === 404 && machine) {
        // no transcript on the machine, or a quorumd too old to read it: nothing older to load
        paging.current = { phase: 'done', cursor: '' }
        setHasMore(false)
        setNotice((e as Error).message || 'No older history on the machine.')
      } else {
        // a cursor the machine refuses (its transcript changed): the next try starts from its newest page
        if (status === 400 && machine) paging.current = { phase: 'machine', cursor: '' }
        fail(e)
      }
    } finally {
      if (live.current === sid) { busy.current = false; setLoading(false) }
    }
  }, [id])

  /**
   * Brings the session up to date from what is in memory (and cache): the newest events after the
   * last known seq, then the newest hole. A hole too big to fill drops what is older than it.
   */
  const syncNewest = useCallback(async (sid: string, mem: Event[]) => {
    const top = maxSeq(mem)
    if (!top) {
      const page = await listEvents(sid, 0, PAGE)
      if (live.current !== sid) return
      if (page.length) cbs.current.onEvents(sid, page)
      if (page.length < PAGE) {
        paging.current = { phase: 'machine', cursor: '' }
        // the hub holds nothing of this session: the first page comes from its machine
        if (!page.length && !mem.length) await loadOlder()
      }
      return
    }
    const d = await eventsAfter(sid, top, DELTA)
    if (live.current !== sid) return
    if (d.length >= DELTA) {
      // too far behind: start again from the newest page
      const page = await listEvents(sid, 0, PAGE)
      if (live.current !== sid) return
      if (page.length) {
        cbs.current.onEvents(sid, page)
        trim(sid, { below: Math.min(...page.map((e) => e.seq)) })
        restartPaging()
      }
      return
    }
    if (d.length) cbs.current.onEvents(sid, d)
    const gap = newestGap(mergeEvents(mem, d))
    if (!gap) return
    if (gap.next - gap.after - 1 > DELTA) {
      trim(sid, { below: gap.next })
      restartPaging()
      return
    }
    const fill = await eventsAfter(sid, gap.after, DELTA)
    if (live.current === sid && fill.length) cbs.current.onEvents(sid, fill)
  }, [loadOlder, restartPaging, trim])

  // On open: cache first, then only what is newer.
  useEffect(() => {
    let off = false
    paging.current = { phase: 'hub', cursor: '' }
    seam.current = null
    busy.current = false
    cut.current = false
    keys.current = null
    setNewest(0)
    setRestoreFailed(false)
    setHasMore(true)
    setLoading(false)
    setNotice('')
    setError('')
    setFailed(false)
    ;(async () => {
      let mem = ev.current
      if (cache) {
        const c = await loadCached(id)
        if (off) return
        if (c?.events.length) {
          cbs.current.onEvents(id, c.events)
          mem = mergeEvents(mem, c.events)
        }
      }
      await syncNewest(id, mem)
    })().catch((e) => { if (!off) fail(e) })
    return () => { off = true }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // After a reconnect of the live feed: what was missed meanwhile.
  const seenReconnects = useRef(reconnects)
  useEffect(() => {
    if (reconnects === seenReconnects.current) return
    seenReconnects.current = reconnects
    if (cut.current) {
      // the newest are read again back at the bottom; a failed attempt is retried now
      if (atBottomRef.current) { setRestoreFailed(false); void restoreNewest(id) }
      return
    }
    syncNewest(id, ev.current).catch(fail)
  }, [reconnects]) // eslint-disable-line react-hooks/exhaustive-deps

  // Scrolled up with too much in memory: drop the newest (far below); seen marks keep their seq.
  useEffect(() => {
    if (atBottom || events.length <= MAX_SCROLLED) return
    const top = maxSeq(events)
    setNewest((n) => Math.max(n, top))
    cut.current = true
    trim(id, { keepOldest: MAX_SCROLLED })
  }, [atBottom, events]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Back at the bottom after the newest were dropped: a small hole after the kept events is filled
   * with eventsAfter, else the newest hub page replaces what is in memory (paging starts again).
   */
  const restoreNewest = useCallback(async (sid: string) => {
    if (busy.current) return
    busy.current = true
    setLoading(true)
    try {
      const top = maxSeq(ev.current)
      if (top > 0 && newest - top <= DELTA) {
        const d = await eventsAfter(sid, top, DELTA)
        if (live.current !== sid) return
        if (d.length) cbs.current.onEvents(sid, d)
        if (d.length < DELTA) { cut.current = false; return }
      }
      const page = await listEvents(sid, 0, PAGE)
      if (live.current !== sid) return
      if (page.length) {
        cbs.current.onEvents(sid, page)
        trim(sid, { below: Math.min(...page.map((e) => e.seq)) })
      }
      restartPaging()
      cut.current = false
      setRestoreFailed(false)
    } catch (e) {
      if (live.current === sid) { setRestoreFailed(true); fail(e) }
    } finally {
      if (live.current === sid) { busy.current = false; setLoading(false) }
    }
  }, [newest, restartPaging, trim])

  /** Try again after a failed restore of the newest events: one request. */
  const retryNewest = useCallback(() => {
    if (!cut.current) return
    setRestoreFailed(false)
    setError('')
    setFailed(false)
    void restoreNewest(id)
  }, [id, restoreNewest])

  // Back at the bottom with too much in memory: drop the oldest; paging older starts again.
  useEffect(() => {
    if (!atBottom || loading) return
    if (cut.current) { if (!restoreFailed) void restoreNewest(id); return }
    if (events.length <= MAX_EVENTS) return
    trim(id, { max: MAX_EVENTS })
    restartPaging()
  }, [atBottom, loading, restoreFailed, events.length > MAX_EVENTS]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cache: written a moment after changes, and when the session is left or the page hidden.
  // The unsaved events carry the id they belong to: after /clear or /resume the same view shows
  // another id, and what is left to write must still go under the old one.
  // The cache generation goes with them: after a logout cleared the cache they are not written.
  const dirty = useRef<{ id: string; events: Event[]; gen: number } | null>(null)
  const flush = useCallback(() => {
    const d = dirty.current
    dirty.current = null
    if (d) saveCached(d.id, d.events, d.gen)
  }, [])
  useEffect(() => {
    if (!cache || !events.length) return
    dirty.current = { id, events, gen: dirty.current?.gen ?? cacheGeneration() }
    const t = setTimeout(flush, SAVE_MS)
    return () => clearTimeout(t)
  }, [events]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!cache) return
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush); flush() }
  }, [id, cache, flush])

  return { hasMore, loading, notice, error, setError, failed, loadOlder, setAtBottom, lastSeq: Math.max(newest, maxSeq(events)), restoreFailed, retryNewest }
}
