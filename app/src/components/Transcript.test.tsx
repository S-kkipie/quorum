// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const createView = vi.fn()
// empty hub = the hub serves the app: view links are same-origin
vi.mock('../lib/api', () => ({ createView: (...a: any[]) => createView(...a), hubUrl: () => '' }))
import Transcript from './Transcript'
import { resetPastedImageLinks } from './timeline/PastedImages'
import type { Event } from '../proto.gen'

const ev = (seq: number, kind: string, data: any): Event => ({ seq, session: 's', ts: 0, kind, data })
const evs = [
  ev(1, 'user', { text: 'hello' }),
  ev(2, 'tool_start', { id: 't1', name: 'Bash', summary: 'ls -la' }),
  ev(3, 'tool_start', { id: 't2', name: 'Read', summary: 'a.go' }),
  ev(4, 'tool_end', { id: 't1', ok: true, ms: 12, output: 'OUTPUT-ONE' }),
]
afterEach(cleanup)

describe('Transcript', () => {
  it('renders tool titles from the timeline model, without end-of-turn rows', () => {
    render(<Transcript events={[...evs, ev(5, 'turn_end', { reason: 'end', outputTokens: 9 })]} />)
    expect(screen.getByText('ls -la')).toBeTruthy()
    expect(screen.getByText('Read a.go')).toBeTruthy()
    expect(screen.queryByText(/end of turn/)).toBeNull()
  })
  it('an artifact outside the base says so', () => {
    render(<Transcript base="/p" events={[ev(1, 'tool_start', { id: 'w', name: 'Write', summary: '', input: { file_path: '/tmp/r.html' } }), ev(2, 'tool_end', { id: 'w', ok: true, ms: 1, output: '' })]} />)
    expect(screen.getByText('r.html')).toBeTruthy()
    expect(screen.getByText('outside the project folder')).toBeTruthy()
  })
  it('detail expands on tap', () => {
    render(<Transcript events={evs} />)
    expect(screen.queryByText('OUTPUT-ONE')).toBeNull()
    fireEvent.click(screen.getByText('ls -la'))
    expect(screen.getByText('OUTPUT-ONE')).toBeTruthy()
  })
  it('streaming text at the end and subagent with status', () => {
    render(<Transcript events={[ev(1, 'agent_start', { id: 'a', type: 'Explore', description: 'searches' })]} live="typing" />)
    expect(screen.getByLabelText('running')).toBeTruthy()
    expect(screen.getByText(/typing/)).toBeTruthy()
  })
  it('assistant text renders markdown heading', () => {
    render(<Transcript events={[ev(1, 'assistant', { text: '# Title\n\nbody' })]} />)
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy()
  })
  it('artifact Open calls onOpenFile', () => {
    const onOpenFile = vi.fn()
    render(<Transcript base="/p" onOpenFile={onOpenFile} events={[ev(1, 'tool_start', { id: 'w', name: 'Write', summary: '', input: { file_path: '/p/r.html' } }), ev(2, 'tool_end', { id: 'w', ok: true, ms: 1, output: '' })]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenFile).toHaveBeenCalledWith('/p/r.html')
  })
  it('user and assistant turns render inside message containers', () => {
    render(<Transcript events={[ev(1, 'user', { text: 'hello' }), ev(2, 'assistant', { text: 'hi there' }), ev(3, 'info', { text: 'compacted' })]} />)
    expect(screen.getByRole('log')).toBeTruthy()
    expect(screen.getByRole('article', { name: 'You' }).textContent).toContain('hello')
    expect(screen.getByRole('article', { name: 'Claude' }).textContent).toContain('hi there')
    expect(screen.getByRole('note').textContent).toBe('compacted')
  })
  it('a tool row is a collapsed disclosure that expands on click', () => {
    render(<Transcript events={evs} />)
    const row = screen.getByRole('button', { name: /ls -la/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('OUTPUT-ONE')).toBeTruthy()
  })
  it('a remote image in assistant text never renders an img', () => {
    const { container } = render(<Transcript events={[ev(1, 'assistant', { text: '![x](https://example.com/a.png)' })]} />)
    expect(container.querySelector('img')).toBeNull()
    const a = container.querySelector('a[href="https://example.com/a.png"]')!
    expect(a.textContent).toBe('[image: x]')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })
  it('working without streamed text shows the working indicator', () => {
    const { rerender } = render(<Transcript events={evs} />)
    expect(screen.queryByRole('status')).toBeNull()
    rerender(<Transcript events={evs} working />)
    expect(screen.getByRole('status').textContent).toBe('Working…')
    rerender(<Transcript events={[...evs, ev(5, 'thinking', {})]} working />)
    expect(screen.getByRole('status').textContent).toBe('Thinking…')
    rerender(<Transcript events={evs} working live="typing" />)
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('scrolling near the top loads earlier events, unless autoLoad is off', () => {
    const onLoadMore = vi.fn()
    const { rerender } = render(<Transcript events={evs} hasMore onLoadMore={onLoadMore} />)
    const scroller = screen.getByRole('log').firstElementChild as HTMLElement
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    rerender(<Transcript events={evs} hasMore autoLoad={false} onLoadMore={onLoadMore} />)
    fireEvent.scroll(scroller)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })
})

describe('Transcript: per-turn tokens', () => {
  const turn = (model: string) => [ev(1, 'user', { text: 'q' }), ev(2, 'assistant', { text: 'a' }), ev(3, 'turn_end', { reason: 'end', tokens: { in: 1200, out: 340, cache: 4100 }, model })]
  it('shows the token line and who answered when Haiku', () => {
    render(<Transcript events={turn('claude-haiku-5-5')} />)
    expect(screen.getByText('↑1.2k ↓340 · cache 4.1k')).toBeTruthy()
    expect(screen.getByText('Answered by Haiku')).toBeTruthy()
  })
  it('no "Answered by" for other models', () => {
    render(<Transcript events={turn('claude-opus-5-5')} />)
    expect(screen.getByText('↑1.2k ↓340 · cache 4.1k')).toBeTruthy()
    expect(screen.queryByText(/Answered by/)).toBeNull()
  })
})

describe('Transcript file paths', () => {
  it('assistant paths call onOpenFile with the absolute path', () => {
    const onOpenFile = vi.fn()
    render(<Transcript base="/p" onOpenFile={onOpenFile} events={[ev(1, 'assistant', { text: 'Changed src/a.ts today' })]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open src/a.ts' }))
    expect(onOpenFile).toHaveBeenCalledWith('/p/src/a.ts')
  })
})

describe('Transcript pasted images', () => {
  const IMG = '/tmp/claude-1000/-p/s1/images'
  const userWith = (seq: number, images: any) => ev(seq, 'user', { text: 'look at [Image #1] and [Image #2]', images })
  afterEach(() => { createView.mockReset(); resetPastedImageLinks() })

  it('a user message with images renders a 64 px thumbnail per image from a same-origin view link; tap opens the Viewer', async () => {
    createView.mockImplementation(async (_m: string, _s: string, p: string) => ({ url: `/v/${p.endsWith('1.png') ? 'aa01' : 'aa02'}/${p.split('/').pop()}` }))
    const onOpenFile = vi.fn()
    render(<Transcript machine="vps-1" sessionId="s1" base="/p" onOpenFile={onOpenFile}
      events={[userWith(1, [{ n: 1, path: `${IMG}/1.png` }, { n: 2, path: `${IMG}/2.jpg` }])]} />)
    const one = await screen.findByRole('img', { name: 'Image #1' })
    const two = await screen.findByRole('img', { name: 'Image #2' })
    expect(one.getAttribute('src')).toBe('/v/aa01/1.png')
    expect(two.getAttribute('src')).toBe('/v/aa02/2.jpg')
    expect(one.className).toContain('size-16')
    expect(createView).toHaveBeenCalledWith('vps-1', 's1', `${IMG}/1.png`, true)
    fireEvent.click(screen.getByRole('button', { name: 'Open Image #2' }))
    expect(onOpenFile).toHaveBeenCalledWith(`${IMG}/2.jpg`, { images: true })
  })

  it('view links are fetched once per session and path, even across re-renders and repeated messages', async () => {
    createView.mockResolvedValue({ url: '/v/ab12/1.png' })
    const evs1 = [userWith(1, [{ n: 1, path: `${IMG}/1.png` }])]
    const { rerender } = render(<Transcript machine="vps-1" sessionId="s1" events={evs1} />)
    await screen.findByRole('img', { name: 'Image #1' })
    rerender(<Transcript machine="vps-1" sessionId="s1" events={[...evs1, userWith(2, [{ n: 1, path: `${IMG}/1.png` }])]} />)
    await waitFor(() => expect(screen.getAllByRole('img', { name: 'Image #1' })).toHaveLength(2))
    expect(createView).toHaveBeenCalledTimes(1)
  })

  it('a refused link shows a placeholder, never an img', async () => {
    createView.mockRejectedValue(new Error('outside the project folder'))
    const { container } = render(<Transcript machine="vps-1" sessionId="s1" events={[userWith(1, [{ n: 1, path: `${IMG}/1.png` }])]} />)
    await waitFor(() => expect(createView).toHaveBeenCalled())
    await screen.findByText('Image #1')
    expect(container.querySelector('img')).toBeNull()
  })

  it('a link that is not the hub\'s own /v/ link is never put in an img', async () => {
    createView.mockResolvedValue({ url: 'https://evil.example/v/ab/1.png' })
    const { container } = render(<Transcript machine="vps-1" sessionId="s1" events={[userWith(1, [{ n: 1, path: `${IMG}/1.png` }])]} />)
    await waitFor(() => expect(createView).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector('img')).toBeNull()
  })

  it('malformed images data is ignored', () => {
    render(<Transcript machine="vps-1" sessionId="s1" events={[userWith(1, [{ n: 'x', path: 1 }, null, 'a']), userWith(2, 'nope')]} />)
    expect(createView).not.toHaveBeenCalled()
  })

  it('the thumbnails are the only img with a non-data src in the transcript, and their src is same-origin /v/', async () => {
    createView.mockImplementation(async (_m: string, _s: string, p: string) => ({ url: `/v/0123abcd/${p.split('/').pop()}` }))
    const events = [
      userWith(1, [{ n: 1, path: `${IMG}/1.png` }]),
      ev(2, 'assistant', { text: '![remote](https://example.com/a.png) and <img src="https://example.com/b.png"> and ![rel](/v/x/y.png)' }),
      ev(3, 'tool_start', { id: 't1', name: 'Read', summary: '/p/shot.png', input: { file_path: '/p/shot.png' } }),
      ev(4, 'tool_end', { id: 't1', ok: true, ms: 1, output: '<img src="https://example.com/c.png">' }),
      ev(5, 'tool_start', { id: 't2', name: 'Write', summary: '/p/r.html', input: { file_path: '/p/r.html', content: '<img src="https://example.com/d.png">' } }),
      ev(6, 'tool_end', { id: 't2', ok: true, ms: 1, output: 'ok' }),
      ev(7, 'info', { text: '<img src="https://example.com/e.png">' }),
    ]
    const { container } = render(<Transcript machine="vps-1" sessionId="s1" base="/p" onOpenFile={() => {}} events={events} live="![l](https://example.com/f.png)" />)
    await screen.findByRole('img', { name: 'Image #1' })
    const nonData = [...container.querySelectorAll('img')].filter((i) => !(i.getAttribute('src') ?? '').startsWith('data:'))
    expect(nonData).toHaveLength(1)
    expect(nonData[0].getAttribute('alt')).toBe('Image #1')
    expect(nonData[0].getAttribute('src')).toMatch(/^\/v\/[0-9a-f]+\/1\.png$/)
  })
})
