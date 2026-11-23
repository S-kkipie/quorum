// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Composer from './Composer'
import type { SessionInfo } from '../proto.gen'

const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response('{}', { status: 202 }))
vi.stubGlobal('fetch', fetchMock)

const sess = (o: Partial<SessionInfo>): SessionInfo => ({
  id: 's1', recap: '', previousId: '', machine: 'm', name: 'n', cwd: '/x', root: '/x', model: '', role: 'work' as any,
  state: 'idle' as any, contextPct: 0, startedAt: 0, updatedAt: 0, transcriptPath: '', repoUrl: '', branch: '', projectId: '', ...o,
})

async function send(s: SessionInfo, label: string) {
  render(<Composer session={s} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hola' } })
  fireEvent.click(screen.getByRole('button', { name: label }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  const [url, init] = fetchMock.mock.calls[0]
  return { url, body: JSON.parse(String(init?.body)) }
}

afterEach(() => { cleanup(); fetchMock.mockClear() })

describe('Composer', () => {
  it('working: Enviar usa mode now', async () => {
    const r = await send(sess({ state: 'working' as any }), 'Enviar')
    expect(r.url).toContain('/api/sessions/s1/prompt')
    expect(r.body).toEqual({ text: 'hola', mode: 'now' })
  })
  it('idle: Enviar usa mode queue', async () => {
    expect((await send(sess({ state: 'idle' as any }), 'Enviar')).body.mode).toBe('queue')
  })
  it('En cola e Interrumpir', async () => {
    expect((await send(sess({ state: 'working' as any }), 'En cola')).body.mode).toBe('queue')
    cleanup(); fetchMock.mockClear()
    expect((await send(sess({ state: 'working' as any }), 'Interrumpir y enviar')).body.mode).toBe('interrupt')
  })
  it('servicio: deshabilitado', () => {
    render(<Composer session={sess({ role: 'service' as any })} />)
    expect(screen.getByText('Sesión de servicio')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('cerrada', () => {
    render(<Composer session={sess({ state: 'closed' as any })} />)
    expect(screen.getByText('Sesión cerrada')).toBeTruthy()
  })
})
