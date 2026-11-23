// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import Starting from './Starting'

afterEach(cleanup)
const late = { reqId: 'r', machine: 'm1', label: 'x', startedAt: Date.now() - 61000, pane: 'w1:p1' }

describe('Starting', () => {
  it('pasados 60 s ofrece "Ver en terminal" solo si la máquina tiene terminal', () => {
    render(<Starting pending={late} terminal onBack={vi.fn()} />)
    expect(screen.getByText('Claude no se registró en 60 s')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ver en terminal' })).toBeTruthy()
    cleanup()
    render(<Starting pending={late} onBack={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Ver en terminal' })).toBeNull()
  })
})
