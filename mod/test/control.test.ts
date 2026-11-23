import { expect, test } from 'claude-code/testing'

import { makeControl } from '../src/control'
import { makeHandlers } from '../src/events'
import type { Link } from '../src/link'
import type { Command } from '../src/proto.gen'

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

const cmd = (c: Partial<Command>): Command =>
  ({ type: '', text: '', mode: '', askId: '', decision: '', reason: '', answers: null as never, ...c })

/** `$` falso: registra llamadas en orden; sleep se resuelve a mano con `fire`. */
function fake(role = 'work') {
  const calls: string[] = []
  const evs: Array<{ kind: string; data: any }> = []
  const updates: any[] = []
  const sleeps: Array<{ ms: number; fire: () => void }> = []
  const link = { role, emit: (e: any) => evs.push(e), update: (p: any) => updates.push(p) } as unknown as Link
  let n = 0
  const control = makeControl({
    getLink: () => link,
    submit: async t => { calls.push(`submit:${t}`) },
    abort: async id => { calls.push(`abort:${id}`) },
    stopTask: async id => { calls.push(`stop:${id}`) },
    exit: async () => { calls.push('exit') },
    sleep: ms => new Promise<void>(r => sleeps.push({ ms, fire: r })),
    newId: () => `a${++n}`,
  })
  return { control, calls, evs, updates, sleeps, link, kinds: () => evs.map(e => e.kind) }
}

const ok = (text = 'out') => async () => ({ result: {}, text }) as any

test('prompt now durante un turno → context en el siguiente tool.call, sin submit', async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1', text: 'hola' })
  await f.control.handle(cmd({ type: 'prompt', text: 'y además esto', mode: 'now' }))
  const r: any = await f.control.toolCall({ tool: 'Bash', tool_use_id: 'u1' }, async () => ({ result: {}, text: 'x', context: ['previo'] }))
  expect(r.context).toEqual(['previo', 'y además esto'])
  expect(f.calls).toEqual([])
  // ya entregado: el siguiente no lo repite
  const r2: any = await f.control.toolCall({ tool: 'Bash', tool_use_id: 'u2' }, ok())
  expect(r2.context).toBe(undefined)
  f.control.turnEnd({})
  expect(f.calls).toEqual([])
})

test('prompt now sin entregar al terminar el turno → submit', async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1', text: 'hola' })
  await f.control.handle(cmd({ type: 'prompt', text: 'tarde', mode: 'now' }))
  // un tool.call de un subagente no lo entrega
  const r: any = await f.control.toolCall({ tool: 'Bash', tool_use_id: 'u1', agentId: 'ag' }, ok())
  expect(r.context).toBe(undefined)
  f.control.turnEnd({})
  await flush()
  expect(f.calls).toEqual(['submit:tarde'])
})

test('prompt now sin turno en curso → submit directo', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'prompt', text: 'hola', mode: 'now' }))
  expect(f.calls).toEqual(['submit:hola'])
})

test('prompt interrupt → abort antes de submit', async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't9', text: 'x' })
  await f.control.handle(cmd({ type: 'prompt', text: 'para y haz esto', mode: 'interrupt' }))
  expect(f.calls).toEqual(['abort:t9', 'submit:para y haz esto'])
})

test('prompt queue → submit; abort → turn.abort del turno en curso', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'prompt', text: 'q', mode: 'queue' }))
  await f.control.handle(cmd({ type: 'abort' }))
  f.control.turnStart({ turnId: 't2', text: 'q' })
  await f.control.handle(cmd({ type: 'abort' }))
  expect(f.calls).toEqual(['submit:q', 'abort:t2'])
})

test('dedupe: el prompt del dispositivo emite un solo user', async () => {
  const f = fake()
  const h = makeHandlers(() => f.link, { fromDevice: t => f.control.takeFromDevice(t) })
  await f.control.handle(cmd({ type: 'prompt', text: 'desde el móvil', mode: 'queue' }))
  h.turnStart({ text: 'desde el móvil' })
  h.turnStart({ text: 'desde el móvil' }) // la segunda vez sí lo escribió la terminal
  const users = f.evs.filter(e => e.kind === 'user').map(e => e.data.text)
  expect(users).toEqual(['desde el móvil', 'desde el móvil'])
  expect(f.kinds()).toEqual(['user', 'turn_start', 'status', 'turn_start', 'user', 'status'])
})

