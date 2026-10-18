// The Askaway pane: the header, the tree of the open questions (every group in turn, one under the other, with its
// sessions and questions), the question card (one question at a time; Submit all on the last one of its group) and the
// status lines of the answers. Everything is drawn from data handed in; the pane never reads state or writes it. Every
// callback it receives is a handler; the register supplies them, and the held table keeps each Button's press handle.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { Question, QuestionOption } from '../types'
import { t, type Lang } from './i18n'
import type { HeldButtons } from './held'
import { DIVIDER_COLUMNS, DIVIDER_HEIGHT, DIVIDER_PX, dividerSvg } from './divider'
import { DETAILS_FILL, LINK_MARK, URGENCY_COLOR, type ThemeFamily } from './look'
import { KEEPGLIDE_HEADER_SIZE, KEEPGLIDE_SUBMIT_SIZE, renderKeepGlide, renderLogo } from './logo-element'
import {
  urgencyGradeOf,
  OTHER_INPUT_PREFIX,
  OTHER_KEY,
  ageLabel,
  clearableIdsOf,
  counterText,
  escapeMarkdown,
  firstBlockOf,
  groupLabelOf,
  leadOf,
  otherLetterOf,
  piecesOf,
  questionLabel,
  riskLabel,
  sectionsOf,
  sessionLabelOf,
  type HistoryEntry,
  type HistoryGroup,
  type Leaving,
  type Section,
} from './model'
import type { Group, Screen, Wizard } from './wizard'

type Ui = Elements[RenderSurface]

export type PaneView = {
  questions: Question[]
  // The History tree (historyOf, hooks/model.ts): newest answer first, with the rows a Clear removes.
  history: HistoryGroup[]
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
  // The ids of open questions whose asking session has ended: their card shows a notice and Dismiss, no options.
  ended: readonly string[]
  // True until the person gave a name or skipped: the pane then asks for it above the card, once.
  askWho: boolean
  // The theme family (look.ts themeFamilyOf): it picks the fill of the details block.
  theme: ThemeFamily
}

export type PaneActions = {
  clearHistory: () => void
  dismissEnded: (id: string) => void
  saveWho: (text: string) => void
  skipWho: () => void
  pick: (id: string, key: string) => void
  focusOther: (id: string) => void
  submitOne: (id: string) => void
  jump: (id: string) => void
  typeOther: (id: string, text: string) => void
  submitOther: (id: string, text: string) => void
  back: () => void
  next: () => void
  submit: () => void
}

// What one question card draws from: the question, the wizard state and whether it is fading out after a press.
type CardContext = {
  question: Question
  wizard: Wizard
  isLeaving: boolean
  held: HeldButtons
  surface: RenderSurface
  theme: ThemeFamily
}

export function renderPane(ui: Ui, view: PaneView, actions: PaneActions, lang: Lang, held: HeldButtons): RenderElement {
  const { Box, Text } = ui
  const { screen } = view
  const tree: TreeContext = { ui, lang, view, actions, held }
  const clearCount = clearableIdsOf(view.history).length
  held.begin()
  // The History block sits under the card, where it changes height as answers are delivered: a Button drawn below a block
  // that grows lost its presses on the desktop (the first click was dropped). The Clear link therefore comes last.
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
      {view.groups.length > 0 && renderTree(tree)}
      {view.askWho && view.questions.length > 0 && renderAskWho(ui, lang, actions, held)}
      {screen !== undefined && renderQuestion(ui, lang, view, actions, screen, held)}
      {view.history.length > 0 && renderHistory(tree, view.history)}
      {view.footer !== undefined && view.questions.length === 0 && renderFooter(ui, view.footer)}
      {clearCount > 0 && renderDivider(ui, view.surface, 'divider-history')}
      {clearCount > 0 && renderHistoryClear(tree, clearCount)}
    </Box>
  )
  held.end()
  return pane
}

