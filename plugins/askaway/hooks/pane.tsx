// The Askaway pane: the header, the tree of the open questions (every group in turn, one under the other, with its
// sessions and questions), the question card (one question at a time; Submit all on the last one of its group) and the
// status lines of the answers. Everything is drawn from data handed in; the pane never reads state or writes it. Every
// callback it receives is a handler; the register supplies them, and the held table keeps each Button's press handle.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { Question, QuestionOption } from '../types'
import { t, type Lang } from './i18n'
import type { HeldButtons } from './held'
import { DIVIDER_COLUMNS, DIVIDER_HEIGHT, DIVIDER_PX, dividerSvg } from './divider'
import { DETAILS_FILL, LINK_MARK, URGENCY_COLOR } from './look'
import { KEEPGLIDE_HEADER_SIZE, KEEPGLIDE_SUBMIT_SIZE, renderHistoryIcon, renderKeepGlide, renderLogo } from './logo-element'
import {
  urgencyGradeOf,
  OTHER_KEY,
  SUBMIT_ALL_KEY,
  ageLabel,
  answerNameOf,
  clearableIdsOf,
  counterText,
  escapeMarkdown,
  firstBlockOf,
  groupLabelOf,
  isRootSession,
  leadOf,
  localizedQuestion,
  optionLabelOf,
  otherApplyKey,
  otherButtonKey,
  otherInputKey,
  otherLetterOf,
  piecesOf,
  questionLabel,
  recommendedMarkOf,
  riskLabel,
  sectionsOf,
  sessionLabelOf,
  singleLine,
  type HistoryEntry,
  type HistoryGroup,
  type Leaving,
  type Section,
  OTHER_MIN_ROWS,
} from './model'
import { reviewKeyOf, type Group, type Pick, type Screen, type Wizard } from './wizard'

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
  // A move (a pick, Next or Back) ran within the last MOVE_LOCK_MS: its buttons are drawn disabled until it lifts.
  moveLocked: boolean
  // Next on the last question of a group of two or more asked for the review of that question set (reviewKeyOf): it is drawn in
  // place of the card until Back, or until the group's questions change.
  review: string | null
  // The ids of questions whose last submit did not deliver their pick: their card draws the not-delivered line.
  undelivered: readonly string[]
  // The height of each question's Other field, grown with its typed text (otherRowsOf); absent, OTHER_MIN_ROWS.
  otherRows: Readonly<Record<string, number>>
  screen: Screen | undefined
  surface: RenderSurface
  // The footer line (footerText, hooks/model.ts), set by the register only while no question is open.
  footer?: string
  // The ids of open questions whose asking session has ended: their card shows a notice and Dismiss, no options.
  ended: readonly string[]
  // The damaged q/ files that pause their session (register: damagedPauses): each draws a notice with its id and Dismiss.
  // Optional: the register sets it.
  damagedPauses?: readonly string[]
  // Away mode is on (away.json): the counter line says so. Optional: the register sets it.
  away?: boolean
  // True until the person gave a name or skipped: the pane then asks for it above the card, once.
  askWho: boolean
}

export type PaneActions = {
  clearHistory: () => void
  // Dismiss of an ended card: the prune is forced. Dismiss of a damaged pause: the prune is not (the CLI refuses a question it reads).
  dismissEndedForced: (id: string) => void
  dismissDamagedUnforced: (id: string) => void
  saveWho: (text: string) => void
  skipWho: () => void
  pick: (id: string, choice: Pick) => void
  focusOther: (id: string) => void
  submitOne: (id: string) => void
  jump: (id: string) => void
  typeOther: (id: string, text: string) => void
  keepOther: (id: string, text: string) => void
  applyOther: (id: string) => void
  back: () => void
  next: () => void
  submit: () => void
  leaveReview: () => void
}

// What one question card draws from: the question, the wizard state and whether it is fading out after a press.
type CardContext = {
  question: Question
  // The height of the Other field (renderOther); the review draws no field.
  otherRows?: number
  wizard: Wizard
  isLeaving: boolean
  // The pick of this question was not delivered by the last submit (PaneView.undelivered).
  isUndelivered: boolean
  isMoveLocked: boolean
  held: HeldButtons
  surface: RenderSurface
}

