import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { askUser } from "./ask-user.ts";

const OptionSchema = Type.Object({
	label: Type.String({ minLength: 1, description: "Short option name shown to the user. Unique among the options." }),
	tradeoff: Type.String({
		minLength: 1,
		description: "One honest line on what the user gains and gives up with this option.",
	}),
}, { additionalProperties: false });

export const AskUserParams = Type.Object({
	question: Type.String({ minLength: 1, description: "One clear question about a single decision." }),
	reason: Type.String({
		minLength: 1,
		description: "Why the choice matters: how it changes behavior, scope, or the amount of rework.",
	}),
	options: Type.Array(OptionSchema, { minItems: 2, maxItems: 3, description: "2 or 3 real options." }),
	recommendation: Type.Optional(
		Type.String({
			description:
				"Label of the option you recommend, if you have a view. Must match one option label. Top-level field, not inside an option.",
		}),
	),
}, { additionalProperties: false });

export default function askUserExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the user one decision question in a dialog and wait for their answer. Use it only when an unresolved " +
			"choice materially changes user-visible behavior, scope, or the amount of rework, and the user has not decided it. " +
			"Give 2-3 real options with honest tradeoffs and, if you have a view, a recommendation; the user may also type " +
			"their own answer. The result status is answered (with the user's answer), cancelled, or unavailable. " +
			"Only answered carries an answer.",
		promptSnippet:
			"Ask the user one decision question with 2-3 options when an unresolved choice materially changes behavior, scope, or rework",
		promptGuidelines: [
			"Use ask_user only when an unresolved choice materially changes user-visible behavior, scope, or the amount of rework, and the user has not decided it.",
			'Do not use ask_user when the user already specified the behavior, when they delegated the choice ("your call", "as you think best") — then make the choice and say which one you made — or when the detail is routine and easy to reverse (names, formatting, internal structure, test layout).',
			"Ask one question per ask_user call, with 2-3 real options, honest tradeoffs, and a recommendation if you have a view.",
			"If ask_user returns answered, act on the user's answer, even when it differs from your recommendation.",
			"If ask_user returns cancelled or unavailable, do not invent or assume an answer: say which decision is still open and continue only with work that does not depend on it.",
		],
		parameters: AskUserParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return askUser(params, signal, ctx);
		},
	});
}
