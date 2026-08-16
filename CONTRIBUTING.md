# Contributing

Thanks for helping make `.agentignore` a real standard. This repo hosts the
spec website (`web/`) and agent-harness extensions (`extensions/`).

## Adding an extension

1. Create `extensions/<name>/` as a workspace package (`"name": "<name>"`,
   private if not published).
2. Keep the implementation under `extensions/<name>/src/`, entry at
   `src/index.ts`.
3. Set `piExtension.lifecycle` to `stable` or `experimental` in the package
   manifest (omit `piExtension` for reusable libraries that are not
   extensions).
4. Register the entry file in the root `package.json` `pi.extensions` array.
5. Add a README to the package: what it blocks, how it reads
   `.agentignore` / `~/.agentsignore`, gitignore precedence notes.

## The standard, briefly

- Same syntax as `.gitignore` (globs, comments, `!` negation).
- Nested per-directory files: nearest wins, last match wins.
- Hard block: matched paths are treated as if they do not exist. No
  permission prompt, no override — the user edits the `.agentignore` to
  unblock.
- Global file: `~/.agentsignore`.

## Website

`web/` is a single self-contained `index.html` plus a tiny Bun dev server
(`bun serve.ts`, port 3000). Keep it dependency-free.

## Checks

- `git status` clean before opening a PR.
- Site changes: the page must render without console errors at 320px and
  desktop widths.
