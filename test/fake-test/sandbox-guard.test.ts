// The live scripts' sandbox guard, tested without a model: a fake pi captures
// the tool_call handler and the test feeds it events.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import sandboxGuard from "../../scripts/sandbox-guard.ts";

type Handler = (event: Record<string, unknown>, ctx: { cwd: string }) => unknown;

const handlers: Handler[] = [];
sandboxGuard({ on: (name: string, handler: Handler) => name === "tool_call" && handlers.push(handler) } as never);

const root = mkdtempSync(path.join(tmpdir(), "guard-root-"));
const outside = mkdtempSync(path.join(tmpdir(), "guard-outside-"));
writeFileSync(path.join(root, "notes.txt"), "hi");
mkdirSync(path.join(root, "sub"));
symlinkSync(outside, path.join(root, "link-out"));
after(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

function call(toolName: string, input: Record<string, unknown>, cwd = root) {
	assert.equal(handlers.length, 1, "one tool_call handler");
	return handlers[0]!({ type: "tool_call", toolCallId: "t", toolName, input }, { cwd });
}
const blocked = (result: unknown) => (result as { block?: boolean } | undefined)?.block === true;

describe("sandbox guard", () => {
	for (const [tool, p] of [
		["read", "notes.txt"],
		["read", "./sub/../notes.txt"],
		["read", "@notes.txt"],
		["write", "sub/new/dir/file.md"],
		["edit", "notes.txt"],
		["write", path.join(root, "abs.txt")],
		["write", path.join(realpathSync(root), "abs-real.txt")],
		["ls", "sub"],
	] as const) {
		test(`allows ${tool} ${JSON.stringify(p)} inside the run folder`, () => {
			assert.equal(call(tool, { path: p }), undefined);
		});
	}

	for (const [tool, p] of [
		["read", "/etc/passwd"],
		["read", "../outside.txt"],
		["read", "sub/../../escape.txt"],
		["write", "~/pwned.txt"],
		["read", "@../x"],
		["edit", "link-out/file.txt"],
		["write", "link-out"],
		["write", path.join(outside, "x.txt")],
		["ls", "/"],
	] as const) {
		test(`blocks ${tool} ${JSON.stringify(p)} outside the run folder`, () => {
			const result = call(tool, { path: p });
			assert.ok(blocked(result));
			assert.match((result as { reason: string }).reason, /^sandbox-guard: /);
		});
	}

	test("blocks shell tools outright", () => {
		assert.ok(blocked(call("bash", { command: "ls" })));
		assert.ok(blocked(call("powershell", { command: "dir" })));
	});

	test("blocks a file tool without a string path; allows grep/find without a path", () => {
		assert.ok(blocked(call("read", {})));
		assert.ok(blocked(call("write", { path: 42, content: "x" })));
		assert.equal(call("grep", { pattern: "x" }), undefined);
	});

	test("leaves other tools alone", () => {
		assert.equal(call("ask_user", { question: "q" }), undefined);
	});

	test("follows the run folder given as cwd", () => {
		assert.ok(blocked(call("read", { path: path.join(root, "notes.txt") }, outside)));
		assert.equal(call("read", { path: "x.txt" }, outside), undefined);
	});
});
