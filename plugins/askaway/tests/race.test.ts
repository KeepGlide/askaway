// Race tests for the pane writer (hooks/register.tsx: answerEntry, writeAnswer, submitGroup) and the shared files it reads
// and writes (draft.json, cleared.json, the delivery markers). Many Submit all presses for one question at once must write
// its reply file once, and a failed write must release the guards it holds. The stub keeps the state folder in memory, the
// shared files included, so the race is isolated from the disk. The host stub is a copy of the one in askaway.test.ts:
// this file does not import that one, because importing a test file runs its tests again.
import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

const HOME = '/test-home'
const STATE = `${HOME}/.claude/state/askaway`
const DRAFT = `${STATE}/draft.json`
const DRAFT_LOCK = `${STATE}/draft.lock`
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
const OTHER_SESSION = 'sess-other'
const QUESTION = 'q-race-aaaaaa'
const OTHER_QUESTION = 'q-race-bbbbbb'
const PRESSES = 20
const BULK_QUESTIONS = 200
// hooks/register.tsx: a draft.json stamped more than this past the clock is not applied.
const DRAFT_SKEW_MS = 60_000

// A question as askaway.py writes it (SPEC.md), with two options. `session` is the session that asked it.
function question(id: string, ts: number, session: string | null = null): string {
  return JSON.stringify({
    v: 1,
    id,
    ts,
    project: '/work/app',
    session,
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
// The picks a draft.json holds, from its text.
const picksOf = (text: string | undefined): Record<string, unknown> =>
  (JSON.parse(text ?? '{}') as { picks: Record<string, unknown> }).picks
// The temp file of an atomic write of draft.json (writeAtomic: dot-named, random, .tmp).
const isDraftTemp = (file: string): boolean => file.startsWith(`${STATE}/.draft.json.`) && file.endsWith('.tmp')

// Gates and faults a test sets. A gate holds a call until the test releases it. `draftWriteOnce` holds only the next write of
// draft.json. `draftFull` makes every write of draft.json fail with no space, until the test clears it. `onTempWrite` runs
// before a temp file is written, so a test can change the folder between the pane's read and its write.
type Holds = {
  write?: Promise<void>
  draftWrite?: Promise<void>
  draftWriteOnce?: Promise<void>
  draftFull?: boolean
  onTempWrite?: (file: string) => void
  // The age in seconds of each lock folder. `find -mmin +N` reports a lock whose age is above N whole minutes (Gauntlet 5 review R8).
  lockAgeSeconds?: Map<string, number>
  // The draft.json temp files a crashed window left, which the sweep of a stale lock removes (`find ... -delete`).
  staleTemps?: Set<string>
  failListOf?: string
}

// The engine's file calls, answered from an in-memory folder. `attempts` records every reply write that reaches the host,
// before any hold; `writes` records the reply writes that land. `draftAttempts` records each write of draft.json (its temp
// file) and `drafts` the text that lands at draft.json; `submits` records each prompt. A read of a missing file rejects, as
// the host does, and a folder exists when a file lies under it. `locks` holds the directories `mkdir` made and not removed.
function stubHost(on: On, files: Map<string, string>, holds: Holds = {}) {
  const attempts: string[] = []
  const writes: string[] = []
  const draftAttempts: string[] = []
  const drafts: string[] = []
  const submits: string[] = []
  const locks = new Set<string>()
  // The argv of each stale-temp sweep (a find with -delete), in order.
  const sweeps: string[][] = []
  // The argv of each `ln` the pane makes (a delivery marker's no-clobber publish), in order (Gauntlet 5 review R4).
  const links: string[][] = []
  // Every file the plugin reads, in order: a poll's reads show which files it took.
  const reads: string[] = []
  const clock = mock.clock(on)
  mock.env(on, { HOME })
  mock.store(on, {})
  on('command.register', (_$, event) => ({ value: { command: event.name } }))
  on('session.start', (_$, event) => ({ cwd: event.cwd }))
  on('session.id', () => ({ value: SELF }))
  on('prompt.submit', (_$, event) => {
    submits.push(event.text)
    return { text: event.text }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn beneath'] }))
  on('fs.list', (_$, event) => {
    if (holds.failListOf === event.path) {
      holds.failListOf = undefined
      throw new Error(`EIO: cannot list ${event.path}`)
    }
    const prefix = `${event.path}/`
    const names = [...files.keys()].filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
    return { value: names.map(file => ({ name: file.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_$, event) => {
    reads.push(event.path)
    const text = files.get(event.path)
    if (text === undefined) throw new Error(`ENOENT: ${event.path}`)
    return { value: text }
  })
  on('fs.exists', (_$, event) => ({
    value: files.has(event.path) || [...files.keys()].some(file => file.startsWith(`${event.path}/`)),
  }))
  on('fs.write', async (_$, event) => {
    if (event.path.includes('/panel-tokens/')) return { value: undefined } // the panel's one-shot credential
    // The panel answers through the CLI (process.run below); a direct write to a/ would bypass its first-writer-wins link.
    if (event.path.startsWith(`${STATE}/a/`)) throw new Error(`answer written directly: ${event.path}`)
    if (event.path.endsWith('.tmp')) holds.onTempWrite?.(event.path)
    if (isDraftTemp(event.path)) {
      draftAttempts.push(event.text)
      if (holds.draftFull) throw new Error(`ENOSPC: no space left on device, write ${event.path}`)
      await holds.draftWrite
      const once = holds.draftWriteOnce
      holds.draftWriteOnce = undefined
      await once
    }
    files.set(event.path, event.text)
    return { value: undefined }
  })
  // The shell commands the pane runs beside the CLI: `mv -fT` renames within the folder (writeAtomic's last step), `ln`
  // publishes only when no file is there (the CLI's create_once), `rm -f` and `mkdir`/`rmdir` mirror the draft lock.
  on('process.run', async (_$, event) => {
    if (event.argv[0] === 'mv') {
      const [from = '', to = ''] = event.argv.slice(2)
      const text = files.get(from)
      if (text === undefined) return cliReply('', 1)
      files.delete(from)
      files.set(to, text)
      if (to === DRAFT) drafts.push(text)
      return cliReply('')
    }
    if (event.argv[0] === 'ln') {
      const [from = '', to = ''] = event.argv.slice(1)
      links.push([...event.argv])
      if (files.has(to)) return cliReply('', 1)
      files.set(to, files.get(from) ?? '')
      writes.push(to)
      return cliReply('')
    }
    if (event.argv[0] === 'rm') {
      files.delete(event.argv[2] ?? '')
      return cliReply('')
    }
    if (event.argv[0] === 'mkdir') {
      if (locks.has(event.argv[1] ?? '')) return cliReply('', 1)
      locks.add(event.argv[1] ?? '')
      return cliReply('')
    }
    if (event.argv[0] === 'rmdir') {
      locks.delete(event.argv[1] ?? '')
      return cliReply('')
    }
    // `find <dir> ... -delete` removes the stale temp files the holds name; its -mmin age is recorded in `sweeps` for the test.
    if (event.argv[0] === 'find' && event.argv.includes('-delete')) {
      sweeps.push([...event.argv])
      for (const file of holds.staleTemps ?? []) files.delete(file)
      return cliReply('')
    }
    // `find <lock> -maxdepth 0 -mmin +N` prints the lock's path when its age is above N whole minutes (find truncates the age to
    // minutes), and nothing when it is not. So `+0` reports a lock a minute old or more, and `+1` one of two minutes or more.
    if (event.argv[0] === 'find') {
      const limit = Number((event.argv[event.argv.indexOf('-mmin') + 1] ?? '+0').slice(1))
      const ageSeconds = holds.lockAgeSeconds?.get(event.argv[1] ?? '') ?? 0
      return cliReply(Math.floor(ageSeconds / 60) > limit ? (event.argv[1] ?? '') : '')
    }
    if (event.argv[0] !== 'python3') return cliReply('') // the token folder and mode
    const [, , , id, key] = event.argv
    attempts.push(path('a', id))
    await holds.write
    const stored = files.get(path('a', id))
    if (stored !== undefined) return cliReply(JSON.stringify({ id, key: (JSON.parse(stored) as { key: string }).key, written: false }))
    files.set(path('a', id), `${JSON.stringify({ id, key, by: 'panel', ts: 0 })}\n`)
    writes.push(path('a', id))
    return cliReply(JSON.stringify({ id, key, written: true }))
  })
  return { attempts, writes, draftAttempts, drafts, submits, reads, clock, locks, sweeps, links }
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
  const { attempts, writes, drafts, clock } = stubHost(on, files, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: `opt-${QUESTION}-B` })
  const write = gate()
  holds.write = write.promise
  const presses = Array.from({ length: PRESSES }, () => pane.press({ key: 'submit-all' }))
  await clock.settle()
  // One write reached the host and is held; the other 19 presses were turned away before any write.
  expect(attempts).toEqual([path('a', QUESTION)])
  expect(writes).toEqual([])
  write.open()
  await Promise.all(presses)
  expect(writes).toEqual([path('a', QUESTION)])
  expect(readJson(files, path('a', QUESTION))).toMatchObject({ id: QUESTION, key: 'B', by: 'panel' })
  // The pick reached the shared draft: the stub saw that write land.
  expect(picksOf(drafts[0])).toEqual({ [QUESTION]: { key: 'B' } })
  await pane.unmount()
})

test('race: when the first write fails, the guards are released and the next Submit all writes the answer once', async ($, on) => {
  const files = new Map([[path('q', QUESTION), question(QUESTION, 1000)]])
  const holds: Holds = {}
  const { attempts, writes, clock } = stubHost(on, files, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: `opt-${QUESTION}-B` })
  let failWrite: (reason: Error) => void = () => {}
  holds.write = new Promise<void>((_resolve, reject) => {
    failWrite = reject
  })
  const presses = Array.from({ length: PRESSES }, () => pane.press({ key: 'submit-all' }))
  await clock.settle()
  failWrite(new Error('disk full'))
  await Promise.allSettled(presses)
  expect(attempts).toEqual([path('a', QUESTION)])
  expect(writes).toEqual([])
  expect(files.has(path('a', QUESTION))).toBe(false)
  holds.write = undefined
  // A refused write ends the failed card's fade at once, so the retry goes through at once; the advance only settles the timers.
  await clock.advance(250)
  await pane.press({ key: 'submit-all' })
  expect(attempts).toEqual([path('a', QUESTION), path('a', QUESTION)])
  expect(writes).toEqual([path('a', QUESTION)])
  expect(readJson(files, path('a', QUESTION))).toMatchObject({ id: QUESTION, key: 'B', by: 'panel' })
  await pane.unmount()
})

test('race: a draft stamped more than DRAFT_SKEW_MS past the clock is applied, and its stamp is pulled back to the clock', async ($, on) => {
  const files = new Map([[path('q', QUESTION), question(QUESTION, 1000)]])
  const { writes, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const variantOf = async (key: string): Promise<unknown> => (await pane.find({ type: 'Button', key }))?.props.variant
  // The fake clock starts at 0. Another window stamped the draft 10 s beyond the allowance: this window applies it at once,
  // and its stamp is pulled back to the clock (5 s), not kept at the far-ahead value.
  files.set(DRAFT, JSON.stringify({ ts: DRAFT_SKEW_MS + 10_000, picks: { [QUESTION]: { key: 'B' } } }))
  await clock.advance(5000)
  expect(await variantOf(`opt-${QUESTION}-B`)).toBe('primary')
  // A later draft stamped at 10 s is past the pulled-back stamp, so it is applied; it would be ignored under the old stamp.
  files.set(DRAFT, JSON.stringify({ ts: 10_000, picks: { [QUESTION]: { key: 'A' } } }))
  await clock.advance(5000)
  expect(await variantOf(`opt-${QUESTION}-A`)).toBe('primary')
  expect(writes).toEqual([])
  await pane.unmount()
})

test('race: a failed listing of the question folder keeps the board, so Submit all still writes the pick', async ($, on) => {
  const files = new Map([[path('q', QUESTION), question(QUESTION, 1000)]])
  const holds: Holds = {}
  const { writes, clock } = stubHost(on, files, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: `opt-${QUESTION}-B` })
  holds.failListOf = `${STATE}/q`
  await clock.advance(5000)
  // The poll's listing of q/ failed once (the hold is spent); the question stays on the board.
  expect(holds.failListOf).toBeUndefined()
  await pane.press({ key: 'submit-all' })
  expect(writes).toEqual([path('a', QUESTION)])
  expect(readJson(files, path('a', QUESTION))).toMatchObject({ id: QUESTION, key: 'B', by: 'panel' })
  await pane.unmount()
})

test('race: a torn delivery marker counts as absent: the answer shows no delivery until a whole marker lands', async ($, on) => {
  const files = new Map([
    [path('q', QUESTION), question(QUESTION, 1000)],
    [path('a', QUESTION), `${JSON.stringify({ id: QUESTION, key: 'A', by: 'cli', ts: 900, session: OTHER_SESSION })}\n`],
    // A marker cut off mid-write, as a crash leaves it.
    [path('d', QUESTION), '{"id":"q-race-aaaaaa","sess'],
  ])
  const { clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await clock.advance(5000)
  expect(await pane.find({ type: 'Text', text: /read by the session|lida pela sessão/ })).toBeUndefined()
  // The control: a whole marker shows the delivery, so the search above sees the History line when it is there.
  files.set(path('d', QUESTION), `${JSON.stringify({ id: QUESTION, session: OTHER_SESSION, ts: 950 })}\n`)
  await clock.advance(5000)
  expect(await pane.find({ type: 'Text', text: /read by the session|lida pela sessão/ })).toBeDefined()
  await pane.unmount()
})

test('race: a tick that comes while a poll is still writing starts no second poll, so draft.json gets one write', async ($, on) => {
  const files = new Map([[path('q', QUESTION), question(QUESTION, 1000)]])
  // The first pick cannot be written, so it stays pending for the poll to retry.
  const holds: Holds = { draftFull: true }
  const { draftAttempts, drafts, clock } = stubHost(on, files, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: `opt-${QUESTION}-B` })
  holds.draftFull = false
  const attemptsBefore = draftAttempts.length
  const landing = gate()
  holds.draftWrite = landing.promise
  await clock.advance(5000) // poll 1 retries the pending pick; its write is held in flight
  await clock.advance(5000) // tick 2 comes while poll 1 is still in flight
  await clock.settle()
  expect(draftAttempts.length - attemptsBefore).toBe(1)
  landing.open()
  await clock.settle()
  expect(drafts).toHaveLength(1)
  expect(picksOf(drafts[0])).toEqual({ [QUESTION]: { key: 'B' } })
  await pane.unmount()
})

test('race: 200 open questions on the board: a poll reads all of them and applies a shared draft that picks each', async ($, on) => {
  const ids = Array.from({ length: BULK_QUESTIONS }, (_value, index) => `q-race-${index.toString(16).padStart(6, '0')}`)
  const files = new Map(ids.map((id, index): [string, string] => [path('q', id), question(id, 1000 + index)]))
  const picks = Object.fromEntries(ids.map(id => [id, { key: 'B' }]))
  files.set(DRAFT, JSON.stringify({ ts: 1000, picks }))
  const { reads, clock } = stubHost(on, files)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await clock.advance(5000)
  // The board holds all 200: every question file was read, and the first card shows the pick the draft holds for it.
  expect(new Set(reads.filter(file => file.startsWith(`${STATE}/q/`)))).toEqual(new Set(ids.map(id => path('q', id))))
  expect((await pane.find({ type: 'Button', key: `opt-${ids[0]}-B` }))?.props.variant).toBe('primary')
  await pane.unmount()
})

test('race: a no-space write of draft.json keeps the previous file and the pick, and the next poll writes the pick', async ($, on) => {
  const previousDraft = `${JSON.stringify({ ts: 500, picks: {} })}\n`
  const files = new Map([
    [path('q', QUESTION), question(QUESTION, 1000)],
    [DRAFT, previousDraft],
  ])
  const holds: Holds = { draftFull: true }
  const { drafts, clock } = stubHost(on, files, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: `opt-${QUESTION}-B` })
  expect(files.get(DRAFT)).toBe(previousDraft)
  expect(drafts).toEqual([])
  // The pick stays on screen while its write is pending.
  expect((await pane.find({ type: 'Button', key: `opt-${QUESTION}-B` }))?.props.variant).toBe('primary')
  holds.draftFull = false
  await clock.advance(5000)
  expect(drafts).toHaveLength(1)
  expect(picksOf(drafts[0])).toEqual({ [QUESTION]: { key: 'B' } })
  await pane.unmount()
})

test('race: a pick made while another draft.json write is in flight is not lost: both picks land', async ($, on) => {
  const files = new Map([
    [path('q', QUESTION), question(QUESTION, 1000)],
    [path('q', OTHER_QUESTION), question(OTHER_QUESTION, 1000)],
  ])
  const holds: Holds = {}
  const { drafts, locks, clock } = stubHost(on, files, holds)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  // The first pick's write is held in flight; a second pick, from this or another window, is made meanwhile.
  const landing = gate()
  holds.draftWriteOnce = landing.promise
  const firstPick = pane.press({ key: `opt-${QUESTION}-B` })
  await clock.settle()
  await clock.advance(1000) // past the move lock the first pick set
  await pane.press({ key: `opt-${OTHER_QUESTION}-A` })
  // The draft lock is held by the first write, so the second pick waits for it instead of reading the draft meanwhile.
  expect(locks.has(DRAFT_LOCK)).toBe(true)
  landing.open()
  await clock.settle()
  await firstPick
  expect(locks.has(DRAFT_LOCK)).toBe(false)
  // The next poll retries the second pick, which then reads the first pick's draft and writes both.
  await clock.advance(5000)
  expect(picksOf(drafts.at(-1))).toEqual({ [QUESTION]: { key: 'B' }, [OTHER_QUESTION]: { key: 'A' } })
  expect(Object.keys(picksOf(drafts.at(-1)))).toHaveLength(2)
  await pane.unmount()
})

test('race: a draft.lock left by a crashed window is removed once stale, and the pick is written at the next poll', async ($, on) => {
  const files = new Map([[path('q', QUESTION), question(QUESTION, 1000)]])
  // The lock a crashed window left behind is 61 s old, past one minute: the pick's write removes it, and waits for the next poll.
  const holds: Holds = { lockAgeSeconds: new Map([[DRAFT_LOCK, 61]]) }
  const { drafts, locks, clock } = stubHost(on, files, holds)
  locks.add(DRAFT_LOCK)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: `opt-${QUESTION}-B` })
  expect(drafts).toEqual([])
  expect(locks.has(DRAFT_LOCK)).toBe(false)
  await clock.advance(5000)
  expect(picksOf(drafts.at(-1))).toEqual({ [QUESTION]: { key: 'B' } })
  await pane.unmount()
})

test('race: the draft temp file a crashed window left is swept with its stale lock, by a find of the same age; the lock stays while fresh', async ($, on) => {
  const staleTemp = `${STATE}/.draft.json.0123456789abcdef.tmp`
  const files = new Map([
    [path('q', QUESTION), question(QUESTION, 1000)],
    [staleTemp, '{"ts":1,"picks":{}}'],
  ])
  // The lock and its temp file are older than the stale age: the write removes both, and waits for the next poll.
  const holds: Holds = { lockAgeSeconds: new Map([[DRAFT_LOCK, 61]]), staleTemps: new Set([staleTemp]) }
  const { drafts, locks, sweeps, clock } = stubHost(on, files, holds)
  locks.add(DRAFT_LOCK)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: `opt-${QUESTION}-B` })
  expect(files.has(staleTemp)).toBe(false)
  expect(sweeps).toEqual([['find', STATE, '-maxdepth', '1', '-name', '.draft.json.*.tmp', '-mmin', '+0', '-delete']])
  await clock.advance(5000)
  expect(picksOf(drafts.at(-1))).toEqual({ [QUESTION]: { key: 'B' } })
  await pane.unmount()
})

// Gauntlet 5 review R8: the stale age is one minute. find's `-mmin +0` matches a lock a minute old or more, so a lock 59 s old is fresh.
test('race: a draft.lock 59 seconds old is still fresh: the pick waits, and no lock or temp file is swept', async ($, on) => {
  const files = new Map([[path('q', QUESTION), question(QUESTION, 1000)]])
  const holds: Holds = { lockAgeSeconds: new Map([[DRAFT_LOCK, 59]]) }
  const { drafts, locks, sweeps, clock } = stubHost(on, files, holds)
  locks.add(DRAFT_LOCK)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: `opt-${QUESTION}-B` })
  await clock.advance(5000)
  expect(drafts).toEqual([])
  expect(locks.has(DRAFT_LOCK)).toBe(true)
  expect(sweeps).toEqual([])
  await pane.unmount()
})

