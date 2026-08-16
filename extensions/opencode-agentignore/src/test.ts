/**
 * Node-only tests for the opencode-agentignore engine, guard and redaction.
 * Run: node src/test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IgnoreEngine } from "./engine.ts";
import { evaluateToolCall, redactString } from "./guard.ts";
import { scanCommand } from "./bash.ts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
	if (cond) {
		passed++;
		console.log(`  ok  ${name}`);
	} else {
		failed++;
		console.log(`FAIL  ${name} ${detail}`);
	}
}

function makeTree(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-agentignore-"));
	for (const [rel, content] of Object.entries(files)) {
		const p = path.join(root, rel);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, content);
	}
	return root;
}

function engineWith(
	globalContent: string | undefined,
	...agents: Array<[string, string]>
): { engine: IgnoreEngine; root: string } {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-global-"));
	const root = path.join(tmp, "proj");
	fs.mkdirSync(root, { recursive: true });
	const globalPath = path.join(tmp, ".agentignore");
	if (globalContent !== undefined) fs.writeFileSync(globalPath, globalContent);
	const engine = new IgnoreEngine(globalPath);
	for (const [dir, content] of agents) {
		const p = path.join(root, dir, ".agentignore");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, content);
	}
	return { engine, root };
}

console.log("== engine: basics ==");
{
	const { engine, root } = engineWith(undefined, [
		".",
		".env\n.env.*\ndocs/scratch/\nnotes/private/",
	]);
	check("ignores .env", engine.isIgnored(path.join(root, ".env"), false));
	check(
		"ignores .env.prod",
		engine.isIgnored(path.join(root, ".env.prod"), false),
	);
	check(
		"ignores file in docs/scratch",
		engine.isIgnored(path.join(root, "docs/scratch/ideas.md"), false),
	);
	check(
		"keeps src/main.ts",
		!engine.isIgnored(path.join(root, "src/main.ts"), false),
	);
}

console.log("== engine: parent-dir rule (git) ==");
{
	const { engine, root } = engineWith(undefined, [
		".",
		"random/\n!random/HELLO.md",
	]);
	check(
		"dir/ + !file stays ignored (git rule)",
		engine.isIgnored(path.join(root, "random/HELLO.md"), false),
	);
}
{
	const { engine, root } = engineWith(undefined, [
		".",
		"random/*\n!random/HELLO.md",
	]);
	check(
		"dir/* + !file re-includes",
		!engine.isIgnored(path.join(root, "random/HELLO.md"), false),
	);
	check(
		"dir/* + !file keeps siblings ignored",
		engine.isIgnored(path.join(root, "random/BYE.md"), false),
	);
}

console.log("== engine: anchored + nested precedence ==");
{
	const { engine, root } = engineWith(undefined, [".", "/top.txt\nmid.txt"]);
	check(
		"anchored /top.txt matches root only",
		engine.isIgnored(path.join(root, "top.txt"), false),
	);
	check(
		"unanchored mid.txt matches deep",
		engine.isIgnored(path.join(root, "sub/deep/mid.txt"), false),
	);
}
{
	const { engine, root } = engineWith(undefined, [".", "*.log\n"], ["logs", "!important.log\n"]);
	check(
		"parent ignores a.log",
		engine.isIgnored(path.join(root, "a.log"), false),
	);
	check(
		"deeper ! re-includes important.log",
		!engine.isIgnored(path.join(root, "logs/important.log"), false),
	);
	check(
		"deeper ! only affects its dir",
		engine.isIgnored(path.join(root, "logs/other.log"), false),
	);
}

console.log("== engine: global file applies everywhere ==");
{
	const { engine, root } = engineWith(".ssh/\n", [".", "!**/.ssh/\n"]);
	check(
		"global wins over project re-include",
		engine.isIgnored(path.join(root, ".ssh/id_rsa"), false),
	);
}
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-global-scope-"));
	const home = path.join(tmp, "home");
	const elsewhere = path.join(tmp, "elsewhere");
	fs.mkdirSync(home);
	fs.mkdirSync(elsewhere);
	fs.writeFileSync(path.join(home, ".agentignore"), ".env\n");
	const engine = new IgnoreEngine(path.join(home, ".agentignore"));
	check(
		"global applies outside its tree",
		engine.isIgnored(path.join(elsewhere, ".env"), false),
	);
}

