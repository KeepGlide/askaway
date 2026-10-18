// The Askaway pane: the header, the tree of the open questions (every group in turn, one under the other, with its
// sessions and questions), the question card (one question at a time; Submit all on the last one of its group) and the
// status lines of the answers. Everything is drawn from data handed in; the pane never reads state or writes it. Every
// callback it receives is a handler; the register supplies them, and the held table keeps each Button's press handle.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { Question, QuestionOption } from '../types'
import { t, type Lang } from './i18n'
import type { HeldButtons } from './held'
import { DIVIDER_COLUMNS, DIVIDER_HEIGHT, DIVIDER_PX, dividerSvg } from './divider'
import { EXPLAIN_COLORS, STATUS_COLORS } from './look'
import { KEEPGLIDE_HEADER_SIZE, KEEPGLIDE_SUBMIT_SIZE, renderKeepGlide, renderLogo } from './logo-element'
import {
  OTHER_INPUT_PREFIX,
  OTHER_KEY,
  ageLabel,
  counterText,
  leadOf,
  piecesOf,
  projectLabel,
  riskLabel,
  sectionsOf,
  sessionLabelOf,
  type CardSlot,
  type Leaving,
  type Section,
  type StatusLine,
} from './model'
import type { Group, Screen, Wizard } from './wizard'

type Ui = Elements[RenderSurface]

export type PaneView = {
  questions: Question[]
  lines: StatusLine[]
  now: number
  leaving: Leaving
  groups: Group[]
  active: Group | undefined
  // Already pruned to the open questions by the register.
  wizard: Wizard
  screen: Screen | undefined
  surface: RenderSurface
  // The footer line (footerText, hooks/model.ts), set by the register only while no question is open.
  footer?: string
  // The questions whose details are open: question id → true. A question not listed keeps its details folded.
  expanded: Readonly<Record<string, boolean>>
}

export type PaneActions = {
  dismiss: (id: string) => void
  pick: (id: string, key: string) => void
  toggleOther: (id: string) => void
  toggleDetails: (id: string) => void
  jump: (id: string) => void
  submitOther: (id: string, text: string) => void
  back: () => void
  next: () => void
  submit: () => void
}

// What one question card draws from: the question, the wizard state, whether it is fading out after a press, and
// whether its Other field is open (then the card draws no hotkeys: typed text must not press a button).
type CardContext = {
  question: Question
  wizard: Wizard
  isLeaving: boolean
  isTyping: boolean
  isExpanded: boolean
  held: HeldButtons
  surface: RenderSurface
}

// The title line names a question by its title; a question with no title is named by its text, cut short.
const TITLE_MAX = 24

export function renderPane(ui: Ui, view: PaneView, actions: PaneActions, lang: Lang, held: HeldButtons): RenderElement {
  const { Box, Text } = ui
  const { screen } = view
  held.begin()
  // The status lines come last: they change height as answers are delivered, and a Button drawn below a block that
  // grows lost its presses on the desktop (the first click was dropped). Everything that changes size stays below the card.
  const pane = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          {renderLogo(ui, view.surface)}
          <Text bold>{t(lang, 'pane.heading')}</Text>
        </Box>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text>{counterText(lang, view.questions)}</Text>
          {renderKeepGlide(ui, view.surface, 'keepglide-counter', KEEPGLIDE_HEADER_SIZE)}
        </Box>
      </Box>
      {view.groups.length > 0 && renderTree({ ui, lang, view, actions, held })}
      {screen !== undefined && renderQuestion(ui, lang, view, actions, screen, held)}
      {view.lines.map(line => renderStatusLine(ui, actions, line, held))}
      {view.footer !== undefined && view.questions.length === 0 && renderFooter(ui, view.footer)}
    </Box>
  )
  held.end()
  return pane
}

// The footer: one muted line under the status lines. Text only, never a row of the tree, and drawn only with no card up.
function renderFooter(ui: Ui, text: string): RenderElement {
  const { Text } = ui
  return <Text key="footer" dimColor>{text}</Text>
}

// One status line of the answers: pending, delivered or expired. Expired lines carry a ✕ that dismisses them.
function renderStatusLine(ui: Ui, actions: PaneActions, line: StatusLine, held: HeldButtons): RenderElement {
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
      {line.dismissable &&
        held.hold(`dismiss-${line.id}`, '✕', () => actions.dismiss(line.id), press => (
          <Button key={`dismiss-${line.id}`} label="✕" plain onPress={press} />
        ))}
    </Box>
  )
}

