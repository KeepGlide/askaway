import type { EngineInterface, On, RenderElement } from 'claude-code'
import { DELIVERY_LINES } from './delivery-lines'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import {
  ANSWER_TTL_MS,
  EMPTY_BOARD,
  ageLabel,
  counterText,
  deliveryLine,
  escapeMarkdown,
  firstBlockOf,
  answerWho,
  footerText,
  groupBySession,
  leadOf,
  leavesOtherField,
  listText,
  localizedQuestion,
  optionLabelOf,
  parseAnswer,
  parseDelivery,
  parseQuestion,
  piecesOf,
  projectLabel,
  questionLabel,
  riskLabel,
  sectionsOf,
  sessionLabelOf,
  clearableIdsOf,
  historyOf,
  titleCase,
  urgencyGradeOf,
 desktopSessionOf, groupKeyOf, groupLabelOf, isRootSession, parseDesktopGroups, withDesktopGroup } from '../hooks/model'
import { heldButtons } from '../hooks/held'
import { placeUnder, renderPane, renderTreeQuestion } from '../hooks/pane'
import { t } from '../hooks/i18n'
import { resetDesktopConfigCache, writeAtomic } from '../hooks/register'
import { ACCENT_COLOR, LINK_MARK, TEXT_CONTRAST, URGENCY_COLOR } from '../hooks/look'
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

// Gates a test can close: a write, or the listing of the answer folder, waits until the test releases it. `answerExit` makes
// the CLI's reply exit with that code (a test of a failed reply).
// gauntlet 4, B1: each fault below fires once (the field clears), except `pruneExit` and `refusedReplyId`, which hold. `listed`
// records each folder the plugin lists, in order.
type Holds = {
  write?: Promise<void>
  listAnswers?: Promise<void>
  answerExit?: number
  listExit?: number
  // Runs when the pane's `list` call reaches the stub, before it answers: the card's state is read at that moment.
  onList?: () => Promise<void>
  failListOf?: string
  failReadOf?: string
  tornWriteTo?: string
  // Every write whose path holds this text throws (no space left) until the test clears it; the draft and cleared files
  // are written through a temp file, so their faults name `draft.json` or `cleared.json`, which the temp file's name holds.
  failingWriteTo?: string
  pruneExit?: number
  refusedReplyId?: string
  listed?: string[]
  // The modification time (ms) of each file, as the listing of its folder reports it (mtimeMs); 0 when a file has none set.
  mtimes?: Map<string, number>
  // The size (bytes) of each file, as the listing reports it (size); 0 when a file has none set.
  sizes?: Map<string, number>
  // A failing `install -m <mode>` (the panel token file), so the exit code the pane gets is this one.
  installExit?: number
  // The next prompt.submit fails. A hook that throws counts as skipped, so the host's own answer stands: with none, the
  // submit rejects and the pane logs the failure. The fault then clears.
  failSubmitOnce?: boolean
  // Runs when a link is made, with the target it names: a test writes another window's marker at that moment (Gauntlet 5 review R12).
  onLink?: (marker: string) => void
  // The stdout of `list --open` when it exits 0 but prints no list (Gauntlet 6 review R3).
  listStdout?: string
}

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
  // The lines a hook logs with $.ui.log, in order: a failed poll or action is logged here, not thrown.
  const logs: string[] = []
  const writes: string[] = []
  // The shared picks (draft.json) of each change, kept apart from `writes`, which lists the answers and the state files.
  const drafts: string[] = []
  // The shared Clear all (cleared.json) of each press, kept apart from `writes` for the same reason.
  const clearings: string[] = []
  const submits: string[] = []
  // The argv of each `ln` the pane makes (a delivery marker's no-clobber publish), in order (Gauntlet 5 review R4).
  const links: string[][] = []
  const calls: { argv: string[]; env?: Record<string, string> }[] = []
  const ended = new Set<string>()
  // The panel token calls in order (`install`, `write`, `chmod`).
  const tokenCalls: string[][] = []
  // The /askaway registrations in order: the description each one carries (M69).
  const registrations: { name: string; description: string }[] = []
  // The Desktop config cache belongs to one host: a test starts with none, so no test reads another test's config.
  resetDesktopConfigCache()
  const clock = mock.clock(on)
  mock.env(on, { HOME, LANG: 'pt_BR.UTF-8', ...env })
  mock.store(on, stored)
  on('command.register', (_$, event) => {
    registrations.push({ name: event.name, description: event.description })
    return { value: { command: event.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF }))
  // A null theme name is an absent theme row: the list has no row at all.
  on('config.list', () => ({ value: themeName === null ? [] : [{ key: 'theme', label: 'Theme', kind: 'choice', value: themeName }] }))
  on('config.set', (_$, e) => ({ value: e.value }))
  on('prompt.submit', (_$, e) => {
    submits.push(e.text)
    if (holds.failSubmitOnce) {
      holds.failSubmitOnce = undefined
      throw new Error('prompt refused: the session is closing')
    }
    return { text: e.text }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, event) => {
    logs.push(event.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow terminal' } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn beneath'] }))
  // Nothing beneath the plugin moves the focus ring: the move lands at once, as the engine's own stops do.
  on('ui.focus', () => ({}))
  on('fs.list', async (_$, e) => {
    holds.listed?.push(e.path)
    if (holds.failListOf === e.path) {
      holds.failListOf = undefined
      throw new Error(`EIO: cannot list ${e.path}`)
    }
    const prefix = `${e.path}/`
    const names = [...files.keys()].filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
    const listing = names.map(file => ({ name: file.slice(prefix.length), kind: 'file' as const, size: holds.sizes?.get(file) ?? 0, mtimeMs: holds.mtimes?.get(file) ?? 0, isLink: false }))
    if (e.path === `${STATE}/a`) await holds.listAnswers
    return { value: listing }
  })
  on('fs.read', (_$, e) => {
    if (holds.failReadOf === e.path) {
      holds.failReadOf = undefined
      throw new Error(`EIO: cannot read ${e.path}`)
    }
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  // A folder exists when a file lies under it, as on disk.
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) || [...files.keys()].some(file => file.startsWith(`${e.path}/`)) }))
  on('fs.write', async (_$, e) => {
    // An answer goes through the CLI (process.run below); a direct write to a/ would bypass its first-writer-wins link.
    if (e.path.startsWith(`${STATE}/a/`)) throw new Error(`answer written directly: ${e.path}`)
    // gauntlet 4, B1: a torn write stores half the text and throws; a temp file of an atomic write is not a state write.
    if (holds.tornWriteTo !== undefined && e.path.includes(holds.tornWriteTo)) {
      files.set(e.path, e.text.slice(0, 5))
      holds.tornWriteTo = undefined
      throw new Error(`ENOSPC: no space left on device: ${e.path}`)
    }
    if (holds.failingWriteTo !== undefined && e.path.includes(holds.failingWriteTo)) {
      throw new Error(`ENOSPC: no space left on device: ${e.path}`)
    }
    if (e.path.endsWith('.tmp')) {
      files.set(e.path, e.text)
      return { value: undefined }
    }
    if (e.path.includes('/panel-tokens/')) {
      tokenCalls.push(['write', e.path])
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
      if (e.argv[0] === 'install' || e.argv[0] === 'chmod') tokenCalls.push([...e.argv])
      // A failing `install` says which file it could not make, as the host's install does.
      if (e.argv[0] === 'install' && e.argv[1] === '-m' && holds.installExit !== undefined) {
        return { value: { exitCode: holds.installExit, stdout: '', stderr: `install: cannot create regular file '${e.argv[4] ?? ''}': No such file or directory`, isStdoutTruncated: false, isStderrTruncated: false } }
      }
      // gauntlet 4, B1: `mv -f from to` renames in the stub's folder; the target is recorded as the write it stands for.
      // The draft and cleared files are recorded apart, as the writes they are.
      if (e.argv[0] === 'mv') {
        const [from = '', to = ''] = e.argv.slice(2)
        const text = files.get(from)
        if (text === undefined) return cliReply('', 1)
        files.delete(from)
        files.set(to, text)
        if (to === `${STATE}/draft.json`) drafts.push(text)
        else if (to === `${STATE}/cleared.json`) clearings.push(text)
        else writes.push(to)
      }
      // `ln temp target` is the no-clobber publish (the CLI's create_once): it fails when the target is there.
      if (e.argv[0] === 'ln') {
        const [from = '', to = ''] = e.argv.slice(1)
        links.push([...e.argv])
        holds.onLink?.(to)
        if (files.has(to)) return cliReply('', 1)
        files.set(to, files.get(from) ?? '')
        writes.push(to)
      }
      if (e.argv[0] === 'rm') files.delete(e.argv[2] ?? '')
      return cliReply('')
    }
    calls.push({ argv: [...e.argv], env: e.init?.env })
    // `list --open` reports the ids a test put in `ended`; `prune --id` removes the question file, as the CLI does for one.
    if (e.argv[2] === 'list') {
      await holds.onList?.()
      if (holds.listExit !== undefined) return cliReply('', holds.listExit)
      if (holds.listStdout !== undefined) return cliReply(holds.listStdout)
      const items = [...files.keys()].filter(file => file.startsWith(`${STATE}/q/`)).map(file => ({ id: file.slice(`${STATE}/q/`.length, -5) }))
      return cliReply(JSON.stringify({ items: items.map(item => (ended.has(item.id) ? { ...item, ended: true } : item)) }))
    }
    if (e.argv[2] === 'prune') {
      if (holds.pruneExit !== undefined) return cliReply('', holds.pruneExit)
      files.delete(path('q', e.argv[4]))
      return cliReply(JSON.stringify({ removed: 1 }))
    }
    const [, , , id, key] = e.argv
    await holds.write
    if (holds.answerExit !== undefined) return cliReply('', holds.answerExit)
    if (holds.refusedReplyId === id) return cliReply('', 1)
    const stored = files.get(path('a', id))
    if (stored !== undefined) return cliReply(JSON.stringify({ id, key: (JSON.parse(stored) as { key: string }).key, written: false }))
    const textArg = e.argv.find(arg => arg.startsWith('--text='))
    const text = textArg === undefined ? undefined : textArg.slice('--text='.length)
    const record = { id, key, by: 'panel', ts: 0, ...(key === 'other' && text !== undefined ? { text: text.trim() } : {}) }
    files.set(path('a', id), `${JSON.stringify(record)}\n`)
    writes.push(path('a', id))
    return cliReply(JSON.stringify({ id, key, written: true }))
  })
  return { toasts, writes, drafts, clearings, submits, clock, calls, ended, tokenCalls, registrations, logs, links }
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
// The texts drawn, one per Text node and per Markdown block; a card's title heading ("### <title> - <See session> - <risk>
// · <age>") is split at its dashes, so the title, the link and the status line are listed as the Text nodes they were.
const textsOf = async (pane: Awaited<ReturnType<typeof mountPane>>): Promise<string[]> =>
  nodesOf(await pane.drawn()).flatMap(node => {
    if (node.type === 'Text') return [textOfNode(node)]
    if (node.type !== 'Markdown') return []
    const text = plainMarkdown(String((node.props as Record<string, unknown>).text))
    return text.startsWith('### ') ? text.slice(4).split(' - ') : [text]
  })

// The Text the pane draws that contains the fragment. A History line carries its own times, so tests match its words.
const textNodeWith = async (pane: Awaited<ReturnType<typeof mountPane>>, fragment: string) =>
  nodesOf(await pane.drawn()).find(node => node.type === 'Text' && textOfNode(node).includes(fragment))

// A tree link is pressed on its href, as a click on its Markdown link does: action is jump or submit, id the question.
const pressTreeLink = (pane: Awaited<ReturnType<typeof mountPane>>, action: 'jump' | 'submit', id: string) =>
  pane.press({ key: `tree-${action}-${id}`, link: { href: `file:///askaway/${action}/${id}` } })

// The label a Button is drawn with, by its key; undefined when it is not drawn.
const labelOf = async (pane: Awaited<ReturnType<typeof mountPane>>, key: string): Promise<unknown> =>
  (await pane.find({ type: 'Button', key }))?.props.label

// Every node of a drawn tree, depth first. A found element's props leave out `hover`, so the tree is read for it.
// The separator rule the pane draws on the desktop: an SVG with empty alt text and the rule's 21 px height.
const isDividerProps = (props: Record<string, unknown> | undefined): boolean => props?.alt === '' && props?.height === 21
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
const NO_STATUS = { cleared: [], now: 0, leaving: {} } as const

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

test('model: an option key must be one uppercase letter, so a key such as -h never reaches the CLI argument list', () => {
  const withFirstKey = (key: string) => JSON.parse(question('q-m-000004', 10, { recommended: 'B', options: [{ key, label: 'Keep' }, { key: 'B', label: 'Rewrite' }] }))
  expect(parseQuestion(withFirstKey('A'), 'q-m-000004')).toBeDefined()
  expect(parseQuestion(withFirstKey('-h'), 'q-m-000004')).toBeUndefined()
  expect(parseQuestion(withFirstKey('a'), 'q-m-000004')).toBeUndefined()
})

test('model: parseQuestion keeps each option tradeoff, and a missing or blank one reads as absent', () => {
  const withTradeoff = parsedQuestion('q-m-000001', 10)
  expect(withTradeoff.options.map(option => option.tradeoff)).toEqual(['cheap', 'slow'])
  const bare = parseQuestion(JSON.parse(nullFieldQuestion('q-m-000002', 10)), 'q-m-000002')
  expect(bare?.options.map(option => option.tradeoff)).toEqual([undefined, undefined])
  const blank = parseQuestion({ ...JSON.parse(question('q-m-000003', 10)), options: [{ key: 'A', label: 'Keep', tradeoff: '  ', fit: 1 }, { key: 'B', label: 'Rewrite', fit: 2 }] }, 'q-m-000003')
  expect(blank?.options[0]?.tradeoff).toBeUndefined()
})

test('model: a key the question does not list has no delivery line', () => {
  expect(deliveryLine(parsedQuestion('q-m-000001', 10), answerOf('q-m-000001', 'Z', 1))).toBeUndefined()
})

// The shared fixture tests/delivery-lines.ts, also read by askaway.py's tests (test_askaway.py). Each record goes through
// parseQuestion and parseAnswer, the read path the hook uses.
for (const fixture of DELIVERY_LINES) {
  test(`model: the delivery line matches the shared fixture: ${fixture.name}`, () => {
    const question = parsedQuestion(fixture.id, 1, { title: fixture.title, question: fixture.question, recommended: fixture.recommended, options: fixture.options })
    const answer = parseAnswer({ id: fixture.id, ts: 1, ...fixture.answer }, fixture.id)
    if (answer === undefined) throw new Error(`fixture ${fixture.name}: the answer record did not parse`)
    const line = deliveryLine(question, answer)
    expect(line).toBe(fixture.line)
    expect(line).not.toMatch(/\p{Cc}|\p{Zl}|\p{Zp}/u)
  })
}

test('model: format characters (zero-width, bidi overrides) are deleted from the Other text and from a who, not turned into spaces', () => {
  const question = parsedQuestion('q-m-000001', 10)
  expect(deliveryLine(question, answerOf('q-m-000001', 'other', 1, 'a\u200Bb\u202Ec\u2066'))).toContain('(Other): "abc" [typed')
  expect(deliveryLine(question, answerOf('q-m-000001', 'other', 1, '\u200B\u2066'))).toBeUndefined()
  expect(answerWho('An\u200Ba', undefined)).toBe('Ana')
  expect(answerWho('\u2066Ana\u2069', undefined)).toBe('Ana')
  expect(parseAnswer({ id: 'q-m-000001', key: 'A', by: 'panel', ts: 5, who: '\u202EAna' }, 'q-m-000001')?.who).toBe('Ana')
})

test('model: the Other text and the who keep no raw control character, so the History line never carries an escape or a NUL', () => {
  const at = localMs(10, 17, 14, 32)
  const lines = historyOf('en', {
    questions: [parsedQuestion('q-h-000001', 10), parsedQuestion('q-h-000002', 20)],
    answers: [
      { ...answerOf('q-h-000001', 'other', at, 'x\u001b[31m\u0000y\u009bz'), by: 'panel' },
      { ...answerOf('q-h-000002', 'A', at, undefined), by: 'cli', who: 'Ana\u001b\u0007' },
    ],
    delivered: [],
  }, { ...NO_STATUS, now: SAME_DAY_NOW }).flatMap(group => group.sessions.flatMap(session => session.entries.map(entry => entry.line)))
  expect(lines).toHaveLength(2)
  for (const line of lines) expect(line).not.toMatch(/\p{Cc}/u)
  expect(lines).toContainEqual(expect.stringContaining('“x [31m y z” · '))
  expect(lines).toContainEqual(expect.stringContaining('answered by Ana'))
})

test('model: a who read from a record is capped at 40 characters, as the write side caps it', () => {
  expect(parseAnswer({ id: 'q-m-000001', key: 'A', by: 'cli', ts: 5, who: 'x'.repeat(200) }, 'q-m-000001')?.who).toBe(`${'x'.repeat(39)}…`)
  expect(parseAnswer({ id: 'q-m-000001', key: 'A', by: 'cli', ts: 5, who: '  \u0007  ' }, 'q-m-000001')?.who).toBeUndefined()
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

test('model: a label is one line with no control or bidi characters, the escape and the bidi override are removed or spaced', () => {
  expect(sessionLabelOf(parsedQuestion('q-m-000003', 10, { session_title: 'build‮me\u0007now' }), 'en')).toBe('Buildme now')
  expect(projectLabel('/work/bridge‮to\u001bmoon', 'en')).toBe('Bridgeto moon')
  expect(groupLabelOf(parsedQuestion('q-m-000003', 10, { family_title: 'Family‮One' }), 'en')).toBe('FamilyOne')
})

test('model: the risk label reads in each language, and an unknown risk keeps its name', () => {
  expect(riskLabel('pt', 'high')).toBe('🛑 risco alto')
  expect(riskLabel('en', 'medium')).toBe('⚠️ medium risk')
  expect(riskLabel('en', 'low')).toBe('✅ low risk')
  // pane-safe5-1: a risk other than low, medium or high is never drawn raw (the label goes into a Markdown heading).
  expect(riskLabel('en', 'extreme')).toBe('⚠️ medium risk')
  expect(riskLabel('pt', 'constructor')).toBe('⚠️ risco médio')
  expect(riskLabel('en', 'high\n\n[Abrir](https://x)')).toBe('⚠️ medium risk')
})

test('model: the age label reads now, minutes, hours and days in both languages', () => {
  const HOUR = 3_600_000
  expect(ageLabel('en', 0, 0)).toBe('just now')
  expect(ageLabel('pt', 0, 0)).toBe('há instantes')
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
  expect(tree[0]?.sessions[0]?.entries.map(entry => entry.line)).toEqual(['Rewrite · sent 14:35'])
  expect(tree[0]?.sessions[1]?.entries.map(entry => entry.title)).toEqual(['Title q-h-000001'])
  expect(tree[1]?.sessions[0]?.entries).toEqual([
    { id: 'q-h-000009', title: 'Question closed', line: 'A · sent 13:58' },
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
  expect(lineOf('en', SAME_DAY_NOW)).toBe('Keep · sent 14:32 · delivered 14:33 (read by the session)')
  expect(lineOf('pt', SAME_DAY_NOW)).toBe('Keep · enviada 14:32 · entregue 14:33 (lida pela sessão)')
  expect(lineOf('en', localMs(10, 18, 9, 0))).toBe('Keep · sent 17/10 14:32 · delivered 17/10 14:33 (read by the session)')
  const withoutTime: Board = { ...delivered, delivered: [{ id: 'q-h-000001', expired: false }] }
  expect(lineOf('en', SAME_DAY_NOW, withoutTime)).toBe('Keep · sent 14:32 · (read by the session)')
})

test('model: the Other answer names its typed text; an agent or a named CLI answer names who answered, a panel answer names no one', () => {
  const at = localMs(10, 17, 14, 32)
  const lineOf = (extra: Partial<Answer>): string | undefined =>
    historyOf('en', { questions: [parsedQuestion('q-h-000001', 10)], answers: [{ ...answerOf('q-h-000001', 'other', at, '  lavanda  '), ...extra }], delivered: [] }, {
      ...NO_STATUS,
      now: SAME_DAY_NOW,
    })[0]?.sessions[0]?.entries[0]?.line
  expect(lineOf({})).toBe('“lavanda” · sent 14:32')
  expect(lineOf({ key: 'A', by: 'agent' })).toBe('Keep · answered by agent · sent 14:32')
  expect(lineOf({ key: 'A', by: 'cli', who: 'Ana' })).toBe('Keep · answered by Ana · sent 14:32')
  expect(lineOf({ key: 'A', by: 'panel', who: 'Ana' })).toBe('Keep · sent 14:32')
})

// beta.35, item 2: a History row names the chosen option by its label (in the language of the pane) and an Other reply by its
// whole typed text; the letter is never drawn, and a question that is gone draws its key letter.
test('model: a History row names the option label in English and Portuguese, an Other reply its whole text, and a reply with no text the Other label', () => {
  const typed = 'Use a fork of the sync client, keep the offline cache, and tell the team in the weekly standup before merging it'
  const board: Board = {
    questions: [parsedQuestion('q-h2-000001', 10, { title: 'Pick the queue' }), parsedQuestion('q-h2-000002', 20, { title: 'Second' })],
    answers: [answerOf('q-h2-000001', 'B', localMs(10, 17, 14, 32)), answerOf('q-h2-000002', 'other', localMs(10, 17, 14, 33), typed)],
    delivered: [{ id: 'q-h2-000001', expired: false, ts: localMs(10, 17, 14, 33) }],
  }
  const entriesOf = (lang: 'en' | 'pt', of: Board): Record<string, { title: string; line: string }> =>
    Object.fromEntries(
      historyOf(lang, of, { ...NO_STATUS, now: SAME_DAY_NOW })
        .flatMap(group => group.sessions.flatMap(session => session.entries))
        .map(entry => [entry.id, entry]),
    )
  const en = entriesOf('en', board)
  expect(en['q-h2-000001']).toEqual({ id: 'q-h2-000001', title: 'Pick the queue', line: 'Rewrite · sent 14:32 · delivered 14:33 (read by the session)' })
  expect(en['q-h2-000002']?.line).toBe(`“${typed}” · sent 14:33`)
  expect(entriesOf('pt', board)['q-h2-000001']?.line).toBe('Rewrite · enviada 14:32 · entregue 14:33 (lida pela sessão)')
  const blank: Board = { questions: board.questions, answers: [answerOf('q-h2-000002', 'other', localMs(10, 17, 14, 33))], delivered: [] }
  expect(entriesOf('en', blank)['q-h2-000002']?.line).toBe('Other… · sent 14:33')
  expect(entriesOf('pt', blank)['q-h2-000002']?.line).toBe('Outra… · enviada 14:33')
  const gone: Board = { questions: [], answers: [answerOf('q-h2-000003', 'B', localMs(10, 17, 14, 34))], delivered: [] }
  expect(historyOf('en', gone, { ...NO_STATUS, now: SAME_DAY_NOW })[0]?.sessions[0]?.entries[0]?.line).toBe('B · sent 14:34')
})

// beta.35, item 1: a stored title the CLI clipped to 60 characters (its last one "…") reads as the whole question; a
// title-less question reads whole, however long; a title that is not a clip reads as it is.
const CLIPPED_TEXT = 'Como o bloqueio de licença do sync deve se comportar enquanto a licença é validada offline pelo cliente?'
const CLIPPED_TITLE = `${Array.from(CLIPPED_TEXT).slice(0, 59).join('')}…`

test('model: a title the CLI clipped reads as the whole question, a title-less question reads whole, and any other title reads as it is', () => {
  expect(Array.from(CLIPPED_TITLE)).toHaveLength(60)
  expect(questionLabel(parsedQuestion('q-t1-000001', 1, { title: CLIPPED_TITLE, question: CLIPPED_TEXT }))).toBe(CLIPPED_TEXT)
  expect(questionLabel(parsedQuestion('q-t1-000002', 1, { title: '', question: CLIPPED_TEXT }))).toBe(CLIPPED_TEXT)
  expect(questionLabel(parsedQuestion('q-t1-000003', 1, { title: 'Pick the queue', question: CLIPPED_TEXT }))).toBe('Pick the queue')
  expect(questionLabel(parsedQuestion('q-t1-000004', 1, { title: 'Ends with… a word', question: CLIPPED_TEXT }))).toBe('Ends with… a word')
  expect(questionLabel(parsedQuestion('q-t1-000005', 1, { title: '', question: '🚀'.repeat(30) }))).toBe('🚀'.repeat(30))
})

test('model: Clear all removes every row drawn, pending ones included, and a cleared id hides its row', () => {
  const board: Board = {
    questions: [parsedQuestion('q-h-000001', 10), parsedQuestion('q-h-000002', 20), parsedQuestion('q-h-000003', 30)],
    answers: [answerOf('q-h-000001', 'A', 100), answerOf('q-h-000002', 'B', 200), answerOf('q-h-000003', 'C', 300)],
    delivered: [
      { id: 'q-h-000001', expired: false, ts: 150 },
      { id: 'q-h-000002', expired: true, reason: 'session-ended' },
    ],
  }
  expect(clearableIdsOf(historyOf('en', board, { ...NO_STATUS, now: 1000 }))).toEqual(['q-h-000003', 'q-h-000002', 'q-h-000001'])
  expect(clearableIdsOf(historyOf('en', board, { ...NO_STATUS, now: 1000, cleared: ['q-h-000002', 'q-h-000003'] }))).toEqual(['q-h-000001'])
})

test('model: a session that ended keeps its line under the family of its project', () => {
  const ended: Board = {
    questions: [parsedQuestion('q-m-000001', 10)],
    answers: [answerOf('q-m-000001', 'B', 1)],
    delivered: [{ id: 'q-m-000001', expired: true, reason: 'session-ended' }],
  }
  const [group] = historyOf('en', ended, NO_STATUS)
  expect(group?.label).toBe('App')
  expect(group?.sessions[0]?.entries[0]).toMatchObject({ id: 'q-m-000001', title: 'Title q-m-000001' })
  expect(group?.sessions[0]?.entries[0]?.line).toContain('the session ended before reading it')
  const orphan: Board = { questions: [], answers: [answerOf('q-m-000001', 'B', 1)], delivered: [] }
  expect(historyOf('pt', orphan, NO_STATUS)[0]?.label).toBe('a sessão')
  expect(historyOf('pt', orphan, NO_STATUS)[0]?.sessions[0]?.entries[0]?.line).toContain('B · enviada ')
})

test('model: an answer unread past the 7-day TTL reads as expired, and one inside the TTL still reads as pending', () => {
  const board: Board = { questions: [parsedQuestion('q-m-000001', 10)], answers: [answerOf('q-m-000001', 'B', 1000)], delivered: [] }
  const entriesAt = (now: number) =>
    historyOf('en', board, { ...NO_STATUS, now }).flatMap(group => group.sessions.flatMap(session => session.entries))
  expect(entriesAt(1000 + ANSWER_TTL_MS)[0]?.line).toMatch(/^Rewrite · sent [\d/ :]+$/)
  expect(entriesAt(1000 + ANSWER_TTL_MS + 1)).toMatchObject([{ id: 'q-m-000001' }])
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
    '3 answered in the last 24 h · last: Pick the queue → Keep, 12 min ago · 1 not yet read · 2 expired',
  )
  expect(footerText('pt', board, now)).toBe(
    '3 respondidas nas últimas 24 h · última: Pick the queue → Keep, há 12 min · 1 ainda não lida · 2 expiradas',
  )
  const withOpen: Board = { ...board, questions: [...board.questions, parsedQuestion('q-f-000006', 6)] }
  expect(footerText('en', withOpen, now)).toBeUndefined()
})

test('model: the footer names the last answer by its title in each language, the pt-BR title in Portuguese and the main one in English', () => {
  const board: Board = {
    questions: [parsedQuestion('q-f-000001', 1, { title: 'Pick the queue', translations: { 'pt-BR': { title: 'Escolha a fila' } } })],
    answers: [answerOf('q-f-000001', 'A', FOOT_DAY - 12 * FOOT_MIN)],
    delivered: [{ id: 'q-f-000001', expired: false }],
  }
  expect(footerText('en', board, FOOT_DAY)).toBe('1 answered in the last 24 h · last: Pick the queue → Keep, 12 min ago')
  expect(footerText('pt', board, FOOT_DAY)).toBe('1 respondida nas últimas 24 h · última: Escolha a fila → Keep, há 12 min')
})

test('model: the footer reads the zero and the singular forms in both languages', () => {
  expect(footerText('en', EMPTY_BOARD, FOOT_DAY)).toBe('none answered in the last 24 h')
  expect(footerText('pt', EMPTY_BOARD, FOOT_DAY)).toBe(
    'nenhuma respondida nas últimas 24 h',
  )
  const one: Board = {
    questions: [parsedQuestion('q-f-000001', 1)],
    answers: [answerOf('q-f-000001', 'A', FOOT_DAY - FOOT_HOUR)],
    delivered: [{ id: 'q-f-000001', expired: false }],
  }
  expect(footerText('en', one, FOOT_DAY)).toBe('1 answered in the last 24 h · last: Title q-f-000001 → Keep, 1 h ago')
  expect(footerText('pt', one, FOOT_DAY)).toBe(
    '1 respondida nas últimas 24 h · última: Title q-f-000001 → Keep, há 1 h',
  )
  const expiredOne: Board = { questions: [], answers: [answerOf('q-f-000002', 'B', 1)], delivered: [] }
  expect(footerText('pt', expiredOne, 8 * FOOT_DAY)).toContain('1 expirada')
})

// beta.35, item 1 and 2: the footer names the last answer's title whole (a clipped one as its whole question) and its option
// label, never its letter.
test('model: the footer names a long or clipped title of the last answer whole, and a question that is gone as "Question closed" and its letter', () => {
  const long: Board = {
    questions: [parsedQuestion('q-f-000001', 1, { title: 'a'.repeat(60) })],
    answers: [answerOf('q-f-000001', 'A', FOOT_DAY - FOOT_MIN)],
    delivered: [{ id: 'q-f-000001', expired: false }],
  }
  expect(footerText('en', long, FOOT_DAY)).toContain(`last: ${'a'.repeat(60)} → Keep, 1 min ago`)
  const clipped: Board = {
    questions: [parsedQuestion('q-f-000002', 1, { title: CLIPPED_TITLE, question: CLIPPED_TEXT })],
    answers: [answerOf('q-f-000002', 'A', FOOT_DAY - FOOT_MIN)],
    delivered: [{ id: 'q-f-000002', expired: false }],
  }
  expect(footerText('en', clipped, FOOT_DAY)).toContain(`last: ${CLIPPED_TEXT} → Keep, 1 min ago`)
  const gone: Board = { questions: [], answers: [answerOf('q-f-000009', 'B', FOOT_DAY - FOOT_MIN)], delivered: [] }
  // pane-rule1-5: a question that is gone is named as its History row names it, never by its raw id.
  expect(footerText('en', gone, FOOT_DAY)).toContain('last: Question closed → B, 1 min ago')
  expect(footerText('en', gone, FOOT_DAY)).not.toContain('q-f-000009')
})

test('model: each explanation section reads in the chosen language and shows only the fields set', () => {
  const short = parsedQuestion('q-m-000001', 10)
  expect(sectionsOf('pt', short, 'details')).toEqual([{ heading: '💡 Por que A', body: 'It is smaller.' }])
  expect(sectionsOf('en', short, 'details')).toEqual([{ heading: '💡 Why A', body: 'It is smaller.' }])
  expect(firstBlockOf(short)).toEqual([])

  const full = parsedQuestion('q-m-000002', 10, { context: 'C', analogy: 'An', how: 'H', gains: 'G', losses: 'L' })
  expect(firstBlockOf(full)).toEqual([])
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
  expect(firstBlockOf(every)).toEqual(['W', 'P'])
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
  expect(leadOf('en', parsedQuestion('q-m-000008', at, { recommended: 'B' }), at)).toBe('On B since 14:02. Pick another option to switch; no answer keeps B.')
  expect(leadOf('pt', parsedQuestion('q-m-000008', at, { recommended: 'B' }), at)).toBe('Na opção B desde 14:02. Escolha outra opção para trocar; sem resposta, fica a opção B.')
  expect(leadOf('en', parsedQuestion('q-m-000009', at, { risk: 'high' }), at)).toBe('Paused since 14:02, waiting for your answer.')
  expect(leadOf('pt', parsedQuestion('q-m-000009', at, { risk: 'high' }), at)).toBe('Pausado desde 14:02, esperando a sua resposta.')
  const early = new Date(2026, 9, 18, 9, 5).getTime()
  expect(leadOf('en', parsedQuestion('q-m-000010', early, {}), early)).toBe('On A since 09:05. Pick another option to switch; no answer keeps A.')
})

test('model: the list header and rows read in each language, with away mode when it is on', () => {
  const q = parsedQuestion('q-m-000001', 10)
  expect(listText('en', [q], true)).toBe(
    'Askaway: 1 pending, away mode on.\npending · q-m-000001 · Title q-m-000001 (recommended A)',
  )
  expect(listText('pt', [q], true)).toBe(
    'Askaway: 1 pendente, modo ausente ligado.\npendente · q-m-000001 · Title q-m-000001 (recomendada A)',
  )
  expect(listText('pt', [], false)).toBe('Askaway: 0 pendentes.')
})

// beta.34: the optional `translations` of a question (per language, per field and per option) and the overlay the pane draws.
test('model: parseQuestion keeps each language of translations, and drops every malformed part without damaging the question', () => {
  const parsed = parsedQuestion('q-t-000001', 10, {
    translations: {
      en: { title: 'Cache', question: 'Where?', what: '', analogy: 42, options: { A: { label: 'Disk', does: 'Writes', fit: 9 }, Z: { label: 'Ghost' } } },
      fr: { title: 'Cache FR' },
      'pt-BR': 'not an object',
    },
  })
  expect(parsed.translations).toEqual({ en: { title: 'Cache', question: 'Where?', options: { A: { label: 'Disk', does: 'Writes' } } } })
})

test('model: a translations value that is not an object reads as none, and the question still parses', () => {
  expect(parsedQuestion('q-t-000002', 10, { translations: ['en'] }).translations).toBeUndefined()
  expect(parsedQuestion('q-t-000003', 10, { translations: 'oops' }).translations).toBeUndefined()
  expect(parsedQuestion('q-t-000004', 10, { translations: { en: 'oops' } }).translations).toEqual({})
})

test('model: localizedQuestion overlays the language per field and per option, and a question with no translation for it is returned as it is', () => {
  const translated = parsedQuestion('q-t-000005', 10, {
    question: 'Onde?',
    translations: { en: { title: 'Cache', question: 'Where?', options: { A: { label: 'Disk' } } } },
  })
  const english = localizedQuestion(translated, 'en')
  expect(english.title).toBe('Cache')
  expect(english.question).toBe('Where?')
  expect(english.options.map(option => option.label)).toEqual(['Disk', 'Rewrite'])
  expect(english.options[0]?.tradeoff).toBe('cheap')
  expect(english.recommended).toBe('A')
  expect(localizedQuestion(translated, 'pt')).toBe(translated)
  const plain = parsedQuestion('q-t-000006', 10)
  expect(localizedQuestion(plain, 'en')).toBe(plain)
})

test('model: the delivery line of a translated question is the untranslated one, in every language', () => {
  const translated = parsedQuestion('q-t-000007', 10, { translations: { en: { title: 'Cache', options: { A: { label: 'Disk' } } } } })
  const plain = parsedQuestion('q-t-000007', 10)
  const answer = answerOf('q-t-000007', 'B', 5)
  expect(deliveryLine(translated, answer)).toBe(deliveryLine(plain, answer))
  expect(deliveryLine(translated, answer)).toContain('"Keep"')
  expect(deliveryLine(translated, answer)).toContain('"Title q-t-000007"')
})

test('model: the text list and the history rows draw the translated title in the language that is open', () => {
  const translatedQuestion = parsedQuestion('q-t-000008', 10, { translations: { en: { title: 'Cache' } } })
  expect(listText('en', [translatedQuestion], false)).toContain('Cache')
  expect(listText('pt', [translatedQuestion], false)).toContain('Title q-t-000008')
  const board = { ...EMPTY_BOARD, questions: [translatedQuestion], answers: [answerOf(translatedQuestion.id, 'A', 5)] }
  const rows = JSON.stringify(historyOf('en', board, NO_STATUS))
  expect(rows).toContain('"title":"Cache"')
  expect(rows).not.toContain('Title q-t-000008')
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
    'Answered via panel by "unknown": B · "Rewrite". Askaway question q-m-000002 ("Title q-m-000002"). (you were using A · "Keep")',
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
    const pane = await mountPane($, surface)
    const texts = await textsOf(pane)
    expect(texts).toContain('Title q-l1-aaaaaa')
    expect(texts).toContain('Which way for q-l1-aaaaaa?')
    // q-l2 is open but not on screen: it is an unpicked row of the tree, and its card is not drawn.
    expect(texts).toContain('○ Title q-l2-bbbbbb')
    expect(texts).not.toContain('Which way for q-l2-bbbbbb?')
    // The answered (q-l3) and delivered (q-l4) questions draw no card and no tree row: they show as History rows only.
    expect(texts).not.toContain('Which way for q-l3-cccccc?')
    expect(texts).not.toContain('Which way for q-l4-dddddd?')
    expect(await pane.find({ type: 'Markdown', key: 'tree-jump-q-l3-cccccc' })).toBeUndefined()
    expect(await pane.find({ type: 'Markdown', key: 'tree-jump-q-l4-dddddd' })).toBeUndefined()
    const historyRow = nodesOf(await pane.drawn()).find(node => keyOfNode(node) === 'history-q-l3-cccccc')
    // The history row is one line: the same ○ a waiting question row does, the title, " ✓ - " and the answer line.
    expect(nodesOf(historyRow).some(node => node.type === 'Text' && textOfNode(node).startsWith('○ Title q-l3-cccccc ✓ '))).toBe(true)
    // The broken file draws nothing.
    expect(texts.some(text => text.includes('q-l9'))).toBe(false)
    await pane.unmount()
  }
})

test('the tree names the group by its project, each session by its title in title case, or the words for the session when it has none', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1', session_title: 'spec-49 follow-ups' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's2' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const texts = await textsOf(pane)
  expect(texts).toContain('App')
  expect(texts).toContain('├ Spec-49 Follow-ups')
  // The stub host reads in pt-BR, so a session with no title reads "a sessão".
  expect(texts).toContain('└ a sessão')
  await pane.unmount()
})

test('the KeepGlide mark is drawn 24px beside the counter and 28px beside Submit all on the desktop, and nowhere on the terminal', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    // The drawn tree keeps no key on an Svg (only Box and Button keep theirs), so each mark is placed by its neighbour:
    // the header mark sits right after the counter, the other right after the Submit all button.
    const nodes = nodesOf(await pane.drawn())
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
    await pane.unmount()
  }
})

