import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { closeTerminal, openTerminal, readTerminal, sendTerminal, watchTerminal } from '../lib/api'
import { parseAnsi, type Span } from '../lib/ansi'
import { frames } from '../lib/frames'

const KEYS: [string, string][] = [
  ['Esc', 'esc'], ['Tab', 'tab'], ['Ctrl-C', 'ctrl+c'], ['↑', 'up'], ['↓', 'down'], ['←', 'left'], ['→', 'right'], ['Ctrl-D', 'ctrl+d'], ['Ctrl-L', 'ctrl+l'],
]
const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v))
const FG = '#e4e4e7'
const BG = '#09090b'

function spanStyle(s: Span): CSSProperties {
  let fg = s.fg, bg = s.bg
  if (s.inverse) { const f = fg; fg = bg ?? BG; bg = f ?? FG }
  return {
    color: fg, backgroundColor: bg,
    fontWeight: s.bold ? 700 : undefined, fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: s.underline ? 'underline' : undefined, opacity: s.dim ? 0.6 : undefined,
  }
}

const Screen = memo(function Screen({ ansi }: { ansi: string }) {
  const lines = useMemo(() => parseAnsi(ansi), [ansi])
  return (
    <>
      {lines.map((l, i) => (
        <div key={i}>{l.length === 0 ? '​' : l.map((s, j) => <span key={j} style={spanStyle(s)}>{s.text}</span>)}</div>
      ))}
    </>
  )
})

