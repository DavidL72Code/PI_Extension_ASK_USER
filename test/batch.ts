// Batch report: runs every ask_user scenario in the table below through the
// real registered tool (fake pi + fake dialogs from ./helpers.ts; no Pi process,
// no model) and writes test/batch-test/results.json.
//
// Run: npm run test:batch   (exits 1 if any scenario fails)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
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
	withoutRecommendation,
	type Responder,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Scenario types
// ---------------------------------------------------------------------------

type Category = "answered" | "cancelled" | "unavailable" | "invalid" | "unexpected" | "display";
type Method = "select" | "input";

/** What the simulated human (or client) does. Choice numbers are the 1-based numbers shown in the menu. */
type UserAction =
	| { kind: "pick"; choice: number }
	| { kind: "type"; text: string }
	| { kind: "escMenu" }
	| { kind: "escTextBox" }
	| { kind: "abortBefore" }
	| { kind: "abortInMenu" }
	| { kind: "abortInTextBox" }
	| { kind: "menuReturns"; value: string }
	| { kind: "noUI" }
	| { kind: "none" };

interface Expected {
	status?: "answered" | "cancelled" | "unavailable";
	details?: Record<string, unknown>;
	firstLine?: string;
	/** Substring of the thrown error message. */
	error?: string;
	/** Methods of the dialogs that must open, in order. */
	dialogs: Method[];
	/** Exact select dialog arguments, when the scenario checks the layout. */
	select?: { title: string; choices: string[] };
	/** Exact input dialog arguments, when the scenario checks them. */
	input?: { title: string; placeholder: string };
}

interface Scenario {
	name: string;
	category: Category;
	input: unknown;
	user: UserAction;
	expected: Expected;
}

// ---------------------------------------------------------------------------
// Expectation builders (fixed key order keeps the JSON stable)
// ---------------------------------------------------------------------------

const CUSTOM = "Write my own answer";

function answered(
	answer: string,
	source: "option" | "custom",
	rec?: { recommendation: string; followed: boolean },
	question = QUESTION,
): Expected {
	const details: Record<string, unknown> = { status: "answered", question, answer, source };
	if (rec) {
		details.recommendation = rec.recommendation;
		details.followedRecommendation = rec.followed;
	}
	return {
		status: "answered",
		details,
		firstLine: "ask_user: answered",
		dialogs: source === "custom" ? ["select", "input"] : ["select"],
	};
}

function cancelled(cancelReason: "dismissed" | "empty_answer" | "aborted", dialogs: Method[], question = QUESTION): Expected {
	return {
		status: "cancelled",
		details: { status: "cancelled", question, cancelReason },
		firstLine: `ask_user: cancelled (${cancelReason})`,
		dialogs,
	};
}

const unavailable = (): Expected => ({
	status: "unavailable",
	details: { status: "unavailable", question: QUESTION },
	firstLine: "ask_user: unavailable",
	dialogs: [],
});

const throws = (error: string, dialogs: Method[] = []): Expected => ({ error, dialogs });