// The footer: one muted line under the status lines. Text only, never a row of the tree, and drawn only with no card up.
// The one-time question for the answerer's name: the sentence, a name field and Skip. Drawn above the card until answered.
function renderAskWho(ui: Ui, lang: Lang, actions: PaneActions, held: HeldButtons): RenderElement | false {
  if (!('Input' in ui)) return false
  const { Box, Button, Input, Text } = ui
  const skip = t(lang, 'who.skip')
  return (
    <Box key="ask-who" flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
      <Text>{t(lang, 'who.prompt')}</Text>
      <Input
        key="who-input"
        label={t(lang, 'who.label')}
        placeholder={t(lang, 'who.placeholder')}
        submitLabel={t(lang, 'who.save')}
        onSubmit={text => actions.saveWho(text)}
      />
      {held.hold('who-skip', [skip], () => actions.skipWho(), press => (
        <Button key="who-skip" label={skip} variant="secondary" onPress={press} />
      ))}
    </Box>
  )
}

function renderFooter(ui: Ui, text: string): RenderElement {
  const { Text } = ui
  return <Text key="footer" dimColor>{text}</Text>
}

// What the trees draw from: the view and the language, the actions a row's press runs, and the held table for its Buttons.
type TreeContext = {
  ui: Ui
  lang: Lang
  view: PaneView
  actions: PaneActions
  held: HeldButtons
}

// A row under a session. It is drawn knowing whether its session is the last one: the indent and the "│" differ.
type TreeRow = (isFinal: boolean) => RenderElement
type TreeSession = { key: string; label: string; rows: readonly TreeRow[] }
type TreeBranch = { key: string; label: string; sessions: readonly TreeSession[] }

// The tree of the open questions: every group in turn, one under the other, each with its sessions and their questions.
// Indentation is the Box's paddingLeft, not leading spaces, which a desktop may collapse.
function renderTree(tree: TreeContext): RenderElement {
  const { Box } = tree.ui
  return (
    <Box key="tree" flexDirection="column" gap={1}>
      {tree.view.groups.map(group => renderGroup(tree, group))}
    </Box>
  )
}

// One group of the open questions. Its questions are drawn by renderTreeQuestion.
function renderGroup(tree: TreeContext, group: Group): RenderElement {
  return renderBranch(tree.ui, {
    key: `group-${group.key}`,
    label: groupLabelOf(group.questions[0], tree.lang),
    sessions: group.sessions.flatMap(questions => {
      const [first] = questions
      if (first === undefined) return []
      return [
        {
          key: `session-${first.id}`,
          label: sessionLabelOf(first, tree.lang),
          rows: questions.map(question => (isFinal: boolean) => renderTreeQuestion(tree, question, isFinal)),
        },
      ]
    }),
  })
}

// A branch of a tree: its label in bold, then its sessions. The last session is drawn "└", the others "├".
function renderBranch(ui: Ui, branch: TreeBranch): RenderElement {
  const { Box, Text } = ui
  const lastSession = branch.sessions.length - 1
  return (
    <Box key={branch.key} flexDirection="column">
      <Text bold>{branch.label}</Text>
      {branch.sessions.map((session, index) => renderBranchSession(ui, session, index === lastSession))}
    </Box>
  )
}

// One session of a branch: its row ("├ " or, for the last one, "└ "), then its rows under it.
function renderBranchSession(ui: Ui, session: TreeSession, isFinal: boolean): RenderElement {
  const { Box, Text } = ui
  return (
    <Box key={session.key} flexDirection="column">
      <Box paddingLeft={1}>
        <Text>{`${isFinal ? '└' : '├'} ${session.label}`}</Text>
      </Box>
      {session.rows.map(row => row(isFinal))}
    </Box>
  )
}

// The History tree under the card: the answers of the last while, drawn with the same branches as the open tree.
function renderHistory(tree: TreeContext, history: readonly HistoryGroup[]): RenderElement {
  const { Box, Text } = tree.ui
  return (
    <Box key="history" flexDirection="column">
      <Text bold>{t(tree.lang, 'history.heading')}</Text>
      <Box flexDirection="column" gap={1}>
        {history.map(group =>
          renderBranch(tree.ui, {
            key: `history-group-${group.key}`,
            label: group.label,
            sessions: group.sessions.map(session => ({
              key: `history-session-${session.key}`,
              label: session.label,
              rows: session.entries.map(entry => (isFinal: boolean) => renderHistoryEntry(tree.ui, entry, isFinal)),
            })),
          }),
        )}
      </Box>
    </Box>
  )
}

