import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { closeTerminal, openTerminal, readTerminal, sendTerminal, watchTerminal } from '../lib/api'
import { parseAnsi, type Span } from '../lib/ansi'
import { frames } from '../lib/frames'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'

const KEYS: [string, string][] = [
  ['Esc', 'esc'], ['Tab', 'tab'], ['Ctrl-C', 'ctrl+c'], ['↑', 'up'], ['↓', 'down'], ['←', 'left'], ['→', 'right'], ['Ctrl-D', 'ctrl+d'], ['Ctrl-L', 'ctrl+l'],
]
const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v))
// the terminal screen is dark in both themes: its box carries .dark, so tokens inside resolve to the
// current palette's dark values, a custom accent included (index.css); inverse video falls back to them
const FG = 'var(--ink)'
const BG = 'var(--background)'

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

/** Live terminal of a pane: daemon snapshot (only while the lease is renewed), keys and text. */
export default function Terminal({ machine, pane, root, label, onBack, onReopen }: {
  machine: string; pane: string; root?: string; label?: string; onBack: () => void; onReopen?: (pane: string) => void
}) {
  const key = frames.key(machine, pane)
  const sub = useCallback((fn: () => void) => frames.subscribe(key, fn), [key])
  const stored = useSyncExternalStore(sub, () => frames.get(machine, pane))
  // a snapshot from a previous visit does not count: one received after mounting is awaited
  const mountedAt = useRef(0)
  const mountKey = useRef('')
  if (mountKey.current !== key) { mountKey.current = key; mountedAt.current = Date.now() }
  const frame = stored && frames.receivedAt(machine, pane) >= mountedAt.current ? stored : undefined
  const [lastLive, setLastLive] = useState(() => Date.now())
  const [watchErr, setWatchErr] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [history, setHistory] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [waited, setWaited] = useState(false)
  const closed = !!frame?.closed
  const [size, setSize] = useState(11)
  const [auto, setAuto] = useState(true)
  const box = useRef<HTMLDivElement>(null)

  // every new snapshot is a sign of life
  useEffect(() => { if (frame) setLastLive(Date.now()) }, [frame])
  // the lease lasts 15 s: it is renewed every 5 s while the screen is mounted and the terminal alive
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
  // font that fits the width (the phone never resizes the pane)
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
    setText('') // cleared before the await: a double tap does not repeat the text
    try {
      if (t) await sendTerminal(machine, pane, { text: t })
    } catch (e) {
      setText((cur) => cur || t) // did not arrive: the typed text is restored (unless something else was typed)
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
    if (!confirm('Close this terminal?')) return
    try { await closeTerminal(machine, pane); onBack() } catch (e) { fail(e) }
  }
  const reopen = async () => {
    if (!root) return
    try { const r = await openTerminal(machine, root, label ?? root, true); onReopen?.(r.pane) } catch (e) { fail(e) }
  }
  const zoom = (d: number) => { setAuto(false); setSize((s) => clamp(6, 24, s + d)) }

  const noBlur = { onPointerDown: (e: React.PointerEvent) => e.preventDefault() }
  const btn = 'min-h-11 shrink-0 px-2.5 text-xs'
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Button variant="secondary" onClick={onBack} aria-label="Back" className="min-h-11 px-2">←</Button>
        <span className="min-w-0 flex-1 truncate text-sm">{label || 'Terminal'} <span className="text-xs text-muted-foreground">{machine}</span></span>
        <Button variant="secondary" onClick={() => zoom(-1)} className={btn}>A−</Button>
        <Button variant="secondary" onClick={() => zoom(1)} className={btn}>A+</Button>
        <Button variant="secondary" onClick={() => (history === null ? showHistory() : setHistory(null))} className={btn}>{history === null ? 'History' : 'Live'}</Button>
        {/* only terminals opened by Quorum (with root) can be closed */}
        {root && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" aria-label="⋯" className={btn}>⋯</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" className="min-h-11" onSelect={close}>Close terminal</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      <div ref={box} className="min-h-0 flex-1 dark overflow-auto bg-background p-2 text-ink">
        {history !== null ? (
          <pre className="m-0 font-mono text-ink" style={{ fontSize: size, lineHeight: 1.25 }}><Screen ansi={history} /></pre>
        ) : closed ? (
          <div className="flex flex-col items-center gap-3 p-6 text-center">
            <p className="text-sm text-ink">Terminal closed</p>
            {root && <Button className="min-h-11" onClick={reopen}>Open another</Button>}
          </div>
        ) : frame ? (
          <pre className="m-0 w-max font-mono text-ink" style={{ fontSize: size, lineHeight: 1.25 }}><Screen ansi={frame.ansi} /></pre>
        ) : waited ? (
          <p className="p-4 text-sm text-muted-foreground">Connecting to the terminal…</p>
        ) : null}
      </div>
      {noSignal && <p role="status" className="shrink-0 bg-state-needs-soft px-3 py-1 text-xs text-state-needs">No signal: {watchErr || 'retrying…'}</p>}
      {err && <p role="alert" className="shrink-0 px-3 py-1 text-xs text-danger">{err}</p>}
      {!closed && history === null && (
        <footer className="shrink-0 border-t border-line bg-background pb-[env(safe-area-inset-bottom)]">
          <div className="flex gap-1.5 overflow-x-auto px-2 pt-2">
            {KEYS.map(([name, k]) => <Button key={k} variant="secondary" {...noBlur} onClick={() => key1(k)} className={btn}>{name}</Button>)}
          </div>
          <form className="flex gap-2 p-2" onSubmit={(e) => { e.preventDefault(); submit() }}>
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type…" enterKeyHint="send"
              autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
              className="min-h-11 min-w-0 flex-1 border-0 bg-surface px-3 py-2 text-base text-ink" />
            <Button type="submit" aria-label="⏎" className="min-h-11 shrink-0 px-4">⏎</Button>
          </form>
        </footer>
      )}
    </div>
  )
}
