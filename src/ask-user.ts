// Core of the ask_user tool: validate the call, show Pi's built-in dialogs,
// and map the human's response to one of three results. See docs/CONTRACT.md.

/** Text of the final choice that lets the user type their own answer (shown numbered, after the options). */
export const CUSTOM_ANSWER_LABEL = "Write my own answer";

/** Put right after the recommended option's number, in the title and in its choice. */
export const RECOMMENDED_MARK = "[Recommended] ";

const INPUT_PLACEHOLDER = "Type your answer";

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
	  }
	| { status: "cancelled"; question: string; cancelReason: CancelReason }
	| { status: "unavailable"; question: string };

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
	dismissed: "The user closed the question without answering.",
	empty_answer: "The user submitted an empty custom answer.",
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
		"No interactive UI is available in this mode, so the user could not be asked.",
		NO_ANSWER_ADVICE(question),
	]);
}

function answered(params: AskUserParams, answer: string, source: "option" | "custom"): AskUserResult {
	const { question, recommendation } = params;
	const lines = [`ask_user: answered`, `Question: ${JSON.stringify(question)}`];
	if (source === "option") lines.push(`The user chose the option ${JSON.stringify(answer)}.`);
	else lines.push(`The user typed a free-text answer instead of choosing an option: ${JSON.stringify(answer)}`);

	if (recommendation === undefined) {
		return result({ status: "answered", question, answer, source }, lines);
	}
	const followedRecommendation = source === "option" && answer === recommendation;
	if (followedRecommendation) {
		lines.push("This is the option you recommended.");
	} else if (source === "option") {
		lines.push(`This is not the option you recommended (${JSON.stringify(recommendation)}). Use the user's choice.`);
	} else {
		lines.push(`The user did not pick your recommended option (${JSON.stringify(recommendation)}). Use their answer as written.`);
	}
	return result({ status: "answered", question, answer, source, recommendation, followedRecommendation }, lines);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function askUser(input: unknown, signal: AbortSignal | undefined, ctx: AskUserContext): Promise<AskUserResult> {
	const params = validate(input);
	const { question } = params;
	if (signal?.aborted) return cancelled(question, "aborted");
	if (!ctx.hasUI) return unavailable(question);

	// No `timeout`: an auto-dismissed dialog must never look like a human decision.
	const choices = buildChoices(params);
	const picked = await dialog(() => ctx.ui.select(buildTitle(params), choices, { signal }), signal);
	if (picked === ABORTED) return cancelled(question, "aborted");
	if (picked === undefined) return cancelled(question, "dismissed");

	const index = choices.indexOf(picked);
	if (index === -1) unexpected(picked);
	if (index < params.options.length) return answered(params, params.options[index]!.label, "option");

	if (signal?.aborted) return cancelled(question, "aborted");
	const typed = await dialog(() => ctx.ui.input(question, INPUT_PLACEHOLDER, { signal }), signal);
	if (typed === ABORTED) return cancelled(question, "aborted");
	if (typed === undefined) return cancelled(question, "dismissed");
	if (typeof typed !== "string") unexpected(typed);
	if (typed.trim() === "") return cancelled(question, "empty_answer");
	return answered(params, typed, "custom");
}
