# Changelog

All notable changes to Askaway are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version in
`plugins/askaway/.claude-plugin/plugin.json` is 0.4.0-beta.8, set by the beta.8 release commit.
The 0.4.0-beta.8 entry has no release commit yet. Commit hashes name the change in `git log`.

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
