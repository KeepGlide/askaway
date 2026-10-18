---
name: askaway-question-playbook
description: Files a question for the user in the Askaway inbox with what it is, the problem, an analogy, options with does, pros and cons, a recommended option and a risk level. Use when a decision is needed and the user may be away, such as in bypass permissions, away mode or an unattended run. Loaded on demand by the main session and by any agent that files a question.
metadata:
  domain: agentic
  owner: sophia-phillipa
  created: "2026-10-16"
---

# Askaway question playbook

Askaway holds questions for the user while the user is away. You file one
question with a recommended option and keep working on that option. The user
answers later in the Askaway panel, and the answer comes back into your session.

## When to file

- The user may be away: permission mode is `bypassPermissions`, away mode is on
  (`away.json` has `on: true`), or the session is unattended (`CLAUDE_CODE_SESSION_ATTENDED=0`).
- A decision the user would make (scope, a trade-off, a lasting consequence)
  would otherwise be a guess.
- Any question you would write in the reply and then wait for: a handoff pause,
  an authorization round, a choice of approach. File it, keep the recommended
  option, and you may repeat the question in the reply. Chat text alone never
  reaches the panel.
- Do not file facts you can check yourself, or routine steps.

## Briefing order

Write each question in this order. The reader has not seen the conversation.

1. **Context** (`context`): one or two sentences: the task and the step that stopped.
2. **What it is** (`what`): 2 to 5 plain sentences: what the thing is, what the
   spec says, what the code does today, and the discrepancy. At least 2 sentences;
   the CLI refuses fewer.
3. **The problem** (`problem`): the concrete consequence if nothing is decided,
   with one example.
4. **Analogy** (`analogy`): one everyday image that makes the trade-off concrete.
5. **Options** (`options`): for each option, what happens if it is chosen
   (`does`), its `pros`, its `cons`, a one-line `tradeoff` and a `fit` score.
6. **Recommendation** (`recommended`): the key of the option you continue with.
   Then `why` (the reasoning, one or two sentences), `how` (how it works), `gains`
   and `losses` (what the user gets and gives up), `urgency` (why now: when the
   answer is due, or `Can wait`) and `undo` (what reversing costs).

## Fields

The CLI refuses longer text as `too long (n/limit)` and names the field, so keep each field within its limit. Only a missing title falls back to the question, cut to 60.

| Field | Required | Limit | Rule |
|---|---|---|---|
| `title` | no | 60 | Defaults to the question, cut to 60. |
| `question` | yes | 400 | One decision, short and concrete. |
| `context` | yes | 600 | Task and step that stopped. |
| `what` | yes | 600 | At least 2 sentences, checked by the CLI. |
| `problem` | yes | 400 | Consequence with one example. |
| `analogy` | yes | 300 | One everyday image. |
| `why`, `how` | yes | 300, 400 | One or two sentences each. |
| `gains`, `losses` | yes | 300 | One or two sentences each. |
| `urgency` | yes | 300 | `Blocks in ~8 min` or `Can wait`. |
| `undo` | yes | 300 | For example `changing later ≈ 10 min`. |
| `recommended` | yes | | One of the option keys. |
| `risk` | yes | | `low`, `medium` or `high`. |
| `options` | yes | | At least 2. Keys are consecutive uppercase letters from A, in order (A, B, C). Each has `key`, `label` (300), `does`, `pros`, `cons` (300 each, all required), `tradeoff` (300, one line, required) and `fit` (integer 0 to 100, required). |

Do not pass `session` or `project`: the CLI fills them from the environment and the working directory.