test('AskUserQuestion: gana la terminal → withdraw y ask_resolved{by:terminal}', async () => {
  const f = fake()
  let answer!: (r: any) => void
  const terminal = new Promise<any>(r => { answer = r })
  const questions = [{ question: '¿A o B?', options: [{ label: 'A' }, { label: 'B' }] }]
  const p = f.control.toolCall({ tool: 'AskUserQuestion', tool_use_id: 'u1', questions }, () => terminal)
  await flush()
  const ask = f.evs.find(e => e.kind === 'ask')!
  expect(ask.data.kind).toBe('question')
  expect(ask.data.questions).toEqual(questions)
  const termResult = { result: { questions, answers: { '¿A o B?': 'A' } }, text: 'A' }
  answer(termResult)
  expect(await p).toBe(termResult)
  expect(f.evs.find(e => e.kind === 'ask_resolved')!.data).toEqual({ askId: 'a1', by: 'terminal' })
  expect(f.kinds()).toEqual(['ask', 'status', 'ask_resolved', 'status'])
  expect(f.sleeps).toEqual([]) // la pregunta no vence: espera a la terminal
  // una decisión tardía del dispositivo no hace nada
  await f.control.handle(cmd({ type: 'decide', askId: 'a1', decision: 'allow', answers: { x: 'y' } }))
  expect(f.kinds().length).toBe(4)
})

test('AskUserQuestion: gana el dispositivo → respuestas con el formato de la terminal', async () => {
  const f = fake()
  const questions = [{ question: '¿A o B?', options: [{ label: 'A' }, { label: 'B' }] }]
  const p = f.control.toolCall({ tool: 'AskUserQuestion', tool_use_id: 'u1', questions }, () => new Promise(() => {}))
  await flush()
  await f.control.handle(cmd({ type: 'decide', askId: 'a1', decision: 'allow', answers: { '¿A o B?': 'B' } }))
  expect(await p).toEqual({ result: { questions, answers: { '¿A o B?': 'B' } } })
})

test('AskUserQuestion: el dispositivo cancela → deny', async () => {
  const f = fake()
  const p = f.control.toolCall({ tool: 'AskUserQuestion', tool_use_id: 'u1', questions: [] }, () => new Promise(() => {}))
  await flush()
  await f.control.handle(cmd({ type: 'decide', askId: 'a1', decision: 'deny' }))
  expect(((await p) as any).deny).toBe('El usuario canceló la pregunta desde Quorum.')
})

test('close detiene las tareas conocidas y luego sale', async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1', text: 'x' })
  await f.control.toolCall({ tool: 'Bash', tool_use_id: 'u1', command: 'sleep 100', run_in_background: true },
    async () => ({ result: { backgroundTaskId: 'b1' }, text: '' }))
  await f.control.toolCall({ tool: 'Monitor', tool_use_id: 'u2' }, async () => ({ result: { taskId: 'm1' }, text: '' }))
  await f.control.toolCall({ tool: 'Bash', tool_use_id: 'u3' }, async () => ({ result: { backgroundTaskId: 'b2' }, text: '' }))
  await f.control.toolCall({ tool: 'TaskStop', tool_use_id: 'u4', task_id: 'b2' }, ok())
  f.control.agentSpawned('ag1')
  f.control.agentSpawned('ag2')
  f.control.turnEnd({ agentId: 'ag2' })
  const done = f.control.handle(cmd({ type: 'close' }))
  await flush()
  expect(f.calls).toEqual(['stop:b1', 'stop:m1', 'stop:ag1'])
  f.sleeps[0].fire()
  await done
  expect(f.calls).toEqual(['stop:b1', 'stop:m1', 'stop:ag1', 'abort:t1', 'exit'])
})

test('close sin tareas sale de inmediato; un TaskStop que falla no bloquea', async () => {
  const f = fake()
  await f.control.handle(cmd({ type: 'close' }))
  expect(f.calls).toEqual(['exit'])
})

