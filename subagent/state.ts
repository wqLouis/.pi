/**
 * Mutable extension state (active session scope, main session file) plus the
 * on-disk layout helpers shared by every module.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentRecord } from "./types.ts";

/** True inside a subagent process; blocks nested spawns and drives child-only hooks. */
export const isSubagentProcess = Number(process.env.PI_SUBAGENT_DEPTH ?? "0") >= 1;

let activeSubagentDir: string | undefined;
let currentMainSessionFile: string | undefined;
let extensionDisposed = false;

/**
 * Streamed output per record id (opencode ACP text chunks; pi accumulated text).
 * In-memory only: the viewer falls back to the record's lastOutput when a
 * subagent ran in a previous process.
 */
const liveOutputs = new Map<string, string>();

export function setLiveOutput(id: string, text: string): void {
	liveOutputs.set(id, text);
}

export function getLiveOutput(id: string): string | undefined {
	return liveOutputs.get(id);
}

/** Reset process-scoped state; called once per factory invocation (e.g. after /reload). */
export function resetExtensionState(): void {
	extensionDisposed = false;
}

export function markExtensionDisposed(): void {
	extensionDisposed = true;
}

export function isExtensionDisposed(): boolean {
	return extensionDisposed;
}

export function setActiveSubagentDir(dir: string | undefined): void {
	activeSubagentDir = dir;
}

export function setCurrentMainSessionFile(file: string | undefined): void {
	currentMainSessionFile = file;
}

export function getCurrentMainSessionFile(): string | undefined {
	return currentMainSessionFile;
}

/** A filesystem-safe key for the current session, used as the subagent dir name. */
export function sessionScopeKey(ctx: ExtensionContext): string {
	let sessionId = "session";
	try {
		sessionId = ctx.sessionManager.getSessionId() || sessionId;
	} catch {
		// Session manager unavailable (early startup): fall back to a shared dir.
	}
	return sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "session";
}

/** Directory holding this session's subagent records and session files. */
export function subagentDir(ctx?: ExtensionContext): string {
	const configured = process.env.PI_SUBAGENT_DIR;
	const dir = configured
		? path.resolve(configured)
		: activeSubagentDir ?? path.join(getAgentDir(), "subagents", ctx ? sessionScopeKey(ctx) : "unscoped");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function recordFile(id: string): string {
	return path.join(subagentDir(), `${id}.json`);
}

export function sessionFile(id: string): string {
	return path.join(subagentDir(), `${id}.jsonl`);
}

export function sessionFileForRecord(rec: Pick<SubagentRecord, "id" | "sessionPath">): string {
	return rec.sessionPath ?? sessionFile(rec.id);
}

export function scopeFile(id: string): string {
	return path.join(subagentDir(), `${id}.scope`);
}

/** The main session file for `ctx`, when available. */
export function sessionFileOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile() ?? undefined;
	} catch {
		return undefined;
	}
}
