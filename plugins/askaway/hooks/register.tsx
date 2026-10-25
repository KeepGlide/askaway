// The Askaway hooks module: the poll timer, the state reads and writes of the state folder, the pane, the band row,
// the toast and the /askaway command. $ stays in this file: the engine follows $ only inside the module that holds
// the hook, so the calls on $ live here. Pure rules live in model.ts, the wizard's in wizard.ts, the text in i18n.ts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Answer, Board, Delivery, PromptMarker, Question } from '../types'
import { renderBand } from './band'
import { heldButtons, type HeldButtons } from './held'
import { detectLang, resolveLang, t, type Lang } from './i18n'
import { renderPane, type PaneActions, type PaneView } from './pane'
import {
  EMPTY_BOARD,
  OTHER_INPUT_PREFIX,
  OTHER_KEY,
  SUBMIT_ALL_KEY,
  ageLabel,
  answerWho,
  footerText,
  groupBySession,
  isOpenIn,
  leadOf,
  leavesOtherField,
  listText,
  openQuestions,
  otherButtonKey,
  otherInputKey,
  parseAnswer,
  parseAnswerWritten,
  parseEndedIds,
  whoText,
  parseAway,
  parseDelivery,
  parseCleared,
  parseDraft,
  parseQuestion,
  localizedQuestion,
  questionLabel,
  sameBoard,
  clearableIdsOf,
  historyOf,
  withAnswer,
  withLocalAnswers,
  damagedPauseOf,
  NO_DESKTOP_GROUPS,
  parseDesktopGroups,
  withDesktopGroup,
  type DesktopGroups,
} from './model'
import * as flow from './wizard'
import type { Group, Pick, Wizard } from './wizard'

const PANE = 'askaway'
const TITLE = 'Askaway'
const POLL_MS = 5000
// A draft.json stamped more than this past the clock is pulled back to the clock: a far-future stamp would hold off later drafts.
const DRAFT_SKEW_MS = 60_000
// A draft.lock folder this many minutes old or older is a dead window's lock (saveDraft removes it). find's `-mmin +N` matches an
// age above N whole minutes, so the test is `+(minutes - 1)`: `+0` is a minute or older.
const DRAFT_LOCK_STALE_MINUTES = 1
const DRAFT_LOCK_STALE_FIND_ARG = `+${DRAFT_LOCK_STALE_MINUTES - 1}`
// A pick, Next or Back locks the moves for this long: a second press inside the window (a double click) does nothing.
const MOVE_LOCK_MS = 350
// How long the card a pick moved to draws its arrival line.
const ARRIVAL_MS = 1500
// The `list --open` run that finds the ended sessions repeats at most this often while the linked open questions do not change.
const ENDED_RECHECK_MS = 30_000
// The longest text a failed `list --open` run logs after the command's name, in code points: a longer stderr or stdout is cut
// (logEndedListFailure).
const LIST_FAILURE_LOG_MAX = 500
// The plugin's own store keys: the ids of the History lines the person cleared, and the chosen language.
const CLEARED_KEY = 'cleared'
const LANG_KEY = 'lang'
// The name the person signs answers with: a name, '' once they skipped the question, absent before it was asked.
const WHO_KEY = 'who'
// Quiet mode (/askaway quiet on|off): true stops the toast per new question and the fade after an answer.
const QUIET_KEY = 'quiet'
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
// The names /askaway lang shows in its reply: each language's own name (`auto` is shown as the person typed it).
const LANG_NAMES: Readonly<Record<Lang, string>> = { en: 'English', pt: 'Português' }

// The drawn state. The pane and the band draw from these; the poll and the handlers write them, so each change
// redraws the instances that read it. They are declared here because the engine reads atoms in the file that
// reads them.
const board = atom({ plugin: 'askaway', key: 'board' } as const, EMPTY_BOARD)
const isAway = atom({ plugin: 'askaway', key: 'away' } as const, false)
const clockTick = atom({ plugin: 'askaway', key: 'tick' } as const, 0)
// Question ids already seen. The first poll only primes them, so a session start does not toast what is there.
const seen = atom({ plugin: 'askaway', key: 'seen' } as const, { isPrimed: false, ids: [] as string[] })
const cleared = atom({ plugin: 'askaway', key: 'cleared' } as const, [] as string[])
// The cards fading out after a press: question id → press time. The pane is one instance, so a plain atom holds it.
const leaving = atom({ plugin: 'askaway', key: 'leaving' } as const, {} as Record<string, number>)
// Whether this session's main loop is inside a turn: an answer is handed to the prompt only while it is idle.
const turn = atom({ plugin: 'askaway', key: 'turn' } as const, { isBusy: false })
// The language in use, and the question wizard (group, step, picks, Other…).
const langAtom = atom({ plugin: 'askaway', key: 'lang' } as const, DEFAULT_LANG)
// The open questions whose asking session has ended (`list --open` marks them): the card shows a notice for them.
const endedAtom = atom({ plugin: 'askaway', key: 'ended' } as const, [] as string[])
// The damaged q/ files that pause their session (readBoard): the pane's notices.
const damagedAtom = atom({ plugin: 'askaway', key: 'damagedPauses' } as const, [] as string[])
// The stored answerer name: null before the question was asked, '' after a skip, else the name.
const whoAtom = atom({ plugin: 'askaway', key: 'who' } as const, null as string | null)
const quietAtom = atom({ plugin: 'askaway', key: 'quiet' } as const, false)
const wizardAtom = atom({ plugin: 'askaway', key: 'wizard' } as const, flow.EMPTY_WIZARD)
// Whether a move (a pick, Next or Back) ran within MOVE_LOCK_MS: the pane draws its buttons disabled meanwhile.
const moveLockAtom = atom({ plugin: 'askaway', key: 'moveLock' } as const, false)
// The id of the question a pick just moved the card to, for ARRIVAL_MS (markArrival); null otherwise.
const arrivalAtom = atom({ plugin: 'askaway', key: 'arrival' } as const, null as string | null)
// Whether the pane draws the review (every chosen answer, Back and Submit all) in place of the card: set by the pick that
// completes the group, cleared by Back on the review, a jump or a move (leaveReview).
const reviewAtom = atom({ plugin: 'askaway', key: 'review' } as const, false)
// The questions whose last Submit all (or row Submit) did not deliver: the card says so until a submit delivers the pick or
// the pick changes (setUndelivered, forgetUndelivered).
const undeliveredAtom = atom({ plugin: 'askaway', key: 'undelivered' } as const, [] as string[])
// The ts of the picks this session last wrote to draft.json or applied from it. A draft with a newer ts is applied.
let draftTs = 0
// Whether a move (a pick, Next or Back) ran within MOVE_LOCK_MS; cleared by the timer set in moveOnce. The atom mirrors it.
let moveLocked = false
// The changes to draft.json, by question id: a pick or a kept label, undefined when it was removed.
type DraftChanges = { picks: Map<string, Pick | undefined>; labels: Map<string, string | undefined> }
// The picks and kept labels whose draft.json write has not landed yet. Each poll retries them (H2), so a failed write
// neither drops the pick from this window nor from the folder's picks.
const unsaved: DraftChanges = { picks: new Map(), labels: new Map() }
// Whether the poll's retry of unsavedPicks failed and the person was told; the toast shows once per failure.
let draftFailing = false
// The draft.json saves of this window in flight: the poll's retry skips its turn meanwhile rather than meet their draft.lock.
let draftSaves = 0
// The poll running now, undefined when none: a tick that comes meanwhile starts no second poll (the `handing` pattern), and
// a poll asked for meanwhile (Dismiss) runs after it, so two polls never read `seen` or take draft.lock at once.
let polling: Promise<void> | undefined
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

