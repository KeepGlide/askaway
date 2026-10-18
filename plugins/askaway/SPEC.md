# Askaway — question inbox spec (v1)

Why: a question raised while the user is away (any run kind: main session, subagent, goal,
/loop, background Bash, `codex exec`) is lost today; the work continues on a guess the user
never sees. Askaway queues the question with a recommended default, keeps the work going on
that default, pauses only the risky ones, and delivers the user's answer back to the session
that asked.

Two parts, one shared folder:
- `scripts/askaway.py` (Python 3 standard library, in the plugin folder): the CLI agents call, and
  the hook modes of `hooks/command-hooks.json`. It is the sole writer of questions and delivery markers.
- The mod, hooks module `hooks/register.tsx` (loaded by `hooks/hooks.json`): the panel, the band
  button, the toast and the `/askaway` commands. It reads questions; it writes answers, the away
  toggle, its own store keys and the hand-off prompt.

Terms:
- **Group**: the open questions of one project (`project`). The group's label is the project's name.
- **Session**: the questions of a group that were asked by one session (`session`). A question with no
  session sits in its group under the session label "the session" ("a sessão").
- **Round**: the open questions of one group; Submit all writes the round of the group on screen.

## State folder: `~/.claude/state/askaway/` (`ASKAWAY_HOME` env var overrides it; tests use it)

One JSON file per item; never one shared file (no append races, no 4 MiB limit).

- `q/<id>.json` — the question (written once by askaway.py, atomically: temp file in `q/` + os.replace):
  ```json
  {"v":1,"id":"q-lq3x9a1-a3f9c2","ts":1791993000000,
   "project":"<absolute project path>","session":"<CLAUDE_CODE_SESSION_ID or null>",
   "run_kind":"main|subagent|goal|loop|bash|codex","session_title":"<<= 80 chars> | null>",
   "title":"<= 60 chars","question":"<= 400 chars","context":"<<= 600 chars>",
   "options":[{"key":"A","label":"...","tradeoff":"<one line>","fit":88}],
   "recommended":"A","how":"<<= 400 chars>","gains":"<<= 300 chars>",
   "losses":"<<= 300 chars>","why":"<1-2 sentences>","analogy":"<free text>",
   "urgency":"<free text, e.g. 'Blocks in ~8 min' | 'Can wait'>",
   "undo":"<free text, e.g. 'changing later ≈ 10 min'>",
   "risk":"low|medium|high","pause":false,"source":"cli"}
  ```
  `fit` is an int 0-100 (older questions may hold null; the panel then draws no fit for that option).
  `session_title` is filled by `ask`, not by the caller: it is the window title of the asking
  session, read from its transcript `~/.claude/projects/<dir>/<session>.jsonl`. The folder is
  derived from `project`: every char outside `[A-Za-z0-9]` becomes `-`; all folders are globbed
  only when that folder does not hold the session. The last `custom-title` entry (`customTitle`)
  wins, else the last `agent-name` (`agentName`), else the last `ai-title` (`aiTitle`); clipped to
  80 chars. It is null when there is no session, no transcript or the lookup fails; the lookup
  never fails the ask. Questions filed by the AskUserQuestion hook get it the same way. Session
  ids that are not plain tokens (`[A-Za-z0-9_-]`) are never looked up.
  `context`, `why`, `how` (how the option works), `gains`, `losses`, `analogy`, `urgency` and `undo` are
  required explanation fields for the panel: `ask` refuses an entry with any of them blank (see `ask`).
  Questions filed before they were required load unchanged (missing keys read as null).
  `pause` is true only when `risk` is `high`: pause applies to risk high only, and it ends when the
  answer is delivered to the asking session, not when it is written. A `pause` value the caller sends
  for `low` or `medium` is type-checked (a non-boolean is refiled) and then ignored.
  id = `q-` + base36(ms) + `-` + 6 hex chars from os.urandom.
