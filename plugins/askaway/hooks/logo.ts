// The Askaway logo: a speech bubble with a question mark and a dot at its corner, the question that waits for the
// person. Drawn as inline SVG on the desktop surface (the band, the pane header); the terminal shows a text glyph.

// The 24x24 stroke paths: the bubble, the hook of the question mark, its dot, and the waiting dot at the corner.
const PATHS = [
  'M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-8l-4 3v-3h-2a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2z',
  'M10 8.5a2 2 0 1 1 2.8 1.8c-.6 .3 -.8 .7 -.8 1.2v.5',
  'M12 14v.01',
]

// The violet, set on the markup's own attributes: an engine may scrub a <style> element out of the SVG.
const LOGO_COLOR = '#8B5CF6'

// The terminal's stand-in for the logo.
export const LOGO_GLYPH = '?'

// The logo as an SVG document for the `Svg` element, `size` CSS pixels square.
export function askawaySvg({ size = 16 }: { size?: number } = {}): string {
  const paths = PATHS.map(d => `<path d="${d}"/>`).join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${LOGO_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}` +
    `<circle cx="19.5" cy="4.5" r="2.5" fill="${LOGO_COLOR}" stroke="none"/></svg>`
  )
}
