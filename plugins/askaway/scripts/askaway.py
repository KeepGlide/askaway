#!/usr/bin/env python3
"""Askaway inbox: the CLI agents call and the hook modes that guard and deliver questions.

State lives in one JSON file per item under ASKAWAY_HOME (default
~/.claude/state/askaway): q/ questions, a/ answers (first writer wins),
d/ delivery markers and away.json. Contract: SPEC.md next to this plugin.
Hook modes fail open: any error exits 0 with no output.
"""
import os
import sys


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
import json
import re
import stat
import string
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Final, NamedTuple, NoReturn

type HookOutput = dict[str, Any] | None

DEFAULT_HOME: Final = Path.home() / ".claude" / "state" / "askaway"
SCRIPT_PATH: Final = Path(__file__).resolve()
ID_PATTERN: Final = re.compile(r"q-[0-9a-z]+-[0-9a-f]{6}")
BASE36: Final = string.digits + string.ascii_lowercase
RUN_KINDS: Final = frozenset({"main", "subagent", "goal", "loop", "bash", "codex"})
RISKS: Final = frozenset({"low", "medium", "high"})
ANSWER_SOURCES: Final = frozenset({"panel", "accept_recommended", "accept_all", "cli"})
MIN_OPTIONS: Final = 2
TITLE_MAX: Final = 60
QUESTION_MAX: Final = 400
CONTEXT_MAX: Final = 600
HOW_MAX: Final = 400
TEXT_MAX: Final = 300
SESSION_TITLE_MAX: Final = 80
SESSION_PATTERN: Final = re.compile(r"[A-Za-z0-9_-]{1,128}")
# Title entry types in precedence order: the last custom title wins, then agent name, then AI title.
TITLE_FIELDS: Final = (("custom-title", "customTitle"), ("agent-name", "agentName"),
                       ("ai-title", "aiTitle"))
