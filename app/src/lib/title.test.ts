import { describe, expect, it } from 'vitest'
import { sessionTitle } from './title'

const s = (o: object) => ({ id: 'abcdef1234567890', name: '', root: '', cwd: '', ...o })

describe('sessionTitle', () => {
  it('uses the name if present', () => {
    expect(sessionTitle(s({ name: 'my session', root: '/a/b' }))).toEqual({ title: 'my session', short: 'abcdef12' })
  })
  it('basename of root, then cwd', () => {
    expect(sessionTitle(s({ root: '/home/u/quorum/' })).title).toBe('quorum')
    expect(sessionTitle(s({ cwd: 'C:\\work\\proj' })).title).toBe('proj')
  })
  it('with nothing, the short id', () => {
    expect(sessionTitle(s({}))).toEqual({ title: 'abcdef12', short: 'abcdef12' })
  })
})

describe('sessionTitle recap', () => {
  it('recap wins over name and root', () => {
    expect(sessionTitle({ id: 'abcdef12xx', recap: 'X', name: 'n', root: '/a/b', cwd: '' }).title).toBe('X')
  })
})
