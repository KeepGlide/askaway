import type { On, RenderElement } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import {
  ANSWER_TTL_MS,
  EMPTY_BOARD,
  ageLabel,
  counterText,
  deliveryLine,
  footerText,
  groupBySession,
  leadOf,
  listText,
  parseAnswer,
  parseQuestion,
  piecesOf,
  projectLabel,
  riskLabel,
  sectionsOf,
  sessionLabelOf,
  statusLines,
  titleCase,
  windowOf,
} from '../hooks/model'
import { heldButtons } from '../hooks/held'
import { ACCENT_COLOR, EXPLAIN_COLORS } from '../hooks/look'
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

test('model: the counter reads in English and Portuguese, singular and plural, with the group count', () => {
  const two = [parsedQuestion('q-m-000001', 10, { project: '/work/app' }), parsedQuestion('q-m-000002', 20, { project: '/work/web' })]
  expect(counterText('en', two)).toBe('2 pending · 2 groups')
  expect(counterText('pt', two)).toBe('2 pendentes · 2 grupos')
  expect(counterText('pt', two.slice(0, 1))).toBe('1 pendente · 1 grupo')
  expect(counterText('en', [])).toBe('Nothing pending')
  expect(counterText('pt', [])).toBe('Nenhuma pendente')
})

test('model: the counter counts two sessions of one project as one group', () => {
  const twoSessions = [parsedQuestion('q-m-000001', 10, { session: 's1' }), parsedQuestion('q-m-000002', 20, { session: 's2' })]
  expect(counterText('en', twoSessions)).toBe('2 pending · 1 group')
})

test('model: titleCase title-cases a slug and a session title, keeps inner capitals, and leaves minor words after the first', () => {
  expect(projectLabel('/home/user/projects/my-sample_project', 'en')).toBe('My Sample Project')
  expect(projectLabel('/work/bridge_to-the_moon', 'en')).toBe('Bridge to the Moon')
  expect(titleCase('Team decisions and stability checklist', 'en')).toBe('Team Decisions and Stability Checklist')
  expect(titleCase('the way of JEV on iOS', 'en')).toBe('The Way of JEV on iOS')
  expect(titleCase('and then', 'en')).toBe('And Then')
  expect(titleCase('  spaced   out  ', 'en')).toBe('Spaced Out')
})

test('model: titleCase uses the minor words of the language it is given', () => {
  expect(titleCase('guia de uso das ferramentas', 'pt')).toBe('Guia de Uso das Ferramentas')
  expect(titleCase('guia de uso', 'en')).toBe('Guia De Uso')
})

test('model: titleCase keeps each minor word of the English list lowercase after the first word', () => {
  for (const word of ['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'via', 'with']) {
    expect(titleCase(`alpha ${word} beta`, 'en')).toBe(`Alpha ${word} Beta`)
  }
})

test('model: titleCase keeps each minor word of the Portuguese list lowercase after the first word', () => {
  for (const word of ['a', 'as', 'o', 'os', 'e', 'de', 'da', 'das', 'do', 'dos', 'em', 'na', 'nas', 'no', 'nos', 'para', 'por', 'com', 'ou', 'um', 'uma']) {
    expect(titleCase(`guia ${word} uso`, 'pt')).toBe(`Guia ${word} Uso`)
  }
})

test('model: titleCase capitalizes the first word even when it is a minor word, and keeps a capital already typed', () => {
  expect(titleCase('the way', 'en')).toBe('The Way')
  expect(titleCase('de volta', 'pt')).toBe('De Volta')
  expect(titleCase('iOS app', 'en')).toBe('iOS App')
  expect(titleCase('a JEV queue', 'en')).toBe('A JEV Queue')
})

test('model: the session label is the title-cased session title, or the words for the session when there is none', () => {
  expect(sessionLabelOf(parsedQuestion('q-m-000001', 10, { session_title: 'build the query' }), 'en')).toBe('Build the Query')
  expect(sessionLabelOf(parsedQuestion('q-m-000002', 10), 'en')).toBe('the session')
  expect(sessionLabelOf(parsedQuestion('q-m-000002', 10), 'pt')).toBe('a sessão')
})

test('model: the status-line window reads "<Project> · <Session Title>", and drops the session part when there is none', () => {
  expect(windowOf(parsedQuestion('q-m-000001', 10, { project: '/work/my-sample_project', session_title: 'team decisions' }), 'en')).toBe(
    'My Sample Project · Team Decisions',
  )
  expect(windowOf(parsedQuestion('q-m-000002', 10, { project: '/work/my-sample_project' }), 'en')).toBe('My Sample Project')
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
  expect(statusLines('pt', board, NO_STATUS).map(line => line.text)).toEqual(['⏳ Resposta B enviada para App'])
  expect(statusLines('en', board, NO_STATUS).map(line => line.text)).toEqual(['⏳ Answer B sent to App'])

  const orphan: Board = { questions: [], answers: [answerOf('q-m-000001', 'B', 1)], delivered: [] }
  expect(statusLines('pt', orphan, NO_STATUS).map(line => line.text)).toEqual(['⏳ Resposta B enviada para a sessão'])

  const ended: Board = {
    questions: [q],
    answers: [answerOf('q-m-000001', 'B', 1)],
    delivered: [{ id: 'q-m-000001', expired: true, reason: 'session-ended' }],
  }
  const [line] = statusLines('en', ended, NO_STATUS)
  expect(line).toEqual({ id: 'q-m-000001', text: '⚠️ App ended before reading answer B', dismissable: true })
})

test('model: an answer unread past the 7-day TTL reads as expired, and one inside the TTL still reads as pending', () => {
  const board: Board = { questions: [parsedQuestion('q-m-000001', 10)], answers: [answerOf('q-m-000001', 'B', 1000)], delivered: [] }
  expect(statusLines('en', board, { ...NO_STATUS, now: 1000 + ANSWER_TTL_MS }).map(line => line.text)).toEqual(['⏳ Answer B sent to App'])
  expect(statusLines('en', board, { ...NO_STATUS, now: 1000 + ANSWER_TTL_MS + 1 })).toEqual([
    { id: 'q-m-000001', text: '⚠️ Answer B expired unread', dismissable: true },
  ])
})

test('model: parseAnswer keeps the session an answer is bound to, and a file without one reads as no session', () => {
  expect(parseAnswer({ id: 'q-m-000001', key: 'A', by: 'cli', ts: 5, session: 's1' }, 'q-m-000001')?.session).toBe('s1')
  expect(parseAnswer({ id: 'q-m-000001', key: 'A', by: 'panel', ts: 5 }, 'q-m-000001')?.session).toBeUndefined()
  expect(parseAnswer({ id: 'q-m-000001', key: 'A', by: 'panel', ts: 5, session: null }, 'q-m-000001')?.session).toBeUndefined()
  expect(parseAnswer({ id: 'q-m-000001', key: 'A', by: 'panel', ts: 5, session: 7 }, 'q-m-000001')?.session).toBeUndefined()
})

const FOOT_MIN = 60_000
const FOOT_HOUR = 60 * FOOT_MIN
const FOOT_DAY = 24 * FOOT_HOUR

test('model: the footer reads the counts and the last answer in English and Portuguese, and is absent while a question is open', () => {
  const now = 10 * FOOT_DAY
  const board: Board = {
    questions: [
      parsedQuestion('q-f-000001', 1, { title: 'Pick the queue' }),
      parsedQuestion('q-f-000002', 2),
      parsedQuestion('q-f-000003', 3),
      parsedQuestion('q-f-000004', 4),
      parsedQuestion('q-f-000005', 5),
    ],
    answers: [
      answerOf('q-f-000001', 'A', now - 12 * FOOT_MIN),
      answerOf('q-f-000002', 'B', now - 2 * FOOT_HOUR),
      answerOf('q-f-000003', 'A', now - 20 * FOOT_HOUR),
      answerOf('q-f-000004', 'B', now - 3 * FOOT_DAY),
      answerOf('q-f-000005', 'A', now - 8 * FOOT_DAY),
    ],
    delivered: [
      { id: 'q-f-000002', expired: false },
      { id: 'q-f-000003', expired: false },
      { id: 'q-f-000004', expired: true, reason: 'session-ended' },
    ],
  }
  expect(footerText('en', board, now)).toBe(
    'Nothing waiting · 3 answered in the last 24 h · last: Pick the queue → A, 12 min ago · 1 not yet read · 2 expired',
  )
  expect(footerText('pt', board, now)).toBe(
    'Nada aguardando · 3 respondidas nas últimas 24 h · última: Pick the queue → A, há 12 min · 1 ainda não lida · 2 expiradas',
  )
  const withOpen: Board = { ...board, questions: [...board.questions, parsedQuestion('q-f-000006', 6)] }
  expect(footerText('en', withOpen, now)).toBeUndefined()
})

test('model: the footer reads the zero and the singular forms in both languages', () => {
  expect(footerText('en', EMPTY_BOARD, FOOT_DAY)).toBe('Nothing waiting · none answered in the last 24 h · 0 not yet read · 0 expired')
  expect(footerText('pt', EMPTY_BOARD, FOOT_DAY)).toBe(
    'Nada aguardando · nenhuma respondida nas últimas 24 h · 0 ainda não lidas · 0 expiradas',
  )
  const one: Board = {
    questions: [parsedQuestion('q-f-000001', 1)],
    answers: [answerOf('q-f-000001', 'A', FOOT_DAY - FOOT_HOUR)],
    delivered: [{ id: 'q-f-000001', expired: false }],
  }
  expect(footerText('en', one, FOOT_DAY)).toBe('Nothing waiting · 1 answered in the last 24 h · last: Title q-f-000001 → A, 1 h ago · 0 not yet read · 0 expired')
  expect(footerText('pt', one, FOOT_DAY)).toBe(
    'Nada aguardando · 1 respondida nas últimas 24 h · última: Title q-f-000001 → A, há 1 h · 0 ainda não lidas · 0 expiradas',
  )
  const expiredOne: Board = { questions: [], answers: [answerOf('q-f-000002', 'B', 1)], delivered: [] }
  expect(footerText('pt', expiredOne, 8 * FOOT_DAY)).toContain('1 expirada')
})

test('model: the footer cuts a long title of the last answer, and names a question that is gone by its id', () => {
  const long: Board = {
    questions: [parsedQuestion('q-f-000001', 1, { title: 'a'.repeat(60) })],
    answers: [answerOf('q-f-000001', 'A', FOOT_DAY - FOOT_MIN)],
    delivered: [{ id: 'q-f-000001', expired: false }],
  }
  expect(footerText('en', long, FOOT_DAY)).toContain(`last: ${'a'.repeat(39)}… → A, 1 min ago`)
  const gone: Board = { questions: [], answers: [answerOf('q-f-000009', 'B', FOOT_DAY - FOOT_MIN)], delivered: [] }
  expect(footerText('en', gone, FOOT_DAY)).toContain('last: q-f-000009 → B, 1 min ago')
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
    '🎁 O que ganhamos',
    '⚖️ O que perdemos',
  ])
  expect(sectionsOf('en', full).slice(4)).toEqual([
    { heading: '🎁 What we gain', body: 'G' },
    { heading: '⚖️ What we lose', body: 'L' },
  ])

  const gainsOnly = parsedQuestion('q-m-000003', 10, { gains: 'G' })
  expect(sectionsOf('en', gainsOnly)[1]).toEqual({ heading: '🎁 What we gain', body: 'G' })
  const lossesOnly = parsedQuestion('q-m-000007', 10, { losses: 'L' })
  expect(sectionsOf('en', lossesOnly)[1]).toEqual({ heading: '⚖️ What we lose', body: 'L' })
})

