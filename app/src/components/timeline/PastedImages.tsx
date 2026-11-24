import { useEffect, useState } from 'react'
import { createView, hubUrl } from '../../lib/api'
import type { PastedImage } from '../../lib/timeline'

// A view link lives 6 h on the hub; one is reused for 5 h, then asked again.
const LINK_TTL_MS = 5 * 60 * 60 * 1000
const links = new Map<string, { at: number; url: Promise<string> }>()

/** Test hook: forgets the cached view links. */
export function resetPastedImageLinks() {
  links.clear()
}

/** The view link of a pasted image, one request per session and path (cached; a failure is forgotten). */
function linkFor(machine: string, sessionId: string, path: string): Promise<string> {
  const key = `${machine}\u0000${sessionId}\u0000${path}`
  const hit = links.get(key)
  if (hit && Date.now() - hit.at < LINK_TTL_MS) return hit.url
  const url = createView(machine, sessionId, path, true).then(({ url }) => {
    // only the hub's own /v/ links: anything else is never put in an img
    if (!/^\/v\/[0-9a-f]+\/[^/]+$/.test(url)) throw new Error('unexpected link')
    return hubUrl() + url
  })
  links.set(key, { at: Date.now(), url })
  url.catch(() => { if (links.get(key)?.url === url) links.delete(key) })
  return url
}

function Thumb({ machine, sessionId, image, onOpen }: { machine: string; sessionId: string; image: PastedImage; onOpen?: (path: string, o: { images: true }) => void }) {
  const label = `Image #${image.n}`
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setSrc(''); setFailed(false)
    if (!machine || !sessionId) return
    linkFor(machine, sessionId, image.path).then((u) => { if (live) setSrc(u) }, () => { if (live) setFailed(true) })
    return () => { live = false }
  }, [machine, sessionId, image.path])
  const show = src && !failed
  return (
    <button type="button" aria-label={`Open ${label}`} title={label} disabled={!onOpen}
      onClick={() => onOpen?.(image.path, { images: true })}
      className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 text-[10px] text-zinc-500 enabled:hover:border-zinc-500">
      {show
        ? <img src={src} alt={label} loading="lazy" onError={() => setFailed(true)} className="size-16 object-cover" />
        : <span>{label}</span>}
    </button>
  )
}

/** Thumbnails (64 px) of the images the owner pasted in the terminal; a tap opens the Viewer. */
export default function PastedImages({ machine, sessionId, images, onOpen }: {
  machine: string; sessionId: string; images: PastedImage[]; onOpen?: (path: string, o: { images: true }) => void
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((im) => <Thumb key={`${im.n}\u0000${im.path}`} machine={machine} sessionId={sessionId} image={im} onOpen={onOpen} />)}
    </div>
  )
}
