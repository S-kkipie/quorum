import type { Command, Event, SessionInfo } from './proto.gen'
import { Version } from './proto.gen'

export type LinkIO = {
  run(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr?: string }>
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number }>
  spawn(argv: string[]): AsyncIterable<{ stream: string; text: string }>
  sleep(ms: number): Promise<void>
  /** Reloj en ms (opcional; por defecto Date.now). */
  now?: () => number
  /** Diagnóstico opcional (se llama solo cuando el mensaje cambia). */
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
  /** Versión del daemon que respondió a ensure ("" si no la informó). */
  daemonVersion = ''
  /** Aviso si la versión del daemon difiere de la del mod ("" si coinciden o se ignora). */
  versionWarning = ''
  role = 'work'
  private info!: SessionInfo
  private conn?: Conn
  private queue: Event[] = []
  private handlers: Array<(c: Command) => void> = []
  private epoch = 0
  private changed = deferred()
  private stopped = false
  /** Época del bucle de vaciado: start lanza uno nuevo y el anterior termina solo. */
  private flushGen = 0
  /** Vaciado en curso: nunca hay dos POST de eventos a la vez (se reordenarían). */
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

  /** La sesión sigue en el mismo proceso con otro id (/clear, /resume). */
  adoptId(newId: string): void {
    if (!this.info || newId === this.info.id) return
    this.info = { ...this.info, previousId: this.info.id, id: newId }
    const epoch = this.bump()
    void (async () => {
      const ok = await this.connect(epoch)
      void this.loop(epoch, ok)
    })()
  }

  /** Mezcla campos en la info de la sesión y la re-registra (sin esperar; se omite sin conexión). */
  update(patch: Partial<SessionInfo>): void {
    if (!this.info) return
    this.info = { ...this.info, ...patch, updatedAt: this.now() }
    if (!this.conn || this.state !== 'connected') return // el próximo connect registra la info vigente
    void this.pushRegister()
  }

  private regBusy = false
  private regDirty = false
  /** Un solo register en vuelo; si llegan más cambios, tras terminar se envía solo el último. */
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

  /** Nueva época: los bucles y el attach anteriores terminan. */
  private bump(): number {
    this.epoch++
    this.changed.resolve()
    this.changed = deferred()
    return this.epoch
  }

  /** sleep que devuelve false si el entorno se descargó (sleep abortado). */
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

  /** ensure + register. Falso si el daemon no está disponible. */
  private async connect(epoch: number): Promise<boolean> {
    let conn: Conn
    try {
      const r = await this.io.run(['quorumd', 'ensure', '--json'])
      if (r.exitCode !== 0) {
        let detail = (r.stderr ?? '').trim()
        if (!detail) {
          try { detail = String(JSON.parse(r.stdout)?.error ?? '') } catch { /* stdout no es JSON */ }
        }
        throw new Error(`ensure terminó con código ${r.exitCode}${detail ? `: ${detail}` : ''}`)
      }
      const out = JSON.parse(r.stdout)
      if (!out.ok) throw new Error(out.error || 'ensure respondió ok:false')
      conn = { port: out.port, token: out.token, machine: out.machine ?? '', version: typeof out.version === 'string' ? out.version : '' }
    } catch (err) {
      if (epoch !== this.epoch) return false
      this.conn = undefined
      this.error = String((err as Error)?.message ?? err)
      this.state = 'no-daemon'
      this.log(`quorum: quorumd no disponible: ${this.error}`)
      return false
    }
    if (epoch !== this.epoch) return false
    this.conn = conn
    this.machine = conn.machine
    const sent = { ...this.info, machine: conn.machine }
    const status = await this.post('/v1/sessions/register', sent)
    if (epoch !== this.epoch) return false
    if (status !== 204) {
      this.error = `register devolvió ${status}`
      this.state = 'reconnecting'
      this.log(`quorum: ${this.error}`)
      return false
    }
    if (this.info.id === sent.id) this.info.previousId = ''
    this.error = ''
    this.lastLog = ''
    this.state = 'connected'
    this.daemonVersion = conn.version
    this.versionWarning = this.daemonVersion && this.daemonVersion !== Version
      ? `quorumd ${this.daemonVersion} no coincide con la versión del mod (${Version}): reinicia quorumd o actualiza`
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
        this.log(`quorum: error al reconectar: ${String((err as Error)?.message ?? err)}`)
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
      // el hijo no arrancó o murió: el bucle reintenta
    } finally {
      // suelta el hijo si seguía vivo (cambio de época)
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
        // un manejador roto no tumba el flujo
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
        this.log(`quorum: error al vaciar la cola: ${String((err as Error)?.message ?? err)}`)
      }
    }
  }

  /** Encadena el vaciado tras el que esté en curso (p. ej. del bucle anterior a un stop/start). */
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

  /** POST con timeout de 2 s; nunca lanza. Devuelve el status o 0. */
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
