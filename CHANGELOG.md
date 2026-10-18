# Changelog

All notable changes to Askaway are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version in
`plugins/askaway/.claude-plugin/plugin.json` is still 0.4.0-beta.6: the 0.4.0-beta.7 and
0.4.0-beta.8 entries have no release commit yet. Commit hashes name the change in `git log`.

## [0.4.0-beta.8] - 2026-10-18

### Added

- `askaway.py wait <id> [--timeout 300]` polls the answer folder until the answer exists or the timeout ends (9b89c35).
- `--strict` on `ask`, `answer` and `status`: a refile, an error or a usage error exits 1 instead of 0 (9b89c35).
- `list --answered --since <when>` lists the answered questions, and `export [--since <when>] [--format json|jsonl|csv]` writes every question with its answer (9b89c35).
- `ASKAWAY_PRUNE_DAYS` sets the retention window in whole days; the default stays 30 (e43abe0).
- Answers record `who`: `ASKAWAY_WHO`, else the OS user name, else "unknown" (32f5a6e). Panel answers record it too (2552e2b).
- The pause guard lets `wait` and `export` through, as it does `ask`, `status` and `list` (e43abe0).
- Race tests: 20 concurrent `answer` processes, and 20 concurrent Submit all presses, each leave exactly one written answer.
- A CI workflow runs the Python suite and the mod suite on every push and pull request.

### Changed

- The pane footer shows the counts and the last answer when no question is open, and is absent while one is open (17ebade).

## [0.4.0-beta.7] - 2026-10-18

### Security

- The ask-guard skeleton quotes its JSON with `shlex.quote`, so option text cannot run `$(...)` in the shell (e77f4c5).
- Answers record their session. A `cli` answer from another session is refused and claims nothing (e77f4c5).
- Delivery lines are flattened to one line, so a title cannot forge a "The user answered" line (e77f4c5).
- A high-risk question keeps the agent paused until its answer is delivered or it expires; prune counts from delivery (e77f4c5).
- The pause guard covers `Agent` and `mcp__.*` writes, with an allowance for read-only tools (e77f4c5).
- A high-risk question that hits an internal error pauses the agent (e77f4c5).

### Changed

- The CLI checks for Python 3.12 before any other statement and prints an error line on an older Python (e77f4c5).
- `deliver` scans the project folders once per run, not once per question (e77f4c5).
- An answer still undelivered after its 7-day TTL reads as expired, not as delivered (17ebade).
- The pane draws the lead line under the card title, and urgency before undo (5657f11).
- On the desktop, Back, Next and Submit take the letters p, f and e; the terminal keeps b, n and s (9554668).
- The accent colour is no longer used for text. The accent is `#3566C8`: 5.40:1 on `#FFFFFF` and 3.28:1 on `#111827`, where `#1E40AF` measured 8.72:1 and 2.03:1 (0a01eb5).
- The plugin uses the approved KeepGlide brand icon (cef3351).

### Documentation

- SPEC.md states the pause rule, the answer sources and what is read and written (6b55ec2), and the expired status and answer session (e77f4c5).
- The README hero shows the pane on the light and dark themes (40925d1).

## [0.4.0-beta.6] - 2026-10-17

### Added

- The pane draws each option's fit after its tradeoff, in a gray explanation box (640d07e).

### Changed

- The README describes the away flow and what each card carries, matches every claim to the plugin, and adds a screenshot (150ad49, 6020300).
- SPEC.md records the 0.4.0-beta.5 live check of the pane layout (0f43a9f).
