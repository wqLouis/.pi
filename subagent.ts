

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
	ModelSelectorComponent,
	type ModelRuntime,
	getAgentDir,
	getSettingsListTheme,
	withFileMutationQueue,
	DynamicBorder,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, SettingsList, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_MAX_SUBAGENTS = 4;
const MAX_ERROR_CHARS = 500;
const PREVIEW_CHARS = 200;
const DETAIL_CHARS = 300;
const KILL_GRACE_MS = 5000;
const FLUSH_DELAY_MS = 50;
const SESSION_START_FLUSH_DELAY_MS = 200;
const FLUSH_INTERVAL_MS = 30_000;
const SETTINGS_MAX_VISIBLE = 10;

const DEFAULT_SUBAGENT_PROMPT = [
	"You are a subagent working for a main agent. You run in an isolated context, so the main agent's conversation is not visible to you — only the task you receive and any follow-up instructions.",
	"",
	"Guidelines:",
	"- Complete the assigned task autonomously, using your tools as needed.",
	"- The main agent may send follow-up messages to steer or redirect you. Treat them as updated instructions and adapt your work accordingly.",
	"- When done, report concisely with concrete details (file paths, findings, decisions) that the main agent can act on without re-reading the code.",
	"- If something is blocked or impossible, say so clearly instead of guessing.",
].join("\n");


const isSubagentProcess = Number(process.env.PI_SUBAGENT_DEPTH ?? "0") >= 1;


function isWithinScope(targetAbs: string, scope: string[]): boolean {
	return scope.some((s) => {
		const rel = path.relative(s, targetAbs);
		return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	});
}


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

	bubbles?: Array<{ text: string; request: boolean }>;
}

interface SubagentRecord {
	id: string;
	model?: string;
	task?: string;
	sessionPath?: string;
	/** Steering messages queued while the subagent was running; delivered as its next turn when the current run finishes. */
	pendingMessages?: string[];
	systemPrompt: string;
	cwd: string;
	tools?: string;

	scope?: string[];

	allowTmp?: boolean;
	status: SubagentStatus;
	pid?: number;

	lastError?: string;

	donePushedAt?: number;
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

	maxSubagents?: number;

	scope?: string | string[];

	allowTmp?: boolean;
}

interface RunningEntry {
	proc: ChildProcess;
	done: Promise<RunResult>;
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


function configFile(): string {
	return path.join(getAgentDir(), "subagent-config.json");
}

function loadConfig(): SubagentConfig {
	try {
		const raw = fs.readFileSync(configFile(), "utf-8");
		const cfg = JSON.parse(raw) as SubagentConfig;
		if (cfg && typeof cfg === "object") return cfg;
	} catch {

	}
	return {};
}

function saveConfig(cfg: SubagentConfig): void {
	fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), { encoding: "utf-8", mode: 0o600 });
}


function getMaxSubagents(): number {
	const cfg = loadConfig();
	if (typeof cfg.maxSubagents === "number" && Number.isFinite(cfg.maxSubagents) && cfg.maxSubagents >= 1)
		return Math.floor(cfg.maxSubagents);
	const env = Number(process.env.PI_SUBAGENT_MAX_SUBAGENTS);
	if (Number.isFinite(env) && env >= 1) return Math.floor(env);
	return DEFAULT_MAX_SUBAGENTS;
}


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
						continue;
					}
				}
				count++;
			} catch {

			}
		}
	} catch {

	}
	return count;
}


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


let activeSubagentDir: string | undefined;

function sessionScopeKey(ctx: ExtensionContext): string {
	let sessionId = "session";
	try {
		sessionId = ctx.sessionManager.getSessionId() || sessionId;
	} catch {

	}
	return sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "session";
}

