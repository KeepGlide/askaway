---
name: file-question
description: File a question for the user through the Askaway inbox when you need a decision and the user may be away (bypass permissions, away mode, or an unattended run). Use it instead of guessing or blocking. Each question carries a recommended option you continue with unless the question is paused.
metadata:
  domain: agentic
  owner: sophia-phillipa
  created: "2026-10-16"
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
- Any question you would otherwise write in the reply and then wait for: a
  handoff pause ("continue here or open a new window?"), an authorization
  round, a choice of approach. File it, keep the recommended option, and you
  may repeat the question in the reply. A question that lives only in chat text
  never reaches the panel.
- Do not file facts you can check yourself, or routine steps.

## How to file

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py" ask --json '{"title":"Cache backend","question":"Which cache should the service use?","context":"Sizing the API for three workers; the cache sits in front of the reads.","options":[{"key":"A","label":"Redis","tradeoff":"Safe to accept and easy to change later; one more service to run and monitor","fit":88},{"key":"B","label":"In-process","tradeoff":"Give up sharing hits across workers; the cache is lost on restart","fit":40}],"recommended":"A","why":"Workers share one cache, so a hit on one serves all three.","how":"Redis runs as a service in `docker-compose.yml` next to the API; the cache client points at it.","gains":"Hits are shared across workers and survive a restart.","losses":"One more service to run and monitor.","risk":"low"}'
```

The CLI prints one JSON line: `{"id":"q-...","recommended":"A","action":"continue"}`.
On an invalid entry it prints `{"action":"continue","recommended":...,"error":"..."}`:
fix the entry and file it again, or continue on the recommended option.

Fields (SPEC.md, "State folder"):

| Field | Required | Notes |
|---|---|---|
| `question` | yes | Up to 400 characters. |
| `options` | yes | At least 2 objects: `key` (unique, such as `A`), `label`, optional `tradeoff` (one line; the rules below say what it holds), optional `fit` (integer 0-100 or null). |
| `recommended` | yes | One of the option keys. |
| `title` | no | Up to 60 characters; defaults to the question, clipped. |
| `context` | no, always fill | Where the question comes from: the task and the step that stopped. Up to 600 characters. |
| `why` | no, always fill | One or two sentences on why the recommended option. |
| `how` | no, always fill | One or two sentences on how the recommended option works. Up to 400 characters. |
| `gains` | no, always fill | One or two sentences on what the user gains with it. Up to 300 characters. |
| `losses` | no, always fill | One or two sentences on what the user gives up or risks with it. Up to 300 characters. |
| `analogy`, `urgency`, `undo` | no | Add `analogy` when a comparison makes the trade-off clear, `urgency` when there is a deadline (e.g. `Blocks in ~8 min`), `undo` when reversing the choice is costly (e.g. `changing later ≈ 10 min`). |
| `risk` | no | The risk of accepting the recommended option: `low` (default) is safe to accept and easy to change later; `medium` is reversible but costs rework; `high` is irreversible, or touches real files, credentials or money, and pauses the session. |
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
- Fill `context`, `why`, `how`, `gains` and `losses` in every question, one or two
  sentences each, so the user can judge the trade-off in the panel without opening
  the conversation.
- When the option has no material gain or loss, say so in that field and name the
  smallest real one. Never leave a field empty or write a placeholder.
- Add `analogy`, `urgency` or `undo` when the table says they help.
- Keep `question` and `options` short and concrete.
- The recommended option's `tradeoff` says how safe it is to accept it, whether it can be changed later, and what else
  weighs on it (cost, time, what is lost). Each other option's `tradeoff` says what you give up by picking it.
- Put every command, skill, agent, file or flag that an explanation field names between backticks, such as
  `software-test-engineer` or `hooks/pane.tsx`. A slash command may stand bare (`/reload-plugins`). The panel draws
  these names in the accent color and does not draw the backticks.
  Keep the JSON inside single quotes, as in the example, or pipe it to `askaway.py ask` on stdin: inside double
  quotes the shell would run a backticked name as a command.
- Never invent an answer, and never file a question to hand over routine work.
- Never call `answer` yourself: only the user answers.