// The name of a group: its project's name, or the words for "the session" when the project is unknown.
function groupLabel(group: Group, lang: Lang): string {
  return projectLabel(group.questions[0]?.project ?? '', lang) || t(lang, 'status.target.session')
}

// What the tree draws from: the view and the language, the actions a row's press runs, and the held table for its Buttons.
type TreeContext = {
  ui: Ui
  lang: Lang
  view: PaneView
  actions: PaneActions
  held: HeldButtons
}

// The tree of the open questions: every group in turn, one under the other, each with its sessions and their questions.
// Group labels are bold. A question's mark says where it stands: ● the one on screen, ✓ picked, ○ not yet.
// Indentation is the Box's paddingLeft, not leading spaces, which a desktop may collapse.
function renderTree(tree: TreeContext): RenderElement {
  const { Box } = tree.ui
  return (
    <Box key="tree" flexDirection="column" gap={1}>
      {tree.view.groups.map(group => renderGroup(tree, group))}
    </Box>
  )
}

function renderGroup(tree: TreeContext, group: Group): RenderElement {
  const { Box, Text } = tree.ui
  const label = groupLabel(group, tree.lang)
  const lastSession = group.sessions.length - 1
  return (
    <Box key={`group-${group.key}`} flexDirection="column">
      <Text bold>{label}</Text>
      {group.sessions.map((questions, index) => renderSession(tree, questions, index === lastSession))}
    </Box>
  )
}

// One session of the group: its row ("├ " or, for the last one, "└ "), then its questions under it.
function renderSession(tree: TreeContext, questions: Question[], isFinal: boolean): RenderElement | false {
  const { Box, Text } = tree.ui
  const [first] = questions
  if (first === undefined) return false
  return (
    <Box key={`session-${first.id}`} flexDirection="column">
      <Box paddingLeft={1}>
        <Text>{`${isFinal ? '└' : '├'} ${sessionLabelOf(first, tree.lang)}`}</Text>
      </Box>
      {questions.map(question => renderTreeQuestion(tree, question, isFinal))}
    </Box>
  )
}

// One question under its session: "│  " before the mark under a session that is not the last one, nothing under the last.
// The indent is the Box's paddingLeft, so the mark sits in the same column under either session. The row is a plain
// Button: its press jumps to the question's card (actions.jump), as walking there with Next or Back would. Its text is
// bold while the card on screen is that question.
function renderTreeQuestion(tree: TreeContext, question: Question, isFinal: boolean): RenderElement {
  const { ui, view, actions, held } = tree
  const { Box, Button, Text } = ui
  const isOnScreen = view.screen?.question.id === question.id
  const mark = isOnScreen ? '●' : view.wizard.picks[question.id] !== undefined ? '✓' : '○'
  const label = `${isFinal ? '' : '│  '}${mark} ${questionLabel(question)}`
  const key = `tree-jump-${question.id}`
  const onPress = () => actions.jump(question.id)
  return (
    <Box key={`tree-${question.id}`} paddingLeft={isFinal ? 4 : 1}>
      {held.hold(key, [label, isOnScreen], onPress, press => (
        <Button key={key} label={label} plain onPress={press}>
          <Text bold={isOnScreen}>{label}</Text>
        </Button>
      ))}
    </Box>
  )
}

// The title of a question for the card and the tree: its title, else its text cut to TITLE_MAX characters.
function questionLabel(question: Question): string {
  const title = question.title.trim()
  if (title !== '') return title
  const text = question.question.trim()
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text
}

// The tradeoff under an option starts with a capital letter, whatever the agent wrote.
const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

// The line under an option: its tradeoff, then its fit after a dot. Either part may be missing; with neither, no line.
const tradeoffLineOf = (lang: Lang, option: QuestionOption): string | undefined => {
  const parts = [
    option.tradeoff === undefined ? undefined : capitalized(option.tradeoff),
    typeof option.fit === 'number' ? t(lang, 'option.fit', { n: option.fit }) : undefined,
  ].filter((part): part is string => part !== undefined)
  return parts.length > 0 ? `└ ${parts.join(' · ')}` : undefined
}

// The lines under an option's link line, as [label, text]: what happens if it is chosen, its pros, its cons. A missing
// one draws no line; an entry from before these fields existed draws none.
const optionDetailsOf = (lang: Lang, option: QuestionOption): [string, string][] => {
  const details: [string, string | undefined][] = [
    [t(lang, 'option.does'), option.does],
    [t(lang, 'option.pros'), option.pros],
    [t(lang, 'option.cons'), option.cons],
  ]
  return details.filter((detail): detail is [string, string] => detail[1] !== undefined)
}

