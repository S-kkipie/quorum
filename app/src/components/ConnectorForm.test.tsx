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
})
