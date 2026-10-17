// The band row above the prompt: the Askaway logo, one line that says how many questions wait, and a button that
// opens the pane. The register decides when the row is drawn (only while a question is open and no survey is up);
// this file only draws it.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { HeldButtons } from './held'
import { plural, t, type Lang } from './i18n'
import { renderLogo } from './logo-element'

type Ui = Elements[RenderSurface]

export type BandView = { lang: Lang; questions: number; groups: number; surface: RenderSurface }

// The digit 1 opens the pane from an empty composer too (the band's hotkey), so the person answers without a mouse.
export function renderBand(ui: Ui, view: BandView, onOpen: () => void, held: HeldButtons): RenderElement {
  const { Box, Button, Text } = ui
  const label = t(view.lang, 'band.open')
  held.begin()
  const questions = plural(view.lang, view.questions, 'count.question.one', 'count.question.many')
  const groups = plural(view.lang, view.groups, 'count.group.one', 'count.group.many')
  const band = (
    <Box flexDirection="row" alignItems="center" gap={1}>
      {renderLogo(ui, view.surface)}
      <Text>{t(view.lang, 'band.text', { questions, groups })}</Text>
      {held.hold('open', label, onOpen, press => (
        <Button key="open" label={label} hotkey="1" variant="primary" onPress={press} />
      ))}
    </Box>
  )
  held.end()
  return band
}
