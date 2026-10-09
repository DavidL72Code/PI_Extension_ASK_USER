import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { CUSTOM_ANSWER_LABEL } from "../src/ask-user.ts";
import {
	QUESTION,
	REASON,
	abortWhileOpen,
	base,
	contentText,
	pick,
	pickCustom,
	reply,
	run,
	session,
	tool,
	untilAborted,
	withoutRecommendation,
} from "./helpers.ts";

// The harness (fake pi, fake dialogs) and fixtures live in ./helpers.ts.

function textOf(result: AgentToolResult<any>): string {
	assert.equal(result.content.length, 1, "content is a single block");
	assert.equal(result.content[0]!.type, "text");
	return contentText(result);
}

const firstLine = (result: AgentToolResult<any>) => textOf(result).split("\n")[0];

const EXPECTED_CHOICES = ["1. SQLite", "2. [Recommended] Postgres", "3. In-memory", "4. Write my own answer"];

const EXPECTED_TITLE = [
	QUESTION,
	"",
	`Why it matters: ${REASON}`,
	"",
	"1. SQLite",
	"   Zero setup; one writer at a time",
	"",
	"2. [Recommended] Postgres",
	"   Needs a server; handles concurrent writers",
	"",
	"3. In-memory",
	"   Fastest; lost on restart",
].join("\n");

/** Words a cancelled/unavailable result must never contain. */
const NO_ANSWER_FORBIDDEN = [/Postgres/, /default/i, /proceed with/i, /go ahead/i, /agreed/i, /approved/i, /ask (it )?again|re-ask/i];

function assertNoAnswerText(text: string) {
	assert.match(text, /do not assume/i, "tells the agent not to assume an answer");
	assert.ok(text.includes(QUESTION), "names the open decision (the question)");
	assert.match(text, /continue only with work that does not depend on/i);
	for (const pattern of NO_ANSWER_FORBIDDEN) assert.doesNotMatch(text, pattern);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registration", () => {
	test("registers ask_user, sequential, with a 2–3 option schema", () => {
		assert.equal(tool.name, "ask_user");
		assert.equal(typeof tool.label, "string");
		assert.equal(tool.executionMode, "sequential");
		const schema = tool.parameters as any;
		assert.equal(schema.additionalProperties, false, "unknown top-level fields are rejected by the schema");
		assert.equal(schema.properties.options.items.additionalProperties, false, "unknown option fields are rejected");
		assert.equal(schema.properties.options.minItems, 2);
		assert.equal(schema.properties.options.maxItems, 3);
		assert.deepEqual([...schema.required].sort(), ["options", "question", "reason"]);
		assert.ok(schema.properties.recommendation, "recommendation is declared (optional)");
	});

	test("model-facing description and guidelines carry the asking policy", () => {
		assert.ok(tool.description.length > 0);
		assert.equal(typeof tool.promptSnippet, "string");
		assert.ok(tool.promptSnippet!.length > 0);
		assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0);
		const guidance = tool.promptGuidelines!.join("\n");
		assert.match(guidance, /ask_user/);
		assert.match(guidance, /behavior|scope|rework/i, "when to ask");
		assert.match(guidance, /your call|delegat/i, "delegated choices proceed");
		assert.match(guidance, /cancelled|unavailable/, "what to do without an answer");
		assert.match(guidance, /do not (invent|assume)/i);
	});
});

// ---------------------------------------------------------------------------
// Dialog shape
// ---------------------------------------------------------------------------

