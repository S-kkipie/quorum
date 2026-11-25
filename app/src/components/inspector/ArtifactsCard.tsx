import { FileText } from 'lucide-react'
import InspectorCard from './InspectorCard'
import type { ArtifactLink } from '../../lib/artifacts'

/** Local artifacts the session linked; a click opens one. Hidden when empty. */
export default function ArtifactsCard({ links, partial, onOpen }: { links: ArtifactLink[]; partial?: boolean; onOpen?: (l: ArtifactLink) => void }) {
  if (links.length === 0) return null
  return (
    <InspectorCard title="Artifacts" note={partial ? 'From loaded history' : undefined}>
      <ul className="flex flex-col px-1.5 pb-1.5">
        {links.map((l) => (
          <li key={l.url}>
            <button type="button" title={l.title} onClick={() => onOpen?.(l)}
              className="press flex min-h-11 w-full items-center gap-2 rounded-lg px-1.5 text-left text-sm hover:bg-chip">
              <FileText size={14} aria-hidden className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-ink">{l.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </InspectorCard>
  )
}
