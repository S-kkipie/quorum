import type { Event } from '../proto.gen'
import { maxSeq, mergeEvents } from './store'

/**
 * Local event cache per device (IndexedDB): each session keeps its newest events and its lastSeq,
 * so opening a session renders at once and then asks the hub only for what came after. Bounded per
 * session and in total (least recently opened sessions go first). Every access is guarded: with no
 * IndexedDB (private mode), a refused open or a full quota, calls resolve as if nothing was cached
 * and the app works from the network only.
 */

const DB = 'quorum-cache'
const META = 'meta'
const EVENTS = 'events'

export const cacheLimits = { perSession: 2000, totalBytes: 50 * 1024 * 1024 }

interface Meta { id: string; lastSeq: number; openedAt: number; bytes: number }
interface Row { id: string; events: Event[] }
export interface Cached { events: Event[]; lastSeq: number }

let dbp: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp
  dbp = new Promise((resolve) => {
    try {
      const idb = globalThis.indexedDB
      if (!idb) return resolve(null)
      const r = idb.open(DB, 1)
      r.onupgradeneeded = () => {
        const d = r.result
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'id' })
        if (!d.objectStoreNames.contains(EVENTS)) d.createObjectStore(EVENTS, { keyPath: 'id' })
      }
      r.onsuccess = () => {
        const d = r.result
        // another tab deletes the database (unpair): let it
        d.onversionchange = () => { d.close(); dbp = null }
        resolve(d)
      }
      r.onerror = () => resolve(null)
      r.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbp
}

const wait = <T,>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
const done = (tx: IDBTransaction): Promise<void> => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error) })

/** The cached events of a session (null when none or no storage); marks it as just opened. */
export async function loadCached(id: string): Promise<Cached | null> {
  try {
    const d = await open()
    if (!d) return null
    const tx = d.transaction([META, EVENTS], 'readwrite')
    const [meta, row] = await Promise.all([wait(tx.objectStore(META).get(id)) as Promise<Meta | undefined>, wait(tx.objectStore(EVENTS).get(id)) as Promise<Row | undefined>])
    if (!meta || !row?.events?.length) return null
    tx.objectStore(META).put({ ...meta, openedAt: Date.now() })
    await done(tx)
    return { events: row.events, lastSeq: meta.lastSeq }
  } catch {
    return null
  }
}

/** First live seq of a list (history and backfill have none). */
const firstLive = (l: Event[]): number | undefined => l.find((e) => e.seq > 0)?.seq

/**
 * Bumped when clearCache starts (logout, unpair): a save of events gathered before it (a flush
 * still pending in a screen) passes the generation it read and is skipped, so the database is
 * never refilled after it was cleared.
 */
let generation = 0
export const cacheGeneration = (): number => generation

/** Estimated bytes of an event, serialized once per event object. */
const sizes = new WeakMap<Event, number>()
const sizeOf = (e: Event): number => {
  let n = sizes.get(e)
  if (n === undefined) { n = JSON.stringify(e).length * 2; sizes.set(e, n) }
  return n
}
/** An event's identity in a session (the same identity is the same event, of the same size). */
const ident = (e: Event): string => (e.seq ? `s${e.seq}` : `k${e.key ?? ''}@${e.ts}`)

/**
 * The size of list, from the size of old (its known bytes): only the events added or dropped are
 * counted (and serialized at most once each), never the whole list on every save.
 */
function bytesOf(list: Event[], old: Event[], oldBytes: number | undefined): number {
  if (!old.length || oldBytes === undefined) return list.reduce((n, e) => n + sizeOf(e), 0)
  const was = new Set(old.map(ident))
  const now = new Set<string>()
  let n = oldBytes
  for (const e of list) { const k = ident(e); now.add(k); if (!was.has(k)) n += sizeOf(e) }
  for (const e of old) if (!now.has(ident(e))) n -= sizeOf(e)
  return n
}

/** The estimated bytes a session holds in the cache (tests). */
export async function cachedBytes(id: string): Promise<number | undefined> {
  const d = await open()
  if (!d) return undefined
  const m = (await wait(d.transaction(META, 'readonly').objectStore(META).get(id))) as Meta | undefined
  return m?.bytes
}

/**
 * Saves a session's events. When they continue what is cached (no hole in the live seqs) both are
 * merged; otherwise the cache restarts from these. Keeps the newest perSession events, then drops
 * least recently opened sessions until the total fits. Saving does not count as opening: a row
 * never opened (written while evicting from memory) is the first to go. Read, merge and write
 * happen in one transaction, so two saves of a session never lose each other's events.
 */
export async function saveCached(id: string, events: Event[], gen = generation): Promise<void> {
  try {
    if (gen !== generation) return
    const d = await open()
    if (!d || !events.length || gen !== generation) return
    const tx = d.transaction([META, EVENTS], 'readwrite')
    const metas = tx.objectStore(META)
    const rows = tx.objectStore(EVENTS)
    const getMeta = metas.get(id)
    const getRow = rows.get(id)
    getRow.onsuccess = () => {
     try {
      if (gen !== generation) { tx.abort(); return }
      const old = (getRow.result as Row | undefined)?.events ?? []
      const meta = getMeta.result as Meta | undefined
      const first = firstLive(events)
      const merge = old.length > 0 && (first === undefined || first <= maxSeq(old) + 1)
      let list = merge ? mergeEvents(old, events) : events
      if (list.length > cacheLimits.perSession) list = list.slice(list.length - cacheLimits.perSession)
      const bytes = merge ? bytesOf(list, old, meta?.bytes) : bytesOf(list, [], undefined)
      rows.put({ id, events: list } satisfies Row)
      metas.put({ id, lastSeq: maxSeq(list), openedAt: meta?.openedAt ?? 0, bytes } satisfies Meta)
     } catch { try { tx.abort() } catch { /* already finished */ } }
    }
    await done(tx)
    await prune(d, id)
  } catch {
    /* quota or storage refused: the app keeps working from the network */
  }
}

async function prune(d: IDBDatabase, keep: string) {
  const all = (await wait(d.transaction(META, 'readonly').objectStore(META).getAll())) as Meta[]
  let total = all.reduce((n, m) => n + (m.bytes || 0), 0)
  if (total <= cacheLimits.totalBytes) return
  const tx = d.transaction([META, EVENTS], 'readwrite')
  for (const m of all.sort((a, b) => a.openedAt - b.openedAt)) {
    if (total <= cacheLimits.totalBytes) break
    if (m.id === keep) continue
    tx.objectStore(META).delete(m.id)
    tx.objectStore(EVENTS).delete(m.id)
    total -= m.bytes || 0
  }
  await done(tx)
}

/** Forgets every cached event (unpair / logout). */
export async function clearCache(): Promise<void> {
  generation++
  try {
    const cur = dbp
    dbp = null
    const d = await cur
    d?.close()
    const idb = globalThis.indexedDB
    if (!idb) return
    await new Promise<void>((res) => {
      const r = idb.deleteDatabase(DB)
      r.onsuccess = () => res()
      r.onerror = () => res()
      r.onblocked = () => res()
    })
  } catch {
    /* nothing stored, or storage refused */
  }
}
