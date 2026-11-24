import { expect, test } from 'claude-code/testing'

import { accountKey, enabledPlugins, parseWhoasWhich, makeAccountLookup, configDirFrom } from '../src/account'

test('parseWhoasWhich extracts the alias', () => {
  expect(parseWhoasWhich('claude@work via default profile (profile work)')).toBe('work')
  expect(parseWhoasWhich('claude@personal-test via x')).toBe('personal-test')
  expect(parseWhoasWhich('')).toBe('default')
  expect(parseWhoasWhich('not found')).toBe('default')
})

test('accountKey is 16 lowercase hex, stable and input-dependent', async () => {
  const a = await accountKey('a@example.com')
  expect(a).toMatch(/^[0-9a-f]{16}$/)
  expect(await accountKey('a@example.com')).toBe(a)
  expect(await accountKey('b@example.com')).not.toBe(a)
  // known vector: sha256('quorum-account:a@example.com'), checked against sha256sum
  expect(a).toBe('012bff4ec5d4221d')
})

test('enabledPlugins keeps only known better-claude plugins that are enabled', () => {
  const s = JSON.stringify({ enabledPlugins: {
    'after@better-claude': true, 'time-machine@better-claude': true, 'use-haiku@better-claude': false,
    'quick-peek@other': true, 'unknown@better-claude': true,
  } })
  expect(enabledPlugins(s)).toEqual(['after', 'time-machine'])
  expect(enabledPlugins('not json')).toEqual([])
  expect(enabledPlugins('{}')).toEqual([])
})

test('configDirFrom prefers CLAUDE_CONFIG_DIR, else HOME/.claude', () => {
  expect(configDirFrom('/c/dir', '/home/u')).toBe('/c/dir')
  expect(configDirFrom('', '/home/u')).toBe('/home/u/.claude')
  expect(configDirFrom(undefined, undefined)).toBe('')
})

test('whoas lookup runs through a login shell and is cached per cwd', async () => {
  const calls: Array<{ argv: string[]; cwd: string }> = []
  const lookup = makeAccountLookup({
    run: async (argv, cwd) => { calls.push({ argv, cwd }); return 'claude@work via default profile' },
  })
  expect(await lookup('/p1')).toBe('work')
  expect(await lookup('/p1')).toBe('work')
  expect(calls).toHaveLength(1)
  expect(calls[0].argv).toEqual(['bash', '-lc', 'whoas which claude'])
  await lookup('/p2')
  expect(calls).toHaveLength(2)
})

test('whoas lookup failure gives default', async () => {
  const lookup = makeAccountLookup({ run: async () => { throw new Error('boom') } })
  expect(await lookup('/p')).toBe('default')
})