export function renderPane(ui: Ui, view: PaneView, actions: PaneActions, lang: Lang, held: HeldButtons): RenderElement {
  const { Box, Text } = ui
  const { screen } = view
  const tree: TreeContext = { ui, lang, view, actions, held }
  const clearCount = clearableIdsOf(view.history).length
  held.begin()
  // A Button drawn below a block that changes height lost its presses on the desktop (the first click was dropped), so the
  // History's Clear all sits right under the header, above the tree and the card, where nothing above it moves.
  const pane = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          {renderLogo(ui, view.surface)}
          <Text bold>{t(lang, 'pane.heading')}</Text>
        </Box>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text>{`${counterText(lang, view.questions)}${view.away ? t(lang, 'list.awayOn') : ''}`}</Text>
          {renderKeepGlide(ui, view.surface, 'keepglide-counter', KEEPGLIDE_HEADER_SIZE)}
        </Box>
      </Box>
      {clearCount > 0 && renderHistoryClear(tree, clearCount)}
      {clearCount > 0 && renderDivider(ui, view.surface, 'divider-history')}
      {view.groups.length > 0 && renderTree(tree)}
      {view.askWho && view.questions.length > 0 && renderAskWho(ui, lang, actions, held)}
      {view.damagedPauses?.map(id => renderDamagedPause(ui, lang, actions, held, id))}
      {screen !== undefined &&
        (reviewDrawnOf(view, screen)
          ? renderReview(ui, lang, view, actions, screen, held)
          : renderQuestion(ui, lang, view, actions, screen, held))}
      {view.history.length > 0 && renderHistory(tree, view.history)}
      {view.footer !== undefined && view.questions.length === 0 && renderFooter(ui, view.footer)}
    </Box>
  )
  held.end()
  return pane
}

// A damaged q/ file that pauses its session: a notice that names its id, with Dismiss (prune --id removes the file, unless the CLI
// reads it as a question and refuses). It is drawn above the card until a poll no longer lists the file.
function renderDamagedPause(ui: Ui, lang: Lang, actions: PaneActions, held: HeldButtons, id: string): RenderElement {
  const { Box, Button, Text } = ui
  const dismissLabel = t(lang, 'card.dismiss')
  const key = `dismiss-damaged-${id}`
  return (
    <Box key={`damaged-${id}`} flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
      <Text>{t(lang, 'damaged.pause', { id })}</Text>
      {held.hold(key, [dismissLabel, id], () => actions.dismissDamagedUnforced(id), press => (
        <Button key={key} label={dismissLabel} variant="secondary" onPress={press} />
      ))}
    </Box>
  )
}

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

// The footer: one line under the status lines, drawn without dim (M68, the owner's rule; the dim ratios are in look.ts). Text only, never
// a row of the tree, and drawn only with no card up.
function renderFooter(ui: Ui, text: string): RenderElement {
  const { Text } = ui
  return <Text key="footer">{text}</Text>
}

// What the trees draw from: the view and the language, the actions a row's press runs, and the held table for its Buttons.
type TreeContext = {
  ui: Ui
  lang: Lang
  view: PaneView
  actions: PaneActions
  held: HeldButtons
}

// Where a row sits: its lead ("│  " under a session that is not the last one, else none) and the indent of its Box.
type RowPlace = { lead: string; indent: number }
// A row under a session, drawn at its place.
type TreeRow = (place: RowPlace) => RenderElement
// A session of a branch. The root session of a family (`isRoot`: its Desktop session is the family root) draws no row of its own: its
// rows sit right under the group's label, before the derived sessions, so the family's title is never drawn twice.
// `href`: a Desktop session id (local_<uuid>) the label links to, as "#<id>", where the surface draws Markdown; the
// surface opens it itself. Absent, the label is plain text.
type TreeSession = { key: string; label: string; isRoot: boolean; href?: string; rows: readonly TreeRow[] }
type TreeBranch = { key: string; label: string; href?: string; sessions: readonly TreeSession[] }
const ROOT_PLACE: RowPlace = { lead: '', indent: 1 }
export const placeUnder = (isFinal: boolean): RowPlace => (isFinal ? { lead: '', indent: 4 } : { lead: '│  ', indent: 1 })

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
          isRoot: isRootSession(first),
          rows: questions.map(question => (place: RowPlace) => renderTreeQuestion(tree, question, place)),
        },
      ]
    }),
  })
}

// A branch of a tree: its label in bold, the rows of its root session right under it, then the derived sessions. The last
// derived session is drawn "└", the others "├".
function renderBranch(ui: Ui, branch: TreeBranch): RenderElement {
  const { Box, Text } = ui
  const derived = branch.sessions.filter(session => !session.isRoot)
  const lastSession = derived.length - 1
  return (
    <Box key={branch.key} flexDirection="column">
      {sessionLink(ui, branch.href, branch.label, true) ?? <Text bold>{branch.label}</Text>}
      {branch.sessions.filter(session => session.isRoot).map(session => renderRootRows(ui, session))}
      {derived.map((session, index) => renderBranchSession(ui, session, index === lastSession))}
    </Box>
  )
}

// A label linked to a Desktop session, "[label](#<id>)", bold for a group's label, after its lead ("├ " or "└ "), where
// the surface draws Markdown and the id is known; else undefined, and the caller draws the plain label.
function sessionLink(ui: Ui, href: string | undefined, label: string, bold: boolean, lead = ''): RenderElement | undefined {
  if (href === undefined || !('Markdown' in ui)) return undefined
  const { Markdown } = ui
  const anchor = `[${escapeMarkdown(label)}](#${href})`
  return <Markdown text={`${lead}${bold ? `**${anchor}**` : anchor}`} />
}

