"""Frozen copy of a later revision of the Bash guard: the guard of 0.4.0-beta.36
(askaway.py at a312550) plus the relaxations that stop it denying unrelated commands (bash_tamper_reason and what it uses).

Why it exists: the guard was rewritten during gauntlet 6 and every review found inputs the installed guard denied and
the new scanner let through. askaway.bash_tamper_reason denies when the current scanner denies OR this copy denies, so
the guard never denies less than the installed mirror did, and never denies more than it, which is why the
relaxations (STATE_HINT, PROSE_COMMANDS) are part of it. Do not edit it. Remove it, with its call in askaway.py and its
test, once the current scanner has a clean review. The only change from that source is SCRIPT_PATH, which names
askaway.py instead of this file, so the inbox-call exemption still matches."""
import os
import re
from collections.abc import Mapping, Sequence
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Final, NamedTuple

DEFAULT_HOME: Final = Path.home() / ".claude" / "state" / "askaway"


SCRIPT_PATH: Final = Path(__file__).resolve().with_name("askaway.py")  # the script, not this module


MIRROR_SCRIPT: Final = Path.home() / ".claude" / "mods" / "plugins" / "askaway" / "scripts" / "askaway.py"


_HOME_PREFIX: Final = r"(?:~|\$HOME|\$\{HOME\})"


_MIRROR_PATH: Final = rf"(?:{re.escape(str(MIRROR_SCRIPT))}|{_HOME_PREFIX}/\.claude/mods/plugins/askaway/scripts/askaway\.py)"


_FIXED_SCRIPTS: Final = "|".join([re.escape(str(SCRIPT_PATH)), _MIRROR_PATH])


_PLUGIN_ROOT_SCRIPT: Final = re.escape("${CLAUDE_PLUGIN_ROOT}/scripts/askaway.py")


_INBOX_HEAD: Final = (
    r"^\s*(?:/usr/bin/)?python3(?:\.\d+)?\s+"
    rf"(?:(?:{_FIXED_SCRIPTS})|\"(?:{_FIXED_SCRIPTS}|{_PLUGIN_ROOT_SCRIPT})\")"
    r"\s+(?:ask|status|list|wait|export)\b"
)


INBOX_HEREDOC: Final = re.compile(rf"{_INBOX_HEAD}[^;&|`$<>\n]*?<<-?\s*(['\"]?)(\w+)\1\s*$")


TMP_ROOT: Final = os.path.realpath("/tmp")


HOME_VAR: Final = "ASKAWAY_HOME"


ANSWER_DENIED: Final = ("Denied: an Askaway question is answered only by the user, in the Askaway panel, never "
                        "from a shell command. Keep working on the recommended option or end the turn.")


AWAY_DENIED: Final = ("Denied: the Askaway away mode is switched only by the user, in the Askaway panel or the user's "
                      "own shell, never by a shell command of the agent. Questions keep going to the inbox meanwhile.")


AWAY_SWITCHES: Final = frozenset({"on", "off"})


STATE_DENIED: Final = ("Denied: the Askaway state folder is written only by askaway.py itself. The user answers "
                       "in the Askaway panel, so a shell command or a file edit must not write into that folder.")


FORCE_PRUNE_DENIED: Final = ("Denied: prune --force is for the user's own terminal only. It removes an open question "
                             "whose session has not ended, which frees that session's pause. Do read-only work or "
                             "end the turn.")


FORCE_FLAG: Final = "--force"  # argparse takes any unambiguous prefix of a long option, so a prefix counts too


SHELL_OPERATORS: Final = frozenset({";", "&&", "||", "|", "&", "(", ")", "\n"})


WRITE_REDIRECTS: Final = frozenset({">", ">>", ">&", ">|", "&>", "<>"})


SHELL_WORD: Final = (r"(?:\$\((?:[^()]|\([^()]*\))*\)|\\.|'[^']*'|\"(?:\\.|[^\"\\])*\""
                     r"|[^\s;&|<>()'\"\\]|\\.)+")


SHELL_TOKEN: Final = re.compile(
    rf"[ \t]*(?:(?P<op>&&|\|\||>>|>&|>\||<<-?|<>|&>|[;&|<>()\n])|(?P<word>{SHELL_WORD}))")


WRITE_COMMANDS: Final = frozenset({"cp", "mv", "tee", "touch", "ln", "install", "truncate", "rsync",
                                 "mkfifo", "mknod", "mkdir", "chmod", "chown", "chgrp", "setfacl", "chattr"})


