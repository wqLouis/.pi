/**
 * Process-scoped state for the background-job extension: the session's job
 * directory and the "extension disposed" flag used to stop notifications when
 * the session is replaced.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

let activeDir: string | undefined;
let disposed = false;

/** A filesystem-safe key for the current session (jobs are session-scoped). */
export function sessionScopeKey(ctx: ExtensionContext): string {
	let sessionId = "session";
	try {
		sessionId = ctx.sessionManager.getSessionId() || sessionId;
	} catch {
		// Session manager unavailable (early startup): fall back to a shared dir.
	}
	return sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "session";
}

/** Point the extension at the job directory of the active session. */
export function setActiveJobsDir(dir: string | undefined): void {
	activeDir = dir;
}

/** Reset process-scoped state (called once per factory invocation, e.g. /reload). */
export function resetState(): void {
	activeDir = undefined;
	disposed = false;
}

export function markDisposed(): void {
	disposed = true;
}

export function isDisposed(): boolean {
	return disposed;
}

/** Root directory holding every session's job records, logs and exit files. */
export function jobsRoot(): string {
	return process.env.PI_BGJOBS_DIR
		? path.resolve(process.env.PI_BGJOBS_DIR)
		: path.join(getAgentDir(), "bgjobs");
}

/** Directory holding this session's job records, logs and exit files. */
export function jobsDir(ctx?: ExtensionContext): string {
	const dir = activeDir ?? path.join(jobsRoot(), ctx ? sessionScopeKey(ctx) : "unscoped");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}
