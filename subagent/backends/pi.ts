/**
 * The pi backend: spawn a subagent as a separate `pi --mode rpc` process and
 * drive it over pi's RPC protocol (newline-delimited JSON on stdio).
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { KILL_GRACE_MS } from "../constants.ts";
import { getPiInvocation, writePromptToTempFile } from "../prompts.ts";
import { writeScopeFile } from "../scope.ts";
import { getCurrentMainSessionFile } from "../state.ts";
import { sessionFileForRecord, subagentDir } from "../state.ts";
import type { RpcControl, RunResult, SubagentRecord } from "../types.ts";
import { EMPTY_USAGE, getFinalOutput } from "../usage.ts";

/**
 * A cache key shared by every child of the current main session, so the
 * provider reuses one cached prompt prefix across the batch.
 */
let cachedPromptKey: string | undefined;

function promptCacheKey(): string | undefined {
	if (cachedPromptKey) return cachedPromptKey;
	const sessionFile = getCurrentMainSessionFile();
	const id = sessionFile ? path.basename(sessionFile).replace(/\.jsonl$/, "") : process.env.PI_SESSION_ID;
	const base = id ? `pi-sub-${id}` : `pi-sub-${process.pid}`;
	cachedPromptKey = base.slice(0, 64);
	return cachedPromptKey;
}

export interface SpawnedProcess {
	proc: ChildProcess;
	done: Promise<RunResult>;
	control: RpcControl;
}

/**
 * Spawn a pi-backed subagent. The child starts idle in RPC mode; the initial
 * turn is submitted as a `prompt` command over stdin. Extension bubbles the
 * child emits are parsed from both stdout and stderr (pi redirects extension
 * writes to stderr in non-interactive modes) and surfaced via `onBubble`.
 */
