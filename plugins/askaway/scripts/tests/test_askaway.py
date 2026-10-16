"""Tests for scripts/askaway.py: CLI commands, hook modes and the state folder (SPEC.md)."""
import io
import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import askaway

SCRIPT = SCRIPTS / "askaway.py"
SESSION = "sess-under-test"
DAY_MS = 86_400_000


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    state = tmp_path / "inbox"
    monkeypatch.setenv("ASKAWAY_HOME", str(state))
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ATTENDED", raising=False)
    for name in [n for n in os.environ if n.startswith("CODEX_")]:
        monkeypatch.delenv(name)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(askaway, "projects_root", lambda: tmp_path / "projects", raising=False)
    return state


@pytest.fixture
def clock(monkeypatch):
    now = {"ms": 1_791_993_000_000}
    monkeypatch.setattr(askaway, "now_ms", lambda: now["ms"])
    return now


def base_entry(**over) -> dict:
    entry = {
        "title": "Cache backend",
        "question": "Which cache should the service use?",
        "options": [
            {"key": "A", "label": "Redis", "tradeoff": "one more service to run", "fit": 88},
            {"key": "B", "label": "In-process", "tradeoff": "lost on restart", "fit": 40},
        ],
        "recommended": "A",
        "why": "Shared across workers.",
        "risk": "low",
    }
    entry.update(over)
    return entry


def cli(capsys, *args: str) -> dict:
    assert askaway.main(list(args)) == 0
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    return json.loads(lines[0])


def ask_item(capsys, **over) -> str:
    return cli(capsys, "ask", "--json", json.dumps(base_entry(**over)))["id"]


def run_hook(capsys, monkeypatch, mode: str, event: dict) -> str:
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(event)))
    assert askaway.main(["hook", mode]) == 0
    return capsys.readouterr().out


def hook_json(capsys, monkeypatch, mode: str, event: dict) -> dict:
    lines = run_hook(capsys, monkeypatch, mode, event).splitlines()
    assert len(lines) == 1
    return json.loads(lines[0])


def stored(home: Path, folder: str, item_id: str) -> dict:
    return json.loads((home / folder / f"{item_id}.json").read_text(encoding="utf-8"))


def deliver_event(session=SESSION, cwd=None) -> dict:
    return {"session_id": session, "cwd": cwd or os.getcwd(), "hook_event_name": "UserPromptSubmit"}


def edit_event(session=SESSION, tool="Edit", command="") -> dict:
    tool_input = {"command": command} if tool == "Bash" else {"file_path": "notes.md"}
    return {"session_id": session, "cwd": os.getcwd(), "hook_event_name": "PreToolUse",
            "tool_name": tool, "tool_input": tool_input}


def askuser_payload(permission_mode: str = "default") -> dict:
    return {
        "session_id": SESSION, "cwd": os.getcwd(), "hook_event_name": "PreToolUse",
        "tool_name": "AskUserQuestion", "permission_mode": permission_mode,
        "tool_input": {"questions": [
            {"header": "Cache", "question": "Which cache?", "multiSelect": False, "options": [
                {"label": "In-process", "description": "lost on restart"},
                {"label": "Redis (Recommended)", "description": "one more service"}]},
            {"header": "Logs", "question": "Log level?", "multiSelect": False, "options": [
                {"label": "info", "description": "default"},
                {"label": "debug", "description": "noisy"}]},
        ]},
    }


# ---- ask ---------------------------------------------------------------

def test_ask_valid_entry_is_filed_and_reported(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    out = cli(capsys, "ask", "--json", json.dumps(base_entry()))
    assert out["recommended"] == "A" and out["action"] == "continue"
    entry = stored(home, "q", out["id"])
    assert entry["v"] == 1 and entry["id"] == out["id"]
    assert entry["session"] == SESSION and entry["project"] == os.getcwd()
    assert entry["run_kind"] == "main" and entry["source"] == "cli"
    assert entry["pause"] is False and entry["risk"] == "low"
    assert entry["options"][0] == {"key": "A", "label": "Redis",
                                   "tradeoff": "one more service to run", "fit": 88}
    assert [p.name for p in (home / "q").iterdir()] == [f"{out['id']}.json"]


def test_ask_high_risk_pauses(home, capsys):
    out = cli(capsys, "ask", "--json", json.dumps(base_entry(risk="high")))
    assert out["action"] == "pause"
    assert stored(home, "q", out["id"])["pause"] is True


def test_ask_pause_flag_pauses_a_low_risk_question(home, capsys):
    out = cli(capsys, "ask", "--json", json.dumps(base_entry(pause=True)))
    assert out["action"] == "pause"


def test_ask_defaults_to_codex_run_kind_without_session(home, capsys, monkeypatch):
    monkeypatch.setenv("CODEX_THREAD_ID", "thread-1")
    out = cli(capsys, "ask", "--json", json.dumps(base_entry()))
    entry = stored(home, "q", out["id"])
    assert entry["run_kind"] == "codex" and entry["session"] is None


def test_ask_explicit_run_kind_wins_over_env(home, capsys, monkeypatch):
    monkeypatch.setenv("CODEX_THREAD_ID", "thread-1")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    out = cli(capsys, "ask", "--json", json.dumps(base_entry(run_kind="subagent")))
    assert stored(home, "q", out["id"])["run_kind"] == "subagent"


def test_ask_ignores_session_and_project_sent_in_payload(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    out = cli(capsys, "ask", "--json",
              json.dumps(base_entry(session="someone-else", project="/elsewhere")))
    entry = stored(home, "q", out["id"])
    assert entry["session"] == SESSION and entry["project"] == os.getcwd()


@pytest.mark.parametrize("change", [
    lambda e: e.update(options=[e["options"][0]]),
    lambda e: e["options"][1].update(key="A"),
    lambda e: e.update(recommended="Z"),
    lambda e: e.update(risk="extreme"),
    lambda e: e["options"][0].update(fit=101),
    lambda e: e["options"][0].update(fit=True),
    lambda e: e.pop("question"),
    lambda e: e.update(pause="yes"),
    lambda e: e.update(run_kind="robot"),
])
def test_ask_invalid_entry_continues_with_error_and_files_nothing(change, home, capsys):
    entry = base_entry()
    change(entry)
    out = cli(capsys, "ask", "--json", json.dumps(entry))
    assert out["action"] == "continue" and out["error"]
    assert not (home / "q").exists() or list((home / "q").glob("*.json")) == []


def test_ask_error_echoes_the_recommended_value_given(capsys):
    out = cli(capsys, "ask", "--json", json.dumps(base_entry(recommended="Z")))
    assert out["recommended"] == "Z" and out["action"] == "continue"


def test_ask_unreadable_json_fails_open(capsys):
    out = cli(capsys, "ask", "--json", "{nope")
    assert out["action"] == "continue" and out["recommended"] is None and out["error"]


def test_ask_reads_entry_from_stdin(capsys, monkeypatch):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(base_entry())))
    assert cli(capsys, "ask")["recommended"] == "A"


