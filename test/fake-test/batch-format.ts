// Console output for the batch report (./batch.ts). By default one readable
// block per scenario: the question, the choices shown, what the simulated user
// did, and what came back. With --compact, one line per scenario. Display only:
// long text is shortened with … here, never in results.json. Pure, so
// ./batch-format.test.ts can check it without running the batch.

import { CUSTOM_ANSWER_LABEL, callKey } from "../../src/ask-user.ts";

/** How the simulated human answers the rule 16 follow-up (default "once": Enter on "Just this time"). */
export type FollowUp = "once" | "similar" | "esc" | "unexpected" | "abort";

/** What the simulated human (or client) does. Choice numbers are the 1-based numbers shown in the menu. */
export type UserAction =
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

/** One dialog as the fake ctx recorded it ("scope" is the rule 16 follow-up). */
export type ShownDialog = { method: string; title?: string; choices?: string[]; placeholder?: string };

/** One ask_user call: its input, what the user did, the dialogs that opened, and what came back. */
export interface CallView {
	input: unknown;
	user: UserAction;
	followUp?: FollowUp;
	dialogs: ShownDialog[];
	/** `{ status, details, firstLine }` for a result, `{ error }` for a thrown error. */
	outcome: Record<string, unknown>;
}

/** The earlier call of a repeat scenario: a sibling in the same response or a call in an earlier turn. */
export interface EarlierView extends CallView {
	sameMessage: boolean;
	saved: boolean;
}

export interface ScenarioView {
	name: string;
	category: string;
	pass: boolean;
	mismatches: string[];
	call: CallView;
	earlier?: EarlierView;
}

// Display limits (characters, … included).
const MAX = { question: 90, choice: 45, label: 40, text: 50, answer: 60, error: 160 };
const INDENT = " ".repeat(6);
const LABEL_WIDTH = 10;

