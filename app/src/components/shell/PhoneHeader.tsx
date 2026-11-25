import { Plus } from 'lucide-react'
import { Logo } from '../Logo'
import { Button } from '../ui/button'

/** The phone's page header: the Seats mark, the page title, the connection dot and `+` for a new session. */
export default function PhoneHeader({ title, connected, onLaunch }: { title: string; connected: boolean; onLaunch: () => void }) {
  return (
    <header className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-line bg-background/90 px-3 py-1.5 backdrop-blur">
      <Logo size={22} className="shrink-0 text-accent" />
      <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h1>
      <span role="img" aria-label={connected ? 'Connected' : 'Reconnecting'} title={connected ? 'connected' : 'reconnecting…'} className={`h-2 w-2 shrink-0 rounded-full ${connected ? 'bg-success' : 'bg-warning'}`} />
      <Button size="icon" onClick={onLaunch} aria-label="New session" title="New session" className="size-11 shrink-0"><Plus aria-hidden /></Button>
    </header>
  )
}
