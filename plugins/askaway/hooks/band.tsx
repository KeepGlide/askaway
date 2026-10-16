// The band row above the prompt: one line that says how many questions wait, and a button that opens the pane. The
// register decides when the row is drawn (only while a question is open and no survey is up); this file only draws it.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import { plural, t, type Lang } from './i18n'

type Ui = Elements[RenderSurface]

export type BandView = { lang: Lang; questions: number; windows: number }

// The digit 1 opens the pane from an empty composer too (the band's hotkey), so the person answers without a mouse.
export function renderBand(ui: Ui, view: BandView, onOpen: () => void): RenderElement {
  const { Box, Button, Text } = ui
  const questions = plural(view.lang, view.questions, 'count.question.one', 'count.question.many')
  const windows = plural(view.lang, view.windows, 'count.window.one', 'count.window.many')
  return (
    <Box flexDirection="row" alignItems="center" gap={1}>
      <Text>{t(view.lang, 'band.text', { questions, windows })}</Text>
      <Button key="open" label={t(view.lang, 'band.open')} hotkey="1" variant="primary" onPress={onOpen} />
    </Box>
  )
}
