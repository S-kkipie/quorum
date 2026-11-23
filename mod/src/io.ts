import type { EngineInterface } from 'claude-code'
import type { LinkIO } from './link'

/** Adapta `$` (la API de mods) al LinkIO mínimo que usa Link. */
export function makeIO($: EngineInterface): LinkIO {
  return {
    run: async argv => {
      const r = await $.process.run(argv, { timeoutMs: 20_000 })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    },
    fetch: async (url, init) => {
      const r = await $.http.fetch(url, init)
      return { status: r.status }
    },
    async *spawn(argv) {
      for await (const c of $.process.spawn({ argv })) {
        if ('stream' in c && 'text' in c) yield { stream: String(c.stream), text: String(c.text) }
      }
    },
    sleep: ms => $.clock.sleep(ms),
    log: msg => $.ui.log(msg, { to: 'debug' }),
  }
}
