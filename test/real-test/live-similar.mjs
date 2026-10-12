#!/usr/bin/env node
// Live checks that the MODEL honors "Also for similar questions this session"
// (spends model credits): `npm run test:live-similar -- [--mode spectrum|pair]`.
//
// Two sessions, "similar" and "once" (control), each ONE Pi RPC process, so the
// first answer stays in the conversation. Same fair setup as live-answers: fresh
// temp folder, tools ask_user/read/write/edit, sandbox guard, capped max tokens.
// Prompt A sets the preference: its question gets the [Recommended] choice (else
// 1); its follow-up gets "2. Also for similar questions this session" (session
// "similar") or "1. Just this time" (control). Every later dialog gets
// [Recommended] (else 1) and "Just this time".
//
// --mode spectrum (default): A, then S1 D1 S2 D2 — SIMILAR prompts (same kind of
//   decision: how to notify me) and very DIFFERENT ones. The folder is emptied
//   after every prompt so leftover files can't settle the next decision. In the
//   similar session, S passes when no question dialog opens, D when one does; the
//   control records asked/not. Summary: preferenceHonored, scopeRespected
//   (live-similar-score.ts). Writes test/real-test/live-similar/results.json.
// --mode pair: A, then one similar prompt B, folder kept. Writes results-pair.json.
//
// No retries except one rerun of a session after an environment failure; stops
// on a credit/auth error and keeps the partial results. Exit 1 on errors or failed checks.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	FAIR_EXTENSIONS,
	FAIR_TOOLS,
	FATAL,
	ROOT,
	SCOPE_CHOICES,
	commandLine,
	cut,
	firstLineOf,
	isRecommendedChoice,
	isScopeFollowUp,
	runSessionSandboxed,
	sumUsage,
	summarizeToolCalls,
} from "./pi-rpc.mjs";
import { scoreSession, scoreSpectrumPrompt, summarizeSpectrum } from "./live-similar-score.ts";

const USAGE = "usage: npm run test:live-similar -- [--mode spectrum|pair]";
const argv = process.argv.slice(2);
const MODE = argv.length === 0 ? "spectrum" : argv[0] === "--mode" && argv.length === 2 ? argv[1] : undefined;
if (!["spectrum", "pair"].includes(MODE)) {
	console.error(`unrecognized arguments ${JSON.stringify(argv)} (${USAGE})`);
	process.exit(2);
}

const SPECTRUM = [
	{ id: "A", kind: "setup", text: "Add a reminder that pings me after 30 minutes of work." },
	{ id: "S1", kind: "similar", text: "Add a timer that tells me when my coffee is ready in 4 minutes." },
	{ id: "D1", kind: "different", text: "Write a script that cleans up old log files in ./logs." },
	{ id: "S2", kind: "similar", text: "Make a script that alerts me when a long download finishes." },
	{ id: "D2", kind: "different", text: "Make a script that backs up my Documents folder." },
];
const PAIR = [
	{ id: "A", kind: "setup", text: "Add a reminder that pings me after 30 minutes of work." },
	{ id: "B", kind: "similar", text: "Now add another reminder that pings me every 2 hours to drink water." },
];
const PLAN = MODE === "spectrum" ? SPECTRUM : PAIR;
const SESSIONS = ["similar", "once"];
const MAX_QUESTIONS = 3; // per prompt; follow-ups don't count
const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 180_000);
const DEFAULT_MODEL = "openrouter/moonshotai/kimi-k2.6 (user default)";
const OUT_FILE =
	process.env.LIVE_RESULTS_FILE ?? path.join(ROOT, "test", "real-test", "live-similar", MODE === "spectrum" ? "results.json" : "results-pair.json");

/** Dialog answers: A's follow-up gets the session's choice, every other follow-up "Just this time". */
function answerer(kind) {
	return (request, { prompt, earlier }) => {
		if (isScopeFollowUp(request)) return { value: prompt === 0 && kind === "similar" ? SCOPE_CHOICES[1] : SCOPE_CHOICES[0] };
		const questions = earlier.filter((d) => !isScopeFollowUp(d.request)).length + 1;
		if (request.method !== "select" || questions > MAX_QUESTIONS) return { cancelled: true };
		return { value: request.options.find(isRecommendedChoice) ?? request.options[0] };
	};
}