describe("dialog", () => {
	const option = (label: string, tradeoff = "Some tradeoff") => ({ label, tradeoff });

	test("title lists question, reason, and each option with its tradeoff; choices are short, numbered, marked, custom last", async () => {
		const s = session();
		const controller = new AbortController();
		await run(base(), s, controller.signal);
		assert.equal(s.calls.length, 1);
		const [call] = s.calls;
		assert.equal(call!.method, "select");
		assert.equal(call!.title, EXPECTED_TITLE);
		assert.deepEqual(call!.choices, EXPECTED_CHOICES);
		assert.equal(call!.choices!.at(-1), `4. ${CUSTOM_ANSWER_LABEL}`, "custom choice is last and numbered");
		assert.equal(call!.opts?.signal, controller.signal, "execute signal is passed to select");
		assert.ok(!("timeout" in (call!.opts ?? {})), "no timeout is passed");
	});

	test("matches the human-approved example (2 options, option 2 recommended)", async () => {
		const s = session();
		await run(
			{
				question: "Should the reminder remember previous notifications after Pi restarts?",
				reason: "Persistence changes what you see after a restart and is costly to redo.",
				options: [
					{ label: "Session only", tradeoff: "Simpler; forgets everything when Pi restarts." },
					{ label: "Persist to disk", tradeoff: "Survives restarts; needs a state file and cleanup." },
				],
				recommendation: "Persist to disk",
			},
			s,
		);
		assert.equal(
			s.calls[0]!.title,
			"Should the reminder remember previous notifications after Pi restarts?\n\n" +
				"Why it matters: Persistence changes what you see after a restart and is costly to redo.\n\n" +
				"1. Session only\n   Simpler; forgets everything when Pi restarts.\n\n" +
				"2. [Recommended] Persist to disk\n   Survives restarts; needs a state file and cleanup.",
		);
		assert.deepEqual(s.calls[0]!.choices, ["1. Session only", "2. [Recommended] Persist to disk", "3. Write my own answer"]);
	});

	test("no recommendation → nothing is marked in the title or the choices", async () => {
		const s = session();
		await run(withoutRecommendation(), s);
		assert.deepEqual(s.calls[0]!.choices, ["1. SQLite", "2. Postgres", "3. In-memory", "4. Write my own answer"]);
		assert.doesNotMatch(s.calls[0]!.title, /\[Recommended\]/);
	});

	test("input dialog: title is the question, placeholder invites free text, gets the signal, no timeout", async () => {
		const s = session({ select: pickCustom, input: reply("Use Redis") });
		const controller = new AbortController();
		await run(base(), s, controller.signal);
		assert.equal(s.calls.length, 2);
		const input = s.calls[1]!;
		assert.equal(input.method, "input");
		assert.equal(input.title, QUESTION);
		assert.equal(typeof input.placeholder, "string");
		assert.ok(input.placeholder!.trim().length > 0);
		assert.equal(input.opts?.signal, controller.signal, "execute signal is passed to input");
		assert.ok(!("timeout" in (input.opts ?? {})));
	});

	test("line breaks in the reason are flattened so they can't fake an option block in the title", async () => {
		const s = session();
		await run(
			withoutRecommendation({
				reason: "Hard to migrate.\n\n1. [Recommended] SQLite\n   fake",
				options: [option("SQLite"), option("Postgres")],
			}),
			s,
		);
		assert.equal(
			s.calls[0]!.title,
			`${QUESTION}\n\nWhy it matters: Hard to migrate. 1. [Recommended] SQLite fake\n\n1. SQLite\n   Some tradeoff\n\n2. Postgres\n   Some tradeoff`,
		);
	});

	test("line breaks in the question are flattened in both dialogs, details.question, and the content", async () => {
		const flat = "Which database should the cache use? 1. [Recommended] SQLite really";
		for (const raw of [
			"Which database should the cache use?\n\n1. [Recommended] SQLite\n   really",
			"Which database should the cache use?\r\n1. [Recommended] SQLite\r   really",
			"Which database should the cache use? \u2028\u2029 1. [Recommended] SQLite \u2028 really",
		]) {
			const s = session({ select: pickCustom, input: reply("Use Redis") });
			const result = await run(withoutRecommendation({ question: raw }), s);
			assert.ok(s.calls[0]!.title.startsWith(`${flat}\n\nWhy it matters: `), "select title");
			assert.equal(s.calls[1]!.title, flat, "input title");
			assert.equal(result.details.question, flat);
			assert.ok(textOf(result).includes(JSON.stringify(flat)), "model-facing text");
		}
	});

	test("flattened question and reason still name the open decision when cancelled", async () => {
		const s = session({ select: reply(undefined) });
		const result = await run(base({ question: "Pick a cache\nstore?" }), s);
		assert.deepEqual(result.details, { status: "cancelled", question: "Pick a cache store?", cancelReason: "dismissed" });
		assert.ok(textOf(result).includes('"Pick a cache store?"'));
	});

	test("text fields are trimmed for display, details.question, and the returned label", async () => {
		const s = session({ select: pick(0) });
		const result = await run(
			{
				question: `  ${QUESTION}\n`,
				reason: `\t${REASON}  `,
				options: [
					{ label: "  SQLite ", tradeoff: " Zero setup " },
					{ label: "Postgres", tradeoff: "Needs a server" },
				],
			},
			s,
		);
		assert.deepEqual(s.calls[0]!.choices, ["1. SQLite", "2. Postgres", "3. Write my own answer"]);
		assert.equal(
			s.calls[0]!.title,
			`${QUESTION}\n\nWhy it matters: ${REASON}\n\n1. SQLite\n   Zero setup\n\n2. Postgres\n   Needs a server`,
		);
		assert.deepEqual(result.details, { status: "answered", question: QUESTION, answer: "SQLite", source: "option" });
	});
});

