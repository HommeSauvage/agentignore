"""Tool-argument extraction and blocking logic for the pre_tool_call hook."""

from __future__ import annotations

import os
import re
import shlex
from pathlib import Path

try:
    from . import ignore  # loaded as a package (plugin loader)
except ImportError:  # pragma: no cover — standalone test runs
    import ignore  # type: ignore[no-redef]

# Tools whose args carry a direct file path.
_PATH_TOOLS = {
    "read_file": ("path",),
    "search_files": ("path",),
    "write_file": ("path",),
    "patch": ("path",),
}

# Tools whose args are free text that may reference paths (best effort).
_TEXT_TOOLS = {
    "terminal": ("command",),
    "execute_code": ("code",),
}

# Ignore files are read-only for agents: reads allowed, writes/deletes blocked.
_IGNORE_BASENAMES = (".agentignore", ".agentsignore")
_GLOBAL_IGNORE = os.path.normpath(str(Path.home() / ".agentsignore"))

_DESTRUCTIVE_RE = re.compile(
    r"\b(rm|rmdir|mv|truncate|shred|unlink|tee|dd|touch|vim|nvim|nano)\b"
    r"|sed -i|perl -i"
    r"|>>?|&>"
)

_PY_DESTRUCTIVE_RE = re.compile(
    r"\bos\.(remove|unlink|rmdir|rename|replace|truncate|write)\b"
    r"|\bshutil\.(rmtree|move|copy|copyfile|replace)\b"
    r"|\.(write_text|write_bytes|unlink|rmdir|rename|replace)\("
    r"|open\([^)]*['\"][waxb+]"
)

_QUOTE_CHARS = "\"'`"

# Embedded absolute / ~ / ./ paths inside code strings (open('/x/y').read()).
_EMBEDDED_PATH_RE = re.compile(
    r"""(?:~|/|\.{1,2}/)[^\s'"`|&;<>()\[\]{}]*"""
)


def _extract_path_tokens(text: str) -> list[str]:
    """Pull path-looking tokens out of a command or code string.

    Best effort by design: the hard block is authoritative for the direct
    path tools; for shell/code execution we scan for tokens that look like
    paths (shell tokens plus embedded absolute paths) and err on the side
    of blocking.
    """
    tokens: list[str] = []

    # 1. shell-token split: `cat docs/scratch/x.md`
    try:
        parts = shlex.split(text)
    except ValueError:
        parts = text.split()
    for part in parts:
        cleaned = part.strip(_QUOTE_CHARS).rstrip("),;")
        if not cleaned:
            continue
        # strip leading flags ("-r", "--include=")
        cleaned = cleaned.lstrip("-")
        # only path-like tokens are worth checking
        if _looks_like_path(cleaned):
            tokens.append(cleaned)

    # 2. embedded absolute paths: open('/var/x/.env').read()
    for match in _EMBEDDED_PATH_RE.finditer(text):
        tok = match.group(0).strip(_QUOTE_CHARS).rstrip("),;")
        if tok and _looks_like_path(tok):
            tokens.append(tok)

    return tokens


def _looks_like_path(token: str) -> bool:
    if "/" in token or "\\" in token:
        return True
    if token.startswith("~") or token.startswith("."):
        return True
    # bare dotfile names (e.g. ".env")
    if token.startswith(".") and len(token) > 1:
        return True
    return False


def _is_ignore_file(path_str: str) -> bool:
    """True when the path IS an ignore file (any .agentignore or the global
    ~/.agentsignore). Symlinks are resolved, so writing through a symlink
    cannot reach an ignore file."""
    expanded = os.path.expanduser(path_str)
    if not os.path.isabs(expanded):
        expanded = os.path.join(os.getcwd(), expanded)
    logical = os.path.normpath(expanded)
    if Path(logical).name in _IGNORE_BASENAMES:
        return True
    real = os.path.normpath(os.path.realpath(logical))
    if real == _GLOBAL_IGNORE:
        return True
    return Path(real).name in _IGNORE_BASENAMES


def _blocked(path: str, source: str | None) -> dict:
    where = f" ({source})" if source else ""
    return {
        "action": "block",
        "message": f"Blocked by .agentignore{where}: {path}",
    }


def check(tool_name: str, args: dict) -> dict | None:
    """Evaluate a pre_tool_call. Returns a block directive or None."""
    if not isinstance(args, dict):
        return None

    if tool_name in _PATH_TOOLS:
        for key in _PATH_TOOLS[tool_name]:
            val = args.get(key)
            if val:
                # ignore files themselves: read-only for agents
                if tool_name in ("write_file", "patch") and _is_ignore_file(str(val)):
                    return _blocked(str(val), "protected file")
                blocked, source = ignore.is_blocked(val)
                if blocked:
                    return _blocked(str(val), source)

    if tool_name in _TEXT_TOOLS:
        for key in _TEXT_TOOLS[tool_name]:
            text = args.get(key) or ""
            destructive = bool(
                _DESTRUCTIVE_RE.search(text)
                if tool_name == "terminal"
                else _PY_DESTRUCTIVE_RE.search(text)
            )
            if destructive:
                for token in _extract_path_tokens(text):
                    if _is_ignore_file(token):
                        return _blocked(token, "protected file")
            for token in _extract_path_tokens(text):
                blocked, source = ignore.is_blocked(token)
                if blocked:
                    return _blocked(token, source)

    return None
