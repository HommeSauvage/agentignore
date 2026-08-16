# hermes-agentignore

Makes [Hermes](https://hermes-agent.nousresearch.com) honor `.agentignore`
files. Blocks file tools at the code level via a `pre_tool_call` hook. No
prompts. It cannot be overridden.

The standard: [agentignore.org](https://agentignore.org).

## Install

```sh
ln -s <repo>/extensions/hermes-agentignore ~/.hermes/plugins/hermes-agentignore
hermes plugins enable hermes-agentignore
```

Restart Hermes (or the gateway) after enabling.

## What it blocks

- `read_file`, `search_files`, `write_file`, `patch` — hard block
- `terminal`, `execute_code` — best-effort scan of path-like tokens
- `.agentignore` / `~/.agentsignore` files — read-only for agents. Reads
  allowed, modification and deletion blocked.

## Semantics

gitignore syntax via `pathspec`. A `.agentignore` applies to its directory
and everything below it; deeper files override shallower ones.
`~/.agentsignore` applies everywhere, at the lowest precedence. `!` re-includes
a path. Symlinks cannot bypass.

## Test

```sh
<hermes-venv>/bin/python test_ignore.py
```
