import { expect, test } from 'claude-code/testing'
import type { Question } from '../types'
import {
  EMPTY_WIZARD,
  activeWindow,
  back,
  canReview,
  choose,
  jump,
  next,
  pruneWizard,
  screenOf,
  selectWindow,
  settle,
  submittable,
  toggleExpanded,
  windowKeyOf,
  windowsOf,
  type Pick,
  type Wizard,
  type WindowGroup,
} from '../hooks/wizard'

// A question with the fields the wizard reads; the session and the project place it in a window.
function question(id: string, ts: number, session: string | null = 's1', extra: Partial<Question> = {}): Question {
  return {
    id,
    ts,
    title: `Title ${id}`,
    question: `Which way for ${id}?`,
    project: '/work/app',
    session,
    options: [
      { key: 'A', label: 'Keep', fit: 80 },
      { key: 'B', label: 'Rewrite', fit: 40 },
    ],
    recommended: 'A',
    risk: 'low',
    ...extra,
  }
}

const A: Pick = { key: 'A' }
const B: Pick = { key: 'B' }

// One window of the given questions, as windowsOf builds it.
function groupOf(...questions: Question[]): WindowGroup {
  const [group] = windowsOf(questions)
  if (group === undefined) throw new Error('no group')
  return group
}

const pickedAll = (ids: string[], base: Wizard = EMPTY_WIZARD): Wizard => ({
  ...base,
  picks: Object.fromEntries(ids.map(id => [id, A])),
})

test('windowKeyOf is the session when there is one, and the project otherwise', () => {
  expect(windowKeyOf({ session: 'sess-1', project: '/work/app' })).toBe('sess-1')
  expect(windowKeyOf({ session: null, project: '/work/app' })).toBe('project:/work/app')
})

test('windowsOf groups by window, questions oldest first, groups in the order of their oldest question', () => {
  const groups = windowsOf([
    question('q-b-000002', 30, 's2'),
    question('q-a-000001', 20, 's1'),
    question('q-c-000003', 10, 's2'),
    question('q-d-000004', 40, 's1'),
  ])
  expect(groups.map(group => group.key)).toEqual(['s2', 's1'])
  expect(groups[0]?.questions.map(one => one.id)).toEqual(['q-c-000003', 'q-b-000002'])
  expect(groups[1]?.questions.map(one => one.id)).toEqual(['q-a-000001', 'q-d-000004'])
})

test('windowsOf labels a window by its project and session title, and groups a question with no session by project', () => {
  const groups = windowsOf([
    question('q-a-000001', 10, 's1', { session_title: 'Build' }),
    question('q-b-000002', 20, null),
    question('q-c-000003', 30, null),
  ])
  expect(groups.map(group => group.label)).toEqual(['app · Build', 'app'])
  expect(groups[1]?.key).toBe('project:/work/app')
  expect(groups[1]?.questions).toHaveLength(2)
})

test('windowsOf of nothing open is empty', () => {
  expect(windowsOf([])).toEqual([])
})

test('activeWindow is the window the wizard names while it is open, else the first', () => {
  const groups = windowsOf([question('q-a-000001', 10, 's1'), question('q-b-000002', 20, 's2')])
  expect(activeWindow(groups, { ...EMPTY_WIZARD, windowKey: 's2' })?.key).toBe('s2')
  expect(activeWindow(groups, { ...EMPTY_WIZARD, windowKey: 'gone' })?.key).toBe('s1')
  expect(activeWindow(groups, EMPTY_WIZARD)?.key).toBe('s1')
  expect(activeWindow([], EMPTY_WIZARD)).toBeUndefined()
})

test('screenOf shows the first question with no back, and next waits for a pick', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  const screen = screenOf(group, EMPTY_WIZARD)
  expect(screen.kind).toBe('question')
  if (screen.kind !== 'question') return
  expect(screen.index).toBe(0)
  expect(screen.total).toBe(2)
  expect(screen.question.id).toBe('q-a-000001')
  expect(screen.canBack).toBe(false)
  expect(screen.canNext).toBe(false)
})

test('screenOf shows the review after the last question, with every row and submit only when all are picked', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  const partial = { ...EMPTY_WIZARD, step: 2, picks: { 'q-a-000001': A } }
  const partialScreen = screenOf(group, partial)
  expect(partialScreen.kind).toBe('review')
  if (partialScreen.kind !== 'review') return
  expect(partialScreen.rows.map(row => row.pick)).toEqual([A, undefined])
  expect(partialScreen.canSubmit).toBe(false)

  const full = screenOf(group, pickedAll(['q-a-000001', 'q-b-000002'], { ...EMPTY_WIZARD, step: 2 }))
  expect(full.kind === 'review' && full.canSubmit).toBe(true)
})