// One answer's row: the ○ every history row carries, as a waiting question row does, and its question's title. Its line
// sits under the title, dim, starting in the title's column.
function renderHistoryEntry(ui: Ui, entry: HistoryEntry, isFinal: boolean): RenderElement {
  const { Box, Text } = ui
  return (
    <Box key={`history-${entry.id}`} flexDirection="column" paddingLeft={isFinal ? 4 : 1}>
      <Box flexDirection="row">
        {!isFinal && <Text>{'│  '}</Text>}
        <Text>{`○ ${entry.title}`}</Text>
      </Box>
      <Text dimColor>{`${isFinal ? '  ' : '│    '}${entry.line}`}</Text>
    </Box>
  )
}

// The Clear button: the last row of the pane, right-aligned, under a divider, drawn as the card's Back button is (a
// secondary Button). Its press clears every row that can go.
function renderHistoryClear(tree: TreeContext, count: number): RenderElement {
  const { ui, held, lang, actions } = tree
  const { Box, Button } = ui
  const label = `${t(lang, 'history.clear')} (${count})`
  return (
    <Box key="history-clear-row" flexDirection="row" justifyContent="flex-end">
      {held.hold('history-clear', [label], () => actions.clearHistory(), press => (
        <Button key="history-clear" label={label} variant="secondary" onPress={press} />
      ))}
    </Box>
  )
}

// One question under its session: "│  " before the mark under a session that is not the last one, nothing under the last.
// The indent is the Box's paddingLeft, so the mark sits in the same column under either session. The row is a link
// (treeLink): its press jumps to the question's card (actions.jump), as walking there with Next or Back would. Its text
// is bold while the card on screen is that question.
// One question row of the tree: its link, then, once the question has a pick not yet submitted, " ✓ - " and its own
// Submit link. The one mark before the text is the state: on screen (●) or waiting (○); no link mark joins it.
export function renderTreeQuestion(tree: TreeContext, question: Question, isFinal: boolean): RenderElement {
  const { ui, view, actions, held } = tree
  const { Box, Text } = ui
  const isOnScreen = view.screen?.question.id === question.id
  const isPicked = view.wizard.picks[question.id] !== undefined
  return (
    <Box key={`tree-${question.id}`} paddingLeft={isFinal ? 4 : 1} flexDirection="row">
      {treeLink(ui, held, {
        key: `tree-jump-${question.id}`,
        lead: isFinal ? '' : '│  ',
        mark: isOnScreen ? '●' : '○',
        label: questionLabel(question),
        href: linkHref('jump', question.id),
        bold: isOnScreen,
        onPress: () => actions.jump(question.id),
      })}
      {isPicked && <Text>{' ✓ - '}</Text>}
      {isPicked && renderTreeSubmit(tree, question)}
    </Box>
  )
}

// The Submit of one tree row: it answers that question alone, at once (a link, or the plain Button).
function renderTreeSubmit(tree: TreeContext, question: Question): RenderElement {
  const { ui, held, lang, actions } = tree
  return treeLink(ui, held, {
    key: `tree-submit-${question.id}`,
    lead: '',
    label: t(lang, 'tree.submit'),
    href: linkHref('submit', question.id),
    bold: false,
    onPress: () => actions.submitOne(question.id),
  })
}

// A tree link, in two forms. Where the surface draws Markdown: the lead, one mark and the link, which a press answers
// through onLinkPress; pressableLinks names only this href, so no other link is answered. The mark is the row's state
// mark (`mark`: ● on screen, ○ waiting) where the row has one, else the dim link mark; a row never carries both. Else
// the underlined plain Button these rows were before, with the state mark and no link mark. Both keep their press handle
// across redraws (held).
type TreeLink = { key: string; lead: string; mark?: string; label: string; href: string; bold: boolean; onPress: () => void }

