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
from fnmatch import fnmatchcase
from itertools import islice
from pathlib import Path
from typing import Any, Final, NamedTuple, NoReturn

HookOutput = dict[str, Any] | None

DEFAULT_HOME: Final = Path.home() / ".claude" / "state" / "askaway"
SCRIPT_PATH: Final = Path(__file__).resolve()
MIRROR_SCRIPT: Final = Path.home() / ".claude" / "mods" / "plugins" / "askaway" / "scripts" / "askaway.py"
ID_PATTERN: Final = re.compile(r"q-[0-9a-z]+-[0-9a-f]{6}")
BASE36: Final = string.digits + string.ascii_lowercase
RUN_KINDS: Final = frozenset({"main", "subagent", "goal", "loop", "bash", "codex"})
RISKS: Final = frozenset({"low", "medium", "high"})
URGENCY_LEVELS: Final = frozenset({"low", "medium", "high"})  # the optional grade the pane colours Urgency by
ANSWER_SOURCES: Final = frozenset({"panel", "accept_recommended", "accept_all", "cli"})
# Who answered, in the words the model reads ({who} is the answerer). "agent" is stamped by the CLI, never typed.
ANSWER_WORDING: Final = {
    "agent": "Answered by the agent itself",
    "accept_all": "Accepted all",
    "accept_recommended": "Accepted the recommended option",
    "panel": "Answered via panel by {who}",
    "cli": "Answered by {who} (cli)",
}
WHO_ENV: Final = "ASKAWAY_WHO"
# Panel credential: the panel mints a one-shot token file (mode 600) and passes its name in this env var. A second layer
# behind the Bash guard, not isolation: any process of the same user that can read the folder could mint one.
TOKEN_ENV: Final = "ASKAWAY_PANEL_TOKEN"
TOKEN_DIR: Final = "panel-tokens"
TOKEN_PATTERN: Final = re.compile(r"[0-9a-f]{32}")
TOKEN_TTL_MS: Final = 120_000
TOKEN_SOURCES: Final = frozenset({"panel", "accept_all", "accept_recommended"})
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
DESKTOP_SESSIONS_ROOT: Final = Path.home() / ".config" / "Claude" / "claude-code-sessions"
DESKTOP_SESSIONS_ENV: Final = "ASKAWAY_DESKTOP_SESSIONS"
DESKTOP_GLOB: Final = "*/*/local_*.json"  # one folder per org and user, one file per Desktop session
DESKTOP_FILE_MAX: Final = 2 * 1024 * 1024
DESKTOP_SCAN_MAX: Final = 2000  # files examined per lookup, so a huge Desktop folder cannot stall ask
FAMILY_MAX_HOPS: Final = 8
DESKTOP_ESCAPE: Final = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[0-~])")
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
STATUS_DAMAGED: Final = "damaged"  # q/<id>.json does not read as a JSON object
STATUS_DAMAGED_ANSWER: Final = "damaged answer"  # a/<id>.json does not read: answered, key unknown, still pauses
PAUSE_ENDED: Final = CLOSED_STATUSES
WAIT_DEFAULT_S: Final = 300.0
WAIT_POLL_S: Final = 0.5
MIN_WORDS: Final = 3
PLACEHOLDER_WORDS: Final = frozenset({"tbd", "todo", "n/a", "lorem"})
MISSING: Final = "missing"
PLACEHOLDER: Final = "placeholder"
KEY_RULE: Final = "option keys must be consecutive uppercase letters starting at A, in order (A, B, C...)"
FOREIGN_RECHECK_S: Final = 60
FOREIGN_STAMP: Final = "foreign_check"  # touched when unread answers of other sessions were last re-checked
WAIT_ANSWERED: Final = frozenset({"answered", "delivered"})
DURATION: Final = re.compile(r"([0-9]+)([mhd])")
DURATION_MS: Final = {"m": 60_000, "h": 3_600_000, "d": DAY_MS}
# Read-only MCP tools (mcp__<server>__<tool>): the tool name starts with one of these prefixes, no write word.
READ_ONLY_PREFIXES: Final = ("get_", "list_", "read_", "search_", "find_", "describe_", "show_")
WRITE_WORDS: Final = frozenset({
    "add", "apply", "create", "delete", "edit", "exec", "execute", "insert", "keep", "kill", "move",
    "patch", "post", "purge", "push", "put", "register", "remove", "reset", "run", "save", "send",
    "set", "start", "stop", "update", "write"})
# One simple `askaway.py ask|status|list|wait|export` call of the installed script: its path is SCRIPT_PATH
# (symlinks resolved), its mirror under ~/.claude/mods (spelled out, or with ~, $HOME or ${HOME}), or the
# plugin-root form the Askaway skill teaches (a quoted path only). A planted path such as /x/askaway.py never matches.
_HOME_PREFIX: Final = r"(?:~|\$HOME|\$\{HOME\})"
_MIRROR_PATH: Final = rf"(?:{re.escape(str(MIRROR_SCRIPT))}|{_HOME_PREFIX}/\.claude/mods/plugins/askaway/scripts/askaway\.py)"
_FIXED_SCRIPTS: Final = "|".join([re.escape(str(SCRIPT_PATH)), _MIRROR_PATH])
_PLUGIN_ROOT_SCRIPT: Final = re.escape("${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py")
INBOX_CALL: Final = re.compile(
    r"^\s*(?:/usr/bin/)?python3(?:\.\d+)?\s+"
    rf"(?:(?:{_FIXED_SCRIPTS})|\"(?:{_FIXED_SCRIPTS}|{_PLUGIN_ROOT_SCRIPT})\")"
    r"\s+(?:ask|status|list|wait|export)\b[^;&|`$<>\n]*$"
)
# The Bash guard (a deterrent, SPEC.md): each command is read word by word as the shell reads it, and the words
# are checked in command or write position. It does not model xargs, find -exec or a script file's own code.
TMP_ROOT: Final = os.path.realpath("/tmp")
HOME_VAR: Final = "ASKAWAY_HOME"
ANSWER_DENIED: Final = ("Denied: an Askaway question is answered only by the user, in the Askaway panel, never "
                        "from a shell command. Keep working on the recommended option or end the turn.")
STATE_DENIED: Final = ("Denied: the Askaway state folder is written only by askaway.py itself. The user answers "
                       "in the Askaway panel, so a shell command or a file edit must not write into that folder.")
FILE_TOOLS: Final = frozenset({"Edit", "Write", "NotebookEdit"})
SHELL_OPERATORS: Final = frozenset({";", "&&", "||", "|", "&", "(", ")", "\n"})
WRITE_REDIRECTS: Final = frozenset({">", ">>", ">&", ">|", "&>", "<>"})
SHELL_WORD: Final = (r"(?:\$\((?:[^()]|\([^()]*\))*\)|\\.|'[^']*'|\"(?:\\.|[^\"\\])*\""
                     r"|[^\s;&|<>()'\"\\]|\\.)+")
SHELL_TOKEN: Final = re.compile(
    rf"[ \t]*(?:(?P<op>&&|\|\||>>|>&|>\||<<-?|<>|&>|[;&|<>()\n])|(?P<word>{SHELL_WORD}))")
