// /ask-user on|off|status: turn the ask_user tool on or off at runtime, saved
// for future sessions.
//
// Off removes "ask_user" from Pi's active tools (pi.setActiveTools); on adds it
// back. Other tools are left as they are. Pi builds the system prompt (tool
// list and guidelines) and the tool definitions it sends from the ACTIVE tools
// only, so while off the model sees nothing of ask_user.
//
// The setting is {"enabled": true|false} in ask-user-state.json inside Pi's agent
// directory (getAgentDir(): $PI_CODING_AGENT_DIR, else ~/.pi/agent). No file means
// on. An unreadable or malformed file means on, with a warning; it never throws.
// The saved state is applied on every session_start (startup, /reload, /new, …).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TOOL_NAME = "ask_user";
export const TOGGLE_COMMAND = "ask-user";
/** Pi accepts underscores in command names, so the tool's own name works as an alias. */
export const TOGGLE_ALIAS = "ask_user";
export const STATE_FILE = "ask-user-state.json";

export const ON_TEXT = "ask_user is ON: the agent can ask you questions";
export const OFF_TEXT = "ask_user is OFF: the agent won't ask and will decide on its own";
export const TOGGLE_USAGE = `Usage: /${TOGGLE_COMMAND} on|off|status`;

export const statePath = () => path.join(getAgentDir(), STATE_FILE);

/** The saved setting. Missing file → on; anything unreadable → on plus a warning. */
export function readState(): { enabled: boolean; warning?: string } {
	const file = statePath();
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: true };
		return { enabled: true, warning: `Couldn't read ${file} (${(error as Error).message}); ask_user stays ON.` };
	}
	try {
		const parsed = JSON.parse(raw) as { enabled?: unknown };
		if (typeof parsed?.enabled === "boolean") return { enabled: parsed.enabled };
	} catch {
		// fall through
	}
	return { enabled: true, warning: `Ignoring ${file}: it isn't {"enabled": true|false}; ask_user stays ON.` };
}

/** Save the setting; returns an error message instead of throwing. */
export function writeState(enabled: boolean): string | undefined {
	const file = statePath();
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify({ enabled }, null, 2)}\n`);
		return undefined;
	} catch (error) {
		return `Couldn't save ${file} (${(error as Error).message}); the change applies to this session only.`;
	}
}

export function registerToggle(pi: ExtensionAPI) {
	const isActive = () => pi.getActiveTools().includes(TOOL_NAME);
	/** Excluded at startup (--tools without it, --exclude-tools ask_user, --no-tools): Pi won't activate it. */
	const isAvailable = () => pi.getAllTools().some((tool) => tool.name === TOOL_NAME);

	/** Add or remove ask_user from the active tools; leaves every other tool alone. */
	const apply = (enabled: boolean) => {
		const active = pi.getActiveTools();
		if (enabled && !active.includes(TOOL_NAME)) pi.setActiveTools([...active, TOOL_NAME]);
		if (!enabled && active.includes(TOOL_NAME)) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	};

	const excludedText = () =>
		`ask_user is saved as ON, but this Pi session was started without it (--tools, --exclude-tools or --no-tools), ` +
		"so it can't be turned on until Pi is restarted without that option.";

	const status = (state = readState()) =>
		[
			`ask_user is ${state.enabled ? "ON" : "OFF"} (saved in ${statePath()}).`,
			`In this session the tool is ${isActive() ? "active" : "not active"}${state.enabled && !isAvailable() ? " (excluded at startup)" : ""}.`,
		].join(" ");

	pi.on("session_start", (_event, ctx) => {
		const state = readState();
		if (state.warning) ctx.ui.notify(state.warning, "warning");
		apply(state.enabled);
		if (!state.enabled) ctx.ui.notify(`${OFF_TEXT}. Turn it back on with /${TOGGLE_COMMAND} on.`, "info");
	});

	const handler = async (args: string, ctx: ExtensionContext) => {
		const sub = args.trim().toLowerCase();
		if (sub === "on" || sub === "off") {
			const enabled = sub === "on";
			const saveError = writeState(enabled);
			apply(enabled);
			if (enabled && !isActive()) ctx.ui.notify(excludedText(), "warning");
			else ctx.ui.notify(enabled ? ON_TEXT : OFF_TEXT, "info");
			if (saveError) ctx.ui.notify(saveError, "error");
			return;
		}
		if (sub === "" || sub === "status") {
			const state = readState();
			if (state.warning) ctx.ui.notify(state.warning, "warning");
			ctx.ui.notify(sub === "" ? `${status(state)}\n${TOGGLE_USAGE}` : status(state), "info");
			return;
		}
		ctx.ui.notify(TOGGLE_USAGE, "warning");
	};

	const description = "Turn the ask_user tool on or off (on|off|status); saved for future sessions";
	pi.registerCommand(TOGGLE_COMMAND, { description, handler });
	pi.registerCommand(TOGGLE_ALIAS, { description: `Alias of /${TOGGLE_COMMAND}`, handler });
}
