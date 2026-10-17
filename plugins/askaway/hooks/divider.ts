// The separator above the nav row of a question card: a 1px rule as an SVG on the desktop surface. The terminal draws
// the same rule as a text of '─' instead (in pane.tsx). The colour is set on the markup's own attribute: an engine may
// scrub a <style> element out of the SVG.
import { DIVIDER_COLOR } from './look'

// The SVG element's height in CSS pixels: the 1px rule sits in the middle, with 10px of air above and below.
export const DIVIDER_HEIGHT = 21

// The width of the rule on the desktop, and its length in columns on the terminal. The card's render event carries no
// width the pane can read, so both are fixed defaults that fit a narrow pane.
export const DIVIDER_PX = 320
export const DIVIDER_COLUMNS = 40

export function dividerSvg(width: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${DIVIDER_HEIGHT}" viewBox="0 0 ${width} ${DIVIDER_HEIGHT}" ` +
    `preserveAspectRatio="none"><rect x="0" y="10" width="${width}" height="1" fill="${DIVIDER_COLOR}"/></svg>`
  )
}
