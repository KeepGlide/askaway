// The question wizard's state and rules: which group is open, which question is on screen, what was picked. Pure: each
// function returns a new value and never touches the store or the drawing. A group is the questions of one project,
// in tree order (session by session). The step runs 0..total-1 over the questions of the group; the last question
// carries the Submit all button, so there is no review step.
import type { Question } from '../types'

// A chosen option. The key 'other' carries the free text in `text`.
export type Pick = { key: string; text?: string }

// `questionId` is the id of the question on screen (the one at `step`); the pruning re-anchors the step to it when the
// list shifts. `other` is the id of the question whose "Other…" field is open; the text typed there lives in the field only.
export type Wizard = {
  groupKey: string | null
  step: number
  questionId: string | null
  picks: Record<string, Pick>
  other: string | null
}

export const EMPTY_WIZARD: Wizard = { groupKey: null, step: 0, questionId: null, picks: {}, other: null }

// The open questions of one project. `sessions` holds the same questions split by session (sessions in the order of
// their oldest question, questions oldest first); `questions` is those sessions one after the other: the step order.
export type Group = { key: string; sessions: Question[][]; questions: Question[] }

// What the pane draws for the current step: the question on screen and what its buttons may do.
export type Screen = {
  index: number
  total: number
  question: Question
  canBack: boolean
  canNext: boolean
  canSubmit: boolean
}

// The step of the last question of a group of `total` questions (0 for an empty one).
const lastStep = (total: number): number => Math.max(total - 1, 0)
const clampStep = (step: number, total: number): number => Math.min(Math.max(step, 0), lastStep(total))

// The sessions of one project's questions (oldest first): grouped by session, in the order of each session's oldest one.
function sessionsOf(questions: readonly Question[]): Question[][] {
  const bySession = new Map<string | null, Question[]>()
  for (const question of questions) {
    const session = bySession.get(question.session)
    if (session) session.push(question)
    else bySession.set(question.session, [question])
  }
  return [...bySession.values()]
}

// The open questions grouped by project. Groups come in the order of their oldest question.
export function groupsOf(open: readonly Question[]): Group[] {
  const byProject = new Map<string, Question[]>()
  for (const question of [...open].sort((a, b) => a.ts - b.ts)) {
    const questions = byProject.get(question.project)
    if (questions) questions.push(question)
    else byProject.set(question.project, [question])
  }
  return [...byProject].map(([key, questions]) => {
    const sessions = sessionsOf(questions)
    return { key, sessions, questions: sessions.flat() }
  })
}

// The group on screen: the one the wizard names when it is still open, else the first.
export function activeGroup(groups: readonly Group[], wizard: Wizard): Group | undefined {
  return groups.find(group => group.key === wizard.groupKey) ?? groups[0]
}

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
    canSubmit: submittable(group, wizard) !== undefined,
  }
}

// The first question without a pick, searched from `from` on and wrapping to the start; undefined when all have one.
function firstUnpickedFrom(group: Group, wizard: Wizard, from: number): number | undefined {
  const total = group.questions.length
  for (let offset = 0; offset < total; offset++) {
    const index = (from + offset) % total
    if (wizard.picks[group.questions[index]?.id ?? ''] === undefined) return index
  }
  return undefined
}

// The wizard on the question at `step` of the group: the step and the id of the question on screen move together.
const onStep = (wizard: Wizard, group: Group, step: number): Wizard => ({
  ...wizard,
  step,
  questionId: group.questions[step]?.id ?? null,
})

// Records the pick and moves the wizard on: to the first question without a pick after the current one (wrapping), or,
// once every question has a pick, to the last question, where Submit all is. Nothing is submitted here.
export function choose(wizard: Wizard, group: Group, id: string, pick: Pick): Wizard {
  const picked: Wizard = { ...wizard, picks: { ...wizard.picks, [id]: pick } }
  if (submittable(group, picked) !== undefined) return onStep(picked, group, lastStep(group.questions.length))
  const from = clampStep(wizard.step, group.questions.length)
  return onStep(picked, group, firstUnpickedFrom(group, picked, from + 1) ?? from)
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

const keepOpen = <V>(record: Record<string, V>, open: ReadonlySet<string>): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => open.has(id)))

// Drops what belongs to questions no longer open (answered elsewhere) and clamps the step. `activeTotal` is the size of
// the group on screen after the drop: the caller passes the questions of activeGroup over the pruned groups (0 if none).
export function pruneWizard(wizard: Wizard, openIds: readonly string[], activeTotal: number): Wizard {
  const open = new Set(openIds)
  return {
    ...wizard,
    step: clampStep(wizard.step, activeTotal),
    picks: keepOpen(wizard.picks, open),
    other: wizard.other !== null && open.has(wizard.other) ? wizard.other : null,
  }
}
