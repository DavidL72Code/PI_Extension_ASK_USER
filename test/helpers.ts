// Shared harness for the unit tests and the batch runner: load the real
// extension into a fake `pi`, then drive the registered tool's execute() with a
// fake ctx whose dialogs record every call. Nothing here starts Pi or a model.

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import askUserExtension from "../src/index.ts";

export type Tool = ToolDefinition<any, any>;

export function loadTool(): Tool {
	const registered: Tool[] = [];
	const pi = { registerTool: (definition: Tool) => registered.push(definition) };
	askUserExtension(pi as unknown as ExtensionAPI);
	if (registered.length !== 1) throw new Error(`expected exactly one registered tool, got ${registered.length}`);
	return registered[0]!;
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

/** Fake ctx. Like Pi, a dialog opened with an already-aborted signal resolves undefined. */
export function session(options: { hasUI?: boolean; select?: Responder; input?: Responder } = {}) {
	const hasUI = options.hasUI ?? true;
	const calls: DialogCall[] = [];
	const open = (call: DialogCall, responder?: Responder) => {
		calls.push(call);
		if (call.opts?.signal?.aborted) return Promise.resolve(undefined);
		return Promise.resolve().then(() => (responder ? responder(call) : undefined));
	};
	const ui = {
		select: (title: string, choices: string[], opts?: DialogCall["opts"]) =>
			open({ method: "select", title, choices: [...choices], opts }, options.select),
		input: (title: string, placeholder?: string, opts?: DialogCall["opts"]) =>
			open({ method: "input", title, placeholder, opts }, options.input),
	};
	const ctx = { hasUI, mode: hasUI ? "tui" : "print", ui } as unknown as ExtensionContext;
	return {
		ctx,
		calls,
		count: (method: DialogCall["method"]) => calls.filter((c) => c.method === method).length,
	};
}

export type Session = ReturnType<typeof session>;

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
