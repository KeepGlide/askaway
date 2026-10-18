// Race tests for the pane writer (hooks/register.tsx: answerEntry, writeAnswer, submitGroup). Many Submit all presses
// for one question at once must write its answer file once, and a failed write must release the guards it holds.
// The host stub is a copy of the one in askaway.test.ts: this file does not import that one, because importing a
// test file runs its tests again.
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
const QUESTION = 'q-race-aaaaaa'
const PRESSES = 20

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

// Gates a test can close: a write waits until the test releases it.
type Holds = { write?: Promise<void> }

// The engine's file calls, answered from an in-memory folder. `attempts` records every write that reaches the host,
// before any hold; `writes` records the writes that land. A read of a missing file rejects, as the host does.
function stubHost(on: On, files: Map<string, string>, holds: Holds = {}) {
  const attempts: string[] = []
  const writes: string[] = []
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
  // The CLI's `answer` (create_once): a call reaches the host, is held, then lands only if no answer exists yet.
  on('process.run', async (_$, e) => {
    if (e.argv[0] !== 'python3') return cliReply('') // the token folder and mode
    const [, , , id, key] = e.argv
    attempts.push(path('a', id))
    await holds.write
    const stored = files.get(path('a', id))
    if (stored !== undefined) return cliReply(JSON.stringify({ id, key: (JSON.parse(stored) as { key: string }).key, written: false }))
    files.set(path('a', id), `${JSON.stringify({ id, key, by: 'panel', ts: 0 })}\n`)
    writes.push(path('a', id))
    return cliReply(JSON.stringify({ id, key, written: true }))
  })
  return { attempts, writes, clock }
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

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'askaway', surface: 'terminal', component: 'Pane', requestId: 'askaway', props: PANE_PROPS })

test('race: 20 concurrent Submit all presses for one question write its answer file exactly once', async ($, on) => {
  const files = new Map([[path('q', QUESTION), question(QUESTION, 1000)]])
  const holds: Holds = {}
  const { attempts, writes, clock } = stubHost(on, files, holds)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: `opt-${QUESTION}-B` })
  const write = gate()
  holds.write = write.promise
  const presses = Array.from({ length: PRESSES }, () => ui.press({ key: 'submit-all' }))
  await clock.settle()
  // One write reached the host and is held; the other 19 presses were turned away before any write.
  expect(attempts).toEqual([path('a', QUESTION)])
  expect(writes).toEqual([])
  write.open()
  await Promise.all(presses)
  expect(writes).toEqual([path('a', QUESTION)])
  expect(readJson(files, path('a', QUESTION))).toMatchObject({ id: QUESTION, key: 'B', by: 'panel' })
  await ui.unmount()
})

test('race: when the first write fails, the guards are released and the next Submit all writes the answer once', async ($, on) => {
  const files = new Map([[path('q', QUESTION), question(QUESTION, 1000)]])
  const holds: Holds = {}
  const { attempts, writes, clock } = stubHost(on, files, holds)
  await $.session.start(SESSION)
  const ui = await mountPane($)
  await ui.press({ key: `opt-${QUESTION}-B` })
  let failWrite: (reason: Error) => void = () => {}
  holds.write = new Promise<void>((_resolve, reject) => {
    failWrite = reject
  })
  const presses = Array.from({ length: PRESSES }, () => ui.press({ key: 'submit-all' }))
  await clock.settle()
  failWrite(new Error('disk full'))
  await Promise.allSettled(presses)
  expect(attempts).toEqual([path('a', QUESTION)])
  expect(writes).toEqual([])
  expect(files.has(path('a', QUESTION))).toBe(false)
  holds.write = undefined
  // The failed card fades for FADE_MS (250) and a card that is fading takes no press: the retry waits for the fade.
  await clock.advance(250)
  await ui.press({ key: 'submit-all' })
  expect(attempts).toEqual([path('a', QUESTION), path('a', QUESTION)])
  expect(writes).toEqual([path('a', QUESTION)])
  expect(readJson(files, path('a', QUESTION))).toMatchObject({ id: QUESTION, key: 'B', by: 'panel' })
  await ui.unmount()
})