console.log("== guard: path tools ==");
{
	const root = makeTree({
		".env": "SECRET=1",
		"notes/private/n.md": "y",
		"src/main.ts": "z",
	});
	fs.writeFileSync(path.join(root, ".agentignore"), ".env\nnotes/private/\n");
	const engine = new IgnoreEngine();
	const cwd = root;

	check(
		"read .env blocked",
		evaluateToolCall("read", { filePath: path.join(cwd, ".env") }, cwd, engine)
			.block,
	);
	check(
		"read relative .env blocked",
		evaluateToolCall("read", { filePath: ".env" }, cwd, engine).block,
	);
	check(
		"write .env blocked",
		evaluateToolCall(
			"write",
			{ filePath: path.join(cwd, ".env"), content: "x" },
			cwd,
			engine,
		).block,
	);
	check(
		"write into ignored dir (new file) blocked",
		evaluateToolCall(
			"write",
			{ filePath: path.join(cwd, "notes/private/new.md"), content: "x" },
			cwd,
			engine,
		).block,
	);
	check(
		"edit notes/private/n.md blocked",
		evaluateToolCall(
			"edit",
			{ filePath: path.join(cwd, "notes/private/n.md"), edits: [] },
			cwd,
			engine,
		).block,
	);
	check(
		"grep with ignored path blocked",
		evaluateToolCall(
			"grep",
			{ pattern: "secret", path: path.join(cwd, "notes/private") },
			cwd,
			engine,
		).block,
	);
	check(
		"glob with ignored path blocked",
		evaluateToolCall(
			"glob",
			{ pattern: "**/*", path: path.join(cwd, "notes/private") },
			cwd,
			engine,
		).block,
	);
	check(
		"read src/main.ts allowed",
		!evaluateToolCall("read", { filePath: path.join(cwd, "src/main.ts") }, cwd, engine).block,
	);
}

console.log("== guard: read-only ignore files ==");
{
	const root = makeTree({});
	fs.writeFileSync(path.join(root, ".agentignore"), ".env\n");
	const engine = new IgnoreEngine();
	const cwd = root;
	check(
		"write .agentignore blocked",
		evaluateToolCall("write", { filePath: ".agentignore", content: "" }, cwd, engine).block,
	);
	check(
		"edit .agentignore blocked",
		evaluateToolCall("edit", { filePath: ".agentignore", edits: [] }, cwd, engine).block,
	);
	check(
		"apply_patch on .agentignore blocked",
		evaluateToolCall(
			"apply_patch",
			{ patchText: "*** Update File: .agentignore\n@@\n" },
			cwd,
			engine,
		).block,
	);
	check(
		"read .agentignore allowed",
		!evaluateToolCall("read", { filePath: ".agentignore" }, cwd, engine).block,
	);
	check(
		"apply_patch on src file allowed",
		!evaluateToolCall(
			"apply_patch",
			{ patchText: "*** Update File: src/main.ts\n@@\n" },
			cwd,
			engine,
		).block,
	);
}

console.log("== guard: shell scan ==");
{
	const root = makeTree({
		".env": "SECRET=1",
		"sub/.env": "S2",
		"a.log": "log",
	});
	fs.writeFileSync(path.join(root, ".agentignore"), ".env\na.log\n");
	const engine = new IgnoreEngine();
	const cwd = root;
	const ev = (cmd: string, workdir?: string) =>
		evaluateToolCall("bash", { command: cmd, workdir }, cwd, engine).block;

	check("cat .env blocked", ev("cat .env"));
	check("cat .e'n'v blocked", ev("cat .e'n'v"));
	check("cat *.log blocked (glob)", ev("cat *.log"));
	check("cat .ENV blocked (case)", ev("cat .ENV"));
	check("echo x > .agentignore blocked", ev("echo x > .agentignore"));
	check("rm .agentignore blocked", ev("rm .agentignore"));
	check("cat .agentignore allowed", !ev("cat .agentignore"));
	check("ls allowed", !ev("ls -la"));
	check("workdir-relative blocked", ev("cat .env", "sub"));
	check("unrelated command allowed", !ev("echo hello"));
}

