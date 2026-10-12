import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { askUser, type AskUserDetails } from "./ask-user.ts";
import { createSiblingMemory, type SessionView } from "./siblings.ts";
import { registerSelfTestCommand } from "./self-test-command.ts";
import { registerToggle } from "./toggle.ts";

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

// ---------------------------------------------------------------------------
// Model-facing guidance (edit here to change when the model asks)
// ---------------------------------------------------------------------------

export const ASK_USER_DESCRIPTION =
	"Ask the user one decision question in a dialog and wait for the answer. Use it only for an unresolved choice that " +
	"materially changes user-visible behavior, scope, or the amount of rework, and that the user has not decided. " +
	"Ask before starting the work. Give 2-3 real options with honest tradeoffs and, if you have a view, a recommendation; " +
	"the user may also type their own answer. The status is answered (with the answer), cancelled, or unavailable; only " +
	"answered carries an answer. After answering, the user can apply the answer to similar questions this session " +
	'(scope "similar"). Before asking, check the conversation: reuse an earlier answer to the same decision in the same ' +
	"scenario instead of asking again; ask again when a new task or scenario needs its own answer.";

export const ASK_USER_PROMPT_SNIPPET =
	"Ask the user about the single most important decision that is material and not yet decided (2-3 options), before starting the work";

export const ASK_USER_GUIDELINES = [
	"Use ask_user only for an unresolved choice that materially changes user-visible behavior, scope, or the amount of rework, and that the user has not decided.",
	"Call ask_user about the single most important open decision first, before starting the work. Usually call it once per task; ask a second question only if another decision is equally material.",
	'Do not use ask_user when the user specified the behavior; when they delegated the choice ("your call", "up to you", "as you think best") — decide and state your choice; or for implementation details the user would not notice (library or framework, file names and layout, flags, internal structure).',
	"Ask one question per ask_user call, with 2-3 real options, honest tradeoffs, and a recommendation if you have a view.",
	"Before calling ask_user, check the conversation: if you already asked about this decision in the same scenario, reuse the user's answer (or, if they declined, treat the decision as still open) instead of asking again. If a new task or scenario needs its own answer, call ask_user again and say in the reason what is different.",
	"If ask_user returns answered, act on the answer, even when it differs from your recommendation.",
	'If ask_user returns an answer with scope "similar", the user wants that choice applied to similar decisions for the rest of the session: for a later decision you judge similar, don\'t call ask_user; apply the preference and tell the user you did. If you\'re unsure whether a decision is similar, call ask_user.',
	"If ask_user returns cancelled because the user dismissed it or gave an empty answer, do not invent or assume an answer and do not ask about that decision again in this scenario: say it is still open and continue only with work that does not depend on it. If it was cancelled because the run was aborted, you may ask again. If it returns unavailable, do not call ask_user again in this run.",
];

// ---------------------------------------------------------------------------
// Tool and registration
// ---------------------------------------------------------------------------

/**
 * Build the model-callable tool. Each instance remembers what it returned, so an
 * identical sibling call in the same assistant message reuses that result (see
 * siblings.ts). Across turns the model decides whether an earlier answer applies.
 */
export function createAskUserTool(): ToolDefinition<typeof AskUserParams, AskUserDetails> {
	const memory = createSiblingMemory();
	return {
		name: "ask_user",
		label: "Ask user",
		description: ASK_USER_DESCRIPTION,
		promptSnippet: ASK_USER_PROMPT_SNIPPET,
		promptGuidelines: ASK_USER_GUIDELINES,
		parameters: AskUserParams,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const session = ctx.sessionManager as SessionView | undefined;
			const siblings = session ? memory.siblings(session, toolCallId) : [];
			const result = await askUser(params, signal, ctx, siblings);
			memory.remember(toolCallId, result.details);
			return result;
		},
	};
}

export default function askUserExtension(pi: ExtensionAPI) {
	pi.registerTool(createAskUserTool());

	// /ask-user-test runs the self-test against a fresh instance of the same tool.
	registerSelfTestCommand(pi, createAskUserTool);

	// /ask-user on|off|status turns the tool on or off at runtime, saved for future sessions.
	registerToggle(pi);
}
