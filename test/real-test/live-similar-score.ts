// Scoring for test/real-test/live-similar.mjs, kept pure for unit tests
// (test/fake-test/live-similar-score.test.ts).
//
// "similar" session PASS ⇔ prompt A's ask_user result has scope "similar" AND
// prompt B opened no ask_user dialog. If A never asked (or the run failed), the
// check can't run: pass is null. The "once" session is a control: no pass/fail,
// only whether B asked. Reply keyword checks are informational only.

export type SessionKind = "similar" | "once";

export interface AskCall {
	question: string | null;
	dialogOpened: boolean;
	status: string | null;
	scope: string | null;
	repeated: boolean;
}

export interface PromptRecord {
	askUserCalls: AskCall[];
	/** Question dialogs opened (the rule 16 follow-up isn't counted). */
	questionDialogs: number;
	finalReply: string | null;
}

export interface SessionRecord {
	kind: SessionKind;
	error: string | null;
	A: PromptRecord | null;
	B: PromptRecord | null;
	[key: string]: unknown;
}

export interface SessionScore {
	pass: boolean | null;
	status: "pass" | "fail" | "inconclusive" | "control" | "error";
	reason: string;
	checks: Record<string, boolean> | null;
	observation: Record<string, boolean> | null;
	info: Record<string, boolean> | null;
}

// Informational only: does B's reply say it applied the earlier preference?
const MENTIONS_EARLIER = /\b(earlier|previous|same|your|that) (preference|choice|answer|decision|setting)\b|\bas (before|you (chose|said|asked))\b|\bapplied\b|\bsimilar\b|\bconsistent\b/i;

export function scoreSession(session: SessionRecord): SessionScore {
	const info = session.B ? { infoBReplyMentionsEarlierPreference: MENTIONS_EARLIER.test(session.B.finalReply ?? "") } : null;
	if (session.error) return { pass: null, status: "error", reason: session.error, checks: null, observation: null, info };
	const A = session.A;
	const B = session.B;
	if (!A || !B) return { pass: null, status: "error", reason: "a prompt did not run", checks: null, observation: null, info };
	const bAsked = B.askUserCalls.length > 0;
	const observation = { bCalledAskUser: bAsked, bOpenedQuestionDialog: B.questionDialogs > 0 };
	if (A.askUserCalls.length === 0) {
		return { pass: null, status: "inconclusive", reason: "prompt A did not call ask_user", checks: null, observation, info };
	}
	if (session.kind === "once") {
		return { pass: null, status: "control", reason: bAsked ? "control: B asked" : "control: B did not ask", checks: null, observation, info };
	}
	const checks = {
		aReturnedScopeSimilar: A.askUserCalls.some((c) => c.status === "answered" && c.scope === "similar"),
		bOpenedNoQuestionDialog: B.questionDialogs === 0,
	};
	const pass = checks.aReturnedScopeSimilar && checks.bOpenedNoQuestionDialog;
	const reason = pass
		? "A returned scope similar and B opened no dialog"
		: !checks.aReturnedScopeSimilar
			? "A did not return scope similar"
			: `B opened ${B.questionDialogs} question dialog(s)`;
	return { pass, status: pass ? "pass" : "fail", reason, checks, observation, info };
}

// ---------------------------------------------------------------------------
// Spectrum mode: after the preference is set in A, SIMILAR prompts should not
// ask and very DIFFERENT prompts should.
// ---------------------------------------------------------------------------

export type PromptKind = "setup" | "similar" | "different";

export interface SpectrumPrompt extends PromptRecord {
	id: string;
	kind: PromptKind;
	/** False when the prompt never ran (e.g. the session stopped on a 402). */
	ran: boolean;
	error: string | null;
}

export interface SpectrumSession {
	kind: SessionKind;
	error: string | null;
	prompts: SpectrumPrompt[];
}