- `a/<id>.json` — the answer: `{"id":"...","key":"B","by":"panel|accept_recommended|accept_all|cli","session":<session or null>,"ts":<ms>}`.
  `session` is the session the answer is bound to: for `by: cli` the caller's `CLAUDE_CODE_SESSION_ID`
  (or the question's session when the caller has none); for a panel answer the question's own session.
  Free text carries key `"other"` and the text in `text`: `{"id":"...","key":"other","text":"Use a fork","by":"panel","session":"<session>","ts":<ms>}`.
  `text` is absent for lettered keys. First writer wins: a writer checks that the file does not
  exist first and never overwrites it. Delivery accepts key `other` only when `text` is non-empty.
  Earlier versions wrote `other` answers too; the panel reads them like any other answer.
- `d/<id>.json` — delivery marker: `{"id":"...","session":"<session that received it>","ts":<ms>}`.
  A marker the mod writes when it hands the answer to its own idle session's prompt carries
  `"via":"prompt"` (`{"id","session","ts","via":"prompt"}`); askaway.py's markers carry no `via`.
  A lapsed answer (no session can receive it) is marked closed instead:
  `{"id":"...","session":null,"expired":true,"reason":"session-ended|ttl","ts":<ms>}`.
  `expired` (bool) and `reason` appear only on lapsed markers; a normal delivery carries neither.
  `session-ended`: the asking session has a `~/.claude/projects/<dir>/<session>.desktop-released.json`
  marker (Claude Desktop released it). `ttl`: the answer has been unread for more than 7 days (measured
  from the answer's `ts`); it expires for every session, the asking one included.
- `away.json` — `{"on":true,"ts":<ms>}` (missing = off).

Status (derived, never stored): `open` (no a/), `answered` (a/ but no d/, and the answer is not yet
past the 7-day TTL), `delivered` (a d/ marker without `expired`), `expired` (an answer unread past the
7-day TTL, with or without a lapsed d/ marker; a d/ marker with `expired: true` always reads `expired`).
`delivered` and `expired` are closed; `open` and `answered` are not.
Readers skip unreadable or invalid JSON files silently (a file may be mid-write).

## Away rule

The user counts as away when ANY of: hook input `permission_mode == "bypassPermissions"`;
`away.json` has `on: true`; env `CLAUDE_CODE_SESSION_ATTENDED == "0"`.

## CLI

`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py" <cmd>`. Output is one JSON line on stdout (`export`
writes its document instead); exit 0 always, unless `--strict` is given (below).

- `ask` — reads the entry JSON (the fields above minus v/id/ts/source) from stdin or `--json '<...>'`.
  `title` defaults to the question clipped to 60 chars. Fills `session` from env
  `CLAUDE_CODE_SESSION_ID`, `project` from the working directory, and `run_kind` defaults to `main`
  (`codex` when env `CODEX_*` vars exist and there is no session id). Validates: at least 2
  options, unique keys, `recommended` among the keys; `context`, `why`, `how`, `gains`, `losses`,
  `analogy`, `urgency` and `undo` are required (non-blank strings); each option requires `tradeoff`
  (non-blank) and `fit` (integer 0-100). Every missing or invalid field is named in one error, e.g.
  `missing fields: analogy, undo; option B: fit`. Truncates long strings. Prints
  `{"id","recommended","action":"continue|pause"}`. An incomplete or invalid entry files nothing and
  prints `{"action":"refile","recommended":<given or null>,"error":"..."}`: the caller completes the
  fields named in `error` and files again. An internal error prints
  `{"action":"continue","recommended":<given or null>,"error":"internal error"}`, or
  `{"action":"pause",...}` when the entry asked for `risk` `high` (nothing was filed in either case).
- `answer <id> <key> [--by cli]` — writes a/ if absent; prints `{"id","key","written":bool}`.
  Session rule: a `cli` answer to a question with a session is refused unless the caller's
  `CLAUDE_CODE_SESSION_ID` equals that session (a shell with no session is refused too); the refusal
  prints `{"error":"answer refused: ..."}`, exit 0, and writes nothing, so the slot stays free. Panel
  answers (`--by panel|accept_recommended|accept_all`) are not bound to a shell session.
- `status <id>` — prints `{"id","status","key"|null}`.
- `--strict` (opt-in, on `ask`, `answer` and `status`) — a refile, an error, or a usage error that
  names `--strict` exits 1 instead of 0. The JSON line is printed as usual. Without the flag the exit
  code stays 0. A repeated `answer` that loses the first-writer race (`written:false`) is not an error.
- `wait <id> [--timeout 300]` — polls a/ every 0.5 s until the answer exists or the timeout (seconds,
  finite, zero or more; `0` checks once) passes. Prints `{"id","status":"answered","key","text"?}` (the
  `text` of an `other` answer, as in `status`), `{"id","status":"timeout"}`, or
  `{"id","status":"unknown id"}`. Exit 0. The pause guard does not exempt `wait` or `export`
  (only `ask|status|list`), so a paused turn cannot run them.
- `list [--open | --answered] [--since <when>]` — prints `{"items":[{"id","title","status","recommended","key"}...]}`,
  newest first. `--answered` keeps the answered items (`answered`, `delivered`, `expired`). With
  `--since`, only the items whose answer `ts` is at or after `<when>`; `--since` needs `--answered`.
  `<when>` is a duration counted back from now (`30m`, `2h`, `7d`) or an ISO 8601 timestamp; a
  timestamp without a zone is read as UTC. Any other value is an error.
- `export [--since <when>] [--format json|jsonl|csv]` — writes every question, newest first, with its
  answer record. Rows are `{"id","status","question":<stored question>,"answer":<stored answer>|null}`:
  `json` (the default) is one array, `jsonl` one row per line, `csv` one row per question with the
  header `id,status,question,answer`, the last two cells as JSON. `--since` keeps the questions
  asked at or after `<when>` (the question's `ts`; unlike `list --since`, which filters by the answer's).
  Writes the document to stdout, not a JSON result line; exit 0.
- `away on|off|status` — writes or reads away.json; prints `{"away":bool}`.
- `prune [--days 30]` — deletes q/a/d files of closed items (`delivered` or `expired`) whose closing
  time is older than N days: the delivery marker's `ts` for `delivered`, the answer's `ts` for
  `expired`; never the question's `ts`. Prints `{"removed":n}`.

## Hook modes

`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py" hook <mode>` reads the hook JSON from stdin.
It fails open: any error exits 0 with no output. The command hooks are declared in
`hooks/command-hooks.json`.

- `ask-guard` — PreToolUse, matcher `AskUserQuestion`. Away → for each `tool_input.questions[i]`
  it builds a skeleton question and stores nothing: `title` = `header`; `question`; options keyed A, B,
  C… from `options[].label` with a trailing "(Recommended)" or "(Recomendado)" removed (case-insensitive);
  `tradeoff` = `options[].description`; `fit` null; `context` = the question's own context, else the
  descriptions as "<key>: <description>" lines; recommended = the option whose label had the marker, else
  the first; `why`, `how`, `gains`, `losses`, `analogy`, `urgency`, `undo` = ""; risk low. It then prints
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":<reason>}}`,
  where the reason says the questions are NOT in the inbox yet, and that the agent must fill every empty
  field of each skeleton and file it with `python3 "<this script>" ask --json '<skeleton>'` (one command
  per question) before continuing on the recommended option unless the reply says pause. The script
  path comes from `Path(__file__)`. The JSON after `--json` is shell-quoted with `shlex.quote`, so a
  quote or `$(...)` inside a question or label is data, never a shell token. The recommended marker
  is "(Recommended)" or "(Recomendado)" or "(Recomendada)", case-insensitive. Not away, or any error
  → no output (the real question shows).
- `pause-guard` — PreToolUse, matcher `Edit|Write|NotebookEdit|Bash|Agent|mcp__.*`. If an entry with
  `pause:true` (risk `high` only) whose status is not closed (`open` or `answered`, that is, not yet
  delivered nor expired) has `session == input.session_id`, it denies with the reason "Paused: Askaway question
  <id> (<title>) needs the user's answer. Do read-only work or end the turn; check with
  `askaway.py status <id>`." Exception: one simple Bash command running `askaway.py ask|status|list`
  (no `;&|`$<>`) passes. `answer` never passes, so only the user lifts a pause; an answer that is
  written but not yet delivered still holds it, and the next deliver run (the `status` call's
  PostToolUse, for one) ends it. Read-only MCP tools pass: `mcp__<server>__<tool>` whose tool name
  has a read word (`get`, `list`, `read`, `search`, `query`, `find`, `describe`, `show`) and no write
  word (`create`, `update`, `delete`, `keep`, `save`, `send`, `run`, and similar); every other tool
  of the matcher is denied, `Agent` included.
- `deliver` — UserPromptSubmit, SessionStart (matcher `startup|resume|clear|compact`) and PostToolUse
  (no matcher). It picks `answered` items with `session == input.session_id`, or with session null
  and `project == input.cwd`, and prints
  `{"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":<text>}}` with the answer
  line (see "Model-facing lines"), then writes the d/ marker for each. Nothing answered → no output.
  It must cost under 20 ms when the folder is empty, because PostToolUse runs after every tool.
  A busy session without the mod gets its answer on its next hook.
- `deliver`, lapsed answers — on every deliver run (any session), each answered item that the running
  session cannot receive is checked: if its asking session has a `desktop-released.json` marker, it
  gets a d/ marker with `expired: true, reason: "session-ended"`; otherwise, if the answer is older
  than 7 days, it gets `expired: true, reason: "ttl"`. Only undelivered ids are checked, with the
  folder-first lookup. The slow path prunes at most once a day. A session that Claude Desktop
  released never runs hooks again, so its answers are closed here (`session-ended`) instead of
  waiting for the 7-day TTL. A lapsed answer closes for every session: an unread answer older than
  7 days is marked `ttl` even when the running session is its asking session.
  The folder-wide scan for released sessions runs at most once per deliver run (`ReleasedScan`),
  however many answers the run checks.

## Commands

- `/askaway` — opens the panel. When the panel is not placed, it answers with a text list of the open questions.
- `/askaway lang pt-BR|en|auto` — sets the language; the default is `auto`, the environment's locale (see "Language").
- `/askaway away` — toggles `away.json` and reports the new state.

There are no other public commands. The `/inbox` commands of earlier versions are not part of v1.

## Language

Detected from the environment: the first of `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE` that is
set (non-empty). A value that starts with `pt` means Portuguese; anything else means English
(`detectLang`, `hooks/i18n.ts`).
`/askaway lang pt-BR|en` stores the choice (`pt-BR` as `pt`) in the mod's `$.store` key `lang`; `auto` clears it, and the
locale decides again. A stored `pt` or `en` wins over the detected language (`resolveLang`, `hooks/i18n.ts`). The panel and the band text are translated (`hooks/i18n.ts`, English and
Brazilian Portuguese, with identical key sets). The model-facing lines are always English and are never translated.

## Band button and toast

- A band row above the prompt (`ui.render` on `AbovePrompt`, `hooks/band.tsx`) is drawn only while open questions exist
  and no survey is up. It reads, left to right: the Askaway logo, "<n> questions waiting · <n> groups"
  (Portuguese: "<n> perguntas aguardando · <n> grupos"; `band.text`, `hooks/i18n.ts`), and an **Answer**
  button (Portuguese: "Responder"). The button has hotkey `1` (a bare digit works from an empty composer)
  and opens the panel.
- When a new open question arrives, the mod shows one toast: `New question: <title>` (Portuguese: `Nova pergunta: <title>`).
  A question already waiting when the session starts does not toast; the first poll only primes the seen ids.

## Panel

Pane id `askaway`, title "Askaway" (`hooks/pane.tsx`, `hooks/register.tsx`). Colors are in `hooks/look.ts`.

Draw order, top to bottom: header, tree of the open questions, question card, status lines. The status lines come
last because they change height as answers are delivered. On the desktop a Button drawn below a block that grows lost
its presses (the first click was dropped); this is the same finding as another mod's (comment above its
status list). `hooks/pane.tsx`, `renderPane`.

- **Header**: the Askaway logo, then "Questions waiting" ("Perguntas aguardando"; `pane.heading`, `hooks/i18n.ts`), with the counter on the right. The logo is the violet
  SVG on the desktop (`hooks/logo.ts`, `#8B5CF6`) and the "?" glyph in the accent color on the terminal
  (`hooks/logo-element.tsx`). The counter reads "<n> pending · <n> groups" ("<n> pendentes · <n> grupos"), or
  "Nothing pending" ("Nenhuma pendente") when no question is open (`counterText`, `hooks/model.ts`).
- **Tree of the open questions** (drawn when at least one question is open). The questions are grouped by GROUP =
  their `project`, in the order of each group's oldest question. Every open group is drawn in turn, one under the other,
  in a Box keyed `group-<project path>`. No group draws a Button: a group's label is a Text.
  - Group label: the project's basename with hyphens and underscores turned into spaces, title-cased
    ("my-sample_project" becomes "My Sample Project"). Session label: the session's title, title-cased the same way;
    "the session" ("a sessão") when there is no title (`projectLabel`, `sessionLabelOf`, `titleCase`, `hooks/model.ts`).
    Minor words stay lower-case after the first word (English: a, an, and, as, at, but, by, for, in, of, on, or,
    the, to, via, with; Portuguese: its own list, `MINOR_WORDS`). A word that already has a capital stays as typed.
  - **Label of each group**: a bold row. It is in the accent color (`ACCENT_COLOR`, `hooks/look.ts`) for the group on
    screen (the wizard's `groupKey` while that group is open, else the first open group), and has no color for the others.
    Its sessions are rows below it: "├ <session>", and
    "└ <session>" for the last one, indented with the Box's `paddingLeft`. Each question of a session is a row
    with a mark and its title: ● the question on screen (bold, in the accent color), ✓ picked, ○ not yet picked.
    The questions of a session that is not the last are indented with `paddingLeft={1}` and prefixed "│  "; those
    of the last session are indented with `paddingLeft={4}` (`renderSession`, `renderTreeQuestion`, `hooks/pane.tsx`).
  - The card shows the questions of one group at a time (the group on screen); the other groups stay in the tree only,
    and the picks of every group are kept.
- **KeepGlide mark**: an SVG of the KeepGlide tile (`hooks/keepglide.ts`, `renderKeepGlide`, `hooks/logo-element.tsx`),
  drawn on the desktop only: 24px before the counter in the header (key `keepglide-counter`, `KEEPGLIDE_HEADER_SIZE`)
  and 28px before the Submit all button (key `keepglide-submit`, `KEEPGLIDE_SUBMIT_SIZE`). The terminal draws no mark.
- **Question card**, one question at a time, bordered, rows separated by a gap. Top to bottom:
  - the title row: the question's title, bold, with its risk and age beside it, muted, "<risk label> · <age label>"
    (`riskLabel`, `ageLabel`); the row wraps the risk under the title when it does not fit. The risk label (low, medium,
    high) is the risk of accepting the recommended option, as the filing agent judged it. A question with no title is
    named by its text, cut to 24 characters with "…";
  - the question text, bold;
  - the explanation box, when at least one of its sections is set: a box on a very light gray ground (`#F9FAFB`, ink
    `#1F2937`, `EXPLAIN_COLORS`, 14.05:1), with `paddingX={1}` and `paddingY={1}`. Its sections, each drawn only when its field is set: 🧭 Context and origin, 🔁 Analogy,
    💡 Why <rec>, 🛠️ How, one section for gains and losses (🎁 What we gain · ⚖️ What we lose; its heading names only
    the halves that are set), then ⏱️ Urgency and ↩️ Undo (pt: ⏱️ Urgência, ↩️ Como desfazer). Each section is one line,
    "heading: text" (pt: "💡 Por que A: <why>"): the heading in bold, then the text, wrapping as one paragraph. Every name
    in the text (a slash command, or anything the agent wrote between backticks) is drawn in the accent color
    (`ACCENT_COLOR`), its backticks not drawn (`piecesOf`, `renderSection`, `hooks/model.ts`, `hooks/pane.tsx`). The box
    sits before the options (`sectionsOf`, `renderExplanation`, `hooks/pane.tsx`, `hooks/model.ts`);
  - the options, one full-width Button each, "N. Label", with the option's tradeoff under it: one line, its first letter
    capitalized, then the fit after a dot, `· fit N` (`· aderência N` in pt-BR; with no tradeoff the line reads `└ fit N`;
    a null fit draws nothing), indented one cell (`paddingLeft={1}`), dim only while the card fades. The options
    are in a column with `gap={2}` and `marginTop={1}`, so two blank lines part them from the explanation box
    (`renderQuestion`, `hooks/pane.tsx`). The recommended option reads "N. Label (Recommended)"
    (Portuguese: "Recomendada") and is bold while not picked. The picked option is the primary button;
  - "N. Other…" is the last option (Portuguese: "Outra…"). Its button opens and shuts a text field under it
    (autofocused). Enter in that field ("Done" / "Pronto") records the typed text as the pick (key `other`); blank
    text records nothing. Once recorded, the text shows under the button and the button is primary. A surface with
    no Input draws no Other option (`renderOther`);
  - the nav row: [← Back] (Portuguese: "← Voltar") on every question, dim on the first; [Next →] (Portuguese:
    "Próxima →") on every question but the last; on the last one, [Submit all (n)] (Portuguese: "Enviar tudo (n)"),
    where n is the number of questions of the group, dim until every question of the group has a pick.
- **Hotkeys**: options take the digits 1 to 9 in order on every surface; "Other…" takes the next digit (none after
  nine). Back `b`, Next `n` and Submit all `s` are drawn on the terminal only (`letterFor`, `hooks/pane.tsx`): the
  desktop clicks them. No hotkey is drawn while the Other field is open, so typed text presses no button.
- **Choosing**: an option, or "Other…" with its text, records the pick and moves on: to the first question without a
  pick after the current one (wrapping to the start), or, once every question of the group has a pick, to the last
  question, where Submit all is. After each pick the group stays selected. Nothing is written until Submit all.
  A card that is fading after a press takes no pick.
- **Next** moves to the next question whether or not it has a pick; **Back** moves to the previous one. Next does
  nothing on the last question.
- **Submit all (n)** writes every answer of the group's round at once. On each press the card dims at once; each
  answer then goes through the first-writer-wins path of `a/`, and the card fades for 250 ms (`FADE_MS`). Then the
  picks of those questions are cleared and the step goes back to the first question. When other groups stay open, the
  card then shows the first question of the first group still open.
- **Picks** survive a re-poll. Picks, and an open Other field, of questions that are no longer open are dropped.
- **Status lines** (bottom of the pane, newest first), green (`#166534` ink on `#DCFCE7`):
  - "⏳ Answer <key> sent to <window>" while the answer has no d/ marker;
  - "✅ Answer <key> delivered to <window> (read by the session)", hidden 30 s after it is first seen
    (`DELIVERED_SHOWN_MS`, `hooks/model.ts`);
  - "⚠️ <window> ended before reading answer <key>" and "⚠️ Answer <key> expired unread". The two ⚠️
    lines stay until their ✕ is pressed; the press records the id in `$.store` key `cleared`
    (non-destructive: no q/, a/ or d/ file changes).
  `<window>` is "<project name> · <session title>" (the project's last path segment, then the session title; the
  part that is missing is left out), the same label that the tree uses for a session.

## Focus and clicks

Decision: every Button of the pane and of the band keeps its press handle across redraws, on the desktop and on the
terminal alike. The plugin does not hold the focus ring any more (there is no `ui.focus` hook); the engine moves the
ring as it does for any plugin, and the pane's hotkeys (the digits on both surfaces; `b`, `n`, `s` on the terminal) are its keyboard path.

Why: the engine hands a Button a new press handle on every redraw, unless the very same element object comes back. On
the desktop a click moves the focus onto the Button, and that move redraws the site just before the press arrives. The
press then names a retired handle and is dropped, so the first click did nothing and the answer was written by the
second click (both as reported; the log line "ui_press not handled" is not in this repo).

How (`hooks/held.ts`, `heldButtons()`):
- `begin()` opens a draw; `end()` lets go of the keys not held since `begin()`.
- `hold(key, look, onPress, make)` returns the element it made last time for that key when `JSON.stringify(look)` is
  unchanged, so the engine sees the same element and keeps its handle. A changed look calls `make` for a new element.
  `look` is everything the Button draws: its label, variant, dim state and hotkey.
- The press of a held element runs the handler that the latest `hold` stored for its key, so a Button that changed
  (a new pick, a new question) still runs its current handler.
- One table per site: `heldFor(surface, requestId)` (`hooks/register.tsx`). The pane's table goes to
  `renderPane` (`hooks/pane.tsx`) and the band's to `renderBand` (`hooks/band.tsx`). Every Button goes
  through `hold`: each option, Other…, Back, Next, Submit all, the band's Answer and each status ✕.
- The Other field is an Input. The engine matches an Input by its key, so the field is not held.

Verification: `tests/askaway.test.ts` tests the table on its own (`heldButtons`), and the engine tests
`held (terminal)` and `held (desktop)` check that a redraw keeps every Button's handle, and that a press renews only the
pressed option's. Live check on the desktop (0.4.0-beta.3, 2026-10-17, held buttons, KeepGlide mark beside Submit all): every
Button answered on the first click, confirmed by the user through an Askaway question answered in that pane.
Live check on the desktop (0.4.0-beta.5, 2026-10-17): gains and losses as two sections, "└ " before each tradeoff and the
KeepGlide mark after the counter and after Submit all, confirmed the same way (answer A).

Two guards keep the drawn state from changing for nothing:
- `tickClock` (`hooks/register.tsx`) counts only the open questions. An answered question draws no age label,
  so a tick for it alone would redraw an equal pane; the clock is written only when the drawn age labels or status
  lines change.
- `pruneWizardState` (`hooks/register.tsx`) skips the write when nothing is open and only the wizard's
  `groupKey` would change (the field is `groupKey`, `hooks/wizard.ts`). With nothing open the pane draws no
  card, so that write would only redraw the pane. A group that opens later still starts at step 0.

Known limit: the accent `#1E40AF` (`hooks/look.ts`) is low contrast on a dark theme (2.03:1 on a dark background,
per the comment in `hooks/look.ts`). The engine gives the mod no theme signal, so the color cannot switch with the theme.

## Polling

The mod lists `q/`, `a/` and `d/` with `$.fs.list` on a `$.clock` timer every 5 s while the session runs
(`hooks/register.tsx`: `POLL_MS`, `readBoard`).
It merges the folder into the board and never takes back an answer that a press wrote: a local
answer stays while its question is listed and the folder read does not show it yet.

## Idle hand-off

In each session's interval poll, when the session is idle (no main-loop turn running: `turn.start`
begins a turn and `turn.complete` without `agentId` ends it), the answers whose question has
`session` equal to this session's id, at least 5 s old, with no d/ marker, are handed to the prompt.
All due answers of one asking session go in ONE `$.prompt.submit({ text })`, one line per answer,
joined by "\n". The d/ markers (`via:"prompt"`) are written first, only where absent.

- Never twice: the marker is the guard, and an in-flight guard covers overlapping polls.
- A busy session gets nothing until its turn completes.
- If the submit fails after the markers are written, the answers stay marked delivered, the failure is logged, and
  a toast says each answer was not delivered (`toast.undelivered`: "Answer <key> for <id> was not delivered; answer
  again in the session."). No retry.

## Model-facing lines (English, never translated; `askaway.py` `_delivery_line` and `model.ts` `deliveryLine` stay identical)

`_delivery_line` is one line: control characters and line breaks in the title, the labels and an
Other text become spaces, so a title cannot start a second line of the delivery.

- Answer: `The user answered Askaway question <id> (<title>): <key> · <label>.`, plus
  ` (you were using <rec key> · <rec label>)` when the answer differs from the recommendation.
- Free text (key `other`): `The user answered Askaway question <id> (<title>): their own answer (Other): "<text>".`
- Ask-guard and pause-guard reasons: see "Hook modes".

The agent instruction lives in `skills/file-question/SKILL.md`: file a question with every required
field, a recommended option, and on `refile` complete and file again; continue on `recommended` unless
`action` is `pause`.

## Packaging

- The catalog is not in this repository. It lives in `KeepGlide/claude-plugins` (marketplace `keepglide`), whose
  entry `askaway` is a `git-subdir` source pointing at `plugins/askaway` of this repository. Installed with
  `claude plugin marketplace add KeepGlide/claude-plugins` and `claude plugin install askaway@keepglide`.
- `plugins/askaway/.claude-plugin/plugin.json`: the manifest; `"hooks": "./hooks/command-hooks.json"`
  declares the command hooks (`deliver`, `ask-guard`, `pause-guard`), which use
  `python3` and `${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py`.
- `plugins/askaway/hooks/hooks.json`: the mod, `{"modules":["./register.tsx"]}`.
- `plugins/askaway/skills/file-question/SKILL.md`: the skill agents read before they file a question.
