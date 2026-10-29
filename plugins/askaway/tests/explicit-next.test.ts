import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { resetDesktopConfigCache } from '../hooks/register'

// The card's explicit Next behaviour: a pick records the answer and keeps the card on its question, the nav labels read the
// answer first, Keep in the Other field picks its text, and the last card's Next opens the review (or Submit all, for one
// question). The harness is copied from askaway.test.ts (its helpers are not exported); it keeps only what these tests use.

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
// The session id the host answers for `$.session.id()`; a question filed by this session carries it.
const SELF = 'sess-self'

// The strings each language draws. The nav labels are the desktop ones: no hotkey letter after them.
const COPY = {
  en: { lang: 'en_US.UTF-8', noAnswer: 'No answer', answer: 'Answer', back: '← Back', next: 'Next →', submit: 'Submit all', review: 'Review your answers' },
  pt: { lang: 'pt_BR.UTF-8', noAnswer: 'Sem resposta', answer: 'Resposta', back: '← Voltar', next: 'Próxima →', submit: 'Enviar tudo', review: 'Revise as suas respostas' },
} as const

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

const path = (dir: string, id: string): string => `${STATE}/${dir}/${id}.json`

// A group of two questions, the first with the given fields (its options, say).
const pairOf = (first: Record<string, unknown> = {}): Map<string, string> =>
  new Map([
    [path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000, first)],
    [path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000)],
  ])

// The faults a test can set: `answerExit` makes every CLI answer exit with that code (a reply that fails).
type Holds = { answerExit?: number }

// The engine's file calls, answered from an in-memory folder, and the CLI's list and answer, as the pane's hooks see them.
// `writes` lists the answers and state files that land; `drafts` lists the picks each change writes to draft.json.
function stubHost(on: On, files: Map<string, string>, env: Record<string, string>, holds: Holds = {}) {
  const writes: string[] = []
  const drafts: string[] = []
  // The Desktop config cache belongs to one host: a test starts with none.
  resetDesktopConfigCache()
  const clock = mock.clock(on)
  mock.env(on, { HOME, ...env })
  mock.store(on, {})
  on('command.register', (_$, event) => ({ value: { command: event.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF }))
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'dark' }] }))
  on('config.set', (_$, e) => ({ value: e.value }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn beneath'] }))
  // Nothing beneath the plugin moves the focus ring: the move lands at once, as the engine's own stops do.
  on('ui.focus', () => ({}))
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
  // A folder exists when a file lies under it, as on disk.
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) || [...files.keys()].some(file => file.startsWith(`${e.path}/`)) }))
  on('fs.write', (_$, e) => {
    // An answer goes through the CLI (process.run below); a direct write to a/ would bypass its first-writer-wins link.
    if (e.path.startsWith(`${STATE}/a/`)) throw new Error(`answer written directly: ${e.path}`)
    if (e.path.endsWith('.tmp') || e.path.includes('/panel-tokens/')) {
      files.set(e.path, e.text)
      return { value: undefined }
    }
    writes.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  // The CLI's `list`, `prune` and `answer`: the first answer for an id lands, and a later one is refused.
  on('process.run', (_$, e) => {
    if (e.argv[0] !== 'python3') {
      // `mv -f from to` renames in the stub's folder; the draft file is recorded apart, as the picks it stands for.
      if (e.argv[0] === 'mv') {
        const [from = '', to = ''] = e.argv.slice(2)
        const text = files.get(from)
        if (text === undefined) return cliReply('', 1)
        files.delete(from)
        files.set(to, text)
        if (to === `${STATE}/draft.json`) drafts.push(text)
        else writes.push(to)
      }
      // `ln temp target` is the no-clobber publish: it fails when the target is there.
      if (e.argv[0] === 'ln') {
        const [from = '', to = ''] = e.argv.slice(1)
        if (files.has(to)) return cliReply('', 1)
        files.set(to, files.get(from) ?? '')
        writes.push(to)
      }
      if (e.argv[0] === 'rm') files.delete(e.argv[2] ?? '')
      return cliReply('')
    }
    if (e.argv[2] === 'list') {
      const items = [...files.keys()].filter(file => file.startsWith(`${STATE}/q/`)).map(file => ({ id: file.slice(`${STATE}/q/`.length, -5) }))
      return cliReply(JSON.stringify({ items }))
    }
    if (e.argv[2] === 'prune') {
      files.delete(path('q', e.argv[4]))
      return cliReply(JSON.stringify({ removed: 1 }))
    }
    const [, , , id, key] = e.argv
    if (holds.answerExit !== undefined) return cliReply('', holds.answerExit)
    const stored = files.get(path('a', id))
    if (stored !== undefined) return cliReply(JSON.stringify({ id, key: (JSON.parse(stored) as { key: string }).key, written: false }))
    const record = { id, key, by: 'panel', ts: 0 }
    files.set(path('a', id), `${JSON.stringify(record)}\n`)
    writes.push(path('a', id))
    return cliReply(JSON.stringify({ id, key, written: true }))
  })
  return { writes, drafts, clock }
}

// The reply of a child that exited, with the fields the pane reads.
const cliReply = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const readJson = (files: Map<string, string>, file: string): Record<string, unknown> =>
  JSON.parse(files.get(file) ?? '{}') as Record<string, unknown>

// The picks of the last draft.json a change wrote.
const lastPicks = (drafts: string[]): Record<string, unknown> =>
  (JSON.parse(drafts[drafts.length - 1] ?? '{}') as { picks?: Record<string, unknown> }).picks ?? {}

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'askaway', surface: 'desktop', component: 'Pane', requestId: 'askaway', props: PANE_PROPS })

