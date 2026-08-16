/**
 * Node-only tests for the .agentignore engine, bash scanner and redaction.
 * Run: node src/test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanCommand } from "./bash.ts";
import { IgnoreEngine } from "./ignore.ts";
import { redactResult } from "./redact.ts";
import { evaluateToolCall } from "./tools.ts";

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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentignore-test-"));
	for (const [rel, content] of Object.entries(files)) {
		const p = path.join(root, rel);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, content);
	}
	return root;
}

/** project dir with a sibling global file (global must be an ancestor or
 *  sibling scope for the walk to behave like ~/.agentignore). */
function engineWith(
	globalContent: string | undefined,
	...agents: Array<[string, string]>
): { engine: IgnoreEngine; root: string } {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentignore-global-"));
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

console.log("== engine: basic patterns ==");
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
		"ignores dir itself",
		engine.isIgnored(path.join(root, "docs/scratch"), true),
	);
	check(
		"keeps src/main.ts",
		!engine.isIgnored(path.join(root, "src/main.ts"), false),
	);
	check(
		"keeps notes/other.md",
		!engine.isIgnored(path.join(root, "notes/other.md"), false),
	);
}

console.log("== engine: negation ==");
{
	const { engine, root } = engineWith(undefined, [
		".",
		"docs/scratch/\n!docs/scratch/keep.md",
	]);
	// git rule: cannot re-include below an excluded directory
	check(
		"dir/ excludes contents even with !file (git rule)",
		engine.isIgnored(path.join(root, "docs/scratch/keep.md"), false),
	);
}
{
	const { engine, root } = engineWith(undefined, [
		".",
		"docs/scratch/*\n!docs/scratch/keep.md",
	]);
	check(
		"dir/* + !file re-includes",
		!engine.isIgnored(path.join(root, "docs/scratch/keep.md"), false),
	);
	check(
		"dir/* + !file still ignores others",
		engine.isIgnored(path.join(root, "docs/scratch/drop.md"), false),
	);
}
{
	const { engine, root } = engineWith(undefined, [
		".",
		"docs/scratch/*\n!docs/scratch/keep/",
	]);
	check(
		"re-includes directory and contents",
		!engine.isIgnored(path.join(root, "docs/scratch/keep/x.md"), false),
	);
}

console.log("== engine: anchored vs unanchored ==");
{
	const { engine, root } = engineWith(undefined, [".", "/top.txt\nmid.txt"]);
	check(
		"anchored /top.txt matches root only",
		engine.isIgnored(path.join(root, "top.txt"), false),
	);
	check(
		"anchored /top.txt not in subdir",
		!engine.isIgnored(path.join(root, "sub/top.txt"), false),
	);
	check(
		"unanchored mid.txt matches anywhere",
		engine.isIgnored(path.join(root, "sub/deep/mid.txt"), false),
	);
}

