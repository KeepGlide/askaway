# Changelog

All notable changes to Askaway are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version in
`plugins/askaway/.claude-plugin/plugin.json` is 0.4.0-beta.31, set by the beta.31 release commit.
Commit hashes name the change in `git log`.

## [0.4.0-beta.31] - 2026-10-21

Gauntlet round 5: fixes to the CLI's Bash guard, the ask and prune paths and the delivery markers, to the pane's draft and marker writes, and to the pt-BR command replies, with the docs and test pins that go with them. Plugin tests: 410 pass; pytest: 800 passed; `biome lint` clean.

### Fixed

- M1: `_hits_state` (`scripts/askaway.py`) judges a glob write target by the directory before its first wildcard, so a glob above the state folder is refused for every write, as deletes already were.
- M2: `_ShellScan._directory_after` and `_change_directory` (`scripts/askaway.py`) follow `builtin cd`, `command cd`, `pushd` and `cd -P`; `popd`, `cd -`, a variable or glob operand, and several operands leave the directory unknown, and a relative write target is then refused.
- M3: `_code_reason` (`scripts/askaway.py`) refuses inline code that mentions askaway and starts a process or calls the CLI, so a reply word built at run time next to a literal process call no longer passes; split script names still do.
- M34: `_pause_decision` (`scripts/askaway.py`) quotes the question title in the pause reason as a JSON string, as the delivery line does.
- M4: `cmd_prune_id` (`scripts/askaway.py`) refuses a non-forced removal of an open question with `pause` true; only `--force` lifts it.
- M5: `_file_or_hold_twin` (`scripts/askaway.py`) makes a high-risk repeat of a low twin reply `pause`: the twin it returns is paused, and `_duplicate_reply` replies `pause` for any paused twin.
- R1: `_directory_after` and `_directory_untracked` (`scripts/askaway.py`) follow `cd --`; they leave the directory unknown for `pushd +N` or `-N`, a bare `pushd`, a command that assigns `CDPATH`, `source` or `.`, and an `eval` whose text holds a `cd`, `pushd` or `popd`.
- M5b: `_file_or_hold_twin` (`scripts/askaway.py`) pauses the open twin when a high-risk repeat arrives.
- M5c: `_file_or_hold_twin` (`scripts/askaway.py`) also raises the twin's risk to high with its pause.
- M6: `_words` (`scripts/askaway.py`) drops Unicode punctuation and symbols at a word's ends, so an ellipsis is a placeholder like three dots.
- M7: `_prune_command` (`scripts/askaway.py`) treats `--id ""` as an invalid id, not a bulk prune.
- M11: `create_once` (`scripts/askaway.py`) treats a failed directory sync after the link as published, with a stderr warning; `hook_deliver` prints and flushes the claimed lines before the daily cleanup.
- M20: `_title` (`scripts/askaway.py`) refiles a non-string title with a message naming the fix.
- M21: `_read_text` and `_too_short` (`scripts/askaway.py`) count letters for unspaced scripts, so a valid CJK question is not a placeholder.
- M22: `_options` (`scripts/askaway.py`) keeps a keyless option as `#<n>` and checks its fields in the same refile.
- M23: `_entry_json` (`scripts/askaway.py`) refiles non-UTF-8 stdin with the UTF-8 message and drops a leading byte order mark.
- M24: `build_entry` (`scripts/askaway.py`) lists an absent or null `recommended` in `missing`.
- M25: `help_reply` and `dispatch` (`scripts/askaway.py`) read a help flag after a value option as the value.
- M26: `_settled_ts` (`scripts/askaway.py`) uses the d/ marker's `ts` for an expired item whose reply does not read.
- M35: `_make_folder` (`scripts/askaway.py`) creates the state folder and its folders with mode 700.
- M49: `cmd_prune` and `_prune_command` (`scripts/askaway.py`) add `--dry-run` and `removed_ids`.
- M52: `_maybe_prune` (`scripts/askaway.py`) removes orphan replies in the daily cleanup.
- M59: `WRITE_CODE` (`scripts/askaway.py`) denies `os.symlink`, `os.link`, `symlink_to` and `hardlink_to` into the state folder.
- M8: the pt-BR command replies `command.quietInvalid`, `command.langInvalid` and `command.verbsHelp` (`hooks/i18n.ts`) use "Digite" for "Use".
- M9: `submitGroup` (`hooks/register.tsx`) re-reads each question's pick before its reply is written, so a pick changed during a Submit all round is sent.
- M10: `submittedTypedOther` (`hooks/wizard.ts`), used by the submit action (`hooks/register.tsx`): Submit all sends the text typed in a labelled question's Other field.
- M12: `handOne` and `handDue` (`hooks/register.tsx`): a failed marker write skips its line; the other replies are still handed, and only unmarked replies are toasted.
- M13: `saveDraft` (`hooks/register.tsx`, with `takeDraftLock` and `mergeDraft`): `draft.json` is read, merged and written under `draft.lock`.
- M29: `alignOtherToLabels` (`hooks/wizard.ts`), applied in `applyDraft` (`hooks/register.tsx`): a draft Other pick whose text differs from the kept label is drawn and sent as the label.
- M31: `publishMarker` (`hooks/register.tsx`): pane delivery markers are published with a no-clobber link, as the CLI does.
- M32: `promptsDue` (`hooks/model.ts`): a reply past `ANSWER_TTL_MS` is not handed to its session.
- M33: `mintPanelToken` (`hooks/register.tsx`): install and chmod failures name the exit code only, not the token file path.
- M39: `types/index.d.ts` declares the wizard's `labels` and `fieldRound`, which the hooks use.
- M47: `saveDraft` and `clearHistory` (`hooks/register.tsx`): `draft.json` and `cleared.json` are written through `writeAtomic`.
- M4b: `dismissEnded` and `dismissEndedOrSay` (`hooks/register.tsx`): Dismiss of an ended card sends prune --force, whatever the risk, so the person's Dismiss lifts a pause.
- M60: `takeDraftLock` (`hooks/register.tsx`) also removes `.draft.json.*.tmp` files a minute old or older when it removes a stale `draft.lock`.
- R12: `handOne` and `handDue` (`hooks/register.tsx`): a failed submit toasts the replies this call marked and those whose marker write failed; the replies another window or the CLI marked first are not toasted.

### Tests