test('the Urgency text takes the colour of its grade, its bold title stays in the default colour', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { urgency: 'Blocks in ~8 min', urgency_level: 'high' })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const nodes = nodesOf(await pane.drawn())
  const bodyNode = nodes.find(node => node.type === 'Text' && Array.isArray(node.children) && node.children.includes('Blocks in ~8 min'))
  expect(bodyNode).toBeDefined()
  expect((bodyNode?.props as Record<string, unknown> | undefined)?.color).toBe('error')
  const titleNode = nodes.find(node => node.type === 'Text' && Array.isArray(node.children) && node.children.includes('⏱️ Urgência (alta): '))
  expect(titleNode).toBeDefined()
  expect((titleNode?.props as Record<string, unknown> | undefined)?.color).toBeUndefined()
  await pane.unmount()
})

test('the card draws the risk and age on the title row, and two blank lines before the options', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    const nodes = nodesOf(await pane.drawn())
    // The title row is one Markdown heading: the title, a dash, then the risk and the age; no See session link without a
    // Desktop session on the question.
    const titleRow = await pane.find({ type: 'Markdown', key: 'title-q-l1-aaaaaa' })
    const titleText = String((titleRow?.props as Record<string, unknown> | undefined)?.text)
    expect(titleText.startsWith(`### Title q-l1-aaaaaa - ${riskLabel('pt', 'low')} · `)).toBe(true)
    expect(titleText).not.toContain('](#')
    const optionList = nodes.find(
      node => node.type === 'Box' && nodesOf(node).some(inner => keyOfNode(inner) === 'opt-q-l1-aaaaaa-A') && nodesOf(node).some(inner => keyOfNode(inner) === 'opt-q-l1-aaaaaa-B') && (node.props as Record<string, unknown> | undefined)?.gap === 2,
    )
    expect((optionList?.props as Record<string, unknown> | undefined)?.marginTop).toBe(1)
    await pane.unmount()
  }
})

test('a single-question window: Submit all is dim until its pick, then primary, and writes the answer', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect(await labelOf(pane, 'submit-all')).toBe('Sem resposta · Enviar tudo (1) (w)')
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(true)
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(writes).toEqual([])
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect(await labelOf(pane, 'submit-all')).toBe('Resposta: B · Enviar tudo (1) (w)')
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.variant).toBe('primary')
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(false)
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', key: 'B', by: 'panel' })
  await clock.advance(250)
  expect(await textsOf(pane)).toContain('Nenhuma pendente')
  await pane.unmount()
})

test('a second press on another option replaces the pick; the answer is written only by Submit all', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(writes).toEqual([])
  expect((await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-A' }))?.props.variant).toBe('primary')
  expect((await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).toBe('secondary')
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'A' })
  await pane.unmount()
})

test('a pick is written to draft.json with its ts, and no answer is written until Submit all', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes, drafts } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(writes).toEqual([])
  expect(drafts).toHaveLength(1)
  expect(JSON.parse(drafts[0] ?? '{}')).toEqual({ ts: expect.any(Number), picks: { 'q-l1-aaaaaa': { key: 'B' } } })
  await pane.unmount()
})

test('a draft.json another session wrote with a newer ts is applied on the next poll: the pick shows and Submit all is primary', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes, drafts, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(true)
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: 100, picks: { 'q-l1-aaaaaa': { key: 'B' } } }))
  await clock.advance(5000)
  expect((await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).toBe('primary')
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.variant).toBe('primary')
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(false)
  // Applying a draft writes nothing back, and no answer is written.
  expect(drafts).toEqual([])
  expect(writes).toEqual([])
  await pane.unmount()
})

test('a draft.json no newer than the one this session last wrote is not applied', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { drafts, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await clock.advance(1000)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  const own = JSON.parse(drafts[0] ?? '{}') as { ts: number }
  // An older draft from another session, with a pick for the second question, which the card shows after Next.
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: own.ts - 1, picks: { 'q-l2-bbbbbb': { key: 'A' } } }))
  await clock.advance(5000)
  await pane.press({ key: 'nav-next' })
  expect(await labelOf(pane, 'nav-back')).toBe('Sem resposta · ← Voltar (z)')
  await pane.unmount()
})

test('a pick merges into the picks another session wrote since the last poll, instead of replacing them', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { drafts, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await clock.advance(1000)
  // The other session's write lands after this session's last poll, so this session has not applied it yet.
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: 100, picks: { 'q-l2-bbbbbb': { key: 'A' } } }))
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(JSON.parse(drafts[0] ?? '{}')).toEqual({
    ts: expect.any(Number),
    picks: { 'q-l2-bbbbbb': { key: 'A' }, 'q-l1-aaaaaa': { key: 'B' } },
  })
  await pane.unmount()
})

test('Submit all writes draft.json with the submitted questions dropped', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, drafts, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  await clock.advance(350)
  expect(writes).toEqual([])
  await pane.press({ key: 'nav-next' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  expect(JSON.parse(drafts[drafts.length - 1] ?? '{}')).toEqual({ ts: expect.any(Number), picks: {} })
  await pane.unmount()
})

test('a malformed draft.json is read as no draft: a pick of the wrong shape changes nothing', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock, drafts } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: 100, picks: { 'q-l1-aaaaaa': { key: 7 } } }))
  await clock.advance(5000)
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(true)
  expect(drafts).toEqual([])
  await pane.unmount()
})

test('a panel answer leaves who to the CLI: the call names no who and sets no ASKAWAY_WHO (the CLI stamps it)', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { calls } = stubHost(on, files, true, {}, {}, { ASKAWAY_WHO: '  Ana\tSilva  ' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await pane.press({ key: 'submit-all' })
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
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await pane.press({ key: 'submit-all' })
  const token = calls[0]?.env?.ASKAWAY_PANEL_TOKEN ?? ''
  expect(token).toMatch(/^[0-9a-f]{32}$/)
  // The file is made at mode 600 before its text, and set to 600 again after the write, so the mode holds either way.
  expect(tokenCalls).toEqual([
    ['install', '-d', '-m', '700', `${STATE}/panel-tokens`],
    ['install', '-m', '600', '/dev/null', `${STATE}/panel-tokens/${token}`],
    ['write', `${STATE}/panel-tokens/${token}`],
    ['chmod', '600', `${STATE}/panel-tokens/${token}`],
  ])
  expect(JSON.parse(files.get(`${STATE}/panel-tokens/${token}`) ?? '{}')).toHaveProperty('ts')
})

test('a panel token whose file cannot be made at mode 600 is not minted: the CLI never runs and no answer is written', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { calls, writes, tokenCalls } = stubHost(on, files, true, {}, { installExit: 1 })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await pane.press({ key: 'submit-all' })
  expect(tokenCalls.map(argv => argv[0])).toEqual(['install', 'install'])
  expect(calls).toEqual([])
  expect(writes).toEqual([])
  expect([...files.keys()].some(file => file.includes('/panel-tokens/'))).toBe(false)
  await pane.unmount()
})

test('a click picks and advances; Submit all on the last question writes every answer of the window in one go', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(writes).toEqual([])
  // The pick keeps the card on its question; Next moves on to the next question.
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  expect(writes).toEqual([])
  // Next on the last question opens the review, with every answer chosen and Submit all primary.
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Revise as suas respostas')
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.variant).toBe('primary')
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'B' })
  expect(readJson(files, path('a', 'q-l2-bbbbbb'))).toMatchObject({ key: 'A' })
  await clock.advance(250)
  expect(await textsOf(pane)).toContain('Nenhuma pendente')
  await pane.unmount()
})

test('Next moves on without a pick; on the last question Next opens the review, and Submit all waits for every pick', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  // The last question of a group of two still has a Next; it opens the review instead of moving on.
  expect(await labelOf(pane, 'nav-next')).toBe('Sem resposta · Próxima → (x)')
  expect(await pane.find({ type: 'Button', key: 'submit-all' })).toBeUndefined()
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Revise as suas respostas')
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(true)
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  await pane.unmount()
})

test('Back keeps the picks: the picked option stays the primary button when the step comes back', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect((await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).toBe('primary')
  expect(writes).toEqual([])
  await pane.unmount()
})

test('two projects are two groups: submit-all answers the first group, and the card then shows the next group\'s first question', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { project: '/work/web' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // The app group holds the oldest question, so it is the first group and the card starts on its first question.
  expect(await textsOf(pane)).toContain('Which way for q-l1-aaaaaa?')
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l3-cccccc-B' })
  await clock.advance(350)
  // Next on the last question of the app group opens its review; Submit all there writes the group's two answers.
  await pane.press({ key: 'nav-next' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l3-cccccc')])
  await clock.advance(250)
  // The app group is answered: its group Box is gone, and the web group's question is on screen.
  expect(await pane.find({ type: 'Box', key: 'group-/work/app' })).toBeUndefined()
  expect(await textsOf(pane)).toContain('Which way for q-l2-bbbbbb?')
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l3-cccccc')])
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l3-cccccc'), path('a', 'q-l2-bbbbbb')])
  await pane.unmount()
})

test('a question answered elsewhere leaves the round: its pick is pruned on the next poll, and Submit all writes only the rest', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  // The card is on q-l2 now: its pick makes q-l2 hold a pick when it is answered elsewhere.
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  files.set(path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A', 500))
  await clock.advance(5000)
  const texts = await textsOf(pane)
  expect(texts).not.toContain('Which way for q-l2-bbbbbb?')
  expect(texts).toContain('1 pendente · 1 grupo')
  expect(writes).toEqual([])
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  await pane.unmount()
})

test('no 🎯 and no tooltip: the recommended option says "(Recomendada)" in its text, bold while not picked', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: '🎯' })).toBeUndefined()
  expect(await pane.find({ type: 'Box', key: 'rec-q-l1-aaaaaa' })).toBeUndefined()
  const isAbsoluteBox = (node: Record<string, unknown>): boolean =>
    node.type === 'Box' && (node.props as Record<string, unknown> | undefined)?.position === 'absolute'
  expect(nodesOf(await pane.drawn()).filter(isAbsoluteBox)).toHaveLength(0)
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-A')).toBe('A · Keep (Recomendada)')
  expect(await pane.find({ type: 'Text', text: 'A · Keep (Recomendada)' })).toMatchObject({ props: { bold: true } })
  await pane.unmount()
})

test('each option is one full-width column with its tradeoff under it, headed by its key letter, and Other… is the last one, under the next letter', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-B')).toBe('B · Rewrite')
  expect(await labelOf(pane, 'other-q-l1-aaaaaa')).toBe('C · Outra…')
  for (const key of ['optrow-q-l1-aaaaaa-A', 'optrow-q-l1-aaaaaa-B']) {
    expect((await pane.find({ type: 'Box', key }))?.props.flexDirection).toBe('column')
  }
  expect(await pane.find({ type: 'Text', text: '└ Cheap · aderência 80' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '└ Slow · aderência 40' })).toBeDefined()
  await pane.unmount()
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
    const pane = await mountPane($, surface)
    const nodes = nodesOf(await pane.drawn())
    const optionSubRow = nodes.find(node => node.type === 'Box' && (node.props as Record<string, unknown> | undefined)?.paddingLeft === 1 && nodesOf(node).some(inner => inner.type === 'Text' && Array.isArray(inner.children) && inner.children.includes('└ Cheap · aderência 80')))
    const fieldRow = nodes.find(node => node.type === 'Box' && startsWithBranch(node) && nodesOf(node).some(inner => inner.type === 'Input'))
    expect(fieldRow).toBeDefined()
    expect(optionSubRow).toBeDefined()
    expect((fieldRow?.props as Record<string, unknown> | undefined)?.paddingLeft).toBe(1)
    expect((fieldRow?.props as Record<string, unknown> | undefined)?.paddingLeft).toBe((optionSubRow?.props as Record<string, unknown> | undefined)?.paddingLeft)
    await pane.unmount()
  }
})

test('the field under Other… is laid out to stretch: the row is full width and the Box holding the Input is a growing, stretching column, on both surfaces', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    const nodes = nodesOf(await pane.drawn())
    const fieldRow = nodes.find(node => node.type === 'Box' && startsWithBranch(node) && nodesOf(node).some(inner => inner.type === 'Input'))
    const holder = nodesOf(fieldRow ?? {}).find(node => node.type === 'Box' && Array.isArray(node.children) &&
      node.children.some(child => typeof child === 'object' && child !== null && (child as Record<string, unknown>).type === 'Input'))
    expect((fieldRow?.props as Record<string, unknown> | undefined)?.width).toBe('100%')
    const props = holder?.props as Record<string, unknown> | undefined
    expect(props?.flexDirection).toBe('column')
    expect(props?.alignItems).toBe('stretch')
    expect(props?.flexGrow).toBe(1)
    expect(props?.width).toBe('100%')
    await pane.unmount()
  }
})

test('the question card has one blank line under its nav row: paddingBottom 1, on both surfaces', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    expect((await pane.find({ type: 'Box', key: 'card-q-l1-aaaaaa' }))?.props.paddingBottom).toBe(1)
    await pane.unmount()
  }
})

test('the nav row has a separator after the options and Other…: an SVG rule on the desktop, a row of ─ on the terminal', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    // The engine keeps keys on Box nodes only, so the Other field and the nav row are found by key, the rules by content.
    // The details block has no rule above it: the separator before the nav row is the only rule drawn.
    const nodes = nodesOf(await pane.drawn())
    const rule = '─'.repeat(40)
    const keyAt = (key: string): number => nodes.findIndex(node => keyOfNode(node) === key)
    const isRule = (node: Record<string, unknown>): boolean =>
      isDividerProps(node.props as Record<string, unknown> | undefined) || (Array.isArray(node.children) && node.children.includes(rule))
    expect(nodes.filter(isRule)).toHaveLength(1)
    const navRuleAt = nodes.map(isRule).lastIndexOf(true)
    const otherAt = keyAt('other-row-q-l1-aaaaaa')
    expect(otherAt).toBeGreaterThan(-1)
    expect(navRuleAt).toBeGreaterThan(otherAt)
    expect(keyAt('nav-q-l1-aaaaaa')).toBeGreaterThan(navRuleAt)
    const svgRules = (await pane.findAll({ type: 'Svg' })).filter(found => isDividerProps(found.props))
    if (surface === 'desktop') {
      // One rule, the one above the nav row.
      expect(svgRules).toHaveLength(1)
      expect(svgRules[0]?.props).toMatchObject({ alt: '', height: 21 })
      expect(String(svgRules[0]?.props.source)).toContain('<rect x="0" y="10" width="320" height="1"')
      expect(await pane.find({ type: 'Text', text: rule })).toBeUndefined()
    } else {
      expect(svgRules).toHaveLength(0)
      expect((await pane.find({ type: 'Text', text: rule }))?.props.dimColor).toBe(true)
    }
    await pane.unmount()
  }
})

test('a status row has no fill and no border: it takes no colour of its own, and its text is plain', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A')],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: true, reason: 'ttl' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'B')],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const expired = 'expirou sem ser lida'
  const pending = 'Rewrite · enviada'
  expect(await textNodeWith(pane, expired)).toBeDefined()
  expect((await textNodeWith(pane, expired))?.props?.dimColor).toBeUndefined()
  expect(await textNodeWith(pane, pending)).toBeDefined()
  expect((await textNodeWith(pane, pending))?.props?.dimColor).toBeUndefined()
  // The history rows draw the plain ○ of the open tree, in no colour of their own.
  expect(await pane.find({ type: 'Text', text: /^○ / })).toBeDefined()
  expect((await pane.find({ type: 'Text', text: /^○ / }))?.props.color).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '⏳' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '⚠️' })).toBeUndefined()
  // No node of the pane is filled: the status rows and the explanation sections sit on the card's own background. The only box is the details block's round border.
  const filled = nodesOf(await pane.drawn()).filter(node => {
    const props = node.props as Record<string, unknown> | undefined
    return props?.backgroundColor !== undefined || props?.borderStyle !== undefined && props?.borderStyle !== 'round'
  })
  expect(filled).toHaveLength(0)
  await pane.unmount()
})

test('the header counts open questions and their groups: two sessions of one project are one group', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's1' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { session: 's2' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: 'Perguntas aguardando' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '3 pendentes · 1 grupo' })).toBeDefined()
  await pane.unmount()
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
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: 'Nenhuma pendente' })).toBeDefined()
  await pane.unmount()
})

test('the header counts a question with no session by its project', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { project: '/work/api' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: '3 pendentes · 2 grupos' })).toBeDefined()
  await pane.unmount()
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
  const pane = await mountPane($)
  expect(await pane.findAll({ type: 'Text', text: /\(Recomendada\)$/ })).toHaveLength(1)
  expect(await pane.findAll({ type: 'Text', text: '🎯' })).toHaveLength(0)
  const texts = await textsOf(pane)
  expect(texts.some(text => text.startsWith('🔷') || text.includes('JEV'))).toBe(false)
  // The recommended option is B here, so the explanation names it: one line, heading then text.
  expect(texts).toContain('💡 Por que B: It is smaller.')
  await pane.unmount()
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
  const pane = await mountPane($)
  const texts = await textsOf(pane)
  // A section is one Text, "heading: text": its whole line, and the bold heading as a Text of its own before the body.
  expect(texts.filter(text => text.startsWith('🧭'))).toEqual(['🧭 Contexto e origem: Why now.', '🧭 Contexto e origem: '])
  expect(texts).toContain('🔁 Analogia: Like a phone book.')
  expect(texts).toContain('💡 Por que A: It is smaller.')
  expect(texts).toContain('🛠️ Como: A table.')
  expect(texts).toContain('🎁 O que ganhamos: Fast reads.')
  expect(texts).toContain('⚖️ O que perdemos: A file to back up.')
  // Urgency and undo are not set on this question, so their headings are not drawn.
  expect(texts.some(text => text.startsWith('⏱️') || text.startsWith('↩️'))).toBe(false)
  await pane.unmount()
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
  const pane = await mountPane($)
  const texts = await textsOf(pane)
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
  await pane.unmount()
})

// A card for a question at 14:02 local time (built from local fields, so it reads 14:02 in any time zone).
const AT_1402 = new Date(2026, 9, 18, 14, 2).getTime()
async function cardTextsAt1402($: Engine, on: On, env: Record<string, string>, extra: Record<string, unknown>): Promise<string[]> {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', AT_1402, { recommended: 'B', ...extra })]])
  stubHost(on, files, true, {}, {}, env)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const texts = await textsOf(pane)
  await pane.unmount()
  return texts
}

test('the card draws the lead line right under the question in pt-BR: the recommended key and the time', async ($, on) => {
  const texts = await cardTextsAt1402($, on, {}, {})
  const lead = 'Na opção B desde 18/10 14:02. Escolha outra opção para trocar; sem resposta, fica a opção B.'
  // The lead is the text drawn straight after the question, and the details block comes before the question.
  expect(texts.indexOf(lead)).toBe(texts.indexOf('Which way for q-l1-aaaaaa?') + 1)
  expect(texts.indexOf('Detalhes do Askaway:')).toBeLessThan(texts.indexOf('Which way for q-l1-aaaaaa?'))
  expect(texts.indexOf('Title q-l1-aaaaaa')).toBeLessThan(texts.indexOf(lead))
})

test('the card draws the lead line right under the question in English: the recommended key and the time', async ($, on) => {
  const texts = await cardTextsAt1402($, on, { LANG: 'en_US.UTF-8' }, {})
  expect(texts.indexOf('On B since 18/10 14:02. Pick another option to switch; no answer keeps B.')).toBe(texts.indexOf('Which way for q-l1-aaaaaa?') + 1)
  expect(texts).not.toContain('Na opção B desde 18/10 14:02. Escolha outra opção para trocar; sem resposta, fica a opção B.')
})

test('a high-risk card in pt-BR says the agent is paused, not on a key', async ($, on) => {
  const texts = await cardTextsAt1402($, on, {}, { risk: 'high' })
  expect(texts).toContain('Pausado desde 18/10 14:02, esperando a sua resposta.')
  expect(texts.some(text => text.startsWith('Na '))).toBe(false)
})

test('a high-risk card in English says the agent is paused, not on a key', async ($, on) => {
  const texts = await cardTextsAt1402($, on, { LANG: 'en_US.UTF-8' }, { risk: 'high' })
  expect(texts).toContain('Paused since 18/10 14:02, waiting for your answer.')
  expect(texts.some(text => text.startsWith('On '))).toBe(false)
})

test('a losses-only question draws the losses section alone, and a gains-only one the gains', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { losses: 'Extra file.' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { gains: 'Quick answers.' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const losses = await textsOf(pane)
  expect(losses).toContain('⚖️ O que perdemos: Extra file.')
  expect(losses.some(text => text.startsWith('🎁'))).toBe(false)
  await pane.press({ key: 'nav-next' })
  const gains = await textsOf(pane)
  expect(gains).toContain('🎁 O que ganhamos: Quick answers.')
  expect(gains.some(text => text.startsWith('⚖️'))).toBe(false)
  await pane.unmount()
})

test('a question with every optional field null draws its card with no sections and no JEV line', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), nullFieldQuestion('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    const texts = await textsOf(pane)
    expect(texts).toContain('Which way for q-l1-aaaaaa?')
    expect(texts.some(text => /^(🧭|🔁|💡|🛠️|🎁|⚖️|🔷)/u.test(text))).toBe(false)
    await pane.unmount()
  }
})

test('a legacy question with tradeoff and no how, gains, losses or session title draws without empty sections', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const texts = await textsOf(pane)
  expect(texts).toContain('💡 Por que A: It is smaller.')
  expect(texts).toContain('└ Cheap · aderência 80')
  expect(texts.filter(text => /^(🛠️|🎁|⚖️)/u.test(text))).toEqual([])
  // No empty section and no blank row: the unanswered line carries its words while the question has no pick.
  expect(texts.filter(text => text.trim() === '')).toEqual([])
  await pane.unmount()
})

test('a name in an explanation is drawn bold, a slash command bare and a backticked one without its backticks', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { how: 'Run /reload-plugins, then open `frontend-code-engineer`.' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    expect(await textsOf(pane)).toContain('🛠️ Como: Run /reload-plugins, then open frontend-code-engineer.')
    const nodes = nodesOf(await pane.drawn())
    const nameChildren = nodes
      .filter(node => node.type === 'Text' && (node.props as Record<string, unknown> | undefined)?.bold === true)
      .map(node => node.children)
    expect(nameChildren).toContainEqual(['/reload-plugins'])
    expect(nameChildren).toContainEqual(['frontend-code-engineer'])
    // The section is still one line for a reader, with no backtick drawn anywhere.
    expect(await textsOf(pane)).toContain('🛠️ Como: Run /reload-plugins, then open frontend-code-engineer.')
    const drawnText = nodes.flatMap(node => (Array.isArray(node.children) ? node.children : [])).filter((child): child is string => typeof child === 'string')
    expect(drawnText.some(text => text.includes('`'))).toBe(false)
      await pane.unmount()
  }
})

test('an option tradeoff written in lowercase is drawn capitalized after └, in a box indented one cell, on both surfaces', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    const nodes = nodesOf(await pane.drawn())
    const indentedLine = (line: string): boolean =>
      nodes.some(
        node =>
          node.type === 'Box' &&
          (node.props as Record<string, unknown> | undefined)?.paddingLeft === 1 &&
          nodesOf(node).some(inner => inner.type === 'Text' && Array.isArray(inner.children) && inner.children.includes(line)),
      )
    expect(indentedLine('└ Cheap · aderência 80')).toBe(true)
    expect(indentedLine('└ Slow · aderência 40')).toBe(true)
    expect(await pane.find({ type: 'Text', text: 'cheap' })).toBeUndefined()
    await pane.unmount()
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
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: '└ Fast · fit 88' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '└ fit 55' })).toBeDefined()
  await pane.unmount()
})

test('an option draws its fit as "· aderência N" in Portuguese, the default language', async ($, on) => {
  const options = [
    { key: 'A', label: 'SQLite', tradeoff: 'fast', fit: 88 },
    { key: 'B', label: 'JSONL', tradeoff: 'simple', fit: 55 },
  ]
  const files = new Map([[path('q', 'q-f-aaaaaa'), question('q-f-aaaaaa', 1000, { options })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: '└ Fast · aderência 88' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '└ Simple · aderência 55' })).toBeDefined()
  await pane.unmount()
})

test('a question with a fit draws one fit hint line in English, explaining the 0 to 100 scale (M45)', async ($, on) => {
  const options = [
    { key: 'A', label: 'SQLite', tradeoff: 'fast', fit: 88 },
    { key: 'B', label: 'JSONL', tradeoff: 'simple', fit: 55 },
  ]
  const files = new Map([[path('q', 'q-f-aaaaaa'), question('q-f-aaaaaa', 1000, { options })]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect((await textsOf(pane)).filter(text => text === "fit N: the agent's estimate of fit, 0 to 100")).toHaveLength(1)
  await pane.unmount()
})

test('a question with a fit draws one fit hint line in Portuguese, explaining the 0 to 100 scale (M45)', async ($, on) => {
  const options = [
    { key: 'A', label: 'SQLite', tradeoff: 'fast', fit: 88 },
    { key: 'B', label: 'JSONL', tradeoff: 'simple', fit: 55 },
  ]
  const files = new Map([[path('q', 'q-f-aaaaaa'), question('q-f-aaaaaa', 1000, { options })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect((await textsOf(pane)).filter(text => text === 'aderência N: estimativa do agente, de 0 a 100')).toHaveLength(1)
  await pane.unmount()
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
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: '└ Cheap' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '└ Slow' })).toBeDefined()
  expect((await textsOf(pane)).some(text => /\bfit\b|aderência/u.test(text))).toBe(false)
  const row = await pane.find({ type: 'Box', key: 'optrow-q-f-aaaaaa-C' })
  expect(row).toBeDefined()
  expect(nodesOf(row).some(node => (node.props as Record<string, unknown> | undefined)?.paddingLeft === 1)).toBe(false)
  await pane.unmount()
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

test('Owner replies Q10: a pending answer shows "enviada", then "lida pela sessão", and that line stays until Clear all', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 5000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  let pane = await mountPane($)
  expect(await textNodeWith(pane, 'Rewrite · enviada')).toBeDefined()
  await pane.unmount()
  files.set(path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa'))
  await clock.advance(5000)
  pane = await mountPane($)
  expect(await textNodeWith(pane, 'lida pela sessão')).toBeDefined()
  await pane.unmount()
  // Q10: no timer removes a delivered line. This 36 s advance runs a poll every 5 s; the line is still drawn 35 s after the first sighting.
  await clock.advance(36_000)
  pane = await mountPane($)
  expect(await textNodeWith(pane, 'lida pela sessão')).toBeDefined()
  await pane.unmount()
  // Still drawn 60 s after the first sighting, and gone only once Clear all hides it.
  await clock.advance(24_000)
  pane = await mountPane($)
  expect(await textNodeWith(pane, 'lida pela sessão')).toBeDefined()
  await pane.press({ key: 'history-clear' })
  await pane.unmount()
  pane = await mountPane($)
  expect(await textNodeWith(pane, 'lida pela sessão')).toBeUndefined()
  await pane.unmount()
})

test('Owner replies Q10: a delivered line is still drawn 35 and 60 seconds after the first sighting, and goes only with Clear all', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 5000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  files.set(path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa'))
  await clock.advance(5000) // the poll at 5 s is the first sighting
  await clock.advance(25_000) // the poll at 30 s: 25 s on screen
  let pane = await mountPane($)
  expect(await textNodeWith(pane, 'lida pela sessão')).toBeDefined()
  await pane.unmount()
  await clock.advance(10_000) // the poll at 40 s: 35 s on screen
  pane = await mountPane($)
  expect(await textNodeWith(pane, 'lida pela sessão')).toBeDefined()
  await pane.unmount()
  await clock.advance(25_000) // the poll at 65 s: 60 s on screen
  pane = await mountPane($)
  expect(await textNodeWith(pane, 'lida pela sessão')).toBeDefined()
  await pane.press({ key: 'history-clear' })
  await pane.unmount()
  pane = await mountPane($)
  expect(await textNodeWith(pane, 'lida pela sessão')).toBeUndefined()
  await pane.unmount()
})

test('Owner replies Q10: a delivery already waiting at the first poll is drawn as read too, and stays after 60 seconds until Clear all', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 5000)],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa')],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(60_000)
  let pane = await mountPane($)
  expect(await textNodeWith(pane, 'lida pela sessão')).toBeDefined()
  await pane.press({ key: 'history-clear' })
  await pane.unmount()
  pane = await mountPane($)
  expect(await textNodeWith(pane, 'lida pela sessão')).toBeUndefined()
  await pane.unmount()
})

test('an expired answer with no reason reads as expired unread', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: true })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textNodeWith(pane, 'expirou sem ser lida')).toBeDefined()
  await pane.unmount()
})

test('an answer unread past the 7-day TTL expires with no marker, and its line can be cleared', async ($, on) => {
  // Stamped more than the TTL before the clock's start, so the pane sees it expired at once (no long clock advance).
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', -ANSWER_TTL_MS - 60_000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textNodeWith(pane, 'expirou sem ser lida')).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'history-clear' })).toBeDefined()
  await pane.unmount()
})

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const footerOf = async (pane: Awaited<ReturnType<typeof mountPane>>): Promise<string> =>
  (await textsOf(pane)).find(text => text.includes('nas últimas 24 h')) ?? ''

