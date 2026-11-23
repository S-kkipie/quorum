// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Markdown from './Markdown'

afterEach(cleanup)

describe('Markdown', () => {
  it('renders headings, lists and gfm tables', () => {
    const { container } = render(<Markdown text={'# Title\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n'} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeTruthy()
    expect(container.querySelectorAll('li').length).toBe(2)
    expect(container.querySelector('table')).toBeTruthy()
    expect(container.querySelector('table')!.parentElement!.className).toContain('overflow-x-auto')
  })
  it('does not render raw <script> or <img onerror>', () => {
    const { container } = render(<Markdown text={'<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">'} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<script>')
  })
  it('javascript: link is not a link', () => {
    const { container } = render(<Markdown text={'[click](javascript:alert(1)) and [ok](https://example.com)'} />)
    expect(container.textContent).toContain('click')
    const links = container.querySelectorAll('a')
    expect(links.length).toBe(1)
    expect(links[0].getAttribute('href')).toBe('https://example.com')
    expect(links[0].getAttribute('target')).toBe('_blank')
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer')
  })
  it('code block has copy button that writes to clipboard', async () => {
    const writeText = vi.fn(async (_: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { container } = render(<Markdown text={'```js\nconst a = 1\n```'} />)
    expect(container.querySelector('pre')!.className).toContain('overflow-x-auto')
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const a = 1'))
    await screen.findByText('Copied')
  })
  it('images never load: link-styled label, no img element', () => {
    const { container } = render(<Markdown text={'![x](https://t/p.png) ![y](javascript:alert(1))'} />)
    expect(container.querySelector('img')).toBeNull()
    const a = container.querySelector('a')!
    expect(a.textContent).toBe('[image: x]')
    expect(a.getAttribute('href')).toBe('https://t/p.png')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(container.querySelectorAll('a').length).toBe(1)
    expect(container.textContent).toContain('[image: y]')
  })
  it('fenced block without language has no pill classes and keeps Copy', () => {
    const { container } = render(<Markdown text={'```\nplain\n```'} />)
    const code = container.querySelector('pre code')!
    expect(code.className).not.toContain('bg-zinc-800')
    expect(code.className).not.toContain('px-1')
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
    render(<Markdown text={'inline `x` here'} />)
    expect(document.querySelector('p code')!.className).toContain('bg-zinc-800')
  })
  it('autolink and mixed-case/whitespace javascript: scheme', () => {
    const { container } = render(<Markdown text={'<https://example.com/a> [bad]( JaVaScRiPt:alert(1))\n\n[b2](<JaVaScRiPt:x>)'} />)
    const links = container.querySelectorAll('a')
    expect(links.length).toBe(1)
    expect(links[0].getAttribute('href')).toBe('https://example.com/a')
    expect(container.textContent).toContain('bad')
  })
})