test('screenOf never shows a review for a window of one question, and clamps a step past it', () => {
  const group = groupOf(question('q-a-000001', 10))
  for (const step of [0, 1, 5]) {
    const screen = screenOf(group, { ...EMPTY_WIZARD, step })
    expect(screen.kind).toBe('question')
    expect(screen.kind === 'question' && screen.index).toBe(0)
  }
})

test('screenOf clamps a negative step to the first question', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  const screen = screenOf(group, { ...EMPTY_WIZARD, step: -3 })
  expect(screen.kind === 'question' && screen.index).toBe(0)
})

test('choose records the pick and moves one step on, to the review after the last question', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  const first = choose(EMPTY_WIZARD, group, 'q-a-000001', A)
  expect(first.submit).toBe(false)
  expect(first.wizard.picks).toEqual({ 'q-a-000001': A })
  expect(first.wizard.step).toBe(1)

  const second = choose(first.wizard, group, 'q-b-000002', B)
  expect(second.submit).toBe(false)
  expect(second.wizard.step).toBe(2)
  expect(screenOf(group, second.wizard).kind).toBe('review')
})

test('choose on a window of one question submits at once and keeps the pick', () => {
  const group = groupOf(question('q-a-000001', 10))
  const result = choose(EMPTY_WIZARD, group, 'q-a-000001', B)
  expect(result.submit).toBe(true)
  expect(result.wizard.picks).toEqual({ 'q-a-000001': B })
  expect(result.wizard.step).toBe(0)
})

test('choose keeps the picks of the other questions', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  const before = { ...EMPTY_WIZARD, picks: { 'q-b-000002': B } }
  const result = choose(before, group, 'q-a-000001', A)
  expect(result.wizard.picks).toEqual({ 'q-a-000001': A, 'q-b-000002': B })
  expect(before.picks).toEqual({ 'q-b-000002': B })
})

test('back moves one step and never goes below zero', () => {
  const at2: Wizard = { ...EMPTY_WIZARD, step: 2 }
  expect(back(at2).step).toBe(1)
  expect(back(back(back(at2))).step).toBe(0)
  expect(at2.step).toBe(2)
})

test('next moves only when the question on screen has a pick, and never past the review', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  expect(next(EMPTY_WIZARD, group)).toBe(EMPTY_WIZARD)

  const picked = { ...EMPTY_WIZARD, picks: { 'q-a-000001': A } }
  expect(next(picked, group).step).toBe(1)
  expect(next({ ...EMPTY_WIZARD, step: 2, picks: { 'q-a-000001': A, 'q-b-000002': B } }, group).step).toBe(2)
})

test('next on a window of one question stays on its only question', () => {
  const group = groupOf(question('q-a-000001', 10))
  expect(next({ ...EMPTY_WIZARD, picks: { 'q-a-000001': A } }, group).step).toBe(0)
})

test('next on the last question with a gap stays there; with every question picked it reaches the review', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  const gap: Wizard = { ...EMPTY_WIZARD, step: 1, picks: { 'q-b-000002': B } }
  expect(next(gap, group)).toBe(gap)
  expect(next({ ...gap, picks: { 'q-a-000001': A, 'q-b-000002': B } }, group).step).toBe(2)
})

test('choose on the last question with a gap lands on the first unpicked question, not the review', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20), question('q-c-000003', 30))
  const chosen = choose({ ...EMPTY_WIZARD, step: 2 }, group, 'q-c-000003', A)
  expect(chosen.wizard.step).toBe(0)
  expect(screenOf(group, chosen.wizard).kind).toBe('question')
  expect(choose({ ...EMPTY_WIZARD, step: 1, picks: { 'q-a-000001': A } }, group, 'q-b-000002', A).wizard.step).toBe(2)
})

test('settle keeps a question step, and moves a review step with a gap to the first unpicked question', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20), question('q-c-000003', 30))
  const onReview: Wizard = { ...EMPTY_WIZARD, step: 3, picks: { 'q-b-000002': B } }
  expect(settle(onReview, group).step).toBe(0)
  expect(settle({ ...onReview, step: 1 }, group).step).toBe(1)
  expect(settle({ ...onReview, picks: { 'q-a-000001': A, 'q-b-000002': B, 'q-c-000003': A } }, group).step).toBe(3)
})

