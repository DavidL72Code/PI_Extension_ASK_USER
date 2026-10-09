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
// Usage: node scripts/live-rpc-check.mjs [--pick <choice index>]
// By default it picks an option that is NOT the recommended one (if the agent
// recommended one), so the run shows the user's pick winning over the agent's.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "src", "index.ts");
// Caps requested output tokens so a spending-limited API key isn't rejected (HTTP 402). See the file header.
const capHelper = path.join(root, "scripts", "cap-max-tokens.ts");
const TIMEOUT_MS = 240_000;
const MAX_DIALOGS = 3;

const PROMPT =
	"Add a reminder to my Pi setup that pings me after 30 minutes of work. " +
	"Don't write any files yet. First settle any design decision that would change what I see or cause rework " +
	"later (use the ask_user tool if you need to), then reply with a 3-bullet implementation plan that reflects my answers.";

const pickArg = process.argv.indexOf("--pick");
const forcedPick = pickArg === -1 ? undefined : Number(process.argv[pickArg + 1]);

const args = [
	"--mode", "rpc",
	"--no-session", // ephemeral: nothing written to ~/.pi sessions
	"-ne", "-ns", "-np", "-nc", // only this extension; no skills, templates, or context files
	"--tools", "ask_user", // the agent can only ask, not touch files
	"-e", extension,
	"-e", capHelper,
];

const log = (label, value) =>
	console.log(`\n=== ${label} ===\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);

log("command", `pi ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
log("prompt", PROMPT);

const child = spawn("pi", args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
const send = (record) => child.stdin.write(`${JSON.stringify(record)}\n`);

let stderr = "";
let dialogs = 0;
let toolResult;
let finalText;
let lastAssistantText;
let chosen;
let done = false;

child.stderr.on("data", (chunk) => (stderr += chunk));

/** Pick the displayed choice a "human" would choose (never the custom-answer choice). */
function choose(options) {
	const optionCount = options.length - 1; // last choice is the numbered "Write my own answer"
	if (forcedPick !== undefined) return options[forcedPick];
	const notRecommended = options.slice(0, optionCount).findIndex((o) => !/^\d+\. \[Recommended\] /.test(o));
	return options[notRecommended === -1 ? 0 : notRecommended];
}

function handle(record) {
	switch (record.type) {
		case "extension_ui_request": {
			if (!["select", "input", "confirm", "editor"].includes(record.method)) return; // fire-and-forget
			log(`dialog request #${++dialogs} (${record.method})`, record);
			if (record.method === "select" && dialogs <= MAX_DIALOGS) {
				chosen = choose(record.options);
				log("dialog response", { chosen });
				send({ type: "extension_ui_response", id: record.id, value: chosen });
			} else {
				log("dialog response", "cancelled");
				send({ type: "extension_ui_response", id: record.id, cancelled: true });
			}
			return;
		}
		case "tool_execution_start":
			if (record.toolName === "ask_user") log("ask_user call arguments", record.args);
			return;
		case "tool_execution_end":
			if (record.toolName === "ask_user") {
				toolResult = record;
				log(`ask_user tool result (isError: ${record.isError})`, record.result);
			}
			return;
		case "message_end": {
			const message = record.message;
			if (message?.role !== "assistant") return;
			if (message.stopReason === "error" || message.errorMessage) log("assistant error", message.errorMessage ?? message);
			const text = (message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
			if (text.trim()) lastAssistantText = text;
			return;
		}
		case "extension_error":
			log("extension error", record);
			return;
		case "agent_settled":
			send({ id: "final-text", type: "get_last_assistant_text" });
			return;
		case "response":
			if (!record.success) log(`command failed: ${record.command}`, record.error);
			if (record.command === "prompt" && !record.success) finish(1);
			if (record.id === "final-text") {
				finalText = record.data?.text ?? lastAssistantText;
				log("agent final reply", finalText ?? "(no assistant text)");
				finish(0);
			}
			return;
	}
}

// Strict JSONL framing: split on LF only (readline would also split on U+2028/U+2029).
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let newline;
	while ((newline = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		if (!line.trim()) continue;
		try {
			handle(JSON.parse(line));
		} catch (error) {
			log("unparseable stdout line", `${line.slice(0, 500)}\n(${error.message})`);
		}
	}
});

const timer = setTimeout(() => {
	log("timeout", `no settled run after ${TIMEOUT_MS / 1000}s`);
	finish(1);
}, TIMEOUT_MS);

child.on("exit", (code, signal) => {
	if (!done) {
		log("pi exited early", { code, signal });
		finish(1);
	}
});

function finish(code) {
	if (done) return;
	done = true;
	clearTimeout(timer);
	child.stdin.end();
	setTimeout(() => child.kill(), 2000).unref();

	const details = toolResult?.result?.details;
	const answer = details?.answer;
	const summary = {
		selectDialogReceived: dialogs > 0,
		toolStatus: details?.status ?? "(ask_user not called)",
		answer,
		followedRecommendation: details?.followedRecommendation,
		finalReplyMentionsAnswer:
			typeof answer === "string" && typeof finalText === "string"
				? finalText.toLowerCase().includes(answer.toLowerCase())
				: false,
	};
	log("summary", summary);
	if (stderr.trim()) log("pi stderr", stderr.trim());
	const ok = code === 0 && summary.selectDialogReceived && summary.toolStatus === "answered" && Boolean(finalText);
	console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
	process.exitCode = ok ? 0 : 1;
}

send({ id: "prompt-1", type: "prompt", message: PROMPT });
