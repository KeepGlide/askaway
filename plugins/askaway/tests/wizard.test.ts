import { expect, test } from 'claude-code/testing'
import type { Question } from '../types'
import {
  EMPTY_WIZARD,
  activeGroup,
  alignOtherToLabels,
  back,
  choose,
  groupsOf,
  keptOther,
  next,
  pruneWizard,
  screenOf,
  submittable,
  submittedOther,
  submittedTypedOther,
  type Group,
  type Pick,
  type Wizard,
} from '../hooks/wizard'

// A question with the fields the wizard reads; the session and the project place it in a group.
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

// One group of the given questions, as groupsOf builds it.
function groupOf(...questions: Question[]): Group {
  const [group] = groupsOf(questions)
  if (group === undefined) throw new Error('no group')
  return group
}

const pickedAll = (ids: string[], base: Wizard = EMPTY_WIZARD): Wizard => ({
  ...base,
  picks: Object.fromEntries(ids.map(id => [id, A])),
})

// The screen of a group that has a question on it; a test that expects none fails here.
function screenAt(group: Group, wizard: Wizard) {
  const screen = screenOf(group, wizard)
  if (screen === undefined) throw new Error('no screen')
  return screen
}

test('groupsOf groups by project: two sessions of one project are one group, and the questions run session by session', () => {
  const groups = groupsOf([
    question('q-a-000001', 10, 's1'),
    question('q-b-000002', 20, 's2'),
    question('q-c-000003', 30, 's1'),
    question('q-d-000004', 40, 's2'),
  ])
  expect(groups.map(group => group.key)).toEqual(['/work/app'])
  expect(groups[0]?.questions.map(one => one.id)).toEqual(['q-a-000001', 'q-c-000003', 'q-b-000002', 'q-d-000004'])
})

test('groupsOf keeps the sessions in the order of their oldest question, and the questions oldest first within each', () => {
  const [group] = groupsOf([
    question('q-b-000002', 30, 's2'),
    question('q-a-000001', 20, 's1'),
    question('q-c-000003', 10, 's2'),
    question('q-d-000004', 40, 's1'),
  ])
  expect(group?.sessions.map(session => session.map(one => one.id))).toEqual([
    ['q-c-000003', 'q-b-000002'],
    ['q-a-000001', 'q-d-000004'],
  ])
  expect(group?.questions.map(one => one.id)).toEqual(['q-c-000003', 'q-b-000002', 'q-a-000001', 'q-d-000004'])
})

test('groupsOf keeps the questions with no session together in their project, and orders groups by their oldest question', () => {
  const groups = groupsOf([
    question('q-a-000001', 40, 's1', { project: '/work/web' }),
    question('q-b-000002', 20, null),
    question('q-c-000003', 30, null),
  ])
  expect(groups.map(group => group.key)).toEqual(['/work/app', '/work/web'])
  expect(groups[0]?.sessions).toHaveLength(1)
  expect(groups[0]?.questions.map(one => one.id)).toEqual(['q-b-000002', 'q-c-000003'])
})

test('groupsOf keeps two projects with the same folder name apart', () => {
  const groups = groupsOf([
    question('q-a-000001', 10, 's1', { project: '/home/one/app' }),
    question('q-b-000002', 20, 's1', { project: '/home/two/app' }),
  ])
  expect(groups.map(group => group.key)).toEqual(['/home/one/app', '/home/two/app'])
  expect(groups.map(group => group.questions.length)).toEqual([1, 1])
})

test('groupsOf groups by family: the sessions of one family are one group even across folders, keyed by the family', () => {
  const groups = groupsOf([
    question('q-a-000001', 10, 'root', { family: 'local_root', family_title: 'Big abstraction', project: '/work/app' }),
    question('q-b-000002', 20, 'child', { family: 'local_root', family_title: 'Big abstraction', project: '/work/app/scratch' }),
    question('q-c-000003', 30, 'root', { family: 'local_root', family_title: 'Big abstraction', project: '/work/app' }),
  ])
  expect(groups.map(group => group.key)).toEqual(['local_root'])
  expect(groups[0]?.sessions.map(questions => questions.map(one => one.id))).toEqual([['q-a-000001', 'q-c-000003'], ['q-b-000002']])
  expect(groups[0]?.questions.map(one => one.id)).toEqual(['q-a-000001', 'q-c-000003', 'q-b-000002'])
})