function promptRecord(seg, filesBefore, filesAfter) {
	if (!seg) return null;
	const ends = new Map(seg.toolResults.map((r) => [r.toolCallId, r]));
	const isQuestion = (d) => !isScopeFollowUp(d.request);
	const askUserCalls = seg.toolCalls
		.filter((c) => c.toolName === "ask_user")
		.map((c) => {
			const end = ends.get(c.toolCallId);
			const details = end?.result?.details ?? null;
			const own = seg.dialogs.filter((d) => d.askCall === c.toolCallId);
			const question = own.find(isQuestion);
			const follow = own.find((d) => !isQuestion(d));
			return {
				question: typeof c.args?.question === "string" ? c.args.question : null,
				dialogOpened: Boolean(question),
				status: end ? (end.isError ? "error" : (details?.status ?? null)) : null,
				scope: details?.scope ?? null,
				repeated: details?.repeated === true,
				firstLine: end ? firstLineOf(end.result) : null,
				choices: question?.request.options ?? null,
				picked: question ? (question.response.cancelled ? "(dismissed)" : question.response.value) : null,
				followUpPicked: follow ? (follow.response.cancelled ? "(dismissed)" : follow.response.value) : null,
				answer: details?.answer ?? null,
			};
		});
	const before = new Set(filesBefore ?? []);
	const last = seg.assistantMessages.at(-1);
	return {
		askUserCalls,
		questionDialogs: seg.dialogs.filter(isQuestion).length,
		dialogs: seg.dialogs.map((d) => ({
			kind: isQuestion(d) ? "question" : "follow-up",
			title: String(d.request.title ?? "").split("\n")[0],
			options: d.request.options ?? null,
			sent: d.response.cancelled ? "(dismissed)" : d.response.value,
		})),
		toolCalls: summarizeToolCalls(seg),
		filesInFolderAfter: filesAfter ?? null,
		newFiles: (filesAfter ?? []).filter((f) => !before.has(f)),
		lastStopReason: last ? last.stopReason : null,
		finalReply: cut(seg.finalText, 2000),
		usage: sumUsage(seg.assistantMessages),
		error: seg.error ?? null,
		durationMs: seg.durationMs ?? null,
	};
}

/** Run one session; one rerun after an environment failure. */
async function runOne(kind) {
	const attempts = [];
	let result;
	for (let attempt = 1; attempt <= 2; attempt++) {
		const { session, filesAfter, deletedAfter } = await runSessionSandboxed(
			PLAN.map((p) => p.text),
			answerer(kind),
			TIMEOUT_MS,
			{ clearAfterEach: MODE === "spectrum" },
		);
		const error = session.error ?? session.segments.find((s) => s.error)?.error ?? (session.segments.length < PLAN.length ? "a prompt did not finish" : undefined);
		attempts.push({ error: error ?? null, promptsCompleted: session.segments.filter((s) => !s.error).length });
		result = { session, filesAfter, deletedAfter, error };
		if (!error || FATAL.test(error)) break;
		if (attempt === 1) console.log(`RETRY ${kind} (whole session) after an environment failure: ${error}`);
	}
	return { ...result, attempts };
}

const sessions = [];
let model;
let stop;

