// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AskCard from './AskCard'
import type { Ask } from '../proto.gen'

const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response('{}', { status: 200 }))
vi.stubGlobal('fetch', fetchMock)
afterEach(() => { cleanup(); fetchMock.mockReset(); fetchMock.mockImplementation(async () => new Response('{}')) })

const perm: Ask = { askId: 'a1', kind: 'permission', tool: 'Bash', summary: 'ls -la', detail: 'ls -la /', questions: null as any }
const body = () => JSON.parse(String(fetchMock.mock.calls[0][1]?.body))

describe('AskCard', () => {
  it('permiso: Permitir y Denegar', async () => {
    render(<AskCard session="s1" ask={perm} />)
    fireEvent.click(screen.getByRole('button', { name: 'Permitir' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toContain('/api/sessions/s1/decide')
    expect(body()).toEqual({ askId: 'a1', decision: 'allow' })
  })
  it('pregunta: manda answers (multi con coma, y Otra)', async () => {
    const ask: Ask = { ...perm, kind: 'question', tool: 'AskUserQuestion', questions: [
      { question: 'Color', options: [{ label: 'Rojo' }, { label: 'Azul' }] },
      { question: 'Extras', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
      { question: 'Libre', options: [{ label: 'X' }] },
    ] as any }
    render(<AskCard session="s1" ask={ask} />)
    fireEvent.click(screen.getByLabelText('Azul'))
    fireEvent.click(screen.getByLabelText('A'))
    fireEvent.click(screen.getByLabelText('B'))
    fireEvent.change(screen.getByLabelText('Otra: Libre'), { target: { value: 'otra cosa' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar respuestas' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(body()).toEqual({ askId: 'a1', decision: 'allow', answers: { Color: 'Azul', Extras: 'A, B', Libre: 'otra cosa' } })
  })
  it('409 muestra "ya se respondió" y se cierra', async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":"ya se respondió"}', { status: 409 }))
    const done = vi.fn()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    render(<AskCard session="s1" ask={perm} onDone={done} />)
    fireEvent.click(screen.getByRole('button', { name: 'Denegar' }))
    await vi.waitFor(() => expect(screen.getByText('ya se respondió')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Permitir' })).toBeNull()
    vi.advanceTimersByTime(2100)
    expect(done).toHaveBeenCalled()
    vi.useRealTimers()
  })
})