test('the footer moves an unread answer to expired once the 7-day TTL passes, without a new poll write', async ($, on) => {
  // Stamped just inside the TTL at the clock's start, so the TTL passes within one short advance.
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', -ANSWER_TTL_MS + 30_000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await footerOf(pane)).toContain('· 1 ainda não lida')
  await clock.advance(60_000)
  await clock.settle()
  expect(await footerOf(pane)).toContain('· 1 expirada')
  await pane.unmount()
})

test('the footer drops an answer from the last-24-hours count once the window passes, with no status line change', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', -ONE_DAY_MS + 30_000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await footerOf(pane)).toContain('1 respondida nas últimas 24 h')
  await clock.advance(60_000)
  await clock.settle()
  expect(await footerOf(pane)).toContain('nenhuma respondida nas últimas 24 h')
  await pane.unmount()
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
  const pane = await mountPane($)
  let texts = await textsOf(pane)
  for (const name of ['What W', 'Problem P', 'Analogy N', 'Reason R', 'Undo U', 'How H', 'Gain G', 'Loss L', 'Context C', 'Blocks soon', 'Keeps the queue', 'Fast path', 'Stale data']) {
    expect(texts.some(text => text.includes(name))).toBe(true)
  }
  expect(texts.some(text => text.startsWith('└ Cheap'))).toBe(true)
  // No toggle: no details Button, no "Detalhes" or "Ocultar detalhes" link, and no button carries the hotkey e.
  expect(await pane.find({ type: 'Button', key: 'details-q-f1-aaaaaa' })).toBeUndefined()
  expect(texts).not.toContain('Detalhes')
  expect(texts).not.toContain('Ocultar detalhes')
  for (const button of await pane.findAll({ type: 'Button' })) expect(button.props.hotkey).not.toBe('e')
  // The title line sits after the first block (What, then The problem) and before the details; the question and Urgency come after them.
  const at = (name: string): number => texts.findIndex(text => text.includes(name))
  expect(at('What W')).toBeLessThan(at('Detalhes do Askaway:'))
  expect(at('Detalhes do Askaway:')).toBeLessThan(at('Analogy N'))
  expect(at('Analogy N')).toBeLessThan(at('Reason R'))
  expect(at('Reason R')).toBeLessThan(at('Context C'))
  expect(at('Context C')).toBeLessThan(at('Which way for q-f1-aaaaaa?'))
  expect(at('Blocks soon')).toBeLessThan(at('What W'))
  expect(at('Which way for q-f1-aaaaaa?')).toBeGreaterThan(at('Context C'))
  // The details block has no border: its fill alone sets it apart, so no node draws a border colour.
  const bordered = nodesOf(await pane.drawn()).filter(node => (node.props as Record<string, unknown> | undefined)?.borderColor !== undefined)
  expect(bordered).toEqual([])
  // The second question draws the same sections, reached by Next.
  await pane.press({ key: 'nav-next' })
  texts = await textsOf(pane)
  expect(texts).toContain('Which way for q-f2-bbbbbb?')
  expect(texts.some(text => text.includes('Reason R'))).toBe(true)
  await pane.unmount()
})



const detailsFillOf = async (pane: Awaited<ReturnType<typeof mountPane>>): Promise<unknown> =>
  (await pane.find({ type: 'Box', key: 'details-q-l1-aaaaaa' }))?.props.backgroundColor

test('the details block draws the engine theme key userMessageBackground when there is no theme row', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files, true, {}, {}, {}, null)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    expect(await detailsFillOf(pane)).toBe('userMessageBackground')
    await pane.unmount()
  }
})

test('the details block draws the engine theme key userMessageBackground under a dark theme row', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files, true, {}, {}, {}, 'dark')
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await detailsFillOf(pane)).toBe('userMessageBackground')
  await pane.unmount()
})

test('the details block draws the engine theme key userMessageBackground under a light theme row', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files, true, {}, {}, {}, 'light')
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await detailsFillOf(pane)).toBe('userMessageBackground')
  await pane.unmount()
})

test('a config.set of the theme keeps the details block on userMessageBackground, whatever the value', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await detailsFillOf(pane)).toBe('userMessageBackground')
  for (const value of ['light', 'dark-daltonized', 'auto', 'custom:x']) {
    await $.config.set({ key: 'theme', value })
    expect(await detailsFillOf(pane)).toBe('userMessageBackground')
  }
  await pane.unmount()
})

test('a legacy answer written by accept_recommended reads as a normal status line', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), JSON.stringify({ id: 'q-l1-aaaaaa', key: 'A', by: 'accept_recommended', ts: 5000 })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textNodeWith(pane, 'Keep · enviada')).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' })).toBeUndefined()
  await pane.unmount()
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
  const pane = await mountPane($)
  expect(await textNodeWith(pane, warning)).toBeDefined()
  await pane.press({ key: 'history-clear' })
  expect(await textNodeWith(pane, warning)).toBeUndefined()
  expect(writes).toEqual([])
  await pane.unmount()
})

test('a line cleared before a restart stays hidden after it', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: true, reason: 'ttl' })],
  ])
  stubHost(on, files, true, { cleared: ['q-l1-aaaaaa'] })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textNodeWith(pane, 'expirou sem ser lida')).toBeUndefined()
  await pane.unmount()
})

test('the title row on the terminal names no "See session" link, even when the question knows its Desktop session', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { desktop_session: 'local_abc', title: 'Cache [it] now' })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const titleRow = await pane.find({ type: 'Markdown', key: 'title-q-l1-aaaaaa' })
  const text = String((titleRow?.props as Record<string, unknown> | undefined)?.text)
  // No session opens on the terminal, so the heading reads "<title> - <risk> · <age>".
  expect(text.startsWith(`### Cache \\[it\\] now - ${riskLabel('pt', 'low')} · `)).toBe(true)
  expect(text).not.toContain('](#local_abc)')
  // No pressable list on the heading.
  expect((titleRow?.props as Record<string, unknown> | undefined)?.pressableLinks).toBeUndefined()
  await pane.unmount()
})

test('model: desktop_session is kept only as local_<id> of letters, digits and dashes; any other text draws no link', () => {
  expect(desktopSessionOf('local_7f3a-b2')).toBe('local_7f3a-b2')
  expect(desktopSessionOf('local_x) - [a](b)')).toBeUndefined()
  expect(desktopSessionOf('local_a b')).toBeUndefined()
  expect(desktopSessionOf('abc')).toBeUndefined()
  expect(desktopSessionOf(null)).toBeUndefined()
})

test('the risk label reads in pt-BR for low, medium and high, with the age after it, one question per card', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { risk: 'low', session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { risk: 'medium', session: 's2' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { risk: 'high', session: 's3' })],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Markdown', text: / - ✅ risco baixo · / })).toBeDefined()
  await pane.press({ key: 'nav-next' })
  expect(await pane.find({ type: 'Markdown', text: / - ⚠️ risco médio · / })).toBeDefined()
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await pane.find({ type: 'Markdown', text: / - 🛑 risco alto · / })).toBeDefined()
  await pane.unmount()
})

test('the header has no Away, Paused, Clear answered or Accept all controls', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { pause: true, risk: 'high' })],
    [`${STATE}/away.json`, JSON.stringify({ on: true, ts: 1 })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: ' Away ' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: ' Paused ' })).toBeUndefined()
  expect(await pane.find({ key: 'clear-answered' })).toBeUndefined()
  expect(await pane.find({ key: 'accept-all' })).toBeUndefined()
  await pane.unmount()
})

test('a legacy answer with key other and its free text still gives a status line', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), JSON.stringify({ id: 'q-l1-aaaaaa', key: 'other', by: 'panel', ts: 5000, text: 'Use a fork' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textNodeWith(pane, 'Title q-l1-aaaaaa ✓ “Use a fork” · enviada')).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' })).toBeUndefined()
  await pane.unmount()
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

test('the new-question toast reads the title in the current language: the pt-BR title in Portuguese, the en title in English', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { toasts, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  files.set(path('q', 'q-l5-eeeeee'), question('q-l5-eeeeee', 3000, {
    title: 'Pick a parser',
    translations: { 'pt-BR': { title: 'Escolha um parser' } },
  }))
  await clock.advance(5000)
  expect(toasts).toEqual(['Nova pergunta: Escolha um parser'])
  await run($, 'lang en')
  files.set(path('q', 'q-l6-ffffff'), question('q-l6-ffffff', 5000, {
    title: 'Escolha uma fila',
    translations: { en: { title: 'Pick a queue' } },
  }))
  await clock.advance(5000)
  expect(toasts).toEqual(['Nova pergunta: Escolha um parser', 'New question: Pick a queue'])
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

// One `mv` the folder engine ran: its argv and the exit code it gave.
type MoveCall = { argv: string[]; exitCode: number }

// The file calls writeAtomic makes, on an in-memory folder: a write records its path, and `mv from to` renames within the
// folder and fails when `from` is gone, as the host does. As GNU mv does, `mv -T` refuses a folder at `to`, and a plain `mv`
// moves `from` into that folder. Each `mv` is recorded in `moves`. The test engine has no $.fs of its own.
function folderEngine(files: Map<string, string>, temps: string[], moves: MoveCall[] = [], folders = new Set<string>()): EngineInterface {
  return {
    fs: {
      write: async (file: string, text: string) => {
        if (file.endsWith('.tmp')) temps.push(file)
        files.set(file, text)
      },
    },
    process: {
      run: async (argv: string[]) => {
        const [from = '', to = ''] = argv.slice(2)
        const text = files.get(from)
        // The flags are one word (`-fT`): the T letter is the -T option.
        const refused = folders.has(to) && (argv[1] ?? '').includes('T')
        const exitCode = text === undefined || refused ? 1 : 0
        moves.push({ argv: [...argv], exitCode })
        if (exitCode !== 0) return { exitCode, stdout: '', stderr: `mv: cannot move ${from} to ${to}` }
        files.delete(from)
        files.set(folders.has(to) ? `${to}/${from.slice(from.lastIndexOf('/') + 1)}` : to, text ?? '')
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  } as unknown as EngineInterface
}

test('two windows write one target at once: both writes land, and each temp file is dot-prefixed and ends in .tmp', async () => {
  const files = new Map<string, string>()
  const temps: string[] = []
  const moves: MoveCall[] = []
  const engine = folderEngine(files, temps, moves)
  const target = `${STATE}/away.json`
  await Promise.all([writeAtomic(engine, target, 'first\n'), writeAtomic(engine, target, 'second\n')])
  expect(['first\n', 'second\n']).toContain(files.get(target))
  expect(temps).toEqual([
    expect.stringMatching(/\/\.away\.json\.[0-9a-f]+\.tmp$/),
    expect.stringMatching(/\/\.away\.json\.[0-9a-f]+\.tmp$/),
  ])
  expect(temps[0]).not.toBe(temps[1])
  // Both moves run as `mv -fT temp target` and exit 0, so each write lands.
  expect(moves.map(move => move.argv)).toEqual(temps.map(temp => ['mv', '-fT', temp, target]))
  expect(moves.map(move => move.exitCode)).toEqual([0, 0])
})

test('an atomic write refuses a folder at its target: mv -T fails, the folder stays, and writeAtomic throws', async () => {
  const files = new Map<string, string>()
  const temps: string[] = []
  const moves: MoveCall[] = []
  const target = `${STATE}/away.json`
  const folders = new Set([target])
  const outcome = await writeAtomic(folderEngine(files, temps, moves, folders), target, 'text\n').then(
    () => 'written',
    (error: unknown) => (error instanceof Error ? error.message : 'not an Error'),
  )
  expect(outcome).toContain('could not move')
  expect(moves.map(move => move.exitCode)).toEqual([1])
  expect(folders.has(target)).toBe(true)
  expect([...files.keys()]).toEqual(temps)
})

test('/askaway opens the pane, or answers the text list when the pane waits undrawn', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { title: 'Pick a parser' })]])
  stubHost(on, files, false)
  await $.session.start(SESSION)
  const listed = await run($, '')
  expect(listed.text).toContain('Askaway: 1 pendente.')
  expect(listed.text).toContain('Pick a parser')
})

test('/askaway lang en draws the open card in English on the very next draw, with no new question and no poll', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { desktop_session: 'local_abc', analogy: 'A ring road' })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($, 'desktop')
  await run($, 'lang en')
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('On A since')
  expect(drawn).toContain("fit N: the agent's estimate of fit, 0 to 100")
  expect(drawn).toContain('Askaway Details:')
  expect(drawn).toContain('Analogy: ')
  expect(drawn).toContain('See session')
  expect(await labelOf(pane, 'nav-back')).toBe('No answer · ← Back')
  await pane.unmount()
})

// beta.34: a pt-BR card whose question carries an en translation (the agent wrote the main text in Portuguese).
const TRANSLATED_CACHE = {
  title: 'Cache',
  question: 'Onde guardar o cache?',
  what: 'O cache guarda as respostas.',
  analogy: 'Um atalho',
  options: [
    { key: 'A', label: 'JSONL', tradeoff: 'simples', does: 'Guarda num arquivo', pros: 'Fácil', cons: 'Lento', fit: 88 },
    { key: 'B', label: 'SQLite', tradeoff: 'pesado', fit: 55 },
  ],
  translations: {
    en: {
      title: 'Cache',
      question: 'Where should the cache live?',
      what: 'The cache keeps the answers.',
      analogy: 'A shortcut',
      options: {
        A: { label: 'JSONL file', tradeoff: 'simple', does: 'Keeps it in a file', pros: 'Easy', cons: 'Slow' },
        B: { label: 'SQLite file', tradeoff: 'heavy' },
      },
    },
  },
}

test('/askaway lang en draws a translated card in English on the very next draw, and lang pt-BR draws it in Portuguese again', async ($, on) => {
  const files = new Map([[path('q', 'q-t-000010'), question('q-t-000010', 1000, TRANSLATED_CACHE)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($, 'desktop')
  expect(JSON.stringify(await pane.drawn())).toContain('Onde guardar o cache?')
  await run($, 'lang en')
  const english = JSON.stringify(await pane.drawn())
  expect(english).toContain('Where should the cache live?')
  expect(english).toContain('The cache keeps the answers.')
  expect(english).toContain('A shortcut')
  expect(english).toContain('JSONL file')
  expect(english).toContain('Keeps it in a file')
  expect(english).not.toContain('Onde guardar')
  expect(english).not.toContain('JSONL"')
  await run($, 'lang pt-BR')
  const portuguese = JSON.stringify(await pane.drawn())
  expect(portuguese).toContain('Onde guardar o cache?')
  expect(portuguese).toContain('Guarda num arquivo')
  expect(portuguese).not.toContain('Where should the cache live?')
  await pane.unmount()
})

test('a pt-BR translation is read and drawn: the main text is English, and /askaway lang pt-BR draws the Portuguese card', async ($, on) => {
  const files = new Map([[path('q', 'q-t-000014'), question('q-t-000014', 1000, {
    translations: {
      'pt-BR': { title: 'Cache em disco', question: 'Onde guardar o cache?', options: { A: { label: 'Manter', does: 'Mantém como está' } } },
    },
  })]])
  stubHost(on, files, true, {}, {}, { LANG: 'en_US.UTF-8' })
  await $.session.start(SESSION)
  const pane = await mountPane($, 'desktop')
  expect(JSON.stringify(await pane.drawn())).toContain('Which way for q-t-000014?')
  await run($, 'lang pt-BR')
  const portuguese = JSON.stringify(await pane.drawn())
  expect(portuguese).toContain('Cache em disco')
  expect(portuguese).toContain('Onde guardar o cache?')
  expect(portuguese).toContain('Mantém como está')
  expect(portuguese).not.toContain('Which way for q-t-000014?')
  await pane.unmount()
})

test('a question with no translations draws its own text in every language', async ($, on) => {
  const files = new Map([[path('q', 'q-t-000011'), question('q-t-000011', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($, 'terminal')
  await run($, 'lang en')
  expect(JSON.stringify(await pane.drawn())).toContain('Which way for q-t-000011?')
  await run($, 'lang pt-BR')
  expect(JSON.stringify(await pane.drawn())).toContain('Which way for q-t-000011?')
  await pane.unmount()
})

test('a partial translation falls back per field and per option to the main text', async ($, on) => {
  const files = new Map([[path('q', 'q-t-000012'), question('q-t-000012', 1000, {
    title: 'Cache',
    question: 'Onde?',
    what: 'Texto principal.',
    options: [
      { key: 'A', label: 'Manter', tradeoff: 'simples', fit: 80 },
      { key: 'B', label: 'Reescrever', tradeoff: 'lento', fit: 40 },
    ],
    translations: { en: { question: 'Where?', options: { B: { label: 'Rewrite it' } } } },
  })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($, 'terminal')
  await run($, 'lang en')
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('Where?')
  expect(drawn).toContain('Texto principal.')
  expect(drawn).toContain('Manter')
  expect(drawn).toContain('Rewrite it')
  expect(drawn).not.toContain('Onde?')
  expect(drawn).not.toContain('Reescrever')
  await pane.unmount()
})

test('a malformed translations value is ignored and the card still draws in its main language', async ($, on) => {
  const files = new Map([[path('q', 'q-t-000013'), question('q-t-000013', 1000, {
    question: 'Onde?',
    translations: { en: { title: 42, question: '', options: 'x' } },
  })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($, 'terminal')
  await run($, 'lang en')
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('Onde?')
  expect(drawn).toContain('Keep')
  await pane.unmount()
})

test('/askaway lang en switches the pane to English at once, and the choice is kept in the store', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const answered = await run($, 'lang en')
  expect(answered.text).toBe('Askaway language is now English.')
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: '1 pending · 1 group' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Questions waiting' })).toBeDefined()
  expect(await labelOf(pane, 'submit-all')).toBe('No answer · Submit all (1) (w)')
  await pane.unmount()
  expect(await run($, 'lang xx')).toEqual({ text: 'Use /askaway lang pt-BR, en or auto.' })
  // Object keys of the prototype are not choices either; nothing is stored for them.
  expect(await run($, 'lang constructor')).toEqual({ text: 'Use /askaway lang pt-BR, en or auto.' })
  expect(await run($, 'lang __proto__')).toEqual({ text: 'Use /askaway lang pt-BR, en or auto.' })
  expect(await run($, 'lang en')).toEqual({ text: 'Askaway language is now English.' })
  // The older spellings of Brazilian Portuguese still work, whatever the case.
  expect((await run($, 'lang pt')).text).toBe('O idioma do Askaway agora é Português.')
  expect((await run($, 'lang PT_BR')).text).toBe('O idioma do Askaway agora é Português.')
  await clock.advance(0)
})

test('Gauntlet M69: /askaway lang re-registers /askaway with the new description', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { registrations } = stubHost(on, files)
  await $.session.start(SESSION)
  expect(registrations).toEqual([{ name: 'askaway', description: 'Abre o painel do Askaway com as perguntas pendentes' }])
  await run($, 'lang en')
  expect(registrations).toHaveLength(2)
  expect(registrations[1]).toEqual({ name: 'askaway', description: 'Open the Askaway pane with the pending questions' })
})

test('/askaway lang pt then the pane reads in pt-BR, even when the environment says English', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, {}, {}, { LANG: 'en_US.UTF-8' })
  await $.session.start(SESSION)
  expect((await run($, 'lang pt-BR')).text).toBe('O idioma do Askaway agora é Português.')
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: 'Perguntas aguardando' })).toBeDefined()
  expect(await labelOf(pane, 'submit-all')).toBe('Sem resposta · Enviar tudo (1) (w)')
  await pane.unmount()
})

test('the language follows LANG=pt_BR.UTF-8 when nothing is stored', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: '1 pendente · 1 grupo' })).toBeDefined()
  await pane.unmount()
})

test('the language reads in English when no locale variable is set', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: '1 pending · 1 group' })).toBeDefined()
  await pane.unmount()
})

test('Submit all writes the answer only once the answer file is written', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = {}
  const { clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  const write = gate()
  holds.write = write.promise
  const pressed = pane.press({ key: 'submit-all' })
  await clock.settle()
  expect(files.has(path('a', 'q-l1-aaaaaa'))).toBe(false)
  write.open()
  await pressed
  expect(files.has(path('a', 'q-l1-aaaaaa'))).toBe(true)
  await pane.unmount()
})

test('a second Submit all press while the answer is being written writes nothing', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = {}
  const { writes, clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  const write = gate()
  holds.write = write.promise
  const first = pane.press({ key: 'submit-all' })
  await clock.settle()
  await pane.press({ key: 'submit-all' })
  write.open()
  await first
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'B' })
  await pane.unmount()
})

test('a poll that read the answer folder before a press keeps the press answer', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = {}
  const { clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const listing = gate()
  holds.listAnswers = listing.promise
  await clock.advance(5000)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await pane.press({ key: 'submit-all' })
  listing.open()
  await clock.advance(1000)
  const texts = await textsOf(pane)
  expect(texts).not.toContain('Which way for q-l1-aaaaaa?')
  expect(texts).toContainEqual(expect.stringContaining('Rewrite · enviada'))
  await pane.unmount()
})

test('Submit all on a question another writer already answered takes that answer at once', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  files.set(path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', 500))
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  await clock.advance(250)
  const texts = await textsOf(pane)
  expect(texts).not.toContain('Which way for q-l1-aaaaaa?')
  expect(texts).toContainEqual(expect.stringContaining('Keep · enviada'))
  await pane.unmount()
})

test('Other… keeps the text Enter sends as its label, a link click picks it into the same reply path, and blank Enter is no reply', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes, drafts, logs } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // The field is open under the Other link from the start, with no press: a stable key, no value (the field keeps its own
  // text across redraws), no autofocus (the card keeps its keys until the person clicks in), and no label: the engine's Input
  // draws its label as text, so the placeholder is the field's only text. Enter keeps the text as the link's label.
  const field = await pane.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa' })
  expect(field?.props).not.toHaveProperty('autoFocus')
  expect(field?.props).not.toHaveProperty('value')
  expect(field?.props).not.toHaveProperty('label')
  expect(field?.props.submitLabel).toBe('Aplicar')
  // The Other link only focuses that field and records nothing.
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  expect(await pane.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa' })).toBeDefined()
  expect(writes).toEqual([])
  // Blank Enter changes nothing: the field keeps its round and nothing is drafted.
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: '   ' })
  expect(await pane.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa' })).toBeDefined()
  expect(drafts).toEqual([])
  // Enter keeps the trimmed text as the label and picks it: the same question stays on screen, and nothing is written yet.
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: '  Use a fork  ' })
  expect(writes).toEqual([])
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  // A click on the link picks Other with that text again, and Submit all writes it as before.
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', key: 'other', by: 'panel', text: 'Use a fork' })
  // The harness answers no plugin ui.focus, so the link's focus move is logged and nothing else is.
  expect(logs.filter(line => !line.includes('ui.focus'))).toEqual([])
  await pane.unmount()
})

test('typing in Other… changes nothing drawn and writes nothing: no pick, no bold link, no state write', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes } = stubHost(on, files)
  // Every state write goes through state.set; the pane's text lives in memory, so no key may reach it.
  const stateWrites: string[] = []
  on('state.set', { plugin: 'askaway' }, (_$, e, next) => {
    stateWrites.push(e.key)
    return next(e)
  })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  const drawnBefore = JSON.stringify(await pane.drawn())
  const writesBefore = stateWrites.length
  for (const text of ['U', 'Us', 'Use', 'Use a', 'Use a fork']) {
    await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text, kind: 'change' })
    expect(JSON.stringify(await pane.drawn())).toBe(drawnBefore)
  }
  expect(stateWrites.length).toBe(writesBefore)
  expect(JSON.stringify(await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' }))).not.toContain('"bold":true')
  expect(writes).toEqual([])
  await pane.unmount()
})

test('the Other field opens three rows tall and grows with the typed text up to ten', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const rows = async () => (await pane.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa' }))?.props.rows
  expect(await rows()).toBe(3)
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'a\nb\nc\nd\ne', kind: 'change' })
  expect(await rows()).toBe(5)
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'x'.repeat(2000), kind: 'change' })
  expect(await rows()).toBe(10)
  await pane.unmount()
})

test('Next records the Other text typed and not confirmed, before the card moves on, so Submit all writes it', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: '  Use a fork  ', kind: 'change' })
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect(JSON.stringify(await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' }))).toContain('"bold":true')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'other', text: 'Use a fork' })
  await pane.unmount()
})

test('Enter drops the pending draft: the link picks the text Enter kept, not the older typing', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fo', kind: 'change' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
  // Enter keeps the text and picks it, so the older typing is gone and the pick is the kept text.
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  await clock.advance(350)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'other', text: 'Use a fork' })
  await pane.unmount()
})

test('blank Other… text typed after a recorded Other pick leaves the kept label picked when Next leaves the field (M46)', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
  // Keep moves the text to the link and picks it; a click on the link picks it again, and the card stays on its question.
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  // The field is open again under its new round: blank text typed there, not kept, takes the pick away when Next leaves it.
  await clock.advance(350)
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa-1', text: '   ', kind: 'change' })
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  // Blur with blank text is a no-op on a kept label: the label stays picked, and its text is still the reply's text.
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  expect(JSON.stringify(await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' }))).toContain('Use a fork')
  await pane.unmount()
})

test('a kept label drawn chosen is the primary button with a ✓ mark and bold, as a picked option is; unpicked it stays a plain link (M29b)', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  const unpicked = await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' })
  expect(unpicked?.props.plain).toBe(true)
  expect(unpicked?.props.variant).not.toBe('primary')
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(false)
  // Enter keeps the text and picks it, so the kept label is drawn chosen at once.
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
  const chosen = await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' })
  expect(chosen?.props.plain).toBeUndefined()
  expect(chosen?.props.variant).toBe('primary')
  expect(chosen?.props.label).toBe('✓ C · Use a fork')
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  await pane.unmount()
})

test('model: a focus move leaves the Other field only when the ring goes from its field to another element or an engine stop', () => {
  expect(leavesOtherField('other-input-q-l1-aaaaaa', 'nav-next')).toBe(true)
  expect(leavesOtherField('other-input-q-l1-aaaaaa', undefined)).toBe(true)
  expect(leavesOtherField('other-input-q-l1-aaaaaa', 'other-input-q-l1-aaaaaa')).toBe(false)
  expect(leavesOtherField('nav-next', 'other-input-q-l1-aaaaaa')).toBe(false)
  expect(leavesOtherField(undefined, 'opt-q-l1-aaaaaa-A')).toBe(false)
})

// The ring moves through the engine's own ui.focus event: onto `element`, or to one of the engine's stops when it is absent.
const moveRing = ($: Engine, element?: string) =>
  $.ui.focus({ component: 'Pane', requestId: 'askaway', origin: { kind: 'person' }, ...(element === undefined ? {} : { element }) })

const otherBold = async (pane: Awaited<ReturnType<typeof mountPane>>, id: string): Promise<boolean> =>
  JSON.stringify(await pane.find({ type: 'Button', key: `other-${id}` })).includes('"bold":true')

test('a focus move off the Other field records its typed text: the move is passed on, then the pick is recorded', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  // Registered before the host stub, so the recorder sees each move before the stub answers it.
  const moves: (string | undefined)[] = []
  on('ui.focus', { requestId: 'askaway' }, (_$, e, next) => {
    moves.push(e.element)
    return next(e)
  })
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await moveRing($, 'other-input-q-l1-aaaaaa')
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork', kind: 'change' })
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(false)
  await moveRing($, 'nav-next')
  expect(moves).toEqual(['other-input-q-l1-aaaaaa', 'nav-next'])
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  await pane.unmount()
})

test('a focus move within the Other field records nothing, and a move to an engine stop without a key does record', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await moveRing($, 'other-input-q-l1-aaaaaa')
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork', kind: 'change' })
  await moveRing($, 'other-input-q-l1-aaaaaa')
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(false)
  await moveRing($)
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  await pane.unmount()
})

test('a focus move from Submit all onto another element records the Other text typed before it; a move within Submit all records nothing', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await moveRing($, 'other-input-q-l1-aaaaaa')
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork', kind: 'change' })
  await moveRing($, 'submit-all')
  await moveRing($, 'submit-all')
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(false)
  await moveRing($, 'nav-next')
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  await pane.unmount()
})

test('Back records the Other text typed on the card it leaves', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'nav-next' })
  await pane.press({ key: 'other-q-l2-bbbbbb' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l2-bbbbbb', text: 'Use a fork', kind: 'change' })
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await otherBold(pane, 'q-l2-bbbbbb')).toBe(true)
  await pane.unmount()
})

test('Submit all records the Other text typed after the picks, before it writes', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  await clock.advance(350)
  await pane.press({ key: 'other-q-l2-bbbbbb' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l2-bbbbbb', text: 'Use a fork', kind: 'change' })
  // Next on the last question records the typed text first, then opens the review, where Submit all writes both answers.
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  expect(readJson(files, path('a', 'q-l2-bbbbbb'))).toMatchObject({ key: 'other', text: 'Use a fork' })
  await pane.unmount()
})

test('Submit all with a kept label sends the text typed after it: the typed text is the answer, as SPEC says', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'First text' })
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa-1', text: 'Use a fork', kind: 'change' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'other', text: 'Use a fork' })
  await pane.unmount()
})

test('a pick changed on the last card while an earlier answer is written is the answer sent, not dropped', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const holds: Holds = {}
  const { writes, clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  const write = gate()
  holds.write = write.promise
  const pressed = pane.press({ key: 'submit-all' })
  await clock.settle()
  // The review's jump to the last card, then a new pick on it, while the write is in flight.
  await pressTreeLink(pane, 'jump', 'q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-B' })
  write.open()
  await clock.settle()
  await pressed
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  expect(readJson(files, path('a', 'q-l2-bbbbbb'))).toMatchObject({ key: 'B' })
  await pane.unmount()
})

test('Submit all drawn off takes the press when the only answer is an Other text typed but not recorded: it records, then writes', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork', kind: 'change' })
  // No Enter and no focus move: the pane still draws the button off, as the draft is not in the store yet.
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(true)
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'other', text: 'Use a fork' })
  await pane.unmount()
})

test('Submit all drawn off with an Other text on one of two questions records the pick and writes nothing while the other has none', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'other-q-l2-bbbbbb' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l2-bbbbbb', text: 'Use a fork', kind: 'change' })
  // Next on the last question records the typed text, then opens the review: q-l1-aaaaaa has no answer, so Submit all is dim.
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Revise as suas respostas')
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(true)
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  // Back to the last card, a blank text typed over the field, then Next: the Other pick goes away, and nothing is written.
  await clock.advance(350)
  await pane.press({ key: 'review-back' })
  await clock.advance(350)
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l2-bbbbbb', text: '   ', kind: 'change' })
  await pane.press({ key: 'nav-next' })
  expect((await textsOf(pane)).filter(text => text.includes('→ Sem resposta'))).toHaveLength(2)
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  await pane.unmount()
})

test('an Other text recorded from its field that completes a group of two keeps the card; Next on the last question draws the review', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { title: 'Cache layer' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { title: 'Retry policy' })],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await moveRing($, 'other-input-q-l2-bbbbbb')
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l2-bbbbbb', text: 'Use a fork', kind: 'change' })
  expect(await textsOf(pane)).not.toContain('Revise as suas respostas')
  // Leaving the field records the text as the pick; the card stays on its question until Next.
  await moveRing($, 'nav-back')
  expect(await otherBold(pane, 'q-l2-bbbbbb')).toBe(true)
  expect(await textsOf(pane)).not.toContain('Revise as suas respostas')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Revise as suas respostas')
  await pane.unmount()
})

test('an option pick records the pending Other text first, so the pick stands and no older draft overrides it on Next', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork', kind: 'change' })
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(false)
  expect(await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-A' })).toMatchObject({ props: { variant: 'primary' } })
  await pane.unmount()
})

test('a question that left the board drops its pending Other text: Next records no Other pick for it', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock, writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork', kind: 'change' })
  files.delete(path('q', 'q-l1-aaaaaa'))
  await clock.advance(5000)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l2-bbbbbb')])
  await pane.unmount()
})

test('a tree jump records the pending Other text on the question it leaves', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork', kind: 'change' })
  await pressTreeLink(pane, 'jump', 'q-l2-bbbbbb')
  await pane.press({ key: 'nav-back' })
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  await pane.unmount()
})

test('Other… text that is itself an option word reaches the CLI as one --text=<text> argument, and is stored as typed', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { calls, writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: '--help' })
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await pane.press({ key: 'submit-all' })
  const argv = calls.find(call => call.argv[2] === 'answer')?.argv ?? []
  expect(argv).toContain('--text=--help')
  expect(argv.filter(arg => arg.startsWith('--text'))).toEqual(['--text=--help'])
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'other', text: '--help' })
  await pane.unmount()
})

test('Keep in Other… draws the text on the link and picks it, empties the field, and the card stays; a link click picks it again, Back keeps the pick', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
  // Keep does not move on, and it picks the kept text: the same question stays, the field is empty under its new round.
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect(await textsOf(pane)).not.toContain('Title q-l2-bbbbbb')
  expect(await pane.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa' })).toBeUndefined()
  expect(await pane.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa-1' })).toBeDefined()
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  // The link's click picks Other with the kept text again; the card stays, and Next moves on.
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  await pane.unmount()
})

test('Keep, click, type without Keep, Next, Back: the pick stays the kept label, the field keeps its text, and the button draws the label bold', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, drafts, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'First text' })
  // Enter picked the kept text and the link's click picks it again; Next moves on, and Back returns to question 1,
  // whose field is under its new round.
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  await clock.advance(350)
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa-1', text: 'Second text', kind: 'change' })
  // The harness does not expose the typed text on the Input node; the field is still there under its round key.
  expect(await pane.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa-1' })).toBeDefined()
  // Next leaves the field without Keep: the typed text is not recorded as the pick; the pick and the link are what the
  // person sees and what Submit all sends.
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  const link = JSON.stringify(await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' }))
  expect(link).toContain('C · First text')
  expect(link).not.toContain('Second text')
  // The last draft written is still the click's pick: the blocked Next wrote nothing.
  expect(JSON.parse(drafts[drafts.length - 1] ?? '{}')).toEqual({
    ts: expect.any(Number),
    picks: { 'q-l1-aaaaaa': { key: 'other', text: 'First text' } },
    labels: { 'q-l1-aaaaaa': 'First text' },
  })
  expect(writes).toEqual([])
  await pane.unmount()
})

