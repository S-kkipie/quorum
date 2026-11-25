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
  it('scoped to a job: the title names it and folder suggestions come from its projects', () => {
    const s = {
      ...state(),
      workspaces: { w1: { id: 'w1', name: 'ACME', color: '', whoasProfile: '' } },
      projects: { p1: { ...({} as any), id: 'p1', workspaceId: 'w1', name: 'Web' }, p2: { ...({} as any), id: 'p2', workspaceId: 'w2', name: 'Else' } },
      checkouts: { p1: [{ projectId: 'p1', machine: 'vps-1', root: '/srv/web', branch: '' }], p2: [{ projectId: 'p2', machine: 'vps-1', root: '/srv/else', branch: '' }] },
    } as any
    const { container } = render(<LaunchDialog state={s} workspaceId="w1" onClose={vi.fn()} onLaunched={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'New session · ACME' })).toBeTruthy()
    const options = [...container.ownerDocument.querySelectorAll('#launch-dirs option')].map((o) => o.getAttribute('value'))
    expect(options).toEqual(['/srv/web'])
  })
  it('scoped to a project: the title names it and its checkouts are suggested', () => {
    const s = {
      ...state(),
      projects: { p1: { ...({} as any), id: 'p1', workspaceId: 'w1', name: 'Web' } },
      checkouts: { p1: [{ projectId: 'p1', machine: 'vps-1', root: '/srv/web', branch: '' }] },
    } as any
    const { container } = render(<LaunchDialog state={s} projectId="p1" onClose={vi.fn()} onLaunched={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'New session · Web' })).toBeTruthy()
    expect([...container.ownerDocument.querySelectorAll('#launch-dirs option')].map((o) => o.getAttribute('value'))).toEqual(['/srv/web'])
  })
})
