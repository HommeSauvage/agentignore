"""gitignore-compatible matching for .agentignore files.

Implements the .agentignore standard (agentignore.org):
- same syntax as .gitignore (globs, comments, `!` negation)
- nested per-directory files: a .agentignore applies to its directory and
  everything below it
- precedence: deeper files override shallower ones; within a file, later
  patterns win; the global ~/.agentsignore is the lowest precedence layer
- hard block: matched paths are treated as if they do not exist

Matching is delegated to `pathspec` (the same library git uses), so pattern
semantics match git's exactly.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import pathspec

GLOBAL_FILE = Path.home() / ".agentsignore"
LOCAL_NAME = ".agentignore"
_MAX_DEPTH = 64


@dataclass(frozen=True)
class _RuleFile:
    base: Path  # directory this file governs
    spec: pathspec.GitIgnoreSpec
    mtime_ns: int
    size: int


_cache: dict[Path, _RuleFile | None] = {}


def _load_rule_file(path: Path) -> _RuleFile | None:
    try:
        st = path.stat()
    except OSError:
        return None
    stamp = (st.st_mtime_ns, st.st_size)
    cached = _cache.get(path)
    if cached is not None and (cached.mtime_ns, cached.size) == stamp:
        return cached
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    rule = _RuleFile(
        base=path.parent,
        spec=pathspec.GitIgnoreSpec.from_lines(lines),
        mtime_ns=st.st_mtime_ns,
        size=st.st_size,
    )
    _cache[path] = rule
    return rule


def _last_decision(
    spec: pathspec.GitIgnoreSpec, candidates: list[str]
) -> bool | None:
    """Last-pattern-wins over a list of candidate spellings of a path."""
    decision = None
    for candidate in candidates:
        for pattern in spec.patterns:
            if pattern.match_file(candidate):
                decision = pattern.include
    return decision


def _file_decision(
    spec: pathspec.GitIgnoreSpec, relpath: str, as_dir: bool = False
) -> bool | None:
    """Last-pattern-wins decision for one rule file.

    Returns True (ignored), False (negated / re-included), or None when no
    pattern in this file matches the path at all. When `as_dir` is True the
    path is also matched with a trailing slash, so a `dir/` pattern blocks
    the directory itself (git semantics).

    Implements git's parent-dir rule: an excluded ancestor directory stops
    the walk — "it is not possible to re-include a file if a parent
    directory of that file is excluded". Ancestors are walked shallowest →
    deepest; a re-included directory (negated match) lets the walk
    continue, which is what makes the `dir/*` + `!dir/keep.md` idiom work.
    """
    # Ancestor directories (everything above the final segment), shallow → deep.
    parts = relpath.split("/")
    for i in range(1, len(parts)):
        dir_rel = "/".join(parts[:i])
        d = _last_decision(spec, [dir_rel, dir_rel + "/"])
        if d is True:
            return True  # excluded dir → everything below is ignored
        # False (re-included dir) → keep descending
    candidates = [relpath]
    if as_dir:
        candidates.append(relpath.rstrip("/") + "/")
    return _last_decision(spec, candidates)


def _check_path(abs_path: str) -> tuple[bool, str | None]:
    """Check one absolute path against the rule set.

    Returns (blocked, source_file). The global file is evaluated first
    (lowest precedence); local files are then evaluated shallowest to
    deepest, and a deeper file overrides a shallower one only when one of
    its patterns actually matches the path.
    """
    path = Path(abs_path)

    decision = False
    source: str | None = None
    as_dir = os.path.isdir(abs_path) or abs_path.endswith(("/", os.sep))

    global_rule = _load_rule_file(GLOBAL_FILE)
    if global_rule is not None:
        try:
            rel = path.relative_to(global_rule.base).as_posix()
        except ValueError:
            rel = None
        if rel is not None:
            d = _file_decision(global_rule.spec, rel)
            if d is not None:
                decision, source = d, str(GLOBAL_FILE)

    # local files, shallowest -> deepest (deeper files win)
    for anc in reversed(_ancestors(path.parent)):
        rule = _load_rule_file(anc / LOCAL_NAME)
        if rule is None:
            continue
        try:
            rel = path.relative_to(rule.base).as_posix()
        except ValueError:
            continue
        d = _file_decision(rule.spec, rel, as_dir=as_dir)
        if d is not None:
            decision, source = d, str(rule.base / LOCAL_NAME)

    return decision, source


def _ancestors(path: Path) -> list[Path]:
    out: list[Path] = []
    p = path
    for _ in range(_MAX_DEPTH):
        out.append(p)
        if p.parent == p:
            break
        p = p.parent
    return out


def is_blocked(
    target: str | os.PathLike, cwd: str | os.PathLike | None = None
) -> tuple[bool, str | None]:
    """Return (blocked, source_file) for a target path.

    Relative paths resolve against `cwd` (default: the current working
    directory). Both the logical path and its symlink-resolved realpath are
    checked, so symlink tricks cannot bypass a block.
    """
    raw = os.fspath(target)
    if not raw:
        return False, None
    expanded = os.path.expanduser(raw)
    if not os.path.isabs(expanded):
        base = os.fspath(cwd) if cwd else os.getcwd()
        expanded = os.path.join(base, expanded)
    logical = os.path.normpath(expanded)
    real = os.path.realpath(expanded)

    for cand in dict.fromkeys((logical, real)):
        blocked, src = _check_path(cand)
        if blocked:
            return True, src
    return False, None


def clear_cache() -> None:
    """Drop cached rule files (used by tests)."""
    _cache.clear()