function treeLink(ui: Ui, held: HeldButtons, link: TreeLink): RenderElement {
  const { Button, Text } = ui
  if (!('Markdown' in ui)) {
    const text = `${link.lead}${link.mark === undefined ? '' : `${link.mark} `}${link.label}`
    return held.hold(link.key, [text, link.bold], link.onPress, press => (
      <Button key={link.key} label={text} plain onPress={press}>
        <Text underline bold={link.bold}>{text}</Text>
      </Button>
    ))
  }
  const { Markdown } = ui
  const anchor = `[${escapeMarkdown(link.label)}](${link.href})`
  const text = `${link.lead}${link.mark ?? LINK_MARK} ${link.bold ? `**${anchor}**` : anchor}`
  return held.hold(link.key, [text], link.onPress, press => (
    <Markdown key={link.key} text={text} pressableLinks={[link.href]} onLinkPress={press} />
  ))
}

// The address of a tree link. A link the plugin answers never opens; the scheme only has to be one a surface draws.
const linkHref = (action: 'jump' | 'submit', id: string): string =>
  `file:///askaway/${action}/${encodeURIComponent(id).replace(/\(/g, '%28').replace(/\)/g, '%29')}`

// The tradeoff under an option starts with a capital letter, whatever the agent wrote.
const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

// The line under an option: its tradeoff, then its fit after a dot. Either part may be missing; with neither, no line.
const tradeoffLineOf = (lang: Lang, option: QuestionOption): string | undefined => {
  const parts = [
    option.tradeoff === undefined ? undefined : capitalized(option.tradeoff),
    typeof option.fit === 'number' ? t(lang, 'option.fit', { n: option.fit }) : undefined,
  ].filter((part): part is string => part !== undefined)
  return parts.length > 0 ? `${BRANCH_PREFIX}${parts.join(' · ')}` : undefined
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

// The branch glyph that opens each sub-row under an option, and the field under "Other…".
const BRANCH_PREFIX = '└ '

// An option answers to its key letter in lower case; a key that is not one letter draws no hotkey.
const optionHotkey = (key: string): string | undefined => (/^[a-z]$/i.test(key) ? key.toLowerCase() : undefined)

// Back, Next and Submit take the first free letters of their surface's pool, in that order. A letter that an option key
// or Other… uses on this card is skipped, so no shortcut clashes with an option. The terminal pool avoids b, n and s, because
// option B, N and S would clash with them; the desktop keeps p and f while no option uses them. A surface not listed draws none.
type NavKey = 'back' | 'next' | 'submit'
const NAV_ORDER: readonly NavKey[] = ['back', 'next', 'submit']
const NAV_POOLS: Partial<Record<RenderSurface, readonly string[]>> = {
  terminal: ['z', 'x', 'w'],
  desktop: ['p', 'f', 'w', 'z', 'x'],
}

const letterFor = (card: CardContext, key: NavKey): string | undefined => {
  const taken = [...card.question.options.map(option => option.key.toLowerCase()), otherLetterOf(card.question.options)]
  const free = (NAV_POOLS[card.surface] ?? []).filter(letter => !taken.includes(letter))
  return free[NAV_ORDER.indexOf(key)]
}

// One question on screen: the title in bold with the risk and age beside it, the Urgency box under it (when set), the first
// block (What it is and The problem, plain paragraphs), then the details block: the "Askaway Details:" title and Analogy,
// Why to Context. Then the question, the dim lead line under it, the options with their tradeoff, fit, what happens,
// pros and cons, and "Other…". Then a separator, and the Back / Next or Submit all row. One blank line sits under it.
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
    held,
    surface: view.surface,
    theme: view.theme,
  }
  const { isLeaving } = card
  const isEnded = view.ended.includes(question.id)
  const details = sectionsOf(lang, question, 'details')
  return (
    <Box key={`card-${question.id}`} flexDirection="column" gap={1} borderStyle="round" borderDimColor={isLeaving} paddingX={1} paddingBottom={1}>
      <Box flexDirection="row" flexWrap="wrap" gap={2}>
        <Text bold dimColor={isLeaving}>{questionLabel(question)}</Text>
        <Text dimColor>{`${riskLabel(lang, question.risk)} · ${ageLabel(lang, question.ts, view.now)}`}</Text>
      </Box>
      {renderUrgency(ui, lang, question, isLeaving)}
      {renderFirstBlock(ui, question, isLeaving)}
      {details.length > 0 && renderDetailsBlock(ui, lang, card, details)}
      <Box flexDirection="column">
        <Text bold dimColor={isLeaving}>{question.question}</Text>
        <Text dimColor>{leadOf(lang, question)}</Text>
      </Box>
      {isEnded ? (
        <Text key={`ended-${question.id}`}>{t(lang, 'card.ended', { key: question.recommended })}</Text>
      ) : (
        <Box flexDirection="column" gap={2} marginTop={1}>
          {question.options.map(option => renderOption(ui, lang, actions, card, option))}
          {renderOther(ui, lang, actions, card)}
        </Box>
      )}
      {renderDivider(ui, view.surface, 'divider-nav')}
      {isEnded ? renderEndedNav(ui, lang, actions, card, screen) : renderNav(ui, lang, actions, card, screen)}
    </Box>
  )
}

