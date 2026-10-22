/**
 * Subagent runtime orchestration: the live process registry, background
 * starts, completion finalization and notifications, interrupt/steering,
 * auto-resume reconciliation, and suspension on shutdown.
 */

import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnOpencodeProcess } from "./backends/opencode.ts";
import { spawnSubagentProcess, type SpawnedProcess } from "./backends/pi.ts";
import { DETAIL_CHARS, KILL_GRACE_MS, PREVIEW_CHARS, RESUME_WAIT_MS } from "./constants.ts";
import { getAutoResume, getMaxAutoResumes, maxForBackend } from "./config.ts";
import { backendOf } from "./models.ts";
import { buildCompletionText, buildResumePrompt, childTaskBase } from "./prompts.ts";
import {
	countRunningSubagents,
	isPidAlive,
	listRecords,
	loadRecord,
	recordLabel,
	saveRecord,
	waitForPidExit,
} from "./records.ts";
import { isExtensionDisposed, isSubagentProcess, setLiveOutput } from "./state.ts";
import type { RpcControl, RunResult, RunningEntry, SubagentRecord } from "./types.ts";
import { addUsage, firstLine, getFinalOutput, isFailedRun, sleep } from "./usage.ts";

/** Live subagent processes keyed by record id. */
export const running = new Map<string, RunningEntry>();

/** Persist the outcome of a finished run onto its record. */
export function finalizeRecord(rec: SubagentRecord, run: RunResult): { output: string; failed: boolean } {
	const output = getFinalOutput(run.messages) || "(no output)";
	rec.lastOutput = output;
	rec.totalUsage = addUsage(rec.totalUsage, run.usage);
	rec.status = isFailedRun(run) ? "error" : "idle";
	rec.lastError = isFailedRun(run) ? (run.errorMessage || run.stderr || firstLine(output).slice(0, DETAIL_CHARS)) : undefined;
	rec.pid = undefined;
	rec.suspended = false;
	rec.activeTask = undefined;
	saveRecord(rec);
	return { output, failed: isFailedRun(run) };
}

/** Show a UI toast and push the completion message to the main agent. */
export function notifyDone(pi: ExtensionAPI, ctx: ExtensionContext, rec: SubagentRecord): void {
	const text = buildCompletionText(rec);
	const brief = rec.status === "error" ? `Subagent ${recordLabel(rec)} error` : `Subagent ${recordLabel(rec)} done`;
	if (ctx.hasUI) {
		ctx.ui.notify(
			rec.status === "error" ? brief : `${brief}: ${firstLine(rec.lastOutput).slice(0, PREVIEW_CHARS)}`,
			rec.status === "error" ? "error" : "info",
		);
	}
	try {
		pi.sendUserMessage(text, { deliverAs: "steer" });
		rec.donePushedAt = Date.now();
		saveRecord(rec);
	} catch {
		// A missing send target leaves the record pending; the flush timer retries.
	}
}

/** Re-deliver completion notifications for records that finished but were never reported. */
export function flushPendingNotifications(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (isExtensionDisposed()) return;
	try {
		for (const rec of listRecords()) {
			if (rec.status === "running" || rec.donePushedAt) continue;
			pi.sendUserMessage(buildCompletionText(rec), { deliverAs: "steer" });
			rec.donePushedAt = Date.now();
			saveRecord(rec);
		}
	} catch {
		// Nothing to flush or the session is gone.
	}
}

async function resumeInterrupted(api: ExtensionAPI, ctx: ExtensionContext, rec: SubagentRecord): Promise<boolean> {
	rec.status = "running";
	rec.suspended = false;
	rec.resumeCount = (rec.resumeCount ?? 0) + 1;
	rec.donePushedAt = undefined;
	saveRecord(rec);
	const started = await startBackground(api, ctx, rec, buildResumePrompt(rec));
	if (!started.started) {
		rec.status = "error";
		rec.pid = undefined;
		rec.lastError = `Auto-resume failed: ${started.error ?? "unknown error"}`;
		saveRecord(rec);
		return false;
	}
	return true;
}