// Names of the JSON files in a folder. A missing folder reads as empty; a folder that exists but cannot be listed reads as
// undefined, so the caller keeps what it knew (one failed listing must not empty the board).
async function jsonIds($: EngineInterface, dir: string): Promise<string[] | undefined> {
  const entries = await $.fs.list(dir).catch(() => undefined)
  if (entries === undefined) return (await $.fs.exists(dir).catch(() => true)) ? undefined : []
  return entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
    .map(entry => entry.name.slice(0, -'.json'.length))
}

// A file may be mid-write or gone between the list and the read. An unreadable or invalid file reads as
// absent (the spec's rule for readers), so the next poll picks it up.
async function readJson($: EngineInterface, path: string): Promise<unknown> {
  return parseJsonText(await $.fs.read(path).catch(() => undefined))
}

function parseJsonText(text: unknown): unknown {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// The away file's state: off when the file is missing, the state kept when it exists but cannot be read (a failed read
// is not a missing file, so it does not flip the pane).
async function readAway($: EngineInterface, home: string, kept: boolean): Promise<boolean> {
  const path = `${home}/away.json`
  const text = await $.fs.read(path).catch(() => undefined)
  if (text === undefined && (await $.fs.exists(path).catch(() => true))) return kept
  return parseAway(parseJsonText(text))
}

// A random lowercase hex string of `bytes` random bytes.
function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

// Writes a file whole or not at all: the text goes to a temp file beside it, and `mv` renames it over the target (a rename
// within one folder is atomic; $.fs has no rename). The temp name is dot-prefixed and random, so two writers of one target
// never share a temp file, and the CLI's `.*.tmp` prune finds an orphan. `mv -T` refuses a folder target instead of moving into it.
export async function writeAtomic($: EngineInterface, path: string, text: string): Promise<void> {
  const temp = tempPathOf(path)
  await $.fs.write(temp, text)
  const run = await $.process.run(['mv', '-fT', temp, path])
  if (run.exitCode !== 0) throw new Error(`askaway: could not move ${temp} into place: ${(run.stderr || run.stdout).trim()}`)
}

// The temp file a write of `path` goes to first: dot-named beside it, with a random part, so two writers never share one.
function tempPathOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return `${path.slice(0, slash + 1)}.${path.slice(slash + 1)}.${randomHex(8)}.tmp`
}

// Publishes text at `marker` only when no file is there, as the CLI's create_once does (an exclusive hard link). True when
// this call published it; false when a readable marker, the CLI's or another window's, already holds the answer. A torn
// marker that is there is replaced, so the answer is still handed once.
async function publishMarker($: EngineInterface, marker: string, id: string, text: string): Promise<boolean> {
  const temp = tempPathOf(marker)
  await $.fs.write(temp, text)
  const linked = await $.process.run(['ln', temp, marker])
  await $.process.run(['rm', '-f', temp])
  if (linked.exitCode === 0) return true
  if (parseDelivery(await readJson($, marker), id) !== undefined) return false
  await writeAtomic($, marker, text)
  return true
}

async function readCached<T>(
  $: EngineInterface,
  dir: string,
  cache: Map<string, T>,
  parse: (raw: unknown, id: string) => T | undefined,
): Promise<{ found: T[]; ids: string[] }> {
  const listed = await jsonIds($, dir)
  // A failed listing keeps the cache as it stands, so this poll reads the folder as the last poll left it.
  const ids = listed ?? [...cache.keys()]
  const found: T[] = []
  for (const id of ids) {
    const value = cache.get(id) ?? parse(await readJson($, `${dir}/${id}.json`), id)
    if (value !== undefined) {
      cache.set(id, value)
      found.push(value)
    }
  }
  if (listed !== undefined) {
    for (const id of [...cache.keys()]) {
      if (!ids.includes(id)) cache.delete(id)
    }
  }
  return { found, ids }
}

// The Desktop config (claude_desktop_config.json) and its sidebar groups. It is read only when its mtime changes (the folder
// listing gives it). ASKAWAY_DESKTOP_CONFIG overrides its path, as the tests use it. A file that is not there names no group,
// and the tree draws as before. A file over DESKTOP_CONFIG_MAX_BYTES, one that cannot be read or parsed, or a folder whose
// listing fails keeps the last good groups: the board never empties on one failed read, and nothing is reported (fail open).
// The cache is written only on a successful read.
const DESKTOP_CONFIG_MAX_BYTES = 4 * 1024 * 1024
let desktopConfigCache: { path: string; mtimeMs: number; groups: DesktopGroups } | undefined

// Forgets the cached config, so the next poll reads it again. The tests call it before each host starts.
export function resetDesktopConfigCache(): void {
  desktopConfigCache = undefined
}

async function desktopConfigPathOf($: EngineInterface): Promise<string | undefined> {
  const custom = await $.env.get('ASKAWAY_DESKTOP_CONFIG')
  if (custom) return custom
  const home = await $.env.get('HOME')
  return home ? `${home}/.config/Claude/claude_desktop_config.json` : undefined
}

// The listing entry of a file in its folder, undefined when the file is not there. A failed listing rejects: that is an error,
// not an absent file.
async function desktopConfigEntryOf($: EngineInterface, path: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  const slash = path.lastIndexOf('/')
  const entries = await $.fs.list(path.slice(0, slash))
  const entry = entries.find(one => one.kind === 'file' && one.name === path.slice(slash + 1))
  return entry === undefined ? undefined : { mtimeMs: entry.mtimeMs, size: entry.size }
}

const lastDesktopGroups = (): DesktopGroups => desktopConfigCache?.groups ?? NO_DESKTOP_GROUPS

async function readDesktopGroups($: EngineInterface): Promise<DesktopGroups> {
  try {
    const path = await desktopConfigPathOf($)
    const entry = path === undefined ? undefined : await desktopConfigEntryOf($, path)
    if (path === undefined || entry === undefined) {
      desktopConfigCache = undefined
      return NO_DESKTOP_GROUPS
    }
    if (desktopConfigCache?.path === path && desktopConfigCache.mtimeMs === entry.mtimeMs) return desktopConfigCache.groups
    if (entry.size > DESKTOP_CONFIG_MAX_BYTES) return lastDesktopGroups()
    const config = parseJsonText(await $.fs.read(path))
    if (config === undefined) return lastDesktopGroups()
    const groups = parseDesktopGroups(config)
    desktopConfigCache = { path, mtimeMs: entry.mtimeMs, groups }
    return groups
  } catch {
    return lastDesktopGroups()
  }
}

// The board, and the ids of the reply files listed in a/ (an unreadable one included), so a poll lists that folder once.
async function readBoard($: EngineInterface, home: string): Promise<{ board: Board; answerFileIds: string[]; damagedPauses: string[] }> {
  const questions = await readCached($, `${home}/q`, questionCache, parseQuestion)
  const answers = await readCached($, `${home}/a`, answerCache, parseAnswer)
  const delivered = await readCached($, `${home}/d`, deliveryCache, parseDelivery)
  const groups = await readDesktopGroups($)
  return {
    board: { questions: questions.found.map(question => withDesktopGroup(question, groups)), answers: answers.found, delivered: delivered.found },
    answerFileIds: answers.ids,
    damagedPauses: await damagedPausesOf($, home, questions, answers.ids, delivered.ids),
  }
}

