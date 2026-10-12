// Rule 16: after a new answer, "Apply … to similar questions this session?"

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { createAskUserTool } from "../../src/index.ts";
import {
	QUESTION,
	alsoSimilar,
	base,
	contentText,
	pick,
	pickCustom,
	reply,
	run,
	session,
	untilAborted,
	withoutRecommendation,
	type Session,
} from "./helpers.ts";

const ONCE = "1. Just this time";
const SIMILAR = "2. Also for similar questions this session";
const title = (shown: string) => `Apply "${shown}" to similar questions this session?`;

describe("rule 16: the follow-up after a new answer", () => {
	test("after an option: exact title and choices, signal passed, no timeout; Enter-Enter keeps scope once", async () => {
		const s = session({ select: pick(1) });
		const controller = new AbortController();
		const result = await run(base(), s, controller.signal);
		assert.equal(s.scopeCalls.length, 1);
		const follow = s.scopeCalls[0]!;
		assert.equal(follow.title, title("Postgres"));
		assert.deepEqual(follow.choices, [ONCE, SIMILAR]);
		assert.equal(follow.opts?.signal, controller.signal);
		assert.ok(!("timeout" in (follow.opts ?? {})));
		assert.deepEqual(result.details, {
			status: "answered",
			question: QUESTION,
			answer: "Postgres",
			source: "option",
			recommendation: "Postgres",
			followedRecommendation: true,
			scope: "once",
		});
		assert.match(contentText(result), /applies to this question only/);
	});

	test('"Also for similar questions" → scope similar, and the content tells the agent how to use it', async () => {
		const s = session({ select: pick(0), scope: alsoSimilar });
		const result = await run(withoutRecommendation(), s);
		assert.deepEqual(result.details, { status: "answered", question: QUESTION, answer: "SQLite", source: "option", scope: "similar" });
		const text = contentText(result);
		assert.match(text, /apply this choice to similar decisions for the rest of this session/);
		assert.match(text, /For a later decision you judge similar, don't call ask_user: apply this preference and tell the user you did/);
		assert.match(text, /If you're unsure whether a decision is similar, ask/);
	});

	test("after a custom answer: quoted in the title; the answer itself stays exact", async () => {
		const typed = "  keep   both  ";
		const s = session({ select: pickCustom, input: reply(typed) });
		const result = await run(base(), s);
		assert.equal(s.scopeCalls[0]!.title, title(typed));
		assert.equal(result.details.answer, typed);
		assert.equal(result.details.scope, "once");
	});

	test("a long custom answer is shortened to 60 characters + … in the title only, never splitting an emoji", async () => {
		const typed = `${"x".repeat(59)}🚀🚀 and more text after the cut`;
		const s = session({ select: pickCustom, input: reply(typed) });
		const result = await run(withoutRecommendation(), s);
		assert.equal(s.scopeCalls[0]!.title, title(`${"x".repeat(59)}🚀…`));
		assert.equal(result.details.answer, typed, "details keep the full answer");
		const exactly60 = "y".repeat(60);
		const s60 = session({ select: pickCustom, input: reply(exactly60) });
		await run(withoutRecommendation(), s60);
		assert.equal(s60.scopeCalls[0]!.title, title(exactly60), "60 characters are shown in full");
	});

	for (const [name, scope] of [
		["Esc", reply(undefined)],
		["an unexpected value", reply("2. Also for similar")],
		["a dialog error", () => Promise.reject(new Error("terminal gone"))],
	] as const) {
		test(`${name} on the follow-up → scope once; the answer stands`, async () => {
			const s = session({ select: pick(2), scope });
			const result = await run(base(), s);
			assert.equal(result.details.status, "answered");
			assert.equal(result.details.answer, "In-memory");
			assert.equal(result.details.scope, "once");
		});
	}

	test("an abort while the follow-up is open → scope once; the answer stands (not cancelled)", async () => {
		const controller = new AbortController();
		const s = session({
			select: pick(0),
			scope: (call) => {
				const closed = untilAborted(call);
				setImmediate(() => controller.abort());
				return closed;
			},
		});
		const result = await run(base(), s, controller.signal);
		assert.equal(s.scopeCalls.length, 1);
		assert.deepEqual(result.details, {
			status: "answered",
			question: QUESTION,
			answer: "SQLite",
			source: "option",
			recommendation: "Postgres",
			followedRecommendation: false,
			scope: "once",
		});
	});

	test("an abort landing as the answer is picked → no follow-up opens, scope once", async () => {
		const controller = new AbortController();
		const s = session({
			select: (call) => {
				controller.abort();
				return call.choices![1];
			},
		});
		const result = await run(base(), s, controller.signal);
		assert.equal(s.scopeCalls.length, 0);
		assert.equal(result.details.answer, "Postgres");
		assert.equal(result.details.scope, "once");
	});

	for (const [name, make] of [
		["dismissed", () => session({ select: reply(undefined) })],
		["empty answer", () => session({ select: pickCustom, input: reply("  ") })],
		["no UI", () => session({ hasUI: false })],
	] as const) {
		test(`${name}: no follow-up and no scope`, async () => {
			const s: Session = make();
			const result = await run(base(), s);
			assert.equal(s.scopeCalls.length, 0);
			assert.ok(!("scope" in result.details));
		});
	}
});

describe("rule 16 with identical siblings: the repeat carries the sibling's scope", () => {
	/** A branch with one assistant message holding two identical ask_user calls. */
	const siblings = () => {
		const entries = [
			{ type: "message", id: "u", parentId: null, message: { role: "user" } },
			{ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [["s1", base()], ["s2", base()]].map(([id, args]) => ({ type: "toolCall", id, name: "ask_user", arguments: args })) } },
		];
		return { getBranch: () => entries };
	};
	const ask = (tool: ReturnType<typeof createAskUserTool>, id: string, s: Session, manager: unknown): Promise<AgentToolResult<any>> => {
		(s.ctx as unknown as { sessionManager: unknown }).sessionManager = manager;
		return tool.execute(id, base() as never, undefined, undefined, s.ctx);
	};

	for (const scope of ["similar", "once"] as const) {
		test(`a sibling answered with scope ${scope} → the identical sibling repeats it, with no dialogs`, async () => {
			const tool = createAskUserTool();
			const manager = siblings();
			await ask(tool, "s1", session({ select: pick(0), scope: scope === "similar" ? alsoSimilar : undefined }), manager);
			const second = session({ select: pick(1) });
			const result = await ask(tool, "s2", second, manager);
			assert.equal(second.calls.length + second.scopeCalls.length, 0);
			assert.equal(result.details.scope, scope);
			assert.equal(result.details.repeated, true);
			if (scope === "similar") assert.match(contentText(result), /similar decisions for the rest of this session/);
		});
	}
});
