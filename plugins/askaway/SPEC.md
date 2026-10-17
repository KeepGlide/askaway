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
- **Window**: one asking session (`session`). A question with no session belongs to the window
  `project:<project>`.
- **Round**: the open questions of one window.

## State folder: `~/.claude/state/askaway/` (`ASKAWAY_HOME` env var overrides it; tests use it)

The folder keeps the name `inbox` from earlier versions, so existing data keeps working.

One JSON file per item; never one shared file (no append races, no 4 MiB limit).

- `q/<id>.json` — the question (written once by askaway.py, atomically: temp file in `q/` + os.replace):
  ```json
  {"v":1,"id":"q-lq3x9a1-a3f9c2","ts":1791993000000,
   "project":"<absolute project path>","session":"<CLAUDE_CODE_SESSION_ID or null>",
   "run_kind":"main|subagent|goal|loop|bash|codex","session_title":"<<= 80 chars> | null>",
   "title":"<= 60 chars","question":"<= 400 chars","context":"<optional, <= 600 chars>",
   "options":[{"key":"A","label":"...","tradeoff":"<one line>","fit":88}],
   "recommended":"A","how":"<optional, <= 400 chars>","gains":"<optional, <= 300 chars>",
   "losses":"<optional, <= 300 chars>","why":"<1-2 sentences>","analogy":"<optional>",
   "urgency":"<optional free text, e.g. 'Blocks in ~8 min' | 'Can wait'>",
   "undo":"<optional free text, e.g. 'changing later ≈ 10 min'>",
   "risk":"low|medium|high","pause":false,"source":"cli|askuserquestion"}
  ```
  `fit` is an int 0-100 or null (the panel hides the chart when every fit is null).
  `session_title` is filled by `ask`, not by the caller: it is the window title of the asking
  session, read from its transcript `~/.claude/projects/<dir>/<session>.jsonl`. The folder is
  derived from `project`: every char outside `[A-Za-z0-9]` becomes `-`; all folders are globbed
  only when that folder does not hold the session. The last `custom-title` entry (`customTitle`)
  wins, else the last `agent-name` (`agentName`), else the last `ai-title` (`aiTitle`); clipped to
  80 chars. It is null when there is no session, no transcript or the lookup fails; the lookup
  never fails the ask. Questions filed by the AskUserQuestion hook get it the same way. Session
  ids that are not plain tokens (`[A-Za-z0-9_-]`) are never looked up.
  `how` (how the option works), `gains` and `losses` are optional explanation fields for the
  panel, each validated like `why`; questions filed before they existed load unchanged (missing
  keys read as null).
  `pause` is true when the caller says so or `risk` is `high`.
  id = `q-` + base36(ms) + `-` + 6 hex chars from os.urandom.
- `a/<id>.json` — the answer: `{"id":"...","key":"B","by":"panel|accept_recommended|accept_all|cli","ts":<ms>}`.
  Free text carries key `"other"` and the text in `text`: `{"id":"...","key":"other","text":"Use a fork","by":"panel","ts":<ms>}`.
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
  marker (Claude Desktop released it). `ttl`: the answer is older than 7 days and no session could
  receive it.
- `away.json` — `{"on":true,"ts":<ms>}` (missing = off).

Status (derived, never stored): `open` (no a/), `answered` (a/ but no d/), `delivered` (d/).
Readers skip unreadable or invalid JSON files silently (a file may be mid-write).

## Away rule

The user counts as away when ANY of: hook input `permission_mode == "bypassPermissions"`;
`away.json` has `on: true`; env `CLAUDE_CODE_SESSION_ATTENDED == "0"`.

## CLI

`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py" <cmd>`. Output is one JSON line on stdout; exit 0 always.

