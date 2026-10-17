// The Askaway logo as one drawing element, shared by the band row and the pane heading: the SVG on the desktop, the
// text glyph elsewhere. The surface decides, not `'Svg' in ui`: the terminal's elements carry an Svg too, drawn empty.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import { ACCENT_COLOR } from './look'
import { LOGO_GLYPH, askawaySvg } from './logo'

type Ui = Elements[RenderSurface]

const LOGO_SIZE = 16

export function renderLogo(ui: Ui, surface: RenderSurface): RenderElement {
  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    return <Svg key="logo" source={askawaySvg({ size: LOGO_SIZE })} alt="Askaway" width={LOGO_SIZE} height={LOGO_SIZE} />
  }
  const { Text } = ui
  return (
    <Text key="logo" bold color={ACCENT_COLOR}>
      {LOGO_GLYPH}
    </Text>
  )
}
