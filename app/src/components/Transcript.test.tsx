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
  it('scrolls inside a ScrollArea whose viewport is the scroll element', () => {
    render(<Transcript events={evs} />)
    const log = screen.getByRole('log')
    expect(log.querySelector('[data-slot="scroll-area"] [data-slot="scroll-area-viewport"]')).toBeTruthy()
  })
  it('scrolling near the top loads earlier events, unless autoLoad is off', () => {
    const onLoadMore = vi.fn()
    const { rerender } = render(<Transcript events={evs} hasMore onLoadMore={onLoadMore} />)
    const scroller = screen.getByRole('log').querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement
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
    expect(createView).toHaveBeenCalledWith('vps-1', 's1', `${IMG}/1.png`, 'images')
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
      ev(8, 'tool_start', { id: 't3', name: 'Write', summary: '/p/w.png', input: { file_path: '/p/w.png' } }),
      ev(9, 'tool_end', { id: 't3', ok: true, ms: 1, output: 'ok' }),
    ]
    const { container } = render(<Transcript machine="vps-1" sessionId="s1" base="/p" onOpenFile={() => {}} events={events} live="![l](https://example.com/f.png)" />)
    await screen.findByRole('img', { name: 'Image #1' })
    await screen.findByRole('img', { name: 'shot.png' })
    const nonData = [...container.querySelectorAll('img')].filter((i) => !(i.getAttribute('src') ?? '').startsWith('data:'))
    expect(nonData.map((i) => i.getAttribute('alt'))).toEqual(['Image #1', 'shot.png'])
    for (const i of nonData) expect(i.getAttribute('src')).toMatch(/^\/v\/[0-9a-f]+\/[^/]+$/)
    expect(createView.mock.calls.map((c) => c.slice(2))).toEqual([[`${IMG}/1.png`, 'images'], ['/p/shot.png', 'read']])
  })
})

describe('Transcript read images', () => {
  const read = (seq: number, id: string, file: string, ok = true) => [
    ev(seq, 'tool_start', { id, name: 'Read', summary: file, input: { file_path: file } }),
    ev(seq + 1, 'tool_end', { id, ok, ms: 1, output: '' }),
  ]
  afterEach(() => { createView.mockReset(); resetPastedImageLinks() })

  it('a Read of an image shows a 64 px thumbnail in the collapsed row; tap opens the Viewer in read mode', async () => {
    createView.mockImplementation(async (_m: string, _s: string, p: string) => ({ url: `/v/beef/${p.split('/').pop()}` }))
    const onOpenFile = vi.fn()
    render(<Transcript machine="vps-1" sessionId="s1" base="/p" onOpenFile={onOpenFile} events={read(1, 't1', '/home/u/Shot.PNG')} />)
    const img = await screen.findByRole('img', { name: 'Shot.PNG' })
    expect(img.getAttribute('src')).toBe('/v/beef/Shot.PNG')
    expect(img.className).toContain('size-16')
    expect(screen.getByRole('button', { name: /Read Shot\.PNG/ }).getAttribute('aria-expanded')).toBe('false')
    expect(createView).toHaveBeenCalledWith('vps-1', 's1', '/home/u/Shot.PNG', 'read')
    fireEvent.click(screen.getByRole('button', { name: 'Open Shot.PNG' }))
    expect(onOpenFile).toHaveBeenCalledWith('/home/u/Shot.PNG', { read: true })
  })

  it('a grouped Read row shows at most 4 thumbnails and +N; non-images, relative and failed reads get none', async () => {
    createView.mockImplementation(async (_m: string, _s: string, p: string) => ({ url: `/v/beef/${p.split('/').pop()}` }))
    const files = ['/p/1.png', '/p/a.ts', '/p/2.jpg', '/p/3.jpeg', '/p/4.gif', '/p/5.webp', '/p/6.png']
    const events = [...files.flatMap((f, k) => read(1 + 2 * k, `t${k}`, f)), ...read(20, 'tx', 'rel.png'), ...read(30, 'ty', '/p/bad.png', false)]
    render(<Transcript machine="vps-1" sessionId="s1" base="/p" onOpenFile={() => {}} events={events} />)
    await screen.findByRole('img', { name: '4.gif' })
    expect(screen.getAllByRole('img').map((i) => i.getAttribute('alt'))).toEqual(['1.png', '2.jpg', '3.jpeg', '4.gif'])
    expect(createView).toHaveBeenCalledTimes(4)
    // +N is a 64 px button that opens the row, which lists every file
    const more = screen.getByRole('button', { name: 'Show 2 more images' })
    expect(more.textContent).toBe('+2')
    expect(more.className).toContain('size-16')
    const row = screen.getByRole('button', { name: /Read 1\.png and 8 more/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/\/p\/6\.png/)).toBeTruthy()
  })

  it('a refused or foreign link shows a placeholder, never an img', async () => {
    createView.mockImplementation(async (_m: string, _s: string, p: string) => {
      if (p.endsWith('a.png')) throw new Error('This image is not available.')
      return { url: 'https://evil.example/v/ab/b.png' }
    })
    const { container } = render(<Transcript machine="vps-1" sessionId="s1" events={[...read(1, 't1', '/p/a.png'), ...read(5, 't2', '/q/b.png')]} />)
    await waitFor(() => expect(createView).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('a.png', { selector: 'button span' })).toBeTruthy()
  })
})

