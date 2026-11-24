import { ExternalLink, FileCode, FileText, Image } from 'lucide-react'
import { Artifact, ArtifactActions, ArtifactDescription, ArtifactHeader, ArtifactTitle } from '@/components/ai-elements/artifact'
import { Button } from '@/components/ui/button'
import { middleTruncate } from '../../lib/truncate'
import type { ArtifactItem } from '../../lib/timeline'

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i

/** Folder of `path` relative to `base` (the base's own name for files at its top level). */
export function folderOf(path: string, base: string): string {
  const dir = path.replace(/[\\/]+[^\\/]*$/, '')
  const b = base.replace(/[\\/]+$/, '')
  const sep = (s: string) => s.replace(/\\/g, '/')
  const win = /^[a-zA-Z]:|^\\\\/.test(b)
  const d = win ? sep(dir).toLowerCase() : sep(dir)
  const bb = win ? sep(b).toLowerCase() : sep(b)
  if (b && d === bb) return b.split(/[\\/]/).pop() || b
  if (b && d.startsWith(bb + '/')) return sep(dir).slice(bb.length + 1)
  return dir
}

export default function ArtifactCard({ item, machine = '', base = '', onOpen }: {
  item: ArtifactItem
  machine?: string
  base?: string
  onOpen?: (path: string) => void
}) {
  const Icon = IMAGE.test(item.name) ? Image : /\.html?$/i.test(item.name) ? FileCode : FileText
  const where = item.inBase ? [machine, folderOf(item.path, base)].filter(Boolean).join(' · ') : 'outside the project folder'
  return (
    <Artifact className="my-2 rounded-xl border-line bg-surface shadow-none">
      <ArtifactHeader className="gap-3 border-b-0 bg-transparent p-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <ArtifactTitle title={item.name} className="line-clamp-2 font-serif text-[15.5px] text-ink [overflow-wrap:anywhere]">{middleTruncate(item.name, 48)}</ArtifactTitle>
          <ArtifactDescription className="truncate text-xs text-muted-foreground">{where}</ArtifactDescription>
        </div>
        {item.inBase && (
          <ArtifactActions className="shrink-0">
            <Button type="button" onClick={() => onOpen?.(item.path)} className="min-h-11 rounded-lg bg-accent px-3 text-on-accent hover:bg-accent/90">
              <ExternalLink size={14} aria-hidden />Open
            </Button>
          </ArtifactActions>
        )}
      </ArtifactHeader>
    </Artifact>
  )
}