WRITE_COMMANDS: Final = frozenset({"cp", "mv", "tee", "touch", "ln", "install", "truncate", "rsync"})
DELETE_COMMANDS: Final = frozenset({"rm", "unlink", "shred", "rmdir"})
PYTHON_NAME: Final = re.compile(r"python(?:3(?:\.\d+)?)?")
CODE_RUNNERS: Final = frozenset({"perl", "ruby", "node", "bun", "deno", "php"})
SHELL_NAMES: Final = frozenset({"sh", "bash", "zsh", "dash", "ksh"})
SHELL_C_FLAG: Final = re.compile(r"-[A-Za-z]*c[A-Za-z]*")
WRAPPER_NAMES: Final = frozenset({"command", "env", "exec", "nice", "nohup", "time", "timeout"})
PREFIX_WORDS: Final = frozenset({"!", "{", "do", "elif", "else", "if", "then", "until", "while"})
WRAPPER_ARG: Final = re.compile(r"-\S*|[0-9.]+[smhd]?")
ASSIGNMENT: Final = re.compile(r"([A-Za-z_]\w*)=(.*)", re.DOTALL)
SUBSTITUTION: Final = re.compile(r"\$\(((?:[^()]|\([^()]*\))*)\)|`([^`]*)`")
SED_IN_PLACE: Final = re.compile(r"-[A-Za-z]*i|--in-place")
PY_VALUE_OPTIONS: Final = frozenset({"-W", "-X"})
MKTEMP_HOME: Final = re.compile(r"\$\(mktemp(?:\s[^()]*)?\)")
EXPANSION: Final = re.compile(r"[$`*?\[{]")
GLOB: Final = re.compile(r"[*?\[]")
STATE_MENTION: Final = re.compile(r"state[\W_]*askaway|ASKAWAY_HOME")
WRITE_CODE: Final = re.compile(r"open\(.*?(?:['\"][wax+]|>)|write|unlink|remove|rename|os\.replace\(|rmtree|copy|move"
                               r"|touch|truncate|\b(?:rm|mv|cp|tee)\b")
ANSWER_CODE: Final = re.compile(r"cmd_answer|answer\(|['\"]answer['\"]")
ASKAWAY_CODE: Final = re.compile(r"import\s+askaway|from\s+askaway\s+import|askaway\.py")


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
    """Publish data at target unless a readable file is there; a damaged file (not a JSON object) is replaced.

    os.link fails atomically on existence, so writers racing on a readable file cannot both publish. A damaged
    file holds nothing to keep, so it is replaced in place; racing writers on a damaged file are not atomic."""
    tmp = _write_temp(target, data)
    try:
        try:
            os.link(tmp, target)
        except FileExistsError:
            if read_json(target) is not None:
                return False
            os.replace(tmp, target)
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


def load_questions() -> tuple[list[dict[str, Any]], list[str]]:
    """The readable questions, newest first, and the ids of the q/ files that do not read: one pass over q/."""
    loaded: list[dict[str, Any]] = []
    damaged: list[str] = []
    for path in (state_home() / "q").glob("*.json"):
        entry = read_json(path)
        if entry is None:
            if ID_PATTERN.fullmatch(path.stem):
                damaged.append(path.stem)
        elif entry.get("id") == path.stem and isinstance(entry.get("ts"), int):
            loaded.append(entry)
    return sorted(loaded, key=lambda entry: (entry["ts"], entry["id"]), reverse=True), sorted(damaged)


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
        if answer is None:  # answered, but the answer file does not read: the key is unknown
            return STATUS_DAMAGED_ANSWER, None
        return ("expired" if answer_lapsed(answer) else "answered"), key
    return "open", None


OTHER_TEXT_MAX = 500
OTHER_KEY: Final = "other"


def other_text(answer: Mapping[str, Any] | None) -> str | None:
    """The free text of an "Other" answer, on one line and capped, or None."""
    if not answer or answer.get("key") != OTHER_KEY or not isinstance(answer.get("text"), str):
        return None
    text = " ".join(answer["text"].split())[:OTHER_TEXT_MAX]
    return text or None


def away_on() -> bool:
    data = read_json(away_path())
    return data is not None and data.get("on") is True


def is_away(permission_mode: object) -> bool:
    """Whether the user is away. A bypassPermissions run always counts as away, whatever away.json says:
    nobody is there to answer, so an "away off" flag must never let a question skip the inbox."""
    return (permission_mode == "bypassPermissions" or away_on()
            or os.environ.get("CLAUDE_CODE_SESSION_ATTENDED") == "0")


# ---- entry validation --------------------------------------------------