test('rol service: ninguna orden se aplica; responde info', async () => {
  const f = fake('service')
  await f.control.handle(cmd({ type: 'prompt', text: 'hola', mode: 'queue' }))
  await f.control.handle(cmd({ type: 'close' }))
  expect(f.calls).toEqual([])
  expect(f.evs).toEqual([
    { kind: 'info', data: { text: 'Sesión de servicio: Quorum no la controla' } },
    { kind: 'info', data: { text: 'Sesión de servicio: Quorum no la controla' } },
  ])
})

test("'now' no lo toma un \$.tool.call de un plugin (sin tool_use_id)", async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1', text: 'x' })
  await f.control.handle(cmd({ type: 'prompt', text: 'ojo', mode: 'now' }))
  const r: any = await f.control.toolCall({ tool: 'TaskStop' }, ok())
  expect(r.context).toBe(undefined)
  const r2: any = await f.control.toolCall({ tool: 'Bash', tool_use_id: 'u1' }, ok())
  expect(r2.context).toEqual(['ojo'])
})

test("interrupt lleva delante los 'now' sin entregar y no quedan para el fin del turno", async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1', text: 'x' })
  await f.control.handle(cmd({ type: 'prompt', text: 'uno', mode: 'now' }))
  await f.control.handle(cmd({ type: 'prompt', text: 'dos', mode: 'interrupt' }))
  f.control.turnEnd({})
  await flush()
  expect(f.calls).toEqual(['abort:t1', 'submit:uno\n\ndos'])
  expect(f.control.takeFromDevice('uno\n\ndos')).toBe(true)
})

test('submit que falla no deja el texto en fromDevice', async () => {
  const evs: any[] = []
  const link = { role: 'work', emit: (e: any) => evs.push(e), update: () => {} } as unknown as Link
  const control = makeControl({
    getLink: () => link,
    submit: async () => { throw new Error('no') },
    abort: async () => {}, stopTask: async () => {}, exit: async () => {},
    sleep: () => new Promise(() => {}),
  })
  await control.handle(cmd({ type: 'prompt', text: 'hola', mode: 'queue' }))
  expect(control.takeFromDevice('hola')).toBe(false)
  expect(evs.map(e => e.kind)).toEqual(['user', 'info'])
})

test("interrupt con submit fallido envía enseguida los 'now' como prompt en cola", async () => {
  const calls: string[] = []
  let fails = 1
  const link = { role: 'work', emit: () => {}, update: () => {} } as unknown as Link
  const control = makeControl({
    getLink: () => link,
    submit: async t => { calls.push(`submit:${t}`); if (fails-- > 0) throw new Error('no') },
    abort: async id => { calls.push(`abort:${id}`) },
    stopTask: async () => {}, exit: async () => {},
    sleep: () => new Promise(() => {}),
  })
  control.turnStart({ turnId: 't1', text: 'x' })
  await control.handle(cmd({ type: 'prompt', text: 'uno', mode: 'now' }))
  await control.handle(cmd({ type: 'prompt', text: 'tres', mode: 'now' }))
  await control.handle(cmd({ type: 'prompt', text: 'dos', mode: 'interrupt' }))
  expect(calls).toEqual(['abort:t1', 'submit:uno\n\ntres\n\ndos', 'submit:uno\n\ntres'])
  control.turnEnd({})
  await flush()
  expect(calls.length).toBe(3) // ya entregados: nada queda para el fin del turno
})

test("si también falla el reenvío, los 'now' esperan al fin del turno", async () => {
  const calls: string[] = []
  let fails = 2
  const link = { role: 'work', emit: () => {}, update: () => {} } as unknown as Link
  const control = makeControl({
    getLink: () => link,
    submit: async t => { calls.push(`submit:${t}`); if (fails-- > 0) throw new Error('no') },
    abort: async id => { calls.push(`abort:${id}`) },
    stopTask: async () => {}, exit: async () => {},
    sleep: () => new Promise(() => {}),
  })
  control.turnStart({ turnId: 't1', text: 'x' })
  await control.handle(cmd({ type: 'prompt', text: 'uno', mode: 'now' }))
  await control.handle(cmd({ type: 'prompt', text: 'dos', mode: 'interrupt' }))
  control.turnEnd({})
  await flush()
  expect(calls).toEqual(['abort:t1', 'submit:uno\n\ndos', 'submit:uno', 'submit:uno'])
})