type Pane = Awaited<ReturnType<typeof mountPane>>

// Every node of a drawn tree, depth first.
const nodesOf = (node: unknown): Record<string, unknown>[] => {
  if (typeof node !== 'object' || node === null) return []
  const element = node as Record<string, unknown>
  const children = Array.isArray(element.children) ? element.children : []
  return [element, ...children.flatMap(nodesOf)]
}

// The text of a drawn Text node, its nested strings joined.
const textOfNode = (node: unknown): string => {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  const children = (node as Record<string, unknown>).children
  return Array.isArray(children) ? children.map(textOfNode).join('') : ''
}

// The text a tree link (a Markdown block) reads as: its markup gone, the link as its label, its escapes undone.
const plainMarkdown = (markdown: string): string =>
  markdown.replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\\(.)/g, '$1')

// Every Text the pane draws, one per Text node and per Markdown block, in order.
const textsOf = async (pane: Pane): Promise<string[]> =>
  nodesOf(await pane.drawn()).flatMap(node => {
    if (node.type === 'Text') return [textOfNode(node)]
    if (node.type !== 'Markdown') return []
    const text = plainMarkdown(String((node.props as Record<string, unknown>).text))
    return text.startsWith('### ') ? text.slice(4).split(' - ') : [text]
  })

// The label a Button is drawn with, by its key; undefined when it is not drawn.
const labelOf = async (pane: Pane, key: string): Promise<unknown> => (await pane.find({ type: 'Button', key }))?.props.label

const variantOf = async (pane: Pane, key: string): Promise<unknown> => (await pane.find({ type: 'Button', key }))?.props.variant

const dimOf = async (pane: Pane, key: string): Promise<unknown> => (await pane.find({ type: 'Button', key }))?.props.dimColor

// A tree link is pressed on its href, as a click on its Markdown link does: action is jump or submit, id the question.
const pressTreeLink = (pane: Pane, action: 'jump' | 'submit', id: string) =>
  pane.press({ key: `tree-${action}-${id}`, link: { href: `file:///askaway/${action}/${id}` } })