test('model: urgency draws first and undo right after why, each only when set, in both languages', () => {
  const every = parsedQuestion('q-m-000004', 10, {
    context: 'C', analogy: 'An', how: 'H', gains: 'G', losses: 'L', urgency: 'Blocks in ~8 min', undo: 'Changing later ≈ 10 min',
  })
  expect(sectionsOf('en', every).map(section => section.heading)).toEqual([
    '⏱️ Urgency',
    '🧭 Context and origin',
    '🔁 Analogy',
    '💡 Why A',
    '↩️ Undo',
    '🛠️ How',
    '🎁 What we gain',
    '⚖️ What we lose',
  ])
  expect(sectionsOf('en', every)[0]).toEqual({ heading: '⏱️ Urgency', body: 'Blocks in ~8 min' })
  expect(sectionsOf('en', every)[4]).toEqual({ heading: '↩️ Undo', body: 'Changing later ≈ 10 min' })
  expect(sectionsOf('pt', every).map(section => section.heading)).toEqual([
    '⏱️ Urgência',
    '🧭 Contexto e origem',
    '🔁 Analogia',
    '💡 Por que A',
    '↩️ Como desfazer',
    '🛠️ Como',
    '🎁 O que ganhamos',
    '⚖️ O que perdemos',
  ])

  const withoutEither = parsedQuestion('q-m-000005', 10, { gains: 'G' })
  expect(sectionsOf('en', withoutEither).map(section => section.heading)).toEqual(['💡 Why A', '🎁 What we gain'])

  const urgencyOnly = parsedQuestion('q-m-000006', 10, { urgency: 'Can wait' })
  expect(sectionsOf('en', urgencyOnly)[0]).toEqual({ heading: '⏱️ Urgency', body: 'Can wait' })
})

test('model: the lead line names the recommended key and the local time, or says paused for a high-risk question', () => {
  const at = new Date(2026, 9, 18, 14, 2).getTime()
  expect(leadOf('en', parsedQuestion('q-m-000008', at, { recommended: 'B' }))).toBe('The agent is already on B since 14:02')
  expect(leadOf('pt', parsedQuestion('q-m-000008', at, { recommended: 'B' }))).toBe('O agente já seguiu com B desde 14:02')
  expect(leadOf('en', parsedQuestion('q-m-000009', at, { risk: 'high' }))).toBe('The agent is paused since 14:02')
  expect(leadOf('pt', parsedQuestion('q-m-000009', at, { risk: 'high' }))).toBe('O agente está pausado desde 14:02')
  const early = new Date(2026, 9, 18, 9, 5).getTime()
  expect(leadOf('en', parsedQuestion('q-m-000010', early, {}))).toBe('The agent is already on A since 09:05')
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

test('the card is the oldest open question; the other open ones are tree rows; answered, delivered and broken files draw nothing', async ($, on) => {
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
    expect(texts).toContain('Title q-l1-aaaaaa')
    expect(texts).toContain('Which way for q-l1-aaaaaa?')
    // q-l2 is open but not on screen: it is an unpicked row of the tree, and its card is not drawn.
    expect(texts).toContain('○ Title q-l2-bbbbbb')
    expect(texts).not.toContain('Which way for q-l2-bbbbbb?')
    expect(texts.some(text => text.includes('q-l3') || text.includes('q-l4') || text.includes('q-l9'))).toBe(false)
    await ui.unmount()
  }
})

test('the tree names the group by its project, each session by its title in title case, or the words for the session when it has none', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1', session_title: 'spec-49 follow-ups' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's2' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const texts = await textsOf(ui)
  expect(texts).toContain('App')
  expect(texts).toContain('├ Spec-49 Follow-ups')
  // The stub host reads in pt-BR, so a session with no title reads "a sessão".
  expect(texts).toContain('└ a sessão')
  await ui.unmount()
})

test('the KeepGlide mark is drawn 24px beside the counter and 28px beside Submit all on the desktop, and nowhere on the terminal', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    // The drawn tree keeps no key on an Svg (only Box and Button keep theirs), so each mark is placed by its neighbour:
    // the header mark sits right after the counter, the other right after the Submit all button.
    const nodes = nodesOf(await ui.drawn())
    const markAt = nodes.flatMap((node, index) => (node.type === 'Svg' && (node.props as Record<string, unknown>).alt === 'KeepGlide' ? [index] : []))
    if (surface === 'desktop') {
      expect(markAt).toHaveLength(2)
      const counterAt = nodes.findIndex(node => node.type === 'Text' && Array.isArray(node.children) && node.children.includes('1 pendente · 1 grupo'))
      const submitAt = nodes.findIndex(node => keyOfNode(node) === 'submit-all')
      expect(markAt[0]).toBe(counterAt + 1)
      expect(markAt[1]).toBe(submitAt + nodesOf(nodes[submitAt]).length)
      expect(markAt.map(index => (nodes[index].props as Record<string, unknown>).width)).toEqual([24, 28])
    } else {
      expect(markAt).toHaveLength(0)
    }
    await ui.unmount()
  }
})

test('the card draws the risk and age on the title row, and two blank lines before the options', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const nodes = nodesOf(await ui.drawn())
    const textOf = (node: Record<string, unknown>): string =>
      (Array.isArray(node.children) ? node.children : []).map(child => (typeof child === 'string' ? child : '')).join('')
    const childTexts = (node: Record<string, unknown>): string[] =>
      (Array.isArray(node.children) ? node.children : [])
        .filter((child): child is Record<string, unknown> => typeof child === 'object' && child !== null && (child as Record<string, unknown>).type === 'Text')
        .map(textOf)
    const titleRow = nodes.find(node => node.type === 'Box' && childTexts(node)[0] === 'Title q-l1-aaaaaa')
    expect((titleRow?.props as Record<string, unknown> | undefined)?.flexDirection).toBe('row')
    expect(childTexts(titleRow ?? {})[1]?.startsWith(riskLabel('pt', 'low'))).toBe(true)
    const optionList = nodes.find(
      node => node.type === 'Box' && nodesOf(node).some(inner => keyOfNode(inner) === 'opt-q-l1-aaaaaa-A') && nodesOf(node).some(inner => keyOfNode(inner) === 'opt-q-l1-aaaaaa-B') && (node.props as Record<string, unknown> | undefined)?.gap === 2,
    )
    expect((optionList?.props as Record<string, unknown> | undefined)?.marginTop).toBe(1)
    await ui.unmount()
  }
})

