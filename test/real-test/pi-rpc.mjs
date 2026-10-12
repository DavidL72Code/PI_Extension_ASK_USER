// Shared plumbing for the live scripts: run one prompt in a fresh `pi --mode rpc`
// process with only this extension (plus any dev-only helpers) and a chosen tool
// list, answer forwarded dialogs through a callback, and collect what happened.
//
// PI_BIN overrides the executable (default "pi"), e.g. to dry-run against a fake.

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PI_BIN = process.env.PI_BIN ?? "pi";

export const SANDBOX_GUARD = path.join(ROOT, "scripts", "sandbox-guard.ts");

/** Pi arguments: RPC, ephemeral, only this extension (plus `extensions`), and only `tools`. */
export function piArgs({ tools = ["ask_user"], extensions = [] } = {}) {
	return [
		"--mode", "rpc",
		"--no-session", // ephemeral: nothing written to ~/.pi sessions
		"-ne", "-ns", "-np", "-nc", // only this extension; no skills, templates, or context files
		"--tools", tools.join(","),
		"-e", path.join(ROOT, "src", "index.ts"),
		// Lowers the requested max output tokens; the default (~235k) is rejected with
		// HTTP 402 by a spending-limited OpenRouter key. See scripts/cap-max-tokens.ts.
		"-e", path.join(ROOT, "scripts", "cap-max-tokens.ts"),
		...extensions.flatMap((e) => ["-e", e]),
	];
}

export const commandLine = (options) =>
	`${PI_BIN} ${piArgs(options).map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`;

const DIALOG_METHODS = ["select", "input", "confirm", "editor"];

/** True for a choice the ask_user dialog marks as recommended ("2. [Recommended] Postgres"). */
export const isRecommendedChoice = (choice) => /^\d+\. \[Recommended\] /.test(choice);

/** Rule 16 follow-up choices; live scripts always answer "1. Just this time". */
export const SCOPE_CHOICES = ["1. Just this time", "2. Also for similar questions this session"];

/** True for the rule 16 follow-up ("Apply … to similar questions this session?") rather than a question. */
export const isScopeFollowUp = (request) =>
	request.method === "select" &&
	/^Apply ".*" to similar questions this session\?$/s.test(String(request.title ?? "")) &&
	JSON.stringify(request.options) === JSON.stringify(SCOPE_CHOICES);

/**
 * Run one prompt and resolve when Pi settles, times out, or exits.
 *
 * answerDialog(request, n, earlier) returns the response fields for dialog n (1-based;
 * `earlier` are the previous { request, response } pairs): `{ value }` or
 * `{ cancelled: true }`. onRecord(record) sees every stdout record.
 * `cwd`, `tools`, and `extensions` choose where Pi runs and what the agent can use.
 */
export function runPrompt({
	prompt,
	answerDialog,
	timeoutMs = 180_000,
	onRecord = () => {},
	cwd = ROOT,
	tools,
	extensions,
}) {
	return new Promise((resolve) => {
		const started = Date.now();
		const run = {
			model: undefined,
			dialogs: [], // { request, response }
			toolCalls: [], // tool_execution_start records
			toolResults: [], // tool_execution_end records
			assistantMessages: [], // { stopReason, errorMessage, usage } per assistant message
			finalText: undefined,
			lastAssistantError: undefined,
			stderr: "",
			error: undefined,
			durationMs: 0,
		};
		let lastAssistantText;
		let done = false;
		let timer;

		const child = spawn(PI_BIN, piArgs({ tools, extensions }), { cwd, stdio: ["pipe", "pipe", "pipe"] });
		const send = (record) => {
			if (!done) child.stdin.write(`${JSON.stringify(record)}\n`);
		};
		const finish = (error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			run.error = error;
			run.durationMs = Date.now() - started;
			child.stdin.end();
			setTimeout(() => child.kill(), 2000).unref();
			resolve(run);
		};

		const handle = (record) => {
			onRecord(record);
			switch (record.type) {
				case "extension_ui_request": {
					if (!DIALOG_METHODS.includes(record.method)) return; // fire-and-forget (notify, status, ...)
					const response = answerDialog(record, run.dialogs.length + 1, [...run.dialogs]);
					run.dialogs.push({ request: record, response });
					send({ type: "extension_ui_response", id: record.id, ...response });
					return;
				}
				case "tool_execution_start":
					run.toolCalls.push(record);
					return;
				case "tool_execution_end":
					run.toolResults.push(record);
					return;
				case "message_end": {
					const message = record.message;
					if (message?.role !== "assistant") return;
					run.assistantMessages.push({
						stopReason: message.stopReason ?? null,
						errorMessage: message.errorMessage ?? null,
						usage: message.usage ?? null,
					});
					// Pi may retry a failed request; only the latest assistant message decides.
					run.lastAssistantError =
						message.stopReason === "error" || message.errorMessage ? String(message.errorMessage ?? "error") : undefined;
					const text = (message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
					if (text.trim()) lastAssistantText = text;
					return;
				}
				case "agent_settled":
					send({ id: "final-text", type: "get_last_assistant_text" });
					return;
				case "response":
					if (record.command === "get_state" && record.success && record.data?.model) {
						run.model = `${record.data.model.provider}/${record.data.model.id}`;
					}
					if (record.command === "prompt" && !record.success) finish(`prompt rejected: ${record.error}`);
					if (record.id === "final-text") {
						run.finalText = record.data?.text ?? lastAssistantText;
						finish(run.lastAssistantError ? `assistant error: ${run.lastAssistantError}` : undefined);
					}
					return;
			}
		};

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
				let record;
				try {
					record = JSON.parse(line);
				} catch (error) {
					onRecord({ type: "unparseable", line: line.slice(0, 500), error: error.message });
					continue;
				}
				handle(record);
			}
		});
		child.stderr.on("data", (chunk) => (run.stderr += chunk));
		child.on("error", (error) => finish(`could not start ${PI_BIN}: ${error.message}`));
		child.on("exit", (code, signal) => finish(`pi exited early (code ${code}, signal ${signal})`));
		timer = setTimeout(() => finish(`timeout after ${timeoutMs / 1000}s`), timeoutMs);

		send({ id: "state", type: "get_state" });
		send({ id: "prompt-1", type: "prompt", message: prompt });
	});
}

