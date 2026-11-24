import { describe, expect, it } from 'vitest'
import { addEvents, evictEvents, freshHistory, idleSessions, initialState, mergeEvents, newestGap, oldestHubSeq, maxSeq, reduce, trimEvents } from './store'
import type { Event } from '../proto.gen'

const hub = (seq: number, kind = 'user', data: any = { text: 'h' + seq }, ts = 1_000_000 + seq * 1000): Event => ({ seq, session: 's', ts, kind, data })
const hist = (key: string, ts: number, kind = 'user', data: any = { text: key }): Event => ({ seq: 0, session: 's', ts, kind, data, key })

describe('history model: hub events by seq, machine history by key before them', () => {
  it('places machine history before the oldest hub event and dedupes by key', () => {
    const a = mergeEvents([hub(1), hub(2)], [hist('k2', 500), hist('k3', 600)])
    expect(a.map((e) => e.key ?? e.seq)).toEqual(['k2', 'k3', 1, 2])
    // an older page, oldest first, overlapping one key of the previous page
    const b = mergeEvents(a, [hist('k1', 400), hist('k2', 500)])
    expect(b.map((e) => e.key ?? e.seq)).toEqual(['k1', 'k2', 'k3', 1, 2])
  })
  it('a single history event never lands after hub events (backfill-only list)', () => {
    const l = mergeEvents([hub(-2, 'user', { text: 'a' }, 5000), hub(-1, 'user', { text: 'b' }, 6000)], [hist('k', 100)])
    expect(l.map((e) => e.key ?? e.seq)).toEqual(['k', -2, -1])
  })
  it('keeps page order for history events with the same ts', () => {
    const a = mergeEvents([hub(1)], [hist('x/0', 500), hist('x/1', 500), hist('x/2', 500)])
    expect(a.map((e) => e.key ?? e.seq)).toEqual(['x/0', 'x/1', 'x/2', 1])
  })
  it('live events still append in order and dedupe by seq', () => {
    let l = mergeEvents([hist('k', 1)], [hub(5)])
    l = mergeEvents(l, [hub(6)])
    l = mergeEvents(l, [hub(6), hub(4)])
    expect(l.map((e) => e.key ?? e.seq)).toEqual(['k', 4, 5, 6])
  })
  it('a live compact (no key) and the same compact from history (close ts) show once', () => {
    const live = hub(1, 'compact', { at: 100_000, trigger: 'auto' }, 100_400)
    const fromHistory = hist('c1/0', 99_000, 'compact', { at: 99_000, trigger: 'auto' })
    const far = hist('c0/0', 10_000, 'compact', { at: 10_000, trigger: 'manual' })
    const l = mergeEvents([live], [far, fromHistory])
    expect(l.filter((e) => e.kind === 'compact').map((e) => e.key ?? e.seq)).toEqual(['c0/0', 1])
  })
  it('history at or after the oldest hub event is already in the hub: dropped', () => {
    const l = mergeEvents([hub(1, 'user', { text: 'a' }, 5000)], [hist('old', 4000), hist('dup', 5000), hist('newer', 6000)])
    expect(l.map((e) => e.key ?? e.seq)).toEqual(['old', 1])
  })
  it('history within 5 s of a hub event with the same kind and content is the same event (skewed clocks)', () => {
    const live = [hub(1, 'user', { text: 'hello' }, 10_000), hub(2, 'tool_start', { id: 't', name: 'Bash', summary: 'ls' }, 12_000)]
    const l = mergeEvents(live, [
      hist('old', 1_000, 'user', { text: 'hello' }), // 9 s before: another prompt
      hist('dup', 9_000, 'user', { text: 'hello' }), // 1 s skew: the same prompt
      hist('other', 9_500, 'user', { text: 'different' }),
      hist('kind', 9_600, 'assistant', { text: 'hello' }),
      hist('tool', 9_700, 'tool_start', { id: 'x', name: 'Bash', summary: 'ls' }),
      hist('tool2', 9_800, 'tool_start', { id: 'y', name: 'Bash', summary: 'pwd' }),
      hist('empty', 9_900, 'user', {}), // nothing to compare: kept
    ])
    expect(l.map((e) => e.key ?? e.seq)).toEqual(['old', 'other', 'kind', 'tool2', 'empty', 1, 2])
  })
  it('freshHistory keeps only what a merge would add (keys, seam ts, skewed duplicates)', () => {
    const list = mergeEvents([hub(1, 'user', { text: 'hello' }, 10_000)], [hist('k1', 100)])
    const page = [hist('k0', 50), hist('k1', 100), hist('dup', 9_000, 'user', { text: 'hello' }), hist('after', 10_000)]
    expect(freshHistory(list, page, new Set(['k1'])).map((e) => e.key)).toEqual(['k0'])
    // a cache-only list without hub events: only keys count
    expect(freshHistory([hist('k1', 100)], page, new Set(['k1'])).map((e) => e.key)).toEqual(['k0', 'dup', 'after'])
  })
  it('prepending older pages keeps the order (pages interleaving by ts too)', () => {
    let l = mergeEvents([hub(1, 'user', { text: 'a' }, 100_000)], [hist('c', 300), hist('d', 400)])
    l = mergeEvents(l, [hist('a', 100), hist('b', 200)])
    l = mergeEvents(l, [hist('b2', 250), hist('e', 350)])
    expect(l.map((e) => e.key ?? e.seq)).toEqual(['a', 'b', 'b2', 'c', 'e', 'd', 1])
  })
  it('history survives a backfill-duplicate pass and the reducer', () => {
    let s = addEvents(initialState(), 's', [hub(1), hub(2)])
    s = addEvents(s, 's', [hist('k1', 10)])
    s = reduce(s, { type: 'event', machine: 'm', session: 's', payload: hub(3) })
    expect(s.events.s.map((e) => e.key ?? e.seq)).toEqual(['k1', 1, 2, 3])
  })
})