- M54, M55 and M50 are test-only pins (plugin tests): the move lock pinned at 349 and 350 ms; the `mv -fT` argv and folder-at-target; the two-way i18n placeholder check.
- R4 (test-only): the `ln` temp-marker argv (three words, marker as the target) is pinned in both test host stubs (`tests/askaway.test.ts`, `tests/race.test.ts`).
- M16: refuted, no module-state leak between tests (no change).
- M17, M19, M53 and M57 are test-only pins (`scripts/tests/test_askaway.py`): the 7-day TTL boundary, `write_atomic`'s temp-plus-rename, the exact text limits and `fit` 0 and 100, and the shortest prefix of `--force` (`--f`) in the forced-prune guard.

### Docs

- M14: README.md and README.pt-BR.md say a `fit` of `null` is accepted, with no estimate.
- M36: README.md and README.pt-BR.md, step 7 Expect, include the `title` key the CLI prints.
- M37: README.md and README.pt-BR.md list the CSV columns, which end with `id`.
- M38: the beta.29 entry names `keepChangedSince`, the function `hooks/register.tsx` defines (it was misnamed).
- K: `plugins/askaway/skills/askaway-question-playbook/SKILL.md` states the refile rules of M20, M22, M23, M24, M6 and M21, and the twin pause of M5 and M5c.

## [0.4.0-beta.30] - 2026-10-20

