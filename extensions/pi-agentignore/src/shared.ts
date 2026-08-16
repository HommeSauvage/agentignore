/**
 * Shared constants and helpers — path-key classification, protected
 * basenames, and home expansion, used by tools.ts, redact.ts and bash.ts.
 */

import * as os from "node:os";
import * as path from "node:path";

/** Keys whose string values are file paths (top-level or nested). */
export const PATH_KEYS = new Set([
	"path",
	"paths",
	"dir",
	"directory",
	"dirs",
	"file",
	"files",
	"filename",
	"cwd",
	"root",
	"target",
	"source",
	"destination",
	"src",
	"dst",
	"location",
	"where",
	"uriPath",
	"oldPath",
	"newPath",
]);

/** The spec makes ignore files read-only for agents. */
export const PROTECTED_BASENAMES = new Set([".agentignore"]);

/** Expand `~` and `~user` prefixes. */
export function expandHome(token: string): string {
	if (token === "~") return os.homedir();
	if (token.startsWith("~/")) return path.join(os.homedir(), token.slice(2));
	return token;
}

/** Resolve a (possibly relative, possibly `~`-prefixed) path against `baseDir`. */
export function resolvePath(t: string, baseDir: string): string {
	const expanded = expandHome(t);
	return path.isAbsolute(expanded)
		? path.normalize(expanded)
		: path.resolve(baseDir, expanded);
}
