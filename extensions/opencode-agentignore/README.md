# opencode-agentignore

An opencode (v1) plugin that enforces the [`.agentignore` standard](https://agentignore.org) at the tool-call level.

> Anything listed in a `.agentignore` must not be read, opened, or modified by any coding agent. Matched paths are treated as they do not exist.
> `.agentignore` files themselves are **read-only for agents**: they may be read, never modified, deleted, or created.

## What it enforces

| Layer | Mechanism | Covers |
|---|---|---|
| **Block** | `tool.execute.before` hook throws **before the tool executes** | `read` / `write` / `edit` (`filePath`), `grep` / `glob` (`path`), `apply_patch` (`*** Update File:` headers), and any MCP/custom tool via argument-*shape* classification (path-like keys, nested args) |
| **Shell scan** | static scan of `bash`/`pwsh`/`powershell`/`cmd` commands | `cat .env`, `head x/.env`, `git show HEAD:.env`, `$(<file)`, quote-splitting (`.e"nv"`), variables (`f=.env; cat $f`), `cd` tracking, globs (`cat *`), case tricks (`.ENV` on macOS/Windows) |
| **Redact** | `tool.execute.after` filters output lines that mention ignored paths | `ls` of a directory containing ignored entries, recursive grep/glob walking ignored dirs, shell output, `git diff`/`log -p` hunks (whole hunk dropped) |

## .agentignore is read-only for agents

Blocked: writing/editing/creating/deleting/renaming any `.agentignore` or `.agentsignore` via

- `write`/`edit` tools and any write-shaped tool call (path + content keys), including MCP `write_file`
- `apply_patch` headers targeting one
- shell commands that reference an ignore file together with a mutator: redirects (`>`/`>>`), `rm`/`mv`/`chmod`/`git checkout`/`python`/`tee`/…, globs that match one, directory targets that contain one, `find -delete`/`-exec`, `git clean`

Reading the rules stays allowed (`cat .agentignore`, `read`, `grep`), so the agent can see what is off-limits — like `.gitignore`.

## Semantics (gitignore-compatible)

Pattern parsing and matching are delegated to the [`ignore`](https://github.com/kaelzhang/node-ignore) npm package — the de-facto standard gitignore engine (used by eslint, prettier, webpack; its test suite is ported from git's own). The plugin adds what a stateless matcher can't: multi-file discovery, precedence, caching, and platform case policy.

- Same syntax as `.gitignore`: `#` comments, `!` negation, `dir/` directory patterns, anchored (`/foo`, `a/b`) vs unanchored (`foo`) patterns, `*`, `?`, `[...]`, `**`
- Nested `.agentignore` files: a file applies to its directory and everything below it; deeper files override shallower ones; last matching pattern wins
- A pattern matching a directory excludes everything below it (git's "cannot re-include below an excluded directory" rule) — use `dir/*` + `!dir/keep.md` to ignore a directory's contents while keeping one file
- A global file in your home directory (`~/.agentignore`, falling back to `~/.agentsignore`) is applied **last** so a user's exclusions always win over a project's re-includes (privacy-first); a leading `/` anchors to the filesystem root
- The engine only ever `stat`s candidate paths; it never reads the contents of ignored files

## Install

In `opencode.json` (`~/.config/opencode/opencode.json` or project `.opencode/opencode.json`):

```json
{
  "plugin": [
    "/path/to/this/repo/extensions/opencode-agentignore"
  ]
}
```

Or as an npm package (after publishing): `"plugin": ["opencode-agentignore"]`. The plugin's `./server` entrypoint is loaded from the package exports. No restart needed for config changes; the plugin re-initializes per session.

## Limitations (read these — they're the spec-relevant part)

1. **Shell commands are arbitrary code.** The static scan is an approximation — it catches every *mention* of a path and the common evasion tricks above, but a determined model can still compute a path purely at runtime or extract content without mentioning paths (`find | xargs cat`, `grep -h`, `tar -xO`, raw device reads). **The only true hard block for shell is OS-level** sandboxing. The path tools (`read`/`write`/`edit`/`grep`/`glob`/`apply_patch`) are an exact hard block.
2. **Other plugins are trusted code.** Any plugin runs with the same process permissions and can read files itself. The `.agentignore` contract is about the agent harness's tools; this plugin cannot police its peers.
3. **Block messages disclose the path** of the blocked resource (never its content) — by design, so the model knows why it was blocked.
4. **Model-side tools** (opencode's "computer use", browser tools, or a future agent that reads files through the model provider) are outside the plugin hook surface.

## Development

```bash
npm install
node src/test.ts   # engine + guard + redaction + shell-scan tests (54 checks)
npx tsc            # type-check (tsconfig maps @opencode-ai/plugin to your install)
# live smoke test:
opencode run "read the .env file"
```
