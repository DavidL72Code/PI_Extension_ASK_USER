#!/usr/bin/env node
// Real Pi dialogs, no model (free): `npm run test:real`.
//
// Loads test/real-test/real-dialog-command.ts, whose /ask-user-real-check
// command runs the real ask_user tool with Pi's real ctx, then checks it in
// three modes:
//   rpc   - pi --mode rpc; answers each forwarded dialog (docs/rpc-extension-ui.md)
//   tui   - the interactive on-screen dialog, driven with real keystrokes (real-tui.py)
//   print - pi -p, where there is no UI (expects unavailable), plus a JSON-mode
//           event witness showing that no model turn ran
// Expected values are written out below, not computed by the tool's code.
// Writes test/real-test/real-dialogs/results.json; exits 1 on any failure.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ROOT } from "./pi-rpc.mjs";

const PI = process.env.PI_BIN ?? "pi";
const COMMAND = "ask-user-real-check";
const EXTENSIONS = ["-e", "./src/index.ts", "-e", "./test/real-test/real-dialog-command.ts"];
const QUIET = ["--offline", "-ne", "-ns", "-np", "-nc"];
const OUT_FILE = path.join(ROOT, "test", "real-test", "real-dialogs", "results.json");

// ---------------------------------------------------------------------------
// Expected values (independent of the implementation)
// ---------------------------------------------------------------------------

const REASON = "Changes deployment needs; costly to migrate later.";
const TITLE_OPTIONS = [
	"1. SQLite",
	"   Zero setup; one writer at a time",
	"",
	"2. [Recommended] Postgres",
	"   Needs a server; handles concurrent writers",
	"",
	"3. In-memory",
	"   Fastest; lost on restart",
];
const title = (question) => [question, "", `Why it matters: ${REASON}`, "", ...TITLE_OPTIONS].join("\n");
const CHOICES = ["1. SQLite", "2. [Recommended] Postgres", "3. In-memory", "4. Write my own answer"];
const Q = {
	recommended: "Which database should the cache use?",
	against: "Which database should the queue use?",
	custom: "Where should exports be saved?",
	"esc-menu": "How should old log files be handled?",
	"esc-textbox": "Should reminders survive a Pi restart?",
	empty: "Which format should exports use?",
	whitespace: "Which retention period should logs use?",
	"unknown-value": "Which port should the server use?",
	"again-answered": "which DATABASE should   the cache use",
	"again-dismissed": "how should old LOG files be handled",
	"scope-similar": "Which cache eviction policy should we use?",
	"scope-esc": "Which log format should we use?",
	unavailable: "Should the CLI keep tasks on disk?",
};
const answered = (question, answer, source, followed, scope = "once", extra = {}) => ({
	status: "answered",
	question,
	answer,
	source,
	recommendation: "Postgres",
	followedRecommendation: followed,
	scope,
	...extra,
});
const cancelled = (question, cancelReason, extra = {}) => ({ status: "cancelled", question, cancelReason, ...extra });
const firstLine = (details) =>
	details.status === "cancelled" ? `ask_user: cancelled (${details.cancelReason})` : `ask_user: ${details.status}`;

const RPC_CUSTOM = "  keep   both — naïve café 日本語 🚀 é  ";
const TUI_CUSTOM = "  Play a sound — naïve café 日本語  "; // what real-tui.py types
const select = (question, respond) => ({ method: "select", title: title(question), options: CHOICES, respond });
// Rule 16 follow-up after every new answer.
const SCOPE = ["1. Just this time", "2. Also for similar questions this session"];
const followUp = (shown, respond = { value: SCOPE[0] }) => ({ method: "select", title: `Apply "${shown}" to similar questions this session?`, options: SCOPE, respond });
const input = (question, respond) => ({ method: "input", title: question, placeholder: "Type your answer", respond });

