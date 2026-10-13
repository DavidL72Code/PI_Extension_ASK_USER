// Console formatting of the batch report (./batch-format.ts), on hand-built
// scenario views: no tool runs here.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	clip,
	describeChoices,
	describeQuestion,
	describeRelation,
	describeResult,
	describeUser,
	formatBlock,
	formatCompact,
	formatReport,
	type CallView,
	type ScenarioView,
} from "./batch-format.ts";
import { QUESTION, base } from "./helpers.ts";

const CHOICES = ["1. SQLite", "2. [Recommended] Postgres", "3. In-memory", "4. Write my own answer"];
const MENU = { method: "select", title: `${QUESTION}\n\nWhy it matters: …`, choices: CHOICES };
const TEXT_BOX = { method: "input", title: QUESTION, placeholder: "Type your answer" };
const FOLLOW_UP = { method: "scope", title: 'Apply "Postgres" to similar questions this session?', choices: ["1. Just this time", "2. Also for similar questions this session"] };

const answeredOutcome = (answer: string, extra: Record<string, unknown> = {}) => ({
	status: "answered",
	details: { status: "answered", question: QUESTION, answer, source: "option", recommendation: "Postgres", followedRecommendation: answer === "Postgres", scope: "once", ...extra },
	firstLine: "ask_user: answered",
});
const call = (over: Partial<CallView> = {}): CallView => ({
	input: base(),
	user: { kind: "pick", choice: 2 },
	dialogs: [MENU, FOLLOW_UP],
	outcome: answeredOutcome("Postgres"),
	...over,
});
const view = (over: Partial<ScenarioView> = {}): ScenarioView => ({ name: "picks the recommended option", category: "answered", pass: true, mismatches: [], call: call(), ...over });