// The rows of a family's root session: no session row, each row one step under the group's label.
function renderRootRows(ui: Ui, session: TreeSession): RenderElement {
  const { Box } = ui
  return (
    <Box key={session.key} flexDirection="column">
      {session.rows.map(row => row(ROOT_PLACE))}
    </Box>
  )
}

// One derived session of a branch: its row ("├ " or, for the last one, "└ "), then its rows under it.
function renderBranchSession(ui: Ui, session: TreeSession, isFinal: boolean): RenderElement {
  const { Box, Text } = ui
  return (
    <Box key={session.key} flexDirection="column">
      <Box paddingLeft={1}>
        {sessionLink(ui, session.href, session.label, false, `${isFinal ? '└' : '├'} `) ?? (
          <Text>{`${isFinal ? '└' : '├'} ${session.label}`}</Text>
        )}
      </Box>
      {session.rows.map(row => row(placeUnder(isFinal)))}
    </Box>
  )
}

// The History tree under the card: the answers of the last while, drawn as the open tree is: the heading row with the
// logo, a blank line, then the same branches.
function renderHistory(tree: TreeContext, history: readonly HistoryGroup[]): RenderElement {
  const { Box, Text } = tree.ui
  // Only the Desktop opens a session from a link: the terminal draws the History's labels plain.
  const linked = tree.view.surface === 'desktop'
  return (
    <Box key="history" flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        {renderHistoryIcon(tree.ui, tree.view.surface)}
        <Text bold>{t(tree.lang, 'history.heading')}</Text>
      </Box>
      <Box flexDirection="column" gap={1}>
        {history.map(group =>
          renderBranch(tree.ui, {
            key: `history-group-${group.key}`,
            label: group.label,
            href: linked ? group.href : undefined,
            sessions: group.sessions.map(session => ({
              key: `history-session-${session.key}`,
              label: session.label,
              isRoot: session.isRoot,
              href: linked ? session.href : undefined,
              rows: session.entries.map(entry => (place: RowPlace) => renderHistoryEntry(tree.ui, entry, place)),
            })),
          }),
        )}
      </Box>
    </Box>
  )
}

