// The Askaway hooks module: the poll timer, the state reads and writes of the state folder, the pane, the band row,
// the toast and the /askaway command. $ stays in this file: the engine follows $ only inside the module that holds
// the hook, so the calls on $ live here. Pure rules live in model.ts, the wizard's in wizard.ts, the text in i18n.ts.
import { atom, read, update } from 'claude-code'
import type { ConfigRow, EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Answer, Board, Delivery, PromptMarker, Question } from '../types'
import { renderBand } from './band'
import { heldButtons, type HeldButtons } from './held'
import { detectLang, langName, resolveLang, t, type Lang } from './i18n'
import { themeFamilyOf, type ThemeFamily } from './look'
import { renderPane, type PaneActions, type PaneView } from './pane'
import {
  EMPTY_BOARD,
  OTHER_INPUT_PREFIX,
  OTHER_KEY,
  ageLabel,
  footerText,
  groupBySession,
  isOpenIn,
  leavesOtherField,
  listText,
  openQuestions,
  parseAnswer,
  parseAnswerWritten,
  parseEndedIds,
  whoText,
  parseAway,
  parseDelivery,
  parseCleared,
  parseDraft,
  parseQuestion,
  sameBoard,
  clearableIdsOf,
  historyOf,
  withAnswer,
  withLocalAnswers,
} from './model'
import * as flow from './wizard'
import type { Group, Pick, Wizard } from './wizard'

