// Scoring for test/real-test/live-answers.mjs, kept pure so it can rescore a
// saved results file and be unit-tested (test/fake-test/live-answers-score.test.ts).
//
// Pass/fail is objective:
//   custom         - ask_user returned exactly the typed text as a custom answer.
//   cancel / empty - the first ask_user result is cancelled with the expected
//                    reason, no answer came back, and the agent wrote no files
//                    after that cancelled result (for this prompt nothing can be
//                    built without the decision).
// Keyword checks on the final reply are kept as `info*` fields only; they
// misjudged replies in both directions and never decide pass/fail.

export const CUSTOM_TEXT = "Play a short sound and show a banner, but never auto-restart";
export const MODES = ["custom", "cancel", "empty"] as const;
export type Mode = (typeof MODES)[number];

export interface RecordedToolCall {
	name: string;
	args: string | null;
	isError: boolean | null;
	result: string | null;
	path?: string | null;
}

export interface RecordedRun {
	mode: Mode;
	asked: boolean;
	error: string | null;
	askUserResults: { isError: boolean; firstLine: string; details: Record<string, unknown> | null }[];
	toolCalls: RecordedToolCall[];
	finalReply: string | null;
	usage?: { totalTokens?: number } | null;
	[key: string]: unknown;
}

export interface Write {
	tool: string;
	path: string | null;
	toolCallIndex: number;
	when: "before the cancelled ask_user result" | "after the cancelled ask_user result" | "no cancelled ask_user result";
}

export interface Score {
	checks: Record<string, boolean> | null;
	info: Record<string, boolean> | null;
	writes: Write[];
	pass: boolean;
}

const FILE_TOOLS = new Set(["write", "edit"]);

/** The file a write/edit call touched: recorded path, else from its args, else from its result line. */
export function pathOf(call: RecordedToolCall): string | null {
	if (typeof call.path === "string") return call.path;
	if (call.args) {
		try {
			const parsed = JSON.parse(call.args) as { path?: unknown };
			if (typeof parsed.path === "string") return parsed.path;
		} catch {
			// args were shortened; fall through
		}
		const inArgs = /"path":"((?:[^"\\]|\\.)*)"/.exec(call.args);
		if (inArgs) return JSON.parse(`"${inArgs[1]}"`);
	}
	const inResult = call.result ? /\b(?:wrote to|in) (\S+)\s*$/.exec(call.result) : null;
	return inResult ? inResult[1]! : null;
}

/** Successful write/edit calls, each placed before or after the first cancelled ask_user result. */
export function writesRelativeToCancel(run: RecordedRun): Write[] {
	let askIndex = 0;
	let cancelAt = -1;
	run.toolCalls.forEach((call, i) => {
		if (call.name !== "ask_user") return;
		const result = run.askUserResults[askIndex++];
		if (cancelAt === -1 && result && !result.isError && result.details?.status === "cancelled") cancelAt = i;
	});
	return run.toolCalls.flatMap((call, i): Write[] =>
		FILE_TOOLS.has(call.name) && call.isError === false
			? [
					{
						tool: call.name,
						path: pathOf(call),
						toolCallIndex: i,
						when: cancelAt === -1 ? "no cancelled ask_user result" : i > cancelAt ? "after the cancelled ask_user result" : "before the cancelled ask_user result",
					},
				]
			: [],
	);
}

// Informational only.
const MENTIONS_OPEN = /\b(still open|remains open|is open|undecided|not (yet )?decided|haven'?t decided|unresolved|let me know|which (option|one|would you)|your (choice|preference|decision)|once you (decide|choose|pick)|when you decide|you can (choose|decide|pick)|needs? your (input|decision))\b/i;
const CLAIMS_DECISION = /\b(I('ve| have)? (chose|chosen|picked|went with|decided)|I'll (go with|use)|defaulted to|by default I|I assumed)\b/i;
const REFLECTS_CUSTOM = (reply: string) => /sound|audio|beep|chime/i.test(reply) && /banner|notification/i.test(reply) && /restart/i.test(reply);

export function scoreRun(run: RecordedRun): Score {
	const writes = writesRelativeToCancel(run);
	if (!run.asked || run.error) return { checks: null, info: null, writes, pass: false };
	const results = run.askUserResults.filter((r) => !r.isError).map((r) => r.details ?? {});
	const reply = run.finalReply ?? "";
	let checks: Record<string, boolean>;
	let info: Record<string, boolean>;
	if (run.mode === "custom") {
		checks = {
			askUserCalled: run.asked,
			exactCustomAnswerReturned: results.some((d) => d.status === "answered" && d.source === "custom" && d.answer === CUSTOM_TEXT),
		};
		info = { infoReplyReflectsAnswer: REFLECTS_CUSTOM(reply) };
	} else {
		const reason = run.mode === "cancel" ? "dismissed" : "empty_answer";
		checks = {
			[`firstResultCancelled_${reason}`]: results[0]?.status === "cancelled" && results[0]?.cancelReason === reason,
			noAnswerReturned: !results.some((d) => d.status === "answered"),
			noFilesWrittenAfterCancel: !writes.some((w) => w.when === "after the cancelled ask_user result"),
		};
		info = { infoReplyMentionsOpen: MENTIONS_OPEN.test(reply), infoReplyDoesNotClaimDecision: !CLAIMS_DECISION.test(reply) };
	}
	return { checks, info, writes, pass: Object.values(checks).every(Boolean) };
}

/** Per-mode status (from each mode's last attempt) and totals. */
export function summarizeModes(runs: (RecordedRun & { pass: boolean })[]) {
	const modes = MODES.map((mode) => {
		const attempts = runs.filter((r) => r.mode === mode);
		const last = attempts.at(-1);
		const status = !last ? "not run" : last.error ? "error" : !last.asked ? "did not ask" : last.pass ? "pass" : "fail";
		return { mode, status, attempts: attempts.length };
	});
	const totals = {
		modes: MODES.length,
		passed: modes.filter((m) => m.status === "pass").length,
		failed: modes.filter((m) => m.status === "fail").length,
		didNotAsk: modes.filter((m) => m.status === "did not ask").length,
		errors: modes.filter((m) => m.status === "error" || m.status === "not run").length,
		modelRuns: runs.length,
		totalTokens: runs.reduce((sum, r) => sum + (r.usage?.totalTokens ?? 0), 0),
	};
	return { modes, totals };
}

/** Put the score fields after the run's recorded fields, replacing any older ones. */
export function withScore<T extends RecordedRun>(run: T) {
	const { checks: _c, info: _i, writes: _w, pass: _p, ...recorded } = run as T & Partial<Score>;
	return { ...recorded, ...scoreRun(recorded as unknown as RecordedRun) };
}
