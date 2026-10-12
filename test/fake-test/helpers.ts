// Shared harness for the unit tests and the batch runner: load the real
// extension into a fake `pi`, then drive the registered tool's execute() with a
// fake ctx whose dialogs record every call. Nothing here starts Pi or a model.

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SCOPE_CHOICES, type AskUserResult } from "../../src/ask-user.ts";
import askUserExtension from "../../src/index.ts";
import type { Execute } from "../../src/self-test.ts";

export type Tool = ToolDefinition<any, any>;

/**
 * Load the extension into a fake `pi` that records everything it registers or sends.
 * Active tools work like Pi's: setActiveTools keeps only tools in `available`
 * (default: the built-ins plus every registered tool).
 */
export function loadExtension(options: { activeTools?: string[]; available?: string[] } = {}) {
	const tools: Tool[] = [];
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
	const entryRenderers = new Map<string, (entry: any, options: any, theme: any) => any>();
	const events = new Map<string, ((event: any, ctx: any) => unknown)[]>();
	const sent: { method: string; args: unknown[] }[] = [];
	const record = (method: string) => (...args: unknown[]) => void sent.push({ method, args });
	const builtIns = ["read", "bash", "edit", "write"];
	const available = () => options.available ?? [...builtIns, ...tools.map((t) => t.name)];
	let active: string[] = options.activeTools ? [...options.activeTools] : [];
	const pi = {
		registerTool: (definition: Tool) => {
			tools.push(definition);
			if (!options.activeTools && available().includes(definition.name)) active.push(definition.name); // Pi activates new tools
		},
		registerCommand: (name: string, opts: any) => commands.set(name, opts),
		registerEntryRenderer: (type: string, renderer: any) => entryRenderers.set(type, renderer),
		on: (event: string, handler: (event: any, ctx: any) => unknown) => events.set(event, [...(events.get(event) ?? []), handler]),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = names.filter((name) => available().includes(name));
			record("setActiveTools")(names);
		},
		getAllTools: () => available().map((name) => ({ name })),
		appendEntry: record("appendEntry"),
		sendMessage: record("sendMessage"),
		sendUserMessage: record("sendUserMessage"),
	};
	if (!options.activeTools) active = [...builtIns];
	askUserExtension(pi as unknown as ExtensionAPI);
	const emit = async (event: string, payload: unknown, ctx: unknown) => {
		for (const handler of events.get(event) ?? []) await handler(payload, ctx);
	};
	return { tools, commands, entryRenderers, events, emit, sent, activeTools: () => [...active] };
}

export function loadTool(): Tool {
	const { tools } = loadExtension();
	if (tools.length !== 1) throw new Error(`expected exactly one registered tool, got ${tools.length}`);
	return tools[0]!;
}

export const tool = loadTool();

export interface DialogCall {
	method: "select" | "input";
	title: string;
	choices?: string[];
	placeholder?: string;
	opts?: { signal?: AbortSignal; timeout?: number };
}

export type Responder = (call: DialogCall) => unknown;

/** The rule 16 follow-up ("Apply … to similar questions this session?"), told apart from a question menu. */
export const isScopeFollowUp = (title: string, choices: string[]) =>
	/^Apply ".*" to similar questions this session\?$/s.test(title) && JSON.stringify(choices) === JSON.stringify(SCOPE_CHOICES);

/** Answers the follow-up with "1. Just this time" (Enter-Enter). */
export const justThisTime: Responder = (call) => call.choices![0];
export const alsoSimilar: Responder = (call) => call.choices![1];

/**
 * Fake ctx. Like Pi, a dialog opened with an already-aborted signal resolves undefined.
 * The rule 16 follow-up goes to `scope` (default: "Just this time") and is recorded
 * in `scopeCalls`, so `calls` keeps only the question's own dialogs.
 */
export function session(options: { hasUI?: boolean; select?: Responder; input?: Responder; scope?: Responder } = {}) {
	const hasUI = options.hasUI ?? true;
	const calls: DialogCall[] = [];
	const scopeCalls: DialogCall[] = [];
	/** Every dialog in order, the follow-up marked kind "scope". */
	const log: (DialogCall & { kind: "question" | "scope" })[] = [];
	const open = (call: DialogCall, responder?: Responder) => {
		calls.push(call);
		log.push({ ...call, kind: "question" });
		if (call.opts?.signal?.aborted) return Promise.resolve(undefined);
		return Promise.resolve().then(() => (responder ? responder(call) : undefined));
	};
	const ui = {
		select: (title: string, choices: string[], opts?: DialogCall["opts"]) => {
			const call: DialogCall = { method: "select", title, choices: [...choices], opts };
			if (!isScopeFollowUp(title, choices)) return open(call, options.select);
			scopeCalls.push(call);
			log.push({ ...call, kind: "scope" });
			if (opts?.signal?.aborted) return Promise.resolve(undefined);
			return Promise.resolve().then(() => (options.scope ?? justThisTime)(call));
		},
		input: (title: string, placeholder?: string, opts?: DialogCall["opts"]) =>
			open({ method: "input", title, placeholder, opts }, options.input),
	};
	const ctx = { hasUI, mode: hasUI ? "tui" : "print", ui } as unknown as ExtensionContext;
	return {
		ctx,
		calls,
		scopeCalls,
		log,
		count: (method: DialogCall["method"]) => calls.filter((c) => c.method === method).length,
	};
}

export type Session = ReturnType<typeof session>;

/** The registered tool's execute(), shaped for runSelfTest. */
export const executeViaTool: Execute = (params, signal, ctx, toolCallId) =>
	tool.execute(toolCallId, params as never, signal, undefined, ctx as never) as Promise<AskUserResult>;

export function run(params: unknown, s: Session, signal?: AbortSignal): Promise<AgentToolResult<any>> {
	return tool.execute("call-1", params as never, signal, undefined, s.ctx);
}

/** Pick the displayed choice at this index (0-based), exactly as passed to select. */
export const pick = (index: number): Responder => (call) => call.choices![index];
export const pickCustom: Responder = (call) => call.choices!.at(-1);
export const reply = (value: unknown): Responder => () => value;

/** Resolve undefined once the dialog's signal aborts (what Pi's dialogs do). */
export function untilAborted(call: DialogCall): Promise<undefined> {
	const signal = call.opts?.signal;
	if (!signal) throw new Error("dialog opened without an abort signal");
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
}

/** Open the dialog, then abort the run while it is still open. */
export const abortWhileOpen = (controller: AbortController): Responder => (call) => {
	const closed = untilAborted(call);
	setImmediate(() => controller.abort());
	return closed;
};

/** All text blocks of a result, joined (no shape assertions). */
export function contentText(result: AgentToolResult<any>): string {
	return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

// ---------------------------------------------------------------------------
// Fixtures (the reviewer's BASE)
// ---------------------------------------------------------------------------

export const QUESTION = "Which database should the cache use?";
export const REASON = "Changes deployment needs; costly to migrate later.";

export function base(overrides: Record<string, unknown> = {}) {
	return {
		question: QUESTION,
		reason: REASON,
		options: [
			{ label: "SQLite", tradeoff: "Zero setup; one writer at a time" },
			{ label: "Postgres", tradeoff: "Needs a server; handles concurrent writers" },
			{ label: "In-memory", tradeoff: "Fastest; lost on restart" },
		],
		recommendation: "Postgres",
		...overrides,
	};
}

export function withoutRecommendation(overrides: Record<string, unknown> = {}) {
	const params: Record<string, unknown> = base(overrides);
	delete params.recommendation;
	return params;
}
