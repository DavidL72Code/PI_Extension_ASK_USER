// Repeats against Pi's REAL in-memory SessionManager (no model, no Pi process).
// Across turns an identical call asks again; only identical sibling calls in one
// assistant message share a dialog. Includes the reviewer's R-B probe as a regression.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SessionManager, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { questionKey } from "../../src/ask-user.ts";
import { createAskUserTool } from "../../src/index.ts";
import { isScopeFollowUp } from "./helpers.ts";

type Call = { method: string; title: string; choices?: string[] };
type Tool = ReturnType<typeof createAskUserTool>;

/** Fake dialogs; the rule 16 follow-up is answered "Just this time" and kept out of `calls`. */
function ctxFor(sessionManager: unknown, select: (c: Call) => unknown = () => undefined, hasUI = true) {
	const calls: Call[] = [];
	const ui = {
		select: async (title: string, choices: string[]) => {
			if (isScopeFollowUp(title, choices)) return choices[0];
			const c = { method: "select", title, choices: [...choices] };
			calls.push(c);
			return select(c);
		},
		input: async (title: string) => {
			calls.push({ method: "input", title });
			return undefined;
		},
	};
	return { ctx: { hasUI, mode: "tui", ui, sessionManager } as never, calls };
}
const pick = (i: number) => (c: Call) => c.choices![i];
const ts = () => Date.now();

const Q = "Which database should the cache use?";
const params = (over: Record<string, unknown> = {}) => ({
	question: Q,
	reason: "Changes deployment needs; costly to migrate later.",
	options: [
		{ label: "SQLite", tradeoff: "Zero setup" },
		{ label: "Postgres", tradeoff: "Needs a server" },
	],
	...over,
});

const user = (sm: SessionManager) => sm.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: ts() } as never);
const assistant = (sm: SessionManager, calls: [string, unknown][]) =>
	sm.appendMessage({
		role: "assistant",
		content: calls.map(([id, args]) => ({ type: "toolCall", id, name: "ask_user", arguments: args })),
		api: "x",
		provider: "x",
		model: "x",
		usage: {},
		stopReason: "toolUse",
		timestamp: ts(),
	} as never);
const save = (sm: SessionManager, id: string, r: AgentToolResult<any>) =>
	sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: "ask_user", content: r.content, details: r.details, isError: false, timestamp: ts() } as never);
const done = (sm: SessionManager) =>
	sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: ts() } as never);

/** One turn as Pi runs it: user → assistant(toolCalls) → each call executes and is saved → assistant. */
async function turn(sm: SessionManager, tool: Tool, calls: [string, unknown, (c: Call) => unknown][], hasUI = true) {
	user(sm);
	const assistantId = assistant(sm, calls.map(([id, p]) => [id, p]));
	const out: { result: AgentToolResult<any>; calls: Call[] }[] = [];
	for (const [id, p, select] of calls) {
		const { ctx, calls: dialogs } = ctxFor(sm, select, hasUI);
		const result: AgentToolResult<any> = await tool.execute(id, p as never, undefined, undefined, ctx);
		save(sm, id, result); // Pi saves each result before the next sibling runs
		out.push({ result, calls: dialogs });
	}
	done(sm);
	return { assistantId, out };
}

describe("across turns (real SessionManager)", () => {
	test("an identical call in a later turn opens the dialog again", async () => {
		const sm = SessionManager.inMemory("/tmp");
		const tool = createAskUserTool();
		const first = await turn(sm, tool, [["t1", params(), pick(0)]]);
		assert.equal(first.out[0]!.result.details.answer, "SQLite");
		const later = await turn(sm, tool, [["t2", params(), pick(1)]]);
		assert.equal(later.out[0]!.calls.length, 1, "the model decides; the tool asks");
		assert.equal(later.out[0]!.result.details.answer, "Postgres");
		assert.ok(!("repeated" in later.out[0]!.result.details));
	});

	test('R-B regression: "Should I go ahead?" for a different decision in a later turn asks', async () => {
		const sm = SessionManager.inMemory("/tmp");
		const tool = createAskUserTool();
		const q = "Should I go ahead?";
		await turn(sm, tool, [["t1", { question: q, reason: "Deletes logs older than 30 days.", options: [{ label: "Yes", tradeoff: "Frees disk" }, { label: "No", tradeoff: "Keeps logs" }] }, pick(0)]]);
		const second = await turn(sm, tool, [["t2", { question: q, reason: "Overwrites your existing config.json with defaults.", options: [{ label: "Yes", tradeoff: "Clean config" }, { label: "No", tradeoff: "Keep your edits" }] }, pick(1)]]);
		assert.equal(second.out[0]!.calls.length, 1);
		assert.equal(second.out[0]!.result.details.answer, "No");
	});

	test("after continuing from the assistant message that asked, a new response's identical call asks", async () => {
		const sm = SessionManager.inMemory("/tmp");
		const tool = createAskUserTool();
		const first = await turn(sm, tool, [["t1", params(), pick(0)]]);
		sm.branch(first.assistantId);
		const again = await turn(sm, tool, [["t2", params(), pick(1)]]);
		assert.equal(again.out[0]!.calls.length, 1);
	});
});