/** Hook tool.check falso: el diálogo de la terminal se contesta a mano. */
function hookFake(signal?: AbortSignal) {
  const qs: string[] = []
  const held: Array<Promise<unknown>> = []
  let answer!: (s: string) => void
  return {
    qs, held, answer: (s: string) => answer(s),
    hook: { termAsk: (q: string) => { qs.push(q); return new Promise<string>(r => { answer = r }) }, signal, keepAlive: (u: Promise<unknown>) => { held.push(u) } },
  }
}

test('tool.check ask del hilo principal → carrera: diálogo en la terminal y ask al dispositivo a la vez', async () => {
  const f = fake()
  const h = hookFake()
  const p = f.control.permission({ tool: 'Bash', input: { command: 'rm x' }, tool_use_id: 'u1' }, { decision: 'ask' }, h.hook)
  await flush()
  expect(h.qs).toEqual(['Bash: rm x'])
  expect(f.evs[0]).toEqual({ kind: 'ask', data: { askId: 'a1', kind: 'permission', tool: 'Bash', summary: 'rm x', detail: '{"command":"rm x"}', questions: null } })
  expect(f.updates).toEqual([{ state: 'needs_you' }])
  expect(h.held.length).toBe(1)
  await f.control.handle(cmd({ type: 'decide', askId: 'a1', decision: 'allow' }))
  expect(await p).toEqual({ decision: 'allow', reason: 'Permitido desde Quorum' })
  // Ruling L: sin ask_resolved del mod cuando decide un dispositivo
  expect(f.kinds()).toEqual(['ask', 'status', 'status'])
  expect(f.updates).toEqual([{ state: 'needs_you' }, { state: 'working' }])
})

test('tool.check: gana la terminal → ask_resolved{by:terminal}', async () => {
  const f = fake()
  const h = hookFake()
  const p = f.control.permission({ tool: 'Write', input: { file_path: '/x' }, tool_use_id: 'u1' }, { decision: 'ask' }, h.hook)
  await flush()
  h.answer('Permitir')
  expect(await p).toEqual({ decision: 'allow', reason: 'Permitido en la terminal' })
  expect(f.evs.find(e => e.kind === 'ask_resolved')!.data).toEqual({ askId: 'a1', by: 'terminal' })
})

test('tool.check sin carrera: allow/deny, consulta sin id, AskUserQuestion/ExitPlanMode', async () => {
  const f = fake()
  const h = hookFake()
  const ask = { decision: 'ask' as const, reason: 'regla' }
  for (const e of [
    { tool: 'AskUserQuestion', input: {}, tool_use_id: 'u' },
    { tool: 'ExitPlanMode', input: {}, tool_use_id: 'u' },
    { tool: 'Bash', input: {} },
  ]) expect(await f.control.permission(e, ask, h.hook)).toBe(ask)
  for (const v of [{ decision: 'allow' as const }, { decision: 'deny' as const, reason: 'no' }]) {
    expect(await f.control.permission({ tool: 'Bash', input: {}, tool_use_id: 'u' }, v, h.hook)).toBe(v)
  }
  expect(f.evs).toEqual([])
  expect(h.qs).toEqual([])
})

test('tool.check rol service → veredicto sin tocar', async () => {
  const f = fake('service')
  const h = hookFake()
  const v = { decision: 'ask' as const }
  expect(await f.control.permission({ tool: 'Bash', input: {}, tool_use_id: 'u' }, v, h.hook)).toBe(v)
  expect(f.evs).toEqual([])
  expect(h.qs).toEqual([])
})

test('tool.check sin daemon → veredicto (el diálogo nativo; no hay dispositivos)', async () => {
  const f = fake()
  ;(f.link as any).state = 'no-daemon'
  const h = hookFake()
  const v = { decision: 'ask' as const }
  expect(await f.control.permission({ tool: 'Bash', input: {}, tool_use_id: 'u' }, v, h.hook)).toBe(v)
  expect(h.qs).toEqual([])
})