test('prune dropping the current question while another is unpicked never leaves the step on the review', () => {
  const wizard: Wizard = { ...EMPTY_WIZARD, step: 2, picks: { 'q-a-000001': A } }
  // q-c-000003 was answered elsewhere: the window now holds q-a and q-b, and only q-a has a pick.
  const pruned = pruneWizard(wizard, ['q-a-000001', 'q-b-000002'], 2)
  const prunedGroup = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  expect(settle(pruned, prunedGroup).step).toBe(1)
})

test('jump lands on a question step, and never below the first', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20), question('q-c-000003', 30))
  expect(jump(EMPTY_WIZARD, group, 1).step).toBe(1)
  expect(jump(EMPTY_WIZARD, group, -1).step).toBe(0)
})

test('jump to the review step (index === total) works only when every question has a pick', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20), question('q-c-000003', 30))
  const partial = pickedAll(['q-a-000001', 'q-b-000002'])
  expect(canReview(group, pickedAll(['q-a-000001', 'q-b-000002', 'q-c-000003']))).toBe(true)
  expect(canReview(group, partial)).toBe(false)
  expect(jump(partial, group, 3)).toBe(partial)
  expect(jump(EMPTY_WIZARD, group, 9).step).toBe(0)
  expect(jump(pickedAll(['q-a-000001', 'q-b-000002', 'q-c-000003']), group, 3).step).toBe(3)
})

test('a window of one question has no review step, so jump does not reach one', () => {
  const single = groupOf(question('q-a-000001', 10))
  const picked = pickedAll(['q-a-000001'])
  expect(canReview(single, picked)).toBe(false)
  expect(jump(picked, single, 1).step).toBe(0)
})

test('toggleExpanded flips one question\'s explanation and leaves the others', () => {
  const opened = toggleExpanded(EMPTY_WIZARD, 'q-a-000001')
  expect(opened.expanded).toEqual({ 'q-a-000001': true })
  expect(toggleExpanded(opened, 'q-a-000001').expanded).toEqual({ 'q-a-000001': false })
  expect(EMPTY_WIZARD.expanded).toEqual({})
})

test('selectWindow goes back to the first question and keeps the picks', () => {
  const wizard: Wizard = { ...EMPTY_WIZARD, windowKey: 's1', step: 2, picks: { 'q-a-000001': A } }
  const switched = selectWindow(wizard, 's2')
  expect(switched.windowKey).toBe('s2')
  expect(switched.step).toBe(0)
  expect(switched.picks).toEqual({ 'q-a-000001': A })
})

test('submittable lists every question in group order once all are picked, else undefined', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  expect(submittable(group, pickedAll(['q-b-000002', 'q-a-000001']))).toEqual([
    { id: 'q-a-000001', pick: A },
    { id: 'q-b-000002', pick: A },
  ])
  expect(submittable(group, pickedAll(['q-a-000001']))).toBeUndefined()
  expect(submittable({ key: 'empty', label: '', questions: [] }, EMPTY_WIZARD)).toBeUndefined()
})

test('pruneWizard drops the picks, expanded flags and Other draft of questions no longer open', () => {
  const wizard: Wizard = {
    windowKey: 's1',
    step: 0,
    picks: { 'q-a-000001': A, 'q-gone-000002': B },
    other: 'q-gone-000002',
    expanded: { 'q-a-000001': true, 'q-gone-000002': true },
  }
  const pruned = pruneWizard(wizard, ['q-a-000001'], 1)
  expect(pruned.picks).toEqual({ 'q-a-000001': A })
  expect(pruned.expanded).toEqual({ 'q-a-000001': true })
  expect(pruned.other).toBeNull()
  expect(Object.keys(wizard.picks)).toEqual(['q-a-000001', 'q-gone-000002'])
})

test('pruneWizard keeps the Other field of a question that is still open', () => {
  const wizard: Wizard = { ...EMPTY_WIZARD, other: 'q-a-000001' }
  expect(pruneWizard(wizard, ['q-a-000001'], 1).other).toBe('q-a-000001')
})

test('pruneWizard clamps the step to the size of the window on screen after the drop', () => {
  const wizard: Wizard = { ...EMPTY_WIZARD, step: 3 }
  expect(pruneWizard(wizard, [], 1).step).toBe(0)
  expect(pruneWizard(wizard, [], 2).step).toBe(2)
  expect(pruneWizard(wizard, [], 0).step).toBe(0)
})
