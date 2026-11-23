import { ExternalLink, FileCode, FileText, Image } from 'lucide-react'
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
    <div className="my-2 flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-300">
        <Icon size={20} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-100">{item.name}</div>
        <div className="truncate text-xs text-zinc-500">{where}</div>
      </div>
      {item.inBase && (
        <button type="button" onClick={() => onOpen?.(item.path)}
          className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-500">
          <ExternalLink size={14} aria-hidden />Open
        </button>
      )}
    </div>
  )
}
