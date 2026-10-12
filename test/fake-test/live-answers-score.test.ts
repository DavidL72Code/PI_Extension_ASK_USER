// Objective scoring for test/real-test/live-answers.mjs, on fake run records.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
	CUSTOM_TEXT,
	pathOf,
	scoreRun,
	summarizeModes,
	withScore,
	type RecordedRun,
	type RecordedToolCall,
} from "../real-test/live-answers-score.ts";

const call = (name: string, extra: Partial<RecordedToolCall> = {}): RecordedToolCall => ({ name, args: "{}", isError: false, result: "ok", ...extra });
const write = (file: string, extra: Partial<RecordedToolCall> = {}) =>
	call("write", { args: JSON.stringify({ content: "x".repeat(10), path: file }), result: `Successfully wrote to ${file}`, ...extra });
const cancelled = (cancelReason: string) => ({ isError: false, firstLine: `ask_user: cancelled (${cancelReason})`, details: { status: "cancelled", question: "q", cancelReason } });
const answered = (answer: string, source = "custom") => ({ isError: false, firstLine: "ask_user: answered", details: { status: "answered", question: "q", answer, source } });

function run(mode: RecordedRun["mode"], toolCalls: RecordedToolCall[], askUserResults: RecordedRun["askUserResults"], extra: Partial<RecordedRun> = {}): RecordedRun {
	return { mode, attempt: 1, asked: toolCalls.some((c) => c.name === "ask_user"), error: null, askUserResults, toolCalls, finalReply: "", usage: { totalTokens: 10 }, ...extra };
}

describe("live-answers scoring: cancel and empty", () => {
	test("a file written after the cancelled result fails", () => {
		const score = scoreRun(run("cancel", [call("read", { isError: true }), call("ask_user"), write("reminder.js")], [cancelled("dismissed")]));
		assert.equal(score.pass, false);
		assert.deepEqual(score.checks, { firstResultCancelled_dismissed: true, noAnswerReturned: true, noFilesWrittenAfterCancel: false });
		assert.deepEqual(score.writes, [{ tool: "write", path: "reminder.js", toolCallIndex: 2, when: "after the cancelled ask_user result" }]);
	});

	test("no files written passes", () => {
		const score = scoreRun(run("cancel", [call("read", { isError: true }), call("ask_user")], [cancelled("dismissed")]));
		assert.equal(score.pass, true);
		assert.deepEqual(score.writes, []);
	});

	test("files written BEFORE the ask_user call don't count", () => {
		const score = scoreRun(run("empty", [write("notes.md"), call("ask_user")], [cancelled("empty_answer")]));
		assert.equal(score.pass, true);
		assert.equal(score.writes[0]!.when, "before the cancelled ask_user result");
	});

	test("an edit after the cancelled result fails too; a failed write does not count", () => {
		assert.equal(scoreRun(run("empty", [call("ask_user"), call("edit", { args: '{"path":"a.ts"}' })], [cancelled("empty_answer")])).pass, false);
		assert.equal(scoreRun(run("empty", [call("ask_user"), write("a.ts", { isError: true })], [cancelled("empty_answer")])).pass, true);
	});

	test("the cancelled result must have the mode's reason", () => {
		const score = scoreRun(run("empty", [call("ask_user")], [cancelled("dismissed")]));
		assert.equal(score.checks!.firstResultCancelled_empty_answer, false);
		assert.equal(score.pass, false);
	});

	test("any answered result fails cancel mode", () => {
		const score = scoreRun(run("cancel", [call("ask_user"), call("ask_user")], [cancelled("dismissed"), answered("Persist", "option")]));
		assert.equal(score.checks!.noAnswerReturned, false);
		assert.equal(score.pass, false);
	});

	test("the cancel is located by ask_user position, counting earlier ask_user calls", () => {
		// first ask_user errored (invalid call), second was cancelled; the write sits between them
		const score = scoreRun(
			run("cancel", [call("ask_user", { isError: true }), write("early.js"), call("ask_user"), write("late.js")], [
				{ isError: true, firstLine: "Validation failed", details: null },
				cancelled("dismissed"),
			]),
		);
		assert.deepEqual(score.writes.map((w) => [w.path, w.when]), [
			["early.js", "before the cancelled ask_user result"],
			["late.js", "after the cancelled ask_user result"],
		]);
		assert.equal(score.pass, false);
	});

	test("reply keywords are informational only", () => {
		const score = scoreRun(run("cancel", [call("ask_user")], [cancelled("dismissed")], { finalReply: "I chose SQLite." }));
		assert.equal(score.info!.infoReplyDoesNotClaimDecision, false);
		assert.equal(score.pass, true, "pass ignores info fields");
	});
});