console.log("== engine: nested files, deeper wins ==");
{
	const { engine, root } = engineWith(
		undefined,
		[".", "*.log\n"],
		["logs", "!important.log\n"],
	);
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

console.log("== engine: globs ==");
{
	const { engine, root } = engineWith(undefined, [
		".",
		"**/node_modules/\nbuild/*.tmp\n*.min.js",
	]);
	check(
		"**/node_modules deep",
		engine.isIgnored(path.join(root, "a/b/node_modules"), true),
	);
	check("build/*.tmp", engine.isIgnored(path.join(root, "build/x.tmp"), false));
	check(
		"build/*.tmp not .tmp elsewhere",
		!engine.isIgnored(path.join(root, "src/x.tmp"), false),
	);
	check(
		"*.min.js",
		engine.isIgnored(path.join(root, "dist/app.min.js"), false),
	);
	check(
		"keeps app.js",
		!engine.isIgnored(path.join(root, "dist/app.js"), false),
	);
}

console.log("== engine: global file, privacy-first precedence ==");
{
	const { engine, root } = engineWith(".ssh/\n", [".", "!**/.ssh/\n"]);
	check(
		"global wins over project re-include",
		engine.isIgnored(path.join(root, ".ssh/id_rsa"), false),
	);
}
{
	const { engine, root } = engineWith("", [".", ".env\n"]);
	check(
		"empty global changes nothing",
		engine.isIgnored(path.join(root, ".env"), false),
	);
}
{
	// the global ~/.agentignore applies to paths OUTSIDE its own tree too
	const tmp = fs.mkdtempSync(
		path.join(os.tmpdir(), "agentignore-global-scope-"),
	);
	const home = path.join(tmp, "home");
	const elsewhere = path.join(tmp, "elsewhere");
	fs.mkdirSync(home);
	fs.mkdirSync(elsewhere);
	fs.writeFileSync(path.join(home, ".agentignore"), ".env\n");
	const engine = new IgnoreEngine(path.join(home, ".agentignore"));
	check(
		"global applies inside its tree",
		engine.isIgnored(path.join(home, "proj/.env"), false),
	);
	check(
		"global applies outside its tree",
		engine.isIgnored(path.join(elsewhere, ".env"), false),
	);
}

console.log("== engine: comments, blank lines, escapes ==");
{
	const { engine, root } = engineWith(undefined, [
		".",
		"# comment\n\n\\#not-comment\n",
	]);
	check(
		"comment line is not a pattern",
		!engine.isIgnored(path.join(root, "#comment"), false),
	);
	check(
		"escaped hash is a pattern",
		engine.isIgnored(path.join(root, "#not-comment"), false),
	);
}

console.log("== engine: reload on change ==");
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentignore-reload-"));
	const globalPath = path.join(tmp, ".agentignore");
	const engine = new IgnoreEngine(globalPath, 30);
	fs.writeFileSync(path.join(tmp, ".agentignore"), "");
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const run = async () => {
		check(
			"initially not ignored",
			!engine.isIgnored(path.join(tmp, ".env"), false),
		);
		fs.writeFileSync(path.join(tmp, ".agentignore"), ".env\n");
		await sleep(60);
		check(
			"picks up change without restart",
			engine.isIgnored(path.join(tmp, ".env"), false),
		);
	};
	await run();
}

console.log("== bash scanner ==");
{
	const root = makeTree({
		".env": "SECRET=1",
		"docs/scratch/a.md": "x",
		"notes/private/n.md": "y",
		"src/main.ts": "z",
		"sub/dir/target.ts": "t",
	});
	const cwd = root;
	const scan = (cmd: string) => scanCommand(cmd, cwd).paths;
	check(
		"cat .env",
		scan("cat .env").some((p) => p.endsWith(".env")),
	);
	check(
		"head -n 5 .env",
		scan("head -n 5 .env").some((p) => p.endsWith(".env")),
	);
	check(
		"quoted cat",
		scan('cat ".env"').some((p) => p.endsWith(".env")),
	);
	check(
		"redirect write",
		scan("echo x > .env").some((p) => p.endsWith(".env")),
	);
	check(
		"command sub",
		scan("cat $(pwd)/.env").some((p) => p.endsWith(".env")),
	);
	check(
		"bash $(<file)",
		scan("x=$(<.env)").some((p) => p.endsWith(".env")),
	);
	check(
		"git show HEAD:.env",
		scan("git show HEAD:.env").some((p) => p.endsWith(".env")),
	);
	check(
		"git cat-file",
		scan("git cat-file -p HEAD:docs/scratch/a.md").some((p) =>
			p.endsWith("docs/scratch/a.md"),
		),
	);
	check(
		"python open()",
		scan("python -c \"print(open('.env').read())\"").some((p) =>
			p.endsWith(".env"),
		),
	);
	check(
		"glob prefix",
		scan("cat docs/scratch/*.md").some((p) => p.endsWith("docs/scratch/a.md")),
	);
	check(
		"absolute path",
		scan(`cat ${path.join(root, ".env")}`).some((p) => p.endsWith(".env")),
	);
	check(
		"curl file://",
		scan("curl file:///etc/passwd").some((p) => p.includes("etc/passwd")),
	);
	check(
		"clean command no paths",
		!scan("git status").some((p) => p.endsWith("status")),
	);
	check("ls no args", !scan("ls").some((p) => p.endsWith("ls")));
}