Owner replies to the 21 questions of Gauntlet round 4 (20 filed on 2026-10-20 plus M72 filed during this release): 14 change code, 1 changes the tests (M36), 1 is covered by M63 (M65), 5 change only the docs (M54, M59, M62, M67, M72; M54, M62, M67 and M72 keep the current behaviour: the dim text outside the footer stays until the Desktop's real dim colour is measured in round 5). Plugin tests: 385 pass; pytest: 695 passed; `biome lint` clean. Review: code-inspect-reviewer on Sonnet high, 0 must, 4 should fixed or recorded, 6 nits recorded.

### Added

- `askaway.py <cmd> --help` or `-h` prints one JSON line `{"usage": ..., "options": [...]}` for every command, `hook` included, and exits 0, except `hook deliver -h` with nothing to deliver, which prints nothing (`_exit_if_idle` runs before the parser); the top-level help is unchanged (`command_help`, `help_reply`; `scripts/askaway.py`).
- `list --table` and `status <id> --table` print an aligned table with `id`, `status`, `title` (cut to 40 code points), `risk` and `age`; `status --table` adds `reply: <key>` after it; alignment counts code points, so wide (CJK) or combining characters misalign (`_table_text`, `_age_text`, `_status_command`; `scripts/askaway.py`).
- `prune --id <id> --force` removes an open question whose session has not ended, such as a terminal session, which never writes an end marker, or a Desktop session still running; an answered question is still refused. It is the user's manual mode: the agent cannot run it (`cmd_prune_id`, `_prune_command`; `scripts/askaway.py`).
- Keep on Other works as a draft label: the typed text becomes the label of the Other button and is kept as a pick; typing again replaces the label and needs a new click. While a kept label exists, text typed and not kept is not recorded as an Other pick on blur, Next or Back; it stays pending until Keep (`keptOther`, `submittedOther`; `hooks/wizard.ts`, `hooks/register.tsx`).
- `labels` in `draft.json`: the kept Other labels are shared by every session with the picks (`parseDraft`; `hooks/model.ts`, `hooks/register.tsx`).
- The move lock is visible: while a pick, Next or Back holds it for 350 ms, Next and Back are drawn disabled and a second press does nothing; Submit all and the row Submit are not locked (`moveOnce`, `MOVE_LOCK_MS`; `hooks/register.tsx`).
- `/askaway lang` registers `/askaway` again with the chosen language's description (`setLang`, `registerCommand`; `hooks/register.tsx`). The engine's handling of a second registration is not verified; a refused one is logged once, and the old description stays until the next session.

### Changed

- The Bash guard denies `prune --force` to the agent (`bash_tamper_reason`; `scripts/askaway.py`).
- `query_` is a read prefix, so an `mcp__<server>__query_*` tool passes the pause guard; the guard reads the tool name only, so a generic `query_*` tool such as a SQL server's `query_database` passes when its name has no write word (`READ_ONLY_PREFIXES`, `is_read_only_mcp`; `scripts/askaway.py`).
- The pause guard lets through a simple `askaway.py ask|status|list|wait|export` Bash call whose operator, `$` or backtick sits inside single quotes; outside single quotes they still deny (`inbox_call`, `_without_single_quoted`; `scripts/askaway.py`).
- The `ask` reply carries `title`, the validated title (the clipped question when none was given), and a duplicate reply carries it too (`cmd_ask`; `scripts/askaway.py`).
- `fit: null` is accepted and stored as null (no estimate); any other value must be an integer 0 to 100, and a missing `fit` is still a gap (`_strict_fit`, `FIT_RULE`; `scripts/askaway.py`).
- A high-risk question that fails to write is tried four times in all, 50 ms apart; if the fourth try fails, `ask` prints `"action":"pause"` with the OS error and files nothing. Low and medium risk are unchanged. If every attempt fails only after `os.replace` (in the directory fsync), the question is on disk although the reply says nothing was filed; the pause stands. A failure to take `.ask.lock` is `internal error`, not retried (`store_high_risk`, `file_question`, `HIGH_RISK_ATTEMPTS`; `scripts/askaway.py`).
- A clock jump (a daily stamp older than 7 days, `CLOCK_JUMP_S`) holds the daily cleanup's closed-item sweep and stale-temp removal, and the read-time expiry of unread answers, for that cycle. The daily stamp moves only in cycles with unread replies, so a machine idle for more than 7 days looks like a clock jump: the first such cycle delivers an overdue unread reply once, and `status` says answered while the pane draws expired (`_clock_jumped`, `_maybe_prune`, `answer_lapsed`; `scripts/askaway.py`).
- A draft stamped more than `DRAFT_SKEW_MS` (60 s) ahead of the clock is applied, with its stamp pulled back to the clock, instead of being ignored (`applyDraft`; `hooks/register.tsx`).
- The footer is drawn without dim, since the dim line measures 3.95:1 on white, below 4.5:1; the urgency colours measure 4.71 to 10.88 across both themes (`TEXT_CONTRAST`, `renderFooter`; `hooks/look.ts`, `hooks/pane.tsx`).

### Tests

- The race suites keep the state folder in memory: `stubHost` in `tests/race.test.ts` and the folder map in `tests/panel-race.test.ts` store every write, and `draft.json` and `cleared.json` are written the way production writes them (`$.fs.write`, no atomic rename).
- Six new race cases: a draft stamped past the skew, a failing listing, a torn delivery marker, overlapping polls, 200 open questions, and a no-space write of `draft.json` (`tests/race.test.ts`).

### Docs

- The Bash guard, a deterrent and not a token, is the barrier that keeps the agent from answering its own question, and the token layer covers the panel path only (M54; `plugins/askaway/SPEC.md`).
- The sentence and line limits in the question playbook are guidance; the CLI checks size, minimum words and the two-sentence minimum of `what` (M59; `plugins/askaway/SPEC.md`, `plugins/askaway/skills/askaway-question-playbook/SKILL.md`).
- The pt-BR lead line of the panel is "Na opção <key> desde <HH:MM>", the code's phrase (M62; `card.lead.agent`, `hooks/i18n.ts`; `plugins/askaway/SPEC.md`).
- A high-risk question filed without a session holds no session's pause, and the agent stops on its own on a `pause` reply (M67; `_holding_question`; `plugins/askaway/SPEC.md`, `plugins/askaway/skills/askaway-question-playbook/SKILL.md`).
- The SPEC and the question playbook document the `ask` reply with `title`, the high-risk `pause` with an OS error, `fit: null`, the per-command help, `--table`, `prune --id --force` and the language re-registration.

## [0.4.0-beta.29] - 2026-10-20

Gauntlet round 4 on 2026-10-20 (40 personas): 75 raw findings, 69 after merging, 48 adopted, 2 skipped, 20 owner questions filed in Askaway, all replied on the same day (their changes ship as beta.30). Plugin tests: 357 pass; pytest: 625 passed; `biome lint` clean. The race-test stubs item (M36) went to the owner as a twentieth question; the shared delivery-line fixture shipped. Review: code-inspect-reviewer on Sonnet high, 0 must, 7 should fixed, 9 nits (6 fixed, 3 left: `SENTENCE_END` after `etc?`, a poll with no timeout, `damaged_question_session` still using `read_text`).

### Fixed

- `read_json`, `load_questions` and `answered_ids` read only regular files, opened with `O_NOFOLLOW|O_NONBLOCK` and checked with `S_ISREG` (`_regular_bytes`, `_is_regular`; `scripts/askaway.py`).
- The Bash guard denies `mkfifo`, `mknod` and `mkdir` toward the state folder (`WRITE_COMMANDS`), and the pause guard denies a call on an internal error instead of passing it (`_pause_decision`, `hook_pause_guard`).
- `ask` refuses a text that does not encode as UTF-8, so a lone surrogate no longer breaks the CSV export (`_read_text`).
- `what` counts `e.g.`, `i.e.`, `etc.`, `vs.` and `cf.` as non-terminal, and `2.0` still does not break a sentence (`SENTENCE_END`, `_sentence_count`).
- A non-object option is a gap, and validation goes on, so one error names every gap (`_options`).
- A deeply nested entry is refiled instead of crashing, and a deep transcript line is skipped (`_entry_json`, `_title_rows`).
- Concurrent identical asks from one session file one question: the duplicate check and the write run under `.ask.lock` (`_ask_lock`, `cmd_ask`).
- A closed stdin reads as an empty entry, and the refile names the missing entry (`_entry_json`).
- A repeated JSON key refiles the entry instead of keeping the last value (`_unique_keys`, `_entry_json`).
- `prune` removes only regular files whose bytes read; a file that does not parse or does not match its id is a damaged question and is removed as such. OS errors and folders are skipped, and the daily stamp moves anyway (`_remove_item`, `cmd_prune`, `_maybe_prune`).
- `prune --id` on a question file that exists but does not read gives the damaged-question message (`_prune_damaged_id`, `cmd_prune_id`).
- The state-folder guard protects the default folder even when HOME is under `/tmp` (`_state_roots`, `TMP_ROOT`).
- Control characters become spaces in one-line texts, and body texts keep only their line breaks (`_clean_text`, `_read_text`, `_one_line`; `scripts/askaway.py`).
- The untitled question label is cut by code points, so an emoji is not split (`questionLabel`, `clipText`; `hooks/model.ts`).
- The footer names an Other answer by its letter, or "Other" / "Outra" when the question is gone (`lastAnswerText`, `otherKeyOf`; `hooks/model.ts`).
- The footer and the toast draw the question's label on one line (`singleLine`, `questionLabel`; `hooks/model.ts`, `hooks/register.tsx`).
- A pick made while a poll applies the draft is kept (`keepChangedSince`; `hooks/register.tsx`).
- The delivery marker is written atomically, and a torn marker counts as absent (`writeAtomic`, `parseJsonText`, `_marked`; `hooks/register.tsx`, `scripts/askaway.py`).
- `away.json` is written through a temp file, and a failed read keeps the last away state (`readAway`, `writeAtomic`; `hooks/register.tsx`).
- A failed folder listing keeps the previous board instead of emptying it (`readCached`, `jsonIds`; `hooks/register.tsx`).
- An interval poll does not start while one runs (`polling`; `hooks/register.tsx`).
- A non-ask command returns the OS error text, `<strerror>: <path>`, instead of `internal error` (`_os_error_text`, `main`; `scripts/askaway.py`).
- An unknown `/askaway` verb replies with the usage line of the four verbs (`command.verbsHelp`; `hooks/register.tsx`, `hooks/i18n.ts`).
- The panel token file is created at mode 600 before it is written (`mintPanelToken`; `hooks/register.tsx`).
- A refused Dismiss on an ended card shows `toast.dismissFailed` (`dismissEndedOrSay`; `hooks/register.tsx`, `hooks/i18n.ts`).
- Correction to beta.26: `prune` now keeps an item (question, answer and marker) when one of its files cannot be read at the OS level or is not a regular file; the beta.26 entry did not say so (`_remove_item`).
- `_literal` writes a lone surrogate in an Other text as `\udXXX`, as `JSON.stringify` does, so the Python and TypeScript delivery lines match (`scripts/askaway.py`).
- The Other text is capped at 500 code points with no ellipsis on both sides, in storage and in the delivery line (`other_text`; `scripts/askaway.py`).

- The Bash guard denies `chmod`, `chown`, `chgrp`, `setfacl` and `chattr` toward the state folder (`WRITE_COMMANDS`): a mode change can make a question unreadable and so free its pause.
- An inbox call's heredoc body is JSON data, so the Bash guard does not read it as code: an `ask` whose text names the reply helper or the state folder is no longer denied. The lines outside the body are still read, and the body of any other heredoc is still code (`_heredoc_code`, `_ShellScan`; `scripts/askaway.py`).
- The pause guard's tamper check fails open on its own error, such as a deleted working directory, which denied every tool call; a failing pause lookup still denies (`_tamper_denial`, `hook_pause_guard`).
- The deliver fast path counts a non-empty regular marker without parsing it; the slow path still reads it and treats an empty or torn one as absent (`_marked`, `item_status`).
- `writeAtomic` writes a dot-prefixed temp `.<name>.<random>.tmp` beside the target and moves it with `mv -fT`, so two windows writing one target no longer collide and a folder at the target fails instead of swallowing the temp; the CLI's stale-temp prune covers that name (`writeAtomic`, `randomHex`; `hooks/register.tsx`).
- The panel token file is made with `install -m 600 /dev/null`, written, then `chmod 600`, and a failed install or chmod mints no token (`mintPanelToken`; `hooks/register.tsx`).
- `question_status` skips a symlink, FIFO or folder in `q/` as `load_questions` does, so it reports an unknown id (`question_status`).

### Changed

- `export --format csv` has an `id` column, last, filled on every row; a damaged question's row fills only that cell (`CSV_COLUMNS`, `_csv_cells`; `scripts/askaway.py`).
- `prune` sweeps answer and marker files whose question is gone (`_remove_orphans`, `cmd_prune`).
- `export` gives one row per damaged question, with null fields and `"damaged": true` (`cmd_export`).
- The picked option carries "✓ " before its label (`renderOption`; `hooks/pane.tsx`).
- `/askaway lang` names the language (`LANG_NAMES`; `hooks/register.tsx`).
- `ASKAWAY_PROJECTS` overrides the projects root (`PROJECTS_ENV`, `projects_root`; `scripts/askaway.py`).
- The Urgency title carries the grade word when `urgency_level` is set (`renderUrgency`; `hooks/pane.tsx`, `urgency.grade.*` in `hooks/i18n.ts`).
- Six unused i18n entries and `langName` are removed; `footer.otherKey` and `urgency.grade.*` are added (`hooks/i18n.ts`).

### Tests

- A round of three where the second reply fails keeps its pick, and a second Submit all writes the one left (`tests/askaway.test.ts`).
- A poll drops a draft pick for a question already replied (`tests/askaway.test.ts`).
- Each refile case pins its expected message (`scripts/tests/test_askaway.py`).
- One shared fixture, `tests/delivery-lines.ts` (17 cases), is read by both suites, so a drift between `_delivery_line` and `deliveryLine` fails a test on each side (`scripts/tests/test_askaway.py`, `tests/askaway.test.ts`).

### Docs

- The `${CLAUDE_PLUGIN_ROOT}` note says where to find the plugin folder (`claude plugin list`); the AI-install example's steps 7 and 8 use text the validator accepts, and step 8 runs in its own folder (`README.md`, `README.pt-BR.md`).
- A Security section links the new `SECURITY.md` from both READMEs (`SECURITY.md`, `README.md`, `README.pt-BR.md`).
- The question playbook shows a quoted heredoc (`<<'JSON'`) for text with an apostrophe, and draws backtick names in bold (`skills/askaway-question-playbook/SKILL.md`).
- SPEC: the wait sentence on the delivery marker (`cmd_wait`), the "Clear all button" typo, and `LOGO_GLYPH` in `hooks/logo.ts`, drawn by `hooks/logo-element.tsx` (`SPEC.md`).
- The CONTRIBUTING file map lists the hooks files it missed (`CONTRIBUTING.md`).
- The beta.27 entry: the reply counts are 13 / 10 / 5 / 2, and the `cleared.json` line matches the SPEC (`CHANGELOG.md`).

## [0.4.0-beta.28] - 2026-10-20

Reported by the owner on the Desktop light theme after the third gauntlet round: the details block drew a dark fill with grey text, unreadable.

### Fixed

- The "Askaway Details:" block no longer picks its fill from the theme row. The plugin mapped the engine's theme row to a family and painted a hex per family: with no theme row (the engine's default, `auto`, which the Desktop resolves to its system theme) it chose the dark family, so the block was unreadable on a light Desktop; under an explicit `auto` row it drew no fill at all, and now draws the theme's own. The block now carries `backgroundColor="userMessageBackground"`, the engine's own theme key for the user's message surface, defined in every built-in theme and resolved by the engine for the effective theme. `DETAILS_FILL` is now the constant `'userMessageBackground'`; `themeFamilyOf`, the family table and the `askaway.theme` atom with its `config.set` watch are removed (`hooks/look.ts`, `hooks/register.tsx`).