test('a draft pick whose text is not the kept label is drawn as the label, and Submit all sends the label drawn', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: 100, picks: { 'q-l1-aaaaaa': { key: 'other', text: 'Stale text' } }, labels: { 'q-l1-aaaaaa': 'First text' } }))
  await clock.advance(5000)
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  expect(JSON.stringify(await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' }))).toContain('C · First text')
  expect(await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' })).toMatchObject({ props: { variant: 'primary', label: '✓ C · First text' } })
  await pane.press({ key: 'submit-all' })
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'other', text: 'First text' })
  await pane.unmount()
})

test('blank Enter in Other… changes nothing: the Other pick and its label stay, and the card stays', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
  // The link's click picks the kept text again and the card stays; Next and Back bring question 1 back with the pick.
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa-1', text: '   ' })
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  expect(JSON.stringify(await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' }))).toContain('Use a fork')
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  await pane.unmount()
})

test('Keep draws the link as its letter and the text, picks it, and empties the field under a new round', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: '  Use a fork  ' })
  expect(await labelOf(pane, 'other-q-l1-aaaaaa')).toContain('C · Use a fork')
  expect(await pane.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa' })).toBeUndefined()
  expect(await pane.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa-1' })).toBeDefined()
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  await pane.unmount()
})

test('Keep again replaces the label and the Other pick with the new text, and Keep picks that text too', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { drafts } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa-1', text: 'Use a fork two' })
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  expect(JSON.stringify(await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' }))).toContain('Use a fork two')
  expect(JSON.parse(drafts[drafts.length - 1] ?? '{}')).toMatchObject({
    picks: { 'q-l1-aaaaaa': { key: 'other', text: 'Use a fork two' } },
    labels: { 'q-l1-aaaaaa': 'Use a fork two' },
  })
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  expect(JSON.parse(drafts[drafts.length - 1] ?? '{}')).toMatchObject({ picks: { 'q-l1-aaaaaa': { key: 'other', text: 'Use a fork two' } } })
  await pane.unmount()
})

test('a second window poll applies the kept label from draft.json labels, without a pick', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: 100, picks: {}, labels: { 'q-l1-aaaaaa': 'Use a fork' } }))
  await clock.advance(5000)
  expect(JSON.stringify(await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' }))).toContain('Use a fork')
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(false)
  await pane.unmount()
})

test('the kept label is still drawn after the panel closes and reopens', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { drafts } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
  expect(JSON.parse(drafts[drafts.length - 1] ?? '{}')).toMatchObject({ labels: { 'q-l1-aaaaaa': 'Use a fork' } })
  await pane.unmount()
  const reopened = await mountPane($)
  expect(JSON.stringify(await reopened.find({ type: 'Button', key: 'other-q-l1-aaaaaa' }))).toContain('Use a fork')
  expect(await otherBold(reopened, 'q-l1-aaaaaa')).toBe(true)
  await reopened.unmount()
})

test('the card warns it is not answered until a pick, and a kept label with no pick names the Other letter', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const warnings = async () => (await textsOf(pane)).filter(text => text.startsWith('Ainda não respondida'))
  expect(await warnings()).toEqual(['Ainda não respondida: escolha uma opção.'])
  // A draft that keeps a label without its pick (written by another session) names the Other letter to press.
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: 100, picks: {}, labels: { 'q-l1-aaaaaa': 'Use a fork' } }))
  await clock.advance(5000)
  expect(await warnings()).toEqual([expect.stringMatching(/^Ainda não respondida: aperte [A-Z] para escolher o seu texto\.$/)])
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(await warnings()).toEqual([])
  await pane.unmount()
})

test('the pt lines that name a key tell the person to press it; the review hint keeps its click', () => {
  expect(t('pt', 'card.unansweredKept', { key: 'C' })).toBe('Ainda não respondida: aperte C para escolher o seu texto.')
  expect(t('pt', 'review.hint')).toBe('Clique numa pergunta para mudar a resposta.')
})

test('a Submit all whose reply fails keeps the pick and says it is not delivered, until a later submit delivers it', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = { answerExit: 1 }
  stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const notDelivered = async () => (await textsOf(pane)).filter(text => text.startsWith('Ainda não entregue'))
  const variantOf = async (key: string): Promise<unknown> => (await pane.find({ type: 'Button', key }))?.props.variant
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(await notDelivered()).toEqual([])
  await pane.press({ key: 'submit-all' })
  expect(await notDelivered()).toEqual(['Ainda não entregue: aperte Enviar tudo de novo.'])
  expect(await variantOf('opt-q-l1-aaaaaa-B')).toBe('primary')
  holds.answerExit = undefined
  await pane.press({ key: 'submit-all' })
  expect(await notDelivered()).toEqual([])
  expect(files.has(path('a', 'q-l1-aaaaaa'))).toBe(true)
  await pane.unmount()
})

test('draft.json has no labels key while no Other text is kept, and writes the label and the Other pick once one is kept', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { drafts, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(JSON.parse(drafts[0] ?? '{}')).toEqual({ ts: expect.any(Number), picks: { 'q-l1-aaaaaa': { key: 'B' } } })
  await clock.advance(350)
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
  // Keep picks the kept text, which replaces the option pick: the label and the Other pick are written together.
  expect(JSON.parse(drafts[drafts.length - 1] ?? '{}')).toEqual({
    ts: expect.any(Number),
    picks: { 'q-l1-aaaaaa': { key: 'other', text: 'Use a fork' } },
    labels: { 'q-l1-aaaaaa': 'Use a fork' },
  })
  await pane.unmount()
})

test('the move lock dims option, Other, Next and Back for 350 ms after a move, presses do nothing then, and they work after the window', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
  // A pick is a move: it locks the moves for 350 ms, and the card stays on its question.
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  for (const key of ['opt-q-l1-aaaaaa-B', 'other-q-l1-aaaaaa', 'nav-next']) {
    expect((await pane.find({ type: 'Button', key }))?.props.dimColor).toBe(true)
  }
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect((await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).not.toBe('primary')
  await clock.advance(350)
  expect((await pane.find({ type: 'Button', key: 'nav-next' }))?.props.dimColor).toBe(false)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  // Back works once the window has lifted; its move locks the links on question 1 again.
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect((await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' }))?.props.dimColor).toBe(true)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(false)
  await clock.advance(350)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l3-cccccc')
  await pane.unmount()
})

test('the card names the question on screen; a pick keeps the card on it, Next moves on, and Back returns to it with the pick kept', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect((await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).toBe('primary')
  await pane.unmount()
})

test('on the last question of a group of two, Next stays and opens the review, where Submit all (n) waits for every pick', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await labelOf(pane, 'nav-next')).toBe('Sem resposta · Próxima → (x)')
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  expect(await labelOf(pane, 'nav-next')).toBe('Sem resposta · Próxima → (x)')
  expect(await pane.find({ type: 'Button', key: 'submit-all' })).toBeUndefined()
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Revise as suas respostas')
  expect(await labelOf(pane, 'submit-all')).toBe('Enviar tudo (2) (w)')
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(true)
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  await pane.unmount()
})

test('a question with no title is named in the tree and on the card by its text, cut to 24 characters; a title is never cut', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { title: '', question: 'Cache it on the disk now!' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { title: '   ', question: 'Cache it on the disk now' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { title: 'Ship the retry policy before Friday', question: 'Ship it?' })],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // 25 characters: the first 23 and an ellipsis, 24 in all. The tree row carries the mark in front of it.
  expect(await textsOf(pane)).toContain('Cache it on the disk now!')
  expect(await textsOf(pane)).toContain('● Cache it on the disk now!')
  await pane.press({ key: 'nav-next' })
  // 24 characters and a blank title: the text is whole.
  expect(await textsOf(pane)).toContain('Cache it on the disk now')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Ship the retry policy before Friday')
  await pane.unmount()
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
  const pane = await mountPane($)
  await clock.advance(5000)
  // The first poll settles the clock and the board; from here on three polls find nothing new.
  const settledWrites = stateWrites.length
  await clock.advance(5000)
  await clock.advance(5000)
  await clock.advance(5000)
  expect(stateWrites.slice(settledWrites)).toEqual([])
  expect(await pane.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' })).toBeDefined()
  await pane.unmount()
})

test('an Other… answer keeps its link bold, with no echo of the typed text under it, also after going back', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
  // Keep picked the text: the link is the chosen primary button, bold, with its label and no echo of the text.
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect(await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' })).toMatchObject({ props: { variant: 'primary', label: '✓ C · Use a fork' } })
  expect(await otherBold(pane, 'q-l1-aaaaaa')).toBe(true)
  expect(await textsOf(pane)).not.toContain('Use a fork')
  await pane.unmount()
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
  const pane = await mountPane($)
  await clock.advance(60_000)
  expect(await pane.find({ type: 'Markdown', text: /· há 1 min$/ })).toBeDefined()
  const ticksBefore = stateWrites.filter(key => key === 'tick').length
  await clock.advance(30_000)
  expect(await pane.find({ type: 'Markdown', text: /· há 2 min$/ })).toBeDefined()
  expect(stateWrites.filter(key => key === 'tick').length - ticksBefore).toBe(1)
  await pane.unmount()
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
  expect(submits).toEqual(['Answered via panel by "unknown": B · "Rewrite". Askaway question q-l1-aaaaaa ("Title q-l1-aaaaaa"). (you were using A · "Keep")'])
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
    'Answered via panel by "unknown": B · "Rewrite". Askaway question q-l1-aaaaaa ("Title q-l1-aaaaaa"). (you were using A · "Keep")\n' +
      'Answered via panel by "unknown": A · "Keep". Askaway question q-l2-bbbbbb ("Title q-l2-bbbbbb").',
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
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Cache layer')
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Retry policy')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Log level')
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  expect(await textsOf(pane)).toContain('Retry policy')
  await pane.unmount()
})

test('a pick keeps the card on its question and draws no arrival line, on the card or after Next', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { title: 'Cache layer' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { title: 'Retry policy' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { title: 'Log level' })],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // The arrival line is gone: no text of the card starts with it, before or after a pick and past its old 1.5 s window.
  const arrival = async () => (await textsOf(pane)).filter(text => text.startsWith('✓ Escolha anterior guardada'))
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(await textsOf(pane)).toContain('Cache layer')
  expect(await arrival()).toEqual([])
  await clock.advance(1500)
  expect(await arrival()).toEqual([])
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Retry policy')
  expect(await arrival()).toEqual([])
  await pane.unmount()
})

test('on the last question Submit all is dim until every question has a pick; the pick that completes them shows the review, Submit all primary', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const submit = () => pane.find({ type: 'Button', key: 'submit-all' })
  const rows = async () => (await textsOf(pane)).filter(text => /^\S+ \d\. /.test(text))
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l3-cccccc')
  // Next on the last question opens the review even with no pick: every row reads "Sem resposta", and Submit all is dim.
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Revise as suas respostas')
  expect(await rows()).toEqual([
    expect.stringMatching(/1\. Title q-l1-aaaaaa → Sem resposta/),
    expect.stringMatching(/2\. Title q-l2-bbbbbb → Sem resposta/),
    expect.stringMatching(/3\. Title q-l3-cccccc → Sem resposta/),
  ])
  expect((await submit())?.props.dimColor).toBe(true)
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  // A jump to the last card and a pick there: the review still has gaps, so Submit all stays dim.
  await clock.advance(350)
  await pressTreeLink(pane, 'jump', 'q-l3-cccccc')
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l3-cccccc-B' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Revise as suas respostas')
  expect(await rows()).toEqual([
    expect.stringMatching(/1\. Title q-l1-aaaaaa → Sem resposta/),
    expect.stringMatching(/2\. Title q-l2-bbbbbb → Sem resposta/),
    expect.stringMatching(/3\. Title q-l3-cccccc → Rewrite/),
  ])
  expect((await submit())?.props.dimColor).toBe(true)
  // The gaps filled from the cards: the review's rows follow, and Submit all turns primary.
  await clock.advance(350)
  await pressTreeLink(pane, 'jump', 'q-l1-aaaaaa')
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Revise as suas respostas')
  expect((await submit())?.props.variant).toBe('primary')
  expect((await submit())?.props.dimColor).toBe(false)
  expect(writes).toEqual([])
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb'), path('a', 'q-l3-cccccc')])
  await pane.unmount()
})

test('a pick draws no arrival line, and the card\'s Next names the answer it has: "Resposta: B · Próxima →"', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { title: 'Cache layer' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { title: 'Retry policy' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await labelOf(pane, 'nav-next')).toBe('Sem resposta · Próxima → (x)')
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect((await textsOf(pane)).some(text => text.startsWith('✓ Escolha anterior guardada'))).toBe(false)
  expect(await labelOf(pane, 'nav-next')).toBe('Resposta: B · Próxima → (x)')
  await pane.unmount()
})

test('Next on the last question shows the review: each answer links to its card, Back returns to the last card, and Submit all sends', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { title: 'Cache layer' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { title: 'Retry policy' })],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const rows = async () => (await textsOf(pane)).filter(text => /^\S+ \d\. /.test(text))
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  // The pick keeps the card on its question: the review waits for Next.
  expect(await textsOf(pane)).not.toContain('Revise as suas respostas')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Revise as suas respostas')
  expect(await rows()).toEqual([expect.stringMatching(/1\. Cache layer → Rewrite/), expect.stringMatching(/2\. Retry policy → Keep/)])
  // A row jumps to its card; changing the pick there and walking back with Next brings the review back with the new answer.
  await pane.press({ key: 'review-jump-q-l1-aaaaaa', link: { href: 'file:///askaway/jump/q-l1-aaaaaa' } })
  expect(await textsOf(pane)).toContain('Cache layer')
  expect(await textsOf(pane)).not.toContain('Revise as suas respostas')
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await rows()).toEqual([expect.stringMatching(/1\. Cache layer → Keep/), expect.stringMatching(/2\. Retry policy → Keep/)])
  // Back leaves the review for the last card, which keeps its own answer. The move lock lifts before the next press.
  await clock.advance(350)
  await pane.press({ key: 'review-back' })
  expect(await textsOf(pane)).toContain('Retry policy')
  expect(await textsOf(pane)).not.toContain('Revise as suas respostas')
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-B' })
  expect(writes).toEqual([])
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  expect(readJson(files, path('a', 'q-l2-bbbbbb'))).toMatchObject({ key: 'B' })
  await pane.unmount()
})

test('a one-question group drawn after a submitted two-question group shows no review: the review is reset with the group sent', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Revise as suas respostas')
  await pane.press({ key: 'submit-all' })
  files.set(path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { project: '/work/other' }))
  await clock.advance(5000)
  await pane.press({ key: 'opt-q-l3-cccccc-A' })
  expect(await textsOf(pane)).toContain('Title q-l3-cccccc')
  expect(await textsOf(pane)).not.toContain('Revise as suas respostas')
  await pane.unmount()
})

test('Back on the review is under the move lock: dim and no-op for 350 ms after the pick that drew it, then it leaves the review', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Revise as suas respostas')
  expect((await pane.find({ type: 'Button', key: 'review-back' }))?.props.dimColor).toBe(true)
  await pane.press({ key: 'review-back' })
  expect(await textsOf(pane)).toContain('Revise as suas respostas')
  await clock.advance(350)
  expect((await pane.find({ type: 'Button', key: 'review-back' }))?.props.dimColor).toBe(false)
  await pane.press({ key: 'review-back' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  expect(await textsOf(pane)).not.toContain('Revise as suas respostas')
  await pane.unmount()
})

test('the review Back carries the card Back hotkey and label: z and "← Voltar (z)" on the terminal, the same letter as the card', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect((await pane.find({ type: 'Button', key: 'review-back' }))?.props.hotkey).toBe('z')
  // The review's Back names the answer of the card it leads to, first; the letter is the same as the card's.
  expect(await labelOf(pane, 'review-back')).toBe('Resposta: A · ← Voltar (z)')
  await clock.advance(350)
  await pane.press({ key: 'review-back' })
  expect((await pane.find({ type: 'Button', key: 'nav-back' }))?.props.hotkey).toBe('z')
  await pane.unmount()
})

test('a pick, Next and a tree jump draw no arrival line, and the card stays on the question it moves to', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // The arrival line is gone, so no card draws one: no text starts with its words after any move.
  const arrival = async () => (await textsOf(pane)).filter(text => text.startsWith('✓ Escolha anterior guardada'))
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(await arrival()).toEqual([])
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  expect(await arrival()).toEqual([])
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-B' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  expect(await arrival()).toEqual([])
  await pressTreeLink(pane, 'jump', 'q-l1-aaaaaa')
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect(await arrival()).toEqual([])
  await pane.unmount()
})

test('the unanswered row is always drawn: the card keeps its rows and its title row as a pick comes and goes', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // The rows the card of a question lays out, by type, in order: the card's own rows, so the tree above it does not count.
  const rowsOf = async (id: string) =>
    ((nodesOf(await pane.drawn()).find(node => keyOfNode(node) === `card-${id}`)?.children ?? []) as Record<string, unknown>[]).map(
      row => row.type,
    )
  const before = await rowsOf('q-l1-aaaaaa')
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect(await rowsOf('q-l1-aaaaaa')).toEqual(before)
  await clock.advance(1500)
  expect(await rowsOf('q-l1-aaaaaa')).toEqual(before)
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  expect(await rowsOf('q-l2-bbbbbb')).toEqual(before)
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  expect(await rowsOf('q-l2-bbbbbb')).toEqual(before)
  await pane.unmount()
})

test('a window of one question has no Back or Next: the pick writes nothing, and Submit all writes its one answer', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', key: 'nav-next' })).toBeUndefined()
  expect((await pane.find({ type: 'Button', key: 'nav-back' }))?.props.dimColor).toBe(true)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect(writes).toEqual([])
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', key: 'A', by: 'panel' })
  await pane.unmount()
})

// A press the hook refuses ends the fade it started at once: the card is not left dimmed while nothing was written.
test('a reply the CLI refuses ends the card fade at once', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = {}
  const { writes } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  holds.answerExit = 1
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  expect((await pane.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' }))?.props.dimColor).not.toBe(true)
  await pane.unmount()
})

test('a reply refused by a failed ended check ends the card fade at once', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const holds: Holds = {}
  const { writes } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  holds.listExit = 1
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  expect((await pane.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' }))?.props.dimColor).not.toBe(true)
  await pane.unmount()
})

test('a reply refused because its session ended ends the card fade at once', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const { ended, writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  ended.add('q-l1-aaaaaa')
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  expect((await pane.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' }))?.props.dimColor).not.toBe(true)
  await pane.unmount()
})

test('a reply the CLI keeps from an earlier one ends the card fade at once', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  // Another writer answers after the poll: the CLI keeps the first reply and reports written false.
  files.set(path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B'))
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  expect((await pane.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' }))?.props.dimColor).not.toBe(true)
  await pane.unmount()
})

test('an answered card stays dimmed while its reply is written, and leaves once the write lands', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = {}
  const { writes, clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  const write = gate()
  holds.write = write.promise
  const pressed = pane.press({ key: 'submit-all' })
  await clock.settle()
  // No timer ends the fade while the write is pending, however long it takes.
  await clock.advance(1000)
  expect(writes).toEqual([])
  expect((await pane.find({ type: 'Box', key: 'card-q-l1-aaaaaa' }))?.props.borderDimColor).toBe(true)
  write.open()
  await pressed
  await clock.settle()
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(await pane.find({ type: 'Box', key: 'card-q-l1-aaaaaa' })).toBeUndefined()
  expect(await textsOf(pane)).toContain('Nenhuma pendente')
  await pane.unmount()
})

test('a reply that fails to write undims its card once the write fails, and the failure is toasted', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = {}
  const { toasts, writes, clock } = stubHost(on, files, true, {}, holds, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  const write = gate()
  holds.write = write.promise
  holds.answerExit = 1
  const pressed = pane.press({ key: 'submit-all' })
  await clock.settle()
  await clock.advance(1000)
  expect((await pane.find({ type: 'Box', key: 'card-q-l1-aaaaaa' }))?.props.borderDimColor).toBe(true)
  write.open()
  await pressed
  await clock.settle()
  expect(writes).toEqual([])
  expect((await pane.find({ type: 'Box', key: 'card-q-l1-aaaaaa' }))?.props.borderDimColor).not.toBe(true)
  expect(await pane.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' })).toBeDefined()
  expect(toasts).toEqual(['Could not send your reply; the question is still open.'])
  await pane.unmount()
})

test('Submit all of a window writes each answer once its reply is written, then the window is answered', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const holds: Holds = {}
  const { writes, clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // Next moves to the second question, the last: Next there opens the review, where Submit all writes the window.
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  const write = gate()
  holds.write = write.promise
  const pressed = pane.press({ key: 'submit-all' })
  await clock.settle()
  expect(writes).toEqual([])
  write.open()
  await pressed
  await clock.settle()
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'B' })
  expect(readJson(files, path('a', 'q-l2-bbbbbb'))).toMatchObject({ key: 'A' })
  expect(await textsOf(pane)).toContain('Nenhuma pendente')
  await pane.unmount()
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
  const pane = await mountPane($)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  files.set(path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', 500))
  files.set(path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'B', 500))
  await clock.advance(5000)
  const texts = await textsOf(pane)
  // The app group is gone, so the web group is on screen at its first question, not at the step the app group had.
  expect(texts).toContain('Which way for q-l3-cccccc?')
  expect(texts).not.toContain('Which way for q-l4-dddddd?')
  await pane.unmount()
})

test('hotkeys: each option its key letter, Other the next letter c, then z, x and w on the terminal and p, f and w on the desktop; the hotkeys stay while the Other field holds text', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const hotkeyOf = async (key: string): Promise<unknown> => (await pane.find({ type: 'Button', key }))?.props.hotkey
  expect(await hotkeyOf('opt-q-l1-aaaaaa-A')).toBe('a')
  expect(await hotkeyOf('opt-q-l1-aaaaaa-B')).toBe('b')
  expect(await hotkeyOf('other-q-l1-aaaaaa')).toBe('c')
  expect(await hotkeyOf('nav-back')).toBe('z')
  expect(await hotkeyOf('nav-next')).toBe('x')
  await pane.press({ key: 'nav-next' })
  expect(await hotkeyOf('nav-next')).toBe('x')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await hotkeyOf('submit-all')).toBe('w')
  await clock.advance(350)
  await pane.press({ key: 'review-back' })
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  // The Other link only focuses its field, and typing reaches the field alone while it has focus: no hotkey is gated on
  // the field, so the letters stay drawn, also once Enter has recorded its text.
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  expect(await hotkeyOf('opt-q-l1-aaaaaa-A')).toBe('a')
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'o' })
  expect(await hotkeyOf('opt-q-l1-aaaaaa-A')).toBe('a')
  expect(await hotkeyOf('other-q-l1-aaaaaa')).toBe('c')
  await pane.unmount()
  // The desktop takes p and f for Back and Next: none of them is an option key of this question (A or B), so no shortcut
  // clashes with another. Options take their letters on the desktop too.
  const desk = await mountPane($, 'desktop')
  const deskHotkey = async (key: string): Promise<unknown> => (await desk.find({ type: 'Button', key }))?.props.hotkey
  expect(await deskHotkey('opt-q-l1-aaaaaa-A')).toBe('a')
  expect(await deskHotkey('other-q-l1-aaaaaa')).toBe('c')
  expect(await deskHotkey('nav-back')).toBe('p')
  expect(await deskHotkey('nav-next')).toBe('f')
  await clock.advance(350)
  await desk.press({ key: 'nav-next' })
  await clock.advance(350)
  await desk.press({ key: 'nav-next' })
  expect(await deskHotkey('submit-all')).toBe('w')
  await clock.advance(350)
  await desk.press({ key: 'review-back' })
  await clock.advance(350)
  await desk.press({ key: 'nav-back' })
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
  const pane = await mountPane($)
  const optionButtons = (await pane.findAll({ type: 'Button' })).filter(button => String(button.props.label).includes(' · '))
  expect(optionButtons[0]?.props.label).toBe('B · Rewrite (Recomendada)')
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-A')).toBe('A · Keep')
  expect(await pane.find({ type: 'Text', text: 'B · Rewrite (Recomendada)' })).toMatchObject({ props: { bold: true } })
  const hotkeyOf = async (key: string): Promise<unknown> => (await pane.find({ type: 'Button', key }))?.props.hotkey
  expect(await hotkeyOf('opt-q-l1-aaaaaa-B')).toBe('b')
  expect(await hotkeyOf('opt-q-l1-aaaaaa-A')).toBe('a')
  const buttonWithHotkey = nodesOf(await pane.drawn()).find(
    node => node.type === 'Button' && (node.props as Record<string, unknown>).hotkey === 'a',
  )
  expect(buttonWithHotkey).toBeDefined()
  await pane.press({ key: String(keyOfNode(buttonWithHotkey ?? {})) })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', key: 'A', by: 'panel' })
  await pane.unmount()
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
  const pane = await mountPane($)
  const drawn = nodesOf(await pane.drawn())
  const propsOf = (node: Record<string, unknown>): Record<string, unknown> => (node.props ?? {}) as Record<string, unknown>
  const textOf = (node: Record<string, unknown>): string =>
    (Array.isArray(node.children) ? node.children : []).filter((child): child is string => typeof child === 'string').join('')
  // A history row is the one Text that starts with the ○ and a title; the open tree's rows are Markdown links.
  const statusAt = drawn.flatMap((node, index) => (node.type === 'Text' && textOf(node).startsWith('○ Title ') ? [index] : []))
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
  await pane.unmount()
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

test('a tree row reads its title in the current language: the pt-BR title in Portuguese, the main title in English', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1', session_title: 'monta a consulta' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 3000, {
      session: 's1',
      session_title: 'monta a consulta',
      title: 'Store cache',
      translations: { 'pt-BR': { title: 'Cache em disco' } },
    })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('○ Cache em disco')
  await run($, 'lang en')
  const english = await textsOf(pane)
  expect(english).toContain('○ Store cache')
  expect(english).not.toContain('○ Cache em disco')
  await pane.unmount()
})

test('the tree draws the group row in bold, each session with ├ or └, and one mark per question', async ($, on) => {
  stubHost(on, treeFiles())
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const texts = await textsOf(pane)
  // Two sessions of one project are one group: one group row, and no Button for a group.
  expect(texts.filter(text => text === 'App')).toHaveLength(1)
  expect(await pane.find({ type: 'Text', text: 'App' })).toMatchObject({ props: { bold: true } })
  expect(nodesOf(await pane.drawn()).filter(node => node.type === 'Button' && String(keyOfNode(node) ?? '').startsWith('group-'))).toHaveLength(0)
  // pt-BR minor words stay lowercase after the first word: "a" is one.
  expect(texts).toContain('├ Monta a Consulta')
  expect(texts).toContain('└ a sessão')
  // The question on screen is ● and bold; the others are ○.
  expect((await pane.find({ type: 'Markdown', key: 'tree-jump-q-l1-aaaaaa' }))?.props.text).toBe('│  ● **[Title q-l1-aaaaaa](file:///askaway/jump/q-l1-aaaaaa)**')
  expect(texts).toContain('│  ○ Title q-l2-bbbbbb')
  expect(texts).toContain('○ Title q-l3-cccccc')
  await pane.unmount()
})

test('a pick keeps the ● on its question, and the picked row shows its check, " - " and its own Submit', async ($, on) => {
  stubHost(on, treeFiles())
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  const texts = await textsOf(pane)
  expect(texts).toContain('│  ● Title q-l1-aaaaaa')
  expect(texts).toContain(' ✓ - ')
  expect(texts.indexOf(' ✓ - ')).toBeGreaterThan(texts.indexOf('│  ● Title q-l1-aaaaaa'))
  expect(texts).toContain('│  ○ Title q-l2-bbbbbb')
  expect(texts).not.toContain('│  ● Title q-l2-bbbbbb')
  expect((await pane.find({ type: 'Markdown', key: 'tree-jump-q-l1-aaaaaa' }))?.props.text).toBe('│  ● **[Title q-l1-aaaaaa](file:///askaway/jump/q-l1-aaaaaa)**')
  // Only the picked row has its own Submit.
  // The question row and its Submit are links the plugin answers, and only their own hrefs.
  expect(await pane.find({ type: 'Markdown', key: 'tree-jump-q-l1-aaaaaa' })).toMatchObject({ props: { pressableLinks: ['file:///askaway/jump/q-l1-aaaaaa'] } })
  expect(await pane.find({ type: 'Markdown', key: 'tree-submit-q-l2-bbbbbb' })).toBeUndefined()
  // The row's own Submit reads "Enviar resposta" in pt-BR ("Submit Answer" in English), never a bare Submit.
  expect((await pane.find({ type: 'Markdown', key: 'tree-submit-q-l1-aaaaaa' }))?.props.text).toBe('▪ [Enviar resposta](file:///askaway/submit/q-l1-aaaaaa)')
  await pane.unmount()
})

test('a row Submit answers that question alone and removes its row; the other picks wait for Submit all', async ($, on) => {
  const { writes, clock } = stubHost(on, treeFiles())
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  expect(writes).toEqual([])
  await pressTreeLink(pane, 'submit', 'q-l1-aaaaaa')
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  await clock.advance(250)
  expect(await pane.find({ type: 'Markdown', key: 'tree-jump-q-l1-aaaaaa' })).toBeUndefined()
  // The second question keeps its pick and its own Submit.
  expect(await pane.find({ type: 'Markdown', key: 'tree-submit-q-l2-bbbbbb' })).toBeDefined()
  await clock.advance(350)
  // Submit all still answers the rest of the group: Next on its last question opens the review, which holds it. The row
  // Submit took q1 out, so the tree lists q3's session first: the group is q3 then q2, and q2 is the last question.
  await pressTreeLink(pane, 'jump', 'q-l3-cccccc')
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l3-cccccc-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await pane.press({ key: 'submit-all' })
  // Each answer is written once; the order of the rest follows the group, so the three are compared as a set.
  expect(writes[0]).toBe(path('a', 'q-l1-aaaaaa'))
  expect([...writes].sort()).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb'), path('a', 'q-l3-cccccc')])
  await pane.unmount()
})

test('a question row under the last session is indented 4, and one under another session 1, so the marks share a column', async ($, on) => {
  stubHost(on, treeFiles())
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect((await pane.find({ type: 'Box', key: 'tree-q-l3-cccccc' }))?.props.paddingLeft).toBe(4)
  expect((await pane.find({ type: 'Box', key: 'tree-q-l1-aaaaaa' }))?.props.paddingLeft).toBe(1)
  await pane.unmount()
})

test('a question row of the tree is a link: its press puts that question on the card, with no details toggle', async ($, on) => {
  // q-l3 has its details block drawn (Why) and no toggle; its row press puts the card on screen.
  const files = treeFiles()
  files.set(path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 2000, { session: 's2', why: 'Reason R' }))
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Markdown', key: 'tree-jump-q-l3-cccccc' })).toMatchObject({ props: { pressableLinks: ['file:///askaway/jump/q-l3-cccccc'] } })
  await pressTreeLink(pane, 'jump', 'q-l3-cccccc')
  // The card is now the question of the row, bold in the tree, and the first question's card is gone.
  const texts = await textsOf(pane)
  expect(texts).toContain('Which way for q-l3-cccccc?')
  expect(texts).not.toContain('Which way for q-l1-aaaaaa?')
  expect((await pane.find({ type: 'Markdown', key: 'tree-jump-q-l3-cccccc' }))?.props.text).toBe('● **[Title q-l3-cccccc](file:///askaway/jump/q-l3-cccccc)**')
  expect(await pane.find({ type: 'Button', key: 'details-q-l3-cccccc' })).toBeUndefined()
  await pane.unmount()
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
  const pane = {
    Box: fakeElement('Box'),
    Text: fakeElement('Text'),
    Button: fakeElement('Button'),
    ...(options.markdown ? { Markdown: fakeElement('Markdown') } : {}),
  }
  const tree = {
    ui: pane,
    lang: 'en',
    view: { screen: undefined, wizard: { picks: {} } },
    actions: { jump: (id: string) => options.onJump?.(id), submitOne: () => undefined },
    held: heldButtons(),
  }
  const question = options.question ?? parsedQuestion('q-l1-aaaaaa', 1000)
  return renderTreeQuestion(tree as never, question, placeUnder(options.isFinal)) as unknown as FakeElement
}

test('on a surface that draws Markdown, a tree row is a Markdown link: its lead, its state mark and the file: link, and its press runs the jump', () => {
  const jumped: string[] = []
  const [link] = childrenOf(fakeRow({ markdown: true, isFinal: false, onJump: id => jumped.push(id) }))
  expect(link?.tag).toBe('Markdown')
  expect(link?.props.key).toBe('tree-jump-q-l1-aaaaaa')
  expect(link?.props.text).toBe(`│  ○ [Title q-l1-aaaaaa](file:///askaway/jump/q-l1-aaaaaa)`)
  expect(link?.props.pressableLinks).toEqual(['file:///askaway/jump/q-l1-aaaaaa'])
  const press = link?.props.onLinkPress as () => void
  press()
  expect(jumped).toEqual(['q-l1-aaaaaa'])
})

test('a title that writes markdown is escaped in its link, so it draws no link or autolink of its own', () => {
  const question = parsedQuestion('q-l1-aaaaaa', 1000, { title: 'See [docs](https://evil.example)' })
  const [link] = childrenOf(fakeRow({ markdown: true, isFinal: true, question }))
  expect(link?.props.text).toBe(`○ [See \\[docs\\]\\(https\\://evil\\.example\\)](file:///askaway/jump/q-l1-aaaaaa)`)
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
    const pane = await mountPane($, surface)
    expect(await pane.find({ type: 'Markdown', key: 'tree-jump-q-l1-aaaaaa' })).toMatchObject({ props: { pressableLinks: ['file:///askaway/jump/q-l1-aaaaaa'] } })
    expect(await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' })).toBeDefined()
    expect(nodesOf(await pane.drawn()).some(node => node.type === 'Text' && Array.isArray(node.children) && node.children.includes(`${LINK_MARK} `))).toBe(true)
    await pane.unmount()
  }
})

