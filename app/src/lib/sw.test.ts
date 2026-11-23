import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

// Loads public/sw.js in a sandbox with fake caches/fetch and returns its fetch handler.
function loadSW(fetchImpl: (req: unknown) => Promise<unknown>) {
  const listeners: Record<string, (e: unknown) => void> = {}
  const puts: string[] = []
  const cache = { put: vi.fn((k: unknown) => { puts.push(typeof k === 'string' ? k : (k as { url: string }).url) }), addAll: vi.fn() }
  const ctx = {
    self: { location: { origin: 'https://hub.test' }, addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f } },
    caches: { open: async () => cache, match: async () => undefined, keys: async () => [] },
    fetch: fetchImpl,
    URL,
  }
  vm.runInNewContext(readFileSync(resolve(import.meta.dirname, '../../public/sw.js'), 'utf8'), ctx)
  return { onFetch: listeners.fetch, puts }
}

function fire(onFetch: (e: unknown) => void, url: string, mode = 'navigate') {
  let responded: Promise<unknown> | undefined
  onFetch({ request: { url, method: 'GET', mode }, respondWith: (p: Promise<unknown>) => { responded = p } })
  return responded
}

const res = (ok: boolean) => ({ ok, clone() { return this } })

describe('service worker', () => {
  it('never handles /v/ requests', () => {
    const { onFetch, puts } = loadSW(async () => res(true))
    expect(fire(onFetch, 'https://hub.test/v/abc/r.html')).toBeUndefined()
    expect(fire(onFetch, 'https://hub.test/v/abc/a.png', 'no-cors')).toBeUndefined()
    expect(puts).toEqual([])
  })

  it('caches the shell only for ok navigations', async () => {
    const ok = loadSW(async () => res(true))
    await fire(ok.onFetch, 'https://hub.test/sessions/x')
    await new Promise((r) => setTimeout(r, 0))
    expect(ok.puts).toEqual(['/'])
    const bad = loadSW(async () => res(false))
    await fire(bad.onFetch, 'https://hub.test/sessions/x')
    await new Promise((r) => setTimeout(r, 0))
    expect(bad.puts).toEqual([])
  })
})
