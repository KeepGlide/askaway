# Changelog

All notable changes to Askaway are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version in
`plugins/askaway/.claude-plugin/plugin.json` is 0.4.0-beta.43, set by the beta.43 release commit.
Commit hashes name the change in `git log`.

## [Unreleased]

### Fixed
- The Bash guard's scanner scans each shell's own heredocs and here-strings in the directory that shell runs in, so `bash <<< 'true'; cd` into the state folder, then a second `bash <<<` that writes there, is denied by the scanner alone (gauntlet 1, rule1-1).
- The Bash guard's scanner reads a heredoc or here-string held by a substitution again for each directory an `eval` or `-c` script runs it in, so the same `eval "$x"` after a `cd` into the state folder is denied. Each read of a stdin or substitution text costs its length plus `FED_READ_COST`, and a line whose reads pass `FED_SCAN_LIMIT` (64 KiB) is denied as unreadable, so a dense 61 KB line scans in about 0.3 s instead of up to 7 s (gauntlet 1, rule1-2).
- The Bash guard's scanner reads the text that `echo` or `printf` pipes into a shell, with the `printf` format applied as bash applies it and `$'...'` words decoded, and a here-string that is one variable, set earlier on the same line by an assignment, `export`, `declare`, `typeset` or `readonly` (an assignment inside `( ... )` ends with the subshell). So `printf '%s %s %s' python3 <askaway.py> answer | bash`, `echo $'\x70ython3 ...' | bash` and `x=ok; export x='<answer line>'; bash <<< "$x"` are denied by the scanner alone and by the full guard; all were allowed before. A `sh -c` script reads stdin only when its own commands do, so `echo '<answer line>' > notes.md && bash -c 'make test'` stays allowed while `echo ... > f; bash < f` is denied (gauntlet 1, safe5-1).
- After Submit all, the review no longer shows on the next group, and it is drawn only for groups of two or more questions (gauntlet 1, uiuxs2-1).
- The review's Back button goes through the move lock and has the same hotkey as the card's Back (gauntlet 1, uiuxs2-3, uiuxs2-4).
- The arrival line goes on Next, Back and a jump; only a pick draws it (gauntlet 1, uiuxs2-5).
- The review draws the answers in the group's tree, as the open tree does: the group's name on top, then its sessions and one row per answer, above the title and the hint.
- The card keeps a row for the arrival line and one for the unanswered line, blank when they do not apply, so the card no longer shifts when a line comes or goes (gauntlet 1, uiuxs2-2).

### Changed
- SPEC.md (Bash and file guard) states the guard's threat: an agent of the same user that answers its own question or turns away mode on the plain way, out of haste or because text it read told it to. Deliberate evasion is a known limit, listed there, not a bug to chase, and no OS sandbox backs the guard (owner decision after gauntlet 1: the sandbox would change every Bash command of every session).

## [0.4.0-beta.43] - 2026-10-25

Askaway 0.4.0-beta.43 makes the Bash guard's scanner read heredocs and here-strings that a shell, `source` or an `eval` script runs (issues #10 to #14), and adds three card cues: the unanswered line, the arrival line and the review before Submit all.

