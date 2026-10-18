#!/usr/bin/env python3
"""Askaway inbox: the CLI agents call and the hook modes that guard and deliver questions.

State lives in one JSON file per item under ASKAWAY_HOME (default
~/.claude/state/askaway): q/ questions, a/ answers (first writer wins),
d/ delivery markers and away.json. Contract: SPEC.md next to this plugin.
Hook modes fail open: any error exits 0 with no output.
"""
import os
import sys

if sys.version_info < (3, 12):  # runs before any statement that could fail on an older Python
    print('{"error": "askaway needs Python 3.12 or newer"}')
    sys.exit(0)


def _json_names(folder: str) -> set[str]:
    return {name for name in os.listdir(folder) if name.endswith(".json")}


def _nothing_to_deliver() -> bool:
    """Is every answer already marked in d/? Runs before the heavy imports."""
    default_home = os.path.join(os.path.expanduser("~"), ".claude", "state", "askaway")
    home = os.environ.get("ASKAWAY_HOME") or default_home
    try:
        answered = _json_names(os.path.join(home, "a"))
    except OSError:
        return True
    try:
        delivered = _json_names(os.path.join(home, "d"))
    except OSError:
        delivered = set()
    return answered <= delivered


def _exit_if_idle() -> None:
    try:
        if sys.argv[1:3] == ["hook", "deliver"] and _nothing_to_deliver():
            sys.stdin.read()
            sys.exit(0)
    except Exception:  # noqa: BLE001 - fail open: a broken fast path still exits 0 with no output
        sys.exit(0)


if __name__ == "__main__":
    _exit_if_idle()

import argparse
import contextlib
import csv
import getpass
import io
import json
import math
import re
import shlex
import stat
import string
import time
import unicodedata
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final, NamedTuple, NoReturn

HookOutput = dict[str, Any] | None

DEFAULT_HOME: Final = Path.home() / ".claude" / "state" / "askaway"
SCRIPT_PATH: Final = Path(__file__).resolve()
ID_PATTERN: Final = re.compile(r"q-[0-9a-z]+-[0-9a-f]{6}")
BASE36: Final = string.digits + string.ascii_lowercase
RUN_KINDS: Final = frozenset({"main", "subagent", "goal", "loop", "bash", "codex"})
RISKS: Final = frozenset({"low", "medium", "high"})
ANSWER_SOURCES: Final = frozenset({"panel", "accept_recommended", "accept_all", "cli"})
WHO_ENV: Final = "ASKAWAY_WHO"
WHO_MAX: Final = 40
UNKNOWN_WHO: Final = "unknown"
CONTROL_CHARS: Final = re.compile(r"[\x00-\x1f\x7f-\x9f]")
MIN_OPTIONS: Final = 2
TITLE_MAX: Final = 60
QUESTION_MAX: Final = 400
CONTEXT_MAX: Final = 600
HOW_MAX: Final = 400
WHAT_MAX: Final = 600
PROBLEM_MAX: Final = 400
TEXT_MAX: Final = 300
TEXT_CAPS: Final = {"context": CONTEXT_MAX, "how": HOW_MAX, "what": WHAT_MAX, "problem": PROBLEM_MAX}
REQUIRED_TEXT: Final = ("what", "problem", "context", "why", "how", "gains", "losses", "analogy",
                        "urgency", "undo")
REQUIRED_OPTION_TEXT: Final = ("does", "pros", "cons")
MIN_SENTENCES: Final = 2
SENTENCE_END: Final = re.compile(r"[.!?]+(?:\s|$)")
RECOMMENDED_MARKER: Final = re.compile(r"\s*\((?:recommended|recomendad[oa])\)\s*$", re.IGNORECASE)
SESSION_TITLE_MAX: Final = 80
SESSION_PATTERN: Final = re.compile(r"[A-Za-z0-9_-]{1,128}")
# Title entry types in precedence order: the last custom title wins, then agent name, then AI title.
TITLE_FIELDS: Final = (("custom-title", "customTitle"), ("agent-name", "agentName"),
                       ("ai-title", "aiTitle"))
TITLE_FIELD_BY_TYPE: Final = dict(TITLE_FIELDS)
TITLE_LINE: Final = re.compile(r'"(?:custom-title|agent-name|ai-title)"')
DAY_MS: Final = 86_400_000
DEFAULT_PRUNE_DAYS: Final = 30
PRUNE_DAYS_ENV: Final = "ASKAWAY_PRUNE_DAYS"
PRUNE_DAYS_TEXT: Final = re.compile(r"[0-9]{1,6}")
UNDELIVERED_TTL_MS: Final = 7 * DAY_MS
PRUNE_INTERVAL_S: Final = 86_400
RELEASED_SUFFIX: Final = ".desktop-released.json"
TEMP_STALE_S: Final = 86_400
CLOSED_STATUSES: Final = frozenset({"delivered", "expired"})
WAIT_DEFAULT_S: Final = 300.0
WAIT_POLL_S: Final = 0.5
DURATION: Final = re.compile(r"([0-9]+)([mhd])")
DURATION_MS: Final = {"m": 60_000, "h": 3_600_000, "d": DAY_MS}
# Read-only MCP tools (mcp__<server>__<tool>): one read verb in the tool name and no write verb.
READ_ONLY_WORDS: Final = frozenset({"get", "list", "read", "search", "query", "find", "describe", "show"})
WRITE_WORDS: Final = frozenset({
    "add", "apply", "create", "delete", "edit", "exec", "execute", "insert", "keep", "kill", "move",
    "patch", "post", "purge", "push", "put", "register", "remove", "reset", "run", "save", "send",
    "set", "start", "stop", "update", "write"})
