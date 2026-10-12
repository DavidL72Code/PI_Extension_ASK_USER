// The sandbox guard against Pi's REAL read/write tools (no model, no Pi process):
// the guard decides, then Pi's tool runs the same call so the test shows where
// the file operation would land. Ported from the reviewer's round-3 probes (G1, G2).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import sandboxGuard from "../../scripts/sandbox-guard.ts";

const box = realpathSync(mkdtempSync(path.join(tmpdir(), "guard-review-")));
const root = path.join(box, "run");
const outside = path.join(box, "outside");
mkdirSync(root);
mkdirSync(outside);
writeFileSync(path.join(outside, "secret.txt"), "SECRET");
writeFileSync(path.join(root, "inside.txt"), "INSIDE");
symlinkSync(path.join(outside, "created-by-write.txt"), path.join(root, "dangling")); // target doesn't exist yet
symlinkSync(path.join(root, "not-yet.txt"), path.join(root, "dangling-inside")); // dangling, but points inside
symlinkSync(path.join(root, "dangling"), path.join(root, "chain")); // link → dangling link → outside
after(() => rmSync(box, { recursive: true, force: true }));

let handler: (event: unknown, ctx: unknown) => { block?: boolean; reason?: string } | undefined;
sandboxGuard({ on: (name: string, h: typeof handler) => name === "tool_call" && (handler = h) } as never);
const guard = (toolName: string, input: Record<string, unknown>) => handler({ type: "tool_call", toolCallId: "t", toolName, input }, { cwd: root });
const ctx = { cwd: root } as never;

describe("sandbox guard vs Pi's real file tools", () => {
	test("G1: a file:// URL outside the folder is blocked — and Pi's read tool really would read it", async () => {
		const url = pathToFileURL(path.join(outside, "secret.txt")).href;
		assert.ok(guard("read", { path: url })?.block, `guard must block ${url}`);
		const out = await createReadToolDefinition(root).execute("t", { path: url } as never, undefined, undefined, ctx);
		assert.ok(JSON.stringify(out.content).includes("SECRET"), "Pi resolves file:// URLs, so the guard must too");
	});

	test("G1b: @file:// is blocked too", () => {
		assert.ok(guard("read", { path: `@${pathToFileURL(path.join(outside, "secret.txt")).href}` })?.block);
	});

	test("file:// inside the folder is allowed; a file URL that isn't a local path is blocked", () => {
		assert.equal(guard("read", { path: pathToFileURL(path.join(root, "inside.txt")).href }), undefined);
		assert.ok(guard("read", { path: "file://some-host/share/x.txt" })?.block);
	});

	test("G2: writing through a dangling symlink that points outside is blocked — and Pi's write tool really would escape", async () => {
		assert.ok(guard("write", { path: "dangling" })?.block, "guard must block a write through a dangling symlink to outside");
		assert.ok(guard("write", { path: "chain" })?.block, "a chain of links ending outside is blocked too");
		await createWriteToolDefinition(root).execute("t", { path: "dangling", content: "ESCAPED" } as never, undefined, undefined, ctx);
		assert.ok(existsSync(path.join(outside, "created-by-write.txt")), "Pi's write followed the link out of the folder");
	});

	test("a dangling symlink that points inside the folder is allowed", () => {
		assert.equal(guard("write", { path: "dangling-inside" }), undefined);
	});

	test("a case variant of the run folder is only ever a false block (safe direction)", () => {
		const verdict = guard("read", { path: path.join(root.replace(/run$/, "RUN"), "inside.txt") });
		assert.ok(verdict === undefined || verdict.block === true);
	});
});
