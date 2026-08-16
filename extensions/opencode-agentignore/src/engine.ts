/**
 * .agentignore pattern engine — gitignore-compatible semantics.
 *
 * Pattern parsing and matching are delegated to the `ignore` npm package
 * (the de-facto standard gitignore engine, used by eslint/prettier/webpack;
 * its test suite is ported from git's own). This module supplies what a
 * stateless pattern matcher cannot:
 *
 *  - multi-file discovery: every `.agentignore` from the filesystem root
 *    down to the target's directory, then the global file last
 *  - precedence: deeper files override shallower ones; the global file is
 *    applied LAST so user-level privacy decisions always win (privacy-first)
 *  - TTL/mtime caching so repeated tool calls don't re-read the files
 *  - platform case policy: case-insensitive matching on case-insensitive
 *    filesystems (macOS/Windows), case-sensitive elsewhere (git-exact)
 *
 * Semantics inherited from `ignore` (git's exclude algorithm):
 *  - `#` comments, `!` negation, trailing-slash directory-only patterns
 *  - patterns containing `/` are anchored to the file's directory; others
 *    match at any level below it
 *  - `*`, `?`, `[...]` within a segment; `**` as a whole segment
 *  - a pattern that matches a directory excludes everything below it; the
 *    walk stops at the first excluded directory (git's "cannot re-include
 *    a file if a parent directory is excluded" rule)
 *  - last matching pattern wins
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ignore from "ignore";

type Ignore = ReturnType<typeof ignore>;

export const LOCAL_FILE_NAME = ".agentignore";
/** The alternative global-file spelling (hermes uses ~/.agentsignore). */
export const GLOBAL_FILE_ALIAS = ".agentsignore";

/** The global ignore file: ~/.agentignore, falling back to ~/.agentsignore. */
export function defaultGlobalPath(): string {
	const primary = path.join(os.homedir(), LOCAL_FILE_NAME);
	try {
		fs.statSync(primary);
		return primary;
	} catch {
		// not present — fall back to the alias
	}
	return path.join(os.homedir(), GLOBAL_FILE_ALIAS);
}

interface IgnoreFile {
	dir: string;
	filePath: string;
	mtimeMs: number;
	matcher: Ignore;
	patternCount: number;
	/** The global file: matches against full absolute path segments so it
	 *  applies to paths outside its own directory too. */
	global?: boolean;
}

export const FILE_TTL_MS_DEFAULT = 1_000;

export class IgnoreEngine {
	private cache = new Map<string, IgnoreFile | null>();
	private lastStat = new Map<string, number>();
	private readonly ttlMs: number;
	readonly globalPath: string;
	/** Case-insensitive matching on case-insensitive filesystems (macOS/Windows):
	 *  `.ENV` is `.env`, so patterns must match case-insensitively. */
	readonly caseInsensitive: boolean;

	constructor(
		globalPath = defaultGlobalPath(),
		ttlMs = FILE_TTL_MS_DEFAULT,
		caseInsensitive = process.platform === "darwin" ||
			process.platform === "win32",
	) {
		this.globalPath = globalPath;
		this.ttlMs = ttlMs;
		this.caseInsensitive = caseInsensitive;
	}
	invalidate(): void {
		this.cache.clear();
		this.lastStat.clear();
	}

