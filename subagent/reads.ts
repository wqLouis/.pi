/**
 * Recent reads of the main agent.
 *
 * The files the main agent just read are the ones a subagent is most likely to
 * need. Injecting them into the child's first message (the shared
 * `<shared-context-prefill>` block) means the child does not spend tokens
 * reading them again, and every child of the same batch gets the *same* prefix,
 * which is what the provider prompt cache keys on.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** How many recent reads are remembered. */
const MAX_TRACKED = 12;
/** How many of them are prefilled into a child by default. */
export const DEFAULT_PREFILL_LIMIT = 3;

interface ReadEntry {
	path: string;
	at: number;
}

const recent: ReadEntry[] = [];

/** Remember a file the main agent read. */
export function recordRead(filePath: string, cwd: string): void {
	if (!filePath) return;
	const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
	const existing = recent.findIndex((entry) => entry.path === absolute);
	if (existing >= 0) recent.splice(existing, 1);
	recent.unshift({ path: absolute, at: Date.now() });
	while (recent.length > MAX_TRACKED) recent.pop();
}

/** The most recent reads that still exist on disk, newest first. */
export function recentReads(cwd: string, limit = DEFAULT_PREFILL_LIMIT): string[] {
	const out: string[] = [];
	for (const entry of recent) {
		if (out.length >= limit) break;
		try {
			if (!fs.statSync(entry.path).isFile()) continue;
		} catch {
			continue;
		}
		out.push(entry.path);
	}
	return out;
}

/** Forget everything (used on session switches). */
export function clearRecentReads(): void {
	recent.length = 0;
}