/**
 * On session start, find subagents left in `running` state by a previous pi
 * process and resume them (bounded by the auto-resume limit and the
 * concurrency limit). Live orphaned pids are stopped first.
 */
export async function reconcileAndAutoResume(api: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (isSubagentProcess || !getAutoResume()) return;
	const candidates = listRecords().filter((r) => r.status === "running");
	if (candidates.length === 0) return;

	const maxResumes = getMaxAutoResumes();
	// pi and opencode are independent pools, each bounded by its own limit.
	const live: Record<"pi" | "opencode", number> = {
		pi: countRunningSubagents("pi"),
		opencode: countRunningSubagents("opencode"),
	};
	const resumed: string[] = [];
	const skipped: string[] = [];

	for (const rec of candidates) {
		// A live pid means a previous pi process was hard-killed and left an orphan we
		// cannot reattach to. Stop it, then resume from its persisted session file.
		if (isPidAlive(rec.pid)) {
			try {
				process.kill(rec.pid!, "SIGTERM");
			} catch {
				// Already gone.
			}
			await waitForPidExit(rec.pid, RESUME_WAIT_MS);
		}
		rec.pid = undefined;

		if ((rec.resumeCount ?? 0) >= maxResumes) {
			rec.status = "error";
			rec.suspended = false;
			rec.lastError = `Not auto-resumed: reached the auto-resume limit (${maxResumes}).`;
			saveRecord(rec);
			skipped.push(rec.id);
			continue;
		}
		const pool = backendOf(rec);
		if (live[pool] >= maxForBackend(pool)) {
			skipped.push(rec.id);
			continue;
		}
		if (await resumeInterrupted(api, ctx, rec)) {
			live[pool]++;
			resumed.push(rec.id);
		} else {
			skipped.push(rec.id);
		}
	}

	if (resumed.length > 0) {
		try {
			ctx.ui.notify(`Auto-resumed ${resumed.length} interrupted subagent(s) after session resume.`, "info");
		} catch {
			// UI may be unavailable during startup.
		}
		try {
			api.sendMessage(
				{
					customType: "subagent-resume",
					content:
						`[subagents] Auto-resumed ${resumed.length} interrupted subagent(s) after session resume: ${resumed.join(", ")}.` +
						(skipped.length ? ` Not resumed (resume limit or concurrency): ${skipped.join(", ")}.` : ""),
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
		} catch {
			// Notification delivery is best-effort.
		}
	} else if (skipped.length > 0) {
		try {
			ctx.ui.notify(`Found ${skipped.length} interrupted subagent(s) but did not resume them (limit or concurrency).`, "warning");
		} catch {
			// UI may be unavailable during startup.
		}
	}
}

/** Stop every in-flight child process without finalizing it, so it can be resumed later. */
export function suspendAllRunning(): void {
	for (const entry of running.values()) {
		// Mutate the same record object the completion handler closes over, so its
		// suspended check sees the flag and skips finalize/notify.
		entry.rec.suspended = true;
		entry.rec.pid = undefined;
		saveRecord(entry.rec);
		try {
			entry.proc.kill("SIGTERM");
		} catch {
			// Already gone.
		}
	}
	running.clear();
}

/** Kick off a background turn for `rec` (spawning its backend process) and register it. */
export async function startBackground(
	api: ExtensionAPI,
	ctx: ExtensionContext,
	rec: SubagentRecord,
	userText: string,
): Promise<{ started: boolean; error?: string }> {
	if (isSubagentProcess) {
		return {
			started: false,
			error: "Nested subagents are not supported.",
		};
	}

	// pi and opencode run in independent pools, each bounded by its own limit.
	const pool = backendOf(rec);
	const poolLimit = maxForBackend(pool);
	const poolRunning = countRunningSubagents(pool);
	if (poolRunning >= poolLimit) {
		const label = pool === "opencode" ? "opencode subagents" : "subagents";
		return {
			started: false,
			error: `Maximum concurrent ${label} reached (${poolRunning}/${poolLimit} running).`,
		};
	}

	rec.status = "running";
	rec.suspended = false;
	rec.activeTask = userText;
	saveRecord(rec);

	let proc: ChildProcess;
	let done: Promise<RunResult>;
	let control: RpcControl | undefined;
	try {
		const spawnFn = backendOf(rec) === "opencode" ? spawnOpencodeProcess : spawnSubagentProcess;
		const spawned: SpawnedProcess = await spawnFn(
			rec,
			userText,
			0,
			undefined,
			(text) => setLiveOutput(rec.id, text),
			(bubble) => {
				if (ctx.hasUI) {
					ctx.ui.notify(`[subagent ${recordLabel(rec)}] ${firstLine(bubble.text).slice(0, PREVIEW_CHARS)}`, "info");
				}
				api.sendMessage(
					{
						customType: "subagent-bubble",
						content: `[subagent ${recordLabel(rec)}] ${bubble.text}`,
						display: true,
						details: { name: rec.name },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
			childTaskBase(ctx, rec.id),
		);
		proc = spawned.proc;
		done = spawned.done;
		control = spawned.control;
	} catch (error) {
		rec.status = "error";
		saveRecord(rec);
		return { started: false, error: `Failed to start subagent process: ${error instanceof Error ? error.message : String(error)}` };
	}

	rec.pid = proc.pid;
	saveRecord(rec);
	const entry: RunningEntry = { proc, done, rec, control };
	running.set(rec.id, entry);

	done
		.then(async (run) => {
			running.delete(rec.id);
			if (rec.suspended || entry.interrupted) {
				// Intentionally stopped (session switch/quit/interrupt/forget): keep it
				// resumable rather than finalizing it as an error or a completion.
				rec.pid = undefined;
				if (loadRecord(rec.id)) saveRecord(rec);
				return;
			}
			finalizeRecord(rec, run);
			notifyDone(api, ctx, rec);
			await deliverQueuedMessages(api, ctx, rec);
		})
		.catch((error) => {
			running.delete(rec.id);
			rec.status = "error";
			rec.pid = undefined;
			rec.lastOutput = rec.lastOutput || `background error: ${error instanceof Error ? error.message : String(error)}`;
			saveRecord(rec);
		});

	return { started: true };
}

/**
 * Stop a running subagent without delivering a message.
 *
 * Used by `subagent_forget`: the subagent is interrupted first (its in-flight
 * turn is aborted over the RPC channel, so no tool call is left hanging) and
 * only then are its files removed. The record is marked as intentionally
 * stopped before the process goes down, so the completion handler neither
 * finalizes it nor pushes an error notification to the main agent.
 */
export async function stopRunning(rec: SubagentRecord): Promise<void> {
	const entry = running.get(rec.id);

	if (!entry) {
		// Orphan from an earlier pi process: no control channel, so stop it by pid.
		if (isPidAlive(rec.pid)) {
			rec.suspended = true;
			saveRecord(rec);
			await waitForPidExit(rec.pid, RESUME_WAIT_MS);
			rec.suspended = false;
			rec.pid = undefined;
			if (loadRecord(rec.id)) saveRecord(rec);
		}
		return;
	}

	// Mark first: the completion handler must skip finalize/notify.
	entry.interrupted = true;
	rec.suspended = true;
	saveRecord(rec);

	if (entry.control && !entry.control.closed) {
		try {
			// Abort the in-flight turn (tool call, streaming) without a new prompt.
			await entry.control.sendCommand({ type: "abort" });
		} catch {
			// The child may already be gone; the hard stop below still applies.
		}
	}

	const escalate = setTimeout(() => {
		try {
			if (entry.proc.exitCode === null) entry.proc.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}, KILL_GRACE_MS);
	try {
		await Promise.race([entry.done, sleep(KILL_GRACE_MS + 1500)]);
	} finally {
		clearTimeout(escalate);
	}
	if (running.get(rec.id) === entry) running.delete(rec.id);
	rec.suspended = false;
	rec.pid = undefined;
	// The record may already have been deleted (forget); only persist it when it
	// still exists, so a forgotten subagent does not come back from the dead.
	if (loadRecord(rec.id)) saveRecord(rec);
}

/**
 * Interrupt a running subagent so a message can be delivered right now.
 *
 * Preferred path: the child runs pi in RPC mode, so we issue a real `abort`
 * command (pi aborts the in-flight tool call — including a running bash command
 * — and streaming) and then submit the message as the next prompt on the SAME
 * process. The ordinary completion handler then finalizes and notifies with the
 * new turn's result, so the caller must NOT start another turn.
 *
 * Fallbacks: if the process has no control channel or abort fails, kill it and
 * report `restarted`; if nothing is running, report `idle`. In both fallback
 * cases the caller starts a fresh turn.
 */
export async function interruptRunning(rec: SubagentRecord, message: string): Promise<"aborted" | "restarted" | "idle"> {
	const entry = running.get(rec.id);
	if (entry?.control && !entry.control.closed) {
		// Reserve the settle that is about to happen so the process is not shut
		// down before the emergency prompt gets its turn.
		entry.control.pendingContinuations++;
		try {
			const response = await entry.control.sendCommand({ type: "abort" });
			if (response?.success === false) throw new Error(response.error ?? "abort failed");
			if (entry.control.closed) throw new Error("subagent process closed during abort");
			const promptResponse = await entry.control.sendCommand({ type: "prompt", message });
			if (promptResponse?.success === false) throw new Error(promptResponse.error ?? "prompt failed");
			return "aborted";
		} catch {
			entry.control.pendingContinuations = Math.max(0, entry.control.pendingContinuations - 1);
			// Fall through to a hard restart so the message is still delivered.
		}
	}
	if (entry) {
		// Hard fallback: kill the process and let the caller start a fresh turn.
		entry.interrupted = true;
		rec.suspended = true;
		saveRecord(rec);
		try {
			entry.proc.kill("SIGTERM");
		} catch {
			// Already gone.
		}
		const escalate = setTimeout(() => {
			try {
				if (entry.proc.exitCode === null) entry.proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}, KILL_GRACE_MS);
		try {
			await Promise.race([entry.done, sleep(KILL_GRACE_MS + 1500)]);
		} finally {
			clearTimeout(escalate);
		}
		if (running.get(rec.id) === entry) running.delete(rec.id);
		rec.suspended = false;
		rec.pid = undefined;
		saveRecord(rec);
		return "restarted";
	}
	if (isPidAlive(rec.pid)) {
		// Orphan left by a previous pi process: no control channel, so stop it by pid.
		rec.suspended = true;
		saveRecord(rec);
		await waitForPidExit(rec.pid, RESUME_WAIT_MS);
		rec.suspended = false;
		rec.pid = undefined;
		saveRecord(rec);
		return "restarted";
	}
	return "idle";
}

/**
 * Deliver steering messages that were queued while the subagent was running.
 * Each queued message is started as a background turn on the subagent's session.
 */
export async function deliverQueuedMessages(api: ExtensionAPI, ctx: ExtensionContext, rec: SubagentRecord): Promise<void> {
	const queue = rec.pendingMessages ?? [];
	if (queue.length === 0) return;
	const next = queue.shift();
	rec.pendingMessages = queue;
	saveRecord(rec);
	const started = await startBackground(api, ctx, rec, next!);
	if (!started.started) {
		rec.pendingMessages = [next!, ...(rec.pendingMessages ?? [])];
		rec.lastError = started.error;
		saveRecord(rec);
	}
}
