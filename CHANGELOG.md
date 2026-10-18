# Changelog

All notable changes to Askaway are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version in
`plugins/askaway/.claude-plugin/plugin.json` is 0.4.0-beta.20, set by the beta.20 release commit.
Commit hashes name the change in `git log`.

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