test('a single-question window: Submit all is dim until its pick, then primary, and writes the answer', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await textsOf(ui)).toContain('Title q-l1-aaaaaa')
  expect(await labelOf(ui, 'submit-all')).toBe('Enviar tudo (1)')
  expect((await ui.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(writes).toEqual([])
  expect(await textsOf(ui)).toContain('Title q-l1-aaaaaa')
  expect((await ui.find({ type: 'Button', key: 'submit-all' }))?.props.variant).toBe('primary')
  expect((await ui.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(false)
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', key: 'B', by: 'panel' })
  await clock.advance(250)
  expect(await textsOf(ui)).toContain('Nenhuma pendente')
  await ui.unmount()
})

test('a second press on another option replaces the pick; the answer is written only by Submit all', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(writes).toEqual([])
  expect((await ui.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-A' }))?.props.variant).toBe('primary')
  expect((await ui.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).toBe('secondary')
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'A' })
  await ui.unmount()
})

test('a click picks and advances; Submit all on the last question writes every answer of the window in one go', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(writes).toEqual([])
  // The pick moves the card on to the next question without a pick.
  expect(await textsOf(ui)).toContain('Title q-l2-bbbbbb')
  await ui.press({ key: 'opt-q-l2-bbbbbb-A' })
  expect(writes).toEqual([])
  // Every question picked: the card stays on the last one, where Submit all is primary.
  expect(await textsOf(ui)).toContain('Title q-l2-bbbbbb')
  expect((await ui.find({ type: 'Button', key: 'submit-all' }))?.props.variant).toBe('primary')
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'B' })
  expect(readJson(files, path('a', 'q-l2-bbbbbb'))).toMatchObject({ key: 'A' })
  await clock.advance(250)
  expect(await textsOf(ui)).toContain('Nenhuma pendente')
  await ui.unmount()
})

test('Next moves on without a pick; on the last question Next is gone, and Submit all waits for every pick', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Title q-l2-bbbbbb')
  expect(await ui.find({ type: 'Button', key: 'nav-next' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'submit-all' })
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
  expect(await textsOf(ui)).toContain('Title q-l1-aaaaaa')
  expect((await ui.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).toBe('primary')
  expect(writes).toEqual([])
  await ui.unmount()
})

test('two projects are two groups: submit-all answers the first group, and the card then shows the next group\'s first question', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { project: '/work/web' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  // The app group holds the oldest question, so it is the first group and the card starts on its first question.
  expect(await textsOf(ui)).toContain('Which way for q-l1-aaaaaa?')
  await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
  await ui.press({ key: 'opt-q-l3-cccccc-B' })
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l3-cccccc')])
  await clock.advance(250)
  // The app group is answered: its group Box is gone, and the web group's question is on screen.
  expect(await ui.find({ type: 'Box', key: 'group-/work/app' })).toBeUndefined()
  expect(await textsOf(ui)).toContain('Which way for q-l2-bbbbbb?')
  await ui.press({ key: 'opt-q-l2-bbbbbb-A' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l3-cccccc')])
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l3-cccccc'), path('a', 'q-l2-bbbbbb')])
  await ui.unmount()
})

test('a question answered elsewhere leaves the round: its pick is pruned on the next poll, and Submit all writes only the rest', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  // The card is on q-l2 now: its pick makes every question of the group picked, so q-l2 holds a pick when it is answered elsewhere.
  await ui.press({ key: 'opt-q-l2-bbbbbb-A' })
  files.set(path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A', 500))
  await clock.advance(5000)
  const texts = await textsOf(ui)
  expect(texts).not.toContain('Which way for q-l2-bbbbbb?')
  expect(texts).toContain('1 pendente · 1 grupo')
  expect(writes).toEqual([])
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
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
  expect(await labelOf(ui, 'other-q-l1-aaaaaa')).toBe('3. Outra…')
  for (const key of ['optrow-q-l1-aaaaaa-A', 'optrow-q-l1-aaaaaa-B']) {
    expect((await ui.find({ type: 'Box', key }))?.props.flexDirection).toBe('column')
  }
  expect(await ui.find({ type: 'Text', text: '└ Cheap · aderência 80' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '└ Slow · aderência 40' })).toBeDefined()
  await ui.unmount()
})

test('the question card has one blank line under its nav row: paddingBottom 1, on both surfaces', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Box', key: 'card-q-l1-aaaaaa' }))?.props.paddingBottom).toBe(1)
    await ui.unmount()
  }
})

test('a separator is drawn after the options and Other…, and before the nav row: an SVG rule on the desktop, a row of ─ on the terminal', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    // The engine keeps keys on Box nodes only, so the Other field, the separator and the nav row are found by content.
    const nodes = nodesOf(await ui.drawn())
    const rule = '─'.repeat(40)
    const keyAt = (key: string): number => nodes.findIndex(node => keyOfNode(node) === key)
    const otherAt = keyAt('other-row-q-l1-aaaaaa')
    const dividerAt = nodes.findIndex(
      node => (node.props as Record<string, unknown> | undefined)?.alt === 'divider' || (Array.isArray(node.children) && node.children.includes(rule)),
    )
    expect(otherAt).toBeGreaterThan(-1)
    expect(dividerAt).toBeGreaterThan(otherAt)
    expect(keyAt('nav-q-l1-aaaaaa')).toBeGreaterThan(dividerAt)
    const svgRules = (await ui.findAll({ type: 'Svg' })).filter(found => found.props.alt === 'divider')
    if (surface === 'desktop') {
      expect(svgRules).toHaveLength(1)
      expect(svgRules[0]?.props).toMatchObject({ alt: 'divider', height: 21 })
      expect(String(svgRules[0]?.props.source)).toContain('<rect x="0" y="10" width="320" height="1"')
      expect(await ui.find({ type: 'Text', text: rule })).toBeUndefined()
    } else {
      expect(svgRules).toHaveLength(0)
      expect((await ui.find({ type: 'Text', text: rule }))?.props.dimColor).toBe(true)
    }
    await ui.unmount()
  }
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
  const expired = '⚠️ Resposta A expirou sem ser lida'
  const pending = '⏳ Resposta B enviada para App'
  expect((await ui.find({ type: 'Text', text: expired }))?.props.color).toBe('#166534')
  expect((await ui.find({ type: 'Text', text: pending }))?.props.color).toBe('#166534')
  // Each status line is one green row with its text inside; the explanation box of the card is light gray, so it is not one.
  const rows = nodesOf(await ui.drawn()).filter(node => (node.props as Record<string, unknown> | undefined)?.backgroundColor === '#DCFCE7')
  expect(rows).toHaveLength(2)
  for (const text of [expired, pending]) {
    expect(rows.some(row => nodesOf(row).some(child => Array.isArray(child.children) && child.children.includes(text)))).toBe(true)
  }
  await ui.unmount()
})

test('the header counts open questions and their groups: two sessions of one project are one group', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's1' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { session: 's2' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Perguntas aguardando' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '3 pendentes · 1 grupo' })).toBeDefined()
  await ui.unmount()
})

test('the heading draws the logo before it: the glyph on the terminal, the SVG on the desktop', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const terminal = await mountPane($)
  expect(await textsOf(terminal)).toContain('?')
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  await terminal.unmount()
  const desktop = await mountPane($, 'desktop')
  expect((await desktop.find({ type: 'Svg' }))?.props).toMatchObject({ alt: 'Askaway', width: 16, height: 16 })
  expect(await desktop.find({ type: 'Text', text: 'Perguntas aguardando' })).toBeDefined()
  await desktop.unmount()
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
  expect(await ui.find({ type: 'Text', text: '3 pendentes · 2 grupos' })).toBeDefined()
  await ui.unmount()
})

test('only the recommended option says "(Recomendada)", and the card has no JEV line', async ($, on) => {
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
  expect(texts.some(text => text.startsWith('🔷') || text.includes('JEV'))).toBe(false)
  // The recommended option is B here, so the explanation names it: one line, heading then text.
  expect(texts).toContain('💡 Por que B: It is smaller.')
  await ui.unmount()
})