DELETE_COMMANDS: Final = frozenset({"rm", "unlink", "shred", "rmdir"})


PYTHON_NAME: Final = re.compile(r"python(?:3(?:\.\d+)?)?")


CODE_RUNNERS: Final = frozenset({"perl", "ruby", "node", "bun", "deno", "php"})


SHELL_NAMES: Final = frozenset({"sh", "bash", "zsh", "dash", "ksh"})


SHELL_C_FLAG: Final = re.compile(r"-[A-Za-z]*c[A-Za-z]*")


WRAPPER_NAMES: Final = frozenset({"builtin", "command", "env", "exec", "nice", "nohup", "time", "timeout"})


DIRECTORY_CHANGERS: Final = frozenset({"cd", "pushd", "popd"})


DIRECTORY_OPTION: Final = re.compile(r"-(?:-|[LPe@]+)")  # cd's own options and the end-of-options "--"; a lone "-" is OLDPWD


DIRECTORY_STACK_INDEX: Final = re.compile(r"[+-]\d+")  # pushd's rotation of the stack: the directory it reaches is unknown


DIRECTORY_WORD: Final = re.compile(r"\b(?:cd|pushd|popd)\b")


SOURCE_NAMES: Final = frozenset({"source", "."})  # run in this shell, and the scan cannot read the file they run


CDPATH_VAR: Final = "CDPATH"  # cd searches these folders for a relative operand


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


STATE_HINT: Final = re.compile(r"askaway|ASKAWAY_HOME|\bstate\b", re.IGNORECASE)  # a command with none of these cannot aim at the state folder


PROSE_COMMANDS: Final = frozenset({"git", "gh"})  # a heredoc under these is a commit, PR or issue text, never code


WRITE_CODE: Final = re.compile(r"open\(.*?(?:['\"][wax+]|>)|write|unlink|remove|rename|os\.replace\(|rmtree|copy|move"
                               r"|os\.(?:symlink|link)\(|symlink_to|hardlink_to"
                               r"|touch|truncate|\b(?:rm|mv|cp|tee)\b")


ANSWER_CODE: Final = re.compile(r"cmd_answer|answer\(|['\"]answer['\"]")


AWAY_CODE: Final = re.compile(r"['\"]away['\"]|\baway\w*")  # the away switch as a string or as an identifier such as away_path


AWAY_SWITCH_TEXT: Final = re.compile(r"\baway\s+(?:on|off)\b")


ASKAWAY_CODE: Final = re.compile(r"import\s+askaway|from\s+askaway\s+import|askaway\.py")


RUNS_CODE: Final = re.compile(r"subprocess|os\.(?:system|popen|exec\w*|spawn\w*)|\bpty\b|\.main\(|cmd_\w+"
                              r"|\brunpy\b|\bexec\(")


def state_home() -> Path:
    override = os.environ.get("ASKAWAY_HOME")
    return Path(override) if override else DEFAULT_HOME


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


def _away_reason(argv: Sequence[str], sandboxed: bool) -> str | None:
    """An away switch typed in a shell, or one a variable could make: the user switches away mode, not the agent."""
    args = _askaway_args(argv)
    if args is None or sandboxed:
        return None
    words = [word for word in args if not _unquote(word).startswith("-")]
    if len(words) < 2 or _unquote(words[0]) != "away":
        return None
    return AWAY_DENIED if _unquote(words[1]) in AWAY_SWITCHES or _has_expansion(words[1]) else None


def _forced_prune_reason(argv: Sequence[str]) -> str | None:
    """A prune with --force, which removes a question whose session has not ended: the user's own terminal only."""
    words = [_unquote(word) for word in _askaway_args(argv) or []]
    forced = any(len(word) >= 3 and FORCE_FLAG.startswith(word) for word in words)
    return FORCE_PRUNE_DENIED if "prune" in words and forced else None


def _inline_code(argv: Sequence[str]) -> str | None:
    """The code string of python -c (or a runner's -e), when argv runs one."""
    name = _command_name(argv)
    if not (PYTHON_NAME.fullmatch(name) or name in CODE_RUNNERS):
        return None
    args = [_quoted_text(word) for word in argv[1:]]
    return next((args[index + 1] for index, arg in enumerate(args[:-1]) if arg in ("-c", "-e")), None)


def _directory_operand(operand: str) -> str | None:
    """The expanded operand of a cd or pushd, or None when it is `-`, a stack index, or still holds a variable, a glob or a brace."""
    target = _expand(operand, str(DEFAULT_HOME))
    return None if target == "-" or DIRECTORY_STACK_INDEX.fullmatch(target) or EXPANSION.search(target) else target


