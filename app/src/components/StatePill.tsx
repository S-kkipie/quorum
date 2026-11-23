const PILLS: Record<string, { label: string; cls: string; dot?: string }> = {
  working: { label: 'Working', cls: 'bg-blue-500/15 text-blue-300 ring-blue-500/30', dot: 'bg-blue-400 animate-pulse' },
  needs_you: { label: 'Needs permission', cls: 'bg-amber-500/15 text-amber-300 ring-amber-500/30', dot: 'bg-amber-400' },
  waiting: { label: 'Waiting for you', cls: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30' },
  idle: { label: 'Waiting for you', cls: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30' },
  closed: { label: 'Closed', cls: 'bg-zinc-800/60 text-zinc-500 ring-zinc-700/40' },
}

/** Session state as a small rounded pill. */
export default function StatePill({ state }: { state: string }) {
  const p = PILLS[state] ?? PILLS.idle
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${p.cls}`}>
      {p.dot && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${p.dot}`} />}
      {p.label}
    </span>
  )
}
