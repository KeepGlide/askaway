// The question wizard's state and rules: which group is open, which question is on screen, what was picked. Pure: each
// function returns a new value and never touches the store or the drawing. A group is the questions of one session
// family (or of one project, for questions with no family), in tree order (session by session). The step runs
// 0..total-1 over the questions of the group. A pick never moves the step; on the last question of a group of two or more,
// Next opens the review (register.tsx), and a group of one carries Submit all.
import type { Question } from '../types'
import { OTHER_KEY, OTHER_TEXT_MAX, groupKeyOf } from './model'

// A chosen option. The key 'other' carries the free text in `text`.
export type Pick = { key: string; text?: string }

// `questionId` is the id of the question on screen (the one at `step`); the pruning re-anchors the step to it when the
// list shifts. The text typed in an "Other…" field lives in the field until Keep moves it to `labels` (the kept text that
// the Other button draws); `fieldRound` numbers the fields, since Keep empties one by giving it a new key.
export type Wizard = {
  groupKey: string | null
  step: number
  questionId: string | null
  picks: Record<string, Pick>
  labels: Record<string, string>
  fieldRound: number
}

export const EMPTY_WIZARD: Wizard = { groupKey: null, step: 0, questionId: null, picks: {}, labels: {}, fieldRound: 0 }

// The open questions of one group. `sessions` holds the same questions split by session (sessions in the order of
// their oldest question, questions oldest first); `questions` is those sessions one after the other: the step order.
export type Group = { key: string; sessions: Question[][]; questions: Question[] }

// What the pane draws for the current step: the question on screen and what its buttons may do. `canReview` is the last
// question of a group of two or more: its Next opens the review instead of moving.
export type Screen = {
  index: number
  total: number
  question: Question
  canBack: boolean
  canNext: boolean
  canReview: boolean
  canSubmit: boolean
}

// The step of the last question of a group of `total` questions (0 for an empty one).
const lastStep = (total: number): number => Math.max(total - 1, 0)
const clampStep = (step: number, total: number): number => Math.min(Math.max(step, 0), lastStep(total))

// The sessions of one group's questions (oldest first): grouped by session, in the order of each session's oldest one.
function sessionsOf(questions: readonly Question[]): Question[][] {
  const bySession = new Map<string | null, Question[]>()
  for (const question of questions) {
    const session = bySession.get(question.session)
    if (session) session.push(question)
    else bySession.set(question.session, [question])
  }
  return [...bySession.values()]
}

// The open questions grouped by family (groupKeyOf: the project when a question has no family). Groups come in the order
// of their oldest question.
export function groupsOf(open: readonly Question[]): Group[] {
  const byGroup = new Map<string, Question[]>()
  for (const question of [...open].sort((a, b) => a.ts - b.ts)) {
    const key = groupKeyOf(question)
    const questions = byGroup.get(key)
    if (questions) questions.push(question)
    else byGroup.set(key, [question])
  }
  return [...byGroup].map(([key, questions]) => {
    const sessions = sessionsOf(questions)
    return { key, sessions, questions: sessions.flat() }
  })
}

// The group on screen: the one the wizard names when it is still open, else the first.
export function activeGroup(groups: readonly Group[], wizard: Wizard): Group | undefined {
  return groups.find(group => group.key === wizard.groupKey) ?? groups[0]
}

// The question set of a group, as the review names it: the sorted ids. A question that leaves or arrives changes it, so a
// review opened for the old set is not drawn for the new one.
export const reviewKeyOf = (group: Group): string =>
  group.questions
    .map(question => question.id)
    .sort()
    .join(',')

// Every question of the group must have a pick; the list is in group order. Undefined when one is missing or the group is empty.
export function submittable(group: Group, wizard: Wizard): { id: string; pick: Pick }[] | undefined {
  const answers: { id: string; pick: Pick }[] = []
  for (const question of group.questions) {
    const pick: Pick | undefined = wizard.picks[question.id]
    if (pick === undefined) return undefined
    answers.push({ id: question.id, pick })
  }
  return answers.length > 0 ? answers : undefined
}

// The text of an Other field as it is kept: trimmed, and capped at OTHER_TEXT_MAX code points.
const otherTextOf = (text: string): string => Array.from(text.trim()).slice(0, OTHER_TEXT_MAX).join('')

// Keep in the Other field (Enter, or its Apply button) moves its text to the question's label, which the Other button then
// draws, and picks that text: the label and the Other pick are the same text, so the button is drawn chosen. The field
// round moves on, so the field empties. The step stays. Blank text changes nothing.
export function keptOther(wizard: Wizard, id: string, text: string): Wizard {
  const trimmed = otherTextOf(text)
  if (trimmed === '') return wizard
  const pick: Pick = { key: OTHER_KEY, text: trimmed }
  return {
    ...wizard,
    picks: { ...wizard.picks, [id]: pick },
    labels: { ...wizard.labels, [id]: trimmed },
    fieldRound: wizard.fieldRound + 1,
  }
}