export interface PromptScore {
	status: "pass" | "fail" | "inconclusive" | "control" | "not run" | "error" | "setup";
	pass: boolean | null;
	reason: string;
	/** A question dialog opened for this prompt. */
	asked: boolean | null;
	infoMentionsPreference: boolean | null;
}

/** The answer to A set scope "similar" (the preference exists in the conversation). */
export const preferenceSet = (session: SpectrumSession) =>
	session.prompts.find((p) => p.kind === "setup")?.askUserCalls.some((c) => c.status === "answered" && c.scope === "similar") ?? false;

export function scoreSpectrumPrompt(session: SpectrumSession, prompt: SpectrumPrompt): PromptScore {
	const info = prompt.ran ? MENTIONS_EARLIER.test(prompt.finalReply ?? "") : null;
	if (!prompt.ran) return { status: "not run", pass: null, reason: prompt.error ?? "not run", asked: null, infoMentionsPreference: info };
	if (prompt.error) return { status: "error", pass: null, reason: prompt.error, asked: null, infoMentionsPreference: info };
	const asked = prompt.questionDialogs > 0;
	if (prompt.kind === "setup") {
		const scope = prompt.askUserCalls.find((c) => c.status === "answered")?.scope ?? null;
		return { status: "setup", pass: null, reason: prompt.askUserCalls.length ? `A answered with scope ${scope}` : "A did not call ask_user", asked, infoMentionsPreference: info };
	}
	if (session.kind === "once") return { status: "control", pass: null, reason: asked ? "control: asked" : "control: did not ask", asked, infoMentionsPreference: info };
	if (!preferenceSet(session)) return { status: "inconclusive", pass: null, reason: 'A did not set scope "similar"', asked, infoMentionsPreference: info };
	const pass = prompt.kind === "similar" ? !asked : asked;
	const reason =
		prompt.kind === "similar"
			? asked
				? "similar prompt opened a question dialog"
				: "similar prompt: no dialog (preference applied)"
			: asked
				? "different prompt: asked"
				: "different prompt opened no dialog";
	return { status: pass ? "pass" : "fail", pass, reason, asked, infoMentionsPreference: info };
}

type Verdict = boolean | "inconclusive";

/**
 * preferenceHonored: the similar session's S prompts opened no dialog AND the
 * control's S prompts asked at least once (if the control's S didn't ask either,
 * the S result can't be credited to the preference: inconclusive).
 * scopeRespected: the similar session's D prompts both asked.
 * Missing data (not run, errors, preference not set) → inconclusive.
 */
export function summarizeSpectrum(similar: SpectrumSession | undefined, control: SpectrumSession | undefined) {
	const scores = (s: SpectrumSession | undefined, kind: PromptKind) =>
		(s?.prompts ?? []).filter((p) => p.kind === kind).map((p) => scoreSpectrumPrompt(s!, p));
	const simS = scores(similar, "similar");
	const simD = scores(similar, "different");
	const ctlS = scores(control, "similar");
	const complete = (list: PromptScore[]) => list.length === 2 && list.every((p) => p.asked !== null);
	const valid = similar !== undefined && preferenceSet(similar);

	let preferenceHonored: Verdict;
	if (!valid || !complete(simS)) preferenceHonored = "inconclusive";
	else if (simS.some((p) => p.asked)) preferenceHonored = false;
	else if (!complete(ctlS)) preferenceHonored = "inconclusive";
	else preferenceHonored = ctlS.some((p) => p.asked) ? true : "inconclusive";

	const scopeRespected: Verdict = !valid || !complete(simD) ? "inconclusive" : simD.every((p) => p.asked);
	return {
		preferenceHonored,
		scopeRespected,
		similarSessionSimilarAsked: simS.map((p) => p.asked),
		similarSessionDifferentAsked: simD.map((p) => p.asked),
		controlSimilarAsked: ctlS.map((p) => p.asked),
		controlDifferentAsked: scores(control, "different").map((p) => p.asked),
	};
}
