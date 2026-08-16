/**
 * Static scanner for shell commands.
 *
 * A shell command is arbitrary code, so no scanner can *prove* which paths a
 * command touches. This scanner finds the paths a command *mentions* — and
 * handles the common evasion tricks:
 *
 *  - quotes split mid-token:      `cat .e"nv"`, `cat .e$'nv'`
 *  - embedded commands:           `eval "cat .env"`, `sh -c 'cat .env'`,
 *                                 `ssh host 'cat .env'`, `$(...)`, backticks
 *  - variables:                   `f=.env; cat $f`
 *  - directory changes:           `cd sub && cat .env`
 *  - globs:                       `cat *`, `cat *.log`, `cat .[e]nv`,
 *                                 `cat **` + `/*.env` (expanded against the FS)
 *  - case tricks on case-insensitive filesystems: `cat .ENV`
 *
 * It also enforces the spec's read-only rule for the ignore files themselves:
 * any command that references a `.agentignore` file and could WRITE it
 * (redirects, mutator commands like rm/mv/chmod/git checkout/python...) is
 * blocked, so the agent cannot modify or delete the rules. Reading the rules
 * stays allowed. This covers indirect deletion too:
 *  - globs that match a .agentignore (`cat *`, redirects to `*`)
 *  - directory targets that contain one (recursive delete of a directory)
 *  - `find -delete` / `-exec`, `git clean`
 *
 * Remaining holes (documented in README): pipelines that extract content
 * without mentioning paths, raw device reads, and anything that computes a
 * path purely at runtime. Closing those requires OS-level sandboxing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LOCAL_FILE_NAME } from "./engine.ts";
import { PROTECTED_BASENAMES, resolvePath as resolveToken } from "./shared.ts";

export interface ShellScanResult {
	/** Resolved existing paths the command references (ignore-checked by caller). */
	paths: string[];
	/** Referenced `.agentignore` files (resolved). */
	protectedFiles: string[];
	/** Command contains redirects or mutator commands (could write files). */
	mutating: boolean;
	unresolved: string[];
}

/** Commands that can write/delete/rename files (conservative). */
const MUTATORS = new Set([
	"rm",
	"mv",
	"cp",
	"chmod",
	"chown",
	"touch",
	"truncate",
	"tee",
	"ln",
	"unlink",
	"rename",
	"shred",
	"install",
	"dd",
	"mkdir",
	"rmdir",
	"git",
	"python",
	"python3",
	"perl",
	"ruby",
	"node",
	"php",
	"eval",
	"exec",
	"source",
	"sed",
	"install",
]);

/** git subcommands that only read. */
const GIT_READERS = new Set([
	"show",
	"log",
	"diff",
	"grep",
	"ls-files",
	"status",
	"blame",
	"branch",
	"tag",
]);

interface Word {
	text: string;
	start: number;
	end: number;
	adjacent: boolean; // directly abuts the previous word in source
}

/** Tokenize a shell command into ordered words. Quoted spans, `$(...)` and
 *  backticks are flattened in source order; escapes are consumed. */