console.log("== bash scanner: evasion tricks ==");
{
	const root = makeTree({
		".env": "SECRET=1",
		"docs/scratch/a.md": "x",
		"docs/.agentignore": "# nested rules\n",
		"a.log": "log",
		"a.txt": "t",
		"sub/.env": "S2",
		"sub/x.txt": "t",
	});
	fs.writeFileSync(path.join(root, ".agentignore"), ".env\na.log\n");
	const engine = new IgnoreEngine();
	const cwd = root;
	const ev = (cmd: string) =>
		evaluateToolCall("bash", { command: cmd }, cwd, engine).block;
	const scan = (cmd: string) => scanCommand(cmd, cwd);

	// blocked: quote/obfuscation tricks
	check('quote-split .e"nv"', ev('cat .e"nv"'));
	check("ansi-quote .e$'nv'", ev("cat .e$'nv'"));
	check("nested quote .e'n'v", ev("cat .e'n'v"));
	check("eval string", ev('eval "cat .env"'));
	check("sh -c string", ev("sh -c 'cat .env'"));
	check("ssh remote command", ev("ssh host 'cat .env'"));
	check("var assignment", ev("f=.env; cat $f"));
	check("var braces", ev("f=.env; cat $" + "{f}"));
	check("cd + relative", ev("cd sub && cat .env"));
	check("bare glob", ev("cat *"));
	check("glob *.log", ev("cat *.log"));
	check("char class .[e]nv", ev("cat .[e]nv"));
	check("double-star **/*.env", ev("cat **/*.env"));
	check("case trick .ENV", ev("cat .ENV"));
	check("command sub $(pwd)/.env", ev("cat $(pwd)/.env"));

	// .agentignore write protection
	check("echo > .agentignore blocked", ev("echo x > .agentignore"));
	check(
		"echo > sub/.agentignore blocked (new file)",
		ev("mkdir -p sub && echo x > sub/.agentignore"),
	);
	check(
		"tee sub/.agentignore blocked (new file)",
		ev("tee sub/.agentignore < /dev/null"),
	);
	check("rm .agentignore blocked", ev("rm .agentignore"));
	check("mv .agentignore /tmp/x blocked", ev("mv .agentignore /tmp/x"));
	check("chmod .agentignore blocked", ev("chmod 777 .agentignore"));
	check("git checkout .agentignore blocked", ev("git checkout .agentignore"));
	check(
		"python write .agentignore blocked",
		ev("python -c \"open('.agentignore','w').write('')\""),
	);
	check("cat .agentignore allowed", !ev("cat .agentignore"));
	check("grep .agentignore allowed", !ev("grep foo .agentignore"));
	check("git show .agentignore allowed", !ev("git show HEAD:.agentignore"));

	// indirect deletion protection
	check("glob delete blocked (matches .agentignore)", ev("rm -rf *"));
	check("redirect to glob blocked", ev("echo x > *"));
	check("recursive delete of cwd blocked", ev("rm -rf ."));
	check("recursive delete of dir with rules blocked", ev("rm -rf docs"));
	check("find -delete blocked", ev("find . -delete"));
	check("find -exec blocked", ev("find . -exec cat {} \\;"));
	check("git clean blocked", ev("git clean -fd"));
	check("read-only dir command allowed", !ev("ls docs"));

	// glob expansion finds the right things
	const s = scan("cat *.txt");
	check(
		"glob *.txt resolves entries",
		s.paths.some((p) => p.endsWith("a.txt")),
	);
}