for (const [lang, copy] of Object.entries(COPY)) {
  test(`a pick keeps the card on its question and is recorded; Next and Back keep the pick (${lang})`, async ($, on) => {
    const files = pairOf()
    const { writes, drafts, clock } = stubHost(on, files, { LANG: copy.lang })
    await $.session.start(SESSION)
    const pane = await mountPane($)
    await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
    // The pick stays on the same question: no move, no answer file, and the pick is drafted.
    expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
    expect(writes).toEqual([])
    expect(lastPicks(drafts)).toEqual({ 'q-l1-aaaaaa': { key: 'B' } })
    expect(await labelOf(pane, 'nav-next')).toBe(`${copy.answer}: B · ${copy.next}`)
    await clock.advance(350)
    await pane.press({ key: 'nav-next' })
    expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
    expect(await labelOf(pane, 'nav-back')).toBe(`${copy.noAnswer} · ${copy.back}`)
    await clock.advance(350)
    await pane.press({ key: 'nav-back' })
    // Back returns to the picked question, which still shows its pick: the primary option and the answer in the nav labels.
    expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
    expect(await variantOf(pane, 'opt-q-l1-aaaaaa-B')).toBe('primary')
    expect(await labelOf(pane, 'nav-next')).toBe(`${copy.answer}: B · ${copy.next}`)
    expect(writes).toEqual([])
    await pane.unmount()
  })

  test(`the nav labels read the answer first, and the answer is the letter, before and after a pick (${lang})`, async ($, on) => {
    const files = pairOf()
    const { clock } = stubHost(on, files, { LANG: copy.lang })
    await $.session.start(SESSION)
    const pane = await mountPane($)
    // No pick yet: the state reads "No answer" on both nav buttons.
    expect(await labelOf(pane, 'nav-back')).toBe(`${copy.noAnswer} · ${copy.back}`)
    expect(await labelOf(pane, 'nav-next')).toBe(`${copy.noAnswer} · ${copy.next}`)
    await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
    await clock.advance(350)
    // After picking B the state reads "Answer: B" on both nav buttons, the answer first and the label after it.
    expect(await labelOf(pane, 'nav-back')).toBe(`${copy.answer}: B · ${copy.back}`)
    expect(await labelOf(pane, 'nav-next')).toBe(`${copy.answer}: B · ${copy.next}`)
    await pane.unmount()
  })

  test(`an Other pick shows the Other row's letter, never its label or the typed text (${lang})`, async ($, on) => {
    const threeOptions = [
      { key: 'A', label: 'Keep', tradeoff: 'cheap', fit: 80 },
      { key: 'B', label: 'Rewrite', tradeoff: 'slow', fit: 40 },
      { key: 'C', label: 'Defer', tradeoff: 'later', fit: 20 },
    ]
    const files = pairOf({ options: threeOptions })
    stubHost(on, files, { LANG: copy.lang })
    await $.session.start(SESSION)
    const pane = await mountPane($)
    // With options A, B and C the Other row is D.
    await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
    expect(await labelOf(pane, 'nav-next')).toBe(`${copy.answer}: D · ${copy.next}`)
    expect(await labelOf(pane, 'nav-back')).toBe(`${copy.answer}: D · ${copy.back}`)
    expect(String(await labelOf(pane, 'nav-next'))).not.toContain('Use a fork')
    await pane.unmount()
  })

  test(`Keep in the Other field keeps its text as the Other label and picks it; blank text changes nothing (${lang})`, async ($, on) => {
    const files = pairOf()
    const { writes, drafts } = stubHost(on, files, { LANG: copy.lang })
    await $.session.start(SESSION)
    const pane = await mountPane($)
    // Blank Keep: no pick, no draft, the Next label keeps its "No answer" state.
    await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: '   ' })
    expect(drafts).toEqual([])
    expect(await labelOf(pane, 'nav-next')).toBe(`${copy.noAnswer} · ${copy.next}`)
    // Keep with text: the text becomes the Other button's label, the pick is drafted, and the card stays on its question.
    await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: '  Use a fork  ' })
    expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
    // With options A and B the Other row is C.
    expect(await labelOf(pane, 'other-q-l1-aaaaaa')).toBe('✓ C · Use a fork')
    expect(lastPicks(drafts)).toEqual({ 'q-l1-aaaaaa': { key: 'other', text: 'Use a fork' } })
    expect(await labelOf(pane, 'nav-next')).toBe(`${copy.answer}: C · ${copy.next}`)
    expect(writes).toEqual([])
    await pane.unmount()
  })

  test(`the last card of a group of two has Next; its press opens the review, and Submit all there waits for every pick (${lang})`, async ($, on) => {
    const files = pairOf()
    const { writes, clock } = stubHost(on, files, { LANG: copy.lang })
    await $.session.start(SESSION)
    const pane = await mountPane($)
    await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
    await clock.advance(350)
    await pane.press({ key: 'nav-next' })
    expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
    // The last card has Next, not Submit all, and q-l2 has no pick.
    expect(await pane.find({ type: 'Button', key: 'submit-all' })).toBeUndefined()
    expect(await labelOf(pane, 'nav-next')).toBe(`${copy.noAnswer} · ${copy.next}`)
    await clock.advance(350)
    await pane.press({ key: 'nav-next' })
    // The review opens although q-l2 has no pick: its row reads "No answer", and Submit all is dim and writes nothing.
    expect(await textsOf(pane)).toContain(copy.review)
    expect((await textsOf(pane)).some(text => text.endsWith(`→ ${copy.noAnswer}`))).toBe(true)
    expect(await labelOf(pane, 'submit-all')).toBe(`${copy.submit} (2)`)
    expect(await dimOf(pane, 'submit-all')).toBe(true)
    await pane.press({ key: 'submit-all' })
    expect(writes).toEqual([])
    // Jumping to q-l2 from its review row, picking there, and returning by Next makes Submit all live; it then writes both answers.
    await pressTreeLink(pane, 'jump', 'q-l2-bbbbbb')
    await clock.advance(350)
    expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
    await pane.press({ key: 'opt-q-l2-bbbbbb-B' })
    await clock.advance(350)
    await pane.press({ key: 'nav-next' })
    expect(await textsOf(pane)).toContain(copy.review)
    expect(await variantOf(pane, 'submit-all')).toBe('primary')
    expect(await dimOf(pane, 'submit-all')).toBe(false)
    await pane.press({ key: 'submit-all' })
    expect(writes).toEqual([path('a', 'q-l1-aaaaaa'), path('a', 'q-l2-bbbbbb')])
    expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'A', by: 'panel' })
    expect(readJson(files, path('a', 'q-l2-bbbbbb'))).toMatchObject({ key: 'B', by: 'panel' })
    await pane.unmount()
  })

  test(`a group of one question has Submit all on its card, never Next and never a review (${lang})`, async ($, on) => {
    const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
    const { writes, clock } = stubHost(on, files, { LANG: copy.lang })
    await $.session.start(SESSION)
    const pane = await mountPane($)
    expect(await labelOf(pane, 'submit-all')).toBe(`${copy.noAnswer} · ${copy.submit} (1)`)
    expect(await dimOf(pane, 'submit-all')).toBe(true)
    expect(await pane.find({ type: 'Button', key: 'nav-next' })).toBeUndefined()
    await pane.press({ key: 'opt-q-l1-aaaaaa-B' })
    await clock.advance(350)
    expect(await labelOf(pane, 'submit-all')).toBe(`${copy.answer}: B · ${copy.submit} (1)`)
    expect(await variantOf(pane, 'submit-all')).toBe('primary')
    expect(await textsOf(pane)).not.toContain(copy.review)
    await pane.press({ key: 'submit-all' })
    expect(writes).toEqual([path('a', 'q-l1-aaaaaa')])
    expect(readJson(files, path('a', 'q-l1-aaaaaa'))).toMatchObject({ key: 'B', by: 'panel' })
    await pane.unmount()
  })
}

