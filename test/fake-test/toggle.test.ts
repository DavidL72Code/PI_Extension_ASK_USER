// /ask-user on|off|status with a fake pi and a temp agent dir (PI_CODING_AGENT_DIR),
// so the user's real setting is never read or changed.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { OFF_TEXT, ON_TEXT, STATE_FILE, TOGGLE_ALIAS, TOGGLE_COMMAND, TOGGLE_USAGE, statePath } from "../../src/toggle.ts";
import { loadExtension } from "./helpers.ts";

const base = mkdtempSync(path.join(tmpdir(), "ask-user-agent-"));
let agentDir: string;
let n = 0;
beforeEach(() => {
	agentDir = path.join(base, `agent-${++n}`); // fresh, not yet created: Pi may not have made it either
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
after(() => {
	rmSync(base, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

function fakeCtx() {
	const notes: { message: string; level?: string }[] = [];
	return { ctx: { hasUI: true, ui: { notify: (message: string, level?: string) => notes.push({ message, level }) } }, notes };
}
const saved = () => JSON.parse(readFileSync(path.join(agentDir, STATE_FILE), "utf8"));

/** A fresh extension instance after a session_start, as at Pi startup. */
async function start(options?: Parameters<typeof loadExtension>[0]) {
	const ext = loadExtension(options);
	const { ctx, notes } = fakeCtx();
	await ext.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	const run = async (args: string, command = TOGGLE_COMMAND) => {
		const c = fakeCtx();
		await ext.commands.get(command)!.handler(args, c.ctx);
		return c.notes;
	};
	return { ...ext, startNotes: notes, run };
}

describe("/ask-user on|off|status", () => {
	test("the state file lives in Pi's agent dir (PI_CODING_AGENT_DIR here, never the real ~/.pi)", () => {
		assert.equal(statePath(), path.join(agentDir, STATE_FILE));
	});

	test("default ON with no file; nothing is written until a change", async () => {
		const ext = await start();
		assert.ok(ext.activeTools().includes("ask_user"));
		assert.deepEqual(ext.startNotes, []);
		assert.throws(() => readFileSync(path.join(agentDir, STATE_FILE)));
	});

	test("off removes only ask_user, saves {enabled:false}, says so; on adds it back and saves {enabled:true}", async () => {
		const ext = await start();
		const others = ext.activeTools().filter((t) => t !== "ask_user");
		assert.deepEqual(await ext.run("off"), [{ message: OFF_TEXT, level: "info" }]);
		assert.deepEqual(ext.activeTools(), others, "other tools untouched");
		assert.deepEqual(saved(), { enabled: false });
		assert.deepEqual(await ext.run("on"), [{ message: ON_TEXT, level: "info" }]);
		assert.deepEqual(ext.activeTools(), [...others, "ask_user"]);
		assert.deepEqual(saved(), { enabled: true });
	});

	test("off twice / on twice are no-ops for the tool list", async () => {
		const ext = await start();
		await ext.run("off");
		await ext.run("off");
		assert.ok(!ext.activeTools().includes("ask_user"));
		await ext.run("on");
		await ext.run("on");
		assert.equal(ext.activeTools().filter((t) => t === "ask_user").length, 1);
	});

	test("the setting survives a new extension instance (a new Pi process / reload)", async () => {
		await (await start()).run("off");
		const next = await start();
		assert.ok(!next.activeTools().includes("ask_user"), "applied on session_start");
		assert.match(next.startNotes.map((n) => n.message).join("\n"), /ask_user is OFF/);
		await next.run("on");
		const third = await start();
		assert.ok(third.activeTools().includes("ask_user"));
	});

	test("status shows the state, whether the tool is active, and where it's saved; bare adds usage", async () => {
		const ext = await start();
		await ext.run("off");
		const [status] = await ext.run("status");
		assert.match(status!.message, /^ask_user is OFF \(saved in .*ask-user-state\.json\)\. In this session the tool is not active\.$/);
		assert.ok(status!.message.includes(path.join(agentDir, STATE_FILE)));
		const [bare] = await ext.run("");
		assert.ok(bare!.message.endsWith(`\n${TOGGLE_USAGE}`));
		assert.deepEqual(await ext.run("sideways"), [{ message: TOGGLE_USAGE, level: "warning" }]);
	});

	test(`/${TOGGLE_ALIAS} is an alias`, async () => {
		const ext = await start();
		assert.deepEqual(await ext.run("off", TOGGLE_ALIAS), [{ message: OFF_TEXT, level: "info" }]);
		assert.ok(!ext.activeTools().includes("ask_user"));
	});

	for (const [name, content] of [
		["malformed JSON", "{oops"],
		["the wrong shape", JSON.stringify({ enabled: "no" })],
		["an array", "[]"],
	] as const) {
		test(`a state file with ${name} → ON plus a warning, never a crash`, async () => {
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(path.join(agentDir, STATE_FILE), content);
			const ext = await start();
			assert.ok(ext.activeTools().includes("ask_user"));
			assert.equal(ext.startNotes[0]!.level, "warning");
			assert.match(ext.startNotes[0]!.message, /stays ON/);
		});
	}

	test("an unreadable state path (a directory) → ON plus a warning", async () => {
		mkdirSync(path.join(agentDir, STATE_FILE), { recursive: true });
		const ext = await start();
		assert.ok(ext.activeTools().includes("ask_user"));
		assert.match(ext.startNotes[0]!.message, /Couldn't read .*stays ON/);
		const notes = await ext.run("off");
		assert.ok(notes.some((n) => n.level === "error" && /Couldn't save/.test(n.message)), "save failure is reported");
		assert.ok(!ext.activeTools().includes("ask_user"), "the change still applies to this session");
	});

	test("when Pi was started without ask_user (--tools / --exclude-tools), on explains why it can't turn on", async () => {
		const ext = await start({ activeTools: ["read", "write"], available: ["read", "write"] });
		const notes = await ext.run("on");
		assert.equal(notes[0]!.level, "warning");
		assert.match(notes[0]!.message, /started without it \(--tools, --exclude-tools or --no-tools\)/);
		assert.deepEqual(ext.activeTools(), ["read", "write"]);
		assert.deepEqual(saved(), { enabled: true }, "the preference is still saved for the next start");
		const [status] = await ext.run("status");
		assert.match(status!.message, /excluded at startup/);
	});

	test("the toggle never calls the model", async () => {
		const ext = await start();
		await ext.run("off");
		await ext.run("on");
		assert.ok(!ext.sent.some((s) => s.method === "sendMessage" || s.method === "sendUserMessage"));
	});
});
