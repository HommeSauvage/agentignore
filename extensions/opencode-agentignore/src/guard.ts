/**
 * tool_call evaluation and result redaction for opencode (v1).
 *
 * Blocking happens in the `tool.execute.before` plugin hook: any tool whose
 * arguments reference an ignored path throws before the tool executes, so the
 * tool never runs and the model sees an error result. Covered:
 *
 *  - path tools: `read` / `write` / `edit` (`filePath`), `grep` / `glob`
 *    (`path`) — hard block, existence not required (writing a NEW file into
 *    an ignored directory is blocked too)
 *  - shell tools: `bash` / `pwsh` / `powershell` / `cmd` (`command`,
 *    `workdir`) — the command is statically scanned for referenced paths
 *    (quote-splitting, $(), variables, cd, globs, case tricks — see bash.ts)
 *  - `apply_patch` — `*** Update/Add/Delete File:` headers are path
 *    references
 *  - any other tool (MCP, custom): args are classified by SHAPE, never by
 *    tool name — path-like keys are candidates, nested args are recursed
 *
 * The spec makes ignore files READ-ONLY for agents: write/delete/rename of
 * any `.agentignore`/`.agentsignore` is always blocked via write tools,
 * patch headers, and mutating shell commands. Reading the rules stays
 * allowed.
 *
 * Redaction happens in `tool.execute.after`: listing/search/shell output
 * lines that mention ignored paths are dropped before the model sees them,
 * so ignored paths are "treated as if they do not exist" even when a tool
 * walks a directory that contains them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { scanCommand } from "./bash.ts";
import type { IgnoreEngine } from "./engine.ts";
import { PATH_KEYS, PROTECTED_BASENAMES, resolvePath } from "./shared.ts";

export interface BlockDecision {
	block: boolean;
	reason?: string;
}

/** Built-in tools whose args carry a direct file path. */
const PATH_TOOL_ARGS: Record<string, string[]> = {
	read: ["filePath"],
	write: ["filePath"],
	edit: ["filePath"],
	grep: ["path"],
	glob: ["path"],
};

const SHELL_TOOLS = new Set(["bash", "pwsh", "powershell", "cmd"]);

/** Tools that WRITE to their target path. */
const WRITE_TOOLS = new Set(["write", "edit"]);

/** `*** Add File: x` / `*** Update File: x` / `*** Delete File: x` headers. */
const PATCH_HEADER_RE = /\*\*\* (?:Add|Update|Delete|Move) File:\s*(.+)$/gm;

/** Keys whose string values are never paths (prompt text, code, patterns...). */
const TEXT_KEYS = new Set([
	"pattern",
	"query",
	"prompt",
	"text",
	"content",
	"oldText",
	"newText",
	"task",
	"message",
	"title",
	"description",
	"reason",
	"name",
	"agent",
	"action",
	"to",
	"workflowScript",
	"code",
	"input",
	"output",
	"schema",
	"model",
	"patchText",
]);

/** Keys whose string values are executable code — quoted path-like strings
 *  inside them are scanned as file references. */
const CODE_KEYS = new Set(["code", "script", "source"]);

/** Keys that indicate a tool WRITES content, not just reads. */
const WRITE_KEYS = new Set([
	"content",
	"contents",
	"data",
	"text",
	"newText",
	"oldText",
	"edits",
	"body",
]);

/** Keys that carry a tool/method name (MCP `{server, tool, args}` etc.). */
const OP_KEYS = new Set(["tool", "method", "operation", "op"]);

/** Tool-op values that delete/rename/overwrite — ignore files are read-only. */
const DESTRUCTIVE_OPS =
	/^(delete|remove|unlink|rm|truncate|erase|clear|destroy|rename|move|overwrite|reset)/i;

