// Dev-only extension for trying ask_user by hand, without a model (load with -e;
// never part of the package). /ask-user-try [example] opens the REAL ask_user
// dialog through Pi's own UI and shows the full result the agent would receive:
// the content text and the details. Nothing is sent to the model.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAskUserTool } from "../src/index.ts";

const EXAMPLES: Record<string, unknown> = {
	reminder: {
		question: "Should the reminder remember previous notifications after Pi restarts?",
		reason: "Persistence changes what you see after a restart and is costly to redo.",
		options: [
			{ label: "Session only", tradeoff: "Simpler; forgets everything when Pi restarts." },
			{ label: "Persist to disk", tradeoff: "Survives restarts; needs a state file and cleanup." },
		],
		recommendation: "Persist to disk",
	},
	database: {
		question: "Which database should the cache use?",
		reason: "Changes deployment needs; costly to migrate later.",
		options: [
			{ label: "SQLite", tradeoff: "Zero setup; one writer at a time" },
			{ label: "Postgres", tradeoff: "Needs a server; handles concurrent writers" },
			{ label: "In-memory", tradeoff: "Fastest; lost on restart" },
		],
		recommendation: "Postgres",
	},
	norec: {
		question: "How should old log files be handled?",
		reason: "Deleting is permanent; archiving uses disk space.",
		options: [
			{ label: "Delete them", tradeoff: "Frees space; can't be undone" },
			{ label: "Archive them", tradeoff: "Recoverable; the archive keeps growing" },
		],
	},
	invalid: {
		question: "Which port should the server use?",
		reason: "Other services may already use some ports.",
		options: [{ label: "3000", tradeoff: "Common default" }],
	},
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ask-user-try", {
		description: "Dev-only: open the real ask_user dialog with an example and show the full result (no model)",
		handler: async (args, ctx) => {
			const name = args.trim() || "reminder";
			const params = EXAMPLES[name];
			if (params === undefined) {
				ctx.ui.notify(`Usage: /ask-user-try [${Object.keys(EXAMPLES).join("|")}]`, "warning");
				return;
			}
			// In print/JSON mode there is no UI to show a notification, so print to the terminal instead.
			const show = (message: string, level: "info" | "error") =>
				ctx.hasUI ? ctx.ui.notify(message, level) : console.log(message);
			// A fresh tool each time, so earlier tries never count as repeats.
			const tool = createAskUserTool();
			try {
				const result = await tool.execute(`try-${Date.now()}`, params as never, undefined, undefined, ctx);
				const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
				show(`${text}\n\ndetails: ${JSON.stringify(result.details, null, 2)}`, "info");
			} catch (error) {
				// Invalid input is a tool error: the model would see this message and fix its call.
				show(`tool error (no dialog opened): ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
