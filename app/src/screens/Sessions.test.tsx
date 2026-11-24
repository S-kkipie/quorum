// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import Sessions from './Sessions'
import { initialState } from '../lib/store'
import { proj, sess } from '../lib/fixtures.test-util'

vi.mock('../lib/api', () => ({ closeSession: vi.fn() }))
afterEach(cleanup)

const mach = (name: string) => ({ name, os: 'linux', env: 'linux', version: '', online: true, lastSeen: 0, caps: { herdr: false, terminal: false, root: false } })

describe('Sessions tab', () => {
  it('lists only live sessions, groups by machine, keeps services', () => {
    const s = {
      ...initialState(),
      projects: { p1: proj('p1') },
      machines: { 'vps-1': mach('vps-1'), laptop: mach('laptop') },
      sessions: {
        a: sess('a', { recap: 'Live work', machine: 'vps-1', state: 'working' }),
        b: sess('b', { recap: 'Gone work', machine: 'vps-1', state: 'closed' }),
        c: sess('c', { recap: 'Svc', machine: 'vps-1', role: 'service' }),
      },
      order: ['a', 'b', 'c'],
    }
    render(<Sessions state={s} />)
    expect(screen.getByText('Live work')).toBeTruthy()
    expect(screen.queryByText('Gone work')).toBeNull()
    expect(screen.getByText('Svc')).toBeTruthy()
    expect(screen.getByText('No sessions.')).toBeTruthy() // laptop
    expect(screen.getAllByRole('button', { name: 'Session actions' })).toHaveLength(1)
    expect(screen.getByText(/Project p1/)).toBeTruthy()
  })
  it('orders a machine by attention', () => {
    const s = {
      ...initialState(), machines: { 'vps-1': mach('vps-1') },
      sessions: {
        a: sess('a', { recap: 'Aaa idle', machine: 'vps-1' }), b: sess('b', { recap: 'Bbb working', machine: 'vps-1', state: 'working' }),
        c: sess('c', { recap: 'Ccc done', machine: 'vps-1', unread: true }), d: sess('d', { recap: 'Ddd needs', machine: 'vps-1', state: 'needs_you' }),
      },
      order: ['a', 'b', 'c', 'd'],
    }
    render(<Sessions state={s} />)
    const titles = screen.getAllByRole('listitem').map((x) => x.textContent!.slice(0, 3))
    expect(titles).toEqual(['Ddd', 'Ccc', 'Bbb', 'Aaa'])
  })
})
