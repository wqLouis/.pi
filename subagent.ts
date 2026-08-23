

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
	SessionManager,
	getAgentDir,
	getSettingsListTheme,
	withFileMutationQueue,
	DynamicBorder,
} from "@earendil-works/pi-coding-agent";
import { Container, decodeKittyPrintable, matchesKey, SettingsList, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_SUBAGENTS = 4;
const MAX_ERROR_CHARS = 500;
const PREVIEW_CHARS = 200;
const DETAIL_CHARS = 300;
const KILL_GRACE_MS = 5000;
const FLUSH_DELAY_MS = 50;
const SESSION_START_FLUSH_DELAY_MS = 200;
const FLUSH_INTERVAL_MS = 30_000;
const SETTINGS_MAX_VISIBLE = 10;
const FILTER_MAX_CHARS = 40;

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

type SubagentStatus = "running" | "idle" | "error" | "planned";

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
	role?: "task" | "explorer";
	parentSubagentId?: string;
	task?: string;
	sessionPath?: string;
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

	maxDepth?: number;

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


function getMaxDepth(): number {
	const cfg = loadConfig();
	if (typeof cfg.maxDepth === "number" && Number.isFinite(cfg.maxDepth) && cfg.maxDepth >= 1) return Math.floor(cfg.maxDepth);
	const env = Number(process.env.PI_SUBAGENT_MAX_DEPTH);
	if (Number.isFinite(env) && env >= 1) return Math.floor(env);
	return DEFAULT_MAX_DEPTH;
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

function forkSessionForRecord(rec: SubagentRecord, sourcePath: string): string {
	const forked = SessionManager.forkFrom(sourcePath, rec.cwd, subagentDir(), { id: rec.id });
	const forkedPath = forked.getSessionFile();
	if (!forkedPath) throw new Error(`Forked session for ${rec.id} has no session file`);
	rec.sessionPath = forkedPath;
	saveRecord(rec);
	return forkedPath;
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
	forkFrom?: string,
): Promise<{ proc: ChildProcess; done: Promise<RunResult> }> {
	if (forkFrom) forkSessionForRecord(rec, forkFrom);
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
	forkFrom?: string,
): Promise<RunResult> {
	const { done } = await spawnSubagentProcess(rec, userText, depth, signal, onUpdate, onBubble, taskBase, forkFrom);
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
	forkFrom?: string,
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
	}, onBubble, taskBase, forkFrom);

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
			if (!rec || rec.status === "running" || rec.status === "planned" || rec.donePushedAt) continue;
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
	forkFrom?: string,
	onDone?: (run: RunResult) => Promise<void> | void,
): Promise<{ started: boolean; error?: string }> {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = getMaxDepth();
	if (depth >= maxDepth) {
		return {
			started: false,
			error: `Maximum subagent depth (${maxDepth}) reached — refusing to nest further. Raise maxDepth in the settings (/subagent config maxDepth N) to allow deeper layers.`,
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
			depth,
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
			forkFrom,
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
		try {
			await onDone?.(run);
		} catch (error) {
			rec.lastError = `follow-up dispatch failed: ${error instanceof Error ? error.message : String(error)}`;
			saveRecord(rec);
		}
		notifyDone(api, ctx, rec);
	}).catch((error) => {
		running.delete(rec.id);
		rec.status = "error";
		rec.pid = undefined;
		rec.lastOutput = rec.lastOutput || `background error: ${error instanceof Error ? error.message : String(error)}`;
		saveRecord(rec);
	});

	return { started: true };
}


interface DispatchDetails {
	dispatchId: string;
	explorerId?: string;
	subagentIds: string[];
	status: SubagentStatus | "planning";
	usage: RunUsage;
}

interface TaskAssignment {
	task: string;
	scope: string | string[];
}

