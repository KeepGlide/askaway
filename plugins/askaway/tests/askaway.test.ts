import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import {
  ageLabel,
  counterText,
  deliveryLine,
  groupBySession,
  jevLine,
  listText,
  parseQuestion,
  riskLabel,
  sectionsOf,
  statusLines,
} from '../hooks/model'
import type { Answer, Board } from '../types'

const HOME = '/test-home'
const STATE = `${HOME}/.claude/state/askaway`
const SESSION = { cwd: '/work/app', surface: 'terminal', isInteractive: true } as const
const PANE_PROPS = {
  title: 'Askaway',
  isFocused: false,
  bodyColumns: 100,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const
const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const
const SURFACES = ['terminal', 'desktop'] as const

// A question as askaway.py writes it (SPEC.md), with the fields a test changes passed in.
function question(id: string, ts: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    id,
    ts,
    project: '/work/app',
    session: null,
    run_kind: 'main',
    title: `Title ${id}`,
    question: `Which way for ${id}?`,
    options: [
      { key: 'A', label: 'Keep', tradeoff: 'cheap', fit: 80 },
      { key: 'B', label: 'Rewrite', tradeoff: 'slow', fit: 40 },
    ],
    recommended: 'A',
    why: 'It is smaller.',
    risk: 'low',
    pause: false,
    source: 'cli',
    ...extra,
  })
}

// A question exactly as askaway.py writes it when the optional fields are not given: null, not absent.
function nullFieldQuestion(id: string, ts: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    id,
    ts,
    project: '/work/app',
    session: null,
    run_kind: 'main',
    title: `Title ${id}`,
    question: `Which way for ${id}?`,
    context: null,
    options: [
      { key: 'A', label: 'Keep', tradeoff: null, fit: null },
      { key: 'B', label: 'Rewrite', tradeoff: null, fit: null },
    ],
    recommended: 'A',
    why: null,
    analogy: null,
    how: null,
    gains: null,
    losses: null,
    session_title: null,
    risk: 'low',
    pause: false,
    source: 'cli',
    ...extra,
  })
}

const answer = (id: string, key: string, ts = 1): string => JSON.stringify({ id, key, by: 'panel', ts })
const delivery = (id: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ id, session: 's', ts: 2, ...extra })
const path = (dir: string, id: string): string => `${STATE}/${dir}/${id}.json`

// The session id the host answers for `$.session.id()`; a question filed by this session carries it.
const SELF = 'sess-self'

// Gates a test can close: a write, or the listing of the answer folder, waits until the test releases it.
type Holds = { write?: Promise<void>; listAnswers?: Promise<void> }

// The engine's file calls, answered from an in-memory folder. A read of a missing file rejects, as the host does.
// The listing of the answer folder is taken as the disk stands at the call, then the host waits for its hold,
// so a poll can read the folder before a press lands and apply its board after it. The language comes from the
// environment: LANG is pt-BR unless a test says otherwise (LANG '' reads as unset, so the pane reads in English).
function stubHost(
  on: On,
  files: Map<string, string>,
  isPlaced = true,
  stored: Record<string, unknown> = {},
  holds: Holds = {},
  env: Record<string, string> = {},
) {
  const toasts: string[] = []
  const writes: string[] = []
  const submits: string[] = []
  const clock = mock.clock(on)
  mock.env(on, { HOME, LANG: 'pt_BR.UTF-8', ...env })
  mock.store(on, stored)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF }))
  on('prompt.submit', (_$, e) => {
    submits.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow terminal' } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn beneath'] }))
  on('fs.list', async (_$, e) => {
    const prefix = `${e.path}/`
    const names = [...files.keys()].filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
    const listing = names.map(file => ({ name: file.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))
    if (e.path === `${STATE}/a`) await holds.listAnswers
    return { value: listing }
  })
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.write', async (_$, e) => {
    await holds.write
    writes.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  return { toasts, writes, submits, clock }
}

// A promise a test releases by calling the returned function.
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {}
  const promise = new Promise<void>(resolve => {
    open = resolve
  })
  return { promise, open }
}

// Runs the /askaway command the way the composer does (the engine's command.run input needs the origin and the surface).
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'askaway', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const readJson = (files: Map<string, string>, file: string): Record<string, unknown> =>
  JSON.parse(files.get(file) ?? '{}') as Record<string, unknown>

const mountPane = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'askaway', surface, component: 'Pane', requestId: 'askaway', props: PANE_PROPS })

const mountBand = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'askaway', surface, component: 'AbovePrompt', props: BAND_PROPS })

// Every Text the pane draws, in order.
const textsOf = async (ui: Awaited<ReturnType<typeof mountPane>>): Promise<string[]> =>
  (await ui.findAll({ type: 'Text' })).map(found => found.text)

// The label a Button is drawn with, by its key; undefined when it is not drawn.
const labelOf = async (ui: Awaited<ReturnType<typeof mountPane>>, key: string): Promise<unknown> =>
  (await ui.find({ type: 'Button', key }))?.props.label