// ---------------------------------------------------------------------------
// The "fair" live setup shared by live-prompt-batch.mjs and live-answers.mjs
// ---------------------------------------------------------------------------

/** Normal file tools, no shell; sandbox-guard.ts keeps them inside the run folder. */
export const FAIR_TOOLS = ["ask_user", "read", "write", "edit"];
export const FAIR_EXTENSIONS = [SANDBOX_GUARD];

/** Errors that mean every later run would fail too (credits, auth). */
export const FATAL = /\b(401|402|403)\b|credits|unauthori[sz]ed|authentication|invalid api key/i;

export const textOf = (result) => (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
export const firstLineOf = (result) => textOf(result).split("\n")[0];

export function cut(text, max) {
	if (typeof text !== "string") return null;
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** Files left in a folder, relative to it. */
export function listFiles(dir, prefix = "") {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const rel = path.join(prefix, entry.name);
		return entry.isDirectory() ? listFiles(path.join(dir, entry.name), rel) : [rel];
	});
}

/** Token usage summed over assistant messages, or null when Pi reported none. */
export function sumUsage(messages) {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	let reported = false;
	for (const { usage } of messages) {
		if (!usage) continue;
		reported = true;
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) total[key] += Number(usage[key] ?? 0);
		total.cost += Number(usage.cost?.total ?? 0);
	}
	total.cost = Math.round(total.cost * 1e6) / 1e6;
	return reported ? total : null;
}

/** Every tool call of a run: name, short args, and how it ended. */
export function summarizeToolCalls(run) {
	const ends = new Map(run.toolResults.map((r) => [r.toolCallId, r]));
	return run.toolCalls.map((call) => {
		const end = ends.get(call.toolCallId);
		return {
			name: call.toolName,
			...(typeof call.args?.path === "string" ? { path: call.args.path } : {}),
			args: cut(JSON.stringify(call.args ?? {}), 160),
			isError: end ? Boolean(end.isError) : null,
			result: end ? cut(firstLineOf(end.result), 160) : null,
		};
	});
}

