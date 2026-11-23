import { expect, test } from 'claude-code/testing'

import { contextPct, ERROR_ANSWER, fromPlugin, makeHandlers, newStep, stepHook, summarize, toolHook } from '../src/events'
import type { Link } from '../src/link'

function fakeLink(role = 'work') {
  const evs: Array<{ kind: string; data: any }> = []
  const updates: any[] = []
  const link = { role, emit: (e: any) => evs.push(e), update: (p: any) => updates.push(p) } as unknown as Link
  return { link, evs, updates, kinds: () => evs.map(e => e.kind) }
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function turn(h: ReturnType<typeof makeHandlers>, agentId?: string) {
  const e = { agentId }
  const st = newStep()
  h.chunk(e, { kind: 'text', text: 'ho' }, st)
  h.chunk(e, { kind: 'text', text: 'la' }, st)
  h.chunk(e, { kind: 'tool', name: 'Bash', id: 't1' }, st)
  h.stepEnd(e, st)
}

test('summarize: Bash usa command', () => {
  expect(summarize('Bash', { command: 'ls -la' })).toBe('ls -la')
})
test('summarize: Read/Write/Edit usan file_path', () => {
  for (const t of ['Read', 'Write', 'Edit']) expect(summarize(t, { file_path: '/a/b' })).toBe('/a/b')
})
test('summarize: Grep/Glob usan pattern', () => {
  expect(summarize('Grep', { pattern: 'foo', path: '/x' })).toBe('foo')
  expect(summarize('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
})
test('summarize: WebFetch usa url', () => {
  expect(summarize('WebFetch', { url: 'https://x.dev', prompt: 'p' })).toBe('https://x.dev')
})
test('summarize: el resto en k=v hasta 120 chars', () => {
  expect(summarize('Other', { a: 'x', n: 2 })).toBe('a=x n=2')
  expect(summarize('Other', { a: 'y'.repeat(300) }).length).toBe(120)
  expect(summarize('Other', null)).toBe('')
})

test('turno simulado: secuencia exacta de eventos', async () => {
  const f = fakeLink()
  const h = makeHandlers(() => f.link)
  h.turnStart({ text: 'hola' })
  const st = newStep()
  h.chunk({}, { kind: 'text', text: 'ho' }, st)
  h.chunk({}, { kind: 'text', text: 'la' }, st)
  h.chunk({}, { kind: 'tool', name: 'Bash', id: 't1' }, st)
  const call = { tool: 'Bash', tool_use_id: 't1', command: 'ls' }
  h.toolStart(call)
  h.toolEnd(call, { text: 'x'.repeat(5000) }, 12)
  h.stepEnd({}, st)
  h.turnComplete({ answer: 'listo', reason: 'answer', usage: { output_tokens: 7 } }, async () => 42)
  expect(f.kinds()).toEqual(['turn_start', 'user', 'status', 'assistant_delta', 'assistant_delta', 'tool_start', 'tool_end', 'assistant', 'turn_end', 'status'])
  const ts = f.evs.find(e => e.kind === 'tool_start')!
  expect(ts.data).toEqual({ id: 't1', name: 'Bash', summary: 'ls' })
  expect(f.evs.find(e => e.kind === 'tool_end')!.data.output.length).toBe(4000)
  expect(f.evs.find(e => e.kind === 'turn_end')!.data).toEqual({ answer: 'listo', reason: 'answer', outputTokens: 7 })
  await flush()
  expect(f.updates).toEqual([{ state: 'working' }, { state: 'idle' }, { contextPct: 42 }])
})

test('error sin respuesta usa el aviso', () => {
  const f = fakeLink()
  makeHandlers(() => f.link).turnComplete({ answer: '', reason: 'error' })
  expect(f.evs.find(e => e.kind === 'turn_end')!.data.answer).toBe(ERROR_ANSWER)
})

test('thinking se emite una vez por bloque', () => {
  const f = fakeLink()
  const h = makeHandlers(() => f.link)
  const st = newStep()
  for (const c of [{ kind: 'thinking', text: 'a' }, { kind: 'thinking', text: 'b' }, { kind: 'text', text: 'x' }, { kind: 'thinking', text: 'c' }]) h.chunk({}, c, st)
  expect(f.kinds()).toEqual(['thinking', 'assistant_delta', 'thinking'])
})

test('rol service: solo status', async () => {
  const f = fakeLink('service')
  const h = makeHandlers(() => f.link)
  h.turnStart({ text: 'x' })
  turn(h)
  h.toolStart({ tool: 'Bash', tool_use_id: 't', command: 'ls' })
  h.toolEnd({ tool: 'Bash', tool_use_id: 't' }, { text: 'o' }, 1)
  h.agentSpawn({ subagentType: 'a' }, { agentId: 'g' })
  h.turnComplete({ answer: 'r' }, async () => 10)
  h.turnComplete({ answer: 'r', agentId: 'g' })
  await flush()
  expect(f.kinds()).toEqual(['status', 'status'])
  expect(f.updates).toEqual([{ state: 'working' }, { state: 'idle' }])
})

test('sin link: no hace nada ni lanza', () => {
  const h = makeHandlers(() => undefined)
  h.turnStart({ text: 'x' })
  h.turnComplete({ answer: 'r' })
})

test('un emit que lanza no se propaga', () => {
  const link = { role: 'work', emit: () => { throw new Error('x') }, update: () => {} } as unknown as Link
  makeHandlers(() => link).turnStart({ text: 'x' })
})

test('subagente: eventos con agent y sin cambiar el estado', async () => {
  const f = fakeLink()
  const h = makeHandlers(() => f.link)
  h.turnStart({ text: 'x', agentId: 'ag1' })
  h.agentSpawn({ subagentType: 'Explore', description: 'busca' }, { agentId: 'ag1' })
  turn(h, 'ag1')
  h.toolStart({ tool: 'Read', tool_use_id: 'r1', agentId: 'ag1', file_path: '/f' })
  h.turnComplete({ answer: 'z'.repeat(3000), agentId: 'ag1' })
  await flush()
  expect(f.kinds()).toEqual(['agent_start', 'assistant_delta', 'assistant_delta', 'assistant', 'tool_start', 'agent_end'])
  expect(f.evs[0].data).toEqual({ id: 'ag1', type: 'Explore', description: 'busca' })
  for (const e of f.evs.filter(e => ['assistant_delta', 'assistant', 'tool_start'].includes(e.kind))) expect(e.data.agent).toBe('ag1')
  const end = f.evs[f.evs.length - 1].data
  expect(end.status).toBe('completed')
  expect(end.answer.length).toBe(2000)
  expect(f.updates).toEqual([])
})

test('contextPct: percent, o tokens/window', () => {
  expect(contextPct({ context: { percent: 41.6, window: 200000 } })).toBe(42)
  expect(contextPct({ context: { tokens: 50000, window: 200000 } })).toBe(25)
  expect(contextPct({ context: { window: 200000 } })).toBeUndefined()
})

const textChunk = (text: string) => ({ kind: 'text', text })

test('stepHook reenvía chunks y el valor de retorno, y emite assistant', async () => {
  const f = fakeLink()
  const h = makeHandlers(() => f.link)
  async function* inner() { yield textChunk('ho'); yield textChunk('la'); return 'RES' }
  const got: unknown[] = []
  const it = stepHook(h, {}, inner())
  while (true) {
    const r = await it.next()
    if (r.done) { expect(r.value).toBe('RES'); break }
    got.push(r.value)
  }
  expect(got).toEqual([textChunk('ho'), textChunk('la')])
  expect(f.kinds()).toEqual(['assistant_delta', 'assistant_delta', 'assistant'])
  expect(f.evs[2].data.text).toBe('hola')
})

test('stepHook: return() temprano cierra el flujo interno y emite lo parcial', async () => {
  const f = fakeLink()
  const h = makeHandlers(() => f.link)
  let closed = false
  async function* inner() { try { yield textChunk('par'); yield textChunk('cial') } finally { closed = true } }
  for await (const c of stepHook(h, {}, inner())) { void c; break }
  expect(closed).toBe(true)
  expect(f.evs.some(e => e.kind === 'assistant' && e.data.text === 'par')).toBe(true)
})

test('stepHook: throw() se reenvía al flujo interno', async () => {
  const f = fakeLink()
  const h = makeHandlers(() => f.link)
  let seen: unknown
  async function* inner() { try { yield textChunk('a') } catch (e) { seen = e; throw e } }
  const it = stepHook(h, {}, inner())
  await it.next()
  let err: unknown
  try { await it.throw(new Error('x')) } catch (e) { err = e }
  expect(String(err)).toContain('x')
  expect(String(seen)).toContain('x')
  expect(f.kinds()).toContain('assistant')
})

test('stepHook: un flujo interno que se recupera de throw() queda cerrado', async () => {
  const f = fakeLink()
  const h = makeHandlers(() => f.link)
  let closed = false
  async function* inner() {
    try {
      try { yield textChunk('a') } catch { yield textChunk('recuperado') }
      yield textChunk('nunca')
    } finally { closed = true }
  }
  const it = stepHook(h, {}, inner())
  await it.next()
  let err: unknown
  try { await it.throw(new Error('x')) } catch (e) { err = e }
  expect(String(err)).toContain('x')
  expect(closed).toBe(true)
})

test('toolHook: si la llamada lanza, tool_end ok:false y se propaga', async () => {
  const f = fakeLink()
  const h = makeHandlers(() => f.link)
  let err: unknown
  try { await toolHook(h, { tool: 'Bash', tool_use_id: 'x', command: 'ls' }, async () => { throw new Error('boom') }) } catch (e) { err = e }
  expect(String(err)).toContain('boom')
  expect(f.kinds()).toEqual(['tool_start', 'tool_end'])
  expect(f.evs[1].data.ok).toBe(false)
  expect(f.evs[1].data.output).toBe('boom')
})

test('toolHook devuelve el resultado sin cambios', async () => {
  const f = fakeLink()
  const r = { text: 'ok' }
  expect(await toolHook(makeHandlers(() => f.link), { tool: 'Bash', tool_use_id: 'x' }, async () => r)).toBe(r)
  expect(f.evs[1].data.ok).toBe(true)
})

// Regresión e2e Plan 2: el diálogo de permiso de Quorum ($.ui.ask = un tool.call de
// AskUserQuestion con origen plugin) salía en la app como herramienta y como pregunta.
test('fromPlugin: un $.ui.ask/$.tool.call de un mod no es del modelo', () => {
  expect(fromPlugin({ plugin: 'quorum' }, { tool_use_id: 'toolu_plugin_ab12' })).toBe(true)
  expect(fromPlugin({ plugin: 'otro' }, { tool_use_id: 'x' })).toBe(true)
  // sin next.origin (builds viejos) se reconoce por el id que pone el engine
  expect(fromPlugin(undefined, { tool_use_id: 'toolu_plugin_ca08bb29' })).toBe(true)
  expect(fromPlugin({ plugin: 'engine' }, { tool_use_id: 'toolu_01Y4Zq' })).toBe(false)
  expect(fromPlugin(undefined, { tool_use_id: 'toolu_01Y4Zq' })).toBe(false)
  expect(fromPlugin(undefined, {})).toBe(false)
})
