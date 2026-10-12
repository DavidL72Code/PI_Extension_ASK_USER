// Scoring for test/real-test/live-similar.mjs, on fake session records.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	scoreSession,
	scoreSpectrumPrompt,
	summarizeSpectrum,
	type AskCall,
	type PromptRecord,
	type SessionRecord,
	type SpectrumPrompt,
	type SpectrumSession,
} from "../real-test/live-similar-score.ts";

const call = (over: Partial<AskCall> = {}): AskCall => ({ question: "Persist reminders?", dialogOpened: true, status: "answered", scope: "once", repeated: false, ...over });
const prompt = (calls: AskCall[], reply = "done", questionDialogs = calls.filter((c) => c.dialogOpened).length): PromptRecord => ({ askUserCalls: calls, questionDialogs, finalReply: reply });
const session = (kind: SessionRecord["kind"], A: PromptRecord | null, B: PromptRecord | null, error: string | null = null): SessionRecord => ({ kind, error, A, B });

describe("live-similar scoring", () => {
	test("similar: A scoped similar and B opened no dialog → pass", () => {
		const s = scoreSession(session("similar", prompt([call({ scope: "similar" })]), prompt([], "I applied your earlier preference (session only).")));
		assert.equal(s.pass, true);
		assert.equal(s.status, "pass");
		assert.deepEqual(s.checks, { aReturnedScopeSimilar: true, bOpenedNoQuestionDialog: true });
		assert.equal(s.info!.infoBReplyMentionsEarlierPreference, true);
	});

	test("similar: B opened a dialog → fail", () => {
		const s = scoreSession(session("similar", prompt([call({ scope: "similar" })]), prompt([call({ question: "Persist the water reminder?" })])));
		assert.equal(s.pass, false);
		assert.match(s.reason, /B opened 1 question dialog/);
	});

	test("similar: B called ask_user but got a repeated result without a dialog → still pass", () => {
		const s = scoreSession(session("similar", prompt([call({ scope: "similar" })]), prompt([call({ dialogOpened: false, repeated: true, scope: "similar" })])));
		assert.equal(s.pass, true);
		assert.equal(s.observation!.bCalledAskUser, true);
	});

	test("similar: A answered but the follow-up gave once → fail", () => {
		const s = scoreSession(session("similar", prompt([call({ scope: "once" })]), prompt([])));
		assert.equal(s.pass, false);
		assert.match(s.reason, /did not return scope similar/);
	});

	test("A never asked → inconclusive (pass null), not a fail", () => {
		const s = scoreSession(session("similar", prompt([]), prompt([])));
		assert.equal(s.pass, null);
		assert.equal(s.status, "inconclusive");
	});

	test("once is a control: no pass/fail, records whether B asked", () => {
		const asked = scoreSession(session("once", prompt([call()]), prompt([call({ question: "Persist the water reminder?" })])));
		assert.equal(asked.pass, null);
		assert.equal(asked.status, "control");
		assert.deepEqual(asked.observation, { bCalledAskUser: true, bOpenedQuestionDialog: true });
		const notAsked = scoreSession(session("once", prompt([call()]), prompt([])));
		assert.equal(notAsked.reason, "control: B did not ask");
	});

	test("errors and missing prompts → status error, pass null", () => {
		assert.equal(scoreSession(session("similar", prompt([call({ scope: "similar" })]), null, "assistant error: 402")).status, "error");
		assert.equal(scoreSession(session("similar", prompt([call({ scope: "similar" })]), null)).status, "error");
	});

	test("the reply keyword check is informational only", () => {
		const s = scoreSession(session("similar", prompt([call({ scope: "similar" })]), prompt([], "Done.")));
		assert.equal(s.info!.infoBReplyMentionsEarlierPreference, false);
		assert.equal(s.pass, true);
	});
});