// Every node of a drawn tree, depth first. A found element's props leave out `hover`, so the tree is read for it.
const nodesOf = (node: unknown): Record<string, unknown>[] => {
  if (typeof node !== 'object' || node === null) return []
  const element = node as Record<string, unknown>
  const children = Array.isArray(element.children) ? element.children : []
  return [element, ...children.flatMap(nodesOf)]
}

// Pure model rules: these run with no engine, so they stay green while the pane and register are being ported.
const parsedQuestion = (id: string, ts: number, extra: Record<string, unknown> = {}) => {
  const parsed = parseQuestion(JSON.parse(question(id, ts, extra)), id)
  if (parsed === undefined) throw new Error(`fixture ${id} did not parse`)
  return parsed
}
const answerOf = (id: string, key: string, ts: number, text?: string): Answer => ({ id, key, by: 'panel', ts, text })
const NO_STATUS = { cleared: [], shownAt: {}, now: 0, leaving: {} } as const

test('model: parseQuestion keeps each option tradeoff, and a missing or blank one reads as absent', () => {
  const withTradeoff = parsedQuestion('q-m-000001', 10)
  expect(withTradeoff.options.map(option => option.tradeoff)).toEqual(['cheap', 'slow'])
  const bare = parseQuestion(JSON.parse(nullFieldQuestion('q-m-000002', 10)), 'q-m-000002')
  expect(bare?.options.map(option => option.tradeoff)).toEqual([undefined, undefined])
  const blank = parseQuestion({ ...JSON.parse(question('q-m-000003', 10)), options: [{ key: 'A', label: 'Keep', tradeoff: '  ', fit: 1 }, { key: 'B', label: 'Rewrite', fit: 2 }] }, 'q-m-000003')
  expect(blank?.options[0]?.tradeoff).toBeUndefined()
})

test('model: the delivery line is English, names the recommended option when another was chosen, and quotes Other text', () => {
  const q = parsedQuestion('q-m-000001', 10)
  expect(deliveryLine(q, answerOf('q-m-000001', 'B', 1))).toBe(
    'The user answered Askaway question q-m-000001 (Title q-m-000001): B · Rewrite. (you were using A · Keep)',
  )
  expect(deliveryLine(q, answerOf('q-m-000001', 'A', 1))).toBe('The user answered Askaway question q-m-000001 (Title q-m-000001): A · Keep.')
  expect(deliveryLine(q, answerOf('q-m-000001', 'other', 1, '  Use a  queue '))).toBe(
    'The user answered Askaway question q-m-000001 (Title q-m-000001): their own answer (Other): "Use a queue". (you were using A · Keep)',
  )
  expect(deliveryLine(q, answerOf('q-m-000001', 'Z', 1))).toBeUndefined()
})

test('model: the counter reads in English and Portuguese, singular and plural, with the window count', () => {
  const two = [parsedQuestion('q-m-000001', 10, { session: 's1' }), parsedQuestion('q-m-000002', 20, { session: 's2' })]
  expect(counterText('en', two)).toBe('2 pending · 2 windows')
  expect(counterText('pt', two)).toBe('2 pendentes · 2 janelas')
  expect(counterText('pt', two.slice(0, 1))).toBe('1 pendente · 1 janela')
  expect(counterText('en', [])).toBe('Nothing pending')
  expect(counterText('pt', [])).toBe('Nenhuma pendente')
})

test('model: the counter counts a question with no session by its project', () => {
  const noSession = [parsedQuestion('q-m-000001', 10), parsedQuestion('q-m-000002', 20)]
  expect(counterText('en', noSession)).toBe('2 pending · 1 window')
})

test('model: the risk label reads in each language, and an unknown risk keeps its name', () => {
  expect(riskLabel('pt', 'high')).toBe('🛑 risco alto')
  expect(riskLabel('en', 'medium')).toBe('⚠️ medium risk')
  expect(riskLabel('en', 'low')).toBe('✅ low risk')
  expect(riskLabel('en', 'extreme')).toBe('⚠️ extreme risk')
  expect(riskLabel('pt', 'constructor')).toBe('⚠️ risco constructor')
})

test('model: the age label reads now, minutes, hours and days in both languages', () => {
  const HOUR = 3_600_000
  expect(ageLabel('en', 0, 0)).toBe('now')
  expect(ageLabel('pt', 0, 0)).toBe('agora')
  expect(ageLabel('en', 0, 5 * 60_000)).toBe('5 min ago')
  expect(ageLabel('pt', 0, 3 * HOUR)).toBe('há 3 h')
  expect(ageLabel('en', 0, 72 * HOUR)).toBe('3 d ago')
  expect(ageLabel('pt', 0, 72 * HOUR)).toBe('há 3 d')
})

test('model: the status lines read in the chosen language, and a session that ended keeps its line', () => {
  const q = parsedQuestion('q-m-000001', 10)
  const board: Board = { questions: [q], answers: [answerOf('q-m-000001', 'B', 1)], delivered: [] }
  expect(statusLines('pt', board, NO_STATUS).map(line => line.text)).toEqual(['⏳ Resposta B enviada para app'])
  expect(statusLines('en', board, NO_STATUS).map(line => line.text)).toEqual(['⏳ Answer B sent to app'])

  const orphan: Board = { questions: [], answers: [answerOf('q-m-000001', 'B', 1)], delivered: [] }
  expect(statusLines('pt', orphan, NO_STATUS).map(line => line.text)).toEqual(['⏳ Resposta B enviada para a sessão'])

  const ended: Board = {
    questions: [q],
    answers: [answerOf('q-m-000001', 'B', 1)],
    delivered: [{ id: 'q-m-000001', expired: true, reason: 'session-ended' }],
  }
  const [line] = statusLines('en', ended, NO_STATUS)
  expect(line).toEqual({ id: 'q-m-000001', text: '⚠️ app ended before reading answer B', dismissable: true })
})