describe('paging helpers', () => {
  it('oldestHubSeq ignores history; maxSeq only counts positive seqs', () => {
    const l = [hist('k', 1), hub(-3), hub(-2), hub(1), hub(7)]
    expect(oldestHubSeq(l)).toBe(-3)
    expect(maxSeq(l)).toBe(7)
    expect(oldestHubSeq([hist('k', 1)])).toBeUndefined()
    expect(maxSeq([])).toBe(0)
  })
  it('newestGap finds the newest hole in the hub seqs', () => {
    expect(newestGap([hub(1), hub(2), hub(3)])).toBeNull()
    expect(newestGap([hub(1), hub(2), hub(10), hub(11), hub(20)])).toEqual({ after: 11, next: 20 })
    expect(newestGap([hist('k', 1), hub(5), hub(6)])).toBeNull()
  })
})

describe('memory caps', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => hub(i + 1))
  it('trimEvents keeps the newest max events', () => {
    const s = trimEvents(addEvents(initialState(), 's', [hist('k', 1), ...many(700)]), 's', { max: 600 })
    expect(s.events.s).toHaveLength(600)
    expect(s.events.s[0].seq).toBe(101)
  })
  it('trimEvents below drops history and every event older than the seq', () => {
    const s = trimEvents(addEvents(initialState(), 's', [hist('k', 1), ...many(10)]), 's', { below: 8 })
    expect(s.events.s.map((e) => e.seq)).toEqual([8, 9, 10])
  })
  it('trimEvents keepOldest drops the newest events (history first in the list stays)', () => {
    const s = trimEvents(addEvents(initialState(), 's', [hist('k', 1), ...many(10)]), 's', { keepOldest: 4 })
    expect(s.events.s.map((e) => e.key ?? e.seq)).toEqual(['k', 1, 2, 3])
  })
  it('trimEvents with nothing to drop keeps the state object', () => {
    const s = addEvents(initialState(), 's', many(3))
    expect(trimEvents(s, 's', { max: 600 })).toBe(s)
  })
  it('idle sessions: not open for 2 minutes (or never) and holding more than a page', () => {
    let s = addEvents(initialState(), 'a', many(80))
    s = addEvents(s, 'b', many(80).map((e) => ({ ...e, session: 'b' })))
    s = addEvents(s, 'c', many(80).map((e) => ({ ...e, session: 'c' })))
    s = addEvents(s, 'd', many(10).map((e) => ({ ...e, session: 'd' })))
    const now = 10_000_000
    const ids = idleSessions(s, 'a', { b: now - 60_000, c: now - 121_000 }, now)
    expect(ids).toEqual(['c'])
    const e = evictEvents(s, ids)
    expect(e.events.c).toHaveLength(50)
    expect(e.events.c[49].seq).toBe(80)
    expect(e.events.a).toHaveLength(80)
  })
})