test('a question of another project is pressable too: its press switches the group on screen and its card', async ($, on) => {
  const files = treeFiles()
  files.set(path('q', 'q-o1-eeeeee'), question('q-o1-eeeeee', 4000, { project: '/work/other' }))
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Which way for q-l1-aaaaaa?')
  await pressTreeLink(pane, 'jump', 'q-o1-eeeeee')
  const texts = await textsOf(pane)
  expect(texts).toContain('Which way for q-o1-eeeeee?')
  expect(texts).not.toContain('Which way for q-l1-aaaaaa?')
  // Walking back with Back stays inside the other project: its first question is the only one it has.
  await pane.unmount()
})

test('the step walks the group session by session, as the tree lists it, not by time', async ($, on) => {
  const { clock } = stubHost(on, treeFiles())
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  // q2 (ts 3000) is the second question of s1, so it comes before q3 (ts 2000) of s2.
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Title q-l3-cccccc')
  await pane.unmount()
})

test('a question that arrives earlier in the tree keeps the card on its question', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's2' })],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Which way for q-l2-bbbbbb?')
  // q3 (ts 3000) joins session s1, so the tree order becomes q1, q3, q2: the card stays on q2.
  files.set(path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { session: 's1' }))
  await clock.advance(5000)
  const texts = await textsOf(pane)
  expect(texts).toContain('Which way for q-l2-bbbbbb?')
  expect(texts).not.toContain('Which way for q-l3-cccccc?')
  await pane.unmount()
})

test('a question answered elsewhere before the card keeps the card on its question', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's2' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { session: 's3' })],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Which way for q-l2-bbbbbb?')
  // q1 is answered elsewhere: q2 moves to the first place of the group, and the card stays on it (not on q3).
  files.set(path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', 500))
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Which way for q-l2-bbbbbb?')
  await pane.unmount()
})

test('the Other field stays open on its own question across a shift', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's2' })],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'nav-next' })
  await pane.press({ key: 'other-q-l2-bbbbbb' })
  expect(await pane.find({ type: 'Input', key: 'other-input-q-l2-bbbbbb' })).toBeDefined()
  files.set(path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { session: 's1' }))
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Which way for q-l2-bbbbbb?')
  expect(await pane.find({ type: 'Input', key: 'other-input-q-l2-bbbbbb' })).toBeDefined()
  await pane.unmount()
})

test('every open group is drawn in turn, one under the other, with its label as a Text and no Button', async ($, on) => {
  const files = treeFiles()
  files.set(path('q', 'q-l4-dddddd'), question('q-l4-dddddd', 4000, { project: '/work/web' }))
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const nodes = nodesOf(await pane.drawn())
  const boxAt = (key: string): number => nodes.findIndex(node => keyOfNode(node) === key)
  expect(boxAt('group-/work/app')).toBeGreaterThan(-1)
  expect(boxAt('group-/work/web')).toBeGreaterThan(boxAt('group-/work/app'))
  expect(nodes.filter(node => node.type === 'Button' && String(keyOfNode(node) ?? '').startsWith('group-'))).toHaveLength(0)
  const texts = await textsOf(pane)
  // The app group's last question comes before the web label, and the web group's question comes after it.
  expect(texts.indexOf('○ Title q-l3-cccccc')).toBeLessThan(texts.indexOf('Web'))
  expect(texts.indexOf('App')).toBeLessThan(texts.indexOf('Web'))
  expect(texts).toContain('○ Title q-l4-dddddd')
  await pane.unmount()
})

test('the group on screen and the other group label are both bold, with no colour', async ($, on) => {
  const files = treeFiles()
  files.set(path('q', 'q-l4-dddddd'), question('q-l4-dddddd', 4000, { project: '/work/web' }))
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const app = await pane.find({ type: 'Text', text: 'App' })
  expect(app).toMatchObject({ props: { bold: true } })
  expect(app?.props.color).toBeUndefined()
  const web = await pane.find({ type: 'Text', text: 'Web' })
  expect(web).toMatchObject({ props: { bold: true } })
  expect(web?.props.color).toBeUndefined()
  await pane.unmount()
})

test('two projects with the same folder name stay apart: two groups in turn, each labelled App, both bold with no colour', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { project: '/a/app' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { project: '/b/app' })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const labels = nodesOf(await pane.drawn()).filter(node => node.type === 'Text' && Array.isArray(node.children) && node.children.includes('App'))
  expect(labels.map(node => (node.props as Record<string, unknown>).color)).toEqual([undefined, undefined])
  expect(labels.map(node => (node.props as Record<string, unknown>).bold)).toEqual([true, true])
  expect(await textsOf(pane)).toContain('Which way for q-l1-aaaaaa?')
  await pane.unmount()
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
  const pane = await mountPane($)
  const labels = nodesOf(await pane.drawn()).filter(node => node.type === 'Text' && Array.isArray(node.children) && node.children.includes('Release Checklist Review'))
  expect(labels.map(node => (node.props as Record<string, unknown>).bold)).toEqual([true])
  expect(await pane.find({ type: 'Text', text: 'Web' })).toBeDefined()
  const texts = await textsOf(pane)
  expect(texts).toContain('├ Root Session')
  expect(texts).toContain('└ Child Session')
  expect(texts).not.toContain('Scratch')
  await pane.unmount()
})

test('the root session of a family (desktop_session equal to family) draws no session row: its questions sit right under the family title, before the derived sessions', async ($, on) => {
  const family = { family: 'local_root', family_title: 'release checklist review' }
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'cli-1', desktop_session: 'local_root', session_title: 'release checklist review', ...family })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 'cli-2', desktop_session: 'local_child', session_title: 'child session', ...family })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { session: 'cli-1', desktop_session: 'local_root', session_title: 'release checklist review', ...family })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const texts = await textsOf(pane)
  // The family title is drawn once, bold; no "├ Release Checklist Review" row repeats it.
  expect(texts.filter(text => text.includes('Release Checklist Review'))).toHaveLength(1)
  expect(texts.some(text => text.startsWith('├ ') || text.startsWith('└ '))).toBe(true)
  expect(texts).toContain('└ Child Session')
  // The root's rows carry no lead and sit before the derived session; the child's row sits under "└", without a lead.
  const rootRow = texts.findIndex(text => text.startsWith('○ Title q-l3-cccccc'))
  expect(rootRow).toBeGreaterThan(texts.indexOf('Release Checklist Review'))
  expect(rootRow).toBeLessThan(texts.indexOf('└ Child Session'))
  expect(texts.indexOf('○ Title q-l2-bbbbbb')).toBeGreaterThan(texts.indexOf('└ Child Session'))
  await pane.unmount()
})

test('beta.35 item 2: a History row on the desktop is plain text: the whole title, the option label and the times, with no session link', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { desktop_session: 'local_abc', title: 'Cache [it] now' })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($, 'desktop')
  expect(await pane.find({ type: 'Markdown', text: /^○ .*\(#local_abc\)/ })).toBeUndefined()
  expect((await textsOf(pane)).some(text => text.startsWith('○ Cache [it] now ✓ Keep · enviada '))).toBe(true)
  // The History heading carries the logo, as the pane heading does, and the whole block gaps its rows from the heading.
  const history = nodesOf(await pane.drawn()).find(node => keyOfNode(node) === 'history')
  expect(history).toBeDefined()
  expect((history?.props as Record<string, unknown> | undefined)?.gap).toBe(1)
  await pane.unmount()
})

test('History: an Other text with Markdown in it never makes a link or a style; a row with no session and no project is not a root row', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { desktop_session: 'local_abc', project: '' })],
    [path('a', 'q-l1-aaaaaa'), JSON.stringify({ id: 'q-l1-aaaaaa', key: 'other', by: 'panel', ts: 1, text: '*x* ](#local_evil)' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($, 'desktop')
  // beta.35: a History row is plain text, so the typed text reads as it was typed and makes no link.
  expect(await pane.find({ type: 'Markdown', text: /\(#local_evil\)/ })).toBeUndefined()
  expect((await textsOf(pane)).some(text => text.startsWith('○ Title q-l1-aaaaaa ✓ “*x* ](#local_evil)” · '))).toBe(true)
  // The group of a question with no project and no family is keyed ''; its session row (null session, key '') still draws, as "└ a sessão".
  const texts = await textsOf(pane)
  expect(texts).toContain('└ a sessão')
  await pane.unmount()
})

test('History: the family label and a derived session row link to their Desktop sessions; the root rows sit under the label; the heading carries the History icon', async ($, on) => {
  const family = { family: 'local_root', family_title: 'release checklist review' }
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'cli-1', desktop_session: 'local_root', session_title: 'release checklist review', ...family })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 'cli-2', desktop_session: 'local_child', session_title: 'child session', ...family })],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'B')],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($, 'desktop')
  const icon = nodesOf(await pane.drawn()).find(node => node.type === 'Svg' && (node.props as Record<string, unknown>).alt === '' && (node.props as Record<string, unknown>).width === 16)
  expect(icon?.props).toMatchObject({ alt: '', width: 16, height: 16 })
  expect(await pane.find({ type: 'Markdown', text: '**[Release Checklist Review](#local_root)**' })).toBeDefined()
  expect(await pane.find({ type: 'Markdown', text: '└ [Child Session](#local_child)' })).toBeDefined()
  // The root's row sits under the family label with no lead; the child's row under its session row.
  expect((await textsOf(pane)).some(text => text.startsWith('○ Title q-l1-aaaaaa ✓ Keep · '))).toBe(true)
  expect((await textsOf(pane)).some(text => text.startsWith('○ Title q-l2-bbbbbb ✓ '))).toBe(true)
  expect(await pane.find({ type: 'Text', text: '├ Release Checklist Review' })).toBeUndefined()
  await pane.unmount()
})

test('History: a record filed before desktop_session existed counts as the root when its session title is its family title', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'cli-1', session_title: 'old root', family: 'local_old', family_title: 'old root' })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($, 'desktop')
  const texts = await textsOf(pane)
  expect(texts.some(text => /^[├└] (\[)?Old Root/.test(text))).toBe(false)
  expect(await pane.find({ type: 'Markdown', text: '**[Old Root](#local_old)**' })).toBeDefined()
  expect(texts.some(text => text.startsWith('○ Title q-l1-aaaaaa ✓ Keep · '))).toBe(true)
  await pane.unmount()
})

test('History: a family id that is not a well-formed Desktop id draws a plain bold label, never a link; a legacy derived session with its own title keeps its row', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'cli-1', session_title: 'odd fam', family: 'local_x) [pay](https://evil.example', family_title: 'odd fam' })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 'cli-2', session_title: 'child session', family: 'local_old', family_title: 'old root' })],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'B')],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($, 'desktop')
  const markdowns = nodesOf(await pane.drawn()).filter(node => node.type === 'Markdown').map(node => String((node.props as Record<string, unknown>).text))
  expect(markdowns.some(text => text.includes('](https://') || text.includes('Odd Fam'))).toBe(false)
  expect(await pane.find({ type: 'Text', text: 'Odd Fam' })).toBeDefined()
  // The legacy derived session (no desktop_session, title unlike the family's) is a "└" row under its family's label.
  expect(await pane.find({ type: 'Markdown', text: '**[Old Root](#local_old)**' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '└ Child Session' })).toBeDefined()
  await pane.unmount()
})

test('History: Clear all touches no state file: the a/ file of a cleared pending reply stays for its session', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'history-clear' })
  expect(files.has(path('a', 'q-l1-aaaaaa'))).toBe(true)
  expect(files.has(path('q', 'q-l1-aaaaaa'))).toBe(true)
  expect(await pane.find({ type: 'Button', key: 'history-clear' })).toBeUndefined()
  await pane.unmount()
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
    const pane = await mountPane($, surface)
    const accentText = nodesOf(await pane.drawn()).filter(node => node.type === 'Text' && (node.props as Record<string, unknown> | undefined)?.color === ACCENT_COLOR)
    expect(accentText.map(node => node.children)).toEqual([])
    await pane.unmount()
  }
})

test('Gauntlet M68: the footer is drawn without dimColor, on the terminal and on the Desktop', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', -ANSWER_TTL_MS + 30_000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    const footer = nodesOf(await pane.drawn()).find(node => node.type === 'Text' && textOfNode(node).includes('nas últimas 24 h'))
    expect(footer).toBeDefined()
    expect((footer?.props as Record<string, unknown> | undefined)?.dimColor).toBeUndefined()
    await pane.unmount()
  }
})

test('Gauntlet M68: every text colour the pane draws measures 4.5:1 or better on both backgrounds', () => {
  const drawn = ['text', ...Object.values(URGENCY_COLOR), 'desktopDim']
  for (const theme of ['light', 'dark'] as const) {
    for (const key of drawn) expect(TEXT_CONTRAST[theme][key]).toBeGreaterThanOrEqual(4.5)
  }
})

// Gauntlet 5 M58: the recorded dim ratios are the measured ones (look.ts names each source). The Desktop's dim is the text colour
// at .6 opacity: #0b0b0b at .6 on #FFFFFF is #6d6d6d (0.6 * 11 + 0.4 * 255 = 108.6), #FFFFFF at .6 on #0b0b0b is #9d9d9d (157.4).
test('Gauntlet 5 M58: the recorded ratios match the WCAG formula on the surfaces they name', () => {
  expect(Math.abs(contrast('#000000', '#FFFFFF') - TEXT_CONTRAST.light.text)).toBeLessThan(0.05)
  expect(Math.abs(contrast('#6d6d6d', '#FFFFFF') - TEXT_CONTRAST.light.desktopDim)).toBeLessThan(0.05)
  expect(Math.abs(contrast('#9d9d9d', '#0b0b0b') - TEXT_CONTRAST.dark.desktopDim)).toBeLessThan(0.05)
  expect(Math.abs(contrast('#666666', '#FFFFFF') - TEXT_CONTRAST.light.inactive)).toBeLessThan(0.05)
  expect(Math.abs(contrast('#999999', '#111827') - TEXT_CONTRAST.dark.inactive)).toBeLessThan(0.05)
})

// Gauntlet 5 M58, reverted on 2026-10-21 (the owner: the dimmed reply text looks bad): an option's sub-rows are plain on both
// surfaces and dim only while the card fades. The lead line and the link mark are dim on both surfaces, as they were; the footer is never dim (M68).
test('option sub-rows are plain on the Desktop and on the terminal; the lead line and link mark are dim on both', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const dimOf = (node: Record<string, unknown> | undefined): unknown => (node?.props as Record<string, unknown> | undefined)?.dimColor
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    const nodes = nodesOf(await pane.drawn())
    const textNode = (fragment: string) => nodes.find(node => node.type === 'Text' && textOfNode(node).includes(fragment))
    expect(dimOf(textNode('Cheap ·'))).toBe(false)
    expect(dimOf(textNode('Pick another option'))).toBe(true)
    expect(dimOf(nodes.find(node => node.type === 'Text' && textOfNode(node) === `${LINK_MARK} `))).toBe(true)
    await pane.unmount()
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
    const { clock } = stubHost(on, files)
    await $.session.start(SESSION)
    const pane = await mountPane($, surface)
    const before = buttonHandles(await pane.drawn())
    expect(Object.keys(before)).toEqual(expect.arrayContaining(['opt-q-l1-aaaaaa-A', 'opt-q-l1-aaaaaa-B', 'nav-back', 'submit-all']))
    for (const handle of Object.values(before)) expect(typeof handle).toBe('number')
    await pane.redraw()
    expect(buttonHandles(await pane.drawn())).toEqual(before)
    await pane.redraw({ ...PANE_PROPS, isFocused: true })
    expect(buttonHandles(await pane.drawn())).toEqual(before)
    await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
    const after = buttonHandles(await pane.drawn())
    expect(after['opt-q-l1-aaaaaa-A']).not.toBe(before['opt-q-l1-aaaaaa-A'])
    // The pick starts the move lock (SPEC, Move lock), which dims every option and nav button, so their handles renew with
    // it. Once the window ends, the handles are stable across a redraw again.
    await clock.advance(350)
    const settled = buttonHandles(await pane.drawn())
    await pane.redraw()
    expect(buttonHandles(await pane.drawn())).toEqual(settled)
    await pane.unmount()
  })
}

test('the card has no n/total counter, no More button, no m hotkey and no JEV text', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const texts = await textsOf(pane)
  expect(texts.some(text => /\b\d+\/\d+\b/.test(text))).toBe(false)
  expect(texts.some(text => text.includes('JEV') || text.startsWith('🔷'))).toBe(false)
  expect(await pane.find({ type: 'Button', key: 'more-q-l1-aaaaaa' })).toBeUndefined()
  const hotkeys = nodesOf(await pane.drawn())
    .filter(node => node.type === 'Button')
    .map(node => (node.props as Record<string, unknown>).hotkey)
  expect(hotkeys).toContain('a')
  expect(hotkeys).not.toContain('m')
  await pane.unmount()
})

test('the details block sits between the first block and the question; the Urgency box follows the question and the options column has gap 2', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { what: 'W', urgency: 'Soon' })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const nodes = nodesOf(await pane.drawn())
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
  await pane.unmount()
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

test('the card draws the first block as two plain paragraphs, then the details block (title, Analogy, Why to Context) before the question, then Urgency and the options with their sub-lines, in pt-BR', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expectInOrder(await textsOf(pane), [
    '⏱️ Urgência: Soon',
    'W',
    'P',
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
  await pane.unmount()
})

test('the section titles are bold and their bodies regular; the details block has no border, the userMessageBackground fill, and its title first, bold beside the mark', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const isBoldText = (node: Record<string, unknown>): boolean =>
    node.type === 'Text' && (node.props as Record<string, unknown> | undefined)?.bold === true
  const childrenOf = (node: Record<string, unknown>): string[] =>
    Array.isArray(node.children) ? node.children.filter((child): child is string => typeof child === 'string') : []
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    const nodes = nodesOf(await pane.drawn())
    const block = nodes.find(node => keyOfNode(node) === 'details-q-l1-aaaaaa')
    const inBlock = nodesOf(block)
    expect(block?.props).not.toHaveProperty('borderStyle')
    expect(block?.props).toMatchObject({ backgroundColor: 'userMessageBackground' })
    expect(inBlock.some(node => isBoldText(node) && childrenOf(node).includes('Detalhes do Askaway:'))).toBe(true)
    // The title row is the block's first child; its mark is the Askaway SVG on the desktop and the glyph on the terminal.
    const firstChild = Array.isArray(block?.children) ? block.children[0] : undefined
    expect(keyOfNode(firstChild as Record<string, unknown>)).toBe('details-title')
    expect(inBlock.some(node => node.type === 'Svg' && (node.props as Record<string, unknown>).alt === 'Askaway')).toBe(surface === 'desktop')
    expect(inBlock.some(node => node.type === 'Text' && childrenOf(node).includes('?'))).toBe(surface === 'terminal')
    // Each section title is a bold run; its body, drawn in the same line, is not bold.
    const boldRuns = nodes.filter(isBoldText).flatMap(childrenOf)
    for (const heading of ['🔁 Analogia', '💡 Por que A', '↩️ Como desfazer', '🛠️ Como', '🎁 O que ganhamos', '⚖️ O que perdemos', '🧭 Contexto e origem', '⏱️ Urgência']) {
      expect(boldRuns).toContain(`${heading}: `)
    }
    expect(boldRuns).toContain('Which way for q-l1-aaaaaa?')
    expect((await pane.find({ type: 'Text', text: '🔁 Analogia: An' }))?.props.bold).not.toBe(true)
    await pane.unmount()
  }
})

test('the card draws the same order in English: the details block with its title, the question, then the option sub-lines under each link line', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, FULL_CARD)]])
  stubHost(on, files, true, {}, {}, { LANG: 'en_US.UTF-8' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expectInOrder(await textsOf(pane), [
    '⏱️ Urgency: Soon',
    'W',
    'P',
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
  await pane.unmount()
})

test('a question filed before the new fields still draws its card and option lines, and none of the new lines', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const texts = await textsOf(pane)
  expect(texts).toContain('Which way for q-l1-aaaaaa?')
  expect(texts).toContain('└ Cheap · aderência 80')
  expect(texts).toContain('💡 Por que A: It is smaller.')
  const newLabels = ['O que é', 'O problema', 'O que acontece', 'Prós', 'Contras']
  expect(texts.filter(text => newLabels.some(label => text.startsWith(label)))).toEqual([])
  await pane.unmount()
})

test('the card labels read in pt-BR: Outra…, ← Voltar and Próxima →', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await labelOf(pane, 'other-q-l1-aaaaaa')).toBe('C · Outra…')
  expect(await labelOf(pane, 'nav-next')).toBe('Sem resposta · Próxima → (x)')
  await pane.press({ key: 'nav-next' })
  expect(await labelOf(pane, 'nav-back')).toBe('Sem resposta · ← Voltar (z)')
  await pane.unmount()
})

test('the card labels read in English under LANG=en_US: Other…, ← Back and Next →', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files, true, {}, {}, { LANG: 'en_US.UTF-8' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await labelOf(pane, 'other-q-l1-aaaaaa')).toBe('C · Other…')
  expect(await labelOf(pane, 'nav-next')).toBe('No answer · Next → (x)')
  await pane.press({ key: 'nav-next' })
  expect(await labelOf(pane, 'nav-back')).toBe('No answer · ← Back (z)')
  await pane.unmount()
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
  const pane = await mountPane($)
  const writesBefore = stateWrites.length
  await clock.advance(60_000)
  // The footer draws while no question is open, and its age label ("now", then "1 min") turns with the minute.
  expect(stateWrites.slice(writesBefore)).toEqual(['tick'])
  expect(await textNodeWith(pane, 'Keep · enviada')).toBeDefined()
  await pane.unmount()
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
  const pane = await mountPane($)
  await clock.advance(31_000)
  const writesBefore = stateWrites.length
  // The window 31 000 to 60 000 holds the off-screen minute (45 000) and no minute of the card.
  await clock.advance(29_000)
  expect(stateWrites.slice(writesBefore)).toEqual([])
  await pane.unmount()
})

test('the question on the card turning its minute still writes, so the pane is redrawn', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 15_000, { session: 's2' })],
  ])
  const { clock } = stubHost(on, files)
  const stateWrites = recordStateWrites(on)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const writesBefore = stateWrites.length
  // The card's question turns its minute at 30 000.
  await clock.advance(31_000)
  expect(stateWrites.slice(writesBefore)).not.toEqual([])
  await pane.unmount()
})

test('the poll right after the last answer writes no atom the pane draws from, so the pane is not redrawn', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  const stateWrites = recordStateWrites(on)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await pane.press({ key: 'submit-all' })
  expect(stateWrites).toContain('board')
  // The card's fade and the move lock end; the next poll reads the answer folder with the answer on disk.
  await clock.advance(350)
  const writesBefore = stateWrites.length
  await clock.advance(5000)
  expect(stateWrites.slice(writesBefore)).toEqual([])
  expect(await textsOf(pane)).toContainEqual(expect.stringContaining('Rewrite · enviada'))
  await pane.unmount()
})

test('after the board empties, a question from a new group opens at its first question', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // The step is on the second question of the group when the board empties.
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Which way for q-l2-bbbbbb?')
  files.delete(path('q', 'q-l1-aaaaaa'))
  files.delete(path('q', 'q-l2-bbbbbb'))
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Nenhuma pendente')
  files.set(path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { project: '/work/web' }))
  files.set(path('q', 'q-l4-dddddd'), question('q-l4-dddddd', 4000, { project: '/work/web' }))
  await clock.advance(5000)
  const texts = await textsOf(pane)
  expect(texts).toContain('Which way for q-l3-cccccc?')
  expect(texts).not.toContain('Which way for q-l4-dddddd?')
  await pane.unmount()
})

test('an open question whose session has ended draws the notice and Dismiss instead of the options, with Next on', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 'sess-gone' })],
  ])
  const { ended } = stubHost(on, files)
  ended.add('q-l1-aaaaaa')
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('A sessão que perguntou terminou; o agente ficou na opção A.')
  expect(await pane.find({ type: 'Button', key: 'dismiss-ended' })).toBeDefined()
  expect(await labelOf(pane, 'nav-next')).toBe('Próxima → (x)')
  expect(await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-A' })).toBeUndefined()
  await pane.unmount()
})

test('the ended notice reads in English with the recommended key, and a live session keeps its options', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-live' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 'sess-gone', recommended: 'B' })],
  ])
  const { ended } = stubHost(on, files, true, {}, {}, { LANG: '' })
  ended.add('q-l2-bbbbbb')
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).not.toContain('The session that asked has ended; the agent stayed on A.')
  expect(await pane.find({ type: 'Button', key: 'dismiss-ended' })).toBeUndefined()
  await pane.unmount()
})

test('Dismiss on an ended card removes the question through prune --id, and sends no answer', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const { ended, calls, writes } = stubHost(on, files)
  ended.add('q-l1-aaaaaa')
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'dismiss-ended' })
  expect(calls.some(call => call.argv.slice(2, 5).join(' ') === 'prune --id q-l1-aaaaaa')).toBe(true)
  expect(files.has(path('q', 'q-l1-aaaaaa'))).toBe(false)
  expect(writes).toEqual([])
  await pane.unmount()
})

test('the pane asks for the answerer name once; Save stores it and the question goes away', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Your name, shown on the answers you give. Asked once; change it with /askaway who <name>.')
  await $.ui.input({ plugin: 'askaway', key: 'who-input', text: '  Ana\tSilva ' })
  expect(await textsOf(pane)).not.toContain('Your name, shown on the answers you give. Asked once; change it with /askaway who <name>.')
  expect((await run($, 'who')).text).toBe('Askaway signs your answers as Ana Silva. Change it with /askaway who <name>.')
  await pane.unmount()
})

test('Skip ends the name question for good, and a stored name is never asked again', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, { who: '' }, {}, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', key: 'who-skip' })).toBeUndefined()
  await pane.unmount()
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
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await pane.press({ key: 'submit-all' })
  expect(calls[0]?.env?.ASKAWAY_WHO).toBe('Ana')
  await pane.unmount()
})

test('the name question reads in Portuguese when the language is pt-BR', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Seu nome, mostrado nas respostas que você dá. Perguntado uma vez; mude com /askaway who <nome>.')
  expect(await pane.find({ type: 'Button', key: 'who-skip' })).toBeDefined()
  await pane.unmount()
})

test('/askaway quiet on|off stores the flag, reports it in both languages, and rejects other values', async ($, on) => {
  const files = new Map<string, string>()
  stubHost(on, files)
  await $.session.start(SESSION)
  expect((await run($, 'quiet')).text).toBe('Modo silencioso do Askaway desligado.')
  expect((await run($, 'quiet on')).text).toBe('Modo silencioso do Askaway ligado: sem aviso para pergunta nova e sem esmaecer depois de uma resposta.')
  expect((await run($, 'quiet')).text).toContain('ligado')
  expect((await run($, 'quiet maybe')).text).toBe('Digite /askaway quiet on ou off.')
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
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await pane.press({ key: 'submit-all' })
  expect(await pane.find({ type: 'Text', text: 'Which way for q-l1-aaaaaa?' })).toBeUndefined()
  expect(await textsOf(pane)).toContain('Nenhuma pendente')
  await pane.unmount()
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

test('History: Clear all counts every row, the pending one included, removes them all and is gone once nothing is left', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: true, reason: 'ttl' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A')],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // Clear all counts the expired row and the pending one; no per-line dismiss button is drawn any more.
  expect(String((await pane.find({ type: 'Button', key: 'history-clear' }))?.props.label)).toBe('Limpar tudo (2)')
  expect(await pane.find({ type: 'Button', key: 'dismiss-q-l1-aaaaaa' })).toBeUndefined()
  await pane.press({ key: 'history-clear' })
  expect(await pane.find({ type: 'Button', key: 'history-clear' })).toBeUndefined()
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).not.toMatch(/expirou sem ser lida/)
  expect(drawn).not.toMatch(/Resposta A · /)
  await pane.unmount()
})

test('History: Clear all writes cleared.json with the drawn ids and a ts, and no answer is written', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A')],
  ])
  const { clearings, writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'history-clear' })
  expect(clearings).toHaveLength(1)
  const written = JSON.parse(clearings[0] ?? '{}') as { ts: number; ids: string[] }
  expect(written.ts).toEqual(expect.any(Number))
  expect([...written.ids].sort()).toEqual(['q-l1-aaaaaa', 'q-l2-bbbbbb'])
  expect(writes).toEqual([])
  await pane.unmount()
})

test('History: a Clear all of another session hides its rows at the next poll', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A')],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(String((await pane.find({ type: 'Button', key: 'history-clear' }))?.props.label)).toBe('Limpar tudo (2)')
  files.set(`${STATE}/cleared.json`, JSON.stringify({ ts: 100, ids: ['q-l1-aaaaaa'] }))
  await clock.advance(5000)
  expect(String((await pane.find({ type: 'Button', key: 'history-clear' }))?.props.label)).toBe('Limpar tudo (1)')
  const texts = await textsOf(pane)
  expect(texts.some(text => text.includes('○ Title q-l1-aaaaaa'))).toBe(false)
  expect(texts.some(text => text.startsWith('○ Title q-l2-bbbbbb ✓ '))).toBe(true)
  await pane.unmount()
})

test('History: a malformed cleared.json changes nothing', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A')],
  ])
  const { clock, clearings } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  files.set(`${STATE}/cleared.json`, JSON.stringify({ ts: 100, ids: [7] }))
  await clock.advance(5000)
  expect(String((await pane.find({ type: 'Button', key: 'history-clear' }))?.props.label)).toBe('Limpar tudo (2)')
  files.set(`${STATE}/cleared.json`, JSON.stringify({ ts: '100', ids: ['q-l1-aaaaaa'] }))
  await clock.advance(5000)
  expect(String((await pane.find({ type: 'Button', key: 'history-clear' }))?.props.label)).toBe('Limpar tudo (2)')
  expect(clearings).toEqual([])
  await pane.unmount()
})

test('History: Clear all keeps the ids cleared.json already lists', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: false })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A')],
  ])
  const { clock, clearings } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // A delivered line stays drawn until Clear all, so the 36 s advance changes nothing here; the file names q-l1 after
  // the last poll, and Clear all still writes its id.
  await clock.advance(36000)
  expect(String((await pane.find({ type: 'Button', key: 'history-clear' }))?.props.label)).toBe('Limpar tudo (2)')
  files.set(`${STATE}/cleared.json`, JSON.stringify({ ts: 100, ids: ['q-l1-aaaaaa'] }))
  await pane.press({ key: 'history-clear' })
  const written = JSON.parse(clearings[0] ?? '{}') as { ids: string[] }
  expect([...written.ids].sort()).toEqual(['q-l1-aaaaaa', 'q-l2-bbbbbb'])
  await pane.unmount()
})

test('History: Clear all keeps an id cleared.json lists for an answer this session\'s board does not know yet', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
  ])
  const { clearings } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // Another session cleared q-l9 after writing its answer; neither file has reached this session's board yet.
  files.set(`${STATE}/cleared.json`, JSON.stringify({ ts: 100, ids: ['q-l9-zzzzzz'] }))
  files.set(path('a', 'q-l9-zzzzzz'), answer('q-l9-zzzzzz', 'A'))
  await pane.press({ key: 'history-clear' })
  const written = JSON.parse(clearings[0] ?? '{}') as { ids: string[] }
  expect([...written.ids].sort()).toEqual(['q-l1-aaaaaa', 'q-l9-zzzzzz'])
  await pane.unmount()
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
  const pane = await mountPane($)
  await pane.press({ key: 'history-clear' })
  await pane.unmount()
  // The stored list is read again at the next session start. The pruned id is no longer in it, so its answer, back on
  // the board, shows; the id still on the board stays hidden.
  files.set(path('q', 'q-gone-eeeeee'), question('q-gone-eeeeee', 500))
  files.set(path('a', 'q-gone-eeeeee'), answer('q-gone-eeeeee', 'A'))
  files.set(path('d', 'q-gone-eeeeee'), delivery('q-gone-eeeeee', { expired: true, reason: 'ttl' }))
  await $.session.start(SESSION)
  const restarted = await mountPane($)
  const restartedTexts = await textsOf(restarted)
  expect(restartedTexts.some(text => text.startsWith('○ Title q-gone-eeeeee ✓ Keep · '))).toBe(true)
  expect(restartedTexts.some(text => text.includes('○ Title q-l1-aaaaaa'))).toBe(false)
  await restarted.unmount()
})


test('model: "multimedia" does not grade medium urgency; an Other answer whose question is gone names no letter', () => {
  const grade = (extra: Record<string, unknown>) => urgencyGradeOf(parsedQuestion('q-u-000002', 1000, extra))
  expect(grade({ urgency: 'multimedia assets' })).toBe('low')
  expect(grade({ urgency: 'media team' })).toBe('medium')
  const orphan: Board = { questions: [], answers: [answerOf('q-m-000001', 'other', 1, 'lavanda')], delivered: [] }
  expect(historyOf('en', orphan, NO_STATUS)[0]?.sessions[0]?.entries[0]?.line).toContain('“lavanda” · sent ')
})

// Gauntlet 3 package C
test('the ended card draws no lead line in either language: no option can be sent, so "Pick another option" would mislead', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const { ended } = stubHost(on, files)
  ended.add('q-l1-aaaaaa')
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    const texts = await textsOf(pane)
    expect(texts).toContain('A sessão que perguntou terminou; o agente ficou na opção A.')
    expect(texts.some(text => text.includes('Escolha outra opção') || text.includes('Pick another option'))).toBe(false)
    await pane.unmount()
  }
})

test('Back on an ended card carries its hotkey, z on the terminal and p on the desktop, as Back on a live card does', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 'sess-gone' })],
  ])
  const { ended } = stubHost(on, files)
  ended.add('q-l1-aaaaaa')
  await $.session.start(SESSION)
  for (const [surface, letter] of [['terminal', 'z'], ['desktop', 'p']] as const) {
    const pane = await mountPane($, surface)
    expect((await pane.find({ type: 'Button', key: 'nav-back' }))?.props.hotkey).toBe(letter)
    await pane.unmount()
  }
})