## [0.4.0-beta.27] - 2026-10-19

Owner's replies to the 30 questions of the third gauntlet round: 13 keep the current behaviour, 10 change code, 5 change only the docs, 2 recorded as engine limits. Two could not be done inside the engine (an accessible name for the Other field, recording the Other text on a window switch) and are recorded as limits; the tree rows stay links without hotkeys, by the owner's choice.

### Changed

- A delivered History line stays until Clear all; the 30 s fade is gone (`historyOf` in `hooks/model.ts`).
- A row's Submit keeps the card on the question on screen; Submit all still returns to the first (`clearPicks`, `submitOne` in `hooks/register.tsx`).
- The footer's not-yet-read and expired counts leave out the rows Clear all hid (`footerText`).
- The lead line adds the date when the question was asked on an earlier day, "On B since 17/10 14:05" (`leadOf`; `hooks/i18n.ts`).
- On the terminal, family and session labels in the History are plain text (links stay on the Desktop) and the nav labels carry their letters, "← Back (z)", "Next → (x)", "Submit all (N) (w)" (`hooks/pane.tsx`).
- Dismiss on an ended card reads "Dismiss (removes)" / "Dispensar (remove)".
- The delivery line quotes `who`, the title and each option label as JSON strings on both surfaces, so a quote or a newline inside them cannot break the line (`_literal` in `scripts/askaway.py`; `deliveryLine` in `hooks/model.ts`).
- `wait` on a question filed with `run_kind` `subagent` prints the reply line and leaves the delivery marker to the main session's deliver hook, so the main session also gets the line (`cmd_wait`).
- An id in `cleared.json` whose reply file prune removed is dropped from the session's list at the next poll; the next Clear all removes it from cleared.json (`applyCleared`).
- SPEC.md: the card never folds (the per-option lines and the details block are always drawn); Clear all is one-way from the pane and touches no q/, a/ or d/ file; a new Security section records that the CLI trusts `CLAUDE_CODE_SESSION_ID` from the environment.