/** Terminal en vivo de un panel: foto del daemon (solo mientras se renueva el lease), teclas y texto. */
export default function Terminal({ machine, pane, root, label, onBack, onReopen }: {
  machine: string; pane: string; root?: string; label?: string; onBack: () => void; onReopen?: (pane: string) => void
}) {
  const key = frames.key(machine, pane)
  const sub = useCallback((fn: () => void) => frames.subscribe(key, fn), [key])
  const stored = useSyncExternalStore(sub, () => frames.get(machine, pane))
  // una foto de una visita anterior no cuenta: se espera una recibida después de montar
  const mountedAt = useRef(0)
  const mountKey = useRef('')
  if (mountKey.current !== key) { mountKey.current = key; mountedAt.current = Date.now() }
  const frame = stored && frames.receivedAt(machine, pane) >= mountedAt.current ? stored : undefined
  const [lastLive, setLastLive] = useState(() => Date.now())
  const [watchErr, setWatchErr] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [history, setHistory] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [waited, setWaited] = useState(false)
  const closed = !!frame?.closed
  const [size, setSize] = useState(11)
  const [auto, setAuto] = useState(true)
  const box = useRef<HTMLDivElement>(null)

  // cada foto nueva es señal de vida
  useEffect(() => { if (frame) setLastLive(Date.now()) }, [frame])
  // el lease dura 15 s: se renueva cada 5 s mientras la pantalla esté montada y la terminal viva
  useEffect(() => {
    if (closed) return
    let off = false
    const go = () => {
      watchTerminal(machine, pane)
        .then(() => { if (!off) { setWatchErr(''); setLastLive(Date.now()) } })
        .catch((e) => { if (!off) setWatchErr(e instanceof Error ? e.message : String(e)) })
    }
    go()
    const t = setInterval(go, 5000)
    return () => { off = true; clearInterval(t) }
  }, [machine, pane, closed])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const noSignal = !closed && history === null && (!!watchErr || now - lastLive > 10_000)
  useEffect(() => {
    setWaited(false)
    const t = setTimeout(() => setWaited(true), 3000)
    return () => clearTimeout(t)
  }, [machine, pane])
  // fuente que cabe en el ancho (el celular nunca redimensiona el panel)
  const cols = frame?.cols ?? 0
  useLayoutEffect(() => {
    if (!auto || !cols || !box.current) return
    const w = box.current.clientWidth
    if (w > 0) setSize(clamp(8, 15, Math.floor(w / (cols * 0.6))))
  }, [cols, auto])

  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : String(e))
  const key1 = (k: string) => { setErr(''); sendTerminal(machine, pane, { keys: [k] }).catch(fail) }
  const submit = async () => {
    setErr('')
    const t = text
    setText('') // se vacía antes del await: un doble toque no repite el texto
    try {
      if (t) await sendTerminal(machine, pane, { text: t })
    } catch (e) {
      setText((cur) => cur || t) // no llegó: se devuelve lo escrito (si no se escribió otra cosa)
      fail(e)
      return
    }
    try { await sendTerminal(machine, pane, { keys: ['enter'] }) } catch (e) { fail(e) }
  }
  const showHistory = async () => {
    setErr('')
    try { setHistory((await readTerminal(machine, pane, 400)).ansi) } catch (e) { fail(e) }
  }
  const close = async () => {
    setMenu(false)
    if (!confirm('¿Cerrar esta terminal?')) return
    try { await closeTerminal(machine, pane); onBack() } catch (e) { fail(e) }
  }
  const reopen = async () => {
    if (!root) return
    try { const r = await openTerminal(machine, root, label ?? root, true); onReopen?.(r.pane) } catch (e) { fail(e) }
  }
  const zoom = (d: number) => { setAuto(false); setSize((s) => clamp(6, 24, s + d)) }

  const noBlur = { onPointerDown: (e: React.PointerEvent) => e.preventDefault() }
  const btn = 'shrink-0 rounded bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 active:bg-zinc-700'
  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <header className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <button onClick={onBack} aria-label="Volver" className="rounded bg-zinc-800 px-2 py-1 text-sm">←</button>
        <span className="min-w-0 flex-1 truncate text-sm">{label || 'Terminal'} <span className="text-xs text-zinc-500">{machine}</span></span>
        <button onClick={() => zoom(-1)} className={btn}>A−</button>
        <button onClick={() => zoom(1)} className={btn}>A+</button>
        <button onClick={() => (history === null ? showHistory() : setHistory(null))} className={btn}>{history === null ? 'Historial' : 'En vivo'}</button>
        {/* solo las terminales que abrió Quorum (con root) se pueden cerrar */}
        {root && <span className="relative">
          <button onClick={() => setMenu((m) => !m)} aria-label="⋯" className={btn}>⋯</button>
          {menu && (
            <div className="absolute right-0 top-full z-10 mt-1 rounded border border-zinc-700 bg-zinc-900 p-1 shadow">
              <button onClick={close} className="whitespace-nowrap rounded px-3 py-1.5 text-sm text-red-400 hover:bg-zinc-800">Cerrar terminal</button>
            </div>
          )}
        </span>}
      </header>
      <div ref={box} className="min-h-0 flex-1 overflow-auto bg-zinc-950 p-2">
        {history !== null ? (
          <pre className="m-0 font-mono text-zinc-200" style={{ fontSize: size, lineHeight: 1.25 }}><Screen ansi={history} /></pre>
        ) : closed ? (
          <div className="flex flex-col items-center gap-3 p-6 text-center">
            <p className="text-sm text-zinc-300">La terminal se cerró</p>
            {root && <button onClick={reopen} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white">Abrir otra</button>}
          </div>
        ) : frame ? (
          <pre className="m-0 w-max font-mono text-zinc-200" style={{ fontSize: size, lineHeight: 1.25 }}><Screen ansi={frame.ansi} /></pre>
        ) : waited ? (
          <p className="p-4 text-sm text-zinc-500">Conectando con la terminal…</p>
        ) : null}
      </div>
      {noSignal && <p role="status" className="shrink-0 bg-amber-950 px-3 py-1 text-xs text-amber-300">Sin señal — {watchErr || 'reintentando…'}</p>}
      {err && <p role="alert" className="shrink-0 px-3 py-1 text-xs text-red-400">{err}</p>}
      {!closed && history === null && (
        <footer className="shrink-0 border-t border-zinc-800 bg-zinc-950 pb-[env(safe-area-inset-bottom)]">
          <div className="flex gap-1.5 overflow-x-auto px-2 pt-2">
            {KEYS.map(([name, k]) => <button key={k} {...noBlur} onClick={() => key1(k)} className={btn}>{name}</button>)}
          </div>
          <form className="flex gap-2 p-2" onSubmit={(e) => { e.preventDefault(); submit() }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe…" enterKeyHint="send"
              autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
              className="min-w-0 flex-1 rounded bg-zinc-900 px-3 py-2 text-base text-zinc-100 outline-none" />
            <button type="submit" aria-label="⏎" className="shrink-0 rounded bg-blue-600 px-4 py-2 text-sm text-white">⏎</button>
          </form>
        </footer>
      )}
    </div>
  )
}