console.log("== evaluateToolCall: shape-based, universal ==");
{
	const root = makeTree({
		".env": "SECRET=1",
		"notes/private/n.md": "y",
		"src/main.ts": "z",
	});
	fs.writeFileSync(path.join(root, ".agentignore"), ".env\nnotes/private/\n");
	const engine = new IgnoreEngine();
	const cwd = root;

	// built-in-style tools
	check(
		"read .env blocked",
		evaluateToolCall("read", { path: ".env" }, cwd, engine).block,
	);
	check(
		"write .env blocked",
		evaluateToolCall("write", { path: ".env", content: "x" }, cwd, engine)
			.block,
	);
	check(
		"write into ignored dir (new file) blocked",
		evaluateToolCall(
			"write",
			{ path: "notes/private/new.md", content: "x" },
			cwd,
			engine,
		).block,
	);
	check(
		"edit notes/private/n.md blocked",
		evaluateToolCall(
			"edit",
			{ path: "notes/private/n.md", edits: [] },
			cwd,
			engine,
		).block,
	);
	check(
		"ls .env blocked",
		evaluateToolCall("ls", { path: ".env" }, cwd, engine).block,
	);
	check("ls cwd allowed", !evaluateToolCall("ls", {}, cwd, engine).block);
	check(
		"grep dir allowed (redaction handles contents)",
		!evaluateToolCall("grep", { pattern: "x", path: "." }, cwd, engine).block,
	);
	check(
		"bash cat .env blocked",
		evaluateToolCall("bash", { command: "cat .env" }, cwd, engine).block,
	);
	check(
		"bash clean allowed",
		!evaluateToolCall("bash", { command: "ls" }, cwd, engine).block,
	);
	check(
		"bash base64 obfuscation NOT caught (documented gap)",
		!evaluateToolCall(
			"bash",
			{ command: 'base64 -d <<< "U0VDUkVUPTE="' },
			cwd,
			engine,
		).block,
	);
	check(
		"read src allowed",
		!evaluateToolCall("read", { path: "src/main.ts" }, cwd, engine).block,
	);
	check(
		"fetch file:// blocked",
		evaluateToolCall(
			"fetch_content",
			{ url: "file:///etc/passwd" },
			cwd,
			engine,
		).block,
	);
	check(
		"web_search query not a path",
		!evaluateToolCall("web_search", { query: ".env" }, cwd, engine).block,
	);

	// unknown tools with path args — must work without naming the tool
	check(
		"unknown tool with path blocked",
		evaluateToolCall("ffgrep", { pattern: "x", path: ".env" }, cwd, engine)
			.block,
	);
	check(
		"unknown tool with dir path allowed",
		!evaluateToolCall("ffgrep", { pattern: "x", path: "src" }, cwd, engine)
			.block,
	);
	check(
		"unknown tool with command blocked",
		evaluateToolCall("hypa_shell", { command: "cat .env" }, cwd, engine).block,
	);
	check(
		"mcp nested path blocked",
		evaluateToolCall(
			"mcp",
			{ server: "fs", tool: "read_file", args: { path: "notes/private/n.md" } },
			cwd,
			engine,
		).block,
	);
	check(
		"subagent task text not scanned",
		!evaluateToolCall(
			"subagent",
			{ agent: "worker", task: "please look at .env" },
			cwd,
			engine,
		).block,
	);
	check(
		"intercom cwd to ignored dir blocked (conservative)",
		evaluateToolCall(
			"intercom",
			{ action: "send", message: "hi", cwd: "notes/private" },
			cwd,
			engine,
		).block,
	);
	check(
		"intercom to normal dir allowed",
		!evaluateToolCall(
			"intercom",
			{ action: "send", message: "hi", cwd: "src" },
			cwd,
			engine,
		).block,
	);
}