/** RPC: each scenario lists the dialogs Pi must forward (exact payload) and what the client answers. */
const RPC_SCENARIOS = [
	{ name: "recommended", label: "pick the recommended option, then Just this time", dialogs: [select(Q.recommended, { value: CHOICES[1] }), followUp("Postgres")], details: answered(Q.recommended, "Postgres", "option", true) },
	{ name: "against", label: "pick against the recommendation", dialogs: [select(Q.against, { value: CHOICES[0] }), followUp("SQLite")], details: answered(Q.against, "SQLite", "option", false) },
	{ name: "custom", label: "custom answer, exact (spaces + unicode)", dialogs: [select(Q.custom, { value: CHOICES[3] }), input(Q.custom, { value: RPC_CUSTOM }), followUp(RPC_CUSTOM)], details: answered(Q.custom, RPC_CUSTOM, "custom", false) },
	{ name: "scope-similar", label: "follow-up: Also for similar questions this session", dialogs: [select(Q["scope-similar"], { value: CHOICES[1] }), followUp("Postgres", { value: SCOPE[1] })], details: answered(Q["scope-similar"], "Postgres", "option", true, "similar") },
	{ name: "scope-esc", label: "follow-up: Esc keeps the answer, scope once", dialogs: [select(Q["scope-esc"], { value: CHOICES[0] }), followUp("SQLite", { cancelled: true })], details: answered(Q["scope-esc"], "SQLite", "option", false) },
	{ name: "esc-menu", label: "Esc on the menu", dialogs: [select(Q["esc-menu"], { cancelled: true })], details: cancelled(Q["esc-menu"], "dismissed") },
	{ name: "esc-textbox", label: "Esc on the text box", dialogs: [select(Q["esc-textbox"], { value: CHOICES[3] }), input(Q["esc-textbox"], { cancelled: true })], details: cancelled(Q["esc-textbox"], "dismissed") },
	{ name: "empty", label: "empty custom answer", dialogs: [select(Q.empty, { value: CHOICES[3] }), input(Q.empty, { value: "" })], details: cancelled(Q.empty, "empty_answer") },
	{ name: "whitespace", label: "whitespace-only custom answer", dialogs: [select(Q.whitespace, { value: CHOICES[3] }), input(Q.whitespace, { value: "  \t 　 " })], details: cancelled(Q.whitespace, "empty_answer") },
	{ name: "unknown-value", label: "client returns a value that is not a choice", dialogs: [select(Q["unknown-value"], { value: "Postgres" })], error: "unexpected dialog response" },
	{ name: "again-answered", label: "an identical call made later (after an answer) opens the dialog again", dialogs: [select(Q["again-answered"], { value: CHOICES[0] }), followUp("SQLite")], details: answered(Q["again-answered"], "SQLite", "option", false) },
	{ name: "again-dismissed", label: "an identical call made later (after Esc) opens the dialog again", dialogs: [select(Q["again-dismissed"], { cancelled: true })], details: cancelled(Q["again-dismissed"], "dismissed") },
	{ name: "invalid", label: "invalid input (1 option): no dialog", dialogs: [], error: "options must be an array of 2 or 3 items" },
];