function tokenize(command: string): Word[] {
	const out: Word[] = [];
	let i = 0;
	const n = command.length;
	let lastEnd = -1;

	const push = (text: string, start: number, end: number) => {
		if (text === "") return;
		out.push({ text, start, end, adjacent: start === lastEnd });
		lastEnd = end;
	};

	while (i < n) {
		const c = command[i];
		if (c === " " || c === "\t" || c === "\n") {
			i++;
			continue;
		}
		if (c === "#") break; // comment
		if (c === "\\") {
			// escaped char (mid-word escapes are handled by the word scan; a
			// leading backslash makes the next char literal)
			if (i + 1 < n) {
				push(command[i + 1], i, i + 2);
				i += 2;
			} else {
				i++;
			}
			continue;
		}
		// single-char operators — pushed as words so the scanner sees `>`/`>>`
		if ("|&;<>()".includes(c)) {
			push(c, i, i + 1);
			i++;
			continue;
		}
		if (c === "$" && command[i + 1] === "(") {
			const depth = findClosing(command, i + 1, "(", ")");
			if (depth >= 0) {
				let inner = command.slice(i + 2, depth);
				const lt = inner.trim();
				if (lt.startsWith("<")) inner = lt.slice(1).trim(); // $(<file)
				tokenize(inner).forEach((w) => {
					push(w.text, i + 2 + w.start, i + 2 + w.end);
				});
				i = depth + 1;
				continue;
			}
		}
		if (c === "`") {
			const end = command.indexOf("`", i + 1);
			if (end > i) {
				tokenize(command.slice(i + 1, end)).forEach((w) => {
					push(w.text, i + 1 + w.start, i + 1 + w.end);
				});
				i = end + 1;
				continue;
			}
		}
		// quoted spans: `"..."`, `'...'`, `$'...'`, `$"..."`.
		// Spans containing whitespace are tokenized as an inner command
		// (`eval "cat .env"`, `sh -c 'cat .env'`); plain strings stay single
		// words (`cat ".env"`, `cat "my file.txt"` stays one candidate).
		let quote = "";
		let qStart = i;
		if (c === '"' || c === "'") {
			quote = c;
		} else if (
			c === "$" &&
			(command[i + 1] === '"' || command[i + 1] === "'")
		) {
			quote = command[i + 1];
			qStart = i + 1;
		}
		if (quote) {
			const end = findQuoteEnd(command, qStart, quote);
			if (end > qStart) {
				const inner = command.slice(qStart + 1, end);
				if (/\s/.test(inner)) {
					// inner command (eval/sh -c/ssh) or a filename with spaces;
					// tokenizing both is safe — existence-gated path checks
					tokenize(inner).forEach((w) => {
						push(w.text, qStart + 1 + w.start, qStart + 1 + w.end);
					});
				} else {
					// for `$'...'`/`$"..."` the `$` abuts the previous word
					push(inner, c === "$" ? qStart - 1 : qStart, end + 1);
				}
				i = end + 1;
				continue;
			}
		}
		// bare word: read until whitespace or an unquoted operator
		let j = i;
		while (j < n) {
			const w = command[j];
			if (
				j > i &&
				(w === " " ||
					w === "\t" ||
					w === "\n" ||
					w === "|" ||
					w === "&" ||
					w === ";" ||
					w === "<" ||
					w === ">" ||
					w === "(" ||
					w === ")" ||
					w === "$" ||
					w === '"' ||
					w === "'" ||
					w === "`")
			)
				break;
			j++;
		}
		if (j > i) {
			push(command.slice(i, j), i, j);
			i = j;
		} else {
			i++;
		}
	}
	return out;
}

