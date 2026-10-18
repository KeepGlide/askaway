// The Askaway hooks module: the poll timer, the state reads and writes of the state folder, the pane, the band row,
// the toast and the /askaway command. $ stays in this file: the engine follows $ only inside the module that holds
// the hook, so the calls on $ live here. Pure rules live in model.ts, the wizard's in wizard.ts, the text in i18n.ts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Answer, Board, Delivery, PromptMarker, Question } from '../types'
import { renderBand } from './band'
import { heldButtons, type HeldButtons } from './held'
import { detectLang, langName, resolveLang, t, type Lang } from './i18n'
import { renderPane, type PaneActions, type PaneView } from './pane'
import {
  EMPTY_BOARD,
  OTHER_KEY,
  ageLabel,
  footerText,
  groupBySession,
  isOpenIn,
  listText,
  openQuestions,
  parseAnswer,
  parseAnswerWritten,
  parseAway,
  parseDelivery,
  parseQuestion,
  sameBoard,
  statusLines,
  withAnswer,
  withLocalAnswers,
} from './model'
import * as flow from './wizard'
import type { Group, Pick, Wizard } from './wizard'

const PANE = 'askaway'
const PLUGIN = 'askaway'
const TITLE = 'Askaway'
const POLL_MS = 5000
// An answered card stays listed, dimmed, for this long after the press; then it leaves and its status line shows.
const FADE_MS = 250
// The plugin's own store keys: the ids of the expired status lines the person dismissed, and the chosen language.
const CLEARED_KEY = 'cleared'
const LANG_KEY = 'lang'
// The choices of /askaway lang, as typed (case does not matter; `pt` and `pt_br` still work); `pt-BR` is stored as
// the dictionary's `pt`, and `auto` follows the environment. A Map, so `constructor` and the like are not choices.
const LANG_CHOICES: ReadonlyMap<string, string> = new Map([
  ['pt-br', 'pt'],
  ['pt_br', 'pt'],
  ['pt', 'pt'],
  ['en', 'en'],
  ['auto', 'auto'],
])
const DEFAULT_LANG: Lang = 'en'

// The drawn state. The pane and the band draw from these; the poll and the handlers write them, so each change
// redraws the instances that read it. They are declared here because the engine reads atoms in the file that
// reads them.
const board = atom({ plugin: 'askaway', key: 'board' } as const, EMPTY_BOARD)
const isAway = atom({ plugin: 'askaway', key: 'away' } as const, false)
const clockTick = atom({ plugin: 'askaway', key: 'tick' } as const, 0)
// Question ids already seen. The first poll only primes them, so a session start does not toast what is there.
const seen = atom({ plugin: 'askaway', key: 'seen' } as const, { isPrimed: false, ids: [] as string[] })
const cleared = atom({ plugin: 'askaway', key: 'cleared' } as const, [] as string[])
// When the pane first saw each delivery marker, so a delivered status line leaves after its time on screen.
const deliveredAt = atom({ plugin: 'askaway', key: 'deliveredAt' } as const, {} as Record<string, number>)
// The cards fading out after a press: question id → press time. The pane is one instance, so a plain atom holds it.
const leaving = atom({ plugin: 'askaway', key: 'leaving' } as const, {} as Record<string, number>)
// Whether this session's main loop is inside a turn: an answer is handed to the prompt only while it is idle.
const turn = atom({ plugin: 'askaway', key: 'turn' } as const, { isBusy: false })
// The language in use, and the question wizard (group, step, picks, Other…).
const langAtom = atom({ plugin: 'askaway', key: 'lang' } as const, DEFAULT_LANG)
const wizardAtom = atom({ plugin: 'askaway', key: 'wizard' } as const, flow.EMPTY_WIZARD)

// Files are written once and never change, so a parsed file stays until its name leaves the folder.
const questionCache = new Map<string, Question>()
const answerCache = new Map<string, Answer>()
const deliveryCache = new Map<string, Delivery>()
// Question ids whose answer a press is writing now, answer ids being handed to the prompt now, and group keys whose
// submit-all is in flight. Each is checked before the first await, so a second press or an overlapping poll does nothing.
const pressing = new Set<string>()
const handing = new Set<string>()
const submitting = new Set<string>()
// The Buttons each site (a pane or the band, on one surface) drew last, so a redraw keeps their press handles (held.ts).
const heldTables = new Map<string, HeldButtons>()