def _askaway_code_reason(code: str) -> str | None:
    """Code that names the askaway module or script and either answers a question or switches away mode."""
    if ANSWER_CODE.search(code):
        return ANSWER_DENIED
    return AWAY_DENIED if AWAY_CODE.search(code) else None  # the away switch is the user's, as _away_reason holds it


def _code_reason(code: str, *, sandboxed: bool) -> str | None:
    """Code that writes the state folder, or that answers a question (an answer into a sandbox home is fine).

    Judged line by line, so prose inside a heredoc that edits a document (a README line that names the state
    folder next to the word "write") does not count: the mention and the write must share a line of code, and
    an answer needs the askaway module or script named in the code.
    """
    if any(STATE_MENTION.search(line) and WRITE_CODE.search(line) for line in code.splitlines()):
        return STATE_DENIED
    if not sandboxed and ASKAWAY_CODE.search(code) and (reason := _askaway_code_reason(code)) is not None:
        return reason
    if not sandboxed and "askaway" in code and RUNS_CODE.search(code):
        return ANSWER_DENIED  # the answer word may be built at run time; running the CLI from code is the route
    return None


def _closing_index(lines: Sequence[str], word: str) -> int | None:
    """The index of the first line that closes a heredoc with this terminator word (leading tabs ignored)."""
    return next((index for index, line in enumerate(lines) if line.lstrip("\t") == word), None)


def _heredoc_code(command: str) -> str:
    """The text the code scan reads: an inbox call's heredoc body is JSON on stdin and never runs, so only the lines
    outside it are read. Any other command keeps its body."""
    head, _, rest = command.partition("\n")
    opened = INBOX_HEREDOC.match(head)
    if opened is None:
        return command
    lines = rest.split("\n")
    end = _closing_index(lines, opened[2])
    return head if end is None else "\n".join([head, *lines[end + 1:]])


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
    """The real state folders the guard protects: the default one always, and ASKAWAY_HOME unless it lies under /tmp."""
    roots = {os.path.realpath(DEFAULT_HOME)}
    custom = os.path.realpath(state_home())
    if not custom.startswith(TMP_ROOT + os.sep):
        roots.add(custom)
    return tuple(sorted(roots))


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
    """A command that does not read (an open quote): refused when it names the state folder, an answer or an away switch."""
    if STATE_MENTION.search(command):
        return STATE_DENIED
    if "askaway" in command and "answer" in command:
        return ANSWER_DENIED
    return AWAY_DENIED if "askaway" in command and AWAY_SWITCH_TEXT.search(command) else None


