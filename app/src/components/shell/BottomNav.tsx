import { FolderKanban, Inbox, Settings, type LucideIcon } from 'lucide-react'

export type NavTab = 'sessions' | 'projects' | 'settings'
const TABS: { id: NavTab; label: string; Icon: LucideIcon }[] = [
  { id: 'sessions', label: 'Sessions', Icon: Inbox },
  { id: 'projects', label: 'Projects', Icon: FolderKanban },
  { id: 'settings', label: 'Settings', Icon: Settings },
]

/** The phone's bottom navigation (44 px targets, on the safe area). The app hides it inside a session and the Viewer. */
export default function BottomNav({ active, attention = 0, onNav }: { active: NavTab; /** Sessions that need you or are done and unread. */ attention?: number; onNav: (t: NavTab) => void }) {
  return (
    <nav aria-label="Main" className="flex shrink-0 border-t border-line bg-background pb-[env(safe-area-inset-bottom,0px)]">
      {TABS.map(({ id, label, Icon }) => (
        <button key={id} type="button" aria-label={id === 'sessions' && attention > 0 ? `Sessions, ${attention} need attention` : undefined} aria-current={active === id ? 'page' : undefined} onClick={() => onNav(id)}
          className={`relative flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-xs ${active === id ? 'text-accent' : 'text-muted-foreground hover:text-ink'}`}>
          <Icon size={20} aria-hidden />
          <span className="max-w-full truncate">{label}</span>
          {id === 'sessions' && attention > 0 && <span aria-hidden className="absolute right-[calc(50%-1.75rem)] top-1.5 rounded-full bg-state-done-soft px-1.5 text-xs text-state-done">{attention}</span>}
        </button>
      ))}
    </nav>
  )
}
