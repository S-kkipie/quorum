// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'

const createView = vi.fn()
vi.mock('../lib/api', () => ({ createView: (...a: any[]) => createView(...a), hubUrl: () => 'http://h:1' }))
// shiki's wasm engine does not run in jsdom: raw (unhighlighted) tokens are shown instead
vi.mock('shiki', () => ({ createHighlighter: () => new Promise(() => {}) }))
import Viewer from './Viewer'

const props = { machine: 'vps-1', sessionId: 's1', onBack: () => {} }
afterEach(cleanup)
beforeEach(() => { createView.mockReset(); vi.unstubAllGlobals() })

describe('Viewer', () => {
  it('html viewer iframe has sandbox without allow-same-origin', async () => {
    createView.mockResolvedValue({ url: '/v/tok/page.html' })
    render(<Viewer {...props} path="/p/docs/page.html" />)
    const f = await screen.findByTitle('page.html')
    expect(f.getAttribute('src')).toBe('http://h:1/v/tok/page.html')
    expect(f.getAttribute('sandbox')).toBe('allow-scripts allow-popups allow-forms allow-modals')
    expect(f.getAttribute('sandbox')).not.toContain('allow-same-origin')
    // the artifact's canvas follows the app theme (a `color-scheme: light dark` page has a transparent canvas)
    expect(f.className).toContain('bg-background')
    expect(f.className).not.toContain('bg-white')
    expect(createView).toHaveBeenCalledWith('vps-1', 's1', '/p/docs/page.html')
    expect(screen.getByText('vps-1 · docs')).toBeTruthy()
  })
  it('md viewer renders markdown from fetched text', async () => {
    createView.mockResolvedValue({ url: '/v/tok/n.md' })
    const f = vi.fn(async () => new Response('# Hello title\n\nbody **bold**'))
    vi.stubGlobal('fetch', f)
    render(<Viewer {...props} path="/p/n.md" />)
    expect(await screen.findByRole('heading', { name: 'Hello title' })).toBeTruthy()
    expect((f.mock.calls[0] as any)[0]).toBe('http://h:1/v/tok/n.md')
  })
  it('a pasted image asks for an images link', async () => {
    createView.mockResolvedValue({ url: '/v/tok/1.png' })
    render(<Viewer {...props} path="/tmp/claude-1000/-p/s1/images/1.png" images />)
    expect(await screen.findByRole('img', { name: '1.png' })).toBeTruthy()
    expect(createView).toHaveBeenCalledWith('vps-1', 's1', '/tmp/claude-1000/-p/s1/images/1.png', 'images')
  })
  it('an image Claude read asks for a read link', async () => {
    createView.mockResolvedValue({ url: '/v/tok/shot.png' })
    render(<Viewer {...props} path="/home/u/shot.png" read />)
    expect(await screen.findByRole('img', { name: 'shot.png' })).toBeTruthy()
    expect(createView).toHaveBeenCalledWith('vps-1', 's1', '/home/u/shot.png', 'read')
  })
  it('image viewer zoom buttons', async () => {
    createView.mockResolvedValue({ url: '/v/tok/a.png' })
    render(<Viewer {...props} path="/p/a.png" />)
    const img = await screen.findByRole('img', { name: 'a.png' })
    expect(img.style.width).toBe('100%')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(img.style.width).toBe('150%')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(img.style.width).toBe('75%')
  })
  it('pdf viewer uses an unsandboxed iframe', async () => {
    createView.mockResolvedValue({ url: '/v/tok/a.pdf' })
    render(<Viewer {...props} path="/p/a.pdf" />)
    const f = await screen.findByTitle('a.pdf')
    expect(f.hasAttribute('sandbox')).toBe(false)
  })
  it('error from createView is shown', async () => {
    createView.mockRejectedValue(new Error('outside the project folder'))
    const back = vi.fn()
    render(<Viewer {...props} onBack={back} path="/etc/x.html" />)
    expect(await screen.findByText('outside the project folder')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(back).toHaveBeenCalled()
  })
  it('open in new tab uses noopener', async () => {
    createView.mockResolvedValue({ url: '/v/tok/p.html' })
    const open = vi.fn()
    vi.stubGlobal('open', open)
    render(<Viewer {...props} path="/p/p.html" />)
    await screen.findByTitle('p.html')
    fireEvent.click(screen.getByRole('button', { name: 'Open in new tab' }))
    expect(open).toHaveBeenCalledWith('http://h:1/v/tok/p.html', '_blank', 'noopener')
    await waitFor(() => expect(createView).toHaveBeenCalledTimes(1))
  })
  it('text files render as code, capped at 2,000 lines', async () => {
    createView.mockResolvedValue({ url: '/v/tok/a.ts' })
    const body = Array.from({ length: 2500 }, (_, i) => `const v${i} = ${i}`).join('\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    render(<Viewer {...props} path="/p/src/a.ts" />)
    expect(await screen.findByText('Showing the first 2,000 lines.')).toBeTruthy()
    await waitFor(() => expect(document.body.textContent).toContain('const v1999 = 1999'))
    expect(document.body.textContent).not.toContain('const v2000 = 2000')
  })
  it('a huge text file is read only up to ~1 MB, with a note', async () => {
    createView.mockResolvedValue({ url: '/v/tok/big.log' })
    const line = 'x'.repeat(999) + '\n' // 1,000 bytes a line: the byte cap comes before the line cap
    const chunk = new TextEncoder().encode(line.repeat(64)) // 64 kB
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulls++; if (pulls > 400) c.close(); else c.enqueue(chunk) }, // up to 25 MB if read to the end
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    render(<Viewer {...props} path="/p/big.log" />)
    expect(await screen.findByText('Showing the first 1 MB.')).toBeTruthy()
    expect(pulls).toBeLessThanOrEqual(20)
  })
  it('short text files show no cap note', async () => {
    createView.mockResolvedValue({ url: '/v/tok/a.json' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"a": 1}')))
    render(<Viewer {...props} path="/p/a.json" />)
    await waitFor(() => expect(document.body.textContent).toContain('"a"'))
    expect(screen.queryByText('Showing the first 2,000 lines.')).toBeNull()
  })
  it('binary files cannot be previewed', async () => {
    createView.mockResolvedValue({ url: '/v/tok/a.bin' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ab\u0000cd')))
    render(<Viewer {...props} path="/p/a.bin" />)
    expect(await screen.findByText('This file cannot be previewed.')).toBeTruthy()
  })
})