// The Other pick of a question as its typed text leaves the field: trimmed and capped; blank text takes the pick away.
// The pick is the only thing that moves; the wizard keeps its step.
function recordedOther(wizard: Wizard, id: string, text: string): Wizard {
  const trimmed = otherTextOf(text)
  const picks = { ...wizard.picks }
  const pick: Pick | undefined = picks[id]
  if (trimmed !== '') picks[id] = { key: OTHER_KEY, text: trimmed }
  else if (pick?.key === OTHER_KEY) delete picks[id]
  return { ...wizard, picks }
}

// Whether submittedOther sets a typed Other text aside instead of recording it: a kept label stays the pick until Apply.
export const setsTypedOtherAside = (wizard: Wizard, id: string): boolean => wizard.labels[id] !== undefined

// The text typed in an Other field and not kept yet, recorded when the field loses focus or a nav action runs: its trimmed
// text is the Other pick, and keeps the wizard where it is; blank text takes an Other pick away when no label is kept. It
// never moves on. While the question has a kept label, nothing is recorded, typed or blank: Keep is the only way to set the
// Other text, so the pick and the drawn label cannot disagree, and a blank text never removes the kept label's pick. The
// text stays in the field until Keep. Submit all is the one exception (submittedTypedOther).
export function submittedOther(wizard: Wizard, id: string, text: string): Wizard {
  if (setsTypedOtherAside(wizard, id)) return wizard
  return recordedOther(wizard, id, text)
}

// Submit all records the text typed in an Other field as the answer, a kept label included (SPEC, Submit all: a text typed
// and followed by a click on Submit all is the answer). The pick is submitted at once, so it does not need to match the label.
// Blank text changes nothing while a label is kept: blank text never removes a kept label (owner reply, M46).
export function submittedTypedOther(wizard: Wizard, id: string, text: string): Wizard {
  if (otherTextOf(text) === '' && wizard.labels[id] !== undefined) return wizard
  return recordedOther(wizard, id, text)
}

// A draft's Other pick whose text is not the kept label of its question takes the label as its text: the Other button is
// drawn chosen only for the kept text, so the reply sent is the text drawn (SPEC, Other: "so the button and the reply sent
// always agree"). Picks of other kinds, and Other picks with no kept label, are returned as they are.
export function alignOtherToLabels(picks: Record<string, Pick>, labels: Record<string, string>): Record<string, Pick> {
  return Object.fromEntries(
    Object.entries(picks).map(([id, pick]) => {
      const label = labels[id]
      const isStale = pick.key === OTHER_KEY && label !== undefined && pick.text !== label
      return [id, isStale ? { key: OTHER_KEY, text: label } : pick]
    }),
  )
}

// The question on screen at the step (clamped into the group), or undefined for a group with no question.
export function screenOf(group: Group, wizard: Wizard): Screen | undefined {
  const total = group.questions.length
  const index = clampStep(wizard.step, total)
  const question = group.questions[index]
  if (question === undefined) return undefined
  return {
    index,
    total,
    question,
    canBack: index > 0,
    canNext: index < lastStep(total),
    canReview: total > 1 && index === lastStep(total),
    canSubmit: submittable(group, wizard) !== undefined,
  }
}

// The wizard on the question at `step` of the group: the step and the id of the question on screen move together.
const onStep = (wizard: Wizard, group: Group, step: number): Wizard => ({
  ...wizard,
  step,
  questionId: group.questions[step]?.id ?? null,
})

// Records the pick of a question. The step stays where it is: the card stays on the question that was picked. Nothing is
// submitted or reviewed here.
export function choose(wizard: Wizard, id: string, pick: Pick): Wizard {
  return { ...wizard, picks: { ...wizard.picks, [id]: pick } }
}

// Moves to the previous question. On the first question it does nothing.
export function back(wizard: Wizard, group: Group): Wizard {
  return onStep(wizard, group, Math.max(0, clampStep(wizard.step, group.questions.length) - 1))
}

// Moves to the next question, picked or not. On the last question it does nothing.
export function next(wizard: Wizard, group: Group): Wizard {
  const step = clampStep(wizard.step, group.questions.length)
  if (step >= lastStep(group.questions.length)) return wizard
  return onStep(wizard, group, step + 1)
}

// Moves to a question of a group, the group on screen included: the press on a question row of the tree. A question
// the group does not hold leaves the wizard as it is.
export function jumpTo(wizard: Wizard, group: Group, id: string): Wizard {
  const step = group.questions.findIndex(question => question.id === id)
  if (step < 0) return wizard
  return onStep({ ...wizard, groupKey: group.key }, group, step)
}

export const keepOpen = <V>(record: Record<string, V>, open: ReadonlySet<string>): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => open.has(id)))

// Drops what belongs to questions no longer open (answered elsewhere) and clamps the step. `activeTotal` is the size of
// the group on screen after the drop: the caller passes the questions of activeGroup over the pruned groups (0 if none).
export function pruneWizard(wizard: Wizard, openIds: readonly string[], activeTotal: number): Wizard {
  const open = new Set(openIds)
  return {
    ...wizard,
    step: clampStep(wizard.step, activeTotal),
    picks: keepOpen(wizard.picks, open),
    labels: keepOpen(wizard.labels, open),
  }
}
