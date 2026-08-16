"""Tests for the .agentignore matcher (ignore.py) and guard (guard.py).

Run with the Hermes venv python:

    ~/.hermes/hermes-agent/venv/bin/python extensions/hermes-agentignore/test_ignore.py
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from ignore import GLOBAL_FILE, clear_cache, is_blocked  # noqa: E402
from guard import check as guard_check  # noqa: E402

FAILED = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        FAILED.append(name)
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        clear_cache()

        # --- setup: project with a .agentignore ---
        proj = root / "proj"
        (proj / "docs" / "scratch").mkdir(parents=True)
        (proj / "docs" / "keep").mkdir(parents=True)
        (proj / "src").mkdir()
        (proj / ".agentignore").write_text(
            "# secrets\n.env\n.env.*\n\n# scratch notes\n/docs/scratch/\n\n# keep a doc\n!docs/keep/\n"
        )
        env_file = proj / ".env"
        env_file.write_text("SECRET=1")
        scratch = proj / "docs" / "scratch" / "notes.md"
        scratch.write_text("stale ideas")
        keep = proj / "docs" / "keep" / "notes.md"
        keep.write_text("fine")
        src = proj / "src" / "main.py"
        src.write_text("print(1)")

        # 1. basic .env block
        blocked, src_f = is_blocked(str(env_file), cwd=str(proj))
        check("blocks .env", blocked and src_f == str(proj / ".agentignore"))

        # 2. directory pattern blocks files beneath it
        blocked, _ = is_blocked(str(scratch), cwd=str(proj))
        check("blocks docs/scratch/notes.md", blocked)

        # 3. negation re-includes
        blocked, _ = is_blocked(str(keep), cwd=str(proj))
        check("!docs/keep/ re-includes", not blocked)

        # 3b. git parent-dir rule: cannot re-include below an excluded dir
        (proj / ".agentignore").write_text("random/\n!random/HELLO.md\n")
        clear_cache()
        hello = proj / "random" / "HELLO.md"
        hello.parent.mkdir(parents=True, exist_ok=True)
        hello.write_text("hi")
        blocked, _ = is_blocked(str(hello), cwd=str(proj))
        check("dir/ + !file stays blocked (git rule)", blocked)

        # 3c. dir/* + !file re-includes; siblings stay blocked
        (proj / ".agentignore").write_text("random/*\n!random/HELLO.md\n")
        clear_cache()
        bye = proj / "random" / "BYE.md"
        bye.write_text("bye")
        blocked, _ = is_blocked(str(hello), cwd=str(proj))
        check("dir/* + !file re-includes", not blocked)
        blocked, _ = is_blocked(str(bye), cwd=str(proj))
        check("dir/* + !file keeps siblings blocked", blocked)

        # 3d. re-included dir lets contents through; excluded dir cannot be
        # re-entered by a deeper negation
        (proj / ".agentignore").write_text("random/*\n!random/sub/\n")
        clear_cache()
        subfile = proj / "random" / "sub" / "x.md"
        subfile.parent.mkdir(parents=True, exist_ok=True)
        subfile.write_text("x")
        blocked, _ = is_blocked(str(subfile), cwd=str(proj))
        check("re-included dir lets contents through", not blocked)
        (proj / ".agentignore").write_text("random/\n!random/sub/\n")
        clear_cache()
        blocked, _ = is_blocked(str(subfile), cwd=str(proj))
        check("excluded dir cannot be re-entered (git rule)", blocked)

        # restore the original rules for the remaining tests
        (proj / ".agentignore").write_text(
            "# secrets\n.env\n.env.*\n\n# scratch notes\n/docs/scratch/\n\n# keep a doc\n!docs/keep/\n"
        )
        clear_cache()

        # 4. unrelated files pass
        blocked, _ = is_blocked(str(src), cwd=str(proj))
        check("src/main.py not blocked", not blocked)

        # 5. relative paths resolve against cwd
        blocked, _ = is_blocked("docs/scratch/notes.md", cwd=str(proj))
        check("relative path resolves via cwd", blocked)

        # 6. nested .agentignore overrides parent (deeper wins)
        (proj / "docs" / "scratch" / ".agentignore").write_text("!notes.md\n")
        clear_cache()
        blocked, _ = is_blocked(str(scratch), cwd=str(proj))
        check("nested file re-includes notes.md", not blocked)
        nested_env = proj / "docs" / "scratch" / "x.env"
        nested_env.write_text("X=1")
        blocked, _ = is_blocked(str(nested_env), cwd=str(proj))
        check("nested file does not unblock unrelated paths", blocked)

        # 7. global ~/.agentsignore — lowest precedence, overridable locally
        old_global = GLOBAL_FILE
        fake_global = root / ".agentsignore"
        import ignore as ignore_mod

        ignore_mod.GLOBAL_FILE = fake_global
        fake_global.write_text("*.secret\n")
        clear_cache()
        s = root / "proj" / "src" / "data.secret"
        s.write_text("s")
        blocked, src_f = is_blocked(str(s), cwd=str(proj))
        check("global file blocks *.secret", blocked and src_f == str(fake_global))
        # local negation overrides global
        (proj / ".agentignore").write_text(
            "# secrets\n.env\n.env.*\n\n# scratch notes\n/docs/scratch/\n\n# keep a doc\n!docs/keep/\n\n!src/*.secret\n"
        )
        clear_cache()
        blocked, _ = is_blocked(str(s), cwd=str(proj))
        check("local !src/*.secret overrides global", not blocked)
        ignore_mod.GLOBAL_FILE = old_global

        # 8. symlink cannot bypass (realpath checked)
        if hasattr(os, "symlink"):
            outside = root / "outside-secret.md"
            outside.write_text("s")
            link = proj / "docs" / "scratch" / "link.md"
            try:
                link.symlink_to(outside)
                blocked, _ = is_blocked(str(link), cwd=str(proj))
                check("symlink into blocked dir is blocked", blocked)
            except OSError:
                print("[skip] symlink not permitted")

        # 9. nonexistent path still matches rules (write protection)
        blocked, _ = is_blocked(str(proj / ".env.local"), cwd=str(proj))
        check("nonexistent .env.local blocked (writes)", blocked)

        # --- guard: hook directives ---
        check(
            "read_file blocked",
            guard_check("read_file", {"path": str(env_file)})["action"] == "block",
        )
        check(
            "write_file blocked",
            guard_check("write_file", {"path": str(env_file)})["action"] == "block",
        )
        check(
            "patch blocked",
            guard_check("patch", {"path": str(env_file)})["action"] == "block",
        )
        check(
            "search_files blocked",
            guard_check("search_files", {"path": str(proj / "docs" / "scratch")})["action"] == "block",
        )
        check(
            "unrelated read_file passes",
            guard_check("read_file", {"path": str(src)}) is None,
        )
        check(
            "terminal cat blocked",
            guard_check("terminal", {"command": f"cat {env_file}"})["action"] == "block",
        )
        check(
            "terminal ls blocked dir",
            guard_check("terminal", {"command": f"ls -la {proj}/docs/scratch"})["action"] == "block",
        )
        check(
            "execute_code blocked",
            guard_check("execute_code", {"code": f"open('{env_file}').read()"})["action"] == "block",
        )
        check(
            "terminal unrelated passes",
            guard_check("terminal", {"command": "ls -la /tmp"}) is None,
        )
        check(
            "empty args pass",
            guard_check("read_file", {}) is None,
        )

        # --- protected ignore files: read-only for agents ---
        ai = proj / ".agentignore"
        check(
            "write_file on .agentignore blocked",
            guard_check("write_file", {"path": str(ai)})["action"] == "block",
        )
        check(
            "patch on .agentignore blocked",
            guard_check("patch", {"path": str(ai)})["action"] == "block",
        )
        check(
            "write_file on ~/.agentsignore blocked",
            guard_check("write_file", {"path": str(Path.home() / ".agentsignore")})["action"] == "block",
        )
        check(
            "read_file on .agentignore allowed",
            guard_check("read_file", {"path": str(ai)}) is None,
        )
        check(
            "terminal cat .agentignore allowed",
            guard_check("terminal", {"command": f"cat {ai}"}) is None,
        )
        check(
            "terminal rm .agentignore blocked",
            guard_check("terminal", {"command": f"rm {ai}"})["action"] == "block",
        )
        check(
            "terminal rm -rf blocked dir still blocked",
            guard_check("terminal", {"command": f"rm -rf {proj}/docs/scratch"})["action"] == "block",
        )
        check(
            "execute_code write_text on .agentignore blocked",
            guard_check("execute_code", {"code": f"Path('{ai}').write_text('x')"})["action"] == "block",
        )

    print()
    if FAILED:
        print(f"{len(FAILED)} FAILED: {FAILED}")
        sys.exit(1)
    print("all tests passed")


if __name__ == "__main__":
    main()
