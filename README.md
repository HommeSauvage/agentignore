# agentignore

A proposed standard for coding agents: a `.agentignore` file, listing paths
that must not be read, opened, or modified.

Same syntax as `.gitignore`. Anything listed in `.agentignore` is treated as
if it does not exist: not read, not listed, not edited, not put in context.
Agents read `.agentignore` to honor it. They never modify or delete it.

- The spec: [agentignore.org](https://agentignore.org)
- Reference implementations: `extensions/`

## Honor system, not security

`.agentignore` is a convention, not a security boundary. Harnesses enforce
it on a best-effort basis, and that is by design: models have escaped
difficult sandboxes, and a model determined to read a file can likely find a
way around any ignore file. Anything truly sensitive belongs outside the
machines where agents are deployed. For everything that must live on disk —
`.env` files, scratch notes, private folders — `.agentignore` is enough to
keep it out of day-to-day operations.

## Layout

- `web/` — the spec website
- `extensions/` — reference implementations for specific harnesses

## Extensions

| Harness | Extension | Status |
|---|---|---|
| Hermes | [hermes-agentignore](extensions/hermes-agentignore/) | v0.1.0 — hard block via `pre_tool_call` hook (pathspec) |
| pi | [pi-agentignore](extensions/pi-agentignore/) | v0.1.0 — hard block via `tool_call` hook (`ignore` npm) |
| opencode v1 | [opencode-agentignore](extensions/opencode-agentignore/) | v0.1.0 — hard block via `tool.execute.before` hook (`ignore` npm) |

These extensions make the standard usable today. They are a bridge, not the
destination. When harnesses embed `.agentignore` into their core, the
extensions should be retired.

## Running the site

```sh
cd web && bun serve.ts   # http://localhost:3000
```

## License

MIT. See [LICENSE](LICENSE).
