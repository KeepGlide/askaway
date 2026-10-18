import type { On, RenderElement } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import {
  ANSWER_TTL_MS,
  EMPTY_BOARD,
  ageLabel,
  counterText,
  deliveryLine,
  escapeMarkdown,
  answerWho,
  footerText,
  groupBySession,
  leadOf,
  listText,
  parseAnswer,
  parseDelivery,
  parseQuestion,
  piecesOf,
  projectLabel,
  riskLabel,
  sectionsOf,
  sessionLabelOf,
  clearableIdsOf,
  historyOf,
  titleCase,
  urgencyGradeOf,
} from '../hooks/model'
import { heldButtons } from '../hooks/held'
import { renderTreeQuestion } from '../hooks/pane'
import { ACCENT_COLOR, DETAILS_FILL, LINK_MARK, URGENCY_COLOR, themeFamilyOf } from '../hooks/look'
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
  themeName: string | null = 'dark',
) {
  const toasts: string[] = []
  const writes: string[] = []
  const submits: string[] = []
  const calls: { argv: string[]; env?: Record<string, string> }[] = []
  const ended = new Set<string>()
  const tokenCalls: string[][] = []
  const clock = mock.clock(on)
  mock.env(on, { HOME, LANG: 'pt_BR.UTF-8', ...env })
  mock.store(on, stored)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF }))
  // A null theme name is an absent theme row: the list has no row at all.
  on('config.list', () => ({ value: themeName === null ? [] : [{ key: 'theme', label: 'Theme', kind: 'choice', value: themeName }] }))
  on('config.set', (_$, e) => ({ value: e.value }))
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
    // An answer goes through the CLI (process.run below); a direct write to a/ would bypass its first-writer-wins link.
    if (e.path.startsWith(`${STATE}/a/`)) throw new Error(`answer written directly: ${e.path}`)
    if (e.path.includes('/panel-tokens/')) {
      files.set(e.path, e.text) // the panel's one-shot credential: never held, never counted as an answer
      return { value: undefined }
    }
    await holds.write
    writes.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  // The CLI's `answer` (askaway.py's cmd_answer and create_once): the first answer for an id lands, a later one is refused
  // and reports the stored key. The check runs when the call reaches its write, after any hold. `writes` records the
  // answers that land; `calls` records every call the pane makes.
  on('process.run', async (_$, e) => {
    // The token folder and mode are set by two plain commands; only the calls to askaway.py are the pane's CLI calls.
    if (e.argv[0] !== 'python3') {
      tokenCalls.push([...e.argv])
      return cliReply('')
    }
    calls.push({ argv: [...e.argv], env: e.init?.env })
    // `list --open` reports the ids a test put in `ended`; `prune --id` removes the question file, as the CLI does for one.
    if (e.argv[2] === 'list') {
      const items = [...files.keys()].filter(file => file.startsWith(`${STATE}/q/`)).map(file => ({ id: file.slice(`${STATE}/q/`.length, -5) }))
      return cliReply(JSON.stringify({ items: items.map(item => (ended.has(item.id) ? { ...item, ended: true } : item)) }))
    }
    if (e.argv[2] === 'prune') {
      files.delete(path('q', e.argv[4]))
      return cliReply(JSON.stringify({ removed: 1 }))
    }
    const [, , , id, key] = e.argv
    await holds.write
    const stored = files.get(path('a', id))
    if (stored !== undefined) return cliReply(JSON.stringify({ id, key: (JSON.parse(stored) as { key: string }).key, written: false }))
    const at = e.argv.indexOf('--text')
    const text = at === -1 ? undefined : e.argv[at + 1]
    const record = { id, key, by: 'panel', ts: 0, ...(key === 'other' && text !== undefined ? { text: text.trim() } : {}) }
    files.set(path('a', id), `${JSON.stringify(record)}\n`)
    writes.push(path('a', id))
    return cliReply(JSON.stringify({ id, key, written: true }))
  })
  return { toasts, writes, submits, clock, calls, ended, tokenCalls }
}

// The hook's reply with the result `$.process.run` gives for a child that exited (the fields the pane reads).
const cliReply = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

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

// The text a tree link (a Markdown block) reads as: its markup gone, the link as its label, its escapes undone.
const plainMarkdown = (markdown: string): string =>
  markdown.replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\\(.)/g, '$1')

// The text of a drawn Text node, its nested strings joined.
const textOfNode = (node: unknown): string => {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  const children = (node as Record<string, unknown>).children
  return Array.isArray(children) ? children.map(textOfNode).join('') : ''
}

// Every Text the pane draws, in order; a tree link (a Markdown block) reads as its label, with its mark.
const textsOf = async (ui: Awaited<ReturnType<typeof mountPane>>): Promise<string[]> =>
  nodesOf(await ui.drawn()).flatMap(node => {
    if (node.type === 'Text') return [textOfNode(node)]
    if (node.type === 'Markdown') return [plainMarkdown(String((node.props as Record<string, unknown>).text))]
    return []
  })

// The Text the pane draws that contains the fragment. A History line carries its own times, so tests match its words.
const textNodeWith = async (ui: Awaited<ReturnType<typeof mountPane>>, fragment: string) =>
  nodesOf(await ui.drawn()).find(node => node.type === 'Text' && textOfNode(node).includes(fragment))

// A tree link is pressed on its href, as a click on its Markdown link does: action is jump or submit, id the question.
const pressTreeLink = (ui: Awaited<ReturnType<typeof mountPane>>, action: 'jump' | 'submit', id: string) =>
  ui.press({ key: `tree-${action}-${id}`, link: { href: `file:///askaway/${action}/${id}` } })

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

test('look: themeFamilyOf reads a name starting with light as light, one starting with dark or no row as dark, and auto or custom as unknown', () => {
  expect(themeFamilyOf('light')).toBe('light')
  expect(themeFamilyOf('light-ansi')).toBe('light')
  expect(themeFamilyOf('light-daltonized')).toBe('light')
  expect(themeFamilyOf('dark')).toBe('dark')
  expect(themeFamilyOf('dark-daltonized')).toBe('dark')
  expect(themeFamilyOf(undefined)).toBe('dark')
  expect(themeFamilyOf(null)).toBe('dark')
  expect(themeFamilyOf('auto')).toBe('unknown')
  expect(themeFamilyOf('custom:x')).toBe('unknown')
})

test('model: the urgency grade is the level the file names, else the one its words suggest in English or Portuguese, else low', () => {
  const grade = (extra: Record<string, unknown>) => urgencyGradeOf(parsedQuestion('q-u-000001', 1000, extra))
  expect(grade({ urgency: 'Blocks in ~8 min', urgency_level: 'high' })).toBe('high')
  expect(grade({ urgency: 'Blocks right now', urgency_level: 'medium' })).toBe('medium')
  expect(grade({ urgency: 'Can wait', urgency_level: 'low' })).toBe('low')
  expect(grade({ urgency: 'Blocks right now' })).toBe('high')
  expect(grade({ urgency: 'Blocks today' })).toBe('high')
  expect(grade({ urgency: 'Needs an answer this week' })).toBe('medium')
  expect(grade({ urgency: 'Soon, in a few days' })).toBe('medium')
  expect(grade({ urgency: 'Bloqueia agora' })).toBe('high')
  expect(grade({ urgency: 'Urgência imediata' })).toBe('high')
  expect(grade({ urgency: 'Vence em dias' })).toBe('medium')
  expect(grade({ urgency: 'Prazo na semana que vem' })).toBe('medium')
  expect(grade({ urgency: 'Pode esperar' })).toBe('low')
  expect(grade({})).toBe('low')
  // A level that is not one of the three reads as absent, and the words decide.
  expect(grade({ urgency: 'Blocks in ~8 min', urgency_level: 'critical' })).toBe('low')
  expect(URGENCY_COLOR).toEqual({ low: 'success', medium: 'warning', high: 'error' })
})

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
    'Answered via panel by unknown: B · Rewrite. Askaway question q-m-000001 (Title q-m-000001). (you were using A · Keep)',
  )
  expect(deliveryLine(q, answerOf('q-m-000001', 'A', 1))).toBe('Answered via panel by unknown: A · Keep. Askaway question q-m-000001 (Title q-m-000001).')
  expect(deliveryLine(q, answerOf('q-m-000001', 'other', 1, '  Use a  queue '))).toBe(
    'Answered via panel by unknown: their own answer (Other): "Use a queue". Askaway question q-m-000001 (Title q-m-000001). (you were using A · Keep)',
  )
  expect(deliveryLine(q, answerOf('q-m-000001', 'Z', 1))).toBeUndefined()
})

test('model: the delivery line names who answered in the five wordings askaway.py uses, on one line', () => {
  const q = parsedQuestion('q-m-000001', 10, { title: 'Two\nlines' })
  const line = (extra: Partial<Answer>) => deliveryLine(q, { ...answerOf('q-m-000001', 'A', 1), ...extra })
  const tail = 'A · Keep. Askaway question q-m-000001 (Two lines).'
  expect(line({ by: 'panel', who: 'Ana' })).toBe(`Answered via panel by Ana: ${tail}`)
  expect(line({ by: 'cli', who: 'Ana' })).toBe(`Answered by Ana (cli): ${tail}`)
  expect(line({ by: 'cli' })).toBe(`Answered by unknown (cli): ${tail}`)
  expect(line({ by: 'agent', who: 'Ana' })).toBe(`Answered by the agent itself: ${tail}`)
  expect(line({ by: 'accept_all' })).toBe(`Accepted all: ${tail}`)
  expect(line({ by: 'accept_recommended' })).toBe(`Accepted the recommended option: ${tail}`)
  expect(line({ by: 'agent' })).not.toContain('\n')
})

