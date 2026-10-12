#!/usr/bin/env node
// Live prompt batch against real Pi (spends model credits: one run per prompt).
//
// Sends each prompt below, exactly as written, to a fresh `pi --mode rpc` and
// records whether the agent called ask_user. The prompts carry no hint about the
// tool, so this tests the tool's own description and prompt guidelines. Live and
// non-deterministic.
//
// Each run gets a fresh temp folder as its working directory and the tools
// ask_user, read, write and edit (no shell). scripts/sandbox-guard.ts blocks
// file tools outside that folder. Dialogs are auto-answered: the [Recommended]
// choice if there is one, else choice 1; at most 3 dialogs per run, later ones
// are dismissed.
//
// Writes test/real-test/live-prompts/results.json. Exit 0 even when the agent's behavior
// doesn't match the expectation (that's an observation); exit 1 on errors.
// Usage: npm run test:live-prompts

import { mkdirSync, writeFileSync } from "node:fs";
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

const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 180_000);
const MAX_DIALOGS = 3;
const DEFAULT_MODEL = "openrouter/moonshotai/kimi-k2.6 (user default)";
// LIVE_RESULTS_FILE lets a dry run (PI_BIN pointing at a fake) write somewhere else.
const OUT_FILE = process.env.LIVE_RESULTS_FILE ?? path.join(ROOT, "test", "real-test", "live-prompts", "results.json");

const PROMPTS = [
	{ prompt: "Add a /export command that saves this conversation to a file.", expected: "ask", why: "File format, location, and overwrite behavior are unspecified and user-visible." },
	{ prompt: "Write a script that cleans up old log files in ./logs.", expected: "ask", why: "Delete vs. archive and what counts as old are unspecified; deletion is hard to reverse." },
	{ prompt: "Build a small to-do list CLI in Python.", expected: "ask", why: "Storage (persisted or in-memory) and commands are unspecified and change behavior." },
	{ prompt: "Add a reminder that pings me after 30 minutes of work.", expected: "ask", why: "Whether reminder state persists across restarts is unspecified (contract example)." },
	{ prompt: "Make a script that backs up my Documents folder.", expected: "ask", why: "Destination, schedule, and full vs. incremental are unspecified and costly to redo." },
	{ prompt: "Write a Python to-do CLI that saves tasks to todo.json, with add, list, and done commands.", expected: "no-ask", why: "Fully specified." },
	{ prompt: "Write a script that deletes log files older than 7 days in ./logs, or archives them instead — your call.", expected: "no-ask", why: "The open choice is explicitly delegated." },
	{ prompt: "Write a JavaScript function that adds two numbers.", expected: "no-ask", why: "Routine and easy to reverse." },
];

/** Questions: [Recommended] else choice 1, at most MAX_DIALOGS. The rule 16 follow-up: always "Just this time", not counted. */
function answerDialog(request, _n, earlier) {
	if (isScopeFollowUp(request)) return { value: SCOPE_CHOICES[0] };
	const questionDialogs = earlier.filter((d) => !isScopeFollowUp(d.request)).length + 1;
	if (request.method !== "select" || questionDialogs > MAX_DIALOGS) return { cancelled: true };
	return { value: request.options.find(isRecommendedChoice) ?? request.options[0] };
}

function summarize(entry, run, attempts, files) {
	const askResults = run.toolResults.filter((r) => r.toolName === "ask_user");
	const askUserCalls = run.toolCalls.filter((r) => r.toolName === "ask_user").length;
	const last = run.assistantMessages.at(-1);
	return {
		prompt: entry.prompt,
		expected: entry.expected,
		why: entry.why,
		askUserCalls,
		rejectedCalls: askResults.filter((r) => r.isError).length,
		repeatedCalls: askResults.filter((r) => r.result?.details?.repeated === true).length,
		dialogs: run.dialogs.map(({ request, response }) => ({
			kind: isScopeFollowUp(request) ? "follow-up" : "question",
			question: String(request.title ?? "").split("\n")[0],
			choices: request.options ?? null,
			picked: response.cancelled ? "(dismissed)" : response.value,
		})),
		toolResults: askResults.map((r) => firstLineOf(r.result)),
		toolCalls: summarizeToolCalls(run),
		filesWritten: files,
		lastStopReason: last ? last.stopReason : null,
		lastErrorMessage: last?.errorMessage ? cut(last.errorMessage, 300) : null,
		finalReply: cut(run.finalText, 2000),
		usage: sumUsage(run.assistantMessages),
		matched: run.error ? null : (askUserCalls > 0) === (entry.expected === "ask"),
		error: run.error ?? null,
		attempts,
		durationMs: run.durationMs,
	};
}

