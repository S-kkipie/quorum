// The Seats mark: seven seats around a table and the tail that makes the Q. It inherits the text colour (the accent).
// The numbers match scripts/seats.mjs, which draws the committed icons; Logo.test.tsx keeps the two in step.
const DOTS: [number, number][] = [[24, 9], [34.6, 13.4], [39, 24], [24, 39], [13.4, 34.6], [9, 24], [13.4, 13.4]]
const TAIL = { x: 29, y: 31, width: 15, height: 5.4, rx: 2.7, transform: 'rotate(45 36.5 33.7)' }

export function Logo({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="currentColor"
      className={className}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      {DOTS.map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={4.3} />)}
      <rect {...TAIL} />
    </svg>
  )
}

/** The mark as a standalone SVG string in a fixed colour (for icons and non-React pages). */
export function SEATS_SVG(color: string): string {
  const dots = DOTS.map(([cx, cy]) => `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4.3"/>`).join('')
  const t = TAIL
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><g fill="${color}">${dots}<rect x="${t.x}" y="${t.y}" width="${t.width}" height="${t.height}" rx="${t.rx}" transform="${t.transform}"/></g></svg>`
}