export async function spawnSubagentProcess(
	rec: SubagentRecord,
	userText: string,
	depth: number,
	signal: AbortSignal | undefined,
	onUpdate?: (text: string) => void,
	onBubble?: (bubble: { text: string }) => void,
	taskBase?: string,
): Promise<SpawnedProcess> {
	const args: string[] = ["--mode", "rpc", "--session", sessionFileForRecord(rec)];
	if (rec.model) args.push("--model", rec.model);
	if (rec.thinkingLevel) args.push("--thinking", rec.thinkingLevel);
	if (rec.tools) args.push("--tools", rec.tools);

	writeScopeFile(rec);

	const tmp = await writePromptToTempFile(rec.systemPrompt);
	args.push("--append-system-prompt", tmp.filePath);

	const result: RunResult = {
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: EMPTY_USAGE(),
		bubbles: [],
	};

	let proc: ChildProcess | undefined;
	let stdinClosed = false;
	let commandSeq = 0;
	const pendingResponses = new Map<string, (response: any) => void>();
	const writeCommand = (cmd: Record<string, unknown>) => {
		try {
			if (!stdinClosed && proc?.stdin?.writable) proc.stdin.write(`${JSON.stringify(cmd)}\n`);
		} catch {
			// A closed stdin means the child is already shutting down.
		}
	};
	const closeStdin = () => {
		if (stdinClosed) return;
		stdinClosed = true;
		control.closed = true;
		try {
			proc?.stdin?.end();
		} catch {
			// Already closed.
		}
	};
	const control: RpcControl = {
		pendingContinuations: 0,
		closed: false,
		sendCommand: (cmd) => {
			const id = `sub-${++commandSeq}`;
			return new Promise((resolve) => {
				pendingResponses.set(id, resolve);
				writeCommand({ id, ...cmd });
			});
		},
	};

	const done = new Promise<RunResult>((resolve) => {
		const invocation = getPiInvocation(args);
		const env: Record<string, string> = {
			...process.env,
			PI_SUBAGENT_DEPTH: String(depth + 1),
			PI_SUBAGENT_ID: rec.id,
			PI_SUBAGENT_DIR: subagentDir(),
		};
		if (rec.scope && rec.scope.length > 0) {
			env.PI_SUBAGENT_SCOPE = JSON.stringify(rec.scope);
		}
		if (rec.tools) env.PI_SUBAGENT_TOOLS_SET = "1";
		// Cache: keep the shared prefix (system prompt + prefill) cached for a
		// day, and route every child of this main session to the same cache key
		// so the batch reuses one cached prefix instead of one per child.
		env.PI_CACHE_RETENTION = env.PI_CACHE_RETENTION ?? "long";
		const cacheKey = promptCacheKey();
		if (cacheKey) env.PI_PROMPT_CACHE_KEY = cacheKey;
		if (taskBase) env.PI_TASK_BASE = taskBase;
		if (rec.allowTmp === false) env.PI_SUBAGENT_SCOPE_BLOCK_TMP = "1";
		proc = spawn(invocation.command, invocation.args, {
			cwd: rec.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});
		let buffer = "";
		let stderrBuffer = "";

		// pi takes over process.stdout in non-interactive modes (json/print/rpc) and
		// redirects extension writes to stderr, so bubbles arrive on the child's
		// stderr. Parse both streams so a bubble is never lost.
		const emitBubble = (event: any) => {
			const bubble = { text: String(event.content ?? "") };
			result.bubbles?.push(bubble);
			if (onBubble) onBubble(bubble);
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message) {
				const msg = event.message as Message;
				result.messages.push(msg);
				if (msg.role === "assistant") {
					result.usage.turns++;
					const u = msg.usage;
					if (u) {
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += u.cost?.total || 0;
						result.usage.contextTokens = u.totalTokens || 0;
					}
					if (!result.model && msg.model) result.model = msg.model;
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;
				}
				if (onUpdate) onUpdate(getFinalOutput(result.messages) || "(working...)");
			}
			if (event.type === "tool_result_end" && event.message) {
				result.messages.push(event.message as Message);
			}
			if (event.type === "subagent_bubble") emitBubble(event);
			if (event.type === "response" && typeof event.id === "string") {
				const pending = pendingResponses.get(event.id);
				if (pending) {
					pendingResponses.delete(event.id);
					pending(event);
				}
			}
			if (
				event.type === "extension_ui_request" &&
				(event.method === "select" || event.method === "confirm" || event.method === "input" || event.method === "editor")
			) {
				// Headless subagents must never block on a dialog: answer with the default.
				writeCommand({ type: "extension_ui_response", id: event.id, cancelled: true });
			}
			if (event.type === "agent_settled") {
				// Keep the process alive only while another run is queued (e.g. an emergency
				// interrupt that aborted this turn and pushed a new prompt).
				if (control.pendingContinuations > 0) control.pendingContinuations--;
				else closeStdin();
			}
		};

		const processStderrLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				result.stderr += line + "\n";
				return;
			}
			if (event && event.type === "subagent_bubble") {
				emitBubble(event);
				return;
			}
			result.stderr += line + "\n";
		};

		proc!.stdout!.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		proc!.stderr!.on("data", (data) => {
			stderrBuffer += data.toString();
			const lines = stderrBuffer.split("\n");
			stderrBuffer = lines.pop() || "";
			for (const line of lines) processStderrLine(line);
		});
		proc!.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			if (stderrBuffer.trim()) processStderrLine(stderrBuffer);
			// Keep an exit code we already set for a known failure (e.g. a rejected
			// prompt still lets the child shut down cleanly with code 0).
			result.exitCode = result.exitCode || (code ?? 0);
			resolve(result);
		});
		proc!.on("error", () => {
			result.exitCode = 1;
			resolve(result);
		});
		if (signal) {
			const killProc = () => {
				proc!.kill("SIGTERM");
				setTimeout(() => {
					if (!proc!.killed) proc!.kill("SIGKILL");
				}, KILL_GRACE_MS);
			};
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}

		// RPC mode starts idle; the initial turn is submitted as a `prompt` command.
		// A `handled` disposition means no run started, so shut down immediately; a
		// rejected prompt is surfaced as a failed run rather than hanging forever.
		pendingResponses.set("sub-initial", (response) => {
			if (response?.success === false) {
				result.exitCode = 1;
				result.errorMessage = response.error ?? "prompt failed";
				closeStdin();
			} else if (response?.data?.disposition === "handled") {
				closeStdin();
			}
		});
		writeCommand({ id: "sub-initial", type: "prompt", message: userText });
	});

	done.finally(() => {
		try {
			fs.unlinkSync(tmp.filePath);
		} catch {
			// Already gone.
		}
		try {
			fs.rmdirSync(tmp.dir);
		} catch {
			// Already gone.
		}
	});

	return { proc: proc!, done, control };
}
