// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { Event, TranscriptPage } from '../proto.gen'

const api = vi.hoisted(() => ({
  listEvents: vi.fn(async (_id: string, _before: number, _limit: number): Promise<Event[]> => []),
  eventsAfter: vi.fn(async (_id: string, _after: number, _limit: number): Promise<Event[]> => []),
  history: vi.fn(async (_id: string, _cursor: string): Promise<TranscriptPage> => ({ events: [], cursor: '', done: true })),
}))
const cache = vi.hoisted(() => ({
  loadCached: vi.fn(async (_id: string): Promise<{ events: Event[]; lastSeq: number } | null> => null),
  saveCached: vi.fn(async (_id: string, _evs: Event[], _gen?: number) => {}),
}))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), ...api, usingDevApi: () => false }))
const gen = vi.hoisted(() => ({ n: 0 }))
vi.mock('./cache', () => ({ ...cache, cacheGeneration: () => gen.n }))

import { ApiError } from './api'
import { addEvents, initialState, isHistory, trimEvents, type AppState } from './store'
import { MAX_EMPTY_PAGES, MAX_SCROLLED, useSessionEvents } from './useSessionEvents'

const hub = (seq: number): Event => ({ seq, session: 's', ts: 1_000_000 + seq, kind: 'user', data: { text: 'h' + seq } })
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => hub(a + i))
const hist = (key: string, ts = 10): Event => ({ seq: 0, session: 's', ts, kind: 'user', data: { text: key }, key })

/** The hook over a real store slice, as the Session screen uses it; `push` delivers live events. */
let push: (evs: Event[]) => void = () => {}
function setup(initial: Event[] = [], reconnects = 0) {
  let st: AppState = addEvents(initialState(), 's', initial)
  const r = renderHook(({ rc }) => {
    const [s, set] = useState(st)
    push = (evs) => set((x) => addEvents(x, 's', evs))
    st = s
    const h = useSessionEvents({
      id: 's', events: s.events.s ?? [], reconnects: rc,
      onEvents: (id, evs) => set((x) => addEvents(x, id, evs)),
      onTrim: (id, o) => set((x) => trimEvents(x, id, o)),
    })
    return { ...h, events: s.events.s ?? [] }
  }, { initialProps: { rc: reconnects } })
  return r
}

