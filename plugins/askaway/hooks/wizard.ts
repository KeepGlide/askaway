// The question wizard's state and rules: which window is open, which question is on screen, what was picked. Pure: each
// function returns a new value and never touches the store or the drawing. The step runs 0..total-1 over the questions
// of the window, and `total` is the review step; a window of one question has no review step.
import type { Question } from '../types'
import { windowOf } from './model'

// A chosen option. The key 'other' carries the free text in `text`.
export type Pick = { key: string; text?: string }

export type Wizard = {
  windowKey: string | null
  step: number
  picks: Record<string, Pick>
  other: { id: string; text: string } | null
  expanded: Record<string, boolean>
}

export const EMPTY_WIZARD: Wizard = { windowKey: null, step: 0, picks: {}, other: null, expanded: {} }

export type WindowGroup = { key: string; label: string; questions: Question[] }

export type Screen =
  | { kind: 'question'; index: number; total: number; question: Question; pick?: Pick; canBack: boolean; canNext: boolean }
  | { kind: 'review'; rows: { question: Question; pick: Pick | undefined }[]; canSubmit: boolean }

// The window a question belongs to: its session, or its project when it has no session.
export function windowKeyOf(question: { session: string | null; project: string }): string {
  return question.session ?? `project:${question.project}`
}

// The highest step: the review step for a window of two or more questions, the only question otherwise.
const lastStep = (total: number): number => (total > 1 ? total : 0)
const clampStep = (step: number, total: number): number => Math.min(Math.max(step, 0), lastStep(total))

// The open questions grouped by window. Groups come in the order of their oldest question, questions oldest first.
export function windowsOf(open: readonly Question[]): WindowGroup[] {
  const byKey = new Map<string, Question[]>()
  for (const question of [...open].sort((a, b) => a.ts - b.ts)) {
    const key = windowKeyOf(question)
    const questions = byKey.get(key)
    if (questions) questions.push(question)
    else byKey.set(key, [question])
  }
  return [...byKey].flatMap(([key, questions]) => {
    const first = questions[0]
    return first === undefined ? [] : [{ key, label: windowOf(first), questions }]
  })
}

// The window on screen: the one the wizard names when it is still open, else the first.
export function activeWindow(groups: readonly WindowGroup[], wizard: Wizard): WindowGroup | undefined {
  return groups.find(group => group.key === wizard.windowKey) ?? groups[0]
}

// Every question of the group must have a pick; the list is in group order. Undefined when one is missing or the group is empty.
export function submittable(group: WindowGroup, wizard: Wizard): { id: string; pick: Pick }[] | undefined {
  const answers: { id: string; pick: Pick }[] = []
  for (const question of group.questions) {
    const pick: Pick | undefined = wizard.picks[question.id]
    if (pick === undefined) return undefined
    answers.push({ id: question.id, pick })
  }
  return answers.length > 0 ? answers : undefined
}

function reviewOf(group: WindowGroup, wizard: Wizard): Screen {
  const rows = group.questions.map(question => ({ question, pick: wizard.picks[question.id] }))
  return { kind: 'review', rows, canSubmit: submittable(group, wizard) !== undefined }
}

// What the pane draws for the current step. A step past the last question is the review.
export function screenOf(group: WindowGroup, wizard: Wizard): Screen {
  const total = group.questions.length
  const step = clampStep(wizard.step, total)
  const question = group.questions[step]
  if (question === undefined) return reviewOf(group, wizard)
  const pick: Pick | undefined = wizard.picks[question.id]
  return { kind: 'question', index: step, total, question, pick, canBack: step > 0, canNext: pick !== undefined }
}

// Records the pick. A window of one question is submitted at once; otherwise the wizard moves to the next step.
export function choose(wizard: Wizard, group: WindowGroup, id: string, pick: Pick): { wizard: Wizard; submit: boolean } {
  const picked: Wizard = { ...wizard, picks: { ...wizard.picks, [id]: pick } }
  const total = group.questions.length
  if (total === 1) return { wizard: picked, submit: true }
  return { wizard: { ...picked, step: Math.min(clampStep(wizard.step, total) + 1, total) }, submit: false }
}

export function back(wizard: Wizard): Wizard {
  return { ...wizard, step: Math.max(0, wizard.step - 1) }
}

// Moves forward only when the question on screen has a pick; the review step is never passed.
export function next(wizard: Wizard, group: WindowGroup): Wizard {
  const total = group.questions.length
  const step = clampStep(wizard.step, total)
  const current = group.questions[step]
  if (current === undefined || wizard.picks[current.id] === undefined) return wizard
  return { ...wizard, step: Math.min(step + 1, lastStep(total)) }
}

export function jump(wizard: Wizard, group: WindowGroup, index: number): Wizard {
  return { ...wizard, step: clampStep(index, group.questions.length) }
}

export function toggleExpanded(wizard: Wizard, id: string): Wizard {
  return { ...wizard, expanded: { ...wizard.expanded, [id]: !wizard.expanded[id] } }
}

// Another window: back to its first question, the picks of every window kept.
export function selectWindow(wizard: Wizard, key: string): Wizard {
  return { ...wizard, windowKey: key, step: 0 }
}

const keepOpen = <V>(record: Record<string, V>, open: ReadonlySet<string>): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => open.has(id)))

// Drops what belongs to questions no longer open (answered elsewhere) and clamps the step. `activeTotal` is the size of
// the window on screen after the drop: the caller passes the questions of activeWindow over the pruned groups (0 if none).
export function pruneWizard(wizard: Wizard, openIds: readonly string[], activeTotal: number): Wizard {
  const open = new Set(openIds)
  return {
    ...wizard,
    step: clampStep(wizard.step, activeTotal),
    picks: keepOpen(wizard.picks, open),
    expanded: keepOpen(wizard.expanded, open),
    other: wizard.other !== null && open.has(wizard.other.id) ? wizard.other : null,
  }
}