describe('Transcript: command cards', () => {
  const cmd = (seq: number, d: any) => ev(seq, 'command', { origin: 'device', args: '', ...d })
  it('shows /name args, from phone, and each status', () => {
    render(<Transcript events={[
      cmd(1, { id: 'a', name: 'brainstorming', status: 'queued' }),
      cmd(2, { id: 'b', name: 'model', args: 'sonnet', status: 'done', text: 'Set model to Sonnet' }),
      cmd(3, { id: 'c', name: 'init', status: 'failed', error: 'Waiting for an answer in the terminal.' }),
      cmd(4, { id: 'd', name: 'compact', status: 'done' }),
    ]} />)
    const cards = screen.getAllByRole('article', { name: /^Command/ })
    expect(cards).toHaveLength(4)
    expect(cards[0].textContent).toContain('/brainstorming')
    expect(cards[0].textContent).toContain('from phone')
    expect(cards[0].textContent).toContain('Runs when Claude finishes this turn')
    expect(cards[1].textContent).toContain('/model sonnet')
    expect(cards[1].textContent).toContain('Set model to Sonnet')
    expect(cards[2].textContent).toContain('Failed: Waiting for an answer in the terminal.')
    expect(cards[3].textContent).toContain('Done')
  })
  it('the latest status of an id replaces the earlier one', () => {
    render(<Transcript events={[cmd(1, { id: 'a', name: 'compact', status: 'queued' }), cmd(2, { id: 'a', name: 'compact', status: 'done', text: 'ok' })]} />)
    expect(screen.getAllByRole('article', { name: /^Command/ })).toHaveLength(1)
    expect(screen.queryByText('Runs when Claude finishes this turn')).toBeNull()
  })
  it('long output collapses beyond 6 lines with Show more', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
    render(<Transcript events={[cmd(1, { id: 'a', name: 'insights', status: 'done', text })]} />)
    const out = screen.getByTestId('command-output')
    expect(out.textContent).toContain('line 6')
    expect(out.textContent).not.toContain('line 7')
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByTestId('command-output').textContent).toContain('line 10')
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy()
  })
  it('a command user event renders a compact mono /name args bubble; a device one next to its card renders nothing', () => {
    render(<Transcript events={[
      ev(1, 'user', { text: '/humanizer fix it', command: { name: 'humanizer', args: 'fix it' }, device: true }),
      cmd(2, { id: 'a', name: 'humanizer', args: 'fix it', status: 'done' }),
      ev(3, 'user', { text: '/init', command: { name: 'init', args: '' } }),
    ]} />)
    const you = screen.getAllByRole('article', { name: 'You' })
    expect(you).toHaveLength(1)
    const bubble = screen.getByTestId('command-prompt')
    expect(bubble.textContent).toBe('/init')
    expect(bubble.className).toContain('font-mono')
    expect(screen.queryByText(/<command-/)).toBeNull()
  })
  it('Claude answers in the reading serif at 15.5 px, capped near 70ch; your messages sit in the bubble fill', () => {
    render(<Transcript events={[ev(1, 'user', { text: 'hello' }), ev(2, 'assistant', { text: 'hi there' })]} live="still typing" />)
    const [answer, live] = screen.getAllByRole('article', { name: 'Claude' }).map((a) => a.firstElementChild as HTMLElement)
    for (const el of [answer, live]) {
      expect(el.className).toMatch(/\bfont-serif\b/)
      expect(el.className).toContain('text-[15.5px]')
      expect(el.className).toContain('leading-[1.6]')
      expect(el.className).toContain('max-w-[70ch]')
    }
    const you = screen.getByRole('article', { name: 'You' }).firstElementChild as HTMLElement
    expect(you.className).toContain('bg-bubble')
    expect(you.className).not.toMatch(/font-serif/)
  })
  it('short output has no Show more', () => {
    render(<Transcript events={[cmd(1, { id: 'a', name: 'recap', status: 'done', text: 'one\ntwo' })]} />)
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })
})

