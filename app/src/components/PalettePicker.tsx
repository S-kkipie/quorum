import { Button } from '@/components/ui/button'
import { PALETTES, PALETTE_IDS, deriveAccent, usePalette, type PaletteId } from '../lib/palettes'
import { useRoving } from '../lib/roving'
import type { ThemeName } from '../lib/tokens'

/** Swatches for a palette tile: light background, surface, ink and accent, then dark background, surface and accent. */
function Swatches({ id }: { id: PaletteId }) {
  const { light: l, dark: d } = PALETTES[id]
  const dot = (c: string, k: string) => <span key={k} data-swatch className="size-3 rounded-full border border-line" style={{ background: c }} />
  return (
    <span aria-hidden className="flex items-center gap-2">
      <span className="flex gap-1">{[l.background, l.surface, l.ink, l.accent].map((c, i) => dot(c, `l${i}`))}</span>
      <span className="flex gap-1">{[d.background, d.surface, d.accent].map((c, i) => dot(c, `d${i}`))}</span>
    </span>
  )
}

/**
 * Palette choice for this device: one tile per preset (a radio group with a roving tabindex) and a
 * custom accent. Picking a tile applies that preset and drops a custom accent; the custom accent sits
 * on top of the current preset and is nudged for contrast when it needs it (the note says so).
 */
export default function PalettePicker({ theme }: { theme: ThemeName }) {
  const [palette, setPalette] = usePalette()
  const { ref, onKey } = useRoving(PALETTE_IDS, (id) => setPalette({ id }))
  const base = PALETTES[palette.id][theme]
  const shown = palette.accent ? deriveAccent(palette.accent, theme, base).accent : null
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Palette" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {PALETTE_IDS.map((id, i) => {
          const p = PALETTES[id]
          const on = palette.id === id
          return (
            <button key={id} ref={ref(i)} type="button" role="radio" aria-checked={on} aria-label={p.name} title={p.description}
              tabIndex={on ? 0 : -1} onKeyDown={(e) => onKey(e, i)} onClick={() => setPalette({ id })}
              className={`press flex min-h-11 min-w-0 flex-col items-start gap-1.5 rounded-xl border bg-surface p-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent ${on ? 'border-accent ring-1 ring-accent' : 'border-line'}`}>
              <span className="w-full truncate text-sm font-medium text-ink">{p.name}</span>
              <Swatches id={id} />
              <span className="line-clamp-2 text-xs text-muted-foreground">{p.description}</span>
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
          <input type="color" aria-label="Custom accent" value={(palette.accent ?? base.accent).toLowerCase()}
            onChange={(e) => setPalette({ id: palette.id, accent: e.target.value })}
            className="h-11 w-14 cursor-pointer rounded-lg border border-line bg-surface p-1" />
          Custom accent
        </label>
        {palette.accent && (
          <Button variant="ghost" onClick={() => setPalette({ id: palette.id })} className="min-h-11 text-sm text-muted-foreground">Reset to palette</Button>
        )}
        {palette.accent && shown !== palette.accent && (
          <p className="w-full text-xs text-muted-foreground">Adjusted to {shown} for contrast in this theme.</p>
        )}
      </div>
    </div>
  )
}