# One simple `askaway.py ask|status|list|wait|export` call. The path token excludes shell metacharacters,
# so a command substitution in the path never matches. The path may be quoted, and a quoted path
# may start with the literal ${CLAUDE_PLUGIN_ROOT} (the form the Askaway skill teaches).
_PATH_CHARS = r"[^\s;&|`$<>()\"]*"
_QUOTED_CHARS = r"[^;&|`$<>()\"\\\n]*"
INBOX_CALL: Final = re.compile(
    r"^\s*(?:/usr/bin/)?python3(?:\.\d+)?\s+"
    rf"(?:{_PATH_CHARS}askaway\.py|\"(?:\$\{{CLAUDE_PLUGIN_ROOT\}})?{_QUOTED_CHARS}askaway\.py\")"
    r"\s+(?:ask|status|list|wait|export)\b[^;&|`$<>\n]*$"
)


class Origin(NamedTuple):
    session: str | None
    project: str
    run_kind: str
    source: str


# ---- state folder ------------------------------------------------------

def state_home() -> Path:
    override = os.environ.get("ASKAWAY_HOME")
    return Path(override) if override else DEFAULT_HOME


def item_path(folder: str, item_id: str) -> Path:
    if not ID_PATTERN.fullmatch(item_id):
        raise ValueError("invalid inbox id")
    return state_home() / folder / f"{item_id}.json"


def away_path() -> Path:
    return state_home() / "away.json"


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def to_base36(number: int) -> str:
    digits = ""
    while number:
        number, remainder = divmod(number, 36)
        digits = BASE36[remainder] + digits
    return digits or "0"


def new_id(ms: int) -> str:
    return f"q-{to_base36(ms)}-{os.urandom(3).hex()}"


