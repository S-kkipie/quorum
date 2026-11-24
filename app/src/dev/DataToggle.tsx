import type { DataMode } from './fixtures'

const OPTIONS: { mode: DataMode; label: string }[] = [
  { mode: 'demo', label: 'Demo data' },
  { mode: 'worst', label: 'Worst case' },
  { mode: 'empty', label: 'Empty' },
  { mode: 'one', label: 'One' },
  { mode: 'huge', label: '1,000 rows' },
]

/** Dev-only segmented control: `onChange` is expected to write ?data= and reload. */
export default function DataToggle({ mode, onChange }: { mode: DataMode; onChange: (m: DataMode) => void }) {
  return (
    <div role="radiogroup" aria-label="Data mode" className="fixed bottom-2 left-1/2 z-50 flex max-w-[calc(100vw-1rem)] -translate-x-1/2 overflow-x-auto rounded-lg border border-zinc-700 bg-zinc-900/95 p-0.5 shadow-lg">
      {OPTIONS.map((o) => (
        <button key={o.mode} type="button" role="radio" aria-checked={mode === o.mode} onClick={() => onChange(o.mode)}
          className={`min-h-11 shrink-0 whitespace-nowrap rounded-md px-2.5 text-xs ${mode === o.mode ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