/** TUI: what real-tui.py does for each scenario, and the result it must produce. */
const TUI_EXPECTED = {
	recommended: { label: "Down + Enter picks choice 2 (recommended), Enter on the follow-up (Just this time)", details: answered(Q.recommended, "Postgres", "option", true), textbox: false, followUp: "Postgres" },
	"esc-menu": { label: "Esc on the menu", details: cancelled(Q["esc-menu"], "dismissed"), textbox: false },
	custom: { label: "choice 4, type a custom answer, Enter, Enter on the follow-up", details: answered(Q.custom, TUI_CUSTOM, "custom", false), textbox: true, followUp: TUI_CUSTOM },
	empty: { label: "choice 4, Enter on an empty text box", details: cancelled(Q.empty, "empty_answer"), textbox: true },
	"esc-textbox": { label: "choice 4, Esc in the text box", details: cancelled(Q["esc-textbox"], "dismissed"), textbox: true },
	"scope-similar": { label: "Down + Enter, then Down + Enter on the follow-up (Also for similar)", details: answered(Q["scope-similar"], "Postgres", "option", true, "similar"), textbox: false, followUp: "Postgres" },
	"scope-esc": { label: "Enter on choice 1, then Esc on the follow-up", details: answered(Q["scope-esc"], "SQLite", "option", false), textbox: false, followUp: "SQLite" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkResult(expected, record) {
	const problems = [];
	if (!record) return ["no result recorded"];
	if (expected.error) {
		if (!record.error?.includes(expected.error)) problems.push(`expected an error containing ${JSON.stringify(expected.error)}, got ${JSON.stringify(record.error ?? record.details)}`);
		return problems;
	}
	if (record.error) return [`unexpected error: ${record.error}`];
	if (!isDeepStrictEqual(record.details, expected.details)) problems.push(`details: expected ${JSON.stringify(expected.details)}, got ${JSON.stringify(record.details)}`);
	const line = String(record.text ?? "").split("\n")[0];
	if (line !== firstLine(expected.details)) problems.push(`first line: expected ${JSON.stringify(firstLine(expected.details))}, got ${JSON.stringify(line)}`);
	return problems;
}

const actualOf = (record) =>
	!record ? null : record.error ? { error: record.error } : { details: record.details, firstLine: String(record.text).split("\n")[0] };

function scenarioEntry(name, label, sent, dialogShown, expected, record, extraProblems = []) {
	const mismatches = [...extraProblems, ...checkResult(expected, record)];
	return {
		scenario: name,
		label,
		...sent,
		dialogShown,
		expected: expected.error ? { error: expected.error } : { details: expected.details, firstLine: firstLine(expected.details) },
		actual: actualOf(record),
		pass: mismatches.length === 0,
		mismatches,
	};
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

function runRpc() {
	return new Promise((resolve) => {
		const child = spawn(PI, ["--mode", "rpc", "--no-session", ...QUIET, ...EXTENSIONS], { cwd: ROOT });
		const send = (r) => child.stdin.write(`${JSON.stringify(r)}\n`);
		const section = { command: `${PI} --mode rpc --no-session ${QUIET.join(" ")} ${EXTENSIONS.join(" ")}`, registered: false, scenarios: [], modelEvents: [], messagesInContext: null, stderr: "" };
		let current = -1;
		let state;
		let buffer = "";
		const done = (why) => {
			if (why) section.error = why;
			clearTimeout(timer);
			child.stdin.end();
			setTimeout(() => child.kill(), 1500).unref();
			resolve(section);
		};
		const next = () => {
			current++;
			if (current >= RPC_SCENARIOS.length) return send({ id: "messages", type: "get_messages" });
			state = { sc: RPC_SCENARIOS[current], shown: [], sent: [], record: null, problems: [] };
			send({ id: `s-${current}`, type: "prompt", message: `/${COMMAND} ${state.sc.name}` });
		};
		const finishScenario = () => {
			const { sc, shown, sent, record, problems } = state;
			if (shown.length < sc.dialogs.length) problems.push(`expected ${sc.dialogs.length} dialog(s), Pi forwarded ${shown.length}`);
			section.scenarios.push(scenarioEntry(sc.name, sc.label, { responsesSent: sent }, shown, sc, record, problems));
			next();
		};
		const handle = (r) => {
			if (["agent_start", "turn_start"].includes(r.type) || (r.type === "message_start" && r.message?.role === "assistant")) section.modelEvents.push(r.type);
			if (r.type === "response" && r.command === "get_commands") {
				section.registered = r.data.commands.some((c) => c.name === COMMAND);
				return section.registered ? next() : done(`/${COMMAND} is not registered; nothing was sent`);
			}
			if (r.type === "extension_ui_request" && (r.method === "select" || r.method === "input")) {
				const want = state.sc.dialogs[state.shown.length];
				const payload = { method: r.method, title: r.title, ...(r.method === "select" ? { options: r.options } : { placeholder: r.placeholder }), timeout: r.timeout };
				state.shown.push(payload);
				if (r.timeout !== undefined) state.problems.push(`dialog ${state.shown.length} has a timeout (${r.timeout})`);
				if (!want) {
					state.problems.push(`unexpected ${r.method} dialog`);
					state.sent.push({ cancelled: true });
					return send({ type: "extension_ui_response", id: r.id, cancelled: true });
				}
				const { respond, ...expectedPayload } = want;
				const gotPayload = { method: r.method, title: r.title, ...(r.method === "select" ? { options: r.options } : { placeholder: r.placeholder }) };
				if (!isDeepStrictEqual(gotPayload, expectedPayload)) state.problems.push(`dialog ${state.shown.length}: expected ${JSON.stringify(expectedPayload)}, got ${JSON.stringify(gotPayload)}`);
				state.sent.push(respond);
				return send({ type: "extension_ui_response", id: r.id, ...respond });
			}
			if (r.type === "entry_appended" && r.entry?.customType === COMMAND) state.record = r.entry.data;
			if (r.type === "response" && r.id === `s-${current}`) {
				if (!r.success) state.problems.push(`prompt failed: ${r.error}`);
				return finishScenario();
			}
			if (r.type === "response" && r.id === "messages") {
				section.messagesInContext = r.data.messages.length;
				return done();
			}
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			let i;
			while ((i = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				if (line.trim()) handle(JSON.parse(line));
			}
		});
		child.stderr.on("data", (d) => (section.stderr += d));
		child.on("exit", (code) => current < RPC_SCENARIOS.length && done(`pi exited early (code ${code})`));
		const timer = setTimeout(() => done("timeout after 120s"), 120_000);
		send({ id: "commands", type: "get_commands" });
	});
}

// ---------------------------------------------------------------------------
// TUI
// ---------------------------------------------------------------------------

/** The rendered lines, trimmed, with the selection arrow removed. */
const screenLines = (text) => String(text ?? "").split("\n").map((l) => l.replace(/^\s*→\s?/, "").trim()).filter(Boolean);
const hasRun = (lines, run) => lines.some((_, i) => run.every((want, k) => lines[i + k] === want));

function runTui(resultsFile) {
	const started = Date.now();
	const proc = spawnSync("/usr/bin/python3", [path.join(ROOT, "test", "real-test", "real-tui.py"), resultsFile], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
	const section = { driver: "python3 test/real-test/real-tui.py (pty)", durationMs: Date.now() - started, scenarios: [] };
	let observed;
	try {
		observed = JSON.parse(proc.stdout);
	} catch {
		section.error = `driver failed (exit ${proc.status}): ${String(proc.stderr || proc.stdout).slice(0, 500)}`;
		return section;
	}
	section.terminal = observed.terminal;
	section.startup = observed.startup;
	for (const [name, expected] of Object.entries(TUI_EXPECTED)) {
		const o = observed.scenarios.find((s) => s.scenario === name);
		if (!o) {
			section.scenarios.push(scenarioEntry(name, expected.label, { keysPressed: [] }, null, expected, null, ["scenario not run"]));
			continue;
		}
		const problems = [...o.problems];
		const menu = screenLines(o.screen.menu);
		const titleBlock = [Q[name], `Why it matters: ${REASON}`, ...TITLE_OPTIONS.filter(Boolean).map((l) => l.trim())];
		if (!hasRun(menu, titleBlock)) problems.push("screen did not show the question, reason and options block as expected");
		if (!hasRun(menu, CHOICES)) problems.push("screen did not show the four numbered choices in order");
		if (expected.textbox && !screenLines(o.screen.textbox).some((l) => l.includes("submit"))) problems.push("text box not seen on screen");
		if (expected.followUp !== undefined) {
			const lines = screenLines(o.screen.followup);
			if (!lines.includes(`Apply "${expected.followUp}" to similar questions this session?`.trim())) problems.push("follow-up title not seen on screen");
			if (!hasRun(lines, SCOPE)) problems.push("follow-up choices not seen on screen");
		} else if (o.screen.followup !== undefined) problems.push("a follow-up was driven where none was expected");
		const shown = {
			menu: o.screen.menu,
			...(o.screen.textbox !== undefined ? { textbox: o.screen.textbox } : {}),
			...(o.screen.followup !== undefined ? { followup: o.screen.followup } : {}),
		};
		section.scenarios.push(scenarioEntry(name, expected.label, { keysPressed: o.keysPressed }, shown, expected, o.record, problems));
	}
	return section;
}

// ---------------------------------------------------------------------------
// Print mode
// ---------------------------------------------------------------------------

function runPrint(dir) {
	const section = { scenarios: [] };
	const prompt = `/${COMMAND} unavailable`;
	const env = (file) => ({ ...process.env, ASK_USER_REAL_RESULTS: file });
	const printFile = path.join(dir, "print.jsonl");
	const printArgs = ["-p", "--no-session", ...QUIET, ...EXTENSIONS, prompt];
	const print = spawnSync(PI, printArgs, { cwd: ROOT, env: env(printFile), input: "", encoding: "utf8", timeout: 60_000 });
	const record = readRecords(printFile)[0];
	const problems = [];
	if (print.status !== 0) problems.push(`pi -p exited ${print.status}: ${print.stderr}`);
	if (print.stdout.trim()) problems.push(`pi -p printed model output: ${JSON.stringify(print.stdout.slice(0, 200))}`);
	if (record && (record.mode !== "print" || record.hasUI !== false)) problems.push(`ran in mode ${record.mode} with hasUI ${record.hasUI}`);

	// Witness: the same command in JSON mode shows every session event; a model turn would appear here.
	const jsonFile = path.join(dir, "json.jsonl");
	const json = spawnSync(PI, ["--mode", "json", "--no-session", ...QUIET, ...EXTENSIONS, prompt], { cwd: ROOT, env: env(jsonFile), input: "", encoding: "utf8", timeout: 60_000 });
	const eventTypes = [...new Set(json.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l).type))];
	const modelEvents = eventTypes.filter((t) => !["session", "entry_appended"].includes(t));
	if (modelEvents.length) problems.push(`JSON-mode witness saw model events: ${modelEvents.join(", ")}`);
	if (readRecords(jsonFile)[0]?.details?.status !== "unavailable") problems.push("JSON-mode run did not return unavailable");

	section.witness = { command: `${PI} --mode json --no-session ${QUIET.join(" ")} ${EXTENSIONS.join(" ")} "${prompt}"`, eventTypes };
	section.scenarios.push(
		scenarioEntry(
			"unavailable",
			"print mode (no UI) returns unavailable without a model call",
			{ command: `${PI} ${printArgs.slice(0, -1).join(" ")} "${prompt}" < /dev/null` },
			null,
			{ details: { status: "unavailable", question: Q.unavailable } },
			record,
			problems,
		),
	);
	return section;
}

function readRecords(file) {
	try {
		return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// /ask-user on|off|status and /ask-user-try (commands only, no model)
// ---------------------------------------------------------------------------

/**
 * Start Pi in RPC mode with `env`, run `/commands` one by one, and collect the
 * notifications each produced (plus the ones from startup). `answer(request)`
 * answers any dialog. Every command is checked to be registered first, so
 * nothing can fall through to the model.
 */
function rpcCommands({ env, extraArgs = [], extensions, commands, answer = () => ({ cancelled: true }) }) {
	return new Promise((resolve) => {
		const child = spawn(PI, ["--mode", "rpc", "--no-session", ...QUIET, ...extraArgs, ...extensions], { cwd: ROOT, env: { ...process.env, ...env } });
		const send = (r) => child.stdin.write(`${JSON.stringify(r)}\n`);
		const out = { startupNotes: [], steps: [], modelEvents: [], messagesInContext: null, error: undefined };
		let step = null;
		let i = -1;
		let buffer = "";
		const finish = (error) => {
			out.error ??= error;
			clearTimeout(timer);
			child.stdin.end();
			setTimeout(() => child.kill(), 1500).unref();
			resolve(out);
		};
		const next = () => {
			i++;
			if (i >= commands.length) return send({ id: "messages", type: "get_messages" });
			step = { command: commands[i], notes: [], dialogs: [] };
			out.steps.push(step);
			send({ id: `c-${i}`, type: "prompt", message: commands[i] });
		};
		const handle = (r) => {
			if (["agent_start", "turn_start"].includes(r.type) || (r.type === "message_start" && r.message?.role === "assistant")) out.modelEvents.push(r.type);
			if (r.type === "extension_ui_request" && r.method === "notify") (step ? step.notes : out.startupNotes).push({ message: r.message, level: r.notifyType ?? "info" });
			if (r.type === "extension_ui_request" && (r.method === "select" || r.method === "input")) {
				const response = answer(r);
				step?.dialogs.push({ method: r.method, title: r.title, options: r.options, response });
				send({ type: "extension_ui_response", id: r.id, ...response });
			}
			if (r.type === "response" && r.command === "get_commands") {
				const names = r.data.commands.map((c) => c.name);
				const missing = commands.map((c) => c.slice(1).split(" ")[0]).filter((name) => !names.includes(name));
				return missing.length ? finish(`commands not registered: ${missing.join(", ")}`) : next();
			}
			if (r.type === "response" && r.id === `c-${i}`) return next();
			if (r.type === "response" && r.id === "messages") {
				out.messagesInContext = r.data.messages.length;
				return finish();
			}
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			let n;
			while ((n = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, n);
				buffer = buffer.slice(n + 1);
				if (line.trim()) handle(JSON.parse(line));
			}
		});
		child.on("exit", (code) => finish(`pi exited early (code ${code})`));
		const timer = setTimeout(() => finish("timeout after 60s"), 60_000);
		send({ id: "commands", type: "get_commands" });
	});
}

const ON_TEXT = "ask_user is ON: the agent can ask you questions";
const OFF_TEXT = "ask_user is OFF: the agent won't ask and will decide on its own";
const witnessOf = (step) => {
	const note = step?.notes.find((n) => n.message.startsWith("witness "));
	return note ? JSON.parse(note.message.slice("witness ".length)) : null;
};

async function runToggle(dir) {
	const agentDir = path.join(dir, "agent"); // temp PI_CODING_AGENT_DIR: the user's real setting is never touched
	const env = { PI_CODING_AGENT_DIR: agentDir };
	const extensions = ["-e", "./src/index.ts", "-e", "./test/real-test/active-tools-witness.ts"];
	const stateFile = path.join(agentDir, "ask-user-state.json");
	const readSaved = () => {
		try {
			return JSON.parse(readFileSync(stateFile, "utf8"));
		} catch {
			return null;
		}
	};
	const section = { agentDir: "(temp dir, removed afterwards)", scenarios: [] };
	const add = (name, label, sent, shown, expected, actual, problems) =>
		section.scenarios.push({ scenario: name, label, commandsSent: sent, dialogShown: shown, expected, actual, pass: problems.length === 0, mismatches: problems });
	const ok = (cond, message, problems) => cond || problems.push(message);

	// 1. Default on → off in one process.
	const p1 = await rpcCommands({ env, extensions, commands: ["/active-tools-witness", "/ask-user off", "/active-tools-witness", "/ask_user status"] });
	{
		const problems = [];
		const [w0, off, w1, status] = p1.steps;
		ok(witnessOf(w0)?.askUserActive === true && witnessOf(w0)?.promptMentionsAskUser === true, "default: ask_user should be active and in the prompt", problems);
		ok(off?.notes.some((n) => n.message === OFF_TEXT), `off should say ${JSON.stringify(OFF_TEXT)}`, problems);
		ok(witnessOf(w1)?.askUserActive === false, "after off: ask_user must not be an active tool", problems);
		ok(witnessOf(w1)?.promptMentionsAskUser === false, "after off: ask_user must not appear in the system prompt", problems);
		ok(isDeepStrictEqual(witnessOf(w1)?.active, witnessOf(w0)?.active.filter((t) => t !== "ask_user")), "after off: the other tools must be unchanged", problems);
		ok(/^ask_user is OFF \(saved in .*ask-user-state\.json\)\./.test(status?.notes[0]?.message ?? ""), "/ask_user (alias) status should show OFF and the file", problems);
		ok(isDeepStrictEqual(readSaved(), { enabled: false }), "the file should hold {enabled:false}", problems);
		ok(p1.modelEvents.length === 0 && p1.messagesInContext === 0, "no model activity", problems);
		if (p1.error) problems.push(p1.error);
		add("off", "default on; /ask-user off removes ask_user from the tools and the prompt; /ask_user alias works", p1.steps.map((s) => s.command), null, { before: "active", after: "not active", file: { enabled: false } }, { witnessBefore: witnessOf(w0), witnessAfter: witnessOf(w1), notes: p1.steps.map((s) => s.notes), file: readSaved() }, problems);
	}

	// 2. A fresh Pi process keeps it off; /ask-user on restores it.
	const p2 = await rpcCommands({ env, extensions, commands: ["/active-tools-witness", "/ask-user on", "/active-tools-witness"] });
	{
		const problems = [];
		const [w0, on, w1] = p2.steps;
		ok(p2.startupNotes.some((n) => n.message.startsWith(OFF_TEXT)), "startup should say it is OFF", problems);
		ok(witnessOf(w0)?.askUserActive === false && witnessOf(w0)?.promptMentionsAskUser === false, "a fresh process must keep ask_user off", problems);
		ok(on?.notes.some((n) => n.message === ON_TEXT), `on should say ${JSON.stringify(ON_TEXT)}`, problems);
		ok(witnessOf(w1)?.askUserActive === true && witnessOf(w1)?.promptMentionsAskUser === true, "after on: ask_user active and in the prompt again", problems);
		ok(isDeepStrictEqual(readSaved(), { enabled: true }), "the file should hold {enabled:true}", problems);
		ok(p2.modelEvents.length === 0 && p2.messagesInContext === 0, "no model activity", problems);
		if (p2.error) problems.push(p2.error);
		add("persist-and-on", "the OFF setting survives a fresh Pi process; /ask-user on restores ask_user", p2.steps.map((s) => s.command), null, { startup: "OFF", after: "active", file: { enabled: true } }, { startupNotes: p2.startupNotes, witnessBefore: witnessOf(w0), witnessAfter: witnessOf(w1), file: readSaved() }, problems);
	}

	// 3. Started with --tools read (ask_user excluded): on explains why it can't.
	const p3 = await rpcCommands({ env, extensions, extraArgs: ["--tools", "read"], commands: ["/ask-user on", "/active-tools-witness"] });
	{
		const problems = [];
		const [on, w] = p3.steps;
		ok(on?.notes.some((n) => n.level === "warning" && /started without it \(--tools, --exclude-tools or --no-tools\)/.test(n.message)), "on should explain the startup exclusion", problems);
		ok(witnessOf(w)?.askUserActive === false, "ask_user stays inactive when excluded at startup", problems);
		if (p3.error) problems.push(p3.error);
		add("excluded", "started with --tools read: /ask-user on says why it can't turn on", p3.steps.map((s) => s.command), null, { warning: "started without it" }, { notes: on?.notes, witness: witnessOf(w) }, problems);
	}

	// 4. A corrupt file: ON plus a warning, no crash.
	writeFileSync(stateFile, "{oops");
	const p4 = await rpcCommands({ env, extensions, commands: ["/active-tools-witness"] });
	{
		const problems = [];
		ok(p4.startupNotes.some((n) => n.level === "warning" && /stays ON/.test(n.message)), "startup should warn about the corrupt file", problems);
		ok(witnessOf(p4.steps[0])?.askUserActive === true, "a corrupt file means ON", problems);
		if (p4.error) problems.push(p4.error);
		add("corrupt-file", "a corrupt state file: ON plus a warning, no crash", ["(state file = \"{oops\")", ...p4.steps.map((s) => s.command)], null, { warning: "stays ON", active: true }, { startupNotes: p4.startupNotes, witness: witnessOf(p4.steps[0]) }, problems);
	}
	return section;
}

/** The dev-only /ask-user-try command (scripts/try-ask-user.ts) keeps working. */
async function runTry(dir) {
	const env = { PI_CODING_AGENT_DIR: path.join(dir, "agent-try") };
	const run = await rpcCommands({
		env,
		extensions: ["-e", "./src/index.ts", "-e", "./scripts/try-ask-user.ts"],
		commands: ["/ask-user-try invalid", "/ask-user-try norec"],
		answer: (r) => ({ value: r.options[0] }), // option 1, then "1. Just this time"
	});
	const [invalid, norec] = run.steps;
	const section = { scenarios: [] };
	const p1 = [];
	if (!invalid?.notes.some((n) => n.level === "error" && n.message.startsWith("tool error (no dialog opened): ask_user: options must be an array of 2 or 3 items"))) p1.push("invalid example should report the tool error");
	if (invalid?.dialogs.length) p1.push("invalid example must not open a dialog");
	section.scenarios.push({ scenario: "try-invalid", label: "/ask-user-try invalid: tool error, no dialog", commandsSent: [invalid?.command], dialogShown: invalid?.dialogs ?? [], expected: "tool error, no dialog", actual: invalid?.notes, pass: p1.length === 0, mismatches: p1 });
	const p2 = [];
	if (norec?.dialogs.length !== 2) p2.push(`norec should open the menu and the follow-up (got ${norec?.dialogs.length ?? 0} dialogs)`);
	const note = norec?.notes.find((n) => n.message.startsWith("ask_user: answered"))?.message ?? "";
	if (!note.includes('"answer": "Delete them"') || !note.includes('"scope": "once"')) p2.push("norec should show the answered result with scope once");
	if (run.modelEvents.length || run.messagesInContext !== 0) p2.push("no model activity");
	if (run.error) p2.push(run.error);
	section.scenarios.push({ scenario: "try-norec", label: "/ask-user-try norec: real dialog, full result shown", commandsSent: [norec?.command], dialogShown: norec?.dialogs ?? [], expected: "answered Delete them, scope once", actual: norec?.notes, pass: p2.length === 0, mismatches: p2 });
	return section;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const dir = mkdtempSync(path.join(tmpdir(), "ask-user-real-"));
const sections = {};
try {
	sections.rpc = await runRpc();
	if (sections.rpc.modelEvents.length) sections.rpc.error = `model events seen: ${sections.rpc.modelEvents.join(", ")}`;
	if (sections.rpc.messagesInContext !== 0) sections.rpc.error ??= `expected 0 messages in context, got ${sections.rpc.messagesInContext}`;
	sections.tui = runTui(path.join(dir, "tui.jsonl"));
	// Print mode sends the prompt text to the model if the command is missing, so only run it once RPC confirmed it.
	sections.print = sections.rpc.registered ? runPrint(dir) : { error: "skipped: command not registered", scenarios: [] };
	sections.toggle = await runToggle(dir);
	sections.try = await runTry(dir);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

const all = Object.values(sections).flatMap((s) => s.scenarios);
const sectionErrors = Object.entries(sections).filter(([, s]) => s.error).map(([name, s]) => `${name}: ${s.error}`);
const passed = all.filter((s) => s.pass).length;
const piVersion = spawnSync(PI, ["--version"], { encoding: "utf8" }).stdout.trim();
const report = {
	generatedAt: new Date().toISOString(),
	node: process.version,
	pi: piVersion,
	note: "Real Pi driven without a model: RPC dialog responses, real TUI keystrokes in a pty, print mode, the /ask-user on|off toggle (temp agent dir), and /ask-user-try.",
	totals: { scenarios: all.length, passed, failed: all.length - passed, sectionErrors },
	...sections,
};
mkdirSync(path.dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`);

for (const [name, section] of Object.entries(sections)) {
	for (const s of section.scenarios) {
		console.log(`${s.pass ? "PASS" : "FAIL"}  ${name.padEnd(6)}  ${s.label}`);
		for (const m of s.mismatches) console.log(`        - ${m}`);
	}
	if (section.error) console.log(`ERROR ${name}: ${section.error}`);
}
console.log(`\nrpc: ${sections.rpc.messagesInContext} messages in context, model events: ${sections.rpc.modelEvents.length}; print witness events: ${sections.print.witness?.eventTypes.join(", ") ?? "-"}`);
console.log(`${passed}/${all.length} scenarios passed${sectionErrors.length ? `, ${sectionErrors.length} section error(s)` : ""}`);
console.log(`Wrote ${OUT_FILE}`);
process.exitCode = passed === all.length && sectionErrors.length === 0 ? 0 : 1;
