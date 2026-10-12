// Core of the ask_user tool: validate the call, show Pi's built-in dialogs,
// and map the human's response to one of three results.

/** Text of the final choice that lets the user type their own answer (shown numbered, after the options). */
export const CUSTOM_ANSWER_LABEL = "Write my own answer";

/** Put right after the recommended option's number, in the title and in its choice. */
export const RECOMMENDED_MARK = "[Recommended] ";

const INPUT_PLACEHOLDER = "Type your answer";

/** Rule 16: the follow-up after a new answer. "Just this time" is first, so Enter-Enter keeps the old flow. */
export const SCOPE_ONCE = "1. Just this time";
export const SCOPE_SIMILAR = "2. Also for similar questions this session";
export const SCOPE_CHOICES = [SCOPE_ONCE, SCOPE_SIMILAR];
const SCOPE_SHOWN_MAX = 60;

export type Scope = "once" | "similar";

export interface AskUserOption {
	label: string;
	tradeoff: string;
}

export interface AskUserParams {
	question: string;
	reason: string;
	options: AskUserOption[];
	recommendation?: string;
}

export type CancelReason = "dismissed" | "empty_answer" | "aborted";

export type AskUserDetails =
	| {
			status: "answered";
			question: string;
			answer: string;
			source: "option" | "custom";
			recommendation?: string;
			followedRecommendation?: boolean;
			/** Rule 16: whether the user applied this answer to similar questions this session. */
			scope: Scope;
			/** Only when an identical sibling call in the same assistant message already got this answer. */
			repeated?: true;
	  }
	| { status: "cancelled"; question: string; cancelReason: CancelReason; repeated?: true }
	| { status: "unavailable"; question: string };

/** The result of an earlier ask_user call in the same assistant message (a sibling call). */
export interface SiblingResult {
	toolCallId: string;
	details: AskUserDetails;
	/** callKey() of that sibling call. */
	call: string;
}

export interface AskUserResult {
	content: { type: "text"; text: string }[];
	details: AskUserDetails;
}

type DialogOptions = { signal?: AbortSignal };

