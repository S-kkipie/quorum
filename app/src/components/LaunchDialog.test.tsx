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
  it('initialPrompt: an editable first prompt, prefilled machine and folder, sent with the launch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ reqId: 'r1' })))
    vi.stubGlobal('fetch', fetchMock)
    const s = { ...state(), machines: { ...state().machines, 'vps-2': { ...state().machines['vps-1'], name: 'vps-2' } } }
    const onLaunched = vi.fn()
    render(<LaunchDialog state={s} projectId="p1" initialPrompt={'## My open tickets\n- Acme'} initialMachine="vps-2" initialDir="/srv/acme" onClose={vi.fn()} onLaunched={onLaunched} />)
    expect(screen.getByRole('heading', { name: 'Continue where I left off' })).toBeTruthy()
    expect((screen.getByDisplayValue('vps-2') as HTMLSelectElement).tagName).toBe('SELECT')
    expect((screen.getByPlaceholderText('/path/to/project') as HTMLInputElement).value).toBe('/srv/acme')
    const box = screen.getByLabelText('First prompt') as HTMLTextAreaElement
    expect(box.value).toBe('## My open tickets\n- Acme')
    fireEvent.change(box, { target: { value: 'Edited prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await vi.waitFor(() => expect(onLaunched).toHaveBeenCalled())
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body))
    expect(body).toMatchObject({ machine: 'vps-2', dir: '/srv/acme', prompt: 'Edited prompt', projectId: 'p1' })
  })
  it('without initialPrompt there is no prompt box and no prompt is sent', () => {
    render(<LaunchDialog state={state()} onClose={vi.fn()} onLaunched={vi.fn()} />)
    expect(screen.queryByLabelText('First prompt')).toBeNull()
  })
})