test('the terminal submit link draws the ▪ link mark before "Enviar resposta", as the Desktop Markdown link does', async ($, on) => {
  stubHost(on, treeFiles())
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(await textsOf(pane)).toContain('▪ Enviar resposta')
  await pane.unmount()
})

test('a long Other text is drawn whole in typographic quotes on its History row, while the delivery line keeps the full text', () => {
  const long = 'x'.repeat(200)
  const board: Board = { questions: [parsedQuestion('q-m-000001', 10)], answers: [answerOf('q-m-000001', 'other', 1, long)], delivered: [] }
  const [entry] = historyOf('en', board, NO_STATUS).flatMap(group => group.sessions.flatMap(session => session.entries))
  expect(entry?.line).toMatch(/^“x{200}” · sent [\d/ :]+$/)
  expect(entry?.line.startsWith(`“${long}”`)).toBe(true)
  expect(deliveryLine(parsedQuestion('q-m-000001', 10), answerOf('q-m-000001', 'other', 1, long))).toContain(long)
})

test('the terminal card title names the asking session, dimmed beside the title', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session_title: 'billing-api' })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($, 'terminal')
  expect(await pane.find({ type: 'Text', text: sessionLabelOf({ session_title: 'billing-api' }, 'pt') })).toBeDefined()
  await pane.unmount()
})

test('the pt-BR ended notice and lead name the option as "opção", not a bare letter', () => {
  expect(t('pt', 'card.ended', { key: 'B' })).toBe('A sessão que perguntou terminou; o agente ficou na opção B.')
  expect(t('pt', 'card.lead.agent', { key: 'B', time: '14:02' })).toBe(
    'Na opção B desde 14:02. Escolha outra opção para trocar; sem resposta, fica a opção B.',
  )
})

test('an answer given this minute reads "just now" in English and "há instantes" in pt-BR', () => {
  expect(ageLabel('en', 0, 0)).toBe('just now')
  expect(ageLabel('pt', 0, 0)).toBe('há instantes')
})

test('the footer with nothing open leaves out the zero counts and the "nothing waiting" text, and keeps the none form of the replied count', () => {
  expect(footerText('en', EMPTY_BOARD, FOOT_DAY)).toBe('none answered in the last 24 h')
  expect(footerText('pt', EMPTY_BOARD, FOOT_DAY)).toBe('nenhuma respondida nas últimas 24 h')
})

test('a History row whose question has left the board is titled "Question closed" (pt-BR "Pergunta encerrada"), never its raw id', () => {
  const orphan: Board = { questions: [], answers: [answerOf('q-m-000001', 'A', 1)], delivered: [] }
  const titleIn = (lang: 'en' | 'pt'): string | undefined =>
    historyOf(lang, orphan, NO_STATUS).flatMap(group => group.sessions.flatMap(session => session.entries))[0]?.title
  expect(titleIn('en')).toBe('Question closed')
  expect(titleIn('pt')).toBe('Pergunta encerrada')
})

test('decorative images carry empty alt text on the desktop: the History icon and the divider rule, not English words', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A')],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($, 'desktop')
  const alts = (await pane.findAll({ type: 'Svg' })).map(svg => svg.props.alt)
  expect(alts).not.toContain('History')
  expect(alts).not.toContain('divider')
  expect(alts).toContain('')
  await pane.unmount()
})

test('away mode shows on the pane counter line: the counter text with the list away mark appended, and nothing when away is off', () => {
  const pane = { Box: fakeElement('Box'), Text: fakeElement('Text'), Button: fakeElement('Button') }
  const view = {
    questions: [], history: [], now: 0, leaving: {}, groups: [], active: undefined, wizard: { picks: {} },
    screen: undefined, surface: 'terminal', footer: undefined, ended: [], askWho: false,
  }
  const drawnWith = (away: boolean): string =>
    JSON.stringify(renderPane(pane as never, { ...view, away } as never, {} as never, 'en', heldButtons()))
  expect(drawnWith(true)).toContain('Nothing pending, away mode on')
  expect(drawnWith(false)).not.toContain('away mode on')
})

test('a delivered line whose marker has no time reads "(read by the session)" in parentheses, as the timed line does', () => {
  const board: Board = {
    questions: [parsedQuestion('q-h-000001', 10)],
    answers: [answerOf('q-h-000001', 'A', 1)],
    delivered: [{ id: 'q-h-000001', expired: false }],
  }
  const [entry] = historyOf('en', board, NO_STATUS).flatMap(group => group.sessions.flatMap(session => session.entries))
  expect(entry?.line.endsWith('· (read by the session)')).toBe(true)
})

// Gauntlet 3 package B1
test('Gauntlet B1 H1: a draft.json that exists but does not parse is not written over, and the pick stays on screen', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [`${STATE}/draft.json`, '{"ts": 100, "picks": {'],
  ])
  const { drafts } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(drafts).toEqual([])
  expect(files.get(`${STATE}/draft.json`)).toBe('{"ts": 100, "picks": {')
  expect((await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).toBe('primary')
  await pane.unmount()
})

test('Gauntlet B1 H2: a pick whose draft write failed is retried at the next poll, and the person is told once', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = { failingWriteTo: 'draft.json' }
  const { drafts, toasts, clock } = stubHost(on, files, true, {}, holds, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.advance(5000)
  await clock.advance(5000)
  expect(drafts).toEqual([])
  expect(toasts.filter(text => text === 'Could not save your pick; retrying.')).toHaveLength(1)
  expect((await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).toBe('primary')
  holds.failingWriteTo = undefined
  await clock.advance(5000)
  expect(drafts).toHaveLength(1)
  expect(JSON.parse(drafts[0] ?? '{}')).toEqual({ ts: expect.any(Number), picks: { 'q-l1-aaaaaa': { key: 'B' } } })
  await pane.unmount()
})

test('Gauntlet B1 H3: a draft.json stamped more than 60 s past the clock is pulled back to now and applied; one 30 s ahead is', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: 1e13, picks: { 'q-l1-aaaaaa': { key: 'B' } } }))
  await clock.advance(5000)
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(false)
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: 100, picks: { 'q-l1-aaaaaa': { key: 'B' } } }))
  await clock.advance(5000)
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(false)
  await pane.unmount()
})

test('Gauntlet M52: a far-ahead draft applies every pick it holds, the one made here included', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  // Another window wrote the file after reading this pick, so its far-ahead draft holds both picks.
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: 1e13, picks: { 'q-l1-aaaaaa': { key: 'A' }, 'q-l2-bbbbbb': { key: 'B' } } }))
  await clock.advance(5000)
  // Next walks to the last question, and the next Next opens the review, where Submit all is lit once every pick is held.
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(false)
  await pane.unmount()
})

test('Gauntlet M64: a second option press inside the move lock is ignored, and the press after MOVE_LOCK_MS is taken', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(readJson(files, `${STATE}/draft.json`)).toMatchObject({ picks: { 'q-l1-aaaaaa': { key: 'A' } } })
  // The lock lower bound (Gauntlet 5 B3 M54): at 349 ms the lock still holds, and the press at 350 ms is taken.
  await clock.advance(349)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(readJson(files, `${STATE}/draft.json`)).toMatchObject({ picks: { 'q-l1-aaaaaa': { key: 'A' } } })
  await clock.advance(1)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(readJson(files, `${STATE}/draft.json`)).toMatchObject({ picks: { 'q-l1-aaaaaa': { key: 'B' } } })
  await pane.unmount()
})

test('Gauntlet M64: Back and Next presses inside the move lock are ignored; the press after the window is taken', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // The pick keeps the card on the first question; the pick itself starts the move lock.
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(await textsOf(pane)).toContain('Which way for q-l1-aaaaaa?')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Which way for q-l2-bbbbbb?')
  await pane.press({ key: 'nav-back' })
  expect(await textsOf(pane)).toContain('Which way for q-l2-bbbbbb?')
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  expect(await textsOf(pane)).toContain('Which way for q-l1-aaaaaa?')
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Which way for q-l1-aaaaaa?')
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Which way for q-l2-bbbbbb?')
  await pane.unmount()
})

test('Gauntlet B1 H4: a draft this window writes is stamped after the newest draft it has seen, even when the clock is behind it', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { drafts, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  // Another window's draft stamped 30 s ahead of this first write; the poll applies it and sets this session's last ts.
  const first = (JSON.parse(drafts[0] ?? '{}') as { ts: number }).ts
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: first + 30_000, picks: {} }))
  await clock.advance(5000)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect((JSON.parse(drafts[drafts.length - 1] ?? '{}') as { ts: number }).ts).toBeGreaterThan(first + 30_000)
  await pane.unmount()
})

test('Gauntlet B1 H5: Submit all applies the draft another window wrote before it sends the picks', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // The other window's pick lands after this session's last poll, so this session has not applied it yet.
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: 100, picks: { 'q-l1-aaaaaa': { key: 'B' } } }))
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'B' })
  await pane.unmount()
})

test('Gauntlet B1 H6: a row Submit on a question whose reply is still being written keeps that question its pick', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const write = gate()
  const holds: Holds = {}
  const { clock, drafts, writes } = stubHost(on, files, true, { quiet: true }, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-B' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  // The first question's reply is held in its CLI call; the row Submit of the same question comes while it is in flight.
  holds.write = write.promise
  const first = pane.press({ key: 'submit-all' })
  await clock.settle()
  const drafted = drafts.length
  await pressTreeLink(pane, 'submit', 'q-l1-aaaaaa')
  await clock.settle()
  expect(drafts).toHaveLength(drafted)
  write.open()
  await first
  await clock.settle()
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  await pane.unmount()
})

test('Gauntlet B1 H9: an ended question takes no Submit all: its pick is dropped and no reply is written', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock, drafts, writes, ended } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  ended.add('q-l1-aaaaaa')
  await clock.advance(5000)
  // The card moved on to the next question, so the ended one is a tree row: its Submit takes no reply.
  await pressTreeLink(pane, 'submit', 'q-l1-aaaaaa')
  await clock.settle()
  expect(writes).toEqual([])
  expect(files.has(path('a', 'q-l1-aaaaaa'))).toBe(false)
  expect(JSON.parse(drafts[drafts.length - 1] ?? '{}')).toEqual({ ts: expect.any(Number), picks: {} })
  await pane.unmount()
})

test('Gauntlet B1 H10: a failed cleared.json write is logged, and the clear holds in this window and after a restart', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files, true, {}, { failingWriteTo: 'cleared.json' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'history-clear' })
  expect(files.has(`${STATE}/cleared.json`)).toBe(false)
  expect(await pane.find({ type: 'Button', key: 'history-clear' })).toBeUndefined()
  await pane.unmount()
  await $.session.start(SESSION)
  const restarted = await mountPane($)
  expect(await restarted.find({ type: 'Button', key: 'history-clear' })).toBeUndefined()
  await restarted.unmount()
})

test('Gauntlet B1 H12: a cleared History row, once hidden, leaves the drawn pane unchanged for 31 s', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  files.set(path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B'))
  files.set(path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa', { expired: false }))
  await clock.advance(5000)
  await pane.press({ key: 'history-clear' })
  await clock.settle()
  // The footer names the cleared question as its last answer and its age moves to the minute, so it is left out.
  const withoutFooter = async (): Promise<string[]> => (await textsOf(pane)).filter(text => !text.includes('Title q-l1-aaaaaa'))
  const drawn = await withoutFooter()
  await clock.advance(31_000)
  expect(await withoutFooter()).toEqual(drawn)
  await pane.unmount()
})

test('Gauntlet B1 H19: a second session start keeps the card on screen and its step', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain('Which way for q-l2-bbbbbb?')
  await pane.unmount()
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const again = await mountPane($, surface)
    expect(await textsOf(again)).toContain('Which way for q-l2-bbbbbb?')
    await again.unmount()
  }
})

// Gauntlet 5 B3 M16 (probe, part 1 of 2): the hook module keeps moveLocked and pendingOther between presses. This test ends
// with a move lock still running (its timer never fires) and an Other text typed on the second card but not recorded.
test('Gauntlet 5 B3 M16 probe: a pick, then an Other text typed on the next card, and the test ends with both open', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock, drafts } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(drafts).toHaveLength(1)
  // The pick keeps the card on the first question: Next, after the lock, walks to the second one, and the lock of that move runs on.
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await pane.press({ key: 'other-q-l2-bbbbbb' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l2-bbbbbb', text: 'Stale text' })
  await pane.unmount()
})

// Gauntlet 5 B3 M16 (probe, part 2 of 2): the test right after the one above starts clean. A leaked move lock would ignore
// its first pick; a leaked pending Other text would be recorded as a pick by it. Its draft is then exactly the one pick.
test('Gauntlet 5 B3 M16 probe: the next test starts with no move lock and no pending Other text', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { drafts } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(JSON.parse(drafts.at(-1) ?? '{}')).toEqual({ ts: expect.any(Number), picks: { 'q-l1-aaaaaa': { key: 'A' } } })
  await pane.unmount()
})

test('Gauntlet B1 F11: Dismiss runs prune with --strict, so a refused prune exits non-zero and is reported', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const { calls, ended } = stubHost(on, files)
  ended.add('q-l1-aaaaaa')
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'dismiss-ended' })
  expect(calls.map(call => call.argv.slice(2).join(' '))).toContain('prune --id q-l1-aaaaaa --strict --force')
  await pane.unmount()
})

test('Gauntlet 5 B3 M4b: Dismiss of an open high-risk ended card runs prune with --force, which lifts its pause', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone', risk: 'high', pause: true })]])
  const { calls, ended } = stubHost(on, files)
  ended.add('q-l1-aaaaaa')
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'dismiss-ended' })
  expect(calls.map(call => call.argv.slice(2).join(' '))).toContain('prune --id q-l1-aaaaaa --strict --force')
  await pane.unmount()
})

// Gauntlet 5 review R3: an ended card's pause is over and the person pressing Dismiss is the user, so Dismiss always forces.
test('Gauntlet 5 review R3: Dismiss of a low-risk ended card runs prune with --force too, whatever the risk', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const { calls, ended } = stubHost(on, files)
  ended.add('q-l1-aaaaaa')
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'dismiss-ended' })
  const prunes = calls.map(call => call.argv.slice(2).join(' ')).filter(line => line.startsWith('prune'))
  expect(prunes).toEqual(['prune --id q-l1-aaaaaa --strict --force'])
  await pane.unmount()
})

// Gauntlet 5 review R3: the pane read the question as low; askaway.py then rewrote it high with pause (a repeat, M5c). Dismiss
// must still force, so it does not depend on the risk the pane cached.
test('Gauntlet 5 review R3: Dismiss of an ended card forces prune even when its question was rewritten to a pause after the pane read it', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const { calls, ended, clock } = stubHost(on, files)
  ended.add('q-l1-aaaaaa')
  await $.session.start(SESSION)
  const pane = await mountPane($)
  files.set(path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone', risk: 'high', pause: true }))
  await clock.advance(6000)
  await pane.press({ key: 'dismiss-ended' })
  expect(calls.map(call => call.argv.slice(2).join(' '))).toContain('prune --id q-l1-aaaaaa --strict --force')
  await pane.unmount()
})

// Gauntlet 3 package B2
test('Gauntlet B2 H7: a reply the CLI cannot write is logged and told by a toast, and the pick stays for another press', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { toasts, clock } = stubHost(on, files, true, {}, { answerExit: 1 }, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await pane.press({ key: 'submit-all' })
  await clock.settle()
  expect(toasts).toEqual(['Could not send your reply; the question is still open.'])
  expect((await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).toBe('primary')
  await pane.unmount()
})

test('Gauntlet B2 H8: a reply another window wrote first is kept, and the toast names the key that holds it', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const hold = gate()
  const { toasts, clock } = stubHost(on, files, true, {}, { write: hold.promise }, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await pane.press({ key: 'submit-all' })
  // Another window writes its reply while this window's CLI call waits: the CLI refuses this one.
  files.set(path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', 500))
  hold.open()
  await clock.settle()
  expect(toasts).toEqual(['Another window already replied A; that reply stays.'])
  expect(files.get(path('a', 'q-l1-aaaaaa'))).toBe(answer('q-l1-aaaaaa', 'A', 500))
  await pane.unmount()
})

test('Gauntlet B2 H11: the ended check runs when the linked open questions change, and otherwise at most every 30 s', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-a' })]])
  const { calls, clock } = stubHost(on, files)
  const listings = (): number => calls.filter(call => call.argv[2] === 'list').length
  await $.session.start(SESSION)
  expect(listings()).toBe(1)
  await clock.advance(5000)
  await clock.advance(5000)
  await clock.advance(5000)
  expect(listings()).toBe(1)
  files.set(path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 'sess-b' }))
  await clock.advance(5000)
  expect(listings()).toBe(2)
  await clock.advance(25000)
  expect(listings()).toBe(2)
  await clock.advance(5000)
  expect(listings()).toBe(3)
})

test('Gauntlet B2 H13: with no state folder the pane footer says away mode is unavailable, on both surfaces', async ($, on) => {
  stubHost(on, new Map(), true, {}, {}, { LANG: '', HOME: '' })
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    expect(await textsOf(pane)).toContain('Askaway away mode is unavailable: no state folder (HOME is unset).')
    await pane.unmount()
  }
})

test('Gauntlet B2 H25: Clear all over a pending reply says the reply still reaches its session', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', 500)],
  ])
  const { toasts, clearings } = stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'history-clear' })
  expect(toasts).toEqual(['Cleared 1; waiting replies still reach their sessions.'])
  expect(clearings).toHaveLength(1)
  await pane.unmount()
})

test('Gauntlet B2 P12: the pane counter says away mode is on while away.json is on, on both surfaces', async ($, on) => {
  const files = new Map([[`${STATE}/away.json`, '{"on":true,"ts":1}']])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    expect(await textsOf(pane)).toContain('Nothing pending, away mode on')
    await pane.unmount()
  }
})

test('Gauntlet B2 leftover: the pick-not-saved toast comes from the i18n table, so pt-BR reads in pt-BR', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { toasts, clock } = stubHost(on, files, true, {}, { failingWriteTo: 'draft.json' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.advance(5000)
  expect(toasts).toEqual(['Não foi possível salvar a escolha; tentando de novo.'])
  await pane.unmount()
})

// Gauntlet 3 H21 H22
test('Gauntlet H21: a reply stamped after a clock step back is due at once; one stamped just before now is still held', () => {
  const now = 100_000
  const board = (ts: number): Board => ({
    questions: [parsedQuestion('q-h21-000001', 10, { session: 's1' })],
    answers: [answerOf('q-h21-000001', 'A', ts)],
    delivered: [],
  })
  expect(groupBySession(board(now + 60_000), now)[0]?.items.map(item => item.answer.id)).toEqual(['q-h21-000001'])
  expect(groupBySession(board(now - 1), now)).toEqual([])
})

// Gauntlet 3 review fixes
test('Gauntlet 3 review 1: an unreadable draft.json holds the first pick; the next poll overwrites it so the picks land', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [`${STATE}/draft.json`, '{"ts": 100, "picks": {'],
  ])
  const { drafts, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(drafts).toEqual([])
  await clock.advance(5000)
  expect(drafts).toHaveLength(1)
  expect(JSON.parse(files.get(`${STATE}/draft.json`) ?? '{}')).toEqual({ ts: expect.any(Number), picks: { 'q-l1-aaaaaa': { key: 'B' } } })
  await pane.unmount()
})

test('Gauntlet 3 review 2: a pick the file holds for an id this window does not know yet survives this window\'s next save', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [`${STATE}/draft.json`, JSON.stringify({ ts: 100, picks: { 'q-l9-zzzzzz': { key: 'A' } } })],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  expect(JSON.parse(files.get(`${STATE}/draft.json`) ?? '{}').picks).toEqual({ 'q-l1-aaaaaa': { key: 'B' }, 'q-l9-zzzzzz': { key: 'A' } })
  await pane.unmount()
})

test('Gauntlet 3 review 3: a list --open run that fails is run again at the next poll; a run that ran is not repeated within 30 s', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const holds: Holds = { listExit: 1 }
  const { calls, clock } = stubHost(on, files, true, {}, holds)
  const listRuns = () => calls.filter(call => call.argv[2] === 'list').length
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const before = listRuns()
  await clock.advance(5000)
  await clock.advance(5000)
  expect(listRuns() - before).toBe(2)
  holds.listExit = undefined
  await clock.advance(5000)
  await clock.advance(5000)
  expect(listRuns() - before).toBe(3)
  await pane.unmount()
})

// Owner replies P1
test('model: a delivered line stays in History until Clear all, however long after the pane saw it', () => {
  const board: Board = {
    questions: [parsedQuestion('q-p1-000001', 10)],
    answers: [answerOf('q-p1-000001', 'A', 100)],
    delivered: [{ id: 'q-p1-000001', expired: false, ts: 150 }],
  }
  const drawnIds = (context: Partial<typeof NO_STATUS>): string[] =>
    clearableIdsOf(historyOf('en', board, { ...NO_STATUS, now: 1000, ...context }))
  expect(drawnIds({ now: 31_000 })).toEqual(['q-p1-000001'])
  expect(drawnIds({ now: 3_600_000 })).toEqual(['q-p1-000001'])
  expect(drawnIds({ now: 3_600_000, cleared: ['q-p1-000001'] })).toEqual([])
})

test('model: the footer not-yet-read count leaves out the lines Clear all hid', () => {
  const now = localMs(10, 18, 15, 0)
  const board: Board = {
    questions: [parsedQuestion('q-p1-000002', 1), parsedQuestion('q-p1-000003', 2)],
    answers: [answerOf('q-p1-000002', 'A', now - FOOT_MIN), answerOf('q-p1-000003', 'B', now - FOOT_HOUR)],
    delivered: [],
  }
  expect(footerText('en', board, now)).toContain('· 2 not yet read')
  expect(footerText('en', board, now, ['q-p1-000002'])).toContain('· 1 not yet read')
  expect(footerText('en', board, now, ['q-p1-000002'])).not.toContain('2 not yet read')
  expect(footerText('pt', board, now, ['q-p1-000002'])).toContain('· 1 ainda não lida')
})

test('model: the lead line dates a question asked on an earlier day and shows the clock time alone on the day it was asked', () => {
  const yesterday = localMs(10, 17, 14, 5)
  const today = localMs(10, 18, 9, 0)
  expect(leadOf('en', parsedQuestion('q-p1-000004', yesterday, { recommended: 'B' }), today)).toBe(
    'On B since 17/10 14:05. Pick another option to switch; no answer keeps B.',
  )
  expect(leadOf('pt', parsedQuestion('q-p1-000004', yesterday, { recommended: 'B' }), today)).toBe(
    'Na opção B desde 17/10 14:05. Escolha outra opção para trocar; sem resposta, fica a opção B.',
  )
  expect(leadOf('en', parsedQuestion('q-p1-000005', today, { risk: 'high' }), today)).toBe('Paused since 09:00, waiting for your answer.')
})

test('the ended card names what Dismiss does, "Dispensar (remove)" in pt-BR and "Dismiss (removes)" in English, on both surfaces', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 'sess-gone' })],
  ])
  const { ended } = stubHost(on, files)
  ended.add('q-l1-aaaaaa')
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    expect(await labelOf(pane, 'dismiss-ended')).toBe('Dispensar (remove)')
    await pane.unmount()
  }
  expect(t('en', 'card.dismiss')).toBe('Dismiss (removes)')
})

test('the Other field draws no label of its own: the engine Input has no accessible-name prop (its label is drawn as text), so its placeholder is its only text on both surfaces', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    const field = await pane.find({ type: 'Input', key: 'other-input-q-l1-aaaaaa' })
    expect(field?.props.label).toBeUndefined()
    expect(field?.props.placeholder).toBe(t('pt', 'input.placeholder'))
    await pane.unmount()
  }
})

test('History labels are links on the desktop only: the terminal draws the family, session and title plain', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { desktop_session: 'local_abc', title: 'Cache it' })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const desk = await mountPane($, 'desktop')
  // beta.35: the History row is plain text and names no session.
  expect(await desk.find({ type: 'Markdown', text: /^○ .*\(#local_abc\)/ })).toBeUndefined()
  await desk.unmount()
  const terminal = await mountPane($)
  expect(await terminal.find({ type: 'Markdown', text: /#local_abc/ })).toBeUndefined()
  expect(await textNodeWith(terminal, '○ Cache it ✓ Keep · ')).toBeDefined()
  await terminal.unmount()
})

test('the terminal nav labels carry their letter, "Sem resposta · ← Voltar (z)", "Sem resposta · Próxima → (x)" and "Enviar tudo (2) (w)"; the desktop labels carry no letter', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const terminal = await mountPane($)
  expect(await labelOf(terminal, 'nav-next')).toBe('Sem resposta · Próxima → (x)')
  await terminal.press({ key: 'nav-next' })
  expect(await labelOf(terminal, 'nav-back')).toBe('Sem resposta · ← Voltar (z)')
  await terminal.unmount()
  const desk = await mountPane($, 'desktop')
  expect(await labelOf(desk, 'nav-back')).toBe('Sem resposta · ← Voltar')
  await desk.unmount()
  // The last card of a group of two shows Next; Submit all is on the review that Next opens.
  const reviewing = await mountPane($)
  await clock.advance(350)
  await reviewing.press({ key: 'nav-next' })
  expect(await labelOf(reviewing, 'submit-all')).toBe('Enviar tudo (2) (w)')
  await reviewing.unmount()
})

// Owner replies P2a
test('Owner replies P2a Q13: a row Submit on another question keeps the card on the question on screen', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's1' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { session: 's1' })],
    [`${STATE}/draft.json`, JSON.stringify({ ts: 100, picks: { 'q-l3-cccccc': { key: 'A' } } })],
  ])
  const { clock, writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'nav-next' })
  expect(await pane.find({ key: 'card-q-l2-bbbbbb' })).toBeDefined()
  await pressTreeLink(pane, 'submit', 'q-l3-cccccc')
  await clock.advance(5000)
  expect(writes).toContain(path('a', 'q-l3-cccccc'))
  expect(await pane.find({ key: 'card-q-l2-bbbbbb' })).toBeDefined()
  expect(await pane.find({ key: 'card-q-l1-aaaaaa' })).toBeUndefined()
  await pane.unmount()
})

test('Owner replies P2a Q13: a row Submit on the question on screen moves the card to the next open question once it leaves', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 's1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { session: 's1' })],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000, { session: 's1' })],
    [`${STATE}/draft.json`, JSON.stringify({ ts: 100, picks: { 'q-l2-bbbbbb': { key: 'B' } } })],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'nav-next' })
  expect(await pane.find({ key: 'card-q-l2-bbbbbb' })).toBeDefined()
  await pressTreeLink(pane, 'submit', 'q-l2-bbbbbb')
  await clock.advance(5000)
  expect(await pane.find({ key: 'card-q-l3-cccccc' })).toBeDefined()
  expect(await pane.find({ key: 'card-q-l2-bbbbbb' })).toBeUndefined()
  await pane.unmount()
})

test('Owner replies P2a Q29: a cleared id with no reply file leaves the atom at the next poll and cleared.json is not rewritten; an id with a reply file stays', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A')],
    [`${STATE}/cleared.json`, JSON.stringify({ ts: 100, ids: ['q-gone-cccccc', 'q-l1-aaaaaa'] })],
  ])
  const { clearings } = stubHost(on, files)
  await $.session.start(SESSION)
  // The poll drops the id with no reply file from the atom only: it writes nothing to cleared.json. Clear all does that later.
  expect(clearings).toEqual([])
  const pane = await mountPane($)
  expect(String((await pane.find({ type: 'Button', key: 'history-clear' }))?.props.label)).toBe('Limpar tudo (1)')
  const texts = await textsOf(pane)
  expect(texts.some(text => text.startsWith('○ Title q-l2-bbbbbb ✓ '))).toBe(true)
  expect(texts.some(text => text.includes('○ Title q-l1-aaaaaa'))).toBe(false)
  await pane.unmount()
})

test('Owner replies P2a Q29: a poll writes nothing to cleared.json while every id it lists still has a reply file', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [`${STATE}/cleared.json`, JSON.stringify({ ts: 100, ids: ['q-l1-aaaaaa'] })],
  ])
  const { clock, clearings } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  expect(clearings).toEqual([])
})

// Owner replies P2b

test('the footer leaves the rows Clear all hid out of the not-yet-read and the expired counts, and keeps the answered count', () => {
  const now = 10 * FOOT_DAY
  const board: Board = {
    questions: [
      parsedQuestion('q-f-000001', 1, { title: 'Pick the queue' }),
      parsedQuestion('q-f-000004', 4),
      parsedQuestion('q-f-000005', 5),
    ],
    answers: [
      answerOf('q-f-000001', 'A', now - 12 * FOOT_MIN),
      answerOf('q-f-000004', 'B', now - 3 * FOOT_DAY),
      answerOf('q-f-000005', 'A', now - 8 * FOOT_DAY),
    ],
    delivered: [{ id: 'q-f-000004', expired: true, reason: 'session-ended' }],
  }
  expect(footerText('en', board, now)).toBe(
    '1 answered in the last 24 h · last: Pick the queue → Keep, 12 min ago · 1 not yet read · 2 expired',
  )
  expect(footerText('en', board, now, ['q-f-000001', 'q-f-000005'])).toBe(
    '1 answered in the last 24 h · last: Pick the queue → Keep, 12 min ago · 1 expired',
  )
})

// beta.27 review fixes

test('beta.27 review fixes: polls never rewrite cleared.json, even to drop a dead id; the next Clear all drops it from the file', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A')],
    [`${STATE}/cleared.json`, JSON.stringify({ ts: 100, ids: ['q-gone-cccccc', 'q-l2-bbbbbb'] })],
  ])
  const { clock, clearings } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(15_000)
  expect(clearings).toEqual([])
  const pane = await mountPane($)
  expect(String((await pane.find({ type: 'Button', key: 'history-clear' }))?.props.label)).toBe('Limpar tudo (1)')
  await pane.press({ key: 'history-clear' })
  expect(clearings).toHaveLength(1)
  const written = JSON.parse(clearings[0] ?? '{}') as { ids: string[] }
  expect([...written.ids].sort()).toEqual(['q-l1-aaaaaa', 'q-l2-bbbbbb'])
  await pane.unmount()
})

test('beta.27 review fixes: the title row on the Desktop keeps its "See session" link between the title and the risk', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { desktop_session: 'local_abc', title: 'Cache [it] now' })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($, 'desktop')
  const titleRow = await pane.find({ type: 'Markdown', key: 'title-q-l1-aaaaaa' })
  const text = String((titleRow?.props as Record<string, unknown> | undefined)?.text)
  expect(text.startsWith(`### Cache \\[it\\] now - [Ver sessão ↗](#local_abc) - ${riskLabel('pt', 'low')} · `)).toBe(true)
  await pane.unmount()
})

// gauntlet 4, package B1
test('Gauntlet 4 B1 M22: a pick made while a poll applies the draft is kept, and Submit all counts it', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { clock } = stubHost(on, files)
  // The first wizard write after `armed` (the poll's apply of the draft's picks) waits here, after the poll has read the wizard.
  const landed = gate()
  let armed = false
  on('state.set', { plugin: 'askaway' }, async (_$, e, next) => {
    if (armed && e.key === 'wizard') {
      armed = false
      await landed.promise
    }
    return next(e)
  })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: 100, picks: { 'q-l2-bbbbbb': { key: 'A' } } }))
  armed = true
  const polled = clock.advance(5000)
  await clock.settle()
  // A pick on the first question lands inside that poll's gap.
  const pressed = pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.settle()
  landed.open()
  await Promise.all([polled, pressed])
  await clock.settle()
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBeFalsy()
  await pane.unmount()
})

test('Gauntlet 4 B1 M23: a delivery marker whose write fails leaves no marker, so the next poll delivers the reply once', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: SELF })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 0)],
  ])
  // The marker's atomic write goes to its dot-named temp file (`d/.<name>.<random>.tmp`), so the torn write is that file.
  const { submits, clock } = stubHost(on, files, true, {}, { tornWriteTo: 'd/.q-l1-aaaaaa.json.' })
  await $.session.start(SESSION)
  await clock.advance(5000)
  expect(files.has(path('d', 'q-l1-aaaaaa'))).toBe(false)
  expect(submits).toEqual([])
  await clock.advance(5000)
  expect(submits).toHaveLength(1)
  expect(readJson(files, path('d', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', via: 'prompt' })
})

test('Gauntlet 5 B2 M12: a marker write that fails after another marker landed still hands the first reply, and toasts only the one left unmarked', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: SELF })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 0, { session: SELF })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 0)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A', 0)],
  ])
  // The second marker's temp file is cut off and its write throws; the first marker lands before it.
  const { submits, toasts, writes, clock } = stubHost(on, files, true, {}, { tornWriteTo: 'd/.q-l2-bbbbbb.json.' })
  await $.session.start(SESSION)
  await clock.advance(5000)
  expect(submits).toEqual(['Answered via panel by "unknown": B · "Rewrite". Askaway question q-l1-aaaaaa ("Title q-l1-aaaaaa"). (you were using A · "Keep")'])
  expect(writes).toEqual([path('d', 'q-l1-aaaaaa')])
  expect(toasts.filter(text => text.includes('q-l2-bbbbbb'))).toHaveLength(1)
  expect(toasts.some(text => text.includes('q-l1-aaaaaa'))).toBe(false)
  // The next poll hands the second reply, which has no marker yet.
  await clock.advance(5000)
  expect(submits).toHaveLength(2)
  expect(submits[1]).toContain('q-l2-bbbbbb')
})

