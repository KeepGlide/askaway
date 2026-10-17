# Contributing to Askaway

Thanks for helping. In short: branch from `main`, keep the change small, run both
test suites, and open a pull request.

## Run the tests

Askaway has two suites.

Mod (TypeScript), from the repository root:

```bash
claude plugin test plugins/askaway
```

CLI and hooks (Python 3, needs `pytest`: `python3 -m pip install pytest`):

```bash
cd plugins/askaway/scripts && python3 -m pytest tests -q
```

## Where things live

| Path | What it holds |
|---|---|
| `plugins/askaway/.claude-plugin/plugin.json` | The plugin manifest; it points to the command hooks |
| `plugins/askaway/hooks/` | The mod: `register.tsx` (wiring, polling, commands), `model.ts`, `wizard.ts`, `i18n.ts`, `pane.tsx`, `look.ts`; `hooks.json` loads the mod, `command-hooks.json` holds the command hooks |
| `plugins/askaway/scripts/askaway.py` | The CLI (`ask`, `answer`, `status`, `list`, `away`, `prune`) and the hook modes (`hook ask-guard`, `hook pause-guard`, `hook deliver`) |
| `plugins/askaway/skills/askaway/SKILL.md` | The skill that tells an agent how to file a question |
| `plugins/askaway/SPEC.md` | The spec: state folder contract, CLI, hooks and panel |
| `plugins/askaway/tests/` | TypeScript tests |
| `plugins/askaway/scripts/tests/` | Python tests |
| `assets/` | The icon |

## Conventions

- Code, comments, file names and commit messages are in English. Commits follow
  Conventional Commits, for example `feat(panel): ...` or `fix(cli): ...`.
- Branch from `main` as `<type>/<scope>-<slug>`, one change per branch, then open a pull request.
- Keep `README.md` and `README.pt-BR.md` in step: a change to one is a change to both.
- `SPEC.md` describes the public state folder contract. When the code changes it, update the spec in the same pull request.