console.log("== evaluateToolCall: .agentignore read-only rule ==");
{
	const root = makeTree({ ".env": "SECRET=1" });
	fs.writeFileSync(path.join(root, ".agentignore"), ".env\n");
	const engine = new IgnoreEngine();
	const cwd = root;
	check(
		"write .agentignore blocked",
		evaluateToolCall(
			"write",
			{ path: ".agentignore", content: "" },
			cwd,
			engine,
		).block,
	);
	check(
		"write sub/.agentignore blocked",
		evaluateToolCall(
			"write",
			{ path: "sub/.agentignore", content: "!.env" },
			cwd,
			engine,
		).block,
	);
	check(
		"edit .agentignore blocked",
		evaluateToolCall("edit", { path: ".agentignore", edits: [] }, cwd, engine)
			.block,
	);
	check(
		"read .agentignore allowed",
		!evaluateToolCall("read", { path: ".agentignore" }, cwd, engine).block,
	);
	check(
		"mcp write_file .agentignore blocked",
		evaluateToolCall(
			"mcp",
			{
				server: "fs",
				tool: "write_file",
				args: { path: ".agentignore", content: "x" },
			},
			cwd,
			engine,
		).block,
	);
	check(
		"mcp delete_file .agentignore blocked",
		evaluateToolCall(
			"mcp",
			{ server: "fs", tool: "delete_file", args: { path: ".agentignore" } },
			cwd,
			engine,
		).block,
	);
	check(
		"mcp read_file .agentignore allowed",
		!evaluateToolCall(
			"mcp",
			{ server: "fs", tool: "read_file", args: { path: ".agentignore" } },
			cwd,
			engine,
		).block,
	);
	check(
		"mcp rename .agentignore blocked",
		evaluateToolCall(
			"mcp",
			{
				server: "fs",
				tool: "rename",
				args: { oldPath: ".agentignore", newPath: "/tmp/x" },
			},
			cwd,
			engine,
		).block,
	);
	check(
		"mcpScript code with .env blocked",
		evaluateToolCall(
			"mcpScript",
			{ code: "tools.call('read_file', { path: '.env' })" },
			cwd,
			engine,
		).block,
	);
	check(
		"mcpScript code with .agentignore blocked",
		evaluateToolCall(
			"mcpScript",
			{
				code: "tools.call('write_file', { path: '.agentignore', content: '' })",
			},
			cwd,
			engine,
		).block,
	);
}

