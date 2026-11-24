// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import Projects from './Projects'
import { initialState } from '../lib/store'
import { proj, sess } from '../lib/fixtures.test-util'

afterEach(cleanup)

describe('Projects board', () => {
  it('projects that need you sort first, ties by name', () => {
    const s = {
      ...initialState(),
      workspaces: { w1: { id: 'w1', name: 'WS', color: '' } },
      projects: { a: proj('a', { name: 'Alpha' }), b: proj('b', { name: 'Beta' }), c: proj('c', { name: 'Charlie' }) },
      sessions: { s1: sess('s1', { projectId: 'c', state: 'needs_you' }), s2: sess('s2', { projectId: 'a', state: 'idle' }) },
      order: ['s1', 's2'],
    } as any
    render(<Projects state={s} />)
    const names = screen.getAllByRole('article').map((a) => a.textContent ?? '')
    expect(names[0]).toContain('Charlie')
    expect(names[1]).toContain('Alpha')
    expect(names[2]).toContain('Beta')
  })
})
