import InspectorCard from './InspectorCard'
import { basename } from '../../lib/timeline'
import type { ChangedFile } from '../../lib/changedFiles'

/** Files the session changed, with +/- per file; a click scrolls to the tool row. Hidden when empty. */
export default function ChangedFilesCard({ files, partial, onJump }: { files: ChangedFile[]; partial?: boolean; onJump?: (eventKey: string) => void }) {
  if (files.length === 0) return null
  return (
    <InspectorCard title="Changed files" note={partial ? 'From loaded history' : undefined}>
      <ul className="flex flex-col px-1.5 pb-1.5">
        {files.map((f) => (
          <li key={f.path}>
            <button type="button" title={f.path} onClick={() => onJump?.(f.eventKey)}
              className="press flex min-h-11 w-full items-center gap-2 rounded-lg px-1.5 text-left text-sm hover:bg-chip">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{basename(f.path)}</span>
              <span className="shrink-0 text-xs"><span className="text-add">+{f.add}</span>{' '}<span className="text-del">{'−'}{f.del}</span></span>
            </button>
          </li>
        ))}
      </ul>
    </InspectorCard>
  )
}