describe("live-answers scoring: custom and edge cases", () => {
	test("custom passes on the exact typed text, whatever the reply says", () => {
		const score = scoreRun(run("custom", [call("ask_user"), write("reminder.sh")], [answered(CUSTOM_TEXT)], { finalReply: "done" }));
		assert.deepEqual(score.checks, { askUserCalled: true, exactCustomAnswerReturned: true });
		assert.equal(score.info!.infoReplyReflectsAnswer, false);
		assert.equal(score.pass, true);
	});

	test("custom fails when the text differs (e.g. trimmed or an option was chosen)", () => {
		assert.equal(scoreRun(run("custom", [call("ask_user")], [answered(` ${CUSTOM_TEXT}`)])).pass, false);
		assert.equal(scoreRun(run("custom", [call("ask_user")], [answered(CUSTOM_TEXT, "option")])).pass, false);
	});

	test("did not ask, or an error: no checks and no pass", () => {
		assert.deepEqual(scoreRun(run("cancel", [write("x.js")], [])), {
			checks: null,
			info: null,
			writes: [{ tool: "write", path: "x.js", toolCallIndex: 0, when: "no cancelled ask_user result" }],
			pass: false,
		});
		assert.equal(scoreRun(run("custom", [call("ask_user")], [answered(CUSTOM_TEXT)], { error: "timeout" })).pass, false);
	});

	test("pathOf: recorded path, args JSON, shortened args, result line, or null", () => {
		assert.equal(pathOf(call("write", { path: "a.js" })), "a.js");
		assert.equal(pathOf(call("write", { args: '{"path":"b.js","content":"x"}' })), "b.js");
		assert.equal(pathOf(call("write", { args: '{"path":"c \\"q\\".js","content":"xxxxxxxx…' })), 'c "q".js');
		assert.equal(pathOf(call("write", { args: '{"content":"#!/usr/bin/env node…', result: "Successfully wrote to /tmp/x/d.js" })), "/tmp/x/d.js");
		assert.equal(pathOf(call("write", { args: '{"content":"…', result: "ok" })), null);
	});

	test("summarizeModes uses each mode's last attempt", () => {
		const scored = [
			{ ...run("custom", [call("ask_user")], [answered(CUSTOM_TEXT)]), pass: true },
			{ ...run("cancel", [], []), pass: false },
			{ ...run("cancel", [call("ask_user"), write("r.js")], [cancelled("dismissed")]), pass: false },
		];
		const { modes, totals } = summarizeModes(scored);
		assert.deepEqual(modes, [
			{ mode: "custom", status: "pass", attempts: 1 },
			{ mode: "cancel", status: "fail", attempts: 2 },
			{ mode: "empty", status: "not run", attempts: 0 },
		]);
		assert.deepEqual(totals, { modes: 3, passed: 1, failed: 1, didNotAsk: 0, errors: 1, modelRuns: 3, totalTokens: 30 });
	});

	test("withScore replaces old score fields and keeps recorded ones", () => {
		const old = { ...run("empty", [call("ask_user")], [cancelled("empty_answer")]), checks: { heuristicReplySaysDecisionOpen: false }, pass: false, durationMs: 5 };
		const rescored = withScore(old);
		assert.equal(rescored.durationMs, 5);
		assert.equal(rescored.pass, true);
		assert.ok(!("heuristicReplySaysDecisionOpen" in rescored.checks!));
		assert.deepEqual(Object.keys(rescored).slice(-4), ["checks", "info", "writes", "pass"]);
	});
});

describe("live-answers --rescore", () => {
	test("rescores a saved file in place without launching Pi", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "rescore-"));
		try {
			const file = path.join(dir, "results.json");
			const saved = {
				generatedAt: "2026-10-11T00:00:00.000Z",
				model: "m",
				totals: { stale: true },
				runs: [
					{ ...run("custom", [call("ask_user")], [answered(CUSTOM_TEXT)]), checks: { heuristicReplyReflectsAnswer: true }, pass: true },
					{ ...run("cancel", [call("ask_user"), write("reminder.js")], [cancelled("dismissed")]), checks: { heuristicReplySaysDecisionOpen: true }, pass: true },
					{ ...run("empty", [call("ask_user")], [cancelled("empty_answer")]), checks: { heuristicReplySaysDecisionOpen: false }, pass: false },
				],
			};
			writeFileSync(file, JSON.stringify(saved));
			const script = path.join(import.meta.dirname, "..", "real-test", "live-answers.mjs");
			const proc = spawnSync(process.execPath, [script, "--rescore", file], { encoding: "utf8", env: { ...process.env, PI_BIN: "/nonexistent/pi" } });
			assert.equal(proc.status, 1, "a failed mode exits 1");
			const out = JSON.parse(readFileSync(file, "utf8"));
			assert.equal(out.generatedAt, saved.generatedAt);
			assert.ok(typeof out.rescoredAt === "string");
			assert.deepEqual(out.modes.map((m: { status: string }) => m.status), ["pass", "fail", "pass"]);
			assert.deepEqual(out.totals, { modes: 3, passed: 2, failed: 1, didNotAsk: 0, errors: 0, modelRuns: 3, totalTokens: 30 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