test('groupsOf keeps a family group apart from an old question of the same project, in the order of their oldest question', () => {
  const groups = groupsOf([
    question('q-a-000001', 10, 's1', { family: 'local_root', family_title: 'Big abstraction' }),
    question('q-b-000002', 20, 's2', { project: '/work/app' }),
    question('q-c-000003', 30, 's3', { family: 'local_root', family_title: 'Big abstraction' }),
  ])
  expect(groups.map(group => group.key)).toEqual(['local_root', '/work/app'])
  expect(groups.map(group => group.questions.map(one => one.id))).toEqual([['q-a-000001', 'q-c-000003'], ['q-b-000002']])
})

test('groupsOf of nothing open is empty', () => {
  expect(groupsOf([])).toEqual([])
})

test('activeGroup is the group the wizard names while it is open, else the first', () => {
  const groups = groupsOf([question('q-a-000001', 10, 's1', { project: '/work/app' }), question('q-b-000002', 20, 's2', { project: '/work/web' })])
  expect(activeGroup(groups, { ...EMPTY_WIZARD, groupKey: '/work/web' })?.key).toBe('/work/web')
  expect(activeGroup(groups, { ...EMPTY_WIZARD, groupKey: 'gone' })?.key).toBe('/work/app')
  expect(activeGroup(groups, EMPTY_WIZARD)?.key).toBe('/work/app')
  expect(activeGroup([], EMPTY_WIZARD)).toBeUndefined()
})

test('screenOf shows the first question with no back, and next is open even with no pick', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  const screen = screenAt(group, EMPTY_WIZARD)
  expect(screen.index).toBe(0)
  expect(screen.total).toBe(2)
  expect(screen.question.id).toBe('q-a-000001')
  expect(screen.canBack).toBe(false)
  expect(screen.canNext).toBe(true)
  expect(screen.canSubmit).toBe(false)
})

test('screenOf of the last question has no Next, and Submit all only when every question has a pick', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  const partial = screenAt(group, { ...EMPTY_WIZARD, step: 1, picks: { 'q-a-000001': A } })
  expect(partial.index).toBe(1)
  expect(partial.canNext).toBe(false)
  expect(partial.canBack).toBe(true)
  expect(partial.canSubmit).toBe(false)
  expect(screenAt(group, pickedAll(['q-a-000001', 'q-b-000002'], { ...EMPTY_WIZARD, step: 1 })).canSubmit).toBe(true)
})

test('screenOf of a group of one question is its question, with no Next, and Submit all once it is picked', () => {
  const group = groupOf(question('q-a-000001', 10))
  const unpicked = screenAt(group, EMPTY_WIZARD)
  expect(unpicked.canNext).toBe(false)
  expect(unpicked.canBack).toBe(false)
  expect(unpicked.canSubmit).toBe(false)
  expect(screenAt(group, pickedAll(['q-a-000001'])).canSubmit).toBe(true)
})

test('screenOf clamps a step past the group to its last question, and a negative one to the first', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  expect(screenAt(group, { ...EMPTY_WIZARD, step: 5 }).index).toBe(1)
  expect(screenAt(group, { ...EMPTY_WIZARD, step: -3 }).index).toBe(0)
  expect(screenOf({ key: 'empty', sessions: [], questions: [] }, EMPTY_WIZARD)).toBeUndefined()
})

test('the step of a group across sessions walks the tree order: session by session, oldest first', () => {
  const group = groupOf(question('q-a-000001', 10, 's1'), question('q-b-000002', 20, 's2'), question('q-c-000003', 30, 's1'))
  expect(screenAt(group, { ...EMPTY_WIZARD, step: 1 }).question.id).toBe('q-c-000003')
  expect(screenAt(group, { ...EMPTY_WIZARD, step: 2 }).question.id).toBe('q-b-000002')
})

