import type { Register } from 'claude-code'

import { optional } from '../src/compat'
import { type Control, makeControl } from '../src/control'
import { type Hold, makeHold } from '../src/hold'
import { TERM_ALLOW, TERM_DENY } from '../src/permission'
import { contextPct, fromPlugin, makeHandlers, stepHook, toolHook } from '../src/events'
import { makeIO } from '../src/io'
import { Link } from '../src/link'
import { Recap } from '../src/recap'
import { detectRepo, makeBranchRefresher, type RepoDeps } from '../src/repo'
import { detectRole } from '../src/role'

// Estado compartido con los hooks de eventos y control (Tasks 9-10): consúltalo
// con `quorum.link`.
// `control` (Task 10) también vive aquí: se arma en session.start con closures sobre `$`
// (el compilador de mods no deja guardar `$` en una variable del módulo).
export const quorum: { link?: Link; control?: Control; recap?: Recap } = {}

// una vez por sesión (avisa una sola vez si hold falla): session.start crea uno nuevo
let hold: Hold | undefined

// último prompt del hilo principal y si ya se vio el primero (para el recap)
let lastPrompt = ''
let firstSeen = false
// refresco de la rama (a lo sumo una vez por minuto) al terminar un turno
let branchRefresh: { seed(b: string): void; refresh(): Promise<void> } | undefined

