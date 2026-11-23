// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'

const createView = vi.fn()
vi.mock('../lib/api', () => ({ createView: (...a: any[]) => createView(...a), hubUrl: () => 'http://h:1' }))
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
})