test('choose records the pick and moves to the next question without one', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  const first = choose(EMPTY_WIZARD, group, 'q-a-000001', A)
  expect(first.picks).toEqual({ 'q-a-000001': A })
  expect(first.step).toBe(1)
})

test('choose once every question has a pick moves to the last question, where Submit all is', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  const second = choose({ ...EMPTY_WIZARD, step: 0, picks: { 'q-b-000002': B } }, group, 'q-a-000001', A)
  expect(second.step).toBe(1)
  expect(screenAt(group, second).canSubmit).toBe(true)
})

test('choose on the last question with a gap wraps to the first question without a pick', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20), question('q-c-000003', 30))
  expect(choose({ ...EMPTY_WIZARD, step: 2 }, group, 'q-c-000003', A).step).toBe(0)
  expect(choose({ ...EMPTY_WIZARD, step: 1, picks: { 'q-a-000001': A } }, group, 'q-b-000002', A).step).toBe(2)
})

test('choose on a group of one question records the pick and stays on it, submitting nothing', () => {
  const group = groupOf(question('q-a-000001', 10))
  const result = choose(EMPTY_WIZARD, group, 'q-a-000001', B)
  expect(result.picks).toEqual({ 'q-a-000001': B })
  expect(result.step).toBe(0)
  expect(screenAt(group, result).canSubmit).toBe(true)
})

test('choose keeps the picks of the other questions', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  const before = { ...EMPTY_WIZARD, picks: { 'q-b-000002': B } }
  const result = choose(before, group, 'q-a-000001', A)
  expect(result.picks).toEqual({ 'q-a-000001': A, 'q-b-000002': B })
  expect(before.picks).toEqual({ 'q-b-000002': B })
})

test('back moves one step and never goes below zero', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20), question('q-c-000003', 30))
  const at2: Wizard = { ...EMPTY_WIZARD, step: 2 }
  expect(back(at2, group).step).toBe(1)
  expect(back(back(back(at2, group), group), group).step).toBe(0)
  expect(at2.step).toBe(2)
})

test('next moves to the next question with or without a pick, and never past the last question', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  expect(next(EMPTY_WIZARD, group).step).toBe(1)

  const onLast: Wizard = { ...EMPTY_WIZARD, step: 1 }
  expect(next(onLast, group)).toBe(onLast)
})

test('next on a group of one question does nothing, picked or not', () => {
  const group = groupOf(question('q-a-000001', 10))
  const picked: Wizard = { ...EMPTY_WIZARD, picks: { 'q-a-000001': A } }
  expect(next(picked, group)).toBe(picked)
  expect(next(EMPTY_WIZARD, group)).toBe(EMPTY_WIZARD)
})

test('a prune that shrinks the group under the step leaves it on a real question, never past the group', () => {
  const wizard: Wizard = { ...EMPTY_WIZARD, step: 2, picks: { 'q-a-000001': A } }
  // q-c-000003 was answered elsewhere: the group now holds q-a and q-b, and only q-a has a pick.
  const pruned = pruneWizard(wizard, ['q-a-000001', 'q-b-000002'], 2)
  expect(pruned.step).toBe(1)
})

test('submittable lists every question in group order once all are picked, else undefined', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20))
  expect(submittable(group, pickedAll(['q-b-000002', 'q-a-000001']))).toEqual([
    { id: 'q-a-000001', pick: A },
    { id: 'q-b-000002', pick: A },
  ])
  expect(submittable(group, pickedAll(['q-a-000001']))).toBeUndefined()
  expect(submittable({ key: 'empty', sessions: [], questions: [] }, EMPTY_WIZARD)).toBeUndefined()
})

