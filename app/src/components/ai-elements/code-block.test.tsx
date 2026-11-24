// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { ThemedToken } from 'shiki'
import { TokenSpan } from './code-block'

const tok = (htmlStyle: Record<string, string>): ThemedToken => ({ content: 'x', offset: 0, htmlStyle } as ThemedToken)

describe('code block tokens', () => {
  it('switch text colour in dark; switch background only when the token carries one', () => {
    const plain = render(<TokenSpan token={tok({ color: '#111', '--shiki-dark': '#eee' })} />).container.querySelector('span')!
    expect(plain.className).toContain('dark:!text-[var(--shiki-dark)]')
    expect(plain.className).not.toContain('shiki-dark-bg')
    const marked = render(<TokenSpan token={tok({ color: '#111', '--shiki-dark': '#eee', 'background-color': '#ffd', '--shiki-dark-bg': '#330' })} />).container.querySelector('span')!
    expect(marked.className).toContain('dark:!bg-[var(--shiki-dark-bg)]')
  })
})
