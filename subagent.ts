/**
 * Subagent — a single generic subagent the main agent can spawn, wait for,
 * and steer.
 *
 * One kind of subagent, using a model resolved in this order:
 *   1. the `model` parameter passed to subagent_spawn
 *   2. the user-configured model in ~/.pi/agent/subagent-config.json
 *      (set it with `/subagent model <provider/id>`)
 *   3. the user's currently selected session model
 *
 * Each subagent owns a private pi session file, so its context survives
 * between turns. Spawning can be synchronous (await: true, default) or
 * background (await: false). Background subagents notify the main agent when
 * they finish, and the main agent can wait on them:
 *
 *   subagent_spawn  – spawn a subagent (sync or background), returns subagentId
 *   subagent_wait   – wait until a subagent (or all running subagents) finish;
 *                     streams progress and returns the final outputs
 *   subagent_send   – push a follow-up message / steering instruction to a
 *                     finished subagent (continues its private session)
 *   subagent_list   – list subagents and their status (running/idle/error)
 *   subagent_result – read a subagent's full transcript
 *   subagent_forget – delete a subagent (kills it if still running)
 *   subagent_config – show the effective subagent configuration
 *
 * Implementation: each turn spawns a one-shot `pi --mode json -p` process
 * resumed on the subagent's private session file (`--session <file>`), so the
 * subagent always has its exact history without re-serializing anything.
 *
 * State lives in ~/.pi/agent/subagents/:
 *   <id>.json      – metadata record (model, system prompt, cwd, status, usage)
 *   <id>.jsonl     – the subagent's pi session file
 * and user configuration in ~/.pi/agent/subagent-config.json.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
	getAgentDir,
	getSettingsListTheme,
	withFileMutationQueue,
	DynamicBorder,
} from "@earendil-works/pi-coding-agent";
import { Container, decodeKittyPrintable, matchesKey, SettingsList, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_MAX_DEPTH = 3; // default max nesting layers (user-configurable via settings)
const DEFAULT_MAX_SUBAGENTS = 4; // default max concurrently running subagents
const MAX_ERROR_CHARS = 500;
const POLL_INTERVAL_MS = 500;

const DEFAULT_SUBAGENT_PROMPT = [
	"You are a subagent working for a main agent. You run in an isolated context, so the main agent's conversation is not visible to you — only the task you receive and any follow-up instructions.",
	"",
	"Guidelines:",
	"- Complete the assigned task autonomously, using your tools as needed.",
	"- The main agent may send follow-up messages to steer or redirect you. Treat them as updated instructions and adapt your work accordingly.",
	"- When done, report concisely with concrete details (file paths, findings, decisions) that the main agent can act on without re-reading the code.",
	"- If something is blocked or impossible, say so clearly instead of guessing.",
	"- You may delegate to your own sub-subagents up to the configured layer limit (see subagent_config), but prefer doing the work yourself unless nesting is clearly useful.",
].join("\n");

/* ------------------------------------------------------------------ */
/* Scope & subagent-process detection                                  */
/* ------------------------------------------------------------------ */

// True when this extension instance runs inside a spawned subagent process
// (the parent sets PI_SUBAGENT_DEPTH=1 for every subagent). Subagents get the
// bubble-up tools in addition to the full subagent toolset — nesting is
// allowed up to the configured maxDepth, enforced at spawn time.
const isSubagentProcess = Number(process.env.PI_SUBAGENT_DEPTH ?? "0") >= 1;

/** True when the absolute target path lies inside any scope entry (dir or file). */
function isWithinScope(targetAbs: string, scope: string[]): boolean {
	return scope.some((s) => {
		const rel = path.relative(s, targetAbs);
		return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	});
}

/** Normalize a scope (dir path or list of paths) into absolute paths. */
function normalizeScope(baseCwd: string, scope: string | string[] | undefined): string[] | undefined {
	if (!scope) return undefined;
	const list = Array.isArray(scope) ? scope : [scope];
	const abs = list.map((p) => path.resolve(baseCwd, p));
	return abs.length > 0 ? [...new Set(abs)] : undefined;
}

type SubagentStatus = "running" | "idle" | "error";

interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface RunResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: RunUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Messages/requests the subagent bubbled up to the main agent during the run. */
	bubbles?: Array<{ text: string; request: boolean }>;
}

interface SubagentRecord {
	id: string;
	model?: string;
	systemPrompt: string;
	cwd: string;
	tools?: string;
	/** Absolute edit-scope paths (dirs or files). Writes outside are blocked. */
	scope?: string[];
	status: SubagentStatus;
	pid?: number;
	createdAt: number;
	updatedAt: number;
	lastOutput: string;
	totalUsage: RunUsage;
}

interface SubagentDetails {
	subagentId: string;
	model?: string;
	output: string;
	status: SubagentStatus;
	usage: RunUsage;
}

interface SubagentConfig {
	model?: string;
	systemPrompt?: string;
	cwd?: string;
	tools?: string;
	/** Max nesting layers (1 = subagents cannot spawn sub-subagents). */
	maxDepth?: number;
	/** Max concurrently-running subagents across all layers. */
	maxSubagents?: number;
}

interface RunningEntry {
	proc: ChildProcess;
	done: Promise<RunResult>;
	getPartial: () => string;
}

const EMPTY_USAGE = (): RunUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
});

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: RunUsage, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function firstLine(text: string): string {
	return text.split("\n")[0] ?? "";
}

function addUsage(a: RunUsage, b: RunUsage): RunUsage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
		contextTokens: b.contextTokens || a.contextTokens,
		turns: a.turns + b.turns,
	};
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: string }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n");
}

/* ------------------------------------------------------------------ */
/* User configuration (~/.pi/agent/subagent-config.json)               */
/* ------------------------------------------------------------------ */

function configFile(): string {
	return path.join(getAgentDir(), "subagent-config.json");
}

function loadConfig(): SubagentConfig {
	try {
		const raw = fs.readFileSync(configFile(), "utf-8");
		const cfg = JSON.parse(raw) as SubagentConfig;
		if (cfg && typeof cfg === "object") return cfg;
	} catch {
		/* missing or corrupted */
	}
	return {};
}