// The fill props of the details block: the fill of its theme family, or none for an unresolved theme (auto, custom:<slug>),
// so the engine's own theme shows through and the block carries no backgroundColor at all.
function detailsFillProps(theme: ThemeFamily): { backgroundColor?: string } {
  return theme === 'unknown' ? {} : { backgroundColor: DETAILS_FILL[theme] }
}

// The details block: the "Askaway Details:" title line (the mark, then the text in bold), then the sections (Analogy,
// Why to Context). It has no border: its fill is the fill of the card's theme family (DETAILS_FILL), none when the theme is
// unresolved, and its padding keeps the text off the fill's edge. The title is the block's first child.
function renderDetailsBlock(ui: Ui, lang: Lang, card: CardContext, sections: Section[]): RenderElement {
  const { Box, Text } = ui
  const { question, isLeaving, surface, theme } = card
  return (
    <Box key={`details-${question.id}`} flexDirection="column" gap={1} {...detailsFillProps(theme)} paddingX={1} paddingY={1}>
      <Box key="details-title" flexDirection="row" alignItems="center" gap={1}>
        {renderLogo(ui, surface)}
        <Text bold dimColor={isLeaving}>{t(lang, 'details.title')}</Text>
      </Box>
      {sections.map(section => renderSection(ui, section, isLeaving))}
    </Box>
  )
}

// A divider rule: a 1px SVG rule on the desktop, a row of '─' on the terminal. It separates the options from the nav row,
// and the history from its Clear link.
function renderDivider(ui: Ui, surface: RenderSurface, key: string): RenderElement {
  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    return <Svg key={key} source={dividerSvg(DIVIDER_PX)} alt="divider" height={DIVIDER_HEIGHT} />
  }
  const { Text } = ui
  return <Text key={key} dimColor>{'─'.repeat(DIVIDER_COLUMNS)}</Text>
}

// The Urgency line under the title: its bold title in the default colour, its text in the colour of its grade (URGENCY_COLOR).
function renderUrgency(ui: Ui, lang: Lang, question: Question, isLeaving: boolean): RenderElement | false {
  const [section] = sectionsOf(lang, question, 'before-options')
  if (section === undefined) return false
  const { Box, Text } = ui
  return (
    <Box key="explanation-before-options" flexDirection="column">
      <Text dimColor={isLeaving}>
        <Text bold>{`${section.heading}: `}</Text>
        <Text color={URGENCY_COLOR[urgencyGradeOf(question)]}>{section.body}</Text>
      </Text>
    </Box>
  )
}

