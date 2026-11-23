import { describe, it, expect, vi, beforeEach } from 'vitest'

const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v },
  removeItem: (k: string) => { delete mem[k] },
})
import { apiFetch, setHub, getToken } from './api'

beforeEach(() => { for (const k in mem) delete mem[k]; setHub('http://h:1/', 'tok') })

describe('apiFetch', () => {
  it('lanza el mensaje de error del hub', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'código inválido o vencido' }), { status: 400 })))
    await expect(apiFetch('/api/pair')).rejects.toThrow('código inválido o vencido')
  })
  it('envia bearer y normaliza la url', async () => {
    const f = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', f)
    await apiFetch('/api/machines')
    const [u, init] = f.mock.calls[0] as any
    expect(u).toBe('http://h:1/api/machines')
    expect(init.headers.get('Authorization')).toBe('Bearer tok')
  })
  it('202 sin cuerpo (prompt, decide) se resuelve sin error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })))
    await expect(apiFetch('/api/sessions/s1/prompt', { method: 'POST', body: '{}' })).resolves.toBe(undefined)
  })
  it('401 limpia el token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"no autorizado"}', { status: 401 })))
    await expect(apiFetch('/api/machines')).rejects.toThrow('no autorizado')
    expect(getToken()).toBe('')
  })
})

describe('setHub', () => {
  it('si falla una escritura no deja un hub nuevo sin token y lanza', () => {
    for (const k in mem) delete mem[k]
    const orig = (localStorage as any).setItem
    ;(localStorage as any).setItem = (k: string, v: string) => { if (k === 'quorum.hub') throw new Error('lleno'); mem[k] = v }
    try {
      expect(() => setHub('http://otro:2', 'tok2')).toThrow('no se pudo guardar el token en este dispositivo')
    } finally {
      ;(localStorage as any).setItem = orig
    }
    expect(mem['quorum.hub']).toBeUndefined()
    expect(mem['quorum.token']).toBeUndefined()
    expect(getToken()).toBe('')
  })
})

describe('propuestas', () => {
  it('listProposals arma ticket, status y limit', async () => {
    const f = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', f)
    const { listProposals } = await import('./api')
    await listProposals()
    await listProposals({ ticket: 't 1', status: 'pendiente', limit: 5 })
    expect((f.mock.calls[0] as any)[0]).toBe('http://h:1/api/proposals')
    expect((f.mock.calls[1] as any)[0]).toBe('http://h:1/api/proposals?ticket=t+1&status=pendiente&limit=5')
  })
  it('loadProposals trae las pendientes y las 50 recientes sin repetir', async () => {
    const prop = (id: string, status = 'pendiente') => ({ id, ticketId: 't', kind: 'comment', body: '', status, error: '', createdAt: 1 })
    const f = vi.fn(async (u: string) => new Response(JSON.stringify(
      u.includes('status=pendiente') ? [prop('a'), prop('b')] : [prop('b'), prop('c', 'aprobada')]), { status: 200 }))
    vi.stubGlobal('fetch', f)
    const { loadProposals } = await import('./api')
    const got = await loadProposals()
    expect(got.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    const urls = f.mock.calls.map((c: any) => c[0])
    expect(urls).toContain('http://h:1/api/proposals?status=pendiente&limit=1000')
    expect(urls).toContain('http://h:1/api/proposals?limit=50')
  })
})

describe('terminal api', () => {
  it('codifica el panel (lleva ":") y usa los verbos correctos', async () => {
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
