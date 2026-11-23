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

// State shared with the event and control hooks (Tasks 9-10): query it
// via `quorum.link`.
// `control` (Task 10) also lives here: it is built in session.start with closures over `$`
// (the mod compiler does not allow storing `$` in a module variable).
export const quorum: { link?: Link; control?: Control; recap?: Recap } = {}

// once per session (warns only once if hold fails): session.start creates a new one
let hold: Hold | undefined

// last main-thread prompt and whether the first one was seen (for the recap)
let lastPrompt = ''
let firstSeen = false
// branch refresh (at most once per minute) when a turn ends
let branchRefresh: { seed(b: string): void; refresh(): Promise<void> } | undefined

/** `/quorum ticket 41` -> '41'; `/quorum ticket -` -> ''; other command -> undefined. */
export function ticketArg(args: string): string | undefined {
  const m = /^\s*ticket(?:\s+(\S+))?\s*$/i.exec(args)
  if (!m) return undefined
  const v = (m[1] ?? '').replace(/^#/, '')
  return v === '-' ? '' : v
}

/** QUORUM_DISABLE=1 turns Quorum off in the session (no Link or control). */
export function disabled(v: string | undefined): boolean {
  return v === '1'
}

const STATE_TEXT = { connected: 'connected', reconnecting: 'reconnecting', 'no-daemon': 'no daemon' } as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // QUORUM_DISABLE=1 (e.g. the `claude -p` the hub resumes with): the session is not registered
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
    // recap (session name) with Haiku, only in work sessions; without $.model.complete there is no recap
    quorum.recap = undefined
    link.onCommand(c => { void control.handle(c).catch(() => {}) })
    const [id, cwd, root, model, ccapi, sinfo, launchReq, herdrPane, herdrWorkspace] = await Promise.all([
      // optional: an API missing in this Claude Code version does not abort registration
      optional(() => $.session.id(), ''),
      optional(() => $.session.cwd(), ''),
      optional(() => $.session.root(), ''),
      optional(() => $.session.model(), ''),
      optional(() => $.env.get('CCAPI_SERVER'), undefined),
      optional(() => $.session.info(), undefined),
      // Quorum launch (ties the session to the request) and the herdr pane it runs in
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
          // optional: without $.session.messages (old builds) the last prompt + answer is used
          const rows = await optional(() => $.session.messages({ last: 30 }), undefined)
          return Array.isArray(rows) ? rows.map(m => ({ role: m.role, text: m.text })) : []
        },
        complete: async prompt => {
          // optional: without $.model.complete (old builds) there is no recap and no error either
          const res = await optional(() => $.model.complete({ model: 'haiku', prompt, maxTokens: 40, timeoutMs: 8000 }), undefined)
          return res?.isAnswered ? res.text : ''
        },
      })
    }
    await $.command.register({ name: 'quorum', description: 'Connection status with quorumd' })
    // not awaited: ensure+register can be slow and session.start blocks the first prompt
    void link.start({
      id, previousId: '', machine: '', name: '', cwd, root: root || cwd, model: String(model ?? ''),
      role: r.role, state: 'idle', contextPct: 0, startedAt: now, updatedAt: now,
      transcriptPath: String(sinfo?.transcriptPath ?? ''), recap: '', repoUrl: '', branch: '', projectId: '',
      launchReq: launchReq ?? '', herdrPane: herdrPane ?? '', herdrWorkspace: herdrWorkspace ?? '',
    }).catch(() => {})
    // repo and branch go separately (git can be slow): detected without blocking and sent with update
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

  // A single tool.call hook: events outside (tool_start/tool_end see the final
  // result), control inside (AskUserQuestion against the device, 'now' prompts).
  // Mod calls (the own permission dialog, $.tool.call) pass through without being reflected.
  on('tool.call', async ($, e, next) => {
    if (fromPlugin((next as { origin?: { plugin?: string } }).origin, e as never)) return next(e)
    return toolHook(h, e as never, () => (quorum.control ? quorum.control.toolCall(e as never, () => next(e)) : next(e)))
  })

  // Permissions without modes: when the engine would ask for permission, control.permission runs the
  // race between an own dialog in the terminal ($.ui.ask: the native one cannot be
  // answered from outside) and the card on the devices; the first answer wins.
  // Main thread and subagents. Esc in the dialog denies (like the native one); without a
  // terminal (-p) only the device answers. While
  // $.ui.ask is open the hook's clock does not run; in addition a `quorumd hold` launched
  // with this hook's `$` sustains the wait (an in-flight `$` does not spend the 10 s
  // of its own). On failure, the verdict.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const c = quorum.control
    if (!c) return verdict
    const h = hold
    return c.permission(e, verdict, {
      termAsk: q => $.ui.ask(q, { options: [TERM_ALLOW, TERM_DENY], header: 'Permission' }),
      // without surfaces (-p run) nobody can answer $.ui.ask: only the device
      hasTerminal: async () => {
        const s = await optional(() => $.session.surfaces(), undefined)
        return !Array.isArray(s) || s.length > 0
      },
      signal: next.signal,
      keepAlive: h ? until => h(until, argv => $.process.spawn({ argv })) : undefined,
      log: msg => { void Promise.resolve($.ui.log(msg)).catch(() => {}) },
    }) as typeof verdict | Promise<typeof verdict>
    // in .catch, `next` is replay-safe (Caught in the d.ts): since the hook already called
    // next(e), this returns that same original verdict without running anything again.
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
    if (!l) return { text: 'quorum: no session started' }
    const t = ticketArg(String((e as { args?: string }).args ?? ''))
    if (t !== undefined) {
      if (l.role === 'service') return { text: 'quorum: service sessions are not linked to tickets' }
      l.emit({ kind: 'ticket', data: { ticket: t } })
      return { text: t ? `quorum: linking ticket ${t}` : 'quorum: unlinking ticket' }
    }
    const role = l.role === 'service' ? 'service' : 'work'
    if (l.state === 'no-daemon') return { text: `quorumd is unavailable: ${l.error}\nrole: ${role}` }
    const lines = [
      `machine: ${l.machine}`,
      `connection: ${STATE_TEXT[l.state]}`,
      `role: ${role}`,
    ]
    if (l.versionWarning) lines.push(`warning: ${l.versionWarning}`)
    return { text: lines.join('\n') }
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    const link = quorum.link
    if (!link) return r
    if (e.reason === 'clear' || e.reason === 'resume') {
      // the process continues with another id and no session.start: follow it
      $.clock.after(300, () => {
        void $.session.id().then(id => { if (id) link.adoptId(id) }, () => {})
      })
    } else {
      link.stop()
    }
    return r
  })
}
