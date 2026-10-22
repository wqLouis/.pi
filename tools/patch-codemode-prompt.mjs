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

/**
 * pi sends the session id as the provider prompt-cache key. Every subagent has
 * its own session, so each child would land in its own cache slot even though
 * they share the same prompt prefix. This patch lets the parent override the
 * key (PI_PROMPT_CACHE_KEY), so a batch of subagents reuses one cached prefix.
 */
const OLD_CACHE_KEY = "clampOpenAIPromptCacheKey(options?.sessionId)";
const NEW_CACHE_KEY = "clampOpenAIPromptCacheKey(process.env.PI_PROMPT_CACHE_KEY ?? options?.sessionId)";

/**
 * The old strings are prefixes of the new ones, so a second run would append
 * the new tail again. These are the tails that may have been duplicated by an
 * earlier run, and the helper collapses them.
 */
const INTRO_TAIL = " Prefer this tool over separate tool calls: put the steps of a task into one script and return only the part you need.";
const GUIDELINE_TAIL = " Prefer the codemode tool over calling tools one by one: put the steps of a task into one script, run independent calls with Promise.allSettled, and let the script return only what you need.";

/** Collapse a repeated unit down to a single occurrence. */
function collapseRepeats(text, unit) {
	let out = text;
	while (out.includes(unit + unit)) {
		out = out.split(unit + unit).join(unit);
	}
	return out;
}
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

/** The pi-ai package: a sibling of pi, or nested inside it. */
function findPiAiDirs(piRoot) {
	const candidates = [
		join(piRoot, "node_modules", "@earendil-works", "pi-ai"),
		join(dirname(piRoot), "pi-ai"),
	];
	return candidates.filter((dir) => {
		try {
			return statSync(dir).isDirectory();
		} catch {
			return false;
		}
	});
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

	const roots = [root, ...findPiAiDirs(root)];
	for (const file of roots.flatMap((dir) => candidateFiles(dir))) {
		let content;
		try {
			content = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		if (
			!content.includes(OLD_GUIDELINE) &&
			!content.includes(OLD_INTRO) &&
			!content.includes(OLD_CACHE_KEY)
		) {
			continue;
		}

		let next = content;
		if (revert) {
			next = next.split(NEW_INTRO).join(OLD_INTRO);
			next = next.split(NEW_GUIDELINE).join(OLD_GUIDELINE);
			next = next.split(LEGACY_NEW_INTRO).join(OLD_INTRO);
			next = next.split(LEGACY_NEW_GUIDELINE).join(OLD_GUIDELINE);
			next = next.split(NEW_CACHE_KEY).join(OLD_CACHE_KEY);
			if (next === content) {
				already++;
				continue;
			}
		} else {
			if (next.includes(NEW_INTRO) && next.includes(NEW_CACHE_KEY)) {
				already++;
				continue;
			}
			// Repair a duplicated tail, then apply each replacement only when its
			// new text is missing.
			next = collapseRepeats(next, INTRO_TAIL);
			next = collapseRepeats(next, GUIDELINE_TAIL);
			if (!next.includes(NEW_INTRO)) next = next.split(OLD_INTRO).join(NEW_INTRO);
			if (!next.includes(NEW_GUIDELINE)) next = next.split(OLD_GUIDELINE).join(NEW_GUIDELINE);
			if (!next.includes(NEW_CACHE_KEY)) next = next.split(OLD_CACHE_KEY).join(NEW_CACHE_KEY);
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