class _ShellScan:
    """One Bash command read as the shell runs it: the working directory, whether the guard knows it, and the
    ASKAWAY_HOME it exports."""

    def __init__(self, cwd: str, exported: Mapping[str, str], roots: tuple[str, ...], cwd_known: bool = True,
                 *, hinted: bool | None = None, prose: bool = False, strict: bool = False) -> None:
        self.cwd = cwd
        self.hinted = hinted  # does the whole command mention the state folder? set by the first text() call
        self.strict = strict  # does the unknown directory come from more than a cd to a variable?
        self.prose = prose  # is this text inside a git or gh command, whose heredoc is message text?
        self.cwd_known = cwd_known  # False once a directory change the guard cannot follow has run
        self.exported = dict(exported)
        self.roots = roots

    def text(self, command: str) -> str | None:
        tokens = _shell_tokens(command)
        if tokens is None:
            return _unreadable_reason(command)
        if self.hinted is None:
            self.hinted = STATE_HINT.search(command) is not None
        simples = _simple_commands(tokens)
        prose = self.prose or all(_command_name(_strip_prefix(simple.words)[1]) in PROSE_COMMANDS for simple in simples)
        if not prose and "<<" in command and (reason := _code_reason(_heredoc_code(command), sandboxed=False)) is not None:
            return reason  # a heredoc body is code too, except an inbox call's JSON body
        return next((reason for reason in map(self._simple, simples) if reason is not None), None)

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
        if self._directory_untracked(name, argv, env):
            self.cwd_known = False
            self.strict = True
        if reason is None and name in DIRECTORY_CHANGERS:
            self._change_directory(name, argv)
        return reason

    def _directory_untracked(self, name: str, argv: Sequence[str], env: Mapping[str, str]) -> bool:
        """Does the command move this shell's directory where the scan cannot follow it?

        CDPATH sends a relative cd to another folder. A sourced file, and an eval whose text holds a cd, run in this
        shell, and the scan of their text does not carry the directory back."""
        if CDPATH_VAR in env or name in SOURCE_NAMES:
            return True
        return name == "eval" and any(DIRECTORY_WORD.search(text) for text in _script_texts(argv))

    def _checks(self, simple: _Simple, argv: Sequence[str], env: Mapping[str, str], home: str) -> str | None:
        sandboxed = bool(home) and (self.cwd_known or os.path.isabs(home)) and _sandbox_value(home, self.cwd)
        askaway_home = home if sandboxed else str(DEFAULT_HOME)
        checks = [_answer_reason(argv, sandboxed), _away_reason(argv, sandboxed), _forced_prune_reason(argv),
                  self._write_reason(simple, argv, askaway_home), self._nested(simple, env, argv)]
        code = _inline_code(argv)
        if code is not None:
            checks.append(_code_reason(code, sandboxed=sandboxed))
        return next((reason for reason in checks if reason is not None), None)

    def _write_reason(self, simple: _Simple, argv: Sequence[str], askaway_home: str) -> str | None:
        targets, delete = _write_targets(argv, simple.writes)
        hit = any(self._hits_state(target, askaway_home, delete=delete) for target in targets)
        return STATE_DENIED if hit else None

    def _hits_state(self, text: str, askaway_home: str, *, delete: bool) -> bool:
        """Does an unquoted word name a path inside a state folder, or above one when it deletes or globs?

        A glob reaches every path under the directory before its first wildcard, so that directory is checked."""
        expanded = _expand(text, askaway_home)
        if not self.cwd_known and not os.path.isabs(expanded):
            # A relative word cannot be placed. After a cd to a variable it counts only in a command that names the
            # state folder; after any other untracked change (pushd, cd -, popd, CDPATH, source, eval) it always counts.
            return self.strict or bool(self.hinted)
        wildcard = GLOB.search(expanded)
        literal = expanded if wildcard is None else expanded[:expanded.rfind(os.sep, 0, wildcard.start()) + 1]
        path = os.path.realpath(os.path.join(self.cwd, literal))
        return _inside(path, self.roots) or ((delete or wildcard is not None) and _above(path, self.roots))

    def _nested(self, simple: _Simple, env: Mapping[str, str], argv: Sequence[str]) -> str | None:
        """Text the command runs on its own: $(...) or `...` (with the exports so far), sh -c or eval (with the prefix)."""
        scans = [(self.exported, text) for word in simple.words for text in _substitutions(word)]
        scans += [({**self.exported, **env}, text) for text in _script_texts(argv)]
        for exported, text in scans:
            reason = _ShellScan(self.cwd, exported, self.roots, self.cwd_known, hinted=self.hinted, strict=self.strict,
                                prose=self.prose or _command_name(argv) in PROSE_COMMANDS).text(text)
            if reason is not None:
                return reason
        return None

    def _change_directory(self, name: str, argv: Sequence[str]) -> None:
        """Follow the directory a cd or pushd leaves; any change the guard cannot resolve leaves it unknown."""
        target = self._directory_after(name, argv)
        self.cwd_known = target is not None
        self.strict = target is None and not self._variable_operand(argv)
        if target is not None:
            self.cwd = target

    @staticmethod
    def _variable_operand(argv: Sequence[str]) -> bool:
        """Is the directory change a cd or pushd to one operand that holds a variable?"""
        operands = [_unquote(word) for word in argv[1:] if not DIRECTORY_OPTION.fullmatch(_unquote(word))]
        return len(operands) == 1 and "$" in operands[0]

    def _directory_after(self, name: str, argv: Sequence[str]) -> str | None:
        """The directory a cd or pushd leaves, or None: popd, a swap, cd -, a variable, a glob, or more operands."""
        operands = [_unquote(word) for word in argv[1:] if not DIRECTORY_OPTION.fullmatch(_unquote(word))]
        if name == "popd" or len(operands) > 1:
            return None
        if not operands:
            return None if name == "pushd" else str(Path.home())
        target = _directory_operand(operands[0])
        if target is None or (not self.cwd_known and not os.path.isabs(target)):
            return None
        return os.path.realpath(os.path.join(self.cwd, target))


def bash_tamper_reason(command: str) -> str | None:
    """Why a Bash command may not answer a question, force a prune or write the state folder, or None.

    A deterrent against the agent's own shell, not a guarantee (SPEC.md, the Bash guard)."""
    return _ShellScan(os.getcwd(), {}, _state_roots()).text(command)
