import { File as FileIcon } from 'lucide-react'
import { keyFile, type UploadRef } from '../../lib/attachments'
import ViewThumb from './ViewThumb'

/** The files attached to a sent message: image thumbnails and file chips; a tap opens the Viewer. */
export default function UploadedFiles({ machine, sessionId, files, onOpen }: {
  machine: string; sessionId: string; files: UploadRef[]; onOpen?: (path: string, o: { upload: true }) => void
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2 first:mt-0">
      {files.map((f) => f.image ? (
        <ViewThumb key={f.path} machine={machine} sessionId={sessionId} path={f.path} mode="upload"
          label={f.name} onOpen={onOpen ? () => onOpen(f.path, { upload: true }) : undefined} />
      ) : keyFile(f.name) ? (
        // the hub never serves key and certificate files: say so instead of a chip that fails
        <span key={f.path} title="Key and certificate files are never shown in Quorum"
          className="flex min-h-11 max-w-60 items-center gap-2 rounded-lg border border-line bg-chip px-2.5 text-xs text-muted-foreground">
          <FileIcon size={14} aria-hidden className="shrink-0" />
          <span className="min-w-0">
            <span className="block truncate text-ink">{f.name}</span>
            <span className="block">Key files are not shown</span>
          </span>
        </span>
      ) : (
        <button key={f.path} type="button" aria-label={`Open ${f.name}`} title={f.name} disabled={!onOpen}
          onClick={onOpen ? () => onOpen(f.path, { upload: true }) : undefined}
          className="press flex min-h-11 max-w-60 items-center gap-2 rounded-lg border border-line bg-chip px-2.5 text-xs text-ink enabled:hover:border-muted-foreground">
          <FileIcon size={14} aria-hidden className="shrink-0 text-muted-foreground" />
          <span className="truncate">{f.name}</span>
        </button>
      ))}
    </div>
  )
}
