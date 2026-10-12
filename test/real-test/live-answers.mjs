#!/usr/bin/env node
// Live model answers (spends model credits): `npm run test:live-answers`.
//
// Sends one prompt that should make the agent ask, in three modes, and answers
// the forwarded dialog the way a human would:
//   custom - first question: "Write my own answer", then a custom text
//   cancel - Esc on every menu
//   empty  - "Write my own answer", then an empty text box, for every question
// Later questions in custom mode get the [Recommended] choice (else choice 1).
// The rule 16 follow-up after an answer always gets "1. Just this time".
// At most 3 dialogs per run, later ones dismissed. Same fair setup as the prompt
// batch: fresh temp folder, tools ask_user/read/write/edit, sandbox guard,
// capped max tokens.
//
// If the model doesn't ask (or a run hits an environment error) that mode is
// retried once. Hard cap: 6 model runs. Stops on a credit/auth error.
// Pass/fail is objective (see live-answers-score.ts): custom = the exact typed
// text came back; cancel/empty = cancelled with that reason, no answer, and no
// files written after the cancelled result. Reply keyword checks are info only.
// Writes test/real-test/live-answers/results.json; exit 1 on errors or failed checks.
//
//   --rescore <results.json>   recompute checks/pass/totals for a saved file in
//                              place, without launching Pi.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	FAIR_EXTENSIONS,
	FAIR_TOOLS,
	FATAL,
	ROOT,
	commandLine,
	cut,
	firstLineOf,
	isRecommendedChoice,
	isScopeFollowUp,
	runSandboxed,
	SCOPE_CHOICES,
	sumUsage,
	summarizeToolCalls,
} from "./pi-rpc.mjs";
import { CUSTOM_TEXT, MODES, summarizeModes, withScore } from "./live-answers-score.ts";

const PROMPT = "Add a reminder that pings me after 30 minutes of work.";
const MAX_RUNS = 6;
const MAX_DIALOGS = 3;
const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 180_000);
const DEFAULT_MODEL = "openrouter/moonshotai/kimi-k2.6 (user default)";
const OUT_FILE = process.env.LIVE_RESULTS_FILE ?? path.join(ROOT, "test", "real-test", "live-answers", "results.json");

/** Dialog answers for one run in `mode`. Returns the answerer and the log of what was sent. */
function answerer(mode) {
	const sent = [];
	let pendingText = null;
	let menus = 0;
	const answer = (request, n, earlier) => {
		const respond = (response, note) => {
			sent.push({ dialog: n, method: request.method, response, note });
			return response;
		};
		if (isScopeFollowUp(request)) return respond({ value: SCOPE_CHOICES[0] }, "rule 16 follow-up: Just this time");
		const questionDialogs = earlier.filter((d) => !isScopeFollowUp(d.request)).length + 1;
		if (questionDialogs > MAX_DIALOGS) return respond({ cancelled: true }, "dialog cap reached");
		if (request.method === "input") {
			const text = pendingText;
			pendingText = null;
			return text === null ? respond({ cancelled: true }, "unexpected text box") : respond({ value: text }, mode === "empty" ? "empty answer" : "custom answer");
		}
		if (request.method !== "select") return respond({ cancelled: true }, `unexpected ${request.method}`);
		menus++;
		const custom = request.options.at(-1);
		if (mode === "cancel") return respond({ cancelled: true }, "Esc on the menu");
		if (mode === "empty") {
			pendingText = "";
			return respond({ value: custom }, "write my own answer");
		}
		if (menus === 1) {
			pendingText = CUSTOM_TEXT;
			return respond({ value: custom }, "write my own answer");
		}
		return respond({ value: request.options.find(isRecommendedChoice) ?? request.options[0] }, "later question: recommended or first");
	};
	return { answer, sent };
}

function summarize(mode, attempt, run, files, sent) {
	const askCalls = run.toolCalls.filter((c) => c.toolName === "ask_user");
	const askResults = run.toolResults.filter((r) => r.toolName === "ask_user");
	const last = run.assistantMessages?.at(-1);
	const asked = askCalls.length > 0;
	const result = {
		mode,
		attempt,
		asked,
		askUserCalls: askCalls.length,
		dialogs: run.dialogs.map(({ request }, i) => ({
			method: request.method,
			question: String(request.title ?? "").split("\n")[0],
			choices: request.options ?? null,
			placeholder: request.placeholder ?? null,
			sent: sent[i] ?? null,
		})),
		askUserResults: askResults.map((r) => ({ isError: Boolean(r.isError), firstLine: firstLineOf(r.result), details: r.result?.details ?? null })),
		toolCalls: summarizeToolCalls(run),
		filesWritten: files,
		lastStopReason: last ? last.stopReason : null,
		lastErrorMessage: last?.errorMessage ? cut(last.errorMessage, 300) : null,
		finalReply: cut(run.finalText, 2000),
		usage: sumUsage(run.assistantMessages ?? []),
		error: run.error ?? null,
		durationMs: run.durationMs,
	};
	return withScore(result);
}

