#!/usr/bin/env node
/**
 * Patch pi's codemode tool prompt to prefer codemode over single tool calls.
 *
 * pi ships the codemode tool's description and system-prompt guidelines in
 * `dist/extensions/codemode/tool.js` and in the bundled CLI chunk. This script
 * rewrites both copies in place:
 *
 *  - the tool description (what the model reads when it decides to use
 *    codemode) gains a "prefer this over separate tool calls" line,
 *  - the tool's system-prompt guideline gains the same preference.
 *
 * The patch is idempotent, so it can be re-run after a pi update:
 *
 *     node tools/patch-codemode-prompt.mjs [package-dir]
 *
 * Without an argument the package is found through the `pi` binary on PATH.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const MARKER = "Prefer the codemode tool over calling tools one by one";

const OLD_GUIDELINE =
	"Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.";
const NEW_GUIDELINE = `${OLD_GUIDELINE} ${MARKER}: put the steps of a task into one script, run independent calls with Promise.allSettled, and let the script return only what you need.`;

const OLD_INTRO = "Run JavaScript that calls other tools.";
/** An earlier revision of the patch (with an apostrophe) that --revert also removes. */
const LEGACY_NEW_INTRO =
	"Run JavaScript that calls other tools. Prefer this tool over separate tool calls: put a task's steps into one script and return only the part you need.";
const LEGACY_NEW_GUIDELINE = `${OLD_GUIDELINE} ${MARKER}: put a task's steps into one script, run independent calls with Promise.allSettled, and let the script return only what you need.`;
const NEW_INTRO =
	"Run JavaScript that calls other tools. Prefer this tool over separate tool calls: put the steps of a task into one script and return only the part you need.";

/** The package root of the installed pi, from the `pi` binary on PATH. */
function findPackageDir(explicit) {
	if (explicit) return resolve(explicit);
	try {
		const binary = execFileSync("sh", ["-lc", "command -v pi"], { encoding: "utf-8" }).trim();
		if (binary) {
			// The binary is usually a symlink into the package: <pkg>/dist/bundle/cli.js -> <pkg>
			const real = realpathSync(binary);
			return resolve(dirname(real), "..", "..");
		}
	} catch {
		// Fall through to the default install location.
	}
	const fallback = join(
		homedir(),
		".bun/install/global/node_modules/@earendil-works/pi-coding-agent",
	);
	return fallback;
}

/** Every file in the package that carries the codemode prompt strings. */
function candidateFiles(root) {
	const files = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry);
			let stats;
			try {
				stats = statSync(path);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				walk(path);
				continue;
			}
			if (!/\.(js|mjs|cjs)$/.test(entry)) continue;
			if (/\.map$/.test(entry)) continue;
			files.push(path);
		}
	};
	walk(join(root, "dist"));
	return files;
}

function main() {
	const revert = process.argv.includes("--revert");
	const root = findPackageDir(process.argv.slice(2).find((arg) => !arg.startsWith("--")));
	let patched = 0;
	let already = 0;

	for (const file of candidateFiles(root)) {
		let content;
		try {
			content = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		if (!content.includes(OLD_GUIDELINE) && !content.includes(OLD_INTRO)) continue;

		let next = content;
		if (revert) {
			next = next.split(NEW_INTRO).join(OLD_INTRO);
			next = next.split(NEW_GUIDELINE).join(OLD_GUIDELINE);
			next = next.split(LEGACY_NEW_INTRO).join(OLD_INTRO);
			next = next.split(LEGACY_NEW_GUIDELINE).join(OLD_GUIDELINE);
			if (next === content) {
				already++;
				continue;
			}
		} else {
			if (next.includes(NEW_INTRO)) {
				already++;
				continue;
			}
			next = next.split(OLD_INTRO).join(NEW_INTRO);
			next = next.split(OLD_GUIDELINE).join(NEW_GUIDELINE);
		}
		if (next !== content) {
			writeFileSync(file, next);
			patched++;
			console.log(`patched ${file}`);
		}
	}

	if (patched === 0) {
		console.log(already > 0 ? "already patched" : `no codemode prompt found under ${root}`);
		return;
	}
	console.log(
		revert
			? `reverted ${patched} file(s). Run /reload in pi to pick it up.`
			: `done (${patched} file(s) patched). Run /reload in pi to pick it up.`,
	);
}

main();