console.log("== redaction ==");
{
	const root = makeTree({
		".env": "SECRET=1",
		"notes/private/n.md": "y",
		"src/main.ts": "ok",
		"docs/scratch/d.md": "d",
	});
	fs.writeFileSync(
		path.join(root, ".agentignore"),
		".env\nnotes/private/\ndocs/scratch/\n",
	);
	const engine = new IgnoreEngine();
	const cwd = root;
	const text = (t: string) => [{ type: "text" as const, text: t }];

	const lsOut = text(`total 4\n.agentignore\n.env\nnotes\nsrc\n`);
	const r1 = redactResult({ path: "." }, lsOut, cwd, engine);
	check(
		"ls redacts .env line",
		r1 !== undefined &&
			!(r1.content[0] as { text: string }).text.includes(".env"),
	);
	check(
		"ls keeps src line",
		r1 !== undefined &&
			(r1.content[0] as { text: string }).text.includes("src"),
	);

	const grepOut = text(
		`${path.join(root, "src/main.ts")}:1:ok\n${path.join(root, ".env")}:1:SECRET=1\n`,
	);
	const r2 = redactResult({ pattern: "x", path: "." }, grepOut, cwd, engine);
	check(
		"grep redacts ignored match",
		r2 !== undefined &&
			!(r2.content[0] as { text: string }).text.includes("SECRET"),
	);
	check(
		"grep keeps normal match",
		r2 !== undefined && (r2.content[0] as { text: string }).text.includes("ok"),
	);

	const findOut = text(
		`${path.join(root, "notes/private/n.md")}\n${path.join(root, "src/main.ts")}\n`,
	);
	const r3 = redactResult({ path: "." }, findOut, cwd, engine);
	check(
		"find redacts ignored path",
		r3 !== undefined &&
			!(r3.content[0] as { text: string }).text.includes("private"),
	);
	check(
		"find keeps normal path",
		r3 !== undefined &&
			(r3.content[0] as { text: string }).text.includes("main.ts"),
	);

	// universal: unknown tool, dir path arg
	const r4 = redactResult({ pattern: "x", path: "." }, grepOut, cwd, engine);
	check(
		"unknown search tool redacted (shape-based)",
		r4 !== undefined &&
			!(r4.content[0] as { text: string }).text.includes("SECRET"),
	);

	// no-arg listing (ls with defaults to cwd)
	const r5 = redactResult({}, lsOut, cwd, engine);
	check(
		"empty-arg call redacted as cwd listing",
		r5 !== undefined &&
			!(r5.content[0] as { text: string }).text.includes(".env"),
	);

	// bash output redaction (path: prefix lines)
	const bashOut = text(
		`${path.join(root, "docs/scratch/d.md")}:1:d\n${path.join(root, "src/main.ts")}:1:ok\n`,
	);
	const r6 = redactResult({ command: "grep -r x ." }, bashOut, cwd, engine);
	check(
		"shell output redacted",
		r6 !== undefined &&
			!(r6.content[0] as { text: string }).text.includes("d.md"),
	);

	// read of a non-ignored file must NOT be redacted (content is prose)
	const prose = text(`docs say: put secrets in .env\nline two\n`);
	const r7 = redactResult({ path: "src/main.ts" }, prose, cwd, engine);
	check("read of allowed file never redacted", r7 === undefined);

	const clean = redactResult(
		{ path: "." },
		text("src\nmain.ts\n"),
		cwd,
		engine,
	);
	check("no change when nothing ignored", clean === undefined);
}

console.log("== redaction: evasion tricks ==");
{
	const root = makeTree({
		".env": "SECRET=1",
		"notes/private/n.md": "y",
		"src/main.ts": "ok",
	});
	fs.writeFileSync(path.join(root, ".agentignore"), ".env\nnotes/private/\n");
	const engine = new IgnoreEngine();
	const cwd = root;
	const text = (t: string) => [{ type: "text" as const, text: t }];

	// case-insensitive listing: `.ENV` line must go (case-insensitive engine)
	const upper = redactResult({ path: "." }, text(`.ENV\nsrc\n`), cwd, engine);
	check(
		"uppercase .ENV line redacted",
		upper !== undefined &&
			!(upper.content[0] as { text: string }).text.includes(".ENV"),
	);

	// git diff hunks: header + content lines all dropped
	const diff = redactResult(
		{ command: "git diff" },
		text(
			`diff --git a/${root}/.env b/${root}/.env\nindex 123..456 100644\n--- a/${root}/.env\n+++ b/${root}/.env\n@@ -1 +1 @@\n-SECRET=1\n+SECRET=2\ndiff --git a/${root}/src/main.ts b/${root}/src/main.ts\n@@ -1 +1 @@\n-ok\n+ok2\n`,
		),
		cwd,
		engine,
	);
	check(
		"git diff hunk for ignored file dropped",
		diff !== undefined &&
			!(diff.content[0] as { text: string }).text.includes("SECRET"),
	);
	check(
		"git diff keeps allowed file hunk",
		diff !== undefined &&
			(diff.content[0] as { text: string }).text.includes("ok2"),
	);

	// a/ b/ prefixed listing lines
	const ab = redactResult(
		{ command: "git ls-files" },
		text(`a/.env\nb/.env\nsrc/main.ts\n`),
		cwd,
		engine,
	);
	check(
		"a/ b/ prefixed lines redacted",
		ab !== undefined &&
			!(ab.content[0] as { text: string }).text.includes(".env"),
	);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