/** The slice of Pi's ExtensionContext this tool needs. */
export interface AskUserContext {
	hasUI: boolean;
	ui: {
		select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
		input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined>;
	};
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function fail(message: string): never {
	throw new Error(`ask_user: ${message}`);
}

function requireText(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a non-empty string`);
	return value.trim();
}

const labelKey = (label: string) => label.trim().toLowerCase();

const INPUT_FIELDS = ["question", "reason", "options", "recommendation"];
const OPTION_FIELDS = ["label", "tradeoff"];

function rejectUnknownFields(value: Record<string, unknown>, allowed: string[], path: string) {
	for (const key of Object.keys(value)) {
		if (allowed.includes(key)) continue;
		const name = path ? `${path}.${key}` : key;
		if (path && INPUT_FIELDS.includes(key)) fail(`${name} is not allowed; put ${JSON.stringify(key)} at the top level`);
		fail(`${name} is not allowed (allowed fields: ${allowed.join(", ")})`);
	}
}

const LINE_BREAK = /[\r\n\u2028\u2029]/;

/** Rule 14: a run of line breaks and the whitespace around it becomes one space, so text can't fake option blocks. */
const flatten = (text: string) => text.replace(/\s*[\r\n\u2028\u2029]\s*/g, " ");

/** Rule 14: labels and tradeoffs must not fake the dialog's own structure. Inputs are already trimmed. */
function requireDisplaySafe(label: string, tradeoff: string, i: number) {
	if (LINE_BREAK.test(label) || LINE_BREAK.test(tradeoff)) {
		fail(`options[${i}] label and tradeoff must each be a single line`);
	}
	if (label.toLowerCase().includes(RECOMMENDED_MARK.trim().toLowerCase())) {
		fail(`options[${i}].label must not contain "[Recommended]"; use the top-level "recommendation" field`);
	}
	if (labelKey(label) === labelKey(CUSTOM_ANSWER_LABEL)) {
		fail(`options[${i}].label must not be "${CUSTOM_ANSWER_LABEL}"; that choice is added automatically`);
	}
}

/** Returns trimmed (question/reason also flattened) params with `recommendation` set to the canonical label, or throws. */
export function validate(input: unknown): AskUserParams {
	if (typeof input !== "object" || input === null) fail("input must be an object");
	const raw = input as Record<string, unknown>;
	rejectUnknownFields(raw, INPUT_FIELDS, "");

	const question = flatten(requireText(raw.question, "question"));
	const reason = flatten(requireText(raw.reason, "reason"));

	if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 3) {
		const got = Array.isArray(raw.options) ? `${raw.options.length} items` : typeof raw.options;
		fail(`options must be an array of 2 or 3 items (got ${got})`);
	}
	const options = raw.options.map((item: unknown, i: number): AskUserOption => {
		if (typeof item !== "object" || item === null) fail(`options[${i}] must be an object with label and tradeoff`);
		const option = item as Record<string, unknown>;
		rejectUnknownFields(option, OPTION_FIELDS, `options[${i}]`);
		const label = requireText(option.label, `options[${i}].label`);
		const tradeoff = requireText(option.tradeoff, `options[${i}].tradeoff`);
		requireDisplaySafe(label, tradeoff, i);
		return { label, tradeoff };
	});

	const seen = new Map<string, string>();
	for (const { label } of options) {
		const earlier = seen.get(labelKey(label));
		if (earlier !== undefined) {
			fail(`option labels must be unique (case-insensitive, trimmed): ${JSON.stringify(earlier)} and ${JSON.stringify(label)}`);
		}
		seen.set(labelKey(label), label);
	}

	let recommendation: string | undefined;
	if (raw.recommendation !== undefined) {
		if (typeof raw.recommendation !== "string") fail("recommendation must be a string equal to one option label");
		recommendation = options.find((o) => labelKey(o.label) === labelKey(raw.recommendation as string))?.label;
		if (recommendation === undefined) {
			const labels = options.map((o) => JSON.stringify(o.label)).join(", ");
			fail(`recommendation ${JSON.stringify(raw.recommendation)} does not match any option label (${labels})`);
		}
	}

	return { question, reason, options, recommendation };
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

/** "<i>. <label>", with the marker right after the number so it can't wrap away from its option. */
function optionLine({ label }: AskUserOption, i: number, recommendation: string | undefined): string {
	return `${i + 1}. ${label === recommendation ? RECOMMENDED_MARK : ""}${label}`;
}

/** Short numbered choices (numbers keep every choice distinct), then the numbered custom choice. */
export function buildChoices({ options, recommendation }: AskUserParams): string[] {
	const choices = options.map((option, i) => optionLine(option, i, recommendation));
	return [...choices, `${choices.length + 1}. ${CUSTOM_ANSWER_LABEL}`];
}

/** Question, reason, then each option with its tradeoff indented on the next line. */
export function buildTitle({ question, reason, options, recommendation }: AskUserParams): string {
	const lines = [question, "", `Why it matters: ${reason}`];
	options.forEach((option, i) => lines.push("", optionLine(option, i, recommendation), `   ${option.tradeoff}`));
	return lines.join("\n");
}

const ABORTED = Symbol("aborted");

/** Runs one dialog; `undefined` or a rejection while the signal is aborted means the run was aborted. */
async function dialog<T>(open: () => Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
	try {
		const value = await open();
		return value === undefined && signal?.aborted ? ABORTED : value;
	} catch (error) {
		if (signal?.aborted) return ABORTED;
		throw error;
	}
}

function unexpected(value: unknown): never {
	fail(`unexpected dialog response ${JSON.stringify(value) ?? String(value)}; it is not one of the displayed choices`);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const NO_ANSWER_ADVICE = (question: string) =>
	`Do not assume an answer. Tell the user this decision is still open: ${JSON.stringify(question)}. ` +
	"Continue only with work that does not depend on it.";

const CANCEL_TEXT: Record<CancelReason, string> = {
	dismissed: "The user closed the question without answering. Don't ask again about this decision in this scenario.",
	empty_answer: "The user submitted an empty custom answer. Don't ask again about this decision in this scenario.",
	aborted: "The run was aborted before the user answered.",
};

function result(details: AskUserDetails, lines: string[]): AskUserResult {
	return { content: [{ type: "text", text: lines.join("\n") }], details };
}

function cancelled(question: string, cancelReason: CancelReason): AskUserResult {
	return result({ status: "cancelled", question, cancelReason }, [
		`ask_user: cancelled (${cancelReason})`,
		CANCEL_TEXT[cancelReason],
		NO_ANSWER_ADVICE(question),
	]);
}

function unavailable(question: string): AskUserResult {
	return result({ status: "unavailable", question }, [
		"ask_user: unavailable",
		"No interactive UI is available in this mode, so the user could not be asked. Do not call ask_user again in this run.",
		NO_ANSWER_ADVICE(question),
	]);
}

const SIMILAR_TEXT =
	"The user asked to apply this choice to similar decisions for the rest of this session. For a later decision you judge similar, " +
	"don't call ask_user: apply this preference and tell the user you did. If you're unsure whether a decision is similar, ask.";
const scopeLine = (scope: Scope) => (scope === "similar" ? SIMILAR_TEXT : "This answer applies to this question only.");

function answered(params: AskUserParams, answer: string, source: "option" | "custom", scope: Scope): AskUserResult {
	const { question, recommendation } = params;
	const lines = [`ask_user: answered`, `Question: ${JSON.stringify(question)}`];
	if (source === "option") lines.push(`The user chose the option ${JSON.stringify(answer)}.`);
	else lines.push(`The user typed a free-text answer instead of choosing an option: ${JSON.stringify(answer)}`);

	if (recommendation === undefined) {
		lines.push(scopeLine(scope));
		return result({ status: "answered", question, answer, source, scope }, lines);
	}
	const followedRecommendation = source === "option" && answer === recommendation;
	if (followedRecommendation) {
		lines.push("This is the option you recommended.");
	} else if (source === "option") {
		lines.push(`This is not the option you recommended (${JSON.stringify(recommendation)}). Use the user's choice.`);
	} else {
		lines.push(`The user did not pick your recommended option (${JSON.stringify(recommendation)}). Use their answer as written.`);
	}
	lines.push(scopeLine(scope));
	return result({ status: "answered", question, answer, source, recommendation, followedRecommendation, scope }, lines);
}