beforeEach(() => {
  for (const f of [...Object.values(api), ...Object.values(cache)]) f.mockReset()
  api.listEvents.mockResolvedValue([])
  api.eventsAfter.mockResolvedValue([])
  api.history.mockResolvedValue({ events: [], cursor: '', done: true })
  cache.loadCached.mockResolvedValue(null)
  cache.saveCached.mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

describe('opening a session', () => {
  it('without cache: reads the newest hub page', async () => {
    api.listEvents.mockResolvedValueOnce(range(51, 100).reverse())
    const r = setup()
    await waitFor(() => expect(r.result.current.events).toHaveLength(50))
    expect(api.listEvents).toHaveBeenCalledWith('s', 0, 50)
    expect(api.eventsAfter).not.toHaveBeenCalled()
  })
  it('with cache: renders the cached events, then asks only for what came after lastSeq', async () => {
    cache.loadCached.mockResolvedValueOnce({ events: range(1, 40), lastSeq: 40 })
    api.eventsAfter.mockResolvedValueOnce(range(41, 45))
    const r = setup()
    await waitFor(() => expect(r.result.current.events).toHaveLength(45))
    expect(api.eventsAfter).toHaveBeenCalledWith('s', 40, 500)
    expect(api.listEvents).not.toHaveBeenCalled()
  })
  it('too far behind (a full delta): starts again from the newest page and drops the stale part', async () => {
    cache.loadCached.mockResolvedValueOnce({ events: range(1, 40), lastSeq: 40 })
    api.eventsAfter.mockResolvedValueOnce(range(41, 540))
    api.listEvents.mockResolvedValueOnce(range(951, 1000).reverse())
    const r = setup()
    await waitFor(() => expect(r.result.current.events[0]?.seq).toBe(951))
    expect(r.result.current.events).toHaveLength(50)
  })
  it('fills the hole between the cache and what the live feed brought while the session was not open', async () => {
    cache.loadCached.mockResolvedValueOnce({ events: range(1, 40), lastSeq: 40 })
    api.eventsAfter.mockImplementation(async (_id, after) => (after === 100 ? [] : after === 40 ? range(41, 90) : []))
    const r = setup(range(91, 100))
    await waitFor(() => expect(r.result.current.events).toHaveLength(100))
    expect(api.eventsAfter).toHaveBeenCalledWith('s', 40, 500)
  })
  it('a hub with nothing of the session reads the first page from the machine', async () => {
    api.history.mockResolvedValueOnce({ events: [hist('a/0'), hist('b/0')], cursor: '9', done: false })
    const r = setup()
    await waitFor(() => expect(r.result.current.events.map((e) => e.key)).toEqual(['a/0', 'b/0']))
    expect(api.history).toHaveBeenCalledWith('s', '')
  })
  it('after a reconnect: asks for what came after the newest seq', async () => {
    const r = setup(range(1, 10))
    await waitFor(() => expect(api.eventsAfter).toHaveBeenCalledTimes(1))
    api.eventsAfter.mockResolvedValueOnce(range(11, 12))
    r.rerender({ rc: 1 })
    await waitFor(() => expect(r.result.current.events).toHaveLength(12))
    expect(api.eventsAfter).toHaveBeenLastCalledWith('s', 10, 500)
  })
})

describe('older history', () => {
  it('walks hub pages, then machine pages to the start of the session, without duplicates at the seam', async () => {
    api.listEvents.mockImplementation(async (_id, before) => (before === 0 ? range(51, 100).reverse() : before === 51 ? range(1, 50).reverse() : []))
    const r = setup()
    await waitFor(() => expect(r.result.current.events).toHaveLength(50))
    await act(() => r.result.current.loadOlder())
    expect(r.result.current.events).toHaveLength(100)
    await act(() => r.result.current.loadOlder()) // hub has nothing older
    expect(api.listEvents).toHaveBeenLastCalledWith('s', 1, 50)
    api.history.mockResolvedValueOnce({ events: [hist('b/0', 30), hist('c/0', 40)], cursor: '200', done: false })
    await act(() => r.result.current.loadOlder())
    expect(api.history).toHaveBeenLastCalledWith('s', '')
    // the next page repeats one key of the previous one
    api.history.mockResolvedValueOnce({ events: [hist('a/0', 20), hist('b/0', 30)], cursor: '', done: true })
    await act(() => r.result.current.loadOlder())
    expect(api.history).toHaveBeenLastCalledWith('s', '200')
    expect(r.result.current.events.slice(0, 3).map((e) => e.key)).toEqual(['a/0', 'b/0', 'c/0'])
    expect(r.result.current.events).toHaveLength(103)
    expect(r.result.current.hasMore).toBe(false)
  })
  it('reads on through pages the hub filtered to nothing, at most 10 in a row, then offers Load earlier again', async () => {
    api.history.mockResolvedValue({ events: [], cursor: 'c', done: false })
    const r = setup()
    // the automatic first machine page (the hub is empty) reads 10 empty pages and stops
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(MAX_EMPTY_PAGES))
    await waitFor(() => expect(r.result.current.loading).toBe(false))
    await act(() => r.result.current.loadOlder())
    expect(api.history).toHaveBeenCalledTimes(2 * MAX_EMPTY_PAGES)
    expect(r.result.current.hasMore).toBe(true)
    expect(r.result.current.loading).toBe(false)
    api.history.mockReset()
    api.history.mockResolvedValueOnce({ events: [], cursor: 'd', done: false }).mockResolvedValueOnce({ events: [hist('z/0')], cursor: 'e', done: false })
    await act(() => r.result.current.loadOlder())
    expect(api.history).toHaveBeenCalledTimes(2)
    expect(r.result.current.events.map((e) => e.key)).toEqual(['z/0'])
  })
  it('each machine answer status gets its own outcome', async () => {
    const r = setup(range(1, 10))
    await waitFor(() => expect(api.eventsAfter).toHaveBeenCalled())
    await act(() => r.result.current.loadOlder()) // hub: nothing older
    // no answer in time: a notice, try again later
    api.history.mockRejectedValueOnce(new ApiError('Older history is on laptop, which did not respond.', 504, null))
    await act(() => r.result.current.loadOlder())
    expect(r.result.current.notice).toBe('Older history is on laptop, which did not respond.')
    expect(r.result.current.hasMore).toBe(true)
    expect(r.result.current.failed).toBe(false)
    // a cursor the machine refuses: an error, and paging restarts from its newest page
    api.history.mockRejectedValueOnce(new ApiError('invalid cursor', 400, null))
    await act(() => r.result.current.loadOlder())
    expect(r.result.current.failed).toBe(true)
    api.history.mockResolvedValueOnce({ events: [hist('a/0')], cursor: 'x', done: false })
    await act(() => r.result.current.loadOlder())
    expect(api.history).toHaveBeenLastCalledWith('s', '')
    // an old quorumd: done, with the message
    api.history.mockRejectedValueOnce(new ApiError('Update quorumd on laptop to load older history.', 404, null))
    await act(() => r.result.current.loadOlder())
    expect(r.result.current.hasMore).toBe(false)
    expect(r.result.current.notice).toBe('Update quorumd on laptop to load older history.')
  })
  it('no transcript on the machine: done, "No older history on the machine."', async () => {
    const r = setup(range(1, 10))
    await waitFor(() => expect(api.eventsAfter).toHaveBeenCalled())
    await act(() => r.result.current.loadOlder())
    api.history.mockRejectedValueOnce(new ApiError('No older history on the machine.', 404, null))
    await act(() => r.result.current.loadOlder())
    expect(r.result.current.hasMore).toBe(false)
    expect(r.result.current.notice).toBe('No older history on the machine.')
    expect(r.result.current.error).toBe('')
  })
  it('an offline machine is a notice, not an error', async () => {
    const r = setup(range(1, 10))
    await waitFor(() => expect(api.eventsAfter).toHaveBeenCalled())
    await act(() => r.result.current.loadOlder()) // hub: nothing older
    api.history.mockRejectedValueOnce(new ApiError('Older history is on laptop, which is offline.', 409, null))
    await act(() => r.result.current.loadOlder())
    expect(r.result.current.notice).toBe('Older history is on laptop, which is offline.')
    expect(r.result.current.error).toBe('')
    expect(r.result.current.failed).toBe(false)
    expect(r.result.current.hasMore).toBe(true)
  })
})

describe('seam on a cache-only device', () => {
  it('machine pages the merge drops (what the cache holds) do not count as new: paging reads on', async () => {
    cache.loadCached.mockResolvedValueOnce({ events: range(1, 40), lastSeq: 40 })
    // the hub kept nothing (retention): the newest machine page repeats what the cache holds
    api.history.mockImplementation(async (_id, cursor) => (cursor === ''
      ? { events: [hist('n1', 1_000_001), hist('n2', 1_000_002)], cursor: 'c1', done: false }
      : { events: [hist('o1', 10)], cursor: '', done: true }))
    const r = setup()
    await waitFor(() => expect(r.result.current.events).toHaveLength(40))
    await act(() => r.result.current.loadOlder()) // hub: nothing older
    await act(() => r.result.current.loadOlder())
    expect(api.history.mock.calls.map(([, c]) => c)).toEqual(['', 'c1'])
    expect(r.result.current.events.map((e) => e.key).filter(Boolean)).toEqual(['o1'])
  })
})

describe('memory while scrolled up', () => {
  /** Machine pages of 100 events, each older than the previous one. */
  const pages = () => api.history.mockImplementation(async (_id, cursor) => {
    const n = cursor ? Number(cursor) : 0
    const evs = Array.from({ length: 100 }, (_, i) => hist(`p${n}-${i}`, 1_000_000 - (n + 1) * 1000 + i))
    return { events: evs, cursor: String(n + 1), done: false }
  })
  it('walking 40 pages keeps at most 3,000 events; back at the bottom the newest are restored', async () => {
    const r = setup(range(1, 100))
    await waitFor(() => expect(api.eventsAfter).toHaveBeenCalled())
    act(() => r.result.current.setAtBottom(false))
    await act(() => r.result.current.loadOlder()) // hub: nothing older
    pages()
    for (let i = 0; i < 40; i++) {
      await act(() => r.result.current.loadOlder())
      expect(r.result.current.events.length).toBeLessThanOrEqual(MAX_SCROLLED)
    }
    expect(api.history).toHaveBeenCalledTimes(40)
    // the oldest pages read are what is kept; the newest (far below) went
    expect(r.result.current.events[0].key).toBe('p39-0')
    expect(r.result.current.events.some((e) => e.seq === 100)).toBe(false)
    expect(r.result.current.lastSeq).toBe(100) // seen marks still know the newest seq
    // a live event while scrolled up: counted for seen marks, not kept in memory
    act(() => push([hub(101)]))
    expect(r.result.current.events.length).toBeLessThanOrEqual(MAX_SCROLLED)
    expect(r.result.current.lastSeq).toBe(101)
    api.listEvents.mockResolvedValueOnce(range(52, 101).reverse())
    act(() => r.result.current.setAtBottom(true))
    await waitFor(() => expect(r.result.current.events.at(-1)?.seq).toBe(101))
    expect(api.listEvents).toHaveBeenLastCalledWith('s', 0, 50)
    expect(r.result.current.events.length).toBeLessThanOrEqual(600)
    expect(r.result.current.events.some(isHistory)).toBe(false)
  })
  it('a failing restore is asked once (no loop while offline); Try again or a reconnect asks again', async () => {
    const r = setup(range(1, 100))
    await waitFor(() => expect(api.eventsAfter).toHaveBeenCalled())
    act(() => r.result.current.setAtBottom(false))
    await act(() => r.result.current.loadOlder()) // hub: nothing older
    pages()
    for (let i = 0; i < 30; i++) await act(() => r.result.current.loadOlder())
    expect(r.result.current.events.some((e) => e.seq === 100)).toBe(false)
    const slowFail = async (): Promise<Event[]> => { await new Promise((res) => setTimeout(res, 20)); throw new Error('offline') }
    api.listEvents.mockReset()
    api.listEvents.mockImplementation(slowFail)
    act(() => r.result.current.setAtBottom(true))
    await waitFor(() => expect(r.result.current.restoreFailed).toBe(true))
    await act(() => new Promise((res) => setTimeout(res, 100)))
    expect(api.listEvents).toHaveBeenCalledTimes(1)
    expect(r.result.current.loading).toBe(false)
    // Try again: exactly one more request
    await act(async () => { r.result.current.retryNewest() })
    await waitFor(() => expect(api.listEvents).toHaveBeenCalledTimes(2))
    await act(() => new Promise((res) => setTimeout(res, 100)))
    expect(api.listEvents).toHaveBeenCalledTimes(2)
    // a reconnect of the live feed: one more, and this time it works
    api.listEvents.mockResolvedValueOnce(range(51, 100).reverse())
    r.rerender({ rc: 1 })
    await waitFor(() => expect(r.result.current.events.at(-1)?.seq).toBe(100))
    expect(api.listEvents).toHaveBeenCalledTimes(3)
    expect(r.result.current.restoreFailed).toBe(false)
  })
  it('a small hole after the kept events is filled with eventsAfter', async () => {
    const r = setup(range(1, 100))
    await waitFor(() => expect(api.eventsAfter).toHaveBeenCalled())
    act(() => r.result.current.setAtBottom(false))
    act(() => push(range(101, MAX_SCROLLED - 10))) // live while scrolled up: under the cap
    await act(() => r.result.current.loadOlder()) // hub: nothing older
    pages()
    await act(() => r.result.current.loadOlder()) // +100: the newest 90 hub events go
    expect(r.result.current.events.length).toBe(MAX_SCROLLED)
    expect(r.result.current.events.at(-1)?.seq).toBe(MAX_SCROLLED - 100)
    api.eventsAfter.mockResolvedValueOnce(range(MAX_SCROLLED - 99, MAX_SCROLLED - 10))
    act(() => r.result.current.setAtBottom(true))
    await waitFor(() => expect(r.result.current.events.at(-1)?.seq).toBe(MAX_SCROLLED - 10))
    expect(api.eventsAfter).toHaveBeenLastCalledWith('s', MAX_SCROLLED - 100, 500)
  })
})

describe('memory', () => {
  it('back at the bottom with more than 600 events: keeps the newest 600 and pages again from the hub', async () => {
    const r = setup(range(1, 700))
    await waitFor(() => expect(r.result.current.events).toHaveLength(600))
    expect(r.result.current.events[0].seq).toBe(101)
    act(() => r.result.current.setAtBottom(false))
    api.listEvents.mockResolvedValueOnce(range(51, 100).reverse())
    await act(() => r.result.current.loadOlder())
    expect(api.listEvents).toHaveBeenLastCalledWith('s', 101, 50)
    // scrolled up there: nothing is dropped
    expect(r.result.current.events).toHaveLength(650)
    act(() => r.result.current.setAtBottom(true))
    expect(r.result.current.events).toHaveLength(600)
  })
  it('saves to the cache a moment after changes and when the session is left', async () => {
    vi.useFakeTimers()
    const r = setup(range(1, 5))
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    expect(cache.saveCached).toHaveBeenCalledWith('s', expect.arrayContaining([expect.objectContaining({ seq: 5 })]), 0)
    const n = cache.saveCached.mock.calls.length
    r.unmount()
    expect(cache.saveCached.mock.calls.length).toBe(n) // nothing new to write
  })
})

describe('cache writes on leave', () => {
  /** The hook as the Session screen keeps it across /clear: same component, the id changes. */
  function two() {
    let st: AppState = addEvents(addEvents(initialState(), 'a', range(1, 3).map((e) => ({ ...e, session: 'a' }))), 'b', range(1, 9).map((e) => ({ ...e, session: 'b' })))
    return renderHook(({ id }) => {
      const [s, set] = useState(st)
      st = s
      return useSessionEvents({ id, events: s.events[id] ?? [], reconnects: 0, onEvents: (i, evs) => set((x) => addEvents(x, i, evs)) })
    }, { initialProps: { id: 'a' } })
  }
  const savedFor = (id: string) => cache.saveCached.mock.calls.filter(([i]) => i === id).map(([, evs]) => evs.length)

  it('an id change with unsaved events saves each session under its own id only', async () => {
    const r = two()
    await waitFor(() => expect(api.eventsAfter).toHaveBeenCalled())
    r.rerender({ id: 'b' })
    expect(savedFor('a')).toEqual([3])
    r.unmount()
    expect(savedFor('b')).toEqual([9])
    expect(savedFor('a')).toEqual([3])
  })
  it('unsaved events are written when the session is left', async () => {
    const r = setup(range(1, 4))
    await waitFor(() => expect(api.eventsAfter).toHaveBeenCalled())
    expect(cache.saveCached).not.toHaveBeenCalled()
    r.unmount()
    expect(cache.saveCached).toHaveBeenCalledTimes(1)
    expect(cache.saveCached.mock.calls[0][1]).toHaveLength(4)
  })
  it('unsaved events carry the cache generation they were gathered in (a logout clear skips them)', async () => {
    gen.n = 3
    const r = setup(range(1, 4))
    await waitFor(() => expect(api.eventsAfter).toHaveBeenCalled())
    gen.n = 4 // clearCache started
    r.unmount()
    expect(cache.saveCached.mock.calls[0][2]).toBe(3)
    gen.n = 0
  })
  it('unsaved events are written when the page is hidden, once', async () => {
    const r = setup(range(1, 4))
    await waitFor(() => expect(api.eventsAfter).toHaveBeenCalled())
    window.dispatchEvent(new Event('pagehide'))
    expect(cache.saveCached).toHaveBeenCalledTimes(1)
    expect(cache.saveCached.mock.calls[0][0]).toBe('s')
    r.unmount()
    expect(cache.saveCached).toHaveBeenCalledTimes(1)
  })
})

describe('machine cursor', () => {
  it('after memory is trimmed, the machine pages resume at the seam instead of the newest page', async () => {
    api.listEvents.mockImplementation(async (_id, before) => (before === 0 ? range(661, 710).reverse() : []))
    const r = setup(range(1, 700).map((e) => ({ ...e, seq: e.seq + 10 })))
    await waitFor(() => expect(api.eventsAfter).toHaveBeenCalled())
    act(() => r.result.current.setAtBottom(false))
    api.listEvents.mockResolvedValue([])
    api.history.mockResolvedValueOnce({ events: [], cursor: 'seam', done: false }).mockResolvedValueOnce({ events: [hist('k1')], cursor: 'older', done: false })
    await act(() => r.result.current.loadOlder()) // hub: nothing older
    await act(() => r.result.current.loadOlder()) // machine: an empty page, then one with events at 'seam'
    expect(api.history.mock.calls.map(([, c]) => c)).toEqual(['', 'seam'])
    act(() => r.result.current.setAtBottom(true)) // trims: the history event goes
    await waitFor(() => expect(r.result.current.events.some((e) => e.key === 'k1')).toBe(false))
    act(() => r.result.current.setAtBottom(false))
    api.history.mockResolvedValueOnce({ events: [hist('k1')], cursor: 'older', done: false })
    await act(() => r.result.current.loadOlder()) // hub (same oldest): nothing older
    await act(() => r.result.current.loadOlder())
    expect(api.history.mock.calls.map(([, c]) => c)).toEqual(['', 'seam', 'seam'])
  })
})