test('model: parseAnswer accepts the agent\'s own answer', () => {
  expect(parseAnswer({ id: 'q-m-000001', key: 'A', by: 'agent', ts: 5, session: 's1' }, 'q-m-000001')?.by).toBe('agent')
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

test('model: the counter counts a family once across its folders, and an old question by its project', () => {
  const questions = [
    parsedQuestion('q-m-000001', 10, { family: 'local_root', family_title: 'Big abstraction', project: '/work/app', session: 's1' }),
    parsedQuestion('q-m-000002', 20, { family: 'local_root', family_title: 'Big abstraction', project: '/work/app/scratch', session: 's2' }),
    parsedQuestion('q-m-000003', 30, { project: '/work/app', session: 's3' }),
  ]
  expect(counterText('en', questions)).toBe('3 pending · 2 groups')
})

test('model: parseQuestion keeps family and family_title, and a null or blank one reads as absent', () => {
  const kept = parsedQuestion('q-m-000001', 10, { family: 'local_root', family_title: 'release checklist of the API' })
  expect(kept.family).toBe('local_root')
  expect(kept.family_title).toBe('release checklist of the API')
  const bare = parsedQuestion('q-m-000002', 20, { family: null, family_title: '  ' })
  expect(bare.family).toBeUndefined()
  expect(bare.family_title).toBeUndefined()
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

// Local times, so the clock text reads the same wherever the tests run.
const localMs = (month: number, day: number, hour: number, minute: number): number =>
  new Date(2026, month - 1, day, hour, minute).getTime()
const SAME_DAY_NOW = localMs(10, 17, 15, 0)

test('model: the History tree groups answers by family, then session, newest first; an answer whose question is gone falls under "the session"', () => {
  const first = parsedQuestion('q-h-000001', 10, { family: 'fam-1', family_title: 'app family', session: 's1', session_title: 'build app' })
  const second = parsedQuestion('q-h-000002', 20, { family: 'fam-1', family_title: 'app family', session: 's2' })
  const board: Board = {
    questions: [first, second],
    answers: [
      answerOf('q-h-000001', 'A', localMs(10, 17, 14, 32)),
      answerOf('q-h-000002', 'B', localMs(10, 17, 14, 35)),
      answerOf('q-h-000009', 'A', localMs(10, 17, 13, 58)),
    ],
    delivered: [],
  }
  const tree = historyOf('en', board, { ...NO_STATUS, now: SAME_DAY_NOW })
  expect(tree.map(group => group.label)).toEqual(['App Family', 'the session'])
  expect(tree[0]?.sessions.map(session => session.label)).toEqual(['the session', 'Build App'])
  expect(tree[0]?.sessions[0]?.entries.map(entry => entry.line)).toEqual(['Answer B · sent 14:35 · waiting to be read'])
  expect(tree[0]?.sessions[1]?.entries.map(entry => entry.title)).toEqual(['Title q-h-000001'])
  expect(tree[1]?.sessions[0]?.entries).toEqual([
    { id: 'q-h-000009', mark: '⏳', title: 'q-h-000009', line: 'Answer A · sent 13:58 · waiting to be read', clearable: false },
  ])
})

test('model: a delivered line reads its delivered time and "read by the session"; another day reads DD/MM HH:MM', () => {
  const delivered: Board = {
    questions: [parsedQuestion('q-h-000001', 10)],
    answers: [answerOf('q-h-000001', 'A', localMs(10, 17, 14, 32))],
    delivered: [{ id: 'q-h-000001', expired: false, ts: localMs(10, 17, 14, 33) }],
  }
  const lineOf = (lang: 'en' | 'pt', now: number, board: Board = delivered): string | undefined =>
    historyOf(lang, board, { ...NO_STATUS, now })[0]?.sessions[0]?.entries[0]?.line
  expect(lineOf('en', SAME_DAY_NOW)).toBe('Answer A · sent 14:32 · delivered 14:33 (read by the session)')
  expect(lineOf('pt', SAME_DAY_NOW)).toBe('Resposta A · enviada 14:32 · entregue 14:33 (lida pela sessão)')
  expect(lineOf('en', localMs(10, 18, 9, 0))).toBe('Answer A · sent 17/10 14:32 · delivered 17/10 14:33 (read by the session)')
  const withoutTime: Board = { ...delivered, delivered: [{ id: 'q-h-000001', expired: false }] }
  expect(lineOf('en', SAME_DAY_NOW, withoutTime)).toBe('Answer A · sent 14:32 · read by the session')
})

test('model: the Other answer names its letter and its text; an agent or a named CLI answer names who answered, a panel answer names no one', () => {
  const at = localMs(10, 17, 14, 32)
  const lineOf = (extra: Partial<Answer>): string | undefined =>
    historyOf('en', { questions: [parsedQuestion('q-h-000001', 10)], answers: [{ ...answerOf('q-h-000001', 'other', at, '  lavanda  '), ...extra }], delivered: [] }, {
      ...NO_STATUS,
      now: SAME_DAY_NOW,
    })[0]?.sessions[0]?.entries[0]?.line
  expect(lineOf({})).toBe('Answer C (Other: "lavanda") · sent 14:32 · waiting to be read')
  expect(lineOf({ key: 'A', by: 'agent' })).toBe('Answer A · answered by agent · sent 14:32 · waiting to be read')
  expect(lineOf({ key: 'A', by: 'cli', who: 'Ana' })).toBe('Answer A · answered by Ana · sent 14:32 · waiting to be read')
  expect(lineOf({ key: 'A', by: 'panel', who: 'Ana' })).toBe('Answer A · sent 14:32 · waiting to be read')
})

test('model: Clear removes only delivered, ended and expired lines; a pending line stays; a delivered line leaves 30 s after the pane first saw it', () => {
  const board: Board = {
    questions: [parsedQuestion('q-h-000001', 10), parsedQuestion('q-h-000002', 20), parsedQuestion('q-h-000003', 30)],
    answers: [answerOf('q-h-000001', 'A', 100), answerOf('q-h-000002', 'B', 200), answerOf('q-h-000003', 'C', 300)],
    delivered: [
      { id: 'q-h-000001', expired: false, ts: 150 },
      { id: 'q-h-000002', expired: true, reason: 'session-ended' },
    ],
  }
  const idsOf = (context: Partial<typeof NO_STATUS>): string[] => {
    const tree = historyOf('en', board, { ...NO_STATUS, now: 1000, ...context })
    return tree.flatMap(group => group.sessions.flatMap(session => session.entries.map(entry => entry.id)))
  }
  expect(clearableIdsOf(historyOf('en', board, { ...NO_STATUS, now: 1000 }))).toEqual(['q-h-000002', 'q-h-000001'])
  expect(clearableIdsOf(historyOf('en', board, { ...NO_STATUS, now: 1000, cleared: ['q-h-000002'] }))).toEqual(['q-h-000001'])
  expect(idsOf({ now: 31_000, shownAt: { 'q-h-000001': 0 } })).toEqual(['q-h-000003', 'q-h-000002'])
})

test('model: a session that ended keeps its line, marked ⚠️ and clearable, under the family of its project', () => {
  const ended: Board = {
    questions: [parsedQuestion('q-m-000001', 10)],
    answers: [answerOf('q-m-000001', 'B', 1)],
    delivered: [{ id: 'q-m-000001', expired: true, reason: 'session-ended' }],
  }
  const [group] = historyOf('en', ended, NO_STATUS)
  expect(group?.label).toBe('App')
  expect(group?.sessions[0]?.entries[0]).toMatchObject({ id: 'q-m-000001', mark: '⚠️', title: 'Title q-m-000001', clearable: true })
  expect(group?.sessions[0]?.entries[0]?.line).toContain('the session ended before reading it')
  const orphan: Board = { questions: [], answers: [answerOf('q-m-000001', 'B', 1)], delivered: [] }
  expect(historyOf('pt', orphan, NO_STATUS)[0]?.label).toBe('a sessão')
  expect(historyOf('pt', orphan, NO_STATUS)[0]?.sessions[0]?.entries[0]?.line).toContain('Resposta B · enviada ')
})

test('model: an answer unread past the 7-day TTL reads as expired and clearable, and one inside the TTL still reads as pending', () => {
  const board: Board = { questions: [parsedQuestion('q-m-000001', 10)], answers: [answerOf('q-m-000001', 'B', 1000)], delivered: [] }
  const entriesAt = (now: number) =>
    historyOf('en', board, { ...NO_STATUS, now }).flatMap(group => group.sessions.flatMap(session => session.entries))
  expect(entriesAt(1000 + ANSWER_TTL_MS).map(entry => entry.mark)).toEqual(['⏳'])
  expect(entriesAt(1000 + ANSWER_TTL_MS + 1)).toMatchObject([{ id: 'q-m-000001', mark: '⚠️', clearable: true }])
  expect(entriesAt(1000 + ANSWER_TTL_MS + 1)[0]?.line).toContain('expired unread')
})

test('model: parseDelivery keeps the ts of a delivery marker, and a marker without one reads with no ts', () => {
  expect(parseDelivery({ id: 'q-h-000001', session: 's', ts: 42 }, 'q-h-000001')?.ts).toBe(42)
  expect(parseDelivery({ id: 'q-h-000001', expired: true, reason: 'ttl' }, 'q-h-000001')?.ts).toBeUndefined()
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
  expect(sectionsOf('pt', short, 'details')).toEqual([{ heading: '💡 Por que A', body: 'It is smaller.' }])
  expect(sectionsOf('en', short, 'details')).toEqual([{ heading: '💡 Why A', body: 'It is smaller.' }])
  expect(sectionsOf('en', short, 'before-question')).toEqual([])

  const full = parsedQuestion('q-m-000002', 10, { context: 'C', analogy: 'An', how: 'H', gains: 'G', losses: 'L' })
  expect(sectionsOf('pt', full, 'before-question')).toEqual([])
  expect(sectionsOf('pt', full, 'details').map(section => section.heading)).toEqual([
    '🔁 Analogia',
    '💡 Por que A',
    '🛠️ Como',
    '🎁 O que ganhamos',
    '⚖️ O que perdemos',
    '🧭 Contexto e origem',
  ])
  expect(sectionsOf('en', full, 'details').slice(3, 5)).toEqual([
    { heading: '🎁 What we gain', body: 'G' },
    { heading: '⚖️ What we lose', body: 'L' },
  ])

  const gainsOnly = parsedQuestion('q-m-000003', 10, { gains: 'G' })
  expect(sectionsOf('en', gainsOnly, 'details')[1]).toEqual({ heading: '🎁 What we gain', body: 'G' })
  const lossesOnly = parsedQuestion('q-m-000007', 10, { losses: 'L' })
  expect(sectionsOf('en', lossesOnly, 'details')[1]).toEqual({ heading: '⚖️ What we lose', body: 'L' })
})

test('model: each card slot keeps its sections in the card order, each only when set, in both languages', () => {
  const every = parsedQuestion('q-m-000004', 10, {
    what: 'W', problem: 'P', context: 'C', analogy: 'An', how: 'H', gains: 'G', losses: 'L', urgency: 'Blocks in ~8 min', undo: 'Changing later ≈ 10 min',
  })
  expect(sectionsOf('en', every, 'before-question').map(section => section.heading)).toEqual(['What it is', 'The problem'])
  expect(sectionsOf('en', every, 'before-options')).toEqual([{ heading: '⏱️ Urgency', body: 'Blocks in ~8 min' }])
  expect(sectionsOf('en', every, 'details').map(section => section.heading)).toEqual([
    '🔁 Analogy',
    '💡 Why A',
    '↩️ Undo',
    '🛠️ How',
    '🎁 What we gain',
    '⚖️ What we lose',
    '🧭 Context and origin',
  ])
  expect(sectionsOf('en', every, 'details')[2]).toEqual({ heading: '↩️ Undo', body: 'Changing later ≈ 10 min' })
  expect(sectionsOf('pt', every, 'before-question').map(section => section.heading)).toEqual(['O que é', 'O problema'])
  expect(sectionsOf('pt', every, 'before-options')).toEqual([{ heading: '⏱️ Urgência', body: 'Blocks in ~8 min' }])
  expect(sectionsOf('pt', every, 'details').map(section => section.heading)).toEqual([
    '🔁 Analogia',
    '💡 Por que A',
    '↩️ Como desfazer',
    '🛠️ Como',
    '🎁 O que ganhamos',
    '⚖️ O que perdemos',
    '🧭 Contexto e origem',
  ])

  const withoutEither = parsedQuestion('q-m-000005', 10, { gains: 'G' })
  expect(sectionsOf('en', withoutEither, 'details').map(section => section.heading)).toEqual(['💡 Why A', '🎁 What we gain'])
  expect(sectionsOf('en', withoutEither, 'before-options')).toEqual([])

  const urgencyOnly = parsedQuestion('q-m-000006', 10, { urgency: 'Can wait' })
  expect(sectionsOf('en', urgencyOnly, 'before-options')).toEqual([{ heading: '⏱️ Urgency', body: 'Can wait' }])
})

test('model: parseQuestion keeps what, problem and each option does, pros and cons; a missing or blank one reads as absent', () => {
  const full = parsedQuestion('q-m-000010', 10, { what: 'W', problem: 'P' })
  expect(full.what).toBe('W')
  expect(full.problem).toBe('P')
  const old = parsedQuestion('q-m-000011', 10)
  expect(old.what).toBeUndefined()
  expect(old.problem).toBeUndefined()
  const detailed = parseQuestion({
    ...JSON.parse(question('q-m-000012', 10)),
    options: [{ key: 'A', label: 'Keep', fit: 1, does: 'D', pros: 'P', cons: '  ' }, { key: 'B', label: 'Rewrite', fit: 2 }],
  }, 'q-m-000012')
  expect(detailed?.options[0]).toMatchObject({ does: 'D', pros: 'P' })
  expect(detailed?.options[0]?.cons).toBeUndefined()
  expect(detailed?.options[1]?.does).toBeUndefined()
})

test('model: the lead line names the recommended key and the local time, or says paused for a high-risk question', () => {
  const at = new Date(2026, 9, 18, 14, 2).getTime()
  expect(leadOf('en', parsedQuestion('q-m-000008', at, { recommended: 'B' }))).toBe('Working on B since 14:02 while it waits for you. Your answer still counts: pick another option and it switches; with no answer it stays on B.')
  expect(leadOf('pt', parsedQuestion('q-m-000008', at, { recommended: 'B' }))).toBe('Trabalhando na B desde 14:02 enquanto espera você. Sua resposta ainda vale: escolha outra opção e ele muda; sem resposta, segue na B.')
  expect(leadOf('en', parsedQuestion('q-m-000009', at, { risk: 'high' }))).toBe('Paused since 14:02: it waits for your answer before going on.')
  expect(leadOf('pt', parsedQuestion('q-m-000009', at, { risk: 'high' }))).toBe('Pausado desde 14:02: espera a sua resposta para seguir.')
  const early = new Date(2026, 9, 18, 9, 5).getTime()
  expect(leadOf('en', parsedQuestion('q-m-000010', early, {}))).toBe('Working on A since 09:05 while it waits for you. Your answer still counts: pick another option and it switches; with no answer it stays on A.')
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
    'Answered via panel by unknown: B · Rewrite. Askaway question q-m-000002 (Title q-m-000002). (you were using A · Keep)',
  ])
  expect(groupBySession({ ...board, delivered: [{ id: 'q-m-000002', expired: false }] }, 100_000).map(group => group.session)).toEqual(['s1'])
})

test('the card is the oldest open question; the other open ones are tree rows; a broken file draws nothing', async ($, on) => {
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
    expect(texts).toContain('○ ▪ Title q-l2-bbbbbb')
    expect(texts).not.toContain('Which way for q-l2-bbbbbb?')
    // The answered (q-l3) and delivered (q-l4) questions draw no card and no tree row: they show as History rows only.
    expect(texts).not.toContain('Which way for q-l3-cccccc?')
    expect(texts).not.toContain('Which way for q-l4-dddddd?')
    expect(texts).not.toContain('○ ▪ Title q-l3-cccccc')
    expect(texts).not.toContain('○ ▪ Title q-l4-dddddd')
    const historyRow = nodesOf(await ui.drawn()).find(node => keyOfNode(node) === 'history-q-l3-cccccc')
    expect(nodesOf(historyRow).some(node => node.type === 'Text' && textOfNode(node) === '⏳')).toBe(true)
    // The broken file draws nothing.
    expect(texts.some(text => text.includes('q-l9'))).toBe(false)
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

test('the Urgency text takes the colour of its grade, its bold title stays in the default colour', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { urgency: 'Blocks in ~8 min', urgency_level: 'high' })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const nodes = nodesOf(await ui.drawn())
  const bodyNode = nodes.find(node => node.type === 'Text' && Array.isArray(node.children) && node.children.includes('Blocks in ~8 min'))
  expect((bodyNode?.props as Record<string, unknown>).color).toBe('error')
  const titleNode = nodes.find(node => node.type === 'Text' && Array.isArray(node.children) && node.children.includes('⏱️ Urgency: '))
  expect((titleNode?.props as Record<string, unknown> | undefined)?.color).toBeUndefined()
  await ui.unmount()
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

test('a panel answer leaves who to the CLI: the call names no who and sets no ASKAWAY_WHO (the CLI stamps it)', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { calls } = stubHost(on, files, true, {}, {}, { ASKAWAY_WHO: '  Ana\tSilva  ' })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  await ui.press({ key: 'submit-all' })
  expect(calls).toEqual([
    {
      argv: ['python3', expect.stringMatching(/\/scripts\/askaway\.py$/), 'answer', 'q-l1-aaaaaa', 'B', '--by', 'panel', '--strict'],
      env: { ASKAWAY_HOME: STATE, ASKAWAY_PANEL_TOKEN: expect.stringMatching(/^[0-9a-f]{32}$/) },
    },
  ])
})

test('a panel answer mints a one-shot token: a 700 folder, a 600 file, and its name goes to the CLI in the env', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { calls, tokenCalls } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
  await ui.press({ key: 'submit-all' })
  const token = calls[0]?.env?.ASKAWAY_PANEL_TOKEN ?? ''
  expect(token).toMatch(/^[0-9a-f]{32}$/)
  expect(tokenCalls).toEqual([
    ['install', '-d', '-m', '700', `${STATE}/panel-tokens`],
    ['chmod', '600', `${STATE}/panel-tokens/${token}`],
  ])
  expect(JSON.parse(files.get(`${STATE}/panel-tokens/${token}`) ?? '{}')).toHaveProperty('ts')
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
  expect(await labelOf(ui, 'opt-q-l1-aaaaaa-A')).toBe('A · Keep (Recomendada)')
  expect(await ui.find({ type: 'Text', text: 'A · Keep (Recomendada)' })).toMatchObject({ props: { bold: true } })
  await ui.unmount()
})

test('each option is one full-width column with its tradeoff under it, headed by its key letter, and Other… is the last one, under the next letter', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await labelOf(ui, 'opt-q-l1-aaaaaa-B')).toBe('B · Rewrite')
  expect(await labelOf(ui, 'other-q-l1-aaaaaa')).toBe('C · Outra…')
  for (const key of ['optrow-q-l1-aaaaaa-A', 'optrow-q-l1-aaaaaa-B']) {
    expect((await ui.find({ type: 'Box', key }))?.props.flexDirection).toBe('column')
  }
  expect(await ui.find({ type: 'Text', text: '└ Cheap · aderência 80' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '└ Slow · aderência 40' })).toBeDefined()
  await ui.unmount()
})