def test_ask_truncates_long_strings(home, capsys):
    out = cli(capsys, "ask", "--json", json.dumps(
        base_entry(title="t" * 200, question="q" * 500, context="c" * 700)))
    entry = stored(home, "q", out["id"])
    assert len(entry["title"]) == 60 and entry["title"].endswith("…")
    assert len(entry["question"]) == 400
    assert len(entry["context"]) == 600


# ---- answer ------------------------------------------------------------

def test_answer_first_writer_wins(home, capsys):
    item = ask_item(capsys)
    first = cli(capsys, "answer", item, "B", "--by", "panel")
    second = cli(capsys, "answer", item, "A")
    assert first == {"id": item, "key": "B", "written": True}
    assert second == {"id": item, "key": "B", "written": False}
    assert stored(home, "a", item)["key"] == "B" and stored(home, "a", item)["by"] == "panel"
    assert [p.name for p in (home / "a").iterdir()] == [f"{item}.json"]


def test_answer_rejects_unknown_key(home, capsys):
    item = ask_item(capsys)
    assert "error" in cli(capsys, "answer", item, "Z")
    assert not (home / "a").exists()


def test_answer_rejects_unknown_id_and_path_like_id(home, capsys):
    assert "error" in cli(capsys, "answer", "q-missing-000000", "A")
    assert "error" in cli(capsys, "answer", "../evil", "A")
    assert not (home.parent / "evil.json").exists()


def test_answer_rejects_unknown_by(home, capsys):
    item = ask_item(capsys)
    assert "error" in cli(capsys, "answer", item, "A", "--by", "robot")
    assert not (home / "a").exists()


# ---- status / list -----------------------------------------------------