// The damaged q/ files that pause their session: a file the pane does not read as a question, that damagedPauseOf reads as a
// damaged pause, and that is open (no answer and no delivery marker, as item_status reads it). Only the ids are kept.
async function damagedPausesOf(
  $: EngineInterface,
  home: string,
  questions: { ids: string[]; found: Question[] },
  answeredIds: string[],
  deliveredIds: string[],
): Promise<string[]> {
  const parsedIds = new Set(questions.found.map(question => question.id))
  const pausing: string[] = []
  for (const id of questions.ids) {
    if (parsedIds.has(id) || answeredIds.includes(id) || deliveredIds.includes(id)) continue
    const text = await $.fs.read(`${home}/q/${id}.json`).catch(() => undefined)
    if (damagedPauseOf(id, text)) pausing.push(id)
  }
  return pausing
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
    if (isOpenIn(next, question.id)) $.ui.toast(t(lang, 'toast.newQuestion', { title: questionLabel(localizedQuestion(question, lang)) }))
  }
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
async function tickClock($: EngineInterface, now: number): Promise<void> {
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
      onCard === undefined ? null : leadOf(lang, onCard, at),
      historyOf(lang, current, { cleared: hidden, now: at, leaving: fading }),
      footerText(lang, current, at, hidden) ?? null,
    ])
  if (drawnAt(last) !== drawnAt(now)) await update($, clockTick, () => now)
}

// The wizard as the open questions leave it: the picks and Other… of answered questions dropped, and the step on the
// question on screen. That question stays on the card while it is still open in the group on screen, even when a
// question before it arrives or leaves; otherwise the step clamps, and a group that changes on screen starts at its
// first question.
function prunedWizard(prev: Wizard, open: readonly Question[]): Wizard {
  const groups = flow.groupsOf([...open])
  const active = groupOnScreen(groups, prev)
  // A group whose key vanished (a Desktop config change) is not a switch while the question on screen is still in it.
  const switched =
    prev.groupKey !== null && active !== undefined && active.key !== prev.groupKey && !active.questions.some(question => question.id === prev.questionId)
  const from: Wizard = { ...prev, step: anchorStep(prev, active, switched) }
  const pruned = flow.pruneWizard(from, open.map(question => question.id), active?.questions.length ?? 0)
  return { ...pruned, groupKey: active?.key ?? null, questionId: active?.questions[pruned.step]?.id ?? null }
}

// The group on screen: the one the wizard names while it is still open; else the group that holds the question on screen
// (a Desktop config change can move its questions under a new group key); else the first group.
function groupOnScreen(groups: readonly Group[], prev: Wizard): Group | undefined {
  return (
    groups.find(group => group.key === prev.groupKey) ??
    groups.find(group => group.questions.some(question => question.id === prev.questionId)) ??
    groups[0]
  )
}

// The step before the clamp: the index of the question on screen when it is still in the group on screen.
function anchorStep(prev: Wizard, active: Group | undefined, switched: boolean): number {
  if (switched) return 0
  const anchor = active?.questions.findIndex(question => question.id === prev.questionId) ?? -1
  return anchor >= 0 ? anchor : prev.step
}

// The last `list --open` run: the linked open ids it covered and when it ran.
let endedCheck: { key: string; at: number } | undefined
// The `list --open` failure last logged, undefined once a run succeeds: a run that keeps failing the same way is logged once
// rather than at every 5 s poll (the draftFailing pattern; gauntlet 7 review F8).
let endedListFailure: string | undefined

// Asks the CLI which open questions belong to an ended session; only questions that name a session can. A run that fails
// keeps what the pane knew. The run repeats when the linked ids change, else at most every ENDED_RECHECK_MS; `force` (a reply
// press) runs it whatever the throttle. The atom is written only when the list changed, so a poll that learns nothing redraws
// nothing. The result is the ended ids this call knows (its own run's, or the atom's when the throttle skipped the run), and
// undefined when the list did not run or printed no list, so a press refuses its reply on its own run rather than on a list
// a concurrent poll may rewrite (pane-conc5-1).
async function refreshEnded($: EngineInterface, home: string, next: Board, now: number, force = false): Promise<string[] | undefined> {
  const linked = next.questions.filter(question => question.session !== null && isOpenIn(next, question.id)).map(question => question.id)
  if (linked.length === 0) {
    endedCheck = undefined
    return mergeEnded($, [])
  }
  const key = linked.sort().join(',')
  if (!force && endedCheck?.key === key && now - endedCheck.at < ENDED_RECHECK_MS) return read($, endedAtom)
  const ended = await runEndedList($, home)
  // A run that fails keeps what the pane knew and is due again at the next poll, so only a run that ran is stamped.
  if (ended === undefined) return undefined
  endedCheck = { key, at: now }
  return mergeEnded($, ended)
}

