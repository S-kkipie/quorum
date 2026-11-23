// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import Starting from './Starting'

afterEach(cleanup)
const late = { reqId: 'r', machine: 'm1', label: 'x', startedAt: Date.now() - 61000, pane: 'w1:p1' }

describe('Starting', () => {
  it('after 60 s it offers "View in terminal" only if the machine has a terminal', () => {
    render(<Starting pending={late} terminal onBack={vi.fn()} />)
    expect(screen.getByText('Claude did not register within 60 s')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View in terminal' })).toBeTruthy()
    cleanup()
    render(<Starting pending={late} onBack={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'View in terminal' })).toBeNull()
  })
})
