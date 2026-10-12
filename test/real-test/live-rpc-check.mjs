#!/usr/bin/env node
// Live check against real Pi (spends model credits: one prompt).
//
// Starts `pi --mode rpc` with only this extension and only the ask_user tool,
// sends a task that leaves a material design choice open, answers the forwarded
// select dialog like a human would, and prints:
//   1. the dialog request Pi forwarded,
//   2. the ask_user tool result,
//   3. the agent's final reply.
//
// Also loads scripts/cap-max-tokens.ts, which only lowers the requested
// max output tokens (the default model asks for ~235k, which a spending-limited
// OpenRouter key rejects with HTTP 402).
//
// Usage: npm run test:live-check -- [--pick <choice index>]
// By default it picks an option that is NOT the recommended one (if the agent
// recommended one), so the run shows the user's pick winning over the agent's.

import { SCOPE_CHOICES, commandLine, isRecommendedChoice, isScopeFollowUp, runPrompt } from "./pi-rpc.mjs";

const TIMEOUT_MS = 240_000;
const MAX_DIALOGS = 3;

const PROMPT =
	"Add a reminder to my Pi setup that pings me after 30 minutes of work. " +
	"Don't write any files yet. First settle any design decision that would change what I see or cause rework " +
	"later (use the ask_user tool if you need to), then reply with a 3-bullet implementation plan that reflects my answers.";

const pickArg = process.argv.indexOf("--pick");
const forcedPick = pickArg === -1 ? undefined : Number(process.argv[pickArg + 1]);

const log = (label, value) =>
	console.log(`\n=== ${label} ===\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);

/** Pick the displayed choice a "human" would choose (never the custom-answer choice). */
function choose(options) {
	const optionCount = options.length - 1; // last choice is the numbered "Write my own answer"
	if (forcedPick !== undefined) return options[forcedPick];
	const notRecommended = options.slice(0, optionCount).findIndex((o) => !isRecommendedChoice(o));
	return options[notRecommended === -1 ? 0 : notRecommended];
}

function answerDialog(request, n) {
	log(`dialog request #${n} (${request.method})`, request);
	if (isScopeFollowUp(request)) {
		log("dialog response", { chosen: SCOPE_CHOICES[0] });
		return { value: SCOPE_CHOICES[0] }; // rule 16 follow-up: Just this time
	}
	if (request.method === "select" && n <= MAX_DIALOGS) {
		const chosen = choose(request.options);
		log("dialog response", { chosen });
		return { value: chosen };
	}
	log("dialog response", "cancelled");
	return { cancelled: true };
}

function onRecord(record) {
	if (record.type === "tool_execution_start" && record.toolName === "ask_user") log("ask_user call arguments", record.args);
	if (record.type === "tool_execution_end" && record.toolName === "ask_user") {
		log(`ask_user tool result (isError: ${record.isError})`, record.result);
	}
	if (record.type === "message_end" && record.message?.role === "assistant" && (record.message.stopReason === "error" || record.message.errorMessage)) {
		log("assistant error", record.message.errorMessage ?? record.message);
	}
	if (record.type === "extension_error") log("extension error", record);
	if (record.type === "response" && !record.success) log(`command failed: ${record.command}`, record.error);
	if (record.type === "unparseable") log("unparseable stdout line", `${record.line}\n(${record.error})`);
}

log("command", commandLine());
log("prompt", PROMPT);

const run = await runPrompt({ prompt: PROMPT, answerDialog, timeoutMs: TIMEOUT_MS, onRecord });
if (run.error) log("run error", run.error);
log("agent final reply", run.finalText ?? "(no assistant text)");

const toolResult = run.toolResults.filter((r) => r.toolName === "ask_user").at(-1);
const details = toolResult?.result?.details;
const answer = details?.answer;
const summary = {
	selectDialogReceived: run.dialogs.some((d) => d.request.method === "select"),
	toolStatus: details?.status ?? "(ask_user not called)",
	answer,
	followedRecommendation: details?.followedRecommendation,
	finalReplyMentionsAnswer:
		typeof answer === "string" && typeof run.finalText === "string"
			? run.finalText.toLowerCase().includes(answer.toLowerCase())
			: false,
};
log("summary", summary);
if (run.stderr.trim()) log("pi stderr", run.stderr.trim());
const ok = !run.error && summary.selectDialogReceived && summary.toolStatus === "answered" && Boolean(run.finalText);
console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
process.exitCode = ok ? 0 : 1;
