// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Composer from './Composer'
import type { SessionCommands, SessionInfo } from '../proto.gen'

const DIR = '/home/u/.cache/quorum/uploads/2026-11-25'
let uploads = 0
let failName = ''
const fetchMock = vi.fn(async (u: string, i?: RequestInit) => {
  if (u.includes('/files?')) {
    const name = decodeURIComponent(u.split('name=')[1])
    if (name === failName) return new Response('{"error":"machine is offline"}', { status: 409 })
    uploads++
    return new Response(JSON.stringify({ path: `${DIR}/abc00${uploads}-${name}`, name, size: (i?.body as File).size, mime: (i?.body as File).type }), { status: 200 })
  }
  return new Response('{}', { status: 202 })
})
vi.stubGlobal('fetch', fetchMock)

const sess = (o: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 's1', recap: '', previousId: '', machine: 'm', name: 'n', cwd: '/x', root: '/x', model: '', role: 'work' as any,
  state: 'idle' as any, contextPct: 0, startedAt: 0, updatedAt: 0, transcriptPath: '', repoUrl: '', branch: '', projectId: '', launchReq: '', herdrPane: '', herdrWorkspace: '', account: '', accountKey: '', configDir: '', plugins: [], contextEstimate: false, tokens: { in: 0, out: 0, cache: 0 }, rateLimits: [], usageAt: 0, imagesDir: '', background: { tasks: 0, wakeAt: 0 }, unread: false, effort: '', modelOptions: [], effortOptions: [], ...o,
})
const LIST: SessionCommands = { session: 's1', hash: 'h1', commands: [
  { name: 'review', description: 'Review', source: 'plugin', plugin: 'x', group: 'plugin', terminalOnly: false },
] }

const file = (name: string, size = 3, type = 'image/png') => {
  const f = new File(['abc'], name, { type })
  if (size !== 3) Object.defineProperty(f, 'size', { value: size })
  return f
}
const box = () => screen.getByRole('combobox') as HTMLTextAreaElement
const pick = (files: File[], id = 'attach-media') => fireEvent.change(screen.getByTestId(id), { target: { files } })
const chips = () => {
  const list = screen.queryByRole('list', { name: 'Attachments' })
  return list ? within(list).getAllByRole('listitem') : []
}
const calls = (part: string) => fetchMock.mock.calls.filter(([u]) => String(u).includes(part))
const sent = (part: string) => JSON.parse(String(calls(part)[0][1]?.body))

beforeEach(() => { localStorage.clear(); uploads = 0; failName = '' })
afterEach(() => { cleanup(); fetchMock.mockClear() })

