// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConnectorForm, { connectorInput, draftFrom, validateConnector, type ConnectorDraft } from './ConnectorForm'
import type { ConnectorConfig } from '../proto.gen'

afterEach(cleanup)

const cfg: ConnectorConfig = { kind: 'paperclip', settings: { baseURL: 'https://pc.local', companyId: 'c1', token: 'NO-DEBE-VERSE' }, hasToken: true, intervalMin: 10 }
let last: ConnectorDraft
function Harness({ c }: { c: ConnectorConfig }) {
  const [d, setD] = useState(() => draftFrom(c))
  last = d
  return <ConnectorForm value={d} onChange={setD} hasToken={c.hasToken} />
}

describe('ConnectorForm', () => {
  it('nunca precarga el token, aunque exista', () => {
    render(<Harness c={cfg} />)
    const tok = screen.getByLabelText('Token') as HTMLInputElement
    expect(tok.value).toBe('')
    expect(tok.type).toBe('password')
    expect(tok.placeholder).toContain('guardado')
    expect(document.body.innerHTML).not.toContain('NO-DEBE-VERSE')
    expect((screen.getByLabelText('URL de la instancia') as HTMLInputElement).value).toBe('https://pc.local')
    fireEvent.change(tok, { target: { value: 'nuevo' } })
    expect(last.token).toBe('nuevo')
  })
  it('borrar token marca clearToken', () => {
    render(<Harness c={cfg} />)
    fireEvent.click(screen.getByRole('button', { name: 'Borrar token' }))
    expect(last.clearToken).toBe(true)
    expect(screen.getByText('Se borrará al guardar.')).toBeTruthy()
  })
  it('formulario por tipo: exec pide comando y valida el mapa JSON', () => {
    render(<Harness c={{ kind: 'none', settings: {}, hasToken: false, intervalMin: 0 }} />)
    expect(screen.queryByLabelText('Token')).toBeNull()
    fireEvent.change(screen.getByLabelText('Conector'), { target: { value: 'exec' } })
    expect(validateConnector(last)).toBe('falta el comando del conector')
    fireEvent.change(screen.getByLabelText('Comando'), { target: { value: '/x/c.sh' } })
    fireEvent.change(screen.getByLabelText('Mapa de estados (JSON, opcional)'), { target: { value: '{malo' } })
    expect(validateConnector(last)).toMatch(/objeto JSON/)
    fireEvent.change(screen.getByLabelText('Mapa de estados (JSON, opcional)'), { target: { value: '' } })
    expect(validateConnector(last)).toBe('')
    expect(connectorInput(last)).toEqual({ kind: 'exec', settings: { command: '/x/c.sh' }, intervalMin: 5 })
  })
  it('github valida owner/nombre', () => {
    expect(validateConnector({ ...draftFrom(), kind: 'github', settings: { repo: 'nope' } })).toMatch(/owner\/nombre/)
    expect(validateConnector({ ...draftFrom(), kind: 'github', settings: { repo: 'o/r' } })).toBe('')
  })
})