test('model: each explanation section reads in the chosen language and shows only the fields set', () => {
  const short = parsedQuestion('q-m-000001', 10)
  expect(sectionsOf('pt', short)).toEqual([{ heading: '💡 Por que A', body: 'It is smaller.' }])
  expect(sectionsOf('en', short)).toEqual([{ heading: '💡 Why A', body: 'It is smaller.' }])

  const full = parsedQuestion('q-m-000002', 10, { context: 'C', analogy: 'An', how: 'H', gains: 'G', losses: 'L' })
  expect(sectionsOf('pt', full).map(section => section.heading)).toEqual([
    '🧭 Contexto e origem',
    '🔁 Analogia',
    '💡 Por que A',
    '🛠️ Como',
    '🎁 O que ganhamos · ⚖️ O que perdemos',
  ])
  expect(sectionsOf('en', full)[4]).toEqual({ heading: '🎁 What we gain · ⚖️ What we lose', body: 'G L' })

  const gainsOnly = parsedQuestion('q-m-000003', 10, { gains: 'G' })
  expect(sectionsOf('en', gainsOnly)[1]).toEqual({ heading: '🎁 What we gain', body: 'G' })
})

test('model: the list header and rows read in each language, with away mode when it is on', () => {
  const q = parsedQuestion('q-m-000001', 10)
  expect(listText('en', [q], true)).toBe(
    'Askaway: 1 open, away mode on.\nopen · q-m-000001 · Title q-m-000001 (recommended A)',
  )
  expect(listText('pt', [q], true)).toBe(
    'Askaway: 1 pendente, modo ausente ligado.\npendente · q-m-000001 · Title q-m-000001 (recomendada A)',
  )
  expect(listText('pt', [], false)).toBe('Askaway: 0 pendentes.')
})

test('model: the due answers group by asking session, and a question with no session is never grouped', () => {
  const board: Board = {
    questions: [
      parsedQuestion('q-m-000001', 10, { session: 's1' }),
      parsedQuestion('q-m-000002', 20, { session: 's2' }),
      parsedQuestion('q-m-000003', 30),
      parsedQuestion('q-m-000004', 40, { session: 's1' }),
    ],
    answers: [
      answerOf('q-m-000001', 'A', 0),
      answerOf('q-m-000002', 'B', 0),
      answerOf('q-m-000003', 'B', 0),
      answerOf('q-m-000004', 'A', 99_000),
    ],
    delivered: [],
  }
  const groups = groupBySession(board, 100_000)
  expect(groups.map(group => group.session)).toEqual(['s1', 's2'])
  expect(groups[0]?.items.map(item => item.answer.id)).toEqual(['q-m-000001'])
  expect(groups[1]?.items.map(item => item.text)).toEqual([
    'The user answered Askaway question q-m-000002 (Title q-m-000002): B · Rewrite. (you were using A · Keep)',
  ])
  expect(groupBySession({ ...board, delivered: [{ id: 'q-m-000002', expired: false }] }, 100_000).map(group => group.session)).toEqual(['s1'])
})

test('model: the JEV line lists each fit in order, with "-" for a null fit, and is absent when no option has one', () => {
  const fits = parsedQuestion('q-m-000001', 10).options
  expect(jevLine(fits)).toBe('🔷 A 80% · B 40%')
  expect(jevLine([{ key: 'A', label: 'Keep', fit: null }, { key: 'B', label: 'Rewrite', fit: 40 }])).toBe('🔷 A - · B 40%')
  expect(jevLine([{ key: 'A', label: 'Keep', fit: null }, { key: 'B', label: 'Rewrite', fit: null }])).toBeUndefined()
})

test('the pane shows the oldest open question first, with its progress, and hides answered, delivered and broken files', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 1500)],
    [path('q', 'q-l4-dddddd'), question('q-l4-dddddd', 500)],
    [path('a', 'q-l3-cccccc'), answer('q-l3-cccccc', 'B')],
    [path('a', 'q-l4-dddddd'), answer('q-l4-dddddd', 'A')],
    [path('d', 'q-l4-dddddd'), delivery('q-l4-dddddd')],
    [path('q', 'q-l9-ffffff'), '{"id":'],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const texts = await textsOf(ui)
    expect(texts).toContain('1 Title q-l1-aaaaaa')
    expect(texts).toContain('Which way for q-l1-aaaaaa?')
    expect(texts.some(text => text.includes('q-l2') || text.includes('q-l3') || text.includes('q-l4'))).toBe(false)
    await ui.unmount()
  }
})

test('the origin line adds the session title when the question has one, and drops the segment when not', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session_title: 'Spec-49 follow-ups' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await textsOf(ui)).toContain('app · Spec-49 follow-ups')
  await ui.unmount()
})