// The digit of "Other…": the position after the options, 1 to 9 for the first nine positions, none after. Options never
// take digits; they answer to their key letters.
const digitOf = (position: number): string | undefined => (position <= 8 ? String(position + 1) : undefined)

// A hotkey is drawn only while the card's Other field is shut.
const hotkeyFor = (card: CardContext, key: string | undefined): string | undefined => (card.isTyping ? undefined : key)

// An option answers to its key letter in lower case; a key that is not one letter draws no hotkey.
const optionHotkey = (card: CardContext, key: string): string | undefined =>
  hotkeyFor(card, /^[a-z]$/i.test(key) ? key.toLowerCase() : undefined)

// Back, Next and Submit take the first free letters of their surface's pool, in that order. A letter that an option key
// uses on this card is skipped, so no shortcut clashes with an option. The terminal pool avoids b, n and s, because
// option B, N and S would clash with them; the desktop keeps p and f while no option uses them. The letter e is the details
// toggle's (DETAILS_KEY), so it is in no pool. A surface not listed draws none.
type NavKey = 'back' | 'next' | 'submit'
const NAV_ORDER: readonly NavKey[] = ['back', 'next', 'submit']
const NAV_POOLS: Partial<Record<RenderSurface, readonly string[]>> = {
  terminal: ['z', 'x', 'w'],
  desktop: ['p', 'f', 'w', 'z', 'x'],
}

const letterFor = (card: CardContext, key: NavKey): string | undefined => {
  const taken = card.question.options.map(option => option.key.toLowerCase())
  const free = (NAV_POOLS[card.surface] ?? []).filter(letter => !taken.includes(letter))
  return hotkeyFor(card, free[NAV_ORDER.indexOf(key)])
}

// One question on screen: the title in bold with the risk and age beside it, the bold lead line under it, the details
// toggle under the lead, What it is, The problem and Analogy above the question, the question, the Urgency box, the
// options with their tradeoff, fit, what happens, pros and cons, and "Other…". The long sections (Why to Context below
// the options) draw only while the details are open. Then a separator, and the Back / Next or Submit all row. One blank
// line sits under it.
function renderQuestion(
  ui: Ui,
  lang: Lang,
  view: PaneView,
  actions: PaneActions,
  screen: Screen,
  held: HeldButtons,
): RenderElement {
  const { Box, Text } = ui
  const { question } = screen
  const card: CardContext = {
    question,
    wizard: view.wizard,
    isLeaving: view.leaving[question.id] !== undefined,
    isTyping: view.wizard.other === question.id,
    isExpanded: view.expanded[question.id] === true,
    held,
    surface: view.surface,
  }
  const { isLeaving, isExpanded } = card
  return (
    <Box key={`card-${question.id}`} flexDirection="column" gap={1} borderStyle="round" borderDimColor={isLeaving} paddingX={1} paddingBottom={1}>
      <Box flexDirection="row" flexWrap="wrap" gap={2}>
        <Text bold dimColor={isLeaving}>{questionLabel(question)}</Text>
        <Text dimColor>{`${riskLabel(lang, question.risk)} · ${ageLabel(lang, question.ts, view.now)}`}</Text>
      </Box>
      <Text bold dimColor={isLeaving}>{leadOf(lang, question)}</Text>
      {hasDetailsOf(lang, question) && renderDetailsToggle(ui, lang, actions, card)}
      {renderExplanation(ui, 'before-question', sectionsOf(lang, question, 'before-question'), isLeaving)}
      <Text bold dimColor={isLeaving}>{question.question}</Text>
      {renderExplanation(ui, 'before-options', sectionsOf(lang, question, 'before-options'), isLeaving)}
      <Box flexDirection="column" gap={2} marginTop={1}>
        {question.options.map(option => renderOption(ui, lang, actions, card, option))}
        {renderOther(ui, lang, actions, card)}
      </Box>
      {isExpanded && renderExplanation(ui, 'after-options', sectionsOf(lang, question, 'after-options'), isLeaving)}
      {renderDivider(ui, view.surface)}
      {renderNav(ui, lang, actions, card, screen)}
    </Box>
  )
}

// The key of the details toggle: "e" opens and closes the long sections of the card.
const DETAILS_KEY = 'e'

// Whether the card has anything behind the details toggle: a section of the folded slot below the options.
const hasDetailsOf = (lang: Lang, question: Question): boolean => sectionsOf(lang, question, 'after-options').length > 0