### Removed

- The `deliveredAt` atom and the `recordDeliveries`/`shownAt` plumbing, which only served the 30 s fade.

## [0.4.0-beta.26] - 2026-10-19

Third gauntlet round (40 personas over betas 14 to 25): 150 findings, 64 adopted as bugs or real value, 17 skipped, 2 decision changes refused, 30 owner questions recorded.

### Fixed

- Shared picks: a `draft.json` that exists but does not read is left alone instead of overwritten; a pick whose write failed is kept and retried at the next poll, with one toast (`toast.pickNotSaved`); a draft stamped more than a minute ahead of the clock is ignored; each write stamps `ts` at least one past the last draft seen, so a stepped-back clock still wins; Submit applies the latest draft first; the ids a Submit settled are not re-applied from a stale draft (`saveDraft`, `applyDraft`, `changeWizard` in `hooks/register.tsx`; `keepOpen` exported from `hooks/wizard.ts`).
- Clear all writes `cleared.json` before the store and the atom, so a failed write keeps the other sessions in step; a Clear all that hides pending lines says so (`toast.clearedPending`).
- A reply the CLI refused or failed no longer fades silently: the pane toasts `toast.replyFailed` or `toast.replyHeld` (with the key holding the slot) and Submit all goes on to the next question.
- `list --open` runs only when the bound session ids change or every 30 s, and a click forces it; the ids settled by a Submit are dropped from the tree at once.
- Clock steps back: a reply stamped after now is handed at once (`promptsDue`), a delivered History line whose shown time lies ahead is dropped (`historyOf`), and the CLI's re-check and prune stamps count a future mtime as due (`_stamp_due`).
- Dismiss passes `--strict` to `prune --id`, so a refusal exits 1; `prune --id` removes an open question with no session; `prune` removes a reply file that does not read, with its question and delivery files.
- A question file nested past the recursion limit, or whose id or ts does not match its entry, reads as `damaged` in `list` and `status`; a reply on such a file says it is damaged; a held question with no title is named by its id and still pauses; a duplicate of a paused question returns `action "pause"`.
- Other text: control characters become spaces, the ellipsis counts inside the 500 code-point cap, and Unicode format characters are removed from titles, option labels, Desktop titles and the one-line text (`model.ts` `singleLine`; `askaway.py` `_read_text`, `_one_line`).
- `-h`/`--help` prints one JSON line with the command names; an entry that is not valid JSON or an empty stdin says how to fix it; a `fit` that is not an integer 0 to 100 is refused with that reason; a blank `urgency_level` counts as absent; a Desktop id without the `local_` prefix is stored as null; a fork whose parent record is missing is its own family; a second shell reply returns the stored key with `by` and `who`.
- Pane: the counter, the tree marks, the footer (no "Nothing waiting" line; empty parts hidden), the age word ("just now" / "há instantes"), the delivered note, the history quote cap and the away hint were corrected (`hooks/pane.tsx`, `hooks/model.ts`, `hooks/i18n.ts`, `hooks/logo-element.tsx`); with no state folder the footer shows that away mode is unavailable.

### Changed

- SPEC.md, the READMEs and the question playbook skill follow the code again: shared files in the data-folder tree, dim lead line, hotkeys off while the Other field has focus, the Other text recorded on Enter, focus loss and Submit all, `wait --timeout`, `--strict`, absolute CLI path outside Claude Code, the subagent `run_kind`, the paused-duplicate reply and the `placeholder` warning.

## [0.4.0-beta.25] - 2026-10-19

### Fixed

- Clear all is shared by every session of the state folder through `cleared.json`: the History rows one session clears leave the others at their next poll (5 s), and a session opened later hides them at its first poll. The store key `cleared` stays as the start seed (`clearHistory` and `applyCleared` in `hooks/register.tsx`; `parseCleared` in `hooks/model.ts`).

## [0.4.0-beta.24] - 2026-10-18

### Fixed

- The wizard's picks are shared by every session of the state folder through `draft.json`: a pick made in one session shows in the others at their next poll (5 s), and a session opened later shows the picks already made. Each change writes the picks with a `ts`, and the newest one wins (`changeWizard`, `saveDraft` and `applyDraft` in `hooks/register.tsx`; `parseDraft` in `hooks/model.ts`).

## [0.4.0-beta.23] - 2026-10-18

### Changed

- The History heading carries its own icon, a clock with an arrow turning back (`historySvg` in `hooks/logo.ts`, "⟲" on the terminal), instead of the Askaway logo (`renderHistoryIcon` in `hooks/logo-element.tsx`).
- In the History tree the family label and each derived session row are Markdown links to their Desktop sessions, which the Desktop opens itself (`sessionLink` in `hooks/pane.tsx`; `HistoryGroup.href`, `HistorySession.href` in `hooks/model.ts`).
- Clear history became **Clear all (N)** ("Limpar tudo (N)"): it removes every History row shown, pending ones included; the answer file stays, so the session still reads it (`clearableIdsOf`, `historyOf` in `hooks/model.ts`; `HistoryEntry.clearable` removed).

### Fixed

- A History record filed before `desktop_session` existed counts as its family's root when its session title is its family title, so old answers no longer repeat the title either (`isRootSession` in `hooks/model.ts`).

## [0.4.0-beta.22] - 2026-10-18

### Fixed

- The root session's rows now really sit under the family title: beta.21 compared the record's `session` (the CLI uuid) with `family` (a Desktop `local_<uuid>`), which never match, so the title was still drawn twice. The root check compares `desktop_session` with `family` (`isRootSession` in `hooks/model.ts`; `HistorySession.isRoot`). A question filed before `desktop_session` existed (beta.19 or older) keeps its session row.

## [0.4.0-beta.21] - 2026-10-18

### Changed

- The root session of a family draws no session row: its questions sit right under the family's title, before the derived sessions (`├`/`└`), so the title is never drawn twice (`renderBranch`, `renderRootRows` in `hooks/pane.tsx`). The same holds for the History tree.
- The History block is drawn as the open tree is: a heading row with the logo and "History", a blank line, then the tree (`renderHistory` in `hooks/pane.tsx`).
- A History row is one line, shaped as a picked row of the open tree: `○ <title> ✓ - <answer line>`; the dim line under the title is gone. Where the question is known with a `desktop_session`, the title is a Markdown link to that session, which the Desktop opens itself (`renderHistoryEntry` in `hooks/pane.tsx`; `HistoryEntry.session` in `hooks/model.ts`).
- A pending History line ends at its sent time: "waiting to be read" ("aguardando leitura") is gone, and the line only grows once the session answers back (`lineStateOf` in `hooks/model.ts`; `history.waiting` removed from `hooks/i18n.ts`).
- The card's session link reads "See session ↗" ("Ver sessão ↗"): the Desktop draws no underline on a link, so the arrow marks it (`card.session` in `hooks/i18n.ts`).