// The first block of the card: What it is and The problem as two plain paragraphs, one blank line between them and no
// heading (firstBlockOf). Nothing is drawn when neither field is set.
function renderFirstBlock(ui: Ui, question: Question, isLeaving: boolean): RenderElement | false {
  const paragraphs = firstBlockOf(question)
  if (paragraphs.length === 0) return false
  const { Box, Text } = ui
  return (
    <Box key="explanation-before-question" flexDirection="column" gap={1}>
      {paragraphs.map((paragraph, index) => (
        <Text key={`paragraph-${index}`} dimColor={isLeaving}>
          {renderBody(ui, paragraph)}
        </Text>
      ))}
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
  const hotkey = optionHotkey(option.key)
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

// "Other…": the last row under the options, a plain link drawn with its letter, "C · Other…" (otherLetterOf). Its field
// sits on the row under it, under the same "└ " branch glyph the option sub-rows draw. The field is always open, ready to
// type; the link only focuses it. Typing keeps the text in the pane's memory (typeOther), with no redraw; the register
// records it as the Other pick when the field loses focus, on Enter (submitOther) or before a nav action, and the card
// stays where it is. The field keeps its own text. The link is bold once Other is the pick; the typed text is not drawn
// again under it. A surface with no Input (mobile) draws no field, so no Other option either.
function renderOther(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext): RenderElement | false {
  if (!('Input' in ui)) return false
  const { Box, Button, Input, Text } = ui
  const { question, isLeaving, wizard, held } = card
  const isChosen = wizard.picks[question.id]?.key === OTHER_KEY
  const key = `other-${question.id}`
  const letter = otherLetterOf(question.options)
  const linkText = t(lang, 'option.other')
  const label = letter === undefined ? linkText : `${letter.toUpperCase()} · ${linkText}`
  const hotkey = letter
  const onPress = () => {
    if (isLeaving) return
    actions.focusOther(question.id)
  }
  return (
    <Box key={`other-row-${question.id}`} flexDirection="column">
      {held.hold(key, [label, isChosen, isLeaving, hotkey], onPress, press => (
        <Button key={key} label={label} plain dimColor={isLeaving} hotkey={hotkey} onPress={press}>
          <Text dimColor>{`${LINK_MARK} `}</Text>
          <Text underline bold={isChosen} dimColor={isLeaving}>{label}</Text>
        </Button>
      ))}
      {!isLeaving && (
        <Box flexDirection="row" paddingLeft={1}>
          <Text dimColor={isLeaving}>{BRANCH_PREFIX}</Text>
          <Box flexGrow={1}>
            <Input
              key={`${OTHER_INPUT_PREFIX}${question.id}`}
              placeholder={t(lang, 'input.placeholder')}
              submitLabel={t(lang, 'input.send')}
              onInput={text => actions.typeOther(question.id, text)}
              onSubmit={text => actions.submitOther(question.id, text)}
            />
          </Box>
        </Box>
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

// The nav row of an ended card: Back, Dismiss (removes the question) and Next. Next is on while a later question exists in
// the group; nothing waits for a pick, because no answer can be sent.
function renderEndedNav(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext, screen: Screen): RenderElement {
  const { Box, Button } = ui
  const { question, isLeaving, held } = card
  const isBackOff = !screen.canBack || isLeaving
  const backLabel = t(lang, 'nav.back')
  const dismissLabel = t(lang, 'card.dismiss')
  return (
    <Box key={`nav-${question.id}`} flexDirection="row" justifyContent="space-between">
      {held.hold('nav-back', [backLabel, isBackOff, undefined], () => !isBackOff && actions.back(), press => (
        <Button key="nav-back" label={backLabel} variant="secondary" dimColor={isBackOff} onPress={press} />
      ))}
      {held.hold('dismiss-ended', [dismissLabel, question.id], () => actions.dismissEnded(question.id), press => (
        <Button key="dismiss-ended" label={dismissLabel} variant="secondary" onPress={press} />
      ))}
      {renderNext(ui, lang, actions, card, screen)}
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
  // The press goes through even while the button is drawn off: an Other text typed but not recorded yet (no Enter, no
  // blur) is recorded by the submit action first, and submitGroup checks again that every question has a pick.
  const onPress = () => {
    if (card.isLeaving) return
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

// The text of an explanation, with every command, skill or agent name the agent wrote drawn in bold (piecesOf).
function renderBody(ui: Ui, body: string): (RenderElement | string)[] {
  const { Text } = ui
  return piecesOf(body).map((piece, index) =>
    piece.isName ? (
      <Text key={`name-${index}`} bold>
        {piece.text}
      </Text>
    ) : (
      piece.text
    ),
  )
}

// One section of the details, on one wrapping line: the heading in bold, a colon, then the text (renderBody).
function renderSection(ui: Ui, section: Section, isLeaving: boolean): RenderElement {
  const { Text } = ui
  return (
    <Text key={`section-${section.heading}`} dimColor={isLeaving}>
      <Text bold>{`${section.heading}: `}</Text>
      {renderBody(ui, section.body)}
    </Text>
  )
}