// The details toggle, a link under the lead line: a plain Button (no chrome) whose label is underlined text, "Details" or,
// while the long sections are open, "Hide details". Its hotkey is drawn before the label ("e: Details"). An option keyed E
// takes the letter, so the toggle then draws no hotkey.
function renderDetailsToggle(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext): RenderElement {
  const { Button, Text } = ui
  const { question, isLeaving, isExpanded, held } = card
  const takesKey = question.options.some(option => option.key.toLowerCase() === DETAILS_KEY)
  const label = t(lang, isExpanded ? 'details.hide' : 'details.show')
  const hotkey = takesKey ? undefined : hotkeyFor(card, DETAILS_KEY)
  const key = `details-${question.id}`
  const onPress = () => {
    if (isLeaving) return
    actions.toggleDetails(question.id)
  }
  return held.hold(key, [label, isLeaving, hotkey], onPress, press => (
    <Button key={key} label={label} plain dimColor={isLeaving} hotkey={hotkey} onPress={press}>
      <Text underline dimColor={isLeaving}>{label}</Text>
    </Button>
  ))
}

// The separator above the nav row: a 1px SVG rule on the desktop, a row of '─' on the terminal. It is drawn after the
// options and the Other field, and before the nav row.
function renderDivider(ui: Ui, surface: RenderSurface): RenderElement {
  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    return <Svg key="divider" source={dividerSvg(DIVIDER_PX)} alt="divider" height={DIVIDER_HEIGHT} />
  }
  const { Text } = ui
  return <Text key="divider" dimColor>{'─'.repeat(DIVIDER_COLUMNS)}</Text>
}

// The explanations of one slot of the card, in one box at that place on the card. Nothing is drawn for a slot with no section.
function renderExplanation(ui: Ui, slot: CardSlot, sections: Section[], isLeaving: boolean): RenderElement | false {
  if (sections.length === 0) return false
  const { Box } = ui
  return (
    <Box key={`explanation-${slot}`} flexDirection="column" gap={1} backgroundColor={EXPLAIN_COLORS.bg} paddingX={1} paddingY={1}>
      {sections.map(section => renderSection(ui, section, isLeaving))}
    </Box>
  )
}

