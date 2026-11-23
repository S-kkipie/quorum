import { describe, expect, it } from 'vitest'
import { sessionTitle } from './title'

const s = (o: object) => ({ id: 'abcdef1234567890', name: '', root: '', cwd: '', ...o })

describe('sessionTitle', () => {
  it('usa el nombre si existe', () => {
    expect(sessionTitle(s({ name: 'mi sesion', root: '/a/b' }))).toEqual({ title: 'mi sesion', short: 'abcdef12' })
  })
  it('basename de root, luego cwd', () => {
    expect(sessionTitle(s({ root: '/home/u/quorum/' })).title).toBe('quorum')
    expect(sessionTitle(s({ cwd: 'C:\\work\\proj' })).title).toBe('proj')
  })
  it('sin nada, el id corto', () => {
    expect(sessionTitle(s({}))).toEqual({ title: 'abcdef12', short: 'abcdef12' })
  })
})

describe('sessionTitle recap', () => {
  it('el recap gana sobre name y root', () => {
    expect(sessionTitle({ id: 'abcdef12xx', recap: 'X', name: 'n', root: '/a/b', cwd: '' }).title).toBe('X')
  })
})
