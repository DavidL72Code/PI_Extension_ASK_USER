// Dev-only extension for test/real-test (load with -e; never part of the package).
// /active-tools-witness reports, independently of /ask-user's own messages, what
// Pi will send the model: the active tool names and whether ask_user appears in
// the current system prompt (its snippet and guidelines). One JSON line via
// notify; no model call.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function activeToolsWitness(pi: ExtensionAPI) {
	pi.registerCommand("active-tools-witness", {
		description: "Dev-only: report the active tools and whether ask_user is in the system prompt",
		handler: async (_args, ctx) => {
			const active = pi.getActiveTools();
			const prompt = ctx.getSystemPrompt();
			ctx.ui.notify(
				`witness ${JSON.stringify({ active, askUserActive: active.includes("ask_user"), promptMentionsAskUser: prompt.includes("ask_user") })}`,
				"info",
			);
		},
	});
}