function subagentDir(ctx?: ExtensionContext): string {
	const configured = process.env.PI_SUBAGENT_DIR;
	const dir = configured
		? path.resolve(configured)
		: activeSubagentDir ?? path.join(getAgentDir(), "subagents", ctx ? sessionScopeKey(ctx) : "unscoped");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function recordFile(id: string): string {
	return path.join(subagentDir(), `${id}.json`);
}

function sessionFile(id: string): string {
	return path.join(subagentDir(), `${id}.jsonl`);
}

function sessionFileForRecord(rec: Pick<SubagentRecord, "id" | "sessionPath">): string {
	return rec.sessionPath ?? sessionFile(rec.id);
}

function newSubagentId(): string {
	return `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadRecord(id: string): SubagentRecord | undefined {
	try {
		const raw = fs.readFileSync(recordFile(id), "utf-8");
		const rec = JSON.parse(raw) as SubagentRecord;
		if (rec && typeof rec.id === "string") {
			if (!rec.status) rec.status = "idle";
			return rec;
		}
	} catch {

	}
	return undefined;
}

function saveRecord(rec: SubagentRecord): void {
	rec.updatedAt = Date.now();
	fs.writeFileSync(recordFile(rec.id), JSON.stringify(rec, null, 2), { encoding: "utf-8", mode: 0o600 });
}


function readTranscript(id: string): string {
	try {
		const rec = loadRecord(id);
		const raw = fs.readFileSync(rec ? sessionFileForRecord(rec) : sessionFile(id), "utf-8");
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


/**
 * Build a shared context-prefill block from file paths. The block is identical
 * for every subagent spawned by the same call, so their conversation prefixes
 * (system prompt + this block) match exactly and provider prompt caches hit
 * across the batch — the subagents don't each have to issue their own reads.
 */
const PREFILL_MAX_FILE_CHARS = 100_000;
const PREFILL_MAX_TOTAL_CHARS = 400_000;

function buildPrefillBlock(paths: string[] | undefined, cwd: string): string | undefined {
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


function currentTaskBase(ctx: ExtensionContext | undefined): string {
	if (process.env.PI_TASK_BASE) return process.env.PI_TASK_BASE;
	const dir = process.env.PI_TASK_DIR || "/tmp";
	let sessionId = "session";
	try {
		sessionId = ctx?.sessionManager.getSessionId() ?? "session";
	} catch {

	}
	const safe = sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "session";
	return path.join(dir, safe);
}


function childTaskBase(ctx: ExtensionContext | undefined, _childId: string): string {
	// All subagents in one main session share the same logical TASK.md board.
	return currentTaskBase(ctx);
}

async function spawnSubagentProcess(
	rec: SubagentRecord,
	userText: string,
	depth: number,
	signal: AbortSignal | undefined,
	onUpdate?: (text: string) => void,
	onBubble?: (bubble: { text: string; request: boolean }) => void,
	taskBase?: string,
): Promise<{ proc: ChildProcess; done: Promise<RunResult> }> {
	const args: string[] = ["--mode", "json", "-p", "--session", sessionFileForRecord(rec)];
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
				PI_SUBAGENT_DIR: subagentDir(),
			};
			if (rec.scope && rec.scope.length > 0) {
				env.PI_SUBAGENT_SCOPE = JSON.stringify(rec.scope);
			}
			if (taskBase) env.PI_TASK_BASE = taskBase;
			if (rec.allowTmp === false) env.PI_SUBAGENT_SCOPE_BLOCK_TMP = "1";
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
					}, KILL_GRACE_MS);
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

		}
		try {
			fs.rmdirSync(tmp.dir);
		} catch {

		}
	}
}


async function runSubagentTurn(
	rec: SubagentRecord,
	userText: string,
	depth: number,
	signal: AbortSignal | undefined,
	onUpdate?: (text: string) => void,
	onBubble?: (bubble: { text: string; request: boolean }) => void,
	taskBase?: string,
): Promise<RunResult> {
	const { done } = await spawnSubagentProcess(rec, userText, depth, signal, onUpdate, onBubble, taskBase);
	return done;
}

function isFailedRun(run: RunResult): boolean {
	return run.exitCode !== 0 || run.stopReason === "error" || run.stopReason === "aborted";
}


function finalizeRecord(rec: SubagentRecord, run: RunResult): { output: string; failed: boolean } {
	const output = getFinalOutput(run.messages) || "(no output)";
	rec.lastOutput = output;
	rec.totalUsage = addUsage(rec.totalUsage, run.usage);
	rec.status = isFailedRun(run) ? "error" : "idle";
	rec.lastError = isFailedRun(run) ? (run.errorMessage || run.stderr || firstLine(output).slice(0, DETAIL_CHARS)) : undefined;
	rec.pid = undefined;
	saveRecord(rec);
	return { output, failed: isFailedRun(run) };
}


async function runAndRecord(
	rec: SubagentRecord,
	userText: string,
	signal: AbortSignal | undefined,
	onUpdate?: (partial: AgentToolResult<SubagentDetails>) => void,
	onBubble?: (bubble: { text: string; request: boolean }) => void,
	taskBase?: string,
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
	}, onBubble, taskBase);

	const { output, failed } = finalizeRecord(rec, run);
	if (failed) {
		const reason = run.stopReason ?? `exit code ${run.exitCode}`;
		const detail = run.errorMessage || run.stderr || output;
		return { ok: false, error: `subagent ${reason}: ${detail.slice(0, MAX_ERROR_CHARS)}`, output, usage: run.usage, bubbles: run.bubbles ?? [] };
	}
	return { ok: true, output, usage: run.usage, bubbles: run.bubbles ?? [] };
}


const running = new Map<string, RunningEntry>();


function buildCompletionText(rec: SubagentRecord): string {
	const output = rec.lastOutput.trim() || "(no output)";
	if (rec.status === "error") {
		const detail = rec.lastError?.trim() || "(no error detail)";
		return (
			`[subagent ${rec.id} error]\n\n` +
			`Error: ${detail}\n\n` +
			`Last output:\n${output}\n\n` +
			`Resolve it with subagent_send { subagentId: "${rec.id}", message: "<what to fix>" }, ` +
			`or inspect the full transcript with subagent_result { subagentId: "${rec.id}" }. ` +
			`Use subagent_forget { subagentId: "${rec.id}" } to discard it.`
		);
	}
	return `[subagent ${rec.id} done]\n\n${output}`;
}


function notifyDone(pi: ExtensionAPI, ctx: ExtensionContext, rec: SubagentRecord) {
	const text = buildCompletionText(rec);
	const brief = rec.status === "error" ? `Subagent ${rec.id} error` : `Subagent ${rec.id} done`;
	if (ctx.hasUI) {
		ctx.ui.notify(rec.status === "error" ? brief : `${brief}: ${firstLine(rec.lastOutput).slice(0, PREVIEW_CHARS)}`, rec.status === "error" ? "error" : "info");
	}
	try {
		pi.sendUserMessage(text, { deliverAs: "steer" });
		rec.donePushedAt = Date.now();
		saveRecord(rec);
	} catch {

	}
}


function flushPendingNotifications(pi: ExtensionAPI, ctx: ExtensionContext): void {
	try {
		for (const file of fs.readdirSync(subagentDir())) {
			if (!file.endsWith(".json")) continue;
			const rec = loadRecord(file.slice(0, -5));
			if (!rec || rec.status === "running" || rec.donePushedAt) continue;
			pi.sendUserMessage(buildCompletionText(rec), { deliverAs: "steer" });
			rec.donePushedAt = Date.now();
			saveRecord(rec);
		}
	} catch {

	}
}


async function startBackground(
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

	if (countRunningSubagents() >= getMaxSubagents()) {
		return {
			started: false,
			error: `Maximum concurrent subagents reached (${countRunningSubagents()}/${getMaxSubagents()} running).`,
		};
	}

	rec.status = "running";
	saveRecord(rec);

	let proc: ChildProcess;
	let done: Promise<RunResult>;
	try {
		const spawned = await spawnSubagentProcess(
			rec,
			userText,
			0,
			undefined,
			undefined,
			(bubble) => {


				if (ctx.hasUI) {
					ctx.ui.notify(
						`[subagent ${rec.id} ${bubble.request ? "request" : "message"}] ${firstLine(bubble.text).slice(0, PREVIEW_CHARS)}`,
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

					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
			childTaskBase(ctx, rec.id),
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
	running.set(rec.id, { proc, done });

	done.then(async (run) => {
		running.delete(rec.id);
		finalizeRecord(rec, run);
		notifyDone(api, ctx, rec);
		await deliverQueuedMessages(api, ctx, rec);
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
 * Deliver steering messages that were queued while the subagent was running.
 * Each queued message is started as a background turn on the subagent's session.
 */
async function deliverQueuedMessages(api: ExtensionAPI, ctx: ExtensionContext, rec: SubagentRecord): Promise<void> {
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


const SpawnParams = Type.Object({
	task: Type.String({ description: "The task to delegate to the subagent" }),
	await: Type.Optional(
		Type.Boolean({
			description: "true (default): wait for the subagent to finish and return its output. false: run in the background and return immediately; completion is automatically notified to the main agent.",
			default: true,
		}),
	),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				task: Type.String({ description: "The implementation task for this subagent.", minLength: 1 }),
				scope: Type.Optional(
					Type.Union([
						Type.String({ description: "Directory or file path this task agent may edit. Reads are unrestricted." }),
						Type.Array(
							Type.String({ description: "A directory or file path this task agent may edit. Reads are unrestricted." }),
							{ minItems: 1 },
						),
					]),
				),
			}),
			{ minItems: 1 },
		),
	),
	prefillReads: Type.Optional(
		Type.Array(
			Type.String({
				description:
					"File paths to read once now and inject verbatim into every spawned subagent's context (before the task), so subagents don't each issue their own reads. The identical prefix maximizes provider prompt-cache hits across parallel subagents.",
			}),
			{ minItems: 1 },
		),
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


export default function (pi: ExtensionAPI) {

	pi.on("session_shutdown", () => {
		for (const { proc } of running.values()) {
			try {
				proc.kill("SIGTERM");
			} catch {

			}
		}
		running.clear();
	});


	let lastFlushCtx: ExtensionContext | undefined;
	const scheduleFlush = (ctx: ExtensionContext, delayMs: number) => {
		lastFlushCtx = ctx;
		setTimeout(() => flushPendingNotifications(pi, ctx), delayMs);
	};
	pi.on("session_start", (_event, ctx) => {
		const scopedDir = process.env.PI_SUBAGENT_DIR
			? path.resolve(process.env.PI_SUBAGENT_DIR)
			: path.join(getAgentDir(), "subagents", sessionScopeKey(ctx));
		activeSubagentDir = scopedDir;
		fs.mkdirSync(scopedDir, { recursive: true });
		scheduleFlush(ctx, SESSION_START_FLUSH_DELAY_MS);
	});
	pi.on("agent_end", (_event, ctx) => scheduleFlush(ctx, FLUSH_DELAY_MS));
	const flushTimer = setInterval(() => {
		if (!lastFlushCtx) return;
		try {
			flushPendingNotifications(pi, lastFlushCtx);
		} catch {

		}
	}, FLUSH_INTERVAL_MS);
	pi.on("session_shutdown", () => clearInterval(flushTimer));


	const scopeEnv = process.env.PI_SUBAGENT_SCOPE;
	if (scopeEnv) {
		let scope: string[] = [];
		try {
			scope = JSON.parse(scopeEnv);
		} catch {

		}
		if (Array.isArray(scope) && scope.length > 0) {
			const tmpDir = os.tmpdir();
			const blockTmp = process.env.PI_SUBAGENT_SCOPE_BLOCK_TMP === "1";
			const taskBoardFile = process.env.PI_TASK_BASE ? path.resolve(path.join(process.env.PI_TASK_BASE, "TASK.md")) : undefined;
			pi.on("tool_call", (event, ctx) => {
				if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
				const target = (event.input as { path?: string }).path;
				if (!target) return undefined;
				const targetAbs = path.resolve(target.replace(/^@/, ""));
				if (isWithinScope(targetAbs, scope)) return undefined;
				const logicalTaskBoardFile = path.resolve(ctx.cwd, "TASK.md");
				if (taskBoardFile && (targetAbs === taskBoardFile || targetAbs === logicalTaskBoardFile)) return undefined;
				if (!blockTmp && isWithinScope(targetAbs, [tmpDir])) return undefined;
				return {
					block: true,
					reason:
						`Writing to "${targetAbs}" is outside this subagent's edit scope. ` +
						`Allowed: scope (${scope.join(", ")}) and the temp dir. Reads are unrestricted; use write/edit only within those.`,
				};
			});
		}
	}


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


	pi.registerTool({
		name: "subagent_spawn",
		label: "Subagent Spawn",
		description:
			"Spawn subagent(s) to work in isolated contexts (their own sessions). Pass task for one direct subagent — with await: true (default) this blocks until it finishes; with await: false it runs in the background. Pass tasks (array of { task, scope? }) to spawn one background subagent per task; each task may carry its own edit scope (optional — defaults to the config's default scope). Multi-task spawns are always asynchronous.",
		promptSnippet: "Spawn isolated subagent(s) to delegate work to",
		promptGuidelines: [
			"Pass tasks (array of { task, scope? }) to run several independent subagents in parallel; each runs in the background with automatic completion notifications.",
			"When multiple subagents need the same files, pass prefillReads (file paths): the files are read once and injected verbatim, identically, into every spawned subagent's context before the task — the subagents share that prompt-cache prefix instead of each issuing their own reads (better cache hits, fewer read calls).",
			"Use a single task with await: false for background work, or await: true (default) to block until it finishes.",
			"Give each task a narrow edit scope so the harness can block writes outside those files or directories — use this to keep parallel subagents from colliding on the same files.",
			"Use subagent_send to steer a subagent — it continues with its full previous context; messages sent while it is running are queued and delivered as its next turn.",
			"If a subagent errors, steer it to fix the error with subagent_send or respawn it with subagent_spawn — don't just give up.",
			"Check subagent_config to see how many subagents are currently running vs the maxSubagents limit. Spawn only as many as you actually need.",
		],
		parameters: SpawnParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = params.task?.trim();
			const assignments = (params.tasks ?? [])
				.map((t) => ({ task: t.task?.trim() ?? "", scope: t.scope }))
				.filter((t) => t.task.length > 0);
			if (!task && assignments.length === 0) {
				return {
					content: [{ type: "text", text: "Error: task is required (or pass tasks for multiple subagents)." }],
					details: { subagentId: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}

			if (isSubagentProcess) {
				return {
					content: [
						{
							type: "text",
							text: "Nested subagents are not supported.",
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
								`Maximum concurrent subagents reached (${runningNow}/${maxSubagents} running). Wait for completion notifications or forget agents (subagent_forget) before spawning more. Raise maxSubagents in the settings (/subagent config maxSubagents N) if you need more.`,
						},
					],
					details: { subagentId: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}

			// Multi-task path: one independent background subagent per task, no shared exploration.
			if (assignments.length > 0) {
				if (runningNow + assignments.length > maxSubagents) {
					return {
						content: [
							{
								type: "text",
								text: `This spawn has ${assignments.length} task(s) but only ${maxSubagents - runningNow} of ${maxSubagents} subagent slots are free. Spawn fewer tasks or raise maxSubagents (/subagent config maxSubagents N).`,
							},
						],
						details: { subagentId: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
						isError: true,
					};
				}
				const opts2 = resolveSpawnOptions(ctx, {
					model: params.model,
					systemPrompt: params.systemPrompt,
					cwd: params.cwd,
					tools: params.tools,
				});
				const cfg2 = loadConfig();
				const allowTmp2 = cfg2.allowTmp ?? true;
				const prefillBlock = buildPrefillBlock(params.prefillReads, opts2.cwd);
				const lines: string[] = [];
				for (const assignment of assignments) {
					const record: SubagentRecord = {
						id: newSubagentId(),
						model: opts2.model,
						systemPrompt: opts2.systemPrompt,
						cwd: opts2.cwd,
						tools: opts2.tools,
						scope: normalizeScope(opts2.cwd, assignment.scope ?? cfg2.scope),
						allowTmp: allowTmp2,
						task: assignment.task,
						status: "idle",
						createdAt: Date.now(),
						updatedAt: Date.now(),
						lastOutput: "",
						totalUsage: EMPTY_USAGE(),
					};
					saveRecord(record);
					const userText = prefillBlock ? `${prefillBlock}\n\n${assignment.task}` : assignment.task;
					const bg = await startBackground(pi, ctx, record, userText);
					if (!bg.started) {
						record.status = "error";
						record.lastError = bg.error;
						saveRecord(record);
						lines.push(`- ${record.id} [error] failed to start: ${bg.error ?? "unknown error"}`);
					} else {
						lines.push(
							`- ${record.id} [running]${record.scope ? ` · scope: ${record.scope.join(", ")}` : ""} · ${firstLine(assignment.task)}`,
						);
					}
				}
				return {
					content: [
						{
							type: "text",
							text:
								`Spawned ${assignments.length} subagent(s) in the background; each will notify you when it finishes.\n` +
								lines.join("\n") +
								`\nSteer with subagent_send, inspect with subagent_result, forget with subagent_forget.`,
						},
					],
					details: { subagentIds: lines.map((l) => l.slice(2, l.indexOf(" "))) } as unknown as SubagentDetails,
				};
			}

			const opts = resolveSpawnOptions(ctx, {
				model: params.model,
				systemPrompt: params.systemPrompt,
				cwd: params.cwd,
				tools: params.tools,
			});
			const cfg = loadConfig();
			const scope = normalizeScope(opts.cwd, params.scope ?? cfg.scope);
			const allowTmp = cfg.allowTmp ?? true;
			const prefillBlock = buildPrefillBlock(params.prefillReads, opts.cwd);

			const record: SubagentRecord = {
				id: newSubagentId(),
				model: opts.model,
				systemPrompt: opts.systemPrompt,
				cwd: opts.cwd,
				tools: opts.tools,
				scope,
				allowTmp,
				status: "idle",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				lastOutput: "",
				totalUsage: EMPTY_USAGE(),
			};
			saveRecord(record);

			const userText = prefillBlock ? `${prefillBlock}\n\n${task}` : task;
			if (params.await === false) {
				const bg = await startBackground(pi, ctx, record, userText);
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
								`You will be notified when it finishes; read its transcript with subagent_result or steer it with subagent_send afterward.`,
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

			const result = await runAndRecord(record, userText, signal, onUpdate, (bubble) => {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[subagent ${record.id} ${bubble.request ? "request" : "message"}] ${firstLine(bubble.text).slice(0, PREVIEW_CHARS)}`,
						bubble.request ? "warning" : "info",
					);
				}
			}, childTaskBase(ctx, record.id));
			await deliverQueuedMessages(pi, ctx, record);
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



	pi.registerTool({
		name: "subagent_send",
		label: "Subagent Send",
		description:
			"Push a follow-up message to a spawned subagent (subagentId from subagent_spawn). The subagent continues its private session, so it keeps full context of its previous work. Use this to steer, redirect, ask for more detail, or assign follow-up work. Always async: if the subagent is idle/error it starts a background steering turn immediately; if it is currently running, the message is queued and delivered as its next turn when the current run finishes. The complete result auto-bubbles when it finishes.",
		promptSnippet: "Send a steering message to a subagent",
		promptGuidelines: [
			"When a subagent errors (you receive a subagent-error message or a failed result), resolve it by steering it with subagent_send (it resumes with full context) or respawning with subagent_spawn; use subagent_result to inspect the transcript first.",
			"subagent_send is async — it returns immediately; if the subagent is running, the message is queued for its next turn, otherwise a background turn starts now. The completion message auto-bubbles; keep working while it runs.",
		],
		parameters: SendParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
				record.pendingMessages = [...(record.pendingMessages ?? []), message];
				saveRecord(record);
				return {
					content: [
						{
							type: "text",
							text:
								`Subagent ${params.subagentId} is currently running — message queued. It will be delivered as the subagent's next turn when the current run finishes (with its full session context).`,
						},
					],
					details: { subagentId: params.subagentId, output: "", status: "running", usage: record.totalUsage } as SubagentDetails,
				};
			}


			const started = await startBackground(pi, ctx, record, message);
			if (!started.started) {
				return {
					content: [{ type: "text", text: started.error ?? "Failed to start the subagent turn." }],
					details: {
						subagentId: params.subagentId,
						model: record.model,
						output: "",
						status: "error",
						usage: record.totalUsage,
					} as SubagentDetails,
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text:
							`Steering message sent to subagent ${params.subagentId} in the background — the complete result will auto-bubble when it finishes. Inspect the output with subagent_result if needed.`,
					},
				],
				details: {
					subagentId: params.subagentId,
					model: record.model,
					output: "",
					status: "running",
					usage: record.totalUsage,
				} as SubagentDetails,
			};
		},
	});


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

			}
			records.sort((a, b) => b.createdAt - a.createdAt);

			const out: string[] = [];
			const runningNow = records.filter((r) => r.status === "running").length;
			const maxSubagents = getMaxSubagents();
			out.push(`Running: ${runningNow}/${maxSubagents} subagents · total spawned: ${records.length}`);
			if (records.length === 0) {
				out.push("No subagents spawned yet. Use subagent_spawn to delegate work.");
			} else {
				out.push(`${records.length} subagent(s):`);
				for (const rec of records) {
					const usage = formatUsage(rec.totalUsage, rec.model);
					out.push(
						`- ${rec.id} [${rec.status}] · model: ${rec.model ?? "session"} · created: ${new Date(rec.createdAt).toLocaleString()}` +
							(rec.pendingMessages?.length ? `\n  queued messages: ${rec.pendingMessages.length}` : "") +
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

				}
				running.delete(params.subagentId);
			}
			let removed = 0;
			for (const file of [recordFile(params.subagentId), sessionFileForRecord(record)]) {
				try {
					fs.unlinkSync(file);
					removed++;
				} catch {

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
			const out: string[] = [];
			out.push(`Config file: ${configFile()}`);
			out.push(`User-configured model: ${cfg.model ?? "(not set — inherits session model)"}`);
			out.push(`Current session model: ${sessionModel ?? "(none)"}`);
			out.push(`Effective model for new subagents: ${cfg.model ?? sessionModel ?? "(none)"}`);
			out.push(`Custom system prompt: ${cfg.systemPrompt ? `set (${cfg.systemPrompt.length} chars)` : "(default)"}`);
			out.push(`Working directory: ${cfg.cwd ?? "(current directory)"}`);
			out.push(`Tool allowlist: ${cfg.tools ?? "(all tools)"}`);
			out.push(`Subagents running: ${runningNow}/${maxSubagents} (maxSubagents)`);
			out.push(
				`Default edit scope: ${cfg.scope ? (Array.isArray(cfg.scope) ? cfg.scope.join(", ") : cfg.scope) : "(none — full access)"}`,
			);
			out.push(`Allow temp writes: ${cfg.allowTmp === false ? "no" : "yes"}`);
			out.push("Set the model with `/subagent model <provider/id>`; set the limit with `/subagent config maxSubagents N`.");
			return {
				content: [{ type: "text", text: out.join("\n") }],
				details: {
					config: cfg,
					sessionModel,
					effectiveModel: cfg.model ?? sessionModel,
					runningSubagents: runningNow,
					maxSubagents,
					defaultScope: cfg.scope,
					allowTmp: cfg.allowTmp !== false,
				},
			};
		},
	});


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


				const picked = await showModelPicker(ctx, "", cfg.model ?? sessionModelLabel(ctx));
				if (picked) setModel(picked);
				else ctx.ui.notify("Model selection cancelled.", "info");
				return;
			}
			if (first === "config") {
				const cfg = loadConfig();
				const key = parts[1];
				if (key === "maxSubagents") {
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
				if (key === "scope") {
					const v = parts.slice(2).join(" ").trim();
					cfg.scope = v
						? v.includes(",")
							? v.split(",").map((x) => x.trim()).filter(Boolean)
							: v
						: undefined;
					saveConfig(cfg);
					ctx.ui.notify(v ? `Default edit scope set to: ${v}` : "Default edit scope cleared (full access).", "info");
					return;
				}
				if (key === "allowTmp") {
					const v = parts[2]?.toLowerCase();
					if (v !== "yes" && v !== "no") {
						ctx.ui.notify("Usage: /subagent config allowTmp yes|no", "info");
						return;
					}
					cfg.allowTmp = v === "yes";
					saveConfig(cfg);
					ctx.ui.notify(`allowTmp set to ${cfg.allowTmp ? "yes" : "no"}.`, "info");
					return;
				}
				if (key) {
					ctx.ui.notify(
						"Usage: /subagent config [maxSubagents <n> | scope <path> | allowTmp yes|no] — no args opens the settings panel.",
						"info",
					);
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

						}
						running.delete(id);
					}
					for (const file of [recordFile(id), sessionFileForRecord(rec)]) {
						try {
							fs.unlinkSync(file);
						} catch {

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
					rec.pendingMessages = [...(rec.pendingMessages ?? []), message];
					saveRecord(rec);
					ctx.ui.notify(`Subagent ${id} is running — message queued; it will run as its next turn when the current run finishes.`, "info");
					return;
				}
				if (ctx.hasUI) ctx.ui.setStatus("subagent", `sending to ${id}...`);
				const result = await runAndRecord(rec, message, ctx.signal, undefined, undefined, childTaskBase(ctx, rec.id));
				await deliverQueuedMessages(pi, ctx, rec);
				if (ctx.hasUI) ctx.ui.setStatus("subagent", "");
				if (!result.ok) {
					ctx.ui.notify(result.error ?? "Failed", "error");
					return;
				}
				ctx.ui.notify(`[subagent ${id}] ${(result.output ?? "").slice(0, 600)}`, "info");
				return;
			}


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
				status: "idle",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				lastOutput: "",
				totalUsage: EMPTY_USAGE(),
			};
			saveRecord(record);
			if (ctx.hasUI) ctx.ui.setStatus("subagent", "spawning subagent...");
			const result = await runAndRecord(record, task, ctx.signal, undefined, undefined, childTaskBase(ctx, record.id));
			await deliverQueuedMessages(pi, ctx, record);
			if (ctx.hasUI) ctx.ui.setStatus("subagent", "");
			if (!result.ok) {
				ctx.ui.notify(result.error ?? "Subagent failed", "error");
				return;
			}
			ctx.ui.notify(`[subagent ${record.id}] ${(result.output ?? "").slice(0, 600)}`, "info");
		},
	});
}