const PANE = 'askaway'
const PLUGIN = 'askaway'
const TITLE = 'Askaway'
const POLL_MS = 5000
// A draft.json stamped more than this past the clock is not applied: a far-future stamp would hold off every later draft.
const DRAFT_SKEW_MS = 60_000
// An answered card stays listed, dimmed, for this long after the press; then it leaves and its status line shows.
const FADE_MS = 250
// The `list --open` run that finds the ended sessions repeats at most this often while the linked open questions do not change (H11).
const ENDED_RECHECK_MS = 30_000
// The plugin's own store keys: the ids of the History lines the person cleared, and the chosen language.
const CLEARED_KEY = 'cleared'
const LANG_KEY = 'lang'
// The name the person signs answers with: a name, '' once they skipped the question, absent before it was asked.
const WHO_KEY = 'who'
// Quiet mode (/askaway quiet on|off): true stops the toast per new question and the fade after an answer.
const QUIET_KEY = 'quiet'
// The engine's theme row (`$.config.list`, `config.set`): its value names the theme, whose family fills the details block.
const THEME_KEY = 'theme'
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
// The theme family of the engine's theme row: the details block's fill (look.ts DETAILS_FILL). Dark until the row is read.
const themeAtom = atom({ plugin: 'askaway', key: 'theme' } as const, 'dark' as ThemeFamily)
// The open questions whose asking session has ended (`list --open` marks them): the card shows a notice for them.
const endedAtom = atom({ plugin: 'askaway', key: 'ended' } as const, [] as string[])
// The stored answerer name: null before the question was asked, '' after a skip, else the name.
const whoAtom = atom({ plugin: 'askaway', key: 'who' } as const, null as string | null)
const quietAtom = atom({ plugin: 'askaway', key: 'quiet' } as const, false)
const wizardAtom = atom({ plugin: 'askaway', key: 'wizard' } as const, flow.EMPTY_WIZARD)
// The ts of the picks this session last wrote to draft.json or applied from it. A draft with a newer ts is applied.
let draftTs = 0
// The picks whose draft.json write has not landed yet, by question id (undefined: the pick was removed). Each poll retries
// them (H2), so a failed write neither drops the pick from this window nor from the folder's picks.
const unsavedPicks = new Map<string, Pick | undefined>()
// Whether the poll's retry of unsavedPicks failed and the person was told; the toast shows once per failure.
let draftFailing = false
// Whether the last write held the picks because draft.json did not parse. The next write overwrites the file (H1, one held write).
let unreadableHeld = false

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
  if (await read($, quietAtom)) return
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
  const fading = await read($, leaving)
  const open = openQuestions(current, fading)
  const wizard = prunedWizard(await read($, wizardAtom), open)
  const group = flow.activeGroup(flow.groupsOf(open), wizard)
  // Only the question on the card draws an age label: an off-screen question turning its minute changes no drawn text.
  const onCard = group === undefined ? undefined : flow.screenOf(group, wizard)?.question
  const hidden = await read($, cleared)
  const drawnAt = (at: number): string =>
    JSON.stringify([
      onCard === undefined ? null : ageLabel(lang, onCard.ts, at),
      historyOf(lang, current, { cleared: hidden, shownAt, now: at, leaving: fading }),
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

// The last `list --open` run: the linked open ids it covered and when it ran (H11).
let endedCheck: { key: string; at: number } | undefined

// Asks the CLI which open questions belong to an ended session; only questions that name a session can. A run that fails
// keeps what the pane knew. The run repeats when the linked ids change, else at most every ENDED_RECHECK_MS (H11). The atom
// is written only when the list changed, so a poll that learns nothing redraws nothing.
async function refreshEnded($: EngineInterface, home: string, next: Board, now: number): Promise<void> {
  const linked = next.questions.filter(question => question.session !== null && isOpenIn(next, question.id)).map(question => question.id)
  let ended: string[] | undefined = []
  if (linked.length === 0) {
    endedCheck = undefined
  } else {
    const key = linked.sort().join(',')
    if (endedCheck?.key === key && now - endedCheck.at < ENDED_RECHECK_MS) return
    const argv = ['python3', `${$.plugin.root}/scripts/askaway.py`, 'list', '--open']
    const run = await $.process.run(argv, { env: { ASKAWAY_HOME: home } }).catch(() => undefined)
    // A run that fails keeps what the pane knew and is due again at the next poll, so only a run that ran is stamped.
    if (run?.exitCode !== 0) return
    endedCheck = { key, at: now }
    ended = parseEndedIds(run.stdout)
  }
  if (ended !== undefined && JSON.stringify(ended) !== JSON.stringify(await read($, endedAtom))) {
    await update($, endedAtom, () => ended)
  }
}

// Dismiss on an ended card: the CLI removes the question (prune --id), then the board is read again.
async function dismissEnded($: EngineInterface, home: string, id: string): Promise<void> {
  const argv = ['python3', `${$.plugin.root}/scripts/askaway.py`, 'prune', '--id', id, '--strict']
  const run = await $.process.run(argv, { env: { ASKAWAY_HOME: home } })
  if (run.exitCode !== 0) throw new Error(`askaway prune failed: ${(run.stderr || run.stdout).trim()}`)
  await pollInbox($, home)
}

// One poll: read the folder, merge it into the board, redraw only when something changed, then announce new questions.
// The interval poll of a session also hands its own answers to its prompt (handDue).
async function pollInbox($: EngineInterface, home: string, ownSession?: string): Promise<void> {
  const next = await readBoard($, home)
  const away = parseAway(await readJson($, `${home}/away.json`))
  const now = await $.clock.now()
  await mergeBoard($, next)
  await applyCleared($, home)
  await applyDraft($, home)
  await retryDraft($, home)
  await refreshEnded($, home, next, now)
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

const samePicks = (a: Wizard['picks'], b: Wizard['picks']): boolean => JSON.stringify(a) === JSON.stringify(b)

// Whether a wizard holds anything a session start would lose: a card or a group on screen, or a pick.
const hasWizardData = (wizard: Wizard): boolean =>
  wizard.groupKey !== null || wizard.questionId !== null || Object.keys(wizard.picks).length > 0

// Applies the picks of draft.json when it is newer than this session's last write or apply (newest ts wins) and no more
// than DRAFT_SKEW_MS past the clock. Only the picks move: the step, the group and the card stay with this session. A draft
// that moves no pick writes nothing, so the pane is not redrawn on every poll. The picks not yet on disk are laid over the
// draft, so a draft another window wrote does not drop a pick made here. The update reads the wizard again, so a pick
// pressed meanwhile is not thrown away; its own write carries a newer ts than this draft, so the next poll brings it back
// should the apply land first.
async function applyDraft($: EngineInterface, home: string): Promise<void> {
  const draft = parseDraft(await readJson($, `${home}/draft.json`))
  if (draft === undefined || draft.ts <= draftTs || draft.ts > (await $.clock.now()) + DRAFT_SKEW_MS) return
  const open = openQuestions(await read($, board), await read($, leaving))
  const picks = overlay(draft.picks, unsavedPicks)
  const prev = await read($, wizardAtom)
  if (!samePicks(prunedWizard({ ...prev, picks }, open).picks, prev.picks)) {
    await update($, wizardAtom, current => prunedWizard({ ...current, picks }, open))
  }
  draftTs = Math.max(draftTs, draft.ts)
}

// The picks with `changes` laid over them: an undefined change removes its pick.
function overlay(picks: Record<string, Pick>, changes: ReadonlyMap<string, Pick | undefined>): Record<string, Pick> {
  const merged = { ...picks }
  for (const [id, pick] of changes) {
    if (pick === undefined) delete merged[id]
    else merged[id] = pick
  }
  return merged
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
  // A press checks the ended sessions at once: the poll's throttle (H11) must not let a reply reach a session that ended (H9).
  endedCheck = undefined
  await refreshEnded($, home, current, await $.clock.now())
  // A question whose session ended takes no reply: its card offers Dismiss only (H9).
  if ((await read($, endedAtom)).includes(id)) return false
  const path = `${home}/a/${id}.json`
  const pressedAt = await $.clock.now()
  // The card dims at once, before the CLI answers: the press gives its feedback without waiting for the disk.
  if (!(await read($, quietAtom))) await startFade($, id, pressedAt)
  const lang = await read($, langAtom)
  // A reply the CLI could not write (an error or a refused token) is logged and told; the pick stays for another press (H7).
  const written = await answerViaCli($, home, id, key, text).catch((error: unknown) => {
    logFailure($, error)
    $.ui.toast(t(lang, 'toast.replyFailed'))
    return undefined
  })
  if (written === undefined) return false
  // The board takes the record on disk, whoever wrote it. The CLI stamps its own ts, who and session, so a copy made here
  // would differ from the file and redraw the pane on the next poll.
  const stored = parseAnswer(await readJson($, path), id)
  if (stored !== undefined) await update($, board, prev => withAnswer(prev, stored))
  // The CLI keeps the first reply: a refused one names the reply that holds the question, so the person knows which one stays (H8).
  if (!written && stored !== undefined) $.ui.toast(t(lang, 'toast.replyHeld', { key: stored.key }))
  return written
}

// The one-shot credential the CLI's panel answers demand (SPEC.md, "Panel credential"): a random token, recorded in a
// mode-600 file in a mode-700 folder under the state folder, and passed to the CLI in ASKAWAY_PANEL_TOKEN. The CLI spends it.
// A second layer behind the Bash guard, not isolation.
async function mintPanelToken($: EngineInterface, home: string): Promise<string> {
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const dir = `${home}/panel-tokens`
  const file = `${dir}/${token}`
  await $.process.run(['install', '-d', '-m', '700', dir])
  await $.fs.write(file, `${JSON.stringify({ ts: await $.clock.now() })}\n`)
  await $.process.run(['chmod', '600', file])
  return token
}

// The panel's only writer of a/<id>.json is the CLI: `askaway.py answer --by panel` publishes with an exclusive link, so
// the first answer from any process wins. The state folder goes in as ASKAWAY_HOME, so the CLI writes the folder the pane
// reads. A run that cannot start, exits non-zero or prints no `written` throws, as a failed write did before. Returns
// whether this answer landed (`written`).
async function answerViaCli($: EngineInterface, home: string, id: string, key: string, text?: string): Promise<boolean> {
  const argv = ['python3', `${$.plugin.root}/scripts/askaway.py`, 'answer', id, key, '--by', 'panel', '--strict']
  // One `--text=<text>` argument: a text that is itself a word such as `--help` is then never read as an option.
  if (text !== undefined) argv.push(`--text=${text}`)
  const token = await mintPanelToken($, home)
  const who = await read($, whoAtom)
  const env = { ASKAWAY_HOME: home, ASKAWAY_PANEL_TOKEN: token, ...(who ? { ASKAWAY_WHO: who } : {}) }
  const run = await $.process.run(argv, { env })
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

// The ids Clear all wrote to cleared.json; none when the file is absent or malformed.
async function sharedClearedIds($: EngineInterface, home: string): Promise<string[]> {
  return parseCleared(await readJson($, `${home}/cleared.json`))?.ids ?? []
}

// Clear all: every History row drawn now, pending ones included, goes into cleared.json for every session of the folder
// (with the ids it already lists) and into the store as this session's start seed. No answer or delivery file is
// touched, so a cleared pending reply is still read by its session.
async function clearHistory($: EngineInterface): Promise<void> {
  const lang = await read($, langAtom)
  const drawn = historyOf(lang, await read($, board), {
    cleared: await read($, cleared),
    shownAt: await read($, deliveredAt),
    now: await read($, clockTick),
    leaving: await read($, leaving),
  })
  const known = new Set((await read($, board)).answers.map(answer => answer.id))
  const folder = await folderOf($)
  const shared = folder === undefined ? [] : await sharedClearedIds($, folder)
  // This session's own ids are pruned to the answers its board knows; the file's ids are kept as they are, since a board
  // up to one poll behind may not know an answer another session cleared, and a cleared id must never come back.
  const drawnIds = clearableIdsOf(drawn)
  const own = [...new Set([...(await read($, cleared)), ...drawnIds])].filter(id => known.has(id))
  const ids = [...new Set([...shared, ...own])]
  // cleared.json goes first (H10). A failed write is logged; the clear still holds on this window and in the store.
  if (folder !== undefined) {
    const ts = await $.clock.now()
    await $.fs.write(`${folder}/cleared.json`, `${JSON.stringify({ ts, ids })}\n`).catch((error: unknown) => logFailure($, error))
  }
  await $.store.set(CLEARED_KEY, ids)
  await update($, cleared, () => ids)
  // A pending reply is cleared from the pane only: its session still reads it (H25), so the person is told that.
  const delivered = new Set((await read($, board)).delivered.map(delivery => delivery.id))
  if (drawnIds.some(id => !delivered.has(id))) $.ui.toast(t(lang, 'toast.clearedPending', { n: drawnIds.length }))
}

// Clear all of another session: the ids cleared.json lists that this session's atom lacks are added, so the History
// drops those rows at this poll. Written only when it adds something, so a poll that learns nothing redraws nothing.
async function applyCleared($: EngineInterface, home: string): Promise<void> {
  const current = await read($, cleared)
  const missing = (await sharedClearedIds($, home)).filter(id => !current.includes(id))
  if (missing.length === 0) return
  await update($, cleared, prev => [...new Set([...prev, ...missing])])
}

// Stores the name answers are signed with (a skip stores ''). The CLI caps and cleans it again (ASKAWAY_WHO).
async function saveWho($: EngineInterface, text: string): Promise<void> {
  const name = whoText(text) ?? ''
  await $.store.set(WHO_KEY, name)
  await update($, whoAtom, () => name)
}

// /askaway who [name]: shows the stored name, or stores the one given.
async function whoReply($: EngineInterface, lang: Lang, name: string): Promise<string> {
  if (name === '') {
    const current = await read($, whoAtom)
    return current ? t(lang, 'command.whoShow', { name: current }) : t(lang, 'command.whoNone')
  }
  await saveWho($, name)
  const stored = await read($, whoAtom)
  return stored ? t(lang, 'command.whoSet', { name: stored }) : t(lang, 'command.whoNone')
}

// /askaway quiet on|off: stores the flag; with no value it reports it.
async function quietReply($: EngineInterface, lang: Lang, value: string): Promise<string> {
  const choice = value.toLowerCase()
  if (choice !== '' && choice !== 'on' && choice !== 'off') return t(lang, 'command.quietInvalid')
  if (choice !== '') {
    await $.store.set(QUIET_KEY, choice === 'on')
    await update($, quietAtom, () => choice === 'on')
  }
  return t(lang, (await read($, quietAtom)) ? 'command.quietOn' : 'command.quietOff')
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
  }
}

// Writes `changes` to draft.json for every session of the folder: the file's picks (another session may have written since
// this session's last poll) with each changed id set or removed. An id this window's board knows as closed or replied is
// dropped (H27); an id it does not know yet is kept, since another window may have seen its question first. The ts is never
// behind the clock or the last ts this session wrote or applied (H4), and becomes draftTs, so this session's own poll does
// not apply the draft back over its screen. A file that exists but does not parse is held once, so no write drops every
// other session's picks (H1); the next write replaces it with this window's picks and logs it, else no write would land.
async function saveDraft($: EngineInterface, home: string, changes: ReadonlyMap<string, Pick | undefined>): Promise<void> {
  const path = `${home}/draft.json`
  const draft = parseDraft(await readJson($, path))
  const unreadable = draft === undefined && (await $.fs.exists(path))
  if (unreadable && !unreadableHeld) {
    unreadableHeld = true
    throw new Error(`askaway: ${path} does not parse; the picks were not written`)
  }
  if (unreadable) logFailure($, new Error(`${path} does not parse; overwritten with this window's picks`))
  const base = unreadable ? (await read($, wizardAtom)).picks : (draft?.picks ?? {})
  const merged = overlay(base, changes)
  const shown = await read($, board)
  const open = new Set(openQuestions(shown, await read($, leaving)).map(question => question.id))
  const known = new Set(shown.questions.map(question => question.id))
  const picks = flow.keepOpen(merged, new Set(Object.keys(merged).filter(id => open.has(id) || !known.has(id))))
  const ts = Math.max(await $.clock.now(), draftTs + 1)
  await $.fs.write(path, `${JSON.stringify({ ts, picks })}\n`)
  draftTs = ts
  unreadableHeld = false
}

// Writes the picks not yet on draft.json. Returns whether the write landed; a failure is logged and the picks stay pending.
async function writeUnsaved($: EngineInterface, home: string): Promise<boolean> {
  if (unsavedPicks.size === 0) return true
  const batch = new Map(unsavedPicks)
  try {
    await saveDraft($, home, batch)
  } catch (error: unknown) {
    logFailure($, error)
    return false
  }
  for (const [id, pick] of batch) {
    if (unsavedPicks.get(id) === pick) unsavedPicks.delete(id)
  }
  return true
}

// The poll's retry of the pending picks (H2). The person is told once while the write keeps failing; a write that lands
// clears the mark.
async function retryDraft($: EngineInterface, home: string): Promise<void> {
  if (await writeUnsaved($, home)) {
    draftFailing = false
    return
  }
  if (draftFailing) return
  draftFailing = true
  $.ui.toast(t(await read($, langAtom), 'toast.pickNotSaved'))
}

// The one way a pick changes: the wizard is updated, then the picks that moved are queued for draft.json and written for every
// session of the folder. A failed write leaves them queued, and the poll retries; the pick stays on this session's screen.
async function changeWizard($: EngineInterface, change: (prev: Wizard) => Wizard): Promise<void> {
  const before = await read($, wizardAtom)
  await update($, wizardAtom, change)
  const after = await read($, wizardAtom)
  const folder = await folderOf($)
  if (folder === undefined) return
  for (const id of new Set([...Object.keys(before.picks), ...Object.keys(after.picks)])) {
    const pick: Pick | undefined = after.picks[id]
    if (JSON.stringify(before.picks[id]) !== JSON.stringify(pick)) unsavedPicks.set(id, pick)
  }
  await writeUnsaved($, folder)
}

// Submit all: each question of the group gets its answer through the answer path, then its picks are cleared and the
// step goes back to the first question. Nothing is written unless every question has a pick.
// The ids whose pick may go once the submit has run: their reply is on the board, or their session ended (a pick of an ended
// question is dropped, H9). A pick whose press is still in flight stays (H6).
async function settledIds($: EngineInterface, ids: readonly string[]): Promise<string[]> {
  const stored = new Set((await read($, board)).answers.map(answer => answer.id))
  const ended = new Set(await read($, endedAtom))
  return ids.filter(id => stored.has(id) || ended.has(id))
}

// Submit all: the draft other windows wrote is applied first (H5), then each question of the group gets its answer through the
// answer path, and the picks that settled are cleared with the step back on the first question. Nothing is written unless
// every question has a pick.
async function submitGroup($: EngineInterface, group: Group): Promise<void> {
  const folder = await folderOf($)
  if (folder === undefined || submitting.has(group.key)) return
  submitting.add(group.key)
  try {
    await applyDraft($, folder)
    const items = flow.submittable(group, (await snapshot($)).wizard)
    if (items === undefined) return
    for (const { id, pick } of items) await answerEntry($, folder, id, pick.key, pick.text)
    const ids = await settledIds($, items.map(item => item.id))
    await changeWizard($, prev => clearPicks(prev, ids, group.questions[0]?.id ?? null))
  } finally {
    submitting.delete(group.key)
  }
}

async function submitCurrent($: EngineInterface): Promise<void> {
  const { group } = await snapshot($)
  if (group !== undefined) await submitGroup($, group)
}

// The per-question Submit of a tree row: that question's answer goes through the answer path alone, at once. The other
// questions keep their picks for Submit all, and the question leaves the round as Submit all's questions do.
const submittingOne = (id: string): string => `question:${id}`

async function submitOne($: EngineInterface, id: string): Promise<void> {
  const folder = await folderOf($)
  if (folder === undefined || submitting.has(submittingOne(id))) return
  submitting.add(submittingOne(id))
  try {
    await applyDraft($, folder)
    const { open, wizard, leaving: fading } = await snapshot($)
    const group = flow.groupsOf(open).find(one => one.questions.some(question => question.id === id))
    const pick: Pick | undefined = wizard.picks[id]
    if (group === undefined || pick === undefined || fading[id] !== undefined) return
    await answerEntry($, folder, id, pick.key, pick.text)
    const first = group.questions.find(question => question.id !== id)?.id ?? null
    const ids = await settledIds($, [id])
    await changeWizard($, prev => clearPicks(prev, ids, first))
  } finally {
    submitting.delete(submittingOne(id))
  }
}

// Records a pick for one question and moves the wizard on. A card that is fading takes nothing. Nothing is submitted
// here: the last question's Submit all is the only submit path.
async function pickOption($: EngineInterface, id: string, choice: Pick): Promise<void> {
  const { open, group, leaving: fading } = await snapshot($)
  if (group === undefined || fading[id] !== undefined || !group.questions.some(question => question.id === id)) return
  await changeWizard($, prev => flow.choose(prunedWizard(prev, open), group, id, choice))
}

// Moves the wizard with the group on screen; a move that needs the group goes through here. The move starts from the
// wizard as the pane drew it (pruned now), not from the stored one, which the next poll may still have to re-anchor.
async function moveWizard($: EngineInterface, move: (current: Wizard, group: Group) => Wizard): Promise<void> {
  const { open, group } = await snapshot($)
  if (group === undefined) return
  await update($, wizardAtom, prev => move(prunedWizard(prev, open), group))
}

// The "Other…" link focuses the field of its question, which is already open under the link.
async function focusOther($: EngineInterface, id: string): Promise<void> {
  await $.ui.focus({ requestId: PANE, key: `${OTHER_INPUT_PREFIX}${id}` })
}

// The tree's press on a question: the card on screen becomes that question, as if the wizard had walked there with Next or
// Back, and its group becomes the group on screen; then the card scrolls into view. A question that is fading out takes
// nothing.
async function jumpToQuestion($: EngineInterface, id: string): Promise<void> {
  const { open, leaving: fading } = await snapshot($)
  if (fading[id] !== undefined) return
  const target = flow.groupsOf(open).find(group => group.questions.some(question => question.id === id))
  if (target === undefined) return
  await update($, wizardAtom, prev => flow.jumpTo(prunedWizard(prev, open), target, id))
  await $.ui.scroll({ in: PANE, to: { key: `card-${id}` }, block: 'start' })
}

// The Other text typed but not recorded yet, by question id. Typing keeps it here, not in the store, so a key does not
// redraw the pane; it is recorded when the field loses focus, on Enter, and before a nav action (recordPendingOther).
const pendingOther = new Map<string, string>()

// The key the pane's focus ring stood on last, as the ui.focus hook saw it: undefined for one of the engine's own stops.
let focusedKey: string | undefined

// Enter in the "Other…" field records its text as the pick and keeps the card; blank text takes the pick away. A question
// that is not open, or fading out, takes nothing.
async function submitOther($: EngineInterface, id: string, text: string): Promise<void> {
  const { open, leaving: fading } = await snapshot($)
  if (fading[id] !== undefined || !open.some(question => question.id === id)) return
  await changeWizard($, prev => flow.submittedOther(prunedWizard(prev, open), id, text))
}

// Records every pending Other text through submitOther, one after another. An entry whose question is no longer open is
// dropped, not recorded: the card it was typed on is gone.
async function recordPendingOther($: EngineInterface): Promise<void> {
  const { open } = await snapshot($)
  for (const [id, text] of [...pendingOther]) {
    pendingOther.delete(id)
    if (open.some(question => question.id === id)) await submitOther($, id, text)
  }
}

// A nav action records the pending Other text first, so the move or the write reads the pick the person typed. A failure
// is logged, and the action goes on.
async function afterPendingOther($: EngineInterface, act: () => Promise<void>): Promise<void> {
  await recordPendingOther($).catch((error: unknown) => logFailure($, error))
  await act()
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
  clearHistory: () => report($, clearHistory($)),
  dismissEnded: id => report($, withFolder($, folder => dismissEnded($, folder, id))),
  pick: (id, key) => report($, afterPendingOther($, () => pickOption($, id, { key }))),
  focusOther: id => report($, afterPendingOther($, () => focusOther($, id))),
  submitOne: id => report($, afterPendingOther($, () => submitOne($, id))),
  jump: id => report($, afterPendingOther($, () => jumpToQuestion($, id))),
  typeOther: (id, text) => {
    pendingOther.set(id, text)
  },
  submitOther: (id, text) => {
    pendingOther.delete(id)
    report($, submitOther($, id, text))
  },
  back: () => report($, afterPendingOther($, () => moveWizard($, (current, group) => flow.back(current, group)))),
  next: () => report($, afterPendingOther($, () => moveWizard($, (current, group) => flow.next(current, group)))),
  submit: () => report($, afterPendingOther($, () => submitCurrent($))),
  saveWho: text => report($, saveWho($, text)),
  skipWho: () => report($, saveWho($, '')),
})

export const register: Register = on => {
  let poller: ReturnType<EngineInterface['clock']['every']> | undefined

  on('session.start', async ($, e, next) => {
    const current = await currentLang($)
    await update($, langAtom, () => current)
    // A failed read keeps the dark fill, as the rest of the start keeps going past a failure.
    const themeRows = await $.config.list().catch((error: unknown): ConfigRow[] => {
      logFailure($, error)
      return []
    })
    await update($, themeAtom, () => themeFamilyOf(themeRows.find(row => row.key === THEME_KEY)?.value))
    // A failed registration (a name already taken, say) must not stop the poll below: the band and the pane draw
    // from the board, and the folder is read only while the poller runs.
    await $.command.register({ name: 'askaway', description: t(current, 'command.describeOpen') }).catch((error: unknown) =>
      logFailure($, error),
    )
    const storedIds = await $.store.get(CLEARED_KEY)
    const ids = Array.isArray(storedIds) ? storedIds.filter((id): id is string => typeof id === 'string') : []
    await update($, cleared, () => ids)
    const storedWho = await $.store.get(WHO_KEY)
    const storedQuiet = (await $.store.get(QUIET_KEY)) === true
    await update($, quietAtom, () => storedQuiet)
    await update($, whoAtom, () => (typeof storedWho === 'string' ? storedWho : null))
    await update($, turn, () => ({ isBusy: false }))
    // A start keeps the wizard it holds, so a reload keeps the card and its step; only a wizard with no prior data starts empty.
    await update($, wizardAtom, prev => (hasWizardData(prev) ? prev : flow.EMPTY_WIZARD))
    // A session starts with no draft seen: the awaited first poll below applies the picks the folder holds.
    draftTs = 0
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

  // The person changed the theme in /config: the details fill follows the new family, so the pane redraws. A denied change
  // keeps the family the row had, since the engine keeps the old value.
  on('config.set', { key: THEME_KEY }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) await update($, themeAtom, () => themeFamilyOf(result.value))
    return result
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
    const rest = e.args.trim().slice(verb.length).trim()
    const lang = await read($, langAtom)
    if (verb === 'lang') return { text: await setLang($, value) }
    if (verb === 'quiet') return { text: await quietReply($, lang, value) }
    if (verb === 'who') return { text: await whoReply($, lang, rest) }
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
    // With no state folder nothing is polled, so the footer says why away mode cannot be read (H13).
    const folder = await folderOf($)
    const view: PaneView = {
      questions: open,
      history: historyOf(lang, current, {
        cleared: await read($, cleared),
        shownAt: await read($, deliveredAt),
        now,
        leaving: fading,
      }),
      now,
      leaving: fading,
      footer: folder === undefined ? t(lang, 'command.awayUnavailable') : footerText(lang, current, now),
      away: await read($, isAway),
      ended: await read($, endedAtom),
      askWho: (await read($, whoAtom)) === null,
      groups,
      active,
      wizard,
      screen,
      surface: e.surface,
      theme: await read($, themeAtom),
    }
    return renderPane($.ui.resolve(e), view, actionsFor($), lang, heldFor(e.surface, e.requestId))
  })

  // The ring leaving the Other field: the move is passed on first, then the field's pending text is recorded, so a person
  // who never pressed Enter keeps it. The hook never blocks, rewrites or re-targets the move.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const isLeavingOther = leavesOtherField(focusedKey, e.element)
    focusedKey = e.element
    const result = await next(e)
    if (isLeavingOther) await afterPendingOther($, async () => undefined)
    return result
  })

  // Closing the pane drops the pending Other drafts and the remembered ring: their field leaves with the pane.
  on('ui.close', { id: PANE }, (_$, e, next) => {
    pendingOther.clear()
    focusedKey = undefined
    return next(e)
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