describe('Composer attachments', () => {
  it('the paperclip menu offers photos & videos and any file; the camera only on a touch screen', async () => {
    render(<Composer session={sess()} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Attach' }), { key: 'Enter' })
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual(['Photos & videos', 'File'])
    expect(screen.queryByTestId('attach-camera')).toBeNull()
    expect(screen.getByTestId('attach-media').getAttribute('accept')).toBe('image/*,video/*')
    expect(screen.getByTestId('attach-file').hasAttribute('accept')).toBe(false)
    expect(screen.getByTestId('attach-file').hasAttribute('capture')).toBe(false)
    cleanup()
    const prev = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: q.includes('coarse'), addEventListener() {}, removeEventListener() {} })) as any
    try {
      render(<Composer session={sess()} />)
      expect(screen.getByTestId('attach-camera').getAttribute('capture')).toBe('environment')
      fireEvent.keyDown(screen.getByRole('button', { name: 'Attach' }), { key: 'Enter' })
      expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual(['Take photo', 'Photos & videos', 'File'])
    } finally { window.matchMedia = prev }
  })

  it('picked files show as chips with name and size; remove drops one', () => {
    render(<Composer session={sess()} />)
    pick([file('a.png'), file('notes.pdf', 12_300, 'application/pdf')])
    expect(chips().map((c) => c.getAttribute('aria-label'))).toEqual(['a.png, 3 B', 'notes.pdf, 12 KB'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }))
    expect(chips()).toHaveLength(1)
  })

  it('a file over 100 MB is rejected with an error naming it', () => {
    render(<Composer session={sess()} />)
    pick([file('huge.mov', 100 * 1024 * 1024 + 1, 'video/quicktime'), file('ok.png')])
    expect(screen.getByRole('alert').textContent).toBe('huge.mov is over 100 MB')
    expect(chips()).toHaveLength(1)
  })

  it('more than 10 files are rejected', () => {
    render(<Composer session={sess()} />)
    pick(Array.from({ length: 11 }, (_, i) => file(`f${i}.png`)), 'attach-file')
    expect(chips()).toHaveLength(10)
    expect(screen.getByRole('alert').textContent).toBe('At most 10 files per message')
  })

  it('paste and drop add files; a text paste is left alone', () => {
    render(<Composer session={sess()} />)
    fireEvent.paste(box(), { clipboardData: { items: [{ kind: 'file', getAsFile: () => file('shot.png') }] } })
    expect(chips()).toHaveLength(1)
    fireEvent.paste(box(), { clipboardData: { items: [{ kind: 'string', getAsFile: () => null }] } })
    expect(chips()).toHaveLength(1)
    fireEvent.drop(box(), { dataTransfer: { types: ['Files'], files: [file('d.pdf', 3, 'application/pdf')] } })
    expect(chips().map((c) => c.getAttribute('aria-label'))).toEqual(['shot.png, 3 B', 'd.pdf, 3 B'])
  })

  it('send uploads each file to the session, then sends the mentions and the text', async () => {
    render(<Composer session={sess({ state: 'working' as any })} />)
    pick([file('a.png'), file('b.pdf', 3, 'application/pdf')])
    fireEvent.change(box(), { target: { value: 'look' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(calls('/prompt')).toHaveLength(1))
    const up = calls('/files?')
    expect(up.map(([u]) => u)).toEqual(['/api/sessions/s1/files?name=a.png', '/api/sessions/s1/files?name=b.pdf'])
    expect(new Headers(up[1][1]?.headers).get('Content-Type')).toBe('application/pdf')
    expect(sent('/prompt')).toEqual({ text: `@${DIR}/abc001-a.png\n@${DIR}/abc002-b.pdf\nlook`, mode: 'now' })
    await waitFor(() => expect(chips()).toHaveLength(0))
    expect(box().value).toBe('')
  })

  it('files alone can be sent', async () => {
    render(<Composer session={sess()} />)
    pick([file('a.png')])
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(calls('/prompt')).toHaveLength(1))
    expect(sent('/prompt')).toEqual({ text: `@${DIR}/abc001-a.png`, mode: 'queue' })
  })

  it('a slash command keeps the command first and appends the mentions', async () => {
    render(<Composer session={sess()} commands={LIST} />)
    pick([file('a.png'), file('b.png')])
    fireEvent.change(box(), { target: { value: '/review the diff' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(calls('/command')).toHaveLength(1))
    expect(sent('/command')).toEqual({ command: 'review', args: `the diff @${DIR}/abc001-a.png @${DIR}/abc002-b.png` })
  })

  it('interrupt mode is kept with attachments', async () => {
    render(<Composer session={sess({ state: 'working' as any })} />)
    pick([file('a.png')])
    fireEvent.change(box(), { target: { value: 'stop' } })
    fireEvent.keyDown(screen.getByRole('button', { name: 'More send options' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Interrupt and send' }))
    await waitFor(() => expect(calls('/prompt')).toHaveLength(1))
    expect(sent('/prompt').mode).toBe('interrupt')
  })

  it('a failed upload aborts the send, keeps draft and attachments; a retry does not upload the done ones again', async () => {
    failName = 'b.png'
    render(<Composer session={sess()} />)
    pick([file('a.png'), file('b.png')])
    fireEvent.change(box(), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Could not upload b.png: machine is offline')
    expect(calls('/prompt')).toHaveLength(0)
    expect(box().value).toBe('hi')
    expect(chips().map((c) => c.getAttribute('aria-label'))).toEqual(['a.png, 3 B, Uploaded', 'b.png, 3 B, Upload failed'])
    failName = ''
    fetchMock.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(calls('/prompt')).toHaveLength(1))
    expect(calls('/files?').map(([u]) => u)).toEqual(['/api/sessions/s1/files?name=b.png'])
    expect(sent('/prompt').text).toBe(`@${DIR}/abc001-a.png\n@${DIR}/abc002-b.png\nhi`)
  })

  it('a closed session takes no files', () => {
    render(<Composer session={sess({ state: 'closed' as any })} />)
    expect((screen.getByRole('button', { name: 'Attach' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.drop(box(), { dataTransfer: { types: ['Files'], files: [file('d.png')] } })
    expect(chips()).toHaveLength(0)
  })
})
