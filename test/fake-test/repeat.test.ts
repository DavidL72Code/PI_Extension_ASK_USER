// Repeats: across turns the dialog always opens (the model decides from the
// conversation whether an earlier answer applies). Only identical sibling calls
// in the SAME assistant message share one dialog.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { createAskUserTool } from "../../src/index.ts";
import { QUESTION, base, contentText, pick, pickCustom, reply, session, type Session } from "./helpers.ts";

type Entry = { type: string; id: string; parentId: string | null; message: Record<string, unknown> };
type Tool = ReturnType<typeof createAskUserTool>;

/** A fake branch shaped like Pi's: an assistant message carries its tool calls; results follow. */
function branch() {
	const entries: Entry[] = [];
	let n = 0;
	const add = (message: Record<string, unknown>) => {
		const id = `e${++n}`;
		entries.push({ type: "message", id, parentId: entries.at(-1)?.id ?? null, message });
		return id;
	};
	add({ role: "user" });
	return {
		manager: { getBranch: () => [...entries] },
		/** One assistant message with these ask_user calls. */
		message(calls: [string, unknown][]) {
			add({ role: "assistant", content: calls.map(([id, args]) => ({ type: "toolCall", id, name: "ask_user", arguments: args })) });
		},
		result(toolCallId: string, details: unknown) {
			add({ role: "toolResult", toolName: "ask_user", toolCallId, isError: false, content: [], details });
		},
		userTurn() {
			add({ role: "user" });
		},
	};
}

function ctxWith(s: Session, manager: unknown) {
	(s.ctx as unknown as { sessionManager: unknown }).sessionManager = manager;
	return s.ctx;
}

async function call(tool: Tool, id: string, params: unknown, s: Session, manager: unknown): Promise<AgentToolResult<any>> {
	return tool.execute(id, params as never, undefined, undefined, ctxWith(s, manager));
}

const answeredSQLite = { status: "answered", question: QUESTION, answer: "SQLite", source: "option", recommendation: "Postgres", followedRecommendation: false, scope: "once" };

describe("across turns: an identical call asks again", () => {
	test("an identical call in a later turn opens the dialog normally", async () => {
		const tool = createAskUserTool();
		const b = branch();
		b.message([["t1", base()]]);
		const first = await call(tool, "t1", base(), session({ select: pick(0) }), b.manager);
		b.result("t1", first.details);
		b.userTurn();
		b.message([["t2", base()]]);
		const later = session({ select: pick(1) });
		const result = await call(tool, "t2", base(), later, b.manager);
		assert.equal(later.count("select"), 1, "the dialog opens again");
		assert.equal(result.details.answer, "Postgres");
		assert.ok(!("repeated" in result.details));
	});

	test("an earlier dismissal in another turn doesn't block either", async () => {
		const tool = createAskUserTool();
		const b = branch();
		b.message([["t1", base()]]);
		const first = await call(tool, "t1", base(), session({ select: reply(undefined) }), b.manager);
		b.result("t1", first.details);
		b.userTurn();
		b.message([["t2", base()]]);
		const later = session({ select: pick(0) });
		await call(tool, "t2", base(), later, b.manager);
		assert.equal(later.count("select"), 1);
	});
});

