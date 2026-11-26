import { useEffect, useMemo, useRef } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import ArtifactsCard from './ArtifactsCard'
import BackgroundCard from './BackgroundCard'
import UsageCard from './UsageCard'
import { hubUrl } from '../../lib/api'
import { artifactLinksOf, isHtmlArtifact, type ArtifactLink } from '../../lib/artifacts'
import { buildTimeline } from '../../lib/timeline'
import { hasBackground } from '../BackgroundSheet'
import { shortcutBlocked } from '../../lib/shortcuts'
import type { InspectorMode } from '../../lib/useLayout'
import type { AccountUsage, Event, SessionInfo } from '../../proto.gen'
import { ScrollArea } from '@/components/ui/scroll-area'

export const INSPECTOR_WIDTH = 280

/**
 * The session inspector: Usage, Background and HTML artifacts, empty cards hidden. Docked it is a
 * 280 px column; as an overlay it covers the right of the transcript (Esc or a click outside closes it);
 * on a phone it is a bottom sheet. `ignore` is the toggle button, whose click must not count as outside.
 */
export default function Inspector({ placement, open, onClose, session, usage, events, hasMore, onOpenArtifact, ignore }: {
  placement: InspectorMode
  open: boolean
  onClose: () => void
  session: SessionInfo
  usage?: AccountUsage
  events: Event[]
  hasMore?: boolean
  onOpenArtifact?: (l: ArtifactLink) => void
  ignore?: React.RefObject<HTMLElement | null>
}) {
  // one timeline pass, and only while the inspector is shown; only HTML pages count as artifacts
  const links = useMemo(() => {
    if (!open) return []
    return artifactLinksOf(buildTimeline(events, ''), hubUrl()).filter(isHtmlArtifact)
  }, [events, open])
  const root = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const overlay = placement === 'overlay' && open
  useEffect(() => {
    if (!overlay) return
    // a modal dialog opened over it (a confirm, a sheet) takes its own Esc
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !shortcutBlocked(e)) close.current() }
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (!root.current?.contains(t) && !ignore?.current?.contains(t)) close.current()
    }
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', down)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', down) }
  }, [overlay, ignore])

  const cards = (
    <div className="flex flex-col gap-2.5 p-3">
      <UsageCard session={session} usage={usage} />
      <BackgroundCard background={session.background} />
      <ArtifactsCard links={links} partial={hasMore} onOpen={onOpenArtifact} />
      {!hasBackground(session.background) && !session.account && !session.accountKey && links.length === 0 && (
        <p className="px-1 py-4 text-center text-sm text-muted-foreground">Nothing to show yet.</p>
      )}
    </div>
  )

  if (placement === 'sheet') {
    return (
      <Sheet open={open} onOpenChange={(o) => { if (!o) onClose() }}>
        <SheetContent side="bottom" className="max-h-[85dvh] gap-0 overflow-hidden rounded-t-2xl border-line bg-background">
<ScrollArea viewportClassName="max-h-[85dvh]"><div className="flex flex-col pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div aria-hidden className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-line" />
          <SheetHeader className="px-4 pt-2 pb-0">
            <SheetTitle className="text-sm text-ink">Inspector</SheetTitle>
            <SheetDescription className="sr-only">Usage, background work and HTML artifacts of this session.</SheetDescription>
          </SheetHeader>
          {cards}
        </div></ScrollArea>
</SheetContent>
      </Sheet>
    )
  }
  if (!open) return null
  const docked = placement === 'docked'
  return (
    <aside ref={root} aria-label="Inspector" style={{ width: INSPECTOR_WIDTH }}
      className={`${docked ? 'shrink-0 border-l' : 'absolute inset-y-0 right-0 z-30 border-l shadow-lg'} flex min-h-0 flex-col border-line bg-background`}>
      <ScrollArea className="min-h-0 flex-1">{cards}</ScrollArea>
    </aside>
  )
}
