// Pure rules of Askaway: validation of the state files, the open questions, the status lines, the counter and the
// text. Nothing here touches $; the store and the drawing both depend on it, never the other way round.
import type { Answer, AnswerBy, Board, Delivery, DeliveryReason, Question, QuestionOption } from '../types'
import { plural, t, type Lang, type MessageKey } from './i18n'

// The id shape askaway.py mints (q-<base36 ms>-<6 hex>). Checked before an id becomes part of a path.
const ID_PATTERN = /^q-[0-9a-z]+-[0-9a-f]{6}$/
const ANSWER_BY: readonly AnswerBy[] = ['panel', 'accept_recommended', 'accept_all', 'cli']
const DELIVERY_REASONS: readonly DeliveryReason[] = ['session-ended', 'ttl']
// The legacy answer key of the old free-text answer (no longer written by the pane): its text is in the answer's `text`.
export const OTHER_KEY = 'other'
// A delivered answer's status line stays this long after the pane first sees the delivery.
const DELIVERED_SHOWN_MS = 30_000
// An answer is handed to its own session's prompt only this long after it was given, so a busy session's own hook
// (askaway.py, its deliver mode) gets it first.
export const PROMPT_DELAY_MS = 5_000
// The longest free text a delivery line quotes, in characters (askaway.py's OTHER_TEXT_MAX).
const OTHER_TEXT_MAX = 500
const RISK_KEYS: ReadonlyMap<string, MessageKey> = new Map<string, MessageKey>([
  ['low', 'risk.low'],
  ['medium', 'risk.medium'],
  ['high', 'risk.high'],
])

export type Section = { heading: string; body: string }
// The cards answered a moment ago that are still drawn dim before they leave: question id → press time (ms).
export type Leaving = Readonly<Partial<Record<string, number>>>
export type StatusLine = { id: string; text: string; dismissable: boolean }
export type StatusContext = {
  cleared: readonly string[]
  shownAt: Readonly<Partial<Record<string, number>>>
  now: number
  leaving: Leaving
}
// The answers to hand to one asking session now, with the line each one submits (one prompt per session per poll).
export type SessionPrompt = { session: string; items: { answer: Answer; text: string }[] }

export const EMPTY_BOARD: Board = { questions: [], answers: [], delivered: [] }

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw)

const optionalText = (raw: unknown): string | undefined =>
  typeof raw === 'string' && raw.trim() !== '' ? raw : undefined

const fitOf = (raw: unknown): number | null =>
  typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? Math.round(raw) : null

function parseOption(raw: unknown): QuestionOption | undefined {
  if (!isRecord(raw) || typeof raw.key !== 'string' || typeof raw.label !== 'string') return undefined
  return { key: raw.key, label: raw.label, fit: fitOf(raw.fit), tradeoff: optionalText(raw.tradeoff) }
}

// Usable only with at least two options, every one of them valid, unique keys, and the recommended key among them.
function parseOptions(raw: unknown, recommended: string): QuestionOption[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const options = raw.map(parseOption)
  if (options.some(option => option === undefined)) return undefined
  const valid = options.filter((option): option is QuestionOption => option !== undefined)
  const keys = new Set(valid.map(option => option.key))
  const isUsable = valid.length >= 2 && keys.size === valid.length && keys.has(recommended)
  return isUsable ? valid : undefined
}

// A question file is trusted only when its id matches its file name and every required field is typed.
export function parseQuestion(raw: unknown, id: string): Question | undefined {
  if (!isRecord(raw) || raw.id !== id || !ID_PATTERN.test(id)) return undefined
  const recommended = typeof raw.recommended === 'string' ? raw.recommended : ''
  const options = parseOptions(raw.options, recommended)
  const isTyped = typeof raw.ts === 'number' && typeof raw.title === 'string' && typeof raw.question === 'string'
  if (!options || !isTyped) return undefined
  return {
    id,
    ts: Number(raw.ts),
    title: String(raw.title),
    question: String(raw.question),
    context: optionalText(raw.context),
    analogy: optionalText(raw.analogy),
    why: optionalText(raw.why),
    how: optionalText(raw.how),
    gains: optionalText(raw.gains),
    losses: optionalText(raw.losses),
    urgency: optionalText(raw.urgency),
    undo: optionalText(raw.undo),
    project: typeof raw.project === 'string' ? raw.project : '',
    session: typeof raw.session === 'string' ? raw.session : null,
    session_title: optionalText(raw.session_title),
    options,
    recommended,
    risk: typeof raw.risk === 'string' ? raw.risk : 'low',
  }
}