test('Gauntlet 5 B3 M18: a hand-off whose submit throws keeps its markers, toasts each reply once, submits once and logs the failure', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: SELF })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 0, { session: SELF })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 0)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A', 0)],
  ])
  const holds: Holds = { failSubmitOnce: true }
  const { submits, toasts, logs, clock } = stubHost(on, files, true, {}, holds, { LANG: '' })
  await $.session.start(SESSION)
  await clock.advance(5000)
  expect(submits).toHaveLength(1)
  expect(files.has(path('d', 'q-l1-aaaaaa'))).toBe(true)
  expect(files.has(path('d', 'q-l2-bbbbbb'))).toBe(true)
  expect(toasts).toHaveLength(2)
  expect(toasts).toContain(t('en', 'toast.undelivered', { key: 'B', id: 'q-l1-aaaaaa' }))
  expect(toasts).toContain(t('en', 'toast.undelivered', { key: 'A', id: 'q-l2-bbbbbb' }))
  // The failed submit is logged once, and the log names the call that failed (the engine's wording for it is not pinned).
  expect(logs).toHaveLength(1)
  expect(logs[0]).toMatch(/^askaway: .*prompt\.submit/)
  // No retry: the markers are there, so the next poll hands nothing and submits nothing.
  await clock.advance(5000)
  expect(submits).toHaveLength(1)
  expect(toasts).toHaveLength(2)
})

// Gauntlet 5 review R4: the marker is published by one no-clobber link (`ln temp marker`). A `-f` would clobber another window's marker.
test('Gauntlet 5 review R4: a delivery marker is published by ln temp marker, with no -f', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: SELF })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 0)],
  ])
  const { links, submits, clock } = stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  await clock.advance(5000)
  expect(submits).toHaveLength(1)
  expect(links.map(argv => [argv[0], argv.length, argv[2]])).toEqual([['ln', 3, path('d', 'q-l1-aaaaaa')]])
})

// Gauntlet 5 review R12: a reply whose marker another window wrote after the board was read is skipped, so a failed submit
// toasts only the reply this window marked.
test('Gauntlet 5 review R12: a hand-off whose submit throws toasts only the replies it marked, not one another window marked first', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: SELF })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 0, { session: SELF })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', 0)],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A', 0)],
  ])
  const holds: Holds = {
    failSubmitOnce: true,
    onLink: marker => {
      if (marker === path('d', 'q-l1-aaaaaa')) files.set(path('d', 'q-l2-bbbbbb'), delivery('q-l2-bbbbbb', { session: 'hook' }))
    },
  }
  const { submits, toasts, clock } = stubHost(on, files, true, {}, holds, { LANG: '' })
  await $.session.start(SESSION)
  await clock.advance(5000)
  expect(submits).toHaveLength(1)
  expect(toasts).toEqual([t('en', 'toast.undelivered', { key: 'B', id: 'q-l1-aaaaaa' })])
})

test('Gauntlet 5 B2 M32: a reply past the 7-day TTL is not handed to its session, as the status shows it expired', async ($, on) => {
  // Stamped more than the TTL before the clock's start: the reply is past its lapse when the session starts.
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 0, { session: SELF })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B', -ANSWER_TTL_MS - 60_000)],
  ])
  const { submits, writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  expect(submits).toEqual([])
  expect(writes).toEqual([])
  expect(files.has(path('d', 'q-l1-aaaaaa'))).toBe(false)
})

test('Gauntlet 5 B2 M33: a panel token file that cannot be made is named by no file and no path in the log', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { calls, logs } = stubHost(on, files, true, {}, { installExit: 1 })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await pane.press({ key: 'submit-all' })
  expect(calls).toEqual([])
  expect(logs.some(line => line.includes('could not create the panel token file'))).toBe(true)
  // The token file's name is the secret: neither the folder, the file's path nor a 32-character hex name reaches the log.
  expect(logs.join('\n')).not.toMatch(/panel-tokens|[0-9a-f]{32}/)
  await pane.unmount()
})

test('Gauntlet 5 B2 M47: a torn cleared.json write leaves the previous file whole, so another window still hides the rows it lists', async ($, on) => {
  // A previous file that lists only an id no board knows, so the History row of q-l1 is still drawn for Clear all.
  const previousCleared = `${JSON.stringify({ ts: 100, ids: ['q-gone-cccccc'] })}\n`
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [`${STATE}/cleared.json`, previousCleared],
  ])
  stubHost(on, files, true, {}, { tornWriteTo: 'cleared.json' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'history-clear' })
  // The torn write cut the temp file, not cleared.json: the file another window reads is still the whole previous one.
  expect(files.get(`${STATE}/cleared.json`)).toBe(previousCleared)
  await pane.unmount()
})

test('Gauntlet 4 B1 M24: a failed read of away.json keeps the away state the pane had, so a toggle flips what the person sees', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [`${STATE}/away.json`, JSON.stringify({ on: true, ts: 1 })],
  ])
  const holds: Holds = {}
  const { clock } = stubHost(on, files, true, {}, holds, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  holds.failReadOf = `${STATE}/away.json`
  await clock.advance(5000)
  expect(await pane.find({ type: 'Text', text: /away mode on/ })).toBeDefined()
  expect(await run($, 'away')).toEqual({ text: 'Askaway away mode is off.' })
  expect(readJson(files, `${STATE}/away.json`)).toMatchObject({ on: false })
  await pane.unmount()
})

test('Gauntlet 4 B1 M25: a failed listing of the question folder keeps the board and the picks', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const holds: Holds = {}
  const { clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  holds.failListOf = `${STATE}/q`
  await clock.advance(5000)
  // Next on the last question opens the review, where Submit all is lit: both picks are kept.
  await pane.press({ key: 'nav-next' })
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(false)
  await pane.unmount()
})

test('Gauntlet 4 B1 M28: a tick that comes while a poll still runs starts no second poll', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = { listed: [] }
  const { clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const listing = gate()
  holds.listAnswers = listing.promise
  const from = holds.listed?.length ?? 0
  await clock.advance(5000)
  await clock.advance(5000)
  expect((holds.listed ?? []).slice(from).filter(dir => dir === `${STATE}/q`)).toHaveLength(1)
  listing.open()
  await clock.settle()
  await pane.unmount()
})

test('Gauntlet 4 B1 M34: an unknown /askaway verb names the four verbs, in English and in Portuguese', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  expect((await run($, 'list')).text).toBe('Use /askaway, /askaway lang pt-BR|en|auto, /askaway quiet on|off, /askaway who <name> or /askaway away.')
  await run($, 'lang pt')
  expect((await run($, 'list')).text).toBe('Digite /askaway, /askaway lang pt-BR|en|auto, /askaway quiet on|off, /askaway who <nome> ou /askaway away.')
})

test('Gauntlet 4 B1 M35: in a round of three, a failed reply keeps its pick and a second Submit all writes the one left', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000)],
  ])
  const holds: Holds = { refusedReplyId: 'q-l2-bbbbbb' }
  const { writes, toasts, clock } = stubHost(on, files, true, {}, holds, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l3-cccccc-B' })
  await clock.advance(350)
  // Next on the last question opens the review, which holds Submit all.
  await pane.press({ key: 'nav-next' })
  await pane.press({ key: 'submit-all' })
  await clock.settle()
  // The answered cards leave once their replies are written; the failed one comes back.
  await clock.advance(250)
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l3-cccccc')])
  expect(toasts).toEqual(['Could not send your reply; the question is still open.'])
  // The failed pick is still there: Submit all is enabled for the one question left.
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBeFalsy()
  holds.refusedReplyId = undefined
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l3-cccccc'), path('a', 'q-l2-bbbbbb')])
  await pane.unmount()
})

test('Gauntlet 4 B1 M44: a refused prune on an ended card shows the dismiss toast and keeps the card', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const { ended, toasts, clock } = stubHost(on, files, true, {}, { pruneExit: 1 }, { LANG: '' })
  ended.add('q-l1-aaaaaa')
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'dismiss-ended' })
  await clock.settle()
  expect(toasts).toEqual(['Could not dismiss the question; it is still listed.'])
  expect(files.has(path('q', 'q-l1-aaaaaa'))).toBe(true)
  expect(await pane.find({ type: 'Button', key: 'dismiss-ended' })).toBeDefined()
  await pane.unmount()
})

test('Gauntlet 4 B1 M47: a poll drops a draft pick for a question already replied: nothing is drawn and no wizard write occurs', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'A', 500)],
  ])
  const wizardWrites: string[] = []
  on('state.set', { plugin: 'askaway' }, (_$, e, next) => {
    if (e.key === 'wizard') wizardWrites.push(e.key)
    return next(e)
  })
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const before = wizardWrites.length
  files.set(`${STATE}/draft.json`, JSON.stringify({ ts: 100, picks: { 'q-l1-aaaaaa': { key: 'B' } } }))
  await clock.advance(5000)
  expect(wizardWrites.length - before).toBe(0)
  expect((await pane.find({ type: 'Button', key: 'submit-all' }))?.props.dimColor).toBe(true)
  await pane.unmount()
})

// gauntlet 4, package B2
test('gauntlet 4, B2 M12: an untitled question of emoji is drawn whole, its code points intact, so no lone surrogate is drawn', () => {
  const label = questionLabel(parsedQuestion('q-b2-aaaaaa', 1, { title: '', question: '🚀'.repeat(30) }))
  expect(label).toBe('🚀'.repeat(30))
  expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
})

test('gauntlet 4, B2 M13: the footer names an Other answer by its typed text, and by the Other label when it has none', () => {
  const now = 10 * FOOT_DAY
  const board: Board = {
    questions: [parsedQuestion('q-b2-000001', 1, { title: 'Pick the queue' })],
    answers: [answerOf('q-b2-000001', 'other', now - 12 * FOOT_MIN, 'lavanda')],
    delivered: [],
  }
  expect(footerText('en', board, now)).toContain('last: Pick the queue → “lavanda”, 12 min ago')
  expect(footerText('pt', board, now)).toContain('última: Pick the queue → “lavanda”, há 12 min')
  expect(footerText('en', board, now)).not.toContain('other')
  const gone: Board = { questions: [], answers: board.answers, delivered: [] }
  expect(footerText('en', gone, now)).toContain('last: Question closed → “lavanda”, 12 min ago')
  const blank: Board = { questions: [], answers: [answerOf('q-b2-000001', 'other', now - 12 * FOOT_MIN)], delivered: [] }
  expect(footerText('pt', blank, now)).toContain('última: Pergunta encerrada → Outra…, há 12 min')
})

// beta.35, item 1: a clipped title (the CLI's 60 characters, its last one "…") is drawn whole in the tree row, the card title row
// and the new-question toast. The card body draws the whole question too, so each surface is checked by its own key.
test('beta.35 item 1: a clipped title is drawn whole in the tree row, the card title row and the new-question toast', async ($, on) => {
  const files = new Map([
    [path('q', 'q-t1-aaaaaa'), question('q-t1-aaaaaa', 1000, { title: CLIPPED_TITLE, question: CLIPPED_TEXT })],
    [path('q', 'q-t2-bbbbbb'), question('q-t2-bbbbbb', 500, { title: CLIPPED_TITLE, question: CLIPPED_TEXT })],
    [path('a', 'q-t2-bbbbbb'), answer('q-t2-bbbbbb', 'A', 400)],
  ])
  const { toasts, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // The question on screen has no tree link: its tree row is plain text, the whole question as its label.
  expect((await textsOf(pane)).includes(`● ${CLIPPED_TEXT}`)).toBe(true)
  expect((await textsOf(pane)).includes(CLIPPED_TEXT)).toBe(true)
  expect((await textsOf(pane)).some(text => text.startsWith(`○ ${CLIPPED_TEXT} ✓ Keep · enviada `))).toBe(true)
  files.set(path('q', 'q-t3-cccccc'), question('q-t3-cccccc', 3000, { title: CLIPPED_TITLE, question: CLIPPED_TEXT }))
  await clock.advance(5000)
  expect(toasts).toEqual([`Nova pergunta: ${CLIPPED_TEXT}`])
  await pane.unmount()
})

test('beta.35 item 2: a History row on the desktop is plain text with the whole title and the option label, and names no session', async ($, on) => {
  const family = { family: 'local_root', family_title: 'release checklist review' }
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'cli-1', desktop_session: 'local_root', session_title: 'release checklist review', ...family })],
    [path('a', 'q-l1-aaaaaa'), answer('q-l1-aaaaaa', 'B')],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  stubHost(on, files, true, {}, {}, { LANG: 'en_US.UTF-8' })
  await $.session.start(SESSION)
  const pane = await mountPane($, 'desktop')
  const texts = await textsOf(pane)
  expect(texts.some(text => text.startsWith('○ Title q-l1-aaaaaa ✓ Rewrite · sent '))).toBe(true)
  expect(texts.some(text => text.startsWith('○ ') && /Release Checklist|Resposta|Answer/.test(text))).toBe(false)
  await pane.unmount()
})

// beta.35, item 3: the Desktop sidebar groups (claude_desktop_config.json, preferences.epitaxyPrefs) name the tree and the History.
const DESKTOP_CONFIG = '/test-home/.config/Claude/claude_desktop_config.json'
const desktopConfig = (groups: unknown[], assignments: Record<string, string>): string =>
  JSON.stringify({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': { 'acc/org': { groups, assignments } } } } })
const sessionQuestion = (id: string, ts: number, session: string, family: string, familyTitle: string): string =>
  question(id, ts, { desktop_session: session, family, family_title: familyTitle, session: `cli-${id}`, session_title: `Session ${session}` })

test('beta.35 item 3: two questions from sessions in the group "Claude Global" draw under one "Claude Global" header, not under their family titles', async ($, on) => {
  const files = new Map([
    [DESKTOP_CONFIG, desktopConfig([{ id: 'cg-1', name: 'Claude Global' }], { 'code:local_s1': 'cg-1', 'code:local_s2': 'cg-1' })],
    [path('q', 'q-g1-aaaaaa'), sessionQuestion('q-g1-aaaaaa', 1000, 'local_s1', 'local_root1', 'Family One')],
    [path('q', 'q-g2-bbbbbb'), sessionQuestion('q-g2-bbbbbb', 2000, 'local_s2', 'local_root2', 'Family Two')],
  ])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const texts = await textsOf(pane)
  expect(texts.filter(text => text === 'Claude Global')).toHaveLength(1)
  expect(texts).not.toContain('Family One')
  expect(texts).not.toContain('Family Two')
  await pane.unmount()
})

test('beta.35 item 3: a session filed in a group moves on the next poll after the config mtime changes; a rewrite with the same mtime is not read', async ($, on) => {
  const mtimes = new Map([[DESKTOP_CONFIG, 1000]])
  const files = new Map([
    [DESKTOP_CONFIG, desktopConfig([{ id: 'cg-1', name: 'Claude Global' }], {})],
    [path('q', 'q-g1-aaaaaa'), sessionQuestion('q-g1-aaaaaa', 1000, 'local_s1', 'local_root1', 'Family One')],
  ])
  const { clock } = stubHost(on, files, true, {}, { mtimes })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Family One')
  files.set(DESKTOP_CONFIG, desktopConfig([{ id: 'cg-1', name: 'Claude Global' }], { 'code:local_s1': 'cg-1' }))
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Family One')
  mtimes.set(DESKTOP_CONFIG, 2000)
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Claude Global')
  expect(await textsOf(pane)).not.toContain('Family One')
  await pane.unmount()
})

test('beta.35 item 3: a malformed config, or one of another shape, draws the tree as before and logs and toasts nothing', async ($, on) => {
  const mtimes = new Map([[DESKTOP_CONFIG, 1000]])
  const files = new Map([
    [DESKTOP_CONFIG, '{"preferences": '],
    [path('q', 'q-g1-aaaaaa'), sessionQuestion('q-g1-aaaaaa', 1000, 'local_s1', 'local_root1', 'Family One')],
  ])
  const { clock, logs, toasts } = stubHost(on, files, true, {}, { mtimes })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Family One')
  files.set(DESKTOP_CONFIG, JSON.stringify({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': ['not', 'a', 'scope'] } } }))
  mtimes.set(DESKTOP_CONFIG, 2000)
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Family One')
  expect(logs).toEqual([])
  expect(toasts).toEqual([])
  await pane.unmount()
})

test("beta.35 item 3: a session in no group falls back to its family title, and a session with no group of its own takes its family root's group", async ($, on) => {
  const override = '/test-desktop/claude_desktop_config.json'
  const files = new Map([
    [override, desktopConfig([{ id: 'cg-1', name: 'Claude Global' }], { 'code:local_root1': 'cg-1' })],
    [path('q', 'q-g1-aaaaaa'), sessionQuestion('q-g1-aaaaaa', 1000, 'local_s9', 'local_root1', 'Family One')],
    [path('q', 'q-g2-bbbbbb'), sessionQuestion('q-g2-bbbbbb', 2000, 'local_s8', 'local_root2', 'Family Two')],
  ])
  stubHost(on, files, true, {}, {}, { ASKAWAY_DESKTOP_CONFIG: override })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const texts = await textsOf(pane)
  expect(texts.filter(text => text === 'Claude Global')).toHaveLength(1)
  expect(texts).toContain('Family Two')
  expect(texts).not.toContain('Family One')
  await pane.unmount()
})

test('beta.35 item 3: a question in a Desktop group is grouped and labelled by that group; only a family root outside a group is a root session', () => {
  const grouped = { ...parsedQuestion('q-dg-000004', 10, { family: 'local_root1', family_title: 'Family One', desktop_session: 'local_root1' }), desktop_group: { id: 'cg-1', name: 'Claude Global' } }
  expect(groupKeyOf(grouped)).toBe('cg-1')
  expect(groupLabelOf(grouped, 'en')).toBe('Claude Global')
  expect(isRootSession(grouped)).toBe(false)
  expect(isRootSession(parsedQuestion('q-dg-000005', 10, { family: 'local_root1', family_title: 'Family One', desktop_session: 'local_root1' }))).toBe(true)
})

test('beta.35 item 3: parseDesktopGroups reads the groups of every scope and fails open to none; withDesktopGroup takes the session group, else its family root group', () => {
  const groups = parseDesktopGroups({
    preferences: {
      epitaxyPrefs: {
        'dframe-group-scopes': {
          'acc/org': { groups: [{ id: 'cg-1', name: 'Claude Global' }], assignments: { 'code:local_s1': 'cg-1', 'other:local_s3': 'cg-1' } },
          'acc2/org': { groups: [{ id: 'cg-2', name: 'Other' }], assignments: { 'code:local_root2': 'cg-2' } },
        },
      },
    },
  })
  const inGroup = parsedQuestion('q-dg-000001', 1, { desktop_session: 'local_s1', family: 'local_root1' })
  expect(withDesktopGroup(inGroup, groups).desktop_group).toEqual({ id: 'cg-1', name: 'Claude Global' })
  const byFamily = parsedQuestion('q-dg-000002', 2, { desktop_session: 'local_s9', family: 'local_root2' })
  expect(withDesktopGroup(byFamily, groups).desktop_group).toEqual({ id: 'cg-2', name: 'Other' })
  const none = parsedQuestion('q-dg-000003', 3, { desktop_session: 'local_s9', family: 'local_none' })
  expect(withDesktopGroup(none, groups).desktop_group).toBeUndefined()
  expect(groups.assignments.has('local_s3')).toBe(false)
  expect(parseDesktopGroups({ preferences: 'x' }).names.size).toBe(0)
  expect(parseDesktopGroups({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': { a: { groups: 'x', assignments: [] } } } } }).names.size).toBe(0)
})

test('gauntlet 4, B2 M21: a title with a line break draws one footer line', () => {
  const now = 10 * FOOT_DAY
  const board: Board = {
    questions: [parsedQuestion('q-b2-000002', 1, { title: 'Pick\nthis' })],
    answers: [answerOf('q-b2-000002', 'A', now - 12 * FOOT_MIN)],
    delivered: [],
  }
  const text = footerText('en', board, now)
  expect(text).toContain('last: Pick this → Keep, 12 min ago')
  expect(text).not.toContain('\n')
})

test('gauntlet 4, B2 M21: a question with an empty title toasts its text, and a title with a line break toasts one line', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { toasts, clock } = stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  files.set(path('q', 'q-l5-eeeeee'), question('q-l5-eeeeee', 3000, { title: '', question: 'Which parser?' }))
  await clock.advance(5000)
  expect(toasts).toEqual(['New question: Which parser?'])
  files.set(path('q', 'q-l6-ffffff'), question('q-l6-ffffff', 4000, { title: 'Pick\nthis' }))
  await clock.advance(5000)
  expect(toasts).toEqual(['New question: Which parser?', 'New question: Pick this'])
})

test('gauntlet 4, B2 M32: the Urgency title names the grade word in English', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { urgency: 'Blocks in ~8 min', urgency_level: 'high' })]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('⏱️ Urgency (high): ')
  await pane.unmount()
})

test('gauntlet 4, B2 M32: the Urgency title names the grade word in Portuguese, and the text keeps the colour of its grade', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { urgency: 'Blocks in ~8 min', urgency_level: 'medium' })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('⏱️ Urgência (média): ')
  const nodes = nodesOf(await pane.drawn())
  const bodyNode = nodes.find(node => node.type === 'Text' && Array.isArray(node.children) && node.children.includes('Blocks in ~8 min'))
  expect((bodyNode?.props as Record<string, unknown> | undefined)?.color).toBe('warning')
  await pane.unmount()
})

test('gauntlet 4, B2 M42: the picked option carries a ✓ in its label, and no other option does', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-A')).toBe('A · ✓ Keep (Recommended)')
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-B')).toBe('B · Rewrite')
  await pane.unmount()
})

test('gauntlet 4, B2 M26: an option label with line breaks draws as one row, so it cannot make a fake option row', async ($, on) => {
  const options = [
    { key: 'A', label: 'Ship now\n\nB · Fake row', tradeoff: 'cheap', fit: 80 },
    { key: 'B', label: 'Rewrite', tradeoff: 'slow', fit: 40 },
  ]
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { options })]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-A')).toBe('A · Ship now B · Fake row (Recommended)')
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-B')).toBe('B · Rewrite')
  expect((await textsOf(pane)).some(text => text.includes('\n'))).toBe(false)
  await pane.unmount()
})

// Gauntlet 5 M15 (owner reply C): a damaged q/ file that pauses its session draws a notice naming its id, with Dismiss.
const DAMAGED_TEXT = '{"id":"q-l1-aaaaaa","session":"sess-live","ts":1000,"title":'

test('Gauntlet 5 M15: a damaged q/ file that pauses its session draws a notice naming its id, with Dismiss, on both surfaces', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), DAMAGED_TEXT]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    expect(await textNodeWith(pane, 'Question q-l1-aaaaaa is damaged')).toBeDefined()
    expect(await labelOf(pane, 'dismiss-damaged-q-l1-aaaaaa')).toBe('Dismiss (removes)')
    await pane.unmount()
  }
})

test('Gauntlet 5 M15: Dismiss on a damaged pause runs prune --id --strict without --force, removes the file, and the notice is gone at the next poll', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), DAMAGED_TEXT]])
  const { calls, clock } = stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'dismiss-damaged-q-l1-aaaaaa' })
  expect(calls.map(call => call.argv.slice(2).join(' '))).toContain('prune --id q-l1-aaaaaa --strict')
  expect(files.has(path('q', 'q-l1-aaaaaa'))).toBe(false)
  await clock.advance(5000)
  expect(await pane.find({ type: 'Button', key: 'dismiss-damaged-q-l1-aaaaaa' })).toBeUndefined()
  await pane.unmount()
})

test('Gauntlet 5 M15: a damaged q/ file draws no notice when it names no session, or when it is already answered', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), '{"id":"q-l1-aaaaaa","ts":1000,"title":'],
    [path('q', 'q-l2-bbbbbb'), '{"id":"q-l2-bbbbbb","session":"sess-live","ts":2000,"title":'],
    [path('a', 'q-l2-bbbbbb'), answer('q-l2-bbbbbb', 'A')],
  ])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', key: 'dismiss-damaged-q-l1-aaaaaa' })).toBeUndefined()
  expect(await pane.find({ type: 'Button', key: 'dismiss-damaged-q-l2-bbbbbb' })).toBeUndefined()
  await pane.unmount()
})

// Should-4 (F4): the damaged Dismiss does not force the prune. A file the CLI reads as a question (a stored NaN literal) is refused
// by the CLI, so the person is told by a toast and the notice stays.
test('Gauntlet 5 F4 Should-4: Dismiss on a damaged pause whose prune the CLI refuses keeps the notice and shows the dismiss toast', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), DAMAGED_TEXT]])
  const { calls, toasts, clock } = stubHost(on, files, true, {}, { pruneExit: 1 }, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'dismiss-damaged-q-l1-aaaaaa' })
  await clock.settle()
  expect(calls.map(call => call.argv.slice(2).join(' '))).toContain('prune --id q-l1-aaaaaa --strict')
  expect(toasts).toEqual(['Could not dismiss the question; it is still listed.'])
  expect(files.has(path('q', 'q-l1-aaaaaa'))).toBe(true)
  expect(await pane.find({ type: 'Button', key: 'dismiss-damaged-q-l1-aaaaaa' })).toBeDefined()
  await pane.unmount()
})

// Should-5 (F4): damagedPauseOf pins. Each file below must draw no notice; breaking the guard named in each test turns it red.
// (a) a file the CLI reads as a question (id and integer ts), with no required options: readsAsQuestion keeps it out.
test('Gauntlet 5 F4 Should-5 a: a q/ file the CLI reads as a question, without required options, draws no damaged notice', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-live', options: [] })]])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', key: 'dismiss-damaged-q-l1-aaaaaa' })).toBeUndefined()
  await pane.unmount()
})

// (b) a q/ file with a d/ delivery marker: deliveredIds keeps it out.
test('Gauntlet 5 F4 Should-5 b: a damaged q/ file with a d/ delivery marker draws no damaged notice', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), DAMAGED_TEXT],
    [path('d', 'q-l1-aaaaaa'), delivery('q-l1-aaaaaa')],
  ])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', key: 'dismiss-damaged-q-l1-aaaaaa' })).toBeUndefined()
  await pane.unmount()
})

// (c) a damaged q/ file whose session fails SESSION_NAME (a space in it): the file pauses nothing.
test('Gauntlet 5 F4 Should-5 c: a damaged q/ file whose session name fails the session pattern draws no damaged notice', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), '{"id":"q-l1-aaaaaa","session":"sess live","ts":1000,"title":']])
  stubHost(on, files, true, {}, {}, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', key: 'dismiss-damaged-q-l1-aaaaaa' })).toBeUndefined()
  await pane.unmount()
})

// beta.35 review fixes: a failed read keeps the last good Desktop groups, a History group of a Desktop group is plain text, and
// the title and answer rules of the History and the footer hold on their edge cases.
const DESKTOP_FOLDER = '/test-home/.config/Claude'
const WINDOW_STATE = `${DESKTOP_FOLDER}/window-state.json`
const GOOD_GROUPS = [{ id: 'cg-1', name: 'Claude Global' }]
const RENAMED_GROUPS = [{ id: 'cg-1', name: 'Renamed' }]
const markdownOf = async (pane: Awaited<ReturnType<typeof mountPane>>): Promise<string[]> =>
  nodesOf(await pane.drawn())
    .filter(node => node.type === 'Markdown')
    .map(node => String((node.props as Record<string, unknown>).text))

test('beta.35 review fix 1: two sessions of one Desktop group draw the group name as plain text, never a link to one family root', async ($, on) => {
  const files = new Map([
    [DESKTOP_CONFIG, desktopConfig(GOOD_GROUPS, { 'code:local_s1': 'cg-1', 'code:local_s2': 'cg-1' })],
    [path('q', 'q-g1-aaaaaa'), sessionQuestion('q-g1-aaaaaa', 1000, 'local_s1', 'local_root1', 'Family One')],
    [path('a', 'q-g1-aaaaaa'), answer('q-g1-aaaaaa', 'A')],
    [path('q', 'q-g2-bbbbbb'), sessionQuestion('q-g2-bbbbbb', 2000, 'local_s2', 'local_root2', 'Family Two')],
    [path('a', 'q-g2-bbbbbb'), answer('q-g2-bbbbbb', 'B')],
    [path('q', 'q-g3-cccccc'), question('q-g3-cccccc', 3000)],
  ])
  stubHost(on, files, true, {}, {}, { LANG: 'en_US.UTF-8' })
  await $.session.start(SESSION)
  const pane = await mountPane($, 'desktop')
  expect((await textsOf(pane)).filter(text => text === 'Claude Global')).toHaveLength(1)
  expect((await markdownOf(pane)).some(text => text.includes('Claude Global') && text.includes('(#local_'))).toBe(false)
  await pane.unmount()
})

test('beta.35 review fix 2: a failed listing of the config folder keeps the last good groups; the poll neither throws nor logs', async ($, on) => {
  const mtimes = new Map([[DESKTOP_CONFIG, 1000]])
  const holds: Holds = { mtimes }
  const files = new Map([
    [DESKTOP_CONFIG, desktopConfig(GOOD_GROUPS, { 'code:local_s1': 'cg-1' })],
    [path('q', 'q-g1-aaaaaa'), sessionQuestion('q-g1-aaaaaa', 1000, 'local_s1', 'local_root1', 'Family One')],
  ])
  const { clock, logs, toasts } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Claude Global')
  holds.failListOf = DESKTOP_FOLDER
  files.set(DESKTOP_CONFIG, desktopConfig(RENAMED_GROUPS, { 'code:local_s1': 'cg-1' }))
  mtimes.set(DESKTOP_CONFIG, 2000)
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Claude Global')
  expect(await textsOf(pane)).not.toContain('Renamed')
  expect(logs).toEqual([])
  expect(toasts).toEqual([])
  await pane.unmount()
})

test('beta.35 review fix 2: an unreadable config keeps the last good groups, and the cache is not written on the failed read', async ($, on) => {
  const mtimes = new Map([[DESKTOP_CONFIG, 1000]])
  const holds: Holds = { mtimes }
  const files = new Map([
    [DESKTOP_CONFIG, desktopConfig(GOOD_GROUPS, { 'code:local_s1': 'cg-1' })],
    [path('q', 'q-g1-aaaaaa'), sessionQuestion('q-g1-aaaaaa', 1000, 'local_s1', 'local_root1', 'Family One')],
  ])
  const { clock, logs } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Claude Global')
  holds.failReadOf = DESKTOP_CONFIG
  files.set(DESKTOP_CONFIG, desktopConfig(RENAMED_GROUPS, { 'code:local_s1': 'cg-1' }))
  mtimes.set(DESKTOP_CONFIG, 2000)
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Claude Global')
  expect(logs).toEqual([])
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Renamed')
  expect(await textsOf(pane)).not.toContain('Claude Global')
  await pane.unmount()
})

test('beta.35 review fix 2: a config that stops parsing keeps the last good groups; a config that is gone names none', async ($, on) => {
  const mtimes = new Map([[DESKTOP_CONFIG, 1000]])
  const files = new Map([
    [DESKTOP_CONFIG, desktopConfig(GOOD_GROUPS, { 'code:local_s1': 'cg-1' })],
    [path('q', 'q-g1-aaaaaa'), sessionQuestion('q-g1-aaaaaa', 1000, 'local_s1', 'local_root1', 'Family One')],
  ])
  const { clock, logs } = stubHost(on, files, true, {}, { mtimes })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Claude Global')
  files.set(DESKTOP_CONFIG, '{"preferences": ')
  mtimes.set(DESKTOP_CONFIG, 2000)
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Claude Global')
  files.delete(DESKTOP_CONFIG)
  await clock.advance(5000)
  expect(await textsOf(pane)).not.toContain('Claude Global')
  expect(await textsOf(pane)).toContain('Family One')
  expect(logs).toEqual([])
  await pane.unmount()
})

test('beta.35 review fix 5: a config over 4 MiB is skipped and keeps the last good groups', async ($, on) => {
  const mtimes = new Map([[DESKTOP_CONFIG, 1000]])
  const sizes = new Map([[DESKTOP_CONFIG, 1024]])
  const holds: Holds = { mtimes, sizes }
  const files = new Map([
    [DESKTOP_CONFIG, desktopConfig(GOOD_GROUPS, { 'code:local_s1': 'cg-1' })],
    [path('q', 'q-g1-aaaaaa'), sessionQuestion('q-g1-aaaaaa', 1000, 'local_s1', 'local_root1', 'Family One')],
  ])
  const { clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Claude Global')
  sizes.set(DESKTOP_CONFIG, 4 * 1024 * 1024 + 1)
  files.set(DESKTOP_CONFIG, desktopConfig(RENAMED_GROUPS, { 'code:local_s1': 'cg-1' }))
  mtimes.set(DESKTOP_CONFIG, 2000)
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Claude Global')
  expect(await textsOf(pane)).not.toContain('Renamed')
  await pane.unmount()
})

test('beta.35 review fix 5: a config over 4 MiB from the start names no group, and the tree draws as before', async ($, on) => {
  const holds: Holds = { sizes: new Map([[DESKTOP_CONFIG, 4 * 1024 * 1024 + 1]]) }
  const files = new Map([
    [DESKTOP_CONFIG, desktopConfig(GOOD_GROUPS, { 'code:local_s1': 'cg-1' })],
    [path('q', 'q-g1-aaaaaa'), sessionQuestion('q-g1-aaaaaa', 1000, 'local_s1', 'local_root1', 'Family One')],
  ])
  stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const texts = await textsOf(pane)
  expect(texts).toContain('Family One')
  expect(texts).not.toContain('Claude Global')
  await pane.unmount()
})

test('beta.35 review M21: the config reloads on its own mtime change; a sibling file in its folder, listed first, changes nothing', async ($, on) => {
  const mtimes = new Map([
    [WINDOW_STATE, 500],
    [DESKTOP_CONFIG, 1000],
  ])
  const files = new Map([
    [WINDOW_STATE, '{}'],
    [DESKTOP_CONFIG, desktopConfig(GOOD_GROUPS, { 'code:local_s1': 'cg-1' })],
    [path('q', 'q-g1-aaaaaa'), sessionQuestion('q-g1-aaaaaa', 1000, 'local_s1', 'local_root1', 'Family One')],
  ])
  const { clock } = stubHost(on, files, true, {}, { mtimes })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Claude Global')
  mtimes.set(WINDOW_STATE, 9000)
  files.set(DESKTOP_CONFIG, desktopConfig(RENAMED_GROUPS, { 'code:local_s1': 'cg-1' }))
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Claude Global')
  expect(await textsOf(pane)).not.toContain('Renamed')
  mtimes.set(DESKTOP_CONFIG, 2000)
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Renamed')
  await pane.unmount()
})

test('beta.35 review M32: a Desktop group whose name is not text is skipped, and the poll still draws the tree', async ($, on) => {
  const files = new Map([
    [DESKTOP_CONFIG, desktopConfig([{ id: 'cg-1', name: 123 }], { 'code:local_s1': 'cg-1' })],
    [path('q', 'q-g1-aaaaaa'), sessionQuestion('q-g1-aaaaaa', 1000, 'local_s1', 'local_root1', 'Family One')],
  ])
  const { logs } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await textsOf(pane)).toContain('Family One')
  expect(logs).toEqual([])
  await pane.unmount()
})