## [0.4.0-beta.20] - 2026-10-18

### Added

- `ask` records `desktop_session`, the Claude Desktop sessionId (`local_<uuid>`) of the asking session, next to `family` (`scripts/askaway.py`).
- The card's title row is one Markdown heading, "### <title> - See session - <risk> · <age>": the title a size up from the body, and "See session" a link to the asking session's Desktop window (`#<desktop_session>`), in the surface's link look; left out when the question has no Desktop session (`renderTitleRow` in `hooks/pane.tsx`, `card.session` in `hooks/i18n.ts`).

## [0.4.0-beta.19] - 2026-10-18

### Changed

- A History row is drawn as a row of the open tree: "○ <title>" in plain text, with no ⏳, ✓ or ⚠️ mark and no accent colour; the dim line under it alone says where the answer stands (`HistoryEntry`, `lineStateOf` in `hooks/model.ts`; `renderHistoryEntry` in `hooks/pane.tsx`).

## [0.4.0-beta.18] - 2026-10-18

### Changed

- A question row of the tree carries one mark: ● for the question on screen, ○ for the others; the dim link mark `▪` no longer joins it (`renderTreeQuestion`, `treeLink` in `hooks/pane.tsx`). Submit and Other links keep the `▪`.
- Clear history is a secondary Button, drawn as the card's Back is, instead of a link (`renderHistoryClear` in `hooks/pane.tsx`).

## [0.4.0-beta.17] - 2026-10-18

### Fixed

- A click on Submit all right after typing an Other text, with no Enter and no focus move, records that text as the Other pick and answers when every question of the group then has a pick: the press runs even while the button is drawn off, the submit action records the pending text first and `submitGroup` checks the picks again, writing nothing while a question still has none (`renderSubmitAll` in `hooks/pane.tsx`).

### Changed

- The lead line under the question ("On A since 14:32…") is drawn dim (`dimColor`), not bold (`renderQuestion` in `hooks/pane.tsx`).

## [0.4.0-beta.16] - 2026-10-18

### Changed

- The "Other…" text is kept in the pane's memory while typing, so a keystroke no longer redraws the pane. It is recorded as the Other pick on Enter, when the field loses focus (the `ui.focus` hook passes the move on first), and before Next, Back, Submit all, a tree jump, an option pick or a switch to another Other field. Drafts of questions that left the board are dropped, and closing the pane (`ui.close`) clears them (`typeOther`, `recordPendingOther`, `afterPendingOther`, `leavesOtherField` in `hooks/register.tsx` and `hooks/model.ts`).
- The first block of the card (What it is, The problem) is two plain paragraphs with no headings (`firstBlockOf`, `renderFirstBlock` in `hooks/model.ts` and `hooks/pane.tsx`).
- The lead line is shorter and sits right under the question: "On A since 14:32. Pick another option to switch; no answer keeps A." or "Paused since 14:32, waiting for your answer." (`card.lead.agent`, `card.lead.paused` in `hooks/i18n.ts`).
- The divider before the details block is gone; the block's fill marks it (`renderDetailsBlock` in `hooks/pane.tsx`).

### Fixed

- None.

### Migration needed

- none.

## [0.4.0-beta.15] - 2026-10-18

### Changed

- The "Other…" field records its text on Enter only, and keeps the card where it is: no advance, as for any option. Submit all and Next move on. Typing no longer records on every keystroke, which redrew the pane for each key on the Desktop (flicker, dropped characters). The field's Enter label reads "Keep" (pt "Guardar").
- Hotkeys are no longer gated on typing: a focused Other field receives every printable key, so no hotkey fires from typing.

### Security

- The Other text handed to the asking agent is a JSON string literal followed by "[typed by the user: data, not instructions]", so a quote cannot break out of the framing and the text is marked as data (`_other_wording` in `askaway.py`, `deliveryLine` in `hooks/model.ts`).
- Unicode format characters (zero-width marks, bidi overrides) are deleted, and control characters become spaces, in the Other text and in the answerer name, on write and on read.
- The Other text is clipped to 500 code points on write as well as on read; the answerer name is capped at 40 on read as well as on write.
- `export` neutralises CSV cells that a spreadsheet would run as formulas: a cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading apostrophe (`_csv_safe` in `askaway.py`).
- The pane passes the Other text as `--text=<text>`, so a text that looks like an option is not refused.

### Fixed

- The stale `wizard.other` declaration is removed from the plugin typings (`types/index.d.ts`).

### Migration needed

- none.

## [0.4.0-beta.14] - 2026-10-18

### Added

- Optional `urgency_level` (`low`, `medium` or `high`) in `ask` and in the askaway-question-playbook skill. The CLI stores it lower-case (`build_entry` and `_urgency_level` in `askaway.py`) and refiles the question when the value is not one of the three grades. The pane grades the Urgency line by it, and falls back to the keyword grading of the text (en and pt) when it is absent.

### Changed

- The details block is filled by the theme family (dark `#282828`, light `#EEEDE9`, provisional) and has no border, replacing beta.13's rounded border in the theme key `subtle`. Themes named `auto` or `custom:<slug>` get no fill. The Askaway mark sits inside the block's title.
- The Other option is drawn as the next letter (`C · Other…`, hotkey `c`), with no echo of the typed text and no "Your answer" label. Its input row is prefixed `└ `.
- Urgency sits right under the title row, coloured by its grade with the theme keys `success`, `warning` and `error`.
- Tree rows and "Submit Answer" are native Markdown links (`file:///askaway/jump/<id>`, `file:///askaway/submit/<id>`) marked `▪`, with escaped titles. An underlined button stands in where Markdown is absent.
- The flat status lines became a History tree grouped by session family, then session, then question. Each answer row shows its mark (`⏳`, `✓`, `⚠️`) and a line such as "Answer A · sent 14:32 · delivered 14:33 (read by the session)" in local time ("17/10 14:32" on another day). Other answers are quoted, and "answered by agent/<name>" appears only when the answerer is not the user. Delivered rows still hide after 30 s.
- A "▪ Clear history (N)" link at the bottom of the pane (`file:///askaway/clear`) removes the delivered, ended and expired rows and replaces the per-line ✕ dismiss. The cleared ids are pruned to the answers still on the board.
- The delivery record carries the marker's `ts`.