const empty = (error) => ({ toolCalls: [], toolResults: [], dialogs: [], assistantMessages: [], durationMs: 0, error });
const runs = [];
let model;
let stopReason;

for (const [i, entry] of PROMPTS.entries()) {
	const label = `[${i + 1}/${PROMPTS.length}]`;
	if (stopReason) {
		runs.push(summarize(entry, empty(`not run: ${stopReason}`), [], []));
		console.log(`ERROR ${label} not run (${stopReason})`);
		continue;
	}
	const attempts = [];
	let { run, files } = await runSandboxed(entry.prompt, answerDialog, TIMEOUT_MS);
	attempts.push({ error: run.error ?? null, durationMs: run.durationMs });
	if (run.error && !FATAL.test(run.error)) {
		// One retry for an environment failure (timeout, provider hiccup, early exit).
		console.log(`RETRY ${label} after: ${run.error}`);
		({ run, files } = await runSandboxed(entry.prompt, answerDialog, TIMEOUT_MS));
		attempts.push({ error: run.error ?? null, durationMs: run.durationMs });
	}
	if (run.error && FATAL.test(run.error)) stopReason = `batch stopped after a credit/auth error on prompt ${i + 1}`;
	model ??= run.model;

	const summary = summarize(entry, run, attempts, files);
	runs.push(summary);
	const calls = (n, what) => `${n} ${what}${n === 1 ? "" : "s"}`;
	const asked = summary.askUserCalls > 0 ? `asked (${calls(summary.askUserCalls, "call")}, ${calls(summary.dialogs.length, "dialog")})` : "did not ask";
	const verdict = summary.error ? "ERROR" : summary.matched ? "MATCH" : "MISS ";
	const tail = summary.error ? summary.error : `${asked}; ended ${summary.lastStopReason}; ${calls(summary.toolCalls.length, "tool call")}`;
	console.log(`${verdict} ${label} expected ${entry.expected.padEnd(6)} -> ${tail}  ${JSON.stringify(entry.prompt)}`);
}

const errors = runs.filter((r) => r.error).length;
const totalTokens = runs.reduce((sum, r) => sum + (r.usage?.totalTokens ?? 0), 0);
const report = {
	generatedAt: new Date().toISOString(),
	model: model ?? DEFAULT_MODEL,
	note:
		"Live run against real Pi and a real model; results are non-deterministic and can change between runs. " +
		"'asked' means the agent called ask_user at least once (including calls Pi rejected as invalid). " +
		"Each run used a fresh temp folder as cwd with tools ask_user, read, write, edit; scripts/sandbox-guard.ts blocked file tools outside it.",
	command: `${commandLine({ tools: FAIR_TOOLS, extensions: FAIR_EXTENSIONS })}   (cwd: a fresh temp folder per run)`,
	answerPolicy: `select: the [Recommended] choice if present, else choice 1; at most ${MAX_DIALOGS} questions per run, later ones dismissed; the rule 16 follow-up always gets "1. Just this time"`,
	totals: {
		prompts: runs.length,
		matchedExpectation: runs.filter((r) => r.matched === true).length,
		mismatched: runs.filter((r) => r.matched === false).length,
		errors,
		totalTokens,
	},
	runs,
};

mkdirSync(path.dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`);
const t = report.totals;
console.log(`\n${t.matchedExpectation}/${t.prompts} matched, ${t.mismatched} mismatched, ${t.errors} errors, ${t.totalTokens} tokens (model: ${report.model})`);
console.log(`Wrote ${OUT_FILE}`);
process.exitCode = errors > 0 ? 1 : 0;
