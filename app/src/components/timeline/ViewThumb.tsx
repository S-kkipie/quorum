import { useEffect, useState } from 'react'
import { createView, hubUrl, type ViewMode } from '../../lib/api'

// A view link lives 6 h on the hub; one is reused for 5 h, then asked again.
const LINK_TTL_MS = 5 * 60 * 60 * 1000
const links = new Map<string, { at: number; url: Promise<string> }>()

/** Test hook: forgets the cached view links. */
export function resetViewLinks() {
  links.clear()
}

/** The single-file view link of an image, one request per mode, session and path (cached; a failure is forgotten). */
function linkFor(machine: string, sessionId: string, path: string, mode: ViewMode): Promise<string> {
  const key = `${mode}\u0000${machine}\u0000${sessionId}\u0000${path}`
  const hit = links.get(key)
  if (hit && Date.now() - hit.at < LINK_TTL_MS) return hit.url
  const url = createView(machine, sessionId, path, mode).then(({ url }) => {
    // only the hub's own /v/ links: anything else is never put in an img
    if (!/^\/v\/[0-9a-f]+\/[^/]+$/.test(url)) throw new Error('unexpected link')
    return hubUrl() + url
  })
  links.set(key, { at: Date.now(), url })
  url.catch(() => { if (links.get(key)?.url === url) links.delete(key) })
  return url
}

/** A 64 px thumbnail of an image on the session's machine, loaded through a single-file view link; the label is the placeholder. */
export default function ViewThumb({ machine, sessionId, path, mode, label, onOpen }: {
  machine: string; sessionId: string; path: string; mode: ViewMode; label: string; onOpen?: () => void
}) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setSrc(''); setFailed(false)
    if (!machine || !sessionId) return
    linkFor(machine, sessionId, path, mode).then((u) => { if (live) setSrc(u) }, () => { if (live) setFailed(true) })
    return () => { live = false }
  }, [machine, sessionId, path, mode])
  const show = src && !failed
  return (
    <button type="button" aria-label={`Open ${label}`} title={label} disabled={!onOpen}
      onClick={onOpen}
      className="press flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-chip text-xs text-muted-foreground enabled:hover:border-muted-foreground">
      {show
        ? <img src={src} alt={label} loading="lazy" onError={() => setFailed(true)} className="size-16 object-cover" />
        : <span className="line-clamp-3 break-all px-1 text-center">{label}</span>}
    </button>
  )
}
