// The Askaway pane: the header, the status lines, the window selector and the question wizard (one question at a
// time, then the review). Everything is drawn from data handed in; the pane never reads state or writes it. Every
// callback it receives is a handler; the register supplies them.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { Question, QuestionOption } from '../types'
import { t, type Lang } from './i18n'
import { ORIGIN_COLOR, STATUS_COLORS } from './look'
import {
  OTHER_KEY,
  ageLabel,
  counterText,
  jevLine,
  riskLabel,
  sectionsOf,
  windowOf,
  type Leaving,
  type Section,
  type StatusLine,
} from './model'
import type { Pick, Screen, Wizard, WindowGroup } from './wizard'

type Ui = Elements[RenderSurface]
type QuestionScreen = Extract<Screen, { kind: 'question' }>
type ReviewScreen = Extract<Screen, { kind: 'review' }>

export type PaneView = {
  questions: Question[]
  lines: StatusLine[]
  now: number
  leaving: Leaving
  windows: WindowGroup[]
  active: WindowGroup | undefined
  // Already pruned to the open questions by the register.
  wizard: Wizard
  screen: Screen | undefined
}

export type PaneActions = {
  dismiss: (id: string) => void
  pick: (id: string, key: string) => void
  toggleOther: (id: string) => void
  typeOther: (id: string, text: string) => void
  submitOther: (id: string, text: string) => void
  toggleExpanded: (id: string) => void
  back: () => void
  next: () => void
  jump: (index: number) => void
  selectWindow: (key: string) => void
  submit: () => void
}

// What one question card draws from: the question, the wizard state and whether it is fading out after a press.
type CardContext = {
  question: Question
  wizard: Wizard
  isLeaving: boolean
}

export function renderPane(ui: Ui, view: PaneView, actions: PaneActions, lang: Lang): RenderElement {
  const { Box, Text } = ui
  const { screen } = view
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>{t(lang, 'pane.title')}</Text>
        <Text>{counterText(lang, view.questions)}</Text>
      </Box>
      {view.lines.map(line => renderStatusLine(ui, actions, line))}
      {view.windows.length > 1 && renderWindows(ui, lang, view, actions)}
      {screen?.kind === 'question' && renderQuestion(ui, lang, view, actions, screen)}
      {screen?.kind === 'review' && renderReview(ui, lang, actions, screen)}
    </Box>
  )
}

// One status line of the answers: pending, delivered or expired. Expired lines carry a ✕ that dismisses them.
function renderStatusLine(ui: Ui, actions: PaneActions, line: StatusLine): RenderElement {
  const { Box, Text, Button } = ui
  return (
    <Box
      key={`status-${line.id}`}
      flexDirection="row"
      justifyContent="space-between"
      backgroundColor={STATUS_COLORS.bg}
      paddingX={1}
    >
      <Text color={STATUS_COLORS.ink}>{line.text}</Text>
      {line.dismissable && (
        <Button key={`dismiss-${line.id}`} label="✕" plain onPress={() => actions.dismiss(line.id)} />
      )}
    </Box>
  )
}

// One button per window, when there are two or more: the window on screen is the primary button.
function renderWindows(ui: Ui, lang: Lang, view: PaneView, actions: PaneActions): RenderElement {
  const { Box, Button, Text } = ui
  return (
    <Box flexDirection="column" gap={1}>
      <Text>{t(lang, 'window.choose')}</Text>
      <Box flexDirection="row" gap={1}>
        {view.windows.map(group => (
          <Button
            key={`window-${group.key}`}
            label={`${group.label || t(lang, 'status.target.session')} (${group.questions.length})`}
            variant={group.key === view.active?.key ? 'primary' : 'secondary'}
            onPress={() => actions.selectWindow(group.key)}
          />
        ))}
      </Box>
    </Box>
  )
}