describe("siblings in one assistant message (real SessionManager)", () => {
	test("identical siblings: the second gets the first's answer without a dialog (result already saved, as in Pi)", async () => {
		const sm = SessionManager.inMemory("/tmp");
		const { out } = await turn(sm, createAskUserTool(), [
			["s1", params(), pick(0)],
			["s2", params(), pick(1)],
		]);
		assert.equal(out[1]!.calls.length, 0);
		assert.equal(out[1]!.result.details.answer, "SQLite");
		assert.equal(out[1]!.result.details.repeated, true);
	});

	test("identical siblings also match when the first result isn't saved yet", async () => {
		const sm = SessionManager.inMemory("/tmp");
		const tool = createAskUserTool();
		user(sm);
		assistant(sm, [["s1", params()], ["s2", params()]]);
		await tool.execute("s1", params() as never, undefined, undefined, ctxFor(sm, pick(0)).ctx);
		const second = ctxFor(sm, pick(1));
		const r2: AgentToolResult<any> = await tool.execute("s2", params() as never, undefined, undefined, second.ctx);
		assert.equal(second.calls.length, 0);
		assert.equal(r2.details.repeated, true);
	});

	test("same call with another recommendation, label order/case and tradeoffs is still identical", async () => {
		const sm = SessionManager.inMemory("/tmp");
		const variant = {
			question: "  which DATABASE should the cache use ",
			reason: "changes deployment needs;  costly to migrate later.",
			options: [{ label: " POSTGRES", tradeoff: "different words" }, { label: "sqlite ", tradeoff: "other" }],
			recommendation: "sqlite",
		};
		const { out } = await turn(sm, createAskUserTool(), [
			["s1", params({ recommendation: "Postgres" }), pick(0)],
			["s2", variant, pick(1)],
		]);
		assert.equal(out[1]!.calls.length, 0);
		assert.equal(out[1]!.result.details.answer, "SQLite");
	});

	test("different calls in one response both ask (different question, reason, or options)", async () => {
		const sm = SessionManager.inMemory("/tmp");
		const { out } = await turn(sm, createAskUserTool(), [
			["s1", params(), pick(0)],
			["s2", params({ question: "Which database should the queue use?" }), pick(0)],
			["s3", params({ reason: "Only affects local tests." }), pick(0)],
			["s4", params({ options: [{ label: "MySQL", tradeoff: "a" }, { label: "MongoDB", tradeoff: "b" }] }), pick(0)],
		]);
		assert.deepEqual(out.map((o) => o.calls.length), [1, 1, 1, 1]);
	});

	test("a fresh tool instance doesn't know an earlier sibling's result (memory is per instance), so it asks", async () => {
		const sm = SessionManager.inMemory("/tmp");
		user(sm);
		assistant(sm, [["s1", params()], ["s2", params()]]);
		await createAskUserTool().execute("s1", params() as never, undefined, undefined, ctxFor(sm, pick(0)).ctx);
		const second = ctxFor(sm, pick(1));
		await createAskUserTool().execute("s2", params() as never, undefined, undefined, second.ctx);
		assert.equal(second.calls.length, 1);
	});

	test("questionKey edge cases", () => {
		assert.equal(questionKey("Which DB?"), questionKey("  which db ? "));
		assert.notEqual(questionKey("Which DB??"), questionKey("Which DB"), "only one trailing ? is dropped");
		assert.notEqual(questionKey("Which DB？"), questionKey("Which DB"), "a full-width ？ is not dropped");
	});
});
