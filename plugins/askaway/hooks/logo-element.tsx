// The Askaway logo as one drawing element, shared by the band row and the pane heading: the SVG on the desktop, the
// text glyph elsewhere. The surface decides, not `'Svg' in ui`: the terminal's elements carry an Svg too, drawn empty.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import { KEEPGLIDE_ALT, keepglideSvg } from './keepglide'
import { HISTORY_GLYPH, LOGO_GLYPH, askawaySvg, historySvg } from './logo'

type Ui = Elements[RenderSurface]

const LOGO_SIZE = 16
// The KeepGlide mark is drawn larger beside Submit all than in the header, where it keeps to the row's height.
export const KEEPGLIDE_HEADER_SIZE = 24
export const KEEPGLIDE_SUBMIT_SIZE = 28

export function renderLogo(ui: Ui, surface: RenderSurface): RenderElement {
  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    return <Svg key="logo" source={askawaySvg({ size: LOGO_SIZE })} alt="Askaway" width={LOGO_SIZE} height={LOGO_SIZE} />
  }
  const { Text } = ui
  return (
    <Text key="logo" bold>
      {LOGO_GLYPH}
    </Text>
  )
}

// The History icon beside the History heading, drawn as the logo is: the SVG on the desktop, the glyph elsewhere.
export function renderHistoryIcon(ui: Ui, surface: RenderSurface): RenderElement {
  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    return <Svg key="history-icon" source={historySvg({ size: LOGO_SIZE })} alt="History" width={LOGO_SIZE} height={LOGO_SIZE} />
  }
  const { Text } = ui
  return (
    <Text key="history-icon" bold>
      {HISTORY_GLYPH}
    </Text>
  )
}

// The KeepGlide mark beside the counter and the Submit all button, at the size each placement asks for. Desktop only:
// the terminal draws no picture.
export function renderKeepGlide(ui: Ui, surface: RenderSurface, key: string, size: number): RenderElement | false {
  if (surface !== 'desktop' || !('Svg' in ui)) return false
  const { Svg } = ui
  return <Svg key={key} source={keepglideSvg({ size })} alt={KEEPGLIDE_ALT} width={size} height={size} />
}
