/**
 * Edit-scope enforcement helpers.
 *
 * A subagent's scope is persisted to `<id>.scope` by the parent and re-read by
 * the child before every write/edit, so scope changes take effect live.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { scopeFile } from "./state.ts";
import type { SubagentRecord } from "./types.ts";

export function isWithinScope(targetAbs: string, scope: string[]): boolean {
	return scope.some((s) => {
		const rel = path.relative(s, targetAbs);
		return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	});
}

export function normalizeScope(baseCwd: string, scope: string | string[] | undefined): string[] | undefined {
	if (!scope) return undefined;
	const list = Array.isArray(scope) ? scope : [scope];
	const abs = list.map((p) => path.resolve(baseCwd, p));
	return abs.length > 0 ? [...new Set(abs)] : undefined;
}

/**
 * Read a subagent's live edit scope from the scope file the parent refreshes on
 * every spawn and every scope change. The child re-reads it before each
 * write/edit, so the main agent can widen or narrow the scope of an already
 * running subagent without restarting it. Returns `found: false` when the file
 * is absent/unreadable so callers can fall back to the spawn-time env scope.
 */
export function readLiveScope(): { found: boolean; scope?: string[]; allowTmp?: boolean } {
	const id = process.env.PI_SUBAGENT_ID;
	const dir = process.env.PI_SUBAGENT_DIR;
	if (!id || !dir) return { found: false };
	try {
		const raw = fs.readFileSync(path.join(path.resolve(dir), `${id}.scope`), "utf-8");
		const parsed = JSON.parse(raw) as { scope?: unknown; allowTmp?: unknown };
		const scope = Array.isArray(parsed.scope)
			? parsed.scope.filter((s): s is string => typeof s === "string" && s.length > 0)
			: [];
		return {
			found: true,
			scope: scope.length > 0 ? scope : undefined,
			allowTmp: typeof parsed.allowTmp === "boolean" ? parsed.allowTmp : undefined,
		};
	} catch {
		return { found: false };
	}
}

/**
 * Persist the subagent's edit scope to a side file the child polls live. Written
 * atomically (tmp + rename) so a running child never reads a half-written file.
 */
export function writeScopeFile(rec: SubagentRecord): void {
	try {
		const file = scopeFile(rec.id);
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ scope: rec.scope ?? [], allowTmp: rec.allowTmp !== false }), {
			encoding: "utf-8",
			mode: 0o600,
		});
		fs.renameSync(tmp, file);
	} catch {
		// A missing scope file just makes the child fall back to its env scope.
	}
}