test('a single-question window submits at once: a click writes the answer, the card fades for 250 ms, then leaves', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', key: 'B', by: 'panel' })
  // Right after the press the card is still listed and drawn dim, its buttons are dimmed too.
  expect((await ui.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-A' }))?.props.dimColor).toBe(true)
  await clock.advance(249)
  expect(await ui.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' })).toBeDefined()
  await clock.advance(1)
  const texts = await textsOf(ui)
  expect(texts).not.toContain('Which way for q-l1-aaaaaa?')
  expect(texts).toContain('Nenhuma pendente')
  expect(texts).toContain('⏳ Resposta B enviada para app')
  await ui.unmount()
})

test('a card that is fading ignores a second press', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'B' })
  await ui.unmount()
})

test('a click picks and advances; the review then submits every answer of the window in one go', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(writes).toEqual([])
  expect(await textsOf(ui)).toContain('2 Title q-l2-bbbbbb')
  await ui.press({ key: 'opt-q-l2-bbbbbb-A' })
  expect(writes).toEqual([])
  expect(await textsOf(ui)).toContain('Revise suas respostas')
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'B' })
  expect(readJson(files, path('a', 'q-l2-bbbbbb'))).toMatchObject({ key: 'A' })
  await clock.advance(250)
  expect(await textsOf(ui)).toContain('Nenhuma pendente')
  await ui.unmount()
})

test('review gating: Next does not pass a question with no pick, so the review and Submit all never appear', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('1 Title q-l1-aaaaaa')
  expect(await ui.find({ type: 'Button', key: 'submit-all' })).toBeUndefined()
  expect(writes).toEqual([])
  await ui.unmount()
})

test('Back keeps the picks: the picked option stays the primary button when the step comes back', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  await ui.press({ key: 'nav-back' })
  expect(await textsOf(ui)).toContain('1 Title q-l1-aaaaaa')
  expect((await ui.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).toBe('primary')
  expect(writes).toEqual([])
  await ui.unmount()
})

test('two windows are two rounds: each is submitted on its own, and the window selector switches between them', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's-a' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's-b' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { session: 's-a' })],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'window-s-b' })
  expect(await textsOf(ui)).toContain('Which way for q-l2-bbbbbb?')
  await ui.press({ key: 'window-s-a' })
  await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
  await ui.press({ key: 'opt-q-l3-cccccc-B' })
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l3-cccccc')])
  await clock.advance(250)
  expect(await ui.find({ type: 'Button', key: 'window-s-a' })).toBeUndefined()
  await ui.press({ key: 'opt-q-l2-bbbbbb-A' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l3-cccccc'), path('a', 'q-l2-bbbbbb')])
  await ui.unmount()
})

test('a question answered elsewhere leaves the round: its pick is pruned on the next poll', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  files.set(path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A', 500))
  await clock.advance(5000)
  const texts = await textsOf(ui)
  expect(texts).not.toContain('Which way for q-l2-bbbbbb?')
  expect(texts).toContain('1 pendente · 1 janela')
  expect(writes).toEqual([])
  await ui.unmount()
})

test('no 🎯 and no tooltip: the recommended option says "(Recomendada)" in its text, bold while not picked', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '🎯' })).toBeUndefined()
  expect(await ui.find({ type: 'Box', key: 'rec-q-l1-aaaaaa' })).toBeUndefined()
  const isAbsoluteBox = (node: Record<string, unknown>): boolean =>
    node.type === 'Box' && (node.props as Record<string, unknown> | undefined)?.position === 'absolute'
  expect(nodesOf(await ui.drawn()).filter(isAbsoluteBox)).toHaveLength(0)
  expect(await labelOf(ui, 'opt-q-l1-aaaaaa-A')).toBe('1. Keep (Recomendada)')
  expect(await ui.find({ type: 'Text', text: '1. Keep (Recomendada)' })).toMatchObject({ props: { bold: true } })
  await ui.unmount()
})

test('each option is one full-width column with its tradeoff under it, numbered, and Other… is the last one', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await labelOf(ui, 'opt-q-l1-aaaaaa-B')).toBe('2. Rewrite')
  expect(await labelOf(ui, 'other-q-l1-aaaaaa')).toBe('3. Outra resposta…')
  for (const key of ['optrow-q-l1-aaaaaa-A', 'optrow-q-l1-aaaaaa-B']) {
    expect((await ui.find({ type: 'Box', key }))?.props.flexDirection).toBe('column')
  }
  expect(await ui.find({ type: 'Text', text: 'cheap' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'slow' })).toBeDefined()
  await ui.unmount()
})

test('every status line takes the one green pair, the ⚠️ lines included', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A')],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: true, reason: 'ttl' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'B')],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const expired = await ui.find({ type: 'Text', text: '⚠️ Resposta A expirou sem ser lida' })
  const pending = await ui.find({ type: 'Text', text: '⏳ Resposta B enviada para app' })
  expect(expired?.props.color).toBe('#166534')
  expect(pending?.props.color).toBe('#166534')
  const rowFills = (await ui.findAll({ type: 'Box' })).map(box => box.props.backgroundColor).filter(fill => fill !== undefined)
  expect(rowFills).toHaveLength(2)
  expect(new Set(rowFills)).toEqual(new Set(['#DCFCE7']))
  await ui.unmount()
})