describe('Transcript: compacts and earlier conversation', () => {
  const at = new Date(2026, 10, 24, 14, 32).getTime()
  const convo = [ev(1, 'user', { text: 'first question' }), ev(2, 'assistant', { text: 'first answer' }), ev(3, 'compact', { at, trigger: 'auto' }), ev(4, 'user', { text: 'after the compact' })]
  it('a compact is a divider with its time and trigger; no time without `at`', () => {
    const { unmount } = render(<Transcript events={[ev(1, 'compact', { at, trigger: 'manual' })]} />)
    const a = screen.getByRole('separator')
    expect(a.getAttribute('aria-label')).toBe('Conversation compacted · 14:32')
    expect(a.textContent).toContain('manual')
    unmount()
    render(<Transcript events={[ev(1, 'compact', { trigger: 'auto' })]} />)
    expect(screen.getByRole('separator').getAttribute('aria-label')).toBe('Conversation compacted')
  })
  it('everything before the newest compact folds into one row that expands on tap', () => {
    const onLoadMore = vi.fn()
    render(<Transcript events={convo} onLoadMore={onLoadMore} />)
    expect(screen.queryByText('first question')).toBeNull()
    expect(screen.getByText('after the compact')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Earlier conversation (2 messages)' }))
    expect(screen.getByText('first question')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Earlier conversation/ })).toBeNull()
    // what was folded is in memory: nothing is fetched
    expect(onLoadMore).not.toHaveBeenCalled()
  })
  it('a focus on a row folded by a compact unfolds it', () => {
    const { rerender } = render(<Transcript events={convo} />)
    expect(screen.queryByText('first question')).toBeNull()
    rerender(<Transcript events={convo} focus={{ key: 'user:1', n: 1 }} />)
    expect(screen.getByText('first question')).toBeTruthy()
  })
  it('a newer compact folds the conversation again', () => {
    const { rerender } = render(<Transcript events={convo} />)
    fireEvent.click(screen.getByRole('button', { name: 'Earlier conversation (2 messages)' }))
    rerender(<Transcript events={[...convo, ev(5, 'compact', { at, trigger: 'auto' }), ev(6, 'user', { text: 'after the second compact' })]} />)
    expect(screen.getByRole('button', { name: 'Earlier conversation (3 messages)' })).toBeTruthy()
    expect(screen.queryByText('after the compact')).toBeNull()
  })
  it('loading older history while folded shows the loading row', () => {
    render(<Transcript events={convo.slice(2)} hasMore loading />)
    expect(screen.getByText('Loading earlier…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Earlier conversation' })).toBeTruthy()
  })
  it('with nothing loaded before the compact, the row loads older history; scrolling up does not while folded', () => {
    const onLoadMore = vi.fn()
    render(<Transcript events={convo.slice(2)} hasMore onLoadMore={onLoadMore} />)
    const scroller = screen.getByRole('log').querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(onLoadMore).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Earlier conversation' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    // now unfolded: the usual loader is back
    expect(screen.getByRole('button', { name: 'Load earlier' })).toBeTruthy()
  })
  it('more history to read: the count says so', () => {
    render(<Transcript events={convo} hasMore />)
    expect(screen.getByRole('button', { name: 'Earlier conversation (2+ messages)' })).toBeTruthy()
  })
  it('an offline machine shows its message with Try again, and scrolling up does not retry', () => {
    const onLoadMore = vi.fn()
    render(<Transcript events={evs} hasMore notice="Older history is on laptop, which is offline." onLoadMore={onLoadMore} />)
    expect(screen.getByText('Older history is on laptop, which is offline.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    const scroller = screen.getByRole('log').querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(onLoadMore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })
  it('a page being read shows a loading row instead of the button', () => {
    render(<Transcript events={evs} hasMore loading />)
    expect(screen.getByText('Loading earlier…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull()
  })
  it('machine history rows (no seq) render next to hub rows', () => {
    const h = (key: string, text: string): Event => ({ seq: 0, session: 's', ts: 1, kind: 'user', data: { text }, key })
    render(<Transcript events={[h('a/0', 'from the machine'), h('b/0', 'also from the machine'), ev(1, 'user', { text: 'from the hub' })]} />)
    expect(screen.getAllByRole('article', { name: 'You' }).map((x) => x.textContent)).toEqual(['from the machine', 'also from the machine', 'from the hub'])
  })
})

describe('Transcript: virtualized', () => {
  it('renders only the rows near the viewport of a long session', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 390, height: 600, top: 0, left: 0, right: 390, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    const off = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(60)
    try {
      const many = Array.from({ length: 1000 }, (_, i) => ev(i + 1, 'user', { text: `message ${i + 1}` }))
      render(<Transcript events={many} />)
      const shown = screen.getAllByRole('article', { name: 'You' }).length
      expect(shown).toBeGreaterThan(5)
      expect(shown).toBeLessThan(60)
    } finally { rect.mockRestore(); off.mockRestore() }
  })
  it('reports whether the reader is at the bottom', () => {
    const onAtBottom = vi.fn()
    render(<Transcript events={evs} onAtBottom={onAtBottom} />)
    expect(onAtBottom).toHaveBeenCalledWith(true)
  })
})