### Fixed
- The Bash guard's scanner reads a heredoc or here-string that a substitution prints into an `eval` or `-c` script, so `eval "$(cat <<'EOF' ...)"`, `bash -c "$(cat <<'EOF' ...)"`, `x=$(cat <<'EOF' ...); eval "$x"`, `bash -c -- "$(...)"`, a substitution used as the command word, `echo "$(...)" | bash`, an `eval "$x"` in a function or loop before the assignment, and the backquote, here-string and nested forms with an `answer`, `away on` or state-folder line are denied by the scanner alone. Every heredoc body and here-string inside the line's substitutions is recorded before the line runs and read once when an `eval` or `-c` script holds a `$` or a backquote, the command word may expand, or a shell reads stdin, an over-deny kept on purpose; `git commit -m "$(cat <<'EOF' ...)"` stays prose (issue #14; `_record_fed`, `_fed_reason`, `SCRIPT_EXPANSION`).
- The Bash guard's scanner reads a heredoc or here-string run by `source` or `.` of stdin (`/dev/stdin`, `/dev/fd/0`, `/proc/self/fd/0`, `/proc/$$/fd/0`), so an `answer`, `away on` or state-folder line in it is denied by the scanner alone. `builtin .`, `command .` and `time .` keep the `.` as the command (a wrapper's number needs a digit now), and `//dev/stdin` counts as stdin. `. /dev/stdin <<< '...'`, `builtin . /dev/stdin <<< '...'` and `. //dev/stdin <<< '...'` with an answer were allowed by the full guard before (issue #13; `_reads_stdin_script`, `STDIN_PATH`).
- The Bash guard's scanner takes a command word that may expand (`$SHELL`, `"$SHELL"`, `${SHELL}`, `ba*sh`, `/bin/*sh`, `$(which bash)`, a backquote) as a possible shell, so a heredoc or here-string it runs is scanned as a command line and an `answer`, `away on` or state-folder line in it is denied by the scanner alone. `$SHELL <<< '...'` with an answer was allowed by the full guard before. A heredoc fed to any such word is read the same way, an over-deny kept on purpose (issue #12; `_reads_stdin_script`, `_may_expand`).
- The Bash guard's scanner skips the fd number of a redirection written before the command, which its tokens split off as a word of its own, so `2>/dev/null bash <<'EOF'`, `2>/dev/null python3 askaway.py answer ...` and `2>/dev/null rm -r` of the state folder are read with the right command word and denied by the scanner alone (`_strip_prefix`).
- The Bash guard's scanner knows more shells and wrappers when it looks for a shell on the line, so a heredoc or here-string run by `fish`, `ash`, `mksh`, `rbash`, `csh`, `tcsh`, `yash`, `busybox sh`, `/usr/bin/env bash`, `sudo bash`, `sudo -u root bash`, `doas -u root sh`, `timeout -s KILL 5 bash`, `env -u FOO bash`, `env -S 'bash -s'`, `exec -a name bash`, `time -f '%e' bash`, or a `sudo -i` or `sudo -s` with no command, is denied by the scanner alone, not only by the frozen copy. A wrapper is matched by its name even when written as a path, and the value word of an option such as `sudo -u` or `timeout -s` is skipped (issue #11; `SHELL_NAMES`, `WRAPPER_NAMES`, `WRAPPER_VALUE_OPTIONS`, `_drop_wrapper_args`).
- The Bash guard's scanner reads a heredoc or a `<<<` here-string that a shell runs as its script. In a command line that runs a shell (`bash`, `sh -s`, `bash /dev/stdin`, `env bash`, `cat <<'EOF' | bash`, and `sh -c 'bash'`, whose `-c` script starts a shell that reads stdin), every heredoc body and here-string of the line is scanned, a `$'...'` here-string also with its C escapes decoded (`$'\x61nswer'`), as a command line of its own, so `bash <<'EOF'` with an `answer` line, an `away on` line, or a `cd` above the state folder and a delete of it is denied by the scanner alone, not only by the frozen copy (issue #10; `_reads_stdin_script`, `_here_strings`, `_stdin_reason`). The rule over-denies on purpose: a body that another command on the same line owns is scanned too.

### Added
- A card with no pick shows an orange line above Back and Next: "Not answered yet: pick an option." Keep in the Other field keeps the text without picking it, so with a kept text the line names the Other letter to press ("Not answered yet: press C to choose your text."). The line goes once the question has a pick.
- A pick that moves the card on draws a green line at the top of the next card for 1.5 s: "✓ Previous pick saved · now question 2 of 3". The move stays instant; Next and Back draw no line.
- In a group of two or more questions, the pick that answers the last open question shows a review in place of the card: each question with its chosen answer, as a link back to its card, then Back and Submit all, so Submit all is no longer at the bottom of a long card. Back shows the last card again; a new pick that completes the group shows the review again.
- `FROZEN_COPY_OVER_DENIES` is the one list of the frozen guard copy's 29 known over-denies, each denied by the copy and allowed by the scanner alone, grouped by root cause, with the dangerous neighbours that the scanner alone must still deny (issues #3 to #7). Older tests that pinned the same commands are folded into it. Three strict `xfail` tests pin a scanner under-deny that the copy hides: a shell that reads its script from a heredoc (issue #10).

### Changed
- SPEC.md (Backstop) defines the clean review that retires the frozen copy: a review round in which no critic finds a scanner under-deny, and a differential run of the copy and the scanner over the commands the tests run, in which every command the copy denies and the scanner allows is in `FROZEN_COPY_OVER_DENIES`. It lists the removal steps, and keeps the copy while a strict `xfail` under-deny is left (issue #2).
- The README pair's Known issues links the milestones that track the guard's over-denies and the hidden under-deny.
- `docs/WAVES.md` summarizes the waves (milestones W1 to W3) and is updated when a wave closes.

## [0.4.0-beta.42] - 2026-10-22

Askaway 0.4.0-beta.42 stops the Bash guard's scanner from reading the script of `sed -i` as a file it writes, and lists the data edits the frozen copy still over-denies (ff413d3).

### Fixed
- The Bash guard's scanner no longer reads the script of `sed -i` as a file it writes. Its first operand is the script, unless `-e`, `-f`, `--expression` or `--file` gives the script, or a word may expand into more words or an option (a `$`, a backquote, a brace, a glob or an extglob outside quotes, as in `sed -i f {-e,s/a/b/}` or `sed -i f -@(e)`, which edit `f`), so a glob in a quoted script (`sed -i '1s|.*|x|' notes.md` run from `~` or `~/.claude`) no longer reaches the state folder (`_sed_files`, `SED_SCRIPT_OPTION`, `_may_expand`). Every file operand still counts. The frozen copy still denies such a command until it is removed.

### Changed
- SPEC.md (Backstop) and the README pair's Known issues list the data edits that the frozen copy over-denies, found in a review round: a quoted heredoc whose body line ends in `).`, which the copy reads as a `.` command, followed by a relative write; a quoted heredoc whose body has an odd number of single quotes, in a command that names askaway and holds the word answer; and the glob in a `sed -i` script. They also list the over-deny that the copy and the scanner share: a relative or `$VAR` write after `cd "$VAR"` in a command that names askaway.

## [0.4.0-beta.41] - 2026-10-22

Askaway 0.4.0-beta.41 records its decisions, trade-offs and limits in the README pair, and ships from a rewritten public history.

### Changed
- The repository history was rewritten on 2026-10-22 to drop text about the maintainer's private setup from every commit, message and tag. Every commit and tag sha from the fifth commit on changed, and the hashes this changelog cites were moved to the new commits. A clone made before that date no longer fast-forwards: clone again, or run `git fetch --force --tags origin` and `git reset --hard origin/main` in a clone with no local work. The code of each tag is unchanged; only comments, test fixtures and documentation text differ.
- The README pair records the project's decisions (what was chosen, over what, why and since which version), its trade-offs and its limits, explains how it works step by step (the `stamp-asker` hook, the pause guard with its frozen copy and scanner, the panel token, one copy of each answer per recipient in `d/` and `s/`), and gives an overview of the version line (`README.md`, `README.pt-BR.md`). Known issues adds the frozen copy's over-denies and the `delivered` status shown while a subagent is still held, and cites symbol names instead of line numbers.
- SPEC.md and CHANGELOG.md name only commits of this repository and neutral examples: the frozen guard copy is described as the guard of 0.4.0-beta.36 plus the relaxations of 0.4.0-beta.39 (be7d417).

## [0.4.0-beta.40] - 2026-10-22

Askaway 0.4.0-beta.40 gives the main session and the asking subagent one copy each of an answer, shows the recommended mark once, and closes the Bash guard gaps gauntlet 7 found.

### Changed
- Each answer has one copy per recipient. `d/<id>.json` is the main session's copy and carries `"recipient": "main"`; the new `s/<id>.json` is the copy of the subagent whose own `ask` filed the question, with its `agent_id` (`_claim_copy`, `_copy_closed`). A subagent's high-risk pause ends only on its own copy or a lapse, never on the main session's copy (`_pause_holds`). A marker written by 0.4.0-beta.39 or older, with no `recipient`, still closes every copy (`_closes_every_copy`). A subagent's `wait` marks its own copy from the line it printed (`_mark_waited`). `prune` removes `s/` files with their item and as orphans.
- The deliver hook reads and judges every answer before it claims any copy, then claims and prints in one short loop (`_deliver_lines`). The daily cleanup runs before the claims, one run at a time under a non-blocking `.prune.lock` (`_cleanup_lock`, `_maybe_prune`), so a hook timeout during the reads or the cleanup costs no claimed line. Only the main thread re-checks other sessions' answers (`_claimed_lines`).
- A subagent held by its own pause is told that its own `status <id>` call brings its copy and ends the hold; one held by a pause it did not file is told the parent session receives the answer (`_subagent_pause_reason`).
- The question playbook gives the `ask --json '<JSON>'` form, with an apostrophe as `\u0027` and no `<<` in the JSON, for calls a pause holds, and tells agents never to wrap a watched `askaway.py` subcommand in backticks or `$(...)` inside the JSON (`skills/askaway-question-playbook/SKILL.md`).

### Fixed
- An option shows the recommended mark once. The CLI takes the recommended marks off the start and the end of every label it stores, in English and Portuguese, in brackets or after a dash or a colon (`RECOMMENDED_MARKER`, `unmarked_label`): `ask --json`, `ask` on stdin, translations, the AskUserQuestion skeleton and the CSV label column. A label that is only a mark is refiled as missing. The pane takes them off too and draws its own mark once, on the button, in History and in the footer (`optionLabelOf`, `recommendedMarkOf`, `hooks/model.ts`).
- Pane: Other text typed under a kept label stays pending on a blur while its field is on screen, so Submit all sends the text the field shows (`recordPendingOther`). A reply press runs its own `list --open` and decides on its own result (`refreshEnded`). A failed `list --open` run is logged with its exit code and stderr, once per failure text, cut to 500 characters (`logEndedListFailure`). A written reply whose file does not read back yet stays on the board as a local copy that names who answered (`panelWho`). The poll after a Dismiss waits for the poll in flight (`pollAfterRunning`), and the draft retry waits for a save in flight (`draftSaves`). The footer names a question that is gone "Question closed", not its id (`hooks/register.tsx`, `hooks/model.ts`).
- A failed directory fsync after `write_atomic`'s replace is a warning on stderr, as after `create_once`'s link (`_sync_published`). A `q/` file whose name is not an inbox id is skipped by `list`, `prune` and `export` (`_question_matches`).

### Security
- The pause guard matcher and the file tamper check cover `MultiEdit` (`hooks/command-hooks.json`, `FILE_TOOLS`).
- The Bash guard denies every command longer than 64K characters, instead of leaving it to the frozen copy alone (`TOO_LONG_DENIED`).
- A deleted working directory no longer lets a call through: the frozen copy and the scanner run with the directory unknown and strict, and a file tool's relative path is refused (`_backstop_reason`, `_file_tamper_reason`).
- The scanner joins backslash-newline continuations in a command it cannot read as written (`_joined_lines`), and ends an unquoted heredoc whose terminator a backslash-newline splits (`_body_lines`). A `git` or `gh` heredoc is message text only for a builtin message subcommand with no config set that reads its message from stdin, and a code heredoc in a `$(...)` under one is code (`_message_command`, `_prose`). `cp`, `ln` and `install -t DIR` name a write target (`_write_operands`), and the suffix of `mv -S` is no target folder (`MOVE_TARGET_SHORT`).
- The pause guard reads its event as UTF-8 bytes whatever the locale, and denies an event it cannot read (`run_hook`, `UNREADABLE_DENIED`); the other hook modes still fail open. A held `ask` is told the `ask --json '<JSON>'` form the pause lets through (`_ask_form_hint`).
- SECURITY.md lists two known limits: the pause guard blocks a call on its own timeout or crash only from Claude Code 2.1.295 on, and below Python 3.12 every hook exits 0 and holds nothing.

## [0.4.0-beta.39] - 2026-10-22

Askaway 0.4.0-beta.39 delivers each answer to the subagent that asked, and stops the Bash guard denying unrelated commands.

### Changed
- The frozen guard `scripts/askaway_guard_baseline.py` is re-extracted from a later revision of the guard: the guard of 0.4.0-beta.36 plus the relaxations listed under Fixed below (be7d417). It still decides first, so the guard denies at least what the installed one denied, and it no longer denies what those relaxations let through (`bash_tamper_reason`, `_baseline_guard`).

### Fixed
- A subagent's hook call delivers only the answers whose question its own `ask` filed (`asker == agent_id`, `_deliver_one`), and its pause reason says to end the turn, that the parent session receives the answer, and that one `askaway.py status <id>` call fetches it (`_pause_decision`). The main thread still takes every answer of its session. A subagent's own `wait` call delivers nothing, so it keeps leaving the marker, and the hold, to the main session (`_is_wait_call`). Ported from a local mirror.
- Bash guard: a relative write after `cd "$VAR"` (or `pushd "$VAR"`) is refused only when the command names askaway, `ASKAWAY_HOME` or the word `state` (`STATE_HINT`), and a `git` or `gh` heredoc is commit, PR or issue text, not code (`PROSE_COMMANDS`); the `$(...)` units of an unquoted body are still read. `pushd`, `cd -`, `popd`, `CDPATH`, `source` and `eval` still refuse every relative target, and stay refused after a later `cd "$VAR"`. Ported from a local mirror.

## [0.4.0-beta.38] - 2026-10-22

Askaway 0.4.0-beta.38 hardens the pause guard's shell scanner, keeps an answered card dimmed until its reply is written, and makes the README pair follow the KeepGlide README standard.

### Changed
- The README pair follows the KeepGlide README standard: banner, badges, contents, status, screenshots, known issues, uninstall and maintainer sections (`README.md`, `README.pt-BR.md`).
- Claude Code 2.1.295 or later is required, because the hooks file sets `onFailure` (README pair, SPEC.md).
- The pause guard passes a read-only MCP tool whose only write word is `merge`, `commit` or `archive` right after the read verb, such as `get_commit`, `get_merge_request` or `list_merge_requests` (`is_read_only_mcp`, `READ_EXEMPT_WORDS`); another write word in its name still holds it, as `search_and_merge` is held. The word list is in SPEC.md.
- A subagent asker hands back during a pause instead of polling or running `wait` (`skills/askaway-question-playbook/SKILL.md`).
- The pane reads an option key only when it is one uppercase letter (`OPTION_KEY_PATTERN`, `hooks/model.ts`).
- An answered card stays dimmed until its reply is written, not for a fixed 250 ms: the written record takes it off, and a refused or failed reply undims it at once (`writeAnswer`, `hooks/register.tsx`).

### Fixed
- Linux: the Desktop session folder follows `$XDG_CONFIG_HOME` (default `~/.config`), as Claude Desktop does (`desktop_sessions_root`, `scripts/askaway.py`).
- An unknown risk value is drawn as the medium warning, never as its raw text (`riskLabel`, `hooks/model.ts`).
- Other text typed in the pane is recorded as the answer when Submit all is pressed (`submittedTypedOther`, `hooks/wizard.ts`).
- Titles of the session, family and project are drawn on one line (`singleLine`, `hooks/model.ts`).
- A Desktop Group with an empty name is skipped, so the family root's group still applies (`hooks/model.ts`).
- A Desktop config change that moves a question's group keeps that question on screen, and is not counted as a group switch (`groupOnScreen`, `hooks/register.tsx`).
- A History row whose question is gone reads "Question closed" (`hooks/model.ts`, `hooks/i18n.ts`).

### Security
- The pause guard matcher covers `Monitor` and `PowerShell` calls, anchored as `^(Edit|Write|NotebookEdit|Bash|PowerShell|Monitor|Agent)$|^mcp__` (`hooks/command-hooks.json`).
- The pause guard blocks the call when its hook times out, fails to start or exits unexpectedly (`"onFailure": "block"`).
- A damaged `q/` file holds the whole session, since its asker cannot be read (`_holds_caller`, `_holding_question`, `scripts/askaway.py`).
- The shell guard reads `#` as a comment only at the start of the text or after a space, tab, newline, `;`, `&`, `|` or `(`, so `echo a#b` and `(1)#` are checked as words, as in bash (`SHELL_TOKEN`, `scripts/askaway.py`). The text of a comment is read once more as a command (`_comment_reason`), so a `#` the scan misreads cannot hide a delete or a write, and a comment that only mentions the state folder still passes.
- The shell guard reads `$$`, a backquote with escapes and `((...))` as one word each, and a `..` after a `$`, a brace or a backquote no longer climbs back into the state folder (`SHELL_PIECE`, `_word_end`, `_hits_state`).
- The shell guard never denies less than it did at commit a312550: `bash_tamper_reason` returns the reason of a frozen copy of that commit's guard first, or else the current scanner's reason; each runs in its own try, so an exception or a missing copy denies instead of letting the command through, and the scanner denies past 64 levels of nesting instead of recursing, reads in linear time and is skipped over 64 KB (`SCAN_DEPTH_LIMIT`, `SCAN_SIZE_LIMIT`, `_Brackets`, `BACKSTOP_DENIED`, `UNREADABLE_DENIED`, `TOO_DEEP_DENIED`). The copy (`scripts/askaway_guard_baseline.py`, loaded by path from beside `askaway.py`) brings back two false positives the scanner had fixed (a sandboxed `answer` followed by a comment with a lone quote, and a bare `export CDPATH=...; touch a`); remove it once the scanner has a clean review. The scanner itself now reads `$(...)`, `${...}` and `((...))` down to 64 levels of nesting (an arithmetic `((...))` at a command's start is one word), checks the text from a `#` with a lone quote to the end of the command, and judges a glob by the directory before it even after a `$`, and a delete by the folder a `..` climbs to (`_unit_end`, `_comment_reason`, `_hits_state`).
- The shell guard refuses `mv` of a folder at or above the state folder when that folder is a source operand. `mv -t DIR`, `-tDIR` and `--target-directory[=]DIR` are read too, and make every other operand a source (`_move_targets`).
- The shell guard does not trust a sandboxed `ASKAWAY_HOME` when an earlier command on the same line made a link at or above it: an `ln`, a `cp -s`, `-a` or `-d` (or a copy of a symlink already on disk), or an `mv` into place. A name with `$`, a backtick, `{` or a glob counts as the folder before its first such mark; `mkdir` and a plain `cp` that copies no link are fine (`_links_made`, `_sandbox_value`).
- Fail closed on an unreadable `q/` folder: when `q/` exists but cannot be listed, `load_questions` raises, so the pause guard denies every call and a pane press is refused. A missing `q/` folder still reads as no questions (`load_questions`, `scripts/askaway.py`).

## [0.4.0-beta.37] - 2026-10-21

On macOS, Claude Desktop keeps its sessions under `~/Library/Application Support`, so the tree and the History found no session there and grouped nothing.

### Fixed
- `DESKTOP_SESSIONS_ROOT` is `~/Library/Application Support/Claude/claude-code-sessions` on macOS and stays `~/.config/Claude/claude-code-sessions` on Linux (`scripts/tests/test_platform_paths.py`).
- The changelog test finds `CHANGELOG.md` both in this repo and in a local mirror, where it sits one folder higher.

## [0.4.0-beta.36] - 2026-10-21

A high-risk question filed by a background subagent froze a whole session for 13 minutes: the pause held every tool call, the main thread's and the other subagents' too, and the main thread kept waking to report it was blocked.

### Changed
- The pause holds only the agent that filed the question (`hook stamp-asker`, a PostToolUse hook on `Bash`, writes `asker`: the caller's `agent_id`, or `main` for the main thread; `_holds_caller`, `_holding_question`, `_pause_decision`). A question with no `asker` (a failed stamp, a duplicate reply, a twin promoted to a pause by a high-risk repeat) still holds the whole session. Only a simple `ask` call or its heredoc form is stamped; an agent-sent `asker` key is dropped. The deny text tells the caller the reply arrives by itself and to end the turn instead of retrying or polling; a held subagent hands back what it has and stops.

### Tests
- `scripts/tests/test_askaway.py`: 32 cases for the scoped pause (subagent, main and unstamped holds), the stamp (once, per session, not from a duplicate, not from a compound command, only under the ask lock) and the deny text. A Sonnet review ran 13 mutations; the one survivor (a stamp outside the lock) now goes red.

Gates: `claude plugin test plugins/askaway` 469 pass, 0 fail; pytest 899 passed; `claude plugin validate` passed; `biome lint` clean.

## [0.4.0-beta.35] - 2026-10-21

Three owner reports on beta.34, seen on the Desktop.

### Fixed
- Titles are drawn whole: `questionLabel` (`hooks/model.ts`) never cuts (the 24-character title-less cut and the 40-character footer cut are gone), and a stored title that is the CLI's 60-character fallback ("…" at the end, a prefix of the question) is drawn as the whole question, in the card, the tree, the History, the footer, the new-question toast and the text list.
- History rows read the question and the reply, not the session's name or the letter: `renderHistoryEntry` (`hooks/pane.tsx`) draws plain text, since the Desktop drew the `#local_…` title link as a chip with the session's own name; `answerNameOf` (`hooks/model.ts`) names the chosen option's label in the pane's language, or an Other reply's whole typed text in quotes (“…”), so it reads apart from an option label; the sent, delivered and read-by-the-session times stay. The footer names the label too (`footer.last`, `hooks/i18n.ts`).

### Added
- Desktop sidebar Groups: the tree and the History group a question by the Desktop Group its session (else its family root) is filed under, labelled with the Group's name, falling back to the family title and then the project; the pane reads `~/.config/Claude/claude_desktop_config.json` (override `ASKAWAY_DESKTOP_CONFIG`) only when its mtime changes; a failed listing, read or parse, or a file over 4 MiB keeps the last Groups read, with no toast and no log, and a Desktop Group header in the History is plain text, not a session link (`readDesktopGroups`, `hooks/register.tsx`; `parseDesktopGroups`, `withDesktopGroup`, `groupKeyOf`, `groupLabelOf`, `hooks/model.ts`).

### Tests
- `tests/askaway.test.ts`, `tests/i18n.test.ts`, `tests/panel-race.test.ts`: a clipped title drawn whole in the tree, card, History and footer; History rows with the option label in both languages, an Other text, a closed question, plain text on the Desktop; Desktop Groups under one header, a session moved on the next poll after the config changes, a malformed config, the family and root fallbacks; after a Sonnet-high mutation review (15 of 40 mutants survived), cases that kill each real survivor: the clip rule's three conditions, a translated option label, list and read rejections that keep the last Groups, sibling files in the config folder, session-over-family precedence, non-`code:` keys, non-text, empty and control-character group names, a scope with no assignments, the text list, and a one-line label.

Gates: `claude plugin test plugins/askaway` 469 pass, 0 fail; pytest 867 passed; `claude plugin validate` passed; `biome lint` clean (23 files). Mutation check: every real survivor of the review now goes red.

## [0.4.0-beta.34] - 2026-10-21

Owner report on beta.33: after `/askaway lang` the pane's labels switched, but the question's text stayed in the
language the filing agent wrote it in. The pane never translates agent text, so a question can now carry its own
translation (JEV B, 0.95).

### Added
- `ask` accepts an optional `translations` object keyed by `en` and `pt-BR` (`_translations` and `_translated_text`, `scripts/askaway.py`): each language holds any of the question's text fields and, per main option key, any of `label`, `does`, `pros`, `cons`, `tradeoff`; every string is checked, capped and cleaned like its main field, a refusal names its path, and the object is not counted in the 4096-byte unknown-keys cap. A translation with `question` and no `title` gets the translated question, cut to 60, as its title (`_translated_language`), so the title rows switch language with the question (review, JEV A 0.93).
- `localizedQuestion` and `translationsOf` (`hooks/model.ts`) draw a question's translation for the language `/askaway lang` chose, field by field with the main text as fallback, in the card, tree rows, history rows, footer, new-question toast and `/askaway` text list (`hooks/pane.tsx`, `hooks/register.tsx`); new types in `types/index.d.ts`.
- `askaway-question-playbook`: write the main text in the user's language and the panel's other language under `translations`, with a worked example accepted by `ask`.

### Tests
- `scripts/tests/test_askaway.py`: a pt-BR translation stored as sent and cleaned; 18 refile cases each naming its path (with `pt` as a language and a 61-character translated title); the derived translated title; translations outside the unknown-keys cap; the delivery line unchanged, also through a shared `tests/delivery-lines.ts` case.
- `tests/askaway.test.ts`: parse, malformed and non-object translations; the overlay with per-field fallback; list, history and tree rows, the footer and the new-question toast in both languages; a `pt-BR` translation drawn after `/askaway lang pt-BR`; `/askaway lang en` and back redraw a translated card at once; the delivery line unchanged.

Gates: plugin tests 439 pass; pytest 867 passed; `claude plugin validate` passed; `biome lint` clean.

## [0.4.0-beta.33] - 2026-10-21

Two owner reports on beta.32, seen on the Desktop.

### Fixed
- `/askaway lang` asks the pane for a new draw at once (`setLang`, `hooks/register.tsx`, the same `$.ui.invalidate('ui.render')` the poll makes in `mergeBoard`), so an open card changes language together with the labels instead of at the next question.

### Changed
- Option sub-rows (tradeoff, pros, cons, fit) are plain on the Desktop again and dim only while the card fades (`renderOption`, `hooks/pane.tsx`); the measured dim ratios stay recorded in `TEXT_CONTRAST` (`hooks/look.ts`).

### Tests
- `tests/askaway.test.ts`: `/askaway lang en` draws the open card in English on the very next draw with no new question and no poll; the M58 sub-row test asserts plain on both surfaces.

Gates: plugin tests 425 pass; pytest 842 passed; `claude plugin validate` passed; `biome lint` clean.

## [0.4.0-beta.32] - 2026-10-21

Owner replies to the gauntlet-5 questions.

### Fixed

- M42: `_table_text` and `_fit_title` (`scripts/askaway.py`) cut the title with an ellipsis so `list --table` and `status --table` fit 80 columns; id, status, risk and age stay whole.
- M43: the module version guard (`scripts/askaway.py`) prints the JSON error to stderr instead of stdout below Python 3.12, and still exits 0.
- M44: `answer_lapsed` and `_clock_reading_ms` (`scripts/askaway.py`) measure the unread-reply TTL against the newest clock time seen (`clock_mark`), so a backward clock step no longer extends it.
- M48: `_away_reason` (`scripts/askaway.py`) denies `away on` and `away off` from the agent's Bash; the panel's toggle (`toggleAway`, `hooks/register.tsx`) is unchanged.
- M45: `renderQuestion` (`hooks/pane.tsx`) draws the `option.fitHint` line (`hooks/i18n.ts`) once per question when an option has a fit, so "fit N" is explained on the 0 to 100 scale.
- M51: `listText` (`hooks/model.ts`) reads the English `list.head.one`, `list.head.many` and `list.row` strings (`hooks/i18n.ts`), which now say "pending" as the pane does.
- M46: `submittedOther` (`hooks/wizard.ts`): while a label is kept, blank text on blur or Enter is a no-op and the label stays picked.
- M58: `TEXT_CONTRAST` (`hooks/look.ts`) records the measured Desktop dim (opacity .6: 5.17:1 light, 7.26:1 dark) and the engine's inactive token (5.74:1, 6.23:1) in place of the 50% blend; `renderOption` (`hooks/pane.tsx`) draws option sub-rows dim on the Desktop and, on the terminal, only while the card fades.
- M15: `renderDamagedPause` (`hooks/pane.tsx`) draws a notice naming a damaged q/ file that pauses its session, with a Dismiss; `damagedPauseOf` (`hooks/model.ts`) and `damagedPausesOf` (`hooks/register.tsx`) find those files; Dismiss runs `prune --id <id> --strict` (no `--force`) through `dismissOrSay` (`hooks/register.tsx`); new state key `damagedPauses` (`types/index.d.ts`).
- M46b: `submittedTypedOther` (`hooks/wizard.ts`) keeps a kept label when Submit all carries blank Other text.
- Review: `dismissQuestion` and `dismissOrSay` (`hooks/register.tsx`) run the damaged-pause Dismiss without `--force`, so a question the CLI reads is refused and kept with a toast; the ended-card Dismiss keeps `--force`.
- M48: `_unreadable_reason` (`scripts/askaway.py`) denies an unreadable Bash command that names the askaway script with `away on|off`, as `_away_reason` does.
- M48: `_askaway_code_reason` and `RUNS_CODE` (`scripts/askaway.py`) deny `away` next to the askaway literal and count `runpy` and `exec(` as running the script.
- M44: `_clock_reading_ms` (`scripts/askaway.py`) persists a reading a TTL or more ahead of the clock mark only once the daily prune stamp is newer than the mark, and rewrites the mark only when it trails the clock by over a minute.
- Review: `_entry_json` and `_finite_number` (`scripts/askaway.py`) refile NaN, Infinity and overflowing numbers; `_write_temp` writes with `allow_nan=False`; `_unknown_keys` refiles an entry whose unknown keys exceed 4096 bytes as JSON (`UNKNOWN_KEYS_MAX_BYTES`).

### Changed

- M41: `build_entry` and `_unknown_keys` (`scripts/askaway.py`) store unknown top-level keys of an ask entry with the question instead of dropping them; known keys keep their validation.
- M29b: `renderOther` (`hooks/pane.tsx`) draws a chosen kept label as the primary button with a "✓ " mark; `input.send` (`hooks/i18n.ts`) renames the field's button to Apply / Aplicar.

### Tests

- M12b: test-only pins in the CLI, the TTL edge and two consecutive runs (`scripts/tests/test_askaway.py`).
- Review: `scripts/tests/test_askaway.py` asserts the away denial reason exactly and pins the sandboxed, quoted, `bash -c` and variable forms; `tests/askaway.test.ts` pins the damaged-pause guards (a readable question, a delivered id, a bad session name) and a refused prune.
- M12b: pane pins in `tests/race.test.ts` (a marker written between the read and the link) and `tests/askaway.test.ts` (the hand-off once only, B3 M18; the TTL, B2 M32).

Gates: plugin tests 424 pass; pytest 842 passed; `claude plugin validate` passed; `biome lint` clean.

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
- Keep on Other works as a draft label: the typed text becomes the label of the Other button and is picked by a click on the button; typing again replaces the label and needs a new click. While a kept label exists, text typed and not kept is not recorded as an Other pick on blur, Next or Back; it stays pending until Keep (`keptOther`, `submittedOther`; `hooks/wizard.ts`, `hooks/register.tsx`).
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

[Unreleased]: https://github.com/KeepGlide/askaway/compare/v0.4.0-beta.43...HEAD
[0.4.0-beta.43]: https://github.com/KeepGlide/askaway/compare/v0.4.0-beta.42...v0.4.0-beta.43
[0.4.0-beta.42]: https://github.com/KeepGlide/askaway/compare/v0.4.0-beta.41...v0.4.0-beta.42
[0.4.0-beta.41]: https://github.com/KeepGlide/askaway/compare/v0.4.0-beta.40...v0.4.0-beta.41
[0.4.0-beta.40]: https://github.com/KeepGlide/askaway/compare/v0.4.0-beta.39...v0.4.0-beta.40
[0.4.0-beta.39]: https://github.com/KeepGlide/askaway/compare/v0.4.0-beta.38...v0.4.0-beta.39
