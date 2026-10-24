/**
 * Background jobs extension.
 *
 * Launches shell commands in the background (their own process group, their
 * own log file) and calls the agent back when they finish: the completion
 * arrives as a real user message with the exit code and the tail of the
 * output, so the agent never has to poll.
 *
 * Jobs survive the pi process: a later session adopts the ones that are still
 * running, and the completion callback is delivered then.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerBgJobCommand } from "./command.ts";
import { adoptOrphanJobs, detachLiveJobs, flushPendingNotifications } from "./runtime.ts";
import { jobsRoot, markDisposed, resetState, sessionScopeKey, setActiveJobsDir } from "./state.ts";
import { registerBgJobTools } from "./tools.ts";

const FLUSH_DELAY_MS = 500;
const FLUSH_INTERVAL_MS = 30_000;

export default function (pi: ExtensionAPI) {
	resetState();

	let lastCtx: ExtensionContext | undefined;
	const scheduleFlush = (ctx: ExtensionContext, delayMs: number) => {
		lastCtx = ctx;
		setTimeout(() => {
			try {
				flushPendingNotifications(pi, ctx);
			} catch {
				// Nothing to flush or the session is gone.
			}
		}, delayMs);
	};

	pi.on("session_start", (_event, ctx) => {
		setActiveJobsDir(path.join(jobsRoot(), sessionScopeKey(ctx)));
		// Jobs that outlived an earlier pi process are picked up again.
		try {
			adoptOrphanJobs(pi, ctx);
		} catch {
			// Nothing to adopt.
		}
		scheduleFlush(ctx, 1000);
	});

	pi.on("agent_end", (_event, ctx) => scheduleFlush(ctx, FLUSH_DELAY_MS));

	// Idle timer: a completion that could not be delivered (busy turn, reload)
	// is re-delivered here, so no callback is ever lost.
	const flushTimer = setInterval(() => {
		if (!lastCtx) return;
		try {
			flushPendingNotifications(pi, lastCtx);
		} catch {
			// Nothing to flush or the session is gone.
		}
	}, FLUSH_INTERVAL_MS);

	pi.on("session_shutdown", () => {
		markDisposed();
		clearInterval(flushTimer);
		// The jobs themselves keep running (they are detached), but this process
		// stops watching them.
		detachLiveJobs();
	});

	registerBgJobTools(pi);
	registerBgJobCommand(pi);
}