// Next on the last card of the group (q-l1, q-l2) opens the review; q-l1 is picked first, as a person makes the pick.
const openReviewOf = async (pane: Pane, clock: ReturnType<typeof stubHost>['clock']): Promise<void> => {
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
}

test('a question of the review group that leaves closes the review; a question that arrives later does not bring it back', async ($, on) => {
  const files = pairOf()
  const { clock } = stubHost(on, files, { LANG: COPY.en.lang })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await openReviewOf(pane, clock)
  expect(await textsOf(pane)).toContain(COPY.en.review)
  // q-l2 is answered elsewhere: one question is left, the card is drawn, and the poll closes the review.
  files.delete(path('q', 'q-l2-bbbbbb'))
  await clock.advance(5000)
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  expect(await textsOf(pane)).not.toContain(COPY.en.review)
  // q-l2 comes back, so the group is the set the review was opened for again: the card still shows, not the review.
  files.set(path('q', 'q-l2-bbbbbb'), question('q-l2-bbbbbb', 2000))
  await clock.advance(5000)
  expect(await textsOf(pane)).not.toContain(COPY.en.review)
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  // A new question arrives later in the group: the card, not the review.
  files.set(path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000))
  await clock.advance(5000)
  expect(await textsOf(pane)).not.toContain(COPY.en.review)
  expect(await textsOf(pane)).toContain('Title q-l1-aaaaaa')
  await pane.unmount()
})