// One question on screen: progress, origin, risk and age, the question, the JEV line, the numbered options,
// "Other…", the explanations behind "More", and the Back / Next row.
function renderQuestion(ui: Ui, lang: Lang, view: PaneView, actions: PaneActions, screen: QuestionScreen): RenderElement {
  const { Box, Text } = ui
  const { question } = screen
  const card: CardContext = { question, wizard: view.wizard, isLeaving: view.leaving[question.id] !== undefined }
  const { isLeaving } = card
  const isExpanded = view.wizard.expanded[question.id] === true
  const jev = jevLine(question.options)
  const riskLine =
    question.risk === 'high'
      ? riskLabel(lang, question.risk)
      : `${riskLabel(lang, question.risk)} · ${ageLabel(lang, question.ts, view.now)}`
  return (
    <Box key={`card-${question.id}`} flexDirection="column" borderStyle="round" borderDimColor={isLeaving} paddingX={1}>
      <Text dimColor={isLeaving}>{t(lang, 'pane.progress', { index: screen.index + 1, total: screen.total })}</Text>
      <Text bold color={ORIGIN_COLOR} dimColor={isLeaving}>{windowOf(question)}</Text>
      <Text dimColor={isLeaving}>{riskLine}</Text>
      <Text bold dimColor={isLeaving}>{question.question}</Text>
      {jev !== undefined && <Text dimColor={isLeaving}>{jev}</Text>}
      {question.options.map((option, position) =>
        renderOption(ui, lang, actions, card, isExpanded, option, position, screen.pick),
      )}
      {renderOther(ui, lang, actions, card)}
      {renderMore(ui, lang, actions, card, isExpanded)}
      {isExpanded && sectionsOf(lang, question).map(section => renderSection(ui, section, isLeaving))}
      {screen.total > 1 && renderNav(ui, lang, actions, card, screen)}
    </Box>
  )
}

// A full-width numbered option; the picked one is the primary button, the recommended one carries the 🎯 mark, and
// the tradeoff line shows under it when the card is expanded.
function renderOption(
  ui: Ui,
  lang: Lang,
  actions: PaneActions,
  card: CardContext,
  isExpanded: boolean,
  option: QuestionOption,
  position: number,
  pick: Pick | undefined,
): RenderElement {
  const { Box, Button, Text } = ui
  const { question, isLeaving } = card
  const isPicked = pick?.key === option.key
  return (
    <Box key={`optrow-${question.id}-${option.key}`} flexDirection="column">
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box flexGrow={1}>
          <Button
            key={`opt-${question.id}-${option.key}`}
            label={`${position + 1}  ${option.label}`}
            variant={isPicked ? 'primary' : 'secondary'}
            dimColor={isLeaving}
            onPress={() => {
              if (isLeaving) return
              actions.pick(question.id, option.key)
            }}
          />
        </Box>
        {option.key === question.recommended && renderRecommendedMark(ui, lang, question.id, isLeaving)}
      </Box>
      {isExpanded && option.tradeoff !== undefined && <Text dimColor>{option.tradeoff}</Text>}
    </Box>
  )
}

// "Other…": a button under the options that opens a field for a free-text answer. The text goes through the same
// pick path as an option. A surface with no Input (mobile) draws no field: there is nothing to type into.
function renderOther(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext): RenderElement | false {
  if (!('Input' in ui)) return false
  const { Box, Button, Input } = ui
  const { question, isLeaving, wizard } = card
  const other = wizard.other?.id === question.id ? wizard.other : undefined
  return (
    <Box key={`other-row-${question.id}`} flexDirection="column">
      <Box flexDirection="row">
        <Button
          key={`other-${question.id}`}
          label={t(lang, 'option.other')}
          variant="secondary"
          dimColor={isLeaving}
          onPress={() => {
            if (isLeaving) return
            actions.toggleOther(question.id)
          }}
        />
      </Box>
      {other !== undefined && !isLeaving && (
        <Input
          key={`other-input-${question.id}`}
          label={t(lang, 'input.label')}
          placeholder={t(lang, 'input.placeholder')}
          value={other.text}
          submitLabel={t(lang, 'input.send')}
          onInput={text => actions.typeOther(question.id, text)}
          onSubmit={text => actions.submitOther(question.id, text)}
        />
      )}
    </Box>
  )
}