/** One run in a fresh temp folder with the fair setup; the folder is removed afterwards. */
export async function runSandboxed(prompt, answerDialog, timeoutMs) {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ask-user-live-")));
	try {
		const run = await runPrompt({ prompt, answerDialog, timeoutMs, cwd: dir, tools: FAIR_TOOLS, extensions: FAIR_EXTENSIONS });
		return { run, files: listFiles(dir) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Several prompts in ONE Pi process (so earlier answers stay in context)
// ---------------------------------------------------------------------------

/**
 * Send `prompts` one after another to the same `pi --mode rpc` process; each
 * waits for the previous run to settle. Returns { model, segments, stderr, error }
 * with one segment per prompt: dialogs (each tagged with the ask_user call that
 * opened it), toolCalls, toolResults, assistantMessages, finalText, error, durationMs.
 *
 * answerDialog(request, { prompt, n, earlier }) answers a dialog: `prompt` is the
 * 0-based prompt index, `n` the 1-based dialog number within that prompt, and
 * `earlier` that prompt's previous { request, response } pairs.
 * afterPrompt(index, segment) runs after each prompt settles, before the next is sent.
 */
export function runSession({ prompts, answerDialog, timeoutMs = 180_000, cwd = ROOT, tools, extensions, afterPrompt = () => {} }) {
	return new Promise((resolve) => {
		const out = { model: undefined, segments: [], stderr: "", error: undefined };
		const child = spawn(PI_BIN, piArgs({ tools, extensions }), { cwd, stdio: ["pipe", "pipe", "pipe"] });
		let done = false;
		let timer;
		let seg;
		let index = -1;
		let activeAskCall = null;
		let lastAssistantText;
		const send = (record) => {
			if (!done) child.stdin.write(`${JSON.stringify(record)}\n`);
		};
		const finish = (error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (seg && !seg.closed) {
				seg.error ??= error;
				seg.durationMs = Date.now() - seg.started;
				out.segments.push(seg);
			}
			out.error = error;
			child.stdin.end();
			setTimeout(() => child.kill(), 2000).unref();
			resolve(out);
		};
		const startPrompt = () => {
			index++;
			if (index >= prompts.length) return finish(undefined);
			seg = { prompt: prompts[index], dialogs: [], toolCalls: [], toolResults: [], assistantMessages: [], finalText: undefined, lastAssistantError: undefined, error: undefined, started: Date.now(), closed: false };
			lastAssistantText = undefined;
			clearTimeout(timer);
			timer = setTimeout(() => finish(`timeout after ${timeoutMs / 1000}s on prompt ${index + 1}`), timeoutMs);
			send({ id: `prompt-${index}`, type: "prompt", message: prompts[index] });
		};
		const handle = (record) => {
			switch (record.type) {
				case "extension_ui_request": {
					if (!DIALOG_METHODS.includes(record.method) || !seg) return;
					const response = answerDialog(record, { prompt: index, n: seg.dialogs.length + 1, earlier: [...seg.dialogs] });
					seg.dialogs.push({ request: record, response, askCall: activeAskCall });
					send({ type: "extension_ui_response", id: record.id, ...response });
					return;
				}
				case "tool_execution_start":
					seg?.toolCalls.push(record);
					if (record.toolName === "ask_user") activeAskCall = record.toolCallId;
					return;
				case "tool_execution_end":
					seg?.toolResults.push(record);
					if (record.toolCallId === activeAskCall) activeAskCall = null;
					return;
				case "message_end": {
					const message = record.message;
					if (message?.role !== "assistant" || !seg) return;
					seg.assistantMessages.push({ stopReason: message.stopReason ?? null, errorMessage: message.errorMessage ?? null, usage: message.usage ?? null });
					seg.lastAssistantError = message.stopReason === "error" || message.errorMessage ? String(message.errorMessage ?? "error") : undefined;
					const text = (message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
					if (text.trim()) lastAssistantText = text;
					return;
				}
				case "agent_settled":
					send({ id: `final-${index}`, type: "get_last_assistant_text" });
					return;
				case "response":
					if (record.command === "get_state" && record.success && record.data?.model) out.model = `${record.data.model.provider}/${record.data.model.id}`;
					if (record.command === "prompt" && !record.success) return finish(`prompt ${index + 1} rejected: ${record.error}`);
					if (record.id === `final-${index}`) {
						seg.finalText = record.data?.text ?? lastAssistantText;
						seg.error = seg.lastAssistantError ? `assistant error: ${seg.lastAssistantError}` : undefined;
						seg.durationMs = Date.now() - seg.started;
						seg.closed = true;
						out.segments.push(seg);
						try {
							afterPrompt(index, seg);
						} catch {
							// a failing hook must not hang the session
						}
						if (seg.error) return finish(seg.error); // don't send the next prompt after a provider error
						startPrompt();
					}
					return;
			}
		};

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
				} catch {
					// ignore unparseable lines
				}
			}
		});
		child.stderr.on("data", (chunk) => (out.stderr += chunk));
		child.on("error", (error) => finish(`could not start ${PI_BIN}: ${error.message}`));
		child.on("exit", (code, signal) => finish(`pi exited early (code ${code}, signal ${signal})`));

		send({ id: "state", type: "get_state" });
		startPrompt();
	});
}

/**
 * runSession in a fresh temp folder with the fair setup; lists the folder's files
 * after each prompt. With `clearAfterEach`, everything in the folder is deleted
 * after each prompt (the folder itself stays), so leftovers can't settle the next
 * decision; `deletedAfter[i]` lists what was removed after prompt i.
 */
export async function runSessionSandboxed(prompts, answerDialog, timeoutMs, { clearAfterEach = false } = {}) {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ask-user-live-")));
	const filesAfter = [];
	const deletedAfter = [];
	try {
		const session = await runSession({
			prompts,
			answerDialog,
			timeoutMs,
			cwd: dir,
			tools: FAIR_TOOLS,
			extensions: FAIR_EXTENSIONS,
			afterPrompt: (index) => {
				filesAfter[index] = listFiles(dir);
				if (!clearAfterEach) return;
				const entries = readdirSync(dir);
				for (const entry of entries) rmSync(path.join(dir, entry), { recursive: true, force: true });
				deletedAfter[index] = filesAfter[index];
				if (readdirSync(dir).length) throw new Error("run folder not empty after clearing");
			},
		});
		return { session, filesAfter, deletedAfter };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