function findExactModel(ctx: ExtensionCommandContext, arg: string): string | undefined {
	const q = arg.trim().toLowerCase();
	try {
		for (const m of ctx.modelRegistry.getAll()) {
			if (`${m.provider}/${m.id}`.toLowerCase() === q) return `${m.provider}/${m.id}`;
		}
	} catch {

	}
	return undefined;
}


function sessionModelLabel(ctx: ExtensionCommandContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}


/**
 * Open pi's built-in model selector (the same UI /model uses) as a component.
 * The session's real ModelRuntime is reached through the ModelRegistry facade
 * so extension-registered providers are listed too. No onSelectAsDefault
 * callback is passed, so Ctrl+S (set as pi's session default) is unavailable —
 * this picks the subagent model, not pi's session default.
 */
function makeModelSelector(
	ctx: ExtensionCommandContext,
	tui: TUI,
	initialFilter: string,
	currentLabel: string | undefined,
	onDone: (model: string | undefined) => void,
): ModelSelectorComponent {
	const runtime = (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
	const [provider, ...rest] = (currentLabel ?? "").split("/");
	const currentModel = currentLabel ? ctx.modelRegistry.find(provider, rest.join("/")) : ctx.model;
	return new ModelSelectorComponent(
		tui,
		currentModel,
		runtime,
		ctx.scopedModels,
		(model) => onDone(`${model.provider}/${model.id}`),
		() => onDone(undefined),
		initialFilter,
	);
}

async function showModelPicker(
	ctx: ExtensionCommandContext,
	initialFilter: string,
	currentLabel?: string,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Model picker requires interactive mode. Use: /subagent model <provider/id>", "info");
		return undefined;
	}
	return await ctx.ui.custom<string | undefined>((tui, _theme, _kb, done) => {
		return makeModelSelector(ctx, tui, initialFilter, currentLabel, done);
	});
}