// The toggle that shows or hides the explanations of the card.
function renderMore(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext, isExpanded: boolean): RenderElement {
  const { Button } = ui
  const { question, isLeaving } = card
  return (
    <Button
      key={`more-${question.id}`}
      label={t(lang, isExpanded ? 'nav.less' : 'nav.more')}
      variant="secondary"
      dimColor={isLeaving}
      onPress={() => {
        if (isLeaving) return
        actions.toggleExpanded(question.id)
      }}
    />
  )
}

// Back and Next. Next moves only once the question on screen has a pick (the register checks it too).
function renderNav(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext, screen: QuestionScreen): RenderElement {
  const { Box, Button } = ui
  const isBackOff = !screen.canBack || card.isLeaving
  const isNextOff = !screen.canNext || card.isLeaving
  return (
    <Box key={`nav-${card.question.id}`} flexDirection="row" justifyContent="space-between">
      <Button
        key="nav-back"
        label={t(lang, 'nav.back')}
        variant="secondary"
        dimColor={isBackOff}
        onPress={() => {
          if (isBackOff) return
          actions.back()
        }}
      />
      <Button
        key="nav-next"
        label={t(lang, 'nav.next')}
        variant={screen.canNext ? 'primary' : 'secondary'}
        dimColor={isNextOff}
        onPress={() => {
          if (isNextOff) return
          actions.next()
        }}
      />
    </Box>
  )
}

// The 🎯 at rest, with its "Recommended" tooltip: a hidden absolute Box that the hover over the keyed mark reveals.
// Absolute, so showing it moves nothing in the row.
function renderRecommendedMark(ui: Ui, lang: Lang, questionId: string, isLeaving: boolean): RenderElement {
  const { Box, Text } = ui
  return (
    <Box key={`rec-${questionId}`} flexDirection="column">
      <Text dimColor={isLeaving}>🎯</Text>
      <Box position="absolute" top={-1} right={0} display="none" hover={{ display: 'flex' }}>
        <Text dimColor={isLeaving}>{t(lang, 'option.recommended')}</Text>
      </Box>
    </Box>
  )
}

function renderSection(ui: Ui, section: Section, isLeaving: boolean): RenderElement {
  const { Box, Text } = ui
  return (
    <Box key={`section-${section.heading}`} flexDirection="column">
      <Text bold dimColor={isLeaving}>{section.heading}</Text>
      <Text dimColor={isLeaving}>{section.body}</Text>
    </Box>
  )
}

// The review: one row per question (a click jumps to its step), then Back and Submit all.
function renderReview(ui: Ui, lang: Lang, actions: PaneActions, screen: ReviewScreen): RenderElement {
  const { Box, Button, Text } = ui
  return (
    <Box key="review" flexDirection="column" gap={1}>
      <Text bold>{t(lang, 'review.title')}</Text>
      {screen.rows.map((row, index) => (
        <Button
          key={`review-row-${row.question.id}`}
          label={`${index + 1}. ${row.question.question} → ${chosenText(lang, row.question, row.pick)}`}
          variant="secondary"
          onPress={() => actions.jump(index)}
        />
      ))}
      <Box flexDirection="row" justifyContent="space-between">
        <Button key="nav-back" label={t(lang, 'nav.back')} variant="secondary" onPress={() => actions.back()} />
        <Button
          key="submit-all"
          label={t(lang, 'review.submit', { n: screen.rows.length })}
          variant={screen.canSubmit ? 'primary' : 'secondary'}
          dimColor={!screen.canSubmit}
          onPress={() => {
            if (!screen.canSubmit) return
            actions.submit()
          }}
        />
      </Box>
    </Box>
  )
}

// What a review row says the question got: the option's label, the Other text, or nothing yet.
function chosenText(lang: Lang, question: Question, pick: Pick | undefined): string {
  if (pick === undefined) return t(lang, 'review.unanswered')
  if (pick.key === OTHER_KEY) return t(lang, 'review.other', { text: pick.text ?? '' })
  return question.options.find(option => option.key === pick.key)?.label ?? pick.key
}