/** Shorten to at most `max` characters (code points, so an emoji is never split), ending in … when cut. */
export function clip(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** A value in quotes with escapes visible (spaces, tabs, line breaks), shortened first. */
const quote = (text: string, max: number) => JSON.stringify(clip(text, max));

const DIALOG_NAME: Record<string, string> = { select: "menu", input: "text box", scope: "follow-up" };
const dialogNames = (dialogs: ShownDialog[]) => dialogs.map((d) => DIALOG_NAME[d.method] ?? d.method);

/** The question as shown (first line of the menu or text box title), else the call's own. */
export function describeQuestion(call: CallView): string {
	const shown = call.dialogs.find((d) => d.method === "select" || d.method === "input")?.title?.split("\n")[0];
	if (shown) return clip(shown, MAX.question);
	const question = (call.input as { question?: unknown } | null)?.question;
	if (typeof question !== "string") return "—";
	const flat = question.replace(/\s+/g, " ").trim();
	return flat ? clip(flat, MAX.question) : JSON.stringify(question);
}

/** The menu's choices as shown, else the call's option labels exactly as given. */
export function describeChoices(call: CallView): string {
	const menu = call.dialogs.find((d) => d.method === "select");
	if (menu?.choices) return menu.choices.map((choice) => clip(choice, MAX.choice)).join(" | ");
	const options = (call.input as { options?: unknown } | null)?.options;
	const labels = Array.isArray(options)
		? options.map((o) => {
				const label = (o as { label?: unknown } | null)?.label;
				return typeof label === "string" ? quote(label, MAX.label) : "—";
			})
		: [];
	return labels.length ? `none shown — the call's options: ${labels.join(", ")}` : "none shown";
}

const CUSTOM = JSON.stringify(CUSTOM_ANSWER_LABEL);

function actionText(action: UserAction): string {
	switch (action.kind) {
		case "pick":
			return `picks choice ${action.choice}`;
		case "type":
			return `picks ${CUSTOM}, types ${quote(action.text, MAX.text)}`;
		case "escMenu":
			return "presses Esc on the menu";
		case "escTextBox":
			return `picks ${CUSTOM}, then Esc in the text box`;
		case "abortBefore":
			return "run aborted before the tool starts";
		case "abortInMenu":
			return "run aborted while the menu is open";
		case "abortInTextBox":
			return `picks ${CUSTOM}, then the run is aborted while the text box is open`;
		case "menuReturns":
			return `client returns ${quote(action.value, MAX.text)} from the menu (not a displayed choice)`;
		case "noUI":
			return "no UI";
		case "none":
			return "";
	}
}

const FOLLOW_UP_TEXT: Record<FollowUp, string> = {
	once: '"Just this time"',
	similar: '"Also for similar questions this session"',
	esc: "Esc on the follow-up",
	unexpected: 'the client returns "2. Also for similar" on the follow-up (not a choice)',
	abort: "the run is aborted while the follow-up is open",
};

/** Actions that open no dialog by design. */
const NO_DIALOG: ReadonlySet<UserAction["kind"]> = new Set(["abortBefore", "noUI", "none"]);

/** What the user did, judged by the dialogs that actually opened. `showDialogs` names them. */
export function describeUser(call: CallView, showDialogs = false): string {
	const opened = dialogNames(call.dialogs);
	const action = actionText(call.user);
	if (opened.length === 0) {
		if (NO_DIALOG.has(call.user.kind) && action) return `${action} — no dialog opened`;
		const details = call.outcome.details as { repeated?: unknown } | undefined;
		return details?.repeated === true ? "no dialog opened; got the earlier call's result" : "no dialog opened";
	}
	// A dialog opened although none should have: say so rather than describe an action that never happened.
	if (NO_DIALOG.has(call.user.kind)) return `${action || "nothing to answer"}, yet opened: ${opened.join(", ")}`;
	let text = action;
	if (opened.includes("follow-up")) text += `, then ${FOLLOW_UP_TEXT[call.followUp ?? "once"]}`;
	if (showDialogs) text += ` (opened: ${opened.join(", ")})`;
	return text;
}

/** What came back: the result's first line plus the answer, or the error. */
export function describeResult(call: CallView): string {
	const { outcome } = call;
	if (typeof outcome.error === "string") {
		const error = clip(outcome.error, MAX.error);
		return call.dialogs.length === 0 ? `rejected before any dialog: ${error}` : `error after the ${dialogNames(call.dialogs).join(", ")}: ${error}`;
	}
	const details = (outcome.details ?? {}) as Record<string, unknown>;
	const firstLine = typeof outcome.firstLine === "string" ? outcome.firstLine : `ask_user: ${String(details.status ?? "—")}`;
	const repeated = details.repeated === true;
	if (details.status === "answered") {
		const tags = [String(details.source ?? "—")];
		if (details.source === "option" && details.followedRecommendation === true) tags.push("recommended");
		if (details.source === "option" && details.followedRecommendation === false) tags.push("not recommended");
		tags.push(`scope ${String(details.scope ?? "—")}`);
		if (repeated) tags.push("repeated");
		const answer = typeof details.answer === "string" ? quote(details.answer, MAX.answer) : "—";
		return `${firstLine} → ${answer} (${tags.join(", ")})`;
	}
	if (details.status === "cancelled" || details.status === "unavailable") return `${firstLine} — no answer${repeated ? " (repeated)" : ""}`;
	return firstLine;
}

/** How the earlier call relates to this one, judged like the tool's sibling check (question, reason, labels). */
export function describeRelation(earlier: unknown, current: unknown): string {
	const a = callKey(earlier);
	const b = callKey(current);
	if (a === undefined || b === undefined) return "another call";
	if (a === b) return "identical";
	const [qa, ra, la] = JSON.parse(a) as [string, string, string[]];
	const [qb, rb, lb] = JSON.parse(b) as [string, string, string[]];
	const otherOptions = JSON.stringify(la) !== JSON.stringify(lb);
	if (qa !== qb) return otherOptions ? "another question, other options" : "another question";
	if (ra !== rb) return otherOptions ? "same question, another reason, other options" : "same question, another reason";
	return "same question and reason, other options";
}

const line = (label: string, text: string) => `${INDENT}${label.padEnd(LABEL_WIDTH)}${text}`;
const more = (text: string) => `${INDENT}${" ".repeat(LABEL_WIDTH)}${text}`;

export function formatHeader(view: ScenarioView, width: number): string {
	return `${view.pass ? "PASS" : "FAIL"}  ${view.category.padEnd(width)}  ${view.name}`;
}

/** Today's one-line format: the header, then each mismatch of a failing scenario. */
export function formatCompact(view: ScenarioView, width: number): string[] {
	return [formatHeader(view, width), ...view.mismatches.map((problem) => `${INDENT}- ${problem}`)];
}

/** One readable block. Repeat scenarios first show the earlier call, then name the dialogs of both. */
export function formatBlock(view: ScenarioView, width: number): string[] {
	const lines = [formatHeader(view, width)];
	const { earlier, call } = view;
	if (earlier) {
		const where = earlier.sameMessage ? "a sibling call in the same response" : "a call in an earlier turn";
		lines.push(
			line("Earlier:", `${where}: ${describeRelation(earlier.input, call.input)}${earlier.saved ? "" : " (its result not saved yet)"}`),
			more(describeUser(earlier, true)),
			more(`result: ${describeResult(earlier)}`),
		);
	}
	lines.push(
		line("Question:", describeQuestion(call)),
		line("Choices:", describeChoices(call)),
		line("User:", describeUser(call, earlier !== undefined)),
		line("Result:", describeResult(call)),
		...view.mismatches.map((problem) => line("Mismatch:", problem)),
	);
	return lines;
}

/** The report's lines before the totals: blocks separated by a blank line, then any failures again (or compact lines). */
export function formatReport(views: ScenarioView[], compact: boolean): string[] {
	const width = Math.max(0, ...views.map((v) => v.category.length));
	if (compact) return views.flatMap((v) => formatCompact(v, width));
	const lines = views.flatMap((v, i) => [...(i > 0 ? [""] : []), ...formatBlock(v, width)]);
	const failed = views.filter((v) => !v.pass);
	if (failed.length) lines.push("", "Failed:", ...failed.map((v) => formatHeader(v, width)));
	return lines;
}
