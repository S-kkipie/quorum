import { expect, test } from 'claude-code/testing'

import { Recap, buildContext, cleanRecap } from '../src/recap'

const tick = () => new Promise<void>(r => setTimeout(r, 0))

function mk(complete: (p: string) => Promise<string>, t = { v: 1_000_000 }) {
  const updates: string[] = []
  const calls: string[] = []
  const r = new Recap({
    complete: p => { calls.push(p); return complete(p) },
    now: () => t.v,
    update: s => { updates.push(s) },
    sleep: ms => new Promise<void>(r => setTimeout(r, ms)),
    timeoutMs: 30,
  })
  return { r, updates, calls, t }
}

test('cleanRecap strips quotes, trailing period and line breaks', () => {
  expect(cleanRecap('"Fixing the login with OAuth."\n')).toBe('Fixing the login with OAuth')
  expect(cleanRecap('Line one\nline two')).toBe('Line one line two')
})

test('cleanRecap cuts at 60 on a word boundary', () => {
  const out = cleanRecap('word '.repeat(20))
  expect(out.length).toBeLessThanOrEqual(60)
  expect(out.endsWith('word')).toBe(true)
})

test('onFirstPrompt generates once and updates with the cleaned result', async () => {
  const { r, updates, calls } = mk(async () => '"Fixing the login."')
  r.onFirstPrompt('fix the login')
  await tick(); await tick()
  expect(calls.length).toBe(1)
  expect(calls[0]).toContain('fix the login')
  expect(updates).toEqual(['Fixing the login'])
})

test('two onTurnEnd calls within 5 min generate only once', async () => {
  const { r, calls, t } = mk(async () => 'Something')
  r.onTurnEnd('a', 'b'); await tick(); await tick()
  t.v += 60_000
  r.onTurnEnd('c', 'd'); await tick(); await tick()
  expect(calls.length).toBe(1)
  t.v += 5 * 60_000
  r.onTurnEnd('e', 'f'); await tick(); await tick()
  expect(calls.length).toBe(2)
})

test('onTurnEnd without a new turn since the last generation does not generate', async () => {
  const { r, calls, t } = mk(async () => 'Something')
  r.onFirstPrompt('hello'); await tick(); await tick()
  t.v += 10 * 60_000
  r.onTurnEnd('hello', 'reply'); await tick(); await tick()
  expect(calls.length).toBe(1)
})

test('a complete that rejects neither updates nor throws', async () => {
  const { r, updates } = mk(async () => { throw new Error('x') })
  r.onFirstPrompt('hello'); await tick(); await tick()
  expect(updates).toEqual([])
})

test('a complete that takes longer than the limit does not update', async () => {
  const { r, updates } = mk(() => new Promise(res => setTimeout(() => res('late'), 100)))
  r.onFirstPrompt('hello')
  await new Promise(res => setTimeout(res, 150))
  expect(updates).toEqual([])
})

test('buildContext: bounded, newest last, no tools', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i} ` + 'x'.repeat(1000) }))
  const withTool = [...msgs, { role: 'assistant', text: '' }, { role: 'user', text: '   ' }]
  const c = buildContext(withTool)
  expect(Array.from(c).length).toBeLessThanOrEqual(4000)
  expect(c).toContain('m9 ')
  expect(c).not.toContain('m3 ')
  expect(c.indexOf('m8 ')).toBeLessThan(c.indexOf('m9 '))
  expect(buildContext([{ role: 'assistant', text: 'a'.repeat(700) }]).length).toBeLessThan(620)
})

test('the prompt uses the messages context and not the lone last prompt', async () => {
  const { r, calls } = mk(async () => 'Migrating the login')
  ;(r as unknown as { deps: { messages: () => Promise<{ role: string; text: string }[]> } }).deps.messages =
    async () => [{ role: 'user', text: 'migrate the login' }, { role: 'assistant', text: 'done' }, { role: 'user', text: 'that is it' }]
  r.onFirstPrompt('that is it'); await tick(); await tick()
  expect(calls[0]).toContain('migrate the login')
  expect(calls[0]).toContain('`-`')
})

test('without a messages API (or when it fails) falls back to prompt + answer', async () => {
  const { r, calls, t } = mk(async () => 'Something')
  ;(r as unknown as { deps: { messages: () => Promise<never> } }).deps.messages = async () => { throw new Error('x') }
  r.onTurnEnd('my prompt', 'my answer'); await tick(); await tick()
  expect(calls[0]).toContain('my prompt')
  expect(calls[0]).toContain('my answer')
  void t
})

test('non-answers are rejected and do not call update', async () => {
  for (const bad of ['-', '"-"', '', 'No hay contexto suficiente sobre la tarea', 'Sin contexto', 'No está claro', 'Not clear', 'I don\'t know', 'Unclear what the task is', 'Insufficient context', 'No se puede determinar', 'No sé', 'No context', 'Unclear', 'Cannot determine the task', 'Not enough information']) {
    const { r, updates } = mk(async () => bad)
    r.onFirstPrompt('x'); await tick(); await tick()
    expect(updates).toEqual([])
  }
})

test('a good phrase is still accepted', async () => {
  const { r, updates } = mk(async () => 'Migrating the login to OAuth')
  r.onFirstPrompt('x'); await tick(); await tick()
  expect(updates).toEqual(['Migrating the login to OAuth'])
})

test('first prompt missing from messages() is appended as the last User', async () => {
  const { r, calls } = mk(async () => 'Something')
  ;(r as unknown as { deps: { messages: () => Promise<{ role: string; text: string }[]> } }).deps.messages =
    async () => [{ role: 'user', text: 'before' }, { role: 'assistant', text: 'previous reply' }]
  r.onFirstPrompt('new prompt'); await tick(); await tick()
  expect(calls[0]!.trimEnd().endsWith('User: new prompt')).toBe(true)
  expect(calls[0]).toContain('before')
})

test('onTurnEnd appends the answer if missing and does not duplicate if present', async () => {
  const mkWith = (rows: { role: string; text: string }[]) => {
    const m = mk(async () => 'Something')
    ;(m.r as unknown as { deps: { messages: () => Promise<typeof rows> } }).deps.messages = async () => rows
    return m
  }
  const a = mkWith([{ role: 'user', text: 'p' }])
  a.r.onTurnEnd('p', 'the answer'); await tick(); await tick()
  expect(a.calls[0]!.trimEnd().endsWith('Assistant: the answer')).toBe(true)
  const b = mkWith([{ role: 'user', text: 'p' }, { role: 'assistant', text: 'the answer' }])
  b.r.onTurnEnd('p', 'the answer'); await tick(); await tick()
  expect(b.calls[0]!.match(/the answer/g)!.length).toBe(1)
})

test('the recap prompt asks for a short English phrase', async () => {
  const { r, calls } = mk(async () => 'Fixing the login')
  r.onFirstPrompt('fix the login'); await tick(); await tick()
  expect(calls[0]).toContain('English')
  expect(calls[0]).toContain('60 characters')
})