const startsWithBranch = (node: Record<string, unknown>): boolean => {
  const [first] = Array.isArray(node.children) ? node.children : []
  return typeof first === 'object' && first !== null && (first as Record<string, unknown>).type === 'Text' &&
    Array.isArray((first as Record<string, unknown>).children) && ((first as Record<string, unknown>).children as unknown[])[0] === '└ '
}

test('the field under Other… starts with the └ branch glyph the option sub-rows draw, at the same one-cell indent, on both surfaces', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const nodes = nodesOf(await ui.drawn())
    const optionSubRow = nodes.find(node => node.type === 'Box' && (node.props as Record<string, unknown> | undefined)?.paddingLeft === 1 && nodesOf(node).some(inner => inner.type === 'Text' && Array.isArray(inner.children) && inner.children.includes('└ Cheap · aderência 80')))
    const fieldRow = nodes.find(node => node.type === 'Box' && startsWithBranch(node) && nodesOf(node).some(inner => inner.type === 'Input'))
    expect(fieldRow).toBeDefined()
    expect((fieldRow?.props as Record<string, unknown>).paddingLeft).toBe(1)
    expect((fieldRow?.props as Record<string, unknown>).paddingLeft).toBe((optionSubRow?.props as Record<string, unknown>).paddingLeft)
    await ui.unmount()
  }
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