test('each explanation section shows only when its field is set, in one box under the question', async ($, on) => {
  const files = new Map([
    [
      path('q', 'q-l1-aaaaaa'),
      question('q-l1-aaaaaa', 1000, { context: 'Why now.', analogy: 'Like a phone book.', how: 'A table.', gains: 'Fast reads.', losses: 'A file to back up.' }),
    ],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const texts = await textsOf(ui)
  // A section is one Text, "heading: text": its whole line, and the bold heading as a Text of its own before the body.
  expect(texts.filter(text => text.startsWith('🧭'))).toEqual(['🧭 Contexto e origem: Why now.', '🧭 Contexto e origem: '])
  expect(texts).toContain('🔁 Analogia: Like a phone book.')
  expect(texts).toContain('💡 Por que A: It is smaller.')
  expect(texts).toContain('🛠️ Como: A table.')
  expect(texts).toContain('🎁 O que ganhamos: Fast reads.')
  expect(texts).toContain('⚖️ O que perdemos: A file to back up.')
  // Urgency and undo are not set on this question, so their headings are not drawn.
  expect(texts.some(text => text.startsWith('⏱️') || text.startsWith('↩️'))).toBe(false)
  await ui.unmount()
})

test('the card draws urgency first in the explanation box and undo right after why, with their Portuguese labels', async ($, on) => {
  const files = new Map([
    [
      path('q', 'q-l3-cccccc'),
      question('q-l3-cccccc', 1000, { gains: 'Fast reads.', losses: 'A file to back up.', urgency: 'Blocks in ~8 min', undo: 'Changing later ≈ 10 min' }),
    ],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const texts = await textsOf(ui)
  const urgencyLine = texts.indexOf('⏱️ Urgência: Blocks in ~8 min')
  const whyLine = texts.indexOf('💡 Por que A: It is smaller.')
  const undoLine = texts.indexOf('↩️ Como desfazer: Changing later ≈ 10 min')
  const gainsLine = texts.indexOf('🎁 O que ganhamos: Fast reads.')
  const lossesLine = texts.indexOf('⚖️ O que perdemos: A file to back up.')
  expect(urgencyLine).toBeGreaterThanOrEqual(0)
  expect(whyLine).toBeGreaterThan(urgencyLine)
  expect(undoLine).toBeGreaterThan(whyLine)
  expect(gainsLine).toBeGreaterThan(undoLine)
  expect(lossesLine).toBeGreaterThan(gainsLine)
  await ui.unmount()
})

// A card for a question at 14:02 local time (built from local fields, so it reads 14:02 in any time zone).
const AT_1402 = new Date(2026, 9, 18, 14, 2).getTime()
async function cardTextsAt1402($: Engine, on: On, env: Record<string, string>, extra: Record<string, unknown>): Promise<string[]> {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', AT_1402, { recommended: 'B', ...extra })]])
  stubHost(on, files, true, {}, {}, env)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const texts = await textsOf(ui)
  await ui.unmount()
  return texts
}

test('the card draws the lead line under the title in pt-BR: the recommended key and the time', async ($, on) => {
  const texts = await cardTextsAt1402($, on, {}, {})
  const lead = 'O agente já seguiu com B desde 14:02'
  expect(texts).toContain(lead)
  expect(texts.indexOf(lead)).toBe(texts.indexOf('Which way for q-l1-aaaaaa?') - 1)
  expect(texts.indexOf(lead)).toBeGreaterThan(texts.indexOf('Title q-l1-aaaaaa'))
})

test('the card draws the lead line under the title in English: the recommended key and the time', async ($, on) => {
  const texts = await cardTextsAt1402($, on, { LANG: 'en_US.UTF-8' }, {})
  expect(texts).toContain('The agent is already on B since 14:02')
  expect(texts).not.toContain('O agente já seguiu com B desde 14:02')
})

test('a high-risk card in pt-BR says the agent is paused, not on a key', async ($, on) => {
  const texts = await cardTextsAt1402($, on, {}, { risk: 'high' })
  expect(texts).toContain('O agente está pausado desde 14:02')
  expect(texts.some(text => text.startsWith('O agente já seguiu'))).toBe(false)
})

test('a high-risk card in English says the agent is paused, not on a key', async ($, on) => {
  const texts = await cardTextsAt1402($, on, { LANG: 'en_US.UTF-8' }, { risk: 'high' })
  expect(texts).toContain('The agent is paused since 14:02')
  expect(texts.some(text => text.startsWith('The agent is already on'))).toBe(false)
})

test('a losses-only question draws the losses section alone, and a gains-only one the gains', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { losses: 'Extra file.' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { gains: 'Quick answers.' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const losses = await textsOf(ui)
  expect(losses).toContain('⚖️ O que perdemos: Extra file.')
  expect(losses.some(text => text.startsWith('🎁'))).toBe(false)
  await ui.press({ key: 'nav-next' })
  const gains = await textsOf(ui)
  expect(gains).toContain('🎁 O que ganhamos: Quick answers.')
  expect(gains.some(text => text.startsWith('⚖️'))).toBe(false)
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
  const texts = await textsOf(ui)
  expect(texts).toContain('💡 Por que A: It is smaller.')
  expect(texts).toContain('└ Cheap · aderência 80')
  expect(texts.filter(text => /^(🛠️|🎁|⚖️)/u.test(text))).toEqual([])
  expect(texts.filter(text => text.trim() === '')).toEqual([])
  await ui.unmount()
})

test('a name in an explanation is drawn bold in the explanation ink, a slash command bare and a backticked one without its backticks', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { how: 'Run /reload-plugins, then open `frontend-code-engineer`.' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const nodes = nodesOf(await ui.drawn())
    const nameChildren = nodes
      .filter(node => node.type === 'Text' && (node.props as Record<string, unknown> | undefined)?.bold === true
        && (node.props as Record<string, unknown> | undefined)?.color === EXPLAIN_COLORS.ink)
      .map(node => node.children)
    expect(nameChildren).toContainEqual(['/reload-plugins'])
    expect(nameChildren).toContainEqual(['frontend-code-engineer'])
    // The section is still one line for a reader, with no backtick drawn anywhere.
    expect(await textsOf(ui)).toContain('🛠️ Como: Run /reload-plugins, then open frontend-code-engineer.')
    const drawnText = nodes.flatMap(node => (Array.isArray(node.children) ? node.children : [])).filter((child): child is string => typeof child === 'string')
    expect(drawnText.some(text => text.includes('`'))).toBe(false)
    await ui.unmount()
  }
})

test('an option tradeoff written in lowercase is drawn capitalized after └, in a box indented one cell, on both surfaces', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const nodes = nodesOf(await ui.drawn())
    const indentedLine = (line: string): boolean =>
      nodes.some(
        node =>
          node.type === 'Box' &&
          (node.props as Record<string, unknown> | undefined)?.paddingLeft === 1 &&
          nodesOf(node).some(inner => inner.type === 'Text' && Array.isArray(inner.children) && inner.children.includes(line)),
      )
    expect(indentedLine('└ Cheap · aderência 80')).toBe(true)
    expect(indentedLine('└ Slow · aderência 40')).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'cheap' })).toBeUndefined()
    await ui.unmount()
  }
})

test('an option draws its fit after its tradeoff as "· fit N" in English, and with no tradeoff as "└ fit N"', async ($, on) => {
  const options = [
    { key: 'A', label: 'SQLite', tradeoff: 'fast', fit: 88 },
    { key: 'B', label: 'JSONL', fit: 55 },
  ]
  const files = new Map([[path('q', 'q-f-aaaaaa'), question('q-f-aaaaaa', 1000, { options })]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '└ Fast · fit 88' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '└ fit 55' })).toBeDefined()
  await ui.unmount()
})

test('an option draws its fit as "· aderência N" in Portuguese, the default language', async ($, on) => {
  const options = [
    { key: 'A', label: 'SQLite', tradeoff: 'fast', fit: 88 },
    { key: 'B', label: 'JSONL', tradeoff: 'simple', fit: 55 },
  ]
  const files = new Map([[path('q', 'q-f-aaaaaa'), question('q-f-aaaaaa', 1000, { options })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '└ Fast · aderência 88' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '└ Simple · aderência 55' })).toBeDefined()
  await ui.unmount()
})

test('an option with fit null draws its tradeoff and no fit, and an option with neither draws no line', async ($, on) => {
  const options = [
    { key: 'A', label: 'Keep', tradeoff: 'cheap', fit: null },
    { key: 'B', label: 'Rewrite', tradeoff: 'slow', fit: null },
    { key: 'C', label: 'Skip', fit: null },
  ]
  const files = new Map([[path('q', 'q-f-aaaaaa'), question('q-f-aaaaaa', 1000, { options })]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '└ Cheap' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '└ Slow' })).toBeDefined()
  expect((await textsOf(ui)).some(text => /\bfit\b|aderência/u.test(text))).toBe(false)
  const row = await ui.find({ type: 'Box', key: 'optrow-q-f-aaaaaa-C' })
  expect(row).toBeDefined()
  expect(nodesOf(row).some(node => (node.props as Record<string, unknown> | undefined)?.paddingLeft === 1)).toBe(false)
  await ui.unmount()
})

