// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Transcript, { buildRows } from './Transcript'
import type { Event } from '../proto.gen'

const ev = (seq: number, kind: string, data: any): Event => ({ seq, session: 's', ts: 0, kind, data })
const evs = [
  ev(1, 'user', { text: 'hola' }),
  ev(2, 'tool_start', { id: 't1', name: 'Bash', summary: 'ls -la' }),
  ev(3, 'tool_start', { id: 't2', name: 'Read', summary: 'a.go' }),
  ev(4, 'tool_end', { id: 't1', ok: true, ms: 12, output: 'SALIDA-UNO' }),
]
afterEach(cleanup)

describe('Transcript', () => {
  it('un tool_start rellenado (seq negativo) sin tool_end sale terminado', () => {
    const rows: any[] = buildRows([ev(-3, 'tool_start', { id: 'h1', name: 'Bash', summary: 'ls' }), ev(2, 'tool_start', { id: 'n1', name: 'Read', summary: 'x' })])
    expect(rows[0].done).toBe(true)
    expect(rows[1].done).toBe(false)
  })
  it('empareja tool_start/tool_end por id en una sola fila', () => {
    const rows = buildRows(evs)
    expect(rows.filter((r) => r.t === 'tool')).toHaveLength(2)
    const t1: any = rows.find((r: any) => r.id === 't1')
    expect(t1).toMatchObject({ done: true, ok: true, output: 'SALIDA-UNO' })
    expect((rows.find((r: any) => r.id === 't2') as any).done).toBe(false)
  })
  it('detalle plegable al tocar', () => {
    render(<Transcript events={evs} />)
    expect(screen.queryByText('SALIDA-UNO')).toBeNull()
    fireEvent.click(screen.getByText('ls -la'))
    expect(screen.getByText('SALIDA-UNO')).toBeTruthy()
  })
  it('texto en streaming al final y subagente con estado', () => {
    render(<Transcript events={[ev(1, 'agent_start', { id: 'a', type: 'Explore', description: 'busca' })]} live="escribiendo" />)
    expect(screen.getByText('trabajando')).toBeTruthy()
    expect(screen.getByText(/escribiendo/)).toBeTruthy()
  })
})
