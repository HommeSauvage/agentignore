/**
 * opencode-agentignore — honor the .agentignore standard in opencode (v1).
 *
 * Install: add this package to the `plugin` array in opencode.json
 * (npm name or local path). Loaded as the `./server` entrypoint.
 *
 * Enforcement:
 *  1. BLOCK (`tool.execute.before`): any tool whose arguments reference an
 *     ignored path throws before the tool executes. The tool never runs;
 *     the model receives the error as the tool result.
 *  2. REDACT (`tool.execute.after`): listing/search/shell output lines that
 *     mention ignored paths are dropped, so ignored paths are "treated as
 *     if they do not exist" even when a tool walks a directory containing
 *     them.
 *
 * The spec makes .agentignore files READ-ONLY for agents: modifying,
 * deleting or creating one is always blocked; reading the rules stays
 * allowed.
 *
 * Hard-guarantee note: shell commands are arbitrary code, so the static
 * command scan is an approximation (see README.md). The hard block for the
 * path tools (read/write/edit/grep/glob) is exact.
 */

import * as fs from "node:fs";
import type { Plugin } from "@opencode-ai/plugin";
import { IgnoreEngine } from "./engine.ts";
import { evaluateToolCall, redactString } from "./guard.ts";

export const server: Plugin = async (input) => {
	const directory = input.directory || process.cwd();
	const engine = new IgnoreEngine();

	// Reload the engine when the global file changes. Local .agentignore files
	// are re-statted on a TTL by the engine itself.
	try {
		const w = fs.watch(engine.globalPath, () => engine.invalidate());
		w.on("error", () => undefined);
	} catch {
		// global file may not exist yet; the engine's TTL re-stat covers it
	}

	return {
		"tool.execute.before": async ({ tool }, { args }) => {
			const decision = evaluateToolCall(tool, args, directory, engine);
			if (decision.block) {
				// Throwing fails the tool call before execution — the model
				// sees this message as the tool result error.
				throw new Error(decision.reason ?? "Blocked by .agentignore");
			}
		},

		"tool.execute.after": async ({ tool, args }, output) => {
			const redacted = redactString(args, output.output, directory, engine);
			if (redacted !== undefined) output.output = redacted;
		},
	};
};

export default server;