/** `/quorum ticket 41` -> '41'; `/quorum ticket -` -> ''; otro comando -> undefined. */
export function ticketArg(args: string): string | undefined {
  const m = /^\s*ticket(?:\s+(\S+))?\s*$/i.exec(args)
  if (!m) return undefined
  const v = (m[1] ?? '').replace(/^#/, '')
  return v === '-' ? '' : v
}

/** QUORUM_DISABLE=1 apaga Quorum en la sesión (no hay Link ni control). */
export function disabled(v: string | undefined): boolean {
  return v === '1'
}

const STATE_TEXT = { connected: 'conectado', reconnecting: 'reconectando', 'no-daemon': 'sin daemon' } as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // QUORUM_DISABLE=1 (p. ej. el `claude -p` con que el hub resume): la sesión no se registra
    if (disabled(await optional(() => $.env.get('QUORUM_DISABLE'), undefined))) {
      quorum.link?.stop()
      quorum.link = undefined
      quorum.control = undefined
      quorum.recap = undefined
      hold = undefined
      branchRefresh = undefined
      return started
    }
    hold = makeHold({
      spawn: argv => $.process.spawn({ argv }),
      info: text => quorum.link?.emit({ kind: 'info', data: { text } }),
      debug: msg => { void Promise.resolve($.ui.log(msg, { to: 'debug' })).catch(() => {}) },
    })
    quorum.link?.stop()
    firstSeen = false
    lastPrompt = ''
    branchRefresh = undefined
    const link = new Link(makeIO($))
    quorum.link = link
    const control = makeControl({
      getLink: () => link,
      submit: text => $.prompt.submit({ text, asUser: true }),
      abort: turnId => $.turn.abort({ turnId }),
      stopTask: id => $.tool.call({ tool: 'TaskStop', task_id: id } as never),
      exit: () => $.command.run({ command: 'exit', args: '' } as never),
      sleep: ms => $.clock.sleep(ms),
    })
    quorum.control = control
    // recap (nombre de la sesión) con Haiku, solo en sesiones de trabajo; sin $.model.complete no hay recap
    quorum.recap = undefined
    link.onCommand(c => { void control.handle(c).catch(() => {}) })
    const [id, cwd, root, model, ccapi, sinfo, launchReq, herdrPane, herdrWorkspace] = await Promise.all([
      // optional: una API que falte en esta versión de Claude Code no aborta el registro
      optional(() => $.session.id(), ''),
      optional(() => $.session.cwd(), ''),
      optional(() => $.session.root(), ''),
      optional(() => $.session.model(), ''),
      optional(() => $.env.get('CCAPI_SERVER'), undefined),
      optional(() => $.session.info(), undefined),
      // lanzamiento de Quorum (ata la sesión a la petición) y panel de herdr donde corre
      optional(() => $.env.get('QUORUM_LAUNCH_REQ'), ''),
      optional(() => $.env.get('HERDR_PANE_ID'), ''),
      optional(() => $.env.get('HERDR_WORKSPACE_ID'), ''),
    ])
    const r = detectRole(k => (k === 'CCAPI_SERVER' ? ccapi : undefined))
    const now = Date.now()
    if (r.role === 'work') {
      quorum.recap = new Recap({
        now: () => Date.now(),
        sleep: ms => $.clock.sleep(ms),
        update: recap => link.update({ recap }),
        messages: async () => {
          // optional: sin $.session.messages (builds viejos) se usa último prompt + respuesta
          const rows = await optional(() => $.session.messages({ last: 30 }), undefined)
          return Array.isArray(rows) ? rows.map(m => ({ role: m.role, text: m.text })) : []
        },
        complete: async prompt => {
          // optional: sin $.model.complete (builds viejos) no hay recap y tampoco error
          const res = await optional(() => $.model.complete({ model: 'haiku', prompt, maxTokens: 40, timeoutMs: 8000 }), undefined)
          return res?.isAnswered ? res.text : ''
        },
      })
    }
    await $.command.register({ name: 'quorum', description: 'Estado de la conexión con quorumd' })
    // no se espera: ensure+register pueden tardar y session.start bloquea el primer prompt
    void link.start({
      id, previousId: '', machine: '', name: '', cwd, root: root || cwd, model: String(model ?? ''),
      role: r.role, state: 'idle', contextPct: 0, startedAt: now, updatedAt: now,
      transcriptPath: String(sinfo?.transcriptPath ?? ''), recap: '', repoUrl: '', branch: '', projectId: '',
      launchReq: launchReq ?? '', herdrPane: herdrPane ?? '', herdrWorkspace: herdrWorkspace ?? '',
    }).catch(() => {})
    // repo y rama van aparte (git puede tardar): se detectan sin bloquear y se mandan con update
    const repoDeps: RepoDeps = {
      repo: () => ($.session as unknown as { repo: RepoDeps['repo'] }).repo(),
      run: argv => $.process.run(argv, { timeoutMs: 3000 }) as never,
    }
    const rroot = root || cwd
    const refresher = makeBranchRefresher(repoDeps, rroot, branch => link.update({ branch }), () => Date.now())
    branchRefresh = refresher
    void detectRepo(repoDeps, rroot).then(rb => {
      refresher.seed(rb.branch)
      if (rb.repoUrl || rb.branch) link.update(rb)
    }).catch(() => {})
    return started
  })

  const h = makeHandlers(() => quorum.link, { fromDevice: t => quorum.control?.takeFromDevice(t) ?? false })

  on('turn.start', async ($, e, next) => {
    quorum.control?.turnStart(e)
    h.turnStart(e)
    if (e.agentId === undefined) {
      lastPrompt = e.text
      if (!firstSeen) { firstSeen = true; quorum.recap?.onFirstPrompt(e.text) }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    return yield* stepHook(h, e, next(e) as never)
  })

  // Un solo hook tool.call: eventos por fuera (tool_start/tool_end ven el resultado
  // final), control por dentro (AskUserQuestion contra el dispositivo, prompts 'now').
  // Las llamadas de mods (el diálogo de permiso propio, $.tool.call) pasan sin reflejarse.
  on('tool.call', async ($, e, next) => {
    if (fromPlugin((next as { origin?: { plugin?: string } }).origin, e as never)) return next(e)
    return toolHook(h, e as never, () => (quorum.control ? quorum.control.toolCall(e as never, () => next(e)) : next(e)))
  })

  // Permisos sin modos: cuando el engine pediría permiso, control.permission corre la
  // carrera entre un diálogo propio en la terminal ($.ui.ask: el nativo no se puede
  // contestar desde fuera) y la tarjeta en los dispositivos; gana la primera respuesta.
  // Hilo principal y subagentes. Esc en el diálogo deniega (como el nativo); sin
  // terminal (-p) contesta solo el dispositivo. Mientras
  // $.ui.ask está abierto el reloj del hook no corre; además un `quorumd hold` lanzado
  // con el `$` de este hook sostiene la espera (un `$` en curso no gasta los 10 s
  // propios). Ante fallo, el veredicto.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const c = quorum.control
    if (!c) return verdict
    const h = hold
    return c.permission(e, verdict, {
      termAsk: q => $.ui.ask(q, { options: [TERM_ALLOW, TERM_DENY], header: 'Permiso' }),
      // sin superficies (corrida -p) no hay quien conteste $.ui.ask: solo el dispositivo
      hasTerminal: async () => {
        const s = await optional(() => $.session.surfaces(), undefined)
        return !Array.isArray(s) || s.length > 0
      },
      signal: next.signal,
      keepAlive: h ? until => h(until, argv => $.process.spawn({ argv })) : undefined,
      log: msg => { void Promise.resolve($.ui.log(msg)).catch(() => {}) },
    }) as typeof verdict | Promise<typeof verdict>
    // en .catch, `next` es replay-safe (Caught en el d.ts): como el hook ya llamó a
    // next(e), esto devuelve ese mismo veredicto original sin volver a correr nada.
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    h.agentSpawn(e as never, r as never)
    quorum.control?.agentSpawned((r as { agentId?: string } | undefined)?.agentId)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    h.turnComplete(e as never, async () => contextPct((await $.session.usage()) as never))
    quorum.control?.turnEnd(e)
    if ((e as { agentId?: string }).agentId === undefined) void branchRefresh?.refresh().catch(() => {})
    if ((e as { agentId?: string }).agentId === undefined) quorum.recap?.onTurnEnd(lastPrompt, String((e as { answer?: string }).answer ?? ''))
    return r
  })

  on('command.run', { command: 'quorum' }, async (_$, e) => {
    const l = quorum.link
    if (!l) return { text: 'quorum: sin sesión iniciada' }
    const t = ticketArg(String((e as { args?: string }).args ?? ''))
    if (t !== undefined) {
      if (l.role === 'service') return { text: 'quorum: las sesiones de servicio no se asocian a tickets' }
      l.emit({ kind: 'ticket', data: { ticket: t } })
      return { text: t ? `quorum: asociando el ticket ${t}` : 'quorum: desasociando el ticket' }
    }
    const role = l.role === 'service' ? 'servicio' : 'trabajo'
    if (l.state === 'no-daemon') return { text: `quorumd no está disponible: ${l.error}\nrol: ${role}` }
    const lines = [
      `máquina: ${l.machine}`,
      `conexión: ${STATE_TEXT[l.state]}`,
      `rol: ${role}`,
    ]
    if (l.versionWarning) lines.push(`aviso: ${l.versionWarning}`)
    return { text: lines.join('\n') }
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    const link = quorum.link
    if (!link) return r
    if (e.reason === 'clear' || e.reason === 'resume') {
      // el proceso sigue con otro id y sin session.start: seguirlo
      $.clock.after(300, () => {
        void $.session.id().then(id => { if (id) link.adoptId(id) }, () => {})
      })
    } else {
      link.stop()
    }
    return r
  })
}