OPTION_TEXT: Final = (("label", TEXT_MAX), ("tradeoff", TEXT_MAX), *((name, TEXT_MAX) for name in REQUIRED_OPTION_TEXT))
# Long texts need MIN_WORDS words; the short ones (urgency, undo, tradeoff, label, title) may have one or two.
LONG_TEXT: Final = frozenset({"question", "what", "problem", "analogy", "why", "how", "gains", "losses", "context",
                              "does", "pros", "cons"})


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _strict_fit(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
        return None
    return value


def _sentence_count(text: str) -> int:
    """Sentences as the non-empty runs between terminators ('.', '!', '?' before a space or the end)."""
    return sum(1 for part in SENTENCE_END.split(text) if part.strip())


def _words(text: str) -> list[str]:
    """The words of a text, lower-cased, with the punctuation at their ends dropped."""
    return [word for word in (raw.strip(string.punctuation) for raw in text.lower().split()) if word]


def _read_text(name: str, raw: object, limit: int) -> tuple[str | None, str | None]:
    """The stripped text, or None with the reason it is refused: missing, too long or a placeholder."""
    if not isinstance(raw, str) or not raw.strip():
        return None, MISSING
    text = raw.strip()
    if len(text) > limit:
        return None, f"too long ({len(text)}/{limit})"
    words = _words(text)
    if all(word in PLACEHOLDER_WORDS for word in words) or (name in LONG_TEXT and len(words) < MIN_WORDS):
        return None, PLACEHOLDER
    return text, None


def _checked(scope: dict[str, str], name: str, raw: object, limit: int) -> str | None:
    text, reason = _read_text(name, raw, limit)
    if reason is not None:
        scope[name] = reason
    return text


class Gaps:
    """Every gap of one entry, collected before it is refused, so the agent fixes them in one pass."""

    def __init__(self) -> None:
        self.top: dict[str, str] = {}  # top-level field -> reason
        self.options: dict[str, dict[str, str]] = {}  # option key -> field -> reason
        self.notes: list[str] = []  # gaps that are no single field: sentences, keys, recommended
        self.keys: list[str] = []  # the option keys as received

    def failed(self) -> bool:
        return bool(self.top or self.notes or self.options)

    def message(self) -> str:
        """Missing fields first, then the other refused fields, the notes, and each option grouped by key."""
        missing = [name for name, reason in self.top.items() if reason == MISSING]
        parts = [f"missing fields: {', '.join(missing)}"] if missing else []
        parts += [f"{name}: {reason}" for name, reason in self.top.items() if reason != MISSING]
        parts += self.notes
        for key, fields in self.options.items():
            parts += _option_parts(key, fields)
        return "; ".join(parts)


def _option_parts(key: str, fields: Mapping[str, str]) -> list[str]:
    """One option's gaps: its missing fields grouped on one line, then each refused field with its reason."""
    names = [name for name, reason in fields.items() if reason == MISSING]
    parts = [f"option {key}: {', '.join(names)}"] if names else []
    return parts + [f"option {key}: {name}: {reason}" for name, reason in fields.items() if reason != MISSING]


class EntryError(ValueError):
    """An entry to refile: the message names every gap, and `gaps` carries them for the reply."""

    def __init__(self, gaps: Gaps) -> None:
        super().__init__(gaps.message())
        self.gaps = gaps


def _top_texts(raw: Mapping[str, Any], gaps: Gaps) -> dict[str, str | None]:
    texts: dict[str, str | None] = {}
    for name, limit in (("question", QUESTION_MAX), *((name, TEXT_CAPS.get(name, TEXT_MAX))
                                                     for name in REQUIRED_TEXT)):
        texts[name] = _checked(gaps.top, name, raw.get(name), limit)
    return texts


def _title(raw: Mapping[str, Any], question: str | None, gaps: Gaps) -> str:
    text, reason = _read_text("title", raw.get("title"), TITLE_MAX)
    if reason is not None and reason != MISSING:
        gaps.top["title"] = reason
    return text or _clip(question or "", TITLE_MAX)


def _risk(raw: Mapping[str, Any], gaps: Gaps) -> str | None:
    risk = raw.get("risk")
    if risk is None:
        gaps.top["risk"] = MISSING
    elif not isinstance(risk, str) or risk not in RISKS:
        gaps.top["risk"] = f"must be one of: {', '.join(sorted(RISKS))}"
    return risk if isinstance(risk, str) else None


def _urgency_level(raw: Mapping[str, Any], gaps: Gaps) -> dict[str, str]:
    """The optional urgency grade, stored lower-case; absent when not given, a refile when not a grade."""
    level = raw.get("urgency_level")
    if level is None:
        return {}
    if not isinstance(level, str) or level.lower() not in URGENCY_LEVELS:
        gaps.top["urgency_level"] = f"must be one of: {', '.join(sorted(URGENCY_LEVELS))}"
        return {}
    return {"urgency_level": level.lower()}


def _run_kind(raw: Mapping[str, Any], origin: Origin, gaps: Gaps) -> str:
    run_kind = raw.get("run_kind") or origin.run_kind
    if not isinstance(run_kind, str) or run_kind not in RUN_KINDS:
        gaps.top["run_kind"] = f"must be one of: {', '.join(sorted(RUN_KINDS))}"
        return origin.run_kind
    return run_kind


def _pause_gap(raw: Mapping[str, Any], gaps: Gaps) -> None:
    pause = raw.get("pause")
    if pause is not None and not isinstance(pause, bool):
        gaps.top["pause"] = "must be true or false"  # type-checked; only risk "high" pauses (SPEC: ask)


def _option_key(raw: object) -> str:
    if not isinstance(raw, dict):
        raise ValueError("each option must be an object")  # noqa: TRY004 - CLI validation channel
    key = raw.get("key")
    if not isinstance(key, str) or not key.strip():
        raise ValueError("option key must be a non-empty string")
    return key.strip()


def _option(raw: Mapping[str, Any], key: str, gaps: Gaps) -> dict[str, Any]:
    fields: dict[str, str] = {}
    texts = {name: _checked(fields, name, raw.get(name), limit) for name, limit in OPTION_TEXT}
    fit = _strict_fit(raw.get("fit"))
    if fit is None:
        fields["fit"] = MISSING
    if fields:
        gaps.options.setdefault(key, {}).update(fields)
    return {"key": key, **texts, "fit": fit}


def _options(raw_options: object, gaps: Gaps) -> list[dict[str, Any]]:
    if not isinstance(raw_options, list) or len(raw_options) < MIN_OPTIONS:
        gaps.notes.append(f"options must be a list of at least {MIN_OPTIONS} items")
        return []
    keys = [_option_key(raw) for raw in raw_options]
    gaps.keys = keys
    if keys != list(string.ascii_uppercase[:len(keys)]):
        gaps.notes.append(f"{KEY_RULE}; keys received: {', '.join(keys)}")
    return [_option(raw, key, gaps) for raw, key in zip(raw_options, keys, strict=True)]


def build_entry(raw: Mapping[str, Any], origin: Origin) -> dict[str, Any]:
    gaps = Gaps()
    risk = _risk(raw, gaps)
    urgency = _urgency_level(raw, gaps)
    run_kind = _run_kind(raw, origin, gaps)
    _pause_gap(raw, gaps)
    texts = _top_texts(raw, gaps)
    title = _title(raw, texts["question"], gaps)
    options = _options(raw.get("options"), gaps)
    recommended = raw.get("recommended")
    if options and recommended not in [option["key"] for option in options]:
        gaps.notes.append("recommended must be one of the option keys")
    what = texts["what"]
    if what is not None and _sentence_count(what) < MIN_SENTENCES:
        gaps.notes.append(f"what needs at least {MIN_SENTENCES} sentences")
    if gaps.failed():
        raise EntryError(gaps)
    now = now_ms()
    desktop = desktop_session(origin.session)  # one Desktop scan serves both the title and the family
    return {
        "v": 1, "id": new_id(now), "ts": now,
        "project": origin.project, "session": origin.session, "run_kind": run_kind,
        "session_title": session_title(origin.session, origin.project, desktop),
        **_family_fields(desktop),
        "title": title, "options": options, "recommended": recommended,
        **texts,
        "risk": risk, "pause": risk == "high", **urgency,
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


def session_title(session: str | None, project: str | None = None,
                  desktop: Mapping[str, Any] | None = None) -> str | None:
    """The asking session's window title: its Desktop title (desktop is its record, when there is one),
    else last custom, agent or AI title. Never raises."""
    title = _desktop_title((desktop or {}).get("title"))
    if title:
        return _clip(title, SESSION_TITLE_MAX)
    try:
        path = _session_file(session, ".jsonl", project)
        latest = _title_rows(path) if path else {}
    except (OSError, ValueError):
        return None
    for kind, _ in TITLE_FIELDS:
        if kind in latest:
            return _clip(latest[kind], SESSION_TITLE_MAX)
    return None


def desktop_sessions_root() -> Path:
    return Path(os.environ.get(DESKTOP_SESSIONS_ENV) or DESKTOP_SESSIONS_ROOT)


def _nonempty(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _desktop_title(value: object) -> str | None:
    """A title from a Desktop file with escape sequences and control characters removed; None when nothing is left."""
    if not isinstance(value, str):
        return None
    text = CONTROL_CHARS.sub(" ", DESKTOP_ESCAPE.sub("", value)).strip()
    return text or None


def _desktop_bytes(path: Path) -> bytes | None:
    """A regular file's bytes, at most DESKTOP_FILE_MAX. A FIFO, a device, a directory, a symlink or an
    oversized file gives None. O_NOFOLLOW refuses a symlink; O_NONBLOCK keeps a FIFO from blocking the open;
    the type check runs on the opened descriptor, so nothing swapped in after the glob is read."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    with os.fdopen(descriptor, "rb") as handle:
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                return None
            data = handle.read(DESKTOP_FILE_MAX + 1)
        except OSError:
            return None
    return data if len(data) <= DESKTOP_FILE_MAX else None


def _desktop_text(path: Path) -> str | None:
    """A Desktop session file's text, or None when it cannot be read as one. Never raises."""
    data = _desktop_bytes(path)
    if data is None:
        return None
    try:
        return data.decode("utf-8")
    except ValueError:
        return None


def _desktop_object(text: str) -> dict[str, Any] | None:
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
        return None
    return data if isinstance(data, dict) else None


def _desktop_record(session_id: str) -> dict[str, Any] | None:
    """The Desktop record stored under this sessionId (a fork's or a spawner's). Never raises."""
    if not SESSION_PATTERN.fullmatch(session_id):
        return None
    try:
        path = next(desktop_sessions_root().glob(f"*/*/{session_id}.json"), None)
    except OSError:
        return None
    text = _desktop_text(path) if path else None
    return _desktop_object(text) if text is not None else None


def desktop_session(cli_session: str | None) -> dict[str, Any] | None:
    """The Claude Desktop record of this Claude Code session (its cliSessionId), or None. Never raises."""
    if not cli_session or not SESSION_PATTERN.fullmatch(cli_session):
        return None
    try:
        for path in islice(desktop_sessions_root().glob(DESKTOP_GLOB), DESKTOP_SCAN_MAX):
            text = _desktop_text(path)
            if text is None or cli_session not in text:
                continue
            record = _desktop_object(text)
            if record is not None and record.get("cliSessionId") == cli_session:
                return record
    except OSError:
        return None
    return None


def _family_parent(record: Mapping[str, Any]) -> str | None:
    """The session this one forked from, else the session that spawned it."""
    spawner = record.get("spawnedFrom")
    spawner_id = spawner.get("sessionId") if isinstance(spawner, dict) else None
    return _nonempty(record.get("forkedFromSessionId")) or _nonempty(spawner_id)


def _spawn_titles(record: Mapping[str, Any], titles: dict[str, str]) -> None:
    """Remember the title a spawn record gives its spawner, keyed by the spawner's sessionId."""
    spawner = record.get("spawnedFrom")
    if not isinstance(spawner, dict):
        return
    spawner_id, title = _nonempty(spawner.get("sessionId")), _desktop_title(spawner.get("title"))
    if spawner_id and title:
        titles.setdefault(spawner_id, title)


def family_of(record: Mapping[str, Any] | None) -> tuple[str, str] | None:
    """The Desktop family root of a session record: (root sessionId, root title), or None. Never raises.
    Walks fork and spawn links up to the root; a cycle or a chain past FAMILY_MAX_HOPS gives None."""
    if record is None:
        return None
    root_id = _nonempty(record.get("sessionId"))
    if root_id is None:
        return None
    seen = {root_id}
    spawn_titles: dict[str, str] = {}
    current = record
    for _ in range(FAMILY_MAX_HOPS + 1):
        _spawn_titles(current, spawn_titles)
        parent = _family_parent(current)
        if parent is None:
            return _titled_root(root_id, current, spawn_titles)
        if parent in seen:
            return None
        seen.add(parent)
        root_id = parent
        found = _desktop_record(parent)
        if found is None:
            return _titled_root(root_id, {}, spawn_titles)
        current = found
    return None


def _titled_root(root_id: str, record: Mapping[str, Any], spawn_titles: Mapping[str, str]) -> tuple[str, str] | None:
    """The root's own title, else the title its child's spawn record gives it; None when neither exists."""
    title = _desktop_title(record.get("title")) or spawn_titles.get(root_id)
    return (root_id, title) if title else None


def desktop_family(cli_session: str | None) -> tuple[str, str] | None:
    """The Desktop family root of this Claude Code session, or None. Never raises."""
    return family_of(desktop_session(cli_session))


def _family_fields(desktop: Mapping[str, Any] | None) -> dict[str, str | None]:
    family = family_of(desktop)
    if family is None:
        return {"family": None, "family_title": None}
    return {"family": family[0], "family_title": _clip(family[1], SESSION_TITLE_MAX)}


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


def _question_key(text: object) -> str:
    """A question text as duplicates compare it: case and spacing ignored."""
    return " ".join(text.lower().split()) if isinstance(text, str) else ""


def open_twin(entry: Mapping[str, Any]) -> dict[str, Any] | None:
    """The open question this session already asked with the same text, or None. Sessionless asks never match."""
    session = entry.get("session")
    if not session:
        return None
    wanted = _question_key(entry["question"])
    return next((other for other in load_questions()[0]
                 if other.get("session") == session and _question_key(other.get("question")) == wanted
                 and item_status(other["id"])[0] == "open"), None)


def _refile(raw: object, error: str, gaps: Gaps) -> dict[str, Any]:
    """The reply that sends the agent back to fix its entry, with every gap grouped by field and option."""
    return {"action": "refile", "recommended": _given_text(raw, "recommended"), "error": error,
            "missing": list(gaps.top), "by_option": {key: list(fields) for key, fields in gaps.options.items()},
            "keys_received": gaps.keys}


def cmd_ask(json_text: str | None) -> dict[str, Any]:
    raw: object = None
    try:
        raw = json.loads(json_text if json_text is not None else sys.stdin.read())
        if not isinstance(raw, dict):
            raise ValueError("the entry must be a JSON object")  # noqa: TRY004 - CLI validation channel
        entry = build_entry(raw, cli_origin())
        twin = open_twin(entry)
        if twin is not None:
            return {"id": twin["id"], "recommended": twin["recommended"], "action": "open", "duplicate": True}
        store_entry(entry)
    except EntryError as exc:  # the entry has gaps: the agent completes them and files again
        return _refile(raw, str(exc), exc.gaps)
    except ValueError as exc:  # the entry is unreadable or invalid: the agent files it again
        return _refile(raw, str(exc), Gaps())
    except Exception:  # noqa: BLE001 - the agent always gets an answer; a high-risk one never continues
        high = _given_text(raw, "risk") == "high"
        return {"action": "pause" if high else "continue",
                "recommended": _given_text(raw, "recommended"), "error": "internal error"}
    return {"id": entry["id"], "recommended": entry["recommended"],
            "action": "pause" if entry["pause"] else "continue"}


def canonical_key(key: str) -> str:
    """Option keys are upper-case letters; the Other key is the word other, in any case."""
    return OTHER_KEY if key.lower() == OTHER_KEY else key.upper()


def answer_refusal(entry: Mapping[str, Any], by: str) -> str | None:
    """Why a shell answer is refused: it must come from the question's own session. None when it may be written."""
    asked = entry.get("session")
    if by == "cli" and asked and caller_session() != asked:
        return ("answer refused: this question belongs to another session; answer it "
                "from the Askaway panel or from its own session")
    return None


def answer_stamp(entry: Mapping[str, Any], by: str) -> str:
    """The channel an answer is stamped with: a shell answer from the question's own session is the agent's own."""
    asked = entry.get("session")
    return "agent" if by == "cli" and asked and caller_session() == asked else by


def answer_session(entry: Mapping[str, Any], by: str) -> str | None:
    """The session an answer is bound to: the caller's for a shell answer, else the question's own."""
    asked = entry.get("session")
    if by != "cli":
        return asked  # the panel answers for the user, so no shell session is required
    return caller_session() or asked


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


def answer_text(key: str, text: str | None) -> str | None:
    """The free text an answer keeps: trimmed, as the panel trims it. Only the Other key keeps text."""
    if key != OTHER_KEY:
        return None
    kept = (text or "").strip()
    if not kept:
        raise ValueError("the Other answer needs --text with some text")
    return kept


def consume_panel_token() -> bool:
    """Spend the panel token in ASKAWAY_PANEL_TOKEN: a fresh file of this user, mode 600, never used before.

    The file is renamed to <token>.used, which is atomic, so two replies cannot spend one token."""
    token = os.environ.get(TOKEN_ENV, "")
    if not TOKEN_PATTERN.fullmatch(token):
        return False
    path = state_home() / TOKEN_DIR / token
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            return False
        minted = (read_json(path) or {}).get("ts")
        if not isinstance(minted, int) or not 0 <= now_ms() - minted <= TOKEN_TTL_MS:
            return False
        os.rename(path, path.with_name(f"{token}.used"))
    except OSError:
        return False
    return True


def cmd_answer(item_id: str, key: str, by: str, text: str | None) -> dict[str, Any]:
    if by not in ANSWER_SOURCES:
        raise ValueError(f"--by must be one of: {', '.join(sorted(ANSWER_SOURCES))}")
    entry = read_json(item_path("q", item_id))
    if entry is None:
        raise ValueError("unknown inbox id")
    key = canonical_key(key)
    kept = answer_text(key, text)
    if key != OTHER_KEY and key not in option_keys(entry):
        raise ValueError("unknown option key")
    refusal = answer_refusal(entry, by)
    if refusal is not None:
        return {"error": refusal}
    if by in TOKEN_SOURCES and not consume_panel_token():
        return {"error": f"answer refused: --by {by} needs a valid panel token; answer from the Askaway panel"}
    stamp = answer_stamp(entry, by)
    record = {"id": item_id, "key": key, "by": stamp, "who": answerer_name(),
              "session": answer_session(entry, stamp), "ts": now_ms()}
    if kept is not None:
        record["text"] = kept
    if create_once(item_path("a", item_id), record):
        return {"id": item_id, "key": key, "written": True}
    stored = read_json(item_path("a", item_id)) or {}
    return {"id": item_id, "key": stored.get("key"), "written": False}


def question_status(item_id: str) -> tuple[str, str | None]:
    """The status and key of a question, as status and wait report them. An unknown id is a usage error."""
    if read_json(item_path("q", item_id)) is None:
        if not item_path("q", item_id).exists():
            raise ValueError("unknown inbox id")
        return STATUS_DAMAGED, None
    return item_status(item_id)


def _status_reply(item_id: str, status: str, key: str | None) -> dict[str, Any]:
    result: dict[str, Any] = {"id": item_id, "status": status, "key": key}
    answer = read_json(item_path("a", item_id))
    text = other_text(answer)
    if text:
        result["text"] = text
    who = answer_who(answer)
    if who:
        result["who"] = who
    by = (answer or {}).get("by")
    if isinstance(by, str) and by:
        result["by"] = by
    return result


def cmd_status(item_id: str) -> dict[str, Any]:
    return _status_reply(item_id, *question_status(item_id))


def _list_row(entry: Mapping[str, Any], released: ReleasedScan | None = None) -> dict[str, Any]:
    status, key = item_status(entry["id"])
    row = {"id": entry["id"], "title": entry.get("title"), "status": status,
           "recommended": entry.get("recommended"), "key": key}
    # The pane reads this: an open question whose asking session has ended can no longer be answered.
    if status == "open" and session_ended(entry.get("session"), entry.get("project"), released):
        row["ended"] = True
    answer = read_json(item_path("a", entry["id"]))
    text = other_text(answer) if key == OTHER_KEY else None
    if text:
        row["text"] = text
    who = answer_who(answer)
    if who:
        row["who"] = who
    return row


def cmd_list(only_open: bool) -> dict[str, Any]:
    released = ReleasedScan()
    items = [_list_row(entry, released) for entry in load_questions()[0]]
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
    for entry in load_questions()[0]:
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
        for tmp in [*folder.glob(".*.tmp"), *(folder.glob(f"{TOKEN_DIR}/*") if folder == state_home() else ())]:
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


def _remove_damaged(damaged: Sequence[str]) -> int:
    """Clear damaged q/ files with their answer and delivery files, whatever the window: the user's way out of a pause."""
    for item_id in damaged:
        _remove_item(item_id)
    return len(damaged)


def _remove_closed(days: int, entries: Sequence[Mapping[str, Any]]) -> int:
    cutoff = now_ms() - days * DAY_MS
    removed = 0
    for entry in entries:
        status = item_status(entry["id"])[0]
        # Only closed items: an undelivered or unexpired record is never pruned, whatever the window.
        if status not in CLOSED_STATUSES:
            continue
        settled = _settled_ts(entry["id"], status)
        if settled is not None and settled < cutoff:
            _remove_item(entry["id"])
            removed += 1
    return removed


def cmd_prune(days: int) -> dict[str, Any]:
    if days < 0:
        raise ValueError("--days must not be negative")
    _remove_stale_temps()
    entries, damaged = load_questions()
    return {"removed": _remove_damaged(damaged) + _remove_closed(days, entries)}


def cmd_prune_id(item_id: str) -> dict[str, Any]:
    """Remove one open question whose asking session has ended (the panel's Dismiss). Nothing else is removed by id."""
    entry = read_json(item_path("q", item_id))
    if entry is None:
        raise ValueError("unknown inbox id")
    if item_status(item_id)[0] != "open":
        return {"error": "prune refused: the question is already answered"}
    if not session_ended(entry.get("session"), entry.get("project")):
        return {"error": "prune refused: the session that asked has not ended"}
    _remove_item(item_id)
    return {"removed": 1}


def _mark_delivered(item_id: str) -> bool:
    """Write the delivery marker the deliver hook writes, so the pane, status and the hook agree.

    Only the asking session closes its answer (any caller may, for a question with no session): another session's
    wait returns the answer and leaves the delivery to the asking session. True when this call wrote the marker."""
    question = read_json(item_path("q", item_id)) or {}
    asked = question.get("session")
    if asked and asked != caller_session():
        return False
    with contextlib.suppress(OSError):  # a marker that did not land is retried by the deliver hook
        return create_once(item_path("d", item_id), {"id": item_id, "session": asked or caller_session(), "ts": now_ms()})
    return False


def _answered_line(item_id: str) -> str | None:
    entry, answer = read_json(item_path("q", item_id)), read_json(item_path("a", item_id))
    if entry is None or answer is None:
        return None
    return _answer_line(entry, answer)


def cmd_wait(item_id: str, timeout: float) -> dict[str, Any]:
    if not 0 <= timeout < math.inf:
        raise ValueError("--timeout must be a finite number of seconds, zero or more")
    deadline = time.monotonic() + timeout
    status, key = question_status(item_id)
    while status == "open":
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {"id": item_id, "status": "timeout"}
        time.sleep(min(WAIT_POLL_S, remaining))
        status, key = question_status(item_id)
    reply = _status_reply(item_id, status, key)
    if status == "answered" and _mark_delivered(item_id):
        line = _answered_line(item_id)  # the asking session receives the line with its answer
        if line is not None:
            reply["line"] = line
    return reply


def cmd_export(since: str | None, fmt: str) -> str:
    """Every question with its answer record, newest first; questions asked before --since are left out."""
    cutoff = since_cutoff(since) if since is not None else 0
    rows = [{"id": entry["id"], "status": item_status(entry["id"])[0], "question": entry,
             "answer": read_json(item_path("a", entry["id"]))}
            for entry in load_questions()[0] if entry["ts"] >= cutoff]
    return render_export(rows, fmt)


CSV_COLUMNS: Final = ("asked_at", "project", "title", "recommended", "answered_key", "label", "who", "by",
                      "answered_at", "delivered")


def _utc_text(ms: object) -> str:
    """A millisecond timestamp as UTC ISO 8601 to the second, or an empty cell."""
    if isinstance(ms, bool) or not isinstance(ms, int):
        return ""
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="seconds")


def _csv_cells(row: Mapping[str, Any]) -> list[str]:
    question, answer = row["question"], row["answer"] or {}
    key = answer.get("key")
    return [_utc_text(question.get("ts")), str(question.get("project") or ""), str(question.get("title") or ""),
            str(question.get("recommended") or ""), str(key or ""), option_label(question, key) or "",
            answer_who(answer) or "", str(answer.get("by") or ""), _utc_text(answer.get("ts")),
            "true" if row["status"] == "delivered" else "false"]


def render_export(rows: list[dict[str, Any]], fmt: str) -> str:
    if fmt == "jsonl":
        return "".join(json.dumps(row) + "\n" for row in rows)
    if fmt == "csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(CSV_COLUMNS)
        writer.writerows(_csv_cells(row) for row in rows)
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
    answer.add_argument("--text")
    answer.add_argument("--strict", action="store_true")
    answer.set_defaults(run=lambda a: cmd_answer(a.id, a.key, a.by, a.text))

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
    prune.add_argument("--id", dest="item_id")
    prune.set_defaults(run=lambda a: cmd_prune_id(a.item_id) if a.item_id else cmd_prune(a.days))

    wait = commands.add_parser("wait")
    wait.add_argument("id")
    wait.add_argument("--timeout", type=float, default=WAIT_DEFAULT_S)
    wait.add_argument("--strict", action="store_true")
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
    """An MCP tool whose own name starts with a read prefix and has no write word, e.g. mcp__graphify__get_node."""
    if not isinstance(tool_name, str) or not tool_name.startswith("mcp__"):
        return False
    tool = tool_name.rsplit("__", 1)[-1]
    return tool.startswith(READ_ONLY_PREFIXES) and not (set(tool.split("_")) & WRITE_WORDS)


def _exempt_call(tool: object, command: str) -> bool:
    """A call the pause lets through: one simple inbox ask, status, list, wait or export, or a read-only MCP tool."""
    return (tool == "Bash" and INBOX_CALL.match(command) is not None) or is_read_only_mcp(tool)


def _unquote(raw: str) -> str:
    """A shell word with its quotes removed and its backslashes read; $( ... ) stays as written."""
    return re.sub(r"\\(.)|[\"']", lambda match: match[1] or "", raw, flags=re.DOTALL)


def _quoted_text(raw: str) -> str:
    """A word's text with only its outer quotes removed, so a code string keeps the quotes inside it."""
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        return raw[1:-1]
    return _unquote(raw)


def _has_expansion(raw: str) -> bool:
    return EXPANSION.search(raw) is not None


def _command_name(argv: Sequence[str]) -> str:
    return os.path.basename(_unquote(argv[0])) if argv else ""


def _shell_tokens(text: str) -> list[tuple[str, str]] | None:
    """(kind, value) pairs, kind "op" or "word"; None when a quote or a bracket is left open."""
    found: list[tuple[str, str]] = []
    pos = 0
    while True:
        match = SHELL_TOKEN.match(text, pos)
        if match is None:
            return found if not text[pos:].strip(" \t") else None
        found.append(("op", match["op"]) if match["op"] else ("word", match["word"]))
        pos = match.end()


class _Simple(NamedTuple):
    words: list[str]  # raw words of one simple command: assignments, wrappers, the command and its arguments
    writes: list[str]  # raw targets of its write redirections


def _simple_commands(tokens: Sequence[tuple[str, str]]) -> list[_Simple]:
    commands: list[_Simple] = []
    words: list[str] = []
    writes: list[str] = []
    redirect: str | None = None  # the redirection operator whose target is the next word
    for kind, value in tokens:
        if kind == "op" and value in SHELL_OPERATORS:
            commands.append(_Simple(words, writes))
            words, writes, redirect = [], [], None
        elif kind == "op":
            redirect = value
        elif redirect is None:
            words.append(value)
        else:
            if redirect in WRITE_REDIRECTS and not value.isdigit():
                writes.append(value)
            redirect = None
    commands.append(_Simple(words, writes))
    return commands


def _drop_wrapper_args(words: list[str]) -> list[str]:
    """The options and numbers a wrapper (env, nice, timeout) takes before the command it runs."""
    rest = list(words)
    while rest and WRAPPER_ARG.fullmatch(_unquote(rest[0])):
        rest.pop(0)
    return rest


def _strip_prefix(words: list[str]) -> tuple[dict[str, str], list[str]]:
    """The assignments before a command, as a dict, and the command words after assignments and wrappers."""
    env: dict[str, str] = {}
    while words:
        head = _unquote(words[0])
        assignment = ASSIGNMENT.fullmatch(head)
        if assignment is not None:
            env[assignment[1]] = assignment[2]
            words = words[1:]
        elif head in PREFIX_WORDS:
            words = words[1:]
        elif head in WRAPPER_NAMES:
            words = _drop_wrapper_args(words[1:])
        else:
            break
    return env, words


def _assignments(words: Sequence[str]) -> dict[str, str]:
    found: dict[str, str] = {}
    for word in words:
        assignment = ASSIGNMENT.fullmatch(_unquote(word))
        if assignment is not None:
            found[assignment[1]] = assignment[2]
    return found


def _substitutions(raw: str) -> list[str]:
    """The text of each $(...) and `...` in a word: the shell runs it as a command too."""
    return [match[1] if match[1] is not None else (match[2] or "") for match in SUBSTITUTION.finditer(raw)]


def _script_texts(argv: Sequence[str]) -> list[str]:
    """The text an sh -c or eval runs, so the scan reads it as a command line of its own."""
    name = _command_name(argv)
    args = [_quoted_text(word) for word in argv[1:]]
    if name == "eval":
        return [" ".join(args)]
    if name not in SHELL_NAMES:
        return []
    return next(([args[index + 1]] for index, arg in enumerate(args[:-1]) if SHELL_C_FLAG.fullmatch(arg)), [])


def _is_askaway_name(name: str) -> bool:
    """Is a file name the askaway script, or a glob that could expand to it (ask*.py, *.py)?"""
    return fnmatchcase("askaway.py", name) or fnmatchcase(name, "askaway*.py")


def _maybe_script(raw: str) -> bool:
    return _has_expansion(raw) or _is_askaway_name(os.path.basename(_unquote(raw)))


def _maybe_module(raw: str) -> bool:
    return _has_expansion(raw) or fnmatchcase("askaway", _unquote(raw))


def _python_args(args: Sequence[str]) -> list[str] | None:
    """The arguments after the askaway script or module that a python command runs, or None."""
    index = 0
    while index < len(args):
        word = _unquote(args[index])
        if word == "-c":
            return None
        if word == "-m":
            module = args[index + 1] if index + 1 < len(args) else ""
            return list(args[index + 2:]) if _maybe_module(module) else None
        if word in PY_VALUE_OPTIONS:
            index += 2
        elif word.startswith("-"):
            index += 1
        else:
            return list(args[index + 1:]) if _maybe_script(args[index]) else None
    return None


def _askaway_args(argv: Sequence[str]) -> list[str] | None:
    """The arguments after the askaway script or module that argv runs, or None when it runs something else."""
    if not argv:
        return None
    if PYTHON_NAME.fullmatch(_command_name(argv)):
        return _python_args(argv[1:])
    return list(argv[1:]) if _is_askaway_name(_command_name(argv)) else None


def _answer_reason(argv: Sequence[str], sandboxed: bool) -> str | None:
    """An answer typed in a shell: the first word after the askaway script that is not an option is answer, or could be."""
    args = _askaway_args(argv)
    if args is None or sandboxed:
        return None
    first = next((word for word in args if not _unquote(word).startswith("-")), None)
    if first is not None and (_unquote(first) == "answer" or _has_expansion(first)):
        return ANSWER_DENIED
    return None


def _inline_code(argv: Sequence[str]) -> str | None:
    """The code string of python -c (or a runner's -e), when argv runs one."""
    name = _command_name(argv)
    if not (PYTHON_NAME.fullmatch(name) or name in CODE_RUNNERS):
        return None
    args = [_quoted_text(word) for word in argv[1:]]
    return next((args[index + 1] for index, arg in enumerate(args[:-1]) if arg in ("-c", "-e")), None)


def _code_reason(code: str, *, sandboxed: bool) -> str | None:
    """Code that writes the state folder, or that answers a question (an answer into a sandbox home is fine).

    Judged line by line, so prose inside a heredoc that edits a document (a README line that names the state
    folder next to the word "write") does not count: the mention and the write must share a line of code, and
    an answer needs the askaway module or script named in the code.
    """
    if any(STATE_MENTION.search(line) and WRITE_CODE.search(line) for line in code.splitlines()):
        return STATE_DENIED
    if not sandboxed and ASKAWAY_CODE.search(code) and ANSWER_CODE.search(code):
        return ANSWER_DENIED
    return None


def _edits_in_place(name: str, args: Sequence[str]) -> bool:
    return name == "sed" and any(SED_IN_PLACE.fullmatch(arg) for arg in args)


def _command_targets(name: str, args: Sequence[str]) -> list[str]:
    """The operands a command writes to: a write or delete command's operands, sed -i's and dd's of= targets."""
    if name == "dd":
        return [arg[3:] for arg in args if arg.startswith("of=")]
    if name in WRITE_COMMANDS or name in DELETE_COMMANDS or _edits_in_place(name, args):
        return [arg for arg in args if not arg.startswith("-")]
    return []


def _write_targets(argv: Sequence[str], writes: Sequence[str]) -> tuple[list[str], bool]:
    """The unquoted words a command writes to (redirections and operands), and whether it deletes."""
    name = _command_name(argv)
    targets = [_unquote(word) for word in writes]
    return targets + _command_targets(name, [_unquote(word) for word in argv[1:]]), name in DELETE_COMMANDS


def _state_roots() -> tuple[str, ...]:
    """The real state folders the guard protects: the default one, and ASKAWAY_HOME when it lies outside /tmp."""
    roots = {os.path.realpath(DEFAULT_HOME), os.path.realpath(state_home())}
    return tuple(sorted(root for root in roots if not root.startswith(TMP_ROOT + os.sep)))


def _inside(path: str, roots: Sequence[str]) -> bool:
    return any(path == root or path.startswith(root + os.sep) for root in roots)


def _above(path: str, roots: Sequence[str]) -> bool:
    """Is path an ancestor of a state folder, so that deleting it would delete the folder?"""
    prefix = path.rstrip(os.sep) + os.sep
    return any(root.startswith(prefix) for root in roots)


def _expand(text: str, askaway_home: str) -> str:
    """A word with ~, $HOME and $ASKAWAY_HOME expanded: the forms a path into the state folder takes."""
    home = str(Path.home())
    text = re.sub(r"\$\{HOME\}|\$HOME\b", lambda _: home, text)
    text = re.sub(r"\$\{ASKAWAY_HOME\}|\$ASKAWAY_HOME\b", lambda _: askaway_home, text)
    return re.sub(r"^~(?=/|$)", lambda _: home, text)


def _sandbox_value(value: str, cwd: str) -> bool:
    """A value that keeps ASKAWAY_HOME in a scratch folder: $(mktemp ...), or a literal path under /tmp."""
    if MKTEMP_HOME.fullmatch(value):
        return True
    if "$" in value or "`" in value:
        return False
    return os.path.realpath(os.path.join(cwd, value)).startswith(TMP_ROOT + os.sep)


def _unreadable_reason(command: str) -> str | None:
    """A command that does not read (an open quote): refused when it names the state folder or an answer."""
    if STATE_MENTION.search(command):
        return STATE_DENIED
    return ANSWER_DENIED if "askaway" in command and "answer" in command else None


class _ShellScan:
    """One Bash command read as the shell runs it: the working directory and the ASKAWAY_HOME it exports."""

    def __init__(self, cwd: str, exported: Mapping[str, str], roots: tuple[str, ...]) -> None:
        self.cwd = cwd
        self.exported = dict(exported)
        self.roots = roots

    def text(self, command: str) -> str | None:
        tokens = _shell_tokens(command)
        if tokens is None:
            return _unreadable_reason(command)
        if "<<" in command and (reason := _code_reason(command, sandboxed=False)) is not None:
            return reason  # a heredoc body is code too
        return next((reason for reason in map(self._simple, _simple_commands(tokens)) if reason is not None), None)

    def _simple(self, simple: _Simple) -> str | None:
        env, argv = _strip_prefix(simple.words)
        name = _command_name(argv)
        if name == "export":
            exported = _assignments(argv[1:])
            self.exported.update(exported)
            env = {**env, **exported}
        if HOME_VAR in env and self._hits_state(env[HOME_VAR], str(DEFAULT_HOME), delete=False):
            return STATE_DENIED
        reason = self._checks(simple, argv, env, env.get(HOME_VAR, self.exported.get(HOME_VAR, "")))
        if reason is None and name == "cd":
            self.cwd = self._cd_target(argv)
        return reason

    def _checks(self, simple: _Simple, argv: Sequence[str], env: Mapping[str, str], home: str) -> str | None:
        sandboxed = bool(home) and _sandbox_value(home, self.cwd)
        askaway_home = home if sandboxed else str(DEFAULT_HOME)
        checks = [_answer_reason(argv, sandboxed), self._write_reason(simple, argv, askaway_home),
                  self._nested(simple, env, argv)]
        code = _inline_code(argv)
        if code is not None:
            checks.append(_code_reason(code, sandboxed=sandboxed))
        return next((reason for reason in checks if reason is not None), None)

    def _write_reason(self, simple: _Simple, argv: Sequence[str], askaway_home: str) -> str | None:
        targets, delete = _write_targets(argv, simple.writes)
        hit = any(self._hits_state(target, askaway_home, delete=delete) for target in targets)
        return STATE_DENIED if hit else None

    def _hits_state(self, text: str, askaway_home: str, *, delete: bool) -> bool:
        """Does an unquoted word name a path inside a state folder (or above one, when it deletes)?"""
        literal = GLOB.split(_expand(text, askaway_home), maxsplit=1)[0]
        path = os.path.realpath(os.path.join(self.cwd, literal))
        return _inside(path, self.roots) or (delete and _above(path, self.roots))

    def _nested(self, simple: _Simple, env: Mapping[str, str], argv: Sequence[str]) -> str | None:
        """Text the command runs on its own: $(...) or `...` (with the exports so far), sh -c or eval (with the prefix)."""
        scans = [(self.exported, text) for word in simple.words for text in _substitutions(word)]
        scans += [({**self.exported, **env}, text) for text in _script_texts(argv)]
        for exported, text in scans:
            reason = _ShellScan(self.cwd, exported, self.roots).text(text)
            if reason is not None:
                return reason
        return None

    def _cd_target(self, argv: Sequence[str]) -> str:
        target = _expand(_unquote(argv[1]), str(DEFAULT_HOME)) if len(argv) > 1 else str(Path.home())
        return os.path.realpath(os.path.join(self.cwd, target))


def bash_tamper_reason(command: str) -> str | None:
    """Why a Bash command may not answer a question or write the state folder, or None.

    A deterrent against the agent's own shell, not a guarantee (SPEC.md, the Bash guard)."""
    return _ShellScan(os.getcwd(), {}, _state_roots()).text(command)


def _file_tamper_reason(tool_input: Mapping[str, Any]) -> str | None:
    raw = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not isinstance(raw, str) or not raw:
        return None
    path = os.path.realpath(os.path.join(os.getcwd(), os.path.expanduser(raw)))
    return STATE_DENIED if _inside(path, _state_roots()) else None


def _tamper_denial(event: Mapping[str, Any]) -> HookOutput:
    """The deny for a Bash command, or a file tool call, that touches the state folder against the rules."""
    tool_input = event.get("tool_input") or {}
    if event.get("tool_name") == "Bash":
        reason = bash_tamper_reason(str(tool_input.get("command", "")))
    elif event.get("tool_name") in FILE_TOOLS:
        reason = _file_tamper_reason(tool_input)
    else:
        return None
    return deny(reason) if reason else None


def damaged_question_session(item_id: str) -> str | None:
    """The session a damaged question names in its raw text, or None when no valid one can be read."""
    try:
        text = item_path("q", item_id).read_text(encoding="utf-8")
    except (OSError, ValueError):
        return None
    found = re.search(r'"session"\s*:\s*"([^"]*)"', text)
    return found[1] if found and SESSION_PATTERN.fullmatch(found[1]) else None


def _holding_question(session: str) -> tuple[str, str | None] | None:
    """The (id, title) of the question that pauses this session, or None; the title is None for a damaged file.

    A high-risk question holds until its answer is delivered (or lapses). A damaged q/ file cannot show its risk,
    so it holds the session its raw text names, while it is open: only `prune` clears it."""
    entries, damaged = load_questions()
    for entry in entries:
        if (entry.get("pause") is True and entry.get("session") == session
                and item_status(entry["id"])[0] not in PAUSE_ENDED):
            return entry["id"], entry["title"]
    for item_id in damaged:
        if damaged_question_session(item_id) == session and item_status(item_id)[0] == "open":
            return item_id, None
    return None


def hook_pause_guard(event: Mapping[str, Any]) -> HookOutput:
    tampering = _tamper_denial(event)  # runs in every session, away or not
    if tampering is not None:
        return tampering
    session = event.get("session_id")
    if not session:
        return None
    tool = event.get("tool_name")
    command = str((event.get("tool_input") or {}).get("command", ""))
    if _exempt_call(tool, command):
        return None
    blocking = _holding_question(session)
    if blocking is None:
        return None
    item_id, title = blocking
    if title is None:
        return deny(f"Paused: Askaway question {item_id} is damaged (its file does not read), so it cannot be "
                    f"answered. The user clears it with `python3 {SCRIPT_PATH} prune`. Do read-only work or end the turn.")
    return deny(f"Paused: Askaway question {item_id} ({title}) needs the "
                "user's answer. Do read-only work or end the turn; check with "
                f"`python3 {SCRIPT_PATH} status {item_id}`.")


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


def _answer_wording(answer: Mapping[str, Any]) -> str:
    """Who gave the answer, in the words the model reads: the channel and its name, or the agent itself."""
    who = answer_who(answer) or UNKNOWN_WHO
    return ANSWER_WORDING.get(str(answer.get("by")), "Answered by {who}").format(who=who)


def _delivery_line(entry: Mapping[str, Any], answer: Mapping[str, Any]) -> str:
    key, recommended = answer.get("key"), entry.get("recommended")
    other = other_text(answer)
    chosen = f'their own answer (Other): "{other}"' if other else _key_text(entry, key)
    line = f"{_answer_wording(answer)}: {chosen}. Askaway question {entry['id']} ({entry['title']})."
    if key != recommended:
        line += f" (you were using {_key_text(entry, recommended)})"
    return _one_line(line)  # a title or label with a line break must not forge a second line


def _answer_line(entry: Mapping[str, Any], answer: Mapping[str, Any]) -> str | None:
    """The delivery line of an answer that names an option or carries free text, or None for neither."""
    if answer.get("key") not in option_keys(entry) and not other_text(answer):
        return None
    return _delivery_line(entry, answer)


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
    line = _answer_line(entry, answer)
    if line is None or not create_once(marker, {"id": item_id, "session": session, "ts": now_ms()}):
        return None
    return line


def _stamp_due(marker: Path, interval_s: float) -> bool:
    """Is there no stamp yet, or has its mtime aged past interval_s?"""
    try:
        return time.time() - marker.stat().st_mtime >= interval_s
    except FileNotFoundError:
        return True


def _maybe_prune() -> None:
    """Opportunistic prune from the deliver slow path, at most once a day. Best effort."""
    marker = state_home() / "last_prune"
    if not _stamp_due(marker, PRUNE_INTERVAL_S):
        return
    with contextlib.suppress(OSError):
        _remove_stale_temps()
        _remove_closed(prune_days(), load_questions()[0])  # never a damaged file: the user clears those
        marker.touch()


def _foreign_recheck_due() -> bool:
    """Are unread answers of other sessions due a re-check? At most once per FOREIGN_RECHECK_S, across hook runs."""
    stamp = state_home() / FOREIGN_STAMP
    if not _stamp_due(stamp, FOREIGN_RECHECK_S):
        return False
    with contextlib.suppress(OSError):
        stamp.touch()
    return True


def _foreign(item_id: str, session: str | None, cwd: object) -> bool:
    """An open answer that another session (or project) receives: only a re-check can close it."""
    if item_path("d", item_id).exists():
        return False  # already closed: _deliver_one returns at once
    entry = read_json(item_path("q", item_id))
    return entry is not None and not _receives(entry, session, cwd)


def _deliver_lines(item_ids: Sequence[str], session: str | None, cwd: object, recheck: bool) -> list[str]:
    released = ReleasedScan()  # one folder-wide scan for every answer of this run, at most
    lines: list[str] = []
    for item_id in item_ids:
        if not recheck and _foreign(item_id, session, cwd):
            continue  # another session's unread answer: re-checked at most once a minute
        try:
            line = _deliver_one(item_id, session, cwd, released)
        except OSError:
            continue  # no marker was written, so the next run retries this answer
        if line:
            lines.append(line)
    return lines


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
    lines = _deliver_lines(item_ids, event.get("session_id") or None, event.get("cwd"), _foreign_recheck_due())
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
    """A refile or an error: the outcomes that --strict turns into a failure."""
    return isinstance(result, dict) and ("error" in result or result.get("action") == "refile")


def _exit_code(result: dict[str, Any] | str, args: Sequence[str]) -> int:
    """0, unless --strict makes a refile, an error or an unanswered wait a failure: 2 on a timeout, else 1."""
    if isinstance(result, str) or "--strict" not in args:
        return 0
    if result.get("status") == "timeout":
        return 2
    if args[:1] == ["wait"] and result.get("status") not in WAIT_ANSWERED:
        return 1
    return 1 if _failed(result) else 0


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == ["hook"]:
        run_hook(args[1] if len(args) > 1 else "")
        return 0
    code = 0
    try:
        result: dict[str, Any] | str = dispatch(args)
    except ValueError as exc:  # a usage error: unknown command, bad id or key, bad option value
        result, code = {"error": str(exc)}, 1
    except Exception:  # noqa: BLE001 - the CLI always answers, on one line
        result, code = {"error": "internal error"}, 1
    if isinstance(result, str):
        sys.stdout.write(result)  # export writes its document as it is, not as a JSON line
    else:
        print(json.dumps(result))
    return code or _exit_code(result, args)


if __name__ == "__main__":
    sys.exit(main())