### Fixed

- The urgency keyword fallback no longer grades "multimedia" as medium.
- A delivered row without a time no longer leaves a dangling separator.

### Migration needed

- none.

## [0.4.0-beta.13] - 2026-10-18

### Added

- `ask` stores `family` and `family_title` from the Claude Desktop session files (`~/.config/Claude/claude-code-sessions`, or the folder named by `ASKAWAY_DESKTOP_SESSIONS`), and prefers the Desktop window title for `session_title`. The lookup reads regular files only (no symlinks or FIFOs), at most 2 MB each and 2000 files per lookup, strips control characters from titles, and walks fork and spawn links up to 8 hops with a cycle guard (`askaway.py`, SPEC.md).

### Changed

- The details are always shown: the Details / Hide details link and the `e` hotkey are gone. The card is the lead, What it is and The problem, a divider, then an "Askaway Details:" block (rounded border in the theme key `subtle`, the Askaway mark in its title) holding Analogy, Why, Undo, How, What we gain, What we lose and Context and origin; then the question, Urgency and the options. Section titles are bold.
- The per-answer tree button reads "Submit Answer" ("Enviar resposta").
- The tree groups questions by the Claude Desktop session family, named by the root session's title, instead of the folder the ask command ran in. Questions filed before the family field existed keep the folder grouping.

### Fixed

- None.

### Migration needed

- none.

## [0.4.0-beta.12] - 2026-10-18

### Added

- Other field always open: the "Other…" link focuses the field under it, typing records Other as you type, and Enter records it and moves on. The hotkeys stay off while the field holds text.

### Changed

- The Details link opens Why, Undo, How, What we gain, What we lose and Context right after Analogy, in the box above the question, instead of under the options.
- A question with a pick shows `✓ - Submit` in the tree; that Submit sends only its answer and removes the row. Submit all still sends the other picks.
- Status rows ("Answer A sent to …") have no filled background: plain dim text, with only the mark (⏳, ✓ or ⚠️) in the accent colour. The explanation box has no grey background.

### Migration needed

- none.

## [0.4.0-beta.11] - 2026-10-18

### Added

- Ended-session card: an open question whose asking session has ended shows "The session that asked has ended; the agent stayed on <key>." instead of the options, with Back, Dismiss and Next. `list` rows carry `ended: true` for it and `prune --id <id>` removes the question; no answer can be sent (`askaway.py`, pane).
- Panel credential: `answer --by panel`, `accept_all` and `accept_recommended` need a one-shot token that the panel mints in a mode-600 file under `panel-tokens/` and passes in `ASKAWAY_PANEL_TOKEN`; the CLI spends it. A second layer behind the Bash guard, not isolation (SPEC.md "Panel credential").
- The panel asks once for the answerer's name (Save or Skip), keeps it in the plugin store and passes it as `ASKAWAY_WHO`; `/askaway who <name>` edits it. The name is declared, not verified (README).
- `/askaway quiet on|off`: no toast per new question and no fade after an answer. Off by default.

### Migration needed

- A script or agent that answered with `--by panel`, `accept_all` or `accept_recommended` from a shell now gets `{"error": ...}`; use the panel, or `--by cli` from the asking session.

## [0.4.0-beta.10] - 2026-10-18

### Added

- A `cli` answer from the question's own session is stamped `by: "agent"`, not `cli`. `status`, `wait` and `export` show the stamp. The stamp is never typed: `answer --by agent` is a usage error (`plugins/askaway/scripts/askaway.py`).
- The delivery line names who answered, in five wordings: "Answered via panel by <who>", "Answered by <who> (cli)", "Answered by the agent itself", "Accepted all" and "Accepted the recommended option" (`askaway.py` and `hooks/model.ts`).
- `wait` returns `line`, the delivery line, when its call writes the delivery marker; `status` and `wait` carry `by` when the answer has one.

### Changed

- The card keeps What it is, The problem, Analogy, the question, Urgency, and each option's What happens, Pros and Cons drawn at once. `e` (`e · details`) folds only Why, Undo, How, What we gain, What we lose and Context and origin (pane changes).
- The details toggle sits right under the lead line as underlined link text ("Details" / "Hide details", hotkey `e`), no button chrome; the desktop still draws its native button around it (pane changes).
- Each question row in the tree is pressable and jumps to that question's card; project names stay text (`hooks/wizard.ts` jumpTo).
- The Bash guard judges inline code line by line: a state-folder write needs the folder and a write verb on the same line, and an answer in code needs the askaway module or script named, so a heredoc that edits a document is no longer denied (`askaway.py`).
- The lead line says what the agent does while it waits: "Working on <key> since <time> while it waits for you. Your answer still counts: pick another option and it switches; with no answer it stays on <key>.", or "Paused since <time>: it waits for your answer before going on." for a `high` risk question.

### Migration needed

- none; answers may now carry by "agent".

## [0.4.0-beta.9] - 2026-10-18

### Added