function findClosing(
	s: string,
	start: number,
	open: string,
	close: string,
): number {
	let depth = 1;
	for (let i = start + 1; i < s.length; i++) {
		if (s[i] === open) depth++;
		else if (s[i] === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function findQuoteEnd(s: string, start: number, quote: string): number {
	for (let i = start + 1; i < s.length; i++) {
		if (s[i] === "\\") {
			i++;
			continue;
		}
		if (s[i] === quote) return i;
	}
	return -1;
}

/** fnmatch-style single-segment matcher: `*`, `?`, `[...]`, `\` escapes.
 *  Used to expand glob tokens in shell commands against the filesystem.
 *  (Deliberately not the `ignore` package: this is shell-glob matching for
 *  the scanner's readdir expansion, not gitignore semantics.) */
export function matchSegment(pat: string, s: string, ci = false): boolean {
	if (ci) {
		pat = pat.toLowerCase();
		s = s.toLowerCase();
	}
	let pi = 0;
	let si = 0;
	let starP = -1;
	let starS = 0;
	while (si < s.length) {
		const pc = pi < pat.length ? pat[pi] : "";
		if (pc === "?" || pc === s[si]) {
			pi++;
			si++;
		} else if (pc === "*") {
			starP = pi++;
			starS = si;
		} else if (pc === "[") {
			let j = pi + 1;
			let neg = false;
			if (pat[j] === "!" || pat[j] === "^") {
				neg = true;
				j++;
			}
			let matched = false;
			let closed = false;
			for (; j < pat.length; j++) {
				if (pat[j] === "]" && j > pi + 1) {
					closed = true;
					break;
				}
				if (pat[j] === "\\" && j + 1 < pat.length) j++;
				if (j + 2 < pat.length && pat[j + 1] === "-" && pat[j + 2] !== "]") {
					const lo = pat.charCodeAt(j);
					const hi = pat.charCodeAt(j + 2);
					const c = s.charCodeAt(si);
					if (c >= lo && c <= hi) matched = true;
					j += 2;
				} else if (pat[j] === s[si]) {
					matched = true;
				}
			}
			if (closed && matched !== neg) {
				pi = j + 1;
				si++;
			} else if (starP >= 0) {
				pi = starP + 1;
				si = ++starS;
			} else {
				return false;
			}
		} else if (starP >= 0) {
			pi = starP + 1;
			si = ++starS;
		} else {
			return false;
		}
	}
	while (pi < pat.length && pat[pi] === "*") pi++;
	return pi === pat.length;
}

/** Scan a command for referenced paths, resolved against `cwd`. */
export function scanCommand(command: string, cwd: string): ShellScanResult {
	const words = tokenize(command);
	const vars = new Map<string, string>();
	let baseDir = cwd;
	let mutating = false;
	const paths: string[] = [];
	const protectedFiles: string[] = [];
	const unresolved: string[] = [];
	const seen = new Set<string>();

	const push = (abs: string) => {
		if (seen.has(abs)) return;
		seen.add(abs);
		if (PROTECTED_BASENAMES.has(path.basename(abs))) protectedFiles.push(abs);
		else paths.push(abs);
	};

	const consider = (token: string) => {
		if (!token || token.length === 0) return;
		let p = token;

		if (p.startsWith("file://")) {
			p = p.slice("file://".length);
			if (p.startsWith("localhost/")) p = p.slice("localhost".length);
			if (p === "") return;
		}
		p = p.replace(/[,;:'"]+$/, "");

		// `git show HEAD:path` / `git cat-file -p HEAD:path`
		if (p.includes(":")) {
			const after = p.slice(p.indexOf(":") + 1);
			if (
				after.startsWith("./") ||
				after.startsWith("/") ||
				after.includes("/") ||
				after.startsWith(".")
			) {
				const asPath = resolveToken(after, baseDir);
				try {
					fs.statSync(asPath);
					push(asPath);
					return;
				} catch {
					// fall through to whole-token check
				}
			}
		}

		const abs = resolveToken(p, baseDir);
		// protect the ignore files themselves even before they exist:
		// creating a new one must be blocked too
		if (PROTECTED_BASENAMES.has(path.basename(abs))) {
			push(abs);
			return;
		}
		try {
			const st = fs.statSync(abs);
			push(abs);
			// A directory target can hold a .agentignore; wiping the directory
			// (recursive delete/move/overwrite) would destroy the rules. Only
			// enforced when the command is mutating.
			if (st.isDirectory()) {
				try {
					fs.statSync(path.join(abs, LOCAL_FILE_NAME));
					push(path.join(abs, LOCAL_FILE_NAME));
				} catch {
					// no nested .agentignore
				}
			}
			return;
		} catch {
			// not an existing path — try the evasion variants
		}

		// absolute path that doesn't exist: may be a continuation of a command
		// substitution — `cat $(pwd)/.env` tokenizes as "/.env" → try cwd-relative
		if (path.isAbsolute(p)) {
			const rel = resolveToken(p.replace(/^\/+/, ""), baseDir);
			try {
				fs.statSync(rel);
				push(rel);
				return;
			} catch {
				// continue
			}
		}

		// quoted substrings inside a larger token:
		// `python -c "print(open('.env').read())"` → token contains '.env'
		for (const q of p.matchAll(/['"`]([^'"`]+)['"`]/g)) {
			const sub = q[1];
			if (!sub || sub.length > 512 || /\s/.test(sub)) continue;
			const sAbs = resolveToken(sub, baseDir);
			try {
				fs.statSync(sAbs);
				push(sAbs);
				return;
			} catch {
				// continue
			}
		}

		// quote-stripped: `cat .e'n'v` → `.env` (also for run-joined tokens)
		if (p.includes("'") || p.includes('"')) {
			const stripped = p.replace(/['"]/g, "");
			const sAbs = resolveToken(stripped, baseDir);
			try {
				fs.statSync(sAbs);
				push(sAbs);
				return;
			} catch {
				// continue
			}
		}

		// globs: expand against the filesystem, check each match
		if (/[*?[]/.test(p)) {
			let g = p;
			// strip leading `**/` or `*/` (globstar at root)
			while (g.startsWith("**/") || g.startsWith("*/"))
				g = g.slice(g.indexOf("/") + 1);
			const slash = g.lastIndexOf("/");
			const dirPart =
				slash >= 0 ? resolveToken(g.slice(0, slash), baseDir) : baseDir;
			const pattern = slash >= 0 ? g.slice(slash + 1) : g;
			try {
				const entries = fs.readdirSync(dirPart);
				let checked = 0;
				for (const e of entries) {
					if (++checked > 500) break;
					if (matchSegment(pattern, e)) {
						// route through push() so a glob that matches a
						// .agentignore is protected from mutating commands too
						push(path.join(dirPart, e));
					}
				}
			} catch {
				// dir unreadable/missing — nothing to expand
			}
			// char-class-stripped candidate: `.[e]nv` → `.env`
			const stripped = p.replace(/\[[^\]]*\]/g, "");
			if (stripped !== p) {
				const sAbs = resolveToken(stripped, baseDir);
				try {
					fs.statSync(sAbs);
					push(sAbs);
				} catch {
					// continue
				}
			}
			return;
		}

		unresolved.push(p);
	};

	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		const t = w.text;

		// `cd <dir>` changes the resolution base for the rest of the command
		if (t === "cd") {
			const next = words[i + 1];
			if (next && !next.text.startsWith("-")) {
				const abs = resolveToken(next.text, baseDir);
				try {
					if (fs.statSync(abs).isDirectory()) {
						baseDir = abs;
						i++;
					}
				} catch {
					// unknown dir — keep base
				}
			}
			continue;
		}

		// variable assignment: `f=.env`
		const assign = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (assign) {
			vars.set(assign[1], assign[2]);
			continue;
		}
		// variable reference: `$f`, `${f}`, `$f/rest`
		const varRef = t.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(\/.*)?$/);
		if (varRef) {
			const v = vars.get(varRef[1]);
			if (v !== undefined) consider(v + (varRef[2] ?? ""));
			continue;
		}

		// operators
		if (t === ">" || t === ">>") {
			mutating = true;
			continue;
		}
		if (["|", "&", ";", "(", ")", "&&", "||", "<", "<<"].includes(t)) continue;

		// flags
		if (t.startsWith("-")) {
			// `find . -delete` / `find . -exec ...` destroy files without
			// naming them — treat as mutating
			if (t === "-delete" || t === "-exec" || t === "-execdir" || t === "-ok")
				mutating = true;
			continue;
		}

		// mutator commands
		if (MUTATORS.has(t)) {
			if (t === "git") {
				const next = words[i + 1]?.text;
				if (next && GIT_READERS.has(next)) {
					i++; // consume the subcommand
					continue;
				}
				mutating = true;
				// `git clean` deletes untracked files (including a
				// .agentignore) without naming them
				if (next === "clean") {
					try {
						fs.statSync(path.join(baseDir, LOCAL_FILE_NAME));
						push(path.join(baseDir, LOCAL_FILE_NAME));
					} catch {
						// no .agentignore in the base dir
					}
				}
			} else {
				mutating = true;
			}
			continue;
		}

		consider(t);
		// adjacent words join into one token: `cat .e"nv"` → `.env`,
		// `cat .e'n'v` → `.env` (accumulate across the whole run)
		if (w.adjacent && i > 0) {
			if (!/^[\s|&;<>()]*$/.test(t)) {
				let joined = t;
				for (let k = i - 1; k >= 0 && words[k + 1].adjacent; k--) {
					joined = words[k].text + joined;
				}
				if (/^[\s|&;<>()]*$/.test(joined)) continue;
				consider(joined);
			}
		}
	}

	return { paths, protectedFiles, mutating, unresolved };
}