test('beta.35 review M24: a session filed in group A keeps group A when its family root is filed in group B', () => {
  const groups = parseDesktopGroups({
    preferences: {
      epitaxyPrefs: {
        'dframe-group-scopes': {
          'acc/org': {
            groups: [{ id: 'cg-1', name: 'Group A' }, { id: 'cg-2', name: 'Group B' }],
            assignments: { 'code:local_s1': 'cg-1', 'code:local_root2': 'cg-2' },
          },
        },
      },
    },
  })
  const session = parsedQuestion('q-n4-000001', 1, { desktop_session: 'local_s1', family: 'local_root2' })
  expect(withDesktopGroup(session, groups).desktop_group).toEqual({ id: 'cg-1', name: 'Group A' })
})

test('beta.35 review M30: an assignment under a prefix other than code: names no group', () => {
  const groups = parseDesktopGroups({
    preferences: {
      epitaxyPrefs: {
        'dframe-group-scopes': { 'acc/org': { groups: [{ id: 'cg-1', name: 'Claude Global' }], assignments: { 'chat:local_x': 'cg-1' } } },
      },
    },
  })
  expect(groups.assignments.has('local_x')).toBe(false)
  expect(withDesktopGroup(parsedQuestion('q-n4-000002', 1, { desktop_session: 'local_x' }), groups).desktop_group).toBeUndefined()
})

test('beta.35 review M34: a Desktop group with an empty or blank name is skipped, and its sessions keep their family', () => {
  const session = parsedQuestion('q-n4-000003', 1, { desktop_session: 'local_s1', family: 'local_root1', family_title: 'Family One' })
  for (const name of ['', '   ']) {
    const groups = parseDesktopGroups({
      preferences: {
        epitaxyPrefs: { 'dframe-group-scopes': { 'acc/org': { groups: [{ id: 'cg-1', name }], assignments: { 'code:local_s1': 'cg-1' } } } },
      },
    })
    expect(withDesktopGroup(session, groups).desktop_group).toBeUndefined()
  }
})

test('pane-exec3-2: a session whose group has no name takes its family root\'s named group, as SPEC says', () => {
  const session = parsedQuestion('q-n4-000012', 1, { desktop_session: 'local_s1', family: 'local_root1', family_title: 'Family One' })
  const groups = parseDesktopGroups({
    preferences: {
      epitaxyPrefs: {
        'dframe-group-scopes': {
          'acc/org': {
            groups: [{ id: 'cg-1', name: '' }, { id: 'cg-2', name: 'Claude Work' }],
            assignments: { 'code:local_s1': 'cg-1', 'code:local_root1': 'cg-2' },
          },
        },
      },
    },
  })
  expect(withDesktopGroup(session, groups).desktop_group).toEqual({ id: 'cg-2', name: 'Claude Work' })
})

test('beta.35 review M35: a Desktop group name is drawn on one line, its control and format characters gone', () => {
  const groups = parseDesktopGroups({
    preferences: {
      epitaxyPrefs: {
        'dframe-group-scopes': {
          'acc/org': { groups: [{ id: 'cg-1', name: 'Claude\nGlobal‮\u0007X' }], assignments: { 'code:local_s1': 'cg-1' } },
        },
      },
    },
  })
  const grouped = withDesktopGroup(parsedQuestion('q-n4-000004', 1, { desktop_session: 'local_s1' }), groups)
  expect(grouped.desktop_group).toEqual({ id: 'cg-1', name: 'Claude Global X' })
})

test('beta.35 review M37: a scope with no assignments, or assignments that are not an object, is skipped; the other scopes still apply', () => {
  const groups = parseDesktopGroups({
    preferences: {
      epitaxyPrefs: {
        'dframe-group-scopes': {
          'acc/none': { groups: [{ id: 'cg-2', name: 'Second' }] },
          'acc/num': { groups: [{ id: 'cg-3', name: 'Third' }], assignments: 5 },
          'acc/org': { groups: [{ id: 'cg-1', name: 'Claude Global' }], assignments: { 'code:local_s1': 'cg-1' } },
        },
      },
    },
  })
  expect(groups.names.get('cg-2')).toBe('Second')
  expect(groups.names.get('cg-3')).toBe('Third')
  expect(groups.assignments.get('local_s1')).toBe('cg-1')
})

test('beta.35 review M01: a title ending in "…" that does not start the question stays the title', () => {
  const title = `${'X'.repeat(59)}…`
  expect(questionLabel(parsedQuestion('q-n4-000005', 1, { title, question: CLIPPED_TEXT }))).toBe(title)
})

test('beta.35 review M02: a 60-character title with no "…" that starts the question stays the title', () => {
  const title = Array.from(CLIPPED_TEXT).slice(0, 60).join('')
  expect(questionLabel(parsedQuestion('q-n4-000006', 1, { title, question: CLIPPED_TEXT }))).toBe(title)
})

test('beta.35 review fix 6: a 20-character title ending in "…" that starts the question stays the title', () => {
  const title = `${Array.from(CLIPPED_TEXT).slice(0, 19).join('')}…`
  expect(Array.from(title)).toHaveLength(20)
  expect(questionLabel(parsedQuestion('q-n4-000007', 1, { title, question: CLIPPED_TEXT }))).toBe(title)
})

test('beta.35 review M36: the tree list names a clipped question by its whole question, not by its clipped title', () => {
  const clipped = parsedQuestion('q-n4-000008', 1, { title: CLIPPED_TITLE, question: CLIPPED_TEXT })
  const text = listText('en', [clipped], false)
  expect(text).toContain(CLIPPED_TEXT)
  expect(text).not.toContain(CLIPPED_TITLE)
})

test('beta.35 review M39: an answer whose key the question does not list is drawn as its key in capitals', () => {
  const at = localMs(10, 17, 14, 32)
  const board: Board = { questions: [parsedQuestion('q-n4-000009', 10)], answers: [answerOf('q-n4-000009', 'c', at)], delivered: [] }
  expect(historyOf('en', board, { ...NO_STATUS, now: SAME_DAY_NOW })[0]?.sessions[0]?.entries[0]?.line).toBe('C · sent 14:32')
})

test('beta.35 review M40: an option label with a line break is drawn on one line in the History row', () => {
  const question = parsedQuestion('q-n4-000010', 10, {
    options: [
      { key: 'A', label: 'Keep\nthis', tradeoff: 'cheap', fit: 80 },
      { key: 'B', label: 'Rewrite', tradeoff: 'slow', fit: 40 },
    ],
  })
  const board: Board = { questions: [question], answers: [answerOf('q-n4-000010', 'A', localMs(10, 17, 14, 32))], delivered: [] }
  expect(historyOf('en', board, { ...NO_STATUS, now: SAME_DAY_NOW })[0]?.sessions[0]?.entries[0]?.line).toBe('Keep this · sent 14:32')
})

test('beta.35 review M07: a History row and the footer name the option label of the pane language, from its translation', () => {
  const translated = parsedQuestion('q-n4-000011', 10, {
    title: 'Pick the queue',
    translations: { 'pt-BR': { options: { A: { label: 'Manter' } } } },
  })
  const at = localMs(10, 17, 14, 32)
  const board: Board = { questions: [translated], answers: [answerOf('q-n4-000011', 'A', at)], delivered: [] }
  expect(historyOf('pt', board, { ...NO_STATUS, now: SAME_DAY_NOW })[0]?.sessions[0]?.entries[0]?.line).toBe('Manter · enviada 14:32')
  expect(historyOf('en', board, { ...NO_STATUS, now: SAME_DAY_NOW })[0]?.sessions[0]?.entries[0]?.line).toBe('Keep · sent 14:32')
  const now = 10 * FOOT_DAY
  const footer: Board = { questions: [translated], answers: [answerOf('q-n4-000011', 'A', now - 12 * FOOT_MIN)], delivered: [] }
  expect(footerText('pt', footer, now)).toContain('última: Pick the queue → Manter, há 12 min')
})

test('pane-conc5-1: a focus move onto Submit all keeps the pending Other text, so with a kept label Submit all still sends the typed text', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // Enter keeps the label; the field then gets a new text that is typed but not kept yet.
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
  await moveRing($, 'other-input-q-l1-aaaaaa-1')
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa-1', text: 'Typed reply', kind: 'change' })
  // The ring moves onto Submit all before the press: the focus move must not drop the typed text.
  await moveRing($, 'submit-all')
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', key: 'other', by: 'panel', text: 'Typed reply' })
  await pane.unmount()
})

test('pane-conc5-2: the card is dimmed before the ended-session list runs, so a press during that run sees it dimmed', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'cli-1' })]])
  let pane: Awaited<ReturnType<typeof mountPane>> | undefined
  const dimmedAtList: unknown[] = []
  // Only the list run of the press is read: `reading` is raised just before the press, and the first list run after it is that run.
  let reading = false
  let resolveRead: () => void = () => undefined
  const listRead = new Promise<void>(resolve => { resolveRead = resolve })
  // The recorder reads the card while the list run is in flight.
  const holds: Holds = { onList: async () => {
    if (pane === undefined || !reading) return
    reading = false
    dimmedAtList.push((await pane.find({ type: 'Box', key: 'card-q-l1-aaaaaa' }))?.props.borderDimColor)
    resolveRead()
  } }
  const { clock } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  pane = await mountPane($)
  // A list run that ran within the last 30 s is not run again, so the press waits for the next one.
  await clock.advance(31_000)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  reading = true
  await pane.press({ key: 'submit-all' })
  // The press returns before its list run reaches the stub, so the test waits for that read and for the answer after it.
  await listRead
  await clock.settle()
  expect(dimmedAtList).toEqual([true])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ id: 'q-l1-aaaaaa', key: 'B', by: 'panel' })
  await pane.unmount()
})

test('pane-exec3-1: a Desktop config change that moves the question on screen under a new group key keeps that question on the card', async ($, on) => {
  const mtimes = new Map([[DESKTOP_CONFIG, 1000]])
  const files = new Map([
    [DESKTOP_CONFIG, desktopConfig([{ id: 'g1', name: 'Desktop Group' }], {})],
    [path('q', 'q-h-cccccc'), question('q-h-cccccc', 100, { family: 'local_H', family_title: 'Family H', session: 'cli-h' })],
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { family: 'local_F', family_title: 'Family F', session: 'cli-1' })],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000, { family: 'local_F', family_title: 'Family F', session: 'cli-2' })],
  ])
  const { clock } = stubHost(on, files, true, {}, { mtimes })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // The card starts on q-h, the oldest group. A tree jump puts q-l2 on the card, in group F, the group the config change moves.
  await pressTreeLink(pane, 'jump', 'q-l2-bbbbbb')
  expect(await pane.find({ type: 'Box', key: 'card-q-l2-bbbbbb' })).toBeDefined()
  // The family's group key moves from its family to the Desktop group g1 under the same questions.
  files.set(DESKTOP_CONFIG, desktopConfig([{ id: 'g1', name: 'Desktop Group' }], { 'code:local_F': 'g1' }))
  mtimes.set(DESKTOP_CONFIG, 2000)
  await clock.advance(5000)
  expect(await pane.find({ type: 'Box', key: 'card-q-l2-bbbbbb' })).toBeDefined()
  expect(await pane.find({ type: 'Box', key: 'card-q-h-cccccc' })).toBeUndefined()
  await pane.unmount()
})

test('pane-rule1-1: the lead line gets its date at midnight, though the age label, History and footer read the same', async ($, on) => {
  // The fake clock starts at 0. The question was asked at 00:30 of the local day that holds 0; the clock is moved to 23:59 of
  // that day before the pane mounts, so the age reads "23 h ago" on both sides of midnight and only the lead's date can change.
  const dayStart = new Date(0)
  dayStart.setHours(0, 0, 0, 0)
  const nextMidnight = new Date(dayStart)
  nextMidnight.setDate(nextMidnight.getDate() + 1)
  const asked = dayStart.getTime() + 30 * 60_000
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', asked, { recommended: 'B' })]])
  const { clock } = stubHost(on, files, true, {}, {}, { LANG: 'en_US.UTF-8' })
  await clock.advance(nextMidnight.getTime() - 60_000)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const leadOnCard = async (): Promise<string | undefined> => (await textsOf(pane)).find(text => text.startsWith('On B since '))
  expect(await leadOnCard()).toMatch(/^On B since 00:30\. /)
  await clock.advance(60_000)
  expect(await leadOnCard()).toMatch(/^On B since \d\d\/\d\d 00:30\. /)
  await pane.unmount()
})

test('pane-safe5-2: a press whose ended-session list does not run takes no reply: nothing is written and the person is told', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'cli-1' })]])
  const { writes, toasts } = stubHost(on, files, true, {}, { listExit: 1 })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  expect(toasts).toEqual(['Não foi possível enviar sua resposta; a pergunta continua aberta.'])
  await pane.unmount()
})

// Gauntlet 6 review R4: a `list --open` run that exits non-zero did not run, so the press refuses like an unparseable run and tells the person.
test('Gauntlet 6 review R4: a list --open run that exits non-zero refuses the reply, and the person is told', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const { toasts, writes } = stubHost(on, files, true, {}, { listExit: 1 }, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  expect(toasts).toEqual(['Could not send your reply; the question is still open.'])
  expect((await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).toBe('primary')
  await pane.unmount()
})

// Gauntlet 6 review R3: a `list --open` run that exits 0 but prints no list did not run, so the press refuses like a failed run.
test('Gauntlet 6 review R3: unparseable list --open output refuses the reply, and the person is told', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const { toasts, writes } = stubHost(on, files, true, {}, { listStdout: 'not a list' }, { LANG: '' })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([])
  expect(toasts).toEqual(['Could not send your reply; the question is still open.'])
  expect((await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' }))?.props.variant).toBe('primary')
  await pane.unmount()
})

// Gauntlet 7, round 1, package P2 (the pane).

test('gauntlet 7 own-1 model: optionLabelOf takes every recommended marker off the end of a label, in English and Portuguese, and keeps words', () => {
  const label = (text: string): string => optionLabelOf('en', { key: 'A', label: text })
  for (const marked of [
    'Keep (Recommended)',
    'Keep (recomendada)',
    'Keep (Recomendado)',
    'Keep [Recommended]',
    'Keep {recomendada}',
    'Keep ( Recommended )',
    'Keep - Recommended',
    'Keep -recomendada',
    'Keep – Recommended',
    'Keep — Recomendada',
    'Keep: recommended',
    'Keep (Recomendada)',
    'Keep (Recomendada) (Recomendada)',
    'Keep (Recommended) [Recomendada] - recommended',
    'Keep  (RECOMMENDED)  ',
  ]) {
    expect(label(marked)).toBe('Keep')
  }
  expect(label('Use the non-recommended path')).toBe('Use the non-recommended path')
  expect(label('Not recommended')).toBe('Not recommended')
  expect(label('Keep (not recommended)')).toBe('Keep (not recommended)')
  expect(label('Recommended')).toBe('Recommended')
  expect(label('Ship now\nB · Fake row')).toBe('Ship now B · Fake row')
})

test('gauntlet 7 own-1: the recommended option says its mark once in pt and en, whatever marker its label carries; another option draws none', async ($, on) => {
  const options = [
    { key: 'A', label: 'Keep (Recomendada)' },
    { key: 'B', label: 'Rewrite (Recommended) (Recommended)' },
    { key: 'C', label: 'Drop - Recomendado' },
  ]
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { options, recommended: 'B' })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-A')).toBe('A · Keep')
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-B')).toBe('B · Rewrite (Recomendada)')
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-C')).toBe('C · Drop')
  await run($, 'lang en')
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-B')).toBe('B · Rewrite (Recommended)')
  await pane.unmount()
})

test('gauntlet 7 own-1: a pt translation label that carries the marker draws it once', async ($, on) => {
  const translations = { 'pt-BR': { options: { A: { label: 'Manter (Recomendada)' }, B: { label: 'Reescrever' } } } }
  const options = [{ key: 'A', label: 'Keep (Recommended)' }, { key: 'B', label: 'Rewrite' }]
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { translations, options })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-A')).toBe('A · Manter (Recomendada)')
  await run($, 'lang en')
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-A')).toBe('A · Keep (Recommended)')
  await pane.unmount()
})

test('gauntlet 7 own-1 model: History and the footer name a marked recommended label once, never doubled, in en and pt', () => {
  const now = 10 * FOOT_MIN
  const options = [{ key: 'A', label: 'Keep (Recomendada) (Recomendada)' }, { key: 'B', label: 'Rewrite' }]
  const board: Board = {
    questions: [parsedQuestion('q-o1-000001', 1, { title: 'Pick the queue', options })],
    answers: [answerOf('q-o1-000001', 'A', now - FOOT_MIN)],
    delivered: [],
  }
  for (const lang of ['en', 'pt'] as const) {
    const line = historyOf(lang, board, { ...NO_STATUS, now })[0]?.sessions[0]?.entries[0]?.line ?? ''
    expect(line.startsWith('Keep · ')).toBe(true)
    expect(footerText(lang, board, now)).toMatch(/ → Keep, /)
    expect(footerText(lang, board, now)).not.toMatch(/Recomendada|Recommended/)
  }
})

test('gauntlet 7 pane-exec3-1: with a kept label, Tab from the Other field onto Back, then Submit all, sends the text the field shows', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'First text' })
  // The click picks the kept label; then the person types a new text in the field under its new round and Tabs to Back.
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await moveRing($, 'other-input-q-l1-aaaaaa-1')
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa-1', text: 'Use a fork', kind: 'change' })
  await moveRing($, 'nav-back')
  // The blur records nothing under the kept label: the button still draws the label as the pick.
  expect(JSON.stringify(await pane.find({ type: 'Button', key: 'other-q-l1-aaaaaa' }))).toContain('✓ C · First text')
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'other', text: 'Use a fork' })
  await pane.unmount()
})

test('gauntlet 7 pane-exec3-1: with a kept label, Esc out of the Other field, then Submit all, sends the text the field shows', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const { writes } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'First text' })
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await moveRing($, 'other-input-q-l1-aaaaaa-1')
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa-1', text: 'Use a fork', kind: 'change' })
  await moveRing($)
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'other', text: 'Use a fork' })
  await pane.unmount()
})

test('gauntlet 7 pane-exec3-1: a text a kept label set aside is dropped once Next takes its field off screen: Submit all then sends the label', async ($, on) => {
  const files = new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'First text' })
  await pane.press({ key: 'other-q-l1-aaaaaa' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'opt-q-l2-bbbbbb-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'review-back' })
  await clock.advance(350)
  await pane.press({ key: 'nav-back' })
  await clock.advance(350)
  await moveRing($, 'other-input-q-l1-aaaaaa-1')
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa-1', text: 'Second text', kind: 'change' })
  await moveRing($, 'nav-next')
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  // The second question is the last one: its Next opens the review, where Submit all sends both answers.
  await pane.press({ key: 'nav-next' })
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
  expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'other', text: 'First text' })
  await pane.unmount()
})

test('gauntlet 7 pane-exec3-2: a list --open run that fails is logged with its exit code and stderr, as is one that cannot start or prints no list', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const faults: (() => unknown)[] = [
    () => {
      throw new Error('spawn python3 ENOENT')
    },
    () => ({ value: { exitCode: 2, stdout: '', stderr: 'askaway: state folder unreadable\n', isStdoutTruncated: false, isStderrTruncated: false } }),
    () => cliReply('not a list'),
  ]
  // Registered before the host stub: each `list` call takes the next fault.
  on('process.run', {}, (_$, e, next) => {
    const fault = e.argv[2] === 'list' ? faults.shift() : undefined
    return fault === undefined ? next(e) : fault()
  })
  const { logs, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  await clock.advance(5000)
  // A handler that throws is skipped by the kit, and the run rejects with the kit's own words: the log names the run that did not start.
  expect(logs).toHaveLength(3)
  expect(logs[0]?.startsWith('askaway: askaway list --open did not start: ')).toBe(true)
  expect(logs.slice(1)).toEqual([
    'askaway: askaway list --open failed (exit 2): askaway: state folder unreadable',
    'askaway: askaway list --open failed (exit 0): not a list',
  ])
})

test('gauntlet 7 pane-exec3-3: a written reply whose file does not read back takes the card off the board, and is not pressed twice', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const holds: Holds = {}
  const { writes, toasts, calls } = stubHost(on, files, true, {}, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  holds.failReadOf = path('a', 'q-l1-aaaaaa')
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
  expect(holds.failReadOf).toBeUndefined()
  expect(await pane.find({ type: 'Button', key: 'opt-q-l1-aaaaaa-B' })).toBeUndefined()
  expect(await pane.find({ type: 'Button', key: 'submit-all' })).toBeUndefined()
  expect(calls.filter(call => call.argv[2] === 'answer')).toHaveLength(1)
  expect(toasts).toEqual([])
  expect((await textsOf(pane)).some(text => text.startsWith('○ Title q-l1-aaaaaa ✓ Rewrite · enviada '))).toBe(true)
  await pane.unmount()
})

test('gauntlet 7 pane-exec3-4: a clipped title is drawn whole in the card title row itself, read by its own key', async ($, on) => {
  const files = new Map([[path('q', 'q-t1-aaaaaa'), question('q-t1-aaaaaa', 1000, { title: CLIPPED_TITLE, question: CLIPPED_TEXT })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  for (const surface of SURFACES) {
    const pane = await mountPane($, surface)
    const row = nodesOf(await pane.drawn()).find(node => keyOfNode(node) === 'title-q-t1-aaaaaa')
    const text = row?.type === 'Markdown' ? plainMarkdown(String((row.props as Record<string, unknown>).text)) : textOfNode(row)
    expect(text).toContain(CLIPPED_TEXT)
    expect(text).not.toContain(CLIPPED_TITLE)
    await pane.unmount()
  }
})

test('gauntlet 7 pane-conc5-1: a press runs its own list --open and refuses on it, though a poll stamps an older run as the press starts', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const pollList = gate()
  let isPollListHeld = false
  let nowsSincePress: number | undefined
  // Registered before the host stub. The poll's run waits for the gate, then prints the list from before the session ended.
  on('process.run', {}, async (_$, e, next) => {
    if (e.argv[2] !== 'list' || !isPollListHeld) return next(e)
    isPollListHeld = false
    await pollList.promise
    return cliReply(JSON.stringify({ items: [{ id: 'q-l1-aaaaaa' }] }))
  })
  // The poll's older run lands at the press's second clock read: the gap in which the press used to clear the throttle stamp.
  on('clock.now', {}, async (_$, e, next) => {
    if (nowsSincePress !== undefined) nowsSincePress += 1
    if (nowsSincePress === 2) {
      pollList.open()
      for (let tick = 0; tick < 50; tick++) await Promise.resolve()
    }
    return next(e)
  })
  const { writes, ended, calls, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  isPollListHeld = true
  await clock.advance(30_000)
  ended.add('q-l1-aaaaaa')
  const listRuns = calls.filter(call => call.argv[2] === 'list').length
  nowsSincePress = 0
  await pane.press({ key: 'submit-all' })
  pollList.open()
  await clock.settle()
  expect(writes).toEqual([])
  expect(calls.filter(call => call.argv[2] === 'list').length).toBe(listRuns + 1)
  await pane.unmount()
})

test('gauntlet 7 pane-conc5-2: the poll retry reports no failure while this window saves a pick under draft.lock, and the pick saves', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  const save = gate()
  let isSaveHeld = true
  const locks = new Set<string>()
  // Registered before the host stub: mkdir and rmdir hold and free draft.lock as on disk, and the pick's temp write waits.
  on('process.run', {}, (_$, e, next) => {
    const [command = '', target = ''] = e.argv
    if (command === 'mkdir') {
      if (locks.has(target)) return cliReply('', 1)
      locks.add(target)
      return cliReply('')
    }
    if (command === 'rmdir') {
      locks.delete(target)
      return cliReply('')
    }
    return command === 'find' ? cliReply('') : next(e)
  })
  on('fs.write', {}, async (_$, e, next) => {
    if (isSaveHeld && e.path.includes('.draft.json.')) {
      isSaveHeld = false
      await save.promise
    }
    return next(e)
  })
  const { toasts, drafts, logs, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
  await clock.advance(5000)
  expect(toasts).toEqual([])
  save.open()
  await clock.settle()
  await clock.advance(5000)
  expect(toasts).toEqual([])
  expect(logs).toEqual([])
  expect(JSON.parse(drafts[drafts.length - 1] ?? '{}').picks).toEqual({ 'q-l1-aaaaaa': { key: 'B' } })
  await pane.unmount()
})

test('gauntlet 7 pane-conc5-3: the poll after a Dismiss waits for the interval poll that is running, so a new question is toasted once', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  const holds: Holds = {}
  const { toasts, ended, clock } = stubHost(on, files, true, {}, holds)
  ended.add('q-l1-aaaaaa')
  await $.session.start(SESSION)
  const pane = await mountPane($)
  files.set(path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000))
  const listing = gate()
  holds.listAnswers = listing.promise
  await clock.advance(5000)
  // The interval poll waits on its a/ listing; the poll after the Dismiss lists nothing until that poll has ended.
  holds.listed = []
  await pane.press({ key: 'dismiss-ended' })
  await clock.settle()
  expect(holds.listed).toEqual([])
  listing.open()
  await clock.settle()
  // The interval poll goes on (its d/ listing), and the Dismiss poll lists the folder after it.
  expect(holds.listed[0]).toBe(`${STATE}/d`)
  expect(holds.listed.indexOf(`${STATE}/q`)).toBeGreaterThan(0)
  expect(toasts.filter(text => text.startsWith('Nova pergunta'))).toEqual(['Nova pergunta: Title q-l2-bbbbbb'])
  expect(files.has(path('q', 'q-l1-aaaaaa'))).toBe(false)
  await pane.unmount()
})

// Gauntlet 7, review-fix package P6 (the pane).

// The lines a session is handed for a reply whose file did not read back after the press, the polls not seeing it either:
// only the copy the press made stands for the reply, so the hand-off line names the who that copy carries.
async function handedUnreadReply($: Engine, on: On, stored: Record<string, unknown>, env: Record<string, string>): Promise<string[]> {
  const id = 'q-l1-aaaaaa'
  const files = new Map([[path('q', id), question(id, 1000, { session: SELF })]])
  const holds: Holds = {}
  const { submits, clock } = stubHost(on, files, true, stored, holds, env)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: `opt-${id}-B` })
  holds.failReadOf = path('a', id)
  await pane.press({ key: 'submit-all' })
  expect(holds.failReadOf).toBeUndefined()
  files.delete(path('a', id))
  await clock.advance(5000)
  await clock.advance(5000)
  await pane.unmount()
  return submits
}

const handedLineBy = (who: string): string =>
  `Answered via panel by ${JSON.stringify(who)}: B · "Rewrite". Askaway question q-l1-aaaaaa ("Title q-l1-aaaaaa"). (you were using A · "Keep")`

test('gauntlet 7 review F6: a written reply that does not read back is handed with the stored name, which the CLI stamps', async ($, on) => {
  expect(await handedUnreadReply($, on, { who: 'Ana' }, { ASKAWAY_WHO: 'Bia', USER: 'jdoe' })).toEqual([handedLineBy('Ana')])
})

test("gauntlet 7 review F6: with no stored name, the copy carries the window's ASKAWAY_WHO, cleaned as the CLI cleans it", async ($, on) => {
  expect(await handedUnreadReply($, on, {}, { ASKAWAY_WHO: '  Ana\tSilva  ', USER: 'jdoe' })).toEqual([handedLineBy('Ana Silva')])
})

test('gauntlet 7 review F6: a skipped name and no ASKAWAY_WHO give the OS user name, from the first of LOGNAME and USER that is set', async ($, on) => {
  expect(await handedUnreadReply($, on, { who: '' }, { LOGNAME: '', USER: 'jdoe', USERNAME: 'other' })).toEqual([handedLineBy('jdoe')])
})

test('gauntlet 7 review F7 model: optionLabelOf takes recommended markers off the start of a label, in English and Portuguese, and keeps a bare leading word', () => {
  const en = (text: string): string => optionLabelOf('en', { key: 'A', label: text })
  const pt = (text: string): string => optionLabelOf('pt', { key: 'A', label: text })
  for (const marked of [
    '(Recommended) Keep',
    '[Recommended] Keep',
    '{recommended} Keep',
    '( Recommended ) Keep',
    '(RECOMMENDED)Keep',
    'Recommended: Keep',
    'Recommended:Keep',
    'Recommended - Keep',
    'Recommended- Keep',
    'Recommended – Keep',
    'recommended — Keep',
    '(Recommended) Keep',
    'Recommended — Keep',
    '(Recommended) [Recommended] Recommended: Keep',
    '(Recommended) Keep (Recommended)',
  ]) {
    expect(en(marked)).toBe('Keep')
  }
  for (const marked of ['[Recomendada] Manter', '(recomendado) Manter', 'Recomendada — Manter', 'RECOMENDADA: Manter', '{Recomendada} (Recomendado) Manter']) {
    expect(pt(marked)).toBe('Manter')
  }
  for (const kept of ['Recommended settings', 'Recommended-only path', 'Recommendedly: Keep', 'Recomendadas: Manter', 'Not recommended: Keep']) {
    expect(en(kept)).toBe(kept)
  }
  // An old stored label that is only markers draws the pane's mark, in the pane's language, once.
  expect(en('(Recommended)')).toBe('(Recommended)')
  expect(pt('(Recommended)')).toBe('(Recomendada)')
  expect(en('Recommended:')).toBe('(Recommended)')
  expect(pt('[Recomendada] (Recommended)')).toBe('(Recomendada)')
  expect(en('')).toBe('')
})

test('gauntlet 7 review F7: a marker at the start of a label is drawn once on the button in pt and en, and a bare leading word stays', async ($, on) => {
  const options = [
    { key: 'A', label: 'Recomendada — Manter' },
    { key: 'B', label: '(Recommended) Rewrite' },
    { key: 'C', label: 'Recommended settings' },
  ]
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { options, recommended: 'B' })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-A')).toBe('A · Manter')
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-B')).toBe('B · Rewrite (Recomendada)')
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-C')).toBe('C · Recommended settings')
  await run($, 'lang en')
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-A')).toBe('A · Manter')
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-B')).toBe('B · Rewrite (Recommended)')
  await pane.unmount()
})

test('gauntlet 7 review F7: an old stored label that is only a marker draws the mark once on the button, with no double space, in pt and en', async ($, on) => {
  const options = [{ key: 'A', label: '(Recommended)' }, { key: 'B', label: 'Rewrite' }]
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { options, recommended: 'A' })]])
  stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-A')).toBe('A · (Recomendada)')
  await run($, 'lang en')
  expect(await labelOf(pane, 'opt-q-l1-aaaaaa-A')).toBe('A · (Recommended)')
  await pane.unmount()
})

test('gauntlet 7 review F7 model: History and the footer name a label marked at its start once, and an only-marker label as the mark, in en and pt', () => {
  const now = 10 * FOOT_MIN
  const options = [{ key: 'A', label: '[Recomendada] Keep' }, { key: 'B', label: '(Recommended)' }]
  const boardOf = (key: string): Board => ({
    questions: [parsedQuestion('q-o1-000001', 1, { title: 'Pick the queue', options })],
    answers: [answerOf('q-o1-000001', key, now - FOOT_MIN)],
    delivered: [],
  })
  const lineOf = (lang: 'en' | 'pt', key: string): string =>
    historyOf(lang, boardOf(key), { ...NO_STATUS, now })[0]?.sessions[0]?.entries[0]?.line ?? ''
  for (const lang of ['en', 'pt'] as const) {
    expect(lineOf(lang, 'A').startsWith('Keep · ')).toBe(true)
    expect(footerText(lang, boardOf('A'), now)).toMatch(/ → Keep, /)
    expect(footerText(lang, boardOf('A'), now)).not.toMatch(/Recomendada|Recommended/)
  }
  expect(lineOf('en', 'B').startsWith('(Recommended) · ')).toBe(true)
  expect(lineOf('pt', 'B').startsWith('(Recomendada) · ')).toBe(true)
  expect(footerText('en', boardOf('B'), now)).toMatch(/ → \(Recommended\), /)
  expect(footerText('pt', boardOf('B'), now)).toMatch(/ → \(Recomendada\), /)
})

test('gauntlet 7 review F8: a list --open run that keeps failing the same way is logged once, cut to 500 characters, and again once a run succeeds', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, { session: 'sess-gone' })]])
  let stderr = `askaway: ${'x'.repeat(5000)}\n`
  let isListFailing = true
  // Registered before the host stub: a `list` call fails with `stderr` while the test says so, else the stub lists.
  on('process.run', {}, (_$, e, next) => {
    if (e.argv[2] !== 'list' || !isListFailing) return next(e)
    return { value: { exitCode: 2, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const { logs, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  await clock.advance(5000)
  await clock.advance(5000)
  const detail = `failed (exit 2): askaway: ${'x'.repeat(5000)}`
  const cut = `askaway: askaway list --open ${detail.slice(0, 500)}…`
  expect(logs).toEqual([cut])
  // A run that succeeds ends the failure; the same failure after it is logged again, once (the next run is due 30 s later).
  isListFailing = false
  await clock.advance(5000)
  isListFailing = true
  await clock.advance(30_000)
  await clock.advance(5000)
  expect(logs).toEqual([cut, cut])
  // Another failure text is logged at once.
  stderr = 'askaway: state folder unreadable\n'
  await clock.advance(5000)
  expect(logs).toEqual([cut, cut, 'askaway: askaway list --open failed (exit 2): askaway: state folder unreadable'])
})