test('pruneWizard drops the picks of questions no longer open', () => {
  const wizard: Wizard = {
    ...EMPTY_WIZARD,
    groupKey: '/work/app',
    picks: { 'q-a-000001': A, 'q-gone-000002': B },
  }
  const pruned = pruneWizard(wizard, ['q-a-000001'], 1)
  expect(pruned.picks).toEqual({ 'q-a-000001': A })
  expect(Object.keys(wizard.picks)).toEqual(['q-a-000001', 'q-gone-000002'])
})

test('submittedOther records the trimmed text as the Other pick and keeps the wizard where it is', () => {
  const wizard: Wizard = { ...EMPTY_WIZARD, step: 1, picks: { 'q-a-000001': A } }
  const next = submittedOther(wizard, 'q-b-000002', '  Use a fork  ')
  expect(next.picks).toEqual({ 'q-a-000001': A, 'q-b-000002': { key: 'other', text: 'Use a fork' } })
  expect(next.step).toBe(1)
})

test('submittedOther with no kept label still records typed text as the Other pick (the pending path is unchanged)', () => {
  const typed = submittedOther({ ...EMPTY_WIZARD, picks: { 'q-a-000001': A } }, 'q-b-000002', '  Second text ')
  expect(typed.picks).toEqual({ 'q-a-000001': A, 'q-b-000002': { key: 'other', text: 'Second text' } })
})

test('submittedOther with a kept label leaves typed text unrecorded: the pick and the label stay the same', () => {
  const kept: Wizard = { ...EMPTY_WIZARD, picks: { 'q-a-000001': { key: 'other', text: 'First text' } }, labels: { 'q-a-000001': 'First text' } }
  expect(submittedOther(kept, 'q-a-000001', 'Second text')).toBe(kept)
  expect(submittedOther(kept, 'q-a-000001', 'Second text').picks).toEqual({ 'q-a-000001': { key: 'other', text: 'First text' } })
})

test('submittedOther with blank text takes an Other pick away, and leaves a chosen option alone', () => {
  const picked: Wizard = { ...EMPTY_WIZARD, picks: { 'q-a-000001': { key: 'other', text: 'Use a fork' } } }
  expect(submittedOther(picked, 'q-a-000001', '   ').picks).toEqual({})
  const option: Wizard = { ...EMPTY_WIZARD, picks: { 'q-a-000001': A } }
  expect(submittedOther(option, 'q-a-000001', '   ').picks).toEqual({ 'q-a-000001': A })
})

test('submittedOther keeps at most 500 code points of the trimmed text, so 600 typed characters store 500', () => {
  const long = submittedOther(EMPTY_WIZARD, 'q-a-000001', `  ${'x'.repeat(600)}  `).picks['q-a-000001']
  expect(long).toEqual({ key: 'other', text: 'x'.repeat(500) })
  // Code points, not UTF-16 units: an emoji counts as one.
  const emoji = submittedOther(EMPTY_WIZARD, 'q-a-000001', '😀'.repeat(600)).picks['q-a-000001']
  expect([...(emoji?.text ?? '')]).toHaveLength(500)
  expect(submittedOther(EMPTY_WIZARD, 'q-a-000001', 'y'.repeat(500)).picks['q-a-000001']?.text).toBe('y'.repeat(500))
})

test('submittedTypedOther records the typed text as the answer even while a label is kept (Submit all), and blank text takes the pick away', () => {
  const kept: Wizard = { ...EMPTY_WIZARD, picks: { 'q-a-000001': { key: 'other', text: 'First text' } }, labels: { 'q-a-000001': 'First text' } }
  expect(submittedTypedOther(kept, 'q-a-000001', '  Second text ').picks).toEqual({ 'q-a-000001': { key: 'other', text: 'Second text' } })
  expect(submittedTypedOther(kept, 'q-a-000001', 'Second text').labels).toEqual({ 'q-a-000001': 'First text' })
  expect(submittedTypedOther(kept, 'q-a-000001', '   ').picks).toEqual({})
})

