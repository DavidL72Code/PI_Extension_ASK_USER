// Batch report: runs every ask_user scenario in the table below through the
// real registered tool (fake pi + fake dialogs from ./helpers.ts; no Pi process,
// no model) and writes test/fake-test/batch-test/results.json.
//
// Prints one block per scenario: the question, the choices shown, what the
// simulated user did, and what came back (./batch-format.ts). --compact prints
// one line per scenario instead.
//
// Run: npm run test:batch [-- --compact]   (exits 1 if any scenario fails, 2 on bad arguments)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { createAskUserTool } from "../../src/index.ts";
import { formatReport, type EarlierView, type FollowUp, type ScenarioView, type UserAction } from "./batch-format.ts";
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
	type Session,
} from "./helpers.ts";

const USAGE = "usage: npm run test:batch -- [--compact]";
const args = process.argv.slice(2);
for (const arg of args) {
	if (arg !== "--compact") {
		console.error(`unknown argument ${JSON.stringify(arg)} (${USAGE})`);
		process.exit(2);
	}
}
const compact = args.includes("--compact");

// ---------------------------------------------------------------------------
// Scenario types
// ---------------------------------------------------------------------------

type Category = "answered" | "cancelled" | "unavailable" | "invalid" | "unexpected" | "display" | "repeat" | "scope";
/** "scope" is the rule 16 follow-up select after a new answer. */
type Method = "select" | "input" | "scope";
// FollowUp (how the simulated human answers the follow-up) and UserAction (what
// the simulated human or client does) live in ./batch-format.ts, which describes them.

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
	/** Exact rule 16 follow-up dialog arguments. */
	scope?: { title: string; choices: string[] };
}

interface Scenario {
	name: string;
	category: Category;
	input: unknown;
	/**
	 * Repeats: a first ask_user call made through the same tool before this one, either as a
	 * sibling in the same assistant message or in an earlier turn.
	 */
	history?: {
		prior: { input: unknown; user: UserAction; followUp?: FollowUp; save: boolean; sameMessage: boolean };
	};
	user: UserAction;
	/** The rule 16 follow-up, when the scenario reaches it (default "once"). */
	followUp?: FollowUp;
	expected: Expected;
}

// ---------------------------------------------------------------------------
// Expectation builders (fixed key order keeps the JSON stable)
// ---------------------------------------------------------------------------

const CUSTOM = "Write my own answer";

const SCOPE_CHOICES = ["1. Just this time", "2. Also for similar questions this session"];

