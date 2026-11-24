import { describe, it, expect, vi, beforeEach } from 'vitest'

const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v },
  removeItem: (k: string) => { delete mem[k] },
})
import { apiFetch, setHub, getToken, seen, listCommands, runCommand, setModel } from './api'

beforeEach(() => { for (const k in mem) delete mem[k]; setHub('http://h:1/', 'tok') })

describe('apiFetch', () => {
  it('throws the hub\'s error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid or expired code' }), { status: 400 })))
    await expect(apiFetch('/api/pair')).rejects.toThrow('invalid or expired code')
  })
  it('sends bearer and normalizes the url', async () => {
    const f = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', f)
    await apiFetch('/api/machines')
    const [u, init] = f.mock.calls[0] as any
    expect(u).toBe('http://h:1/api/machines')
    expect(init.headers.get('Authorization')).toBe('Bearer tok')
  })
  it('202 without a body (prompt, decide) resolves without error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })))
    await expect(apiFetch('/api/sessions/s1/prompt', { method: 'POST', body: '{}' })).resolves.toBe(undefined)
  })
  it('401 clears the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })))
    await expect(apiFetch('/api/machines')).rejects.toThrow('unauthorized')
    expect(getToken()).toBe('')
  })
})

describe('setHub', () => {
  it('if a write fails it does not leave a new hub without a token, and throws', () => {
    for (const k in mem) delete mem[k]
    const orig = (localStorage as any).setItem
    ;(localStorage as any).setItem = (k: string, v: string) => { if (k === 'quorum.hub') throw new Error('full'); mem[k] = v }
    try {
      expect(() => setHub('http://other:2', 'tok2')).toThrow('could not save the token on this device')
    } finally {
      ;(localStorage as any).setItem = orig
    }
    expect(mem['quorum.hub']).toBeUndefined()
    expect(mem['quorum.token']).toBeUndefined()
    expect(getToken()).toBe('')
  })
})

describe('proposals', () => {
  it('listProposals builds ticket, status and limit', async () => {
    const f = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', f)
    const { listProposals } = await import('./api')
    await listProposals()
    await listProposals({ ticket: 't 1', status: 'pending', limit: 5 })
    expect((f.mock.calls[0] as any)[0]).toBe('http://h:1/api/proposals')
    expect((f.mock.calls[1] as any)[0]).toBe('http://h:1/api/proposals?ticket=t+1&status=pending&limit=5')
  })
  it('loadProposals fetches the pending ones and the 50 most recent without repeats', async () => {
    const prop = (id: string, status = 'pending') => ({ id, ticketId: 't', kind: 'comment', body: '', status, error: '', createdAt: 1 })
    const f = vi.fn(async (u: string) => new Response(JSON.stringify(
      u.includes('status=pending') ? [prop('a'), prop('b')] : [prop('b'), prop('c', 'approved')]), { status: 200 }))
    vi.stubGlobal('fetch', f)
    const { loadProposals } = await import('./api')
    const got = await loadProposals()
    expect(got.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    const urls = f.mock.calls.map((c: any) => c[0])
    expect(urls).toContain('http://h:1/api/proposals?status=pending&limit=1000')
    expect(urls).toContain('http://h:1/api/proposals?limit=50')
  })
})

describe('terminal api', () => {
  it('encodes the pane (it contains ":") and uses the right verbs', async () => {
    const calls: [string, any][] = []
    vi.stubGlobal('fetch', async (u: string, i?: RequestInit) => { calls.push([u, i]); return new Response('', { status: 202 }) })
    vi.stubGlobal('localStorage', { getItem: () => '', setItem() {}, removeItem() {} })
    const a = await import('./api')
    await a.watchTerminal('m 1', 'w1:2')
    await a.sendTerminal('m 1', 'w1:2', { keys: ['esc'] })
    await a.readTerminal('m 1', 'w1:2', 40)
    await a.closeTerminal('m 1', 'w1:2')
    expect(calls.map(([u, i]) => `${i?.method} ${u}`)).toEqual([
      'POST /api/machines/m%201/terminals/w1%3A2/watch',
      'POST /api/machines/m%201/terminals/w1%3A2/input',
      'GET /api/machines/m%201/terminals/w1%3A2/read?lines=40',
      'DELETE /api/machines/m%201/terminals/w1%3A2',
    ].map((x) => x.replace('GET', 'undefined')))
  })
})

describe('createView', () => {
  it('posts sessionId and path', async () => {
    const f = vi.fn(async () => new Response('{"url":"/v/abc/x.html"}', { status: 200 }))
    vi.stubGlobal('fetch', f)
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'quorum.hub' ? 'http://h:1' : 'tok'), setItem() {}, removeItem() {} })
    const { createView } = await import('./api')
    await expect(createView('vps 1', 's1', '/p/x.html')).resolves.toEqual({ url: '/v/abc/x.html' })
    const [u, init] = f.mock.calls[0] as any
    expect(u).toBe('http://h:1/api/machines/vps%201/views')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ sessionId: 's1', path: '/p/x.html' })
  })
})

describe('seen', () => {
  it('posts the seen mark of the session', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', f)
    await expect(seen('a b', 42)).resolves.toBe(undefined)
    const [u, init] = f.mock.calls[0] as any
    expect(u).toBe('http://h:1/api/sessions/a%20b/seen')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ seq: 42 })
  })
})

describe('slash commands', () => {
  const sent = () => {
    const f = vi.fn(async () => new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', f)
    return f
  }
  it('listCommands reads the session list', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ session: 's/1', commands: [], hash: '' }), { status: 200 }))
    vi.stubGlobal('fetch', f)
    await expect(listCommands('s/1')).resolves.toEqual({ session: 's/1', commands: [], hash: '' })
    expect((f.mock.calls[0] as any)[0]).toBe('http://h:1/api/sessions/s%2F1/commands')
  })
  it('runCommand posts command and args', async () => {
    const f = sent()
    await runCommand('s1', 'review', 'the diff')
    const [u, init] = f.mock.calls[0] as any
    expect(u).toBe('http://h:1/api/sessions/s1/command')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ command: 'review', args: 'the diff' })
  })
  it('runCommand surfaces the hub error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'This command only works in the terminal.' }), { status: 400 })))
    await expect(runCommand('s1', 'config', '')).rejects.toThrow('only works in the terminal')
  })
  it('setModel posts the value', async () => {
    const f = sent()
    await setModel('s1', 'opus')
    const [u, init] = f.mock.calls[0] as any
    expect(u).toBe('http://h:1/api/sessions/s1/model')
    expect(JSON.parse(init.body)).toEqual({ value: 'opus' })
  })
})