test('alignOtherToLabels gives a draft Other pick the kept label as its text when the two differ, and leaves the rest alone', () => {
  const picks = {
    'q-a-000001': { key: 'other', text: 'Stale text' },
    'q-b-000002': A,
    'q-c-000003': { key: 'other', text: 'Same' },
    'q-d-000004': { key: 'other', text: 'Unlabelled' },
  }
  const labels = { 'q-a-000001': 'First text', 'q-c-000003': 'Same' }
  expect(alignOtherToLabels(picks, labels)).toEqual({
    'q-a-000001': { key: 'other', text: 'First text' },
    'q-b-000002': A,
    'q-c-000003': { key: 'other', text: 'Same' },
    'q-d-000004': { key: 'other', text: 'Unlabelled' },
  })
})

test('keptOther keeps the trimmed text as the label, at most 500 code points, and moves the field round on', () => {
  const kept = keptOther(EMPTY_WIZARD, 'q-a-000001', `  ${'x'.repeat(600)}  `)
  expect(kept.labels).toEqual({ 'q-a-000001': 'x'.repeat(500) })
  expect(kept.fieldRound).toBe(1)
  expect(keptOther(EMPTY_WIZARD, 'q-a-000001', '  Use a fork  ').labels).toEqual({ 'q-a-000001': 'Use a fork' })
})

test('keptOther with blank text changes nothing: the same wizard comes back, with the same field round', () => {
  const wizard: Wizard = { ...EMPTY_WIZARD, fieldRound: 2, picks: { 'q-a-000001': { key: 'other', text: 'Use a fork' } } }
  expect(keptOther(wizard, 'q-a-000001', '   ')).toBe(wizard)
})

test('keptOther drops the Other pick of that question and leaves an option pick alone', () => {
  const wizard: Wizard = { ...EMPTY_WIZARD, picks: { 'q-a-000001': { key: 'other', text: 'Old' }, 'q-b-000002': B } }
  expect(keptOther(wizard, 'q-a-000001', 'New').picks).toEqual({ 'q-b-000002': B })
  const option: Wizard = { ...EMPTY_WIZARD, picks: { 'q-a-000001': A } }
  expect(keptOther(option, 'q-a-000001', 'New').picks).toEqual({ 'q-a-000001': A })
})

test('keptOther on each Keep replaces the label and bumps the field round', () => {
  const once = keptOther(EMPTY_WIZARD, 'q-a-000001', 'First')
  const twice = keptOther(once, 'q-a-000001', 'Second')
  expect(twice.labels).toEqual({ 'q-a-000001': 'Second' })
  expect(twice.fieldRound).toBe(2)
})

test('pruneWizard drops the labels of questions no longer open', () => {
  const wizard: Wizard = { ...EMPTY_WIZARD, labels: { 'q-a-000001': 'Use a fork', 'q-gone-000002': 'Gone' } }
  expect(pruneWizard(wizard, ['q-a-000001'], 1).labels).toEqual({ 'q-a-000001': 'Use a fork' })
  expect(Object.keys(wizard.labels)).toEqual(['q-a-000001', 'q-gone-000002'])
})

test('pruneWizard clamps the step to the last question of the group on screen after the drop', () => {
  const wizard: Wizard = { ...EMPTY_WIZARD, step: 3 }
  expect(pruneWizard(wizard, [], 1).step).toBe(0)
  expect(pruneWizard(wizard, [], 2).step).toBe(1)
  expect(pruneWizard(wizard, [], 0).step).toBe(0)
})

test('every move keeps questionId on the question at the step', () => {
  const group = groupOf(question('q-a-000001', 10), question('q-b-000002', 20), question('q-c-000003', 30))
  const onB: Wizard = { ...EMPTY_WIZARD, step: 1, questionId: 'q-b-000002' }
  expect(next(onB, group).questionId).toBe('q-c-000003')
  expect(back(onB, group).questionId).toBe('q-a-000001')
  expect(choose(onB, group, 'q-b-000002', A).questionId).toBe('q-c-000003')
})
