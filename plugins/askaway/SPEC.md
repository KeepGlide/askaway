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
- **Group**: the open questions of one session family (`family`: the Claude Desktop root session that started or forked the
  asking session, and its family's other sessions). A question with no `family` (filed before the field existed) groups by
  its project (`project`). Without a Desktop Group (below), the group's label is the root's title (`family_title`), or the project's name when there is none.
  On the Desktop, a question whose session (`desktop_session`, else its family root `family`) is filed under one of the
  sidebar's Groups groups by that Group instead, labelled with the Group's name as the user typed it (beta.35): the pane
  reads the Desktop's own config, `~/.config/Claude/claude_desktop_config.json` (override `ASKAWAY_DESKTOP_CONFIG`), only
  when its mtime changes (`readDesktopGroups`, `mtimeOf`, `desktopConfigPathOf`, `hooks/register.tsx`), and takes
  `preferences.epitaxyPrefs["dframe-group-scopes"][<scope>].groups` (id and name) and `.assignments`
  (`"code:local_<uuid>"` to a group id) from every scope (`parseDesktopGroups`, `withDesktopGroup`, `groupKeyOf`,
  `groupLabelOf`, `hooks/model.ts`). The format is the Desktop's private one and undocumented: a missing file or an
  unknown shape means no Groups, drawn as before, with no toast and no log; a failed folder listing, a read or parse
  error, or a file over 4 MiB keeps the last Groups read, as one failed listing never empties the board (`readCached`),
  and is retried at the next poll. A group with no name, or a name that is not text, is skipped; only `code:` keys are
  read. Moving a session to another Group moves its questions on the next poll. Only the Linux path and the override
  are read: macOS, Windows and `XDG_CONFIG_HOME` get no Groups.
- **Session**: the questions of a group that were asked by one session (`session`). The root session of a family (its
  `desktop_session` is the group's `family`, or, for a record filed before `desktop_session` existed, its `session_title` is
  its `family_title`; `isRootSession`, `hooks/model.ts`) is the group itself, except under a Desktop Group, where the root
  session gets its own session row so its title is still drawn (the Group's name labels the group): its questions sit right under the group's label, with no session
  row, so the family's title is never drawn twice. The other sessions of the family are derived sessions, drawn as rows under
  the root's questions. A question with no session sits in its group under the session label "the session" ("a sessão").
- **Round**: the open questions of one group; Submit all writes the round of the group on screen.

## State folder: `~/.claude/state/askaway/` (`ASKAWAY_HOME` env var overrides it; tests use it)

One JSON file per item; never one shared file (no append races, no 4 MiB limit).

The state folder and its `q/`, `a/` and `d/` folders are created with mode 700 (`_make_folder`, `STATE_FOLDER_MODE`); a folder that already exists keeps its mode.

- `q/<id>.json` — the question (written once by askaway.py, atomically: temp file in `q/` + os.replace, or rewritten once when a repeat is held as high risk (`_file_or_hold_twin`)):
  ```json
  {"v":1,"id":"q-lq3x9a1-a3f9c2","ts":1791993000000,
   "project":"<absolute project path>","session":"<CLAUDE_CODE_SESSION_ID or null>",
   "run_kind":"main|subagent|goal|loop|bash|codex","session_title":"<<= 80 chars> | null>",
   "desktop_session":"<Claude Desktop sessionId of the asking session, local_<uuid> | null>",
   "family":"<Claude Desktop root sessionId, local_<uuid> | null>","family_title":"<<= 80 chars> | null>",
   "title":"<= 60 chars","question":"<= 400 chars",
   "what":"<<= 600 chars, 2+ sentences>","problem":"<<= 400 chars>","context":"<<= 600 chars>",
   "options":[{"key":"A","label":"...","tradeoff":"<one line>","fit":88,
               "does":"<<= 300 chars>","pros":"<<= 300 chars>","cons":"<<= 300 chars>"}],
   "recommended":"A","how":"<<= 400 chars>","gains":"<<= 300 chars>",
   "losses":"<<= 300 chars>","why":"<1-2 sentences>","analogy":"<free text>",
   "urgency":"<free text, e.g. 'Blocks in ~8 min' | 'Can wait'>",
   "undo":"<free text, e.g. 'changing later ≈ 10 min'>",
   "risk":"low|medium|high","pause":false,"source":"cli"}
  ```
  `fit` is an int 0-100, or null for no estimate (older questions may hold null too; the panel then draws no fit for that option).
  `urgency_level` is optional: `low`, `medium` or `high` (any case, stored lower-case), the grade the pane colours Urgency by; without it the pane grades the urgency text by keywords. Any other value is refiled, naming `urgency_level`. A blank `urgency_level` counts as absent, like null. Top-level keys the CLI does not read are stored with the question as sent, except `asker`, which only the `stamp-asker` hook writes (`ASKER_KEY`, `_unknown_keys`, `scripts/askaway.py`); the fields the CLI writes win over a key of the same name. Over 4096 bytes as JSON the entry is refiled as `the unknown keys are over 4096 bytes as JSON: keep them short or drop them`.
- `translations` (optional; null counts as absent): the question's text in the panel's other language, so `/askaway lang` switches the whole card. An object keyed by `en` and `pt-BR` only (another key is refiled as `translations.<key>: not a language; use en or pt-BR`); each language holds a non-empty subset of `title`, `question`, `context`, `what`, `problem`, `analogy`, `why`, `how`, `gains`, `losses`, `urgency` and `undo`, plus an optional `options` object keyed by the main option keys, each holding a subset of `label`, `does`, `pros`, `cons` and `tradeoff`. Each string goes through the same check, cap and cleaning as its main field (`_read_text`; `what` keeps its 2-sentence rule), and a refusal names its path, such as `translations.pt-BR.options.Z: not a key of the main options` or `translations.pt-BR.price: not a translatable field` (`_translations`, `scripts/askaway.py`). A translation that has `question` and no `title` gets `title` set to its question cut to 60, the fallback the main title uses; a translation with neither keeps no title, and the pane shows the main title. It is a known field: it is not counted in the 4096-byte unknown-keys cap, and it is stored only when non-empty. Delivery lines never read it (pinned by a case with `translations` in the shared `tests/delivery-lines.ts`).
  `session_title` is filled by `ask`, not by the caller: it is the window title of the asking
  session, read from its transcript `~/.claude/projects/<dir>/<session>.jsonl`. The folder is
  derived from `project`: every char outside `[A-Za-z0-9]` becomes `-`; all folders are globbed
  only when that folder does not hold the session. The last `custom-title` entry (`customTitle`)
  wins, else the last `agent-name` (`agentName`), else the last `ai-title` (`aiTitle`); clipped to
  80 chars. It is null when there is no session, no transcript or the lookup fails; the lookup
  never fails the ask. Questions filed by the AskUserQuestion hook get it the same way. Session
  ids that are not plain tokens (`[A-Za-z0-9_-]`) are never looked up.
  The Desktop title comes first. Claude Desktop keeps one JSON record per session under
  `~/.config/Claude/claude-code-sessions/<org>/<user>/local_<uuid>.json`; the record whose
  `cliSessionId` equals the session id gives its `title`, when non-empty, and that title takes
  precedence over the transcript rows above, which are the fallback. The folder can be moved with
  the `ASKAWAY_DESKTOP_SESSIONS` variable (the tests use it), and the transcripts folder with `ASKAWAY_PROJECTS` (`projects_root`; the tests use it). Only regular files are read: symlinks,
  FIFOs and devices are skipped, a file over 2 MB is skipped, and at most 2000 files are examined
  per lookup. Escape sequences and control characters are removed from a Desktop title, which is
  then clipped to 80 chars. `ask` reads the Desktop record once and uses it for both fields.
  `family` and `family_title` group the question. `family` is the `sessionId` (`local_<uuid>`) of
  the root of the asking session's Desktop family, and `family_title` is that root's title, clipped
  to 80 chars. The walk starts at the session's record and follows `forkedFromSessionId` first,
  then `spawnedFrom.sessionId`, loading each ancestor by its file name (`<sessionId>.json`) until a
  record has neither link. At most 8 links are followed. A cycle, a longer chain, or a root with no
  title (its own `title`, else the `spawnedFrom.title` its child records) makes the session its own family, with its own `sessionId` and title; both fields are null only when that session has no title.
  A root whose file is missing is taken as the last `sessionId` reached, titled from its child's
  `spawnedFrom`; a fork whose parent file is missing and has no such title is its own family too.
  The `local_` prefix is required: a Desktop session id or family root without it is stored as null (`desktop_session`, `family`).
  `what` (the first paragraph of the card: what the thing is, what the spec says, what the code does today, the discrepancy),
  `problem` (the second paragraph of the card: the concrete consequence if nothing is decided, with an example), `context`,
  `why`, `how` (how the option works), `gains`, `losses`, `analogy`, `urgency` and `undo` are required
  explanation fields for the panel, and each option's `does` (what happens if chosen), `pros` and `cons`
  are required too: `ask` refuses an entry with any of them blank (see `ask`). Questions filed before
  these fields existed load unchanged: `what`, `problem` and the option keys `does`, `pros`, `cons` are
  absent there, and readers must treat a missing key as null (`list`, `status` and `answer` never read them).
  `pause` is true only when `risk` is `high`: pause applies to risk high only, and it ends when the
  answer is delivered to the asking session, not when it is written. A `pause` value the caller sends
  for `low` or `medium` is type-checked (a non-boolean is refiled) and then ignored.
  id = `q-` + base36(ms) + `-` + 6 hex chars from os.urandom.
- `a/<id>.json` — the answer: `{"id":"...","key":"B","by":"panel|accept_recommended|accept_all|cli|agent","who":"<name>","ts":<ms>,"session":<session or null>}`.
  Full shape: `id`, `key`, `by`, `who`, `ts`, `text` (key `other` only), `session`.
  `by` names the channel that wrote the answer, not the person; `who` names the person. `answer` stamps `who`:
  env `ASKAWAY_WHO` when it holds a name, else the OS user name (`getpass.getuser()`), else `unknown`. The name is
  trimmed, its format characters (Unicode Cf, such as zero-width marks and bidi overrides) are deleted, its control characters become spaces, and it is capped at 40 characters (the last one `…`) on write and on read, so a hand-written record's `who` is clipped the same way; a blank
  `ASKAWAY_WHO` falls back to the OS user name. First writer wins, so the first answer's `who` stays.
  The panel passes the name the person gave it as `ASKAWAY_WHO`, and only when one is stored; with none stored the CLI
  stamps the OS user name, as above. A record without `who` (written before
  it existed) reads fine: `status` and `list` then show no `who` for it.
  `session` is the session the answer is bound to: for `by: cli` the caller's `CLAUDE_CODE_SESSION_ID`
  (or the question's session when the caller has none); for a panel answer the question's own session.
  Free text carries key `"other"` and the text in `text`: `{"id":"...","key":"other","text":"Use a fork","by":"panel","session":"<session>","ts":<ms>}`.
  `text` is absent for lettered keys. First writer wins: the CLI publishes with `os.link` of a temp file, which fails
  when the target exists, so it never overwrites an answer. The pane publishes its delivery markers the same way (`ln` of a temp file, no clobber). Delivery accepts key `other` only when `text` is non-empty.
  The panel answers through the CLI too (option a), so the same rule holds across processes: the panel never writes
  `a/<id>.json` itself. It runs `python3 <plugin root>/scripts/askaway.py answer <id> <key> --by panel --strict`, with
  `--text <string>` for key `other`, and `ASKAWAY_HOME` set to the state folder it reads. The plugin root is
  `$.plugin.root`. The reply is one JSON line: `written: true` when the panel's answer landed, `written: false` when an
  answer already held the slot. Either way the panel reads the record on disk from `a/<id>.json` and shows it, so the
  board holds the CLI's own stamp (`ts`, `who`, `session`). The panel sends the name the person gave it (the plugin store key `who`, set by the one-time question in the pane or by
  `/askaway who <name>`) as `ASKAWAY_WHO`; with none stored the CLI stamps it (ASKAWAY_WHO, else the OS user name). The
  name is declared, not verified. A run that cannot start (no `python3`), exits
  non-zero or prints no `written` is an error: the card fades as usual and the error is logged; nothing is recorded only when the link did not happen.
  Earlier versions wrote `other` answers too; the panel reads them like any other answer.
- `d/<id>.json` — delivery marker: `{"id":"...","session":"<session that received it>","ts":<ms>}`.
  A marker the mod writes when it hands the answer to its own idle session's prompt carries
  `"via":"prompt"` (`{"id","session","ts","via":"prompt"}`); askaway.py's markers carry no `via`. The deliver fast path (`_marked`) counts a regular file with bytes in it and parses nothing. The slow path (`read_json`, `item_status`) reads only a file that reads as a JSON object: an empty or torn file is no marker and is written again. The CLI and the pane both publish a marker with no clobber: a readable one is kept, a torn one is replaced.
  A lapsed answer (no session can receive it) is marked closed instead:
  `{"id":"...","session":null,"expired":true,"reason":"session-ended|ttl","ts":<ms>}`.
  `expired` (bool) and `reason` appear only on lapsed markers; a normal delivery carries neither.
  `session-ended`: the asking session has a `~/.claude/projects/<dir>/<session>.desktop-released.json`
  marker (Claude Desktop released it). `ttl`: the answer has been unread for more than 7 days (measured
  from the answer's `ts`, against the newest clock time seen: `clock_mark`, `_clock_reading_ms`, so a backward clock step never extends it); it expires for every session, the asking one included.
- `away.json` — `{"on":true,"ts":<ms>}` (missing = off; a file that exists but cannot be read keeps the last known state).
- `draft.json` — `{"ts":<ms>,"picks":{"<question id>":{"key":"…","text"?:"…"}},"labels"?:{"<question id>":"<kept Other text>"}}` (missing = no picks; `labels` present only while a kept Other text exists): the wizard's picks and kept Other labels, shared by every session of the folder. The pane writes it on each change of the picks, and each session's poll reads it (see "Shared picks" below). Each write goes through a temp file and a rename (`writeAtomic`), under `draft.lock`. The CLI never reads it.
- `cleared.json` — `{"ts":<ms>,"ids":["<question id>", …]}` (missing = nothing cleared): the History lines a Clear all hid, shared by every session of the folder. A Clear all writes it through a temp file and a rename; each session's poll adds the listed ids it lacks, and drops a listed id that has no reply file on disk and no reply on the board from its own atom only; a poll never rewrites the file, and the next Clear all drops such ids from it (see "Clear all" below; `applyCleared`, `clearHistory`, `hooks/register.tsx`). Malformed = nothing cleared. The CLI never reads it.
- `foreign_check` — an empty stamp file; its mtime is the last re-check of unread answers that other sessions
  receive. The deliver hook re-checks them at most once every 60 s, so its usual cost stays near the empty folder's.
- `last_prune` — an empty stamp; its mtime is the last daily prune. A stamp whose mtime lies in the future (the clock stepped back) counts as due, for the 60 s re-check and the daily prune alike (`_stamp_due`, `scripts/askaway.py`). It moves even when some items are skipped (`_maybe_prune`).
- `clock_mark` — an empty stamp; its mtime is the newest wall-clock reading of the TTL and moves forward only (`_clock_reading_ms`, `scripts/askaway.py`). A forward clock step shorter than 7 days is remembered by `clock_mark`; if the clock then returns, unread replies lapse early by up to that step. A forward step of 7 days or more is returned for that read but kept only once a daily prune has run after the mark (`_pruned_since`, the same acceptance `_clock_jumped` takes): until then the mark stays where it was, so a jump no prune cycle confirms does not move it, and after a gap of 7 days or more the mark is re-seeded by the first read that follows a prune under the new clock. `clock_mark` is rewritten only when it trails the clock by more than 60 s, so it can trail the newest reading by up to a minute. Residual, documented: an excursion longer than a prune cycle that then returns moves the mark to the excursion, so replies written after the return lapse early until the clock passes it again; after a backward step of more than 7 days, replies written with the recoiled clock lapse at once until the clock catches up.
- `.ask.lock` — an empty lock file that `ask` holds with `flock` from its duplicate check to its write; it is never read and is not an item (`_ask_lock`, `scripts/askaway.py`). The CLI needs a POSIX system: it imports `fcntl` for this lock. The hooks' `writeAtomic` moves its temp file with `mv -T`, which is GNU coreutils (Linux).
- `draft.lock` — a folder the pane makes with `mkdir` around each write of `draft.json` and removes with `rmdir` after it; a lock one minute old or older is removed, and the write that found it stale is retried later by the poll; that stale-lock branch also removes the `.draft.json.*.tmp` files one minute old or older (`find -mmin +0 -delete`, argument `DRAFT_LOCK_STALE_FIND_ARG`), never a fresh one (`takeDraftLock`, `saveDraft`, `hooks/register.tsx`).


Status (derived, never stored): `open` (no a/), `answered` (a/ but no d/, and the answer is not yet
past the 7-day TTL), `delivered` (a readable d/ marker without `expired`), `expired` (an answer unread past the
7-day TTL, with or without a lapsed d/ marker; a d/ marker with `expired: true` always reads `expired`).
`delivered` and `expired` are closed; `open` and `answered` are not.
Readers skip unreadable or invalid JSON files silently (a file may be mid-write). They also skip FIFOs, symlinks and folders: only regular files are read, opened with `O_NOFOLLOW|O_NONBLOCK` and checked with `S_ISREG` (`_regular_bytes`, `_is_regular`).

## Panel credential

`answer --by panel`, `--by accept_all` and `--by accept_recommended` are accepted only with a valid, unused one-shot token.
The panel mints it before each answer: 32 random hex characters, recorded as `panel-tokens/<token>` (a mode 700 folder
under the state folder, a mode 600 file holding `{"ts": <ms>}`, created with `install -m 600 /dev/null` before it is written, then `chmod 600`; a failed install or chmod mints no token), and passes the name to the CLI in `ASKAWAY_PANEL_TOKEN`.
The CLI accepts it when the file is a regular file of the same user, mode 600, no older than 120 s, and renames it to
`<token>.used` (atomic, so one token answers once). Otherwise it prints `{"error": "answer refused: --by <by> needs a
valid panel token; ..."}` and writes nothing. `prune` clears token files older than a day. `--by cli` needs no token.

The barrier that keeps the agent from answering its own question is the Bash guard, a deterrent (see "Bash and file guard" under Commands), not a token. The token layer covers the panel path only, and it is **not isolation**:
any process of the same user that can write the state folder can mint a token.

## Security

Known limit of a single-user state folder: the CLI trusts `CLAUDE_CODE_SESSION_ID` from the environment to decide the own session (`caller_session`, `answer_refusal`, `scripts/askaway.py`), and the Desktop family is looked up from that same id (`desktop_session`). Any process that sets the variable can act as that session's agent on the state folder.

## Away rule

The user counts as away when ANY of: hook input `permission_mode == "bypassPermissions"`;
`away.json` has `on: true`; env `CLAUDE_CODE_SESSION_ATTENDED == "0"`.

## CLI

`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py" <cmd>`. Output is one JSON line on stdout (`export`
writes its document instead). Exit codes: 0 for a reply; 1 for a usage error (unknown command, unknown id or option key, bad option value), always, with a one-line `{"error": ...}` and nothing on stderr; `--strict` (below) adds exit 1 for a refile or an error, and exit 2 for a `wait` timeout. `askaway.py <cmd> --help` or `-h` prints one JSON line `{"usage": "...", "options": [...]}` for every command, `hook` included, and exits 0. `hook deliver -h` prints nothing while there is nothing to deliver, because `_exit_if_idle` runs before the parser; `hook -h` prints the usage line. A `-h` or `--help` that follows an option which takes a value is that option's value, not a help request (`_help_words_as_values`). `askaway.py -h` or `--help` prints one JSON line `{"commands": [...]}` and exits 0 (per-command help is listed above). An OS error in a command other than `ask` prints `{"error":"<strerror>: <path>"}` and exits 1, where the path is relative to the state folder, only the file name for a path outside it, and `.` for the state folder itself (`File exists: .`); `ask` keeps `internal error`. Below Python 3.12 every call, hook included, prints one `{"error": "askaway needs Python 3.12 or newer"}` line on stderr and exits 0.

- `ask` — reads the entry JSON (the fields above minus v/id/ts/source) from stdin or `--json '<...>'`. An entry that is not valid JSON is refiled with an `error` that names the quoting problem (check the quotes and escapes), and an empty entry is refiled with `no entry: pass --json or pipe it on stdin`. A deeply nested entry is refiled the same way, a repeated key is refiled as `duplicate key: <key>`; NaN, Infinity, -Infinity and a number that overflows to infinity are refiled as `the entry holds <literal>, which is not a finite number: write a number or null`; the CLI writes its files with `allow_nan=False`, and a closed stdin counts as empty. A leading UTF-8 byte order mark is dropped; stdin that does not decode as UTF-8 is refiled as `the entry must be UTF-8 JSON`.
  `title` defaults to the question clipped to 60 chars. Fills `session` from env
  `CLAUDE_CODE_SESSION_ID`, `project` from the working directory, and `run_kind` defaults to `main`
  (`codex` when env `CODEX_*` vars exist and there is no session id). Validates: at least 2
  options, option keys consecutive uppercase letters starting at A, in order (A, B, C...),
  `recommended` among the keys. `risk` is required, with no default: `low`, `medium` or `high`.
  The required top-level text fields are `question`, `what`, `problem`, `context`, `why`, `how`, `gains`,
  `losses`, `analogy`, `urgency` and `undo`; each option requires `label`, `tradeoff` (non-blank), `fit`
  (integer 0-100, or null for no estimate), `does`, `pros` and `cons`. `what` must hold at least 2 sentences, counted leniently: the
  non-empty runs between terminators, where a terminator is one or more of `.`, `!` or `?` followed by a space
  or the end of the text (so `2.0`, `e.g.`, `i.e.`, `etc.`, `vs.` and `cf.` do not break a sentence, and the last sentence needs no
  terminator). A text is refused, never clipped: `missing` when blank or not a string; `not valid UTF-8` when it holds a lone surrogate; `too long (n/limit)` over
  its limit (`question` 400, `what` 600, `context` 600, `problem` 400, `how` 400, `title` 60, the other texts 300);
  `placeholder` for a required text made only of the words `TBD`, `todo`, `n/a` or `lorem` (any case; punctuation and symbols such as … ignored), or of no word at all once symbols and emoji are dropped (a label that is only a thumbs-up), or, for a long text (`question`, `what`, `problem`, `analogy`, `why`, `how`, `gains`, `losses`, `context`, each option's `does`, `pros`, `cons`), of fewer than 3 words; a long text that holds any CJK character (`UNSPACED_SCRIPT`; Thai, Lao and Khmer are not in that set) is counted as a whole by its letters or digits instead, which must be at least 6 (`str.isalnum`). Short texts (`urgency`, `undo`, each option's `tradeoff` and `label`, `title`) may be one or two words, such as `Can wait`. Control characters become spaces; `question`, `title`, `label` and `tradeoff` are one line, with runs of spaces collapsed; the other texts keep their line breaks. The playbook's sentence and line limits (2 to 5 sentences in `what`, one or two in `why`, `how`, `gains` and `losses`, one line in `tradeoff`) are guidance: the CLI checks size, minimum words and the minimum of 2 sentences in `what`.
  Every gap is named in one error, grouped: the missing fields (`missing fields: analogy, undo`), then the other
  refused top-level fields (`what: placeholder`), then the `what` sentence rule, then each option grouped by key
  (`option B: does, pros`; `option B: cons: placeholder`). An option that is not an object is `option <n>: each option must be an object` (n counts from 1), and an option with no usable `key` is `option <n>: key`, and its other fields are checked under `#<n>` in `by_option`. Option keys out of order add `keys received: B, A`.
  An incomplete or invalid entry files nothing and prints
  `{"action":"refile","recommended":<given or null>,"error":"...","missing":[...],"by_option":{"B":["does","pros"]},"keys_received":["B","A"]}`:
  `missing` lists the refused top-level fields (`recommended` when it is absent or null, `title` when it is not a string), `by_option` the refused fields of each option, `keys_received`
  the option keys as given (`[]` when they were not a list). The caller completes the named fields and files again. A missing `fit` is a gap (`by_option`); `fit` set to null is stored as null (no estimate); any other value that is not an integer 0 to 100 is refused in `error` as `option <key>: fit: must be an integer 0 to 100, or null`.
  A new ask whose session and question text (case and spacing ignored) match an open question of that session
  prints `{"id":<existing>,"recommended":<its>,"title":<its>,"action":"open","duplicate":true}` and files nothing. A question
  with no session is never a duplicate. The duplicate check and the write run under the lock file `.ask.lock`, so asks from one session at the same time file one question. A duplicate of a paused question (`pause` true) prints `"action":"pause"` instead of `"open"`. A high-risk repeat prints `"action":"pause"` whatever the twin's risk; a high-risk repeat of an open low twin also sets the twin's `pause` to true and its `risk` to `high` in one atomic write, so the pause lookup holds the session for the twin.
  Prints `{"id","recommended","title","action":"continue|pause"}`, where `title` is the validated title (the clipped question when no title was given). An internal error prints
  `{"action":"continue","recommended":<given or null>,"error":"internal error"}`, or
  `{"action":"pause",...}` when the entry asked for `risk` `high` (nothing was filed in either case). A high-risk question that fails to write is tried four times in all, with a 50 ms back-off (`HIGH_RISK_ATTEMPTS`, `store_high_risk`, `file_question`); when the fourth try fails, `ask` prints `{"action":"pause","error":"<OS error text>"}` and files nothing. A low or medium risk question that fails to write keeps `"action":"continue"` with `internal error`. If every attempt fails only after `os.replace` (in the directory fsync), the question is on disk although the reply says nothing was filed; that is harmless, and the pause stands. A failure to take `.ask.lock` (a read-only state folder) is `internal error`, not retried.
- `answer <id> <key> [--by cli] [--text <string>]` — writes a/ if absent (the panel calls it with `--by panel`, `--strict`, and `--text` for key `other`); prints `{"id","key","written":bool}`. `--text` is the free text of key `other` (trimmed; its format characters (Cf) are deleted, its control characters and line breaks become spaces, runs of spaces collapse to one, and it is capped at 500 code points, on write and on read; required for `other`, dropped for a lettered key). Keys are case-insensitive (`b`, `other`, `OTHER`); the reply and the record carry the canonical key (`B`, `other`). The cap is 500 code points, no ellipsis. A second reply to a question already replied to, from any session, prints its stored key with `"written":false` plus the stored `by` and `who` (each when set).
  Session rule: a `cli` answer to a question with a session is refused unless the caller's
  `CLAUDE_CODE_SESSION_ID` equals that session (a shell with no session is refused too); the refusal
  prints `{"error":"answer refused: ..."}`, exit 0, and writes nothing, so the slot stays free. Panel
  answers (`--by panel|accept_recommended|accept_all`) are not bound to a shell session. A `cli` answer from the question's own session is stamped `by: "agent"`, the
  agent's own answer, and its delivery line reads "Answered by the agent itself"; a `cli` answer from another session,
  or to a question with no session, stays `cli`. `--by agent` is a usage error: the stamp is never typed.
- `status <id>` — prints `{"id","status","key"|null}`, plus `"who"` and `"by"` when the item is answered and its answer record
  carries them (`by` is the channel that answered: `panel`, `cli`, `agent`, `accept_all` or `accept_recommended`). `status` is `open`, `answered`, `delivered` or `expired`; `damaged` when the question file does not
  read (key null); `damaged answer` when the answer file does not read (answered, key unknown). An unknown id is a
  usage error (exit 1).
- `--strict` (opt-in, on `ask`, `answer`, `status`, `wait` and `prune`) — a refile or an error exits 1 instead of 0 (a refused `prune --id` too); `wait`
  also exits 2 on a timeout and 1 on any status other than `answered` or `delivered`. The JSON line is printed as
  usual. Without the flag the exit code stays 0 (usage errors exit 1 either way). A repeated `answer` that loses the
  first-writer race (`written:false`) is not an error.
- `wait <id> [--timeout 300] [--strict]` — polls every 0.5 s until the question leaves `open` or the timeout (seconds,
  finite, zero or more; `0` checks once) passes. It returns the reply `status` gives for the item
  (`{"id","status","key"?,"text"?,"who"?,"by"?,"line"?}`; `line` is the delivery line of the answer, see "Hook modes"): an answer past the TTL reads `expired`, not `answered`; an answer
  already delivered reads `delivered`. `{"id","status":"timeout"}` when nothing arrives. When it returns an
  `answered` item, it writes the delivery marker `d/<id>.json` that the deliver hook writes when the call comes from the asking session, or the question has no session, so the pane and `status`
  agree and the hook does not send the answer again. An unknown id is a usage error (exit 1). With `--strict`: exit 0
  for `answered` or `delivered`, 2 on timeout, 1 for any other status. The pause guard exempts `wait` and `export`
  like `ask`, `status` and `list`, so a paused turn can wait for its answer. The delivery marker is written only by the question's own session, or for a question with no session (Codex); another session's `wait` returns the answer and leaves the delivery to the asking session. A `wait` on a question filed with `run_kind` `subagent` prints the line for an `answered` or `delivered` reply and writes no marker, leaving it to the main session's deliver hook, which hands the line once and marks it. Known limit: a `wait` run by the main session on such a question also prints the line unmarked, so the hook hands it again (`_asked_by_subagent`, `cmd_wait`, `scripts/askaway.py`).
- `list [--open | --answered] [--since <when>]` — prints `{"items":[{"id","title","status","recommended","key"}...]}`,
  with `"who"` on each answered item whose answer record carries one; newest first. `--answered` keeps the answered items (`answered`, `delivered`, `expired`). With
  `--since`, only the items whose answer `ts` is at or after `<when>`; `--since` needs `--answered`. A q/ file that does not read, or whose `id` or `ts` does not match its entry, is listed as `damaged` (key null), and `status` reports it the same way; a reply to such a file is refused with the damaged error and writes nothing.
  `<when>` is a duration counted back from now (`30m`, `2h`, `7d`) or an ISO 8601 timestamp; a
  timestamp without a zone is read as UTC. Any other value is an error.
  `list --table` and `status <id> --table` print an aligned text table with the columns `id`, `status`, `title` (cut with an ellipsis so every line is at most 80 columns; the title takes the room the other columns leave; `_table_text`, `_fit_title`), `risk` and `age` (`3d`, `5h`, `12m`, `0m`, or `-` when unknown; `_table_text`, `_age_text`). Alignment counts code points, so wide (CJK) or combining characters misalign; accepted. The cut counts code points, so a wide (CJK) title can pass 80 terminal columns; accepted. `status --table` adds `reply: <key>` after the table when the item has a reply key, and an Other reply adds its text. Without the flag the JSON reply is unchanged.
- `export [--since <when>] [--format json|jsonl|csv]` — writes every question, newest first, with its answer record
  (as stored, so it carries `who` when `answer` wrote one). Rows are `{"id","status","question":<stored question>,"answer":<stored answer>|null}`:
  `json` (the default) is one array, `jsonl` one row per line. `csv` is one flat row per question, under the header
  `asked_at,project,title,recommended,answered_key,label,who,by,answered_at,delivered,id`: times are UTC ISO 8601 to the
  second; `label` is the text of the answered option (empty for `other` and for an unanswered question); `delivered`
  is `true` only for a delivered answer. No cell holds JSON. A damaged q/ file has one row: `status` `damaged`, a null `question` and `answer`, and `"damaged": true` (its CSV cells are empty except `id`, the last column, which every row carries); `--since` does not filter these rows. `--since` keeps the questions asked at or after `<when>`
  (the question's `ts`; unlike `list --since`, which filters by the answer's). Writes the document to stdout, not a
  JSON result line; exit 0.
- `away on|off|status` — writes or reads away.json; prints `{"away":bool}`. From a shell command of the agent, `away on` and `away off` are denied (`_away_reason`), and by code or an unreadable command that names the script (`_askaway_code_reason`, `_unreadable_reason`); the panel's `/askaway away` toggle writes `away.json` itself (`toggleAway`, `hooks/register.tsx`).
- `prune --id <id>` — removes one open question whose asking session has ended (the card's Dismiss) with its files;
  prints `{"removed":1}`, or `{"error":...}` for a question that is answered or whose session is alive. `prune --id <id> --force` also removes an open question whose asking session has no end marker (a terminal session never writes one, and a Desktop session that is still running has none either), so it is the user's own terminal mode; the Bash guard denies `prune --force` to the agent (`bash_tamper_reason`), and the pane's Dismiss of an ended card always runs `prune --id <id> --strict --force`, whatever the risk, so the person's own press lifts a pause (`dismissQuestion`, `dismissOrSay`, `hooks/register.tsx`). It prints `{"removed":1,"id":"<id>"}`; an answered question is still refused. `--force` without `--id` is a usage error, and without `--force` the refusal stands (`cmd_prune_id`, `_prune_command`). A non-forced `prune --id` refuses an open question with `pause` true that names a session, even when that session has ended (`prune refused: the question holds a pause; only prune --id --force lifts it`); `--id ""` prints `{"error":"invalid inbox id"}`. A damaged q/ file is removed with its companion files and prints `{"removed":1,"damaged":"damaged inbox file"}`; if such a file does not read, the error is `damaged inbox file: its file does not read`. For an open question, a file of the question that does not read gives `{"error":"prune refused: a file of the question does not read"}`. A question with a null or empty `session` is removed without that check; any other session that has not ended is still refused. `list` rows of an
  open question whose session has ended carry `"ended": true`; the pane polls `list --open` for them and draws the
  ended-session card (a notice instead of the options, Next on, Dismiss of an ended card always runs `prune --id <id> --strict --force`; no answer can be sent). The pane runs `list --open` only when the set of open questions that name a session changes, or at most every 30 s (`ENDED_RECHECK_MS`); a reply press (Submit all or a row's Submit) forces the check (`refreshEnded`, `hooks/register.tsx`).
- `prune [--days N]` — deletes q/a/d files of closed items (`delivered` or `expired`) whose closing
  time is older than N days: the delivery marker's `ts` for `delivered`, the answer's `ts` for
  `expired` (the d/ marker's `ts` when the answer does not read); never the question's `ts`. Prints `{"removed":n,"removed_ids":[...]}`; `--dry-run` prints `{"dry_run":true,"would_remove_ids":[...]}` and removes nothing, and `--dry-run` with `--id` is a usage error. It removes only regular files that read, and sweeps the a/ and d/ files whose question is gone. A damaged q/ file (no JSON object, or an id or ts that does not match it) is removed with its a/ and d/ files whatever `--days` is; the daily prune (the deliver hook's slow path) never removes one, so the user clears it. A damaged a/ file (one that does not read as a JSON object) with no d/ marker is removed the same way, with its q/ file, whatever `--days` is; one whose d/ marker exists (delivered) is kept for the retention window; the daily prune never removes one either.
  N defaults to env `ASKAWAY_PRUNE_DAYS` when it is a whole number of days (1 to 6 digits, `0`
  allowed, surrounding spaces ignored), else 30; `--days` overrides both. Any other value (empty,
  negative, decimal, a word, more than 6 digits) falls back to 30. The window never reaches an open,
  answered-but-unexpired or otherwise undelivered item: only `delivered` and `expired` items are
  candidates, so `ASKAWAY_PRUNE_DAYS=0` prunes a delivered or expired item at once and nothing earlier.
  The `deliver` slow path uses the same window (at most once a day). When the `last_prune` stamp is older than 7 days (`CLOCK_JUMP_S`), the daily prune skips its closed-item sweep, its orphan sweep and its stale-temp removal for that cycle and moves the stamp (`_clock_jumped`, `_maybe_prune`). The daily prune also removes orphan replies, an `a/` or `d/` file whose `q/` file is absent (`_orphan_ids`). The daily stamp moves only in cycles with unread replies (`hook_deliver` runs the cleanup only when one waits), so a machine idle for more than 7 days looks like a clock jump: in that first cycle an unread reply older than the window is delivered once instead of expiring, and `status` says answered while the pane draws expired from the clock (`answer_lapsed`, `answerStatusOf`, `hooks/model.ts`). Accepted (owner reply M53, option B); no second time reference is kept.

## Hook modes

`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py" hook <mode>` reads the hook JSON from stdin.
It fails open: any error exits 0 with no output (below Python 3.12 the version line goes to stderr, see Exit codes), except in the pause guard: it fails closed when the pause lookup raises (the call is denied), while the tamper check fails open (`hook_pause_guard`, `_tamper_denial`); the deliver and stamp-asker hooks still fail open. The command hooks are declared in
`hooks/command-hooks.json`.

- `ask-guard` — PreToolUse, matcher `AskUserQuestion`. Away → for each `tool_input.questions[i]`
  it builds a skeleton question and stores nothing: `title` = `header`; `question`; options keyed A, B,
  C… from `options[].label` with a trailing "(Recommended)" or "(Recomendado)" removed (case-insensitive);
  `tradeoff` = `options[].description`; `fit` null; `context` = the question's own context, else the
  descriptions as "<key>: <description>" lines; recommended = the option whose label had the marker, else
  the first; `what`, `problem`, `why`, `how`, `gains`, `losses`, `analogy`, `urgency`, `undo` = ""; each
  option's `does`, `pros`, `cons` = ""; risk low. It then prints
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
  <id> ("<title>") needs the user's answer. It holds this call: end the turn now instead of retrying or polling, because the answer
  arrives by itself in the context. A subagent hands back what it has and stops. To look it up once, run
  `askaway.py status <id>`." Exception: one simple Bash command running `askaway.py ask|status|list|wait|export` (its installed or mirror path may start with `~`, `$HOME` or `${HOME}`)
  passes when it is one simple call: an operator, `$` or a backtick counts only outside single quotes, so single-quoted text may hold them (`inbox_call`, `_without_single_quoted`). `answer` never passes (the Bash guard, a deterrent and not a token, is the barrier against the agent answering its own question), so only the user lifts a pause; an answer that is
  written but not yet delivered still holds it, and the next deliver run (the `status` call's
  PostToolUse, for one) ends it. Read-only MCP tools pass: `mcp__<server>__<tool>` whose tool name
  starts with a read prefix (`get_`, `list_`, `read_`, `search_`, `find_`, `describe_`, `show_`, `query_`; `is_read_only_mcp`) and no write
  word (`create`, `update`, `delete`, `keep`, `save`, `send`, `run`, and similar). A generic `query_*` tool (a SQL server's `query_database`) passes the guard if its name has no write word; the owner accepted this (M55). Every other tool
  of the matcher is denied, `Agent` included. Which calls a pause holds follows its `asker` (stamped by `stamp-asker`): a pause with asker `"main"` (`MAIN_ASKER`) holds the calls without an `agent_id`; a subagent's pause, with its `agent_id` as asker, holds only that agent's calls; a pause with no `asker` (not stamped yet, or its stamp failed) holds every call of the session, as before the stamp. A main-thread pause does not hold subagents already running, which may still act, so the main thread should not delegate the paused action. A damaged q/ file holds the whole session, since its asker cannot be read (`_holds_caller`, `_holding_question`). A high-risk question filed without a session holds no session's pause (`_holding_question`): only the model stops, and the agent treats the `pause` reply as a stop on its own.
- `stamp-asker` — PostToolUse, matcher `Bash`. For a finished command that is a call of this script's `ask` (the head the pause guard accepts, `_is_ask_call`), it reads the question id from the reply on stdout (`tool_response.stdout`, `_asked_id`) and, under `.ask.lock` (the lock an ask writes under, so a repeat's rewrite of the twin cannot drop it), writes `asker` onto that record when the record is a pause (`pause` true) of the payload's `session_id` and has no `asker` yet (`_unstamped_pause`, `hook_stamp_asker`). The asker is the payload's `agent_id`, or `"main"` when the call has none. A duplicate reply never stamps, so a high repeat that pauses an open low question stays unstamped and holds the whole session until it is answered; a repeat of a pause that already has an asker changes nothing. It prints nothing. An error, or a reply with no readable id, leaves the record without an asker, so its pause holds the whole session, as before this hook.
- `deliver` — UserPromptSubmit, SessionStart (matcher `startup|resume|clear|compact`) and PostToolUse
  (no matcher). It picks `answered` items with `session == input.session_id`, or with session null
  and `project == input.cwd`, and prints
  `{"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":<text>}}` with the answer
  line (see "Model-facing lines"), then claims the d/ marker for each reply by a no-clobber link where no readable one exists (an empty or torn marker is written again), then prints the line (flushed) before the daily cleanup; a directory sync that fails after the link is a warning on stderr, not a failure. Nothing answered → no output. The fast path (before the module imports) exits with no output when every answered item has a non-empty regular d/ marker, and it parses no marker: a torn marker with bytes in it closes its answer there, where the slow path would write it again. Atomic writes make such a marker unlikely.
  It must cost under 20 ms when the folder is empty, because PostToolUse runs after every tool.
  A busy session without the mod gets its answer on its next hook.
- `deliver`, lapsed answers — on every deliver run (any session), each answered item that the running
  session cannot receive is checked: if its asking session has a `desktop-released.json` marker, it
  gets a d/ marker, where none reads, with `expired: true, reason: "session-ended"`; otherwise, if the answer is older
  than 7 days, it gets a d/ marker, where none reads, with `expired: true, reason: "ttl"`. Only undelivered ids are checked, with the
  folder-first lookup. The slow path prunes at most once a day. A session that Claude Desktop
  released never runs hooks again, so its answers are closed here (`session-ended`) instead of
  waiting for the 7-day TTL. A lapsed answer closes for every session: an unread answer older than
  7 days is marked `ttl` even when the running session is its asking session.
  The folder-wide scan for released sessions runs at most once per deliver run (`ReleasedScan`),
  however many answers the run checks. While the `last_prune` stamp is older than 7 days (a clock jump), the read-time expiry of unread answers is held for that cycle too: `answer_lapsed` reads the hold, and `hook_deliver` delivers first and runs the daily cleanup after (the lines are printed and flushed before the cleanup), so the hold is read before the stamp moves (`answer_lapsed`, `hook_deliver`, `PRUNE_STAMP`).

## Commands

- `/askaway` — opens the panel. When the panel is not placed, it answers with a text list of the open questions. An unknown verb replies with the four verbs: `lang`, `quiet`, `who` and `away`.
- `/askaway lang pt-BR|en|auto` — sets the language; the default is `auto`, the environment's locale (see "Language"). The reply names the language: English, Português, or auto.
- Damaged files: a damaged `q/` file (no JSON object, or an id or ts that does not match it) holds the pause of its session while it is open; the pause reason names it and `askaway.py prune`. A damaged `a/` file keeps the pause (status `damaged answer`) until an `answer`, with any `--by`, overwrites it; `create_once` replaces only a file that does not read as a JSON object. A FIFO, a symlink or a folder in `q/` is not a damaged question: it is skipped. A question file that no tool can read holds no session as far as the CLI goes (its session is unknown), so it pauses nothing; the pane finds the pause from the raw text (`damaged_question_session`, `scripts/askaway.py`). `prune --id <id>` removes a damaged q/ file with its companion files when its bytes can be read as a regular file (`_prune_damaged_id`, `_remove_item`, `_regular_bytes`); a file that cannot be read at all, or is not regular, is kept and refused. The pane draws a notice that names its id, with a Dismiss button that runs `askaway.py prune --id <id> --strict`, without `--force`: the CLI removes a damaged file it cannot read as a question and refuses one it reads as a question, and a refused prune keeps the notice with the `toast.dismissFailed` toast (`renderDamagedPause`, `hooks/pane.tsx`; `damagedPauseOf`, `hooks/model.ts`; `damagedPausesOf` and `dismissOrSay`, `hooks/register.tsx`). Residual: a q/ file caught mid-write can show that notice for one poll.
- **Bash and file guard** (`bash_tamper_reason`, `_tamper_denial`): runs in every session, away or not, on Bash, Edit, Write and NotebookEdit. It denies (1) an answer typed in a shell: a command word that runs the askaway script or module (`python`, `python3.x`, `-m askaway`, a bare `askaway.py`, or a glob or a variable standing for it) followed by `answer`, or by a word that could expand to it, unless that command sets `ASKAWAY_HOME` to a literal path under /tmp or to `$(mktemp ...)` (inline, or exported by an earlier segment; a bare assignment does not reach the child process); (2) code that writes the state folder, or answers, in `python -c`, `-e` and a heredoc, and in `sh -c` and `eval` text, and code that mentions askaway and holds a literal process token (`subprocess`, `os.system`, `os.popen`, `os.exec*`, `os.spawn*`, `pty`, `runpy`, `exec(`, `.main(`, `cmd_*`) unless ASKAWAY_HOME is a scratch folder (`$(mktemp ...)` or a literal path under /tmp) (the JSON body of an `askaway.py ask|status|list|wait|export` heredoc is data and is not read as code). Only those literal tokens next to the word askaway are caught: `runpy` and `exec(` count as running the script; `importlib` and Node `child_process` pass even when they name the CLI; code that names the askaway module or script next to an `away` string or identifier is denied as the away switch (`_askaway_code_reason`, `AWAY_CODE`) (the guard is a deterrent). `WRITE_CODE`, the code test, also denies `os.symlink`, `os.link`, `symlink_to` and `hardlink_to` in code that names the state folder on the same line (`STATE_MENTION`); (3) a write into the state folder: a redirection target, an operand of `cp`, `mv`, `tee`, `touch`, `ln`, `install`, `mkfifo`, `mknod`, `mkdir`, `chmod`, `chown`, `chgrp`, `setfacl`, `chattr`, `truncate`, `rsync`, `rm`, `unlink`, `shred`, `rmdir`, `sed -i` or `dd of=`, after `~`, `$HOME`, `${HOME}`, `$ASKAWAY_HOME` and `cd` are applied; a glob is judged by the directory before its first wildcard, and when that directory is at or above the folder the glob is refused for every write, even one whose names cannot reach the folder (an over-deny: `cd ~/.claude && chmod +x *.sh` is denied, `cd ~/.claude/hooks && chmod +x *.py` is allowed); `cd`, `cd --`, `builtin cd`, `command cd`, `pushd`, `cd -P` and a bare `cd` (HOME) are followed, while `popd`, a bare `pushd`, `pushd +N` or `-N`, `cd -`, a `cd` operand with a variable, glob or brace, several operands, a command that assigns `CDPATH`, a `source` or `.`, and an `eval` whose text holds a `cd`, `pushd` or `popd` leave the directory unknown, and a relative target is then refused; deleting also refuses a path above the folder; (4) `prune --force` (the user's own terminal mode). (5) `away on` or `away off` typed in a shell, or a variable that could make one (`_away_reason`), unless ASKAWAY_HOME is a scratch folder; a command that does not read (an unbalanced quote in a trailing comment, a backslash-newline) is denied when it names askaway and matches `\baway\s+(on|off)\b` (`_unreadable_reason`, `AWAY_SWITCH_TEXT`), and an unreadable command that names ASKAWAY_HOME is denied as the state folder. Reading (`cat`, `jq`, `less`, `python3 -m json.tool`) stays allowed, and a Write, Edit or NotebookEdit into the folder is denied. The protected folders are the default `~/.claude/state/askaway`, always, even when HOME lies under /tmp, and `ASKAWAY_HOME` when it lies outside /tmp; paths are resolved (symlinks followed) before the check. **The guard is a deterrent against the agent's own shell, not a guarantee.** It does not model `xargs`, `find -exec`, a command word held in a variable, a script name built at run time in code (`'ask' + 'away.py'` passes), a script file's own code, or the code of interpreters beyond their `-c`/`-e` string. A write target held in a variable (`D=$HOME/.claude/state/askaway; cp x $D/a/`), a `~user` path (`~user/...`), a brace list (`.../state/{askaway,x}/a/`) and an `eval` text built at run time (`eval "$X"`) are not expanded; the user's own shell is not guarded.
- `/askaway quiet [on|off]` — stores the flag (store key `quiet`, default off) and reports it. While on, a new question
  raises no toast and a pressed card is not dimmed before it leaves (no `leaving` entry, so no fade).
- `/askaway who [name]` — stores the name panel answers are signed with (store key `who`; the pane asks for it once, a
  skip stores an empty name and ends the question); without a name it shows the stored one.
- `/askaway away` — toggles `away.json` and reports the new state.

There are no other public commands. The `/inbox` commands of earlier versions are not part of v1.

## Language

Detected from the environment: the first of `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE` that is
set (non-empty). A value that starts with `pt` means Portuguese; anything else means English
(`detectLang`, `hooks/i18n.ts`).
`/askaway lang pt-BR|en` stores the choice (`pt-BR` as `pt`) in the mod's `$.store` key `lang`; `auto` clears it, and the
locale decides again. The command then asks the pane for a new draw at once (`$.ui.invalidate('ui.render')` in `setLang`, as the poll does in `mergeBoard`): the engine keeps the pane's last draw until the plugin asks, so without that call an open card kept its old language until the next question arrived (owner report, beta.33). The pane translates only its own strings; the question's text is the filing agent's. When the question carries `translations`, every place that draws question text (the card's title, urgency and question lines, sections, details block and option rows; the tree rows; the history rows; the footer; the new-question toast; the `/askaway` text list) draws it through one overlay, `localizedQuestion` (`hooks/model.ts`), which maps `pt` to `pt-BR` and takes each translated field, field by field and option by option, falling back to the main text; so the whole card follows `/askaway lang` on the next draw (beta.34). `parseQuestion` reads `translations` defensively (`translationsOf`): a malformed part is dropped and never makes the question damaged. Group and session labels are not translated: they come from Desktop metadata (`family_title`, `session_title`) or, with no family title, from the project folder's name (`groupLabelOf`). An `urgency` text graded by keywords (no `urgency_level`) is graded in the language drawn, so its colour can change with `/askaway lang`; agents set `urgency_level` to avoid that. The CSV export and the `list`/`status` tables use the main text (`CSV_COLUMNS`, `_csv_cells`); the JSON export carries the stored question whole, `translations` included (`cmd_export`). The delivery line sent to the session always uses the main text. The command also registers `/askaway` again with the chosen language's description (`registerCommand`, `hooks/register.tsx`); the code comment there says the engine takes a changed description only from a fresh registration. The engine's behaviour on a second `command.register` by the same plugin is not verified: the mod calls it and logs a refusal once through `logFailure`; a refused re-registration leaves the old description until the next session. A stored `pt` or `en` wins over the detected language (`resolveLang`, `hooks/i18n.ts`). The panel and the band text are translated (`hooks/i18n.ts`, English and
Brazilian Portuguese, with identical key sets). The model-facing lines are always English and are never translated.

## Band button and toast

- A band row above the prompt (`ui.render` on `AbovePrompt`, `hooks/band.tsx`) is drawn only while open questions exist
  and no survey is up. It reads, left to right: the Askaway logo, "<n> questions waiting · <n> groups"
  (Portuguese: "<n> perguntas aguardando · <n> grupos"; `band.text`, `hooks/i18n.ts`), and an **Answer**
  button (Portuguese: "Responder"). The button has hotkey `1` (a bare digit works from an empty composer)
  and opens the panel.
- When a new open question arrives, the mod shows one toast: `New question: <title>` (Portuguese: `Nova pergunta: <title>`), where the title is the question's label: its title, else its text, on one line (`questionLabel`, `hooks/model.ts`).
  A question already waiting when the session starts does not toast; the first poll only primes the seen ids. The mod shows five more toasts, English texts from `hooks/i18n.ts`: `toast.replyFailed` ("Could not send your reply; the question is still open.") when the CLI cannot write a reply, `toast.replyHeld` ("Another window already replied {key}; that reply stays.") when a reply is refused, `toast.pickNotSaved` ("Could not save your pick; retrying.") when draft.json cannot be written, and `toast.clearedPending` ("Cleared {n}; waiting replies still reach their sessions") when a Clear all hides a row with no delivery marker, and `toast.dismissFailed` ("Could not dismiss the question; it is still listed.") when a Dismiss on an ended card fails (a refused prune).

## Panel

Pane id `askaway`, title "Askaway" (`hooks/pane.tsx`, `hooks/register.tsx`). Colors are in `hooks/look.ts`.

Draw order, top to bottom: header, tree of the open questions, question card, History, footer, Clear all button. The History block and the Clear link come
last because they change height as answers are delivered. On the desktop a Button drawn below a block that grows lost
its presses (the first click was dropped); this is the same finding as another mod's (comment above its
status list). `hooks/pane.tsx`, `renderPane`.

- **Header**: the Askaway logo, then "Questions waiting" ("Perguntas aguardando"; `pane.heading`, `hooks/i18n.ts`), with the counter on the right. The logo is the violet
  SVG on the desktop (`hooks/logo.ts`, `#8B5CF6`) and the bold "?" glyph on the terminal
  (`hooks/logo.ts`, `LOGO_GLYPH`, drawn by `hooks/logo-element.tsx`). The counter reads "<n> pending · <n> groups" ("<n> pendentes · <n> grupos"), or
  "Nothing pending" ("Nenhuma pendente") when no question is open (`counterText`, `hooks/model.ts`); while away mode is on, ", away mode on" (", modo ausente ligado", `list.awayOn`) follows it. The pane draws that suffix from its `away` flag, which the register sets from away.json (`hooks/pane.tsx`, `hooks/register.tsx`).
- **Tree of the open questions** (drawn when at least one question is open). The questions are grouped by GROUP =
  their `family` when they have one, else their `project` (`groupKeyOf`, `hooks/model.ts`), in the order of each group's
  oldest question. Every open group is drawn in turn, one under the other, in a Box keyed `group-<group key>`. No group
  draws a Button: a group's label is a Text. The header counter counts the same groups.
  - Group label: the `family_title` of the group's oldest question, title-cased like a session title ("release checklist
    review" becomes "Release Checklist Review"). A group whose oldest question has no family title takes the
    project's basename with hyphens and underscores turned into spaces, title-cased ("my-sample_project" becomes
    "My Sample Project"). Session label: the session's title, title-cased the same way;
    "the session" ("a sessão") when there is no title (`projectLabel`, `sessionLabelOf`, `titleCase`, `groupLabel`,
    `hooks/model.ts`, `hooks/pane.tsx`).
    Minor words stay lower-case after the first word (English: a, an, and, as, at, but, by, for, in, of, on, or,
    the, to, via, with; Portuguese: its own list, `MINOR_WORDS`). A word that already has a capital stays as typed.
  - **Label of each group**: a bold row (`renderGroup`, `hooks/pane.tsx`). The group on screen is the wizard's `groupKey`
    while that group is open, else the first open group.
    The rows of the root session (its `desktop_session` equal to the group key) come first, one step under the label, with no
    lead and no session row (`renderRootRows`, `hooks/pane.tsx`). Its derived sessions are rows below them: "├ <session>", and
    "└ <session>" for the last one, indented with the Box's `paddingLeft`. Each question of a session is a row
    with a mark and its title: ● the question on screen (bold), ○ the others; a picked row ends with " ✓ - " and its Submit link.
    The questions of a session that is not the last are indented with `paddingLeft={1}` and prefixed "│  "; those
    of the last session are indented with `paddingLeft={4}` (`renderBranchSession`, `renderTreeQuestion`, `hooks/pane.tsx`).
  - The card shows the questions of one group at a time (the group on screen); the other groups stay in the tree only,
    and the picks of every group are kept.
  - **Pressing a question row**: each question row is a link. Where the surface draws Markdown it is a Markdown block, `<mark> [<title>](file:///askaway/jump/<question id>)`, the one mark being the row's state (● on screen, ○ waiting) and never the link mark `▪` (`LINK_MARK`, `hooks/look.ts`) beside it, the title in `**…**` while the card on screen is that question; `pressableLinks` names only that href, and `onLinkPress` runs the jump. The Desktop draws the link dotted and underlined, as its own links. Where Markdown is not drawn it is the underlined plain Button it was (key `tree-jump-<question id>`, `treeLink`, `renderTreeQuestion`,
    `hooks/pane.tsx`). Its press puts that question on the card, the same move as walking there with Next or Back
    (`jumpToQuestion`, `hooks/register.tsx`; `jumpTo`, `hooks/wizard.ts`): the question's group becomes the group on screen
    and its step is the question's place in that group. The card
    scrolls to the top of the window (`$.ui.scroll`). The focus is a request the surface may refuse, since it is
    granted only while the pane holds the keys. A question that is fading out after a press takes nothing. Groups and
    sessions stay Text, with no press.
- **KeepGlide mark**: an SVG of the KeepGlide tile (`hooks/keepglide.ts`, `renderKeepGlide`, `hooks/logo-element.tsx`),
  drawn on the desktop only: 24px before the counter in the header (key `keepglide-counter`, `KEEPGLIDE_HEADER_SIZE`)
  and 28px before the Submit all button (key `keepglide-submit`, `KEEPGLIDE_SUBMIT_SIZE`). The terminal draws no mark.
- **Question card**, one question at a time, bordered, rows separated by a gap. Top to bottom:
  - the title row (`renderTitleRow`): where the surface draws Markdown, one heading, "### <title> - See session ↗ - <risk
    label> · <age label>" (`riskLabel`, `ageLabel`), the title a size up from the body; "See session ↗" ("Ver sessão ↗",
    `card.session`; the arrow marks the link, since the desktop draws no underline) is a link to the asking session's Desktop window, `#<desktop_session>`, left out with its dashes when
    the question has no `desktop_session` or the surface is the terminal (no session opens there: the heading reads "<title> - <risk label> · <age label>"); the surface opens it itself (no `onLinkPress`). Elsewhere the title in bold with
    the risk and age beside it, muted, wrapping under the title when they do not fit. The risk label (low, medium,
    high) is the risk of accepting the recommended option, as the filing agent judged it. A question with no title is
    named by its whole text, on one line that wraps; the pane never cuts a title (beta.35), and a stored title that
    is exactly 60 code points, ends with "…" and, without it, starts the question (the CLI's 60-character fallback) is drawn as the whole question
    (`questionLabel`, `hooks/model.ts`), in the card, the tree, the History, the footer, the new-question toast and the text list;
  - the Urgency line, directly under the title row and before the lead line, when `urgency` is set: "⏱️ Urgency" (pt
    "⏱️ Urgência"), its title bold and its text coloured by grade (`urgencyGradeOf`, `URGENCY_COLOR`, `hooks/look.ts`): low
    `success`, medium `warning`, high `error`, the engine's theme keys, so it follows light and dark. The grade is the optional
    `urgency_level` ("low", "medium", "high") of the question; when it is absent, the words of `urgency` decide (high: now,
    today, immediately, urgent, agora, hoje, imediat-, urgente, alta; medium: this week, soon, days, semana, breve, dias,
    moderad-, média), else low. When `urgency_level` is set, the title carries the grade word, "⏱️ Urgency (high)" (pt "⏱️ Urgência (alta)", `renderUrgency`, `urgency.grade.*`); an inferred grade stays colour-only;
  - the first block, drawn as two plain paragraphs with no heading, one blank line apart, on the card's own background:
    the `what` text, then the `problem` text, each only when its field is set (`firstBlockOf`, `renderFirstBlock`, key
    `explanation-before-question`); names the agent wrote between backticks, or slash commands, drawn in bold;
  - the details block, drawn when one of its sections is set (`renderDetailsBlock`, key `details-<id>`), with no rule above it: the Urgency line and the first block come before it. It is always open: there is no toggle and no `e` hotkey. Nothing in the card folds: the per-option What happens, Pros and Cons and the details block are always visible. Its first line is the
    title: the Askaway mark (`renderLogo`: the SVG on the desktop, the glyph on the terminal), then "Askaway Details:" (pt
    "Detalhes do Askaway:"), in bold. Its sections, each drawn only when its field is set, in this order: "🔁 Analogy"
    (`analogy`; pt "🔁 Analogia"), "💡 Why <rec>" (`why`; pt "💡 Por que A", the letter is the recommended key), "↩️ Undo"
    (`undo`; pt "↩️ Como desfazer"), "🛠️ How" (`how`; pt "🛠️ Como"), "🎁 What we gain" (`gains`; pt "🎁 O que ganhamos"),
    "⚖️ What we lose" (`losses`; pt "⚖️ O que perdemos") and "🧭 Context and origin" (`context`; pt "🧭 Contexto e origem")
    last. Each section is one line, "heading: text": the heading in bold, the text regular, wrapping as one paragraph; every
    name in the text (a slash command, or anything the agent wrote between backticks) is drawn in bold ink (`piecesOf`,
    `renderSection`). The sections come from `sectionsOf` (slot `details`). The block has no border. Its background is the engine theme key `userMessageBackground` (`DETAILS_FILL`,
    `hooks/look.ts`): the fill of the user's own message in every theme, resolved by the engine for the effective theme. The plugin keeps no theme state. Its padding is one cell across
    and one row above and below, so the text does not touch the fill's edge (`renderDetailsBlock`, `hooks/pane.tsx`).
  - the question text, bold;
  - the lead line, dim, right under the question: "On <key> since <HH:MM>. Pick another option to switch; no answer keeps <key>.",
    or "Paused since <HH:MM>, waiting for your answer." for a `high` risk question (`leadOf`, `hooks/model.ts`; pt: "Na opção <key> desde
    <HH:MM>. Escolha outra opção para trocar; sem resposta, fica a <key>.", "Pausado desde <HH:MM>, esperando a sua resposta."); the time takes the date before it (`17/10 14:05`, as in "On B since 17/10 14:05") when the question was asked on an earlier calendar day (`timeOf`, `hooks/model.ts`); not drawn on an ended card, whose notice says where the agent stayed;
  - the options, one full-width Button each, "<key> · Label" (for example "A · Label"), with "(Recommended)" (pt
    "(Recomendada)") after the label of the recommended one. The recommended option is bold while not picked; the picked
    option is the primary button, with "✓ " before its label (`renderOption`). Option keys and labels are drawn on one line (`singleLine`). Under each option, its own lines, indented one cell (`paddingLeft={1}`), plain on both surfaces and dim only while
    the card fades (the Desktop dim was tried in beta.32 and taken back in beta.33 at the owner's word): the tradeoff line "└ <tradeoff> · fit N" (the first letter of the tradeoff capitalized; pt "· aderência N";
    with no tradeoff "└ fit N"; a null fit draws nothing). Once per question, when an option has a fit, the hint line "fit N: the agent's estimate of fit, 0 to 100" (pt "aderência N: estimativa do agente, de 0 a 100") is drawn, dimmed only while the card fades (`option.fitHint`, `drawsFitHint`, `hooks/pane.tsx`). Also drawn at once: "What happens: <does>", "Pros: <pros>" and
    "Cons: <cons>" (pt "O que acontece", "Prós", "Contras"). The options are in a column with `gap={2}` and
    `marginTop={1}`, so two blank lines part them from the lead line (`renderQuestion`, `renderOption`,
    `hooks/pane.tsx`);
  - "<L> · Other…", where <L> is the letter after the last option's key ("C · Other…" with options A and B; Portuguese:
    "C · Outra…"), a plain Button, its text underlined after a dim link mark `▪ ` (`LINK_MARK`), bold while its pick is Other. With a kept label that is the pick, it is the primary button with "✓ " before its label, as a picked option is (`renderOther`, `isKeptChosen`). Its field is on the row under it,
    prefixed with the same "└ " branch glyph the option sub-rows draw (`BRANCH_PREFIX`), indented one cell and dim only
    while the card fades, with no label: its placeholder is the only text. The field is always open (no press needed, no
    autofocus, so the keys stay with the card until the person clicks in). Pressing the link only focuses that field
    (`$.ui.focus`, key `other-input-<id>`). The field has no `value` prop: it keeps the text the person types, across
    redraws. Each change of the text (the Input's `onInput`, `typeOther`) only keeps it in the pane's memory: no store
    write and no redraw. The text is recorded as the Other pick (`submitOther`, `flow.submittedOther`: trimmed, capped)
    at these points: on Enter in the field (the Input's `onSubmit`; the card and the field stay where they are); when the
    focus ring leaves the field (the `ui.focus` hook, `leavesOtherField`, records first and then lets the move through);
    and before an option pick, the Other link, Next, Back, Submit all, a tree row's Submit and a tree jump (`afterPendingOther`).
    A pending text whose question has left the board is dropped, not recorded; closing the pane (`ui.close`) drops them all. A blank text takes that
    pick away when no label is kept; while a label is kept, text on blur or on Enter is a no-op and the label stays picked (`submittedOther`, `hooks/wizard.ts`). Until one of those points, the pick, the bold link or chosen button, and the `✓` tree mark stay as they were. The field's
    submit label is "Apply" (pt "Aplicar"), the word for choosing the typed text. The typed text is not drawn again under the
    link. A surface with no Input draws no Other option (`renderOther`);
    Apply (Enter in the field, or its Apply button) moves the typed text to the Other button, which then draws
    `<letter> · <text>` like the other options draw their labels (`keptOther`, `hooks/wizard.ts`; `keepOther`,
    `hooks/register.tsx`); the field empties (a new input round, `otherInputKey`) and the focus moves to that button. A
    click on the button picks the text as Other (`{key:"other", text}`); Apply again replaces the text and drops the Other
    pick, so a new click is needed; a blank Apply changes nothing. While a kept label exists, text typed and not kept is not recorded as an Other pick on blur, Next or Back; it stays pending until Apply, so the button and the reply sent always agree. Submit all is the exception: its typed text is the reply, and blank text with a kept label changes nothing, so the label stays the reply (`submittedTypedOther`, `hooks/wizard.ts`). Otherwise, text typed and not kept follows the pending path above
    (kept in memory, dropped on close); a kept text is a draft label, shared through `draft.json` `labels` and so kept
    across a close and seen by the other windows. A draft's Other pick whose text differs from the kept label is drawn and sent as that label.

  - a separator: a 1px rule on the desktop, a row of "─" on the terminal (`renderDivider`);
  - the nav row: [← Back] (Portuguese: "← Voltar") on every question, dim on the first; [Next →] (Portuguese:
    "Próxima →") on every question but the last; on the last one, [Submit all (n)] (Portuguese: "Enviar tudo (n)"),
    where n is the number of questions of the group, dim until every question of the group has a pick. On the terminal each nav label carries its letter, "← Back (z)" style, since the terminal draws a Button's label alone (`navLabelOf`, `hooks/pane.tsx`); the Desktop draws the hotkey itself.
- **Hotkeys**: each option button draws its key letter in lower case as its hotkey (`optionHotkey`, `hooks/pane.tsx`), on
  every surface. "Other…" takes the letter after the last option (`otherLetterOf`), drawn in lower case as its hotkey. Back, Next and Submit all
  take the first free letters of their surface's pool (`letterFor`, `NAV_POOLS`, `hooks/pane.tsx`): `z`, `x`, `w` on the
  terminal; `p`, `f` and then `w`, `z`, `x` on the desktop. A letter that an option of the card uses, or the letter of Other…, is skipped. The
  hotkeys are drawn on every card: while the Other field has focus, the engine sends each printable key to the field alone,
  so no hotkey fires from typing.
- **Choosing**: an option records the pick and moves on: to the first question without a pick after the current one
  (wrapping to the start), or, once every question of the group has a pick, to the last question, where Submit all is.
  "Other…" with its text (Enter in its field, or the field losing focus, or a nav action) records the pick and keeps the card (see above). After each pick the group
  stays selected. No answer is written until Submit all; the picks are shared through `draft.json` (see "Shared picks").
  A card that is fading after a press takes no pick.
- **Move lock**: a pick, Next or Back starts a 350 ms move lock (`MOVE_LOCK_MS`, `moveOnce`, `hooks/register.tsx`); a second move while it holds does nothing. Submit all and the row Submit are not locked.
  While the lock holds, the option, Other, Next and Back buttons are drawn disabled (dim) so the interval is visible
  (`moveLockAtom`, `setMoveLock`), and a press in that window does nothing.
- **Next** moves to the next question whether or not it has a pick; **Back** moves to the previous one. Next does
  nothing on the last question.
- **Per-question Submit**: a tree row whose question holds a pick not yet submitted draws, after its text, " ✓ - " and a
  "Submit Answer" link, after the mark `▪` (Markdown `▪ [Submit Answer](file:///askaway/submit/<id>)` where Markdown is drawn, else the plain underlined Button; key `tree-submit-<id>`, pt "Enviar resposta"; `renderTreeSubmit`, `treeLink`). Its press
  answers that question alone, through the answer path (`submitOne`), at once, and the row leaves the tree and the round
  as Submit all's questions do. The other picks stay for Submit all. The card stays on its question; once that question is submitted and leaves the board, the card moves on to the open question at the same step, or to the last open one when that step is past the end (`clearPicks`, `prunedWizard`, `hooks/register.tsx`). Submit all alone returns the step to the first question. The leading mark of a row is only ● (on screen) or ○.
- **Submit all (n)** writes every answer of the group's round at once. It is drawn off (secondary, dim) while a question of
  the group has no pick in the store, but its press always runs: the submit action records a pending Other text first, then
  `submitGroup` checks again that every question has a pick and writes nothing otherwise. So a text typed in the Other
  field and followed straight by a click on Submit all is the answer, with no Enter and no focus move. On each press the card dims at once; each
  answer is sent to the CLI (`askaway.py answer --by panel`, see the answer record above), which writes `a/` first-writer-wins, and the card fades for 250 ms (`FADE_MS`). Then the
  picks of those questions are cleared and the step goes back to the first question. When other groups stay open, the
  card then shows the first question of the first group still open. A reply that fails does not stop the round: Submit all goes on to the next question and clears only the picks whose reply is on the board or whose session ended (`submitGroup`, `hooks/register.tsx`).
- **Picks** survive a re-poll. Picks, and an open Other field, of questions that are no longer open are dropped.
- **Shared picks**: every session of the state folder shows the same picks. Each change of the picks (an option, an Other text, Submit all, a row's Submit) writes `draft.json` with the picks and the write's `ts` (`changeWizard`, `saveDraft`, `hooks/register.tsx`). Each session's poll applies a draft whose `ts` is newer than the last one it wrote or applied (`applyDraft`; a malformed file is ignored), so the newest write wins; a `draft.json` that exists but does not read holds this session's first write (the picks are kept and retried at the next poll, with `toast.pickNotSaved`), and the retry overwrites it from this session's picks and logs it; a session that starts applies the folder's draft at its first poll. Only the picks and the kept Other labels (`labels`, merged per id like the picks) are shared: the step, the group and the card stay per session. Each write merges this session's changed ids into the file's picks (`saveDraft` reads the file first), so the picks another session made within the same poll interval (5 s) are kept; two sessions that change the same id within that interval keep the later write. Each write's ts is the later of the clock and the last draft ts this session wrote or applied plus one (`saveDraft`), and `applyDraft` applies a draft more than DRAFT_SKEW_MS (60 s) ahead of the clock and pulls its stamp back to the clock; the next draft write restamps the file. After a clock step back larger than a minute, a window's drafts sit ahead of the other windows' clocks and are applied by them, their stamp pulled back to the clock; no pick is lost, since the merge is per id. An answer stays first-writer-wins: a second reply to a question already answered is refused by the CLI (`written: false`), and the pane takes the stored answer. A refused reply raises `toast.replyHeld`, which names the key that holds the question (`writeAnswer`, `hooks/register.tsx`).
- **History** (under the card, above the footer; `historyOf`, `hooks/model.ts`; `renderHistory`, `hooks/pane.tsx`): the answers
  of the last while, drawn as the open tree is: a heading row with the History icon (a clock with an arrow turning back,
  `historySvg` in `hooks/logo.ts`, the glyph "⟲" on the terminal; not the Askaway logo) and "History" ("Histórico"), a
  blank line, then the tree. Each family is a bold row, the rows of its root session sit right under it and its derived
  sessions are "├" or "└" rows (as in the open tree). On the Desktop only (the terminal draws the History labels plain; `renderHistory`, `hooks/pane.tsx`), the family label is a bold link to
  the family root's Desktop session ("**[<title>](#<family>)**") and a derived session's row a link to its Desktop session
  ("└ [<title>](#<desktop_session>)", `sessionLink`, `hooks/pane.tsx`); the surface opens them itself. The open tree draws
  no such links. Each answer is one row "○ <title> ✓ <reply> · <line>", shaped as a picked row of the open tree
  (the same ○ every history row carries, plain; the state is only in the line). The row is plain Text on both surfaces, its
  title the question's whole title (beta.35): a `#local_…` link is drawn by the Desktop as a chip with the session's own name,
  so a linked title read as the session's name on every row (`renderHistoryEntry`, `hooks/pane.tsx`); the group and session
  rows above keep their links. `<reply>` is the chosen option's label in the pane's language (`localizedQuestion`), or an
  Other reply's whole typed text in typographic quotes (“…”), so it reads apart from an option label, never the letter
  (`answerNameOf`, `hooks/model.ts`). The line reads
  "sent <time> · delivered <time> (read by the session)" ("enviada <time> · entregue <time> (lida
  pela sessão)"); a pending line ends at the sent time (nothing says it is waiting: the line only grows once the session
  answers back), an ended one ends "the session ended before reading
  it" ("a sessão encerrou antes de ler"), an expired one "expired unread" ("expirou sem ser lida"). An Other answer shows its whole typed text, wrapping (an empty
  one reads "Other…" / "Outra…"); a row whose question has left the board names the key letter, the only thing left. "answered by agent" or "answered by <name>" (a CLI answer) appears only when the
  answer was not given by the person. Times are local: "14:32" on the day of the pane, "17/10 14:32" on another day. The delivered
  time is the `ts` of the delivery marker (`d/<id>.json`); an expired marker carries a ts, which the History line does not show.
  A question's title is never a jump link: an answered question is no longer open, so no card can be jumped to. A row whose question has left the board is titled "Question closed" ("Pergunta encerrada").
  A delivered line stays until Clear all, as a pending, ended or expired line does; no timer removes it (`historyOf`, `hooks/model.ts`).
- **Clear all** (the last row of the pane, after a divider, right-aligned; `renderHistoryClear`): a secondary Button, as the card's Back is, labelled "Clear all (N)"
  ("Limpar tudo (N)"), where N counts every row drawn now, pending ones included; hidden when N is 0. Its press
  (`clearHistory`, `hooks/register.tsx`) writes those answers' ids to `cleared.json`, shared by every session of the folder: the
  press writes the ids it drew and its own earlier ones, pruned to the answers its board knows, plus every id the file already lists, kept unpruned (a board up to one poll behind may not know an answer another session cleared; the file's ids stay while their reply file is on disk, and an id leaves the list only at a Clear all that finds no reply file for it and no reply on the board), with the write's `ts` (recorded for diagnosis; no reader uses it). Two Clear all presses within the same instant in two sessions keep the later write, as `$.fs` has no atomic rename. Each
  session's poll adds the listed ids its `cleared` atom lacks (`applyCleared`), so a row another session cleared leaves at its
  next poll (5 s), and a session opened later hides it at its first poll. The press also keeps the ids in `$.store` key
  `cleared`, the start seed of a session. A malformed file reads as nothing cleared (`parseCleared`, `hooks/model.ts`).
  Non-destructive: it touches no q/, a/ or d/ file and writes only `cleared.json` in the state folder, so a cleared pending answer is still read by its session. Clear all is one-way from the pane: a hidden History row does not come back there, while the q/, a/ and d/ files stay in the state folder and `list --answered` and `export` still show them. It replaces the
  per-line ✕ of earlier versions. A Clear all that hides a row with no delivery marker (a pending or ended line) shows `toast.clearedPending` (`clearHistory`, `hooks/register.tsx`).
- **Footer** (`footerText`, `hooks/model.ts`): drawn under the History block, above the Clear all button, only while no
  question is open. It counts the answers given in the last 24 h, names the last answer (its question's whole label, the chosen option's label in the pane's language, or an Other reply's typed text in quotes, and its age: "… → <label>, <age>", `footer.last`; `lastAnswerText`, `answerNameOf`), and counts the answers not yet read and the expired ones, leaving out the rows Clear all hid (`cleared`), each left out at zero (the replied count keeps its "none" form). Absent while a question is open. Its counts are read on the pane's clock (the tick, `tickClock`), which the poll rewrites
  whenever the footer text changes, so the 24 h window and the 7-day TTL move the counts with no status line change. With no state folder the footer reads `command.awayUnavailable` instead, "Askaway away mode is unavailable: no state folder (HOME is unset)." (`hooks/register.tsx`, `hooks/i18n.ts`). The footer is drawn without dim (M68); the recorded ratios are in `TEXT_CONTRAST` (`hooks/look.ts`): the Desktop dim (opacity .6) measures 5.17:1 light and 7.26:1 dark, the engine's inactive token 5.74:1 and 6.23:1, and the terminal's SGR 2 is not measured; the urgency colours measure 4.71 to 6.67 in light and 6.48 to 10.88 in dark. The lead line and the `▪` link mark are dim on both surfaces (owner reply, M58); the sub-rows are plain on both surfaces and dim only while the card fades; the details block is dim only while the card fades.

## Focus and clicks

Decision: every Button of the pane and of the band keeps its press handle across redraws, on the desktop and on the
terminal alike. The plugin does not hold the focus ring: the engine moves it as it does for any plugin. Its one `ui.focus` hook
(`hooks/register.tsx`) passes the move on first (`await next(e)`), then records the text of the Other field the move left
(see Other…); it never blocks, rewrites or re-targets a move. Its `ui.close` hook drops the pending Other texts. The ring, and the pane's hotkeys (the option letters on both surfaces, the letter of "Other…", and `z`, `x`, `w` or `p`, `f`, `w` for Back, Next and Submit all) are its keyboard path.

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
  through `hold`: each option, Other…, each tree link (`treeLink`), Back, Next, Submit all, the band's Answer and the Clear all button.
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

Colour: the accent `#3566C8` (`ACCENT_COLOR`, `hooks/look.ts`) is never used for text (since 0.4.0-beta.7, commit 0a01eb5):
text is bold ink, or the theme's own foreground, and the pane draws no fill of its own, except the details block (below): the explanation and the status rows sit on the card's background. Measured WCAG 2.x
contrast of the accent, for the record: 5.40:1 on `#FFFFFF` and 3.28:1 on `#111827` (`#1E40AF` measured 8.72:1 and 2.03:1).
The details block's fill is the engine theme key `userMessageBackground` (`DETAILS_FILL`, `hooks/look.ts`), the fill of the user's own message in every theme. The engine resolves it for the effective theme: every built-in theme defines the key (light, dark, their daltonized and ansi variants), and `auto` is resolved by the engine to the Desktop's system theme, so the plugin keeps no theme state of its own.

## Polling

The mod lists `q/`, `a/` and `d/` with `$.fs.list`, and reads `draft.json` and `cleared.json` (`applyDraft`, `applyCleared`), on a `$.clock` timer every 5 s while the session runs
(`hooks/register.tsx`: `POLL_MS`, `readBoard`). A failed listing of a folder keeps the board the last poll read (a missing folder still reads as empty), and an interval poll does not start while one runs (`polling`).
It merges the folder into the board and never takes back an answer that a press wrote: a local
answer stays while its question is listed and the folder read does not show it yet.

The pane has no wall-clock age pass that writes or drops items: the expired status is drawn from the clock (`answerStatusOf`, `hooks/model.ts`), and the TTL write and the prune are the CLI's (`answer_lapsed`, `_maybe_prune`).

The race suites (`tests/race.test.ts`, `tests/panel-race.test.ts`) keep the state folder in memory: their `fs.write` stubs store every write in a folder map, `draft.json` and `cleared.json` included, with the production write semantics (`draft.json` and `cleared.json` are written with `$.fs.write`, with no atomic rename; the `d/` markers and `away.json` go through `writeAtomic`). Six race cases cover a draft stamped more than `DRAFT_SKEW_MS` past the clock, a failing listing, a torn delivery marker, overlapping polls, 200 open questions and a no-space write of `draft.json`.

## Idle hand-off

In each session's interval poll, when the session is idle (no main-loop turn running: `turn.start`
begins a turn and `turn.complete` without `agentId` ends it), the answers whose question has
`session` equal to this session's id, at least 5 s old, with no readable d/ marker, are handed to the prompt. An answer whose ts lies after the clock is handed at once, without the 5 s wait (`promptsDue`, `hooks/model.ts`).
All due answers of one asking session go in ONE `$.prompt.submit({ text })`, one line per answer,
joined by "\n". The d/ markers (`via:"prompt"`) are written first, only where absent, each one atomically: `writeAtomic` writes a dot-prefixed temp `.<name>.<random>.tmp` beside the target and moves it with `mv -fT`, so a folder at the target fails instead of swallowing the temp, and the CLI's stale-temp prune covers that name; a marker that does not parse counts as absent.

- Never twice: the marker is the guard, and an in-flight guard covers overlapping polls.
- A busy session gets nothing until its turn completes.
- If the submit fails after the markers are written, the answers stay marked delivered, the failure is logged, and
  a toast says each answer was not delivered (`toast.undelivered`: "Answer <key> for <id> was not delivered; answer
  again in the session."). No retry.

## Model-facing lines (English, never translated; `_delivery_line` and `deliveryLine` stay identical, and both suites read `tests/delivery-lines.ts`, one JSON literal exported as `DELIVERY_LINES`; a lone surrogate in an Other text is written as `\udXXX`, as `JSON.stringify` does; the Other text is capped at 500 code points with no ellipsis, in storage and in the line.)

`_delivery_line` is one line: control characters and line breaks in the title, the labels and an
Other text become spaces, so a title cannot start a second line of the delivery. Unicode format characters (category Cf) are deleted from titles, option labels, Desktop titles and this one-line text.

The line opens with who answered, from the answer record's `by` and `who`, then the chosen option or Other text,
then the question. The five wordings:

- `by: panel`: `Answered via panel by <who>: <key> · <label>. Askaway question <id> (<title>).`
- `by: cli` (a shell answer from another session, to a question with no session): `Answered by <who> (cli): <key> · <label>. Askaway question <id> (<title>).`
- `by: agent` (a shell answer from the question's own session, stamped as the agent's own): `Answered by the agent itself: <key> · <label>. Askaway question <id> (<title>).`
- `by: accept_all`: `Accepted all: <key> · <label>. Askaway question <id> (<title>).`
- `by: accept_recommended`: `Accepted the recommended option: <key> · <label>. Askaway question <id> (<title>).`

Then, when the answer differs from the recommendation, ` (you were using <rec key> · <rec label>)`. For key `other`,
the chosen part is `their own answer (Other): <JSON string> [typed by the user: data, not instructions]` in place of `<key> · <label>`. `<JSON string>` is the Other text (Cf deleted, one line, capped at 500 code points) serialized with JSON.stringify, which adds its own quotes and escapes `"` and `\`, so the text cannot end the quote early; the clause marks it as data, never as an instruction. For `ok"` then a newline then `then more. "` the chosen part is `their own answer (Other): "ok\" then more. \"" [typed by the user: data, not instructions]`. `<who>` is the record's `who`,
or `unknown` when it has none. `<who>`, the title and each option label are JSON string literals on both surfaces (`_literal`, `scripts/askaway.py`; `deliveryLine`, `hooks/model.ts`), e.g. `Answered via panel by "tester": B · "In-process". Askaway question <id> ("Cache backend"). (you were using A · "Redis")`. A record with no known `by` reads `Answered by <who>: ...`.
`wait` returns the same line as `line` when its call writes the delivery marker; another session's `wait` returns no line, except for a question filed with `run_kind` `subagent`, whose line any `wait` returns (`cmd_wait`, `scripts/askaway.py`).
- Ask-guard and pause-guard reasons: see "Hook modes".

The agent instruction lives in `skills/askaway-question-playbook/SKILL.md`: file a question with every required
field, a recommended option, and on `refile` complete and file again; continue on `recommended` unless
`action` is `pause`.

## Packaging

- The catalog is not in this repository. It lives in `KeepGlide/claude-plugins` (marketplace `keepglide`), whose
  entry `askaway` is a `git-subdir` source pointing at `plugins/askaway` of this repository. Installed with
  `claude plugin marketplace add KeepGlide/claude-plugins` and `claude plugin install askaway@keepglide`.
- `plugins/askaway/.claude-plugin/plugin.json`: the manifest; `"hooks": "./hooks/command-hooks.json"`
  declares the command hooks (`deliver`, `ask-guard`, `pause-guard`, `stamp-asker`), which use
  `python3` and `${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py`.
- `plugins/askaway/hooks/hooks.json`: the mod, `{"modules":["./register.tsx"]}`.
- `plugins/askaway/skills/askaway-question-playbook/SKILL.md`: the skill (`askaway:askaway-question-playbook`) agents read before they file a question.