function heldFor(surface: RenderSurface, requestId: string): HeldButtons {
  const key = `${surface}:${requestId}`
  const known = heldTables.get(key)
  if (known !== undefined) return known
  const table = heldButtons()
  heldTables.set(key, table)
  return table
}

// A failed poll or action is logged, never thrown into the timer or a press handler.
function logFailure($: EngineInterface, error: unknown): void {
  $.ui.log(`askaway: ${error instanceof Error ? error.message : String(error)}`)
}

function report($: EngineInterface, job: Promise<unknown>): void {
  void job.catch((error: unknown) => logFailure($, error))
}

// Names of the JSON files in a folder. A missing folder reads as empty.
async function jsonIds($: EngineInterface, dir: string): Promise<string[]> {
  const entries = await $.fs.list(dir).catch(() => [])
  return entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
    .map(entry => entry.name.slice(0, -'.json'.length))
}

// A file may be mid-write or gone between the list and the read. An unreadable or invalid file reads as
// absent (the spec's rule for readers), so the next poll picks it up.
async function readJson($: EngineInterface, path: string): Promise<unknown> {
  const text = await $.fs.read(path).catch(() => undefined)
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function readCached<T>(
  $: EngineInterface,
  dir: string,
  cache: Map<string, T>,
  parse: (raw: unknown, id: string) => T | undefined,
): Promise<T[]> {
  const ids = await jsonIds($, dir)
  const found: T[] = []
  for (const id of ids) {
    const value = cache.get(id) ?? parse(await readJson($, `${dir}/${id}.json`), id)
    if (value !== undefined) {
      cache.set(id, value)
      found.push(value)
    }
  }
  for (const id of [...cache.keys()]) {
    if (!ids.includes(id)) cache.delete(id)
  }
  return found
}

async function readBoard($: EngineInterface, home: string): Promise<Board> {
  const questions = await readCached($, `${home}/q`, questionCache, parseQuestion)
  const answers = await readCached($, `${home}/a`, answerCache, parseAnswer)
  const delivered = await readCached($, `${home}/d`, deliveryCache, parseDelivery)
  return { questions, answers, delivered }
}

// The language the environment asks for, before any stored choice.
async function detectedLang($: EngineInterface): Promise<Lang> {
  const [LC_ALL, LC_MESSAGES, LANG, LANGUAGE] = await Promise.all([
    $.env.get('LC_ALL'),
    $.env.get('LC_MESSAGES'),
    $.env.get('LANG'),
    $.env.get('LANGUAGE'),
  ])
  return detectLang({
    ...(LC_ALL !== undefined && { LC_ALL }),
    ...(LC_MESSAGES !== undefined && { LC_MESSAGES }),
    ...(LANG !== undefined && { LANG }),
    ...(LANGUAGE !== undefined && { LANGUAGE }),
  })
}

// The stored choice wins; "auto" or nothing stored follows the environment.
async function currentLang($: EngineInterface): Promise<Lang> {
  return resolveLang(await $.store.get(LANG_KEY), await detectedLang($))
}

// Toasts each question that is new since the last poll and still open. The first poll only primes the ids:
// a question already waiting when the session starts shows in the pane, it is not toasted.
async function announceNew($: EngineInterface, next: Board): Promise<void> {
  const known = await read($, seen)
  const fresh = next.questions.filter(question => !known.ids.includes(question.id))
  if (known.isPrimed && fresh.length === 0) return
  await update($, seen, () => ({ isPrimed: true, ids: [...known.ids, ...fresh.map(question => question.id)] }))
  if (!known.isPrimed) return
  const lang = await read($, langAtom)
  for (const question of fresh) {
    if (isOpenIn(next, question.id)) $.ui.toast(t(lang, 'toast.newQuestion', { title: question.title }))
  }
}

// The time the pane first saw each delivery. Deliveries already there at the first poll read as seen at time 0,
// long ago, so only the ones that arrive during the session show their status line for a while.
// Written only when the map changed: an equal write still redraws the pane on every poll. Returns the map as it stands.
async function recordDeliveries($: EngineInterface, next: Board, now: number): Promise<Record<string, number>> {
  const primed = (await read($, seen)).isPrimed
  const known: Partial<Record<string, number>> = await read($, deliveredAt)
  const shown = Object.fromEntries(
    next.delivered.map(delivery => [delivery.id, known[delivery.id] ?? (primed ? now : 0)]),
  )
  if (JSON.stringify(shown) !== JSON.stringify(known)) await update($, deliveredAt, () => shown)
  return shown
}

// Merges the folder into the board. The board is written only when the merge changes it.
async function mergeBoard($: EngineInterface, next: Board): Promise<void> {
  const prev = await read($, board)
  const merged = withLocalAnswers(next, prev)
  if (sameBoard(prev, merged)) return
  await update($, board, () => merged)
  // The band passes (`next(e)`) while nothing is open, so it may hold no subscription: ask for the draw.
  $.ui.invalidate('ui.render')
}

// The pane draws from the clock in three ways: the age label of the question on the card (to the minute), the delivery
// lines (their marks are seconds apart) and the footer counts (the 24 h window and the 7-day TTL). The tick is written
// only when one of them would read differently at `now`; a tick that changes no drawn text would redraw the pane on every poll.
async function tickClock($: EngineInterface, now: number, shownAt: Record<string, number>): Promise<void> {
  const last = await read($, clockTick)
  const lang = await read($, langAtom)
  const current = await read($, board)
  const open = openQuestions(current, await read($, leaving))
  const wizard = prunedWizard(await read($, wizardAtom), open)
  const group = flow.activeGroup(flow.groupsOf(open), wizard)
  // Only the question on the card draws an age label: an off-screen question turning its minute changes no drawn text.
  const onCard = group === undefined ? undefined : flow.screenOf(group, wizard)?.question
  const drawnAt = (at: number): string =>
    JSON.stringify([
      onCard === undefined ? null : ageLabel(lang, onCard.ts, at),
      statusLines(lang, current, { cleared: [], shownAt, now: at, leaving: {} }).map(line => line.text),
      footerText(lang, current, at) ?? null,
    ])
  if (drawnAt(last) !== drawnAt(now)) await update($, clockTick, () => now)
}

// The wizard as the open questions leave it: the picks and Other… of answered questions dropped, and the step on the
// question on screen. That question stays on the card while it is still open in the group on screen, even when a
// question before it arrives or leaves; otherwise the step clamps, and a group that changes on screen starts at its
// first question.
function prunedWizard(prev: Wizard, open: readonly Question[]): Wizard {
  const groups = flow.groupsOf([...open])
  const active = flow.activeGroup(groups, prev)
  const switched = prev.groupKey !== null && active !== undefined && active.key !== prev.groupKey
  const from: Wizard = { ...prev, step: anchorStep(prev, active, switched) }
  const pruned = flow.pruneWizard(from, open.map(question => question.id), active?.questions.length ?? 0)
  return { ...pruned, groupKey: active?.key ?? null, questionId: active?.questions[pruned.step]?.id ?? null }
}

// The step before the clamp: the index of the question on screen when it is still in the group on screen.
function anchorStep(prev: Wizard, active: Group | undefined, switched: boolean): number {
  if (switched) return 0
  const anchor = active?.questions.findIndex(question => question.id === prev.questionId) ?? -1
  return anchor >= 0 ? anchor : prev.step
}

// One poll: read the folder, merge it into the board, redraw only when something changed, then announce new questions.
// The interval poll of a session also hands its own answers to its prompt (handDue).
async function pollInbox($: EngineInterface, home: string, ownSession?: string): Promise<void> {
  const next = await readBoard($, home)
  const away = parseAway(await readJson($, `${home}/away.json`))
  const now = await $.clock.now()
  await mergeBoard($, next)
  if ((await read($, isAway)) !== away) await update($, isAway, () => away)
  const shownAt = await recordDeliveries($, next, now)
  await tickClock($, now, shownAt)
  await announceNew($, next)
  await pruneWizardState($)
  if (ownSession !== undefined) await handDue($, home, ownSession, now)
}

// Drops from the wizard what the open questions no longer hold (answered elsewhere). Written by the poll only; the
// pane draws the same pruned value without writing it.
async function pruneWizardState($: EngineInterface): Promise<void> {
  const open = openQuestions(await read($, board), await read($, leaving))
  const prev = await read($, wizardAtom)
  const next = prunedWizard(prev, open)
  const same = (a: Wizard, b: Wizard): boolean => JSON.stringify(a) === JSON.stringify(b)
  // With nothing open the pane draws no card, so a groupKey or questionId that only turns null changes nothing drawn; the
  // write would still redraw the pane and retire the Button handles on screen. A group that opens later still starts at step 0.
  const drawnNothing = open.length === 0 ? { ...next, groupKey: prev.groupKey, questionId: prev.questionId } : next
  if (same(drawnNothing, prev)) return
  await update($, wizardAtom, current => prunedWizard(current, open))
}

// Hands this session's answers to its prompt: one submit for all of them. Only an idle session takes one: a busy
// session gets it from its own hook (askaway.py) when the turn ends, or from the next poll once the turn has completed.
async function handDue($: EngineInterface, home: string, session: string, now: number): Promise<void> {
  if ((await read($, turn)).isBusy) return
  const group = groupBySession(await read($, board), now).find(one => one.session === session)
  if (group === undefined) return
  const ids = group.items.map(item => item.answer.id)
  if (ids.some(id => handing.has(id))) return
  for (const id of ids) handing.add(id)
  try {
    await handOne($, home, session, group.items)
  } catch (error: unknown) {
    logFailure($, error)
    // A marker may already be written and $.fs cannot remove it, so say so instead of failing silently.
    const lang = await read($, langAtom)
    for (const { answer } of group.items) {
      $.ui.toast(t(lang, 'toast.undelivered', { key: answer.key, id: answer.id }))
    }
  } finally {
    for (const id of ids) handing.delete(id)
  }
}

// The delivery marker of each answer first (written only when absent), then ONE submit with their lines joined. A later
// poll sees the markers and never repeats the submit. If the submit fails after the markers, they stay and the caller logs it.
async function handOne(
  $: EngineInterface,
  home: string,
  session: string,
  items: readonly { answer: Answer; text: string }[],
): Promise<void> {
  const lines: string[] = []
  for (const { answer, text } of items) {
    const marker = `${home}/d/${answer.id}.json`
    if (await $.fs.exists(marker)) continue
    const stamp: PromptMarker = { id: answer.id, session, ts: await $.clock.now(), via: 'prompt' }
    await $.fs.write(marker, `${JSON.stringify(stamp)}\n`)
    lines.push(text)
  }
  if (lines.length > 0) await $.prompt.submit({ text: lines.join('\n') })
}

// Answers the question with the chosen option, or with "Other…" and its free text, through the CLI (answerViaCli). First
// writer wins: an answer that already exists is never overwritten, and a question that is not open takes no answer.
// `pressing` holds the ids being answered, so a second press for a card whose first answer is still in flight does nothing.
async function answerEntry($: EngineInterface, home: string, id: string, key: string, text?: string): Promise<boolean> {
  if (pressing.has(id)) return false
  pressing.add(id)
  try {
    return await writeAnswer($, home, id, key, text)
  } finally {
    pressing.delete(id)
  }
}

async function writeAnswer($: EngineInterface, home: string, id: string, key: string, text?: string): Promise<boolean> {
  const current = await read($, board)
  const question = current.questions.find(one => one.id === id)
  const isChoice =
    question !== undefined && (key === OTHER_KEY ? text !== undefined : question.options.some(option => option.key === key))
  if (!isChoice || !isOpenIn(current, id)) return false
  const path = `${home}/a/${id}.json`
  const pressedAt = await $.clock.now()
  // The card dims at once, before the CLI answers: the press gives its feedback without waiting for the disk.
  await startFade($, id, pressedAt)
  const written = await answerViaCli($, home, id, key, text)
  // The board takes the record on disk, whoever wrote it. The CLI stamps its own ts, who and session, so a copy made here
  // would differ from the file and redraw the pane on the next poll.
  const stored = parseAnswer(await readJson($, path), id)
  if (stored !== undefined) await update($, board, prev => withAnswer(prev, stored))
  return written
}

// The panel's only writer of a/<id>.json is the CLI: `askaway.py answer --by panel` publishes with an exclusive link, so
// the first answer from any process wins. The state folder goes in as ASKAWAY_HOME, so the CLI writes the folder the pane
// reads. A run that cannot start, exits non-zero or prints no `written` throws, as a failed write did before. Returns
// whether this answer landed (`written`).
async function answerViaCli($: EngineInterface, home: string, id: string, key: string, text?: string): Promise<boolean> {
  const argv = ['python3', `${$.plugin.root}/scripts/askaway.py`, 'answer', id, key, '--by', 'panel', '--strict']
  if (text !== undefined) argv.push('--text', text)
  const run = await $.process.run(argv, { env: { ASKAWAY_HOME: home } })
  const written = parseAnswerWritten(run.stdout)
  if (run.exitCode !== 0 || written === undefined) {
    throw new Error(`askaway answer failed: ${(run.stderr || run.stdout).trim()}`)
  }
  return written
}

// Marks the card as leaving and, FADE_MS later on the engine clock, lets it go.
async function startFade($: EngineInterface, id: string, pressedAt: number): Promise<void> {
  await update($, leaving, prev => ({ ...prev, [id]: pressedAt }))
  $.clock.after(FADE_MS, () => report($, endFade($, id)))
}

async function endFade($: EngineInterface, id: string): Promise<void> {
  await update($, leaving, prev => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id)))
}

