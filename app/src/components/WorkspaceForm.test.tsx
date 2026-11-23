// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import WorkspaceForm from './WorkspaceForm'

const fetchMock = vi.fn(async (_u: string, i?: RequestInit) =>
  new Response(JSON.stringify({ id: 'w1', name: 'ACME', color: '', whoasProfile: '', ...(i?.body ? JSON.parse(String(i.body)) : {}) }), { status: i?.method === 'POST' ? 201 : 200 }))
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
afterEach(() => { cleanup(); fetchMock.mockClear() })

describe('WorkspaceForm', () => {
  it('alta: el POST solo lleva el nombre; color y perfil van en un PATCH', async () => {
    const onDone = vi.fn()
    render(<WorkspaceForm onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'ACME' } })
    fireEvent.click(screen.getByRole('button', { name: 'Color rojo' }))
    fireEvent.change(screen.getByPlaceholderText('cliente-x'), { target: { value: 'acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const [[u1, i1], [u2, i2]] = fetchMock.mock.calls
    expect(String(u1)).toContain('/api/workspaces')
    expect(JSON.parse(String(i1?.body))).toEqual({ name: 'ACME' })
    expect(String(u2)).toContain('/api/workspaces/w1')
    expect(i2?.method).toBe('PATCH')
    expect(JSON.parse(String(i2?.body))).toEqual({ color: '#ef4444', whoasProfile: 'acme' })
  })
})
