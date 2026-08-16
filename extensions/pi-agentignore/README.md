# pi-agentignore

A pi extension that enforces the [`.agentignore` standard](https://agentignore.org) at the tool-call level.

> Anything listed in a `.agentignore` must not be read, opened, or modified by any coding agent. Matched paths are treated as they do not exist.
> `.agentignore` files themselves are **read-only for agents**: they may be read, never modified, deleted, or created.

## What it enforces

| Layer | Mechanism | Covers |
|---|---|---|
| **Block** | `tool_call` hook returns `{ block: true }` **before the tool executes** | any tool whose args reference an ignored path — via path-like keys (`path`, `dir`, `file`, `cwd`, ...), `file://` URLs, or nested args (mcp servers); covers `read`/`write`/`edit`/`ls`/`find`/`grep` and any third-party tool with the same arg shapes |
| **Shell scan** | static scan of any tool with a `command` arg (`bash`, `hypa_shell`, ...) for referenced paths | `cat .env`, `head x/.env`, `git show HEAD:.env`, `curl file://…`, redirections, `$(<file)`, globs |
| **Redact** | `tool_result` hook filters output lines that mention ignored paths | `ls` of a directory containing ignored entries, recursive `grep`/`find` walking ignored dirs, shell output, `git diff`/`log -p` hunks |

**Universal, not name-based.** Tools are classified by argument *shape*, never by tool name: any tool — built-in, extension, or MCP — with a `path`-like arg, a `command` arg, or a `url` arg is covered without the extension knowing it exists. Text-ish args (`task`, `pattern`, `content`, ...) are never treated as paths, so prompts and search queries don't false-positive.

## .agentignore is read-only for agents

The spec makes the rules file itself untouchable — otherwise the hard block is trivially weakened. Blocked: writing/editing/creating/deleting/renaming any `.agentignore` via

- `write`/`edit` tools and any write-shaped tool call (path + content keys), including MCP `write_file`
- MCP delete/rename ops (`delete_file`, `rename`, ... detected by op-name shape)
- shell commands that reference an ignore file together with a mutator: redirects (`>`/`>>`), `rm`/`mv`/`chmod`/`git checkout`/`python`/`tee`/...
- **indirect deletion**: globs that match a `.agentignore` (recursive glob delete, redirect-to-glob), directory targets that contain one (recursive delete/move of a dir), `find -delete`/`-exec`, `git clean`
- `mcpScript`/`workflowScript` code strings referencing one

Reading the rules stays allowed (`cat .agentignore`, `read`, `grep`), so the agent can see what is off-limits — like `.gitignore`.

## Semantics (gitignore-compatible)

Pattern parsing and matching are delegated to the [`ignore`](https://github.com/kaelzhang/node-ignore) npm package — the de-facto standard gitignore engine (used by eslint, prettier, webpack; its test suite is ported from git's own). The extension adds what a stateless matcher can't: multi-file discovery, precedence, caching, and platform case policy.

- Same syntax as `.gitignore`: `#` comments, `!` negation, `dir/` directory patterns, anchored (`/foo`, `a/b`) vs unanchored (`foo`) patterns, `*`, `?`, `[...]`, `**`
- Nested `.agentignore` files: a file applies to its directory and everything below it; deeper files override shallower ones; last matching pattern wins
- A pattern matching a directory excludes everything below it (git's "cannot re-include below an excluded directory" rule)
- A `.agentignore` in your home directory acts as the **global file**, applied *last* so a user's exclusions always win over a project's re-includes (privacy-first). Patterns in it are unanchored by default; a leading `/` anchors to the filesystem root.
- The engine only ever `stat`s candidate paths; it never reads the contents of ignored files.

## Evasion hardening (what the shell scanner also handles)

Audited attack vectors, all blocked:

- **Quote-splitting**: `cat .e"nv"`, `cat .e$'nv'`, `cat .e'n'v` (token adjacency joining)
- **Embedded commands**: `eval "cat .env"`, `sh -c 'cat .env'`, `ssh host 'cat .env'`, `$(...)`, backticks, `$(<file)`
- **Variables**: `f=.env; cat $f`, `${f}`, `$f/rest` (same-command assignments)
- **Directory changes**: `cd sub && cat .env` (cd is tracked)
- **Globs**: `cat *`, `cat *.log`, `cat .[e]nv`, `cat **` + `/*.env` — expanded against the filesystem and each match checked
- **Case tricks**: `cat .ENV` on case-insensitive filesystems (macOS/Windows) — the engine matches case-insensitively there
- **Code-arg tools**: `mcpScript`/`workflowScript` strings are scanned for quoted path references (`tools.call('read_file', { path: '.env' })`)
- **git diff/log**: whole hunks for ignored paths are dropped (`diff --git a/x b/x`), not just the header lines; `a/`/`b/`-prefixed lines are handled

## Install

Global (recommended — subagent sessions load global extensions too):

```bash
mkdir -p ~/.pi/agent/extensions
ln -s <repo>/extensions/pi-agentignore ~/.pi/agent/extensions/pi-agentignore
```

Project-local:

```bash
mkdir -p .pi/extensions
ln -s <repo>/extensions/pi-agentignore .pi/extensions/pi-agentignore
```

Or load ad hoc: `pi -e ./src/index.ts`.

Verify: `/agentignore` shows active files, block/redaction stats, and can test a path (`/agentignore .env`).

## Limitations (read this — they're the spec-relevant part)

1. **Shell commands are arbitrary code.** The static scan is an approximation — it catches every *mention* of a path and the common evasion tricks above, but a determined model can still compute a path purely at runtime or extract content without mentioning paths: `find | xargs cat` pipelines, `grep -h` (content without filenames), `tar -xO` full-archive extraction, raw device reads, hardlink copies to a non-ignored name. **The only true hard block for shell is OS-level**: run commands inside a sandbox where ignored paths are unreadable. pi ships an official [sandbox extension](https://github.com/earendil-oss/pi/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts) (sandbox-exec on macOS / bubblewrap on Linux) that replaces the `bash` tool — compose it with this extension and generate its `denyRead` from your `.agentignore` files. That combination is the strongest enforcement available without modifying pi.
2. **Other extensions are trusted code.** Any extension's handler runs with full Node.js access and can read files itself and inject them into tool results or user messages. This extension cannot police its peers. The `.agentignore` contract is about the *agent harness's* tools; extensions are code, not agents.
3. **Subagent sessions** spawn separate pi processes. They load global extensions, so a global install covers them (including worktree children). Project-local installs cover children running in the same project dir. Children launched with a custom agent config that disables extensions are not covered.
4. **Cross-session channels** (`intercom`, a second pi session, the user themselves) can read files and forward contents. Tool args could be scanned heuristically, but that is not enforceable; the standard targets agent tool-level access.
5. **pi internals** (AGENTS.md/skills loading, session transcripts from before the extension was installed) are outside the tool-call layer.
6. **Content copying**: if a secret was already leaked, the model can write it into a non-ignored file — content-based detection is out of scope; the guarantee is about read access.
7. **Block messages disclose the path** of the blocked resource (never its content) — by design, so the model knows why it was blocked.

## Why this works in pi

The extension API exposes `tool_call` (pre-execution block, wired into agent-core's `beforeToolCall` hook — runs after argument validation, **before** `tool.execute()`) and `tool_result` (post-execution result replacement, wired into `afterToolCall`). Both hooks are installed once on the `Agent` instance and cover every tool dispatched through the agent loop — built-in, custom, extension, MCP, hypa — uniformly. `registerTool("bash", …)` can even replace the built-in bash tool entirely if you want to drop in a sandboxed variant.

## Development

```bash
npm install
node src/test.ts        # engine + scanner + redaction unit tests (123 checks)
npx tsc                # type-check (tsconfig maps @earendil-works/pi-coding-agent
                       # to your pi install — adjust the path if needed)
# live smoke test:
pi -p -e ./src/index.ts "read the .env file"
```
