// Dev-only extension for the live scripts (load with -e; never part of the
// package). File tools may only touch paths inside the run's folder, which is
// Pi's working directory (ctx.cwd): each live run uses a fresh temp folder.
// Shell tools are blocked outright, in case one is ever enabled.
//
// Paths are resolved the way Pi's file tools resolve them (unicode spaces
// normalized, leading "@" stripped, file:// URLs converted, "~" expanded,
// relative to cwd), then every symlink along the way is followed with
// lstat/readlink, including dangling ones, so a link inside the folder that
// points outside it is blocked too. Anything that can't be resolved is blocked.

import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PATH_REQUIRED = new Set(["read", "write", "edit"]);
const PATH_OPTIONAL = new Set(["grep", "find", "ls"]); // default to cwd when no path is given
const SHELL_TOOLS = new Set(["bash", "powershell"]);

const MAX_LINKS = 40;

/** Follow every symlink in `absolute`, component by component (dangling links too); missing parts stay as written. */
function resolveLinks(absolute: string, hops = 0): string {
	if (hops > MAX_LINKS) throw new Error("too many symbolic links");
	const parts = absolute.split(path.sep).filter(Boolean);
	let current = path.parse(absolute).root;
	for (let i = 0; i < parts.length; i++) {
		const next = path.join(current, parts[i]!);
		let isLink: boolean;
		try {
			isLink = lstatSync(next).isSymbolicLink();
		} catch {
			return path.join(next, ...parts.slice(i + 1)); // doesn't exist: the rest is just a name
		}
		if (isLink) return resolveLinks(path.join(path.resolve(current, readlinkSync(next)), ...parts.slice(i + 1)), hops + 1);
		current = next;
	}
	return current;
}

/** Where a file tool would end up for `rawPath`, with symlinks followed. Throws if it can't tell. */
export function resolveForGuard(rawPath: string, cwd: string): string {
	let p = rawPath.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (/^file:/i.test(p)) p = fileURLToPath(p); // throws for URLs that aren't local paths
	if (p === "~" || p.startsWith("~/")) p = path.join(homedir(), p.slice(1));
	return resolveLinks(path.resolve(cwd, p));
}

export function isInside(target: string, root: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export default function sandboxGuard(pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		const block = (why: string) => ({ block: true, reason: `sandbox-guard: ${why}` });
		if (SHELL_TOOLS.has(event.toolName)) return block(`${event.toolName} is disabled in live checks`);
		const required = PATH_REQUIRED.has(event.toolName);
		if (!required && !PATH_OPTIONAL.has(event.toolName)) return undefined;

		const raw = (event.input as Record<string, unknown>).path;
		if (raw === undefined && !required) return undefined;
		if (typeof raw !== "string") return block(`${event.toolName} needs a string path`);
		let target: string;
		let root: string;
		try {
			target = resolveForGuard(raw, ctx.cwd);
			root = resolveLinks(path.resolve(ctx.cwd));
		} catch (error) {
			return block(`${event.toolName} path could not be resolved (${raw}): ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!isInside(target, root)) return block(`${event.toolName} outside the run folder is not allowed (${raw})`);
		return undefined;
	});
}