test('permiso pendiente y el turno termina (Esc/abort) → retirado, deny y working', async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1' })
  const h = hookFake()
  const p = f.control.permission({ tool: 'Bash', input: {}, tool_use_id: 'u1' }, { decision: 'ask' }, h.hook)
  await flush()
  f.control.turnEnd({})
  expect(await p).toEqual({ decision: 'deny', reason: 'Turno interrumpido' })
  expect(f.evs.find(e => e.kind === 'ask_resolved')!.data).toEqual({ askId: 'a1', by: 'terminal' })
  expect(f.evs[f.evs.length - 1]).toEqual({ kind: 'status', data: { state: 'working' } })
  expect(f.updates).toEqual([{ state: 'needs_you' }, { state: 'working' }])
  expect(f.control.asks.pending).toEqual([])
})

test('permiso pendiente y next.signal aborta → se retira', async () => {
  const f = fake()
  const ac = new AbortController()
  const h = hookFake(ac.signal)
  const p = f.control.permission({ tool: 'Bash', input: {}, tool_use_id: 'u1' }, { decision: 'ask' }, h.hook)
  await flush()
  ac.abort()
  expect(await p).toEqual({ decision: 'deny', reason: 'Turno interrumpido' })
  expect(f.kinds()).toEqual(['ask', 'status', 'ask_resolved', 'status'])
  expect(f.evs[2].data).toEqual({ askId: 'a1', by: 'terminal' })
})

test('close retira los permisos pendientes antes de salir', async () => {
  const f = fake()
  const h = hookFake()
  const p = f.control.permission({ tool: 'Bash', input: {}, tool_use_id: 'u1' }, { decision: 'ask' }, h.hook)
  await flush()
  await f.control.handle(cmd({ type: 'close' }))
  expect(await p).toEqual({ decision: 'deny', reason: 'Turno interrumpido' })
  expect(f.evs.find(e => e.kind === 'ask_resolved')!.data).toEqual({ askId: 'a1', by: 'terminal' })
  expect(f.calls).toEqual(['exit'])
})

test('tool.check de un subagente también corre la carrera; su fin retira solo su ask', async () => {
  const f = fake()
  f.control.turnStart({ turnId: 't1' })
  const hs = hookFake()
  const hm = hookFake()
  const sub = f.control.permission({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1', agentId: 'ag1' }, { decision: 'ask' }, hs.hook)
  const main = f.control.permission({ tool: 'Bash', input: { command: 'pwd' }, tool_use_id: 'u2' }, { decision: 'ask' }, hm.hook)
  await flush()
  expect(hs.qs).toEqual(['Bash: ls'])
  expect(f.control.asks.pending).toEqual(['a1', 'a2'])
  f.control.turnEnd({ agentId: 'ag1' })
  expect(await sub).toEqual({ decision: 'deny', reason: 'Turno interrumpido' })
  expect(f.control.asks.pending).toEqual(['a2'])
  expect(f.evs.filter(e => e.kind === 'ask_resolved').map(e => e.data)).toEqual([{ askId: 'a1', by: 'terminal' }])
  // el fin del turno principal retira el resto (también de otros subagentes)
  f.control.turnEnd({})
  expect(await main).toEqual({ decision: 'deny', reason: 'Turno interrumpido' })
})

test('tool.check sin terminal (hasTerminal false): no abre el diálogo, contesta el dispositivo', async () => {
  const f = fake()
  const h = hookFake()
  const p = f.control.permission({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1' }, { decision: 'ask' }, { ...h.hook, hasTerminal: async () => false })
  await flush()
  expect(h.qs).toEqual([])
  expect(f.kinds()).toEqual(['ask', 'status'])
  await f.control.handle(cmd({ type: 'decide', askId: 'a1', decision: 'allow' }))
  expect(await p).toEqual({ decision: 'allow', reason: 'Permitido desde Quorum' })
})

test('tool.check con terminal (hasTerminal true, o que falla) abre el diálogo', async () => {
  for (const hasTerminal of [async () => true, async () => { throw new Error('x') }]) {
    const f = fake()
    const h = hookFake()
    const p = f.control.permission({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1' }, { decision: 'ask' }, { ...h.hook, hasTerminal })
    await flush()
    expect(h.qs).toEqual(['Bash: ls'])
    h.answer('Permitir')
    expect(await p).toEqual({ decision: 'allow', reason: 'Permitido en la terminal' })
  }
})