test('the header counts open questions and their windows', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's1' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { session: 's2' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '📥 Askaway' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '3 pendentes · 2 janelas' })).toBeDefined()
  await ui.unmount()
})

test('the header reads Nenhuma pendente when no question is open', async ($, on) => {
  stubHost(on, new Map())
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Nenhuma pendente' })).toBeDefined()
  await ui.unmount()
})

test('the header counts a question with no session by its project', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { project: '/work/api' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '3 pendentes · 2 janelas' })).toBeDefined()
  await ui.unmount()
})

test('only the recommended option says "(Recomendada)", and the JEV line lists the fits in order', async ($, on) => {
  const files = new Map([
    [
      path('q', 'q-l1-aaaaaa'),
      question('q-l1-aaaaaa', 1000, {
        recommended: 'B',
        options: [
          { key: 'A', label: 'SQLite', fit: 82 },
          { key: 'B', label: 'JSONL', fit: 55 },
          { key: 'C', label: 'No cache', fit: 31 },
        ],
      }),
    ],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.findAll({ type: 'Text', text: /\(Recomendada\)$/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: '🎯' })).toHaveLength(0)
  const texts = await textsOf(ui)
  expect(texts.filter(text => text.startsWith('🔷'))).toEqual(['🔷 A 82% · B 55% · C 31%'])
  expect(texts).not.toContain('💡 Por que B')
  await ui.press({ key: 'more-q-l1-aaaaaa' })
  expect(await textsOf(ui)).toContain('💡 Por que B')
  await ui.unmount()
})

test('each explanation section shows only when its field is set, behind More, with the subtitle for what is set', async ($, on) => {
  const files = new Map([
    [
      path('q', 'q-l1-aaaaaa'),
      question('q-l1-aaaaaa', 1000, { context: 'Why now.', analogy: 'Like a phone book.', how: 'A table.', gains: 'Fast reads.', losses: 'A file to back up.' }),
    ],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect((await textsOf(ui)).filter(text => text.startsWith('🧭'))).toEqual([])
  await ui.press({ key: 'more-q-l1-aaaaaa' })
  const texts = await textsOf(ui)
  expect(texts.filter(text => text.startsWith('🧭'))).toEqual(['🧭 Contexto e origem'])
  expect(texts).toContain('Why now.')
  expect(texts).toContain('🔁 Analogia')
  expect(texts).toContain('Like a phone book.')
  expect(texts).toContain('💡 Por que A')
  expect(texts).toContain('🛠️ Como')
  expect(texts).toContain('🎁 O que ganhamos · ⚖️ O que perdemos')
  expect(texts).toContain('Fast reads. A file to back up.')
  await ui.unmount()
})

test('a losses-only question shows its subtitle for the losses alone, and a gains-only one for the gains', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { losses: 'Extra file.' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { gains: 'Quick answers.' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'more-q-l1-aaaaaa' })
  const losses = await textsOf(ui)
  expect(losses).toContain('⚖️ O que perdemos')
  expect(losses).toContain('Extra file.')
  expect(losses.some(text => text.startsWith('🎁'))).toBe(false)
  await ui.unmount()
})

test('a question with every optional field null draws its card with no sections and no JEV line', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), nullFieldQuestion('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const texts = await textsOf(ui)
    expect(texts).toContain('Which way for q-l1-aaaaaa?')
    expect(texts.some(text => /^(🧭|🔁|💡|🛠️|🎁|⚖️|🔷)/u.test(text))).toBe(false)
    await ui.unmount()
  }
})

test('a legacy question with tradeoff and no how, gains, losses or session title draws without empty sections', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'more-q-l1-aaaaaa' })
  const texts = await textsOf(ui)
  expect(texts).toContain('💡 Por que A')
  expect(texts).toContain('It is smaller.')
  expect(texts).toContain('cheap')
  expect(texts.filter(text => /^(🛠️|🎁|⚖️)/u.test(text))).toEqual([])
  expect(texts.filter(text => text.trim() === '')).toEqual([])
  await ui.unmount()
})

test('a pending answer shows "enviada", then "entregue" for 30 seconds after the pane first sees the delivery', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 5000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  let ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '⏳ Resposta B enviada para app' })).toBeDefined()
  await ui.unmount()
  files.set(path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa'))
  await clock.advance(5000)
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '✅ Resposta B entregue para app (lida pela sessão)' })).toBeDefined()
  await ui.unmount()
  // This 36 s advance runs a poll every 5 s; the last one lands 35 s after the first sighting, past the 30 s the line stays for.
  await clock.advance(36_000)
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /entregue para app/ })).toBeUndefined()
  await ui.unmount()
})

test('a delivered line is still drawn about 25 seconds after the first sighting, and gone by 35 seconds', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 5000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  files.set(path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa'))
  await clock.advance(5000) // the poll at 5 s is the first sighting
  await clock.advance(25_000) // the poll at 30 s: 25 s on screen
  let ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '✅ Resposta B entregue para app (lida pela sessão)' })).toBeDefined()
  await ui.unmount()
  await clock.advance(10_000) // the poll at 40 s: 35 s on screen
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /entregue para app/ })).toBeUndefined()
  await ui.unmount()
})

