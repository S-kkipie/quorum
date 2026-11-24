// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import ToolItem from '@/components/timeline/ToolItem'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { SESSION_STATE } from '@/lib/projects'

afterEach(cleanup)

/** Interaction polish (Plan 9, Task 4): the contract the primitives and the base stylesheet keep. */
const CSS = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8')

describe('interaction polish', () => {
  it('buttons give press feedback with transform only, never transition-all', () => {
    render(<Button>Go</Button>)
    const cls = screen.getByRole('button', { name: 'Go' }).className
    expect(cls).toContain('motion-safe:active:scale-[0.97]')
    expect(cls).toContain('duration-[120ms]')
    expect(cls).not.toContain('transition-all')
    expect(cls).toContain('focus-visible:outline-ring')
  })

  it('collapsible content animates its height and is instant under reduced motion', () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent>Body</CollapsibleContent>
      </Collapsible>,
    )
    fireEvent.click(screen.getByText('Toggle'))
    const cls = screen.getByText('Body').className
    expect(cls).toContain('data-[state=open]:animate-collapsible-down')
    expect(cls).toContain('overflow-hidden')
    expect(cls).toContain('motion-reduce:animate-none')
  })

  it('a neutral tool tile stays visible while its row is hovered or pressed', () => {
    render(<ToolItem item={{ t: 'tool', seq: 1, id: 't', name: 'Bash', kind: 'bash', title: 'List files', state: 'ok' }} />)
    const row = screen.getByRole('button', { name: /List files/ })
    expect(row.className).toContain('group/row')
    const tile = row.querySelector('span.rounded-md')
    expect(tile?.className).toContain('group-hover/row:bg-surface')
    expect(tile?.className).toContain('group-active/row:bg-surface')
    expect(tile?.className).toContain('transition-colors')
    expect(tile?.className).toContain('duration-100')
  })

  it('the base stylesheet turns enter/exit movement into a fade under reduced motion', () => {
    const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce) {\n  *'))
    expect(block).toMatch(/--tw-enter-translate-y: 0 !important/)
    expect(block).toMatch(/--tw-exit-scale: 1 !important/)
    expect(block).toMatch(/--tw-enter-opacity: 0 !important/)
  })

  it('a sheet overlay leaves with its content (same exit duration)', () => {
    render(<Sheet open><SheetContent><SheetTitle>T</SheetTitle><SheetDescription>D</SheetDescription></SheetContent></Sheet>)
    const overlay = document.querySelector('[data-slot="sheet-overlay"]')!.className
    const content = document.querySelector('[data-slot="sheet-content"]')!.className
    const exit = (c: string) => c.match(/data-\[state=closed\]:duration-(\d+)/)?.[1]
    expect(exit(overlay)).toBe('200')
    expect(exit(overlay)).toBe(exit(content))
  })

  it('looping indicators hold still under reduced motion', () => {
    render(<Shimmer>Thinking</Shimmer>)
    const cls = screen.getByText('Thinking').className
    expect(cls).toContain('motion-reduce:animate-none')
    expect(cls).toContain('motion-reduce:!bg-none')
    expect(cls).toContain('motion-reduce:text-muted-foreground')
    for (const s of Object.values(SESSION_STATE)) if (s.dot.includes('animate-pulse')) expect(s.dot).toContain('motion-reduce:animate-none')
    const root = join(process.cwd(), 'src')
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f) && !f.startsWith('dev'))
    for (const f of files) {
      for (const m of readFileSync(join(root, f), 'utf8').matchAll(/animate-pulse[^"'`]*/g)) expect(`${f}: ${m[0]}`).toContain('motion-reduce:animate-none')
    }
  })

  it('the focus ring skips programmatic focus targets; label selection is blocked on touch only', () => {
    expect(CSS).toContain('[tabindex]:not([tabindex="-1"])):focus-visible')
    expect(CSS).not.toMatch(/\[tabindex\]\):focus-visible/)
    const touch = CSS.match(/@media \(pointer: coarse\) \{\s*button, summary[^}]*\}/)?.[0] ?? ''
    expect(touch).toContain('user-select: none')
    const count = (t: string) => t.split('user-select: none').length - 1
    expect(count(CSS)).toBe(count(touch))
  })

  it('the shell uses the dynamic viewport and safe areas; phone inputs are 16 px', () => {
    expect(CSS).toMatch(/@utility app-shell \{\s*height: 100dvh;\s*padding-top: env\(safe-area-inset-top/)
    expect(CSS).toMatch(/\(pointer: coarse\) \{\s*input, textarea, select \{ font-size: 16px/)
    expect(CSS).toContain('-webkit-tap-highlight-color: transparent')
  })
})
