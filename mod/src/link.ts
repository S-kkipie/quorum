import type { Command, Event, SessionCommand, SessionInfo } from './proto.gen'
import { Version } from './proto.gen'

export type LinkIO = {
  run(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr?: string }>
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number }>
  spawn(argv: string[]): AsyncIterable<{ stream: string; text: string }>
  sleep(ms: number): Promise<void>
  /** Clock in ms (optional; Date.now by default). */
  now?: () => number
  /** Optional diagnostics (called only when the message changes). */
  log?: (msg: string) => void
}

export type ConnState = 'connected' | 'reconnecting' | 'no-daemon'
export type OutEvent = Omit<Event, 'seq' | 'session' | 'ts'>

export const BACKOFF_MS = [1000, 2000, 5000, 10000]
export const FLUSH_MS = 150
export const POST_TIMEOUT_MS = 2000
export const MAX_QUEUE = 2000
export const HEALTHY_MS = 30_000

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

type Conn = { port: number; token: string; machine: string; version: string }

export class Link {
  state: ConnState = 'no-daemon'
  machine = ''
  error = ''
  /** Version of the daemon that answered ensure ("" if it did not report one). */
  daemonVersion = ''
  /** Warning if the daemon version differs from the mod's ("" if they match or it is ignored). */
  versionWarning = ''
  role = 'work'
  private info!: SessionInfo
  private conn?: Conn
  private queue: Event[] = []
  private handlers: Array<(c: Command) => void> = []
  private epoch = 0
  private changed = deferred()
  private stopped = false
  /** Epoch of the flush loop: start launches a new one and the previous one ends by itself. */
  private flushGen = 0
  /** Flush in progress: there are never two event POSTs at once (they would be reordered). */
  private inFlight: Promise<void> = Promise.resolve()
  private lastLog = ''

  constructor(private io: LinkIO) {}

  get sessionId(): string {
    return this.info?.id ?? ''
  }

  onCommand(fn: (c: Command) => void): void {
    this.handlers.push(fn)
  }

  async start(info: SessionInfo): Promise<void> {
    this.info = { ...info }
    this.role = info.role
    this.stopped = false
    this.state = 'reconnecting'
    void this.flushLoop(++this.flushGen)
    const epoch = this.bump()
    const ok = await this.connect(epoch)
    void this.loop(epoch, ok)
  }

  stop(): void {
    this.stopped = true
    this.bump()
    if (this.conn && this.info?.id) void this.post(`/v1/sessions/${this.info.id}/gone`, undefined)
  }

  /** The session continues in the same process with another id (/clear, /resume). */
  adoptId(newId: string): void {
    if (!this.info || newId === this.info.id) return
    this.info = { ...this.info, previousId: this.info.id, id: newId }
    const epoch = this.bump()
    void (async () => {
      const ok = await this.connect(epoch)
      void this.loop(epoch, ok)
    })()
  }

  // the last command list (commands.ts): re-sent after every (re)connect, so a restarted daemon
  // or a new session id (/clear) gets it too
  private commands?: { commands: SessionCommand[]; hash: string }

  /**
   * The session's command list changed: POSTed to the daemon (session_commands toward the hub).
   * Resolves true when the daemon took it (2xx); false offline (the next connect sends it) or
   * when the POST failed, so the caller retries.
   */
  async setCommands(c: { commands: SessionCommand[]; hash: string }): Promise<boolean> {
    this.commands = c
    if (!this.conn || this.state !== 'connected' || !this.info) return false // the next connect sends it
    const status = await this.postCommands()
    return status >= 200 && status < 300
  }

  private postCommands(): Promise<number> {
    if (!this.commands || !this.info) return Promise.resolve(0)
    const id = this.info.id
    return this.post(`/v1/sessions/${id}/commands`, { session: id, ...this.commands })
  }

  /** Merges fields into the session info and re-registers it (without waiting; skipped when offline). */
  update(patch: Partial<SessionInfo>): void {
    if (!this.info) return
    this.info = { ...this.info, ...patch, updatedAt: this.now() }
    this.infoRev++
    if (!this.conn || this.state !== 'connected') return // the next connect registers the current info
    void this.pushRegister()
  }

  // bumped on every update(): a change made while the register is in flight is re-sent once connected
  private infoRev = 0
  private regBusy = false
  private regDirty = false
  /** A single register in flight; if more changes arrive, only the latest is sent afterwards. */
  private async pushRegister(): Promise<void> {
    if (this.regBusy) { this.regDirty = true; return }
    this.regBusy = true
    try {
      do {
        this.regDirty = false
        if (!this.conn || this.state !== 'connected') break
        await this.post('/v1/sessions/register', { ...this.info, machine: this.machine })
      } while (this.regDirty)
    } finally {
      this.regBusy = false
    }
  }

  emit(ev: OutEvent): void {
    const last = this.queue[this.queue.length - 1]
    if (last && ev.kind === 'assistant_delta' && last.kind === 'assistant_delta' && last.data?.agent === ev.data?.agent) {
      last.data = { ...last.data, text: String(last.data?.text ?? '') + String(ev.data?.text ?? '') }
      return
    }
    this.queue.push({ ...ev, seq: 0, session: '', ts: this.now() })
    if (this.queue.length > MAX_QUEUE) {
      const i = this.queue.findIndex(e => e.kind === 'assistant_delta')
      this.queue.splice(i >= 0 ? i : 0, 1)
    }
  }

  /** New epoch: the previous loops and attach end. */
  private bump(): number {
    this.epoch++
    this.changed.resolve()
    this.changed = deferred()
    return this.epoch
  }

