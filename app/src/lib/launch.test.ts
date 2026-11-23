import { describe, expect, it, vi } from 'vitest'
import { EarlyLaunches, loadPrefs, pendingReducer, savePrefs, timedOut, type Pending } from './launch'

const p: Pending = { reqId: 'r1', machine: 'vps-1', label: 'x', startedAt: 1000 }
const env = (type: string, payload: any) => ({ type, machine: 'vps-1', session: '', payload })

describe('pendingReducer', () => {
  it('opens session on launch_session', () => {
    const r = pendingReducer(p, env('launch_session', { reqId: 'r1', sessionId: 's9' }), 2000)
    expect(r).toEqual({ pending: null, open: 's9' })
  })
  it('ignores other reqId', () => {
    const r = pendingReducer(p, env('launch_session', { reqId: 'zz', sessionId: 's9' }), 2000)
    expect(r.pending).toBe(p)
    expect(r.open).toBeUndefined()
    expect(pendingReducer(p, env('launch_result', { reqId: 'zz', ok: false, error: 'x' }), 2000).pending).toBe(p)
  })
  it('keeps pane from launch_result', () => {
    const r = pendingReducer(p, env('launch_result', { reqId: 'r1', ok: true, pane: 'w1:2', via: 'herdr' }), 2000)
    expect(r.pending?.pane).toBe('w1:2')
    expect(r.open).toBeUndefined()
  })
  it('records error on failed launch_result', () => {
    const r = pendingReducer(p, env('launch_result', { reqId: 'r1', ok: false, error: 'no hay carpeta' }), 2000)
    expect(r.pending?.error).toBe('no hay carpeta')
  })
  it('null pending stays null', () => {
    expect(pendingReducer(null, env('launch_session', { reqId: 'r1', sessionId: 's' }), 1).pending).toBeNull()
  })
})

describe('timedOut', () => {
  it('after 60s', () => {
    expect(timedOut(p, 1000 + 60000)).toBe(false)
    expect(timedOut(p, 1000 + 60001)).toBe(true)
  })
})

describe('prefs', () => {
  it('default bypass true and persist machine', () => {
    const store: Record<string, string> = {}
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v }, removeItem() {} })
    expect(loadPrefs('p1')).toEqual({ bypass: true })
    savePrefs('p1', { machine: 'mac', bypass: false })
    expect(store['quorum.launch.p1']).toBeDefined()
    expect(loadPrefs('p1')).toEqual({ machine: 'mac', bypass: false })
    expect(loadPrefs('p2')).toEqual({ bypass: true })
  })
  it('tolerates garbage', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
    expect(loadPrefs('p1')).toEqual({ bypass: true })
  })
})

describe('EarlyLaunches', () => {
  const np = (reqId: string): Pending => ({ reqId, machine: 'vps-1', label: 'x', startedAt: 5000 })
  it('replays a fast failure that arrived before the POST replied', () => {
    const e = new EarlyLaunches()
    e.remember(env('launch_result', { reqId: 'r1', ok: false, error: 'no hay carpeta' }), 1000)
    const r = e.replay(np('r1'), 2000)
    expect(r.pending?.error).toBe('no hay carpeta')
    // se olvida tras usarlo
    expect(e.replay(np('r1'), 2000).pending?.error).toBeUndefined()
  })
  it('replays pane then session in order', () => {
    const e = new EarlyLaunches()
    e.remember(env('launch_result', { reqId: 'r1', ok: true, pane: 'w1:2' }), 1000)
    e.remember(env('launch_session', { reqId: 'r1', sessionId: 's9' }), 1001)
    expect(e.replay(np('r1'), 2000)).toEqual({ pending: null, open: 's9' })
  })
  it('ignores other reqIds, expired and overflow', () => {
    const e = new EarlyLaunches(2, 60000)
    e.remember(env('launch_result', { reqId: 'old', ok: false, error: 'x' }), 0)
    expect(e.replay(np('old'), 60001).pending?.error).toBeUndefined()
    e.remember(env('launch_result', { reqId: 'a', ok: false, error: 'x' }), 1)
    e.remember(env('launch_result', { reqId: 'b', ok: false, error: 'x' }), 2)
    e.remember(env('launch_result', { reqId: 'c', ok: false, error: 'x' }), 3)
    expect(e.replay(np('a'), 4).pending?.error).toBeUndefined()
    expect(e.replay(np('c'), 4).pending?.error).toBe('x')
    expect(e.replay(np('zz'), 4).pending).toEqual(np('zz'))
  })
})
