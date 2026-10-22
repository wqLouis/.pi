/**
 * Subagent extension entry point.
 *
 * Spawns and manages pi/opencode subagent processes: background runs with
 * completion notifications, steering/interrupts, edit scopes, auto-resume, and
 * a settings panel (`/subagent config`).
 */

import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FLUSH_DELAY_MS, FLUSH_INTERVAL_MS, SESSION_START_FLUSH_DELAY_MS } from "./constants.ts";
import { registerChildHooks } from "./child.ts";
import { registerSubagentCommand } from "./command.ts";
import { flushPendingNotifications, reconcileAndAutoResume, suspendAllRunning } from "./runtime.ts";
import {
	isSubagentProcess,
	markExtensionDisposed,
	resetExtensionState,
	sessionFileOf,
	sessionScopeKey,
	setActiveSubagentDir,
	setCurrentMainSessionFile,
	subagentDir,
} from "./state.ts";
import { recordRead } from "./reads.ts";
import { registerMainTools } from "./tools.ts";

export default function (pi: ExtensionAPI) {
	resetExtensionState();

	pi.on("session_shutdown", () => {
		// A session replacement (switch/reload/new/fork) or a quit tears this extension
		// instance down. Mark in-flight runs suspended so their close handlers don't
		// finalize them, then stop the children. Interrupted runs are resumed by
		// reconcileAndAutoResume on the next session_start.
		markExtensionDisposed();
		suspendAllRunning();
	});

	let lastFlushCtx: ExtensionContext | undefined;
	const scheduleFlush = (ctx: ExtensionContext, delayMs: number) => {
		lastFlushCtx = ctx;
		setTimeout(() => {
			flushPendingNotifications(pi, ctx);
		}, delayMs);
	};

	pi.on("session_start", async (_event, ctx) => {
		setActiveSubagentDir(
			process.env.PI_SUBAGENT_DIR
				? path.resolve(process.env.PI_SUBAGENT_DIR)
				: path.join(getAgentDir(), "subagents", sessionScopeKey(ctx)),
		);
		setCurrentMainSessionFile(sessionFileOf(ctx));
		subagentDir(ctx); // Ensures the session's subagent directory exists.
		scheduleFlush(ctx, SESSION_START_FLUSH_DELAY_MS);
		if (!isSubagentProcess) {
			await reconcileAndAutoResume(pi, ctx);
		}
	});

	pi.on("agent_end", (_event, ctx) => scheduleFlush(ctx, FLUSH_DELAY_MS));

	const flushTimer = setInterval(() => {
		if (!lastFlushCtx) return;
		try {
			flushPendingNotifications(pi, lastFlushCtx);
		} catch {
			// Nothing to flush or the session is gone.
		}
	}, FLUSH_INTERVAL_MS);
	pi.on("session_shutdown", () => clearInterval(flushTimer));

	if (isSubagentProcess) {
		// A child cannot spawn subagents, so the management tools would only add
		// their (long) descriptions to the child's system prompt. The bubble tool
		// comes with the child hooks.
		registerChildHooks(pi);
	} else {
		registerMainTools(pi);
		// Remember what the main agent reads: those files are prefilled into the
		// next child's first message (fewer reads in the child, one shared
		// cached prefix for the whole batch).
		pi.on("tool_call", (event, ctx) => {
			if (event.toolName !== "read") return;
			const file = (event.input as { path?: unknown }).path;
			if (typeof file === "string" && file.trim()) recordRead(file, ctx.cwd);
		});
	}
	registerSubagentCommand(pi);
}