const option = (label: string, tradeoff = "Some tradeoff") => ({ label, tradeoff });
const BASE_TITLE = [
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

const EXAMPLE = {
	question: "Should the reminder remember previous notifications after Pi restarts?",
	reason: "Persistence changes what you see after a restart and is costly to redo.",
	options: [
		{ label: "Session only", tradeoff: "Simpler; forgets everything when Pi restarts." },
		{ label: "Persist to disk", tradeoff: "Survives restarts; needs a state file and cleanup." },
	],
	recommendation: "Persist to disk",
};

// ---------------------------------------------------------------------------
// Scenario table
// ---------------------------------------------------------------------------

const REC_POSTGRES = { recommendation: "Postgres" };

const scenarios: Scenario[] = [
	// answered
	{
		name: "picks the recommended option",
		category: "answered",
		input: base(),
		user: { kind: "pick", choice: 2 },
		expected: answered("Postgres", "option", { ...REC_POSTGRES, followed: true }),
	},
	{
		name: "picks against the recommendation",
		category: "answered",
		input: base(),
		user: { kind: "pick", choice: 1 },
		expected: answered("SQLite", "option", { ...REC_POSTGRES, followed: false }),
	},
	{
		name: "no recommendation: recommendation keys omitted",
		category: "answered",
		input: withoutRecommendation(),
		user: { kind: "pick", choice: 3 },
		expected: answered("In-memory", "option"),
	},
	{
		name: "two options: second option",
		category: "answered",
		input: withoutRecommendation({ options: [option("SQLite"), option("Postgres")] }),
		user: { kind: "pick", choice: 2 },
		expected: answered("Postgres", "option"),
	},
	{
		name: "recommendation in another case is stored as the canonical label",
		category: "answered",
		input: base({ recommendation: "  postgres " }),
		user: { kind: "pick", choice: 2 },
		expected: answered("Postgres", "option", { ...REC_POSTGRES, followed: true }),
	},
	{
		name: "custom answer",
		category: "answered",
		input: base(),
		user: { kind: "type", text: "Use Redis" },
		expected: answered("Use Redis", "custom", { ...REC_POSTGRES, followed: false }),
	},
	{
		name: "custom answer keeps outer and inner spaces exactly",
		category: "answered",
		input: withoutRecommendation(),
		user: { kind: "type", text: "  keep   both  " },
		expected: answered("  keep   both  ", "custom"),
	},
	{
		name: "custom answer keeps unicode exactly (no normalization)",
		category: "answered",
		input: withoutRecommendation(),
		user: { kind: "type", text: "naïve café 日本語 🚀 é" },
		expected: answered("naïve café 日本語 🚀 é", "custom"),
	},
	{
		name: "custom text equal to the recommended label stays custom",
		category: "answered",
		input: base(),
		user: { kind: "type", text: "Postgres" },
		expected: answered("Postgres", "custom", { ...REC_POSTGRES, followed: false }),
	},

	// cancelled
	{
		name: "dismisses the menu",
		category: "cancelled",
		input: base(),
		user: { kind: "escMenu" },
		expected: cancelled("dismissed", ["select"]),
	},
	{
		name: "dismisses the text box",
		category: "cancelled",
		input: base(),
		user: { kind: "escTextBox" },
		expected: cancelled("dismissed", ["select", "input"]),
	},
	{
		name: "empty custom answer",
		category: "cancelled",
		input: base(),
		user: { kind: "type", text: "" },
		expected: cancelled("empty_answer", ["select", "input"]),
	},
	{
		name: "whitespace-only custom answer",
		category: "cancelled",
		input: base(),
		user: { kind: "type", text: "  \t\n " },
		expected: cancelled("empty_answer", ["select", "input"]),
	},
	{
		name: "ideographic-space custom answer",
		category: "cancelled",
		input: base(),
		user: { kind: "type", text: " 　" },
		expected: cancelled("empty_answer", ["select", "input"]),
	},
	{
		name: "run aborted before the tool starts: no dialog",
		category: "cancelled",
		input: base(),
		user: { kind: "abortBefore" },
		expected: cancelled("aborted", []),
	},
	{
		name: "run aborted while the menu is open",
		category: "cancelled",
		input: base(),
		user: { kind: "abortInMenu" },
		expected: cancelled("aborted", ["select"]),
	},
	{
		name: "run aborted while the text box is open",
		category: "cancelled",
		input: base(),
		user: { kind: "abortInTextBox" },
		expected: cancelled("aborted", ["select", "input"]),
	},

	// unavailable
	{
		name: "no UI: zero dialogs, recommendation never returned",
		category: "unavailable",
		input: base(),
		user: { kind: "noUI" },
		expected: unavailable(),
	},

	// invalid input: throws, no dialog
	{
		name: "1 option",
		category: "invalid",
		input: withoutRecommendation({ options: [option("SQLite")] }),
		user: { kind: "none" },
		expected: throws("options must be an array of 2 or 3 items (got 1 items)"),
	},
	{
		name: "4 options",
		category: "invalid",
		input: withoutRecommendation({ options: [option("A"), option("B"), option("C"), option("D")] }),
		user: { kind: "none" },
		expected: throws("options must be an array of 2 or 3 items (got 4 items)"),
	},
	{
		name: "duplicate labels differing only in case",
		category: "invalid",
		input: withoutRecommendation({ options: [option("Postgres"), option("postgres")] }),
		user: { kind: "none" },
		expected: throws("option labels must be unique"),
	},
	{
		name: "duplicate labels differing only in surrounding whitespace",
		category: "invalid",
		input: withoutRecommendation({ options: [option("Postgres"), option(" Postgres\t")] }),
		user: { kind: "none" },
		expected: throws("option labels must be unique"),
	},
	{
		name: "recommendation matching no label",
		category: "invalid",
		input: base({ recommendation: "MySQL" }),
		user: { kind: "none" },
		expected: throws('recommendation "MySQL" does not match any option label'),
	},
	{
		name: "empty recommendation",
		category: "invalid",
		input: base({ recommendation: "" }),
		user: { kind: "none" },
		expected: throws('recommendation "" does not match any option label'),
	},
	{
		name: "whitespace-only question",
		category: "invalid",
		input: base({ question: "   " }),
		user: { kind: "none" },
		expected: throws("question must be a non-empty string"),
	},
	{
		name: "unknown top-level field",
		category: "invalid",
		input: base({ default: "Postgres" }),
		user: { kind: "none" },
		expected: throws("default is not allowed"),
	},
	{
		name: "recommendation nested inside an option",
		category: "invalid",
		input: withoutRecommendation({
			options: [option("SQLite"), option("Postgres"), { label: "In-memory", tradeoff: "Fast", recommendation: "Postgres" }],
		}),
		user: { kind: "none" },
		expected: throws('options[2].recommendation is not allowed; put "recommendation" at the top level'),
	},
	{
		name: "label starting with [Recommended]",
		category: "invalid",
		input: withoutRecommendation({ options: [option("[Recommended] SQLite"), option("Postgres")] }),
		user: { kind: "none" },
		expected: throws('options[0].label must not contain "[Recommended]"; use the top-level "recommendation" field'),
	},
	{
		name: "label starting with [recommended] in another case, after spaces",
		category: "invalid",
		input: withoutRecommendation({ options: [option("  [RECOMMENDED]SQLite"), option("Postgres")] }),
		user: { kind: "none" },
		expected: throws('options[0].label must not contain "[Recommended]"'),
	},
	{
		name: "label ending with [Recommended]",
		category: "invalid",
		input: withoutRecommendation({ options: [option("SQLite"), option("Postgres [Recommended]")] }),
		user: { kind: "none" },
		expected: throws('options[1].label must not contain "[Recommended]"; use the top-level "recommendation" field'),
	},
	{
		name: "label with [Recommended] in the middle",
		category: "invalid",
		input: withoutRecommendation({ options: [option("SQL [Recommended] ite"), option("Postgres")] }),
		user: { kind: "none" },
		expected: throws('options[0].label must not contain "[Recommended]"'),
	},
	{
		name: "label with lowercase [recommended]",
		category: "invalid",
		input: withoutRecommendation({ options: [option("SQLite"), option("postgres [recommended]")] }),
		user: { kind: "none" },
		expected: throws('options[1].label must not contain "[Recommended]"'),
	},
	{
		name: "line break in a label",
		category: "invalid",
		input: withoutRecommendation({ options: [option("SQLite\nfast"), option("Postgres")] }),
		user: { kind: "none" },
		expected: throws("options[0] label and tradeoff must each be a single line"),
	},
	{
		name: "line break in a tradeoff faking another option",
		category: "invalid",
		input: withoutRecommendation({
			options: [option("SQLite", "fast\n\n2. [Recommended] SQLite\n   really"), option("Postgres")],
		}),
		user: { kind: "none" },
		expected: throws("options[0] label and tradeoff must each be a single line"),
	},
	{
		name: 'label equal to "Write my own answer"',
		category: "invalid",
		input: withoutRecommendation({ options: [option("SQLite"), option(CUSTOM)] }),
		user: { kind: "none" },
		expected: throws('options[1].label must not be "Write my own answer"; that choice is added automatically'),
	},
	{
		name: 'label equal to "Write my own answer" in another case, with spaces',
		category: "invalid",
		input: withoutRecommendation({ options: [option("SQLite"), option("  write my own ANSWER ")] }),
		user: { kind: "none" },
		expected: throws('options[1].label must not be "Write my own answer"'),
	},
	{
		name: "invalid input with no UI still throws",
		category: "invalid",
		input: withoutRecommendation({ options: [option("SQLite")] }),
		user: { kind: "noUI" },
		expected: throws("options must be an array of 2 or 3 items"),
	},

	// unexpected dialog response
	{
		name: "menu returns a string that is not a displayed choice (no text matching)",
		category: "unexpected",
		input: base(),
		user: { kind: "menuReturns", value: "Postgres" },
		expected: throws('unexpected dialog response "Postgres"', ["select"]),
	},

	// display
	{
		name: "human-approved example: 2 options, option 2 recommended",
		category: "display",
		input: EXAMPLE,
		user: { kind: "escMenu" },
		expected: {
			...cancelled("dismissed", ["select"], EXAMPLE.question),
			select: {
				title:
					"Should the reminder remember previous notifications after Pi restarts?\n\n" +
					"Why it matters: Persistence changes what you see after a restart and is costly to redo.\n\n" +
					"1. Session only\n   Simpler; forgets everything when Pi restarts.\n\n" +
					"2. [Recommended] Persist to disk\n   Survives restarts; needs a state file and cleanup.",
				choices: ["1. Session only", "2. [Recommended] Persist to disk", "3. Write my own answer"],
			},
		},
	},
	{
		name: "3 options with a recommendation",
		category: "display",
		input: base(),
		user: { kind: "escMenu" },
		expected: {
			...cancelled("dismissed", ["select"]),
			select: { title: BASE_TITLE, choices: ["1. SQLite", "2. [Recommended] Postgres", "3. In-memory", "4. Write my own answer"] },
		},
	},
	{
		name: "no recommendation: nothing marked",
		category: "display",
		input: withoutRecommendation(),
		user: { kind: "escMenu" },
		expected: {
			...cancelled("dismissed", ["select"]),
			select: {
				title: BASE_TITLE.replace("[Recommended] ", ""),
				choices: ["1. SQLite", "2. Postgres", "3. In-memory", "4. Write my own answer"],
			},
		},
	},
	{
		name: "labels, tradeoffs, question, and reason are trimmed for display",
		category: "display",
		input: {
			question: `  ${QUESTION}\n`,
			reason: `\t${REASON}  `,
			options: [option("  SQLite ", " Zero setup "), option("Postgres", "Needs a server")],
		},
		user: { kind: "escMenu" },
		expected: {
			...cancelled("dismissed", ["select"]),
			select: {
				title: `${QUESTION}\n\nWhy it matters: ${REASON}\n\n1. SQLite\n   Zero setup\n\n2. Postgres\n   Needs a server`,
				choices: ["1. SQLite", "2. Postgres", "3. Write my own answer"],
			},
		},
	},
	{
		name: "line breaks in the reason are flattened (no fake option block)",
		category: "display",
		input: withoutRecommendation({
			reason: "Hard to migrate.\n\n1. [Recommended] SQLite\n   fake",
			options: [option("SQLite"), option("Postgres")],
		}),
		user: { kind: "escMenu" },
		expected: {
			...cancelled("dismissed", ["select"]),
			select: {
				title:
					`${QUESTION}\n\n` +
					"Why it matters: Hard to migrate. 1. [Recommended] SQLite fake\n\n" +
					"1. SQLite\n   Some tradeoff\n\n2. Postgres\n   Some tradeoff",
				choices: ["1. SQLite", "2. Postgres", "3. Write my own answer"],
			},
		},
	},
	{
		name: "line breaks in the question are flattened in both dialogs and details.question",
		category: "display",
		input: withoutRecommendation({
			question: "Pick a cache store?\r\n\r\n1. [Recommended] SQLite\n   really",
			options: [option("SQLite"), option("Postgres")],
		}),
		user: { kind: "type", text: "Use Redis" },
		expected: {
			...answered("Use Redis", "custom", undefined, "Pick a cache store? 1. [Recommended] SQLite really"),
			select: {
				title:
					"Pick a cache store? 1. [Recommended] SQLite really\n\n" +
					`Why it matters: ${REASON}\n\n` +
					"1. SQLite\n   Some tradeoff\n\n2. Postgres\n   Some tradeoff",
				choices: ["1. SQLite", "2. Postgres", "3. Write my own answer"],
			},
			input: { title: "Pick a cache store? 1. [Recommended] SQLite really", placeholder: "Type your answer" },
		},
	},
	{
		name: "text box: title is the question, placeholder invites free text",
		category: "display",
		input: base(),
		user: { kind: "type", text: "Use Redis" },
		expected: {
			...answered("Use Redis", "custom", { ...REC_POSTGRES, followed: false }),
			input: { title: QUESTION, placeholder: "Type your answer" },
		},
	},
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function describeAction(action: UserAction): string {
	switch (action.kind) {
		case "pick":
			return `picks choice ${action.choice}`;
		case "type":
			return `picks "${CUSTOM}", types ${JSON.stringify(action.text)}`;
		case "escMenu":
			return "presses Esc on the menu";
		case "escTextBox":
			return `picks "${CUSTOM}", presses Esc in the text box`;
		case "abortBefore":
			return "run is aborted before the tool starts";
		case "abortInMenu":
			return "run is aborted while the menu is open";
		case "abortInTextBox":
			return `picks "${CUSTOM}"; run is aborted while the text box is open`;
		case "menuReturns":
			return `client returns ${JSON.stringify(action.value)} from the menu (not a displayed choice)`;
		case "noUI":
			return "no UI (print or JSON mode)";
		case "none":
			return "nothing (invalid input; no dialog should open)";
	}
}

async function runScenario(scenario: Scenario) {
	const controller = new AbortController();
	let hasUI = true;
	// By default a dialog that opens by mistake would answer, so a wrong "answered" can't hide.
	let select: Responder = pick(0);
	let input: Responder = reply("unexpected text");
	const action = scenario.user;
	switch (action.kind) {
		case "pick":
			select = pick(action.choice - 1);
			break;
		case "type":
			select = pickCustom;
			input = reply(action.text);
			break;
		case "escMenu":
			select = reply(undefined);
			break;
		case "escTextBox":
			select = pickCustom;
			input = reply(undefined);
			break;
		case "abortBefore":
			controller.abort();
			break;
		case "abortInMenu":
			select = abortWhileOpen(controller);
			break;
		case "abortInTextBox":
			select = pickCustom;
			input = abortWhileOpen(controller);
			break;
		case "menuReturns":
			select = reply(action.value);
			break;
		case "noUI":
			hasUI = false;
			break;
		case "none":
			break;
	}

	const fake = session({ hasUI, select, input });
	let actual: Record<string, unknown>;
	try {
		const result = await run(scenario.input, fake, controller.signal);
		actual = { status: result.details.status, details: result.details, firstLine: contentText(result).split("\n")[0] };
	} catch (error) {
		actual = { error: error instanceof Error ? error.message : String(error) };
	}

	const dialogCalls = fake.calls.map((call) =>
		call.method === "select"
			? { method: call.method, title: call.title, choices: call.choices }
			: { method: call.method, title: call.title, placeholder: call.placeholder },
	);

	const mismatches = compare(scenario.expected, actual, dialogCalls);
	return {
		name: scenario.name,
		category: scenario.category,
		input: scenario.input,
		userAction: describeAction(action),
		dialogCalls,
		expected: scenario.expected,
		actual,
		pass: mismatches.length === 0,
		mismatches,
	};
}

function compare(expected: Expected, actual: Record<string, unknown>, dialogCalls: Record<string, unknown>[]): string[] {
	const problems: string[] = [];
	const methods = dialogCalls.map((call) => call.method);
	if (!isDeepStrictEqual(methods, expected.dialogs)) {
		problems.push(`dialogs: expected ${JSON.stringify(expected.dialogs)}, got ${JSON.stringify(methods)}`);
	}
	if (expected.error !== undefined) {
		if (typeof actual.error !== "string" || !actual.error.includes(expected.error)) {
			problems.push(`expected an error containing ${JSON.stringify(expected.error)}, got ${JSON.stringify(actual)}`);
		}
	} else if ("error" in actual) {
		problems.push(`unexpected error: ${actual.error}`);
	} else {
		if (expected.status !== undefined && actual.status !== expected.status) {
			problems.push(`status: expected ${expected.status}, got ${String(actual.status)}`);
		}
		if (expected.details !== undefined && !isDeepStrictEqual(actual.details, expected.details)) {
			problems.push(`details: expected ${JSON.stringify(expected.details)}, got ${JSON.stringify(actual.details)}`);
		}
		if (expected.firstLine !== undefined && actual.firstLine !== expected.firstLine) {
			problems.push(`first content line: expected ${JSON.stringify(expected.firstLine)}, got ${JSON.stringify(actual.firstLine)}`);
		}
	}
	for (const method of ["select", "input"] as const) {
		const want = expected[method];
		if (want === undefined) continue;
		const call = dialogCalls.find((c) => c.method === method);
		const got = call && Object.fromEntries(Object.keys(want).map((key) => [key, call[key]]));
		if (!isDeepStrictEqual(got, want)) problems.push(`${method} dialog: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
	}
	return problems;
}

const results = [];
for (const scenario of scenarios) results.push(await runScenario(scenario));

const passed = results.filter((r) => r.pass).length;
const piPackage = JSON.parse(
	readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"),
);
const report = {
	generatedAt: new Date().toISOString(),
	node: process.version,
	piCodingAgent: piPackage.version,
	harness: "real registered ask_user tool, fake pi and fake dialogs (no Pi process, no model)",
	totals: { scenarios: results.length, passed, failed: results.length - passed },
	scenarios: results,
};

const outDir = new URL("./batch-test/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const outFile = new URL("results.json", outDir);
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

const width = Math.max(...results.map((r) => r.category.length));
for (const r of results) {
	console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.category.padEnd(width)}  ${r.name}`);
	for (const problem of r.mismatches) console.log(`      - ${problem}`);
}
console.log(`\n${passed}/${results.length} scenarios passed, ${results.length - passed} failed`);
console.log(`Wrote ${outFile.pathname}`);
process.exitCode = passed === results.length ? 0 : 1;
