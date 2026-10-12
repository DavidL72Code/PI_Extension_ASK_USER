// The one mechanical repeat check: identical ask_user calls fired as siblings in
// the SAME assistant message share one dialog. Everything across turns is the
// model's call (it reads the conversation).
//
// "Same assistant message": Pi saves an assistant message, with all of its tool
// calls, on the session branch before it runs any of them. So the entry on the
// current branch whose content holds this call's toolCallId lists exactly the
// calls made together with it. Their results come from this tool instance's
// memory of what it returned (keyed by toolCallId), so nothing from an older turn,
// another branch, or another session can match.

import { callKey, type AskUserDetails, type SiblingResult } from "./ask-user.ts";

/** The slice of Pi's ReadonlySessionManager this needs. */
export interface SessionView {
	getBranch(): readonly unknown[];
}

type ToolCallPart = { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };

const LIMIT = 100;

export function createSiblingMemory() {
	const returned = new Map<string, AskUserDetails>();
	return {
		/** Results of the ask_user calls before `toolCallId` in the same assistant message, in order. */
		siblings(session: SessionView, toolCallId: string): SiblingResult[] {
			const branch = session.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i] as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
				if (entry?.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
				const calls = (entry.message.content as ToolCallPart[]).filter((p) => p?.type === "toolCall" && p.name === "ask_user");
				const at = calls.findIndex((p) => p.id === toolCallId);
				if (at === -1) continue;
				return calls.slice(0, at).flatMap((p) => {
					const details = returned.get(String(p.id));
					const call = callKey(p.arguments);
					return details && call !== undefined ? [{ toolCallId: String(p.id), details, call }] : [];
				});
			}
			return [];
		},
		/** Remember what this tool returned for a call. */
		remember(toolCallId: string, details: AskUserDetails) {
			returned.delete(toolCallId);
			returned.set(toolCallId, details);
			if (returned.size > LIMIT) returned.delete(returned.keys().next().value!);
		},
	};
}
