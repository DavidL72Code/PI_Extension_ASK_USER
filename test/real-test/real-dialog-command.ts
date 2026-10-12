// Dev-only extension for test/real-test (load with -e; never part of the
// package). Registers /ask-user-real-check <scenario>, which runs the REAL
// ask_user tool (createAskUserTool().execute) with Pi's REAL command ctx, so the
// dialogs are Pi's own (TUI on screen, RPC forwarded, none in print mode).
//
// No model is involved: a command runs immediately, and its result is recorded
// as a custom entry (never sent to the model) and, when ASK_USER_REAL_RESULTS
// names a file, appended to that file as one JSON line.
//
// One tool instance serves the whole Pi process. Each command is a separate call
// (not a sibling in one assistant message), so an identical call made by a later
// command must open its dialog again: the model, not the tool, decides whether an
// earlier answer still applies.

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAskUserTool } from "../../src/index.ts";

export const REAL_CHECK_COMMAND = "ask-user-real-check";

const OPTIONS = [
	{ label: "SQLite", tradeoff: "Zero setup; one writer at a time" },
	{ label: "Postgres", tradeoff: "Needs a server; handles concurrent writers" },
	{ label: "In-memory", tradeoff: "Fastest; lost on restart" },
];
const REASON = "Changes deployment needs; costly to migrate later.";
const ask = (question: string, extra: Record<string, unknown> = { recommendation: "Postgres" }) => ({
	question,
	reason: REASON,
	options: OPTIONS,
	...extra,
});

/** Each scenario has its own question; the `again-*` ones repeat earlier calls on purpose. */
export const SCENARIOS: Record<string, unknown> = {
	recommended: ask("Which database should the cache use?"),
	against: ask("Which database should the queue use?"),
	custom: ask("Where should exports be saved?"),
	"esc-menu": ask("How should old log files be handled?"),
	"esc-textbox": ask("Should reminders survive a Pi restart?"),
	empty: ask("Which format should exports use?"),
	whitespace: ask("Which retention period should logs use?"),
	"unknown-value": ask("Which port should the server use?"),
	// Rule 16 follow-up: "Also for similar questions", and Esc on the follow-up.
	"scope-similar": ask("Which cache eviction policy should we use?"),
	"scope-esc": ask("Which log format should we use?"),
	// Same calls as `recommended` and `esc-menu`, written differently: a later, identical call asks again.
	"again-answered": ask("  which DATABASE should   the cache use  "),
	"again-dismissed": ask("how should old LOG files be handled"),
	invalid: { question: "Pick one?", reason: REASON, options: [OPTIONS[0]] },
	unavailable: ask("Should the CLI keep tasks on disk?"),
};

export default function realDialogCommand(pi: ExtensionAPI) {
	const tool = createAskUserTool();
	let calls = 0;

	pi.registerCommand(REAL_CHECK_COMMAND, {
		description: "Dev-only: run ask_user with real Pi dialogs for one test scenario (no model)",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			const scenario = args.trim();
			const params = SCENARIOS[scenario];
			if (!params) {
				ctx.ui.notify(`Usage: /${REAL_CHECK_COMMAND} <${Object.keys(SCENARIOS).join("|")}>`, "warning");
				return;
			}
			let record: Record<string, unknown>;
			try {
				const result = await tool.execute(`real-check-${++calls}`, params as never, ctx.signal, undefined, ctx);
				const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
				record = { scenario, mode: ctx.mode, hasUI: ctx.hasUI, details: result.details, text };
			} catch (error) {
				record = { scenario, mode: ctx.mode, hasUI: ctx.hasUI, error: error instanceof Error ? error.message : String(error) };
			}
			if (process.env.ASK_USER_REAL_RESULTS) appendFileSync(process.env.ASK_USER_REAL_RESULTS, `${JSON.stringify(record)}\n`);
			pi.appendEntry("ask-user-real-check", record);
			const status = record.error ? "error" : (record.details as { status: string }).status;
			ctx.ui.notify(`${REAL_CHECK_COMMAND} ${scenario}: ${status}`, "info");
		},
	});
}
