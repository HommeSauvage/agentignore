/**
 * tool_result redaction — shape-based, like tools.ts.
 *
 * Directory listings, search output and shell output can *mention* ignored
 * paths even when no individual tool call targets one (e.g. `ls` of a
 * directory that contains `.env`, or a recursive grep that walks an ignored
 * dir). The spec says ignored paths must not even be listed, so lines that
 * reference an ignored path are dropped from the result before the model sees
 * it.
 *
 * When is redaction applied? Classified by the call's argument shape, never
 * by tool name:
 *  - the input contained a shell command → shell output: drop lines that are
 *    (or start with) an ignored path
 *  - the input contained a search pattern → search output: drop `path:...`
 *    lines whose path is ignored
 *  - a path argument resolved to a directory → listing output: drop lines
 *    whose entry resolves to an ignored path
 *  - the input was empty → cwd-scoped listing (e.g. `ls` with no args)
 *
 * git diff/log output is handled too: a `diff --git a/x b/x` header naming an
 * ignored path drops the WHOLE hunk (content lines are not path-prefixed, so
 * line filtering alone would leak them).
 *
 * This is best-effort for shell output (a line of file *content* cannot be
 * recognized); the hard guarantee for shell comes from the block layer plus
 * OS-level sandboxing (see README).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { IgnoreEngine } from "./ignore.ts";
import { PATH_KEYS, resolvePath } from "./shared.ts";

/** Classify the tool call's input to decide which redaction rules apply. */
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

interface Options {
	shell: boolean;
	search: boolean;
	dirScope: string | null;
	cwd: string;
	engine: IgnoreEngine;
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
 * Redact ignored paths from a tool result's text content.
 * Returns the new content array and the number of dropped lines, or undefined
 * if nothing changed.
 */
export function redactResult(
	input: Record<string, unknown>,
	content: (TextContent | ImageContent)[],
	cwd: string,
	engine: IgnoreEngine,
):
	| { content: (TextContent | ImageContent)[]; redactedLines: number }
	| undefined {
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
			// path is a single file: it was blocked if ignored, so its output
			// cannot contain ignored paths — nothing to redact
			return undefined;
		}
	}

	const opts: Options = {
		shell: cls.shell,
		search: cls.search,
		dirScope: dirScoped ? cls.dirScope : null,
		cwd,
		engine,
	};

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

	const out = content.map((item) => {
		if (item.type !== "text") return item;
		const lines = item.text.split("\n");
		const kept: string[] = [];
		let itemChanged = false;
		for (const line of lines) {
			if (isHunkHeader(line)) {
				const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
				if (m) {
					const p = resolveToken(m[1], cwd);
					hunkIgnored = p !== null && isIgnored(p);
				}
				if (hunkIgnored) {
					redactedLines++;
					itemChanged = true;
					continue;
				}
			}
			if (hunkIgnored) {
				// inside a dropped hunk: drop everything until the next header
				redactedLines++;
				itemChanged = true;
				continue;
			}
			if (lineShouldDrop(line, opts, isIgnored)) {
				redactedLines++;
				itemChanged = true;
			} else {
				kept.push(line);
			}
		}
		if (!itemChanged) return item;
		changed = true;
		return { ...item, text: kept.join("\n") };
	});

	if (!changed) return undefined;
	return { content: out, redactedLines };
}

function lineShouldDrop(
	line: string,
	opts: Options,
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
