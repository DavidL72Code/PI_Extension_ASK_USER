// /ask-user-test: runs the randomized self-test inside Pi and posts the report
// in the transcript. The report is a custom *entry* (pi.appendEntry plus an
// entry renderer), which Pi shows in the chat but never sends to the model.
// A custom *message* (pi.sendMessage) would be converted to user text in the
// next model request, so it is deliberately not used here.

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { AskUserResult } from "./ask-user.ts";
import { formatSelfTestReport, runSelfTest, type Execute } from "./self-test.ts";

export const SELF_TEST_COMMAND = "ask-user-test";
export const REPORT_ENTRY = "ask-user-test-report";
const MAX_ROUNDS = 100;

export const SELF_TEST_USAGE = [
	`Usage: /${SELF_TEST_COMMAND} run_test [seed|random] [rounds]`,
	"  Runs the randomized ask_user self-test against the real tool with a fake dialog.",
	"  No model call; the report is shown in the chat but not sent to the model.",
	`  A seed reproduces a run; rounds defaults to 1 (max ${MAX_ROUNDS}).`,
].join("\n");

export interface ReportEntry {
	text: string;
	failed: number;
}

type Parsed = { seed: number | undefined; rounds: number } | undefined;

function parseArgs(args: string): Parsed {
	const [sub, seedArg, roundsArg, ...rest] = args.trim().split(/\s+/).filter(Boolean);
	if (!["run_test", "run-test", "test"].includes(sub ?? "") || rest.length) return undefined;
	if (seedArg !== undefined && seedArg !== "random" && !/^\d+$/.test(seedArg)) return undefined;
	if (roundsArg !== undefined && !/^\d+$/.test(roundsArg)) return undefined;
	const rounds = roundsArg === undefined ? 1 : Number(roundsArg);
	if (rounds < 1 || rounds > MAX_ROUNDS) return undefined;
	return { seed: seedArg === undefined || seedArg === "random" ? undefined : Number(seedArg) >>> 0, rounds };
}

/** Drive a tool definition's execute() the way runSelfTest expects. */
export const executeTool =
	(tool: ToolDefinition<any, any>): Execute =>
	(params, signal, ctx, toolCallId) =>
		tool.execute(toolCallId, params as never, signal, undefined, ctx as never) as Promise<AskUserResult>;

/** `makeTool` builds a fresh ask_user tool per run, so self-test calls never share memory with the live tool. */
export function registerSelfTestCommand(pi: ExtensionAPI, makeTool: () => ToolDefinition<any, any>) {
	pi.registerEntryRenderer<ReportEntry>(REPORT_ENTRY, (entry, _options, theme) => {
		const lines = (entry.data?.text ?? "").split("\n").map((line, i) => {
			if (i === 0) return theme.fg("accent", theme.bold(line));
			if (line.startsWith("PASS")) return theme.fg("success", line);
			if (line.startsWith("FAIL") || line.startsWith("      -")) return theme.fg("error", line);
			return theme.fg("customMessageText", line);
		});
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});

	pi.registerCommand(SELF_TEST_COMMAND, {
		description: "ask_user: run the randomized self-test (run_test [seed] [rounds]); nothing is sent to the model",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if (!parsed) {
				ctx.ui.notify(SELF_TEST_USAGE, args.trim() ? "warning" : "info");
				return;
			}
			const summary = await runSelfTest({ seed: parsed.seed, rounds: parsed.rounds, execute: executeTool(makeTool()) });
			const rerun = `/${SELF_TEST_COMMAND} run_test ${summary.seed}${summary.rounds > 1 ? ` ${summary.rounds}` : ""}`;
			const { passed, failed, scenarios } = summary.totals;
			ctx.ui.notify(
				`ask_user self-test: ${passed}/${scenarios} passed${failed ? `, ${failed} FAILED` : ""} (seed ${summary.seed})`,
				failed ? "error" : "info",
			);
			pi.appendEntry<ReportEntry>(REPORT_ENTRY, { text: formatSelfTestReport(summary, rerun).join("\n"), failed });
		},
	});
}