// One `list --open` run: the ended ids it printed. A run that cannot start, exits non-zero or prints output that is not the
// list did not run: it is logged with its exit code and stderr (a press that it refuses only shows a toast) and gives undefined.
async function runEndedList($: EngineInterface, home: string): Promise<string[] | undefined> {
  const argv = ['python3', `${$.plugin.root}/scripts/askaway.py`, 'list', '--open']
  const run = await $.process.run(argv, { env: { ASKAWAY_HOME: home } }).catch((error: unknown) => {
    logEndedListFailure($, `did not start: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  })
  if (run === undefined) return undefined
  const parsed = run.exitCode === 0 ? parseEndedIds(run.stdout) : undefined
  if (parsed === undefined) logEndedListFailure($, `failed (exit ${run.exitCode}): ${(run.stderr || run.stdout).trim()}`)
  else endedListFailure = undefined
  return parsed
}

// Logs a `list --open` run that did not run, its text cut to LIST_FAILURE_LOG_MAX code points and "…": once while it keeps
// failing with the same text, again when the text changes or after a run that succeeded.
function logEndedListFailure($: EngineInterface, detail: string): void {
  const chars = [...detail]
  const cut = chars.length <= LIST_FAILURE_LOG_MAX ? detail : `${chars.slice(0, LIST_FAILURE_LOG_MAX).join('')}…`
  const text = `askaway list --open ${cut}`
  if (text === endedListFailure) return
  endedListFailure = text
  logFailure($, new Error(text))
}

// Writes the ended ids to the atom only when they changed, and gives them back.
async function mergeEnded($: EngineInterface, ended: string[]): Promise<string[]> {
  if (JSON.stringify(ended) !== JSON.stringify(await read($, endedAtom))) await update($, endedAtom, () => ended)
  return ended
}

// Dismiss on an ended or a damaged card: the CLI removes the question (prune --id), then the board is read again. An ended card's pause is
// over and the person pressing Dismiss is the user, so its prune runs with --force, whatever the risk. A damaged card's prune does not:
// a file the CLI reads as a question (a stored NaN literal) is refused, not deleted (Should-4).
async function dismissQuestion($: EngineInterface, home: string, id: string, force: boolean): Promise<void> {
  const argv = ['python3', `${$.plugin.root}/scripts/askaway.py`, 'prune', '--id', id, '--strict', ...(force ? ['--force'] : [])]
  const run = await $.process.run(argv, { env: { ASKAWAY_HOME: home } })
  if (run.exitCode !== 0) throw new Error(`askaway prune failed: ${(run.stderr || run.stdout).trim()}`)
  await pollAfterRunning($, home)
}

// Runs a poll once the poll running now, if any, has ended (pane-conc5-3), and marks it as the one running until it ends.
function pollAfterRunning($: EngineInterface, home: string, ownSession?: string): Promise<void> {
  const run = (polling ?? Promise.resolve()).then(() => pollInbox($, home, ownSession))
  const settled = run.catch(() => undefined)
  polling = settled
  void settled.then(() => {
    if (polling === settled) polling = undefined
  })
  return run
}

// The damaged pauses the pane draws; written only when the list changed, so a poll with no change writes nothing.
async function mergeDamagedPauses($: EngineInterface, damagedPauses: string[]): Promise<void> {
  if (JSON.stringify(damagedPauses) !== JSON.stringify(await read($, damagedAtom))) await update($, damagedAtom, () => damagedPauses)
}

// One poll: read the folder, merge it into the board, redraw only when something changed, then announce new questions.
// The interval poll of a session also hands its own answers to its prompt (handDue).
async function pollInbox($: EngineInterface, home: string, ownSession?: string): Promise<void> {
  const { board: next, answerFileIds, damagedPauses } = await readBoard($, home)
  const away = await readAway($, home, await read($, isAway))
  const now = await $.clock.now()
  await mergeBoard($, next)
  await mergeDamagedPauses($, damagedPauses)
  await applyCleared($, home, answerFileIds)
  await applyDraft($, home)
  await retryDraft($, home)
  await refreshEnded($, home, next, now)
  if ((await read($, isAway)) !== away) await update($, isAway, () => away)
  await tickClock($, now)
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

function sameEntries<V>(a: Record<string, V>, b: Record<string, V>): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Whether a wizard holds anything a session start would lose: a card or a group on screen, a pick or a kept label.
const hasWizardData = (wizard: Wizard): boolean =>
  wizard.groupKey !== null ||
  wizard.questionId !== null ||
  Object.keys(wizard.picks).length > 0 ||
  Object.keys(wizard.labels).length > 0

// Applies the picks and kept labels of draft.json when it is newer than this session's last write or apply (newest ts wins).
// A stamp more than DRAFT_SKEW_MS past the clock is pulled back to the clock, and the draft is applied. Only the picks and
// labels move: the step, the group and the card stay with this session. A draft that moves nothing writes nothing, so the
// pane is not redrawn on every poll. The changes not yet on disk are laid over the draft, so a draft another window wrote
// does not drop a change made here. The update reads the wizard again, so a change made meanwhile is not thrown away; its
// own write carries a newer ts than this draft, so the next poll brings it back should the apply land first.
async function applyDraft($: EngineInterface, home: string): Promise<void> {
  const draft = parseDraft(await readJson($, `${home}/draft.json`))
  if (draft === undefined || draft.ts <= draftTs) return
  const now = await $.clock.now()
  const stamp = draft.ts > now + DRAFT_SKEW_MS ? now : draft.ts
  const open = openQuestions(await read($, board), await read($, leaving))
  const labels = overlay(draft.labels, unsaved.labels)
  const picks = overlay(flow.alignOtherToLabels(draft.picks, labels), unsaved.picks)
  const prev = await read($, wizardAtom)
  const pruned = prunedWizard({ ...prev, picks, labels }, open)
  if (!sameEntries(pruned.picks, prev.picks) || !sameEntries(pruned.labels, prev.labels)) {
    await update($, wizardAtom, current =>
      prunedWizard(
        {
          ...current,
          picks: keepChangedSince(prev.picks, current.picks, picks),
          labels: keepChangedSince(prev.labels, current.labels, labels),
        },
        open,
      ),
    )
  }
  draftTs = Math.max(draftTs, stamp)
}

// The entries to apply: `drafted`, with each entry this window changed since `before` (what the apply read) taken from
// `current`, so a change made in the gap between that read and the update is not thrown away.
function keepChangedSince<V>(before: Record<string, V>, current: Record<string, V>, drafted: Record<string, V>): Record<string, V> {
  const merged: Record<string, V> = { ...drafted }
  for (const id of new Set([...Object.keys(before), ...Object.keys(current)])) {
    if (JSON.stringify(before[id]) === JSON.stringify(current[id])) continue
    if (current[id] === undefined) delete merged[id]
    else merged[id] = current[id]
  }
  return merged
}

// The entries with `changes` laid over them: an undefined change removes its entry.
function overlay<V>(entries: Record<string, V>, changes: ReadonlyMap<string, V | undefined>): Record<string, V> {
  const merged = { ...entries }
  for (const [id, value] of changes) {
    if (value === undefined) delete merged[id]
    else merged[id] = value
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
  let undelivered: Answer[] = []
  try {
    undelivered = await handOne($, home, session, group.items)
  } catch (error: unknown) {
    logFailure($, error)
  } finally {
    for (const id of ids) handing.delete(id)
  }
  // A marker may already be written and $.fs cannot remove it, so say so instead of failing silently.
  if (undelivered.length === 0) return
  const lang = await read($, langAtom)
  for (const answer of undelivered) {
    $.ui.toast(t(lang, 'toast.undelivered', { key: answer.key, id: answer.id }))
  }
}

// The delivery marker of each answer first, published only when no marker is there, then ONE submit with the lines of the
// markers this call published. An answer whose marker write fails has no line; an answer another window or the CLI marked
// first is skipped and is not returned. If the submit fails after the markers, they stay, and the answers this call marked
// are returned with the unmarked ones, for the caller to report. A later poll sees the markers and never repeats the submit.
async function handOne(
  $: EngineInterface,
  home: string,
  session: string,
  items: readonly { answer: Answer; text: string }[],
): Promise<Answer[]> {
  const lines: string[] = []
  const marked: Answer[] = []
  const unmarked: Answer[] = []
  for (const { answer, text } of items) {
    const marker = `${home}/d/${answer.id}.json`
    // A marker that does not parse is no marker (a torn write): publishMarker replaces it, so the answer is handed once and not never.
    if (parseDelivery(await readJson($, marker), answer.id) !== undefined) continue
    try {
      const stamp: PromptMarker = { id: answer.id, session, ts: await $.clock.now(), via: 'prompt' }
      if (await publishMarker($, marker, answer.id, `${JSON.stringify(stamp)}\n`)) {
        lines.push(text)
        marked.push(answer)
      }
    } catch (error: unknown) {
      logFailure($, error)
      unmarked.push(answer)
    }
  }
  if (lines.length === 0) return unmarked
  try {
    await $.prompt.submit({ text: lines.join('\n') })
  } catch (error: unknown) {
    logFailure($, error)
    return [...unmarked, ...marked]
  }
  return unmarked
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
  const pressedAt = await $.clock.now()
  // The card dims at once, before the ended check and the CLI: the press gives its feedback without waiting for the disk.
  const fading = !(await read($, quietAtom))
  if (fading) await startFade($, id, pressedAt)
  // The card dims until the reply is written. Every exit ends the fade here: a written reply takes the card off the board
  // first, and a refused or failed press brings it back, including when a read, a write or a toast throws.
  try {
    const lang = await read($, langAtom)
    // A press runs its own ended check at once (force): the poll's throttle must not let a reply reach a session that ended,
    // and the press reads its own run's ids, not the atom a concurrent poll may rewrite. A check that did not run refuses the
    // reply too: the person is told, and the pick stays for another press.
    const ended = await refreshEnded($, home, current, pressedAt, true)
    if (ended === undefined) {
      $.ui.toast(t(lang, 'toast.replyFailed'))
      return false
    }
    // A question whose session ended takes no reply: its card offers Dismiss only.
    if (ended.includes(id)) return false
    const path = `${home}/a/${id}.json`
    // A reply the CLI could not write (an error or a refused token) is logged and told; the pick stays for another press.
    const written = await answerViaCli($, home, id, key, text).catch((error: unknown) => {
      logFailure($, error)
      $.ui.toast(t(lang, 'toast.replyFailed'))
      return undefined
    })
    if (written === undefined) return false
    // The board takes the record on disk, whoever wrote it. The CLI stamps its own ts, who and session, so a copy made here
    // would differ from the file and redraw the pane on the next poll.
    const stored = parseAnswer(await readJson($, path), id)
    // A written reply whose file does not read back yet still takes the card off the board: a copy made here stands in until a
    // poll reads the file (withLocalAnswers), so the card does not come back active and a second press is not refused (pane-exec3-3).
    // The copy carries the who the CLI stamped (panelWho), so a hand-off made before the file reads names the person as the
    // CLI's own line does, not "unknown" (gauntlet 7 review F6).
    const local: Answer = { id, key, by: 'panel', ts: pressedAt, ...(key === OTHER_KEY && text !== undefined ? { text } : {}) }
    const shown = stored ?? (written ? { ...local, who: await panelWho($) } : undefined)
    if (shown !== undefined) await update($, board, prev => withAnswer(prev, shown))
    // The CLI keeps the first reply: a refused one names the reply that holds the question, so the person knows which one stays.
    if (!written && stored !== undefined) $.ui.toast(t(lang, 'toast.replyHeld', { key: stored.key }))
    return written
  } finally {
    if (fading) await endFade($, id).catch((error: unknown) => logFailure($, error))
  }
}

// The one-shot credential the CLI's panel answers demand (SPEC.md, "Panel credential"): a random token, recorded in a
// mode-600 file in a mode-700 folder under the state folder, and passed to the CLI in ASKAWAY_PANEL_TOKEN. The CLI spends it.
// A second layer behind the Bash guard, not isolation.
async function mintPanelToken($: EngineInterface, home: string): Promise<string> {
  const token = randomHex(16)
  const dir = `${home}/panel-tokens`
  const file = `${dir}/${token}`
  await $.process.run(['install', '-d', '-m', '700', dir])
  // The file is created at mode 600 before it gets its text, and set to 600 again after the write: $.fs.write takes no mode,
  // and a write by temp file and rename would leave the default mode. A failed install or chmod throws: no token is handed out.
  // The error names the exit code only: the file's name is the token, so neither its path nor the command's stderr (which
  // names the path) reaches the throw or the log.
  const made = await $.process.run(['install', '-m', '600', '/dev/null', file])
  if (made.exitCode !== 0) throw new Error(`askaway: could not create the panel token file (install exit ${made.exitCode})`)
  await $.fs.write(file, `${JSON.stringify({ ts: await $.clock.now() })}\n`)
  const mode = await $.process.run(['chmod', '600', file])
  if (mode.exitCode !== 0) throw new Error(`askaway: could not set the panel token file to mode 600 (chmod exit ${mode.exitCode})`)
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

// The who the CLI stamps on a panel answer (askaway.py's answerer_name, through answerWho): the stored name answerViaCli
// sends as ASKAWAY_WHO, else this window's own ASKAWAY_WHO, which the CLI inherits, else the OS user name getpass.getuser()
// reads from the environment (the first of LOGNAME, USER, LNAME and USERNAME set to a non-empty text), else "unknown".
// getpass's last resort, the password database, is out of the pane's reach: with none of the four set, the copy says
// "unknown" where the CLI may name the account.
async function panelWho($: EngineInterface): Promise<string> {
  const stored = await read($, whoAtom)
  const askawayWho = stored ? stored : await $.env.get('ASKAWAY_WHO')
  const users = await Promise.all([$.env.get('LOGNAME'), $.env.get('USER'), $.env.get('LNAME'), $.env.get('USERNAME')])
  return answerWho(askawayWho, users.find(user => user !== undefined && user !== ''))
}

// Marks the card as leaving; writeAnswer's finally ends the fade, once the reply is written or when the press is refused or fails.
async function startFade($: EngineInterface, id: string, pressedAt: number): Promise<void> {
  await update($, leaving, prev => ({ ...prev, [id]: pressedAt }))
}

async function endFade($: EngineInterface, id: string): Promise<void> {
  await update($, leaving, prev => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id)))
}

// The ids Clear all wrote to cleared.json; none when the file is absent or malformed.
async function sharedClearedIds($: EngineInterface, home: string): Promise<string[]> {
  return parseCleared(await readJson($, `${home}/cleared.json`))?.ids ?? []
}

// The ids cleared.json lists that still have a reply: a reply file on disk or a reply on the board. The others are dead.
async function liveSharedIds($: EngineInterface, folder: string, known: ReadonlySet<string>, ids: string[]): Promise<string[]> {
  const live: string[] = []
  for (const id of ids) {
    if (known.has(id) || (await $.fs.exists(`${folder}/a/${id}.json`))) live.push(id)
  }
  return live
}

// Clear all: every History row drawn now, pending ones included, goes into cleared.json for every session of the folder
// (with the ids it already lists) and into the store as this session's start seed. No answer or delivery file is
// touched, so a cleared pending reply is still read by its session.
async function clearHistory($: EngineInterface): Promise<void> {
  const lang = await read($, langAtom)
  const drawn = historyOf(lang, await read($, board), {
    cleared: await read($, cleared),
    now: await read($, clockTick),
    leaving: await read($, leaving),
  })
  const known = new Set((await read($, board)).answers.map(answer => answer.id))
  const folder = await folderOf($)
  const shared = folder === undefined ? [] : await sharedClearedIds($, folder)
  // This session's own ids are pruned to the answers its board knows. The file's ids stay while their reply file is on disk,
  // even when a board up to one poll behind does not know the reply yet, since a cleared id must never come back. Only the
  // dead ones go (no reply file, no reply on the board): this write is the one place that drops them from the file.
  const drawnIds = clearableIdsOf(drawn)
  const own = [...new Set([...(await read($, cleared)), ...drawnIds])].filter(id => known.has(id))
  const live = folder === undefined ? [] : await liveSharedIds($, folder, known, shared)
  const ids = [...new Set([...live, ...own])]
  // cleared.json goes first (H10). A failed write is logged; the clear still holds on this window and in the store.
  if (folder !== undefined) {
    const ts = await $.clock.now()
    await writeAtomic($, `${folder}/cleared.json`, `${JSON.stringify({ ts, ids })}\n`).catch((error: unknown) => logFailure($, error))
  }
  await $.store.set(CLEARED_KEY, ids)
  await update($, cleared, () => ids)
  // A pending reply is cleared from the pane only: its session still reads it (H25), so the person is told that.
  const delivered = new Set((await read($, board)).delivered.map(delivery => delivery.id))
  if (drawnIds.some(id => !delivered.has(id))) $.ui.toast(t(lang, 'toast.clearedPending', { n: drawnIds.length }))
}

// Clear all of another session: the ids cleared.json lists that this session's atom lacks are added, so the History
// drops those rows at this poll. An id with no reply file (the a/ listing of readBoard, an unreadable file included) and
// no answer on the board, which prune left behind, leaves the atom and the store seed. A poll never writes cleared.json:
// the next Clear all drops those ids from the file (clearHistory). A poll that learns nothing writes and redraws nothing.
async function applyCleared($: EngineInterface, home: string, answerFileIds: readonly string[]): Promise<void> {
  const current = await read($, cleared)
  const sharedIds = await sharedClearedIds($, home)
  const answered = new Set((await read($, board)).answers.map(answer => answer.id))
  const replied = new Set(answerFileIds)
  const kept = [...new Set([...current, ...sharedIds])].filter(id => answered.has(id) || replied.has(id))
  if (JSON.stringify(kept) !== JSON.stringify(current)) {
    await update($, cleared, () => kept)
    await $.store.set(CLEARED_KEY, kept)
  }
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
  const on = !(await readAway($, home, await read($, isAway)))
  await writeAtomic($, `${home}/away.json`, `${JSON.stringify({ on, ts: await $.clock.now() })}\n`)
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

// Drops the picks of the settled questions. `first` is the question the step goes back to (Submit all); without it the
// step and the card stay where they are (a row's Submit), and the prune moves the card on once its question leaves.
function clearPicks(prev: Wizard, ids: readonly string[], first?: string | null): Wizard {
  const drop = new Set(ids)
  const picks = Object.fromEntries(Object.entries(prev.picks).filter(([id]) => !drop.has(id)))
  return first === undefined ? { ...prev, picks } : { ...prev, step: 0, questionId: first, picks }
}

// Writes `changes` to draft.json for every session of the folder: the file's picks (another session may have written since
// this session's last poll) with each changed id set or removed. An id this window's board knows as closed or replied is
// dropped (H27); an id it does not know yet is kept, since another window may have seen its question first. The ts is never
// behind the clock or the last ts this session wrote or applied (H4), and becomes draftTs, so this session's own poll does
// not apply the draft back over its screen. A file that exists but does not parse is held once, so no write drops every
// other session's picks (H1); the next write replaces it with this window's picks and logs it, else no write would land.
// The read, the merge and the write run under draft.lock, so a window's pick is never merged into a draft another window is
// writing; a write that finds the lock held throws, and the pick stays pending for the next poll.
async function saveDraft($: EngineInterface, home: string, changes: DraftChanges): Promise<void> {
  if (!(await takeDraftLock($, home))) throw new Error(`askaway: ${home}/draft.json is locked by another window; the pick is retried`)
  try {
    await mergeDraft($, home, changes)
  } finally {
    await $.process.run(['rmdir', `${home}/draft.lock`])
  }
}

// The lock on draft.json is the folder draft.lock: mkdir is atomic, so one window holds it at a time. A lock older than
// DRAFT_LOCK_STALE_MINUTES is a window that died mid-write: it is removed here, with the draft.json temp files that window
// left beside it (the same age, so a temp file a live write is still filling is never touched), and the write waits for the next poll.
async function takeDraftLock($: EngineInterface, home: string): Promise<boolean> {
  const lock = `${home}/draft.lock`
  if ((await $.process.run(['mkdir', lock])).exitCode === 0) return true
  const stale = (await $.process.run(['find', lock, '-maxdepth', '0', '-mmin', DRAFT_LOCK_STALE_FIND_ARG])).stdout.trim() !== ''
  if (stale) {
    await $.process.run(['rmdir', lock])
    await $.process.run(['find', home, '-maxdepth', '1', '-name', '.draft.json.*.tmp', '-mmin', DRAFT_LOCK_STALE_FIND_ARG, '-delete'])
  }
  return false
}

// The merge of saveDraft, under its lock: the file's picks and labels with `changes` laid over them, written whole.
async function mergeDraft($: EngineInterface, home: string, changes: DraftChanges): Promise<void> {
  const path = `${home}/draft.json`
  const draft = parseDraft(await readJson($, path))
  const unreadable = draft === undefined && (await $.fs.exists(path))
  if (unreadable && !unreadableHeld) {
    unreadableHeld = true
    throw new Error(`askaway: ${path} does not parse; the picks were not written`)
  }
  if (unreadable) logFailure($, new Error(`${path} does not parse; overwritten with this window's picks`))
  const stored = unreadable ? await read($, wizardAtom) : draft
  const picks = overlay(stored?.picks ?? {}, changes.picks)
  const labels = overlay(stored?.labels ?? {}, changes.labels)
  const shown = await read($, board)
  const open = new Set(openQuestions(shown, await read($, leaving)).map(question => question.id))
  const known = new Set(shown.questions.map(question => question.id))
  const listed = new Set([...Object.keys(picks), ...Object.keys(labels)])
  const kept = new Set([...listed].filter(id => open.has(id) || !known.has(id)))
  const ts = Math.max(await $.clock.now(), draftTs + 1)
  // A draft with no kept label keeps the shape it had before labels: the labels key is written only when one is kept.
  const keptLabels = flow.keepOpen(labels, kept)
  const labelsPart = Object.keys(keptLabels).length > 0 ? { labels: keptLabels } : {}
  await writeAtomic($, path, `${JSON.stringify({ ts, picks: flow.keepOpen(picks, kept), ...labelsPart })}\n`)
  draftTs = ts
  unreadableHeld = false
}

// Drops from `queue` the changes a write has landed: those that still hold the value the write carried.
function forgetLanded<V>(queue: Map<string, V>, landed: ReadonlyMap<string, V>): void {
  for (const [id, value] of landed) {
    if (queue.get(id) === value) queue.delete(id)
  }
}

// Writes the picks and labels not yet on draft.json. Returns whether the write landed; a failure is logged and they stay pending.
async function writeUnsaved($: EngineInterface, home: string): Promise<boolean> {
  if (unsaved.picks.size === 0 && unsaved.labels.size === 0) return true
  const batch: DraftChanges = { picks: new Map(unsaved.picks), labels: new Map(unsaved.labels) }
  draftSaves += 1
  try {
    await saveDraft($, home, batch)
  } catch (error: unknown) {
    logFailure($, error)
    return false
  } finally {
    draftSaves -= 1
  }
  forgetLanded(unsaved.picks, batch.picks)
  forgetLanded(unsaved.labels, batch.labels)
  return true
}

// The poll's retry of the pending picks (H2). The person is told once while the write keeps failing; a write that lands
// clears the mark.
async function retryDraft($: EngineInterface, home: string): Promise<void> {
  // A save of this window holds draft.lock now: the retry would only meet that lock and report a failure (pane-conc5-2). The
  // changes the save did not take stay queued for the next poll.
  if (draftSaves > 0) return
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
  queueChanges(before.picks, after.picks, unsaved.picks)
  queueChanges(before.labels, after.labels, unsaved.labels)
  await writeUnsaved($, folder)
}

// Queues each id whose entry differs between `before` and `after` (undefined when it was removed).
function queueChanges<V>(before: Record<string, V>, after: Record<string, V>, queue: Map<string, V | undefined>): void {
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const value: V | undefined = after[id]
    if (JSON.stringify(before[id]) !== JSON.stringify(value)) queue.set(id, value)
  }
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

// Records the outcome of a submit for the questions it asked: one that is not settled keeps its pick as a draft, and its card
// says so; the others leave the list. Questions that were not asked keep their entries.
async function setUndelivered($: EngineInterface, asked: readonly string[], settled: readonly string[]): Promise<void> {
  const failed = asked.filter(id => !settled.includes(id))
  await update($, undeliveredAtom, prev => [...prev.filter(id => !asked.includes(id)), ...failed])
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
    // Each answer takes the pick on screen when its turn comes: a pick changed during the earlier writes is the one sent.
    for (const { id } of items) {
      const pick: Pick | undefined = (await snapshot($)).wizard.picks[id]
      if (pick !== undefined) await answerEntry($, folder, id, pick.key, pick.text)
    }
    const ids = await settledIds($, items.map(item => item.id))
    await setUndelivered($, items.map(item => item.id), ids)
    await changeWizard($, prev => clearPicks(prev, ids, group.questions[0]?.id ?? null))
    // The review belongs to the group just sent: a later group must not draw it with one question picked.
    await update($, reviewAtom, () => false)
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
    const ids = await settledIds($, [id])
    await setUndelivered($, [id], ids)
    await changeWizard($, prev => clearPicks(prev, ids))
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
  await forgetUndelivered($, id)
  if (await reviewIfComplete($, group)) return
  const after = await read($, wizardAtom)
  if (after.questionId !== null && after.questionId !== id) await markArrival($, after.questionId)
}

// The review after a pick, or after an Other text recorded from its field: drawn when that leaves every question of a group of
// two or more picked (SPEC, Review). Returns whether it drew the review.
async function reviewIfComplete($: EngineInterface, group: Group): Promise<boolean> {
  if (group.questions.length < 2 || flow.submittable(group, await read($, wizardAtom)) === undefined) return false
  await update($, reviewAtom, () => true)
  return true
}

// A pick that changes is no longer the one a submit failed on, so its card drops the not-delivered line.
async function forgetUndelivered($: EngineInterface, id: string): Promise<void> {
  await update($, undeliveredAtom, prev => prev.filter(one => one !== id))
}

// Leaves the review for the card of the question on screen (Back on the review, a jump, a move). The arrival line goes
// too: it marks the pick that just moved the card, and a move or a jump away from that card is no longer that pick.
const leaveReview = async ($: EngineInterface): Promise<void> => {
  await update($, reviewAtom, () => false)
  await update($, arrivalAtom, () => null)
}

// Marks the card a pick moved to, so it draws its arrival line for ARRIVAL_MS: the move itself is instant, and two cards of
// one group often look alike. A later arrival replaces it; the timer clears only its own.
async function markArrival($: EngineInterface, id: string): Promise<void> {
  await update($, arrivalAtom, () => id)
  $.clock.after(ARRIVAL_MS, () => report($, update($, arrivalAtom, prev => (prev === id ? null : prev))))
}

// Moves the wizard with the group on screen; a move that needs the group goes through here. The move starts from the
// wizard as the pane drew it (pruned now), not from the stored one, which the next poll may still have to re-anchor.
async function moveWizard($: EngineInterface, move: (current: Wizard, group: Group) => Wizard): Promise<void> {
  const { open, group } = await snapshot($)
  if (group === undefined) return
  await leaveReview($)
  await update($, wizardAtom, prev => move(prunedWizard(prev, open), group))
}

// The "Other…" link focuses the field of its question, which is already open under the link.
async function focusOther($: EngineInterface, id: string): Promise<void> {
  await $.ui.focus({ requestId: PANE, key: otherInputKey(id, (await read($, wizardAtom)).fieldRound) })
}

// The tree's press on a question: the card on screen becomes that question, as if the wizard had walked there with Next or
// Back, and its group becomes the group on screen; then the card scrolls into view. A question that is fading out takes
// nothing.
async function jumpToQuestion($: EngineInterface, id: string): Promise<void> {
  const { open, leaving: fading } = await snapshot($)
  if (fading[id] !== undefined) return
  const target = flow.groupsOf(open).find(group => group.questions.some(question => question.id === id))
  if (target === undefined) return
  await leaveReview($)
  await update($, wizardAtom, prev => flow.jumpTo(prunedWizard(prev, open), target, id))
  await $.ui.scroll({ in: PANE, to: { key: `card-${id}` }, block: 'start' })
}

// The Other text typed but not recorded yet, by question id. Typing keeps it here, not in the store, so a key does not
// redraw the pane; it is recorded when the field loses focus and before a nav action (recordPendingOther), and Keep drops it.
const pendingOther = new Map<string, string>()

// How a typed Other text becomes the pick: the label rule (flow.submittedOther) or Submit all's (flow.submittedTypedOther).
type OtherRecord = typeof flow.submittedOther

// The key the pane's focus ring stood on last, as the ui.focus hook saw it: undefined for one of the engine's own stops.
let focusedKey: string | undefined

// True when a focus move takes the typed Other text off the ring. From Submit all it counts for an element that is not an
// Other field: Submit all's own press records the text, but a move off it must not drop the text the pane then clears.
function leavesOtherText(previous: string | undefined, next: string | undefined): boolean {
  if (previous === SUBMIT_ALL_KEY) return next !== SUBMIT_ALL_KEY && next?.startsWith(OTHER_INPUT_PREFIX) !== true
  return leavesOtherField(previous, next) && next !== SUBMIT_ALL_KEY
}

// The text of an "Other…" field recorded as the pick, not kept: blank text takes the pick away. A question
// that is not open, or fading out, takes nothing.
async function submitOther($: EngineInterface, id: string, text: string, record: OtherRecord): Promise<void> {
  const { open, leaving: fading } = await snapshot($)
  if (fading[id] !== undefined || !open.some(question => question.id === id)) return
  await changeWizard($, prev => record(prunedWizard(prev, open), id, text))
  await forgetUndelivered($, id)
  // The recorded text may complete the group: the review follows, as after an option pick.
  const group = flow.groupsOf(open).find(one => one.questions.some(question => question.id === id))
  if (group !== undefined) await reviewIfComplete($, group)
}

// Keep in the "Other…" field (Enter, or the Keep button) moves its text to the question's label and empties the field: the
// focus goes to the Other button, which now draws the label. Blank text keeps nothing and leaves the field as it is. A
// question that is not open, or fading out, takes nothing.
async function keepOther($: EngineInterface, id: string, text: string): Promise<void> {
  const { open, leaving: fading } = await snapshot($)
  if (fading[id] !== undefined || !open.some(question => question.id === id) || text.trim() === '') return
  await changeWizard($, prev => flow.keptOther(prunedWizard(prev, open), id, text))
  await $.ui.focus({ requestId: PANE, key: otherButtonKey(id) })
}

// Records every pending Other text through submitOther, one after another. An entry whose question is no longer open is
// dropped, not recorded: the card it was typed on is gone. On a blur (`keepsSetAside`), a text a kept label sets aside
// (flow.setsTypedOtherAside) stays pending, as its field is still on screen, so a later Submit all sends the text the field
// shows (SPEC, Other; pane-exec3-1). A nav action drops it: Next and Back take the field off screen, and a pick, a jump or a
// row's Submit chooses something else.
async function recordPendingOther($: EngineInterface, record: OtherRecord, keepsSetAside = false): Promise<void> {
  const { open, wizard } = await snapshot($)
  for (const [id, text] of [...pendingOther]) {
    const isOpen = open.some(question => question.id === id)
    if (keepsSetAside && isOpen && flow.setsTypedOtherAside(wizard, id)) continue
    pendingOther.delete(id)
    if (isOpen) await submitOther($, id, text, record)
  }
}

// A nav action records the pending Other text first, so the move or the write reads the pick the person typed. A failure
// is logged, and the action goes on. Submit all passes its own record (a kept label does not stop the typed answer).
async function afterPendingOther($: EngineInterface, act: () => Promise<void>, record: OtherRecord = flow.submittedOther): Promise<void> {
  await recordPendingOther($, record).catch((error: unknown) => logFailure($, error))
  await act()
}

// Opens the pane with focus; the result says whether it is drawn (a narrow terminal leaves it undrawn).
function openPane($: EngineInterface): Promise<{ isPlaced: boolean }> {
  return $.ui.open({ id: PANE, title: TITLE, focus: true })
}

// Registers /askaway with the description of the language; /askaway lang calls it again (M69). Whether the engine
// takes a changed description from a second registration is not verified; a refusal is logged once (SPEC, Lang).
async function registerCommand($: EngineInterface, lang: Lang): Promise<void> {
  await $.command.register({ name: 'askaway', description: t(lang, 'command.describeOpen') }).catch((error: unknown) =>
    logFailure($, error),
  )
}

// /askaway lang pt-BR|en|auto (default auto: the environment's locale): stores the choice and switches the language at once.
async function setLang($: EngineInterface, value: string): Promise<string> {
  const choice = LANG_CHOICES.get(value.toLowerCase())
  if (choice === undefined) return t(await read($, langAtom), 'command.langInvalid')
  await $.store.set(LANG_KEY, choice)
  const chosen = resolveLang(choice, await detectedLang($))
  await update($, langAtom, () => chosen)
  await registerCommand($, chosen)
  // The engine keeps the pane's last draw until something asks for a new one (the poll does so in mergeBoard):
  // ask now, so the open card changes language with the labels instead of at the next question.
  $.ui.invalidate('ui.render')
  return t(chosen, 'command.langSet', { lang: choice === 'auto' ? choice : LANG_NAMES[chosen] })
}

async function awayText($: EngineInterface, lang: Lang): Promise<string> {
  const isNowAway = await withFolder($, folder => toggleAway($, folder))
  if (isNowAway === undefined) return t(lang, 'command.awayUnavailable')
  return t(lang, isNowAway ? 'command.awayOn' : 'command.awayOff')
}

// Dismiss on an ended or a damaged card: a prune the CLI refuses leaves the question listed, and the person is told by a toast; the cause is logged.
async function dismissOrSay($: EngineInterface, id: string, force: boolean): Promise<void> {
  await withFolder($, folder => dismissQuestion($, folder, id, force)).catch(async (error: unknown) => {
    logFailure($, error)
    $.ui.toast(t(await read($, langAtom), 'toast.dismissFailed'))
  })
}

// Sets the move lock: the flag the guard reads, and the atom the pane draws its buttons disabled from (so the pane redraws).
function setMoveLock($: EngineInterface, locked: boolean): Promise<void> {
  moveLocked = locked
  return update($, moveLockAtom, () => locked)
}

// Runs a move (a pick, Next, Back or the review's Back) unless one ran within MOVE_LOCK_MS; while the lock holds, the pane
// draws those buttons disabled. Submit and the other actions are not moves.
function moveOnce($: EngineInterface, move: () => void): void {
  if (moveLocked) return
  report($, setMoveLock($, true))
  $.clock.after(MOVE_LOCK_MS, () => report($, setMoveLock($, false)))
  move()
}

const actionsFor = ($: EngineInterface): PaneActions => ({
  clearHistory: () => report($, clearHistory($)),
  dismissEndedForced: id => report($, dismissOrSay($, id, true)),
  dismissDamagedUnforced: id => report($, dismissOrSay($, id, false)),
  pick: (id, choice) => moveOnce($, () => report($, afterPendingOther($, () => pickOption($, id, choice)))),
  focusOther: id => report($, afterPendingOther($, () => focusOther($, id))),
  submitOne: id => report($, afterPendingOther($, () => submitOne($, id))),
  jump: id => report($, afterPendingOther($, () => jumpToQuestion($, id))),
  typeOther: (id, text) => {
    pendingOther.set(id, text)
  },
  keepOther: (id, text) => {
    pendingOther.delete(id)
    report($, keepOther($, id, text))
  },
  back: () => moveOnce($, () => report($, afterPendingOther($, () => moveWizard($, (current, group) => flow.back(current, group))))),
  next: () => moveOnce($, () => report($, afterPendingOther($, () => moveWizard($, (current, group) => flow.next(current, group))))),
  submit: () => report($, afterPendingOther($, () => submitCurrent($), flow.submittedTypedOther)),
  leaveReview: () => moveOnce($, () => report($, leaveReview($))),
  saveWho: text => report($, saveWho($, text)),
  skipWho: () => report($, saveWho($, '')),
})

export const register: Register = on => {
  let poller: ReturnType<EngineInterface['clock']['every']> | undefined

  on('session.start', async ($, e, next) => {
    const current = await currentLang($)
    await update($, langAtom, () => current)
    // A failed registration (a name already taken, say) must not stop the poll below: the band and the pane draw
    // from the board, and the folder is read only while the poller runs.
    await registerCommand($, current)
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
    await setMoveLock($, false)
    const folder = await folderOf($)
    poller?.cancel()
    if (folder !== undefined) {
      // The first poll is awaited, so the first prompt and the first draw already see the folder. Only the interval
      // polls hand answers to the prompt, and they need this session's id.
      await pollInbox($, folder).catch((error: unknown) => logFailure($, error))
      // A hot reload keeps the board, so the first poll writes nothing: the band and the pane are drawn on request.
      $.ui.invalidate('ui.render')
      const ownSession = await $.session.id().catch(() => undefined)
      poller = $.clock.every(POLL_MS, () => {
        if (polling === undefined) report($, pollAfterRunning($, folder, ownSession))
      })
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
    const rest = e.args.trim().slice(verb.length).trim()
    const lang = await read($, langAtom)
    if (verb === 'lang') return { text: await setLang($, value) }
    if (verb === 'quiet') return { text: await quietReply($, lang, value) }
    if (verb === 'who') return { text: await whoReply($, lang, rest) }
    if (verb === 'away') return { text: await awayText($, lang) }
    if (verb !== '') return { text: t(lang, 'command.verbsHelp') }
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
    const hidden = await read($, cleared)
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
        cleared: hidden,
        now,
        leaving: fading,
      }),
      now,
      leaving: fading,
      footer: folder === undefined ? t(lang, 'command.awayUnavailable') : footerText(lang, current, now, hidden),
      away: await read($, isAway),
      ended: await read($, endedAtom),
      damagedPauses: await read($, damagedAtom),
      askWho: (await read($, whoAtom)) === null,
      groups,
      active,
      wizard,
      screen,
      moveLocked: await read($, moveLockAtom),
      arrival: await read($, arrivalAtom),
      review: await read($, reviewAtom),
      undelivered: await read($, undeliveredAtom),
      surface: e.surface,
    }
    return renderPane($.ui.resolve(e), view, actionsFor($), lang, heldFor(e.surface, e.requestId))
  })

  // The ring leaving the Other field: the move is passed on first, then the field's pending text is recorded, so a person
  // who never pressed Keep keeps it; a text a kept label sets aside stays pending for Submit all (recordPendingOther). A move onto Submit all records nothing: its press records the text as the answer
  // (submittedTypedOther), a kept label included. The hook never blocks, rewrites or re-targets the move.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const isLeavingOther = leavesOtherText(focusedKey, e.element)
    focusedKey = e.element
    const result = await next(e)
    if (isLeavingOther) await recordPendingOther($, flow.submittedOther, true).catch((error: unknown) => logFailure($, error))
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