for (const kind of SESSIONS) {
	if (stop) {
		sessions.push({ kind, error: `not run: ${stop}`, attempts: [], prompts: [] });
		console.log(`ERROR ${kind}: not run (${stop})`);
		continue;
	}
	const { session, filesAfter, deletedAfter, error, attempts } = await runOne(kind);
	model ??= session.model;
	if (error && FATAL.test(error)) stop = `stopped after a credit/auth error in session ${kind}`;

	if (MODE === "pair") {
		const A = promptRecord(session.segments[0], [], filesAfter[0]);
		const B = promptRecord(session.segments[1], filesAfter[0], filesAfter[1]);
		const record = { kind, error: error ?? null, attempts, A, B, totalTokens: [A, B].reduce((sum, p) => sum + (p?.usage?.totalTokens ?? 0), 0) };
		const scored = { ...record, ...scoreSession(record) };
		sessions.push(scored);
		console.log(`${scored.status.toUpperCase().padEnd(12)} ${kind.padEnd(7)} ${scored.reason}`);
		continue;
	}

	const prompts = PLAN.map((p, i) => {
		const seg = session.segments[i];
		const rec = promptRecord(seg, [], filesAfter[i]);
		const ran = Boolean(seg);
		return {
			id: p.id,
			kind: p.kind,
			text: p.text,
			ran,
			...(rec ?? { askUserCalls: [], questionDialogs: 0, finalReply: null, usage: null }),
			error: rec?.error ?? (ran ? null : (error ?? "not run")),
			deletedAfter: deletedAfter[i] ?? [],
		};
	});
	const record = { kind, error: error ?? null, attempts, prompts };
	const scoredPrompts = prompts.map((p) => ({ ...p, ...scoreSpectrumPrompt(record, p) }));
	const totalTokens = prompts.reduce((sum, p) => sum + (p.usage?.totalTokens ?? 0), 0);
	sessions.push({ ...record, prompts: scoredPrompts, totalTokens });
	for (const p of scoredPrompts) {
		const calls = p.askUserCalls.map((c) => `${JSON.stringify(c.question)}${c.dialogOpened ? "" : " (no dialog)"}${c.repeated ? " (repeated)" : ""}`).join("; ");
		console.log(`${p.status.toUpperCase().padEnd(12)} ${kind.padEnd(7)} ${p.id.padEnd(2)} ${p.kind.padEnd(9)} asked=${p.asked} ${calls ? `[${calls}] ` : ""}— ${p.reason}`);
	}
}

const totalTokens = sessions.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0);
const errors = sessions.filter((s) => s.error).length;
let totals;
let failed;
if (MODE === "pair") {
	const similar = sessions.find((s) => s.kind === "similar");
	const control = sessions.find((s) => s.kind === "once");
	totals = {
		sessions: sessions.length,
		similarStatus: similar?.status ?? "not run",
		similarPass: similar?.pass ?? null,
		controlBCalledAskUser: control?.observation?.bCalledAskUser ?? null,
		controlBOpenedDialog: control?.observation?.bOpenedQuestionDialog ?? null,
		errors,
		totalTokens,
	};
	failed = totals.similarStatus === "fail";
} else {
	const summary = summarizeSpectrum(
		sessions.find((s) => s.kind === "similar"),
		sessions.find((s) => s.kind === "once"),
	);
	const promptsScored = sessions.flatMap((s) => s.prompts).filter((p) => p.pass !== null);
	totals = {
		sessions: sessions.length,
		...summary,
		promptChecks: { passed: promptsScored.filter((p) => p.pass).length, failed: promptsScored.filter((p) => !p.pass).length },
		errors,
		retries: sessions.reduce((sum, s) => sum + Math.max(0, (s.attempts?.length ?? 0) - 1), 0),
		totalTokens,
	};
	failed = totals.promptChecks.failed > 0;
}

const report = {
	generatedAt: new Date().toISOString(),
	mode: MODE,
	model: model ?? DEFAULT_MODEL,
	note:
		MODE === "spectrum"
			? 'Live and non-deterministic. Each session is one Pi process (the preference stays in context); the folder is emptied after every prompt. In the "similar" session, S prompts pass with no question dialog and D prompts pass with one; the "once" session is a control. preferenceHonored needs the control\'s S prompts to ask at least once, else it is inconclusive. infoMentionsPreference is a keyword heuristic.'
			: 'Live and non-deterministic. Both prompts of a session run in one Pi process. "similar" passes when A returned scope "similar" and B opened no ask_user dialog; "once" is a control.',
	prompts: PLAN,
	command: `${commandLine({ tools: FAIR_TOOLS, extensions: FAIR_EXTENSIONS })}   (cwd: a fresh temp folder per session; all prompts in one process)`,
	totals,
	stopReason: stop ?? null,
	sessions,
};
mkdirSync(path.dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${JSON.stringify(totals)}\n(model: ${report.model})`);
console.log(`Wrote ${OUT_FILE}`);
process.exitCode = errors > 0 || failed ? 1 : 0;