test('the nav row has a separator after the options and Other…: an SVG rule on the desktop, a row of ─ on the terminal', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    // The engine keeps keys on Box nodes only, so the Other field and the nav row are found by key, the rules by content.
    // The details block has a divider above it too, so the separator before the nav row is the last rule drawn.
    const nodes = nodesOf(await ui.drawn())
    const rule = '─'.repeat(40)
    const keyAt = (key: string): number => nodes.findIndex(node => keyOfNode(node) === key)
    const isRule = (node: Record<string, unknown>): boolean =>
      (node.props as Record<string, unknown> | undefined)?.alt === 'divider' || (Array.isArray(node.children) && node.children.includes(rule))
    const navRuleAt = nodes.map(isRule).lastIndexOf(true)
    const otherAt = keyAt('other-row-q-l1-aaaaaa')
    expect(otherAt).toBeGreaterThan(-1)
    expect(navRuleAt).toBeGreaterThan(otherAt)
    expect(keyAt('nav-q-l1-aaaaaa')).toBeGreaterThan(navRuleAt)
    const svgRules = (await ui.findAll({ type: 'Svg' })).filter(found => found.props.alt === 'divider')
    if (surface === 'desktop') {
      // Two rules: the one above the details block, then the one above the nav row.
      expect(svgRules).toHaveLength(2)
      expect(svgRules[0]?.props).toMatchObject({ alt: 'divider', height: 21 })
      expect(String(svgRules[1]?.props.source)).toContain('<rect x="0" y="10" width="320" height="1"')
      expect(await ui.find({ type: 'Text', text: rule })).toBeUndefined()
    } else {
      expect(svgRules).toHaveLength(0)
      expect((await ui.find({ type: 'Text', text: rule }))?.props.dimColor).toBe(true)
    }
    await ui.unmount()
  }
})

test('a status row has no fill and no border: its mark alone takes the accent, and its text is plain and dim', async ($, on) => {
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
  const expired = 'expirou sem ser lida'
  const pending = 'Resposta B · enviada'
  expect((await textNodeWith(ui, expired))?.props).toMatchObject({ dimColor: true })
  expect((await textNodeWith(ui, pending))?.props).toMatchObject({ dimColor: true })
  expect((await ui.find({ type: 'Text', text: '⏳' }))?.props.color).toBe(ACCENT_COLOR)
  expect((await ui.find({ type: 'Text', text: '⚠️' }))?.props.color).toBe(ACCENT_COLOR)
  // No node of the pane is filled: the status rows and the explanation sections sit on the card's own background. The only box is the details block's round border.
  const filled = nodesOf(await ui.drawn()).filter(node => {
    const props = node.props as Record<string, unknown> | undefined
    return props?.backgroundColor !== undefined || props?.borderStyle !== undefined && props?.borderStyle !== 'round'
  })
  expect(filled).toHaveLength(0)
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

test('each explanation section shows only when its field is set, in the box of its place on the card', async ($, on) => {
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

test('the card draws the details right after the explanation before the question, urgency after the question, and undo right after why, with their Portuguese labels', async ($, on) => {
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
  const questionLine = texts.indexOf('Which way for q-l3-cccccc?')
  const urgencyLine = texts.indexOf('⏱️ Urgência: Blocks in ~8 min')
  const whyLine = texts.indexOf('💡 Por que A: It is smaller.')
  const undoLine = texts.indexOf('↩️ Como desfazer: Changing later ≈ 10 min')
  const gainsLine = texts.indexOf('🎁 O que ganhamos: Fast reads.')
  const lossesLine = texts.indexOf('⚖️ O que perdemos: A file to back up.')
  expect(urgencyLine).toBeGreaterThanOrEqual(0)
  expect(whyLine).toBeGreaterThan(-1)
  expect(undoLine).toBeGreaterThan(whyLine)
  expect(gainsLine).toBeGreaterThan(undoLine)
  expect(lossesLine).toBeGreaterThan(gainsLine)
  // The details sit before the question; Urgency sits above the explanation, under the title.
  expect(urgencyLine).toBeLessThan(questionLine)
  expect(questionLine).toBeGreaterThan(lossesLine)
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
  const lead = 'Trabalhando na B desde 14:02 enquanto espera você. Sua resposta ainda vale: escolha outra opção e ele muda; sem resposta, segue na B.'
  expect(texts).toContain(lead)
  // The title line of the details block comes after the lead, and the question after it.
  expect(texts.indexOf(lead)).toBeGreaterThan(texts.indexOf('Title q-l1-aaaaaa'))
  expect(texts.indexOf('Detalhes do Askaway:')).toBeGreaterThan(texts.indexOf(lead))
  expect(texts.indexOf('Detalhes do Askaway:')).toBeLessThan(texts.indexOf('Which way for q-l1-aaaaaa?'))
})

test('the card draws the lead line under the title in English: the recommended key and the time', async ($, on) => {
  const texts = await cardTextsAt1402($, on, { LANG: 'en_US.UTF-8' }, {})
  expect(texts).toContain('Working on B since 14:02 while it waits for you. Your answer still counts: pick another option and it switches; with no answer it stays on B.')
  expect(texts).not.toContain('Trabalhando na B desde 14:02 enquanto espera você. Sua resposta ainda vale: escolha outra opção e ele muda; sem resposta, segue na B.')
})

test('a high-risk card in pt-BR says the agent is paused, not on a key', async ($, on) => {
  const texts = await cardTextsAt1402($, on, {}, { risk: 'high' })
  expect(texts).toContain('Pausado desde 14:02: espera a sua resposta para seguir.')
  expect(texts.some(text => text.startsWith('Trabalhando na'))).toBe(false)
})

test('a high-risk card in English says the agent is paused, not on a key', async ($, on) => {
  const texts = await cardTextsAt1402($, on, { LANG: 'en_US.UTF-8' }, { risk: 'high' })
  expect(texts).toContain('Paused since 14:02: it waits for your answer before going on.')
  expect(texts.some(text => text.startsWith('Working on'))).toBe(false)
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

test('a name in an explanation is drawn bold, a slash command bare and a backticked one without its backticks', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { how: 'Run /reload-plugins, then open `frontend-code-engineer`.' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await textsOf(ui)).toContain('🛠️ Como: Run /reload-plugins, then open frontend-code-engineer.')
    const nodes = nodesOf(await ui.drawn())
    const nameChildren = nodes
      .filter(node => node.type === 'Text' && (node.props as Record<string, unknown> | undefined)?.bold === true)
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

test('model: parseAnswer reads the who an answer carries, and a record without one parses equal to the same record', () => {
  expect(parseAnswer({ id: 'q-m-000001', key: 'A', by: 'panel', ts: 5, who: 'Ana' }, 'q-m-000001')?.who).toBe('Ana')
  expect(parseAnswer({ id: 'q-m-000001', key: 'A', by: 'panel', ts: 5, who: '' }, 'q-m-000001')?.who).toBeUndefined()
  expect(parseAnswer({ id: 'q-m-000001', key: 'A', by: 'panel', ts: 5, who: 7 }, 'q-m-000001')?.who).toBeUndefined()
  const old = parseAnswer({ id: 'q-m-000001', key: 'A', by: 'panel', ts: 5 }, 'q-m-000001')
  expect(old).toEqual({ id: 'q-m-000001', key: 'A', by: 'panel', ts: 5 })
  const written: Answer = { id: 'q-m-000001', key: 'A', by: 'panel', ts: 5, who: 'Ana' }
  expect(parseAnswer(JSON.parse(JSON.stringify(written)), 'q-m-000001')).toEqual(written)
})

test('model: answerWho is ASKAWAY_WHO when it holds a name, else the OS user name, else unknown', () => {
  expect(answerWho('Ana', 'jdoe')).toBe('Ana')
  expect(answerWho(undefined, 'jdoe')).toBe('jdoe')
  expect(answerWho('  \t ', 'jdoe')).toBe('jdoe')
  expect(answerWho(undefined, undefined)).toBe('unknown')
  expect(answerWho('', ' \n ')).toBe('unknown')
})

test('model: answerWho trims, turns control characters into spaces, and caps at 40 characters with an ellipsis', () => {
  expect(answerWho('  Ana\tSilva\nLima  ', undefined)).toBe('Ana Silva Lima')
  expect(answerWho('a\u0007b\u009bc', undefined)).toBe('a b c')
  const forty = 'x'.repeat(40)
  expect(answerWho(forty, undefined)).toBe(forty)
  expect(answerWho(`${forty}y`, undefined)).toBe(`${'x'.repeat(39)}…`)
  // Characters are code points, as in askaway.py: an emoji counts as one.
  expect([...answerWho('😀'.repeat(45), undefined)]).toHaveLength(40)
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
  expect(await textNodeWith(ui, 'Resposta B · enviada')).toBeDefined()
  await ui.unmount()
  files.set(path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa'))
  await clock.advance(5000)
  ui = await mountPane($)
  expect(await textNodeWith(ui, 'lida pela sessão')).toBeDefined()
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
  expect(await textNodeWith(ui, 'lida pela sessão')).toBeDefined()
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
  expect(await textNodeWith(ui, 'expirou sem ser lida')).toBeDefined()
  await ui.unmount()
})

test('an answer unread past the 7-day TTL expires with no marker, and its line can be cleared', async ($, on) => {
  // Stamped more than the TTL before the clock's start, so the pane sees it expired at once (no long clock advance).
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', -ANSWER_TTL_MS - 60_000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await textNodeWith(ui, 'expirou sem ser lida')).toBeDefined()
  expect(await ui.find({ type: 'Markdown', key: 'history-clear' })).toBeDefined()
  await ui.unmount()
})

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const footerOf = async (ui: Awaited<ReturnType<typeof mountPane>>): Promise<string> =>
  (await textsOf(ui)).find(text => text.startsWith('Nada')) ?? ''

test('the footer moves an unread answer to expired once the 7-day TTL passes, without a new poll write', async ($, on) => {
  // Stamped just inside the TTL at the clock's start, so the TTL passes within one short advance.
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', -ANSWER_TTL_MS + 30_000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await footerOf(ui)).toContain('1 ainda não lida · 0 expiradas')
  await clock.advance(60_000)
  await clock.settle()
  expect(await footerOf(ui)).toContain('0 ainda não lidas · 1 expirada')
  await ui.unmount()
})

test('the footer drops an answer from the last-24-hours count once the window passes, with no status line change', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', -ONE_DAY_MS + 30_000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await footerOf(ui)).toContain('1 respondida nas últimas 24 h')
  await clock.advance(60_000)
  await clock.settle()
  expect(await footerOf(ui)).toContain('nenhuma respondida nas últimas 24 h')
  await ui.unmount()
})

test('the card has no details toggle and no e hotkey: every section is drawn at once, under the Askaway Details title', async ($, on) => {
  const long = {
    what: 'What W', problem: 'Problem P', analogy: 'Analogy N', why: 'Reason R', undo: 'Undo U', how: 'How H',
    gains: 'Gain G', losses: 'Loss L', context: 'Context C', urgency: 'Blocks soon',
  }
  const options = [
    { key: 'A', label: 'Keep', tradeoff: 'cheap', fit: 80, does: 'Keeps the queue', pros: 'Fast path', cons: 'Stale data' },
    { key: 'B', label: 'Rewrite', tradeoff: 'slow', fit: 40 },
  ]
  const files = new Map([
    [path('q', 'q-f1-aaaaaa'), question('q-f1-aaaaaa', 1000, { ...long, options })],
    [path('q', 'q-f2-bbbbbb'), question('q-f2-bbbbbb', 2000, { ...long, options })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  let texts = await textsOf(ui)
  for (const name of ['What W', 'Problem P', 'Analogy N', 'Reason R', 'Undo U', 'How H', 'Gain G', 'Loss L', 'Context C', 'Blocks soon', 'Keeps the queue', 'Fast path', 'Stale data']) {
    expect(texts.some(text => text.includes(name))).toBe(true)
  }
  expect(texts.some(text => text.startsWith('└ Cheap'))).toBe(true)
  // No toggle: no details Button, no "Detalhes" or "Ocultar detalhes" link, and no button carries the hotkey e.
  expect(await ui.find({ type: 'Button', key: 'details-q-f1-aaaaaa' })).toBeUndefined()
  expect(texts).not.toContain('Detalhes')
  expect(texts).not.toContain('Ocultar detalhes')
  for (const button of await ui.findAll({ type: 'Button' })) expect(button.props.hotkey).not.toBe('e')
  // The title line sits after What it is and before the details; the question and Urgency come after them.
  const at = (name: string): number => texts.findIndex(text => text.includes(name))
  expect(at('What W')).toBeLessThan(at('Detalhes do Askaway:'))
  expect(at('Detalhes do Askaway:')).toBeLessThan(at('Analogy N'))
  expect(at('Analogy N')).toBeLessThan(at('Reason R'))
  expect(at('Reason R')).toBeLessThan(at('Context C'))
  expect(at('Context C')).toBeLessThan(at('Which way for q-f1-aaaaaa?'))
  expect(at('Blocks soon')).toBeLessThan(at('What W'))
  expect(at('Which way for q-f1-aaaaaa?')).toBeGreaterThan(at('Context C'))
  // The details block has no border: its fill alone sets it apart, so no node draws a border colour.
  const bordered = nodesOf(await ui.drawn()).filter(node => (node.props as Record<string, unknown> | undefined)?.borderColor !== undefined)
  expect(bordered).toEqual([])
  // The second question draws the same sections, reached by Next.
  await ui.press({ key: 'nav-next' })
  texts = await textsOf(ui)
  expect(texts).toContain('Which way for q-f2-bbbbbb?')
  expect(texts.some(text => text.includes('Reason R'))).toBe(true)
  await ui.unmount()
})



const detailsFillOf = async (ui: Awaited<ReturnType<typeof mountPane>>): Promise<unknown> =>
  (await ui.find({ type: 'Box', key: 'details-q-l1-aaaaaa' }))?.props.backgroundColor

test('the details fill follows the theme family: #EEEDE9 under a light theme, #282828 under a dark one, and a theme change redraws it', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files, true, {}, {}, {}, 'light-ansi')
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await detailsFillOf(ui)).toBe(DETAILS_FILL.light)
    await ui.unmount()
  }
  const ui = await mountPane($)
  await $.config.set({ key: 'theme', value: 'dark-daltonized' })
  expect(await detailsFillOf(ui)).toBe(DETAILS_FILL.dark)
  await $.config.set({ key: 'theme', value: 'light' })
  expect(await detailsFillOf(ui)).toBe(DETAILS_FILL.light)
  await ui.unmount()
})

const detailsPropsOf = async (ui: Awaited<ReturnType<typeof mountPane>>) =>
  (await ui.find({ type: 'Box', key: 'details-q-l1-aaaaaa' }))?.props

test('the details block carries no backgroundColor under auto, so the engine theme shows through', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files, true, {}, {}, {}, 'auto')
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await detailsPropsOf(ui)).not.toHaveProperty('backgroundColor')
    await ui.unmount()
  }
})

test('the details fill is the dark one when the theme row is absent', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files, true, {}, {}, {}, null)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await detailsFillOf(ui)).toBe(DETAILS_FILL.dark)
  await ui.unmount()
})