// ---------------------------------------------------------------------------
// answered
// ---------------------------------------------------------------------------

describe("answered", () => {
	test("picks the recommended option → answered, label only, followedRecommendation true", async () => {
		const s = session({ select: pick(1) });
		const result = await run(base(), s);
		assert.deepEqual(result.details, {
			status: "answered",
			question: QUESTION,
			answer: "Postgres",
			source: "option",
			recommendation: "Postgres",
			followedRecommendation: true,
		});
		assert.equal(firstLine(result), "ask_user: answered");
		assert.ok(textOf(result).includes(QUESTION));
		assert.ok(textOf(result).includes('"Postgres"'));
		assert.doesNotMatch(textOf(result), /Needs a server/, "tradeoff is not part of the answer");
		assert.equal(s.count("input"), 0);
	});

	test("picks against the recommendation → user's pick returned, followedRecommendation false, content says so", async () => {
		const s = session({ select: pick(0) });
		const result = await run(base(), s);
		assert.deepEqual(result.details, {
			status: "answered",
			question: QUESTION,
			answer: "SQLite",
			source: "option",
			recommendation: "Postgres",
			followedRecommendation: false,
		});
		const text = textOf(result);
		assert.equal(firstLine(result), "ask_user: answered");
		assert.ok(text.includes('"SQLite"'));
		assert.match(text, /not the option you recommended/i);
		assert.doesNotMatch(text, /\bfollowed\b|\bagreed\b/i);
	});

	test("no recommendation → recommendation and followedRecommendation keys are omitted", async () => {
		const s = session({ select: pick(2) });
		const result = await run(withoutRecommendation(), s);
		assert.deepEqual(result.details, { status: "answered", question: QUESTION, answer: "In-memory", source: "option" });
		assert.ok(!("recommendation" in result.details));
		assert.ok(!("followedRecommendation" in result.details));
	});

	test("two options → three choices; second option maps correctly", async () => {
		const s = session({ select: pick(1) });
		const params = withoutRecommendation();
		params.options = (params.options as unknown[]).slice(0, 2);
		const result = await run(params, s);
		assert.equal(s.calls[0]!.choices!.length, 3);
		assert.equal(s.calls[0]!.choices!.at(-1), "3. Write my own answer");
		assert.equal(result.details.answer, "Postgres");
	});

	test("works when execute gets no signal", async () => {
		const s = session({ select: pick(1) });
		const result = await run(base(), s, undefined);
		assert.equal(result.details.status, "answered");
		assert.equal(result.details.answer, "Postgres");
	});

	test("custom answer → answered/custom, JSON-quoted in content, followedRecommendation false", async () => {
		const s = session({ select: pickCustom, input: reply("Use Redis") });
		const result = await run(base(), s);
		assert.deepEqual(result.details, {
			status: "answered",
			question: QUESTION,
			answer: "Use Redis",
			source: "custom",
			recommendation: "Postgres",
			followedRecommendation: false,
		});
		assert.equal(firstLine(result), "ask_user: answered");
		assert.ok(textOf(result).includes(JSON.stringify("Use Redis")));
		assert.equal(s.count("select"), 1);
		assert.equal(s.count("input"), 1);
	});

	test("custom answer keeps outer and inner whitespace exactly", async () => {
		const typed = "  keep   both  ";
		const s = session({ select: pickCustom, input: reply(typed) });
		const result = await run(base(), s);
		assert.equal(result.details.answer, typed);
		assert.ok(textOf(result).includes(JSON.stringify(typed)));
	});

	test("custom answer with unicode is returned byte-exact (no normalization)", async () => {
		const typed = "naïve café 日本語 🚀 é — ok";
		const s = session({ select: pickCustom, input: reply(typed) });
		const result = await run(withoutRecommendation(), s);
		assert.deepEqual(result.details, { status: "answered", question: QUESTION, answer: typed, source: "custom" });
	});

	test("custom text equal to the recommended label stays custom, followedRecommendation false", async () => {
		const s = session({ select: pickCustom, input: reply("Postgres") });
		const result = await run(base(), s);
		assert.equal(result.details.source, "custom");
		assert.equal(result.details.answer, "Postgres");
		assert.equal(result.details.followedRecommendation, false);
	});

	test("maps by position when labels contain look-alike marker text, a separator, or numbered custom text", async () => {
		const params = base({
			options: [
				{ label: "Postgres (recommended)", tradeoff: "Parenthesized text, not the [Recommended] marker" },
				{ label: "Postgres", tradeoff: "The real recommendation" },
				{ label: `3. ${CUSTOM_ANSWER_LABEL} — b (recommended)`, tradeoff: "c" },
			],
		});
		const labels = ["Postgres (recommended)", "Postgres", `3. ${CUSTOM_ANSWER_LABEL} — b (recommended)`];
		for (const [index, label] of labels.entries()) {
			const s = session({ select: pick(index) });
			const result = await run(params, s);
			assert.deepEqual(s.calls[0]!.choices, [
				"1. Postgres (recommended)",
				"2. [Recommended] Postgres",
				`3. 3. ${CUSTOM_ANSWER_LABEL} — b (recommended)`,
				"4. Write my own answer",
			]);
			assert.equal(new Set(s.calls[0]!.choices).size, 4, "all displayed choices are distinct");
			assert.equal(result.details.answer, label);
			assert.equal(result.details.followedRecommendation, label === "Postgres");
			assert.equal(s.count("input"), 0);
		}
	});

	test(`a label "3. ${CUSTOM_ANSWER_LABEL}" is allowed: it maps to its option, and the last choice still opens input`, async () => {
		const params = withoutRecommendation({
			options: [
				{ label: `3. ${CUSTOM_ANSWER_LABEL}`, tradeoff: "Shares the text but not the whole label" },
				{ label: "Postgres", tradeoff: "Needs a server" },
			],
		});
		const asOption = session({ select: pick(0) });
		const optionResult = await run(params, asOption);
		assert.equal(new Set(asOption.calls[0]!.choices).size, 3, "all displayed choices are distinct");
		assert.deepEqual(optionResult.details, {
			status: "answered",
			question: QUESTION,
			answer: `3. ${CUSTOM_ANSWER_LABEL}`,
			source: "option",
		});
		assert.equal(asOption.count("input"), 0);

		const asCustom = session({ select: pickCustom, input: reply("Something else") });
		const customResult = await run(params, asCustom);
		assert.equal(asCustom.count("input"), 1);
		assert.equal(customResult.details.source, "custom");
		assert.equal(customResult.details.answer, "Something else");
	});

	test("recommendation is matched trimmed + case-insensitively and stored as the canonical label", async () => {
		const s = session({ select: pick(1) });
		const result = await run(base({ recommendation: "  postgres " }), s);
		assert.deepEqual(s.calls[0]!.choices, EXPECTED_CHOICES);
		assert.equal(result.details.recommendation, "Postgres");
		assert.equal(result.details.followedRecommendation, true);
	});

	test("a valid choice returned as the abort lands is still the human's answer", async () => {
		const controller = new AbortController();
		const s = session({
			select: (call) => {
				controller.abort();
				return call.choices![0];
			},
		});
		const result = await run(base(), s, controller.signal);
		assert.equal(result.details.status, "answered");
		assert.equal(result.details.answer, "SQLite");
		assert.equal(result.details.followedRecommendation, false);
	});
});

