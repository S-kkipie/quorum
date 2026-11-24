import { describe, expect, it } from 'vitest'
import { blockReason, commandsReported, selectable, currentModelOption, filterCommands, modelLabel, parseSlash, slashQuery } from './slash'
import type { SessionCommand, SessionCommands } from '../proto.gen'

const c = (name: string, group = 'session', o: Partial<SessionCommand> = {}): SessionCommand => ({
  name, description: '', source: group === 'session' ? 'builtin' : group === 'mcp' ? 'mcp' : 'plugin', plugin: '', group, terminalOnly: false, ...o,
})

describe('slashQuery', () => {
  it('only at the start of the text, with the caret in the first token', () => {
    expect(slashQuery('/', 1)).toBe('')
    expect(slashQuery('/mo', 3)).toBe('mo')
    expect(slashQuery('/mo', 1)).toBe('mo')
    expect(slashQuery('/model opus', 11)).toBeNull()
    expect(slashQuery('/model opus', 4)).toBe('model')
    expect(slashQuery('fix the /path', 13)).toBeNull()
    expect(slashQuery(' /model', 7)).toBeNull()
    expect(slashQuery('', 0)).toBeNull()
  })
})

describe('parseSlash', () => {
  it('splits the name and the args', () => {
    expect(parseSlash('/compact')).toEqual({ name: 'compact', args: '' })
    expect(parseSlash('/after  run the tests ')).toEqual({ name: 'after', args: 'run the tests' })
    expect(parseSlash('/plugin:skill x')).toEqual({ name: 'plugin:skill', args: 'x' })
    expect(parseSlash('hello')).toBeNull()
    expect(parseSlash(' /x')).toBeNull()
    expect(parseSlash('/')).toEqual({ name: '', args: '' })
  })
})

describe('filterCommands', () => {
  const list = [c('model'), c('compact', 'session', { description: 'Summarize and free context' }), c('config', 'session', { terminalOnly: true }),
    c('brainstorming', 'skill'), c('after', 'plugin'), c('mcp__db__query', 'mcp'), c('recompile', 'plugin')]
  it('groups in order Session, Skills, Plugins, MCP and drops empty groups', () => {
    const g = filterCommands(list, '')
    expect(g.map((x) => x.label)).toEqual(['Session', 'Skills', 'Plugins', 'MCP'])
    expect(g[0].items.map((x) => x.name)).toEqual(['model', 'compact', 'config'])
  })
  it('prefix matches on the name come first, then substrings in name or description', () => {
    const g = filterCommands(list, 'co')
    expect(g.map((x) => x.label)).toEqual(['Session', 'Plugins'])
    expect(g[0].items.map((x) => x.name)).toEqual(['compact', 'config'])
    expect(filterCommands(list, 'free')[0].items.map((x) => x.name)).toEqual(['compact'])
    expect(filterCommands(list, 'COMP').flatMap((x) => x.items.map((i) => i.name))).toEqual(['compact', 'recompile'])
  })
  it('nothing matches: empty', () => {
    expect(filterCommands(list, 'zzz')).toEqual([])
  })
  it('an unknown group lands in Plugins', () => {
    expect(filterCommands([c('x', 'weird')], '')[0].label).toBe('Plugins')
  })
})

describe('selectable', () => {
  it('a terminal-only row cannot be picked, completed or sent; any other can', () => {
    expect(selectable(c('config', 'session', { terminalOnly: true }))).toBe(false)
    expect(selectable(c('compact', 'session'))).toBe(true)
    expect(selectable(c('after', 'plugin'))).toBe(true)
  })
})

describe('blockReason', () => {
  it('terminal-only, and after/timeline only when bare', () => {
    expect(blockReason(c('config', 'session', { terminalOnly: true }), '')).toBe('Only in the terminal')
    expect(blockReason(c('after', 'plugin'), '')).toBe('Only in the terminal without arguments')
    expect(blockReason(c('after', 'plugin'), 'run the tests')).toBeNull()
    expect(blockReason(c('timeline', 'plugin'), '  ')).toBe('Only in the terminal without arguments')
    expect(blockReason(c('compact'), '')).toBeNull()
  })
})

describe('commandsReported', () => {
  it('absent or an empty list with an empty hash: never reported (older mod)', () => {
    expect(commandsReported(undefined)).toBe(false)
    expect(commandsReported({ session: 's', commands: [], hash: '' } as SessionCommands)).toBe(false)
    expect(commandsReported({ session: 's', commands: [], hash: 'h' } as SessionCommands)).toBe(true)
    expect(commandsReported({ session: 's', commands: [c('x')], hash: '' } as SessionCommands)).toBe(true)
  })
})

describe('modelLabel', () => {
  it('turns model ids into short names', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(modelLabel('claude-opus-4')).toBe('Opus 4')
    expect(modelLabel('claude-opus-4-6[1m]')).toBe('Opus 4.6 (1M)')
    expect(modelLabel('claude-3-5-haiku-20241022')).toBe('Haiku 3.5')
    expect(modelLabel('opus')).toBe('Opus')
    expect(modelLabel('gpt-x')).toBe('gpt-x')
    expect(modelLabel('')).toBe('')
  })
})

describe('currentModelOption', () => {
  const opts = [
    { value: 'default', label: 'Default', description: '' },
    { value: 'opus', label: 'Opus', description: '' },
    { value: 'opus[1m]', label: 'Opus (1M context)', description: '' },
    { value: 'sonnet', label: 'Sonnet', description: '' },
  ]
  it('exact value first, then the family in the model id (the 1M variant when the id says so)', () => {
    expect(currentModelOption(opts, 'sonnet')?.value).toBe('sonnet')
    expect(currentModelOption(opts, 'claude-opus-5-5')?.value).toBe('opus')
    expect(currentModelOption(opts, 'claude-opus-5-5[1m]')?.value).toBe('opus[1m]')
    expect(currentModelOption(opts, 'claude-haiku-5')).toBeUndefined()
    expect(currentModelOption(opts, '')).toBeUndefined()
  })
})