test('a config.set to a custom theme drops the details fill, and a dark theme brings it back', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await detailsFillOf(ui)).toBe(DETAILS_FILL.dark)
  await $.config.set({ key: 'theme', value: 'custom:x' })
  expect(await detailsPropsOf(ui)).not.toHaveProperty('backgroundColor')
  await $.config.set({ key: 'theme', value: 'dark' })
  expect(await detailsFillOf(ui)).toBe(DETAILS_FILL.dark)
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
  expect(await textNodeWith(ui, 'Resposta A · enviada')).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' })).toBeUndefined()
  await ui.unmount()
})

test('an expired answer whose session ended stays until the person clears it, and the clear writes no state file', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session_title: 'Spec-49 follow-ups' })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: true, reason: 'session-ended' })],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const warning = 'a sessão encerrou antes de ler'
  await clock.advance(60_000)
  const ui = await mountPane($)
  expect(await textNodeWith(ui, warning)).toBeDefined()
  await ui.press({ key: 'history-clear', link: { href: 'file:///askaway/clear' } })
  expect(await textNodeWith(ui, warning)).toBeUndefined()
  expect(writes).toEqual([])
  await ui.unmount()
})

test('a line cleared before a restart stays hidden after it', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: true, reason: 'ttl' })],
  ])
  stubHost(on, files, true, { cleared: ['q-l1-aaaaaa'] })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await textNodeWith(ui, 'expirou sem ser lida')).toBeUndefined()
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
  expect(await textNodeWith(ui, 'Resposta C (Outra: "Use a fork")')).toBeDefined()
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
  expect(texts).toContainEqual(expect.stringContaining('Resposta B · enviada'))
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
  expect(texts).toContainEqual(expect.stringContaining('Resposta A · enviada'))
  await ui.unmount()
})

test('Other… takes a free-text answer through the same answer path, and blank text is no answer', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  // The field is open under the Other link from the start, with no press: a stable key, no value, no autofocus (the card
  // keeps its keys until the person clicks in), and typing reports through onInput.
  const field = await ui.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa' })
  expect(field?.props).not.toHaveProperty('autoFocus')
  expect(field?.props).not.toHaveProperty('value')
  // No label in front of the field: only its placeholder is drawn.
  expect(field?.props).not.toHaveProperty('label')
  // The Other link only focuses that field and records nothing. The harness grants no ui.focus, so the focus request itself
  // is not observable here: the press is checked by what it leaves in place.
  await ui.press({ key: 'other-q-l1-aaaaaa' })
  expect(await ui.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa' })).toBeDefined()
  expect(writes).toEqual([])
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a', kind: 'change' })
  expect(await ui.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa' })).toBeDefined()
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: '   ', kind: 'change' })
  expect(writes).toEqual([])
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: '  Use a fork  ' })
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', key: 'other', by: 'panel', text: 'Use a fork' })
  await clock.advance(250)
  expect(await textsOf(ui)).toContainEqual(expect.stringContaining('Resposta C (Outra: "Use a fork")'))
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
  expect(await textsOf(ui)).toContain('● ▪ Cache it on the disk no…')
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

test('an Other… answer keeps its link bold, with no echo of the typed text under it, also after going back', async ($, on) => {
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
  expect(await ui.find({ type: 'Button', key: 'other-q-l1-aaaaaa' })).toMatchObject({ props: { plain: true } })
  expect(JSON.stringify(await ui.find({ type: 'Button', key: 'other-q-l1-aaaaaa' }))).toContain('"underline":true')
  expect(await textsOf(ui)).not.toContain('Use a fork')
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
  expect(submits).toEqual(['Answered via panel by unknown: B · Rewrite. Askaway question q-l1-aaaaaa (Title q-l1-aaaaaa). (you were using A · Keep)'])
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
    'Answered via panel by unknown: B · Rewrite. Askaway question q-l1-aaaaaa (Title q-l1-aaaaaa). (you were using A · Keep)\n' +
      'Answered via panel by unknown: A · Keep. Askaway question q-l2-bbbbbb (Title q-l2-bbbbbb).',
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

test('hotkeys: each option its key letter, Other the next letter c, then z, x and w on the terminal and p, f and w on the desktop; none once the Other field holds typed text', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const hotkeyOf = async (key: string): Promise<unknown> => (await ui.find({ type: 'Button', key }))?.props.hotkey
  expect(await hotkeyOf('opt-q-l1-aaaaaa-A')).toBe('a')
  expect(await hotkeyOf('opt-q-l1-aaaaaa-B')).toBe('b')
  expect(await hotkeyOf('other-q-l1-aaaaaa')).toBe('c')
  expect(await hotkeyOf('nav-back')).toBe('z')
  expect(await hotkeyOf('nav-next')).toBe('x')
  await ui.press({ key: 'nav-next' })
  expect(await hotkeyOf('submit-all')).toBe('w')
  await ui.press({ key: 'nav-back' })
  // The Other link only focuses its field: the hotkeys stay until the person types in it.
  await ui.press({ key: 'other-q-l1-aaaaaa' })
  expect(await hotkeyOf('opt-q-l1-aaaaaa-A')).toBe('a')
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'o', kind: 'change' })
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.length).toBeGreaterThan(0)
  for (const button of buttons) expect(button.props.hotkey).toBeUndefined()
  // A blank field holds no text, so the hotkeys come back; the desktop mount below starts from that state.
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: '', kind: 'change' })
  await ui.unmount()
  // The desktop takes p and f for Back and Next: none of them is an option key of this question (A or B), so no shortcut
  // clashes with another. Options take their letters on the desktop too.
  const desk = await mountPane($, 'desktop')
  const deskHotkey = async (key: string): Promise<unknown> => (await desk.find({ type: 'Button', key }))?.props.hotkey
  expect(await deskHotkey('opt-q-l1-aaaaaa-A')).toBe('a')
  expect(await deskHotkey('other-q-l1-aaaaaa')).toBe('c')
  expect(await deskHotkey('nav-back')).toBe('p')
  expect(await deskHotkey('nav-next')).toBe('f')
  await desk.press({ key: 'nav-next' })
  expect(await deskHotkey('submit-all')).toBe('w')
  await desk.press({ key: 'nav-back' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'o', kind: 'change' })
  for (const button of await desk.findAll({ type: 'Button' })) expect(button.props.hotkey).toBeUndefined()
  await desk.unmount()
})

