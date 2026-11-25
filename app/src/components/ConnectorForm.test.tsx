// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConnectorForm, { connectorInput, draftFrom, validateConnector, type ConnectorDraft } from './ConnectorForm'
import type { ConnectorConfig } from '../proto.gen'

afterEach(cleanup)

const cfg: ConnectorConfig = { kind: 'paperclip', settings: { baseURL: 'https://pc.local', companyId: 'c1', token: 'MUST-NOT-SHOW' }, hasToken: true, intervalMin: 10 }
let last: ConnectorDraft
function Harness({ c }: { c: ConnectorConfig }) {
  const [d, setD] = useState(() => draftFrom(c))
  last = d
  return <ConnectorForm value={d} onChange={setD} hasToken={c.hasToken} />
}

describe('ConnectorForm', () => {
  it('never prefills the token, even if it exists', () => {
    render(<Harness c={cfg} />)
    const tok = screen.getByLabelText('Token') as HTMLInputElement
    expect(tok.value).toBe('')
    expect(tok.type).toBe('password')
    expect(tok.placeholder).toContain('saved')
    expect(document.body.innerHTML).not.toContain('MUST-NOT-SHOW')
    expect((screen.getByLabelText('Instance URL') as HTMLInputElement).value).toBe('https://pc.local')
    fireEvent.change(tok, { target: { value: 'new' } })
    expect(last.token).toBe('new')
  })
  it('deleting the token sets clearToken', () => {
    render(<Harness c={cfg} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete token' }))
    expect(last.clearToken).toBe(true)
    expect(screen.getByText('Will be deleted on save.')).toBeTruthy()
  })
  it('form per kind: exec asks for a command and validates the JSON map', () => {
    render(<Harness c={{ kind: 'none', settings: {}, hasToken: false, intervalMin: 0 }} />)
    expect(screen.queryByLabelText('Token')).toBeNull()
    fireEvent.change(screen.getByLabelText('Connector'), { target: { value: 'exec' } })
    expect(validateConnector(last)).toBe('missing connector command')
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/x/c.sh' } })
    fireEvent.change(screen.getByLabelText('Status map (JSON, optional)'), { target: { value: '{bad' } })
    expect(validateConnector(last)).toMatch(/JSON object/)
    fireEvent.change(screen.getByLabelText('Status map (JSON, optional)'), { target: { value: '' } })
    expect(validateConnector(last)).toBe('')
    expect(connectorInput(last)).toEqual({ kind: 'exec', settings: { command: '/x/c.sh' }, intervalMin: 5 })
  })
  it('github validates owner/name', () => {
    expect(validateConnector({ ...draftFrom(), kind: 'github', settings: { repo: 'nope' } })).toMatch(/owner\/name/)
    expect(validateConnector({ ...draftFrom(), kind: 'github', settings: { repo: 'o/r' } })).toBe('')
  })
  it('moontech: its fields go into the settings and the password stays write-only', () => {
    render(<Harness c={{ kind: 'none', settings: {}, hasToken: false, intervalMin: 0 }} />)
    fireEvent.change(screen.getByLabelText('Connector'), { target: { value: 'moontech' } })
    expect(screen.getByText(/Read-only/)).toBeTruthy()
    expect(validateConnector(last)).toBe('missing product')
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://tickets.example' } })
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'Acme' } })
    fireEvent.change(screen.getByLabelText('Title prefix (optional)'), { target: { value: 'Acme ·' } })
    fireEvent.change(screen.getByLabelText('You are'), { target: { value: 'Ana' } })
    expect(validateConnector(last)).toBe('missing username')
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ana@example.com' } })
    const pw = screen.getByLabelText('Password') as HTMLInputElement
    expect(pw.type).toBe('password')
    fireEvent.change(pw, { target: { value: 'hunter2-secret' } })
    expect(validateConnector(last)).toBe('')
    expect(last.token).toBe('hunter2-secret')
    const input = connectorInput(last)
    expect(input).toEqual({ kind: 'moontech', settings: { baseUrl: 'https://tickets.example', product: 'Acme', titlePrefix: 'Acme ·', person: 'Ana', username: 'ana@example.com' }, intervalMin: 5 })
    expect(JSON.stringify(input)).not.toContain('hunter2')
    expect(validateConnector({ ...last, settings: { ...last.settings, baseUrl: 'ftp://x' } })).toMatch(/http/)
  })
  it('moontech with a saved password: shows Saved, never the value', () => {
    render(<Harness c={{ kind: 'moontech', settings: { product: 'Acme', username: 'ana', token: 'MUST-NOT-SHOW' }, hasToken: true, intervalMin: 5 }} />)
    const pw = screen.getByLabelText('Password') as HTMLInputElement
    expect(pw.value).toBe('')
    expect(screen.getByText(/^Saved/)).toBeTruthy()
    expect(document.body.innerHTML).not.toContain('MUST-NOT-SHOW')
    expect(screen.getByRole('button', { name: 'Delete password' })).toBeTruthy()
  })
})