test('a new question that arrives in the group of an open review closes it: the card is drawn on its question, not the review', async ($, on) => {
  const files = pairOf()
  const { clock } = stubHost(on, files, { LANG: COPY.en.lang })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await openReviewOf(pane, clock)
  expect(await textsOf(pane)).toContain(COPY.en.review)
  files.set(path('q', 'q-l3-cccccc'), question('q-l3-cccccc', 3000))
  await clock.advance(5000)
  expect(await textsOf(pane)).not.toContain(COPY.en.review)
  // The step stays on q-l2, the question on screen, which is now the middle of three.
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await pane.unmount()
})

test('Back on the review leaves it for the last question card, and the review Back label names that question\'s answer', async ($, on) => {
  const files = pairOf()
  const { clock } = stubHost(on, files, { LANG: COPY.en.lang })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  await pane.press({ key: 'opt-q-l1-aaaaaa-A' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  await clock.advance(350)
  // The last card's pick is made before its Next opens the review, so the review's Back names it: the answer first, then Back.
  await pane.press({ key: 'opt-q-l2-bbbbbb-B' })
  await clock.advance(350)
  await pane.press({ key: 'nav-next' })
  expect(await textsOf(pane)).toContain(COPY.en.review)
  await clock.advance(350)
  expect(await labelOf(pane, 'review-back')).toBe(`${COPY.en.answer}: B · ${COPY.en.back}`)
  await pane.press({ key: 'review-back' })
  expect(await textsOf(pane)).not.toContain(COPY.en.review)
  expect(await textsOf(pane)).toContain('Title q-l2-bbbbbb')
  await pane.unmount()
})

test('Keep with the same Other text as a failed Submit all keeps the not-delivered line; a different text clears it', async ($, on) => {
  const files = new Map([[path('q', 'q-l1-aaaaaa'), question('q-l1-aaaaaa', 1000)]])
  stubHost(on, files, { LANG: COPY.en.lang }, { answerExit: 1 })
  await $.session.start(SESSION)
  const pane = await mountPane($)
  const notDelivered = async () => (await textsOf(pane)).filter(text => text.startsWith('Not delivered yet'))
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa', text: 'Use a fork' })
  await pane.press({ key: 'submit-all' })
  expect(await notDelivered()).toEqual(['Not delivered yet: press Submit all again.'])
  // The field is the next round after a Keep. The same text keeps the same pick, so the line stays.
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa-1', text: 'Use a fork' })
  expect(await labelOf(pane, 'other-q-l1-aaaaaa')).toBe('✓ C · Use a fork')
  expect(await notDelivered()).toEqual(['Not delivered yet: press Submit all again.'])
  // A different text is a changed pick: the line goes.
  await $.ui.input({ plugin: 'askaway', key: 'other-input-q-l1-aaaaaa-2', text: 'Another fork' })
  expect(await notDelivered()).toEqual([])
  await pane.unmount()
})