export function parseAnswer(raw: unknown, id: string): Answer | undefined {
  if (!isRecord(raw) || raw.id !== id || typeof raw.key !== 'string' || typeof raw.ts !== 'number') return undefined
  const by = ANSWER_BY.find(name => name === raw.by)
  if (by === undefined) return undefined
  return { id, key: raw.key, by, ts: raw.ts, text: raw.key === OTHER_KEY ? optionalText(raw.text) : undefined }
}

export function parseDelivery(raw: unknown, id: string): Delivery | undefined {
  if (!isRecord(raw) || raw.id !== id) return undefined
  const reason = DELIVERY_REASONS.find(name => name === raw.reason)
  return { id, expired: raw.expired === true, reason }
}

export function parseAway(raw: unknown): boolean {
  return isRecord(raw) && raw.on === true
}

export const isOpenIn = (board: Board, id: string): boolean =>
  board.questions.some(question => question.id === id) && !board.answers.some(answer => answer.id === id)

// The open questions the pane lists: no answer yet and no delivery marker, except a card still fading out after its
// press (answered, but in `leaving`). Oldest first, so the card that has waited longest sits on top, as in the mock.
export function openQuestions(board: Board, leaving: Leaving): Question[] {
  const answered = new Set(board.answers.map(answer => answer.id))
  const delivered = new Set(board.delivered.map(delivery => delivery.id))
  return board.questions
    .filter(question => (!answered.has(question.id) || leaving[question.id] !== undefined) && !delivered.has(question.id))
    .sort((a, b) => a.ts - b.ts)
}

export function withAnswer(board: Board, answer: Answer): Board {
  return { ...board, answers: [...board.answers.filter(one => one.id !== answer.id), answer] }
}

export const sameBoard = (a: Board, b: Board): boolean => JSON.stringify(a) === JSON.stringify(b)

// A poll reads the folder from before a press may have written its answer. The answer a press wrote stays until a read
// sees it on disk, as long as its question is still listed; a poll never takes an answer back.
export function withLocalAnswers(next: Board, prev: Board): Board {
  const onDisk = new Set(next.answers.map(answer => answer.id))
  const listed = new Set(next.questions.map(question => question.id))
  const kept = prev.answers.filter(answer => !onDisk.has(answer.id) && listed.has(answer.id))
  return kept.length === 0 ? next : { ...next, answers: [...next.answers, ...kept] }
}

// The free text of an "other" answer as askaway.py quotes it: one line, capped in characters.
function otherTextOf(answer: Answer): string | undefined {
  if (answer.key !== OTHER_KEY || answer.text === undefined) return undefined
  const oneLine = answer.text.split(/\s+/).filter(part => part !== '').join(' ')
  const text = Array.from(oneLine).slice(0, OTHER_TEXT_MAX).join('')
  return text === '' ? undefined : text
}

const keyText = (question: Question, key: string): string => {
  const label = question.options.find(option => option.key === key)?.label
  return label ? `${key} · ${label}` : key
}

// The line askaway.py's deliver hook writes for an answer (its _delivery_line), so both paths tell the session the same
// words. Model-facing, so always English: never localized. Undefined when the answer names no option and carries no
// free text.
export function deliveryLine(question: Question, answer: Answer): string | undefined {
  const other = otherTextOf(answer)
  const isListed = question.options.some(option => option.key === answer.key)
  if (other === undefined && !isListed) return undefined
  const chosen = other !== undefined ? `their own answer (Other): "${other}"` : keyText(question, answer.key)
  const line = `The user answered Askaway question ${question.id} (${question.title}): ${chosen}.`
  return answer.key === question.recommended ? line : `${line} (you were using ${keyText(question, question.recommended)})`
}