TITLE_FIELD_BY_TYPE: Final = dict(TITLE_FIELDS)
TITLE_LINE: Final = re.compile(r'"(?:custom-title|agent-name|ai-title)"')
DAY_MS: Final = 86_400_000
DEFAULT_PRUNE_DAYS: Final = 30
UNDELIVERED_TTL_MS: Final = 7 * DAY_MS
PRUNE_INTERVAL_S: Final = 86_400
TEMP_STALE_S: Final = 86_400
# One simple `askaway.py ask|status|list` call. The path token excludes shell metacharacters,
# so a command substitution in the path never matches. The path may be quoted, and a quoted path
# may start with the literal ${CLAUDE_PLUGIN_ROOT} (the form the Askaway skill teaches).
_PATH_CHARS = r"[^\s;&|`$<>()\"]*"
_QUOTED_CHARS = r"[^;&|`$<>()\"\\\n]*"
INBOX_CALL: Final = re.compile(
    r"^\s*(?:/usr/bin/)?python3(?:\.\d+)?\s+"
    rf"(?:{_PATH_CHARS}askaway\.py|\"(?:\$\{{CLAUDE_PLUGIN_ROOT\}})?{_QUOTED_CHARS}askaway\.py\")"
    r"\s+(?:ask|status|list)\b[^;&|`$<>\n]*$"
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


def item_status(item_id: str) -> tuple[str, str | None]:
    answer = read_json(item_path("a", item_id))
    key = answer.get("key") if answer else None
    if item_path("d", item_id).exists():
        return "delivered", key
    if item_path("a", item_id).exists():
        return "answered", key
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


def _fit(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
        raise ValueError("fit must be an integer from 0 to 100, or null")
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
            "tradeoff": _text(raw.get("tradeoff"), TEXT_MAX), "fit": _fit(raw.get("fit"))}


def _options(raw_options: object) -> list[dict[str, Any]]:
    if not isinstance(raw_options, list) or len(raw_options) < MIN_OPTIONS:
        raise ValueError(f"options must be a list of at least {MIN_OPTIONS} items")
    options = [_option(raw) for raw in raw_options]
    keys = [option["key"] for option in options]
    if len(set(keys)) != len(keys):
        raise ValueError("option keys must be unique")
    return options


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
    now = now_ms()
    return {
        "v": 1, "id": new_id(now), "ts": now,
        "project": origin.project, "session": origin.session, "run_kind": run_kind,
        "session_title": session_title(origin.session, origin.project),
        "title": title, "question": question,
        "context": _text(raw.get("context"), CONTEXT_MAX),
        "options": options, "recommended": recommended,
        "how": _text(raw.get("how"), HOW_MAX),
        "gains": _text(raw.get("gains"), TEXT_MAX),
        "losses": _text(raw.get("losses"), TEXT_MAX),
        "why": _text(raw.get("why"), TEXT_MAX),
        "analogy": _text(raw.get("analogy"), TEXT_MAX),
        "urgency": _text(raw.get("urgency"), TEXT_MAX),
        "undo": _text(raw.get("undo"), TEXT_MAX),
        "risk": risk, "pause": _flag(raw.get("pause")) or risk == "high",
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

def cli_origin() -> Origin:
    session = os.environ.get("CLAUDE_CODE_SESSION_ID") or None
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


def session_ended(session: str | None, project: str | None = None) -> bool:
    """Has Claude Desktop released this session (a desktop-released.json marker exists)?"""
    try:
        return _session_file(session, ".desktop-released.json", project) is not None
    except OSError:
        return False


def cmd_ask(json_text: str | None) -> dict[str, Any]:
    raw: object = None
    try:
        raw = json.loads(json_text if json_text is not None else sys.stdin.read())
        if not isinstance(raw, dict):
            raise ValueError("the entry must be a JSON object")  # noqa: TRY004 - CLI validation channel
        origin = cli_origin()
        entry = build_entry(raw, origin)
        store_entry(entry)
    except Exception as exc:  # noqa: BLE001 - the agent always gets an answer and continues
        given = raw.get("recommended") if isinstance(raw, dict) else None
        return {"action": "continue", "recommended": given if isinstance(given, str) else None,
                "error": str(exc) if isinstance(exc, ValueError) else "internal error"}
    return {"id": entry["id"], "recommended": entry["recommended"],
            "action": "pause" if entry["pause"] else "continue"}


def cmd_answer(item_id: str, key: str, by: str) -> dict[str, Any]:
    if by not in ANSWER_SOURCES:
        raise ValueError(f"--by must be one of: {', '.join(sorted(ANSWER_SOURCES))}")
    entry = read_json(item_path("q", item_id))
    if entry is None:
        raise ValueError("unknown inbox id")
    if key not in option_keys(entry):
        raise ValueError("unknown option key")
    if create_once(item_path("a", item_id), {"id": item_id, "key": key, "by": by, "ts": now_ms()}):
        return {"id": item_id, "key": key, "written": True}
    stored = read_json(item_path("a", item_id)) or {}
    return {"id": item_id, "key": stored.get("key"), "written": False}


def cmd_status(item_id: str) -> dict[str, Any]:
    if read_json(item_path("q", item_id)) is None:
        raise ValueError("unknown inbox id")
    status, key = item_status(item_id)
    result = {"id": item_id, "status": status, "key": key}
    text = other_text(read_json(item_path("a", item_id)))
    if text:
        result["text"] = text
    return result


def cmd_list(only_open: bool) -> dict[str, Any]:
    items = []
    for entry in load_questions():
        status, key = item_status(entry["id"])
        if only_open and status != "open":
            continue
        item = {"id": entry["id"], "title": entry.get("title"), "status": status,
                "recommended": entry.get("recommended"), "key": key}
        text = other_text(read_json(item_path("a", entry["id"]))) if key == "other" else None
        if text:
            item["text"] = text
        items.append(item)
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


def cmd_prune(days: int) -> dict[str, Any]:
    if days < 0:
        raise ValueError("--days must not be negative")
    _remove_stale_temps()
    cutoff = now_ms() - days * DAY_MS
    removed = 0
    for entry in load_questions():
        if entry["ts"] < cutoff and item_status(entry["id"])[0] == "delivered":
            _remove_item(entry["id"])
            removed += 1
    return {"removed": removed}


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
    ask.set_defaults(run=lambda a: cmd_ask(a.json_text))

    answer = commands.add_parser("answer")
    answer.add_argument("id")
    answer.add_argument("key")
    answer.add_argument("--by", default="cli")
    answer.set_defaults(run=lambda a: cmd_answer(a.id, a.key, a.by))

    status = commands.add_parser("status")
    status.add_argument("id")
    status.set_defaults(run=lambda a: cmd_status(a.id))

    listing = commands.add_parser("list")
    listing.add_argument("--open", dest="only_open", action="store_true")
    listing.set_defaults(run=lambda a: cmd_list(a.only_open))

    away = commands.add_parser("away")
    away.add_argument("state", choices=("on", "off", "status"))
    away.set_defaults(run=lambda a: cmd_away(a.state))

    prune = commands.add_parser("prune")
    prune.add_argument("--days", type=int, default=DEFAULT_PRUNE_DAYS)
    prune.set_defaults(run=lambda a: cmd_prune(a.days))
    return parser


# ---- hook modes --------------------------------------------------------

def deny(reason: str) -> dict[str, Any]:
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                   "permissionDecisionReason": reason}}