def test_status_follows_open_answered_delivered(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    assert cli(capsys, "status", item) == {"id": item, "status": "open", "key": None}
    cli(capsys, "answer", item, "B")
    assert cli(capsys, "status", item) == {"id": item, "status": "answered", "key": "B"}
    run_hook(capsys, monkeypatch, "deliver", deliver_event())
    assert cli(capsys, "status", item) == {"id": item, "status": "delivered", "key": "B"}


def test_status_of_unknown_id_is_an_error(capsys):
    assert "error" in cli(capsys, "status", "q-missing-000000")


def test_list_is_newest_first_and_open_filter(clock, capsys):
    assert cli(capsys, "list") == {"items": []}
    clock["ms"] = 1_000
    old = ask_item(capsys, title="old one")
    clock["ms"] = 2_000
    new = ask_item(capsys, title="new one")
    cli(capsys, "answer", old, "A")
    items = cli(capsys, "list")["items"]
    assert [i["id"] for i in items] == [new, old]
    assert items[1] == {"id": old, "title": "old one", "status": "answered",
                        "recommended": "A", "key": "A"}
    assert [i["id"] for i in cli(capsys, "list", "--open")["items"]] == [new]


# ---- away --------------------------------------------------------------

def test_away_toggles_and_reports(home, capsys):
    assert cli(capsys, "away", "status") == {"away": False}
    assert cli(capsys, "away", "on") == {"away": True}
    assert json.loads((home / "away.json").read_text(encoding="utf-8"))["on"] is True
    assert cli(capsys, "away", "status") == {"away": True}
    assert cli(capsys, "away", "off") == {"away": False}


def test_away_file_keeps_its_mode(home, capsys):
    home.mkdir(parents=True)
    path = home / "away.json"
    path.write_text('{"on": false, "ts": 1}', encoding="utf-8")
    os.chmod(path, 0o640)
    cli(capsys, "away", "on")
    assert stat.S_IMODE(path.stat().st_mode) == 0o640


def test_away_signals(home, monkeypatch, capsys):
    assert askaway.is_away("default") is False
    assert askaway.is_away("bypassPermissions") is True
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ATTENDED", "0")
    assert askaway.is_away("default") is True
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ATTENDED")
    cli(capsys, "away", "on")
    assert askaway.is_away("default") is True


# ---- ask-guard ---------------------------------------------------------

def test_ask_guard_when_not_away_is_silent(home, capsys, monkeypatch):
    assert run_hook(capsys, monkeypatch, "ask-guard", askuser_payload()) == ""
    assert not (home / "q").exists()


def test_ask_guard_when_away_files_each_question(home, capsys, monkeypatch):
    cli(capsys, "away", "on")
    hook_json(capsys, monkeypatch, "ask-guard", askuser_payload())
    files = sorted((home / "q").glob("*.json"))
    entries = [json.loads(p.read_text(encoding="utf-8")) for p in files]
    assert len(entries) == 2
    by_title = {e["title"]: e for e in entries}
    cache = by_title["Cache"]
    assert cache["source"] == "askuserquestion" and cache["risk"] == "low"
    assert cache["recommended"] == "B"
    assert [(o["key"], o["label"], o["fit"]) for o in cache["options"]] == [
        ("A", "In-process", None), ("B", "Redis (Recommended)", None)]
    assert cache["options"][0]["tradeoff"] == "lost on restart"
    assert by_title["Logs"]["recommended"] == "A"


def test_ask_guard_denial_names_ids_and_recommended_options(home, capsys, monkeypatch):
    cli(capsys, "away", "on")
    out = hook_json(capsys, monkeypatch, "ask-guard", askuser_payload())
    decision = out["hookSpecificOutput"]
    assert decision["hookEventName"] == "PreToolUse"
    assert decision["permissionDecision"] == "deny"
    reason = decision["permissionDecisionReason"]
    for path in (home / "q").glob("*.json"):
        assert path.stem in reason
    assert "Cache: Redis (Recommended)" in reason and "Logs: info" in reason
    assert '"pause": true' in reason


def test_ask_guard_reason_speaks_of_the_user_and_names_this_script(home, capsys, monkeypatch):
    cli(capsys, "away", "on")
    out = hook_json(capsys, monkeypatch, "ask-guard", askuser_payload())
    reason = out["hookSpecificOutput"]["permissionDecisionReason"]
    assert reason.startswith("The user is away, so this question went to the Askaway inbox as ")
    assert askaway.SCRIPT_PATH == SCRIPT.resolve()
    assert f'python3 "{askaway.SCRIPT_PATH}" ask' in reason
    assert not set(reason.split()) & {"her", "she"}


def test_ask_guard_bypass_mode_counts_as_away(home, capsys, monkeypatch):
    out = hook_json(capsys, monkeypatch, "ask-guard", askuser_payload("bypassPermissions"))
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_ask_guard_invalid_question_files_nothing_and_stays_silent(home, capsys, monkeypatch):
    cli(capsys, "away", "on")
    payload = askuser_payload()
    payload["tool_input"]["questions"][1]["options"] = [{"label": "info"}]
    assert run_hook(capsys, monkeypatch, "ask-guard", payload) == ""
    assert not list((home / "q").glob("*.json"))


def guard_entries_by_title(home: Path, capsys, monkeypatch, payload: dict | None = None) -> dict:
    cli(capsys, "away", "on")
    hook_json(capsys, monkeypatch, "ask-guard", payload or askuser_payload())
    files = (home / "q").glob("*.json")
    return {e["title"]: e for e in (json.loads(p.read_text(encoding="utf-8")) for p in files)}


def test_ask_guard_entries_carry_the_option_descriptions_as_context(home, capsys, monkeypatch):
    entries = guard_entries_by_title(home, capsys, monkeypatch)
    assert entries["Cache"]["context"] == "A: lost on restart\nB: one more service"
    assert entries["Logs"]["context"] == "A: default\nB: noisy"
    assert entries["Cache"]["options"][0]["tradeoff"] == "lost on restart"


def test_ask_guard_context_skips_empty_descriptions(home, capsys, monkeypatch):
    payload = askuser_payload()
    payload["tool_input"]["questions"][1]["options"][0]["description"] = "   "
    entries = guard_entries_by_title(home, capsys, monkeypatch, payload)
    assert entries["Logs"]["context"] == "B: noisy"


def test_ask_guard_context_is_clipped_to_the_context_cap(home, capsys, monkeypatch):
    payload = askuser_payload()
    payload["tool_input"]["questions"][0]["options"][0]["description"] = "x" * 700
    entries = guard_entries_by_title(home, capsys, monkeypatch, payload)
    assert len(entries["Cache"]["context"]) == 600


def test_ask_guard_keeps_a_context_the_question_already_carries(home, capsys, monkeypatch):
    payload = askuser_payload()
    payload["tool_input"]["questions"][0]["context"] = "Own context"
    entries = guard_entries_by_title(home, capsys, monkeypatch, payload)
    assert entries["Cache"]["context"] == "Own context"


# ---- pause-guard -------------------------------------------------------

def pending_pause(capsys, monkeypatch) -> str:
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    return ask_item(capsys, risk="high", title="Delete old data?")


def test_pause_guard_denies_edit_in_the_same_session(capsys, monkeypatch):
    item = pending_pause(capsys, monkeypatch)
    out = hook_json(capsys, monkeypatch, "pause-guard", edit_event())
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"
    reason = out["hookSpecificOutput"]["permissionDecisionReason"]
    assert item in reason and "Delete old data?" in reason


def test_pause_guard_reason_names_the_askaway_question_and_this_script(capsys, monkeypatch):
    item = pending_pause(capsys, monkeypatch)
    out = hook_json(capsys, monkeypatch, "pause-guard", edit_event())
    reason = out["hookSpecificOutput"]["permissionDecisionReason"]
    assert reason.startswith(
        f"Paused: Askaway question {item} (Delete old data?) needs the user's answer.")
    assert f"`python3 {askaway.SCRIPT_PATH} status {item}`" in reason
    assert not set(reason.split()) & {"her", "she"}


def test_pause_guard_lets_through_the_status_command_its_reason_names(capsys, monkeypatch):
    item = pending_pause(capsys, monkeypatch)
    command = f"python3 {askaway.SCRIPT_PATH} status {item}"
    assert run_hook(capsys, monkeypatch, "pause-guard", edit_event(tool="Bash", command=command)) == ""


def test_pause_guard_denies_bash_that_is_not_inbox(capsys, monkeypatch):
    pending_pause(capsys, monkeypatch)
    out = hook_json(capsys, monkeypatch, "pause-guard",
                    edit_event(tool="Bash", command="rm -rf build"))
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


@pytest.mark.parametrize("command", [
    "python3 scripts/askaway.py status {item}",
    "python3 scripts/askaway.py list --open",
])
def test_pause_guard_lets_a_bash_command_run_inbox(command, capsys, monkeypatch):
    item = pending_pause(capsys, monkeypatch)
    event = edit_event(tool="Bash", command=command.format(item=item))
    assert run_hook(capsys, monkeypatch, "pause-guard", event) == ""


@pytest.mark.parametrize("command", [
    "python3 scripts/askaway.py answer {item} A",
    "rm -rf x # askaway.py",
    "askaway.py status x && rm y",
    "python3 scripts/askaway.py status {item} && rm y",
    "python3 $(rm -rf x)askaway.py status {item}",
])
def test_pause_guard_denies_bash_that_is_not_one_simple_status_or_list_call(
        command, capsys, monkeypatch):
    item = pending_pause(capsys, monkeypatch)
    event = edit_event(tool="Bash", command=command.format(item=item))
    out = hook_json(capsys, monkeypatch, "pause-guard", event)
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_pause_guard_ignores_other_sessions(capsys, monkeypatch):
    pending_pause(capsys, monkeypatch)
    assert run_hook(capsys, monkeypatch, "pause-guard", edit_event(session="other")) == ""


def test_pause_guard_ignores_answered_and_non_pause_items(capsys, monkeypatch):
    item = pending_pause(capsys, monkeypatch)
    cli(capsys, "answer", item, "A")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    ask_item(capsys, title="Just a question")
    assert run_hook(capsys, monkeypatch, "pause-guard", edit_event()) == ""


def test_pause_guard_never_matches_a_missing_session(capsys, monkeypatch):
    pending_pause(capsys, monkeypatch)
    assert run_hook(capsys, monkeypatch, "pause-guard", edit_event(session=None)) == ""


# ---- deliver -----------------------------------------------------------

def test_deliver_with_no_answers_returns_before_reading_questions(monkeypatch, home):
    def forbidden(path: Path):
        raise AssertionError("q/ must not be read")

    monkeypatch.setattr(askaway, "read_json", forbidden)
    assert askaway.hook_deliver(deliver_event()) is None
    (home / "a").mkdir(parents=True)
    assert askaway.hook_deliver(deliver_event()) is None


def test_deliver_sends_the_answer_once_to_the_asking_session(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    cli(capsys, "answer", item, "B")
    out = hook_json(capsys, monkeypatch, "deliver", deliver_event())
    spec = out["hookSpecificOutput"]
    assert spec["hookEventName"] == "UserPromptSubmit"
    text = spec["additionalContext"]
    assert f"The user answered Askaway question {item} (Cache backend): B · In-process." in text
    assert "(you were using A · Redis)" in text
    marker = stored(home, "d", item)
    assert marker["id"] == item and marker["session"] == SESSION
    assert run_hook(capsys, monkeypatch, "deliver", deliver_event()) == ""


def test_deliver_omits_you_were_using_when_answer_is_recommended(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    cli(capsys, "answer", item, "A")
    out = hook_json(capsys, monkeypatch, "deliver", deliver_event())
    text = out["hookSpecificOutput"]["additionalContext"]
    assert "you were using" not in text


@pytest.mark.parametrize(("answer_key", "expected"), [
    ("A", "The user answered Askaway question {item} (Cache backend): A · Redis."),
    ("B", ("The user answered Askaway question {item} (Cache backend): B · In-process."
           " (you were using A · Redis)")),
])
def test_deliver_line_is_the_model_facing_sentence(answer_key, expected, home, capsys,
                                                    monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    cli(capsys, "answer", item, answer_key)
    out = hook_json(capsys, monkeypatch, "deliver", deliver_event())
    assert out["hookSpecificOutput"]["additionalContext"] == expected.format(item=item)


def test_deliver_line_quotes_an_other_answer_as_the_users_own_words(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    answer = {"id": item, "key": "other", "text": "Use SQLite", "by": "panel", "ts": askaway.now_ms()}
    (home / "a").mkdir(exist_ok=True)
    (home / "a" / f"{item}.json").write_text(json.dumps(answer), encoding="utf-8")
    out = hook_json(capsys, monkeypatch, "deliver", deliver_event())
    expected = (f'The user answered Askaway question {item} (Cache backend): '
                'their own answer (Other): "Use SQLite". (you were using A · Redis)')
    assert out["hookSpecificOutput"]["additionalContext"] == expected


def test_deliver_sends_an_other_free_text_answer(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    answer = {"id": item, "key": "other", "text": " Use SQLite ", "by": "panel", "ts": askaway.now_ms()}
    (home / "a").mkdir(exist_ok=True)
    (home / "a" / f"{item}.json").write_text(json.dumps(answer), encoding="utf-8")
    out = hook_json(capsys, monkeypatch, "deliver", deliver_event())
    text = out["hookSpecificOutput"]["additionalContext"]
    assert '(Cache backend): their own answer (Other): "Use SQLite".' in text
    assert "(you were using A · Redis)" in text


def test_status_and_list_show_an_other_answer_text(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    (home / "a").mkdir(exist_ok=True)
    answer = {"id": item, "key": "other", "text": "Use\n  SQLite " + "x" * 600, "by": "panel", "ts": askaway.now_ms()}
    (home / "a" / f"{item}.json").write_text(json.dumps(answer), encoding="utf-8")
    status = askaway.cmd_status(item)
    assert status["key"] == "other" and status["text"].startswith("Use SQLite x")
    assert len(status["text"]) == askaway.OTHER_TEXT_MAX
    listed = askaway.cmd_list(False)["items"][0]
    assert listed["text"] == status["text"]


def test_deliver_ignores_an_other_answer_without_text(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    answer = {"id": item, "key": "other", "text": "  ", "by": "panel", "ts": askaway.now_ms()}
    (home / "a").mkdir(exist_ok=True)
    (home / "a" / f"{item}.json").write_text(json.dumps(answer), encoding="utf-8")
    assert run_hook(capsys, monkeypatch, "deliver", deliver_event()) == ""


def test_deliver_skips_other_sessions(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    cli(capsys, "answer", item, "B")
    assert run_hook(capsys, monkeypatch, "deliver", deliver_event(session="other")) == ""
    assert not (home / "d" / f"{item}.json").exists()


def test_deliver_matches_null_session_by_project(home, capsys, monkeypatch):
    item = ask_item(capsys)
    cli(capsys, "answer", item, "B")
    text = hook_json(capsys, monkeypatch, "deliver",
                     deliver_event(session="any-session"))["hookSpecificOutput"]["additionalContext"]
    assert item in text


def test_deliver_skips_null_session_from_another_project(home, capsys, monkeypatch):
    item = ask_item(capsys)
    cli(capsys, "answer", item, "B")
    assert run_hook(capsys, monkeypatch, "deliver",
                    deliver_event(session="any-session", cwd="/elsewhere")) == ""
    assert not (home / "d" / f"{item}.json").exists()


def subagent_event(session=SESSION, agent_id="agent-1") -> dict:
    return {**deliver_event(session), "hook_event_name": "PostToolUse", "agent_id": agent_id}


def test_deliver_skips_subagent_events_without_writing_a_marker(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    cli(capsys, "answer", item, "B")
    assert run_hook(capsys, monkeypatch, "deliver", subagent_event()) == ""
    assert not (home / "d" / f"{item}.json").exists()


def test_deliver_on_main_thread_post_tool_use_delivers_and_marks(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    cli(capsys, "answer", item, "B")
    event = {**deliver_event(), "hook_event_name": "PostToolUse"}
    text = hook_json(capsys, monkeypatch, "deliver", event)["hookSpecificOutput"]["additionalContext"]
    assert item in text
    assert (home / "d" / f"{item}.json").exists()


def test_subagent_event_then_main_thread_event_delivers_once_to_the_main_thread(
        home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    cli(capsys, "answer", item, "B")
    assert run_hook(capsys, monkeypatch, "deliver", subagent_event()) == ""
    text = hook_json(capsys, monkeypatch, "deliver", deliver_event())["hookSpecificOutput"]["additionalContext"]
    assert item in text
    assert run_hook(capsys, monkeypatch, "deliver", deliver_event()) == ""


def test_deliver_ignores_corrupt_files(home, capsys, monkeypatch):
    (home / "q").mkdir(parents=True)
    (home / "a").mkdir(parents=True)
    (home / "q" / "q-bad-000000.json").write_text("{trunc", encoding="utf-8")
    (home / "a" / "q-bad-000000.json").write_text('{"key": "A"}', encoding="utf-8")
    assert run_hook(capsys, monkeypatch, "deliver", deliver_event()) == ""
    assert not (home / "d" / "q-bad-000000.json").exists()


# ---- prune -------------------------------------------------------------

def test_prune_removes_only_old_delivered_items(home, clock, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    base = 1_000_000_000_000
    clock["ms"] = base
    old_done = ask_item(capsys, title="old, delivered")
    old_open = ask_item(capsys, title="old, open")
    cli(capsys, "answer", old_done, "A")
    run_hook(capsys, monkeypatch, "deliver", deliver_event())
    clock["ms"] = base + 20 * DAY_MS
    recent = ask_item(capsys, title="recent, delivered")
    cli(capsys, "answer", recent, "A")
    run_hook(capsys, monkeypatch, "deliver", deliver_event())
    clock["ms"] = base + 31 * DAY_MS
    assert cli(capsys, "prune", "--days", "30") == {"removed": 1}
    assert not (home / "q" / f"{old_done}.json").exists()
    assert not (home / "a" / f"{old_done}.json").exists()
    assert not (home / "d" / f"{old_done}.json").exists()
    assert (home / "q" / f"{old_open}.json").exists()
    assert (home / "d" / f"{recent}.json").exists()


# ---- robustness and CLI shape -----------------------------------------

def test_unknown_command_prints_error_json_and_exits_zero(capsys):
    assert "error" in cli(capsys, "bogus")


def test_hook_fails_open_on_bad_stdin(home):
    env = {**os.environ, "ASKAWAY_HOME": str(home)}
    proc = subprocess.run([sys.executable, str(SCRIPT), "hook", "deliver"], input="not json",
                          capture_output=True, text=True, env=env, timeout=20, check=False)
    assert proc.returncode == 0 and proc.stdout == ""


def test_script_prints_one_json_line(home):
    env = {**os.environ, "ASKAWAY_HOME": str(home)}
    proc = subprocess.run([sys.executable, str(SCRIPT), "away", "status"],
                          capture_output=True, text=True, env=env, timeout=20, check=False)
    assert proc.returncode == 0
    assert json.loads(proc.stdout) == {"away": False}


# ---- review fixes ------------------------------------------------------

def test_ask_without_title_uses_the_question_clipped_to_60(home, capsys):
    entry = base_entry()
    del entry["title"]
    out = cli(capsys, "ask", "--json", json.dumps(entry))
    assert out["action"] == "continue" and "error" not in out
    assert stored(home, "q", out["id"])["title"] == entry["question"]
    long_entry = base_entry(question="w" * 100)
    del long_entry["title"]
    out = cli(capsys, "ask", "--json", json.dumps(long_entry))
    title = stored(home, "q", out["id"])["title"]
    assert len(title) == 60 and title.endswith("…")


def test_deliver_expires_old_answer_from_another_session(home, clock, capsys, monkeypatch):
    base = 1_000_000_000_000
    clock["ms"] = base
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "other-session")
    item = ask_item(capsys)
    cli(capsys, "answer", item, "B")
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID")
    clock["ms"] = base + 8 * DAY_MS
    assert run_hook(capsys, monkeypatch, "deliver", deliver_event()) == ""
    marker = stored(home, "d", item)
    assert marker["session"] is None and marker["expired"] is True
    answered = {p.name for p in (home / "a").iterdir()}
    delivered = {p.name for p in (home / "d").iterdir()}
    assert answered <= delivered
    assert askaway._nothing_to_deliver() is True


def test_deliver_keeps_recent_answer_from_another_session(home, clock, capsys, monkeypatch):
    base = 1_000_000_000_000
    clock["ms"] = base
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "other-session")
    item = ask_item(capsys)
    cli(capsys, "answer", item, "B")
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID")
    clock["ms"] = base + DAY_MS
    assert run_hook(capsys, monkeypatch, "deliver", deliver_event()) == ""
    assert not (home / "d" / f"{item}.json").exists()
    assert askaway._nothing_to_deliver() is False


def test_fast_path_ignores_temp_leftovers(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    cli(capsys, "answer", item, "B")
    run_hook(capsys, monkeypatch, "deliver", deliver_event())
    (home / "a" / ".q-x.json.abcd1234.tmp").write_text("{", encoding="utf-8")
    (home / "d" / ".q-x.json.abcd1234.tmp").write_text("{", encoding="utf-8")
    assert askaway._nothing_to_deliver() is True


def test_prune_removes_stale_temp_files_only(home, capsys):
    (home / "q").mkdir(parents=True)
    old = home / "q" / ".q-old.json.00000000.tmp"
    fresh = home / "q" / ".q-new.json.00000000.tmp"
    old.write_text("{", encoding="utf-8")
    fresh.write_text("{", encoding="utf-8")
    two_days_ago = time.time() - 2 * 86_400
    os.utime(old, (two_days_ago, two_days_ago))
    assert cli(capsys, "prune") == {"removed": 0}
    assert not old.exists() and fresh.exists()


def test_deliver_prunes_at_most_once_a_day(home, clock, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    base = 1_000_000_000_000
    clock["ms"] = base
    old_done = ask_item(capsys)
    cli(capsys, "answer", old_done, "A")
    run_hook(capsys, monkeypatch, "deliver", deliver_event())
    clock["ms"] = base + 40 * DAY_MS
    marker = home / "last_prune"
    marker.write_text("", encoding="utf-8")
    pending = ask_item(capsys)
    cli(capsys, "answer", pending, "A")
    run_hook(capsys, monkeypatch, "deliver", deliver_event())
    assert (home / "q" / f"{old_done}.json").exists()
    stale = time.time() - 2 * 86_400
    os.utime(marker, (stale, stale))
    again = ask_item(capsys)
    cli(capsys, "answer", again, "A")
    run_hook(capsys, monkeypatch, "deliver", deliver_event())
    assert not (home / "q" / f"{old_done}.json").exists()
    assert time.time() - marker.stat().st_mtime < 86_400


def test_fast_path_fails_open_when_stdin_is_closed(home):
    env = {**os.environ, "ASKAWAY_HOME": str(home)}
    command = f'"{sys.executable}" "{SCRIPT}" hook deliver <&-'
    proc = subprocess.run(command, shell=True, capture_output=True, text=True, env=env,
                          timeout=20, check=False)
    assert proc.returncode == 0 and proc.stdout == ""


def test_deliver_failure_does_not_mark_answer_delivered(home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    cli(capsys, "answer", item, "B")
    original = askaway._delivery_line

    def broken(entry, key):
        raise RuntimeError("boom")

    monkeypatch.setattr(askaway, "_delivery_line", broken)
    assert run_hook(capsys, monkeypatch, "deliver", deliver_event()) == ""
    assert not (home / "d" / f"{item}.json").exists()
    monkeypatch.setattr(askaway, "_delivery_line", original)
    assert item in run_hook(capsys, monkeypatch, "deliver", deliver_event())
    assert (home / "d" / f"{item}.json").exists()


@pytest.mark.parametrize("event_name", ["UserPromptSubmit", "SessionStart", "PostToolUse"])
def test_deliver_subprocess_delivers_one_pending_answer(event_name, home, capsys, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    item = ask_item(capsys)
    cli(capsys, "answer", item, "B")
    event = {"session_id": SESSION, "cwd": os.getcwd(), "hook_event_name": event_name}
    env = {**os.environ, "ASKAWAY_HOME": str(home)}
    proc = subprocess.run([sys.executable, str(SCRIPT), "hook", "deliver"],
                          input=json.dumps(event), capture_output=True, text=True, env=env,
                          timeout=20, check=False)
    assert proc.returncode == 0
    spec = json.loads(proc.stdout)["hookSpecificOutput"]
    assert spec["hookEventName"] == event_name
    assert f"Askaway question {item}" in spec["additionalContext"]
    assert (home / "d" / f"{item}.json").exists()


# ---- session title, explanation fields, orphan sweep -------------------

PROJECT_DIR = "-workspace-demo"


def transcript_row(kind: str, field: str, value: str) -> str:
    return json.dumps({"type": kind, field: value, "sessionId": SESSION})


def custom(value: str) -> str:
    return transcript_row("custom-title", "customTitle", value)


def agent(value: str) -> str:
    return transcript_row("agent-name", "agentName", value)


def ai(value: str) -> str:
    return transcript_row("ai-title", "aiTitle", value)


def write_transcript(home: Path, rows: list[str], session: str = SESSION) -> None:
    folder = home.parent / "projects" / PROJECT_DIR
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{session}.jsonl").write_text("\n".join(rows) + "\n", encoding="utf-8")


def release_marker(home: Path, session: str) -> None:
    folder = home.parent / "projects" / PROJECT_DIR
    folder.mkdir(parents=True, exist_ok=True)
    marker = {"v": 1, "releasedAt": "2026-09-24T17:48:34.781Z", "reason": "delete"}
    (folder / f"{session}.desktop-released.json").write_text(json.dumps(marker), encoding="utf-8")


def answer_from(capsys, monkeypatch, session: str, key: str = "B") -> str:
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", session)
    item = ask_item(capsys)
    cli(capsys, "answer", item, key)
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID")
    return item


@pytest.mark.parametrize("rows, expected", [
    ([ai("AI")], "AI"),
    ([custom("First"), custom("Last")], "Last"),
    ([ai("AI"), agent("Agent")], "Agent"),
    ([agent("Agent"), ai("AI")], "Agent"),
    ([ai("AI"), agent("Agent"), custom("Custom")], "Custom"),
])
def test_session_title_follows_the_fallback_order(home, rows, expected):
    write_transcript(home, rows)
    assert askaway.session_title(SESSION) == expected


def test_session_title_is_null_without_a_transcript(home):
    assert askaway.session_title(SESSION) is None
    assert askaway.session_title(None) is None


def test_session_title_is_clipped_to_80_chars(home):
    write_transcript(home, [custom("t" * 200)])
    title = askaway.session_title(SESSION)
    assert len(title) == 80 and title.endswith("…")


def test_session_title_skips_corrupt_lines_and_unsafe_ids(home):
    write_transcript(home, ["{trunc", custom("Ok")])
    assert askaway.session_title(SESSION) == "Ok"
    assert askaway.session_title("*") is None


def test_session_title_lookup_failure_never_fails_the_ask(home, capsys, monkeypatch):
    def broken() -> Path:
        raise PermissionError("denied")

    monkeypatch.setattr(askaway, "projects_root", broken)
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    out = cli(capsys, "ask", "--json", json.dumps(base_entry()))
    assert out["action"] == "continue" and "error" not in out
    assert stored(home, "q", out["id"])["session_title"] is None


def test_ask_files_the_asking_sessions_title(home, capsys, monkeypatch):
    write_transcript(home, [ai("Draft"), custom("Cache work")])
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    out = cli(capsys, "ask", "--json", json.dumps(base_entry()))
    assert stored(home, "q", out["id"])["session_title"] == "Cache work"


def test_ask_files_how_gains_and_losses(home, capsys):
    out = cli(capsys, "ask", "--json", json.dumps(base_entry(
        how="Run one Redis", gains="Shared state", losses="One more service")))
    entry = stored(home, "q", out["id"])
    assert entry["how"] == "Run one Redis"
    assert entry["gains"] == "Shared state" and entry["losses"] == "One more service"


def test_ask_explanation_fields_are_optional(home, capsys):
    out = cli(capsys, "ask", "--json", json.dumps(base_entry()))
    entry = stored(home, "q", out["id"])
    assert entry["how"] is None and entry["gains"] is None and entry["losses"] is None
    assert entry["session_title"] is None
    legacy = {k: v for k, v in entry.items()
              if k not in {"how", "gains", "losses", "session_title"}}
    (home / "q" / f"{out['id']}.json").write_text(json.dumps(legacy), encoding="utf-8")
    assert [item["id"] for item in askaway.cmd_list(False)["items"]] == [out["id"]]


@pytest.mark.parametrize("field, limit", [("how", 400), ("gains", 300), ("losses", 300),
                                          ("context", 600)])
def test_ask_caps_explanation_fields(field, limit, home, capsys):
    out = cli(capsys, "ask", "--json", json.dumps(base_entry(**{field: "x" * (limit + 50)})))
    value = stored(home, "q", out["id"])[field]
    assert len(value) == limit and value.endswith("…")


@pytest.mark.parametrize("field", ["how", "gains", "losses"])
def test_ask_rejects_a_non_string_explanation_field(field, home, capsys):
    out = cli(capsys, "ask", "--json", json.dumps(base_entry(**{field: 5})))
    assert out["action"] == "continue" and out["error"]
    assert not (home / "q").exists() or list((home / "q").glob("*.json")) == []


PROJECT_CWD = "/workspace/demo"  # Claude Code encodes it to PROJECT_DIR


class NoGlobRoot(type(Path())):
    """A projects root whose glob fallback fails the test, so only the direct lookup can answer."""

    def glob(self, pattern: str, *args: object, **kwargs: object) -> object:
        raise AssertionError(f"glob fallback ran for {pattern}")


def no_glob_root(home: Path, monkeypatch) -> None:
    monkeypatch.setattr(askaway, "projects_root", lambda: NoGlobRoot(home.parent / "projects"))


@pytest.mark.parametrize("session", ["*", "../x", "a/b", None, ""])
def test_session_ended_rejects_unsafe_or_missing_session_ids(session, home):
    release_marker(home, "real-session")
    assert askaway.session_ended(session, PROJECT_CWD) is False


def test_session_ended_is_false_when_the_projects_root_cannot_be_read(home, monkeypatch):
    def unreadable() -> Path:
        raise OSError("projects folder unreadable")

    monkeypatch.setattr(askaway, "projects_root", unreadable)
    assert askaway.session_ended(SESSION, PROJECT_CWD) is False


def test_session_ended_finds_the_marker_in_the_projects_own_folder_without_a_glob(home, monkeypatch):
    release_marker(home, SESSION)
    no_glob_root(home, monkeypatch)
    assert askaway.session_ended(SESSION, PROJECT_CWD) is True


def test_session_ended_trusts_the_folder_holding_the_transcript_and_skips_the_glob(home, monkeypatch):
    release_marker(home, "unrelated-session")
    write_transcript(home, [ai("Live")])
    no_glob_root(home, monkeypatch)
    assert askaway.session_ended(SESSION, PROJECT_CWD) is False


def test_session_ended_globs_when_the_cwd_folder_is_not_the_sessions(home):
    (home.parent / "projects" / "-tmp").mkdir(parents=True)
    release_marker(home, SESSION)
    assert askaway.session_ended(SESSION, "/tmp") is True


def test_session_ended_falls_back_to_the_glob_when_the_projects_folder_is_absent(home):
    other = home.parent / "projects" / "-some-other-folder"
    other.mkdir(parents=True)
    (other / f"{SESSION}.desktop-released.json").write_text("{}", encoding="utf-8")
    assert askaway.session_ended(SESSION, PROJECT_CWD) is True


def test_session_title_reads_the_transcript_from_the_projects_own_folder(home, monkeypatch):
    write_transcript(home, [custom("Direct")])
    no_glob_root(home, monkeypatch)
    assert askaway.session_title(SESSION, PROJECT_CWD) == "Direct"


def test_lapse_reason_is_session_ended_when_the_marker_exists_and_the_ttl_lapsed(
        home, clock, monkeypatch):
    base = 1_000_000_000_000
    clock["ms"] = base
    release_marker(home, "gone-session")
    no_glob_root(home, monkeypatch)
    clock["ms"] = base + 8 * DAY_MS
    entry = {"session": "gone-session", "project": PROJECT_CWD}
    assert askaway._lapse_reason(entry, {"ts": base}) == "session-ended"


def test_sweep_marks_answers_of_a_released_session_session_ended(home, capsys, monkeypatch):
    item = answer_from(capsys, monkeypatch, "gone-session")
    release_marker(home, "gone-session")
    assert run_hook(capsys, monkeypatch, "deliver", deliver_event(session="live-session")) == ""
    marker = stored(home, "d", item)
    assert marker["session"] is None and marker["expired"] is True
    assert marker["reason"] == "session-ended"
    assert askaway._nothing_to_deliver() is True


def test_sweep_leaves_live_sessions_alone(home, capsys, monkeypatch):
    item = answer_from(capsys, monkeypatch, "live-session")
    release_marker(home, "unrelated-session")
    assert run_hook(capsys, monkeypatch, "deliver", deliver_event(session="other")) == ""
    assert not (home / "d" / f"{item}.json").exists()
    assert askaway._nothing_to_deliver() is False


def test_ttl_expiry_is_marked_with_reason_ttl(home, clock, capsys, monkeypatch):
    base = 1_000_000_000_000
    clock["ms"] = base
    item = answer_from(capsys, monkeypatch, "other-session")
    clock["ms"] = base + 8 * DAY_MS
    assert run_hook(capsys, monkeypatch, "deliver", deliver_event()) == ""
    marker = stored(home, "d", item)
    assert marker["expired"] is True and marker["reason"] == "ttl"


def test_normal_delivery_carries_no_reason(home, capsys, monkeypatch):
    item = answer_from(capsys, monkeypatch, SESSION)
    hook_json(capsys, monkeypatch, "deliver", deliver_event())
    marker = stored(home, "d", item)
    assert "reason" not in marker and "expired" not in marker


def test_ask_guard_entries_carry_the_session_title(home, capsys, monkeypatch):
    write_transcript(home, [custom("Spec-49 close-out")])
    cli(capsys, "away", "on")
    hook_json(capsys, monkeypatch, "ask-guard", askuser_payload())
    entries = [json.loads(p.read_text(encoding="utf-8")) for p in (home / "q").glob("*.json")]
    assert {e["session_title"] for e in entries} == {"Spec-49 close-out"}


@pytest.mark.parametrize(
    ("command", "is_allowed"),
    [
        ("python3 /a/askaway.py status q-1-abcdef", True),
        ('python3 "/a b/askaway.py" status q-1-abcdef', True),
        ('python3 "${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py" ask --json \'{}\'', True),
        ("python3 $(touch x)askaway.py status q-1-abcdef", False),
        ('python3 "$(touch x)/askaway.py" status q-1-abcdef', False),
        ('python3 "${EVIL}/askaway.py" status q-1-abcdef', False),
        ("python3 /a/askaway.py answer q-1-abcdef A", False),
        ('python3 "${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py" status q-1-abcdef; touch x', False),
    ],
)
def test_pause_guard_lets_through_only_simple_quoted_or_plugin_root_calls(command, is_allowed):
    assert bool(askaway.INBOX_CALL.match(command)) is is_allowed
