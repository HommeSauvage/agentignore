/**
 * pi-agentignore — honor the .agentignore standard in pi.
 *
 * Enforcement layers, in order of strength:
 *  1. BLOCK (tool_call): any tool whose arguments reference an ignored path is
 *     blocked before execution. The tool never runs; the model receives a
 *     synthetic error result. This covers read/write/edit/ls/find/grep, the
 *     hypa_* tools, mcp arg scanning, and file:// fetches.
 *  2. SHELL SCAN (tool_call): bash/hypa_shell commands are statically scanned
 *     for referenced paths; commands that mention ignored paths are blocked.
 *  3. REDACT (tool_result): listing/grep/shell outputs are filtered so ignored
 *     paths are not even shown ("treat as if they do not exist").
 *
 * The spec makes .agentignore files READ-ONLY for agents: modifying, deleting
 * or creating one is always blocked; reading the rules stays allowed.
 *
 * Install globally so subagent sessions inherit it:
 *   cp -r . ~/.pi/agent/extensions/pi-agentignore
 * (or point to this repo directly in ~/.pi/agent/extensions/).
 *
 * Hard-guarantee note: shell commands are arbitrary code, so the static scan
 * is an approximation. For a true hard block, compose with OS-level
 * sandboxing (sandbox-exec/bubblewrap) — see README.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IgnoreEngine } from "./ignore.ts";
import { redactResult } from "./redact.ts";
import { evaluateToolCall } from "./tools.ts";

export default function (pi: ExtensionAPI): void {
	const engine = new IgnoreEngine();
	let blockedCalls = 0;
	let redactedLines = 0;

	// Reload the engine when the global file changes. Local .agentignore files
	// are re-statted on a TTL by the engine itself.
	try {
		const w = fs.watch(engine.globalPath, () => engine.invalidate());
		w.on("error", () => undefined);
	} catch {
		// global file may not exist yet; the engine's TTL re-stat covers it
	}

	pi.on("tool_call", async (event, ctx) => {
		const decision = evaluateToolCall(
			event.toolName,
			event.input,
			ctx.cwd,
			engine,
		);
		if (decision.block) {
			blockedCalls++;
			if (ctx.hasUI) {
				ctx.ui.notify(decision.reason ?? "blocked by .agentignore", "warning");
			}
			return {
				block: true,
				reason: decision.reason ?? "blocked by .agentignore",
			};
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return undefined; // never touch our own block errors
		const text = event.content as TextContent[];
		if (!Array.isArray(text) || text.length === 0) return undefined;

		const redacted = redactResult(event.input, text, ctx.cwd, engine);
		if (!redacted) return undefined;

		redactedLines += redacted.redactedLines;
		// Drop details too: for bash they contain the full-output temp path,
		// which would let the model recover unredacted lines. ({} replaces;
		// undefined would be ignored by the merge.)
		return { content: redacted.content, details: {} };
	});

	pi.registerCommand("agentignore", {
		description: "Show active .agentignore files and block/redaction stats",
		handler: async (args, ctx) => {
			const files = engine.activeFiles(ctx.cwd);
			const lines = [
				`.agentignore status (cwd: ${ctx.cwd})`,
				`blocked tool calls: ${blockedCalls}`,
				`redacted lines: ${redactedLines}`,
				"",
				"active files:",
				...files.map((f) => `  ${f.filePath} (${f.count} patterns)`),
			];
			const probe = args.trim();
			if (probe) {
				const abs = path.isAbsolute(probe)
					? probe
					: path.resolve(ctx.cwd, probe);
				let isDir = false;
				try {
					isDir = fs.statSync(abs).isDirectory();
				} catch {
					/* not a path */
				}
				lines.push(
					"",
					`check "${probe}": ${engine.isIgnored(abs, isDir) ? "IGNORED" : "not ignored"}`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
