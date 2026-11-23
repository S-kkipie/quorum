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

test('cleanRecap quita comillas, punto final y saltos de línea', () => {
  expect(cleanRecap('"Arreglando el login con OAuth."\n')).toBe('Arreglando el login con OAuth')
  expect(cleanRecap('Línea uno\nlínea dos')).toBe('Línea uno línea dos')
})

test('cleanRecap corta a 60 en límite de palabra', () => {
  const out = cleanRecap('palabra '.repeat(20))
  expect(out.length).toBeLessThanOrEqual(60)
  expect(out.endsWith('palabra')).toBe(true)
})

test('onFirstPrompt genera una vez y actualiza con el resultado limpio', async () => {
  const { r, updates, calls } = mk(async () => '"Arreglando el login."')
  r.onFirstPrompt('arregla el login')
  await tick(); await tick()
  expect(calls.length).toBe(1)
  expect(calls[0]).toContain('arregla el login')
  expect(updates).toEqual(['Arreglando el login'])
})

test('dos onTurnEnd en menos de 5 min generan una sola vez', async () => {
  const { r, calls, t } = mk(async () => 'Algo')
  r.onTurnEnd('a', 'b'); await tick(); await tick()
  t.v += 60_000
  r.onTurnEnd('c', 'd'); await tick(); await tick()
  expect(calls.length).toBe(1)
  t.v += 5 * 60_000
  r.onTurnEnd('e', 'f'); await tick(); await tick()
  expect(calls.length).toBe(2)
})

test('onTurnEnd sin turno nuevo desde la última generación no genera', async () => {
  const { r, calls, t } = mk(async () => 'Algo')
  r.onFirstPrompt('hola'); await tick(); await tick()
  t.v += 10 * 60_000
  r.onTurnEnd('hola', 'resp'); await tick(); await tick()
  expect(calls.length).toBe(1)
})

test('complete que rechaza no actualiza ni lanza', async () => {
  const { r, updates } = mk(async () => { throw new Error('x') })
  r.onFirstPrompt('hola'); await tick(); await tick()
  expect(updates).toEqual([])
})

test('complete que tarda más del límite no actualiza', async () => {
  const { r, updates } = mk(() => new Promise(res => setTimeout(() => res('tarde'), 100)))
  r.onFirstPrompt('hola')
  await new Promise(res => setTimeout(res, 150))
  expect(updates).toEqual([])
})

test('buildContext: acotado, más nuevo al final, sin herramientas', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i} ` + 'x'.repeat(1000) }))
  const withTool = [...msgs, { role: 'assistant', text: '' }, { role: 'user', text: '   ' }]
  const c = buildContext(withTool)
  expect(Array.from(c).length).toBeLessThanOrEqual(4000)
  expect(c).toContain('m9 ')
  expect(c).not.toContain('m3 ')
  expect(c.indexOf('m8 ')).toBeLessThan(c.indexOf('m9 '))
  expect(buildContext([{ role: 'assistant', text: 'a'.repeat(700) }]).length).toBeLessThan(620)
})

test('el prompt usa el contexto de messages y no el último prompt suelto', async () => {
  const { r, calls } = mk(async () => 'Migrando el login')
  ;(r as unknown as { deps: { messages: () => Promise<{ role: string; text: string }[]> } }).deps.messages =
    async () => [{ role: 'user', text: 'migra el login' }, { role: 'assistant', text: 'listo' }, { role: 'user', text: 'ya esta' }]
  r.onFirstPrompt('ya esta'); await tick(); await tick()
  expect(calls[0]).toContain('migra el login')
  expect(calls[0]).toContain('`-`')
})

test('sin API de messages (o que falla) cae a prompt + respuesta', async () => {
  const { r, calls, t } = mk(async () => 'Algo')
  ;(r as unknown as { deps: { messages: () => Promise<never> } }).deps.messages = async () => { throw new Error('x') }
  r.onTurnEnd('mi prompt', 'mi respuesta'); await tick(); await tick()
  expect(calls[0]).toContain('mi prompt')
  expect(calls[0]).toContain('mi respuesta')
  void t
})

test('no-respuestas se rechazan y no llaman a update', async () => {
  for (const bad of ['-', '"-"', '', 'No hay contexto suficiente sobre la tarea', 'Sin contexto', 'No está claro', 'No se puede determinar', 'No sé', 'No context', 'Unclear', 'Cannot determine the task', 'Not enough information']) {
    const { r, updates } = mk(async () => bad)
    r.onFirstPrompt('x'); await tick(); await tick()
    expect(updates).toEqual([])
  }
})

test('una frase buena se sigue aceptando', async () => {
  const { r, updates } = mk(async () => 'Migrando el login a OAuth')
  r.onFirstPrompt('x'); await tick(); await tick()
  expect(updates).toEqual(['Migrando el login a OAuth'])
})

test('primer prompt ausente de messages() se añade como último Usuario', async () => {
  const { r, calls } = mk(async () => 'Algo')
  ;(r as unknown as { deps: { messages: () => Promise<{ role: string; text: string }[]> } }).deps.messages =
    async () => [{ role: 'user', text: 'antes' }, { role: 'assistant', text: 'resp previa' }]
  r.onFirstPrompt('prompt nuevo'); await tick(); await tick()
  expect(calls[0]!.trimEnd().endsWith('Usuario: prompt nuevo')).toBe(true)
  expect(calls[0]).toContain('antes')
})

test('onTurnEnd añade la respuesta si falta y no duplica si ya está', async () => {
  const mkWith = (rows: { role: string; text: string }[]) => {
    const m = mk(async () => 'Algo')
    ;(m.r as unknown as { deps: { messages: () => Promise<typeof rows> } }).deps.messages = async () => rows
    return m
  }
  const a = mkWith([{ role: 'user', text: 'p' }])
  a.r.onTurnEnd('p', 'la respuesta'); await tick(); await tick()
  expect(a.calls[0]!.trimEnd().endsWith('Asistente: la respuesta')).toBe(true)
  const b = mkWith([{ role: 'user', text: 'p' }, { role: 'assistant', text: 'la respuesta' }])
  b.r.onTurnEnd('p', 'la respuesta'); await tick(); await tick()
  expect(b.calls[0]!.match(/la respuesta/g)!.length).toBe(1)
})
