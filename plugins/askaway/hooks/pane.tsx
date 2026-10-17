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

// A tab names its question by the question's title; a question with no title is named by its text, cut short.
const TAB_TITLE_MAX = 24

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
      {screen?.kind === 'review' && renderReview(ui, lang, view, actions, screen)}
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

// The tab name of a question: its title, else its text cut to TAB_TITLE_MAX characters.
function tabTitle(question: Question): string {
  const title = question.title.trim()
  if (title !== '') return title
  const text = question.question.trim()
  return text.length > TAB_TITLE_MAX ? `${text.slice(0, TAB_TITLE_MAX - 1)}…` : text
}

// The one way into the review step, from the Submit tab and the Review button: it does nothing until every question has
// a pick (canReview).
function goToReview(actions: PaneActions, total: number, canReview: boolean): () => void {
  return () => {
    if (canReview) actions.jump(total)
  }
}

// The tabs row of a window of two or more questions: one tab per question, then Submit. The tab on screen is bold;
// Submit is dim until every question has a pick. A window of one question has no tabs.
function renderTabs(ui: Ui, lang: Lang, actions: PaneActions, group: WindowGroup, current: number, canReview: boolean): RenderElement | false {
  const { Box, Button, Text } = ui
  const total = group.questions.length
  if (total < 2) return false
  const submit = t(lang, 'tab.submit')
  return (
    <Box key="tabs" flexDirection="row" gap={2}>
      {group.questions.map((question, index) => {
        const label = `${index + 1} ${tabTitle(question)}`
        return (
          <Button key={`tab-${question.id}`} label={label} plain onPress={() => actions.jump(index)}>
            {index === current ? <Text bold>{label}</Text> : label}
          </Button>
        )
      })}
      <Button key="tab-submit" label={submit} plain dimColor={!canReview} onPress={goToReview(actions, total, canReview)}>
        {current === total ? <Text bold dimColor={!canReview}>{submit}</Text> : submit}
      </Button>
    </Box>
  )
}

// One question on screen: the tabs, the origin line, the risk and age line, the question, the JEV line, the numbered
// options with "Other…", the explanations behind "More", and the Back / Next row.
function renderQuestion(ui: Ui, lang: Lang, view: PaneView, actions: PaneActions, screen: QuestionScreen): RenderElement {
  const { Box, Text } = ui
  const { question } = screen
  const card: CardContext = { question, wizard: view.wizard, isLeaving: view.leaving[question.id] !== undefined }
  const { isLeaving } = card
  const isExpanded = view.wizard.expanded[question.id] === true
  const jev = jevLine(question.options)
  return (
    <Box key={`card-${question.id}`} flexDirection="column" gap={1} borderStyle="round" borderDimColor={isLeaving} paddingX={1}>
      {view.active !== undefined && renderTabs(ui, lang, actions, view.active, screen.index, screen.canReview)}
      <Box flexDirection="column">
        <Text bold color={ORIGIN_COLOR} dimColor={isLeaving}>{windowOf(question)}</Text>
        <Text dimColor={isLeaving}>{`${riskLabel(lang, question.risk)} · ${ageLabel(lang, question.ts, view.now)}`}</Text>
      </Box>
      <Text bold dimColor={isLeaving}>{question.question}</Text>
      {jev !== undefined && <Text dimColor={isLeaving}>{jev}</Text>}
      <Box flexDirection="column" gap={1}>
        {question.options.map((option, position) => renderOption(ui, lang, actions, card, option, position))}
        {renderOther(ui, lang, actions, card)}
      </Box>
      {renderMore(ui, lang, actions, card, isExpanded)}
      {isExpanded && sectionsOf(lang, question).map(section => renderSection(ui, section, isLeaving))}
      {screen.total > 1 && renderNav(ui, lang, actions, card, screen)}
    </Box>
  )
}