function answered(
	answer: string,
	source: "option" | "custom",
	rec?: { recommendation: string; followed: boolean },
	question = QUESTION,
	scope: "once" | "similar" = "once",
): Expected {
	const details: Record<string, unknown> = { status: "answered", question, answer, source };
	if (rec) {
		details.recommendation = rec.recommendation;
		details.followedRecommendation = rec.followed;
	}
	details.scope = scope;
	return {
		status: "answered",
		details,
		firstLine: "ask_user: answered",
		dialogs: source === "custom" ? ["select", "input", "scope"] : ["select", "scope"],
		scope: { title: `Apply "${answer}" to similar questions this session?`, choices: SCOPE_CHOICES },
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

	// repeat: across turns the dialog always opens; identical siblings in one response share it
	{
		name: "an identical call in a later turn opens the dialog again",
		category: "repeat",
		input: base(),
		history: { prior: { input: base(), user: { kind: "pick", choice: 1 }, save: true, sameMessage: false } },
		user: { kind: "pick", choice: 2 },
		expected: answered("Postgres", "option", { ...REC_POSTGRES, followed: true }),
	},
	{
		name: "an identical call after a dismissal in a later turn opens the dialog again",
		category: "repeat",
		input: base(),
		history: { prior: { input: base(), user: { kind: "escMenu" }, save: true, sameMessage: false } },
		user: { kind: "pick", choice: 1 },
		expected: answered("SQLite", "option", { ...REC_POSTGRES, followed: false }),
	},
	{
		name: 'same question text for a different decision in a later turn asks (R-B: "Should I go ahead?")',
		category: "repeat",
		input: { question: "Should I go ahead?", reason: "Overwrites your existing config.json with defaults.", options: [option("Yes", "Clean config"), option("No", "Keep your edits")] },
		history: {
			prior: {
				input: { question: "Should I go ahead?", reason: "Deletes logs older than 30 days.", options: [option("Yes", "Frees disk"), option("No", "Keeps logs")] },
				user: { kind: "pick", choice: 1 },
				save: true,
				sameMessage: false,
			},
		},
		user: { kind: "pick", choice: 2 },
		expected: {
			status: "answered",
			details: { status: "answered", question: "Should I go ahead?", answer: "No", source: "option", scope: "once" },
			firstLine: "ask_user: answered",
			dialogs: ["select", "scope"],
			scope: { title: 'Apply "No" to similar questions this session?', choices: SCOPE_CHOICES },
		},
	},
	{
		name: "identical siblings in one response: one dialog, the second gets the first's answer (not saved yet)",
		category: "repeat",
		input: base(),
		history: { prior: { input: base(), user: { kind: "pick", choice: 3 }, save: false, sameMessage: true } },
		user: { kind: "pick", choice: 1 },
		expected: {
			status: "answered",
			details: { status: "answered", question: QUESTION, answer: "In-memory", source: "option", recommendation: "Postgres", followedRecommendation: false, scope: "once", repeated: true },
			firstLine: "ask_user: answered",
			dialogs: [],
		},
	},
	{
		name: "identical siblings with case/whitespace differences: still one dialog (first result saved, as in Pi)",
		category: "repeat",
		input: base({ question: "  which DATABASE\tshould  the cache use  " }),
		history: { prior: { input: base(), user: { kind: "type", text: "Use Redis" }, save: true, sameMessage: true } },
		user: { kind: "pick", choice: 1 },
		expected: {
			status: "answered",
			details: { status: "answered", question: "which DATABASE\tshould  the cache use", answer: "Use Redis", source: "custom", recommendation: "Postgres", followedRecommendation: false, scope: "once", repeated: true },
			firstLine: "ask_user: answered",
			dialogs: [],
		},
	},
	{
		name: "identical sibling after a dismissal: cancelled (dismissed), repeated, no dialog",
		category: "repeat",
		input: base(),
		history: { prior: { input: base(), user: { kind: "escMenu" }, save: true, sameMessage: true } },
		user: { kind: "pick", choice: 1 },
		expected: { ...cancelled("dismissed", []), details: { status: "cancelled", question: QUESTION, cancelReason: "dismissed", repeated: true } },
	},
	{
		name: "identical sibling with only a different recommendation and label order/case: still one dialog",
		category: "repeat",
		input: withoutRecommendation({ options: [option("in-memory", "Fast"), option("  POSTGRES ", "Server"), option("sqlite", "File")] }),
		history: { prior: { input: base(), user: { kind: "pick", choice: 1 }, save: true, sameMessage: true } },
		user: { kind: "pick", choice: 2 },
		expected: {
			status: "answered",
			details: { status: "answered", question: QUESTION, answer: "SQLite", source: "option", recommendation: "Postgres", followedRecommendation: false, scope: "once", repeated: true },
			firstLine: "ask_user: answered",
			dialogs: [],
		},
	},
	{
		name: "different siblings in one response both ask: another question",
		category: "repeat",
		input: base({ question: "Which database should the queue use?" }),
		history: { prior: { input: base(), user: { kind: "pick", choice: 1 }, save: true, sameMessage: true } },
		user: { kind: "pick", choice: 3 },
		expected: answered("In-memory", "option", { ...REC_POSTGRES, followed: false }, "Which database should the queue use?"),
	},
	{
		name: "different siblings in one response both ask: same question, another reason",
		category: "repeat",
		input: base({ reason: "Only affects local tests." }),
		history: { prior: { input: base(), user: { kind: "pick", choice: 1 }, save: false, sameMessage: true } },
		user: { kind: "pick", choice: 2 },
		expected: {
			...answered("Postgres", "option", { ...REC_POSTGRES, followed: true }),
			select: {
				title: [QUESTION, "", "Why it matters: Only affects local tests.", "", ...BASE_TITLE.split("\n").slice(4)].join("\n"),
				choices: ["1. SQLite", "2. [Recommended] Postgres", "3. In-memory", "4. Write my own answer"],
			},
		},
	},
	{
		name: "different siblings in one response both ask: same question and reason, other options",
		category: "repeat",
		input: withoutRecommendation({ options: [option("MySQL"), option("MongoDB")] }),
		history: { prior: { input: base(), user: { kind: "pick", choice: 2 }, save: true, sameMessage: true } },
		user: { kind: "pick", choice: 1 },
		expected: answered("MySQL", "option"),
	},
	{
		name: "a sibling aborted before it asked doesn't count: the identical call asks",
		category: "repeat",
		input: base(),
		history: { prior: { input: base(), user: { kind: "abortBefore" }, save: true, sameMessage: true } },
		user: { kind: "pick", choice: 2 },
		expected: answered("Postgres", "option", { ...REC_POSTGRES, followed: true }),
	},

	// scope (rule 16): the follow-up after a new answer
	{
		name: 'option, then "Also for similar questions this session" → scope similar',
		category: "scope",
		input: base(),
		user: { kind: "pick", choice: 1 },
		followUp: "similar",
		expected: answered("SQLite", "option", { ...REC_POSTGRES, followed: false }, QUESTION, "similar"),
	},
	{
		name: 'custom answer, then "Also for similar" → scope similar, answer exact',
		category: "scope",
		input: withoutRecommendation(),
		user: { kind: "type", text: "  Use Redis  " },
		followUp: "similar",
		expected: answered("  Use Redis  ", "custom", undefined, QUESTION, "similar"),
	},
	{
		name: "a long custom answer is shortened to 60 characters + … in the follow-up title only",
		category: "scope",
		input: withoutRecommendation(),
		user: { kind: "type", text: "Keep reminders in a JSON file under ~/.pi and never sync them to the cloud, ever" },
		expected: {
			...answered("Keep reminders in a JSON file under ~/.pi and never sync them to the cloud, ever", "custom"),
			// 60 characters, then …
			scope: { title: 'Apply "Keep reminders in a JSON file under ~/.pi and never sync the…" to similar questions this session?', choices: SCOPE_CHOICES },
		},
	},
	{
		name: "Esc on the follow-up → scope once; the answer stands",
		category: "scope",
		input: base(),
		user: { kind: "pick", choice: 2 },
		followUp: "esc",
		expected: answered("Postgres", "option", { ...REC_POSTGRES, followed: true }),
	},
	{
		name: "an unexpected value on the follow-up → scope once; the answer stands",
		category: "scope",
		input: base(),
		user: { kind: "pick", choice: 3 },
		followUp: "unexpected",
		expected: answered("In-memory", "option", { ...REC_POSTGRES, followed: false }),
	},
	{
		name: "an abort while the follow-up is open → scope once; the answer stands (not cancelled)",
		category: "scope",
		input: base(),
		user: { kind: "pick", choice: 1 },
		followUp: "abort",
		expected: answered("SQLite", "option", { ...REC_POSTGRES, followed: false }),
	},
	{
		name: 'an identical sibling of a "similar" answer carries scope similar, with no dialogs',
		category: "scope",
		input: base(),
		history: { prior: { input: base(), user: { kind: "pick", choice: 1 }, followUp: "similar", save: true, sameMessage: true } },
		user: { kind: "pick", choice: 2 },
		expected: {
			status: "answered",
			details: { status: "answered", question: QUESTION, answer: "SQLite", source: "option", recommendation: "Postgres", followedRecommendation: false, scope: "similar", repeated: true },
			firstLine: "ask_user: answered",
			dialogs: [],
		},
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

/** Fake dialog behavior for a simulated user action. */
const FOLLOW_UP: Record<FollowUp, (controller: AbortController) => Responder> = {
	once: () => (call) => call.choices![0],
	similar: () => (call) => call.choices![1],
	esc: () => reply(undefined),
	unexpected: () => reply("2. Also for similar"),
	abort: (controller) => abortWhileOpen(controller),
};
const FOLLOW_UP_TEXT: Record<FollowUp, string> = {
	once: 'Enter on "1. Just this time"',
	similar: 'picks "2. Also for similar questions this session"',
	esc: "presses Esc",
	unexpected: 'client returns "2. Also for similar" (not a choice)',
	abort: "run is aborted while it is open",
};

function responders(action: UserAction, controller: AbortController, followUp: FollowUp = "once") {
	const scope = FOLLOW_UP[followUp](controller);
	let hasUI = true;
	// By default a dialog that opens by mistake would answer, so a wrong "answered" can't hide.
	let select: Responder = pick(0);
	let input: Responder = reply("unexpected text");
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
	return { hasUI, select, input, scope };
}

type Entry = { type: "message"; id: string; parentId: string | null; message: Record<string, unknown> };

/** A fake session branch like Pi's: an assistant message carries its ask_user tool calls; results follow. */
function fakeBranch(prefix: string) {
	const entries: Entry[] = [];
	const add = (id: string, message: Record<string, unknown>) => {
		entries.push({ type: "message", id: `${prefix}-${id}`, parentId: entries.at(-1)?.id ?? null, message });
	};
	add("user", { role: "user" });
	return {
		manager: { getBranch: () => [...entries] },
		/** One assistant message with these tool calls. */
		message(id: string, calls: [string, unknown][]) {
			add(id, { role: "assistant", content: calls.map(([toolCallId, args]) => ({ type: "toolCall", id: toolCallId, name: "ask_user", arguments: args })) });
		},
		result(toolCallId: string, details: unknown) {
			add(`result-${toolCallId}`, { role: "toolResult", toolName: "ask_user", toolCallId, isError: false, content: [], details });
		},
		userTurn() {
			add("user-2", { role: "user" });
		},
	};
}

/** Every dialog in order, as recorded in results.json ("scope" is the follow-up). */
const shownDialogs = (log: Session["log"]) =>
	log.map((call) =>
		call.kind === "scope"
			? { method: "scope", title: call.title, choices: call.choices }
			: call.method === "select"
				? { method: call.method, title: call.title, choices: call.choices }
				: { method: call.method, title: call.title, placeholder: call.placeholder },
	);

const outcomeOf = (result: AgentToolResult<any>) => ({ status: result.details.status, details: result.details, firstLine: contentText(result).split("\n")[0] });

/** Runs one scenario: `record` goes to results.json, `view` to the console. */
async function runScenario(scenario: Scenario, index: number): Promise<{ record: Record<string, unknown>; view: ScenarioView }> {
	const controller = new AbortController();
	const action = scenario.user;
	const fake = session(responders(action, controller, scenario.followUp));

	// History scenarios use a fresh tool instance and a fake session branch.
	let execute = run;
	let earlier: EarlierView | undefined;
	if (scenario.history) {
		const tool = createAskUserTool();
		const branch = fakeBranch(`batch-${index}`);
		const withBranch = (s: typeof fake) => ((s.ctx as unknown as { sessionManager: unknown }).sessionManager = branch.manager);
		const { prior } = scenario.history;
		// Like Pi: all tool calls of one response are in its assistant message before any of them runs.
		branch.message("assistant-1", prior.sameMessage ? [["prior", prior.input], ["call", scenario.input]] : [["prior", prior.input]]);
		const priorController = new AbortController();
		const priorSession = session(responders(prior.user, priorController, prior.followUp));
		withBranch(priorSession);
		const priorResult = await tool.execute("prior", prior.input as never, priorController.signal, undefined, priorSession.ctx);
		if (prior.save) branch.result("prior", priorResult.details);
		earlier = {
			input: prior.input,
			user: prior.user,
			followUp: prior.followUp,
			dialogs: shownDialogs(priorSession.log),
			outcome: outcomeOf(priorResult),
			sameMessage: prior.sameMessage,
			saved: prior.save,
		};
		if (!prior.sameMessage) {
			branch.userTurn();
			branch.message("assistant-2", [["call", scenario.input]]);
		}
		withBranch(fake);
		execute = (params, s, signal) => tool.execute("call", params as never, signal, undefined, s.ctx);
	}

	let actual: Record<string, unknown>;
	try {
		actual = outcomeOf(await execute(scenario.input, fake, controller.signal));
	} catch (error) {
		actual = { error: error instanceof Error ? error.message : String(error) };
	}

	const dialogCalls = shownDialogs(fake.log);
	const mismatches = compare(scenario.expected, actual, dialogCalls);
	const pass = mismatches.length === 0;
	const record = {
		name: scenario.name,
		category: scenario.category,
		input: scenario.input,
		...(scenario.history ? { history: describeHistory(scenario.history) } : {}),
		userAction: describeAction(action) + (dialogCalls.some((c) => c.method === "scope") ? `; follow-up: ${FOLLOW_UP_TEXT[scenario.followUp ?? "once"]}` : ""),
		dialogCalls,
		expected: scenario.expected,
		actual,
		pass,
		mismatches,
	};
	const view: ScenarioView = {
		name: scenario.name,
		category: scenario.category,
		pass,
		mismatches,
		call: { input: scenario.input, user: action, followUp: scenario.followUp, dialogs: dialogCalls, outcome: actual },
		...(earlier ? { earlier } : {}),
	};
	return { record, view };
}

function describeHistory({ prior }: NonNullable<Scenario["history"]>) {
	return {
		priorCall: {
			input: prior.input,
			userAction: describeAction(prior.user) + (prior.followUp ? `; follow-up: ${FOLLOW_UP_TEXT[prior.followUp]}` : ""),
			where: prior.sameMessage ? "a sibling in the same assistant message" : "an earlier turn",
			saved: prior.save ? "its result was saved on the branch" : "its result is not saved yet",
		},
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
	for (const method of ["select", "input", "scope"] as const) {
		const want = expected[method];
		if (want === undefined) continue;
		const call = dialogCalls.find((c) => c.method === method);
		const got = call && Object.fromEntries(Object.keys(want).map((key) => [key, call[key]]));
		if (!isDeepStrictEqual(got, want)) problems.push(`${method} dialog: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
	}
	return problems;
}

const results: Record<string, unknown>[] = [];
const views: ScenarioView[] = [];
for (const [index, scenario] of scenarios.entries()) {
	const { record, view } = await runScenario(scenario, index);
	results.push(record);
	views.push(view);
}

const passed = views.filter((v) => v.pass).length;
const piPackage = JSON.parse(
	readFileSync(new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"),
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

for (const text of formatReport(views, compact)) console.log(text);
console.log(`\n${passed}/${results.length} scenarios passed, ${results.length - passed} failed`);
console.log(`Wrote ${outFile.pathname}`);
process.exitCode = passed === results.length ? 0 : 1;
