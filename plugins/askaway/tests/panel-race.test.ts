// Cross-process race tests for the panel's answer path (hooks/register.tsx: answerViaCli, writeAnswer). The panel answers
// with `askaway.py answer --by panel`, whose create-once link decides between writers in different processes. The host
// stub stands for that CLI: a call lands only when no a/<id>.json exists at the moment it reaches its write, so an answer
// another process writes while the panel's call is in flight is never overwritten. The host stub is a copy of the one in
// race.test.ts: this file does not import that one, because importing a test file runs its tests again.
import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

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
const SELF = 'sess-self'
const QUESTION = 'q-cross-aaaaaa'

// A question as askaway.py writes it (SPEC.md), with two options.
function question(id: string, ts: number): string {
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
  })
}

const path = (dir: string, id: string): string => `${STATE}/${dir}/${id}.json`
const readJson = (files: Map<string, string>, file: string): Record<string, unknown> =>
  JSON.parse(files.get(file) ?? '{}') as Record<string, unknown>

// A gate the test can close: the CLI call waits at its write until the test releases it.
type Hold = { write?: Promise<void> }

// The hook's reply with the result `$.process.run` gives for a child that exited (the fields the pane reads).
const cliReply = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// The engine's calls, answered from an in-memory folder. `writes` records the answers that land; `calls` records every
// call the pane makes to the CLI.
function stubHost(on: On, files: Map<string, string>, hold: Hold = {}) {
  const writes: string[] = []
  const calls: { argv: string[]; env?: Record<string, string> }[] = []
  const clock = mock.clock(on)
  mock.env(on, { HOME })
  mock.store(on, {})
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn beneath'] }))
  on('fs.list', (_$, e) => {
    const prefix = `${e.path}/`
    const names = [...files.keys()].filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
    return { value: names.map(file => ({ name: file.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  // The panel answers through the CLI (process.run below); a direct write to a/ would bypass its first-writer-wins link.
  on('fs.write', (_$, e) => {
    if (e.path.includes('/panel-tokens/')) return { value: undefined } // the panel's one-shot credential
    throw new Error(`answer written directly: ${e.path}`)
  })
  // The CLI's `answer` (create_once): the call is held at its write, then lands only if no answer exists yet.
  on('process.run', async (_$, e) => {
    if (e.argv[0] !== 'python3') return cliReply('') // the token folder and mode
    calls.push({ argv: [...e.argv], env: e.init?.env })
    const [, , , id, key] = e.argv
    await hold.write
    const stored = files.get(path('a', id))
    if (stored !== undefined) return cliReply(JSON.stringify({ id, key: (JSON.parse(stored) as { key: string }).key, written: false }))
    files.set(path('a', id), `${JSON.stringify({ id, key, by: 'panel', ts: 0 })}\n`)
    writes.push(path('a', id))
    return cliReply(JSON.stringify({ id, key, written: true }))
  })
  return { writes, calls, clock }
}

// A promise a test releases by calling the returned function.
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {}
  const promise = new Promise<void>(resolve => {
    open = resolve
  })
  return { promise, open }
}

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'askaway', surface: 'terminal', component: 'Pane', requestId: 'askaway', props: PANE_PROPS })

test('a CLI answer that lands while the panel call is in flight is never overwritten, and the pane shows that winner', async ($, on) => {
  const files = new Map([[path('q', QUESTION), question(QUESTION, 1000)]])
  const hold: Hold = {}
  const { writes, calls, clock } = stubHost(on, files, hold)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: `opt-${QUESTION}-B` })
  const landed = gate()
  hold.write = landed.promise
  const press = ui.press({ key: 'submit-all' })
  await clock.settle()
  // The panel's call is in flight, held before its write.
  expect(calls).toHaveLength(1)
  // Another process answers now: its link lands first.
  files.set(path('a', QUESTION), `${JSON.stringify({ id: QUESTION, key: 'A', by: 'cli', ts: 900 })}\n`)
  landed.open()
  await press
  expect(writes).toEqual([])
  expect(readJson(files, path('a', QUESTION))).toMatchObject({ id: QUESTION, key: 'A', by: 'cli' })
  await clock.advance(250)
  expect(await ui.find({ type: 'Text', text: 'Answer A sent to App' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Answer B sent to App' })).toBeUndefined()
  await ui.unmount()
})

test('a won race writes the pane answer through the CLI and the pane shows its own key', async ($, on) => {
  const files = new Map([[path('q', QUESTION), question(QUESTION, 1000)]])
  const { writes, calls, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: `opt-${QUESTION}-B` })
  await ui.press({ key: 'submit-all' })
  expect(calls).toEqual([
    {
      argv: ['python3', expect.stringMatching(/\/scripts\/askaway\.py$/), 'answer', QUESTION, 'B', '--by', 'panel', '--strict'],
      env: { ASKAWAY_HOME: STATE, ASKAWAY_PANEL_TOKEN: expect.stringMatching(/^[0-9a-f]{32}$/) },
    },
  ])
  expect(writes).toEqual([path('a', QUESTION)])
  expect(readJson(files, path('a', QUESTION))).toMatchObject({ id: QUESTION, key: 'B', by: 'panel' })
  await clock.advance(250)
  expect(await ui.find({ type: 'Text', text: 'Answer B sent to App' })).toBeDefined()
  await ui.unmount()
})