test('model: piecesOf draws a slash command as a name and leaves the rest of the text plain', () => {
  expect(piecesOf('Plain text.')).toEqual([{ text: 'Plain text.', isName: false }])
  expect(piecesOf('Run /reload-plugins now')).toEqual([
    { text: 'Run ', isName: false },
    { text: '/reload-plugins', isName: true },
    { text: ' now', isName: false },
  ])
  expect(piecesOf('/askaway lang pt')).toEqual([
    { text: '/askaway', isName: true },
    { text: ' lang pt', isName: false },
  ])
})

test('model: piecesOf takes a backticked name without its backticks, and no path or URL slash is a name', () => {
  expect(piecesOf('use `software-test-engineer` here')).toEqual([
    { text: 'use ', isName: false },
    { text: 'software-test-engineer', isName: true },
    { text: ' here', isName: false },
  ])
  expect(piecesOf('https://x.y/path')).toEqual([{ text: 'https://x.y/path', isName: false }])
  expect(piecesOf('a/b')).toEqual([{ text: 'a/b', isName: false }])
  expect(piecesOf('src/hooks/pane.tsx')).toEqual([{ text: 'src/hooks/pane.tsx', isName: false }])
  // A home path is a path, and a command keeps neither the colon nor the dot that ends its sentence.
  expect(piecesOf('see ~/projects/foo')).toEqual([{ text: 'see ~/projects/foo', isName: false }])
  expect(piecesOf('Run /reload-plugins: now')).toEqual([
    { text: 'Run ', isName: false },
    { text: '/reload-plugins', isName: true },
    { text: ': now', isName: false },
  ])
  expect(piecesOf('then /clear.')).toEqual([
    { text: 'then ', isName: false },
    { text: '/clear', isName: true },
    { text: '.', isName: false },
  ])
})

test('model: piecesOf of an empty text is no piece, and a backtick never closed stays plain', () => {
  expect(piecesOf('')).toEqual([])
  expect(piecesOf('open `never closed')).toEqual([{ text: 'open `never closed', isName: false }])
})

test('a pending answer shows "enviada", then "entregue" for 30 seconds after the pane first sees the delivery', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 5000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  let ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '⏳ Resposta B enviada para App' })).toBeDefined()
  await ui.unmount()
  files.set(path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa'))
  await clock.advance(5000)
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '✅ Resposta B entregue para App (lida pela sessão)' })).toBeDefined()
  await ui.unmount()
  // This 36 s advance runs a poll every 5 s; the last one lands 35 s after the first sighting, past the 30 s the line stays for.
  await clock.advance(36_000)
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /entregue para App/ })).toBeUndefined()
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
  expect(await ui.find({ type: 'Text', text: '✅ Resposta B entregue para App (lida pela sessão)' })).toBeDefined()
  await ui.unmount()
  await clock.advance(10_000) // the poll at 40 s: 35 s on screen
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /entregue para App/ })).toBeUndefined()
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
  expect(await ui.find({ type: 'Text', text: /entregue para App/ })).toBeUndefined()
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

test('an answer unread past the 7-day TTL expires with no marker, and its line is dismissable', async ($, on) => {
  // Stamped more than the TTL before the clock's start, so the pane sees it expired at once (no long clock advance).
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', -ANSWER_TTL_MS - 60_000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '⚠️ Resposta B expirou sem ser lida' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'dismiss-q-l1-aaaaaa' })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: '⏳ Resposta A enviada para App' })).toBeDefined()
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
  const warning = '⚠️ App · Spec-49 Follow-ups encerrou antes de ler a resposta B'
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

test('the risk label reads in pt-BR for low, medium and high, with the age after it, one question per card', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { risk: 'low', session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { risk: 'medium', session: 's2' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { risk: 'high', session: 's3' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^✅ risco baixo · / })).toBeDefined()
  await ui.press({ key: 'nav-next' })
  expect(await ui.find({ type: 'Text', text: /^⚠️ risco médio · / })).toBeDefined()
  await ui.press({ key: 'nav-next' })
  expect(await ui.find({ type: 'Text', text: /^🛑 risco alto · / })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: '⏳ Resposta other enviada para App' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' })).toBeUndefined()
  await ui.unmount()
})

test('the band row draws while a question waits: its text, and the hotkey 1 on the open button', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: '1 pergunta aguardando · 1 grupo' })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: '1 pending · 1 group' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Questions waiting' })).toBeDefined()
  expect(await labelOf(ui, 'submit-all')).toBe('Submit all (1)')
  await ui.unmount()
  expect(await run($, 'lang xx')).toEqual({ text: 'Use /askaway lang pt-BR, en or auto.' })
  // Object keys of the prototype are not choices either; nothing is stored for them.
  expect(await run($, 'lang constructor')).toEqual({ text: 'Use /askaway lang pt-BR, en or auto.' })
  expect(await run($, 'lang __proto__')).toEqual({ text: 'Use /askaway lang pt-BR, en or auto.' })
  expect(await run($, 'lang en')).toEqual({ text: 'Askaway language is now en.' })
  // The older spellings of Brazilian Portuguese still work, whatever the case.
  expect((await run($, 'lang pt')).text).toBe('O idioma do Askaway agora é pt-BR.')
  expect((await run($, 'lang PT_BR')).text).toBe('O idioma do Askaway agora é pt-BR.')
  await clock.advance(0)
})

test('/askaway lang pt then the pane reads in pt-BR, even when the environment says English', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, {}, {}, { LANG: 'en_US.UTF-8' })
  await $.session.start(SESSION)
  expect((await run($, 'lang pt-BR')).text).toBe('O idioma do Askaway agora é pt-BR.')
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Perguntas aguardando' })).toBeDefined()
  expect(await labelOf(ui, 'submit-all')).toBe('Enviar tudo (1)')
  await ui.unmount()
})

test('the language follows LANG=pt_BR.UTF-8 when nothing is stored', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '1 pendente · 1 grupo' })).toBeDefined()
  await ui.unmount()
})

test('the language reads in English when no locale variable is set', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '1 pending · 1 group' })).toBeDefined()
  await ui.unmount()
})

test('Submit all writes the answer only once the answer file is written', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = {}
  const { clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  const write = gate()
  holds.write = write.promise
  const pressed = ui.press({ key: 'submit-all' })
  await clock.settle()
  expect(files.has(path('a', 'q-l1-aaaaaa'))).toBe(false)
  write.open()
  await pressed
  expect(files.has(path('a', 'q-l1-aaaaaa'))).toBe(true)
  await ui.unmount()
})

test('a second Submit all press while the answer is being written writes nothing', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = {}
  const { writes, clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  const write = gate()
  holds.write = write.promise
  const first = ui.press({ key: 'submit-all' })
  await clock.settle()
  await ui.press({ key: 'submit-all' })
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
  await ui.press({ key: 'submit-all' })
  listing.open()
  await clock.advance(1000)
  const texts = await textsOf(ui)
  expect(texts).not.toContain('Which way for q-l1-aaaaaa?')
  expect(texts).toContain('⏳ Resposta B enviada para App')
  await ui.unmount()
})

test('Submit all on a question another writer already answered takes that answer at once', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  files.set(path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', 500))
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  await clock.advance(250)
  const texts = await textsOf(ui)
  expect(texts).not.toContain('Which way for q-l1-aaaaaa?')
  expect(texts).toContain('⏳ Resposta A enviada para App')
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
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', key: 'other', by: 'panel', text: 'Use a fork' })
  await clock.advance(250)
  expect(await textsOf(ui)).toContain('⏳ Resposta other enviada para App')
  await ui.unmount()
})

test('the card names the question on screen; a pick moves on, and Back returns to it with the pick kept', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await textsOf(ui)).toContain('Title q-l1-aaaaaa')
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(await textsOf(ui)).toContain('Title q-l2-bbbbbb')
  await ui.press({ key: 'nav-back' })
  expect(await textsOf(ui)).toContain('Title q-l1-aaaaaa')
  expect((await ui.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).toBe('primary')
  await ui.unmount()
})

test('the forward button on the last question is Submit all (n), and Next is gone there', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await labelOf(ui, 'nav-next')).toBe('Próxima →')
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Title q-l2-bbbbbb')
  expect(await ui.find({ type: 'Button', key: 'nav-next' })).toBeUndefined()
  expect(await labelOf(ui, 'submit-all')).toBe('Enviar tudo (2)')
  expect((await ui.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  await ui.unmount()
})