console.log("== guard: mcp-shaped args ==");
{
	const root = makeTree({ ".env": "SECRET=1" });
	fs.writeFileSync(path.join(root, ".agentignore"), ".env\n");
	const engine = new IgnoreEngine();
	const cwd = root;
	check(
		"mcp read_file .env blocked",
		evaluateToolCall(
			"mcp__filesystem__read_file",
			{ server: "filesystem", tool: "read_file", args: { path: ".env" } },
			cwd,
			engine,
		).block,
	);
	check(
		"mcp write_file .agentignore blocked",
		evaluateToolCall(
			"mcp__filesystem__write_file",
			{
				server: "filesystem",
				tool: "write_file",
				args: { path: ".agentignore", content: "x" },
			},
			cwd,
			engine,
		).block,
	);
	check(
		"mcp read other allowed",
		!evaluateToolCall(
			"mcp__filesystem__read_file",
			{ server: "filesystem", tool: "read_file", args: { path: "README.md" } },
			cwd,
			engine,
		).block,
	);
}

console.log("== redaction ==");
{
	const root = makeTree({
		".env": "SECRET=1",
		"src/main.ts": "z",
		"docs/scratch/a.md": "x",
	});
	fs.writeFileSync(path.join(root, ".agentignore"), ".env\ndocs/scratch/\n");
	const engine = new IgnoreEngine();
	const cwd = root;

	// ls of the cwd: ignored entries disappear
	const ls = `total 3\n-rw-r--r--  1 u  g  9 Jan 1 10:00 .env\n-rw-r--r--  1 u  g  3 Jan 1 10:00 README.md\n-rw-r--r--  1 u  g  2 Jan 1 10:00 src\n`;
	const r1 = redactString({ path: cwd }, ls, cwd, engine);
	check("ls redacts .env line", r1 !== undefined && !r1!.includes(".env"));
	check("ls keeps README line", r1 !== undefined && r1!.includes("README.md"));

	// grep output
	const grep = `${path.join(cwd, ".env")}:1:SECRET=1\n${path.join(cwd, "src/main.ts")}:1:z\n`;
	const r2 = redactString({ pattern: "x", path: cwd }, grep, cwd, engine);
	check("grep redacts ignored match", r2 !== undefined && !r2!.includes(".env"));
	check("grep keeps allowed match", r2 !== undefined && r2!.includes("src/main.ts"));

	// shell output
	const r3 = redactString(
		{ command: "ls -la" },
		`total 1\n-rw-r--r-- 1 u g 9 Jan 1 10:00 ${path.join(cwd, ".env")}\n`,
		cwd,
		engine,
	);
	check("shell output redacted", r3 !== undefined && !r3!.includes(".env"));

	// read of an allowed file is never redacted
	const r4 = redactString(
		{ filePath: path.join(cwd, "src/main.ts") },
		"const z = 1",
		cwd,
		engine,
	);
	check("read of allowed file never redacted", r4 === undefined);

	// git diff hunk for an ignored path is dropped entirely
	const diff = `diff --git a/.env b/.env\nindex 123..456\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-SECRET=1\n+SECRET=2\ndiff --git a/src/main.ts b/src/main.ts\nindex 789..abc\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-z\n+zz\n`;
	const r5 = redactString({ command: "git diff" }, diff, cwd, engine);
	check(
		"git diff hunk for ignored file dropped",
		r5 !== undefined &&
			!r5!.includes("SECRET") &&
			r5!.includes("src/main.ts"),
	);
}

console.log("== bash scanner: evasion basics ==");
{
	const root = makeTree({ ".env": "SECRET=1", "a.log": "log" });
	const cwd = root;
	const scan = (cmd: string) => scanCommand(cmd, cwd).paths;
	check("cat .env", scan("cat .env").some((p) => p.endsWith(".env")));
	check("cat .e'n'v", scan("cat .e'n'v").some((p) => p.endsWith(".env")));
	check("var: f=.env; cat $f", scan("f=.env; cat $f").some((p) => p.endsWith(".env")));
	check("command sub $(pwd)/.env", scan("cat $(pwd)/.env").some((p) => p.endsWith(".env")));
	check("git show HEAD:.env", scan("git show HEAD:.env").some((p) => p.endsWith(".env")));
	check("glob *.log", scan("cat *.log").some((p) => p.endsWith("a.log")));
	check("clean ls", !scan("ls").some((p) => p.endsWith("ls")));
}

console.log();
if (failed > 0) {
	console.log(`${failed} FAILED`);
	process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
