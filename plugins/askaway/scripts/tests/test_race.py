"""Race tests for the CLI answer path: concurrent `answer` processes for one question (SPEC.md, a/<id>.json).

Each writer is its own `askaway.py answer` process, so the race is between real processes. The first writer wins:
exactly one process reports `written: true`, and the answer file holds that writer's record and nothing else.
"""
import json
import os
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "askaway.py"
SESSION = "sess-race"
OTHER_SESSION = "sess-race-other"
WRITERS = 20
ENTRY = {
    "title": "Race cache",
    "question": "Which cache should the service use?",
    "options": [
        {"key": "A", "label": "Redis", "tradeoff": "one more service to run", "fit": 88,
         "does": "The API caches responses in Redis.", "pros": "Shared across workers.", "cons": "One more service."},
        {"key": "B", "label": "In-process", "tradeoff": "lost on restart", "fit": 40,
         "does": "Each worker caches in memory.", "pros": "No service to run.", "cons": "Lost on restart."},
    ],
    "recommended": "A",
    "what": "Redis is a cache server that runs next to the API. The service would keep its responses there.",
    "problem": "Without a decision, each worker keeps its own cache and the API slows down after a restart.",
    "context": "Sizing the API for three workers.",
    "why": "Shared across workers.",
    "how": "Redis runs as a service next to the API.",
    "gains": "Hits are shared across workers.",
    "losses": "One more service to run.",
    "analogy": "A shared locker instead of one per worker.",
    "urgency": "Can wait",
    "undo": "changing later ~10 min",
    "risk": "low",
}


@pytest.fixture
def state(tmp_path) -> Path:
    return tmp_path / "inbox"


def session_env(state: Path, session: str) -> dict[str, str]:
    """The environment of one writer: the state folder, a name, and the session the process runs in."""
    inherited = {k: v for k, v in os.environ.items() if not k.startswith(("CODEX_", "CLAUDE_CODE_"))}
    return {**inherited, "ASKAWAY_HOME": str(state), "ASKAWAY_WHO": "racer", "CLAUDE_CODE_SESSION_ID": session,
            "ASKAWAY_DESKTOP_SESSIONS": str(state.parent / "desktop")}


def run_cli(state: Path, session: str, *args: str) -> dict:
    proc = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True,
                          env=session_env(state, session), cwd=state.parent, timeout=60, check=False)
    assert proc.returncode == 0, proc.stderr
    assert len(proc.stdout.splitlines()) == 1
    return json.loads(proc.stdout)


def ask(state: Path) -> str:
    return run_cli(state, SESSION, "ask", "--json", json.dumps(ENTRY))["id"]


def race(state: Path, item: str, attempts: list[tuple[str, str]]) -> list[dict]:
    """One `answer` process per (session, key); every process waits at the barrier, then they all start."""
    start = threading.Barrier(len(attempts))

    def answer(attempt: tuple[str, str]) -> dict:
        session, key = attempt
        start.wait(timeout=30)
        return run_cli(state, session, "answer", item, key)

    with ThreadPoolExecutor(max_workers=len(attempts)) as pool:
        return list(pool.map(answer, attempts))


def stored_answer(state: Path, item: str) -> dict:
    return json.loads((state / "a" / f"{item}.json").read_text(encoding="utf-8"))


def test_twenty_concurrent_answers_write_exactly_one_answer(state):
    item = ask(state)
    keys = ["A" if n % 2 == 0 else "B" for n in range(WRITERS)]
    results = race(state, item, [(SESSION, key) for key in keys])

    assert all("error" not in result for result in results)
    written = [result for result in results if result["written"] is True]
    assert len(written) == 1
    winner = written[0]
    assert {result["key"] for result in results} == {winner["key"]}
    stored = stored_answer(state, item)
    assert stored["key"] == winner["key"] and stored["by"] == "agent" and stored["who"] == "racer"
    assert stored["session"] == SESSION
    assert [path.name for path in (state / "a").iterdir()] == [f"{item}.json"]


def test_a_foreign_session_writer_racing_nineteen_others_is_refused_and_claims_nothing(state):
    item = ask(state)
    results = race(state, item, [(SESSION, "A")] * (WRITERS - 1) + [(OTHER_SESSION, "B")])

    foreign, same_session = results[-1], results[:-1]
    # Refused while the slot is free; once a reply exists it gets the stored key, unwritten.
    refused = "error" in foreign and "written" not in foreign
    told_stored = foreign.get("written") is False and foreign.get("key") == "A"
    assert refused or told_stored
    assert [result["written"] for result in same_session].count(True) == 1
    assert stored_answer(state, item)["key"] == "A"
    assert [path.name for path in (state / "a").iterdir()] == [f"{item}.json"]
