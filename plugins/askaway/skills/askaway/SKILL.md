---
name: askaway
description: File a question for the user through the Askaway inbox when you need a decision and the user may be away (bypass permissions, away mode, or an unattended run). Use it instead of guessing or blocking. Each question carries a recommended option you continue with unless the question is paused.
---

# Askaway

Askaway holds questions for the user while they are away. You file a question
with a recommended option and keep working on that option. The user answers
later in the Askaway panel, and the answer comes back into your session.

## When to file a question

- The user may be away: permission mode is `bypassPermissions`, away mode is on
  (`python3 ${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py away status` prints `{"away":true}`),
  or the run is unattended.
- A decision the user would want to make (scope, a trade-off, a choice with
  lasting consequences) would otherwise be a guess.
- Do not file facts you can check yourself, or routine steps.

## How to file

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py" ask --json '{"title":"Cache backend","question":"Which cache should the service use?","options":[{"key":"A","label":"Redis","tradeoff":"one more service to run","fit":88},{"key":"B","label":"In-process","tradeoff":"lost on restart","fit":40}],"recommended":"A","why":"Shared across workers.","risk":"low"}'
```

The CLI prints one JSON line: `{"id":"q-...","recommended":"A","action":"continue"}`.
On an invalid entry it prints `{"action":"continue","recommended":...,"error":"..."}`:
fix the entry and file it again, or continue on the recommended option.

Fields (SPEC.md, "State folder"):

| Field | Required | Notes |
|---|---|---|
| `question` | yes | Up to 400 characters. |
| `options` | yes | At least 2 objects: `key` (unique, such as `A`), `label`, optional `tradeoff` (one line), optional `fit` (integer 0-100 or null). |
| `recommended` | yes | One of the option keys. |
| `title` | no | Up to 60 characters; defaults to the question, clipped. |
| `context` | no | Up to 600 characters. |
| `why` | no | One or two sentences on why the recommended option. |
| `how`, `gains`, `losses`, `analogy`, `urgency`, `undo` | no | Explanation fields for the panel. |
| `risk` | no | `low` (default), `medium` or `high`. |
| `pause` | no | `true` pauses this session until the user answers. |
| `run_kind` | no | `main`, `subagent`, `goal`, `loop`, `bash` or `codex`. |

Do not pass `session` or `project`: the CLI fills them from the environment and the working directory.

## After filing

- Continue on `recommended` unless `action` is `pause`.
- `"action": "pause"` (from `risk: high` or `pause: true`) means: do read-only work
  or end the turn until the answer arrives. Check with
  `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py status <id>` (unquoted, so the
  pause guard lets it through).
- Pause for real files, credentials, and irreversible actions (deleting data,
  publishing, spending money).
- An answer arrives as a line in your context:
  `The user answered Askaway question <id> (<title>): <key> · <label>.`, with
  `(you were using <key> · <label>)` when it differs from your recommendation.
  A free-text answer reads `their own answer (Other): "<text>"`. The answer
  overrides your recommendation; act on it.

## Rules

- File one question per decision. Do not file the same question twice.
- Keep `question` and `options` short and concrete; add `how`, `gains` and `losses`
  only when they help the user choose.
- Never invent an answer, and never file a question to hand over routine work.
- Never call `answer` yourself: only the user answers.