// Dismisses one expired status line. Only its id is recorded, in the plugin's store; no state file is touched.
async function dismissStatus($: EngineInterface, id: string): Promise<void> {
  const ids = [...new Set([...(await read($, cleared)), id])]
  await $.store.set(CLEARED_KEY, ids)
  await update($, cleared, () => ids)
}

// Flips away.json and returns the new state.
async function toggleAway($: EngineInterface, home: string): Promise<boolean> {
  const on = !parseAway(await readJson($, `${home}/away.json`))
  await $.fs.write(`${home}/away.json`, `${JSON.stringify({ on, ts: await $.clock.now() })}\n`)
  await update($, isAway, () => on)
  return on
}

// ASKAWAY_HOME overrides the folder (the CLI and the tests use it; kept so existing data keeps working); otherwise it
// lives under HOME.
async function folderOf($: EngineInterface): Promise<string | undefined> {
  const custom = await $.env.get('ASKAWAY_HOME')
  if (custom) return custom
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/state/askaway` : undefined
}

async function withFolder<T>($: EngineInterface, job: (folder: string) => Promise<T>): Promise<T | undefined> {
  const folder = await folderOf($)
  return folder === undefined ? undefined : job(folder)
}

// What the handlers need, read fresh at each press: the open questions, the group on screen and the pruned wizard.
type Snapshot = {
  open: Question[]
  wizard: Wizard
  groups: Group[]
  group: Group | undefined
  leaving: Record<string, number>
}

async function snapshot($: EngineInterface): Promise<Snapshot> {
  const fading = await read($, leaving)
  const open = openQuestions(await read($, board), fading)
  const wizard = prunedWizard(await read($, wizardAtom), open)
  const groups = flow.groupsOf(open)
  return { open, wizard, groups, group: flow.activeGroup(groups, wizard), leaving: fading }
}

function clearPicks(prev: Wizard, ids: readonly string[], first: string | null): Wizard {
  const drop = new Set(ids)
  return {
    ...prev,
    step: 0,
    questionId: first,
    picks: Object.fromEntries(Object.entries(prev.picks).filter(([id]) => !drop.has(id))),
    other: prev.other !== null && drop.has(prev.other) ? null : prev.other,
  }
}

// Submit all: each question of the group gets its answer through the answer path, then its picks are cleared and the
// step goes back to the first question. Nothing is written unless every question has a pick.
async function submitGroup($: EngineInterface, group: Group, current: Wizard): Promise<void> {
  const items = flow.submittable(group, current)
  const folder = await folderOf($)
  if (items === undefined || folder === undefined || submitting.has(group.key)) return
  submitting.add(group.key)
  try {
    for (const { id, pick } of items) await answerEntry($, folder, id, pick.key, pick.text)
    const ids = items.map(item => item.id)
    await update($, wizardAtom, prev => clearPicks(prev, ids, group.questions[0]?.id ?? null))
  } finally {
    submitting.delete(group.key)
  }
}

async function submitCurrent($: EngineInterface): Promise<void> {
  const { group, wizard } = await snapshot($)
  if (group !== undefined) await submitGroup($, group, wizard)
}

// Records a pick for one question and moves the wizard on. A card that is fading takes nothing. Nothing is submitted
// here: the last question's Submit all is the only submit path.
async function pickOption($: EngineInterface, id: string, choice: Pick): Promise<void> {
  const { open, group, leaving: fading } = await snapshot($)
  if (group === undefined || fading[id] !== undefined || !group.questions.some(question => question.id === id)) return
  await update($, wizardAtom, prev => {
    const chosen = flow.choose(prunedWizard(prev, open), group, id, choice)
    return { ...chosen, other: chosen.other === id ? null : chosen.other }
  })
}

// Moves the wizard with the group on screen; a move that needs the group goes through here. The move starts from the
// wizard as the pane drew it (pruned now), not from the stored one, which the next poll may still have to re-anchor.
async function moveWizard($: EngineInterface, move: (current: Wizard, group: Group) => Wizard): Promise<void> {
  const { open, group } = await snapshot($)
  if (group === undefined) return
  await update($, wizardAtom, prev => move(prunedWizard(prev, open), group))
}

// Opens or closes the "Other…" field of a question. The draft is typed into the field itself, never written here.
async function toggleOther($: EngineInterface, id: string): Promise<void> {
  await update($, wizardAtom, prev => ({ ...prev, other: prev.other === id ? null : id }))
}

// The free text of "Other…" is a pick like an option; blank text is no answer.
async function submitOther($: EngineInterface, id: string, text: string): Promise<void> {
  const trimmed = text.trim()
  if (trimmed === '') return
  await pickOption($, id, { key: OTHER_KEY, text: trimmed })
}

// Opens the pane with focus; the result says whether it is drawn (a narrow terminal leaves it undrawn).
function openPane($: EngineInterface): Promise<{ isPlaced: boolean }> {
  return $.ui.open({ id: PANE, title: TITLE, focus: true })
}

// /askaway lang pt-BR|en|auto (default auto: the environment's locale): stores the choice and switches the language at once.
async function setLang($: EngineInterface, value: string): Promise<string> {
  const choice = LANG_CHOICES.get(value.toLowerCase())
  if (choice === undefined) return t(await read($, langAtom), 'command.langInvalid')
  await $.store.set(LANG_KEY, choice)
  const chosen = resolveLang(choice, await detectedLang($))
  await update($, langAtom, () => chosen)
  return t(chosen, 'command.langSet', { lang: langName(chosen) })
}

async function awayText($: EngineInterface, lang: Lang): Promise<string> {
  const isNowAway = await withFolder($, folder => toggleAway($, folder))
  if (isNowAway === undefined) return t(lang, 'command.awayUnavailable')
  return t(lang, isNowAway ? 'command.awayOn' : 'command.awayOff')
}

const actionsFor = ($: EngineInterface): PaneActions => ({
  dismiss: id => report($, dismissStatus($, id)),
  pick: (id, key) => report($, pickOption($, id, { key })),
  toggleOther: id => report($, toggleOther($, id)),
  submitOther: (id, text) => report($, submitOther($, id, text)),
  back: () => report($, moveWizard($, (current, group) => flow.back(current, group))),
  next: () => report($, moveWizard($, (current, group) => flow.next(current, group))),
  submit: () => report($, submitCurrent($)),
})

export const register: Register = on => {
  let poller: ReturnType<EngineInterface['clock']['every']> | undefined

  on('session.start', async ($, e, next) => {
    const current = await currentLang($)
    await update($, langAtom, () => current)
    // A failed registration (a name already taken, say) must not stop the poll below: the band and the pane draw
    // from the board, and the folder is read only while the poller runs.
    await $.command.register({ name: 'askaway', description: t(current, 'command.describeOpen') }).catch((error: unknown) =>
      logFailure($, error),
    )
    const storedIds = await $.store.get(CLEARED_KEY)
    const ids = Array.isArray(storedIds) ? storedIds.filter((id): id is string => typeof id === 'string') : []
    await update($, cleared, () => ids)
    await update($, turn, () => ({ isBusy: false }))
    await update($, wizardAtom, () => flow.EMPTY_WIZARD)
    const folder = await folderOf($)
    poller?.cancel()
    if (folder !== undefined) {
      // The first poll is awaited, so the first prompt and the first draw already see the folder. Only the interval
      // polls hand answers to the prompt, and they need this session's id.
      await pollInbox($, folder).catch((error: unknown) => logFailure($, error))
      // A hot reload keeps the board, so the first poll writes nothing: the band and the pane are drawn on request.
      $.ui.invalidate('ui.render')
      const ownSession = await $.session.id().catch(() => undefined)
      poller = $.clock.every(POLL_MS, () => report($, pollInbox($, folder, ownSession)))
    }
    return next(e)
  })

  // The main loop's turns. A subagent's turn.complete carries its agentId and leaves the main turn alone.
  on('turn.start', async ($, e, next) => {
    await update($, turn, () => ({ isBusy: true }))
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, turn, () => ({ isBusy: false }))
    return next(e)
  })

  // /askaway opens the pane (or lists the questions when the pane waits undrawn), /askaway lang <v> sets the language,
  // /askaway away toggles away mode.
  on('command.run', { command: 'askaway' }, async ($, e) => {
    const [verb = '', value = ''] = e.args.trim().split(/\s+/)
    const lang = await read($, langAtom)
    if (verb === 'lang') return { text: await setLang($, value) }
    if (verb === 'away') return { text: await awayText($, lang) }
    if (verb !== '') return { text: t(lang, 'command.langInvalid') }
    const opened = await openPane($)
    if (opened.isPlaced) return { text: t(lang, 'command.opened') }
    const open = openQuestions(await read($, board), await read($, leaving))
    return { text: listText(lang, open, await read($, isAway)) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const lang = await read($, langAtom)
    const current = await read($, board)
    const now = await read($, clockTick)
    const fading = await read($, leaving)
    const open = openQuestions(current, fading)
    const wizard = prunedWizard(await read($, wizardAtom), open)
    const groups = flow.groupsOf(open)
    const active = flow.activeGroup(groups, wizard)
    const screen = active === undefined ? undefined : flow.screenOf(active, wizard)
    const view: PaneView = {
      questions: open,
      lines: statusLines(lang, current, {
        cleared: await read($, cleared),
        shownAt: await read($, deliveredAt),
        now,
        leaving: fading,
      }),
      now,
      leaving: fading,
      footer: footerText(lang, current, now),
      groups,
      active,
      wizard,
      screen,
      surface: e.surface,
    }
    return renderPane($.ui.resolve(e), view, actionsFor($), lang, heldFor(e.surface, e.requestId))
  })

  // The band row above the prompt: drawn only while a question is open and no survey is up.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const open = openQuestions(await read($, board), await read($, leaving))
    if (e.props.hasSurvey || open.length === 0) return next(e)
    const lang = await read($, langAtom)
    return renderBand(
      $.ui.resolve(e),
      { lang, questions: open.length, groups: flow.groupsOf(open).length, surface: e.surface },
      () => report($, openPane($)),
      heldFor(e.surface, e.requestId),
    )
  })
}