// ---------------------------------------------------------------------------
// cancelled
// ---------------------------------------------------------------------------

describe("cancelled", () => {
	test("select dismissed → cancelled/dismissed, no answer keys", async () => {
		const s = session({ select: reply(undefined) });
		const result = await run(base(), s);
		assert.deepEqual(result.details, { status: "cancelled", question: QUESTION, cancelReason: "dismissed" });
		assert.equal(firstLine(result), "ask_user: cancelled (dismissed)");
		assertNoAnswerText(textOf(result));
		assert.equal(s.count("input"), 0);
	});

	test("custom input dismissed → cancelled/dismissed", async () => {
		const s = session({ select: pickCustom, input: reply(undefined) });
		const result = await run(base(), s);
		assert.deepEqual(result.details, { status: "cancelled", question: QUESTION, cancelReason: "dismissed" });
		assert.equal(firstLine(result), "ask_user: cancelled (dismissed)");
		assert.equal(s.count("select"), 1);
		assert.equal(s.count("input"), 1);
	});

	for (const [name, typed] of [
		["empty", ""],
		["whitespace-only", "  \t\n "],
		["ideographic space", " 　"],
	] as const) {
		test(`${name} custom answer → cancelled/empty_answer`, async () => {
			const s = session({ select: pickCustom, input: reply(typed) });
			const result = await run(base(), s);
			assert.deepEqual(result.details, { status: "cancelled", question: QUESTION, cancelReason: "empty_answer" });
			assert.equal(firstLine(result), "ask_user: cancelled (empty_answer)");
			assertNoAnswerText(textOf(result));
		});
	}

	test("signal already aborted → cancelled/aborted, no dialog", async () => {
		const s = session({ select: pick(1) });
		const result = await run(base(), s, AbortSignal.abort());
		assert.deepEqual(result.details, { status: "cancelled", question: QUESTION, cancelReason: "aborted" });
		assert.equal(firstLine(result), "ask_user: cancelled (aborted)");
		assertNoAnswerText(textOf(result));
		assert.equal(s.calls.length, 0);
	});

	test("already-aborted check comes before the UI check", async () => {
		const s = session({ hasUI: false });
		const result = await run(base(), s, AbortSignal.abort());
		assert.deepEqual(result.details, { status: "cancelled", question: QUESTION, cancelReason: "aborted" });
		assert.equal(s.calls.length, 0);
	});

	test("abort while select is open (resolves undefined) → cancelled/aborted, not dismissed", async () => {
		const controller = new AbortController();
		const s = session({ select: abortWhileOpen(controller) });
		const result = await run(base(), s, controller.signal);
		assert.deepEqual(result.details, { status: "cancelled", question: QUESTION, cancelReason: "aborted" });
		assert.equal(s.calls[0]!.opts?.signal, controller.signal);
	});

	test("abort while select is open (rejects AbortError) → cancelled/aborted, not thrown", async () => {
		const controller = new AbortController();
		const s = session({
			select: (call) =>
				untilAborted(call).then(() => {
					throw new DOMException("aborted", "AbortError");
				}),
		});
		setImmediate(() => controller.abort());
		const result = await run(base(), s, controller.signal);
		assert.deepEqual(result.details, { status: "cancelled", question: QUESTION, cancelReason: "aborted" });
	});

	test("abort while custom input is open → cancelled/aborted", async () => {
		const controller = new AbortController();
		const s = session({ select: pickCustom, input: abortWhileOpen(controller) });
		const result = await run(base(), s, controller.signal);
		assert.deepEqual(result.details, { status: "cancelled", question: QUESTION, cancelReason: "aborted" });
		assert.equal(firstLine(result), "ask_user: cancelled (aborted)");
		assert.equal(s.count("input"), 1);
	});
});

