// Randomized self-test from the terminal: the same runSelfTest that backs
// /ask-user-test, driven through the registered tool's execute() (fake pi, fake
// dialogs; no Pi process, no model). Writes test/fake-test/random-test/results.json.
//
// Usage: npm run test:random -- [--seed N] [--rounds R]   (exits 1 on any failure)

import { mkdirSync, writeFileSync } from "node:fs";
import { formatSelfTestReport, runSelfTest } from "../../src/self-test.ts";
import { executeViaTool } from "./helpers.ts";

const USAGE = "usage: npm run test:random -- [--seed N] [--rounds R]";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
	if (args[i] !== "--seed" && args[i] !== "--rounds") {
		console.error(`unknown argument ${JSON.stringify(args[i])} (${USAGE})`);
		process.exit(2);
	}
}

function option(name: string): number | undefined {
	const i = process.argv.indexOf(name);
	if (i === -1) return undefined;
	const value = process.argv[i + 1];
	if (value === undefined || !/^\d+$/.test(value)) {
		console.error(`${name} needs a non-negative integer (${USAGE})`);
		process.exit(2);
	}
	return Number(value);
}

const seed = option("--seed");
const rounds = option("--rounds") ?? 1;
if (rounds < 1) {
	console.error("--rounds must be at least 1");
	process.exit(2);
}

const summary = await runSelfTest({
	seed,
	rounds,
	execute: executeViaTool,
});
const rerun = `npm run test:random -- --seed ${summary.seed}${summary.rounds > 1 ? ` --rounds ${summary.rounds}` : ""}`;
console.log(formatSelfTestReport(summary, rerun).join("\n"));

const outDir = new URL("./random-test/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const outFile = new URL("results.json", outDir);
const report = {
	generatedAt: new Date().toISOString(),
	seed: summary.seed,
	rounds: summary.rounds,
	totals: summary.totals,
	scenarios: summary.scenarios.map(({ round, category, input, action, expected, actual, pass, mismatches }) => ({
		round,
		category,
		input,
		action,
		expected,
		actual,
		pass,
		mismatches,
	})),
};
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${outFile.pathname}`);
process.exitCode = summary.totals.failed === 0 ? 0 : 1;