// A full-width numbered option, its tradeoff under it. The picked one is the primary button; the recommended one, when
// not picked, is bold and says "(Recommended)" in its text.
function renderOption(
  ui: Ui,
  lang: Lang,
  actions: PaneActions,
  card: CardContext,
  option: QuestionOption,
  position: number,
): RenderElement {
  const { Box, Button, Text } = ui
  const { question, isLeaving, wizard } = card
  const isPicked = wizard.picks[question.id]?.key === option.key
  const isRecommended = option.key === question.recommended
  const text = `${position + 1}. ${option.label}${isRecommended ? ` (${t(lang, 'option.recommended')})` : ''}`
  const isBold = isRecommended && !isPicked
  return (
    <Box key={`optrow-${question.id}-${option.key}`} flexDirection="column">
      <Button
        key={`opt-${question.id}-${option.key}`}
        label={text}
        variant={isPicked ? 'primary' : 'secondary'}
        dimColor={isLeaving}
        onPress={() => {
          if (isLeaving) return
          actions.pick(question.id, option.key)
        }}
      >
        {isBold ? <Text bold dimColor={isLeaving}>{text}</Text> : text}
      </Button>
      {option.tradeoff !== undefined && <Text dimColor={isLeaving}>{option.tradeoff}</Text>}
    </Box>
  )
}

// "Other…": the last option. Pressing it opens a field right under it for a free-text answer; the text goes through
// the same pick path as an option. A surface with no Input (mobile) draws no field, so it draws no Other option either.
function renderOther(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext): RenderElement | false {
  if (!('Input' in ui)) return false
  const { Box, Button, Input, Text } = ui
  const { question, isLeaving, wizard } = card
  const isOpen = wizard.other === question.id
  // Once Other… is submitted the pick holds its text: the button stays primary and the text shows under it.
  const pick = wizard.picks[question.id]
  const chosenText = pick !== undefined && pick.key === OTHER_KEY ? (pick.text ?? '') : undefined
  return (
    <Box key={`other-row-${question.id}`} flexDirection="column">
      <Button
        key={`other-${question.id}`}
        label={`${question.options.length + 1}. ${t(lang, 'option.other')}`}
        variant={chosenText !== undefined ? 'primary' : 'secondary'}
        dimColor={isLeaving}
        onPress={() => {
          if (isLeaving) return
          actions.toggleOther(question.id)
        }}
      />
      {chosenText !== undefined && <Text dimColor={isLeaving}>{chosenText}</Text>}
      {isOpen && !isLeaving && (
        <Input
          key={`other-input-${question.id}`}
          label={t(lang, 'input.label')}
          placeholder={t(lang, 'input.placeholder')}
          submitLabel={t(lang, 'input.send')}
          autoFocus
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

// Back, and forward: Next on every question but the last, Review on the last one (to the review step, which needs
// every question picked). A dim button does nothing when pressed.
function renderNav(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext, screen: QuestionScreen): RenderElement {
  const { Box, Button } = ui
  const isLast = screen.index === screen.total - 1
  const forward = isLast
    ? { label: t(lang, 'nav.review'), canGo: screen.canReview, go: goToReview(actions, screen.total, screen.canReview) }
    : { label: t(lang, 'nav.next'), canGo: screen.canNext, go: () => actions.next() }
  const isBackOff = !screen.canBack || card.isLeaving
  const isForwardOff = !forward.canGo || card.isLeaving
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
        label={forward.label}
        variant={forward.canGo ? 'primary' : 'secondary'}
        dimColor={isForwardOff}
        onPress={() => {
          if (isForwardOff) return
          forward.go()
        }}
      />
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

// The review: the tabs (Submit on), one row per question (a click jumps to its step), then Back and Submit all.
function renderReview(ui: Ui, lang: Lang, view: PaneView, actions: PaneActions, screen: ReviewScreen): RenderElement {
  const { Box, Button, Text } = ui
  return (
    <Box key="review" flexDirection="column" gap={1}>
      {view.active !== undefined && renderTabs(ui, lang, actions, view.active, screen.rows.length, screen.canSubmit)}
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