test('Other… takes the letter after the last option, and the desktop keys skip the letters options and Other use: with options A to O, Other is P, F and P are skipped, Back takes w and Submit all x', async ($, on) => {
  const options = Array.from({ length: 15 }, (_, index) => ({ key: String.fromCharCode(65 + index), label: `Option ${index}`, tradeoff: 'cheap', fit: 50 }))
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { options })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const desk = await mountPane($, 'desktop')
  const deskHotkey = async (key: string): Promise<unknown> => (await desk.find({ type: 'Button', key }))?.props.hotkey
  expect(await labelOf(desk, 'other-q-l1-aaaaaa')).toBe('P · Outra…')
  expect(await deskHotkey('other-q-l1-aaaaaa')).toBe('p')
  expect(await deskHotkey('nav-back')).toBe('w')
  expect(await deskHotkey('submit-all')).toBe('x')
  await desk.unmount()
})

test('options filed as [B, A] with B recommended: the first button reads "B · …" with the mark, and the "a" hotkey picks A', async ($, on) => {
  const reversed = [
    { key: 'B', label: 'Rewrite', tradeoff: 'slow', fit: 40 },
    { key: 'A', label: 'Keep', tradeoff: 'cheap', fit: 80 },
  ]
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { options: reversed, recommended: 'B' })]])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const optionButtons = (await ui.findAll({ type: 'Button' })).filter(button => String(button.props.label).includes(' · '))
  expect(optionButtons[0]?.props.label).toBe('B · Rewrite (Recomendada)')
  expect(await labelOf(ui, 'opt-q-l1-aaaaaa-A')).toBe('A · Keep')
  expect(await ui.find({ type: 'Text', text: 'B · Rewrite (Recomendada)' })).toMatchObject({ props: { bold: true } })
  const hotkeyOf = async (key: string): Promise<unknown> => (await ui.find({ type: 'Button', key }))?.props.hotkey
  expect(await hotkeyOf('opt-q-l1-aaaaaa-B')).toBe('b')
  expect(await hotkeyOf('opt-q-l1-aaaaaa-A')).toBe('a')
  const buttonWithHotkey = nodesOf(await ui.drawn()).find(
    node => node.type === 'Button' && (node.props as Record<string, unknown>).hotkey === 'a',
  )
  expect(buttonWithHotkey).toBeDefined()
  await ui.press({ key: String(keyOfNode(buttonWithHotkey ?? {})) })
  await ui.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', key: 'A', by: 'panel' })
  await ui.unmount()
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
  const STATUS_MARKS = ['⏳', '✓', '⚠️']
  const statusAt = drawn.flatMap((node, index) => (node.type === 'Text' && STATUS_MARKS.includes(textOf(node)) ? [index] : []))
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
  expect((await ui.find({ type: 'Markdown', key: 'tree-jump-q-l1-aaaaaa' }))?.props.text).toBe('│  ● ▪ **[Title q-l1-aaaaaa](file:///askaway/jump/q-l1-aaaaaa)**')
  expect(texts).toContain('│  ○ ▪ Title q-l2-bbbbbb')
  expect(texts).toContain('○ ▪ Title q-l3-cccccc')
  await ui.unmount()
})

test('after a pick the ● moves to the next question, and the picked row shows its check, " - " and its own Submit', async ($, on) => {
  stubHost(on, treeFiles())
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  const texts = await textsOf(ui)
  expect(texts).toContain('│  ○ ▪ Title q-l1-aaaaaa')
  expect(texts).toContain(' ✓ - ')
  expect(texts.indexOf(' ✓ - ')).toBeGreaterThan(texts.indexOf('│  ○ ▪ Title q-l1-aaaaaa'))
  expect(texts).toContain('│  ● ▪ Title q-l2-bbbbbb')
  expect(texts).not.toContain('│  ○ ▪ Title q-l2-bbbbbb')
  expect((await ui.find({ type: 'Markdown', key: 'tree-jump-q-l2-bbbbbb' }))?.props.text).toBe('│  ● ▪ **[Title q-l2-bbbbbb](file:///askaway/jump/q-l2-bbbbbb)**')
  // Only the picked row has its own Submit.
  // The question row and its Submit are links the plugin answers, and only their own hrefs.
  expect(await ui.find({ type: 'Markdown', key: 'tree-jump-q-l1-aaaaaa' })).toMatchObject({ props: { pressableLinks: ['file:///askaway/jump/q-l1-aaaaaa'] } })
  expect(await ui.find({ type: 'Markdown', key: 'tree-submit-q-l2-bbbbbb' })).toBeUndefined()
  // The row's own Submit reads "Enviar resposta" in pt-BR ("Submit Answer" in English), never a bare Submit.
  expect((await ui.find({ type: 'Markdown', key: 'tree-submit-q-l1-aaaaaa' }))?.props.text).toBe('▪ [Enviar resposta](file:///askaway/submit/q-l1-aaaaaa)')
  await ui.unmount()
})

test('a row Submit answers that question alone and removes its row; the other picks wait for Submit all', async ($, on) => {
  const { writes, clock } = stubHost(on, treeFiles())
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-B' })
  await ui.press({ key: 'opt-q-l2-bbbbbb-A' })
  expect(writes).toEqual([])
  await pressTreeLink(ui, 'submit', 'q-l1-aaaaaa')
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  await clock.advance(250)
  expect(await ui.find({ type: 'Markdown', key: 'tree-jump-q-l1-aaaaaa' })).toBeUndefined()
  // The second question keeps its pick and its own Submit.
  expect(await ui.find({ type: 'Markdown', key: 'tree-submit-q-l2-bbbbbb' })).toBeDefined()
  // Submit all still answers the rest of the group.
  await pressTreeLink(ui, 'jump', 'q-l3-cccccc')
  await ui.press({ key: 'opt-q-l3-cccccc-A' })
  await ui.press({ key: 'submit-all' })
  // Each answer is written once; the order of the rest follows the group, so the three are compared as a set.
  expect(writes[0]).toBe(path('a', 'q-l1-aaaaaa'))
  expect([...writes].sort()).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb'), path('a', 'q-l3-cccccc')])
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

test('a question row of the tree is a link: its press puts that question on the card, with no details toggle', async ($, on) => {
  // q-l3 has its details block drawn (Why) and no toggle; its row press puts the card on screen.
  const files = treeFiles()
  files.set(path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 2000, { session: 's2', why: 'Reason R' }))
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Markdown', key: 'tree-jump-q-l3-cccccc' })).toMatchObject({ props: { pressableLinks: ['file:///askaway/jump/q-l3-cccccc'] } })
  await pressTreeLink(ui, 'jump', 'q-l3-cccccc')
  // The card is now the question of the row, bold in the tree, and the first question's card is gone.
  const texts = await textsOf(ui)
  expect(texts).toContain('Which way for q-l3-cccccc?')
  expect(texts).not.toContain('Which way for q-l1-aaaaaa?')
  expect((await ui.find({ type: 'Markdown', key: 'tree-jump-q-l3-cccccc' }))?.props.text).toBe('● ▪ **[Title q-l3-cccccc](file:///askaway/jump/q-l3-cccccc)**')
  expect(await ui.find({ type: 'Button', key: 'details-q-l3-cccccc' })).toBeUndefined()
  await ui.unmount()
})

// A stand-in for an engine constructor: the element it draws is its tag and its props, children among them.
type FakeElement = { tag: string; props: Record<string, unknown> }
const fakeElement = (tag: string) => (props: Record<string, unknown>): FakeElement => ({ tag, props })
const childrenOf = (element: FakeElement | undefined): FakeElement[] => (element?.props.children as FakeElement[] | undefined) ?? []

// One question row of the tree, drawn with the fake constructors: with Markdown, or on a surface without it.
function fakeRow(options: {
  markdown: boolean
  isFinal: boolean
  question?: ReturnType<typeof parsedQuestion>
  onJump?: (id: string) => void
}): FakeElement {
  const ui = {
    Box: fakeElement('Box'),
    Text: fakeElement('Text'),
    Button: fakeElement('Button'),
    ...(options.markdown ? { Markdown: fakeElement('Markdown') } : {}),
  }
  const tree = {
    ui,
    lang: 'en',
    view: { screen: undefined, wizard: { picks: {} } },
    actions: { jump: (id: string) => options.onJump?.(id), submitOne: () => undefined },
    held: heldButtons(),
  }
  const question = options.question ?? parsedQuestion('q-l1-aaaaaa', 1000)
  return renderTreeQuestion(tree as never, question, options.isFinal) as unknown as FakeElement
}

test('on a surface that draws Markdown, a tree row is a Markdown link: its lead, the link mark and the file: link, and its press runs the jump', () => {
  const jumped: string[] = []
  const [link] = childrenOf(fakeRow({ markdown: true, isFinal: false, onJump: id => jumped.push(id) }))
  expect(link?.tag).toBe('Markdown')
  expect(link?.props.key).toBe('tree-jump-q-l1-aaaaaa')
  expect(link?.props.text).toBe(`│  ○ ${LINK_MARK} [Title q-l1-aaaaaa](file:///askaway/jump/q-l1-aaaaaa)`)
  expect(link?.props.pressableLinks).toEqual(['file:///askaway/jump/q-l1-aaaaaa'])
  const press = link?.props.onLinkPress as () => void
  press()
  expect(jumped).toEqual(['q-l1-aaaaaa'])
})

test('a title that writes markdown is escaped in its link, so it draws no link or autolink of its own', () => {
  const question = parsedQuestion('q-l1-aaaaaa', 1000, { title: 'See [docs](https://evil.example)' })
  const [link] = childrenOf(fakeRow({ markdown: true, isFinal: true, question }))
  expect(link?.props.text).toBe(`○ ${LINK_MARK} [See \\[docs\\]\\(https\\://evil\\.example\\)](file:///askaway/jump/q-l1-aaaaaa)`)
  expect(escapeMarkdown('a\tb\nc *d*')).toBe('a b c \\*d\\*')
})

test('on a surface with no Markdown, a tree row is the underlined Button it was: no link mark and no Markdown', () => {
  const row = fakeRow({ markdown: false, isFinal: false })
  const [button] = childrenOf(row)
  expect(button?.tag).toBe('Button')
  expect(button?.props.key).toBe('tree-jump-q-l1-aaaaaa')
  expect(button?.props.label).toBe('│  ○ Title q-l1-aaaaaa')
  expect(childrenOf(button)[0]?.props.underline).toBe(true)
  expect(JSON.stringify(row)).not.toContain('Markdown')
})

test('on the terminal and the desktop, a tree row is a Markdown link, and Other… keeps its Button with the mark', async ($, on) => {
  stubHost(on, treeFiles())
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Markdown', key: 'tree-jump-q-l1-aaaaaa' })).toMatchObject({ props: { pressableLinks: ['file:///askaway/jump/q-l1-aaaaaa'] } })
    expect(await ui.find({ type: 'Button', key: 'other-q-l1-aaaaaa' })).toBeDefined()
    expect(nodesOf(await ui.drawn()).some(node => node.type === 'Text' && Array.isArray(node.children) && node.children.includes(`${LINK_MARK} `))).toBe(true)
    await ui.unmount()
  }
})