// ---------------------------------------------------------------------------
// unavailable
// ---------------------------------------------------------------------------

describe("unavailable", () => {
	test("hasUI false → unavailable, exactly {status, question}, zero dialog calls", async () => {
		const s = session({ hasUI: false, select: pick(1), input: reply("x") });
		const result = await run(base(), s);
		assert.deepEqual(result.details, { status: "unavailable", question: QUESTION });
		assert.equal(s.calls.length, 0);
		const text = textOf(result);
		assert.equal(firstLine(result), "ask_user: unavailable");
		assert.match(text, /could not be asked/i);
		assertNoAnswerText(text);
		assert.doesNotMatch(text, /dismiss|declin/i);
	});
});

// ---------------------------------------------------------------------------
// Errors (tool errors are thrown; no dialog opens for invalid input)
// ---------------------------------------------------------------------------

describe("errors", () => {
	test("select resolving a string that is not a displayed choice throws (no text matching)", async () => {
		const s = session({ select: reply("Postgres") });
		await assert.rejects(run(base(), s), /unexpected dialog response/);
		assert.equal(s.count("input"), 0);
	});

	test("select rejecting without an abort is rethrown", async () => {
		const s = session({
			select: () => {
				throw new Error("terminal exploded");
			},
		});
		await assert.rejects(run(base(), s), /terminal exploded/);
	});

	const option = (label: unknown, tradeoff: unknown = "Some tradeoff") => ({ label, tradeoff });
	const invalid: Array<[string, Record<string, unknown>, RegExp]> = [
		["0 options", withoutRecommendation({ options: [] }), /options.*2 or 3/],
		["1 option", withoutRecommendation({ options: [option("SQLite")] }), /options.*2 or 3/],
		[
			"4 options",
			withoutRecommendation({ options: [option("A"), option("B"), option("C"), option("D")] }),
			/options.*2 or 3/,
		],
		["options missing", withoutRecommendation({ options: undefined }), /options/],
		["options not an array", withoutRecommendation({ options: "SQLite, Postgres" }), /options/],
		["option not an object", withoutRecommendation({ options: ["SQLite", "Postgres"] }), /options\[0\]/],
		["empty question", base({ question: "" }), /question/],
		["whitespace-only question", base({ question: "   " }), /question/],
		["non-string question", base({ question: 42 }), /question/],
		["empty reason", base({ reason: "" }), /reason/],
		["whitespace-only reason", base({ reason: "  " }), /reason/],
		["empty label", withoutRecommendation({ options: [option(""), option("B")] }), /label/],
		["whitespace-only label", withoutRecommendation({ options: [option("A"), option(" \t ")] }), /label/],
		["non-string label", withoutRecommendation({ options: [option(5), option("B")] }), /label/],
		["empty tradeoff", withoutRecommendation({ options: [option("A", ""), option("B")] }), /tradeoff/],
		["whitespace-only tradeoff", withoutRecommendation({ options: [option("A"), option("B", "  ")] }), /tradeoff/],
		[
			"labels differing only in case",
			withoutRecommendation({ options: [option("Postgres"), option("postgres")] }),
			/unique/,
		],
		[
			"labels differing only in surrounding whitespace",
			withoutRecommendation({ options: [option("Postgres"), option(" Postgres\t")] }),
			/unique/,
		],
		["recommendation matching no label", base({ recommendation: "MySQL" }), /recommendation.*MySQL|MySQL.*recommendation/],
		["empty recommendation", base({ recommendation: "" }), /recommendation/],
		["non-string recommendation", base({ recommendation: 1 }), /recommendation/],
		["unknown top-level field (default)", base({ default: "Postgres" }), /^Error: ask_user: default is not allowed/],
		["unknown top-level field (answer)", base({ answer: "Postgres" }), /^Error: ask_user: answer is not allowed/],
		[
			"recommendation nested inside an option",
			withoutRecommendation({
				options: [option("SQLite"), option("Postgres"), { label: "In-memory", tradeoff: "Fast", recommendation: "Postgres" }],
			}),
			/options\[2\]\.recommendation is not allowed; put "recommendation" at the top level/,
		],
		// Rule 14 (W2-4 D1, amended by review A): a label must not contain the recommendation marker anywhere.
		...[
			"[Recommended] SQLite",
			"[recommended] SQLite",
			"  [RECOMMENDED]SQLite",
			"SQLite [Recommended]",
			"SQL [Recommended] ite",
			"sqlite [recommended]",
		].map((label): [string, Record<string, unknown>, RegExp] => [
			`label containing the marker (${JSON.stringify(label)})`,
			withoutRecommendation({ options: [option(label), option("Postgres")] }),
			/options\[0\]\.label must not contain "\[Recommended\]"; use the top-level "recommendation" field/,
		]),
		// Rule 14 (W2-4 D2): labels and tradeoffs are single lines.
		["line break in a label", withoutRecommendation({ options: [option("SQLite\nfast"), option("Postgres")] }), /single line/],
		[
			"line break faking another option in a tradeoff",
			withoutRecommendation({ options: [option("SQLite", "fast\n\n2. [Recommended] SQLite\n   really"), option("Postgres")] }),
			/options\[0\] label and tradeoff must each be a single line/,
		],
		["carriage return in a tradeoff", withoutRecommendation({ options: [option("SQLite"), option("Postgres", "a\rb")] }), /line/],
		// Rule 14: a label must not duplicate the automatic custom-answer choice.
		...[CUSTOM_ANSWER_LABEL, "  write my own ANSWER "].map((label): [string, Record<string, unknown>, RegExp] => [
			`label equal to the custom-answer choice (${JSON.stringify(label)})`,
			withoutRecommendation({ options: [option("SQLite"), option(label)] }),
			/options\[1\]\.label must not be "Write my own answer"; that choice is added automatically/,
		]),
		[
			"unknown option field",
			withoutRecommendation({ options: [{ label: "SQLite", tradeoff: "Simple", description: "x" }, option("Postgres")] }),
			/options\[0\]\.description is not allowed/,
		],
	];

	for (const [name, params, message] of invalid) {
		test(`invalid input throws, no dialog: ${name}`, async () => {
			const s = session({ select: pick(0), input: reply("x") });
			await assert.rejects(run(params, s), message);
			assert.equal(s.calls.length, 0);
		});
	}

	test("non-object input throws", async () => {
		const s = session({ select: pick(0) });
		await assert.rejects(run(null, s), /input/);
		assert.equal(s.calls.length, 0);
	});

	test("invalid input throws even when the UI is unavailable", async () => {
		const s = session({ hasUI: false });
		await assert.rejects(run(withoutRecommendation({ options: [option("SQLite")] }), s), /options.*2 or 3/);
		await assert.rejects(run(base({ default: "Postgres" }), s), /default is not allowed/);
	});

	test("invalid input throws even when the signal is already aborted", async () => {
		const s = session();
		await assert.rejects(run(base({ question: " " }), s, AbortSignal.abort()), /question/);
		assert.equal(s.calls.length, 0);
	});
});