describe("live-similar scoring: spectrum", () => {
	const sp = (id: string, kind: SpectrumPrompt["kind"], asked: boolean | "not run", extra: Partial<SpectrumPrompt> = {}): SpectrumPrompt => ({
		id,
		kind,
		ran: asked !== "not run",
		error: asked === "not run" ? "not run" : null,
		askUserCalls: asked === true ? [call({ question: `${id}?` })] : [],
		questionDialogs: asked === true ? 1 : 0,
		finalReply: "done",
		...extra,
	});
	const setup = (scope: "similar" | "once" | null) =>
		sp("A", "setup", scope !== null, scope ? { askUserCalls: [call({ scope })], questionDialogs: 1 } : { askUserCalls: [], questionDialogs: 0 });
	const sessionOf = (kind: SpectrumSession["kind"], scope: "similar" | "once" | null, s1: boolean | "not run", d1: boolean | "not run", s2: boolean | "not run", d2: boolean | "not run"): SpectrumSession => ({
		kind,
		error: null,
		prompts: [setup(scope), sp("S1", "similar", s1), sp("D1", "different", d1), sp("S2", "similar", s2), sp("D2", "different", d2)],
	});

	test("similar session: S passes without a dialog, D passes with one", () => {
		const s = sessionOf("similar", "similar", false, true, true, false);
		const [, s1, d1, s2, d2] = s.prompts.map((p) => scoreSpectrumPrompt(s, p));
		assert.deepEqual([s1!.status, d1!.status, s2!.status, d2!.status], ["pass", "pass", "fail", "fail"]);
	});

	test("control prompts are observations, not pass/fail", () => {
		const s = sessionOf("once", "once", true, true, false, true);
		const scores = s.prompts.slice(1).map((p) => scoreSpectrumPrompt(s, p));
		assert.ok(scores.every((x) => x.status === "control" && x.pass === null));
		assert.deepEqual(scores.map((x) => x.asked), [true, true, false, true]);
	});

	test("preference not set in A → the similar session's prompts are inconclusive", () => {
		const s = sessionOf("similar", "once", false, true, false, true);
		assert.ok(s.prompts.slice(1).every((p) => scoreSpectrumPrompt(s, p).status === "inconclusive"));
		assert.equal(summarizeSpectrum(s, sessionOf("once", "once", true, true, true, true)).preferenceHonored, "inconclusive");
	});

	test("preferenceHonored: true only when the control's S asked at least once", () => {
		const sim = sessionOf("similar", "similar", false, true, false, true);
		assert.equal(summarizeSpectrum(sim, sessionOf("once", "once", true, true, false, true)).preferenceHonored, true);
		assert.equal(summarizeSpectrum(sim, sessionOf("once", "once", false, true, false, true)).preferenceHonored, "inconclusive");
		assert.equal(summarizeSpectrum(sessionOf("similar", "similar", true, true, false, true), sessionOf("once", "once", true, true, true, true)).preferenceHonored, false);
	});

	test("scopeRespected: both D prompts asked in the similar session", () => {
		const control = sessionOf("once", "once", true, true, true, true);
		assert.equal(summarizeSpectrum(sessionOf("similar", "similar", false, true, false, true), control).scopeRespected, true);
		assert.equal(summarizeSpectrum(sessionOf("similar", "similar", false, true, false, false), control).scopeRespected, false);
	});

	test("prompts that didn't run (402 mid-session) → not run, and the summary is inconclusive", () => {
		const sim = sessionOf("similar", "similar", false, true, "not run", "not run");
		assert.equal(scoreSpectrumPrompt(sim, sim.prompts[3]!).status, "not run");
		const summary = summarizeSpectrum(sim, undefined);
		assert.equal(summary.preferenceHonored, "inconclusive");
		assert.equal(summary.scopeRespected, "inconclusive");
		assert.deepEqual(summary.similarSessionSimilarAsked, [false, null]);
	});

	test("a repeated ask_user result without a dialog counts as not asked", () => {
		const s = sessionOf("similar", "similar", false, true, false, true);
		s.prompts[1] = { ...s.prompts[1]!, askUserCalls: [call({ dialogOpened: false, repeated: true })], questionDialogs: 0 };
		assert.equal(scoreSpectrumPrompt(s, s.prompts[1]!).status, "pass");
	});
});
