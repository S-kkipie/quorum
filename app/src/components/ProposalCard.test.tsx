// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ProposalCard from './ProposalCard'
import type { Proposal } from '../proto.gen'

const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ...p, status: 'aprobada' })))
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
afterEach(() => { cleanup(); fetchMock.mockClear() })

const p: Proposal = { id: 'x1', ticketId: 't1', kind: 'comment', body: 'Avance (Quorum, vps-2):\nlisto', status: 'pendiente', error: '', createdAt: 1 }

describe('ProposalCard', () => {
  it('aprobar envía el cuerpo editado', async () => {
    const onDone = vi.fn()
    render(<ProposalCard proposal={p} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('Texto del comentario'), { target: { value: 'Listo, revisa el PR #4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/proposals/x1/approve')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ body: 'Listo, revisa el PR #4' })
  })
  it('sin editar no manda cuerpo; rechazar va a /reject', async () => {
    render(<ProposalCard proposal={p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Rechazar' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1][0]).toContain('/api/proposals/x1/reject')
  })
  it('409: muestra el error del hub', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'la propuesta ya no está pendiente' }), { status: 409 }))
    render(<ProposalCard proposal={p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar' }))
    expect((await screen.findByRole('alert')).textContent).toBe('la propuesta ya no está pendiente')
  })
  it('fallida muestra el error y no tiene botones', () => {
    render(<ProposalCard proposal={{ ...p, kind: 'status', body: 'hecho', status: 'fallida', error: 'HTTP 403' }} />)
    expect(screen.getByText('HTTP 403')).toBeTruthy()
    expect(screen.getByText('hecho')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('adopta el borrador nuevo del hub solo si no se está editando', () => {
    const { rerender } = render(<ProposalCard proposal={p} />)
    const box = () => screen.getByLabelText('Texto del comentario') as HTMLTextAreaElement
    rerender(<ProposalCard proposal={{ ...p, body: 'turno 2' }} />)
    expect(box().value).toBe('turno 2')
    fireEvent.change(box(), { target: { value: 'mío' } })
    rerender(<ProposalCard proposal={{ ...p, body: 'turno 3' }} />)
    expect(box().value).toBe('mío')
  })
})