// A full-width option, headed by its key letter ("A · label"), its tradeoff and fit under it, then what happens, its pros
// and its cons. The picked one is the primary button; the recommended one, the one whose key is the recommended key, when
// not picked, is bold and says "(Recommended)" in its text.
function renderOption(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext, option: QuestionOption): RenderElement {
  const { Box, Button, Text } = ui
  const { question, isLeaving, wizard, held } = card
  const isPicked = wizard.picks[question.id]?.key === option.key
  const isRecommended = option.key === question.recommended
  const text = `${option.key} · ${option.label}${isRecommended ? ` (${t(lang, 'option.recommended')})` : ''}`
  const isBold = isRecommended && !isPicked
  const key = `opt-${question.id}-${option.key}`
  const hotkey = optionHotkey(card, option.key)
  const tradeoffLine = tradeoffLineOf(lang, option)
  const details = optionDetailsOf(lang, option)
  const onPress = () => {
    if (isLeaving) return
    actions.pick(question.id, option.key)
  }
  return (
    <Box key={`optrow-${question.id}-${option.key}`} flexDirection="column">
      {held.hold(key, [text, isPicked, isBold, isLeaving, hotkey], onPress, press => (
        <Button
          key={key}
          label={text}
          variant={isPicked ? 'primary' : 'secondary'}
          dimColor={isLeaving}
          hotkey={hotkey}
          onPress={press}
        >
          {isBold ? <Text bold dimColor={isLeaving}>{text}</Text> : text}
        </Button>
      ))}
      {(tradeoffLine !== undefined || details.length > 0) && (
        <Box flexDirection="column" paddingLeft={1}>
          {tradeoffLine !== undefined && <Text dimColor={isLeaving}>{tradeoffLine}</Text>}
          {details.map(([label, text]) => (
            <Text key={label} dimColor={isLeaving}>
              <Text bold>{`${label}: `}</Text>
              {text}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

// "Other…": the last option. Pressing it opens a field right under it for a free-text answer; the text goes through
// the same pick path as an option. A surface with no Input (mobile) draws no field, so it draws no Other option either.
function renderOther(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext): RenderElement | false {
  if (!('Input' in ui)) return false
  const { Box, Button, Input, Text } = ui
  const { question, isLeaving, wizard, held } = card
  const isOpen = wizard.other === question.id
  // Once Other… is submitted the pick holds its text: the button stays primary and the text shows under it.
  const pick = wizard.picks[question.id]
  const chosenText = pick !== undefined && pick.key === OTHER_KEY ? (pick.text ?? '') : undefined
  const key = `other-${question.id}`
  const label = `${question.options.length + 1}. ${t(lang, 'option.other')}`
  const variant = chosenText !== undefined ? 'primary' : 'secondary'
  const hotkey = hotkeyFor(card, digitOf(question.options.length))
  const onPress = () => {
    if (isLeaving) return
    actions.toggleOther(question.id)
  }
  return (
    <Box key={`other-row-${question.id}`} flexDirection="column">
      {held.hold(key, [label, variant, isLeaving, hotkey], onPress, press => (
        <Button key={key} label={label} variant={variant} dimColor={isLeaving} hotkey={hotkey} onPress={press} />
      ))}
      {chosenText !== undefined && <Text dimColor={isLeaving}>{chosenText}</Text>}
      {isOpen && !isLeaving && (
        <Input
          key={`${OTHER_INPUT_PREFIX}${question.id}`}
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

// Back, and forward: Next on every question but the last; on the last one, Submit all, which writes every answer of the
// group and needs every question picked, with the KeepGlide mark beside it on the desktop. A dim button does nothing when
// pressed. Back, Next and Submit carry their letters on the terminal and on the desktop (letterFor).
function renderNav(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext, screen: Screen): RenderElement {
  const { Box, Button } = ui
  const { question, isLeaving, held } = card
  const isBackOff = !screen.canBack || isLeaving
  const label = t(lang, 'nav.back')
  const hotkey = letterFor(card, 'back')
  const onPress = () => {
    if (isBackOff) return
    actions.back()
  }
  return (
    <Box key={`nav-${question.id}`} flexDirection="row" justifyContent="space-between">
      {held.hold('nav-back', [label, isBackOff, hotkey], onPress, press => (
        <Button key="nav-back" label={label} variant="secondary" dimColor={isBackOff} hotkey={hotkey} onPress={press} />
      ))}
      {screen.canNext ? renderNext(ui, lang, actions, card, screen) : renderSubmitAll(ui, lang, actions, card, screen)}
    </Box>
  )
}

function renderNext(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext, screen: Screen): RenderElement {
  const { Button } = ui
  const isOff = !screen.canNext || card.isLeaving
  const label = t(lang, 'nav.next')
  const hotkey = letterFor(card, 'next')
  const onPress = () => {
    if (isOff) return
    actions.next()
  }
  return card.held.hold('nav-next', [label, isOff, hotkey], onPress, press => (
    <Button key="nav-next" label={label} variant={isOff ? 'secondary' : 'primary'} dimColor={isOff} hotkey={hotkey} onPress={press} />
  ))
}

function renderSubmitAll(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext, screen: Screen): RenderElement {
  const { Box, Button } = ui
  const isOff = !screen.canSubmit || card.isLeaving
  const label = t(lang, 'review.submit', { n: screen.total })
  const hotkey = letterFor(card, 'submit')
  const onPress = () => {
    if (isOff) return
    actions.submit()
  }
  return (
    <Box key="submit-row" flexDirection="row" alignItems="center" gap={1}>
      {card.held.hold('submit-all', [label, isOff, hotkey], onPress, press => (
        <Button key="submit-all" label={label} variant={isOff ? 'secondary' : 'primary'} dimColor={isOff} hotkey={hotkey} onPress={press} />
      ))}
      {renderKeepGlide(ui, card.surface, 'keepglide-submit', KEEPGLIDE_SUBMIT_SIZE)}
    </Box>
  )
}

// One section of the explanation, on one wrapping line: the heading in bold, a colon, then the text, with every command,
// skill or agent name the agent wrote in bold (piecesOf).
function renderSection(ui: Ui, section: Section, isLeaving: boolean): RenderElement {
  const { Text } = ui
  return (
    <Text key={`section-${section.heading}`} color={EXPLAIN_COLORS.ink} dimColor={isLeaving}>
      <Text bold>{`${section.heading}: `}</Text>
      {piecesOf(section.body).map((piece, index) =>
        piece.isName ? (
          <Text key={`name-${index}`} bold color={EXPLAIN_COLORS.ink}>
            {piece.text}
          </Text>
        ) : (
          piece.text
        ),
      )}
    </Text>
  )
}