/** The answer as shown in the follow-up title: an option label as is; a custom answer shortened to 60 characters. */
export function scopeTitle(answer: string, source: "option" | "custom"): string {
	const chars = [...answer]; // code points, so an emoji is never split
	const shown = source === "custom" && chars.length > SCOPE_SHOWN_MAX ? `${chars.slice(0, SCOPE_SHOWN_MAX).join("")}…` : answer;
	return `Apply "${shown}" to similar questions this session?`;
}

/** Rule 16 follow-up. Esc, an abort, an unexpected value, or a dialog error all mean "once": the answer stands. */
async function askScope(ctx: AskUserContext, signal: AbortSignal | undefined, answer: string, source: "option" | "custom"): Promise<Scope> {
	if (signal?.aborted) return "once";
	try {
		const picked = await ctx.ui.select(scopeTitle(answer, source), [...SCOPE_CHOICES], { signal });
		return picked === SCOPE_SIMILAR && !signal?.aborted ? "similar" : "once";
	} catch {
		return "once";
	}
}

// ---------------------------------------------------------------------------
// Identical sibling calls (one mechanical repeat check)
// ---------------------------------------------------------------------------
// Across turns, the model decides from the conversation whether an earlier
// answer still applies: the same question in a different task may need a
// different answer. Only identical calls fired together in ONE assistant
// message are treated as the same moment: the later one gets the earlier one's
// result without a second dialog.

/** Question normalization: flatten line breaks, trim, lower-case, collapse whitespace, drop one trailing "?". */
export function questionKey(question: string): string {
	return flatten(question)
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/\s*\?$/, "");
}

/**
 * Identity of a call: the question and the reason (normalized like questionKey)
 * and the set of option labels (trimmed, case-insensitive). The recommendation
 * and tradeoffs don't count. Works on raw tool-call arguments; returns undefined
 * when they don't have that shape (then nothing can match).
 */