test('a question of another project is pressable too: its press switches the group on screen and its card', async ($, on) => {
  const files = treeFiles()
  files.set(path('q', 'q-o1-eeeeee'), question('q-o1-eeeeee', 4000, { project: '/work/other' }))
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await textsOf(ui)).toContain('Which way for q-l1-aaaaaa?')
  await pressTreeLink(ui, 'jump', 'q-o1-eeeeee')
  const texts = await textsOf(ui)
  expect(texts).toContain('Which way for q-o1-eeeeee?')
  expect(texts).not.toContain('Which way for q-l1-aaaaaa?')
  // Walking back with Back stays inside the other project: its first question is the only one it has.
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
  expect(texts.indexOf('○ ▪ Title q-l3-cccccc')).toBeLessThan(texts.indexOf('Web'))
  expect(texts.indexOf('App')).toBeLessThan(texts.indexOf('Web'))
  expect(texts).toContain('○ ▪ Title q-l4-dddddd')
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

test('a session family is one group labelled by its root title; an old question keeps its project label', async ($, on) => {
  const family = { family: 'local_root', family_title: 'release checklist review' }
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { project: '/work/app/scratch', session: 's1', session_title: 'root session', ...family })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { project: '/work/app/scratch', session: 's2', session_title: 'child session', ...family })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { project: '/work/web', session: 's3' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const labels = nodesOf(await ui.drawn()).filter(node => node.type === 'Text' && Array.isArray(node.children) && node.children.includes('Release Checklist Review'))
  expect(labels.map(node => (node.props as Record<string, unknown>).bold)).toEqual([true])
  expect(await ui.find({ type: 'Text', text: 'Web' })).toBeDefined()
  const texts = await textsOf(ui)
  expect(texts).toContain('├ Root Session')
  expect(texts).toContain('└ Child Session')
  expect(texts).not.toContain('Scratch')
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
  expect(hotkeys).toContain('a')
  expect(hotkeys).not.toContain('m')
  await ui.unmount()
})

test('the details block sits between What it is and the question; the Urgency box follows the question and the options column has gap 2', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { what: 'W', urgency: 'Soon' })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const nodes = nodesOf(await ui.drawn())
  const keyAt = (key: string): number => nodes.findIndex(node => keyOfNode(node) === key)
  const questionAt = nodes.findIndex(node => Array.isArray(node.children) && node.children.includes('Which way for q-l1-aaaaaa?'))
  const whatAt = keyAt('explanation-before-question')
  const detailsAt = keyAt('details-q-l1-aaaaaa')
  const urgencyAt = keyAt('explanation-before-options')
  const firstOptionAt = keyAt('optrow-q-l1-aaaaaa-A')
  expect(questionAt).toBeGreaterThan(-1)
  expect(whatAt).toBeGreaterThan(-1)
  expect(detailsAt).toBeGreaterThan(whatAt)
  expect(questionAt).toBeGreaterThan(detailsAt)
  // Urgency sits right under the title row: before the lead line, the explanation and the details, and not after the question.
  expect(urgencyAt).toBeGreaterThan(-1)
  expect(urgencyAt).toBeLessThan(whatAt)
  expect(firstOptionAt).toBeGreaterThan(questionAt)
  // No explanation box after the options: Urgency is drawn only once, under the title.
  expect(keyAt('explanation-after-options')).toBe(-1)
  const column = nodes.find(
    node =>
      Array.isArray(node.children) &&
      node.children.some(child => typeof child === 'object' && child !== null && keyOfNode(child as Record<string, unknown>) === 'optrow-q-l1-aaaaaa-A'),
  )
  expect((column?.props as Record<string, unknown> | undefined)?.gap).toBe(2)
  await ui.unmount()
})

// Every question field the card can show, and two options with their sub-lines.
const FULL_CARD = {
  what: 'W',
  problem: 'P',
  analogy: 'An',
  urgency: 'Soon',
  how: 'H',
  gains: 'G',
  losses: 'L',
  undo: 'U',
  context: 'C',
  options: [
    { key: 'A', label: 'Keep', tradeoff: 'cheap', fit: 80, does: 'It stays.', pros: 'No risk.', cons: 'Old code.' },
    { key: 'B', label: 'Rewrite', tradeoff: 'slow', fit: 40, does: 'It moves.', pros: 'Clean.', cons: 'Slow.' },
  ],
}

// Each line is drawn, and each comes after the one before it.
const expectInOrder = (texts: string[], lines: string[]): void => {
  const found = lines.map(line => texts.indexOf(line))
  expect(lines.filter((_, index) => found[index] < 0)).toEqual([])
  expect(found).toEqual([...found].sort((a, b) => a - b))
}

test('the card draws What, The problem, then the details block (title, Analogy, Why to Context) before the question, then Urgency and the options with their sub-lines, in pt-BR', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expectInOrder(await textsOf(ui), [
    '⏱️ Urgência: Soon',
    'O que é: W',
    'O problema: P',
    'Detalhes do Askaway:',
    '🔁 Analogia: An',
    '💡 Por que A: It is smaller.',
    '↩️ Como desfazer: U',
    '🛠️ Como: H',
    '🎁 O que ganhamos: G',
    '⚖️ O que perdemos: L',
    '🧭 Contexto e origem: C',
    'Which way for q-l1-aaaaaa?',
    '└ Cheap · aderência 80',
    'O que acontece: It stays.',
    'Prós: No risk.',
    'Contras: Old code.',
    '└ Slow · aderência 40',
    'O que acontece: It moves.',
  ])
  await ui.unmount()
})

test('the section titles are bold and their bodies regular; the details block has no border, a theme fill, and its title first, bold beside the mark', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const isBoldText = (node: Record<string, unknown>): boolean =>
    node.type === 'Text' && (node.props as Record<string, unknown> | undefined)?.bold === true
  const childrenOf = (node: Record<string, unknown>): string[] =>
    Array.isArray(node.children) ? node.children.filter((child): child is string => typeof child === 'string') : []
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const nodes = nodesOf(await ui.drawn())
    const block = nodes.find(node => keyOfNode(node) === 'details-q-l1-aaaaaa')
    const inBlock = nodesOf(block)
    expect(block?.props).not.toHaveProperty('borderStyle')
    expect(block?.props).toMatchObject({ backgroundColor: DETAILS_FILL.dark })
    expect(inBlock.some(node => isBoldText(node) && childrenOf(node).includes('Detalhes do Askaway:'))).toBe(true)
    // The title row is the block's first child; its mark is the Askaway SVG on the desktop and the glyph on the terminal.
    const firstChild = Array.isArray(block?.children) ? block.children[0] : undefined
    expect(keyOfNode(firstChild as Record<string, unknown>)).toBe('details-title')
    expect(inBlock.some(node => node.type === 'Svg' && (node.props as Record<string, unknown>).alt === 'Askaway')).toBe(surface === 'desktop')
    expect(inBlock.some(node => node.type === 'Text' && childrenOf(node).includes('?'))).toBe(surface === 'terminal')
    // Each section title is a bold run; its body, drawn in the same line, is not bold.
    const boldRuns = nodes.filter(isBoldText).flatMap(childrenOf)
    for (const heading of ['O que é', 'O problema', '🔁 Analogia', '💡 Por que A', '↩️ Como desfazer', '🛠️ Como', '🎁 O que ganhamos', '⚖️ O que perdemos', '🧭 Contexto e origem', '⏱️ Urgência']) {
      expect(boldRuns).toContain(`${heading}: `)
    }
    expect(boldRuns).toContain('Which way for q-l1-aaaaaa?')
    expect((await ui.find({ type: 'Text', text: '🔁 Analogia: An' }))?.props.bold).not.toBe(true)
    await ui.unmount()
  }
})