def _option_context(keyed: Sequence[Mapping[str, Any]]) -> str | None:
    """The option descriptions as '<key>: <description>' lines, empty ones skipped."""
    texts = [(option["key"], str(option["tradeoff"] or "").strip()) for option in keyed]
    return "\n".join(f"{key}: {text}" for key, text in texts if text) or None


def askuser_entry(question: Mapping[str, Any]) -> dict[str, Any]:
    options = question.get("options")
    if not isinstance(options, list) or len(options) > len(string.ascii_uppercase):
        raise ValueError("AskUserQuestion options are missing or out of range")
    keyed = [{"key": letter, "label": option.get("label"), "tradeoff": option.get("description")}
             for letter, option in zip(string.ascii_uppercase, options, strict=False)]
    marked = [option["key"] for option in keyed if "(Recommended)" in str(option["label"])]
    first = keyed[0]["key"] if keyed else None
    return {"title": question.get("header"), "question": question.get("question"),
            "context": question.get("context") or _option_context(keyed),
            "options": keyed, "recommended": marked[0] if marked else first, "risk": "low"}


def askuser_reason(entries: Sequence[Mapping[str, Any]]) -> str:
    ids = ", ".join(entry["id"] for entry in entries)
    recommended = "; ".join(f"{entry['title']}: {option_label(entry, entry['recommended'])}"
                            for entry in entries)
    return (f"The user is away, so this question went to the Askaway inbox as {ids}. "
            f"Continue with the recommended option ({recommended}). "
            f'Next time file questions with `python3 "{SCRIPT_PATH}" ask` so they '
            "carry why/how/gains/losses/fit/analogy; set \"pause\": true for risky ones "
            "(real files, credentials, irreversible).")


def hook_ask_guard(event: Mapping[str, Any]) -> HookOutput:
    if not is_away(event.get("permission_mode")):
        return None
    questions = (event.get("tool_input") or {}).get("questions") or []
    origin = Origin(session=event.get("session_id") or None,
                    project=str(event.get("cwd") or os.getcwd()),
                    run_kind="main", source="askuserquestion")
    entries = [build_entry(askuser_entry(question), origin) for question in questions]
    if not entries:
        return None
    for entry in entries:
        store_entry(entry)
    return deny(askuser_reason(entries))


def hook_pause_guard(event: Mapping[str, Any]) -> HookOutput:
    session = event.get("session_id")
    if not session:
        return None
    command = str((event.get("tool_input") or {}).get("command", ""))
    if event.get("tool_name") == "Bash" and INBOX_CALL.match(command):
        return None
    blocking = next((entry for entry in load_questions()
                     if entry.get("pause") is True and entry.get("session") == session
                     and item_status(entry["id"])[0] == "open"), None)
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


def _delivery_line(entry: Mapping[str, Any], key: object, other: str | None = None) -> str:
    recommended = entry.get("recommended")
    chosen = f'their own answer (Other): "{other}"' if other else _key_text(entry, key)
    line = f"The user answered Askaway question {entry['id']} ({entry['title']}): {chosen}."
    if key != recommended:
        line += f" (you were using {_key_text(entry, recommended)})"
    return line


def _lapse_reason(entry: Mapping[str, Any], answer: Mapping[str, Any]) -> str | None:
    """Why an answer that no session can receive is closed now, or None to keep it waiting."""
    if session_ended(entry.get("session"), entry.get("project")):
        return "session-ended"
    ts = answer.get("ts")
    if isinstance(ts, int) and ts < now_ms() - UNDELIVERED_TTL_MS:
        return "ttl"
    return None


def _deliver_one(item_id: str, session: str | None, cwd: object) -> str | None:
    marker = item_path("d", item_id)
    if marker.exists():
        return None
    entry = read_json(item_path("q", item_id))
    answer = read_json(item_path("a", item_id))
    if entry is None or answer is None:
        return None
    if not _receives(entry, session, cwd):
        reason = _lapse_reason(entry, answer)
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
        cmd_prune(DEFAULT_PRUNE_DAYS)
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
    lines: list[str] = []
    for item_id in item_ids:
        try:
            line = _deliver_one(item_id, session, cwd)
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

def dispatch(argv: Sequence[str]) -> dict[str, Any]:
    args = build_parser().parse_args(list(argv))
    return args.run(args)


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == ["hook"]:
        run_hook(args[1] if len(args) > 1 else "")
        return 0
    try:
        result = dispatch(args)
    except ValueError as exc:
        result = {"error": str(exc)}
    except Exception:  # noqa: BLE001 - the CLI always prints one JSON line and exits 0
        result = {"error": "internal error"}
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