test('a delivery already waiting at the first poll stays hidden, since the session never saw it arrive', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 5000)],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa')],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(60_000)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /entregue para app/ })).toBeUndefined()
  await ui.unmount()
})

test('an expired answer with no reason reads as expired unread', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: true })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '⚠️ Resposta B expirou sem ser lida' })).toBeDefined()
  await ui.unmount()
})

test('a legacy answer written by accept_recommended reads as a normal status line', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), JSON.stringify({ id: 'q-l1-aaaaaa', key: 'A', by: 'accept_recommended', ts: 5000 })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '⏳ Resposta A enviada para app' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' })).toBeUndefined()
  await ui.unmount()
})

test('an expired answer whose session ended stays until the person dismisses it, and the dismiss writes no state file', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session_title: 'Spec-49 follow-ups' })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: true, reason: 'session-ended' })],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const warning = '⚠️ app · Spec-49 follow-ups encerrou antes de ler a resposta B'
  await clock.advance(60_000)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: warning })).toBeDefined()
  await ui.press({ key: 'dismiss-q-l1-aaaaaa' })
  expect(await ui.find({ type: 'Text', text: warning })).toBeUndefined()
  expect(writes).toEqual([])
  await ui.unmount()
})

test('a line dismissed before a restart stays hidden after it', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: true, reason: 'ttl' })],
  ])
  stubHost(on, files, true, { cleared: ['q-l1-aaaaaa'] })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '⚠️ Resposta B expirou sem ser lida' })).toBeUndefined()
  await ui.unmount()
})

test('the risk label reads in pt-BR for low, medium and high, with the age after it, one window each', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { risk: 'low', session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { risk: 'medium', session: 's2' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { risk: 'high', session: 's3' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^✅ risco baixo · / })).toBeDefined()
  await ui.press({ key: 'window-s2' })
  expect(await ui.find({ type: 'Text', text: /^⚠️ risco médio · / })).toBeDefined()
  await ui.press({ key: 'window-s3' })
  expect(await ui.find({ type: 'Text', text: /^🛑 risco alto · / })).toBeDefined()
  await ui.unmount()
})

test('the header has no Away, Paused, Clear answered or Accept all controls', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { pause: true, risk: 'high' })],
    [`${STATE}/away.json`, JSON.stringify({ on: true, ts: 1 })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: ' Away ' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: ' Paused ' })).toBeUndefined()
  expect(await ui.find({ key: 'clear-answered' })).toBeUndefined()
  expect(await ui.find({ key: 'accept-all' })).toBeUndefined()
  await ui.unmount()
})

test('a legacy answer with key other and its free text still gives a status line', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), JSON.stringify({ id: 'q-l1-aaaaaa', key: 'other', by: 'panel', ts: 5000, text: 'Use a fork' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '⏳ Resposta other enviada para app' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' })).toBeUndefined()
  await ui.unmount()
})

test('the band row draws while a question waits: its text, and the hotkey 1 on the open button', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: '📥 1 pergunta aguardando · 1 janela' })).toBeDefined()
  expect((await band.find({ type: 'Button', key: 'open' }))?.props.hotkey).toBe('1')
  expect(await band.find({ text: 'drawn beneath' })).toBeUndefined()
  await band.unmount()
})

test('the band row is absent with a survey up, and with no open question', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const surveyUp = await $.ui.mount({ plugin: 'askaway', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, hasSurvey: true } })
  expect(await surveyUp.find({ type: 'Button', key: 'open' })).toBeUndefined()
  expect(await surveyUp.find({ text: 'drawn beneath' })).toBeDefined()
  await surveyUp.unmount()
  files.delete(path('q', 'q-l1-aaaaaa'))
  await clock.advance(5000)
  const none = await mountBand($)
  expect(await none.find({ type: 'Button', key: 'open' })).toBeUndefined()
  await none.unmount()
})

test('a new open entry raises one toast, and the entries already waiting at start do not', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { toasts, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  expect(toasts).toEqual([])
  files.set(path('q', 'q-l5-eeeeee'), question('q-l5-eeeeee', 3000, { title: 'Pick a parser' }))
  await clock.advance(5000)
  expect(toasts).toEqual(['Nova pergunta: Pick a parser'])
  await clock.advance(5000)
  expect(toasts).toHaveLength(1)
})

test('/askaway away toggles away.json and reports the new state', async ($, on) => {
  const files = new Map<string, string>()
  stubHost(on, files)
  await $.session.start(SESSION)
  const first = await run($, 'away')
  expect(first.text).toBe('Modo ausente do Askaway ligado.')
  expect(readJson(files, `${STATE}/away.json`)).toMatchObject({ on: true })
  const second = await run($, 'away')
  expect(second.text).toBe('Modo ausente do Askaway desligado.')
  expect(readJson(files, `${STATE}/away.json`)).toMatchObject({ on: false })
})