// One answer's row, one line of plain text: the ○ every history row carries, the question's whole title, " ✓ " and the answer
// line (the option's label, then the times). No session link: the group's header above carries it. The text wraps, never cut.
function renderHistoryEntry(ui: Ui, entry: HistoryEntry, place: RowPlace): RenderElement {
  const { Box, Text } = ui
  return (
    <Box key={`history-${entry.id}`} paddingLeft={place.indent}>
      <Text>{`${place.lead}○ ${entry.title} ✓ ${entry.line}`}</Text>
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
export function renderTreeQuestion(tree: TreeContext, question: Question, place: RowPlace): RenderElement {
  const { ui, view, actions, held, lang } = tree
  const { Box, Text } = ui
  const isOnScreen = view.screen?.question.id === question.id
  const isPicked = view.wizard.picks[question.id] !== undefined
  return (
    <Box key={`tree-${question.id}`} paddingLeft={place.indent} flexDirection="row">
      {treeLink(ui, held, {
        key: `tree-jump-${question.id}`,
        lead: place.lead,
        mark: isOnScreen ? '●' : '○',
        label: questionLabel(localizedQuestion(question, lang)),
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
// the underlined plain Button these rows were before, with the same mark as the Markdown form: the state mark where the row
// has one, else the link mark (a Submit row). Both keep their press handle
// across redraws (held).
type TreeLink = { key: string; lead: string; mark?: string; label: string; href: string; bold: boolean; onPress: () => void }

function treeLink(ui: Ui, held: HeldButtons, link: TreeLink): RenderElement {
  const { Button, Text } = ui
  if (!('Markdown' in ui)) {
    const text = `${link.lead}${link.mark ?? LINK_MARK} ${link.label}`
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

// The terminal draws a Button's label alone, not its hotkey, so its letter goes into the label: "← Back (z)". The desktop
// draws the hotkey itself and keeps the label as it is.
const navLabelOf = (card: CardContext, key: NavKey, label: string): string => {
  const letter = letterFor(card, key)
  return card.surface === 'terminal' && letter !== undefined ? `${label} (${letter})` : label
}

// The letter an option or the Other link draws before its label ("A · "). The desktop draws a Button's hotkey as its own
// letter chip, so there the letter is left out when the Button has a hotkey; the terminal draws no hotkey, so the letter stays.
const letterPrefixOf = (card: CardContext, letter: string, hotkey: string | undefined): string =>
  card.surface === 'desktop' && hotkey !== undefined ? '' : `${letter} · `

// The answer state a forward or Back label shows first: "Answer: D · Next →" once the card's question has a pick, else
// "No answer · Next →". The answer is always the letter: an option's key, or the Other row's letter for an Other pick, never
// the label or the typed text. A pick with no letter (Other past z) reads as no answer.
const answerLabelOf = (lang: Lang, card: CardContext, label: string): string => {
  const pick: Pick | undefined = card.wizard.picks[card.question.id]
  const letter = pick?.key === OTHER_KEY ? otherLetterOf(card.question.options) : pick?.key
  const state = letter === undefined ? t(lang, 'nav.noAnswer') : t(lang, 'nav.answer', { key: letter.toUpperCase() })
  return `${state} · ${label}`
}

// One question on screen: the title row (renderTitleRow), the Urgency box under it (when set), the first
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
  const question = localizedQuestion(screen.question, lang)
  const card: CardContext = {
    question,
    wizard: view.wizard,
    isLeaving: view.leaving[question.id] !== undefined,
    isUndelivered: view.undelivered.includes(question.id),
    otherRows: view.otherRows[question.id] ?? OTHER_MIN_ROWS,
    isMoveLocked: view.moveLocked,
    held,
    surface: view.surface,
  }
  const { isLeaving } = card
  const isEnded = view.ended.includes(question.id)
  const drawsFitHint = question.options.some(option => typeof option.fit === 'number')
  const details = sectionsOf(lang, question, 'details')
  return (
    <Box key={`card-${question.id}`} flexDirection="column" gap={1} borderStyle="round" borderDimColor={isLeaving} paddingX={1} paddingBottom={1}>
      {renderTitleRow(ui, lang, question, isLeaving, view.now, view.surface)}
      {renderUrgency(ui, lang, question, isLeaving)}
      {renderFirstBlock(ui, question, isLeaving)}
      {details.length > 0 && renderDetailsBlock(ui, lang, card, details)}
      <Box flexDirection="column">
        <Text bold dimColor={isLeaving}>{question.question}</Text>
        {!isEnded && <Text dimColor>{leadOf(lang, question, view.now)}</Text>}
        {!isEnded && drawsFitHint && <Text dimColor={isLeaving}>{t(lang, 'option.fitHint')}</Text>}
      </Box>
      {isEnded ? (
        <Text key={`ended-${question.id}`}>{t(lang, 'card.ended', { key: question.recommended })}</Text>
      ) : (
        <Box flexDirection="column" gap={2} marginTop={1}>
          {question.options.map(option => renderOption(ui, lang, actions, card, option))}
          {renderOther(ui, lang, actions, card)}
        </Box>
      )}
      {renderUnanswered(ui, lang, card, !isEnded && !isLeaving)}
      {renderDivider(ui, view.surface, 'divider-nav')}
      {isEnded ? renderEndedNav(ui, lang, actions, card, screen) : renderNav(ui, lang, actions, card, screen)}
    </Box>
  )
}

// The details block: the "Askaway Details:" title line (the mark, then the text in bold), then the sections (Analogy,
// Why to Context). It has no border: its fill is the engine's user-message background (DETAILS_FILL), and its padding keeps
// the text off the fill's edge. The title is the block's first child.
function renderDetailsBlock(ui: Ui, lang: Lang, card: CardContext, sections: Section[]): RenderElement {
  const { Box, Text } = ui
  const { question, isLeaving, surface } = card
  return (
    <Box key={`details-${question.id}`} flexDirection="column" gap={1} backgroundColor={DETAILS_FILL} paddingX={1} paddingY={1}>
      <Box key="details-title" flexDirection="row" alignItems="center" gap={1}>
        {renderLogo(ui, surface)}
        <Text bold dimColor={isLeaving}>{t(lang, 'details.title')}</Text>
      </Box>
      {sections.map(section => renderSection(ui, section, isLeaving))}
    </Box>
  )
}

// A divider rule: a 1px SVG rule on the desktop, a row of '─' on the terminal. It separates the options from the nav row,
// and the history from its Clear all button.
function renderDivider(ui: Ui, surface: RenderSurface, key: string): RenderElement {
  if (surface === 'desktop' && 'Svg' in ui) {
    const { Svg } = ui
    return <Svg key={key} source={dividerSvg(DIVIDER_PX)} alt="" height={DIVIDER_HEIGHT} />
  }
  const { Text } = ui
  return <Text key={key} dimColor>{'─'.repeat(DIVIDER_COLUMNS)}</Text>
}

// The title row. Where the surface draws Markdown: one heading line, "### <title> - See session - <risk> · <age>", the
// title a size up from the body, and "See session" a link (in the surface's link look, as the tree rows) to the asking
// session's Desktop window, `#<desktop_session>`. The link and its dashes are left out when the question knows no Desktop
// session, and on the terminal, where no session opens. The surface opens the link itself (no onLinkPress). Else the bold
// title and the dim risk and age side by side.
function renderTitleRow(ui: Ui, lang: Lang, question: Question, isLeaving: boolean, now: number, surface: RenderSurface): RenderElement {
  const { Box, Text } = ui
  const status = `${riskLabel(lang, question.risk)} · ${ageLabel(lang, question.ts, now)}`
  if (!('Markdown' in ui)) {
    return (
      <Box key={`title-${question.id}`} flexDirection="row" flexWrap="wrap" gap={2}>
        <Text bold dimColor={isLeaving}>{questionLabel(question)}</Text>
        <Text dimColor>{sessionLabelOf(question, lang)}</Text>
        <Text dimColor>{status}</Text>
      </Box>
    )
  }
  const { Markdown } = ui
  const session = question.desktop_session === undefined || surface === 'terminal' ? [] : [`[${t(lang, 'card.session')}](#${question.desktop_session})`]
  const text = `### ${[escapeMarkdown(questionLabel(question)), ...session, status].join(' - ')}`
  return <Markdown key={`title-${question.id}`} text={text} dimColor={isLeaving} />
}

// The Urgency line under the title: its bold title in the default colour, its text in the colour of its grade (URGENCY_COLOR).
// When the question sets its grade (urgency_level), the title names it too ("Urgency (high):"), so the grade is not colour alone.
function renderUrgency(ui: Ui, lang: Lang, question: Question, isLeaving: boolean): RenderElement | false {
  const [section] = sectionsOf(lang, question, 'before-options')
  if (section === undefined) return false
  const { Box, Text } = ui
  const heading = question.urgency_level === undefined ? section.heading : `${section.heading} (${t(lang, `urgency.grade.${question.urgency_level}`)})`
  return (
    <Box key="explanation-before-options" flexDirection="column">
      <Text dimColor={isLeaving}>
        <Text bold>{`${heading}: `}</Text>
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

// A full-width option, headed by its key letter ("A · label" on the terminal; the desktop draws the letter as the hotkey chip,
// letterPrefixOf), its tradeoff and fit under it, then what happens, its pros
// and its cons. The picked one is the primary button and its label starts "✓ " (the pick is not colour alone); the
// recommended one, the one whose key is the recommended key, when not picked, is bold and says "(Recommended)" in its text,
// once: a marker the agent wrote at the start or the end of the label is not drawn (optionLabelOf, own-1), and a label that is
// only a marker already draws the mark ("A · (Recommended)"). The key and the label are one line each (singleLine), so a line
// break in a label cannot draw a fake option row.
function renderOption(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext, option: QuestionOption): RenderElement {
  const { Box, Button, Text } = ui
  const { question, isLeaving, isMoveLocked, wizard, held } = card
  const isDisabled = isLeaving || isMoveLocked
  // The sub-rows are plain on both surfaces; a leaving card dims them with the rest of it (M58 reverted, 2026-10-21).
  const isSubRowDim = isLeaving
  const isPicked = wizard.picks[question.id]?.key === option.key
  const isRecommended = option.key === question.recommended
  const pickMark = isPicked ? '✓ ' : ''
  const label = optionLabelOf(lang, option)
  const mark = recommendedMarkOf(lang)
  const hotkey = optionHotkey(option.key)
  const text = `${letterPrefixOf(card, singleLine(option.key), hotkey)}${pickMark}${label}${isRecommended && label !== mark ? ` ${mark}` : ''}`
  const isBold = isRecommended && !isPicked
  const key = `opt-${question.id}-${option.key}`
  const tradeoffLine = tradeoffLineOf(lang, option)
  const details = optionDetailsOf(lang, option)
  const onPress = () => {
    if (isDisabled) return
    actions.pick(question.id, { key: option.key })
  }
  return (
    <Box key={`optrow-${question.id}-${option.key}`} flexDirection="column">
      {held.hold(key, [text, isPicked, isBold, isLeaving, isMoveLocked, hotkey], onPress, press => (
        <Button
          key={key}
          label={text}
          variant={isPicked ? 'primary' : 'secondary'}
          dimColor={isDisabled}
          hotkey={hotkey}
          onPress={press}
        >
          {isBold ? <Text bold dimColor={isLeaving}>{text}</Text> : text}
        </Button>
      ))}
      {(tradeoffLine !== undefined || details.length > 0) && (
        <Box flexDirection="column" paddingLeft={1}>
          {tradeoffLine !== undefined && <Text dimColor={isSubRowDim}>{tradeoffLine}</Text>}
          {details.map(([label, text]) => (
            <Text key={label} dimColor={isSubRowDim}>
              <Text bold>{`${label}: `}</Text>
              {text}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

// "Other…": the last row under the options, a plain link drawn with its letter, "C · Other…" (otherLetterOf; the desktop draws
// the letter as the hotkey chip). Its field sits on the row under it, under the same "└ " branch glyph the option sub-rows
// draw, and its Apply button sits under the field. The field is always open, ready to type. Typing keeps the text in the
// pane's memory (typeOther), with no redraw. Keep (Enter, or the field's Apply button)
// moves the text to the link, which then draws "C · <label>", picks it and empties the field; the focus goes to the link.
// A press on the link with a label picks it, else it only focuses the field. Text typed and not kept is recorded as the
// pick when the field loses focus or before a nav action. A pick never moves the card. The link is bold once Other is the
// pick, and with a kept label that is the pick it is the primary button (see isKeptChosen). A surface with no Input
// (mobile) draws no field, so no Other option either.
function renderOther(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext): RenderElement | false {
  if (!('Input' in ui)) return false
  const { Box, Button, Input, Text } = ui
  const { question, isLeaving, isMoveLocked, wizard, held } = card
  const isDisabled = isLeaving || isMoveLocked
  const pick = wizard.picks[question.id]
  const kept: string | undefined = wizard.labels[question.id]
  // With a kept label, the Other button is chosen only for that text: the drawn label and the pick never disagree.
  const isChosen = pick?.key === OTHER_KEY && (kept === undefined || pick.text === kept)
  const key = otherButtonKey(question.id)
  const letter = otherLetterOf(question.options)
  const linkText = kept === undefined ? t(lang, 'option.other') : singleLine(kept)
  const bareLabel = letter === undefined ? linkText : `${letterPrefixOf(card, letter.toUpperCase(), letter)}${linkText}`
  // A chosen kept label is drawn as a picked option is: the primary button, its label starting "✓ ", bold. Unpicked, or with
  // no label, it stays the plain link.
  const isKeptChosen = isChosen && kept !== undefined
  const label = isKeptChosen ? `✓ ${bareLabel}` : bareLabel
  const hotkey = letter
  const onPress = () => {
    if (isDisabled) return
    if (kept === undefined) actions.focusOther(question.id)
    else actions.pick(question.id, { key: OTHER_KEY, text: kept })
  }
  const applyKey = otherApplyKey(question.id)
  const applyLabel = t(lang, 'input.send')
  const onApply = () => {
    if (isDisabled) return
    actions.applyOther(question.id)
  }
  return (
    <Box key={`other-row-${question.id}`} flexDirection="column">
      {held.hold(key, [label, isChosen, isLeaving, isMoveLocked, hotkey], onPress, press => (
        <Button
          key={key}
          label={label}
          plain={isKeptChosen ? undefined : true}
          variant={isKeptChosen ? 'primary' : 'secondary'}
          dimColor={isDisabled}
          hotkey={hotkey}
          onPress={press}
        >
          {!isKeptChosen && <Text dimColor>{`${LINK_MARK} `}</Text>}
          <Text underline={!isKeptChosen} bold={isChosen} dimColor={isLeaving}>{label}</Text>
        </Button>
      ))}
      {/* The branch glyph stays on the field's first row however tall the field grows; the field runs to the pane's edge.
          Input takes no width: its Box is a column so the field stretches across it, where a row leaves it at its own size. */}
      {!isLeaving && (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="flex-start" width="100%" paddingLeft={1}>
            <Text dimColor={isLeaving}>{BRANCH_PREFIX}</Text>
            {/* overflow hidden: while the field has focus the engine draws its own submit button past the pane's edge. */}
            <Box flexDirection="column" alignItems="stretch" flexGrow={1} flexShrink={1} width="100%" overflow="hidden">
              <Input
                key={otherInputKey(question.id, wizard.fieldRound)}
                placeholder={t(lang, 'input.placeholder')}
                submitLabel={t(lang, 'input.enter')}
                rows={card.otherRows ?? OTHER_MIN_ROWS}
                onInput={text => actions.typeOther(question.id, text)}
                onSubmit={text => actions.keepOther(question.id, text)}
              />
            </Box>
          </Box>
          {/* Apply sits under the field, at the field's indent: one cell, then the branch glyph's width. */}
          <Box flexDirection="row" paddingLeft={1 + BRANCH_PREFIX.length}>
            {held.hold(applyKey, [applyLabel, isDisabled], onApply, press => (
              <Button key={applyKey} label={applyLabel} variant="secondary" dimColor={isDisabled} onPress={press} />
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

// The text of a status row with no line. A non-breaking space keeps the row's height, so the card does not move when the
// unanswered line comes or goes above the separator.
const STATUS_BLANK = '\u00a0'

// The warning line above the nav while the question's pick was not delivered by the last submit (the pick stays a draft:
// press Submit all again), or while it has no pick but a kept Other label (a draft that lost its pick), which names the
// Other letter to press. A question with no pick and no kept label draws a blank row. The row is always drawn: blank when
// shown is false (an ended or fading card), or when the question is picked and that pick was delivered.
function renderUnanswered(ui: Ui, lang: Lang, card: CardContext, shown: boolean): RenderElement {
  const { Text } = ui
  const { question, wizard } = card
  const letter = otherLetterOf(question.options)
  const isPicked = wizard.picks[question.id] !== undefined
  const isUndelivered = isPicked && card.isUndelivered
  const text = isUndelivered
    ? t(lang, 'card.undelivered')
    : wizard.labels[question.id] !== undefined && letter !== undefined
      ? t(lang, 'card.unansweredKept', { key: letter.toUpperCase() })
      : STATUS_BLANK
  const isOpen = shown && (!isPicked || isUndelivered)
  return (
    <Text key={`unanswered-${question.id}`} color={URGENCY_COLOR.medium}>
      {isOpen ? text : STATUS_BLANK}
    </Text>
  )
}

// Back, and forward: Next on every question of a group of two or more (on its last question, Next opens the review); on a
// group of one question, Submit all, which writes its one answer. Submit all needs every question picked, with the KeepGlide
// mark beside it on the desktop. A dim button does nothing when pressed. Back, Next and Submit carry their letters on the
// terminal and on the desktop (letterFor). Back and forward show the card's answer first (answerLabelOf).
function renderNav(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext, screen: Screen): RenderElement {
  const { Box, Button } = ui
  const { question, isLeaving, isMoveLocked, held } = card
  const isBackOff = !screen.canBack || isLeaving || isMoveLocked
  const label = navLabelOf(card, 'back', answerLabelOf(lang, card, t(lang, 'nav.back')))
  const hotkey = letterFor(card, 'back')
  const onPress = () => {
    if (isBackOff) return
    actions.back()
  }
  const forward =
    screen.total > 1
      ? renderNext(ui, lang, actions, card, screen, answerLabelOf(lang, card, t(lang, 'nav.next')))
      : renderSubmitAll(ui, lang, actions, card, screen, answerLabelOf(lang, card, t(lang, 'review.submit', { n: screen.total })))
  return (
    <Box key={`nav-${question.id}`} flexDirection="row" justifyContent="space-between">
      {held.hold('nav-back', [label, isBackOff, hotkey], onPress, press => (
        <Button key="nav-back" label={label} variant="secondary" dimColor={isBackOff} hotkey={hotkey} onPress={press} />
      ))}
      {forward}
    </Box>
  )
}

// The nav row of an ended card: Back, Dismiss (removes the question) and Next. Next is on while a later question exists in
// the group; nothing waits for a pick, because no answer can be sent. Its labels stay plain.
function renderEndedNav(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext, screen: Screen): RenderElement {
  const { Box, Button } = ui
  const { question, isLeaving, isMoveLocked, held } = card
  const isBackOff = !screen.canBack || isLeaving || isMoveLocked
  const backLabel = navLabelOf(card, 'back', t(lang, 'nav.back'))
  const dismissLabel = t(lang, 'card.dismiss')
  const hotkey = letterFor(card, 'back')
  // An ended card never opens the review: its last question's Next stays dim.
  const endedScreen: Screen = { ...screen, canReview: false }
  return (
    <Box key={`nav-${question.id}`} flexDirection="row" justifyContent="space-between">
      {held.hold('nav-back', [backLabel, isBackOff, hotkey], () => !isBackOff && actions.back(), press => (
        <Button key="nav-back" label={backLabel} variant="secondary" dimColor={isBackOff} hotkey={hotkey} onPress={press} />
      ))}
      {held.hold('dismiss-ended', [dismissLabel, question.id], () => actions.dismissEndedForced(question.id), press => (
        <Button key="dismiss-ended" label={dismissLabel} variant="secondary" onPress={press} />
      ))}
      {renderNext(ui, lang, actions, card, endedScreen, t(lang, 'nav.next'))}
    </Box>
  )
}

// Next, with its label as the caller built it (answer state first, or plain on an ended card). On a question that can review
// it is on, and its press opens the review (actions.next decides).
function renderNext(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext, screen: Screen, label: string): RenderElement {
  const { Button } = ui
  const isOff = !(screen.canNext || screen.canReview) || card.isLeaving || card.isMoveLocked
  const drawnLabel = navLabelOf(card, 'next', label)
  const hotkey = letterFor(card, 'next')
  const onPress = () => {
    if (isOff) return
    actions.next()
  }
  return card.held.hold('nav-next', [drawnLabel, isOff, hotkey], onPress, press => (
    <Button key="nav-next" label={drawnLabel} variant={isOff ? 'secondary' : 'primary'} dimColor={isOff} hotkey={hotkey} onPress={press} />
  ))
}

// The review is drawn only for the question set it was opened for (reviewKeyOf), and only for a group of two or more on screen:
// a question that left or arrived leaves the card in its place.
const reviewDrawnOf = (view: PaneView, screen: Screen): boolean =>
  view.review !== null && view.active !== undefined && view.review === reviewKeyOf(view.active) && screen.total > 1

// The review, drawn in place of the card once Next on the last question asked for it, whether or not every question has a
// pick: one link per question with the answer chosen for it, "No answer" for one without (a press jumps to its card to
// change it), then Back (to the card of the last question, its answer first) and Submit all, dim until every question has
// a pick. The review's card context is the last question's, whatever step the wizard stores.
function renderReview(
  ui: Ui,
  lang: Lang,
  view: PaneView,
  actions: PaneActions,
  screen: Screen,
  held: HeldButtons,
): RenderElement {
  const { Box, Button, Text } = ui
  const lastQuestion = view.active?.questions[screen.total - 1] ?? screen.question
  const card: CardContext = {
    question: localizedQuestion(lastQuestion, lang),
    wizard: view.wizard,
    isLeaving: view.leaving[lastQuestion.id] !== undefined,
    isUndelivered: view.undelivered.includes(lastQuestion.id),
    isMoveLocked: view.moveLocked,
    held,
    surface: view.surface,
  }
  const isBackOff = card.isMoveLocked
  const backLabel = navLabelOf(card, 'back', answerLabelOf(lang, card, t(lang, 'nav.back')))
  const hotkey = letterFor(card, 'back')
  const group = view.active
  const order = (group?.questions ?? []).map(question => question.id)
  // One answer's row, at its place in the group's tree: the question's number and title, then the answer chosen for it.
  const reviewRow = (question: Question) => (place: RowPlace) => {
    const pick = view.wizard.picks[question.id]
    const answer = pick === undefined ? t(lang, 'nav.noAnswer') : answerNameOf(lang, pick, question)
    return (
      <Box key={`review-row-${question.id}`} paddingLeft={place.indent} flexDirection="row">
        {treeLink(ui, held, {
          key: `review-jump-${question.id}`,
          lead: place.lead,
          mark: '○',
          label: `${order.indexOf(question.id) + 1}. ${questionLabel(localizedQuestion(question, lang))} → ${singleLine(answer)}`,
          href: linkHref('jump', question.id),
          bold: false,
          onPress: () => actions.jump(question.id),
        })}
      </Box>
    )
  }
  // The answers sit in the group's tree, as the open questions do: the group's name on top, then its sessions and rows.
  const tree =
    group === undefined
      ? false
      : renderBranch(ui, {
          key: `review-group-${group.key}`,
          label: groupLabelOf(group.questions[0], lang),
          sessions: group.sessions.flatMap(questions => {
            const [first] = questions
            if (first === undefined) return []
            return [{ key: `review-session-${first.id}`, label: sessionLabelOf(first, lang), isRoot: isRootSession(first), rows: questions.map(reviewRow) }]
          }),
        })
  return (
    <Box key="review" flexDirection="column" gap={1} borderStyle="round" paddingX={1} paddingBottom={1}>
      {tree}
      <Box flexDirection="column">
        <Text bold>{t(lang, 'review.title')}</Text>
        <Text dimColor>{t(lang, 'review.hint')}</Text>
      </Box>
      {renderDivider(ui, view.surface, 'divider-review')}
      <Box flexDirection="row" justifyContent="space-between">
        {held.hold('review-back', [backLabel, isBackOff, hotkey], () => !isBackOff && actions.leaveReview(), press => (
          <Button key="review-back" label={backLabel} variant="secondary" dimColor={isBackOff} hotkey={hotkey} onPress={press} />
        ))}
        {renderSubmitAll(ui, lang, actions, card, screen, t(lang, 'review.submit', { n: screen.total }))}
      </Box>
    </Box>
  )
}

// Submit all, with the label its caller built: the answer state first on a single-question card, plain in the review.
function renderSubmitAll(ui: Ui, lang: Lang, actions: PaneActions, card: CardContext, screen: Screen, label: string): RenderElement {
  const { Box, Button } = ui
  const isOff = !screen.canSubmit || card.isLeaving
  const drawnLabel = navLabelOf(card, 'submit', label)
  const hotkey = letterFor(card, 'submit')
  // The press goes through even while the button is drawn off: an Other text typed but not recorded yet (no Enter, no
  // blur) is recorded by the submit action first, and submitGroup checks again that every question has a pick.
  const onPress = () => {
    if (card.isLeaving) return
    actions.submit()
  }
  return (
    <Box key="submit-row" flexDirection="row" alignItems="center" gap={1}>
      {card.held.hold('submit-all', [drawnLabel, isOff, hotkey], onPress, press => (
        <Button key={SUBMIT_ALL_KEY} label={drawnLabel} variant={isOff ? 'secondary' : 'primary'} dimColor={isOff} hotkey={hotkey} onPress={press} />
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