- `ask` — reads the entry JSON (the fields above minus v/id/ts/source) from stdin or `--json '<...>'`.
  `title` defaults to the question clipped to 60 chars. Fills `session` from env
  `CLAUDE_CODE_SESSION_ID`, `project` from the working directory, and `run_kind` defaults to `main`
  (`codex` when env `CODEX_*` vars exist and there is no session id). Validates: at least 2
  options, unique keys, `recommended` among the keys; truncates long strings. Prints
  `{"id","recommended","action":"continue|pause"}`. On any error prints
  `{"action":"continue","recommended":<given or null>,"error":"..."}`.
- `answer <id> <key> [--by cli]` — writes a/ if absent; prints `{"id","key","written":bool}`.
- `status <id>` — prints `{"id","status","key"|null}`.
- `list [--open]` — prints `{"items":[{"id","title","status","recommended","key"}...]}`, newest first.
- `away on|off|status` — writes or reads away.json; prints `{"away":bool}`.
- `prune [--days 30]` — deletes q/a/d files of delivered items older than N days; prints `{"removed":n}`.

## Hook modes

`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py" hook <mode>` reads the hook JSON from stdin.
It fails open: any error exits 0 with no output. The command hooks are declared in
`hooks/command-hooks.json`.

- `ask-guard` — PreToolUse, matcher `AskUserQuestion`. Away → for each `tool_input.questions[i]`
  it files an entry (`source:"askuserquestion"`; options keyed A, B, C… from `options[].label`;
  `tradeoff` = `options[].description`; `context` = those descriptions as "<key>: <description>"
  lines when the question has none; fit null; recommended = the option whose label contains
  "(Recommended)", else the first; `title` = `header`; risk low). It then prints
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":<reason>}}`,
  where the reason is: "The user is away, so this question went to the Askaway inbox as <ids>.
  Continue with the recommended option (<header>: <label>; …). Next time file questions with
  `python3 "<this script>" ask` so they carry why/how/gains/losses/fit/analogy; set `"pause": true`
  for risky ones (real files, credentials, irreversible)." The script path comes from `Path(__file__)`.
  Not away → no output (the real question shows).