test('a question with no title is named in the tree and on the card by its text, cut to 24 characters; a title is never cut', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { title: '', question: 'Cache it on the disk now!' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { title: '   ', question: 'Cache it on the disk now' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { title: 'Ship the retry policy before Friday', question: 'Ship it?' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  // 25 characters: the first 23 and an ellipsis, 24 in all. The tree row carries the mark in front of it.
  expect(await textsOf(ui)).toContain('Cache it on the disk no…')
  expect(await textsOf(ui)).toContain('● Cache it on the disk no…')
  await ui.press({ key: 'nav-next' })
  // 24 characters and a blank title: the text is whole.
  expect(await textsOf(ui)).toContain('Cache it on the disk now')
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Ship the retry policy before Friday')
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
  expect(await textsOf(ui)).toContain('Title q-l2-bbbbbb')
  await ui.press({ key: 'nav-back' })
  expect(await textsOf(ui)).toContain('Title q-l1-aaaaaa')
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

test('the card names each question of a group of three by its title, and Back and Next walk them', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { title: 'Cache layer' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { title: 'Retry policy' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { title: 'Log level' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await textsOf(ui)).toContain('Cache layer')
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Retry policy')
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Log level')
  await ui.press({ key: 'nav-back' })
  expect(await textsOf(ui)).toContain('Retry policy')
  await ui.unmount()
})

test('on the last question Submit all is dim until every question has a pick; the pick that completes them keeps the last question, primary', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000)],
  ])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const submit = () => ui.find({ type: 'Button', key: 'submit-all' })
  await ui.press({ key: 'nav-next' })
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Title q-l3-cccccc')
  expect((await submit())?.props.dimColor).toBe(true)
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  // A pick with gaps left moves on to the first question without a pick, wrapping from the last one.
  await ui.press({ key: 'opt-q-l3-cccccc-B' })
  expect(await textsOf(ui)).toContain('Title q-l1-aaaaaa')
  await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(await textsOf(ui)).toContain('Title q-l2-bbbbbb')
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Title q-l3-cccccc')
  expect((await submit())?.props.dimColor).toBe(true)
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  await ui.press({ key: 'nav-back' })
  await ui.press({ key: 'opt-q-l2-bbbbbb-A' })
  expect(await textsOf(ui)).toContain('Title q-l3-cccccc')
  expect((await submit())?.props.variant).toBe('primary')
  expect((await submit())?.props.dimColor).toBe(false)
  expect(writes).toEqual([])
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb'), path('a', 'q-l3-cccccc')])
  await ui.unmount()
})

test('a window of one question has no Back or Next: the pick writes nothing, and Submit all writes its one answer', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', key: 'nav-next' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'nav-back' }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(await textsOf(ui)).toContain('Title q-l1-aaaaaa')
  expect(writes).toEqual([])
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', key: 'A', by: 'panel' })
  await ui.unmount()
})

test('Submit all dims the answered card before it leaves: a second press on one of its options during the fade writes nothing', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  // The pick on the first question moves on to the second, the last: its pick completes the window.
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  await ui.press({ key: 'opt-q-l2-bbbbbb-A' })
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  // Submit all goes back to the first question, which is drawn dimmed while it fades.
  expect((await ui.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'nav-next' }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'B' })
  await clock.advance(250)
  expect(await textsOf(ui)).toContain('Nenhuma pendente')
  await ui.unmount()
})

test('a group answered from outside while another is open: the pane shows the first question of the other group', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 1500)],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 2000, { project: '/work/web' })],
    [path('q', 'q-l4-dddddd'), question('q-l4-dddddd', 2500, { project: '/work/web' })],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Title q-l2-bbbbbb')
  files.set(path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', 500))
  files.set(path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'B', 500))
  await clock.advance(5000)
  const texts = await textsOf(ui)
  // The app group is gone, so the web group is on screen at its first question, not at the step the app group had.
  expect(texts).toContain('Which way for q-l3-cccccc?')
  expect(texts).not.toContain('Which way for q-l4-dddddd?')
  await ui.unmount()
})

test('hotkeys: each option its digit, Other the next, then b, n and s on the terminal and p, f and e on the desktop; none while the Other field is open', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const hotkeyOf = async (key: string): Promise<unknown> => (await ui.find({ type: 'Button', key }))?.props.hotkey
  expect(await hotkeyOf('opt-q-l1-aaaaaa-A')).toBe('1')
  expect(await hotkeyOf('opt-q-l1-aaaaaa-B')).toBe('2')
  expect(await hotkeyOf('other-q-l1-aaaaaa')).toBe('3')
  expect(await hotkeyOf('nav-back')).toBe('b')
  expect(await hotkeyOf('nav-next')).toBe('n')
  await ui.press({ key: 'nav-next' })
  expect(await hotkeyOf('submit-all')).toBe('s')
  await ui.press({ key: 'nav-back' })
  await ui.press({ key: 'other-q-l1-aaaaaa' })
  expect(await ui.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa' })).toBeDefined()
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.length).toBeGreaterThan(0)
  for (const button of buttons) expect(button.props.hotkey).toBeUndefined()
  await ui.press({ key: 'other-q-l1-aaaaaa' })
  await ui.unmount()
  // The desktop keeps the digits and takes p, f and e for Back, Next and Submit: none of them is a digit, an option key
  // A to D or a terminal letter (b, n, s), so no shortcut clashes with another.
  const desk = await mountPane($, 'desktop')
  const deskHotkey = async (key: string): Promise<unknown> => (await desk.find({ type: 'Button', key }))?.props.hotkey
  expect(await deskHotkey('opt-q-l1-aaaaaa-A')).toBe('1')
  expect(await deskHotkey('other-q-l1-aaaaaa')).toBe('3')
  expect(await deskHotkey('nav-back')).toBe('p')
  expect(await deskHotkey('nav-next')).toBe('f')
  await desk.press({ key: 'nav-next' })
  expect(await deskHotkey('submit-all')).toBe('e')
  await desk.press({ key: 'nav-back' })
  await desk.press({ key: 'other-q-l1-aaaaaa' })
  for (const button of await desk.findAll({ type: 'Button' })) expect(button.props.hotkey).toBeUndefined()
  await desk.press({ key: 'other-q-l1-aaaaaa' })
  await desk.unmount()
})

test('draw order: every status line is drawn after the card\'s Back and Next buttons', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000)],
    [path('a', 'q-l3-cccccc'), answer('q-l3-cccccc', 'B')],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const drawn = nodesOf(await ui.drawn())
  const propsOf = (node: Record<string, unknown>): Record<string, unknown> => (node.props ?? {}) as Record<string, unknown>
  const textOf = (node: Record<string, unknown>): string =>
    (Array.isArray(node.children) ? node.children : []).filter((child): child is string => typeof child === 'string').join('')
  const STATUS_INK = '#166534'
  const statusAt = drawn.flatMap((node, index) => (node.type === 'Text' && propsOf(node).color === STATUS_INK ? [index] : []))
  const navKeys = ['nav-back', 'nav-next', 'submit-all']
  const navAt = drawn.flatMap((node, index) => (node.type === 'Button' && navKeys.includes(String(propsOf(node).key)) ? [index] : []))
  const cardAt = drawn.findIndex(node => node.type === 'Text' && textOf(node) === 'Which way for q-l1-aaaaaa?')
  expect(statusAt).toHaveLength(1)
  expect(navAt).toHaveLength(2)
  expect(cardAt).toBeGreaterThanOrEqual(0)
  for (const status of statusAt) {
    expect(status).toBeGreaterThan(cardAt)
    for (const nav of navAt) expect(status).toBeGreaterThan(nav)
  }
  await ui.unmount()
})

test('band logo: the desktop band draws the SVG logo with alt "Askaway", and no glyph', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  const desktop = await mountBand($, 'desktop')
  expect((await desktop.find({ type: 'Svg' }))?.props).toMatchObject({ alt: 'Askaway', width: 16, height: 16 })
  expect(await textsOf(desktop)).not.toContain('?')
  await desktop.unmount()
})

// The terminal's elements carry an Svg too, drawn as an empty box: the logo picks the SVG by surface, not by `'Svg' in ui`.
test('band logo: the terminal band draws the glyph "?"', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  const terminal = await mountBand($)
  expect(await textsOf(terminal)).toContain('?')
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  await terminal.unmount()
})

test('the heading draws the glyph "?" on the terminal', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const terminal = await mountPane($)
  expect(await textsOf(terminal)).toContain('?')
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  await terminal.unmount()
})

// ---- The group design: the tree, the card, the band, the grouping and the redraw guards ----

// The drawn node's key: the engine keeps it on the node or on its props.
const keyOfNode = (node: Record<string, unknown>): unknown => node.key ?? (node.props as Record<string, unknown> | undefined)?.key

// The state writes the plugin makes, in order: every write goes through the state.set event, and the hook passes it on.
function recordStateWrites(on: On): string[] {
  const writes: string[] = []
  on('state.set', { plugin: 'askaway' }, (_$, e, next) => {
    writes.push(e.key)
    return next(e)
  })
  return writes
}