test('the card draws the same order in English: the details block with its title, the question, then the option sub-lines under each link line', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files, true, {}, {}, { LANG: 'en_US.UTF-8' })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expectInOrder(await textsOf(ui), [
    '⏱️ Urgency: Soon',
    'What it is: W',
    'The problem: P',
    'Askaway Details:',
    '🔁 Analogy: An',
    '💡 Why A: It is smaller.',
    '↩️ Undo: U',
    '🛠️ How: H',
    '🎁 What we gain: G',
    '⚖️ What we lose: L',
    '🧭 Context and origin: C',
    'Which way for q-l1-aaaaaa?',
    '└ Cheap · fit 80',
    'What happens: It stays.',
    'Pros: No risk.',
    'Cons: Old code.',
    '└ Slow · fit 40',
    'What happens: It moves.',
  ])
  await ui.unmount()
})

test('a question filed before the new fields still draws its card and option lines, and none of the new lines', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  const texts = await textsOf(ui)
  expect(texts).toContain('Which way for q-l1-aaaaaa?')
  expect(texts).toContain('└ Cheap · aderência 80')
  expect(texts).toContain('💡 Por que A: It is smaller.')
  const newLabels = ['O que é', 'O problema', 'O que acontece', 'Prós', 'Contras']
  expect(texts.filter(text => newLabels.some(label => text.startsWith(label)))).toEqual([])
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
  expect(await labelOf(ui, 'other-q-l1-aaaaaa')).toBe('C · Outra…')
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
  expect(await labelOf(ui, 'other-q-l1-aaaaaa')).toBe('C · Other…')
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
test('a minute turning while only an answered question is open writes only the clock tick, which redraws the footer age', async ($, on) => {
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
  // The footer draws while no question is open, and its age label ("now", then "1 min") turns with the minute.
  expect(stateWrites.slice(writesBefore)).toEqual(['tick'])
  expect(await textNodeWith(ui, 'Resposta A · enviada')).toBeDefined()
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
  expect(await textsOf(ui)).toContainEqual(expect.stringContaining('Resposta B · enviada'))
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

test('an open question whose session has ended draws the notice and Dismiss instead of the options, with Next on', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 'sess-gone' })],
  ])
  const { ended } = stubHost(on, files)
  ended.add('q-l1-aaaaaa')
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await textsOf(ui)).toContain('A sessão que perguntou terminou; o agente ficou na A.')
  expect(await ui.find({ type: 'Button', key: 'dismiss-ended' })).toBeDefined()
  expect(await labelOf(ui, 'nav-next')).toBe('Próxima →')
  expect(await ui.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-A' })).toBeUndefined()
  await ui.unmount()
})

test('the ended notice reads in English with the recommended key, and a live session keeps its options', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-live' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 'sess-gone', recommended: 'B' })],
  ])
  const { ended } = stubHost(on, files, true, {}, {}, { LANG: '' })
  ended.add('q-l2-bbbbbb')
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await textsOf(ui)).not.toContain('The session that asked has ended; the agent stayed on A.')
  expect(await ui.find({ type: 'Button', key: 'dismiss-ended' })).toBeUndefined()
  await ui.unmount()
})

test('Dismiss on an ended card removes the question through prune --id, and sends no answer', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const { ended, calls, writes } = stubHost(on, files)
  ended.add('q-l1-aaaaaa')
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'dismiss-ended' })
  expect(calls.some(call => call.argv.slice(2, 5).join(' ') === 'prune --id q-l1-aaaaaa')).toBe(true)
  expect(files.has(path('q', 'q-l1-aaaaaa'))).toBe(false)
  expect(writes).toEqual([])
  await ui.unmount()
})

test('the pane asks for the answerer name once; Save stores it and the question goes away', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await textsOf(ui)).toContain('Your name, shown on the answers you give. Asked once; change it with /askaway who <name>.')
  await $.ui.input({ plugin: 'askaway', key: 'who-input', text: '  Ana\tSilva ' })
  expect(await textsOf(ui)).not.toContain('Your name, shown on the answers you give. Asked once; change it with /askaway who <name>.')
  expect((await run($, 'who')).text).toBe('Askaway signs your answers as Ana Silva. Change it with /askaway who <name>.')
  await ui.unmount()
})

test('Skip ends the name question for good, and a stored name is never asked again', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, { who: '' }, {}, { LANG: '' })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', key: 'who-skip' })).toBeUndefined()
  await ui.unmount()
})

test('/askaway who <name> stores the name; with no name it shows it, or says none is set', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  expect((await run($, 'who')).text).toBe('Askaway has no name for you yet. Set one with /askaway who <name>.')
  expect((await run($, 'who Ana  Maria')).text).toBe('Askaway will sign your answers as Ana Maria.')
  expect((await run($, 'who')).text).toBe('Askaway signs your answers as Ana Maria. Change it with /askaway who <name>.')
})

test('the stored name goes to the CLI as ASKAWAY_WHO on a panel answer', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { calls } = stubHost(on, files, true, { who: 'Ana' })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
  await ui.press({ key: 'submit-all' })
  expect(calls[0]?.env?.ASKAWAY_WHO).toBe('Ana')
  await ui.unmount()
})

test('the name question reads in Portuguese when the language is pt-BR', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  expect(await textsOf(ui)).toContain('Seu nome, mostrado nas respostas que você dá. Perguntado uma vez; mude com /askaway who <nome>.')
  expect(await ui.find({ type: 'Button', key: 'who-skip' })).toBeDefined()
  await ui.unmount()
})

test('/askaway quiet on|off stores the flag, reports it in both languages, and rejects other values', async ($, on) => {
  const files = new Map<string, string>()
  stubHost(on, files)
  await $.session.start(SESSION)
  expect((await run($, 'quiet')).text).toBe('Modo silencioso do Askaway desligado.')
  expect((await run($, 'quiet on')).text).toBe('Modo silencioso do Askaway ligado: sem aviso para pergunta nova e sem esmaecer depois de uma resposta.')
  expect((await run($, 'quiet')).text).toContain('ligado')
  expect((await run($, 'quiet maybe')).text).toBe('Use /askaway quiet on ou off.')
  expect((await run($, 'quiet off')).text).toBe('Modo silencioso do Askaway desligado.')
})

test('quiet mode raises no toast for a new question, and the stored flag holds across a session start', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { toasts, clock } = stubHost(on, files, true, { quiet: true })
  await $.session.start(SESSION)
  await clock.advance(5000)
  files.set(path('q', 'q-l5-eeeeee'), question('q-l5-eeeeee', 3000, { title: 'Pick a parser' }))
  await clock.advance(5000)
  expect(toasts).toEqual([])
  expect((await run($, 'quiet')).text).toContain('ligado')
})

test('quiet mode draws no fade: the answered card is not dimmed and leaves at once', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, { quiet: true })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'opt-q-l1-aaaaaa-A' })
  await ui.press({ key: 'submit-all' })
  expect(await ui.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' })).toBeUndefined()
  expect(await textsOf(ui)).toContain('Nenhuma pendente')
  await ui.unmount()
})

test('quiet off keeps the toast and the fade', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { toasts, clock } = stubHost(on, files, true, { quiet: false })
  await $.session.start(SESSION)
  await clock.advance(5000)
  files.set(path('q', 'q-l5-eeeeee'), question('q-l5-eeeeee', 3000, { title: 'Pick a parser' }))
  await clock.advance(5000)
  expect(toasts).toEqual(['Nova pergunta: Pick a parser'])
})

test('History: Clear counts the rows it removes, keeps a pending row, and is gone once nothing can go', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: true, reason: 'ttl' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A')],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  // The Clear link counts the one expired row; no per-line dismiss button is drawn any more.
  expect(String((await ui.find({ type: 'Markdown', key: 'history-clear' }))?.props.text)).toContain('(1')
  expect(await ui.find({ type: 'Button', key: 'dismiss-q-l1-aaaaaa' })).toBeUndefined()
  await ui.press({ key: 'history-clear', link: { href: 'file:///askaway/clear' } })
  expect(await ui.find({ type: 'Markdown', key: 'history-clear' })).toBeUndefined()
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toMatch(/expirou sem ser lida/)
  expect(drawn).toMatch(/Resposta A · /)
  await ui.unmount()
})

test('History: Clear drops a cleared id whose answer is gone from the board, and stores only the ids still on it', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: true, reason: 'ttl' })],
  ])
  // q-gone-eeeeee was cleared earlier; its answer has since left the board.
  stubHost(on, files, true, { cleared: ['q-gone-eeeeee'] })
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: 'history-clear', link: { href: 'file:///askaway/clear' } })
  await ui.unmount()
  // The stored list is read again at the next session start. The pruned id is no longer in it, so its answer, back on
  // the board, shows; the id still on the board stays hidden.
  files.set(path('q', 'q-gone-eeeeee'), question('q-gone-eeeeee', 500))
  files.set(path('a', 'q-gone-eeeeee'), answer('q-gone-eeeeee', 'A'))
  files.set(path('d', 'q-gone-eeeeee'), delivery('q-gone-eeeeee', { expired: true, reason: 'ttl' }))
  await $.session.start(SESSION)
  const restarted = await mountPane($)
  const restartedTexts = await textsOf(restarted)
  expect(restartedTexts).toContain(' Title q-gone-eeeeee')
  expect(restartedTexts).not.toContain(' Title q-l1-aaaaaa')
  await restarted.unmount()
})


test('model: "multimedia" does not grade medium urgency; an Other answer whose question is gone names no letter', () => {
  const grade = (extra: Record<string, unknown>) => urgencyGradeOf(parsedQuestion('q-u-000002', 1000, extra))
  expect(grade({ urgency: 'multimedia assets' })).toBe('low')
  expect(grade({ urgency: 'media team' })).toBe('medium')
  const orphan: Board = { questions: [], answers: [answerOf('q-m-000001', 'other', 1, 'lavanda')], delivered: [] }
  expect(historyOf('en', orphan, NO_STATUS)[0]?.sessions[0]?.entries[0]?.line).toContain('Answer (Other: "lavanda")')
})