describe("siblings in one assistant message", () => {
	test("identical siblings: one dialog; the second gets the first's answer, marked repeated", async () => {
		const tool = createAskUserTool();
		const b = branch();
		b.message([["s1", base()], ["s2", base()]]);
		const first = session({ select: pick(0) });
		const r1 = await call(tool, "s1", base(), first, b.manager);
		assert.deepEqual(r1.details, answeredSQLite);
		const second = session({ select: pick(1) });
		const r2 = await call(tool, "s2", base(), second, b.manager); // s1's result not saved yet, as in a running turn
		assert.equal(second.calls.length + second.scopeCalls.length, 0, "no dialog at all");
		assert.deepEqual(r2.details, { ...answeredSQLite, repeated: true });
		const text = contentText(r2);
		assert.match(text, /same question as another ask_user call in your current response/);
		assert.match(text, /don't ask again about this decision in this scenario/);
	});

	test("an identical sibling after a dismissal → cancelled, repeated, no dialog", async () => {
		const tool = createAskUserTool();
		const b = branch();
		b.message([["s1", base()], ["s2", base()]]);
		await call(tool, "s1", base(), session({ select: reply(undefined) }), b.manager);
		const second = session({ select: pick(1) });
		const r2 = await call(tool, "s2", base(), second, b.manager);
		assert.equal(second.calls.length, 0);
		assert.deepEqual(r2.details, { status: "cancelled", question: QUESTION, cancelReason: "dismissed", repeated: true });
		assert.match(contentText(r2), /treat it as open/);
	});

	test("the sibling's scope and custom answer carry over exactly", async () => {
		const tool = createAskUserTool();
		const b = branch();
		b.message([["s1", base()], ["s2", base()]]);
		await call(tool, "s1", base(), session({ select: pickCustom, input: reply("  keep   both "), scope: (c) => c.choices![1] }), b.manager);
		const r2 = await call(tool, "s2", base(), session(), b.manager);
		assert.equal(r2.details.answer, "  keep   both ");
		assert.equal(r2.details.source, "custom");
		assert.equal(r2.details.scope, "similar");
		assert.equal(r2.details.repeated, true);
	});

	test("identical means the same call: case/whitespace/trailing ? in question and reason, label order and case, another recommendation", async () => {
		const tool = createAskUserTool();
		const b = branch();
		const variant = {
			question: "  WHICH database should\nthe cache use  ",
			reason: "changes deployment needs;  costly to migrate later.",
			options: [{ label: "in-memory", tradeoff: "x" }, { label: " POSTGRES", tradeoff: "y" }, { label: "sqlite", tradeoff: "z" }],
			recommendation: "sqlite",
		};
		b.message([["s1", base()], ["s2", variant]]);
		await call(tool, "s1", base(), session({ select: pick(0) }), b.manager);
		const second = session({ select: pick(1) });
		const r2 = await call(tool, "s2", variant, second, b.manager);
		assert.equal(second.calls.length, 0);
		assert.equal(r2.details.answer, "SQLite");
	});

	for (const [name, other] of [
		["a different question", base({ question: "Which database should the queue use?" })],
		["the same question with a different reason", base({ reason: "Only affects local tests." })],
		["the same question with different options", base({ options: [{ label: "MySQL", tradeoff: "a" }, { label: "MongoDB", tradeoff: "b" }], recommendation: undefined })],
	] as const) {
		test(`different calls in one response both ask: ${name}`, async () => {
			const tool = createAskUserTool();
			const b = branch();
			b.message([["s1", base()], ["s2", other]]);
			await call(tool, "s1", base(), session({ select: pick(0) }), b.manager);
			const second = session({ select: pick(0) });
			await call(tool, "s2", other, second, b.manager);
			assert.equal(second.count("select"), 1);
		});
	}

	test("an aborted sibling doesn't count; the identical sibling asks", async () => {
		const tool = createAskUserTool();
		const b = branch();
		b.message([["s1", base()], ["s2", base()]]);
		await tool.execute("s1", base() as never, AbortSignal.abort(), undefined, ctxWith(session(), b.manager));
		const second = session({ select: pick(0) });
		await call(tool, "s2", base(), second, b.manager);
		assert.equal(second.count("select"), 1);
	});

	test("a sibling's identical call with no UI gets the earlier answer (repeat check before the UI check)", async () => {
		const tool = createAskUserTool();
		const b = branch();
		b.message([["s1", base()], ["s2", base()]]);
		await call(tool, "s1", base(), session({ select: pick(0) }), b.manager);
		const r2 = await call(tool, "s2", base(), session({ hasUI: false }), b.manager);
		assert.equal(r2.details.status, "answered");
		assert.equal(r2.details.repeated, true);
	});

	test("without a session manager there are no siblings: each call asks", async () => {
		const tool = createAskUserTool();
		for (const id of ["s1", "s2"]) {
			const s = session({ select: pick(0) });
			await tool.execute(id, base() as never, undefined, undefined, s.ctx);
			assert.equal(s.count("select"), 1);
		}
	});

	test("invalid input still throws, even with an identical-looking sibling", async () => {
		const tool = createAskUserTool();
		const b = branch();
		b.message([["s1", base()], ["s2", base({ options: [] })]]);
		await call(tool, "s1", base(), session({ select: pick(0) }), b.manager);
		await assert.rejects(call(tool, "s2", base({ options: [] }), session(), b.manager), /options/);
	});
});