async function showSubagentConfigUi(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {

		const cfg = loadConfig();
		const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
		ctx.ui.notify(
			`model: ${cfg.model ?? "(inherit)"} (session: ${sessionModel})\n` +
				`maxSubagents: ${getMaxSubagents()} (running ${countRunningSubagents()})\n` +
				`scope: ${cfg.scope ? (Array.isArray(cfg.scope) ? cfg.scope.join(", ") : cfg.scope) : "(none)"} · allowTmp: ${cfg.allowTmp === false ? "no" : "yes"}\n` +
				`cwd: ${cfg.cwd ?? "(inherit)"}\ntools: ${cfg.tools ?? "(all)"}\n` +
				`file: ${configFile()}`,
			"info",
		);
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {

		const draft: SubagentConfig = { ...loadConfig() };
		let dirty = false;
		let savedAt = 0;
		const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
		const effectiveModel = draft.model ?? sessionModel ?? "(none)";
		const rowValue = (id: string) => String(draft.maxSubagents ?? getMaxSubagents());


		const items: Array<{
			id: string;
			label: string;
			description?: string;
			currentValue: string;
			values?: string[];
			submenu?: (cur: string, done: (v?: string) => void) => Component;
		}> = [
			{
				id: "model",
				label: "Model",
				description: "Model used by new subagents. Enter to pick (inherits the session model when unset).",
				currentValue: effectiveModel,
			},
			{
				id: "maxSubagents",
				label: "Concurrent subagents",
				description: "Maximum subagents running at once. Type a number directly to set it.",
				currentValue: String(getMaxSubagents()),
			},
			{
				id: "cwd",
				label: "Working directory",
				description: "Where new subagents run. Edit subagent-config.json or use the CLI form.",
				currentValue: draft.cwd ?? "(inherit — session cwd)",
			},
			{
				id: "scope",
				label: "Default edit scope",
				description:
					"Edit scope applied to spawned subagents (overridden by the spawn scope param). Set with /subagent config scope <path>.",
				currentValue: Array.isArray(draft.scope)
					? draft.scope.join(", ")
					: draft.scope ?? "(none — full access)",
			},
			{
				id: "allowTmp",
				label: "Allow temp writes",
				description: "Whether subagents may write to the OS temp dir when scoped. Enter to toggle.",
				currentValue: draft.allowTmp === false ? "no" : "yes",
				values: ["yes", "no"],
			},
		];
		items[0].submenu = (_cur, selectDone) =>
			makeModelSelector(ctx, tui, "", draft.model ?? sessionModelLabel(ctx), (label) => {
				if (label) {
					draft.model = label;
					dirty = true;
					settingsList.updateValue("model", label);
				}
				updateFooter();
				container.invalidate();
				selectDone(label ?? undefined);
			}) as unknown as Component;

		const numericIds = new Set(["maxSubagents"]);
		let selectedRowIndex = 0;
		let digitInput = "";

		const refreshRow = (id: string) => settingsList.updateValue(id, rowValue(id));

		const commitNumber = () => {
			const id = items[selectedRowIndex].id;
			const n = Number(digitInput);
			if (numericIds.has(id) && Number.isInteger(n) && n >= 1) {
				draft.maxSubagents = n;
				dirty = true;
			}
			digitInput = "";
			refreshRow(id);
			updateFooter();
			container.invalidate();
		};

		const settingsList = new SettingsList(
			items,
			SETTINGS_MAX_VISIBLE,
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "allowTmp") {
					draft.allowTmp = newValue === "yes";
					dirty = true;
					updateFooter();
					container.invalidate();
				}
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

				if (matchesKey(data, "ctrl+s")) {
					saveConfig(draft);
					dirty = false;
					savedAt = Date.now();
					updateFooter();
					container.invalidate();
					return;
				}

				if (matchesKey(data, "up")) selectedRowIndex = selectedRowIndex === 0 ? items.length - 1 : selectedRowIndex - 1;
				else if (matchesKey(data, "down")) selectedRowIndex = selectedRowIndex === items.length - 1 ? 0 : selectedRowIndex + 1;

				const row = items[selectedRowIndex];
				if (row && numericIds.has(row.id)) {
					if (data.length === 1 && data >= "0" && data <= "9") {
						digitInput = (digitInput + data).slice(0, 3);
						settingsList.updateValue(row.id, digitInput);
						container.invalidate();
						return;
					}
					if (data === "\x7f" || data === "\b") {
						digitInput = digitInput.slice(0, -1);
						settingsList.updateValue(row.id, digitInput || rowValue(row.id));
						container.invalidate();
						return;
					}
					if (matchesKey(data, "enter")) {
						if (digitInput) commitNumber();
						return;
					}
					if (matchesKey(data, "escape")) {
						if (digitInput) {
							digitInput = "";
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
