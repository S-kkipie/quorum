import { useEffect, useMemo, useRef } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import ArtifactsCard from './ArtifactsCard'
import BackgroundCard from './BackgroundCard'
import ChangedFilesCard from './ChangedFilesCard'
import UsageCard from './UsageCard'
import { hubUrl } from '../../lib/api'
import { artifactLinksOf, type ArtifactLink } from '../../lib/artifacts'
import { changedFilesOf } from '../../lib/changedFiles'
import { buildTimeline } from '../../lib/timeline'
import { hasBackground } from '../BackgroundSheet'
import { shortcutBlocked } from '../../lib/shortcuts'
import type { InspectorMode } from '../../lib/useLayout'
import type { AccountUsage, Event, SessionInfo } from '../../proto.gen'

export const INSPECTOR_WIDTH = 280

/**
 * The session inspector: Background, Usage, Changed files and Artifacts, empty cards hidden. Docked it is a
 * 280 px column; as an overlay it covers the right of the transcript (Esc or a click outside closes it);
 * on a phone it is a bottom sheet. `ignore` is the toggle button, whose click must not count as outside.
 */
export default function Inspector({ placement, open, onClose, session, usage, events, hasMore, onJump, onOpenArtifact, ignore }: {
  placement: InspectorMode
  open: boolean
  onClose: () => void
  session: SessionInfo
  usage?: AccountUsage
  events: Event[]
  hasMore?: boolean
  onJump?: (eventKey: string) => void
  onOpenArtifact?: (l: ArtifactLink) => void
  ignore?: React.RefObject<HTMLElement | null>
}) {
  // one timeline pass for both cards, and only while the inspector is shown
  const { files, links } = useMemo(() => {
    if (!open) return { files: [], links: [] }
    const items = buildTimeline(events, '')
    return { files: changedFilesOf(items), links: artifactLinksOf(items, hubUrl()) }
  }, [events, open])
  // a jump closes an overlay or sheet so the row is visible; a docked inspector stays
  const jump = (key: string) => { onJump?.(key); if (placement !== 'docked') onClose() }
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
      <ChangedFilesCard files={files} partial={hasMore} onJump={jump} />
      <ArtifactsCard links={links} partial={hasMore} onOpen={onOpenArtifact} />
      {!hasBackground(session.background) && !session.account && !session.accountKey && files.length === 0 && links.length === 0 && (
        <p className="px-1 py-4 text-center text-sm text-muted-foreground">Nothing to show yet.</p>
      )}
    </div>
  )

  if (placement === 'sheet') {
    return (
      <Sheet open={open} onOpenChange={(o) => { if (!o) onClose() }}>
        <SheetContent side="bottom" className="max-h-[85dvh] gap-0 overflow-y-auto rounded-t-2xl border-line bg-background pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div aria-hidden className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-line" />
          <SheetHeader className="px-4 pt-2 pb-0">
            <SheetTitle className="text-sm text-ink">Inspector</SheetTitle>
            <SheetDescription className="sr-only">Background work, usage, changed files and artifacts of this session.</SheetDescription>
          </SheetHeader>
          {cards}
        </SheetContent>
      </Sheet>
    )
  }
  if (!open) return null
  const docked = placement === 'docked'
  return (
    <aside ref={root} aria-label="Inspector" style={{ width: INSPECTOR_WIDTH }}
      className={`${docked ? 'shrink-0 border-l' : 'absolute inset-y-0 right-0 z-30 border-l shadow-lg'} min-h-0 overflow-y-auto border-line bg-background`}>
      {cards}
    </aside>
  )
}
