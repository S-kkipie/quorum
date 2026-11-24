// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageResponse } from './message'
import { Tool, ToolContent, ToolHeader } from './tool'

describe('ai-elements spike', () => {
  it('markdown response renders remote images as links', () => {
    const { container } = render(<MessageResponse>{'![chart](https://example.com/a.png)'}</MessageResponse>)
    expect(container.querySelector('img')).toBeNull()
    const link = container.querySelector('a[href="https://example.com/a.png"]')
    expect(link).not.toBeNull()
  })

  it('markdown response does not render raw html', () => {
    const { container } = render(<MessageResponse>{'<img src="https://example.com/x.png" onerror="alert(1)">'}</MessageResponse>)
    expect(container.querySelector('img')).toBeNull()
  })

  it('markdown response links open in a new tab and unsafe links are inert', () => {
    const { container } = render(<MessageResponse>{'[a](https://example.com) [b](javascript:alert(1))'}</MessageResponse>)
    const a = container.querySelector('a[href="https://example.com/"]')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(container.querySelectorAll('a')).toHaveLength(1)
  })

  it('tool hosts custom children', () => {
    const { container } = render(
      <Tool>
        <ToolHeader type="dynamic-tool" toolName="Read" title="Read google.ts" state="output-available" />
        <ToolContent><pre>diff</pre></ToolContent>
      </Tool>,
    )
    fireEvent.click(screen.getByText('Read google.ts'))
    expect(container.querySelector('pre')?.textContent).toBe('diff')
  })
})