- `pause-guard` — PreToolUse, matcher `Edit|Write|NotebookEdit|Bash`. If an `open` entry with
  `pause:true` has `session == input.session_id`, it denies with the reason "Paused: Askaway question
  <id> (<title>) needs the user's answer. Do read-only work or end the turn; check with
  `askaway.py status <id>`." Exception: one simple Bash command running `askaway.py ask|status|list`
  (no `;&|`$<>`) passes. `answer` never passes, so only the user lifts a pause.
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
  waiting for the 7-day TTL.

## Commands

- `/askaway` — opens the panel. When the panel is not placed, it answers with a text list of the open questions.
- `/askaway lang pt|en|auto` — sets the language (see "Language").
- `/askaway away` — toggles `away.json` and reports the new state.

There are no other public commands. The `/inbox` commands of earlier versions are not part of v1.

## Language

Detected from the environment: the first of `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE` that is
set (non-empty). A value that starts with `pt` means Portuguese; anything else means English.
`/askaway lang pt|en` stores the choice in the mod's `$.store` key `lang`; `auto` clears it, and the
locale decides again. The panel and the band text are translated (`hooks/i18n.ts`, English and
Brazilian Portuguese, with identical key sets). The model-facing lines are always English and are never translated.

## Band button and toast

- A band row above the prompt (`ui.render` on `AbovePrompt`) shows only while open questions exist:
  "📥 <n> question(s) waiting · <w> window(s)" with an **Answer** button. The button has hotkey `1`
  (a bare digit works from an empty composer) and opens the panel.
- When a new open question arrives, the mod shows one toast: `Askaway: <title>`. A question already
  waiting when the session starts does not toast; the first poll only primes the seen ids.

## Panel

Pane id `askaway`, title "Askaway". Header "📥 Askaway" with the counter. Status lines sit at the top.

- **Window selector**: shown only when there are 2 or more windows; one button per window,
  "<label> (n)", the active one primary.
- **Question screen**, one question at a time:
  - a tabs row: one tab per question of the window, "1 Title", "2 Title", … (a question with no
    title is named by its text, cut short); the current tab is bold. For a window of 2 or more
    questions a "Submit" tab follows, dim until every question has a pick;
  - origin line (magenta, bold); a dim risk and age line;
  - the question, in bold;
  - the dim JEV line ("🔷 A 82% · B 55%") when any option has a fit;
  - the numbered options, one per line: "1. Label", with the option's one-line tradeoff dim under
    it. The recommended option reads "N. Label (Recommended)" and is bold while not picked. The
    picked option is the primary button;
  - "N. Other…" is the last option; it opens a text field under it (autofocused; the text is
    sent on Enter);
  - a "More" toggle that shows the explanation sections;
  - the nav row [← Back] [Next →] for a window of 2 or more questions. Next needs a pick on the
    current question. On the last question Next becomes [Review], which opens the review screen
    with the button "Submit all (n)".
- **Choosing**: an option records the pick and moves to the next question. A window with one
  question submits at once.
- **Explanations** (per question, behind "More"): 🧭 context, 🔁 analogy, 💡 why <rec>, 🛠️ how,
  🎁 gains · ⚖️ losses. Each section appears only when its field is set.
- **Review screen**: "Review your answers"; one row per question (number, question, and the chosen
  label or "Other: <text>"); a click on a row jumps to that question; buttons [← Back] [Submit all (n)].
- **Submit all** writes every answer of the window's round at once. Each answer goes through the
  first-writer-wins path of `a/` (the card fades for 250 ms first). Then the picks of those questions
  are cleared and the step resets.
- **Picks** survive a re-poll. Picks for questions that are no longer open are dropped.
- **Status lines** (newest first), green (`#166534` ink on `#DCFCE7`):
  - "⏳ Answer <key> sent to <window>" while the answer has no d/ marker;
  - "✅ Answer <key> delivered to <window> (read by the session)", hidden 30 s after it is first seen;
  - "⚠️ <window> ended before reading answer <key>" and "⚠️ Answer <key> expired unread". The two ⚠️
    lines stay until their ✕ is pressed; the press records the id in `$.store` key `cleared`
    (non-destructive: no q/, a/ or d/ file changes).
  `<window>` is "<project> · <session_title>".

## Polling

The mod lists `q/` and `a/` with `$.fs.list` on a `$.clock` timer every 5 s while the session runs.
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
- If the submit fails after the markers are written, the answers stay marked delivered and the
  failure is logged (no retry).

## Model-facing lines (English, never translated; `askaway.py` `_delivery_line` and `model.ts` `deliveryLine` stay identical)

- Answer: `The user answered Askaway question <id> (<title>): <key> · <label>.`, plus
  ` (you were using <rec key> · <rec label>)` when the answer differs from the recommendation.
- Free text (key `other`): `The user answered Askaway question <id> (<title>): their own answer (Other): "<text>".`
- Ask-guard and pause-guard reasons: see "Hook modes".

The agent instruction lives in `skills/askaway/SKILL.md`: file a question with options, a
recommended option, and the explanation fields when they help; continue on `recommended` unless
`action` is `pause`.

## Packaging

- `.claude-plugin/marketplace.json` (repository root): marketplace `askaway` with one plugin,
  `askaway`, whose source is `./plugins/askaway`. Installed with
  `claude plugin marketplace add KeepGlide/askaway` and `claude plugin install askaway@askaway`.
- `plugins/askaway/.claude-plugin/plugin.json`: the manifest; `"hooks": "./hooks/command-hooks.json"`
  declares the command hooks (`deliver`, `ask-guard`, `pause-guard`), which use
  `python3` and `${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py`.
- `plugins/askaway/hooks/hooks.json`: the mod, `{"modules":["./register.tsx"]}`.
- `plugins/askaway/skills/askaway/SKILL.md`: the skill agents read before they file a question.
