/**
 * tool_call evaluation — shape-based, not tool-name-based.
 *
 * Tools are classified by their ARGUMENT SHAPE so the extension works with
 * any tool, built-in or third-party, without naming it:
 *
 *  - SHELL: input has a `command` key → the command is statically scanned for
 *    referenced paths.
 *  - URL: input has `url`/`urls`/`uri` keys → `file://` is always blocked.
 *  - PATH: input has path-like keys (`path`, `dir`, `file`, `cwd`, ...) →
 *    each value is checked against the ignore engine. Existence is not
 *    required: writing a NEW file into an ignored directory is also blocked.
 *  - nested objects/arrays (mcp args, custom tools): recursed; string values
 *    under path-like keys are candidates, and any other string that resolves
 *    to an existing path is a candidate too (covers MCP filesystem servers
 *    with arbitrary key names). Text-ish keys (`task`, `pattern`, `content`,
 *    ...) are never treated as paths.
 *
 * The spec makes .agentignore files READ-ONLY for agents: any write-shaped
 * call (path + content keys), any destructive tool op (tool/method values
 * like delete/remove/unlink/rename), any shell command that could write, and
 * code args referencing them are blocked. Reading the rules stays allowed.
 *
 * This means `ffgrep`, `hypa_read`, `mcp`, or a future tool with a `path`
 * argument are all covered without the extension knowing they exist.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { scanCommand } from "./bash.ts";
import type { IgnoreEngine } from "./ignore.ts";
import { PATH_KEYS, PROTECTED_BASENAMES, resolvePath } from "./shared.ts";

export interface BlockDecision {
	block: boolean;
	reason?: string;
}

const SHELL_KEYS = new Set(["command", "cmd"]);

const URL_KEYS = new Set(["url", "urls", "uri"]);

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
]);

/** Keys whose string values are executable code (mcpScript etc.) — quoted
 *  path-like strings inside them are scanned as file references. */
const CODE_KEYS = new Set(["code", "workflowScript", "script", "source"]);

/** Keys that indicate a tool WRITES content, not just reads (write/edit shapes). */
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

/** Tool-op values that delete/rename/overwrite — the spec makes .agentignore
 *  read-only, so these count as write-shaped. */
const DESTRUCTIVE_OPS =
	/^(delete|remove|unlink|rm|truncate|erase|clear|destroy|rename|move|overwrite|reset)/i;

interface ScannedInput {
	shellCommands: string[];
	fileUrls: string[];
	pathArgs: string[]; // under path-like keys — existence not required
	existingPaths: string[]; // resolved existing paths found in nested args
	codeArgs: string[]; // executable code strings (mcpScript etc.)
	writeShaped: boolean; // input looks like a write (path + content keys)
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
		if (SHELL_KEYS.has(k) && typeof v === "string") {
			out.shellCommands.push(v);
			continue;
		}
		if (URL_KEYS.has(k)) {
			for (const u of Array.isArray(v) ? v : [v]) {
				if (typeof u === "string" && /^file:/i.test(u)) out.fileUrls.push(u);
			}
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
				// existing path is a candidate regardless of key name. Top-level
				// non-path keys are skipped to avoid false positives.
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

export function evaluateToolCall(
	toolName: string,
	input: Input | undefined,
	cwd: string,
	engine: IgnoreEngine,
): BlockDecision {
	if (!input) return { block: false };
	void toolName; // classification is by argument shape, not tool name

	const scanned = scanInput(input, cwd);

	// Shell commands: statically scan for referenced paths.
	for (const command of scanned.shellCommands) {
		const { paths: refs, protectedFiles, mutating } = scanCommand(command, cwd);
		for (const p of refs) {
			if (checkPath(p, engine)) {
				return {
					block: true,
					reason: `blocked by .agentignore: "${p}" is referenced by the command`,
				};
			}
		}
		// The model must never be able to weaken the rules: referencing an
		// ignore file in a command that could write it is blocked. Reading
		// the rules stays allowed.
		if (protectedFiles.length > 0 && mutating) {
			return {
				block: true,
				reason: `blocked by .agentignore: "${protectedFiles[0]}" is protected from modification`,
			};
		}
	}

	// file:// URLs are local file access in disguise.
	if (scanned.fileUrls.length > 0) {
		return {
			block: true,
			reason: "blocked by .agentignore: file:// URLs are not allowed",
		};
	}

	// Explicit path arguments (existence not required — creating a file inside
	// an ignored directory is a modification of an ignored path). Writing or
	// deleting an ignore file itself is always blocked.
	for (const p of scanned.pathArgs) {
		const abs = resolvePath(p, cwd);
		if (checkPath(abs, engine)) {
			return {
				block: true,
				reason: `blocked by .agentignore: "${p}" is ignored`,
			};
		}
		if (scanned.writeShaped && PROTECTED_BASENAMES.has(path.basename(abs))) {
			return {
				block: true,
				reason: `blocked by .agentignore: "${p}" is protected from modification`,
			};
		}
	}

	// Existing paths found in nested/unknown args.
	for (const abs of scanned.existingPaths) {
		if (checkPath(abs, engine)) {
			return {
				block: true,
				reason: `blocked by .agentignore: "${abs}" is ignored`,
			};
		}
		if (scanned.writeShaped && PROTECTED_BASENAMES.has(path.basename(abs))) {
			return {
				block: true,
				reason: `blocked by .agentignore: "${abs}" is protected from modification`,
			};
		}
	}

	// Code args (mcpScript, workflowScript): quoted path-like strings are
	// file references. `tools.call('read_file', { path: '.env' })` etc.
	for (const code of scanned.codeArgs) {
		for (const q of code.matchAll(/['"`]([^'"`]+)['"`]/g)) {
			const ref = q[1];
			if (!ref || ref.length > 512) continue;
			if (ref.includes(" ")) continue;
			const resolved = resolveExisting(ref, cwd);
			if (!resolved) continue;
			if (checkPath(resolved, engine)) {
				return {
					block: true,
					reason: `blocked by .agentignore: "${ref}" is referenced by code`,
				};
			}
			if (PROTECTED_BASENAMES.has(path.basename(resolved))) {
				return {
					block: true,
					reason: `blocked by .agentignore: "${ref}" is protected from modification`,
				};
			}
		}
	}

	return { block: false };
}

type Input = Record<string, unknown>;