// The answers this session is to be handed now: its own questions, answered at least PROMPT_DELAY_MS ago, with no
// delivery marker yet. Each comes with the line to submit.
export function promptsDue(board: Board, session: string, now: number): { answer: Answer; text: string }[] {
  const delivered = new Set(board.delivered.map(delivery => delivery.id))
  const due: { answer: Answer; text: string }[] = []
  for (const answer of board.answers) {
    const question = board.questions.find(one => one.id === answer.id)
    if (!question || question.session !== session || delivered.has(answer.id)) continue
    if (now - answer.ts < PROMPT_DELAY_MS) continue
    const text = deliveryLine(question, answer)
    if (text !== undefined) due.push({ answer, text })
  }
  return due
}

// The due answers of every asking session, one group per session that has any, in the order its first question appears.
// Questions with no session cannot be handed to one, so they are left out.
export function groupBySession(board: Board, now: number): SessionPrompt[] {
  const sessions = new Set<string>()
  for (const question of board.questions) {
    if (question.session !== null) sessions.add(question.session)
  }
  return [...sessions]
    .map(session => ({ session, items: promptsDue(board, session, now) }))
    .filter(group => group.items.length > 0)
}

// The minor words of a title, per language: after the first word they stay as typed.
const MINOR_WORDS: Readonly<Record<Lang, ReadonlySet<string>>> = {
  en: new Set('a an and as at but by for in of on or the to via with'.split(' ')),
  pt: new Set('a as o os e de da das do dos em na nas no nos para por com ou um uma'.split(' ')),
}