test('/askaway opens the pane, or answers the text list when the pane waits undrawn', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { title: 'Pick a parser' })]])
  stubHost(on, files, false)
  await $.session.start(SESSION)
  const listed = await run($, '')
  expect(listed.text).toContain('Askaway: 1 pendente.')
  expect(listed.text).toContain('Pick a parser')
})

test('/askaway lang en switches the pane to English at once, and the choice is kept in the store', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const answered = await run($, 'lang en')
  expect(answered.text).toBe('Askaway language is now en.')
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '1 pending · 1 window' })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /^1 Title / })).toHaveLength(0)
  await ui.unmount()
  expect(await run($, 'lang xx')).toEqual({ text: 'Use /askaway lang pt, en or auto.' })
  await clock.advance(0)
})

test('/askaway lang pt then the pane reads in pt-BR, even when the environment says English', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, {}, {}, { LANG: 'en_US.UTF-8' })
  await $.session.start(SESSION)
  expect((await run($, 'lang pt')).text).toBe('O idioma do Askaway agora é pt.')
  const ui = await mountPane($)
  expect(await ui.findAll({ type: 'Text', text: /^1 Title / })).toHaveLength(0)
  await ui.unmount()
})

test('the language follows LANG=pt_BR.UTF-8 when nothing is stored', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '1 pendente · 1 janela' })).toBeDefined()
  await ui.unmount()
})

test('the language reads in English when no locale variable is set', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '1 pending · 1 window' })).toBeDefined()
  await ui.unmount()
})

test('a press dims its card at once, before the answer file is written', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = {}
  const { clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const write = gate()
  holds.write = write.promise
  const pressed = ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' }))?.props.dimColor).toBe(true)
  expect(files.has(path('a', 'q-l1-aaaaaa'))).toBe(false)
  write.open()
  await pressed
  expect(files.has(path('a', 'q-l1-aaaaaa'))).toBe(true)
  await ui.unmount()
})

test('a second press while the first answer is being written writes nothing', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = {}
  const { writes, clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const write = gate()
  holds.write = write.promise
  const first = ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.settle()
  await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
  write.open()
  await first
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'B' })
  await ui.unmount()
})

test('a poll that read the answer folder before a press keeps the press answer', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = {}
  const { clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const listing = gate()
  holds.listAnswers = listing.promise
  await clock.advance(5000)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  listing.open()
  await clock.advance(1000)
  const texts = await textsOf(ui)
  expect(texts).not.toContain('Which way for q-l1-aaaaaa?')
  expect(texts).toContain('⏳ Resposta B enviada para app')
  await ui.unmount()
})

test('a press on a card another writer already answered takes that answer at once', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  files.set(path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', 500))
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(writes).toEqual([])
  await clock.advance(250)
  const texts = await textsOf(ui)
  expect(texts).not.toContain('Which way for q-l1-aaaaaa?')
  expect(texts).toContain('⏳ Resposta A enviada para app')
  await ui.unmount()
})

test('Other… takes a free-text answer through the same answer path, and blank text is no answer', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'other-q-l1-aaaaaa' })
  // The field has a stable key and takes its text from the person's typing: no value, no onInput.
  const field = await ui.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa' })
  expect(field?.props).toMatchObject({ autoFocus: true })
  expect(field?.props).not.toHaveProperty('value')
  expect(field?.props).not.toHaveProperty('onInput')
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a', kind: 'change' })
  expect(await ui.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa' })).toBeDefined()
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: '   ' })
  expect(writes).toEqual([])
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: '  Use a fork  ' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', key: 'other', by: 'panel', text: 'Use a fork' })
  await clock.advance(250)
  expect(await textsOf(ui)).toContain('⏳ Resposta other enviada para app')
  await ui.unmount()
})

test('the tabs name each question; Submit reaches the review only once every question has a pick', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await labelOf(ui, 'tab-q-l1-aaaaaa')).toBe('1 Title q-l1-aaaaaa')
  expect(await labelOf(ui, 'tab-q-l2-bbbbbb')).toBe('2 Title q-l2-bbbbbb')
  expect(await labelOf(ui, 'tab-submit')).toBe('Enviar')
  expect((await ui.find({ type: 'Button', key: 'tab-submit' }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'tab-submit' })
  expect(await textsOf(ui)).toContain('Which way for q-l1-aaaaaa?')
  await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
  await ui.press({ key: 'tab-q-l2-bbbbbb' })
  await ui.press({ key: 'tab-submit' })
  expect(await textsOf(ui)).toContain('Which way for q-l2-bbbbbb?')
  await ui.press({ key: 'opt-q-l2-bbbbbb-B' })
  expect(await textsOf(ui)).toContain('Revise suas respostas')
  await ui.press({ key: 'tab-q-l1-aaaaaa' })
  expect((await ui.find({ type: 'Button', key: 'tab-submit' }))?.props.dimColor).toBe(false)
  await ui.press({ key: 'tab-submit' })
  expect(await textsOf(ui)).toContain('Revise suas respostas')
  expect(writes).toEqual([])
  await ui.unmount()
})