// Project /work/app: session s1 holds q1 (ts 1000) and q2 (ts 3000), session s2 holds q3 (ts 2000). The step order is the
// tree's, session by session (q1, q2, q3), not the order of time (q1, q3, q2).
const treeFiles = (): Map<string, string> =>
  new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1', session_title: 'monta a consulta' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 3000, { session: 's1', session_title: 'monta a consulta' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 2000, { session: 's2' })],
  ])

test('the tree draws the group row in bold, each session with ├ or └, and one mark per question', async ($, on) => {
  stubHost(on, treeFiles())
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const texts = await textsOf(ui)
  // Two sessions of one project are one group: one group row, and no Button for a group.
  expect(texts.filter(text => text === 'App')).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: 'App' })).toMatchObject({ props: { bold: true } })
  expect(nodesOf(await ui.drawn()).filter(node => node.type === 'Button' && String(keyOfNode(node) ?? '').startsWith('group-'))).toHaveLength(0)
  // pt-BR minor words stay lowercase after the first word: "a" is one.
  expect(texts).toContain('├ Monta a Consulta')
  expect(texts).toContain('└ a sessão')
  // The question on screen is ● and bold; the others are ○.
  expect(await ui.find({ type: 'Text', text: '│  ● Title q-l1-aaaaaa' })).toMatchObject({ props: { bold: true } })
  expect(texts).toContain('│  ○ Title q-l2-bbbbbb')
  expect(texts).toContain('○ Title q-l3-cccccc')
  await ui.unmount()
})

test('after a pick the ● moves to the next question, and the picked one shows ✓', async ($, on) => {
  stubHost(on, treeFiles())
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  const texts = await textsOf(ui)
  expect(texts).toContain('│  ✓ Title q-l1-aaaaaa')
  expect(texts).toContain('│  ● Title q-l2-bbbbbb')
  expect(texts).not.toContain('│  ○ Title q-l2-bbbbbb')
  expect(await ui.find({ type: 'Text', text: '│  ● Title q-l2-bbbbbb' })).toMatchObject({ props: { bold: true } })
  await ui.unmount()
})

test('a question row under the last session is indented 4, and one under another session 1, so the marks share a column', async ($, on) => {
  stubHost(on, treeFiles())
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect((await ui.find({ type: 'Box', key: 'tree-q-l3-cccccc' }))?.props.paddingLeft).toBe(4)
  expect((await ui.find({ type: 'Box', key: 'tree-q-l1-aaaaaa' }))?.props.paddingLeft).toBe(1)
  await ui.unmount()
})

test('the step walks the group session by session, as the tree lists it, not by time', async ($, on) => {
  stubHost(on, treeFiles())
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await textsOf(ui)).toContain('Title q-l1-aaaaaa')
  // q2 (ts 3000) is the second question of s1, so it comes before q3 (ts 2000) of s2.
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Title q-l2-bbbbbb')
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Title q-l3-cccccc')
  await ui.unmount()
})

test('a question that arrives earlier in the tree keeps the card on its question', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's2' })],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Which way for q-l2-bbbbbb?')
  // q3 (ts 3000) joins session s1, so the tree order becomes q1, q3, q2: the card stays on q2.
  files.set(path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { session: 's1' }))
  await clock.advance(5000)
  const texts = await textsOf(ui)
  expect(texts).toContain('Which way for q-l2-bbbbbb?')
  expect(texts).not.toContain('Which way for q-l3-cccccc?')
  await ui.unmount()
})

test('a question answered elsewhere before the card keeps the card on its question', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's2' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { session: 's3' })],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Which way for q-l2-bbbbbb?')
  // q1 is answered elsewhere: q2 moves to the first place of the group, and the card stays on it (not on q3).
  files.set(path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', 500))
  await clock.advance(5000)
  expect(await textsOf(ui)).toContain('Which way for q-l2-bbbbbb?')
  await ui.unmount()
})

test('the Other field stays open on its own question across a shift', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's2' })],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'nav-next' })
  await ui.press({ key: 'other-q-l2-bbbbbb' })
  expect(await ui.find({ type: 'Input', key: 'other-input-q-l2-bbbbbb' })).toBeDefined()
  files.set(path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { session: 's1' }))
  await clock.advance(5000)
  expect(await textsOf(ui)).toContain('Which way for q-l2-bbbbbb?')
  expect(await ui.find({ type: 'Input', key: 'other-input-q-l2-bbbbbb' })).toBeDefined()
  await ui.unmount()
})

test('every open group is drawn in turn, one under the other, with its label as a Text and no Button', async ($, on) => {
  const files = treeFiles()
  files.set(path('q', 'q-l4-dddddd'), question('q-l4-dddddd', 4000, { project: '/work/web' }))
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const nodes = nodesOf(await ui.drawn())
  const boxAt = (key: string): number => nodes.findIndex(node => keyOfNode(node) === key)
  expect(boxAt('group-/work/app')).toBeGreaterThan(-1)
  expect(boxAt('group-/work/web')).toBeGreaterThan(boxAt('group-/work/app'))
  expect(nodes.filter(node => node.type === 'Button' && String(keyOfNode(node) ?? '').startsWith('group-'))).toHaveLength(0)
  const texts = await textsOf(ui)
  // The app group's last question comes before the web label, and the web group's question comes after it.
  expect(texts.indexOf('○ Title q-l3-cccccc')).toBeLessThan(texts.indexOf('Web'))
  expect(texts.indexOf('App')).toBeLessThan(texts.indexOf('Web'))
  expect(texts).toContain('○ Title q-l4-dddddd')
  await ui.unmount()
})

test('the group on screen and the other group label are both bold, with no colour', async ($, on) => {
  const files = treeFiles()
  files.set(path('q', 'q-l4-dddddd'), question('q-l4-dddddd', 4000, { project: '/work/web' }))
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const app = await ui.find({ type: 'Text', text: 'App' })
  expect(app).toMatchObject({ props: { bold: true } })
  expect(app?.props.color).toBeUndefined()
  const web = await ui.find({ type: 'Text', text: 'Web' })
  expect(web).toMatchObject({ props: { bold: true } })
  expect(web?.props.color).toBeUndefined()
  await ui.unmount()
})