function hasEditScope(scope: unknown): scope is string | string[] {
	if (typeof scope === "string") return scope.trim().length > 0;
	return Array.isArray(scope) && scope.length > 0 && scope.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function createSubagentRecord(
	ctx: ExtensionContext,
	params: { model?: string; systemPrompt?: string; cwd?: string; tools?: string; scope?: string | string[] },
	role: "task" | "explorer",
	task: string,
	parentSubagentId?: string,
): SubagentRecord {
	const opts = resolveSpawnOptions(ctx, params);
	const cfg = loadConfig();
	return {
		id: newSubagentId(),
		model: opts.model,
		systemPrompt: opts.systemPrompt,
		cwd: opts.cwd,
		tools: opts.tools,
		scope: normalizeScope(opts.cwd, params.scope ?? cfg.scope),
		allowTmp: cfg.allowTmp ?? true,
		role,
		parentSubagentId,
		task,
		status: parentSubagentId ? "planned" : "idle",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		lastOutput: "",
		totalUsage: EMPTY_USAGE(),
	};
}

function buildExplorerPrompt(scope: string, tasks: string[]): string {
	return [
		"You are the shared exploration agent for a group of implementation subagents.",
		"",
		`Explore this scope thoroughly: ${scope}`,
		"",
		"Inspect the relevant files, architecture, conventions, dependencies, tests, and likely implementation points.",
		"Do not implement or modify files. Produce an implementation-ready report in your final response.",
		"Be concrete: include file paths, symbols, data flow, constraints, risks, and commands/tests the task agents should run.",
		"The task agents will receive this session by fork, so avoid repeating generic background and focus on reusable findings.",
		"",
		"Planned task assignments:",
		...tasks.map((task, index) => `${index + 1}. ${task}`),
	].join("\n");
}

function buildTaskPrompt(task: string): string {
	return [
		"You are an implementation subagent working from a shared exploration session.",
		"The preceding conversation is the explorer's full context and findings. Reuse it; do not repeat broad repository exploration unless you need to verify a specific detail.",
		"Implement and verify the assigned task below. Work autonomously, respect your edit scope, and report concrete changes and validation results.",
		"",
		`Assigned task: ${task}`,
	].join("\n");
}

function dispatchDetails(
	dispatchId: string,
	explorerId: string | undefined,
	subagentIds: string[],
	status: SubagentStatus | "planning",
	usage: RunUsage = EMPTY_USAGE(),
): DispatchDetails {
	return { dispatchId, explorerId, subagentIds, status, usage };
}

const DispatchParams = Type.Object({
	exploreScope: Type.String({
		description: "What the shared exploration agent should inspect: files, architecture, constraints, and relevant implementation scope.",
	}),
	tasks: Type.Array(
		Type.Object({
			task: Type.String({ description: "The implementation task for this subagent.", minLength: 1 }),
			scope: Type.Union([
				Type.String({ description: "Directory or file path this task agent may edit.", minLength: 1 }),
				Type.Array(
					Type.String({ description: "A directory or file path this task agent may edit.", minLength: 1 }),
					{ minItems: 1 },
				),
			]),
		}),
		{ minItems: 1 },
	),
	model: Type.Optional(Type.String({ description: "Model override in provider/id form." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agents (default: current directory)." })),
	tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist." })),
	systemPrompt: Type.Optional(Type.String({ description: "Override the subagent system prompt." })),
});

const SpawnParams = Type.Object({
	task: Type.String({ description: "The task to delegate to the subagent" }),
	await: Type.Optional(
		Type.Boolean({
			description: "true (default): wait for the subagent to finish and return its output. false: run in the background and return immediately; completion is automatically notified to the main agent.",
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
			"Spawn one direct subagent to work in an isolated context (its own session). For multiple related tasks, prefer subagent_dispatch, which explores once and forks task agents from the shared exploration session. With await: true (default) this blocks until the direct subagent finishes; with await: false it runs in the background.",
		promptSnippet: "Spawn an isolated subagent to delegate work to",
		promptGuidelines: [
			"Use subagent_dispatch for multiple implementation tasks that share repository context; it explores once and forks each task agent from the explorer session.",
			"Use subagent_spawn for one direct task or when shared exploration is not useful; use await: false for background work and rely on the automatic completion notification.",
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
								`Maximum concurrent subagents reached (${runningNow}/${maxSubagents} running). Wait for completion notifications or forget agents (subagent_forget) before spawning more. Raise maxSubagents in the settings (/subagent config maxSubagents N) if you need more.`,
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
			const cfg = loadConfig();
			const scope = normalizeScope(opts.cwd, params.scope ?? cfg.scope);
			const allowTmp = cfg.allowTmp ?? true;

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

			const result = await runAndRecord(record, task, signal, onUpdate, (bubble) => {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[subagent ${record.id} ${bubble.request ? "request" : "message"}] ${firstLine(bubble.text).slice(0, PREVIEW_CHARS)}`,
						bubble.request ? "warning" : "info",
					);
				}
			}, childTaskBase(ctx, record.id));
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
		name: "subagent_dispatch",
		label: "Subagent Dispatch",
		description:
			"Dispatch implementation work asynchronously through a shared exploration session. Provide exploreScope and an array of task assignments, each with task and edit scope. With multiple assignments, one explorer investigates the scope in the background, then each task agent is forked from the explorer session so all task agents reuse its full context and provider cache. With exactly one task, the explorer is skipped and the task agent runs directly in the background.",
		promptSnippet: "Explore once, then fork task agents from the shared exploration context",
		promptGuidelines: [
			"Use subagent_dispatch instead of manually spawning multiple agents when tasks share repository context.",
			"Give subagent_dispatch one focused exploreScope and an array of independent { task, scope } assignments; it explores once and forks each task agent from that session.",
			"Assign every subagent_dispatch task a narrow edit scope so the harness can block writes outside that task's files or directories.",
			"subagent_dispatch is always asynchronous; rely on its automatic completion notifications or inspect results with subagent_result.",
			"When subagent_dispatch has exactly one task, it uses the direct fast path and skips the exploration agent."
		],
		parameters: DispatchParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const exploreScope = params.exploreScope?.trim();
			const assignments: TaskAssignment[] = (params.tasks ?? []).map((assignment) => ({
				task: assignment.task.trim(),
				scope: assignment.scope,
			}));
			const tasks = assignments.map((assignment) => assignment.task).filter(Boolean);
			if (!exploreScope) {
				return {
					content: [{ type: "text", text: "Error: exploreScope is required." }],
					details: dispatchDetails("", undefined, [], "error") as unknown as SubagentDetails,
					isError: true,
				};
			}
			if (tasks.length === 0) {
				return {
					content: [{ type: "text", text: "Error: tasks must contain at least one non-empty task." }],
					details: dispatchDetails("", undefined, [], "error") as unknown as SubagentDetails,
					isError: true,
				};
			}
			const missingScope = assignments.find((assignment) => !hasEditScope(assignment.scope));
			if (missingScope) {
				return {
					content: [{ type: "text", text: "Error: every task must include a non-empty edit scope." }],
					details: dispatchDetails("", undefined, [], "error") as unknown as SubagentDetails,
					isError: true,
				};
			}

			const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
			const maxDepth = getMaxDepth();
			if (depth >= maxDepth) {
				return {
					content: [{ type: "text", text: `Maximum subagent depth (${maxDepth}) reached — refusing to dispatch.` }],
					details: dispatchDetails("", undefined, [], "error") as unknown as SubagentDetails,
					isError: true,
				};
			}

			const maxSubagents = getMaxSubagents();
			if (tasks.length > maxSubagents) {
				return {
					content: [{ type: "text", text: `This dispatch has ${tasks.length} tasks, but maxSubagents is ${maxSubagents}. Split the tasks into smaller dispatches or raise the limit.` }],
					details: dispatchDetails("", undefined, [], "error") as unknown as SubagentDetails,
					isError: true,
				};
			}
			if (countRunningSubagents() >= maxSubagents) {
				return {
					content: [{ type: "text", text: `Maximum concurrent subagents reached (${countRunningSubagents()}/${maxSubagents}). Wait for an agent to finish before dispatching.` }],
					details: dispatchDetails("", undefined, [], "error") as unknown as SubagentDetails,
					isError: true,
				};
			}

			const dispatchId = newSubagentId();
			const commonParams = {
				model: params.model,
				systemPrompt: params.systemPrompt,
				cwd: params.cwd,
				tools: params.tools,
			};
			// One task does not need a shared exploration pass.
			if (tasks.length === 1) {
				const record = createSubagentRecord(ctx, { ...commonParams, scope: assignments[0].scope }, "task", tasks[0]);
				saveRecord(record);
				const started = await startBackground(pi, ctx, record, tasks[0]);
				if (!started.started) {
					record.status = "error";
					record.lastError = started.error;
					saveRecord(record);
					return {
						content: [{ type: "text", text: started.error ?? "Failed to start task agent." }],
						details: dispatchDetails(dispatchId, undefined, [record.id], "error") as unknown as SubagentDetails,
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `Single-task fast path: spawned ${record.id} in the background. No explorer was created.` }],
					details: dispatchDetails(dispatchId, undefined, [record.id], "running") as unknown as SubagentDetails,
				};
			}

			const explorer = createSubagentRecord(
				ctx,
				commonParams,
				"explorer",
				buildExplorerPrompt(exploreScope, tasks),
			);
			const taskRecords = assignments.map((assignment) =>
				createSubagentRecord(ctx, { ...commonParams, scope: assignment.scope }, "task", assignment.task, explorer.id),
			);
			saveRecord(explorer);
			for (const record of taskRecords) saveRecord(record);
			const taskIds = taskRecords.map((record) => record.id);
			const explorerTask = explorer.task!;
			const launchTasks = async () => {
				if (explorer.status === "error") return;
				const sourcePath = sessionFileForRecord(explorer);
				for (const record of taskRecords) {
					const started = await startBackground(
						pi,
						ctx,
						record,
						buildTaskPrompt(record.task!),
						sourcePath,
					);
					if (!started.started) {
						record.status = "error";
						record.lastError = started.error;
						saveRecord(record);
						try {
							pi.sendUserMessage(`[subagent dispatch ${dispatchId}] Could not start task ${record.id}: ${started.error ?? "unknown error"}`, { deliverAs: "steer" });
						} catch {

						}
					}
				}
			};

			const started = await startBackground(pi, ctx, explorer, explorerTask, undefined, launchTasks);
			if (!started.started) {
				explorer.status = "error";
				explorer.lastError = started.error;
				saveRecord(explorer);
				return {
					content: [{ type: "text", text: started.error ?? "Failed to start exploration agent." }],
					details: dispatchDetails(dispatchId, explorer.id, taskIds, "error") as unknown as SubagentDetails,
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Dispatch ${dispatchId} started: explorer ${explorer.id} will inspect the scope in the background, then ${taskRecords.length} task agent(s) will be forked from its session. Tasks: ${taskIds.join(", ")}` }],
				details: dispatchDetails(dispatchId, explorer.id, taskIds, "running") as unknown as SubagentDetails,
			};
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Subagent Send",
		description:
			"Push a follow-up message to a spawned subagent (subagentId from subagent_spawn). The subagent continues its private session, so it keeps full context of its previous work. Use this to steer, redirect, ask for more detail, or assign follow-up work. Always async: it returns immediately, the subagent runs the steering turn in the background, and the complete result auto-bubbles when it finishes. Only works when the subagent is not currently running.",
		promptSnippet: "Send a steering message to a subagent",
		promptGuidelines: [
			"When a subagent errors (you receive a subagent-error message or a failed result), resolve it by steering it with subagent_send (it resumes with full context) or respawning with subagent_spawn; use subagent_result to inspect the transcript first.",
			"subagent_send is async — it returns immediately and the complete completion message auto-bubbles; keep working while it runs.",
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
			if (record.status === "running" || record.status === "planned") {
				return {
					content: [
						{
							type: "text",
							text:
								record.status === "planned"
									? `Subagent ${params.subagentId} is queued behind its shared exploration agent. Wait until it starts before steering it.`
									: `Subagent ${params.subagentId} is currently running. Wait until it finishes, then send the steering message.`,
						},
					],
					details: { subagentId: params.subagentId, output: "", status: record.status, usage: record.totalUsage } as SubagentDetails,
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
			out.push(`Running: ${runningNow}/${maxSubagents} subagents · total spawned: ${records.length} · maxDepth: ${getMaxDepth()} layers`);
			if (records.length === 0) {
				out.push("No subagents spawned yet. Use subagent_spawn to delegate work.");
			} else {
				out.push(`${records.length} subagent(s):`);
				for (const rec of records) {
					const usage = formatUsage(rec.totalUsage, rec.model);
					out.push(
						`- ${rec.id} [${rec.status}] · role: ${rec.role ?? "task"} · model: ${rec.model ?? "session"} · created: ${new Date(rec.createdAt).toLocaleString()}` +
							(rec.parentSubagentId ? `\n  parent/explorer: ${rec.parentSubagentId}` : "") +
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
			out.push(
				`Default edit scope: ${cfg.scope ? (Array.isArray(cfg.scope) ? cfg.scope.join(", ") : cfg.scope) : "(none — full access)"}`,
			);
			out.push(`Allow temp writes: ${cfg.allowTmp === false ? "no" : "yes"}`);
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
						"Usage: /subagent config [maxDepth <n> | maxSubagents <n> | scope <path> | allowTmp yes|no] — no args opens the settings panel.",
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
					ctx.ui.notify(`Subagent ${id} is still running — wait for its completion notification.`, "warning");
					return;
				}
				if (ctx.hasUI) ctx.ui.setStatus("subagent", `sending to ${id}...`);
				const result = await runAndRecord(rec, message, ctx.signal, undefined, undefined, childTaskBase(ctx, rec.id));
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
			if (ctx.hasUI) ctx.ui.setStatus("subagent", "");
			if (!result.ok) {
				ctx.ui.notify(result.error ?? "Subagent failed", "error");
				return;
			}
			ctx.ui.notify(`[subagent ${record.id}] ${(result.output ?? "").slice(0, 600)}`, "info");
		},
	});
}


interface PickerModel {
	provider: string;
	id: string;
	label: string;
	name: string;
}


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

	}
	return [...map.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}


function findExactModel(ctx: ExtensionCommandContext, arg: string): string | undefined {
	const q = arg.trim().toLowerCase();
	return collectModels(ctx).find((m) => m.label.toLowerCase() === q)?.label;
}


function sessionModelLabel(ctx: ExtensionCommandContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
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


async function showSubagentConfigUi(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {

		const cfg = loadConfig();
		const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
		ctx.ui.notify(
			`model: ${cfg.model ?? "(inherit)"} (session: ${sessionModel})\n` +
				`maxDepth (layers): ${getMaxDepth()} · maxSubagents: ${getMaxSubagents()} (running ${countRunningSubagents()})\n` +
				`scope: ${cfg.scope ? (Array.isArray(cfg.scope) ? cfg.scope.join(", ") : cfg.scope) : "(none)"} · allowTmp: ${cfg.allowTmp === false ? "no" : "yes"}\n` +
				`cwd: ${cfg.cwd ?? "(inherit)"}\ntools: ${cfg.tools ?? "(all)"}\n` +
				`file: ${configFile()}`,
			"info",
		);
		return;
	}

	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {

		const draft: SubagentConfig = { ...loadConfig() };
		let dirty = false;
		let savedAt = 0;
		const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
		const effectiveModel = draft.model ?? sessionModel ?? "(none)";
		const rowValue = (id: string) =>
			id === "maxDepth" ? String(draft.maxDepth ?? getMaxDepth()) : String(draft.maxSubagents ?? getMaxSubagents());


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
		let selectedRowIndex = 0;
		let digitInput = "";

		const refreshRow = (id: string) => settingsList.updateValue(id, rowValue(id));

		const commitNumber = () => {
			const id = items[selectedRowIndex].id;
			const n = Number(digitInput);
			if (numericIds.has(id) && Number.isInteger(n) && n >= 1) {
				if (id === "maxDepth") draft.maxDepth = n;
				else draft.maxSubagents = n;
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
			this.filterText = (this.filterText + ch).slice(0, FILTER_MAX_CHARS);
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
