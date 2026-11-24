import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheGeneration, cachedBytes, cacheLimits, clearCache, loadCached, saveCached } from './cache'
import type { Event } from '../proto.gen'

const hub = (seq: number, session = 's'): Event => ({ seq, session, ts: seq, kind: 'user', data: { text: 'x'.repeat(10) } })
const range = (a: number, b: number, session = 's') => Array.from({ length: b - a + 1 }, (_, i) => hub(a + i, session))
const hist = (key: string, ts: number): Event => ({ seq: 0, session: 's', ts, kind: 'user', data: { text: key }, key })

const defaults = { ...cacheLimits }
beforeEach(async () => { Object.assign(cacheLimits, defaults); await clearCache() })

describe('cache', () => {
  it('round-trips a session with its lastSeq; nothing cached reads as null', async () => {
    expect(await loadCached('s')).toBeNull()
    await saveCached('s', [hist('k', 1), ...range(1, 3)])
    const c = await loadCached('s')
    expect(c?.lastSeq).toBe(3)
    expect(c?.events.map((e) => e.key ?? e.seq)).toEqual(['k', 1, 2, 3])
  })
  it('keeps the newest 2,000 events per session', async () => {
    await saveCached('s', range(1, 2500))
    const c = await loadCached('s')
    expect(c?.events).toHaveLength(2000)
    expect(c?.events[0].seq).toBe(501)
  })
  it('merges a contiguous save with what is cached; a save past a gap replaces it', async () => {
    await saveCached('s', range(1, 10))
    await saveCached('s', range(8, 12))
    expect((await loadCached('s'))?.events.map((e) => e.seq)).toEqual(range(1, 12).map((e) => e.seq))
    await saveCached('s', range(40, 41))
    expect((await loadCached('s'))?.events.map((e) => e.seq)).toEqual([40, 41])
  })
  it('evicts the least recently opened sessions past the total size', async () => {
    cacheLimits.totalBytes = 3500 // two sessions of ~1.5 kB fit, three do not
    let t = 1000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (t += 10))
    await saveCached('a', range(1, 10, 'a'))
    await saveCached('b', range(1, 10, 'b'))
    await loadCached('a') // a is now the most recently opened
    await saveCached('c', range(1, 10, 'c'))
    expect(await loadCached('b')).toBeNull()
    expect(await loadCached('a')).not.toBeNull()
    expect(await loadCached('c')).not.toBeNull()
    now.mockRestore()
  })
  it('saving does not count as opening: a session written in the background goes first', async () => {
    cacheLimits.totalBytes = 3500
    let t = 1000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (t += 10))
    await saveCached('a', range(1, 10, 'a'))
    await loadCached('a')
    await saveCached('b', range(1, 10, 'b'))
    await loadCached('b')
    await saveCached('a', range(1, 11, 'a')) // a written again, but b was opened more recently
    await saveCached('c', range(1, 10, 'c')) // never opened
    expect(await loadCached('a')).toBeNull()
    expect(await loadCached('b')).not.toBeNull()
    now.mockRestore()
  })
  it('clearCache forgets everything', async () => {
    await saveCached('s', range(1, 3))
    await clearCache()
    expect(await loadCached('s')).toBeNull()
  })
})

describe('cache without storage', () => {
  const real = globalThis.indexedDB
  afterEach(() => { Object.assign(globalThis, { indexedDB: real }); vi.resetModules() })
  it('no IndexedDB (private mode): every call resolves without throwing', async () => {
    vi.resetModules()
    Object.assign(globalThis, { indexedDB: undefined })
    const c = await import('./cache')
    await expect(c.saveCached('s', range(1, 3))).resolves.toBeUndefined()
    await expect(c.loadCached('s')).resolves.toBeNull()
    await expect(c.clearCache()).resolves.toBeUndefined()
  })
  it('open throws (SecurityError) or writes fail (quota): network only, no throw', async () => {
    vi.resetModules()
    Object.assign(globalThis, { indexedDB: { open: () => { throw new DOMException('denied', 'SecurityError') }, deleteDatabase: () => { throw new Error('x') } } })
    const c = await import('./cache')
    await expect(c.saveCached('s', range(1, 3))).resolves.toBeUndefined()
    await expect(c.loadCached('s')).resolves.toBeNull()
    await expect(c.clearCache()).resolves.toBeUndefined()
  })
  it('a write that fails (quota) resolves and reads stay usable', async () => {
    vi.resetModules()
    const c = await import('./cache')
    await c.saveCached('q', range(1, 3))
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function () { throw new DOMException('full', 'QuotaExceededError') }
    try {
      await expect(c.saveCached('q', range(1, 5))).resolves.toBeUndefined()
    } finally { IDBObjectStore.prototype.put = put }
    expect((await c.loadCached('q'))?.lastSeq).toBe(3)
  })
})

describe('cache bookkeeping', () => {
  it('a save after clearCache started (logout) with events from before it is skipped', async () => {
    const gen = cacheGeneration()
    await saveCached('s', range(1, 3), gen)
    const clearing = clearCache()
    await saveCached('s', range(1, 5), gen) // a pending flush of the old session
    await clearing
    await saveCached('s', range(1, 6), gen) // still from before the clear
    expect(await loadCached('s')).toBeNull()
    await saveCached('s', range(1, 2), cacheGeneration())
    expect((await loadCached('s'))?.lastSeq).toBe(2)
  })
  it('the size estimate is incremental: a save serializes only the events it adds or drops', async () => {
    const mem = range(1, 1500)
    await saveCached('s', mem)
    const spy = vi.spyOn(JSON, 'stringify')
    try {
      await saveCached('s', [...mem, hub(1501)])
      expect(spy.mock.calls.length).toBeLessThan(20)
    } finally { spy.mockRestore() }
    // the estimate still matches a full count
    expect(await cachedBytes('s')).toBe(range(1, 1501).reduce((n, e) => n + JSON.stringify(e).length * 2, 0))
    await saveCached('s', range(1, 2500)) // past perSession: the oldest are dropped
    expect(await cachedBytes('s')).toBe(range(501, 2500).reduce((n, e) => n + JSON.stringify(e).length * 2, 0))
  })
})