test('two projects with the same folder name stay apart: two groups in turn, each labelled App, both bold with no colour', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { project: '/a/app' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { project: '/b/app' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const labels = nodesOf(await ui.drawn()).filter(node => node.type === 'Text' && Array.isArray(node.children) && node.children.includes('App'))
  expect(labels.map(node => (node.props as Record<string, unknown>).color)).toEqual([undefined, undefined])
  expect(labels.map(node => (node.props as Record<string, unknown>).bold)).toEqual([true, true])
  expect(await textsOf(ui)).toContain('Which way for q-l1-aaaaaa?')
  await ui.unmount()
})

// WCAG 2.x relative luminance and contrast ratio, for the accent check below.
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map(index => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

test('the accent is a non-text colour: 3:1 or better on white and on the dark theme background', () => {
  expect(contrast(ACCENT_COLOR, '#FFFFFF')).toBeGreaterThanOrEqual(3)
  expect(contrast(ACCENT_COLOR, '#111827')).toBeGreaterThanOrEqual(3)
})

test('no text node uses the accent colour, on either surface, in a question with an explanation and a tree', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { how: 'Run /reload-plugins, then open `frontend-code-engineer`.' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { project: '/work/web' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const accentText = nodesOf(await ui.drawn()).filter(node => node.type === 'Text' && (node.props as Record<string, unknown> | undefined)?.color === ACCENT_COLOR)
    expect(accentText.map(node => node.children)).toEqual([])
    await ui.unmount()
  }
})

// ---- Held buttons: a Button keeps its press handle across redraws (hooks/held.ts) ----

const noop = (): void => {}

// The Buttons of a drawn tree by key, each with the press handle the engine gave it (`"press":{"plugin":"askaway","handle":N}`).
const handleOf = (node: Record<string, unknown>): number | undefined => {
  const match = /"press":\{"plugin":"askaway","handle":(\d+)\}/.exec(JSON.stringify(node))
  return match === null ? undefined : Number(match[1])
}
const buttonHandles = (tree: unknown): Record<string, number | undefined> =>
  Object.fromEntries(
    nodesOf(tree)
      .filter(node => node.type === 'Button')
      .map(node => [String(keyOfNode(node)), handleOf(node)]),
  )

test('held: an unchanged look gives back the same element, and a changed look a new one', () => {
  const held = heldButtons()
  let made = 0
  const make = (label: string) => (press: () => void) => {
    made += 1
    return { type: 'Button', props: { label, press } } as unknown as RenderElement
  }
  held.begin()
  const first = held.hold('opt', ['A', false], noop, make('A'))
  held.end()
  held.begin()
  const same = held.hold('opt', ['A', false], noop, make('A'))
  held.end()
  expect(same).toBe(first)
  expect(made).toBe(1)
  held.begin()
  const changed = held.hold('opt', ['A', true], noop, make('A'))
  held.end()
  expect(changed).not.toBe(first)
  expect(made).toBe(2)
})

test('held: a key not held between begin and end is let go, so its next hold makes a new element', () => {
  const held = heldButtons()
  const make = (press: () => void) => ({ type: 'Button', props: { press } }) as unknown as RenderElement
  held.begin()
  const kept = held.hold('nav-back', 'Back', noop, make)
  held.end()
  held.begin()
  held.end()
  held.begin()
  const remade = held.hold('nav-back', 'Back', noop, make)
  held.end()
  expect(remade).not.toBe(kept)
})

test('held: the press of a held element runs the handler of the latest hold, and a let-go one does nothing', () => {
  const held = heldButtons()
  const calls: string[] = []
  let pressOf: (() => void) | undefined
  const make = (press: () => void) => {
    pressOf = press
    return { type: 'Button', props: {} } as unknown as RenderElement
  }
  held.begin()
  held.hold('nav-next', 'Next', () => calls.push('first'), make)
  held.end()
  held.begin()
  held.hold('nav-next', 'Next', () => calls.push('second'), make)
  held.end()
  expect(pressOf).toBeDefined()
  pressOf?.()
  expect(calls).toEqual(['second'])
  held.begin()
  held.end()
  pressOf?.()
  expect(calls).toEqual(['second'])
})

for (const surface of SURFACES) {
  test(`held (${surface}): a redraw keeps every Button's press handle, and a press renews the pressed option only`, async ($, on) => {
    const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
    stubHost(on, files)
    await $.session.start(SESSION)
    const ui = await mountPane($, surface)
    const before = buttonHandles(await ui.drawn())
    expect(Object.keys(before)).toEqual(expect.arrayContaining(['opt-q-l1-aaaaaa-A', 'opt-q-l1-aaaaaa-B', 'nav-back', 'submit-all']))
    for (const handle of Object.values(before)) expect(typeof handle).toBe('number')
    await ui.redraw()
    expect(buttonHandles(await ui.drawn())).toEqual(before)
    await ui.redraw({ ...PANE_PROPS, isFocused: true })
    expect(buttonHandles(await ui.drawn())).toEqual(before)
    await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
    const after = buttonHandles(await ui.drawn())
    expect(after['opt-q-l1-aaaaaa-A']).not.toBe(before['opt-q-l1-aaaaaa-A'])
    expect(after['nav-back']).toBe(before['nav-back'])
    await ui.unmount()
  })
}

test('the card has no n/total counter, no More button, no m hotkey and no JEV text', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const texts = await textsOf(ui)
  expect(texts.some(text => /\b\d+\/\d+\b/.test(text))).toBe(false)
  expect(texts.some(text => text.includes('JEV') || text.startsWith('🔷'))).toBe(false)
  expect(await ui.find({ type: 'Button', key: 'more-q-l1-aaaaaa' })).toBeUndefined()
  const hotkeys = nodesOf(await ui.drawn())
    .filter(node => node.type === 'Button')
    .map(node => (node.props as Record<string, unknown>).hotkey)
  expect(hotkeys).toContain('1')
  expect(hotkeys).not.toContain('m')
  await ui.unmount()
})

test('the explanation box is drawn after the question text and before the first option, and the options column has gap 2', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const nodes = nodesOf(await ui.drawn())
  const questionAt = nodes.findIndex(node => Array.isArray(node.children) && node.children.includes('Which way for q-l1-aaaaaa?'))
  const explanationAt = nodes.findIndex(node => keyOfNode(node) === 'explanation')
  const firstOptionAt = nodes.findIndex(node => keyOfNode(node) === 'optrow-q-l1-aaaaaa-A')
  expect(questionAt).toBeGreaterThan(-1)
  expect(explanationAt).toBeGreaterThan(questionAt)
  expect(firstOptionAt).toBeGreaterThan(explanationAt)
  const column = nodes.find(
    node =>
      Array.isArray(node.children) &&
      node.children.some(child => typeof child === 'object' && child !== null && keyOfNode(child as Record<string, unknown>) === 'optrow-q-l1-aaaaaa-A'),
  )
  expect((column?.props as Record<string, unknown> | undefined)?.gap).toBe(2)
  await ui.unmount()
})

test('the card labels read in pt-BR: Outra…, ← Voltar and Próxima →', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await labelOf(ui, 'other-q-l1-aaaaaa')).toBe('3. Outra…')
  expect(await labelOf(ui, 'nav-next')).toBe('Próxima →')
  await ui.press({ key: 'nav-next' })
  expect(await labelOf(ui, 'nav-back')).toBe('← Voltar')
  await ui.unmount()
})

test('the card labels read in English under LANG=en_US: Other…, ← Back and Next →', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files, true, {}, {}, { LANG: 'en_US.UTF-8' })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await labelOf(ui, 'other-q-l1-aaaaaa')).toBe('3. Other…')
  expect(await labelOf(ui, 'nav-next')).toBe('Next →')
  await ui.press({ key: 'nav-next' })
  expect(await labelOf(ui, 'nav-back')).toBe('← Back')
  await ui.unmount()
})

test('the band counts the groups: two projects read "2 grupos" in pt-BR', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { project: '/work/web' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: '2 perguntas aguardando · 2 grupos' })).toBeDefined()
  await band.unmount()
})

test('the band counts the groups: two projects read "2 groups" in English', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { project: '/work/web' })],
  ])
  stubHost(on, files, true, {}, {}, { LANG: 'en_US.UTF-8' })
  await $.session.start(SESSION)
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: '2 questions waiting · 2 groups' })).toBeDefined()
  await band.unmount()
})

// The pane is drawn again only when an atom it reads is written, so these guards count the state writes: a write that
// the pane does not need (an equal board, an unchanged tick) is the redraw the guard forbids.
test('a minute turning while only an answered question is open writes no atom the pane draws from, so the pane is not redrawn', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', 0)],
  ])
  const { clock } = stubHost(on, files)
  const stateWrites = recordStateWrites(on)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const writesBefore = stateWrites.length
  await clock.advance(60_000)
  expect(stateWrites.slice(writesBefore)).toEqual([])
  expect(await ui.find({ type: 'Text', text: '⏳ Resposta A enviada para App' })).toBeDefined()
  await ui.unmount()
})

// q1 (ts 0) is on the card and turns its minute at 30 000 and 90 000; q2 (ts 15 000) is off screen and turns at 45 000.
test('an off-screen question turning its minute writes no atom, so the pane is not redrawn', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 15_000, { session: 's2' })],
  ])
  const { clock } = stubHost(on, files)
  const stateWrites = recordStateWrites(on)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await clock.advance(31_000)
  const writesBefore = stateWrites.length
  // The window 31 000 to 60 000 holds the off-screen minute (45 000) and no minute of the card.
  await clock.advance(29_000)
  expect(stateWrites.slice(writesBefore)).toEqual([])
  await ui.unmount()
})

test('the question on the card turning its minute still writes, so the pane is redrawn', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 15_000, { session: 's2' })],
  ])
  const { clock } = stubHost(on, files)
  const stateWrites = recordStateWrites(on)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const writesBefore = stateWrites.length
  // The card's question turns its minute at 30 000.
  await clock.advance(31_000)
  expect(stateWrites.slice(writesBefore)).not.toEqual([])
  await ui.unmount()
})

test('the poll right after the last answer writes no atom the pane draws from, so the pane is not redrawn', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  const stateWrites = recordStateWrites(on)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  await ui.press({ key: 'submit-all' })
  expect(stateWrites).toContain('board')
  // The card's fade ends; the next poll reads the answer folder with the answer on disk.
  await clock.advance(250)
  const writesBefore = stateWrites.length
  await clock.advance(5000)
  expect(stateWrites.slice(writesBefore)).toEqual([])
  expect(await textsOf(ui)).toContain('⏳ Resposta B enviada para App')
  await ui.unmount()
})

test('after the board empties, a question from a new group opens at its first question', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  // The step is on the second question of the group when the board empties.
  await ui.press({ key: 'nav-next' })
  expect(await textsOf(ui)).toContain('Which way for q-l2-bbbbbb?')
  files.delete(path('q', 'q-l1-aaaaaa'))
  files.delete(path('q', 'q-l2-bbbbbb'))
  await clock.advance(5000)
  expect(await textsOf(ui)).toContain('Nenhuma pendente')
  files.set(path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { project: '/work/web' }))
  files.set(path('q', 'q-l4-dddddd'), question('q-l4-dddddd', 4000, { project: '/work/web' }))
  await clock.advance(5000)
  const texts = await textsOf(ui)
  expect(texts).toContain('Which way for q-l3-cccccc?')
  expect(texts).not.toContain('Which way for q-l4-dddddd?')
  await ui.unmount()
})