const NOTE =
	"Live and non-deterministic. pass is objective: custom = the exact typed text came back as a custom answer; " +
	"cancel/empty = the first ask_user result is cancelled with that reason, no answer came back, and no file was written " +
	"after the cancelled result (see writes). info* fields are keyword heuristics on the reply and don't affect pass. " +
	"Each run used a fresh temp folder with tools ask_user, read, write, edit and the sandbox guard.";

// --rescore: recompute from a saved file, no Pi.
const rescoreAt = process.argv.indexOf("--rescore");
if (rescoreAt !== -1) {
	const file = process.argv[rescoreAt + 1];
	if (!file) {
		console.error("usage: node test/real-test/live-answers.mjs --rescore <results.json>");
		process.exit(2);
	}
	const saved = JSON.parse(readFileSync(file, "utf8"));
	const rescoredRuns = saved.runs.map((run) => withScore(run));
	const { modes, totals } = summarizeModes(rescoredRuns);
	const { generatedAt, ...rest } = saved;
	const updated = { generatedAt, rescoredAt: new Date().toISOString(), ...rest, note: NOTE, totals, modes, runs: rescoredRuns };
	writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`);
	for (const run of rescoredRuns) {
		console.log(`${run.pass ? "PASS " : "FAIL "} ${run.mode.padEnd(6)} attempt ${run.attempt}: checks ${JSON.stringify(run.checks)}; writes ${JSON.stringify(run.writes.map((w) => `${w.tool} ${w.path} (${w.when})`))}`);
	}
	console.log(`\n${totals.passed}/${totals.modes} modes passed, ${totals.failed} failed, ${totals.didNotAsk} did not ask, ${totals.errors} errors (rescored ${file})`);
	process.exit(totals.errors > 0 || totals.failed > 0 ? 1 : 0);
}

const runs = [];
let modelRuns = 0;
let model;
let stopReason;

for (const mode of MODES) {
	for (let attempt = 1; attempt <= 2; attempt++) {
		if (stopReason) break;
		if (modelRuns >= MAX_RUNS) {
			stopReason = `run cap (${MAX_RUNS}) reached`;
			break;
		}
		const { answer, sent } = answerer(mode);
		modelRuns++;
		const { run, files } = await runSandboxed(PROMPT, answer, TIMEOUT_MS);
		model ??= run.model;
		const summary = summarize(mode, attempt, run, files, sent);
		runs.push(summary);
		const verdict = summary.error ? "ERROR" : !summary.asked ? "NOASK" : summary.pass ? "PASS " : "FAIL ";
		console.log(`${verdict} ${mode.padEnd(6)} attempt ${attempt}: ${summary.error ?? (summary.asked ? `${summary.askUserCalls} ask_user call(s); checks ${JSON.stringify(summary.checks)}` : "did not ask")}`);
		if (run.error && FATAL.test(run.error)) {
			stopReason = `stopped after a credit/auth error (${mode}, attempt ${attempt})`;
			break;
		}
		if (summary.asked && !summary.error) break; // retry only when the model didn't ask or the environment failed
	}
}

const { modes: finalByMode, totals } = summarizeModes(runs);
const report = {
	generatedAt: new Date().toISOString(),
	model: model ?? DEFAULT_MODEL,
	note: NOTE,
	prompt: PROMPT,
	customText: CUSTOM_TEXT,
	command: `${commandLine({ tools: FAIR_TOOLS, extensions: FAIR_EXTENSIONS })}   (cwd: a fresh temp folder per run)`,
	totals,
	modes: finalByMode,
	stopReason: stopReason ?? null,
	runs,
};
mkdirSync(path.dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${totals.passed}/${totals.modes} modes passed, ${totals.failed} failed, ${totals.didNotAsk} did not ask, ${totals.errors} errors; ${modelRuns} model runs, ${totals.totalTokens} tokens (model: ${report.model})`);
console.log(`Wrote ${OUT_FILE}`);
process.exitCode = totals.errors > 0 || totals.failed > 0 ? 1 : 0;
