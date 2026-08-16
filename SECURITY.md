# Security

This repository hosts a spec website and agent extensions. Extensions run
inside coding agents and control file access, so treat them as security code.

## Reporting a vulnerability

Do not open a public issue for security problems. Report privately:

- GitHub: use the repository's private vulnerability reporting flow.
- Email: security@agentignore.org (once the domain is live).

Include: what the extension is, the affected version, a minimal reproduction
(two files: a `.agentignore` and a path that should be blocked), and the
impact.

## What matters

For context: `.agentignore` is an honor system, not a security boundary.
Harnesses enforce it on a best-effort basis, and a model determined to read
a file can likely find a way around any tool-level block. Anything truly
sensitive should live outside the machines where agents are deployed. The
bullets below describe the extensions' job — making that best effort as
strong as it can be — so treat bypasses as bugs, not as the standard failing.

- A matched path must never be read, opened, modified, or included in agent
  context. Bypasses (symlinks, case-insensitive filesystems, path
  normalization tricks) are vulnerabilities.
- `~/.agentsignore` and project files must follow gitignore precedence
  exactly.
- `.agentignore` files are read-only for agents. Modifying or deleting one
  to lift a block is a vulnerability.