describe("batch report formatting", () => {
	test("clip: short text unchanged; long text cut to max characters ending in …; an emoji is never split", () => {
		assert.equal(clip("Postgres", 8), "Postgres");
		assert.equal(clip("Postgres!", 8), "Postgre…");
		assert.equal([...clip("ab🚀🚀🚀", 4)].length, 4);
		assert.equal(clip("ab🚀🚀🚀", 4), "ab🚀…");
	});

	test("answered: question, choices shown, user action with the follow-up, and the answer with its scope", () => {
		assert.deepEqual(formatBlock(view(), 11), [
			"PASS  answered     picks the recommended option",
			"      Question: Which database should the cache use?",
			"      Choices:  1. SQLite | 2. [Recommended] Postgres | 3. In-memory | 4. Write my own answer",
			'      User:     picks choice 2, then "Just this time"',
			'      Result:   ask_user: answered → "Postgres" (option, recommended, scope once)',
		]);
	});

	test("answered: against the recommendation, custom text, scope similar", () => {
		assert.equal(describeResult(call({ outcome: answeredOutcome("SQLite") })), 'ask_user: answered → "SQLite" (option, not recommended, scope once)');
		const custom = call({
			user: { kind: "type", text: "  Use Redis  " },
			followUp: "similar",
			dialogs: [MENU, TEXT_BOX, FOLLOW_UP],
			outcome: answeredOutcome("  Use Redis  ", { source: "custom", followedRecommendation: false, scope: "similar" }),
		});
		assert.equal(describeUser(custom), 'picks "Write my own answer", types "  Use Redis  ", then "Also for similar questions this session"');
		assert.equal(describeResult(custom), 'ask_user: answered → "  Use Redis  " (custom, scope similar)');
	});

	test("cancelled: the reason and no answer; escapes in typed text stay visible", () => {
		const empty = call({
			user: { kind: "type", text: " \t\n" },
			dialogs: [MENU, TEXT_BOX],
			outcome: { status: "cancelled", details: { status: "cancelled", question: QUESTION, cancelReason: "empty_answer" }, firstLine: "ask_user: cancelled (empty_answer)" },
		});
		assert.equal(describeUser(empty), 'picks "Write my own answer", types " \\t\\n"');
		assert.equal(describeResult(empty), "ask_user: cancelled (empty_answer) — no answer");
		const esc = call({ user: { kind: "escMenu" }, dialogs: [MENU], outcome: { status: "cancelled", details: { status: "cancelled", question: QUESTION, cancelReason: "dismissed" }, firstLine: "ask_user: cancelled (dismissed)" } });
		assert.equal(describeUser(esc), "presses Esc on the menu");
		assert.equal(describeResult(esc), "ask_user: cancelled (dismissed) — no answer");
	});

	test("unavailable: no UI, no dialog opened; the call's options are listed as given", () => {
		const noUI = call({ user: { kind: "noUI" }, dialogs: [], outcome: { status: "unavailable", details: { status: "unavailable", question: QUESTION }, firstLine: "ask_user: unavailable" } });
		assert.equal(describeUser(noUI), "no UI — no dialog opened");
		assert.equal(describeChoices(noUI), 'none shown — the call\'s options: "SQLite", "Postgres", "In-memory"');
		assert.equal(describeResult(noUI), "ask_user: unavailable — no answer");
	});

	test("invalid: rejected before any dialog, with the error; raw labels keep their line breaks and spaces visible", () => {
		const invalid = call({
			input: { ...base(), options: [{ label: "SQLite\nfast", tradeoff: "x" }, { label: " Postgres\t", tradeoff: "y" }] },
			user: { kind: "none" },
			dialogs: [],
			outcome: { error: "ask_user: options[0] label and tradeoff must each be a single line" },
		});
		assert.equal(describeUser(invalid), "no dialog opened");
		assert.equal(describeChoices(invalid), 'none shown — the call\'s options: "SQLite\\nfast", " Postgres\\t"');
		assert.equal(describeResult(invalid), "rejected before any dialog: ask_user: options[0] label and tradeoff must each be a single line");
	});

	test("an error after a dialog opened names that dialog", () => {
		const unexpected = call({ user: { kind: "menuReturns", value: "Postgres" }, dialogs: [MENU], outcome: { error: 'ask_user: unexpected dialog response "Postgres"' } });
		assert.equal(describeUser(unexpected), 'client returns "Postgres" from the menu (not a displayed choice)');
		assert.equal(describeResult(unexpected), 'error after the menu: ask_user: unexpected dialog response "Postgres"');
	});

	test("the user line follows the dialogs that actually opened, not the planned action", () => {
		assert.equal(describeUser(call({ user: { kind: "noUI" }, dialogs: [MENU] })), "no UI, yet opened: menu");
		assert.equal(describeUser(call({ user: { kind: "none" }, dialogs: [MENU, FOLLOW_UP] })), "nothing to answer, yet opened: menu, follow-up");
		assert.equal(describeUser(call({ user: { kind: "pick", choice: 1 }, dialogs: [], outcome: { error: "boom" } })), "no dialog opened");
		assert.equal(describeUser(call({ followUp: "esc" })), "picks choice 2, then Esc on the follow-up");
		assert.equal(describeUser(call(), true), 'picks choice 2, then "Just this time" (opened: menu, follow-up)');
	});

	test("repeat: the earlier call, which dialogs opened, and that the second call got its result", () => {
		const earlier = { ...call({ user: { kind: "pick", choice: 3 }, outcome: answeredOutcome("In-memory") }), sameMessage: true, saved: false };
		const second = call({ dialogs: [], outcome: answeredOutcome("In-memory", { repeated: true }) });
		assert.deepEqual(formatBlock(view({ name: "identical siblings", category: "repeat", earlier, call: second }), 6), [
			"PASS  repeat  identical siblings",
			"      Earlier:  a sibling call in the same response: identical (its result not saved yet)",
			'                picks choice 3, then "Just this time" (opened: menu, follow-up)',
			'                result: ask_user: answered → "In-memory" (option, not recommended, scope once)',
			"      Question: Which database should the cache use?",
			'      Choices:  none shown — the call\'s options: "SQLite", "Postgres", "In-memory"',
			"      User:     no dialog opened; got the earlier call's result",
			'      Result:   ask_user: answered → "In-memory" (option, not recommended, scope once, repeated)',
		]);
		const dismissed = call({ dialogs: [], outcome: { status: "cancelled", details: { status: "cancelled", question: QUESTION, cancelReason: "dismissed", repeated: true }, firstLine: "ask_user: cancelled (dismissed)" } });
		assert.equal(describeResult(dismissed), "ask_user: cancelled (dismissed) — no answer (repeated)");
	});

	test("relation of the earlier call: identical after normalizing, or what differs", () => {
		assert.equal(describeRelation(base(), base({ question: "  which DATABASE\tshould the cache use " })), "identical");
		assert.equal(describeRelation(base(), base({ question: "Which database should the queue use?" })), "another question");
		assert.equal(describeRelation(base(), base({ reason: "Only affects local tests." })), "same question, another reason");
		assert.equal(describeRelation(base(), base({ options: [{ label: "MySQL", tradeoff: "x" }, { label: "MongoDB", tradeoff: "y" }] })), "same question and reason, other options");
		assert.equal(describeRelation(base(), "not a call"), "another call");
	});

	test("display only: long text is shortened with …; missing fields show —", () => {
		const long = "Which storage engine should the long-running background cache use when the disk is nearly full?";
		const q = describeQuestion(call({ input: base({ question: long }), dialogs: [] }));
		assert.equal([...q].length, 90);
		assert.ok(q.endsWith("…") && long.startsWith(q.slice(0, -1)));
		const typed = describeUser(call({ user: { kind: "type", text: "x".repeat(80) }, dialogs: [MENU, TEXT_BOX, FOLLOW_UP] }));
		assert.match(typed, /types "x{49}…", then/);
		assert.equal(describeQuestion(call({ input: {}, dialogs: [] })), "—");
		assert.equal(describeChoices(call({ input: { options: [{}] }, dialogs: [] })), "none shown — the call's options: —");
		assert.equal(describeChoices(call({ input: null, dialogs: [] })), "none shown");
		assert.equal(describeResult(call({ outcome: { details: { status: "answered" } } })), "ask_user: answered → — (—, scope —)");
	});

	test("a whitespace-only question is shown quoted, not as a blank line", () => {
		assert.equal(describeQuestion(call({ input: base({ question: "   " }), dialogs: [] })), '"   "');
	});

	test("FAIL: the block lists each mismatch, and the report repeats failures before the totals", () => {
		const failing = view({ name: "picks against the recommendation", pass: false, mismatches: ["status: expected answered, got cancelled", "dialogs: expected [], got [\"select\"]"] });
		const block = formatBlock(failing, 8);
		assert.equal(block[0], "FAIL  answered  picks against the recommendation");
		assert.deepEqual(block.slice(-2), ["      Mismatch: status: expected answered, got cancelled", '      Mismatch: dialogs: expected [], got ["select"]']);
		const report = formatReport([view(), failing], false);
		assert.deepEqual(report.slice(-3), ["", "Failed:", "FAIL  answered  picks against the recommendation"]);
		assert.equal(report.filter((l) => l === "").length, 2, "one blank line between the two blocks, one before the failure list");
	});

	test("--compact: today's one-line format, mismatches indented under a failing line", () => {
		const failing = view({ name: "x", category: "invalid", pass: false, mismatches: ["dialogs: expected [], got [\"select\"]"] });
		assert.deepEqual(formatCompact(failing, 11), ["FAIL  invalid      x", '      - dialogs: expected [], got ["select"]']);
		assert.deepEqual(formatReport([view(), failing], true), [
			"PASS  answered  picks the recommended option",
			"FAIL  invalid   x",
			'      - dialogs: expected [], got ["select"]',
		]);
	});
});
