import type { Register } from 'claude-code'

import { configDirFrom, enabledPlugins, makeAccountLookup, accountKey } from '../src/account'
import { type CommandsReporter, effortFromStop, makeCommandsReporter } from '../src/commands'
import { optional } from '../src/compat'
import { type Control, makeControl } from '../src/control'
import { type Hold, makeHold } from '../src/hold'
import { TERM_ALLOW, TERM_DENY } from '../src/permission'
import { isTaskNotification } from '../src/background'
import { fromPlugin, makeHandlers, stepHook, toolHook } from '../src/events'
import { imageIds, makeImageFinder } from '../src/images'
import { makeIO } from '../src/io'
import { Link } from '../src/link'
import { PENDING_TOOLS, runPendingTool } from '../src/pendings'
import { contextOf, Meters } from '../src/meters'
import { Recap } from '../src/recap'
import { detectRepo, makeBranchRefresher, type RepoDeps } from '../src/repo'
import { detectRole } from '../src/role'

// State shared with the event and control hooks (Tasks 9-10): query it
// via `quorum.link`.
// `control` (Task 10) also lives here: it is built in session.start with closures over `$`
// (the mod compiler does not allow storing `$` in a module variable).
export const quorum: {
  link?: Link; control?: Control; recap?: Recap; images?: ReturnType<typeof makeImageFinder>; commands?: CommandsReporter
} = {}

// once per session (warns only once if hold fails): session.start creates a new one
let hold: Hold | undefined

// the images folder last reported in the register (re-sent only when it changes)
let imagesDirSent = ''
// how long turn.start may wait for the pasted-image lookup
const IMAGES_DEADLINE_MS = 300
// last main-thread prompt and whether the first one was seen (for the recap)
let lastPrompt = ''
let firstSeen = false
// the running main turn was started by a task notification (no recap from it)
let notificationTurn = false
// branch refresh (at most once per minute) when a turn ends
let branchRefresh: { seed(b: string): void; refresh(): Promise<void> } | undefined
// token totals and throttled usage reports of the current session
let meters: Meters | undefined

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

