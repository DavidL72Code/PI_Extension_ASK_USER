import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CATEGORIES, INVALID_RULES, SCENARIOS_PER_ROUND, runSelfTest, type Execute } from "../../src/self-test.ts";
import { REPORT_ENTRY, SELF_TEST_COMMAND, SELF_TEST_USAGE } from "../../src/self-test-command.ts";
import { executeViaTool as viaTool, loadExtension } from "./helpers.ts";

const inputs = (summary: Awaited<ReturnType<typeof runSelfTest>>) => summary.scenarios.map((s) => s.input);

describe("randomized self-test", () => {
	test("a fixed seed passes, and every round covers every category and every invalid-input rule", async () => {
		const summary = await runSelfTest({ seed: 20261009, rounds: 3, execute: viaTool });
		assert.equal(summary.seed, 20261009);
		assert.equal(summary.rounds, 3);
		const n = 3 * SCENARIOS_PER_ROUND;
		assert.deepEqual(summary.totals, { scenarios: n, passed: n, failed: 0 });
		for (const round of [1, 2, 3]) {
			const scenarios = summary.scenarios.filter((s) => s.round === round);
			assert.deepEqual([...new Set(scenarios.map((s) => s.category))], [...CATEGORIES]);
			const invalid = scenarios.filter((s) => s.category === "invalid input");
			for (const rule of INVALID_RULES) assert.equal(invalid.filter((s) => s.action.startsWith(`invalid: ${rule} (`)).length, 1, rule);
		}
	});

	test("the same seed reproduces identical scenarios", async () => {
		const a = await runSelfTest({ seed: 777, rounds: 2, execute: viaTool });
		const b = await runSelfTest({ seed: 777, rounds: 2, execute: viaTool });
		assert.deepEqual(a.scenarios, b.scenarios);
	});

	test("different seeds produce different inputs", async () => {
		const a = await runSelfTest({ seed: 1, execute: viaTool });
		const b = await runSelfTest({ seed: 2, execute: viaTool });
		assert.notDeepEqual(inputs(a), inputs(b));
	});

	test("without a seed it picks one, returns it, and that seed reproduces the run", async () => {
		const a = await runSelfTest({ execute: viaTool });
		assert.ok(Number.isInteger(a.seed) && a.seed >= 0 && a.seed < 2 ** 32);
		const b = await runSelfTest({ seed: a.seed, execute: viaTool });
		assert.deepEqual(inputs(a), inputs(b));
	});

	test("it drives the execute function it is given (the registered tool path)", async () => {
		let calls = 0;
		const counting: Execute = (params, signal, ctx, id) => {
			calls++;
			return viaTool(params, signal, ctx, id);
		};
		const summary = await runSelfTest({ seed: 5, execute: counting });
		const priorCalls = summary.scenarios.filter((s) => s.actual.prior !== undefined).length;
		assert.equal(calls, summary.totals.scenarios + priorCalls);
		assert.equal(summary.totals.failed, 0);
	});

	test("a broken tool is reported as failures, not passes", async () => {
		const broken: Execute = async (params, signal, ctx, id) => {
			const result = await viaTool(params, signal, ctx, id);
			if (result.details.status === "answered" && result.details.source === "custom") result.details.answer = result.details.answer.trim();
			return result;
		};
		const summary = await runSelfTest({ seed: 3, rounds: 5, execute: broken });
		assert.ok(summary.totals.failed > 0);
		assert.ok(summary.scenarios.some((s) => !s.pass && s.mismatches.some((m) => m.startsWith("details:"))));
	});
});

describe("/ask-user-test command", () => {
	function fakeCtx() {
		const notes: { message: string; level?: string }[] = [];
		return { ctx: { ui: { notify: (message: string, level?: string) => notes.push({ message, level }) } }, notes };
	}

	test("is registered next to the tool, with an entry renderer for its report", () => {
		const { tools, commands, entryRenderers } = loadExtension();
		assert.deepEqual(tools.map((t) => t.name), ["ask_user"]);
		assert.ok(commands.has(SELF_TEST_COMMAND));
		assert.ok(entryRenderers.has(REPORT_ENTRY));
	});

	test("run_test <seed> posts a labeled report as a custom entry and never messages the model", async () => {
		const { commands, sent } = loadExtension();
		const { ctx, notes } = fakeCtx();
		await commands.get(SELF_TEST_COMMAND)!.handler("run_test 42", ctx);

		assert.deepEqual(sent.map((s) => s.method), ["appendEntry"], "no sendMessage / sendUserMessage");
		const [type, data] = sent[0]!.args as [string, { text: string; failed: number }];
		assert.equal(type, REPORT_ENTRY);
		assert.equal(data.failed, 0);
		const lines = data.text.split("\n");
		assert.equal(lines[0], `ask_user self-test — ${SCENARIOS_PER_ROUND}/${SCENARIOS_PER_ROUND} passed`);
		assert.equal(lines.filter((l) => /^(PASS|FAIL) {2}\[/.test(l)).length, SCENARIOS_PER_ROUND, "one line per scenario");
		for (const category of CATEGORIES) assert.ok(lines.some((l) => l.startsWith(`PASS  [${category}] `)), category);
		assert.equal(lines.at(-1), "seed: 42 — rerun with /ask-user-test run_test 42");

		assert.equal(notes.length, 1);
		assert.equal(notes[0]!.level, "info");
		assert.ok(notes[0]!.message.includes(`${SCENARIOS_PER_ROUND}/${SCENARIOS_PER_ROUND} passed (seed 42)`));
	});

	test("rounds are honored and included in the rerun hint", async () => {
		const { commands, sent } = loadExtension();
		await commands.get(SELF_TEST_COMMAND)!.handler("run_test 7 2", fakeCtx().ctx);
		const { text } = sent[0]!.args[1] as { text: string };
		assert.match(text, /^seed: 7, rounds: 2$/m);
		assert.ok(text.endsWith("seed: 7 — rerun with /ask-user-test run_test 7 2"));
		assert.match(text, /^PASS {2}\[r2 abort\] /m);
	});

	for (const args of ["", "help", "run_test abc", "run_test 1 0", "run_test 1 2 3"]) {
		test(`${JSON.stringify(args)} shows usage and runs nothing`, async () => {
			const { commands, sent } = loadExtension();
			const { ctx, notes } = fakeCtx();
			await commands.get(SELF_TEST_COMMAND)!.handler(args, ctx);
			assert.deepEqual(sent, []);
			assert.deepEqual(notes, [{ message: SELF_TEST_USAGE, level: args ? "warning" : "info" }]);
		});
	}

	test("the entry renderer shows the report text", async () => {
		const { commands, entryRenderers, sent } = loadExtension();
		await commands.get(SELF_TEST_COMMAND)!.handler("run_test 9", fakeCtx().ctx);
		const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
		const component = entryRenderers.get(REPORT_ENTRY)!({ data: sent[0]!.args[1] }, { expanded: false }, theme);
		const rendered = component.render(200).join("\n");
		assert.ok(rendered.includes(`ask_user self-test — ${SCENARIOS_PER_ROUND}/${SCENARIOS_PER_ROUND} passed`));
		assert.match(rendered, /PASS {2}\[pick option\]/);
	});
});