	/** Ordered list of ignore files that apply to `absPath`: project files from
	 *  filesystem root down to the target's directory, then the global file. */
	private filesFor(absPath: string): IgnoreFile[] {
		const dir = path.dirname(absPath);
		const files: IgnoreFile[] = [];

		// Walk ancestors from the target's dir up to the filesystem root.
		let current = path.resolve(dir);
		const chain: string[] = [];
		for (;;) {
			chain.push(current);
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
		// chain is leaf → root; reverse to root → leaf.
		for (let i = chain.length - 1; i >= 0; i--) {
			const f = this.loadFile(chain[i]);
			if (f) files.push(f);
		}

		const g = this.loadGlobal();
		if (g) files.push(g);
		return files;
	}

	private loadFile(dir: string): IgnoreFile | null {
		const filePath = path.join(dir, LOCAL_FILE_NAME);
		return this.load(filePath, dir);
	}

	private loadGlobal(): IgnoreFile | null {
		const f = this.load(this.globalPath, path.dirname(this.globalPath));
		if (f) f.global = true;
		return f;
	}

	private load(filePath: string, dir: string): IgnoreFile | null {
		const now = Date.now();
		const last = this.lastStat.get(filePath) ?? 0;
		const cached = this.cache.get(filePath);
		if (cached !== undefined && now - last < this.ttlMs) return cached;
		this.lastStat.set(filePath, now);

		let st: fs.Stats;
		try {
			st = fs.statSync(filePath);
		} catch {
			this.cache.set(filePath, null);
			return null;
		}
		if (cached && cached.mtimeMs === st.mtimeMs) {
			this.cache.set(filePath, cached);
			return cached;
		}
		let raw: string;
		try {
			raw = fs.readFileSync(filePath, "utf8");
		} catch {
			this.cache.set(filePath, null);
			return null;
		}
		const f: IgnoreFile = {
			dir,
			filePath,
			mtimeMs: st.mtimeMs,
			matcher: ignore({
				ignorecase: this.caseInsensitive,
				// paths are pre-normalized and guarded by the caller; the
				// global file matches full absolute path segments
				allowRelativePaths: true,
			}).add(raw),
			patternCount: countPatterns(raw),
		};
		this.cache.set(filePath, f);
		return f;
	}

	/**
	 * True if `absPath` (a file or directory) is covered by an ignore rule.
	 * `isDir` must be accurate: directory-only patterns depend on it.
	 */
	isIgnored(absPath: string, isDir: boolean): boolean {
		const resolved = path.resolve(absPath);
		const files = this.filesFor(resolved);
		if (files.length === 0) return false;

		// `ignore` expects a `/`-separated path relative to the ignore file's
		// directory (for the global file: the full absolute path without the
		// leading separator, so unanchored patterns match at any depth and a
		// leading `/` anchors to the filesystem root). A trailing `/` marks
		// the path as a directory, which directory-only patterns require.
		const suffix = isDir ? "/" : "";

		// Deeper files override shallower ones: evaluate in order (root → leaf
		// → global) and keep the LAST definitive decision. `test()` walks
		// ancestor directories internally (the parent-dir rule) and returns
		// `{ignored, unignored}` — both false when no pattern matched, so a
		// file that doesn't mention the path never overrides an earlier one.
		let decision: boolean | undefined;
		for (const f of files) {
			let rel: string;
			if (f.global) {
				rel = resolved.split(path.sep).filter(Boolean).join("/");
			} else {
				rel = path.relative(f.dir, resolved).split(path.sep).join("/");
				if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
			}
			if (!rel) continue;
			const r = f.matcher.test(rel + suffix);
			if (r.ignored) decision = true;
			else if (r.unignored) decision = false;
		}
		return decision ?? false;
	}

	/** The ignore files currently in scope for cwd (for status tools). */
	activeFiles(cwd: string): Array<{ filePath: string; count: number }> {
		return this.filesFor(path.join(cwd, "__probe__")).map((f) => ({
			filePath: f.filePath,
			count: f.patternCount,
		}));
	}
}

/** Number of real patterns in a rules document (for status display). */
export function countPatterns(raw: string): number {
	let n = 0;
	for (const line of raw.split(/\r?\n/)) {
		let l = line.replace(/(?<!\\) +$/, "");
		if (!l) continue;
		if (l.startsWith("\\#") || l.startsWith("\\!")) {
			n++;
			continue;
		}
		if (l.startsWith("#")) continue;
		if (l.startsWith("!")) l = l.slice(1);
		if (l) n++;
	}
	return n;
}