interface ScannedInput {
	shellCommands: string[];
	fileUrls: string[];
	pathArgs: string[];
	existingPaths: string[];
	codeArgs: string[];
	writeShaped: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function scanInput(input: unknown, cwd: string, depth = 0): ScannedInput {
	const out: ScannedInput = {
		shellCommands: [],
		fileUrls: [],
		pathArgs: [],
		existingPaths: [],
		codeArgs: [],
		writeShaped: false,
	};
	if (depth > 4) return out;
	if (Array.isArray(input)) {
		for (const item of input) {
			const sub = scanInput(item, cwd, depth + 1);
			merge(out, sub);
		}
		return out;
	}
	if (!isPlainObject(input)) return out;

	const keys = Object.keys(input);
	if (
		keys.some((k) => PATH_KEYS.has(k)) &&
		keys.some((k) => WRITE_KEYS.has(k))
	) {
		out.writeShaped = true;
	}

	for (const [k, v] of Object.entries(input)) {
		if (v === null || v === undefined) continue;
		if (SHELL_TOOLS.has(k) && typeof v === "string") {
			out.shellCommands.push(v);
			continue;
		}
		if (k === "command" || k === "cmd") {
			if (typeof v === "string") out.shellCommands.push(v);
			continue;
		}
		if ((k === "url" || k === "urls" || k === "uri") && typeof v === "string") {
			if (/^file:/i.test(v)) out.fileUrls.push(v);
			continue;
		}
		if (OP_KEYS.has(k) && typeof v === "string" && DESTRUCTIVE_OPS.test(v)) {
			out.writeShaped = true;
			continue;
		}
		if (typeof v === "string") {
			if (PATH_KEYS.has(k)) {
				out.pathArgs.push(v);
			} else if (CODE_KEYS.has(k)) {
				out.codeArgs.push(v);
			} else if (!TEXT_KEYS.has(k) && depth > 0) {
				// Nested args (mcp, custom tools): a string that resolves to an
				// existing path is a candidate regardless of key name.
				const resolved = resolveExisting(v, cwd);
				if (resolved) out.existingPaths.push(resolved);
			}
			continue;
		}
		if (Array.isArray(v) || isPlainObject(v)) {
			merge(out, scanInput(v, cwd, depth + 1));
		}
	}
	return out;
}

function merge(out: ScannedInput, sub: ScannedInput): void {
	out.shellCommands.push(...sub.shellCommands);
	out.fileUrls.push(...sub.fileUrls);
	out.pathArgs.push(...sub.pathArgs);
	out.existingPaths.push(...sub.existingPaths);
	out.codeArgs.push(...sub.codeArgs);
	out.writeShaped = out.writeShaped || sub.writeShaped;
}

function resolveExisting(v: string, cwd: string): string | undefined {
	const abs = resolvePath(v, cwd);
	try {
		fs.statSync(abs);
		return abs;
	} catch {
		return undefined;
	}
}

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Check a candidate path (plus its symlink target, if any) against the engine. */
function checkPath(abs: string, engine: IgnoreEngine): boolean {
	if (engine.isIgnored(abs, isDir(abs))) return true;
	try {
		const real = fs.realpathSync(abs);
		if (real !== abs && engine.isIgnored(real, isDir(real))) return true;
	} catch {
		// broken symlink / missing — the literal path was already checked
	}
	return false;
}

/** Check an ignore-file path for write protection. */
function protectedFile(abs: string): boolean {
	return PROTECTED_BASENAMES.has(path.basename(abs));
}

/**
 * Decide whether a tool call must be blocked. `cwd` is the project directory
 * (opencode passes absolute paths to read/write/edit, but relative paths
 * appear in bash workdirs, grep/glob paths and MCP args).
 */
export function evaluateToolCall(
	toolName: string,
	args: Record<string, unknown> | undefined,
	cwd: string,
	engine: IgnoreEngine,
): BlockDecision {
	if (!args) return { block: false };

	// 1. Built-in path tools.
	const pathKeys = PATH_TOOL_ARGS[toolName];
	if (pathKeys) {
		for (const key of pathKeys) {
			const v = args[key];
			if (typeof v !== "string" || v === "") continue;
			const abs = resolvePath(v, cwd);
			if (checkPath(abs, engine)) {
				return {
					block: true,
					reason: `Blocked by .agentignore: "${v}" is ignored`,
				};
			}
			if (WRITE_TOOLS.has(toolName) && protectedFile(abs)) {
				return {
					block: true,
					reason: `Blocked by .agentignore: "${v}" is protected from modification`,
				};
			}
		}
	}

	// 2. Shell tools: statically scan the command for referenced paths.
	if (SHELL_TOOLS.has(toolName) && typeof args.command === "string") {
		const baseDir =
			typeof args.workdir === "string" && args.workdir !== ""
				? resolvePath(args.workdir, cwd)
				: cwd;
		const { paths: refs, protectedFiles, mutating } = scanCommand(
			args.command,
			baseDir,
		);
		for (const p of refs) {
			if (checkPath(p, engine)) {
				return {
					block: true,
					reason: `Blocked by .agentignore: "${p}" is referenced by the command`,
				};
			}
		}
		if (protectedFiles.length > 0 && mutating) {
			return {
				block: true,
				reason: `Blocked by .agentignore: "${protectedFiles[0]}" is protected from modification`,
			};
		}
	}

	// 3. apply_patch headers reference the files they modify.
	if (toolName === "apply_patch" && typeof args.patchText === "string") {
		for (const m of args.patchText.matchAll(PATCH_HEADER_RE)) {
			const p = m[1].trim();
			if (!p) continue;
			const abs = resolvePath(p, cwd);
			if (checkPath(abs, engine)) {
				return {
					block: true,
					reason: `Blocked by .agentignore: "${p}" is ignored`,
				};
			}
			if (protectedFile(abs)) {
				return {
					block: true,
					reason: `Blocked by .agentignore: "${p}" is protected from modification`,
				};
			}
		}
	}

	// 4. Shape-based scan for everything else (MCP, custom tools).
	const scanned = scanInput(args, cwd);

	for (const command of scanned.shellCommands) {
		const { paths: refs, protectedFiles, mutating } = scanCommand(command, cwd);
		for (const p of refs) {
			if (checkPath(p, engine)) {
				return {
					block: true,
					reason: `Blocked by .agentignore: "${p}" is referenced by the command`,
				};
			}
		}
		if (protectedFiles.length > 0 && mutating) {
			return {
				block: true,
				reason: `Blocked by .agentignore: "${protectedFiles[0]}" is protected from modification`,
			};
		}
	}

	if (scanned.fileUrls.length > 0) {
		return {
			block: true,
			reason: "Blocked by .agentignore: file:// URLs are not allowed",
		};
	}

	for (const p of scanned.pathArgs) {
		const abs = resolvePath(p, cwd);
		if (checkPath(abs, engine)) {
			return {
				block: true,
				reason: `Blocked by .agentignore: "${p}" is ignored`,
			};
		}
		if (scanned.writeShaped && protectedFile(abs)) {
			return {
				block: true,
				reason: `Blocked by .agentignore: "${p}" is protected from modification`,
			};
		}
	}

	for (const abs of scanned.existingPaths) {
		if (checkPath(abs, engine)) {
			return {
				block: true,
				reason: `Blocked by .agentignore: "${abs}" is ignored`,
			};
		}
		if (scanned.writeShaped && protectedFile(abs)) {
			return {
				block: true,
				reason: `Blocked by .agentignore: "${abs}" is protected from modification`,
			};
		}
	}

	for (const code of scanned.codeArgs) {
		for (const q of code.matchAll(/['"`]([^'"`]+)['"`]/g)) {
			const ref = q[1];
			if (!ref || ref.length > 512 || ref.includes(" ")) continue;
			const resolved = resolveExisting(ref, cwd);
			if (!resolved) continue;
			if (checkPath(resolved, engine)) {
				return {
					block: true,
					reason: `Blocked by .agentignore: "${ref}" is referenced by code`,
				};
			}
			if (protectedFile(resolved)) {
				return {
					block: true,
					reason: `Blocked by .agentignore: "${ref}" is protected from modification`,
				};
			}
		}
	}

	return { block: false };
}

// ---------------------------------------------------------------------------
// Result redaction (tool.execute.after)
// ---------------------------------------------------------------------------

/** Classify the tool call's args to decide which redaction rules apply. */
function classifyInput(input: Record<string, unknown>): {
	shell: boolean;
	search: boolean;
	dirScope: string | null;
	hasAnyArg: boolean;
} {
	let shell = false;
	let search = false;
	let dirScope: string | null = null;
	let hasAnyArg = false;

	const walk = (obj: Record<string, unknown>, depth: number) => {
		if (depth > 4) return;
		for (const [k, v] of Object.entries(obj)) {
			if (v === null || v === undefined) continue;
			hasAnyArg = true;
			if (typeof v === "string") {
				if (k === "command" || k === "cmd") shell = true;
				if (k === "pattern" || k === "query") search = true;
				if (PATH_KEYS.has(k) && dirScope === null && v !== "") {
					dirScope = v;
				}
			} else if (Array.isArray(v) || (typeof v === "object" && v !== null)) {
				walk(v as Record<string, unknown>, depth + 1);
			}
		}
	};
	walk(input, 0);
	return { shell, search, dirScope, hasAnyArg };
}

/** Extract candidate path tokens from an output line. */
function lineTokens(line: string): string[] {
	const tokens: string[] = [];
	for (const raw of line.split(/\s+/)) {
		let t = raw.trim();
		if (!t || t === "-" || t === "." || t === "..") continue;
		// strip ls -l style metadata prefix
		t = t.replace(
			/^[bcdlps-][rwxsStT-]{9}\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+\d+:\d+\s+/,
			"",
		);
		t = t.replace(/[,;:'")\]]+$/, "");
		if (t.startsWith("-")) continue;
		tokens.push(t);
	}
	return tokens;
}

function resolveToken(t: string, cwd: string): string | null {
	const tryResolve = (s: string): string | null => {
		const abs = resolvePath(s, cwd);
		try {
			fs.statSync(abs);
			return abs;
		} catch {
			return null;
		}
	};

	let resolved = tryResolve(t);
	if (resolved) return resolved;

	// `path:line:content` grep format — check the prefix before the first ':'
	if (t.includes(":")) {
		const prefix = t.slice(0, t.indexOf(":"));
		if (prefix.includes("/") || prefix.startsWith(".")) {
			resolved = tryResolve(prefix);
			if (resolved) return resolved;
		}
	}

	// git diff/log path prefixes: `a/.env`, `b/.env`
	const gitPrefix = t.match(/^[ab]\/(.+)$/);
	if (gitPrefix) {
		resolved = tryResolve(gitPrefix[1]);
		if (resolved) return resolved;
	}
	return null;
}

/**
 * Redact ignored paths from a tool result's text output (opencode's
 * `tool.execute.after` hook receives `output.output` as a plain string).
 * Returns the redacted string, or undefined when nothing changed.
 */
export function redactString(
	input: Record<string, unknown>,
	text: string,
	cwd: string,
	engine: IgnoreEngine,
): string | undefined {
	if (!text) return undefined;
	const cls = classifyInput(input);

	// Nothing to do: no shell command, no search pattern, no dir-scoped path,
	// and the call had arguments (so no implicit cwd scope either).
	if (!cls.shell && !cls.search && cls.dirScope === null && cls.hasAnyArg)
		return undefined;

	let dirScoped = false;
	if (cls.dirScope !== null) {
		const abs = path.isAbsolute(cls.dirScope)
			? cls.dirScope
			: path.resolve(cwd, cls.dirScope);
		try {
			dirScoped = fs.statSync(abs).isDirectory();
		} catch {
			// path doesn't exist (e.g. a write target) — no listing to redact
			return undefined;
		}
		if (!dirScoped) {
			// a single file was blocked if ignored — its output can't mention
			// ignored paths
			return undefined;
		}
	}

	const opts = { shell: cls.shell, search: cls.search, dirScope: dirScoped, cwd };
	let redactedLines = 0;
	let changed = false;
	const memo = new Map<string, boolean>();

	const isIgnored = (abs: string): boolean => {
		let r = memo.get(abs);
		if (r === undefined) {
			let isDir = false;
			try {
				isDir = fs.statSync(abs).isDirectory();
			} catch {
				return false;
			}
			r = engine.isIgnored(abs, isDir);
			memo.set(abs, r);
		}
		return r;
	};

	// git diff/log hunk tracking: once a `diff --git a/x b/x` header names an
	// ignored path, drop every line until the next header.
	let hunkIgnored = false;
	const isHunkHeader = (line: string) => /^diff --git a\//.test(line);

	const kept: string[] = [];
	for (const line of text.split("\n")) {
		if (isHunkHeader(line)) {
			const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
			if (m) {
				const p = resolveToken(m[1], cwd);
				hunkIgnored = p !== null && isIgnored(p);
			}
			if (hunkIgnored) {
				redactedLines++;
				changed = true;
				continue;
			}
		}
		if (hunkIgnored) {
			redactedLines++;
			changed = true;
			continue;
		}
		if (lineShouldDrop(line, opts, isIgnored)) {
			redactedLines++;
			changed = true;
		} else {
			kept.push(line);
		}
	}

	if (!changed) return undefined;
	return kept.join("\n");
}

function lineShouldDrop(
	line: string,
	opts: { shell: boolean; search: boolean; dirScope: boolean; cwd: string },
	isIgnored: (abs: string) => boolean,
): boolean {
	const tokens = lineTokens(line);
	if (tokens.length === 0) return false;

	for (const t of tokens) {
		const resolved = resolveToken(t, opts.cwd);
		if (!resolved) continue;
		if (!isIgnored(resolved)) continue;

		const isPathToken =
			t.includes("/") ||
			path.isAbsolute(t) ||
			t.startsWith("~") ||
			t.startsWith(".");
		// Bare entries (no slash) are only treated as paths when the result is
		// directory-scoped — `ls` of a dir. In shell/search output a bare
		// filename could be prose, so require a path-shaped token.
		if (isPathToken || opts.dirScope) return true;
	}
	return false;
}