  /** sleep that returns false if the environment was unloaded (aborted sleep). */
  private async nap(ms: number): Promise<boolean> {
    try {
      await this.io.sleep(ms)
      return true
    } catch {
      return false
    }
  }

  private now(): number {
    return (this.io.now ?? Date.now)()
  }

  private log(msg: string): void {
    if (msg === this.lastLog) return
    this.lastLog = msg
    this.io.log?.(msg)
  }

  /** ensure + register. False if the daemon is unavailable. */
  private async connect(epoch: number): Promise<boolean> {
    let conn: Conn
    try {
      const r = await this.io.run(['quorumd', 'ensure', '--json'])
      if (r.exitCode !== 0) {
        let detail = (r.stderr ?? '').trim()
        if (!detail) {
          try { detail = String(JSON.parse(r.stdout)?.error ?? '') } catch { /* stdout is not JSON */ }
        }
        throw new Error(`ensure exited with code ${r.exitCode}${detail ? `: ${detail}` : ''}`)
      }
      const out = JSON.parse(r.stdout)
      if (!out.ok) throw new Error(out.error || 'ensure answered ok:false')
      conn = { port: out.port, token: out.token, machine: out.machine ?? '', version: typeof out.version === 'string' ? out.version : '' }
    } catch (err) {
      if (epoch !== this.epoch) return false
      this.conn = undefined
      this.error = String((err as Error)?.message ?? err)
      this.state = 'no-daemon'
      this.log(`quorum: quorumd unavailable: ${this.error}`)
      return false
    }
    if (epoch !== this.epoch) return false
    this.conn = conn
    this.machine = conn.machine
    const sent = { ...this.info, machine: conn.machine }
    const rev = this.infoRev
    const status = await this.post('/v1/sessions/register', sent)
    if (epoch !== this.epoch) return false
    if (status !== 204) {
      this.error = `register returned ${status}`
      this.state = 'reconnecting'
      this.log(`quorum: ${this.error}`)
      return false
    }
    if (this.info.id === sent.id) this.info.previousId = ''
    this.error = ''
    this.lastLog = ''
    this.state = 'connected'
    if (this.infoRev !== rev) void this.pushRegister()
    if (this.commands) void this.postCommands()
    this.daemonVersion = conn.version
    this.versionWarning = this.daemonVersion && this.daemonVersion !== Version
      ? `quorumd ${this.daemonVersion} does not match the mod version (${Version}): restart quorumd or update`
      : ''
    if (this.versionWarning) this.log(`quorum: ${this.versionWarning}`)
    return true
  }

  private async loop(epoch: number, connected: boolean): Promise<void> {
    let idx = 0
    while (epoch === this.epoch && !this.stopped) {
      if (connected) {
        const t0 = this.now()
        await this.attach(epoch)
        if (epoch !== this.epoch) return
        if (this.now() - t0 > HEALTHY_MS) idx = 0
        this.state = 'reconnecting'
      }
      if (!(await this.nap(BACKOFF_MS[idx] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!))) return
      idx = Math.min(idx + 1, BACKOFF_MS.length - 1)
      if (epoch !== this.epoch) return
      try {
        connected = await this.connect(epoch)
      } catch (err) {
        this.log(`quorum: error reconnecting: ${String((err as Error)?.message ?? err)}`)
        connected = false
      }
    }
  }

  private async attach(epoch: number): Promise<void> {
    let buf = ''
    const it = this.io.spawn(['quorumd', 'attach', '--session', this.info.id])[Symbol.asyncIterator]()
    const gone = this.changed.promise.then(() => ({ done: true as const, value: undefined }))
    try {
      for (;;) {
        const r = await Promise.race([it.next(), gone])
        if (r.done || epoch !== this.epoch) return
        const chunk = r.value
        if (chunk.stream !== 'stdout' || typeof chunk.text !== 'string') continue
        buf += chunk.text
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          this.dispatch(line)
        }
      }
    } catch {
      // the child failed to start or died: the loop retries
    } finally {
      // release the child if it was still alive (epoch change)
      void Promise.resolve(it.return?.(undefined)).catch(() => {})
    }
  }

  private dispatch(line: string): void {
    if (!line) return
    let msg: Command
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (!msg || msg.type === 'ping') return
    for (const h of this.handlers) {
      try {
        h(msg)
      } catch {
        // a broken handler does not bring down the flow
      }
    }
  }

  private async flushLoop(gen: number): Promise<void> {
    while (!this.stopped && gen === this.flushGen) {
      if (!(await this.nap(FLUSH_MS))) break
      if (this.stopped || gen !== this.flushGen) break
      try {
        await this.flush()
      } catch (err) {
        this.log(`quorum: error flushing the queue: ${String((err as Error)?.message ?? err)}`)
      }
    }
  }

  /** Chains the flush after the one in progress (e.g. from the loop before a stop/start). */
  private flush(): Promise<void> {
    const run = this.inFlight.then(() => this.flushNow())
    this.inFlight = run.catch(() => {})
    return run
  }

  private async flushNow(): Promise<void> {
    if (!this.queue.length || !this.conn || !this.info) return
    const id = this.info.id
    const batch = this.queue.map(e => ({ ...e, session: id }))
    this.queue = []
    await this.post(`/v1/sessions/${id}/events`, batch)
  }

  /** POST with a 2 s timeout; never throws. Returns the status or 0. */
  private async post(path: string, body: unknown): Promise<number> {
    if (!this.conn) return 0
    const url = `http://127.0.0.1:${this.conn.port}${path}`
    try {
      const res = await Promise.race([
        this.io.fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.conn.token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        this.io.sleep(POST_TIMEOUT_MS).then(() => ({ status: 0 })),
      ])
      return res.status
    } catch {
      return 0
    }
  }
}