function saveConfig(cfg: SubagentConfig): void {
	fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/** Max nesting depth: config > env > default. */
function getMaxDepth(): number {
	const cfg = loadConfig();
	if (typeof cfg.maxDepth === "number" && Number.isFinite(cfg.maxDepth) && cfg.maxDepth >= 1) return Math.floor(cfg.maxDepth);
	const env = Number(process.env.PI_SUBAGENT_MAX_DEPTH);
	if (Number.isFinite(env) && env >= 1) return Math.floor(env);
	return DEFAULT_MAX_DEPTH;
}

/** Max concurrently running subagents (global across layers): config > env > default. */
function getMaxSubagents(): number {
	const cfg = loadConfig();
	if (typeof cfg.maxSubagents === "number" && Number.isFinite(cfg.maxSubagents) && cfg.maxSubagents >= 1)
		return Math.floor(cfg.maxSubagents);
	const env = Number(process.env.PI_SUBAGENT_MAX_SUBAGENTS);
	if (Number.isFinite(env) && env >= 1) return Math.floor(env);
	return DEFAULT_MAX_SUBAGENTS;
}

/** Count subagents currently running anywhere (shared records; stale dead records excluded). */
function countRunningSubagents(): number {
	let count = 0;
	try {
		for (const file of fs.readdirSync(subagentDir())) {
			if (!file.endsWith(".json")) continue;
			try {
				const rec = JSON.parse(fs.readFileSync(path.join(subagentDir(), file), "utf-8")) as SubagentRecord;
				if (rec?.status !== "running") continue;
				if (rec.pid != null) {
					try {
						process.kill(rec.pid, 0);
					} catch {
						continue; // stale record: process is dead
					}
				}
				count++;
			} catch {
				/* unreadable/corrupt record */
			}
		}
	} catch {
		/* dir missing */
	}
	return count;
}

/** Resolve spawn defaults: explicit param > user config > session model/cwd. */
function resolveSpawnOptions(
	ctx: ExtensionContext,
	params: { model?: string; systemPrompt?: string; cwd?: string; tools?: string },
): { model?: string; systemPrompt: string; cwd: string; tools?: string } {
	const cfg = loadConfig();
	const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const systemPrompt = (params.systemPrompt ?? cfg.systemPrompt ?? "").trim();
	return {
		model: params.model ?? cfg.model ?? sessionModel,
		systemPrompt: systemPrompt || DEFAULT_SUBAGENT_PROMPT,
		cwd: params.cwd ?? cfg.cwd ?? ctx.cwd,
		tools: params.tools ?? cfg.tools,
	};
}

/* ------------------------------------------------------------------ */
/* Subagent storage (metadata records + pi session files)              */
/* ------------------------------------------------------------------ */

function subagentDir(): string {
	const dir = path.join(getAgentDir(), "subagents");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function recordFile(id: string): string {
	return path.join(subagentDir(), `${id}.json`);
}

function sessionFile(id: string): string {
	return path.join(subagentDir(), `${id}.jsonl`);
}

function newSubagentId(): string {
	return `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadRecord(id: string): SubagentRecord | undefined {
	try {
		const raw = fs.readFileSync(recordFile(id), "utf-8");
		const rec = JSON.parse(raw) as SubagentRecord;
		if (rec && typeof rec.id === "string") {
			if (!rec.status) rec.status = "idle"; // old records
			return rec;
		}
	} catch {
		/* corrupted or missing */
	}
	return undefined;
}

function saveRecord(rec: SubagentRecord): void {
	rec.updatedAt = Date.now();
	fs.writeFileSync(recordFile(rec.id), JSON.stringify(rec, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/** Read a subagent's session file and render it as a plain-text transcript. */
function readTranscript(id: string): string {
	try {
		const raw = fs.readFileSync(sessionFile(id), "utf-8");
		const parts: string[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== "message" || !entry.message) continue;
			const m = entry.message as { role?: string; content?: unknown; toolName?: string };
			const text = extractText(m.content);
			if (m.role === "user") parts.push(`[user] ${text}`);
			else if (m.role === "assistant") parts.push(`[assistant] ${text}`);
			else if (m.role === "toolResult")
				parts.push(`[tool ${m.toolName ?? ""}] ${text.slice(0, 500)}${text.length > 500 ? "…" : ""}`);
		}
		return parts.join("\n\n");
	} catch {
		return "";
	}
}

/* ------------------------------------------------------------------ */
/* Process spawning (one-shot pi per turn, resumed on the subagent's   */
/* private session file)                                               */
/* ------------------------------------------------------------------ */

async function writePromptToTempFile(prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const filePath = path.join(tmpDir, "system-prompt.md");
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

/**
 * Spawn one subagent turn. Returns the child handle plus a promise that
 * resolves with the run result when the process exits (message stream parsed).
 */
async function spawnSubagentProcess(
	rec: SubagentRecord,
	userText: string,
	depth: number,
	signal: AbortSignal | undefined,
	onUpdate?: (text: string) => void,
	onBubble?: (bubble: { text: string; request: boolean }) => void,
): Promise<{ proc: ChildProcess; done: Promise<RunResult> }> {
	const args: string[] = ["--mode", "json", "-p", "--session", sessionFile(rec.id)];
	if (rec.model) args.push("--model", rec.model);

	const tmp = await writePromptToTempFile(rec.systemPrompt);
	try {
		args.push("--append-system-prompt", tmp.filePath);
		args.push(userText);

		const result: RunResult = {
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: EMPTY_USAGE(),
			bubbles: [],
		};

		let proc: ChildProcess | undefined;
		const done = new Promise<RunResult>((resolve) => {
			const invocation = getPiInvocation(args);
			const env: Record<string, string> = {
				...process.env,
				PI_SUBAGENT_DEPTH: String(depth + 1),
				PI_SUBAGENT_ID: rec.id,
			};
			if (rec.scope && rec.scope.length > 0) {
				env.PI_SUBAGENT_SCOPE = JSON.stringify(rec.scope);
			}
			proc = spawn(invocation.command, invocation.args, {
				cwd: rec.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env,
			});
			let buffer = "";

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
				if (event.type === "subagent_bubble") {
					const bubble = { text: String(event.content ?? ""), request: !!event.request };
					result.bubbles?.push(bubble);
					if (onBubble) onBubble(bubble);
				}
			};

			proc!.stdout!.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc!.stderr!.on("data", (data) => {
				result.stderr += data.toString();
			});
			proc!.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				result.exitCode = code ?? 0;
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
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		return { proc: proc!, done };
	} finally {
		try {
			fs.unlinkSync(tmp.filePath);
		} catch {
			/* ignore */
		}
		try {
			fs.rmdirSync(tmp.dir);
		} catch {
			/* ignore */
		}
	}
}

/** Synchronous turn: spawn and await completion. */
async function runSubagentTurn(
	rec: SubagentRecord,
	userText: string,
	depth: number,
	signal: AbortSignal | undefined,
	onUpdate?: (text: string) => void,
	onBubble?: (bubble: { text: string; request: boolean }) => void,
): Promise<RunResult> {
	const { done } = await spawnSubagentProcess(rec, userText, depth, signal, onUpdate, onBubble);
	return done;
}

function isFailedRun(run: RunResult): boolean {
	return run.exitCode !== 0 || run.stopReason === "error" || run.stopReason === "aborted";
}

/** Write the turn outcome into the record and persist it. */
function finalizeRecord(rec: SubagentRecord, run: RunResult): { output: string; failed: boolean } {
	const output = getFinalOutput(run.messages) || "(no output)";
	rec.lastOutput = output;
	rec.totalUsage = addUsage(rec.totalUsage, run.usage);
	rec.status = isFailedRun(run) ? "error" : "idle";
	rec.pid = undefined;
	saveRecord(rec);
	return { output, failed: isFailedRun(run) };
}

/** Run one synchronous turn for a record, updating + persisting it. */
async function runAndRecord(
	rec: SubagentRecord,
	userText: string,
	signal: AbortSignal | undefined,
	onUpdate?: (partial: AgentToolResult<SubagentDetails>) => void,
	onBubble?: (bubble: { text: string; request: boolean }) => void,
): Promise<{ ok: boolean; error?: string; output: string; usage: RunUsage; bubbles: Array<{ text: string; request: boolean }> }> {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	rec.status = "running";
	saveRecord(rec);

	const run = await runSubagentTurn(rec, userText, depth, signal, (text) => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text }],
				details: {
					subagentId: rec.id,
					model: rec.model,
					output: text,
					status: "running",
					usage: rec.totalUsage,
				},
			});
		}
	}, onBubble);

	const { output, failed } = finalizeRecord(rec, run);
	if (failed) {
		const reason = run.stopReason ?? `exit code ${run.exitCode}`;
		const detail = run.errorMessage || run.stderr || output;
		return { ok: false, error: `subagent ${reason}: ${detail.slice(0, MAX_ERROR_CHARS)}`, output, usage: run.usage, bubbles: run.bubbles ?? [] };
	}
	return { ok: true, output, usage: run.usage, bubbles: run.bubbles ?? [] };
}

/* ------------------------------------------------------------------ */
/* Background execution + completion notification                      */
/* ------------------------------------------------------------------ */

const running = new Map<string, RunningEntry>();

/** Send the main agent a message when a background subagent finishes. */
function notifyDone(api: ExtensionAPI, ctx: ExtensionContext, rec: SubagentRecord, run: RunResult) {
	const failed = isFailedRun(run);
	const preview = firstLine(rec.lastOutput).slice(0, 200);

	if (failed) {
		// Bubble the error to the main agent with concrete recovery options so it
		// can steer the subagent (subagent_send) or respawn it (subagent_spawn).
		const reason = run.stopReason ?? `exit code ${run.exitCode}`;
		const detail = (run.errorMessage || run.stderr || preview || "(no output)").slice(0, 300);
		const text =
			`[subagent ${rec.id} error] ${reason}: ${detail}\n\n` +
			`The subagent's run failed. Resolve it:\n` +
			`- Steer it to fix the error: subagent_send { subagentId: "${rec.id}", message: "<what to fix>" } — it resumes with its full context\n` +
			`- Respawn a fresh subagent: subagent_spawn { task: "<retry the work>", ... }\n` +
			`- Inspect the full transcript first: subagent_result { subagentId: "${rec.id}" }\n` +
			`- Discard it: subagent_forget { subagentId: "${rec.id}" }`;
		if (ctx.hasUI) {
			ctx.ui.notify(`Subagent ${rec.id} error: ${reason}`, "error");
		}
		api.sendMessage(
			{
				customType: "subagent-error",
				content: text,
				display: true,
				details: { subagentId: rec.id, status: "error", reason, error: detail, output: rec.lastOutput },
			},
			// Realtime: if the agent is idle this starts a turn immediately (triggerTurn);
			// if it is streaming the message is queued into the current turn (followUp).
			{ deliverAs: "followUp", triggerTurn: true },
		);
		return;
	}

	if (ctx.hasUI) {
		ctx.ui.notify(`Subagent ${rec.id} done: ${preview}`, "info");
	}
	api.sendMessage(
		{
			customType: "subagent-notify",
			content: `[subagent ${rec.id} done] ${preview || "(no output)"}`,
			display: true,
			details: { subagentId: rec.id, status: rec.status, output: rec.lastOutput },
		},
		// Realtime: if the agent is idle this starts a turn immediately (triggerTurn);
		// if it is streaming the message is queued into the current turn (followUp).
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

/**
 * Start a background turn. The tool call returns immediately; the process
 * keeps running, and when it finishes the record is finalized and the main
 * agent is notified.
 */
async function startBackground(
	api: ExtensionAPI,
	ctx: ExtensionContext,
	rec: SubagentRecord,
	userText: string,
): Promise<{ started: boolean; error?: string }> {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = getMaxDepth();
	if (depth >= maxDepth) {
		return {
			started: false,
			error: `Maximum subagent depth (${maxDepth}) reached — refusing to nest further. Raise maxDepth in the settings (/subagent config maxDepth N) to allow deeper layers.`,
		};
	}

	rec.status = "running";
	saveRecord(rec);

	let partial = "";
	let proc: ChildProcess;
	let done: Promise<RunResult>;
	try {
		const spawned = await spawnSubagentProcess(
			rec,
			userText,
			depth,
			undefined,
			(text) => {
				partial = text;
			},
			(bubble) => {
				// Bubble up to the main agent: notify immediately + deliver as a
				// message in the next turn so the agent can act on it.
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[subagent ${rec.id} ${bubble.request ? "request" : "message"}] ${firstLine(bubble.text).slice(0, 200)}`,
					bubble.request ? "warning" : "info",
				);
				}
				api.sendMessage(
					{
						customType: "subagent-bubble",
						content: `[subagent ${rec.id} ${bubble.request ? "request" : "message"}] ${bubble.text}`,
						display: true,
						details: { subagentId: rec.id, request: bubble.request },
					},
					// Realtime: idle -> immediate new turn; streaming -> queued into current turn.
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
		);
		proc = spawned.proc;
		done = spawned.done;
	} catch (error) {
		rec.status = "error";
		saveRecord(rec);
		return { started: false, error: `Failed to start subagent process: ${error instanceof Error ? error.message : String(error)}` };
	}

	rec.pid = proc.pid;
	saveRecord(rec);
	running.set(rec.id, { proc, done, getPartial: () => partial });

	done.then((run) => {
		running.delete(rec.id);
		finalizeRecord(rec, run);
		notifyDone(api, ctx, rec, run);
	}).catch((error) => {
		running.delete(rec.id);
		rec.status = "error";
		rec.pid = undefined;
		rec.lastOutput = rec.lastOutput || `background error: ${error instanceof Error ? error.message : String(error)}`;
		saveRecord(rec);
	});

	return { started: true };
}

/**
 * Wait until a subagent is no longer running. Handles lost process handles
 * (extension reloaded) by checking the recorded pid liveness.
 */
async function waitForSubagent(
	id: string,
	deadline: number,
	signal: AbortSignal | undefined,
	onUpdate?: (text: string) => void,
): Promise<{ status: "done" | "timeout" | "aborted"; output: string; note?: string }> {
	while (true) {
		if (signal?.aborted) return { status: "aborted", output: "" };
		if (Date.now() > deadline) return { status: "timeout", output: "" };

		// An errored (or otherwise finished) record ends the wait immediately —
		// never wait indefinitely on a subagent that has already failed.
		const recNow = loadRecord(id);
		if (recNow && recNow.status !== "running") {
			return {
				status: "done",
				output: recNow.lastOutput ?? "",
				note: recNow.status === "error" ? "subagent errored" : undefined,
			};
		}

		const entry = running.get(id);
		const partial = entry ? entry.getPartial() : "";
		if (onUpdate) {
			onUpdate(partial ? `Waiting for ${id}...\n\n${partial}` : `Waiting for ${id}...`);
		}

		if (entry) {
			// The process may have exited before the done-handler finalized the entry.
			// Detect via pid liveness so we don't wait on a dead process.
			if (entry.proc.pid != null) {
				try {
					process.kill(entry.proc.pid, 0);
				} catch {
					const rec = loadRecord(id);
					return { status: "done", output: partial || rec?.lastOutput || "", note: "process finished" };
				}
			}
		} else {
			const rec = loadRecord(id);
			if (rec && rec.status === "running") {
				// handle lost (e.g. extension reloaded mid-run) — check pid
				if (rec.pid) {
					try {
						process.kill(rec.pid, 0);
					} catch {
						rec.status = "idle";
						rec.pid = undefined;
						rec.lastOutput =
							rec.lastOutput || "(subagent process finished while the extension was reloaded — use subagent_result for the transcript)";
						saveRecord(rec);
						return { status: "done", output: rec.lastOutput, note: "process handle was lost (reload)" };
					}
				}
			} else {
				return { status: "done", output: rec?.lastOutput ?? "" };
			}
		}
		await sleep(POLL_INTERVAL_MS);
	}
}

/* ------------------------------------------------------------------ */
/* Tool param schemas                                                  */
/* ------------------------------------------------------------------ */

const SpawnParams = Type.Object({
	task: Type.String({ description: "The task to delegate to the subagent" }),
	await: Type.Optional(
		Type.Boolean({
			description: "true (default): wait for the subagent to finish and return its output. false: run in the background and return immediately — use subagent_wait to wait, and you will be notified when it finishes.",
			default: true,
		}),
	),
	systemPrompt: Type.Optional(Type.String({ description: "Override the subagent system prompt (advanced)" })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override in provider/id form. Defaults to the user-configured model (/subagent model), falling back to the session model.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent (default: current directory)" })),
	tools: Type.Optional(
		Type.String({ description: "Comma-separated tool allowlist, e.g. 'read,grep,bash' (default: all tools)" }),
	),
	scope: Type.Optional(
		Type.Union([
			Type.String({
				description:
					"Restrict the subagent's edit scope: a directory path or a single file path (relative paths resolve against cwd). The subagent can read anything, but write/edit calls targeting files outside this scope are blocked — use this to keep parallel subagents from colliding on the same files.",
			}),
			Type.Array(
				Type.String({
					description: "A list of directory and/or file paths the subagent is allowed to edit. Reads are unrestricted.",
				}),
			),
		]),
	),
});

const WaitParams = Type.Object({
	subagentId: Type.Optional(Type.String({ description: "Wait for this specific subagent (from subagent_spawn)" })),
	all: Type.Optional(
		Type.Boolean({
			description: "Wait for all currently running subagents. Ignored if subagentId is provided.",
			default: false,
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({ description: "Maximum time to wait in milliseconds. 0 = wait indefinitely (default 0).", minimum: 0 }),
	),
});

const SendParams = Type.Object({
	subagentId: Type.String({ description: "ID returned by subagent_spawn" }),
	message: Type.String({ description: "Follow-up message / steering instruction for the subagent" }),
});

const ListParams = Type.Object({});

const ResultParams = Type.Object({
	subagentId: Type.String({ description: "ID returned by subagent_spawn" }),
});

const ForgetParams = Type.Object({
	subagentId: Type.String({ description: "ID returned by subagent_spawn" }),
});

const ConfigParams = Type.Object({});

/* ------------------------------------------------------------------ */
/* Extension factory                                                   */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
	/* ---------------- kill background subagents on shutdown ---------------- */
	pi.on("session_shutdown", () => {
		for (const { proc } of running.values()) {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
		}
		running.clear();
	});

	/* ---------------- edit-scope enforcement (subagent processes) ---------------- */
	// The parent passes the scope via PI_SUBAGENT_SCOPE (JSON array of absolute
	// paths). Writes outside it are blocked; reads are unrestricted.
	const scopeEnv = process.env.PI_SUBAGENT_SCOPE;
	if (scopeEnv) {
		let scope: string[] = [];
		try {
			scope = JSON.parse(scopeEnv);
		} catch {
			/* ignore malformed */
		}
		if (Array.isArray(scope) && scope.length > 0) {
			pi.on("tool_call", (event, _ctx) => {
				if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
				const target = (event.input as { path?: string }).path;
				if (!target) return undefined;
				const targetAbs = path.resolve(target);
				if (isWithinScope(targetAbs, scope)) return undefined;
				return {
					block: true,
					reason:
						`Writing to "${targetAbs}" is outside this subagent's edit scope. ` +
						`Allowed scope: ${scope.join(", ")}. Reads are unrestricted; use write/edit only within scope.`,
				};
			});
		}
	}

	/* ---------------- subagent processes: bubble-up tools ---------------- */
	// Subagents additionally get bubble-up tools; the full subagent toolset
	// below is registered for every process (nesting is bounded by maxDepth).
	if (isSubagentProcess) {
		const bubble = (message: string, request: boolean) => {
			process.stdout.write(
				JSON.stringify({ type: "subagent_bubble", content: message, request }) + "\n",
			);
		};
		pi.registerTool({
			name: "subagent_message",
			label: "Subagent Message",
			description:
				"Send an informational message back to the main agent. The main agent sees it (and can act on it) in its next turn. Use for progress updates, findings, or anything the main agent should know.",
			promptSnippet: "Send a message back to the main agent",
			parameters: Type.Object({
				message: Type.String({ description: "The message to bubble up to the main agent" }),
			}),
			async execute(_toolCallId, params) {
				bubble(params.message, false);
				return {
					content: [
						{
							type: "text",
							text: "Message sent to the main agent. Continue working; it will act on your message in its next turn.",
						},
					],
					details: {},
				};
			},
		});
		pi.registerTool({
			name: "subagent_request",
			label: "Subagent Request",
			description:
				"Ask the main agent for something you cannot do yourself: a decision, approval, missing information, or an action outside your scope. The main agent receives this as a request in its next turn. Use sparingly — prefer completing work autonomously.",
			promptSnippet: "Request something from the main agent",
			parameters: Type.Object({
				message: Type.String({ description: "What you need from the main agent" }),
			}),
			async execute(_toolCallId, params) {
				bubble(params.message, true);
				return {
					content: [
						{
							type: "text",
							text: "Request sent to the main agent. It will see it in its next turn; keep working on what you can in the meantime.",
						},
					],
					details: {},
				};
			},
		});
	}

	/* ---------------- subagent_spawn ---------------- */
	pi.registerTool({
		name: "subagent_spawn",
		label: "Subagent Spawn",
		description:
			"Spawn a subagent to work for you. It runs in an isolated context (its own session), using the user-configured model by default (falling back to the session model). With await: true (default) it blocks until the subagent finishes and returns its output. With await: false it spawns in the background and returns immediately — you will be notified when it finishes, and you can wait for it with subagent_wait, steer it with subagent_send, or read its transcript with subagent_result. Spawning respects the configured limits: maxDepth nesting layers and maxSubagents concurrent subagents (see subagent_config).",
		promptSnippet: "Spawn an isolated subagent to delegate work to",
		promptGuidelines: [
			"Use subagent_spawn to delegate long or independent work to an isolated subagent; use await: false for background work, then subagent_wait.",
			"Use subagent_send to steer a subagent — it continues with its full previous context.",
			"If a subagent errors, steer it to fix the error with subagent_send or respawn it with subagent_spawn — don't just give up.",
			"Check subagent_config to see how many subagents are currently running and the limits (maxSubagents concurrent, maxDepth nesting layers). Spawn only as many as you actually need.",
		],
		parameters: SpawnParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = params.task?.trim();
			if (!task) {
				return {
					content: [{ type: "text", text: "Error: task is required." }],
					details: { subagentId: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}

			const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
			const maxDepth = getMaxDepth();
			if (depth >= maxDepth) {
				return {
					content: [
						{
							type: "text",
							text: `Maximum subagent depth (${maxDepth}) reached — refusing to nest further. Raise maxDepth in the settings (/subagent config maxDepth N) to allow deeper layers.`,
						},
					],
					details: { subagentId: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}

			const maxSubagents = getMaxSubagents();
			const runningNow = countRunningSubagents();
			if (runningNow >= maxSubagents) {
				return {
					content: [
						{
							type: "text",
							text:
								`Maximum concurrent subagents reached (${runningNow}/${maxSubagents} running). Wait for some to finish (subagent_wait) or forget them (subagent_forget) before spawning more. Raise maxSubagents in the settings (/subagent config maxSubagents N) if you need more.`,
						},
					],
					details: { subagentId: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}

			const opts = resolveSpawnOptions(ctx, {
				model: params.model,
				systemPrompt: params.systemPrompt,
				cwd: params.cwd,
				tools: params.tools,
			});
			const scope = normalizeScope(opts.cwd, params.scope);

			const record: SubagentRecord = {
				id: newSubagentId(),
				model: opts.model,
				systemPrompt: opts.systemPrompt,
				cwd: opts.cwd,
				tools: opts.tools,
				scope,
				status: "running",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				lastOutput: "",
				totalUsage: EMPTY_USAGE(),
			};
			saveRecord(record);

			if (params.await === false) {
				const bg = await startBackground(pi, ctx, record, task);
				if (!bg.started) {
					record.status = "error";
					saveRecord(record);
					return {
						content: [{ type: "text", text: bg.error ?? "Failed to start subagent." }],
						details: {
							subagentId: record.id,
							model: record.model,
							output: "",
							status: "error",
							usage: EMPTY_USAGE(),
						} as SubagentDetails,
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text:
								`Spawned subagent ${record.id} in the background (model: ${record.model ?? "session model"}).\n` +
								(scope ? `Edit scope: ${scope.join(", ")} — writes outside are blocked.\n` : "") +
								`Wait for it with subagent_wait (subagentId "${record.id}"), read its transcript with subagent_result, steer it with subagent_send once it finishes. You will be notified when it is done.`,
						},
					],
					details: {
						subagentId: record.id,
						model: record.model,
						output: "",
						status: "running",
						usage: EMPTY_USAGE(),
					} as SubagentDetails,
				};
			}

			const result = await runAndRecord(record, task, signal, onUpdate, (bubble) => {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[subagent ${record.id} ${bubble.request ? "request" : "message"}] ${firstLine(bubble.text).slice(0, 200)}`,
						bubble.request ? "warning" : "info",
					);
				}
			});
			if (!result.ok) {
				return {
					content: [{ type: "text", text: result.error ?? "Subagent failed." }],
					details: {
						subagentId: record.id,
						model: record.model,
						output: result.output,
						status: "error",
						usage: result.usage ?? EMPTY_USAGE(),
					} as SubagentDetails,
					isError: true,
				};
			}

			const bubbleText =
				result.bubbles.length > 0
					? "\n\n[subagent bubbles — messages the subagent sent you during the run]\n" +
						result.bubbles.map((b) => `- ${b.request ? "[request] " : ""}${b.text}`).join("\n")
					: "";
			const note =
				`\n\n[subagent ${record.id} — model ${record.model ?? "session model"}]\n` +
				(scope ? `Edit scope: ${scope.join(", ")} (writes outside are blocked).\n` : "") +
				`Steer it with subagent_send, read its transcript with subagent_result, forget it with subagent_forget.`;
			return {
				content: [{ type: "text", text: `${result.output}${bubbleText}${note}` }],
				details: {
					subagentId: record.id,
					model: record.model,
					output: result.output,
					status: "idle",
					usage: result.usage ?? EMPTY_USAGE(),
				} as SubagentDetails,
			};
		},
	});

	/* ---------------- subagent_wait ---------------- */
	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description:
			"Wait until a spawned subagent (subagentId) or all currently running subagents (all: true) finish. Streams progress updates while waiting and returns the final output(s). Use after spawning with await: false. If the subagent already finished, returns its last output immediately.",
		promptSnippet: "Wait for a background subagent (or all subagents) to finish",
		promptGuidelines: [
			"Use subagent_wait after subagent_spawn with await: false to block until the subagent finishes; you will get its output.",
		],
		parameters: WaitParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const subagentId = params.subagentId;
			const all = params.all ?? false;

			if (!subagentId && !all) {
				return {
					content: [{ type: "text", text: "Error: provide subagentId or set all: true." }],
					details: { subagentId: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}

			const deadline = params.timeoutMs ? Date.now() + params.timeoutMs : Infinity;

			if (subagentId) {
				const rec = loadRecord(subagentId);
				if (!rec) {
					return {
						content: [{ type: "text", text: `Unknown subagent "${subagentId}". Spawn one with subagent_spawn.` }],
						details: { subagentId, output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
						isError: true,
					};
				}
				if (rec.status !== "running") {
					return {
						content: [
							{
								type: "text",
								text:
									`Subagent ${subagentId} is not running (status: ${rec.status}).\n\n` +
									`Last output:\n${rec.lastOutput}`,
							},
						],
						details: {
							subagentId,
							model: rec.model,
							output: rec.lastOutput,
							status: rec.status,
							usage: rec.totalUsage,
						} as SubagentDetails,
					};
				}

				const waited = await waitForSubagent(subagentId, deadline, signal, (text) => {
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text }],
							details: { subagentId, output: text, status: "running", usage: rec.totalUsage } as SubagentDetails,
						});
					}
				});

				const finalRec = loadRecord(subagentId);
				if (waited.status === "aborted") {
					return {
						content: [{ type: "text", text: `Wait for ${subagentId} aborted.` }],
						details: { subagentId, output: "", status: "running", usage: rec.totalUsage } as SubagentDetails,
						isError: true,
					};
				}
				if (waited.status === "timeout") {
					return {
						content: [
							{
								type: "text",
								text: `Timed out waiting for ${subagentId} — it is still running. Check subagent_list or wait longer.`,
							},
						],
						details: {
							subagentId,
							model: rec.model,
							output: finalRec?.lastOutput ?? "",
							status: "running",
							usage: rec.totalUsage,
						} as SubagentDetails,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `[subagent ${subagentId} done${waited.note ? ` (${waited.note})` : ""}]\n\n${finalRec?.lastOutput ?? waited.output}`,
						},
					],
					details: {
						subagentId,
						model: finalRec?.model ?? rec.model,
						output: finalRec?.lastOutput ?? waited.output,
						status: finalRec?.status ?? "idle",
						usage: finalRec?.totalUsage ?? rec.totalUsage,
					} as SubagentDetails,
				};
			}

			// all: wait for every currently running subagent
			const targets = [...running.keys()];
			if (targets.length === 0) {
				return {
					content: [{ type: "text", text: "No subagents currently running — nothing to wait for." }],
					details: { subagentId: "", output: "", status: "idle", usage: EMPTY_USAGE() } as SubagentDetails,
				};
			}

			// Live done-count: a target is done when its record is no longer running
			// (finished OR errored), its running entry is gone, or its process is
			// already dead (finalization pending).
			const isDone = (tid: string): boolean => {
				const rec = loadRecord(tid);
				if (rec && rec.status !== "running") return true;
				const entry = running.get(tid);
				if (!entry) return true;
				if (entry.proc.pid != null) {
					try {
						process.kill(entry.proc.pid, 0);
						return false;
					} catch {
						return true;
					}
				}
				return false;
			};

			const results: Array<{ subagentId: string; status: string; output: string }> = [];
			for (const id of targets) {
				const waited = await waitForSubagent(id, deadline, signal, (text) => {
					if (onUpdate) {
						const done = targets.filter(isDone).length;
						onUpdate({
							content: [{ type: "text", text: `Waiting for subagents: ${done}/${targets.length} done\n\n${id}: ${text}` }],
							details: { subagentId: id, output: text, status: "running", usage: EMPTY_USAGE() } as SubagentDetails,
						});
					}
				});
				if (waited.status === "aborted") {
					return {
						content: [{ type: "text", text: `Wait aborted (${results.length}/${targets.length} done).` }],
						details: { subagentId: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
						isError: true,
					};
				}
				const finalRec = loadRecord(id);
				results.push({
					subagentId: id,
					status:
						waited.status === "timeout"
							? "running"
							: finalRec?.status && finalRec.status !== "running"
								? finalRec.status
								: "idle",
					output: finalRec?.lastOutput ?? waited.output,
				});
				if (waited.status === "timeout") {
					return {
						content: [
							{
								type: "text",
								text: `Timed out waiting for subagents — still running: ${results
									.filter((r) => r.status === "running")
									.map((r) => r.subagentId)
									.join(", ")}`,
							},
						],
						details: {
							subagentId: "",
							output: "",
							status: "running",
							usage: EMPTY_USAGE(),
							results,
						} as unknown as SubagentDetails,
					};
				}
			}

			const body = results.map((r) => `### ${r.subagentId} [${r.status}]\n\n${r.output}`).join("\n\n---\n\n");
			return {
				content: [{ type: "text", text: `All ${results.length} subagent(s) done.\n\n${body}` }],
				details: {
					subagentId: "",
					output: "",
					status: "idle",
					usage: EMPTY_USAGE(),
					results,
				} as unknown as SubagentDetails,
			};
		},
	});

	/* ---------------- subagent_send ---------------- */
	pi.registerTool({
		name: "subagent_send",
		label: "Subagent Send",
		description:
			"Push a follow-up message to a spawned subagent (subagentId from subagent_spawn). The subagent continues its private session, so it keeps full context of its previous work. Use this to steer, redirect, ask for more detail, or assign follow-up work. Only works when the subagent is not currently running — wait for it first with subagent_wait.",
		promptSnippet: "Send a steering message to a subagent",
		promptGuidelines: [
			"When a subagent errors (you receive a subagent-error message or a failed result), resolve it by steering it with subagent_send (it resumes with full context) or respawning with subagent_spawn; use subagent_result to inspect the transcript first.",
		],
		parameters: SendParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const message = params.message?.trim();
			if (!message) {
				return {
					content: [{ type: "text", text: "Error: message is required." }],
					details: { subagentId: params.subagentId, output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}

			const record = loadRecord(params.subagentId);
			if (!record) {
				return {
					content: [{ type: "text", text: `Unknown subagent "${params.subagentId}". Spawn one first with subagent_spawn.` }],
					details: { subagentId: params.subagentId, output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}
			if (record.status === "running") {
				return {
					content: [
						{
							type: "text",
							text: `Subagent ${params.subagentId} is currently running. Wait for it with subagent_wait, then send the steering message.`,
						},
					],
					details: { subagentId: params.subagentId, output: "", status: "running", usage: record.totalUsage } as SubagentDetails,
				};
			}

			const result = await runAndRecord(record, message, signal, onUpdate, (bubble) => {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[subagent ${record.id} ${bubble.request ? "request" : "message"}] ${firstLine(bubble.text).slice(0, 200)}`,
						bubble.request ? "warning" : "info",
					);
				}
			});
			if (!result.ok) {
				return {
					content: [{ type: "text", text: result.error ?? "Failed to reach subagent." }],
					details: {
						subagentId: params.subagentId,
						model: record.model,
						output: result.output,
						status: "error",
						usage: result.usage ?? EMPTY_USAGE(),
					} as SubagentDetails,
					isError: true,
				};
			}
			const bubbleText =
				result.bubbles.length > 0
					? "\n\n[subagent bubbles — messages the subagent sent you during the run]\n" +
						result.bubbles.map((b) => `- ${b.request ? "[request] " : ""}${b.text}`).join("\n")
					: "";
			return {
				content: [{ type: "text", text: `[subagent ${params.subagentId}] ${result.output}${bubbleText}` }],
				details: {
					subagentId: params.subagentId,
					model: record.model,
					output: result.output,
					status: "idle",
					usage: result.usage ?? EMPTY_USAGE(),
				} as SubagentDetails,
			};
		},
	});

	/* ---------------- subagent_list ---------------- */
	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description:
			"List spawned subagents: id, status (running/idle/error), model, turn count, usage, and a preview of their latest output. Also shows how many are running vs the maxSubagents limit.",
		promptSnippet: "List spawned subagents and their status",
		parameters: ListParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const records: SubagentRecord[] = [];
			try {
				for (const file of fs.readdirSync(subagentDir())) {
					if (!file.endsWith(".json")) continue;
					const rec = loadRecord(file.slice(0, -5));
					if (rec) records.push(rec);
				}
			} catch {
				/* dir missing */
			}
			records.sort((a, b) => b.createdAt - a.createdAt);

			const out: string[] = [];
			const runningNow = records.filter((r) => r.status === "running").length;
			const maxSubagents = getMaxSubagents();
			out.push(`Running: ${runningNow}/${maxSubagents} subagents · total spawned: ${records.length} · maxDepth: ${getMaxDepth()} layers`);
			if (records.length === 0) {
				out.push("No subagents spawned yet. Use subagent_spawn to delegate work.");
			} else {
				out.push(`${records.length} subagent(s):`);
				for (const rec of records) {
					const usage = formatUsage(rec.totalUsage, rec.model);
					out.push(
						`- ${rec.id} [${rec.status}] · model: ${rec.model ?? "session"} · created: ${new Date(rec.createdAt).toLocaleString()}` +
							`\n  last output: ${firstLine(rec.lastOutput).slice(0, 120) || "(none)"}` +
							(usage ? `\n  usage: ${usage}` : ""),
					);
				}
			}

			return {
				content: [{ type: "text", text: out.join("\n") }],
				details: {
					subagents: records.map((rec) => ({
						subagentId: rec.id,
						status: rec.status,
						model: rec.model,
						createdAt: rec.createdAt,
						lastOutput: firstLine(rec.lastOutput),
						usage: rec.totalUsage,
					})),
				},
			};
		},
	});

	/* ---------------- subagent_result ---------------- */
	pi.registerTool({
		name: "subagent_result",
		label: "Subagent Result",
		description:
			"Read the full transcript of a spawned subagent (subagentId from subagent_spawn), including its task, all steering messages, tool activity, and outputs.",
		promptSnippet: "Read a subagent's full transcript",
		parameters: ResultParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const record = loadRecord(params.subagentId);
			if (!record) {
				return {
					content: [{ type: "text", text: `Unknown subagent "${params.subagentId}". Spawn one with subagent_spawn.` }],
					details: { subagentId: params.subagentId, output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}

			const transcript = readTranscript(params.subagentId) || record.lastOutput || "(no transcript available)";
			const usage = formatUsage(record.totalUsage, record.model);
			const text = `${transcript}${usage ? `\n\n[usage: ${usage}]` : ""}`;
			return {
				content: [{ type: "text", text }],
				details: {
					subagentId: record.id,
					model: record.model,
					output: record.lastOutput,
					status: record.status,
					usage: record.totalUsage,
				} as SubagentDetails,
			};
		},
	});

	/* ---------------- subagent_forget ---------------- */
	pi.registerTool({
		name: "subagent_forget",
		label: "Subagent Forget",
		description:
			"Delete a spawned subagent and its private session (subagentId from subagent_spawn). Kills it first if it is still running. Its work is gone; you can spawn a fresh one if needed.",
		promptSnippet: "Delete a spawned subagent",
		parameters: ForgetParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const record = loadRecord(params.subagentId);
			if (!record) {
				return {
					content: [{ type: "text", text: `Unknown subagent "${params.subagentId}".` }],
					details: { subagentId: params.subagentId, output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}
			const entry = running.get(params.subagentId);
			if (entry) {
				try {
					entry.proc.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				running.delete(params.subagentId);
			}
			let removed = 0;
			for (const file of [recordFile(params.subagentId), sessionFile(params.subagentId)]) {
				try {
					fs.unlinkSync(file);
					removed++;
				} catch {
					/* ignore */
				}
			}
			return {
				content: [{ type: "text", text: `Forgot subagent ${params.subagentId} (removed ${removed} file(s)).` }],
				details: {
					subagentId: params.subagentId,
					output: "",
					status: "idle",
					usage: EMPTY_USAGE(),
				} as SubagentDetails,
			};
		},
	});

	/* ---------------- subagent_config ---------------- */
	pi.registerTool({
		name: "subagent_config",
		label: "Subagent Config",
		description:
			"Show the effective subagent configuration: the user-configured model/system prompt/cwd/tools/limits (from ~/.pi/agent/subagent-config.json), the current session model fallback, and how many subagents are running right now vs the limit.",
		promptSnippet: "Show subagent configuration and current usage",
		parameters: ConfigParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const cfg = loadConfig();
			const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const runningNow = countRunningSubagents();
			const maxSubagents = getMaxSubagents();
			const maxDepth = getMaxDepth();
			const out: string[] = [];
			out.push(`Config file: ${configFile()}`);
			out.push(`User-configured model: ${cfg.model ?? "(not set — inherits session model)"}`);
			out.push(`Current session model: ${sessionModel ?? "(none)"}`);
			out.push(`Effective model for new subagents: ${cfg.model ?? sessionModel ?? "(none)"}`);
			out.push(`Custom system prompt: ${cfg.systemPrompt ? `set (${cfg.systemPrompt.length} chars)` : "(default)"}`);
			out.push(`Working directory: ${cfg.cwd ?? "(current directory)"}`);
			out.push(`Tool allowlist: ${cfg.tools ?? "(all tools)"}`);
			out.push(`Subagents running: ${runningNow}/${maxSubagents} (maxSubagents)`);
			out.push(`Nesting layers allowed: ${maxDepth} (maxDepth — 1 = no sub-subagents)`);
			out.push("Set the model with `/subagent model <provider/id>`; set limits with `/subagent config maxDepth N` / `/subagent config maxSubagents N`.");
			return {
				content: [{ type: "text", text: out.join("\n") }],
				details: {
					config: cfg,
					sessionModel,
					effectiveModel: cfg.model ?? sessionModel,
					runningSubagents: runningNow,
					maxSubagents,
					maxDepth,
				},
			};
		},
	});

	/* ---------------- /subagent command (for humans) ---------------- */
	pi.registerCommand("subagent", {
		description:
			"Spawn or manage subagents: /subagent <task> | list | result <id> | send <id> <msg> | forget <id> | model [provider/id] | config",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const first = parts[0];

			if (first === "model") {
				const cfg = loadConfig();
				const modelArg = parts[1];

				const setModel = (label: string) => {
					cfg.model = label;
					saveConfig(cfg);
					ctx.ui.notify(`Subagent model set to ${label}.`, "info");
				};

				if (modelArg) {
					// exact provider/id match → set directly; otherwise open the picker pre-filtered
					const exact = findExactModel(ctx, modelArg);
					if (exact) {
						setModel(exact);
						return;
					}
					const picked = await showModelPicker(ctx, modelArg, cfg.model ?? sessionModelLabel(ctx));
					if (picked) setModel(picked);
					else ctx.ui.notify("Model selection cancelled.", "info");
					return;
				}

				// no arg → open the model picker panel (like /model)
				const picked = await showModelPicker(ctx, "", cfg.model ?? sessionModelLabel(ctx));
				if (picked) setModel(picked);
				else ctx.ui.notify("Model selection cancelled.", "info");
				return;
			}
			if (first === "config") {
				const cfg = loadConfig();
				const key = parts[1];
				if (key === "maxDepth" || key === "maxSubagents") {
					const val = Number(parts[2]);
					if (!Number.isFinite(val) || val < 1) {
						ctx.ui.notify(`Usage: /subagent config ${key} <positive integer>`, "info");
						return;
					}
					cfg[key] = Math.floor(val);
					saveConfig(cfg);
					ctx.ui.notify(`${key} set to ${cfg[key]}.`, "info");
					return;
				}
				if (key) {
					ctx.ui.notify("Usage: /subagent config [maxDepth <n> | maxSubagents <n>] — no args opens the settings panel.", "info");
					return;
				}
				await showSubagentConfigUi(ctx);
				return;
			}
			if (first === "list") {
				const records: SubagentRecord[] = [];
				try {
					for (const file of fs.readdirSync(subagentDir())) {
						if (!file.endsWith(".json")) continue;
						const rec = loadRecord(file.slice(0, -5));
						if (rec) records.push(rec);
					}
				} catch {
					/* dir missing */
				}
				records.sort((a, b) => b.createdAt - a.createdAt);
				const lines = records.map(
					(rec) => `${rec.id} [${rec.status}] · ${rec.model ?? "session"} · ${firstLine(rec.lastOutput).slice(0, 80) || "(no output)"}`,
				);
				ctx.ui.notify(lines.length ? lines.join("\n") : "No subagents spawned yet.", "info");
				return;
			}
			if (first === "result" || first === "send" || first === "forget") {
				const id = parts[1];
				if (!id) {
					ctx.ui.notify(`Usage: /subagent ${first} <subagentId>${first === "send" ? " <message>" : ""}`, "info");
					return;
				}
				if (first === "result") {
					const rec = loadRecord(id);
					if (!rec) {
						ctx.ui.notify(`Unknown subagent "${id}".`, "error");
						return;
					}
					const transcript = readTranscript(id) || rec.lastOutput || "(no transcript available)";
					ctx.ui.notify(transcript.slice(0, 600), "info");
					return;
				}
				if (first === "forget") {
					const rec = loadRecord(id);
					if (!rec) {
						ctx.ui.notify(`Unknown subagent "${id}".`, "error");
						return;
					}
					const entry = running.get(id);
					if (entry) {
						try {
							entry.proc.kill("SIGTERM");
						} catch {
							/* ignore */
						}
						running.delete(id);
					}
					for (const file of [recordFile(id), sessionFile(id)]) {
						try {
							fs.unlinkSync(file);
						} catch {
							/* ignore */
						}
					}
					ctx.ui.notify(`Forgot subagent ${id}.`, "info");
					return;
				}
				const message = parts.slice(2).join(" ");
				if (!message) {
					ctx.ui.notify(`Usage: /subagent send ${id} <message>`, "info");
					return;
				}
				const rec = loadRecord(id);
				if (!rec) {
					ctx.ui.notify(`Unknown subagent "${id}".`, "error");
					return;
				}
				if (rec.status === "running") {
					ctx.ui.notify(`Subagent ${id} is still running — use /subagent wait? (subagent_wait tool) or wait for it.`, "warning");
					return;
				}
				if (ctx.hasUI) ctx.ui.setStatus("subagent", `sending to ${id}...`);
				const result = await runAndRecord(rec, message, ctx.signal);
				if (ctx.hasUI) ctx.ui.setStatus("subagent", "");
				if (!result.ok) {
					ctx.ui.notify(result.error ?? "Failed", "error");
					return;
				}
				ctx.ui.notify(`[subagent ${id}] ${(result.output ?? "").slice(0, 600)}`, "info");
				return;
			}

			// default: spawn with the given task
			if (!first) {
				ctx.ui.notify(
					"Usage: /subagent <task> | list | result <id> | send <id> <msg> | forget <id> | model [provider/id] | config",
					"info",
				);
				return;
			}
			const task = parts.join(" ");
			const opts = resolveSpawnOptions(ctx, {});
			const record: SubagentRecord = {
				id: newSubagentId(),
				model: opts.model,
				systemPrompt: opts.systemPrompt,
				cwd: opts.cwd,
				tools: opts.tools,
				status: "running",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				lastOutput: "",
				totalUsage: EMPTY_USAGE(),
			};
			saveRecord(record);
			if (ctx.hasUI) ctx.ui.setStatus("subagent", "spawning subagent...");
			const result = await runAndRecord(record, task, ctx.signal);
			if (ctx.hasUI) ctx.ui.setStatus("subagent", "");
			if (!result.ok) {
				ctx.ui.notify(result.error ?? "Subagent failed", "error");
				return;
			}
			ctx.ui.notify(`[subagent ${record.id}] ${(result.output ?? "").slice(0, 600)}`, "info");
		},
	});
}

/* ------------------------------------------------------------------ */
/* Interactive model picker (like /model)                              */
/* ------------------------------------------------------------------ */

interface PickerModel {
	provider: string;
	id: string;
	label: string; // provider/id
	name: string;
}

/** All selectable models: session-scoped models if any, else the full catalog. */
function collectModels(ctx: ExtensionCommandContext): PickerModel[] {
	const map = new Map<string, PickerModel>();
	const add = (provider: string, id: string, name: string) => {
		const label = `${provider}/${id}`;
		if (!map.has(label)) map.set(label, { provider, id, label, name });
	};
	try {
		const scoped = ctx.scopedModels;
		if (scoped && scoped.length > 0) {
			for (const s of scoped) add(s.model.provider, s.model.id, s.model.name);
		} else {
			for (const m of ctx.modelRegistry.getAvailable()) add(m.provider, m.id, m.name);
		}
	} catch {
		/* registry unavailable */
	}
	return [...map.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

/** Exact provider/id match, or undefined. */
function findExactModel(ctx: ExtensionCommandContext, arg: string): string | undefined {
	const q = arg.trim().toLowerCase();
	return collectModels(ctx).find((m) => m.label.toLowerCase() === q)?.label;
}

/** The user's currently selected session model, as provider/id. */
function sessionModelLabel(ctx: ExtensionCommandContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

/** Open the picker; resolves with the chosen model label or undefined (cancelled). */
async function showModelPicker(
	ctx: ExtensionCommandContext,
	initialFilter: string,
	currentLabel?: string,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Model picker requires interactive mode. Use: /subagent model <provider/id>", "info");
		return undefined;
	}
	const models = collectModels(ctx);
	if (models.length === 0) {
		ctx.ui.notify("No models available.", "warning");
		return undefined;
	}
	return await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
		return new SubagentModelPicker(models, initialFilter, currentLabel, theme, (model) => done(model));
	});
}

const PICKER_ROW_CAP = 40;

/* Interactive settings panel for /subagent config (mirrors pi's settings UI) */
/* ------------------------------------------------------------------ */

async function showSubagentConfigUi(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		// non-TUI fallback: notify the config summary
		const cfg = loadConfig();
		const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
		ctx.ui.notify(
			`model: ${cfg.model ?? "(inherit)"} (session: ${sessionModel})\n` +
				`maxDepth (layers): ${getMaxDepth()} · maxSubagents: ${getMaxSubagents()} (running ${countRunningSubagents()})\n` +
				`cwd: ${cfg.cwd ?? "(inherit)"}\ntools: ${cfg.tools ?? "(all)"}\n` +
				`file: ${configFile()}`,
			"info",
		);
		return;
	}

	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		// Edits accumulate in a draft; Ctrl+S persists it (explicit save).
		const draft: SubagentConfig = { ...loadConfig() };
		let dirty = false;
		let savedAt = 0;
		const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
		const effectiveModel = draft.model ?? sessionModel ?? "(none)";
		const rowValue = (id: string) =>
			id === "maxDepth" ? String(draft.maxDepth ?? getMaxDepth()) : String(draft.maxSubagents ?? getMaxSubagents());

		// items order is fixed (search disabled) — we mirror the selection to
		// intercept digit input on the numeric rows for direct value entry.
		const items: Array<{ id: string; label: string; description?: string; currentValue: string; submenu?: (cur: string, done: (v?: string) => void) => Component }> = [
			{
				id: "model",
				label: "Model",
				description: "Model used by new subagents. Enter to pick (inherits the session model when unset).",
				currentValue: effectiveModel,
			},
			{
				id: "maxDepth",
				label: "Nesting layers",
				description: "How many subagent generations deep nesting may go (1 = no sub-subagents). Type a number directly to set it.",
				currentValue: String(getMaxDepth()),
			},
			{
				id: "maxSubagents",
				label: "Concurrent subagents",
				description: "Maximum subagents running at once, across all layers. Type a number directly to set it.",
				currentValue: String(getMaxSubagents()),
			},
			{
				id: "cwd",
				label: "Working directory",
				description: "Where new subagents run. Edit subagent-config.json or use the CLI form.",
				currentValue: draft.cwd ?? "(inherit — session cwd)",
			},
		];
		items[0].submenu = (_cur, selectDone) =>
			new SubagentModelPicker(collectModels(ctx), "", draft.model ?? sessionModel, theme, (label) => {
				if (label) {
					draft.model = label;
					dirty = true;
					settingsList.updateValue("model", label);
				}
				updateFooter();
				container.invalidate();
				selectDone(label);
			}) as unknown as Component;

		const numericIds = new Set(["maxDepth", "maxSubagents"]);
		let sel = 0; // mirrored selection (items order is fixed)
		let buffer = ""; // in-progress digit entry for the numeric row

		const refreshRow = (id: string) => settingsList.updateValue(id, rowValue(id));

		const commitNumber = () => {
			const id = items[sel].id;
			const n = Number(buffer);
			if (numericIds.has(id) && Number.isInteger(n) && n >= 1) {
				if (id === "maxDepth") draft.maxDepth = n;
				else draft.maxSubagents = n;
				dirty = true;
			}
			buffer = "";
			refreshRow(id);
			updateFooter();
			container.invalidate();
		};

		const settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(_id, _newValue) => {
				/* numeric edits are committed by commitNumber */
			},
			() => done(undefined),
			{ enableSearch: false },
		);

		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const footer = new Text(theme.fg("dim", ""), 1, 0);
		const updateFooter = () => {
			if (dirty) footer.setText(theme.fg("warning", "● unsaved changes · Ctrl+S save · Esc close"));
			else if (Date.now() - savedAt < 2000) footer.setText(theme.fg("success", "✓ saved · Ctrl+S save · Esc close"));
			else footer.setText(theme.fg("dim", "↑/↓ navigate · type number to set · Ctrl+S save · Esc close"));
		};
		updateFooter();
		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold("Subagent settings")), 1, 0));
		container.addChild(settingsList);
		container.addChild(footer);
		container.addChild(border);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				// Ctrl+S: persist the draft (explicit save)
				if (matchesKey(data, "ctrl+s")) {
					saveConfig(draft);
					dirty = false;
					savedAt = Date.now();
					updateFooter();
					container.invalidate();
					return;
				}
				// mirror SettingsList's selection navigation (wraps around)
				if (matchesKey(data, "up")) sel = sel === 0 ? items.length - 1 : sel - 1;
				else if (matchesKey(data, "down")) sel = sel === items.length - 1 ? 0 : sel + 1;

				const row = items[sel];
				if (row && numericIds.has(row.id)) {
					// direct integer entry on numeric rows
					if (data.length === 1 && data >= "0" && data <= "9") {
						buffer = (buffer + data).slice(0, 3);
						settingsList.updateValue(row.id, buffer);
						container.invalidate();
						return;
					}
					if (data === "\x7f" || data === "\b") {
						buffer = buffer.slice(0, -1);
						settingsList.updateValue(row.id, buffer || rowValue(row.id));
						container.invalidate();
						return;
					}
					if (matchesKey(data, "enter")) {
						if (buffer) commitNumber();
						return;
					}
					if (matchesKey(data, "escape")) {
						if (buffer) {
							buffer = "";
							refreshRow(row.id);
							container.invalidate();
							return;
						}
					}
				}
				const before = dirty;
				settingsList.handleInput(data);
				if (before !== dirty) {
					updateFooter();
					container.invalidate();
				}
			},
		};
	});
}

class SubagentModelPicker {
	private models: PickerModel[];
	private filterText: string;
	private currentLabel?: string;
	private selected = 0;
	private theme: Theme;
	private onClose: (model?: string) => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		models: PickerModel[],
		initialFilter: string,
		currentLabel: string | undefined,
		theme: Theme,
		onClose: (model?: string) => void,
	) {
		this.models = models;
		this.filterText = initialFilter;
		this.currentLabel = currentLabel;
		this.theme = theme;
		this.onClose = onClose;
	}

	private filtered(): PickerModel[] {
		const q = this.filterText.trim().toLowerCase();
		if (!q) return this.models;
		return this.models.filter(
			(m) => m.label.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q),
		);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose(undefined);
			return;
		}
		if (matchesKey(data, "enter")) {
			const f = this.filtered();
			if (f.length === 0) return;
			this.onClose(f[Math.min(this.selected, f.length - 1)].label);
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(Math.max(0, this.filtered().length - 1), this.selected + 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, "home")) {
			this.selected = 0;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "end")) {
			this.selected = Math.max(0, this.filtered().length - 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.filterText = this.filterText.slice(0, -1);
			this.selected = 0;
			this.invalidate();
			return;
		}
		const ch = decodeKittyPrintable(data) ?? (data.length === 1 ? data : undefined);
		if (ch && ch.length === 1 && ch >= " ") {
			this.filterText = (this.filterText + ch).slice(0, 40);
			this.selected = 0;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [];

		const title = th.fg("accent", " Subagent model ");
		const header =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(2, width - 3 - title.length - 2)));
		lines.push(truncateToWidth(header, width));
		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("muted", "Filter:")} ${this.filterText}${th.fg("accent", "▏")}`, width));
		lines.push("");

		const filtered = this.filtered();
		const sel = Math.min(this.selected, Math.max(0, filtered.length - 1));
		let lastProvider = "";
		let shown = 0;

		for (let i = 0; i < filtered.length && shown < PICKER_ROW_CAP; i++) {
			const m = filtered[i];
			if (m.provider !== lastProvider) {
				lines.push(truncateToWidth(`  ${th.fg("dim", `── ${m.provider}`)}`, width));
				lastProvider = m.provider;
				shown++;
			}
			const isSelected = i === sel;
			const cursor = isSelected ? th.fg("accent", "›") : " ";
			const current = this.currentLabel && m.label === this.currentLabel ? th.fg("success", " ●") : "";
			const name = m.name ? th.fg("dim", `  ${m.name}`) : "";
			const label = th.fg(isSelected ? "accent" : "text", m.label);
			lines.push(truncateToWidth(`  ${cursor} ${label}${name}${current}`, width));
			shown++;
		}
		if (filtered.length === 0) {
			lines.push(`  ${th.fg("dim", "No models match the filter.")}`);
		} else if (filtered.length > PICKER_ROW_CAP) {
			lines.push(
				truncateToWidth(`  ${th.fg("dim", `... ${filtered.length - PICKER_ROW_CAP} more — refine the filter`)}`, width),
			);
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "↑/↓ navigate · type to filter · Enter select · Esc cancel")}`, width));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
