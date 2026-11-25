// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { MessageResponse } from './message'
import { PathLinksProvider } from './pathLinks'

afterEach(cleanup)
const md = [
  'Edited src/auth/google.ts and `src/inline.go` here.',
  '',
  '- item in /p/README.md',
  '',
  '```',
  'src/fenced.ts',
  '```',
  '',
  'see https://x.dev/a.ts',
].join('\n')

describe('path links in answers', () => {
  it('turns paths into buttons calling onOpen with the absolute path', () => {
    const onOpen = vi.fn()
    render(<PathLinksProvider base="/p" onOpen={onOpen}><MessageResponse>{md}</MessageResponse></PathLinksProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Open src/auth/google.ts' }))
    expect(onOpen).toHaveBeenLastCalledWith('/p/src/auth/google.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Open src/inline.go' }))
    expect(onOpen).toHaveBeenLastCalledWith('/p/src/inline.go')
    fireEvent.click(screen.getByRole('button', { name: 'Open README.md' }))
    expect(onOpen).toHaveBeenLastCalledWith('/p/README.md')
    expect(screen.queryByRole('button', { name: /fenced/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /a\.ts/ })).toBeNull()
    expect(document.body.textContent).toContain('Edited src/auth/google.ts and src/inline.go here.')
  })
  it('a path in a git worktree is a link named relative to that worktree', () => {
    const onOpen = vi.fn()
    const W = ['/p', '/p-rewrite']
    render(<PathLinksProvider base="/p" worktrees={W} onOpen={onOpen}><MessageResponse>{'Wrote /p-rewrite/docs/x.md'}</MessageResponse></PathLinksProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Open docs/x.md' }))
    expect(onOpen).toHaveBeenLastCalledWith('/p-rewrite/docs/x.md')
  })
  it('stays plain without a provider', () => {
    render(<MessageResponse>{md}</MessageResponse>)
    expect(screen.queryAllByRole('button', { name: /^Open / })).toEqual([])
  })
})
