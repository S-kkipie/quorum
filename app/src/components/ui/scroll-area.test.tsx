// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ScrollArea } from './scroll-area'

describe('ScrollArea', () => {
  it('exposes the viewport through viewportRef', () => {
    let el: HTMLDivElement | null = null
    const { container } = render(<ScrollArea viewportRef={(e) => { el = e }}><p>x</p></ScrollArea>)
    expect(container.querySelector('[data-slot="scroll-area-viewport"]')).toBe(el)
  })
})
