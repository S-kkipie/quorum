// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import LaunchDialog from './LaunchDialog'
import { initialState } from '../lib/store'

vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
afterEach(cleanup)

const state = () => ({ ...initialState(), machines: { 'vps-1': { name: 'vps-1', os: 'linux', env: 'linux', version: '', online: true, lastSeen: 0, caps: { herdr: false, terminal: false, root: false } } } })

describe('LaunchDialog', () => {
  it('is a bottom sheet on phones (bottom-anchored, rounded top, full width)', () => {
    render(<LaunchDialog state={state()} onClose={vi.fn()} onLaunched={vi.fn()} />)
    const c = screen.getByRole('dialog').className
    expect(c).toContain('bottom-0')
    expect(c).toContain('rounded-t-xl')
    expect(c).toContain('max-w-none')
    expect(c).toContain('sm:max-w-md')
  })
  it('Esc closes while the folder is empty but not once it has text; Cancel always closes', () => {
    const onClose = vi.fn()
    render(<LaunchDialog state={state()} onClose={onClose} onLaunched={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByPlaceholderText('/path/to/project'), { target: { value: '/work/app' } })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