// Title case for a name: each word's first letter up, except a minor word after the first and a word that already
// has a capital (JEV, iOS), which stay as typed. Nothing is ever lowercased.
export function titleCase(text: string, lang: Lang): string {
  const minor = MINOR_WORDS[lang]
  return text
    .trim()
    .split(/\s+/)
    .map((word, index) => {
      if (index > 0 && minor.has(word.toLowerCase())) return word
      return /[A-Z]/.test(word) ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`
    })
    .join(' ')
}

// The name of a project: its folder name, title-cased from its slug ("my-sample_project" becomes "My Sample Project").
export function projectLabel(project: string, lang: Lang): string {
  return titleCase(basename(project).replace(/[-_]+/g, ' '), lang)
}

// The name of a question's session: its title, title-cased, else the words for "the session".
export function sessionLabelOf(question: Pick<Question, 'session_title'>, lang: Lang): string {
  return question.session_title === undefined ? t(lang, 'status.target.session') : titleCase(question.session_title, lang)
}

// The window a question came from, as the status lines name it: "<project> · <session title>", each part only when known.
export function windowOf(question: Pick<Question, 'project' | 'session_title'>, lang: Lang): string {
  const session = question.session_title === undefined ? undefined : titleCase(question.session_title, lang)
  return [projectLabel(question.project, lang), session].filter(part => part !== undefined && part !== '').join(' · ')
}

function basename(project: string): string {
  const parts = project.split('/').filter(part => part !== '')
  return parts[parts.length - 1] ?? project
}

// The status line of one answer: pending until its delivery marker appears, then delivered, or expired.
function statusOf(lang: Lang, answer: Answer, question: Question | undefined, delivery: Delivery | undefined): StatusLine {
  const { id, key } = answer
  const target = (question ? windowOf(question, lang) : '') || t(lang, 'status.target.session')
  if (delivery === undefined) {
    return { id, text: t(lang, 'status.pending', { key, target }), dismissable: false }
  }
  if (!delivery.expired) {
    return { id, text: t(lang, 'status.delivered', { key, target }), dismissable: false }
  }
  if (delivery.reason === 'session-ended') {
    return { id, text: t(lang, 'status.sessionEnded', { key, target }), dismissable: true }
  }
  return { id, text: t(lang, 'status.expired', { key }), dismissable: true }
}

// The status lines above the list, newest answer first: pending answers, delivered ones for DELIVERED_SHOWN_MS after
// the pane first saw them, and expired ones until the user dismisses them. An answer whose card is still fading shows
// no line yet: its line follows the card out of the list.
export function statusLines(lang: Lang, board: Board, context: StatusContext): StatusLine[] {
  const questions = new Map(board.questions.map(question => [question.id, question] as const))
  const deliveries = new Map(board.delivered.map(delivery => [delivery.id, delivery] as const))
  const hidden = new Set(context.cleared)
  const lines: StatusLine[] = []
  for (const answer of [...board.answers].sort((a, b) => b.ts - a.ts)) {
    if (context.leaving[answer.id] !== undefined) continue
    const delivery = deliveries.get(answer.id)
    const line = statusOf(lang, answer, questions.get(answer.id), delivery)
    const isPastShowTime =
      delivery?.expired === false && context.now - (context.shownAt[answer.id] ?? context.now) > DELIVERED_SHOWN_MS
    if (isPastShowTime || (line.dismissable && hidden.has(answer.id))) continue
    lines.push(line)
  }
  return lines
}

// The header counter: the open questions and the distinct groups (projects) they come from.
export function counterText(lang: Lang, questions: readonly Question[]): string {
  if (questions.length === 0) return t(lang, 'counter.none')
  const groups = new Set(questions.map(question => question.project)).size
  return t(lang, 'counter.line', {
    pending: plural(lang, questions.length, 'counter.pending.one', 'counter.pending.many'),
    groups: plural(lang, groups, 'count.group.one', 'count.group.many'),
  })
}

export const riskLabel = (lang: Lang, risk: string): string => {
  const key = RISK_KEYS.get(risk)
  return key === undefined ? t(lang, 'risk.other', { risk }) : t(lang, key)
}

export function ageLabel(lang: Lang, ts: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ts) / 60_000))
  if (minutes < 1) return t(lang, 'age.now')
  if (minutes < 60) return t(lang, 'age.minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t(lang, 'age.hours', { n: hours })
  return t(lang, 'age.days', { n: Math.round(hours / 24) })
}

// The explanation sections, in the approved order; each one only when its field is set.
export function sectionsOf(lang: Lang, question: Question): Section[] {
  const sections: Section[] = []
  const add = (heading: string, body: string | undefined): void => {
    if (body !== undefined) sections.push({ heading, body })
  }
  add(t(lang, 'section.context'), question.context)
  add(t(lang, 'section.analogy'), question.analogy)
  add(t(lang, 'section.why', { key: question.recommended }), question.why)
  add(t(lang, 'section.how'), question.how)
  // One section for the two halves: each half shows only when its field is set, and the subtitle names just the halves shown.
  const benefits = [
    { body: question.gains, heading: t(lang, 'section.gains') },
    { body: question.losses, heading: t(lang, 'section.losses') },
  ].filter((part): part is { body: string; heading: string } => part.body !== undefined)
  if (benefits.length > 0) {
    add(benefits.map(part => part.heading).join(' · '), benefits.map(part => part.body).join(' '))
  }
  add(t(lang, 'section.urgency'), question.urgency)
  add(t(lang, 'section.undo'), question.undo)
  return sections
}

// The text the /askaway command answers when the pane waits undrawn.
export function listText(lang: Lang, questions: readonly Question[], isAway: boolean): string {
  const head = plural(lang, questions.length, 'list.head.one', 'list.head.many')
  const away = isAway ? t(lang, 'list.awayOn') : ''
  const rows = questions.map(question => t(lang, 'list.row', { id: question.id, title: question.title, rec: question.recommended }))
  return [`${head}${away}.`, ...rows].join('\n')
}

// The key prefix of the Other field.
export const OTHER_INPUT_PREFIX = 'other-input-'

// The pieces of an explanation text: plain runs, and the names a reader may act on, drawn in the accent color. A name
// is a slash command (`/reload-plugins`, `/askaway lang pt` up to its first space) or anything the agent wrote between
// backticks (a skill, an agent, a file, a flag); the backticks themselves are not drawn.
export type TextPiece = { text: string; isName: boolean }

const NAME_PATTERN = /`([^`\n]+)`|(?<![\w/.:~])(\/[a-z](?:[\w:-]*\w)?)/g

export function piecesOf(text: string): TextPiece[] {
  const pieces: TextPiece[] = []
  let last = 0
  for (const match of text.matchAll(NAME_PATTERN)) {
    const index = match.index ?? 0
    if (index > last) pieces.push({ text: text.slice(last, index), isName: false })
    pieces.push({ text: match[1] ?? match[2] ?? '', isName: true })
    last = index + match[0].length
  }
  if (last < text.length) pieces.push({ text: text.slice(last), isName: false })
  return pieces
}
