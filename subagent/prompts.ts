/**
 * Prompt construction for spawned subagents: shared context prefill, temp
 * system-prompt files, pi invocation lookup, and the completion/resume texts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PREFILL_MAX_FILE_CHARS, PREFILL_MAX_TOTAL_CHARS } from "./constants.ts";
import { backendOf } from "./models.ts";
import { recordLabel } from "./records.ts";
import { sessionFileForRecord } from "./state.ts";
import type { SubagentRecord } from "./types.ts";

/**
 * Build a shared context-prefill block from file paths. The block is identical
 * for every subagent spawned by the same call, so their conversation prefixes
 * (system prompt + this block) match exactly and provider prompt caches hit
 * across the batch — the subagents don't each have to issue their own reads.
 */
export function buildPrefillBlock(paths: string[] | undefined, cwd: string): string | undefined {
	if (!paths || paths.length === 0) return undefined;
	const parts: string[] = [];
	let total = 0;
	for (const p of paths) {
		const abs = path.resolve(cwd, p);
		let entry: string;
		try {
			const stat = fs.statSync(abs);
			if (!stat.isFile()) throw new Error("not a regular file");
			let content = fs.readFileSync(abs, "utf-8");
			if (content.length > PREFILL_MAX_FILE_CHARS) {
				content = content.slice(0, PREFILL_MAX_FILE_CHARS) + "\n… [truncated]";
			}
			entry = `<file path="${abs}">\n${content}\n</file>`;
		} catch (error) {
			entry = `<file path="${abs}">[could not be read: ${error instanceof Error ? error.message : String(error)}]</file>`;
		}
		if (total + entry.length > PREFILL_MAX_TOTAL_CHARS) {
			parts.push(`<file path="${abs}">[skipped: prefill size limit reached]</file>`);
			continue;
		}
		total += entry.length;
		parts.push(entry);
	}
	return [
		"<shared-context-prefill>",
		"The files below were read once by the main agent before you were spawned and are injected here verbatim, identical for every subagent spawned in this batch. Treat them as current as of spawn time; re-read a file only if you need fresher content or it was truncated/skipped.",
		"",
		...parts,
		"</shared-context-prefill>",
	].join("\n");
}

/** Write the subagent's system prompt to a private temp file pi can append. */
export async function writePromptToTempFile(prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const filePath = path.join(tmpDir, "system-prompt.md");
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

/** How to invoke the pi CLI from here (bun virtual scripts and installed binaries included). */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/** Directory for the shared TASK.md board of this main session. */
export function currentTaskBase(ctx: ExtensionContext | undefined): string {
	if (process.env.PI_TASK_BASE) return process.env.PI_TASK_BASE;
	const dir = process.env.PI_TASK_DIR || "/tmp";
	let sessionId = "session";
	try {
		sessionId = ctx?.sessionManager.getSessionId() ?? "session";
	} catch {
		// Session manager unavailable: fall back to a shared base.
	}
	const safe = sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "session";
	return path.join(dir, safe);
}

/**
 * The task base a child should use. All subagents in one main session share the
 * same logical TASK.md board.
 */
export function childTaskBase(ctx: ExtensionContext | undefined, _childId: string): string {
	return currentTaskBase(ctx);
}

/**
 * First-turn preamble for an opencode subagent. opencode keeps its own system
 * prompt and the ACP protocol has no "append system prompt" hook, so the
 * subagent framing, working directory, and edit scope are prepended to the
 * first user message instead. Later turns reuse the same opencode session, so
 * the preamble stays in its history and is not repeated.
 */
export function buildOpencodeFirstPrompt(rec: SubagentRecord, userText: string): string {
	const sections: string[] = [rec.systemPrompt];
	const context: string[] = [`Working directory: ${rec.cwd}`];
	if (rec.scope && rec.scope.length > 0) {
		context.push(
			`Edit scope: only create or modify files under ${rec.scope.join(", ")}. Reads are unrestricted. ` +
				`If the task seems to require writing elsewhere, say so instead of doing it.`,
		);
	}
	if (rec.tools) {
		context.push(
			`Preferred tools from the user's configuration: ${rec.tools}. Use the equivalent OpenCode tool if a name differs.`,
		);
	}
	sections.push(`[subagent context]\n${context.join("\n")}`);
	sections.push(userText);
	return sections.filter((s) => s && s.trim()).join("\n\n");
}

/** The message pushed to the main agent when a subagent finishes (or fails). */
export function buildCompletionText(rec: SubagentRecord): string {
	const output = rec.lastOutput.trim() || "(no output)";
	if (rec.status === "error") {
		const detail = rec.lastError?.trim() || "(no error detail)";
		return (
			`[subagent ${recordLabel(rec)} error]\n\n` +
			`Error: ${detail}\n\n` +
			`Last output:\n${output}\n\n` +
			`Resolve it with subagent_interrupt { name: "${recordLabel(rec)}", message: "<what to fix>" }, ` +
			`or inspect the full transcript with subagent_result { name: "${recordLabel(rec)}" }. ` +
			`Use subagent_forget { name: "${recordLabel(rec)}" } to discard it.`
		);
	}
	return `[subagent ${recordLabel(rec)} done]\n\n${output}`;
}

/** The first message of a resumed (interrupted) subagent run. */
export function buildResumePrompt(rec: SubagentRecord): string {
	const sessionPath = rec.sessionPath ?? sessionFileForRecord(rec);
	let hasSession = false;
	if (backendOf(rec) === "opencode") {
		// The opencode session lives in opencode's own store and is reloaded by id.
		hasSession = !!rec.opencodeSessionId;
	} else {
		try {
			hasSession = !!sessionPath && fs.existsSync(sessionPath);
		} catch {
			// Treat an unreadable session file as missing.
		}
	}
	if (!hasSession && (rec.task || rec.activeTask)) {
		return `[auto-resume] ${rec.task ?? rec.activeTask}`;
	}
	return (
		"[auto-resume] The pi process was stopped before your previous turn finished, so you were interrupted. " +
		"Your conversation context above is intact. Review it and continue the task from where you left off. " +
		"Do not repeat work that is already complete. When finished, report your final result."
	);
}