test('race: a fresh draft temp file is not swept while its lock is held, and the pick waits for the lock', async ($, on) => {
  const freshTemp = `${STATE}/.draft.json.fedcba9876543210.tmp`
  const files = new Map([
    [path('q', QUESTION), question(QUESTION, 1000)],
    [freshTemp, '{"ts":1,"picks":{}}'],
  ])
  // The lock is fresh (no staleLocks entry): the write leaves the lock and the temp file of the other window alone.
  const { drafts, locks, sweeps } = stubHost(on, files, {})
  locks.add(DRAFT_LOCK)
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: `opt-${QUESTION}-B` })
  expect(files.has(freshTemp)).toBe(true)
  expect(sweeps).toEqual([])
  expect(locks.has(DRAFT_LOCK)).toBe(true)
  expect(drafts).toEqual([])
  await pane.unmount()
})

test('race: a CLI marker that lands between the pane\'s read and its link is kept, and the pane hands nothing', async ($, on) => {
  const files = new Map([
    [path('q', QUESTION), question(QUESTION, 0, SELF)],
    [path('a', QUESTION), `${JSON.stringify({ id: QUESTION, key: 'B', by: 'panel', ts: 0 })}\n`],
  ])
  const holds: Holds = {}
  const { submits, clock, links } = stubHost(on, files, holds)
  // The CLI's deliver run writes its marker after the pane has read the folder, and before the pane's own marker is published.
  holds.onTempWrite = file => {
    if (!file.startsWith(`${STATE}/d/.${QUESTION}.json.`) || files.has(path('d', QUESTION))) return
    files.set(path('d', QUESTION), `${JSON.stringify({ id: QUESTION, session: OTHER_SESSION, ts: 950 })}\n`)
  }
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await clock.advance(5000)
  // The pane's link fails over the CLI's marker, so no line is handed and the CLI's marker stands.
  expect(submits).toEqual([])
  // The link is the no-clobber `ln temp marker` (Gauntlet 5 review R4): a `-f` would have replaced the CLI's marker.
  expect(links.map(argv => [argv[0], argv.length, argv[2]])).toEqual([['ln', 3, path('d', QUESTION)]])
  expect(readJson(files, path('d', QUESTION))).toMatchObject({ session: OTHER_SESSION, ts: 950 })
  await pane.unmount()
})