export function callKey(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const { question, reason, options } = args as Record<string, unknown>;
	if (typeof question !== "string" || typeof reason !== "string" || !Array.isArray(options)) return undefined;
	const labels: string[] = [];
	for (const option of options) {
		const label = (option as { label?: unknown } | null)?.label;
		if (typeof label !== "string") return undefined;
		labels.push(labelKey(label));
	}
	return JSON.stringify([questionKey(question), questionKey(reason), [...new Set(labels)].sort()]);
}

/** The latest identical sibling in which a human decided something (answered, dismissed, empty). */
function findRepeat(params: AskUserParams, siblings: readonly SiblingResult[]): AskUserDetails | undefined {
	const key = callKey(params);
	for (let i = siblings.length - 1; i >= 0; i--) {
		const { details, call } = siblings[i]!;
		if (call !== key) continue;
		if (details.status === "answered") return details;
		if (details.status === "cancelled" && details.cancelReason !== "aborted") return details;
		// aborted / unavailable: nobody decided anything; ask normally
	}
	return undefined;
}

function repeated(question: string, earlier: AskUserDetails): AskUserResult {
	const already = "This is the same question as another ask_user call in your current response, so no second dialog was shown.";
	if (earlier.status === "answered") {
		const { answer, source, scope } = earlier;
		// Same key order as a new answer, then `repeated`.
		const details = {
			status: "answered",
			question,
			answer,
			source,
			...(earlier.recommendation !== undefined
				? { recommendation: earlier.recommendation, followedRecommendation: earlier.followedRecommendation }
				: {}),
			scope,
			repeated: true,
		} as AskUserDetails;
		return result(details, [
			"ask_user: answered",
			`Question: ${JSON.stringify(question)}`,
			`${already} The user answered it: ${JSON.stringify(answer)} (${source === "option" ? "chosen option" : "typed free text"}).`,
			"Use that answer; don't ask again about this decision in this scenario.",
			...(scope === "similar" ? [SIMILAR_TEXT] : []),
		]);
	}
	const cancelReason = earlier.status === "cancelled" ? earlier.cancelReason : "dismissed";
	return result({ status: "cancelled", question, cancelReason, repeated: true }, [
		`ask_user: cancelled (${cancelReason})`,
		`${already} The user chose not to answer it. Don't ask again about this decision in this scenario; treat it as open.`,
		NO_ANSWER_ADVICE(question),
	]);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validate, then return early when aborted, when the same question was already
 * decided by an identical sibling call in the same assistant message (`siblings`),
 * or when there is no UI; otherwise show the dialogs.
 */
export async function askUser(
	input: unknown,
	signal: AbortSignal | undefined,
	ctx: AskUserContext,
	siblings: readonly SiblingResult[] = [],
): Promise<AskUserResult> {
	const params = validate(input);
	const { question } = params;
	if (signal?.aborted) return cancelled(question, "aborted");
	const repeat = findRepeat(params, siblings);
	if (repeat) return repeated(question, repeat);
	if (!ctx.hasUI) return unavailable(question);

	// No `timeout`: an auto-dismissed dialog must never look like a human decision.
	const choices = buildChoices(params);
	const picked = await dialog(() => ctx.ui.select(buildTitle(params), choices, { signal }), signal);
	if (picked === ABORTED) return cancelled(question, "aborted");
	if (picked === undefined) return cancelled(question, "dismissed");

	const index = choices.indexOf(picked);
	if (index === -1) unexpected(picked);
	if (index < params.options.length) {
		const label = params.options[index]!.label;
		return answered(params, label, "option", await askScope(ctx, signal, label, "option"));
	}

	if (signal?.aborted) return cancelled(question, "aborted");
	const typed = await dialog(() => ctx.ui.input(question, INPUT_PLACEHOLDER, { signal }), signal);
	if (typed === ABORTED) return cancelled(question, "aborted");
	if (typed === undefined) return cancelled(question, "dismissed");
	if (typeof typed !== "string") unexpected(typed);
	if (typed.trim() === "") return cancelled(question, "empty_answer");
	return answered(params, typed, "custom", await askScope(ctx, signal, typed, "custom"));
}