def _write_temp(target: Path, data: Mapping[str, Any]) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.{os.urandom(4).hex()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
            handle.flush()
            os.fsync(handle.fileno())
        if target.exists():
            os.chmod(tmp, stat.S_IMODE(target.stat().st_mode))
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return tmp


def _fsync_dir(folder: Path) -> None:
    fd = os.open(folder, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_atomic(target: Path, data: Mapping[str, Any]) -> None:
    tmp = _write_temp(target, data)
    try:
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
    _fsync_dir(target.parent)


def create_once(target: Path, data: Mapping[str, Any]) -> bool:
    """Publish data at target unless it exists; os.link fails atomically on existence."""
    tmp = _write_temp(target, data)
    try:
        os.link(tmp, target)
    except FileExistsError:
        return False
    finally:
        tmp.unlink(missing_ok=True)
    _fsync_dir(target.parent)
    return True


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def load_questions() -> list[dict[str, Any]]:
    loaded = []
    for path in (state_home() / "q").glob("*.json"):
        entry = read_json(path)
        if entry and entry.get("id") == path.stem and isinstance(entry.get("ts"), int):
            loaded.append(entry)
    return sorted(loaded, key=lambda entry: (entry["ts"], entry["id"]), reverse=True)


def answer_lapsed(answer: Mapping[str, Any]) -> bool:
    """Is the answer older than the TTL, so it expires unread instead of waiting for a session?"""
    ts = answer.get("ts")
    return isinstance(ts, int) and ts < now_ms() - UNDELIVERED_TTL_MS


def item_status(item_id: str) -> tuple[str, str | None]:
    answer = read_json(item_path("a", item_id))
    key = answer.get("key") if answer else None
    if item_path("d", item_id).exists():
        marker = read_json(item_path("d", item_id)) or {}
        return ("expired" if marker.get("expired") is True else "delivered"), key
    if item_path("a", item_id).exists():
        return ("expired" if answer and answer_lapsed(answer) else "answered"), key
    return "open", None


OTHER_TEXT_MAX = 500


def other_text(answer: Mapping[str, Any] | None) -> str | None:
    """The free text of an "Other" answer, on one line and capped, or None."""
    if not answer or answer.get("key") != "other" or not isinstance(answer.get("text"), str):
        return None
    text = " ".join(answer["text"].split())[:OTHER_TEXT_MAX]
    return text or None


def away_on() -> bool:
    data = read_json(away_path())
    return data is not None and data.get("on") is True


def is_away(permission_mode: object) -> bool:
    return (permission_mode == "bypassPermissions" or away_on()
            or os.environ.get("CLAUDE_CODE_SESSION_ATTENDED") == "0")


# ---- entry validation --------------------------------------------------

def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _text(value: object, limit: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("text fields must be strings")  # noqa: TRY004 - CLI validation channel
    text = value.strip()
    return _clip(text, limit) if text else None


def _strict_text(value: object, limit: int) -> str | None:
    """A required text field: None when it is missing, blank or not a string."""
    return _text(value, limit) if isinstance(value, str) else None


def _strict_fit(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
        return None
    return value


def _flag(value: object) -> bool:
    if value is None:
        return False
    if not isinstance(value, bool):
        raise ValueError("pause must be true or false")  # noqa: TRY004 - CLI validation channel
    return value


def _choice(value: object, allowed: frozenset[str], name: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise ValueError(f"{name} must be one of: {', '.join(sorted(allowed))}")
    return value


def _option(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("each option must be an object")  # noqa: TRY004 - CLI validation channel
    key = raw.get("key")
    if not isinstance(key, str) or not key.strip():
        raise ValueError("option key must be a non-empty string")
    label = _text(raw.get("label"), TEXT_MAX)
    if label is None:
        raise ValueError("option label is required")
    return {"key": key.strip(), "label": label,
            "tradeoff": _strict_text(raw.get("tradeoff"), TEXT_MAX),
            "fit": _strict_fit(raw.get("fit")),
            **{name: _strict_text(raw.get(name), TEXT_MAX) for name in REQUIRED_OPTION_TEXT}}


def _options(raw_options: object) -> list[dict[str, Any]]:
    if not isinstance(raw_options, list) or len(raw_options) < MIN_OPTIONS:
        raise ValueError(f"options must be a list of at least {MIN_OPTIONS} items")
    options = [_option(raw) for raw in raw_options]
    keys = [option["key"] for option in options]
    if len(set(keys)) != len(keys):
        raise ValueError("option keys must be unique")
    return options


def _sentence_count(text: str) -> int:
    """Sentences as the non-empty runs between terminators ('.', '!', '?' before a space or the end)."""
    return sum(1 for part in SENTENCE_END.split(text) if part.strip())


def _sentence_gaps(texts: Mapping[str, str | None]) -> list[str]:
    what = texts["what"]
    if what is None or _sentence_count(what) >= MIN_SENTENCES:
        return []
    return [f"what needs at least {MIN_SENTENCES} sentences"]


def _option_gaps(options: Sequence[Mapping[str, Any]]) -> list[str]:
    return [f"option {option['key']}: {name}" for option in options
            for name in ("tradeoff", "fit", *REQUIRED_OPTION_TEXT) if option[name] is None]


def _entry_gaps(texts: Mapping[str, str | None], options: Sequence[Mapping[str, Any]]) -> list[str]:
    missing = [name for name in REQUIRED_TEXT if texts[name] is None]
    gaps = [f"missing fields: {', '.join(missing)}"] if missing else []
    return gaps + _sentence_gaps(texts) + _option_gaps(options)


def build_entry(raw: Mapping[str, Any], origin: Origin) -> dict[str, Any]:
    question = _text(raw.get("question"), QUESTION_MAX)
    if question is None:
        raise ValueError("question is required")
    title = _text(raw.get("title"), TITLE_MAX) or _clip(question, TITLE_MAX)
    options = _options(raw.get("options"))
    recommended = raw.get("recommended")
    if recommended not in [option["key"] for option in options]:
        raise ValueError("recommended must be one of the option keys")
    risk = _choice(raw.get("risk") or "low", RISKS, "risk")
    run_kind = _choice(raw.get("run_kind") or origin.run_kind, RUN_KINDS, "run_kind")
    texts = {name: _strict_text(raw.get(name), TEXT_CAPS.get(name, TEXT_MAX))
             for name in REQUIRED_TEXT}
    gaps = _entry_gaps(texts, options)
    if gaps:
        raise ValueError("; ".join(gaps))
    _flag(raw.get("pause"))  # still type-checked; only risk "high" pauses (SPEC: ask)
    now = now_ms()
    return {
        "v": 1, "id": new_id(now), "ts": now,
        "project": origin.project, "session": origin.session, "run_kind": run_kind,
        "session_title": session_title(origin.session, origin.project),
        "title": title, "question": question,
        "options": options, "recommended": recommended,
        **texts,
        "risk": risk, "pause": risk == "high",
        "source": origin.source,
    }


def store_entry(entry: Mapping[str, Any]) -> None:
    write_atomic(item_path("q", entry["id"]), entry)


def option_label(entry: Mapping[str, Any], key: object) -> str | None:
    options = entry.get("options") or []
    return next((option["label"] for option in options if option["key"] == key), None)


def option_keys(entry: Mapping[str, Any]) -> list[str]:
    return [option["key"] for option in entry.get("options") or []]


# ---- CLI commands ------------------------------------------------------

def caller_session() -> str | None:
    return os.environ.get("CLAUDE_CODE_SESSION_ID") or None


def cli_origin() -> Origin:
    session = caller_session()
    codex = session is None and any(name.startswith("CODEX_") for name in os.environ)
    return Origin(session=session, project=os.getcwd(), run_kind="codex" if codex else "main",
                  source="cli")


def projects_root() -> Path:
    return Path.home() / ".claude" / "projects"


def project_folder(project: str | None) -> Path | None:
    """Claude Code's folder for a project cwd: every character outside [A-Za-z0-9] becomes '-'."""
    if not project:
        return None
    return projects_root() / re.sub(r"[^A-Za-z0-9]", "-", project)


def _session_file(session: str | None, suffix: str, project: str | None) -> Path | None:
    """The session's file in its project folder; glob all folders unless that folder holds the session."""
    if not session or not SESSION_PATTERN.fullmatch(session):
        return None
    name = f"{session}{suffix}"
    folder = project_folder(project)
    if folder is not None:
        candidate = folder / name
        if candidate.is_file():
            return candidate
        if (folder / f"{session}.jsonl").is_file():
            return None  # the session lives here, so the file does not exist anywhere
    return next(projects_root().glob(f"*/{name}"), None)


def _title_rows(path: Path) -> dict[str, str]:
    """The last title text per title entry type, streamed; unparsable lines are skipped."""
    latest: dict[str, str] = {}
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if not TITLE_LINE.search(line):
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            kind = row.get("type") if isinstance(row, dict) else None
            if not isinstance(kind, str) or kind not in TITLE_FIELD_BY_TYPE:
                continue
            text = row.get(TITLE_FIELD_BY_TYPE[kind])
            if isinstance(text, str) and text.strip():
                latest[kind] = text.strip()
    return latest


def session_title(session: str | None, project: str | None = None) -> str | None:
    """The asking session's window title: last custom, else agent, else AI title. Never raises."""
    try:
        path = _session_file(session, ".jsonl", project)
        latest = _title_rows(path) if path else {}
    except (OSError, ValueError):
        return None
    for kind, _ in TITLE_FIELDS:
        if kind in latest:
            return _clip(latest[kind], SESSION_TITLE_MAX)
    return None


class ReleasedScan:
    """The sessions Claude Desktop released, from one folder-wide glob shared by a whole hook run."""

    def __init__(self) -> None:
        self._sessions: frozenset[str] | None = None

    def sessions(self) -> frozenset[str]:
        if self._sessions is None:
            self._sessions = frozenset(path.name.removesuffix(RELEASED_SUFFIX)
                                       for path in projects_root().glob(f"*/*{RELEASED_SUFFIX}"))
        return self._sessions


def session_ended(session: str | None, project: str | None = None,
                  released: ReleasedScan | None = None) -> bool:
    """Has Claude Desktop released this session (a desktop-released.json marker exists)?

    The session's own project folder is checked first. The folder-wide scan runs only when that
    folder does not hold the session, and at most once per `released`.
    """
    if not session or not SESSION_PATTERN.fullmatch(session):
        return False
    try:
        folder = project_folder(project)
        if folder is not None:
            if (folder / f"{session}{RELEASED_SUFFIX}").is_file():
                return True
            if (folder / f"{session}.jsonl").is_file():
                return False
        return session in (released or ReleasedScan()).sessions()
    except OSError:
        return False


def _given_text(raw: object, name: str) -> str | None:
    """A string field as the caller gave it, or None; the error replies echo it back."""
    given = raw.get(name) if isinstance(raw, dict) else None
    return given if isinstance(given, str) else None


def cmd_ask(json_text: str | None) -> dict[str, Any]:
    raw: object = None
    try:
        raw = json.loads(json_text if json_text is not None else sys.stdin.read())
        if not isinstance(raw, dict):
            raise ValueError("the entry must be a JSON object")  # noqa: TRY004 - CLI validation channel
        origin = cli_origin()
        entry = build_entry(raw, origin)
        store_entry(entry)
    except ValueError as exc:  # the entry is incomplete or invalid: the agent files it again
        return {"action": "refile", "recommended": _given_text(raw, "recommended"), "error": str(exc)}
    except Exception:  # noqa: BLE001 - the agent always gets an answer; a high-risk one never continues
        high = _given_text(raw, "risk") == "high"
        return {"action": "pause" if high else "continue",
                "recommended": _given_text(raw, "recommended"), "error": "internal error"}
    return {"id": entry["id"], "recommended": entry["recommended"],
            "action": "pause" if entry["pause"] else "continue"}


def answer_session(entry: Mapping[str, Any], by: str) -> str | None:
    """The session an answer is bound to. A shell answer must come from the question's own session."""
    asked = entry.get("session")
    if by != "cli":
        return asked  # the panel answers for the user, so no shell session is required
    caller = caller_session()
    if asked and caller != asked:
        raise ValueError("answer refused: this question belongs to another session; answer it "
                         "from the Askaway panel or from its own session")
    return caller or asked


def _who_text(raw: str) -> str | None:
    """A name on one line and capped: control characters become spaces, the ends are trimmed."""
    flat = " ".join(CONTROL_CHARS.sub(" ", raw).split())
    return _clip(flat, WHO_MAX) if flat else None


def answerer_name() -> str:
    """Who answered: ASKAWAY_WHO when it holds a name, else the OS user name, else "unknown"."""
    try:
        os_user = getpass.getuser()
    except (KeyError, OSError):
        os_user = ""
    return _who_text(os.environ.get(WHO_ENV, "")) or _who_text(os_user) or UNKNOWN_WHO


def answer_who(answer: Mapping[str, Any] | None) -> str | None:
    """The name stamped on an answer, or None for a record written without one."""
    who = (answer or {}).get("who")
    return who if isinstance(who, str) and who else None


def cmd_answer(item_id: str, key: str, by: str) -> dict[str, Any]:
    if by not in ANSWER_SOURCES:
        raise ValueError(f"--by must be one of: {', '.join(sorted(ANSWER_SOURCES))}")
    entry = read_json(item_path("q", item_id))
    if entry is None:
        raise ValueError("unknown inbox id")
    if key not in option_keys(entry):
        raise ValueError("unknown option key")
    record = {"id": item_id, "key": key, "by": by, "who": answerer_name(),
              "session": answer_session(entry, by), "ts": now_ms()}
    if create_once(item_path("a", item_id), record):
        return {"id": item_id, "key": key, "written": True}
    stored = read_json(item_path("a", item_id)) or {}
    return {"id": item_id, "key": stored.get("key"), "written": False}


def cmd_status(item_id: str) -> dict[str, Any]:
    if read_json(item_path("q", item_id)) is None:
        raise ValueError("unknown inbox id")
    status, key = item_status(item_id)
    result = {"id": item_id, "status": status, "key": key}
    answer = read_json(item_path("a", item_id))
    text = other_text(answer)
    if text:
        result["text"] = text
    who = answer_who(answer)
    if who:
        result["who"] = who
    return result


def _list_row(entry: Mapping[str, Any]) -> dict[str, Any]:
    status, key = item_status(entry["id"])
    row = {"id": entry["id"], "title": entry.get("title"), "status": status,
           "recommended": entry.get("recommended"), "key": key}
    answer = read_json(item_path("a", entry["id"]))
    text = other_text(answer) if key == "other" else None
    if text:
        row["text"] = text
    who = answer_who(answer)
    if who:
        row["who"] = who
    return row


def cmd_list(only_open: bool) -> dict[str, Any]:
    items = [_list_row(entry) for entry in load_questions()]
    return {"items": [item for item in items if not only_open or item["status"] == "open"]}


def since_cutoff(text: str) -> int:
    """The earliest timestamp (ms) that passes --since: a duration ago, or an ISO time (no zone means UTC)."""
    match = DURATION.fullmatch(text)
    if match:
        return now_ms() - int(match[1]) * DURATION_MS[match[2]]
    try:
        when = datetime.fromisoformat(text)
    except ValueError:
        raise ValueError("--since must be a duration (30m, 2h, 7d) or an ISO timestamp") from None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return int(when.timestamp() * 1000)


def answered_at(item_id: str) -> int | None:
    ts = (read_json(item_path("a", item_id)) or {}).get("ts")
    return ts if isinstance(ts, int) else None


def cmd_answered(since: str | None) -> dict[str, Any]:
    """Answered items whose answer is at or after --since, newest question first."""
    cutoff = since_cutoff(since) if since is not None else 0
    items = []
    for entry in load_questions():
        answered = answered_at(entry["id"])
        if answered is not None and answered >= cutoff:
            items.append(_list_row(entry))
    return {"items": items}


def cmd_away(state: str) -> dict[str, Any]:
    if state == "status":
        return {"away": away_on()}
    on = state == "on"
    write_atomic(away_path(), {"on": on, "ts": now_ms()})
    return {"away": on}


def _remove_item(item_id: str) -> None:
    # Question first: an interrupted prune leaves orphan answers, never a reopened question.
    for folder in ("q", "a", "d"):
        item_path(folder, item_id).unlink(missing_ok=True)


def _remove_stale_temps() -> None:
    cutoff = time.time() - TEMP_STALE_S
    for folder in (state_home(), state_home() / "q", state_home() / "a", state_home() / "d"):
        for tmp in folder.glob(".*.tmp"):
            with contextlib.suppress(FileNotFoundError):
                if tmp.stat().st_mtime < cutoff:
                    tmp.unlink()


def _settled_ts(item_id: str, status: str) -> int | None:
    """When a closed item closed: its delivery marker, or for an expired answer, the answer."""
    folder = "a" if status == "expired" else "d"
    ts = (read_json(item_path(folder, item_id)) or {}).get("ts")
    return ts if isinstance(ts, int) else None


def prune_days() -> int:
    """The retention window: ASKAWAY_PRUNE_DAYS when it is a whole number of days, else 30."""
    text = os.environ.get(PRUNE_DAYS_ENV, "").strip()
    return int(text) if PRUNE_DAYS_TEXT.fullmatch(text) else DEFAULT_PRUNE_DAYS


def cmd_prune(days: int) -> dict[str, Any]:
    if days < 0:
        raise ValueError("--days must not be negative")
    _remove_stale_temps()
    cutoff = now_ms() - days * DAY_MS
    removed = 0
    for entry in load_questions():
        status = item_status(entry["id"])[0]
        # Only closed items: an undelivered or unexpired record is never pruned, whatever the window.
        if status not in CLOSED_STATUSES:
            continue
        settled = _settled_ts(entry["id"], status)
        if settled is not None and settled < cutoff:
            _remove_item(entry["id"])
            removed += 1
    return {"removed": removed}


def cmd_wait(item_id: str, timeout: float) -> dict[str, Any]:
    if not 0 <= timeout < math.inf:
        raise ValueError("--timeout must be a finite number of seconds, zero or more")
    if read_json(item_path("q", item_id)) is None:
        return {"id": item_id, "status": "unknown id"}
    deadline = time.monotonic() + timeout
    while (answer := read_json(item_path("a", item_id))) is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {"id": item_id, "status": "timeout"}
        time.sleep(min(WAIT_POLL_S, remaining))
    result = {"id": item_id, "status": "answered", "key": answer.get("key")}
    text = other_text(answer)
    if text:
        result["text"] = text
    return result


def cmd_export(since: str | None, fmt: str) -> str:
    """Every question with its answer record, newest first; questions asked before --since are left out."""
    cutoff = since_cutoff(since) if since is not None else 0
    rows = [{"id": entry["id"], "status": item_status(entry["id"])[0], "question": entry,
             "answer": read_json(item_path("a", entry["id"]))}
            for entry in load_questions() if entry["ts"] >= cutoff]
    return render_export(rows, fmt)


EXPORT_COLUMNS: Final = ("id", "status", "question", "answer")


def render_export(rows: list[dict[str, Any]], fmt: str) -> str:
    if fmt == "jsonl":
        return "".join(json.dumps(row) + "\n" for row in rows)
    if fmt == "csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(EXPORT_COLUMNS)
        writer.writerows([row["id"], row["status"], json.dumps(row["question"]), json.dumps(row["answer"])]
                         for row in rows)
        return buffer.getvalue()
    return json.dumps(rows) + "\n"


def _list_command(args: argparse.Namespace) -> dict[str, Any]:
    if args.answered:
        return cmd_answered(args.since)
    if args.since is not None:
        raise ValueError("--since needs --answered")
    return cmd_list(args.only_open)


class _Parser(argparse.ArgumentParser):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(add_help=False, **kwargs)

    def error(self, message: str) -> NoReturn:
        raise ValueError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(prog="askaway.py")
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)

    ask = commands.add_parser("ask")
    ask.add_argument("--json", dest="json_text")
    ask.add_argument("--strict", action="store_true")
    ask.set_defaults(run=lambda a: cmd_ask(a.json_text))

    answer = commands.add_parser("answer")
    answer.add_argument("id")
    answer.add_argument("key")
    answer.add_argument("--by", default="cli")
    answer.add_argument("--strict", action="store_true")
    answer.set_defaults(run=lambda a: cmd_answer(a.id, a.key, a.by))

    status = commands.add_parser("status")
    status.add_argument("id")
    status.add_argument("--strict", action="store_true")
    status.set_defaults(run=lambda a: cmd_status(a.id))

    listing = commands.add_parser("list")
    states = listing.add_mutually_exclusive_group()
    states.add_argument("--open", dest="only_open", action="store_true")
    states.add_argument("--answered", action="store_true")
    listing.add_argument("--since")
    listing.set_defaults(run=_list_command)

    away = commands.add_parser("away")
    away.add_argument("state", choices=("on", "off", "status"))
    away.set_defaults(run=lambda a: cmd_away(a.state))

    prune = commands.add_parser("prune")
    prune.add_argument("--days", type=int, default=prune_days())
    prune.set_defaults(run=lambda a: cmd_prune(a.days))

    wait = commands.add_parser("wait")
    wait.add_argument("id")
    wait.add_argument("--timeout", type=float, default=WAIT_DEFAULT_S)
    wait.set_defaults(run=lambda a: cmd_wait(a.id, a.timeout))

    export = commands.add_parser("export")
    export.add_argument("--since")
    export.add_argument("--format", dest="fmt", choices=("json", "jsonl", "csv"), default="json")
    export.set_defaults(run=lambda a: cmd_export(a.since, a.fmt))
    return parser


# ---- hook modes --------------------------------------------------------

def deny(reason: str) -> dict[str, Any]:
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                   "permissionDecisionReason": reason}}


def _option_context(keyed: Sequence[Mapping[str, Any]]) -> str | None:
    """The option descriptions as '<key>: <description>' lines, empty ones skipped."""
    texts = [(option["key"], str(option["tradeoff"] or "").strip()) for option in keyed]
    return "\n".join(f"{key}: {text}" for key, text in texts if text) or None


def _askuser_options(question: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    options = question.get("options")
    if not isinstance(options, list) or not MIN_OPTIONS <= len(options) <= len(string.ascii_uppercase):
        raise ValueError("AskUserQuestion options are missing or out of range")
    return options


def _recommended_key(keyed: Sequence[Mapping[str, Any]], labels: Sequence[str]) -> str:
    """The option whose label carried the recommended marker, else the first."""
    marked = [option["key"] for option, label in zip(keyed, labels, strict=True)
              if RECOMMENDED_MARKER.search(label)]
    return marked[0] if marked else keyed[0]["key"]


def askuser_skeleton(question: Mapping[str, Any]) -> dict[str, Any]:
    """The AskUserQuestion as a question to file: the explanation fields are left for the agent."""
    options = _askuser_options(question)
    labels = [str(option.get("label") or "") for option in options]
    keyed = [{"key": letter, "label": RECOMMENDED_MARKER.sub("", label).strip() or None,
              "tradeoff": option.get("description"), "fit": None,
              **{name: "" for name in REQUIRED_OPTION_TEXT}}
             for letter, label, option in zip(string.ascii_uppercase, labels, options, strict=False)]
    return {"title": question.get("header"), "question": question.get("question"),
            "context": question.get("context") or _option_context(keyed),
            "options": keyed, "recommended": _recommended_key(keyed, labels),
            "what": "", "problem": "", "why": "", "how": "", "gains": "", "losses": "",
            "analogy": "", "urgency": "", "undo": "", "risk": "low"}


def askuser_reason(skeletons: Sequence[Mapping[str, Any]]) -> str:
    commands = [f"{number}. python3 \"{SCRIPT_PATH}\" ask --json "
                + shlex.quote(json.dumps(skeleton, ensure_ascii=False, separators=(',', ':')))
                for number, skeleton in enumerate(skeletons, start=1)]
    return ("The user is away, so these AskUserQuestion calls are NOT in the Askaway inbox yet. "
            "Before you continue, fill every empty field (\"\" or null) of each skeleton, then file "
            "it with its command: one command per question, keeping the single quotes (write a ' "
            "inside a value as '\\''). Continue on the recommended option unless the reply says "
            "pause.\n" + "\n".join(commands))


def hook_ask_guard(event: Mapping[str, Any]) -> HookOutput:
    if not is_away(event.get("permission_mode")):
        return None
    questions = (event.get("tool_input") or {}).get("questions") or []
    skeletons = [askuser_skeleton(question) for question in questions]
    if not skeletons:
        return None
    return deny(askuser_reason(skeletons))


def is_read_only_mcp(tool_name: object) -> bool:
    """An MCP tool with a read verb and no write verb in its name, e.g. mcp__graphify__get_node."""
    if not isinstance(tool_name, str) or not tool_name.startswith("mcp__"):
        return False
    words = set(tool_name.rsplit("__", 1)[-1].split("_"))
    return bool(words & READ_ONLY_WORDS) and not (words & WRITE_WORDS)


def _exempt_call(tool: object, command: str) -> bool:
    """A call the pause lets through: one simple inbox ask, status, list, wait or export, or a read-only MCP tool."""
    return (tool == "Bash" and INBOX_CALL.match(command) is not None) or is_read_only_mcp(tool)


def hook_pause_guard(event: Mapping[str, Any]) -> HookOutput:
    session = event.get("session_id")
    if not session:
        return None
    tool = event.get("tool_name")
    command = str((event.get("tool_input") or {}).get("command", ""))
    if _exempt_call(tool, command):
        return None
    # A pause holds until the answer is delivered (or lapses): an answered, undelivered item still blocks.
    blocking = next((entry for entry in load_questions()
                     if entry.get("pause") is True and entry.get("session") == session
                     and item_status(entry["id"])[0] not in CLOSED_STATUSES), None)
    if blocking is None:
        return None
    return deny(f"Paused: Askaway question {blocking['id']} ({blocking['title']}) needs the "
                "user's answer. Do read-only work or end the turn; check with "
                f"`python3 {SCRIPT_PATH} status {blocking['id']}`.")


def answered_ids() -> list[str]:
    return sorted(path.stem for path in (state_home() / "a").glob("*.json")
                  if ID_PATTERN.fullmatch(path.stem))


def _receives(entry: Mapping[str, Any], session: str | None, cwd: object) -> bool:
    if entry.get("session"):
        return entry["session"] == session
    return cwd is not None and entry.get("project") == cwd


def _key_text(entry: Mapping[str, Any], key: object) -> str:
    label = option_label(entry, key)
    return f"{key} · {label}" if label else str(key)


def _one_line(text: str) -> str:
    """The text on one line: line breaks and control characters become spaces."""
    flat = "".join(" " if unicodedata.category(char) in ("Cc", "Zl", "Zp") else char for char in text)
    return " ".join(flat.split())


def _delivery_line(entry: Mapping[str, Any], key: object, other: str | None = None) -> str:
    recommended = entry.get("recommended")
    chosen = f'their own answer (Other): "{other}"' if other else _key_text(entry, key)
    line = f"The user answered Askaway question {entry['id']} ({entry['title']}): {chosen}."
    if key != recommended:
        line += f" (you were using {_key_text(entry, recommended)})"
    return _one_line(line)  # a title or label with a line break must not forge a second line


def _lapse_reason(entry: Mapping[str, Any], answer: Mapping[str, Any],
                  released: ReleasedScan | None = None) -> str | None:
    """Why an unread answer is closed now, or None to keep it waiting: its session ended, or the TTL passed."""
    if session_ended(entry.get("session"), entry.get("project"), released):
        return "session-ended"
    return "ttl" if answer_lapsed(answer) else None


def _deliver_one(item_id: str, session: str | None, cwd: object,
                 released: ReleasedScan | None = None) -> str | None:
    marker = item_path("d", item_id)
    if marker.exists():
        return None
    entry = read_json(item_path("q", item_id))
    answer = read_json(item_path("a", item_id))
    if entry is None or answer is None:
        return None
    # A lapsed answer closes for every session, the asking one included: status already says so.
    if not _receives(entry, session, cwd) or answer_lapsed(answer):
        reason = _lapse_reason(entry, answer, released)
        if reason:
            create_once(marker, {"id": item_id, "session": None, "expired": True,
                                 "reason": reason, "ts": now_ms()})
        return None
    key = answer.get("key")
    other = other_text(answer)
    if key not in option_keys(entry) and not other:
        return None
    line = _delivery_line(entry, key, other)
    if not create_once(marker, {"id": item_id, "session": session, "ts": now_ms()}):
        return None
    return line


def _prune_due(marker: Path) -> bool:
    try:
        return time.time() - marker.stat().st_mtime >= PRUNE_INTERVAL_S
    except FileNotFoundError:
        return True


def _maybe_prune() -> None:
    """Opportunistic prune from the deliver slow path, at most once a day. Best effort."""
    marker = state_home() / "last_prune"
    if not _prune_due(marker):
        return
    with contextlib.suppress(OSError):
        cmd_prune(prune_days())
        marker.touch()


def hook_deliver(event: Mapping[str, Any]) -> HookOutput:
    # Main thread only: a subagent's hook call carries the parent's session_id plus an
    # agent_id, so delivering there would consume the answer in a transcript the user never reads.
    if event.get("agent_id"):
        return None
    item_ids = answered_ids()
    event_name = event.get("hook_event_name")
    if not item_ids or not isinstance(event_name, str):
        return None
    _maybe_prune()
    session = event.get("session_id") or None
    cwd = event.get("cwd")
    released = ReleasedScan()  # one folder-wide scan for every answer of this run, at most
    lines: list[str] = []
    for item_id in item_ids:
        try:
            line = _deliver_one(item_id, session, cwd, released)
        except OSError:
            continue  # no marker was written, so the next run retries this answer
        if line:
            lines.append(line)
    if not lines:
        return None
    return {"hookSpecificOutput": {"hookEventName": event_name,
                                   "additionalContext": "\n".join(lines)}}


HOOK_MODES: Final[dict[str, Callable[[Mapping[str, Any]], HookOutput]]] = {
    "ask-guard": hook_ask_guard,
    "pause-guard": hook_pause_guard,
    "deliver": hook_deliver,
}


def run_hook(mode: str) -> None:
    handler = HOOK_MODES.get(mode)
    if handler is None:
        return
    try:
        event = json.load(sys.stdin)
        if not isinstance(event, dict):
            return
        output = handler(event)
    except Exception:  # noqa: BLE001 - fail open: a broken hook must never block the session
        return
    if output is not None:
        print(json.dumps(output))


# ---- entry point -------------------------------------------------------

def dispatch(argv: Sequence[str]) -> dict[str, Any] | str:
    args = build_parser().parse_args(list(argv))
    return args.run(args)


def _failed(result: dict[str, Any] | str) -> bool:
    """A refile or an error: the outcomes that --strict turns into exit 1."""
    return isinstance(result, dict) and ("error" in result or result.get("action") == "refile")


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == ["hook"]:
        run_hook(args[1] if len(args) > 1 else "")
        return 0
    try:
        result: dict[str, Any] | str = dispatch(args)
    except ValueError as exc:
        result = {"error": str(exc)}
    except Exception:  # noqa: BLE001 - the CLI always answers; exit 0 unless --strict
        result = {"error": "internal error"}
    if isinstance(result, str):
        sys.stdout.write(result)  # export writes its document as it is, not as a JSON line
    else:
        print(json.dumps(result))
    # --strict is parsed by ask, answer and status; a usage error that names it exits 1 too.
    return 1 if "--strict" in args and _failed(result) else 0


if __name__ == "__main__":
    sys.exit(main())
