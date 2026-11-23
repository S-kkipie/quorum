import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Minus, Plus, RotateCw, X } from 'lucide-react'
import Markdown from '../components/Markdown'
import { folderOf } from '../components/timeline/ArtifactCard'
import { createView, hubUrl } from '../lib/api'

const SANDBOX = 'allow-scripts allow-popups allow-forms allow-modals'
const ZOOMS = [25, 50, 75, 100, 150, 200, 300, 400]

type Kind = 'frame' | 'md' | 'image' | 'pdf'
function kindOf(name: string): Kind {
  if (/\.(html?|svg)$/i.test(name)) return 'frame'
  if (/\.md$/i.test(name)) return 'md'
  if (/\.pdf$/i.test(name)) return 'pdf'
  return 'image'
}

const btn = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 disabled:opacity-40'

/** Full-screen viewer of a file of a session, served by the hub through a short-lived /v/ link. */
export default function Viewer({ machine, sessionId, path, base = '', onBack }: {
  machine: string
  sessionId: string
  path: string
  /** session base, only used to show the folder relative to it */
  base?: string
  onBack: () => void
}) {
  const name = path.split(/[\\/]/).pop() || path
  const kind = kindOf(name)
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [zoom, setZoom] = useState(100)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    setSrc(''); setError(''); setText('')
    ;(async () => {
      try {
        const { url } = await createView(machine, sessionId, path)
        const full = hubUrl() + url
        if (kind === 'md') {
          const r = await fetch(full)
          if (!r.ok) throw new Error((await r.text()).trim() || `error ${r.status}`)
          const t = await r.text()
          if (live) setText(t)
        }
        if (live) setSrc(full)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'error')
      }
    })()
    return () => { live = false }
  }, [machine, sessionId, path, kind, nonce])

  const openTab = useCallback(() => { if (src) window.open(src, '_blank', 'noopener') }, [src])
  const where = [machine, folderOf(path, base || path.replace(/[\\/]+[^\\/]*$/, ''))].filter(Boolean).join(' · ')
  const step = (d: 1 | -1) => setZoom((z) => {
    const i = ZOOMS.indexOf(z)
    return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + d))]
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-11 items-center gap-1 border-b border-zinc-800 bg-zinc-950 px-1.5 py-1">
        <button onClick={onBack} aria-label="Close" title="Close" className={btn}><X size={20} aria-hidden /></button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{name}</div>
          <div className="truncate text-xs text-zinc-500">{where}</div>
        </div>
        {kind === 'image' && src && (
          <>
            <button onClick={() => step(-1)} aria-label="Zoom out" title="Zoom out" className={btn}><Minus size={18} aria-hidden /></button>
            <span className="w-10 text-center text-xs text-zinc-500">{zoom}%</span>
            <button onClick={() => step(1)} aria-label="Zoom in" title="Zoom in" className={btn}><Plus size={18} aria-hidden /></button>
          </>
        )}
        <button onClick={() => setNonce((n) => n + 1)} aria-label="Reload" title="Reload" className={btn}><RotateCw size={18} aria-hidden /></button>
        <button onClick={openTab} disabled={!src} aria-label="Open in new tab" title="Open in new tab" className={btn}><ExternalLink size={18} aria-hidden /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="flex flex-col items-start gap-3 p-4">
            <p role="alert" className="text-sm text-red-400">{error}</p>
            <button onClick={onBack} className="min-h-11 rounded-lg bg-zinc-800 px-4 text-sm text-zinc-200 hover:bg-zinc-700">Back</button>
          </div>
        ) : !src ? (
          <p className="p-4 text-sm text-zinc-500">Loading…</p>
        ) : kind === 'frame' ? (
          <iframe key={nonce} title={name} src={src} sandbox={SANDBOX} className="h-full w-full border-0 bg-white" />
        ) : kind === 'pdf' ? (
          // the browser's PDF viewer does not work inside a sandbox; a PDF does not run app code
          <iframe key={nonce} title={name} src={src} className="h-full w-full border-0" />
        ) : kind === 'md' ? (
          <div className="mx-auto max-w-3xl p-4"><Markdown text={text} /></div>
        ) : (
          <img key={nonce} src={src} alt={name} style={{ width: `${zoom}%` }} className="block max-w-none" />
        )}
      </div>
    </div>
  )
}
