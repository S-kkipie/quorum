// The Seats mark: the single source of the geometry for scripts/gen-icons.mjs. app/src/components/Logo.tsx holds the
// same numbers for the React component; Logo.test.tsx checks that both produce the same SVG.
export const DOTS = [
  [24.0, 9.0],
  [34.6, 13.4],
  [39.0, 24.0],
  [24.0, 39.0],
  [13.4, 34.6],
  [9.0, 24.0],
  [13.4, 13.4],
]

/** The mark's shapes (inside a 48 viewBox), filled with `color`. */
export function seatsShapes(color) {
  const dots = DOTS.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.3"/>`).join('')
  return `<g fill="${color}">${dots}<rect x="29" y="31" width="15" height="5.4" rx="2.7" transform="rotate(45 36.5 33.7)"/></g>`
}

/** The bare mark as a standalone SVG. */
export function seatsSvg(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${seatsShapes(color)}</svg>`
}
