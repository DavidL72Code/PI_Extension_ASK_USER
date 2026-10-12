// Seeded, randomized self-test for ask_user (same idea as PiReminder's
// /bedtime-test run_test). Every round runs every scenario category with
// randomized inputs (and every invalid-input rule) and drives the real tool with
// an in-memory fake ctx: no Pi dialogs, no model calls.
//
// The oracle derives each expected result from the generated input and the
// chosen action alone (contract rules 2-14). It never calls validate(),
// buildChoices() or buildTitle(), so it can catch bugs instead of mirroring them.

import { isDeepStrictEqual } from "node:util";
import type { AskUserContext, AskUserResult } from "./ask-user.ts";

/** Runs one ask_user call through a tool instance (see executeTool in self-test-command.ts). */
export type Execute = (
	params: unknown,
	signal: AbortSignal | undefined,
	ctx: AskUserContext,
	toolCallId: string,
) => Promise<AskUserResult>;

export const CATEGORIES = [
	"pick option",
	"pick against recommendation",
	"no recommendation",
	"custom answer",
	"custom equals recommended label",
	"dismiss menu",
	"dismiss text box",
	"empty custom answer",
	"no UI",
	"abort",
	"invalid input",
	"unknown menu value",
	"line breaks flattened",
	"identical call in a later turn asks",
	"identical siblings: one dialog",
	"dismissed sibling repeats the cancel",
	"different siblings both ask",
	"aborted sibling doesn't count",
	"follow-up: also for similar",
	"follow-up: Esc or unexpected value",
	"follow-up: abort",
	"follow-up title shortens a long custom answer",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Every round runs each of these once under "invalid input" (shuffled, with random details). */
export const INVALID_RULES = [
	"option count",
	"duplicate labels",
	"bad recommendation",
	"unknown field",
	"nested field",
	"[Recommended] in a label",
	"line break",
	'label = "Write my own answer"',
	"blank text field",
] as const;
type InvalidRule = (typeof INVALID_RULES)[number];

/** Scenarios per round: one per category, except one per rule for "invalid input". */
export const SCENARIOS_PER_ROUND = CATEGORIES.length - 1 + INVALID_RULES.length;

/** "scope" is the rule 16 follow-up select ("Apply … to similar questions this session?"). */
type Method = "select" | "input" | "scope";

export interface Expected {
	status?: "answered" | "cancelled" | "unavailable";
	details?: Record<string, unknown>;
	firstLine?: string;
	/** Every string must appear in the thrown error message. */
	errorIncludes?: string[];
	/** Every string must appear in the model-facing text. */
	contentIncludes?: string[];
	dialogs: Method[];
	select?: { title: string; choices: string[] };
	inputTitle?: string;
	/** Exact rule 16 follow-up dialog. */
	scope?: { title: string; choices: string[] };
	/** Expected details of the prior call, for scenarios that make one first. */
	prior?: Record<string, unknown>;
}

export interface DialogRecord {
	method: Method;
	title: string;
	choices?: string[];
	placeholder?: string;
	timeoutPassed: boolean;
}

export interface Actual {
	status?: string;
	details?: unknown;
	firstLine?: string;
	error?: string;
	dialogs: DialogRecord[];
	/** Details (or error) of the prior call, when the scenario made one. */
	prior?: unknown;
}

export interface SelfTestScenario {
	round: number;
	category: Category;
	action: string;
	input: unknown;
	expected: Expected;
	actual: Actual;
	pass: boolean;
	mismatches: string[];
}

export interface SelfTestSummary {
	seed: number;
	rounds: number;
	totals: { scenarios: number; passed: number; failed: number };
	scenarios: SelfTestScenario[];
}

// ---------------------------------------------------------------------------
// PRNG and pools
// ---------------------------------------------------------------------------

/** Small seeded PRNG (mulberry32) so a seed reproduces a run exactly. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Rand = ReturnType<typeof makeRand>;

function makeRand(seed: number) {
	const next = mulberry32(seed);
	const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
	const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
	const shuffle = <T>(items: readonly T[]): T[] => {
		const copy = [...items];
		for (let i = copy.length - 1; i > 0; i--) {
			const j = int(0, i);
			[copy[i], copy[j]] = [copy[j]!, copy[i]!];
		}
		return copy;
	};
	return { next, int, pick, shuffle, chance: (p: number) => next() < p };
}

// Pools hold trimmed, single-line text. Labels are unique case-insensitively, and
// none contains "[Recommended]" or equals "Write my own answer". No characters whose
// case mapping changes length (like "ß"), so case variants keep the same key.
const QUESTIONS = [
	"Which database should the cache use?",
	"Should reminders survive a Pi restart?",
	"How should old log files be handled?",
	"Where should exports be saved?",
	"¿Qué formato prefieres para la exportación?",
	"どの保存先を使いますか？",
	"Should the CLI keep tasks in memory or on disk?",
	"Keep  both   spaces in this question?",
];
const QUESTION_PARTS = ["Which store should we use?", "1. [Recommended] SQLite", "fake tradeoff line", "naïve café", "日本語"];
const REASONS = [
	"Changes deployment needs; costly to migrate later.",
	"Deleting is hard to undo.",
	"Changes what you see after a restart.",
	"Affects every export file name — and the folder layout.",
	"Cambia lo que ve el usuario.",
	"後で変更するのは大変です。",
];
const LABELS = [
	"SQLite",
	"Postgres",
	"In-memory",
	"Session only",
	"Persist to disk",
	"Delete permanently",
	"Move to archive",
	"Markdown",
	"JSON",
	"Café mode",
	"日本語ラベル",
	"naïve option",
	"Two  inner spaces",
	"Option — with dash",
];
const TRADEOFFS = [
	"Zero setup; one writer at a time",
	"Needs a server; handles concurrent writers",
	"Fastest; lost on restart",
	"Simpler — forgets everything",
	"Survives restarts; needs cleanup",
	"Rápido pero frágil",
	"速いが壊れやすい",
	"Hard  to  undo",
];
const WORDS = ["use", "Redis", "café", "naïve", "日本語", "🚀", "é", "—", "Mixed", "CASE", "keep", "both"];
const PADS = ["", "", " ", "  ", "\t", " \t "];
const BREAKS = ["\n", "\r\n", "\n\n", "\r", " ", " ", " \n  ", "\n\n   ", "\r\n\r\n"];
const BLANKS = ["", " ", "   ", "\t", "\n", " \t\n ", "　", "   ", "\r\n"];
const CUSTOM = "Write my own answer";

const pad = (r: Rand, text: string) => `${r.pick(PADS)}${text}${r.pick(PADS)}`;
const caseVariant = (r: Rand, text: string) => r.pick([text, text.toLowerCase(), text.toUpperCase()]);

// ---------------------------------------------------------------------------
// Generated input and the oracle
// ---------------------------------------------------------------------------

/** A generated call: the raw params sent to the tool plus what the contract says they mean. */
interface Generated {
	params: Record<string, unknown>;
	question: string; // trimmed, line breaks flattened
	reason: string;
	options: { label: string; tradeoff: string }[]; // trimmed
	rec: number; // recommended index, or -1
}

function textWithBreaks(r: Rand): { raw: string; flat: string } {
	const parts = r.shuffle(QUESTION_PARTS).slice(0, r.int(2, 3));
	let raw = parts[0]!;
	for (const part of parts.slice(1)) raw += r.pick(BREAKS) + part;
	return { raw: pad(r, raw), flat: parts.join(" ") };
}

type Text = { raw: string; flat: string };

function generate(
	r: Rand,
	opts: { rec: "none" | "any" | "required"; breaks?: boolean; question?: Text; reason?: Text; labels?: string[] },
): Generated {
	const labels = opts.labels ?? r.shuffle(LABELS).slice(0, r.int(2, 3)).map((label) => caseVariant(r, label));
	const n = labels.length;
	const options = labels.map((label) => ({ label, tradeoff: r.pick(TRADEOFFS) }));
	const rawOptions = options.map((o) => ({ label: pad(r, o.label), tradeoff: pad(r, o.tradeoff) }));

	let question: string;
	let rawQuestion: string;
	let reason: string;
	let rawReason: string;
	const breakQuestion = opts.breaks === true && r.chance(0.6);
	const breakReason = opts.breaks === true && (!breakQuestion || r.chance(0.5));
	if (opts.question) ({ raw: rawQuestion, flat: question } = opts.question);
	else if (breakQuestion) ({ raw: rawQuestion, flat: question } = textWithBreaks(r));
	else rawQuestion = pad(r, (question = r.pick(QUESTIONS)));
	if (opts.reason) ({ raw: rawReason, flat: reason } = opts.reason);
	else if (breakReason) ({ raw: rawReason, flat: reason } = textWithBreaks(r));
	else rawReason = pad(r, (reason = r.pick(REASONS)));

	const rec = opts.rec === "none" ? -1 : opts.rec === "required" || r.chance(0.6) ? r.int(0, n - 1) : -1;
	const params: Record<string, unknown> = { question: rawQuestion, reason: rawReason, options: rawOptions };
	if (rec >= 0) {
		const label = options[rec]!.label;
		params.recommendation = r.pick([label, label.toLowerCase(), label.toUpperCase(), pad(r, label), ` ${label}  `]);
	}
	return { params, question, reason, options, rec };
}

const choiceLine = (g: Generated, i: number) => `${i + 1}. ${i === g.rec ? "[Recommended] " : ""}${g.options[i]!.label}`;

function expectedSelect(g: Generated) {
	const lines = [g.question, "", `Why it matters: ${g.reason}`];
	g.options.forEach((o, i) => lines.push("", choiceLine(g, i), `   ${o.tradeoff}`));
	return {
		title: lines.join("\n"),
		choices: [...g.options.map((_, i) => choiceLine(g, i)), `${g.options.length + 1}. ${CUSTOM}`],
	};
}

function recommendationFields(g: Generated, followed: boolean) {
	return g.rec < 0 ? {} : { recommendation: g.options[g.rec]!.label, followedRecommendation: followed };
}

// Rule 16: after every new answer, a follow-up select. Written out from the contract.
const ONCE = "1. Just this time";
const SIMILAR = "2. Also for similar questions this session";
/** The answer as the follow-up title shows it: custom answers shortened to 60 code points + "…". */
const shownAnswer = (answer: string, source: "option" | "custom") =>
	source === "custom" && [...answer].length > 60 ? `${[...answer].slice(0, 60).join("")}…` : answer;
const expectedScopeDialog = (answer: string, source: "option" | "custom") => ({
	title: `Apply "${shownAnswer(answer, source)}" to similar questions this session?`,
	choices: [ONCE, SIMILAR],
});
const SIMILAR_CONTENT = ["similar decisions", "ask_user"];

function expectOption(g: Generated, i: number, scope: "once" | "similar" = "once"): Expected {
	const answer = g.options[i]!.label;
	return {
		status: "answered",
		details: {
			status: "answered",
			question: g.question,
			answer,
			source: "option",
			...recommendationFields(g, i === g.rec),
			scope,
		},
		firstLine: "ask_user: answered",
		...(scope === "similar" ? { contentIncludes: SIMILAR_CONTENT } : {}),
		dialogs: ["select", "scope"],
		select: expectedSelect(g),
		scope: expectedScopeDialog(answer, "option"),
	};
}

function expectCustom(g: Generated, text: string, scope: "once" | "similar" = "once"): Expected {
	return {
		status: "answered",
		details: { status: "answered", question: g.question, answer: text, source: "custom", ...recommendationFields(g, false), scope },
		firstLine: "ask_user: answered",
		contentIncludes: [JSON.stringify(text), ...(scope === "similar" ? SIMILAR_CONTENT : [])],
		dialogs: ["select", "input", "scope"],
		select: expectedSelect(g),
		inputTitle: g.question,
		scope: expectedScopeDialog(text, "custom"),
	};
}

function expectCancelled(g: Generated, cancelReason: string, dialogs: Method[]): Expected {
	return {
		status: "cancelled",
		details: { status: "cancelled", question: g.question, cancelReason },
		firstLine: `ask_user: cancelled (${cancelReason})`,
		contentIncludes: [g.question],
		dialogs,
		...(dialogs.length ? { select: expectedSelect(g) } : {}),
		...(dialogs.includes("input") ? { inputTitle: g.question } : {}),
	};
}

// ---------------------------------------------------------------------------
// Plans: one per category, randomized
// ---------------------------------------------------------------------------

type Responder = (call: DialogRecord & { signal?: AbortSignal }) => unknown;

interface Plan {
	category: Category;
	action: string;
	params: unknown;
	hasUI: boolean;
	abort?: "before" | "select" | "input" | "scope";
	select?: Responder;
	input?: Responder;
	/** Answers the rule 16 follow-up; default "1. Just this time". */
	scope?: Responder;
	expected: Expected;
	/** Rule 15 scenarios run with a fake session branch. */
	session?: SessionPlan;
}

interface SessionPlan {
	/** A first ask_user call made through the same tool instance before the checked call. */
	prior: {
		params: unknown;
		select?: Responder;
		input?: Responder;
		scope?: Responder;
		/** Run it with an already-aborted signal. */
		aborted?: boolean;
		/** Save its result on the branch afterwards (what Pi does). */
		save: boolean;
		/** True: the checked call is a sibling in the same assistant message. False: it comes in a later turn. */
		sameMessage: boolean;
	};
}

const pickIndex = (i: number): Responder => (call) => call.choices?.[i];
const pickLast: Responder = (call) => call.choices?.at(-1);
const reply = (value: unknown): Responder => () => value;
const choiceName = (g: Generated, i: number) =>
	`choice ${i + 1} of ${g.options.length}${g.rec >= 0 ? ` (recommended: ${g.rec + 1})` : " (no recommendation)"}`;

function randomCustomText(r: Rand): string {
	const words = Array.from({ length: r.int(1, 4) }, () => r.pick(WORDS));
	return pad(r, words.join(r.pick([" ", "  ", "   "])));
}

function invalidPlan(r: Rand, rule: InvalidRule): Plan {
	const g = generate(r, { rec: "none" });
	const params = structuredClone(g.params) as Record<string, any>;
	const options = params.options as Record<string, unknown>[];
	const k = r.int(0, options.length - 1);
	const hasUI = r.chance(0.8);
	let detail: string;
	let errorIncludes: string[];
	switch (rule) {
		case "option count": {
			const count = r.pick([0, 1, 4]);
			params.options = Array.from({ length: count }, (_, i) => options[i] ?? { label: `Extra ${i}`, tradeoff: "More" });
			detail = `${count} options`;
			errorIncludes = ["options", "2 or 3"];
			break;
		}
		case "duplicate labels": {
			const j = (k + 1) % options.length;
			options[j]!.label = pad(r, caseVariant(r, g.options[k]!.label));
			detail = `options[${j}] repeats ${JSON.stringify(g.options[k]!.label)} as ${JSON.stringify(options[j]!.label)}`;
			errorIncludes = ["unique"];
			break;
		}
		case "bad recommendation": {
			params.recommendation = r.pick(["MySQL", "", "   ", "Option Z"]);
			detail = `recommendation ${JSON.stringify(params.recommendation)}`;
			errorIncludes = ["recommendation"];
			break;
		}
		case "unknown field": {
			const name = r.pick(["default", "answer", "choice", "notes"]);
			params[name] = g.options[0]!.label;
			detail = `top-level "${name}"`;
			errorIncludes = [`${name} is not allowed`];
			break;
		}
		case "nested field": {
			const name = r.pick(["recommendation", "question", "description"]);
			options[k]![name] = g.options[k]!.label;
			detail = `options[${k}].${name}`;
			errorIncludes = [`options[${k}].${name} is not allowed`];
			break;
		}
		case "[Recommended] in a label": {
			const marker = r.pick(["[Recommended]", "[recommended]", "[RECOMMENDED]"]);
			const label = g.options[k]!.label;
			const at = r.int(1, label.length - 1);
			const where = r.pick(["start", "middle", "end"] as const);
			options[k]!.label =
				where === "start" ? `${marker} ${label}` : where === "end" ? `${label} ${marker}` : `${label.slice(0, at)}${marker}${label.slice(at)}`;
			detail = `options[${k}].label = ${JSON.stringify(options[k]!.label)} (marker at ${where})`;
			errorIncludes = [`options[${k}].label`, "[Recommended]"];
			break;
		}
		case "line break": {
			const field = r.pick(["label", "tradeoff"] as const);
			const text = g.options[k]![field];
			const at = r.int(1, text.length - 1);
			options[k]![field] = `${text.slice(0, at)}${r.pick(["\n", "\r\n", "\r", " ", " "])}${text.slice(at)}`;
			detail = `line break in options[${k}].${field}`;
			errorIncludes = [`options[${k}]`, "single line"];
			break;
		}
		case 'label = "Write my own answer"': {
			options[k]!.label = pad(r, caseVariant(r, CUSTOM));
			detail = `options[${k}].label = ${JSON.stringify(options[k]!.label)}`;
			errorIncludes = [`options[${k}].label`, CUSTOM];
			break;
		}
		case "blank text field": {
			const field = r.pick(["question", "reason", "label", "tradeoff"] as const);
			const blank = r.pick(BLANKS);
			if (field === "question" || field === "reason") params[field] = blank;
			else options[k]![field] = blank;
			const name = field === "question" || field === "reason" ? field : `options[${k}].${field}`;
			detail = `${name} = ${JSON.stringify(blank)}`;
			errorIncludes = [name];
			break;
		}
	}
	return {
		category: "invalid input",
		action: `invalid: ${rule} (${detail})${hasUI ? "" : ", no UI"}; no dialog should open`,
		params,
		hasUI,
		expected: { errorIncludes, dialogs: [] },
	};
}

// Repeats: only identical sibling calls in ONE assistant message share a dialog.
// Identical = question and reason equal after flattening, trimming, lower-casing,
// collapsing whitespace and dropping a trailing "?", and the same option labels
// as a set (trimmed, case-insensitive). Across turns the dialog always opens.
// The oracle builds variants from those transformations only.

const RANDOM_CASE = (r: Rand, word: string) =>
	[...word].map((ch) => (r.chance(0.5) ? ch.toUpperCase() : ch.toLowerCase())).join("");

/** Text that must count as the same as `text`: { raw sent to the tool, flat text the tool keeps }. */
function nearDuplicate(r: Rand, text: string): Text {
	const words = text.split(/\s+/).map((w) => r.pick([w, w.toLowerCase(), w.toUpperCase(), RANDOM_CASE(r, w)]));
	const last = words.length - 1;
	if (words[last]!.endsWith("?") && r.chance(0.5)) words[last] = words[last]!.slice(0, -1);
	else if (!words[last]!.endsWith("?") && r.chance(0.5)) words[last] += "?";
	let raw = words[0]!;
	let flat = words[0]!;
	for (const word of words.slice(1)) {
		const sep = r.pick([" ", "  ", "\t", " \t ", "\n", "\r\n"]);
		raw += sep + word;
		flat += (sep === "\n" || sep === "\r\n" ? " " : sep) + word;
	}
	return { raw: pad(r, raw), flat };
}

const exact = (r: Rand, text: string): Text => ({ raw: pad(r, text), flat: text });

/** A first call with a single-line question and reason from the pools. */
const firstCall = (r: Rand) => generate(r, { rec: "any" });

/** The same whole call as `g`: question, reason and label set equal; order, case, tradeoffs, recommendation free. */
function sameCall(r: Rand, g: Generated): Generated {
	return generate(r, {
		rec: "any",
		question: r.chance(0.7) ? nearDuplicate(r, g.question) : exact(r, g.question),
		reason: r.chance(0.5) ? nearDuplicate(r, g.reason) : exact(r, g.reason),
		labels: r.shuffle(g.options.map((o) => caseVariant(r, o.label))),
	});
}

/** What an identical sibling returns: the first sibling's decision under its own question, marked repeated. */
function expectRepeat(question: string, earlier: Record<string, unknown>): Expected {
	if (earlier.status === "answered") {
		const details: Record<string, unknown> = { status: "answered", question, answer: earlier.answer, source: earlier.source };
		if ("recommendation" in earlier) {
			details.recommendation = earlier.recommendation;
			details.followedRecommendation = earlier.followedRecommendation;
		}
		details.scope = earlier.scope;
		details.repeated = true;
		return {
			status: "answered",
			details,
			firstLine: "ask_user: answered",
			contentIncludes: [JSON.stringify(earlier.answer), ...(details.scope === "similar" ? SIMILAR_CONTENT : [])],
			dialogs: [],
		};
	}
	return {
		status: "cancelled",
		details: { status: "cancelled", question, cancelReason: earlier.cancelReason, repeated: true },
		firstLine: `ask_user: cancelled (${String(earlier.cancelReason)})`,
		contentIncludes: [question],
		dialogs: [],
	};
}

/** A first call answered by a random option or custom text, with a random follow-up; returns how and what it returns. */
function priorAnswer(r: Rand, g: Generated) {
	const scope = r.pick(["once", "similar"] as const);
	const scopeResponder = pickIndex(scope === "similar" ? 1 : 0);
	if (r.chance(0.6)) {
		const i = r.int(0, g.options.length - 1);
		return { how: `answered ${choiceName(g, i)}, scope ${scope}`, select: pickIndex(i), input: undefined, scope: scopeResponder, expected: expectOption(g, i, scope) };
	}
	const text = randomCustomText(r);
	return { how: `answered ${JSON.stringify(text)} (custom), scope ${scope}`, select: pickLast, input: reply(text), scope: scopeResponder, expected: expectCustom(g, text, scope) };
}

function repeatPlans(r: Rand): Plan[] {
	const plans: Plan[] = [];
	{
		const g0 = firstCall(r);
		const dismissed = r.chance(0.3);
		const a = priorAnswer(r, g0);
		const prior = dismissed ? expectCancelled(g0, "dismissed", ["select"]) : a.expected;
		const g = sameCall(r, g0);
		const i = r.int(0, g.options.length - 1);
		plans.push({
			category: "identical call in a later turn asks",
			action: `an earlier turn ${dismissed ? "dismissed" : a.how} this call; a later turn makes the same call: the dialog opens, picks ${choiceName(g, i)}`,
			params: g.params,
			hasUI: true,
			select: pickIndex(i),
			session: { prior: { params: g0.params, select: dismissed ? reply(undefined) : a.select, input: a.input, scope: a.scope, save: true, sameMessage: false } },
			expected: { ...expectOption(g, i), prior: prior.details },
		});
	}
	{
		const g0 = firstCall(r);
		const a = priorAnswer(r, g0);
		const g = sameCall(r, g0);
		const save = r.chance(0.5);
		plans.push({
			category: "identical siblings: one dialog",
			action: `a sibling in the same response ${a.how}${save ? " (saved)" : " (not saved yet)"}; this identical call gets it without a dialog`,
			params: g.params,
			hasUI: r.chance(0.8),
			select: pickIndex(0),
			input: reply("unexpected"),
			session: { prior: { params: g0.params, select: a.select, input: a.input, scope: a.scope, save, sameMessage: true } },
			expected: { ...expectRepeat(g.question, a.expected.details!), prior: a.expected.details },
		});
	}
	{
		const g0 = firstCall(r);
		const how = r.pick(["dismissed", "empty_answer"] as const);
		const prior = how === "dismissed" ? expectCancelled(g0, "dismissed", ["select"]) : expectCancelled(g0, "empty_answer", ["select", "input"]);
		const g = sameCall(r, g0);
		plans.push({
			category: "dismissed sibling repeats the cancel",
			action: `a sibling in the same response was cancelled (${how}); this identical call is cancelled the same way, no dialog`,
			params: g.params,
			hasUI: true,
			select: pickIndex(0),
			input: reply("unexpected"),
			session: { prior: { params: g0.params, select: how === "dismissed" ? reply(undefined) : pickLast, input: reply(r.pick(BLANKS)), save: r.chance(0.5), sameMessage: true } },
			expected: { ...expectRepeat(g.question, prior.details!), prior: prior.details },
		});
	}
	{
		const g0 = firstCall(r);
		const a = priorAnswer(r, g0);
		const differ = r.pick(["question", "reason", "options"] as const);
		const fresh = r.shuffle(LABELS.filter((l) => !g0.options.some((o) => o.label.toLowerCase() === l.toLowerCase())));
		const g =
			differ === "question"
				? generate(r, { rec: "any", question: exact(r, r.pick(QUESTIONS.filter((q) => q !== g0.question))), reason: exact(r, g0.reason), labels: g0.options.map((o) => o.label) })
				: differ === "reason"
					? generate(r, { rec: "any", question: exact(r, g0.question), reason: exact(r, r.pick(REASONS.filter((x) => x !== g0.reason))), labels: g0.options.map((o) => o.label) })
					: generate(r, { rec: "any", question: exact(r, g0.question), reason: exact(r, g0.reason), labels: fresh.slice(0, r.int(2, 3)) });
		const i = r.int(0, g.options.length - 1);
		plans.push({
			category: "different siblings both ask",
			action: `a sibling in the same response ${a.how}; this call differs in its ${differ}: the dialog opens, picks ${choiceName(g, i)}`,
			params: g.params,
			hasUI: true,
			select: pickIndex(i),
			session: { prior: { params: g0.params, select: a.select, input: a.input, scope: a.scope, save: r.chance(0.5), sameMessage: true } },
			expected: { ...expectOption(g, i), prior: a.expected.details },
		});
	}
	{
		const g0 = firstCall(r);
		const g = sameCall(r, g0);
		const i = r.int(0, g.options.length - 1);
		plans.push({
			category: "aborted sibling doesn't count",
			action: `a sibling in the same response was aborted before it asked; this identical call asks, picks ${choiceName(g, i)}`,
			params: g.params,
			hasUI: true,
			select: pickIndex(i),
			session: { prior: { params: g0.params, aborted: true, save: true, sameMessage: true } },
			expected: { ...expectOption(g, i), prior: expectCancelled(g0, "aborted", []).details },
		});
	}
	return plans;
}

function planRound(r: Rand): Plan[] {
	const plans: Plan[] = [];
	const add = (plan: Plan) => plans.push(plan);

	{
		const g = generate(r, { rec: "any" });
		const i = r.int(0, g.options.length - 1);
		add({ category: "pick option", action: `picks ${choiceName(g, i)}`, params: g.params, hasUI: true, select: pickIndex(i), expected: expectOption(g, i) });
	}
	{
		const g = generate(r, { rec: "required" });
		const others = g.options.map((_, i) => i).filter((i) => i !== g.rec);
		const i = r.pick(others);
		add({ category: "pick against recommendation", action: `picks ${choiceName(g, i)}`, params: g.params, hasUI: true, select: pickIndex(i), expected: expectOption(g, i) });
	}
	{
		const g = generate(r, { rec: "none" });
		const i = r.int(0, g.options.length - 1);
		add({ category: "no recommendation", action: `picks ${choiceName(g, i)}`, params: g.params, hasUI: true, select: pickIndex(i), expected: expectOption(g, i) });
	}
	{
		const g = generate(r, { rec: "any" });
		const text = randomCustomText(r);
		add({ category: "custom answer", action: `picks "${CUSTOM}", types ${JSON.stringify(text)}`, params: g.params, hasUI: true, select: pickLast, input: reply(text), expected: expectCustom(g, text) });
	}
	{
		const g = generate(r, { rec: "required" });
		const text = g.options[g.rec]!.label;
		add({ category: "custom equals recommended label", action: `picks "${CUSTOM}", types the recommended label ${JSON.stringify(text)}`, params: g.params, hasUI: true, select: pickLast, input: reply(text), expected: expectCustom(g, text) });
	}
	{
		const g = generate(r, { rec: "any" });
		add({ category: "dismiss menu", action: "presses Esc on the menu", params: g.params, hasUI: true, select: reply(undefined), expected: expectCancelled(g, "dismissed", ["select"]) });
	}
	{
		const g = generate(r, { rec: "any" });
		add({ category: "dismiss text box", action: `picks "${CUSTOM}", presses Esc in the text box`, params: g.params, hasUI: true, select: pickLast, input: reply(undefined), expected: expectCancelled(g, "dismissed", ["select", "input"]) });
	}
	{
		const g = generate(r, { rec: "any" });
		const blank = r.pick(BLANKS);
		add({ category: "empty custom answer", action: `picks "${CUSTOM}", types ${JSON.stringify(blank)}`, params: g.params, hasUI: true, select: pickLast, input: reply(blank), expected: expectCancelled(g, "empty_answer", ["select", "input"]) });
	}
	{
		const g = generate(r, { rec: "any" });
		add({
			category: "no UI",
			action: "no UI (print or JSON mode)",
			params: g.params,
			hasUI: false,
			select: pickIndex(0),
			input: reply("unexpected"),
			expected: {
				status: "unavailable",
				details: { status: "unavailable", question: g.question },
				firstLine: "ask_user: unavailable",
				contentIncludes: [g.question],
				dialogs: [],
			},
		});
	}
	{
		const g = generate(r, { rec: "any" });
		const at = r.pick(["before", "select", "input"] as const);
		const action = { before: "run is aborted before the tool starts", select: "run is aborted while the menu is open", input: `picks "${CUSTOM}"; run is aborted while the text box is open` }[at];
		const dialogs: Method[] = { before: [], select: ["select"], input: ["select", "input"] }[at] as Method[];
		add({ category: "abort", action, params: g.params, hasUI: true, abort: at, select: at === "input" ? pickLast : pickIndex(0), input: reply("too late"), expected: expectCancelled(g, "aborted", dialogs) });
	}
	for (const rule of r.shuffle(INVALID_RULES)) add(invalidPlan(r, rule));
	{
		const g = generate(r, { rec: "any" });
		const value = r.pick([g.options[0]!.label, `${g.options.length + 2}. ${CUSTOM}`, "", "choice 9"]);
		add({
			category: "unknown menu value",
			action: `menu returns ${JSON.stringify(value)}, which is not a displayed choice`,
			params: g.params,
			hasUI: true,
			select: reply(value),
			expected: { errorIncludes: ["unexpected dialog response"], dialogs: ["select"], select: expectedSelect(g) },
		});
	}
	{
		const g = generate(r, { rec: "any", breaks: true });
		if (r.chance(0.5)) {
			const i = r.int(0, g.options.length - 1);
			add({ category: "line breaks flattened", action: `question/reason contain line breaks; picks ${choiceName(g, i)}`, params: g.params, hasUI: true, select: pickIndex(i), expected: expectOption(g, i) });
		} else {
			const text = randomCustomText(r);
			add({ category: "line breaks flattened", action: `question/reason contain line breaks; types ${JSON.stringify(text)}`, params: g.params, hasUI: true, select: pickLast, input: reply(text), expected: expectCustom(g, text) });
		}
	}
	for (const plan of repeatPlans(r)) add(plan);
	for (const plan of scopePlans(r)) add(plan);
	return plans;
}

/** Rule 16 follow-up: similar, Esc / unexpected value, abort, long custom title. */
function scopePlans(r: Rand): Plan[] {
	const plans: Plan[] = [];
	const answerBy = (g: Generated) => {
		if (r.chance(0.5)) {
			const i = r.int(0, g.options.length - 1);
			return { action: `picks ${choiceName(g, i)}`, select: pickIndex(i), input: undefined, expect: (scope: "once" | "similar") => expectOption(g, i, scope) };
		}
		const text = randomCustomText(r);
		return { action: `picks "${CUSTOM}", types ${JSON.stringify(text)}`, select: pickLast, input: reply(text), expect: (scope: "once" | "similar") => expectCustom(g, text, scope) };
	};
	{
		const g = generate(r, { rec: "any" });
		const a = answerBy(g);
		plans.push({ category: "follow-up: also for similar", action: `${a.action}; then "Also for similar questions this session"`, params: g.params, hasUI: true, select: a.select, input: a.input, scope: pickIndex(1), expected: a.expect("similar") });
	}
	{
		const g = generate(r, { rec: "any" });
		const a = answerBy(g);
		const value = r.pick([undefined, "2. Also for similar", "Also for similar questions this session", "3. Never", ""]);
		const what = value === undefined ? "Esc on the follow-up" : `follow-up returns ${JSON.stringify(value)} (not a choice)`;
		plans.push({ category: "follow-up: Esc or unexpected value", action: `${a.action}; then ${what}: the answer stands, scope once`, params: g.params, hasUI: true, select: a.select, input: a.input, scope: reply(value), expected: a.expect("once") });
	}
	{
		const g = generate(r, { rec: "any" });
		const a = answerBy(g);
		plans.push({ category: "follow-up: abort", action: `${a.action}; then the run is aborted while the follow-up is open: the answer stands, scope once`, params: g.params, hasUI: true, abort: "scope", select: a.select, input: a.input, expected: a.expect("once") });
	}
	{
		const g = generate(r, { rec: "any" });
		const longText = Array.from({ length: r.int(14, 24) }, () => r.pick(WORDS)).join(" ");
		const scope = r.pick(["once", "similar"] as const);
		plans.push({
			category: "follow-up title shortens a long custom answer",
			action: `picks "${CUSTOM}", types a ${[...longText].length}-character answer; then ${scope === "similar" ? '"Also for similar"' : '"Just this time"'}`,
			params: g.params,
			hasUI: true,
			select: pickLast,
			input: reply(longText),
			scope: pickIndex(scope === "similar" ? 1 : 0),
			expected: expectCustom(g, longText, scope),
		});
	}
	return plans;
}

// ---------------------------------------------------------------------------
// Running and checking
// ---------------------------------------------------------------------------

interface FakeEntry {
	type: "message";
	id: string;
	parentId: string | null;
	message: Record<string, unknown>;
}

/**
 * A fake session branch shaped like Pi's (getBranch). A call adds an assistant
 * message with the toolCall (or joins the last one, for siblings); a saved result
 * adds the tool result.
 */
function fakeSession(uid: string) {
	const branch: FakeEntry[] = [];
	let n = 0;
	const push = (message: Record<string, unknown>, label: string) => {
		const entry: FakeEntry = { type: "message", id: `${uid}-${label}-${++n}`, parentId: branch.at(-1)?.id ?? null, message };
		branch.push(entry);
		return entry.id;
	};
	const toolCall = (id: string, args: unknown) => ({ type: "toolCall", id, name: "ask_user", arguments: args });
	const session = {
		view: { getBranch: () => [...branch] },
		/** Returns the id of the assistant entry holding the call. */
		beginCall(id: string, args: unknown, sameMessage = false): string {
			const last = branch.at(-1);
			if (sameMessage && last?.message.role === "assistant" && Array.isArray(last.message.content)) {
				(last.message.content as unknown[]).push(toolCall(id, args));
				return last.id;
			}
			return push({ role: "assistant", content: [toolCall(id, args)] }, "assistant");
		},
		save(toolCallId: string, details: unknown) {
			push({ role: "toolResult", toolName: "ask_user", toolCallId, isError: false, content: [], details }, "result");
		},
		userTurn() {
			push({ role: "user", content: [] }, "user");
		},
	};
	session.userTurn();
	return session;
}

const isFollowUp = (title: string, choices: string[]) =>
	/^Apply ".*" to similar questions this session\?$/s.test(title) && choices.length === 2 && choices[0] === ONCE && choices[1] === SIMILAR;

function makeCtx(
	hasUI: boolean,
	responders: { select?: Responder; input?: Responder; scope?: Responder },
	abortAt: Plan["abort"],
	controller: AbortController,
	dialogs: DialogRecord[],
	sessionManager?: unknown,
): AskUserContext {
	const open = (record: DialogRecord, signal: AbortSignal | undefined, responder: Responder | undefined, abortHere: boolean) => {
		dialogs.push(record);
		if (signal?.aborted) return Promise.resolve(undefined); // like Pi: an aborted signal resolves undefined
		if (abortHere) {
			if (!signal) return Promise.resolve(undefined);
			const closed = new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
			setImmediate(() => controller.abort());
			return closed;
		}
		return Promise.resolve().then(() => responder?.({ ...record, signal }));
	};
	const timeoutPassed = (opts: object | undefined) => opts !== undefined && "timeout" in opts;
	return {
		hasUI,
		ui: {
			select: (title, choices, opts) =>
				(isFollowUp(title, choices)
					? open({ method: "scope", title, choices: [...choices], timeoutPassed: timeoutPassed(opts) }, opts?.signal, responders.scope ?? pickIndex(0), abortAt === "scope")
					: open({ method: "select", title, choices: [...choices], timeoutPassed: timeoutPassed(opts) }, opts?.signal, responders.select, abortAt === "select")) as Promise<
					string | undefined
				>,
			input: (title, placeholder, opts) =>
				open({ method: "input", title, placeholder, timeoutPassed: timeoutPassed(opts) }, opts?.signal, responders.input, abortAt === "input") as Promise<
					string | undefined
				>,
		},
		...(sessionManager ? { sessionManager } : {}),
	} as AskUserContext;
}

/** Run one plan against fresh in-memory state; `text` is the full model-facing content. */
async function runPlan(plan: Plan, execute: Execute, uid: string): Promise<{ actual: Actual; text?: string }> {
	const session = plan.session ? fakeSession(uid) : undefined;
	let prior: unknown;
	let sameMessage = false;
	if (plan.session && session) {
		const p = plan.session.prior;
		const toolCallId = `${uid}-prior`;
		session.beginCall(toolCallId, p.params);
		// Like Pi: every tool call of one response is in the assistant message before any of them runs.
		if (p.sameMessage) session.beginCall(`${uid}-call`, plan.params, true);
		try {
			const priorController = new AbortController();
			if (p.aborted) priorController.abort();
			const result = await execute(p.params, priorController.signal, makeCtx(true, p, undefined, priorController, [], session.view), toolCallId);
			prior = result.details;
			if (p.save) session.save(toolCallId, result.details);
		} catch (error) {
			prior = { error: error instanceof Error ? error.message : String(error) };
		}
		sameMessage = p.sameMessage;
		if (!sameMessage) session.userTurn(); // the checked call comes in a later turn, in a new assistant message
	}

	const controller = new AbortController();
	const dialogs: DialogRecord[] = [];
	const callId = `${uid}-call`;
	if (session && !sameMessage) session.beginCall(callId, plan.params); // siblings were added up front
	const ctx = makeCtx(plan.hasUI, plan, plan.abort, controller, dialogs, session?.view);
	if (plan.abort === "before") controller.abort();
	const withPrior = (actual: Actual): Actual => (prior === undefined ? actual : { ...actual, prior });

	try {
		const result = await execute(plan.params, controller.signal, ctx, callId);
		const text = result.content.map((c) => c.text).join("");
		return { actual: withPrior({ status: result.details.status, details: result.details, firstLine: text.split("\n")[0], dialogs }), text };
	} catch (error) {
		return { actual: withPrior({ error: error instanceof Error ? error.message : String(error), dialogs }) };
	}
}

function check(expected: Expected, actual: Actual, text: string | undefined): string[] {
	const problems: string[] = [];
	const methods = actual.dialogs.map((d) => d.method);
	if (!isDeepStrictEqual(methods, expected.dialogs)) {
		problems.push(`dialogs: expected ${JSON.stringify(expected.dialogs)}, got ${JSON.stringify(methods)}`);
	}
	if (actual.dialogs.some((d) => d.timeoutPassed)) problems.push("a dialog was given a timeout");
	if (expected.errorIncludes) {
		if (actual.error === undefined) problems.push(`expected an error, got status ${String(actual.status)}`);
		else for (const part of expected.errorIncludes) if (!actual.error.includes(part)) problems.push(`error should mention ${JSON.stringify(part)}: ${actual.error}`);
	} else if (actual.error !== undefined) {
		problems.push(`unexpected error: ${actual.error}`);
	} else {
		if (actual.status !== expected.status) problems.push(`status: expected ${expected.status}, got ${String(actual.status)}`);
		if (!isDeepStrictEqual(actual.details, expected.details)) {
			problems.push(`details: expected ${JSON.stringify(expected.details)}, got ${JSON.stringify(actual.details)}`);
		}
		if (actual.firstLine !== expected.firstLine) problems.push(`first line: expected ${JSON.stringify(expected.firstLine)}, got ${JSON.stringify(actual.firstLine)}`);
		for (const part of expected.contentIncludes ?? []) {
			// Accept the text as-is or JSON-escaped (e.g. a tab inside a quoted question).
			const escaped = JSON.stringify(part).slice(1, -1);
			if (!text?.includes(part) && !text?.includes(escaped)) problems.push(`content should include ${JSON.stringify(part)}`);
		}
	}
	if (expected.prior !== undefined && !isDeepStrictEqual(actual.prior, expected.prior)) {
		problems.push(`prior call: expected ${JSON.stringify(expected.prior)}, got ${JSON.stringify(actual.prior)}`);
	}
	const select = actual.dialogs.find((d) => d.method === "select");
	if (expected.select && select) {
		if (select.title !== expected.select.title) problems.push(`select title: expected ${JSON.stringify(expected.select.title)}, got ${JSON.stringify(select.title)}`);
		if (!isDeepStrictEqual(select.choices, expected.select.choices)) {
			problems.push(`select choices: expected ${JSON.stringify(expected.select.choices)}, got ${JSON.stringify(select.choices)}`);
		}
	}
	const scopeDialog = actual.dialogs.find((d) => d.method === "scope");
	if (expected.scope && scopeDialog) {
		if (scopeDialog.title !== expected.scope.title) problems.push(`follow-up title: expected ${JSON.stringify(expected.scope.title)}, got ${JSON.stringify(scopeDialog.title)}`);
		if (!isDeepStrictEqual(scopeDialog.choices, expected.scope.choices)) problems.push(`follow-up choices: expected ${JSON.stringify(expected.scope.choices)}, got ${JSON.stringify(scopeDialog.choices)}`);
	}
	const input = actual.dialogs.find((d) => d.method === "input");
	if (expected.inputTitle !== undefined && input) {
		if (input.title !== expected.inputTitle) problems.push(`input title: expected ${JSON.stringify(expected.inputTitle)}, got ${JSON.stringify(input.title)}`);
		if (!input.placeholder?.trim()) problems.push("input placeholder is empty");
	}
	return problems;
}

/** Run `rounds` rounds of every category. Without a seed, picks one at random and returns it. */
/** Makes fake session ids unique per run, so a tool instance reused across runs never sees an old run's branch. */
let runCounter = 0;

export async function runSelfTest(options: { seed?: number; rounds?: number; execute: Execute }): Promise<SelfTestSummary> {
	const seed = (options.seed ?? Math.floor(Math.random() * 0x100000000)) >>> 0;
	const rounds = Math.max(1, Math.floor(options.rounds ?? 1));
	const { execute } = options;
	const run = ++runCounter;
	const r = makeRand(seed);
	const scenarios: SelfTestScenario[] = [];
	for (let round = 1; round <= rounds; round++) {
		for (const [index, plan] of planRound(r).entries()) {
			const { actual, text } = await runPlan(plan, execute, `self-test-${run}-${seed}-${round}-${index}`);
			const mismatches = check(plan.expected, actual, text);
			scenarios.push({
				round,
				category: plan.category,
				action: plan.action,
				input: plan.params,
				expected: plan.expected,
				actual,
				pass: mismatches.length === 0,
				mismatches,
			});
		}
	}
	const passed = scenarios.filter((s) => s.pass).length;
	return { seed, rounds, totals: { scenarios: scenarios.length, passed, failed: scenarios.length - passed }, scenarios };
}

/** Report lines: one PASS/FAIL line per scenario (with any mismatches), then totals and the seed. */
export function formatSelfTestReport(summary: SelfTestSummary, rerun: string): string[] {
	const { passed, failed, scenarios } = summary.totals;
	const lines = [
		`ask_user self-test — ${passed}/${scenarios} passed${failed ? ` (${failed} FAILED)` : ""}`,
		`seed: ${summary.seed}, rounds: ${summary.rounds}`,
		"",
	];
	for (const s of summary.scenarios) {
		lines.push(`${s.pass ? "PASS" : "FAIL"}  [${summary.rounds > 1 ? `r${s.round} ` : ""}${s.category}] ${s.action}`);
		for (const problem of s.mismatches) lines.push(`      - ${problem}`);
	}
	lines.push("", `${passed}/${scenarios} passed, ${failed} failed`, `seed: ${summary.seed} — rerun with ${rerun}`);
	return lines;
}