const OWN_PENDING_TOOLS = new Set(['mcp__quorum__pending_add', 'mcp__quorum__pending_list', 'mcp__quorum__pending_done'])
export function isOwnPendingTool(tool: unknown): boolean {
  return typeof tool === 'string' && OWN_PENDING_TOOLS.has(tool)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // QUORUM_DISABLE=1 (e.g. the `claude -p` the hub resumes with) or headless: the session is not registered
    // headless runs (`claude -p`, the SDK) report isInteractive: false; older builds omit it (= interactive)
    const headless = (e as { isInteractive?: boolean } | undefined)?.isInteractive === false
    if (headless || disabled(await optional(() => $.env.get('QUORUM_DISABLE'), undefined))) {
      quorum.link?.stop()
      quorum.link = undefined
      quorum.control = undefined
      quorum.recap = undefined
      quorum.images = undefined
      quorum.commands = undefined
      hold = undefined
      branchRefresh = undefined
      meters = undefined
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
    const m = new Meters({ now: () => Date.now(), update: p => link.update(p) })
    meters = m
    // slash commands, model/effort options, model and effort (commands.ts): built once the
    // registered model is known (below); the control reads it through this variable
    let reporter: CommandsReporter | undefined
    const control = makeControl({
      getLink: () => link,
      submit: text => $.prompt.submit({ text, asUser: true }),
      abort: turnId => $.turn.abort({ turnId }),
      stopTask: id => $.tool.call({ tool: 'TaskStop', task_id: id } as never),
      exit: () => $.command.run({ command: 'exit', args: '' } as never),
      sleep: ms => $.clock.sleep(ms),
      now: () => Date.now(),
      commandRun: (command, args) => $.command.run({ command, args }),
      commands: () => reporter?.current(),
      refreshCommands: () => reporter?.check() ?? Promise.resolve(),
      // the /config Model row: no confirm dialog, unlike /model (commands.ts)
      setModel: value => $.config.set({ key: 'model', value }) as Promise<{ value?: unknown; deny?: string }>,
      modelOptions: () => reporter?.modelOptions(),
      // the model, list and options are re-read once a device command settled
      commandSettled: () => { void reporter?.check().catch(() => {}) },
    })
    quorum.control = control
    // recap (session name) with Haiku, only in work sessions; without $.model.complete there is no recap
    quorum.recap = undefined
    link.onCommand(c => { void control.handle(c).catch(() => {}) })
    const [id, cwd, root, model, ccapi, sinfo, launchReq, herdrPane, herdrWorkspace, envDir, home] = await Promise.all([
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
      optional(() => $.env.get('CLAUDE_CONFIG_DIR'), ''),
      optional(() => $.env.get('HOME'), ''),
    ])
    const configDir = configDirFrom(envDir, home)
    // every call optional, checked without awaiting (session start, turn end, after a device
    // command or a plugin reload)
    reporter = makeCommandsReporter({
      list: () => $.command.list(),
      skills: async () => {
        const u = await optional(() => $.session.usage({ breakdown: 'summary' }), undefined)
        const s = (u?.context as { breakdown?: { skills?: { skillFrontmatter?: unknown[] } } } | undefined)?.breakdown?.skills
        return Array.isArray(s?.skillFrontmatter) ? s.skillFrontmatter : undefined
      },
      config: () => $.config.list(),
      model: () => $.session.model(),
      send: p => link.setCommands(p),
      update: p => link.update(p),
      initialModel: String(model ?? ''),
    })
    quorum.commands = reporter
    const plugins = configDir
      ? enabledPlugins(await optional(() => $.fs.read(`${configDir}/settings.json`) as Promise<string>, ''))
      : []
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
    // pending-item tools (mcp__quorum__pending_*), served by the tool.run hooks below; awaited so they are
    // listed by turn one, and a failure is only logged
    const regs = await Promise.allSettled(PENDING_TOOLS.map(spec => Promise.resolve($.tool.register(spec))))
    regs.forEach((res, i) => {
      if (res.status === 'rejected') {
        const err = res.reason as Error
        void Promise.resolve($.ui.log(`quorum: tool.register ${PENDING_TOOLS[i]!.name} failed: ${String(err?.message ?? err)}`, { to: 'debug' })).catch(() => {})
      }
    })
    // not awaited: ensure+register can be slow and session.start blocks the first prompt
    void link.start({
      id, previousId: '', machine: '', name: '', cwd, root: root || cwd, model: String(model ?? ''),
      role: r.role, state: 'idle', contextPct: 0, startedAt: now, updatedAt: now,
      transcriptPath: String(sinfo?.transcriptPath ?? ''), recap: '', repoUrl: '', branch: '', projectId: '',
      launchReq: launchReq ?? '', herdrPane: herdrPane ?? '', herdrWorkspace: herdrWorkspace ?? '',
      account: '', accountKey: '', configDir, plugins, contextEstimate: false,
      tokens: { in: 0, out: 0, cache: 0 }, rateLimits: [], usageAt: 0, imagesDir: '',
      background: { tasks: 0, wakeAt: 0 }, unread: false,
      effort: '', modelOptions: [], effortOptions: [],
    }).catch(() => {})
    // the command list and model/effort options: after link.start (whose info the updates apply to)
    void reporter.check().catch(() => {})
    // the account's usage as Claude Code knows it at start (after link.start, which holds the info
    // updates apply to): reported right away, without the 30 s throttle, so the account shows on the
    // board before the first turn ends; nothing when it has no rate limits yet
    void Promise.all([optional(() => $.session.usage(), undefined), optional(() => $.clock.now(), Date.now())])
      .then(([u, at]) => { if (meters === m) m.reportStart(u as never, at) }).catch(() => {})
    // pasted images (`[Image #N]`): Claude Code's per-session temp folder. Windows has no uid
    // and another layout: the feature stays off there.
    const isWindows = (sinfo as { platform?: string } | undefined)?.platform === 'windows'
    quorum.images = isWindows ? undefined : makeImageFinder({
      tmpRoot: () => optional(() => $.env.get('CLAUDE_CODE_TMPDIR'), undefined),
      uid: async () => {
        const r = await $.process.run(['id', '-u'], { timeoutMs: 3000 })
        const out = String(r.stdout ?? '').trim()
        return r.exitCode === 0 && /^\d{1,10}$/.test(out) ? Number(out) : undefined
      },
      projects: [root || cwd, cwd],
      sessionId: () => link.sessionId,
      list: dir => $.fs.list(dir),
    })
    imagesDirSent = ''
    void quorum.images?.dir().then(dir => {
      if (dir && quorum.link === link) { imagesDirSent = dir; link.update({ imagesDir: dir }) }
    }).catch(() => {})
    // account (whoas alias + hashed identity) resolves without blocking the registration
    const lookup = makeAccountLookup({
      run: async (argv, dir) => {
        const r = await $.process.run(argv, dir ? { cwd: dir, timeoutMs: 3000 } : { timeoutMs: 3000 })
        return r.exitCode === 0 ? String(r.stdout) : ''
      },
    })
    void (async () => {
      const [account, ident] = await Promise.all([
        lookup(cwd || root || '').catch(() => 'default'),
        optional(() => $.session.identity(), undefined),
      ])
      // only the hash leaves this function: the email / organization id are never stored or sent
      const idValue = ident?.email || ident?.organizationId || ''
      link.update({ account, accountKey: idValue ? await accountKey(idValue) : '' })
    })().catch(() => {})
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

  // the pending-item tools answer through the local daemon; a failure is an error result the model reads
  for (const spec of PENDING_TOOLS) {
    on('tool.run', { tool: `mcp__quorum__${spec.name}` }, async ($, e) => {
      const link = quorum.link
      if (!link) return { deny: 'Quorum is not connected; the item was not saved' }
      const key = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
      const r = await runPendingTool(link, link.sessionId, spec.name, e as unknown as Record<string, unknown>, key)
      return r.ok ? { result: r.text } : { deny: r.text }
    })
  }

  const h = makeHandlers(() => quorum.link, {
    fromDevice: t => quorum.control?.takeFromDevice(t) ?? false,
    fromCommand: (n, a) => quorum.control?.takeCommand(n, a) ?? false,
    // at the main turn's end: a subagent still running counts as background
    background: () => quorum.control?.background(true),
    // control.turnStart (which runs first) decided it
    isNotification: t => quorum.control?.isNotificationTurn() ?? isTaskNotification(t),
  })

  // A background task's end reaches the session as a `<task-notification>` prompt: its task
  // is no longer pending and a task_end card is emitted (the follow-up turn it starts reports
  // working on its own; it shows no user bubble).
  on('prompt.submit', async ($, e, next) => {
    // the engine's origin stamp decides; only a build without one falls back to the text
    const origin = (e as { origin?: { kind?: string } }).origin
    try {
      if (origin ? origin.kind === 'task-notification' : isTaskNotification(e.text)) quorum.control?.taskNotification(String(e.text ?? ''))
      else if (origin) quorum.control?.ownerPrompt(String(e.text ?? ''))
    } catch { /* never toward Claude Code */ }
    return next(e)
  })

  // At the end of a main turn Claude Code says what is still in flight and which crons will
  // wake the session (older builds omit both): the authority over the mod's own tracking.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    try { quorum.control?.stopHook(e as never) } catch { /* never toward Claude Code */ }
    try { quorum.commands?.effort(effortFromStop(e)) } catch { /* same */ }
    return r
  })

  // /model (typed, picked or sent from a device) switched the model: report it
  on('classic.PostModelSwitch', async ($, e, next) => {
    const r = await next(e)
    try { quorum.commands?.model((e as { to_model?: string }).to_model) } catch { /* never toward Claude Code */ }
    return r
  })

  // a plugin or skill reload changes the command list: re-checked once it ran
  for (const command of ['reload-plugins', 'reload-skills']) {
    on('command.run', { command }, async ($, e, next) => {
      const r = await next(e)
      void quorum.commands?.check().catch(() => {})
      return r
    })
  }

  // Stop pressed in Claude Code: noted before any await (it is raised before the abort settles)
  on('session.stop', ($, e, next) => {
    h.sessionStop(e.isTurnRunning === true)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    quorum.control?.turnStart(e)
    let images: Array<{ n: number; path: string }> | undefined
    const finder = quorum.images
    if (e.agentId === undefined && finder && imageIds(e.text).length) {
      // a few local file system calls, never more than IMAGES_DEADLINE_MS of the turn; the folder
      // found is reported so the hub can serve from it
      const r = await Promise.race([
        finder.find(e.text, dir => $.fs.list(dir)).catch(() => undefined),
        optional(() => $.clock.sleep(IMAGES_DEADLINE_MS), undefined).then(() => undefined),
      ])
      if (r?.dir && r.dir !== imagesDirSent) { imagesDirSent = r.dir; quorum.link?.update({ imagesDir: r.dir }) }
      images = r?.images
    }
    h.turnStart({ ...e, images })
    // a notification turn is not the owner's prompt: no recap from it
    if (e.agentId === undefined) notificationTurn = quorum.control?.isNotificationTurn() ?? isTaskNotification(e.text)
    if (e.agentId === undefined && !notificationTurn) {
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
    // Quorum's own pending tools only touch the owner's pending list: never ask.
    if (isOwnPendingTool(e.tool)) return { decision: 'allow', reason: 'Quorum pending list' } as never
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
    // read field by field: the typecheck confirms the host's names
    h.agentSpawn({ subagentType: e.subagentType, description: e.description, tool_use_id: e.tool_use_id, parentAgentId: e.parentAgentId }, r as never)
    quorum.control?.agentSpawned((r as { agentId?: string } | undefined)?.agentId, e as never)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const main = (e as { agentId?: string }).agentId === undefined
    // one $.session.usage() per main-thread turn, shared by the context percentage and the meters
    const usageP = main ? optional(() => $.session.usage(), undefined) : undefined
    h.turnComplete(e as never, async () => {
      const ctx = contextOf((await usageP)?.context)
      // pct and its estimate flag come from the same reading
      if (ctx) quorum.link?.update({ contextEstimate: ctx.estimate })
      return ctx?.pct
    })
    if (main && meters) {
      const m = meters
      m.addTurn((e as { usage?: never }).usage)
      // the totals and context go with every main-turn end; only rate limits are throttled
      void Promise.all([usageP, optional(() => $.clock.now(), Date.now())]).then(([u, at]) => { m.report(u as never, at, { turnEnd: true }) }).catch(() => {})
    }
    quorum.control?.turnEnd(e)
    if ((e as { agentId?: string }).agentId === undefined) void branchRefresh?.refresh().catch(() => {})
    // a skill or plugin may have come or gone during the turn: fire-and-forget, never awaited here
    if ((e as { agentId?: string }).agentId === undefined) void quorum.commands?.check().catch(() => {})
    if ((e as { agentId?: string }).agentId === undefined && !notificationTurn) quorum.recap?.onTurnEnd(lastPrompt, String((e as { answer?: string }).answer ?? ''))
    return r
  })

  // Live compaction (/compact, the threshold, a plugin): a `compact` divider once it stands
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    try { h.compact(e as never, r as never, Date.now()) } catch { /* never toward Claude Code */ }
    return r
  })

  // Claude Code measures the window as it moves: report it (throttled to once per 30 s)
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    try { meters?.report(e as never, await optional(() => $.clock.now(), Date.now())) } catch { /* never break the measure chain */ }
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