test('the forward button on the last question reads Review, and goes to the review only once every question is picked', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
  await ui.press({ key: 'tab-q-l2-bbbbbb' })
  expect(await labelOf(ui, 'nav-next')).toBe('Revisar')
  expect((await ui.find({ type: 'Button', key: 'nav-next' }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Which way for q-l2-bbbbbb?')
  await ui.press({ key: 'opt-q-l2-bbbbbb-B' })
  await ui.press({ key: 'tab-q-l2-bbbbbb' })
  expect((await ui.find({ type: 'Button', key: 'nav-next' }))?.props.dimColor).toBe(false)
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Revise suas respostas')
  await ui.unmount()
})

test('a question with no title is named on its tab by its text, cut short', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { title: '', question: 'Which way should the cache be stored in the app?' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await labelOf(ui, 'tab-q-l1-aaaaaa')).toBe('1 Which way should the ca…')
  await ui.unmount()
})

test('three polls with nothing new write no atom the pane draws from, so the pane is not redrawn', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  // Every state write the plugin makes goes through the state.set event; the test hook counts them and passes them on.
  const stateWrites: string[] = []
  on('state.set', { plugin: 'askaway' }, (_$, e, next) => {
    stateWrites.push(e.key)
    return next(e)
  })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await clock.advance(5000)
  // The first poll settles the clock and the board; from here on three polls find nothing new.
  const settledWrites = stateWrites.length
  await clock.advance(5000)
  await clock.advance(5000)
  await clock.advance(5000)
  expect(stateWrites.slice(settledWrites)).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' })).toBeDefined()
  await ui.unmount()
})

test('an Other… answer stays on its button: primary, with its text drawn under it, also after going back', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
  expect(await textsOf(ui)).toContain('Which way for q-l2-bbbbbb?')
  await ui.press({ key: 'tab-q-l1-aaaaaa' })
  expect((await ui.find({ type: 'Button', key: 'other-q-l1-aaaaaa' }))?.props.variant).toBe('primary')
  expect(await textsOf(ui)).toContain('Use a fork')
  await ui.unmount()
})

test('a pane that stays mounted reads the age on as the clock moves: 60 s, then 90 s reads 2 min, and the tick is written once', async ($, on) => {
  // ts 0 is the mocked clock's start, so the age is the clock's own time.
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0)]])
  const { clock } = stubHost(on, files)
  const stateWrites: string[] = []
  on('state.set', { plugin: 'askaway' }, (_$, e, next) => {
    stateWrites.push(e.key)
    return next(e)
  })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await clock.advance(60_000)
  expect(await ui.find({ type: 'Text', text: /· há 1 min$/ })).toBeDefined()
  const ticksBefore = stateWrites.filter(key => key === 'tick').length
  await clock.advance(30_000)
  expect(await ui.find({ type: 'Text', text: /· há 2 min$/ })).toBeDefined()
  expect(stateWrites.filter(key => key === 'tick').length - ticksBefore).toBe(1)
  await ui.unmount()
})

test('an idle session is handed its own answer once, as a prompt, and the d/ marker says so', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: SELF })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 0)],
  ])
  const { submits, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  expect(submits).toEqual([])
  await clock.advance(5000)
  expect(submits).toEqual(['The user answered Askaway question q-l1-aaaaaa (Title q-l1-aaaaaa): B · Rewrite. (you were using A · Keep)'])
  expect(readJson(files, path('d', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', session: SELF, via: 'prompt' })
  await clock.advance(5000)
  expect(submits).toHaveLength(1)
})

test('the answers of one session are handed as one prompt, their lines joined by a newline, each with its marker first', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: SELF })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 0, { session: SELF })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 0)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A', 0)],
  ])
  const { submits, writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  expect(submits).toEqual([
    'The user answered Askaway question q-l1-aaaaaa (Title q-l1-aaaaaa): B · Rewrite. (you were using A · Keep)\n' +
      'The user answered Askaway question q-l2-bbbbbb (Title q-l2-bbbbbb): A · Keep.',
  ])
  expect(writes).toEqual([path('d', 'q-l1-aaaaaa'), path('d', 'q-l2-bbbbbb')])
})

test('an answer already marked delivered is not handed again', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: SELF })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 0)],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { session: 'hook' })],
  ])
  const { submits, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  expect(submits).toEqual([])
  expect(readJson(files, path('d', 'q-l1-aaaaaa'))).toMatchObject({ session: 'hook' })
})

test('a busy session is handed nothing until its turn completes, and a subagent turn does not end the main one', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: SELF })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 0)],
  ])
  const { submits, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await clock.advance(5000)
  expect(submits).toEqual([])
  expect(files.has(path('d', 'q-l1-aaaaaa'))).toBe(false)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't-sub', reason: 'completed', agentId: 'a-1' } as never)
  await clock.advance(5000)
  expect(submits).toEqual([])
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'completed' } as never)
  await clock.advance(5000)
  expect(submits).toHaveLength(1)
})

test('an answer for another session is never handed to this one', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: 'sess-other' })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 0)],
  ])
  const { submits, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  expect(submits).toEqual([])
  expect(files.has(path('d', 'q-l1-aaaaaa'))).toBe(false)
})

test('an answer is handed only once it is at least five seconds old', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: SELF })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 3000)],
  ])
  const { submits, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  expect(submits).toEqual([])
  await clock.advance(5000)
  expect(submits).toHaveLength(1)
})
