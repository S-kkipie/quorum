import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { ExternalLink, Minus, Plus, RotateCw, X } from 'lucide-react'
import Markdown from '../components/Markdown'
import { folderOf } from '../components/timeline/ArtifactCard'
import { createView, hubUrl } from '../lib/api'
import { Button } from '@/components/ui/button'

const ViewerCode = lazy(() => import('./ViewerCode'))

const SANDBOX = 'allow-scripts allow-popups allow-forms allow-modals'
const ZOOMS = [25, 50, 75, 100, 150, 200, 300, 400]

type Kind = 'frame' | 'md' | 'image' | 'pdf' | 'code'
function kindOf(name: string): Kind {
  if (/\.(html?|svg)$/i.test(name)) return 'frame'
  if (/\.md$/i.test(name)) return 'md'
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (/\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(name)) return 'image'
  return 'code'
}

const btn = 'size-11 shrink-0 text-zinc-400 hover:text-zinc-200'

/** The code view reads at most this much of a file (it shows at most 2,000 lines anyway). */
const CODE_MAX_BYTES = 1 << 20

/** Reads a response body up to max bytes, then stops the download; cut: there was more. */
async function readCapped(r: Response, max: number): Promise<{ text: string; cut: boolean }> {
  if (!r.body) {
    const t = await r.text()
    return t.length > max ? { text: t.slice(0, max), cut: true } : { text: t, cut: false }
  }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let text = ''
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return { text: text + dec.decode(), cut: false }
    const room = max - n
    if (value.byteLength >= room) {
      text += dec.decode(value.subarray(0, room))
      void reader.cancel().catch(() => {})
      // drop the partial last line
      const nl = text.lastIndexOf('\n')
      return { text: nl > 0 ? text.slice(0, nl) : text, cut: true }
    }
    n += value.byteLength
    text += dec.decode(value, { stream: true })
  }
}

/** Full-screen viewer of a file of a session, served by the hub through a short-lived /v/ link. */
export default function Viewer({ machine, sessionId, path, base = '', images = false, read = false, onBack }: {
  machine: string
  sessionId: string
  path: string
  /** an image pasted in the terminal: the link comes from the session's images folder */
  images?: boolean
  /** an image Claude read with the Read tool: the link comes from the image's own folder */
  read?: boolean
  /** session base, only used to show the folder relative to it */
  base?: string
  onBack: () => void
}) {
  const name = path.split(/[\\/]/).pop() || path
  const kind = kindOf(name)
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [cut, setCut] = useState(false)
  const [zoom, setZoom] = useState(100)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    setSrc(''); setError(''); setText(''); setCut(false)
    ;(async () => {
      try {
        const mode = images ? 'images' : read ? 'read' : undefined
        const { url } = await (mode ? createView(machine, sessionId, path, mode) : createView(machine, sessionId, path))
        const full = hubUrl() + url
        if (kind === 'md' || kind === 'code') {
          const r = await fetch(full)
          if (!r.ok) throw new Error((await r.text()).trim() || `error ${r.status}`)
          if (kind === 'code') {
            const c = await readCapped(r, CODE_MAX_BYTES)
            if (live) { setText(c.text); setCut(c.cut) }
          } else {
            const t = await r.text()
            if (live) setText(t)
          }
        }
        if (live) setSrc(full)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'error')
      }
    })()
    return () => { live = false }
  }, [machine, sessionId, path, kind, nonce, images, read])

  const openTab = useCallback(() => { if (src) window.open(src, '_blank', 'noopener') }, [src])
  const where = [machine, folderOf(path, base || path.replace(/[\\/]+[^\\/]*$/, ''))].filter(Boolean).join(' · ')
  const step = (d: 1 | -1) => setZoom((z) => {
    const i = ZOOMS.indexOf(z)
    return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + d))]
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-11 items-center gap-1 border-b border-zinc-800 bg-zinc-950 px-1.5 py-1">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Close" title="Close" className={btn}><X size={20} aria-hidden /></Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{name}</div>
          <div className="truncate text-xs text-zinc-500">{where}</div>
        </div>
        {kind === 'image' && src && (
          <>
            <Button variant="ghost" size="icon" onClick={() => step(-1)} aria-label="Zoom out" title="Zoom out" className={btn}><Minus size={18} aria-hidden /></Button>
            <span className="w-10 text-center text-xs text-zinc-500">{zoom}%</span>
            <Button variant="ghost" size="icon" onClick={() => step(1)} aria-label="Zoom in" title="Zoom in" className={btn}><Plus size={18} aria-hidden /></Button>
          </>
        )}
        <Button variant="ghost" size="icon" onClick={() => setNonce((n) => n + 1)} aria-label="Reload" title="Reload" className={btn}><RotateCw size={18} aria-hidden /></Button>
        <Button variant="ghost" size="icon" onClick={openTab} disabled={!src} aria-label="Open in new tab" title="Open in new tab" className={btn}><ExternalLink size={18} aria-hidden /></Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="flex flex-col items-start gap-3 p-4">
            <p role="alert" className="text-sm text-red-400">{error}</p>
            <Button variant="secondary" onClick={onBack} className="min-h-11 px-4">Back</Button>
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
        ) : kind === 'code' ? (
          text.includes('\u0000')
            ? <p className="p-4 text-sm text-zinc-400">This file cannot be previewed.</p>
            : <Suspense fallback={<p className="p-4 text-sm text-zinc-500">Loading…</p>}><ViewerCode text={text} name={name} cutBytes={cut} /></Suspense>
        ) : (
          <img key={nonce} src={src} alt={name} style={{ width: `${zoom}%` }} className="block max-w-none" />
        )}
      </div>
    </div>
  )
}