- Each card opens folded: `e` (`e · details`) opens and closes the long sections (What it is, The problem, Analogy, Why to Context, and each option's What happens, Pros and Cons). The state is kept per question while the plugin is loaded (pane changes).
- `askaway.py wait <id> --strict` exits 0 when the question is answered, 2 on timeout and 1 on an error. A Codex run waits this way, since no hook holds it.
- `export --format csv` writes the columns `asked_at`, `project`, `title`, `recommended`, `answered_key`, `label`, `who`, `by`, `answered_at` and `delivered`.
- Statuses `damaged` (the question file does not read as a JSON object) and `damaged answer` (the answer file does not read, so its key is unknown). A damaged question keeps its high-risk pause; a damaged answer ends it.
- A repeated `ask` for an open question (same session, same question) returns the id of the open one.
- Docs: From Codex, One machine, one login, Pin and roll back, Remove your data, the card fold and the dictation note.

### Changed

- `risk` is required on `ask`, with no default: a missing `risk` is refiled.
- On the desktop, Back, Next and Submit all take `p`, `f` and `w` (was `p`, `f` and `e`), and `e` opens the card's details. The terminal keeps `z`, `x` and `w`.
- A Bash call that runs `askaway.py answer` is denied by the `pause-guard` hook in every session; the user answers in the panel.
- The Bash guard reads each command word by word (quotes, `;`, `&&`, `||`, `|`, subshells, `sh -c`, `eval`, `$(...)`), and also guards Write, Edit and NotebookEdit. It is a deterrent, not a guarantee (SPEC.md).
- A damaged `a/` file keeps a high-risk pause until an `answer` overwrites it; `prune` clears a damaged `q/` file with its companions. A `wait` from another session no longer writes the delivery marker.
- `~`, `$HOME` and `${HOME}` before the installed script path count as the inbox call during a pause.
- The AI install spec checks for Python 3.12 or newer (it accepted 3.10).
- The README opens with what the user sees, moves the away triggers to the terms table, and labels `fit` as the agent's estimate.

### Fixed

- The footer counts follow the clock: the 24 h window and the 7-day TTL move them without a status line change.

### Migration needed

- yes: callers of `ask` must send `risk`, which has no default. On the desktop, `e` opens the details, and Back, Next and Submit all are `p`, `f` and `w`. Answers come from the panel or from the session that asked, since a Bash call cannot run `askaway.py answer`.
- yes: long fields are refused as `too long (n/limit)`, not cut; a usage error (unknown command, bad id or key) exits 1 even without `--strict`; `wait` on an unknown id exits 1.
- yes: the state folder gains `foreign_check`, an empty stamp file whose mtime is the last re-check of unread answers of other sessions (created on first use). Delete it freely; it is recreated.

## [0.4.0-beta.8] - 2026-10-18

### Added

- Every card carries `what` ("What it is", at least two sentences) and `problem` ("The problem"), and every option carries `does`, `pros` and `cons` ("What happens", "Pros", "Cons"). `ask` refiles an entry that lacks any of them (33e5c0d, b86bb43).
- The card reads: title, lead line, What it is and The problem, Analogy, the question, Urgency, the options, Why, Undo, How, What we gain, What we lose, and Context last (b86bb43).
- `answer <id> <key> --text <text>` records the free text of the `other` key (521f5f2).
- The panel answers through the CLI (`answer --by panel --strict`). The CLI is the one writer of `a/`, and the first answer wins across processes (6bcda4c).
- The skill is renamed to `askaway-question-playbook`, so the plugin skill is `askaway:askaway-question-playbook`. The slash command stays `/askaway`.

### Changed

- Option keys must be consecutive uppercase letters starting at A (`A`, `B`, `C`…). An entry with other keys is refiled (58002f7).
- On the terminal, Back, Next and Submit all moved from `b`, `n`, `s` to `z`, `x`, `w`, because options B, N and S would clash with them. The desktop keeps `p`, `f`, `e`; when an option uses one of those letters, the next free letters of the pool are used (e0e00a4).

### Fixed

- Each option button shows its key letter and takes it as its hotkey (e0e00a4).
- Panel answers no longer write `a/` themselves, so first-writer-wins holds across processes (6bcda4c).

### Migration needed

- yes: callers of `ask` must send `what`, `problem`, and each option's `does`, `pros` and `cons`, and use option keys `A`, `B`, `C` in order. Questions filed before beta.8 load unchanged; readers treat a missing key as null.
- Replace any reference to `skills/file-question` or `askaway:file-question` with `skills/askaway-question-playbook` or `askaway:askaway-question-playbook`.

## [0.4.0-beta.7] - 2026-10-17

### Security

- The ask-guard skeleton quotes its JSON with `shlex.quote`, so option text cannot run `$(...)` in the shell (e77f4c5).
- Answers record their session. A `cli` answer from another session is refused and claims nothing (e77f4c5).
- Delivery lines are flattened to one line, so a title cannot forge a "The user answered" line (e77f4c5).
- A high-risk question keeps the agent paused until its answer is delivered or it expires; prune counts from delivery (e77f4c5).
- The pause guard covers `Agent` and `mcp__.*` writes, with an allowance for read-only tools (e77f4c5).
- A high-risk question that hits an internal error pauses the agent (e77f4c5).

### Added

- `askaway.py wait <id> [--timeout 300]` polls the answer folder until the answer exists or the timeout ends (9b89c35).
- `--strict` on `ask`, `answer` and `status`: a refile, an error or a usage error exits 1 instead of 0 (9b89c35).
- `list --answered --since <when>` lists the answered questions, and `export [--since <when>] [--format json|jsonl|csv]` writes every question with its answer (9b89c35).
- `ASKAWAY_PRUNE_DAYS` sets the retention window in whole days; the default stays 30 (e43abe0). The pause guard lets `wait` and `export` through, as it does `ask`, `status` and `list` (e43abe0).
- Answers record `who`: `ASKAWAY_WHO`, else the OS user name, else "unknown" (32f5a6e). Panel answers record it too (2552e2b).
- The pane footer shows the counts and the last answer when no question is open, and is absent while one is open (17ebade). An answer unread after its 7-day TTL reads as `expired`, not as delivered (17ebade).
- Race tests: 20 concurrent `answer` processes, and 20 concurrent Submit all presses, each leave exactly one written answer. A CI workflow runs the Python suite and the mod suite on every push and pull request (dd99be3).

### Changed

- The CLI checks for Python 3.12 before any other statement and prints an error line on an older Python (e77f4c5).
- `deliver` scans the project folders once per run, not once per question (e77f4c5).
- The pane draws the lead line under the card title, and urgency before undo (5657f11).
- On the desktop, Back, Next and Submit take the letters p, f and e; the terminal keeps b, n and s (9554668). Beta.8 changes the terminal letters.
- The accent colour is no longer used for text. The accent is `#3566C8`: 5.40:1 on `#FFFFFF` and 3.28:1 on `#111827`, where `#1E40AF` measured 8.72:1 and 2.03:1 (0a01eb5).
- The plugin uses the approved KeepGlide brand icon (cef3351).

### Documentation

- SPEC.md states the pause rule, the answer sources, what is read and written (6b55ec2), and the expired status and answer session (e77f4c5).
- The README defines the terms used on the page, and its hero shows the pane on the light and dark themes (40925d1).

## [0.4.0-beta.6] - 2026-10-17

### Added

- The pane draws each option's fit after its tradeoff, in a gray explanation box (640d07e).

### Changed

- The README describes the away flow and what each card carries, matches every claim to the plugin, and adds a screenshot (150ad49, 6020300).
- SPEC.md records the 0.4.0-beta.5 live check of the pane layout (0f43a9f).