## Filing

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py" ask --json '<the JSON from the worked example below>'
```

The CLI prints one JSON line: `{"id":"q-...","recommended":"A","action":"continue"}`.

- `"action":"refile"` with an `error` such as `missing fields: analogy, undo; option B: fit`
  means nothing was filed. Complete the named fields and file the same question again.
- `"error":"internal error"` with `"action":"continue"` means it was not filed either.
  Continue on the recommended option.
- Keep the JSON in single quotes, or pipe it to `ask` on stdin. Inside double quotes
  the shell would run a backticked name as a command.

## After filing

- Continue on `recommended` unless `action` is `pause`.
- `"action":"pause"` is printed only for `risk` `high`. Do read-only work, or end
  the turn, until the answer is delivered to your session. The pause ends at
  delivery, not when the user writes the answer. Check with a plain `status <id>`
  command (no shell operators), which the pause guard lets through.
- `low` and `medium` never pause.
- An answer arrives as a line in your context:
  `The user answered Askaway question <id> (<title>): <key> · <label>.`, with
  `(you were using <key> · <label>)` when it differs from your recommendation.
  A free-text answer reads `their own answer (Other): "<text>"`. The answer
  overrides your recommendation; act on it.

## Rules

- One question per decision. Do not file the same question twice.
- Never invent an answer, never file to hand over routine work, and never call
  `answer` yourself: only the user answers.
- Set `risk` to `high` for real files, credentials and irreversible actions
  (deleting data, publishing, spending money).
- When an option has no material gain or loss, say so and name the smallest real
  one. Never leave a field empty or write a placeholder.
- Put every command, skill, agent, file or flag that a field names between
  backticks, such as `software-test-engineer` or `hooks/pane.tsx`. The panel
  draws these names in the accent colour and does not draw the backticks.
  A slash command may stand bare (`/reload-plugins`).

## Worked example

An invented case, to show the shape and the length of each part. It was run
through `ask` against a throwaway `ASKAWAY_HOME` and accepted.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py" ask --json '{
  "title": "Windows install location",
  "question": "Where should the Windows build install for each user?",
  "context": "Packaging the Windows installer; the install step stops at the install folder. Scope: the installer only, no app code changes.",
  "what": "The Windows installer decides where the app lands on disk. The spec says the app installs into the current user folder under `%LOCALAPPDATA%`, so no admin rights are needed. The installer code today writes to `Program Files`, which needs admin rights, so a standard user gets a permission error at the last step.",
  "problem": "If nothing is decided, the next Windows build keeps this mismatch and standard users cannot install it. Example: a new hire on a company laptop without admin rights runs the installer, gets the permission error, and cannot use the app that day.",
  "analogy": "Like keeping your files in your own desk drawer, which needs no key, instead of the building storage room, which needs the janitor key.",
  "why": "The spec already names the per-user folder, and it needs no admin rights, so the install works on the machines where it fails today.",
  "how": "The installer writes the app under `%LOCALAPPDATA%` for the current user and adds a Start menu shortcut for that user.",
  "gains": "The install works without admin rights, and the installer matches the spec again.",
  "losses": "Each Windows account gets its own copy, so an update has to reach every profile on a shared PC.",
  "urgency": "Can wait for the next release",
  "undo": "changing later ≈ 2 h, installer and one test",
  "risk": "low",
  "options": [
    {"key": "A", "label": "Per-user folder", "does": "The installer writes the app under `%LOCALAPPDATA%` for the current user and adds a Start menu shortcut for that user.", "pros": "No admin rights needed; works on shared PCs; matches the spec.", "cons": "Each Windows account gets its own copy, so updates must reach every profile.", "tradeoff": "Safe to accept and easy to change later; only the installer changes.", "fit": 90},
    {"key": "B", "label": "Program Files for all users", "does": "The installer keeps the current location and writes the app to `Program Files` for every account on the PC.", "pros": "One copy serves all users; it is where Windows users look for programs.", "cons": "Needs admin rights, so most standard users cannot install; it contradicts the spec.", "tradeoff": "Accepting it keeps the install broken for standard users; changing later means rewriting the installer again.", "fit": 35},
    {"key": "C", "label": "Folder the user picks", "does": "The installer asks where to install the app, remembers the answer and uses that folder for updates.", "pros": "Each user picks a disk and folder that suit them; works on shared PCs.", "cons": "Adds a screen to the install flow and needs a tested default for people who press Next.", "tradeoff": "Costs one more screen and its tests; reversible later by removing the prompt.", "fit": 60}
  ],
  "recommended": "A"
}'
```
