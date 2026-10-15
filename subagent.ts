

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import {
	Container,
	matchesKey,
	SettingsList,
	Text,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_MAX_SUBAGENTS = 4;
const PREVIEW_CHARS = 200;
const DETAIL_CHARS = 300;
const KILL_GRACE_MS = 5000;
const RESUME_WAIT_MS = 3000;
const DEFAULT_MAX_AUTO_RESUMES = 3;
const FLUSH_DELAY_MS = 50;
const SESSION_START_FLUSH_DELAY_MS = 200;
const FLUSH_INTERVAL_MS = 30_000;
const SETTINGS_MAX_VISIBLE = 10;

/** Default model used for opencode-backed subagents (one of OpenCode's free models). */
const DEFAULT_OPENCODE_MODEL = "opencode/big-pickle";
/** Override with PI_OPENCODE_BIN when the opencode CLI is not on PATH. */
const OPENCODE_BIN = process.env.PI_OPENCODE_BIN || "opencode";

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

/**
 * Read a subagent's live edit scope from the scope file the parent refreshes on
 * every spawn and every scope change. The child re-reads it before each
 * write/edit, so the main agent can widen or narrow the scope of an already
 * running subagent without restarting it. Returns `found: false` when the file
 * is absent/unreadable so callers can fall back to the spawn-time env scope.
 */
function readLiveScope(): { found: boolean; scope?: string[]; allowTmp?: boolean } {
	const id = process.env.PI_SUBAGENT_ID;
	const dir = process.env.PI_SUBAGENT_DIR;
	if (!id || !dir) return { found: false };
	try {
		const raw = fs.readFileSync(path.join(path.resolve(dir), `${id}.scope`), "utf-8");
		const parsed = JSON.parse(raw) as { scope?: unknown; allowTmp?: unknown };
		const scope = Array.isArray(parsed.scope)
			? parsed.scope.filter((s): s is string => typeof s === "string" && s.length > 0)
			: [];
		return {
			found: true,
			scope: scope.length > 0 ? scope : undefined,
			allowTmp: typeof parsed.allowTmp === "boolean" ? parsed.allowTmp : undefined,
		};
	} catch {
		return { found: false };
	}
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

	bubbles?: Array<{ text: string }>;
}

interface SubagentRecord {
	/** Internal id; only for session-file management. Never shown to users or agents. */
	id: string;
	/** Short, unique, human-readable handle used by users and agents. */
	name: string;
	model?: string;
	task?: string;
	sessionPath?: string;
	/** Steering messages queued while the subagent was running; delivered as its next turn when the current run finishes. */
	pendingMessages?: string[];
	systemPrompt: string;
	cwd: string;
	tools?: string;

	/** Which runtime executes this subagent: the pi CLI (default) or the opencode CLI. */
	backend?: "pi" | "opencode";
	/** Persistent opencode ACP session id, so a later turn resumes the same conversation. */
	opencodeSessionId?: string;
	/** opencode turns started so far; the subagent preamble is injected on the first one only. */
	opencodeTurns?: number;

	scope?: string[];

	allowTmp?: boolean;
	status: SubagentStatus;
	pid?: number;

	/** Main session file that owns this subagent, so it can be found and resumed across sessions. */
	mainSessionFile?: string;
	/** Set while the run was intentionally stopped by a session switch/quit; suppresses finalize/notify so it stays resumable. */
	suspended?: boolean;
	/** Number of automatic resumes performed after interruptions (bounds retry loops). */
	resumeCount?: number;
	/** The userText of the turn currently in flight (diagnostics and resume fallback). */
	activeTask?: string;

	lastError?: string;

	donePushedAt?: number;
	createdAt: number;
	updatedAt: number;
	lastOutput: string;
	totalUsage: RunUsage;
}

interface SubagentDetails {
	name: string;
	/** All names for a multi-task spawn. */
	names?: string[];
	model?: string;
	output: string;
	status: SubagentStatus;
	usage: RunUsage;
}

interface SubagentConfig {
	model?: string;
	/** Default runtime for new subagents: the pi CLI (default) or the opencode CLI. */
	backend?: "pi" | "opencode";
	/** OpenCode model id used when the backend is opencode (default: a free model). */
	opencodeModel?: string;
	systemPrompt?: string;
	cwd?: string;
	tools?: string;

	maxSubagents?: number;
	/** Automatically resume interrupted subagents when a session is resumed/reloaded. Default true. */
	autoResume?: boolean;
	/** Maximum automatic resumes per subagent before it is marked as errored. Default 3. */
	maxAutoResumes?: number;

	scope?: string | string[];

	allowTmp?: boolean;
}

interface RunningEntry {
	proc: ChildProcess;
	done: Promise<RunResult>;
	rec: SubagentRecord;
	/** Set by subagent_interrupt so the completion handler skips finalize/notify on a killed run. */
	interrupted?: boolean;
	/** RPC transport control channel, used to abort gracefully and continue in the same process. */
	control?: RpcControl;
}

interface RpcControl {
	/** Additional agent runs queued on top of the current settle, so the process is not shut down early. */
	pendingContinuations: number;
	/** True once stdin has been closed and the child is shutting down. */
	closed: boolean;
	/** Send an RPC command and resolve with its correlated response. */
	sendCommand: (cmd: Record<string, unknown>) => Promise<any>;
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

function getAutoResume(): boolean {
	return loadConfig().autoResume !== false;
}

function getMaxAutoResumes(): number {
	const cfg = loadConfig();
	if (typeof cfg.maxAutoResumes === "number" && Number.isFinite(cfg.maxAutoResumes) && cfg.maxAutoResumes >= 0)
		return Math.floor(cfg.maxAutoResumes);
	return DEFAULT_MAX_AUTO_RESUMES;
}


function countRunningSubagents(): number {
	let count = 0;
	try {
		for (const file of fs.readdirSync(subagentDir())) {
			if (!file.endsWith(".json")) continue;
			try {
				const rec = JSON.parse(fs.readFileSync(path.join(subagentDir(), file), "utf-8")) as SubagentRecord;
				if (rec?.status !== "running") continue;
				// A run with no live pid (killed/quit/suspended) is not actually consuming a slot.
				if (rec.suspended || rec.pid == null) continue;
				try {
					process.kill(rec.pid, 0);
				} catch {
					continue;
				}
				count++;
			} catch {

			}
		}
	} catch {

	}
	return count;
}


type SubagentBackend = "pi" | "opencode";

/** Any model in the OpenCode CLI's namespace (free models and OpenCode Go). */
function isOpencodeModel(model: string | undefined | null): boolean {
	return !!model && /^opencode(-go)?\//.test(model);
}

/** Models that belong to the OpenCode CLI's own `opencode/` namespace. */
function isOpencodeCliModel(model: string | undefined | null): boolean {
	return !!model && /^opencode\//.test(model);
}

/**
 * True when pi has its own provider entry for a model. This keeps models from
 * pi's `opencode-go` provider (a paid subscription) on the pi backend instead of
 * routing them through the OpenCode CLI.
 */
function modelKnownToPi(ctx: ExtensionContext | undefined, model: string | undefined): boolean {
	if (!model || !model.includes("/")) return false;
	try {
		const [provider, ...rest] = model.split("/");
		return !!ctx?.modelRegistry?.find(provider, rest.join("/"));
	} catch {
		return false;
	}
}

/** The runtime a record uses, inferring it from the model for records written before backends existed. */
function backendOf(rec: Pick<SubagentRecord, "backend" | "model">): SubagentBackend {
	if (rec.backend) return rec.backend;
	return isOpencodeCliModel(rec.model) ? "opencode" : "pi";
}


function resolveSpawnOptions(
	ctx: ExtensionContext,
	params: { model?: string; systemPrompt?: string; cwd?: string; tools?: string; backend?: SubagentBackend },
): { model?: string; backend: SubagentBackend; systemPrompt: string; cwd: string; tools?: string } {
	const cfg = loadConfig();
	const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const systemPrompt = (params.systemPrompt ?? cfg.systemPrompt ?? "").trim();
	// A model means the OpenCode CLI backend only when it lives in the opencode/
	// namespace *and* pi has no provider entry for it (opencode-go/... is pi's own).
	const opencodeCliModel = (m?: string) => isOpencodeCliModel(m) && !modelKnownToPi(ctx, m);

	// Precedence: an explicit backend (param or config) wins; otherwise an
	// opencode/-namespaced model selects the opencode backend; otherwise pi.
	let backend: SubagentBackend;
	let model: string | undefined;
	const explicitBackend = params.backend ?? cfg.backend;
	if (explicitBackend) {
		backend = explicitBackend;
		model =
			params.model ??
			(backend === "opencode"
				? isOpencodeModel(cfg.model)
					? cfg.model
					: (cfg.opencodeModel ?? DEFAULT_OPENCODE_MODEL)
				: (cfg.model ?? sessionModel));
	} else if (opencodeCliModel(params.model)) {
		backend = "opencode";
		model = params.model;
	} else if (params.model) {
		backend = "pi";
		model = params.model;
	} else if (opencodeCliModel(cfg.model)) {
		backend = "opencode";
		model = cfg.model;
	} else {
		backend = "pi";
		model = cfg.model ?? sessionModel;
	}

	return {
		model,
		backend,
		systemPrompt: systemPrompt || DEFAULT_SUBAGENT_PROMPT,
		cwd: params.cwd ?? cfg.cwd ?? ctx.cwd,
		tools: params.tools ?? cfg.tools,
	};
}


let activeSubagentDir: string | undefined;
/** Absolute path of the main session that owns the subagents in the active scope. */
let currentMainSessionFile: string | undefined;
/** True after this extension instance has been torn down; blocks late deferred work. */
let extensionDisposed = false;

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

function scopeFile(id: string): string {
	return path.join(subagentDir(), `${id}.scope`);
}

/**
 * Persist the subagent's edit scope to a side file the child polls live. Written
 * atomically (tmp + rename) so a running child never reads a half-written file.
 */
function writeScopeFile(rec: SubagentRecord): void {
	try {
		const file = scopeFile(rec.id);
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ scope: rec.scope ?? [], allowTmp: rec.allowTmp !== false }), {
			encoding: "utf-8",
			mode: 0o600,
		});
		fs.renameSync(tmp, file);
	} catch {

	}
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
	if (!rec.sessionPath) rec.sessionPath = sessionFile(rec.id);
	if (!rec.mainSessionFile && currentMainSessionFile) rec.mainSessionFile = currentMainSessionFile;
	fs.writeFileSync(recordFile(rec.id), JSON.stringify(rec, null, 2), { encoding: "utf-8", mode: 0o600 });
}

function listRecords(): SubagentRecord[] {
	const records: SubagentRecord[] = [];
	try {
		for (const file of fs.readdirSync(subagentDir())) {
			if (!file.endsWith(".json")) continue;
			const rec = loadRecord(file.slice(0, -5));
			if (rec) records.push(rec);
		}
	} catch {

	}
	return records;
}

function sanitizeName(name: string | undefined): string | undefined {
	if (!name) return undefined;
	const cleaned = name.trim().replace(/\s+/g, " ").slice(0, 60);
	return cleaned || undefined;
}

/** The public handle for a subagent. Ids are internal and never shown. */
function recordLabel(rec: Pick<SubagentRecord, "name">): string {
	return rec.name || "(unnamed)";
}

/** Existing subagent names (lowercased) for uniqueness checks. */
function existingNames(): Set<string> {
	return new Set(listRecords().map((r) => r.name?.toLowerCase()).filter((n): n is string => !!n));
}

/** Return a name unique against `taken`, adding it to `taken` (case-insensitive). */
function uniqueName(base: string | undefined, taken: Set<string>): string {
	const root = sanitizeName(base) ?? "subagent";
	let candidate = root;
	let n = 2;
	while (taken.has(candidate.toLowerCase())) candidate = `${root} ${n++}`;
	taken.add(candidate.toLowerCase());
	return candidate;
}

/** Resolve a subagent by exact name (case-insensitive) or a unique name prefix. */
function findRecordByName(name: string): SubagentRecord | undefined {
	const target = name.trim().toLowerCase();
	if (!target) return undefined;
	const all = listRecords();
	const exact = all.find((r) => r.name?.toLowerCase() === target);
	if (exact) return exact;
	const prefixed = all.filter((r) => r.name?.toLowerCase().startsWith(target));
	return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * Accept a value that should be a string array but may arrive as a JSON string:
 * some models stringify array tool arguments. Returns undefined when unusable.
 */
function toStringArray(value: unknown): string[] | undefined {
	let arr: unknown = value;
	if (typeof arr === "string") {
		const s = arr.trim();
		if (!s) return undefined;
		try {
			arr = JSON.parse(s);
		} catch {
			arr = s.split(/[\n,]+/).map((x) => x.trim());
		}
	}
	if (!Array.isArray(arr)) return undefined;
	const out = arr.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
	return out.length > 0 ? out : undefined;
}

interface TaskAssignment {
	task: string;
	name?: string;
	scope?: string | string[];
}

/**
 * Normalize the `tasks` argument. Accepts an array of task objects/strings, or a
 * JSON-encoded array string (models that stringify their arguments).
 */
function toAssignments(value: unknown): TaskAssignment[] {
	let arr: unknown = value;
	if (typeof arr === "string") {
		const s = arr.trim();
		try {
			arr = JSON.parse(s);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(arr)) return [];
	const out: TaskAssignment[] = [];
	for (const item of arr) {
		if (typeof item === "string") {
			const task = item.trim();
			if (task) out.push({ task });
			continue;
		}
		if (item && typeof item === "object") {
			const o = item as { task?: unknown; name?: unknown; scope?: unknown };
			const task = (typeof o.task === "string" ? o.task : String(o.task ?? "")).trim();
			if (!task) continue;
			out.push({
				task,
				name: sanitizeName(typeof o.name === "string" ? o.name : undefined),
				scope: o.scope as string | string[] | undefined,
			});
		}
	}
	return out;
}

function isPidAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string })?.code === "EPERM";
	}
}

async function waitForPidExit(pid: number | undefined, timeoutMs: number): Promise<void> {
	if (!pid) return;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && isPidAlive(pid)) await sleep(50);
	if (isPidAlive(pid)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {

		}
	}
}

function sessionFileOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile() ?? undefined;
	} catch {
		return undefined;
	}
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
	onBubble?: (bubble: { text: string }) => void,
	taskBase?: string,
): Promise<{ proc: ChildProcess; done: Promise<RunResult>; control: RpcControl }> {
	const args: string[] = ["--mode", "rpc", "--session", sessionFileForRecord(rec)];
	if (rec.model) args.push("--model", rec.model);

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

		}
	};
	const closeStdin = () => {
		if (stdinClosed) return;
		stdinClosed = true;
		control.closed = true;
		try {
			proc?.stdin?.end();
		} catch {

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
				if (event.type === "extension_ui_request" && (event.method === "select" || event.method === "confirm" || event.method === "input" || event.method === "editor")) {
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

		}
		try {
			fs.rmdirSync(tmp.dir);
		} catch {

		}
	});

	return { proc: proc!, done, control };
}


/**
 * First-turn preamble for an opencode subagent. opencode keeps its own system
 * prompt and the ACP protocol has no "append system prompt" hook, so the
 * subagent framing, working directory, and edit scope are prepended to the
 * first user message instead. Later turns reuse the same opencode session, so
 * the preamble stays in its history and is not repeated.
 */
function buildOpencodeFirstPrompt(rec: SubagentRecord, userText: string): string {
	const sections: string[] = [rec.systemPrompt];
	const context: string[] = [`Working directory: ${rec.cwd}`];
	if (rec.scope && rec.scope.length > 0) {
		context.push(
			`Edit scope: only create or modify files under ${rec.scope.join(", ")}. Reads are unrestricted. ` +
				`If the task seems to require writing elsewhere, say so instead of doing it.`,
		);
	}
	if (rec.tools) {
		context.push(`Prefer these tools when possible: ${rec.tools}.`);
	}
	sections.push(`[subagent context]\n${context.join("\n")}`);
	sections.push(userText);
	return sections.filter((s) => s && s.trim()).join("\n\n");
}


/**
 * Spawn a subagent backed by the OpenCode CLI (`opencode acp`), driven over the
 * Agent Client Protocol (newline-delimited JSON-RPC on stdio).
 *
 * This is how pi can use OpenCode's models — including its free models that are
 * rejected when called directly — because the model request originates inside
 * the opencode process. opencode runs its own agent loop and tools; pi receives
 * the final assistant text.
 *
 * The returned shape matches {@link spawnSubagentProcess} so the completion
 * handler, budget checks, interrupt path, and notifications are shared:
 *   - `control.sendCommand({ type: "abort" })` cancels the in-flight turn.
 *   - `control.sendCommand({ type: "prompt", message })` starts the next turn on
 *     the same opencode session (used by subagent_interrupt to steer in place).
 *
 * The opencode session id is persisted on the record so a later turn or an
 * auto-resume loads the same conversation via `session/load`.
 */
async function spawnOpencodeProcess(
	rec: SubagentRecord,
	userText: string,
	_depth: number,
	signal: AbortSignal | undefined,
	onUpdate?: (text: string) => void,
	_onBubble?: (bubble: { text: string }) => void,
	_taskBase?: string,
): Promise<{ proc: ChildProcess; done: Promise<RunResult>; control: RpcControl }> {
	const result: RunResult = {
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: EMPTY_USAGE(),
		bubbles: [],
	};

	let proc: ChildProcess | undefined;
	let stdinClosed = false;
	let seq = 0;
	let sessionId: string | undefined;
	let currentText = "";
	let turnInFlight: Promise<unknown> | undefined;
	const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();

	const write = (message: Record<string, unknown>) => {
		try {
			if (!stdinClosed && proc?.stdin?.writable) proc.stdin.write(`${JSON.stringify(message)}\n`);
		} catch {

		}
	};
	const notify = (method: string, params: Record<string, unknown>) => write({ jsonrpc: "2.0", method, params });
	const request = (method: string, params: Record<string, unknown>) => {
		const id = `oc-${++seq}`;
		return new Promise<any>((resolve, reject) => {
			pending.set(id, { resolve, reject });
			write({ jsonrpc: "2.0", id, method, params });
		});
	};
	const closeStdin = () => {
		if (stdinClosed) return;
		stdinClosed = true;
		control.closed = true;
		try {
			proc?.stdin?.end();
		} catch {

		}
	};

	const finishTurn = (text: string, response: any) => {
		result.usage.turns += 1;
		const usage = response?.usage;
		if (usage) {
			result.usage.input += usage.inputTokens || 0;
			result.usage.output += usage.outputTokens || 0;
			result.usage.cacheRead += usage.cachedReadTokens || 0;
			result.usage.contextTokens = usage.totalTokens || result.usage.contextTokens;
		}
		if (!result.model && rec.model) result.model = rec.model;
		const stopReason = typeof response?.stopReason === "string" ? response.stopReason : undefined;
		if (stopReason) result.stopReason = stopReason;
		result.messages.push({
			role: "assistant",
			content: [{ type: "text", text: text || "(no output)" }],
			model: rec.model,
			stopReason,
		} as unknown as Message);
		if (onUpdate) onUpdate(text || "(working...)");
		// A settle consumes one reserved continuation (an interrupt that aborted a
		// turn and queued a follow-up); otherwise the process is done for this turn.
		if (control.pendingContinuations > 0) control.pendingContinuations -= 1;
		else closeStdin();
	};

	const startTurn = (message: string) => {
		currentText = "";
		const turn = request("session/prompt", { sessionId, prompt: [{ type: "text", text: message }] })
			.then((response) => finishTurn(currentText, response))
			.catch((error) => {
				if (result.exitCode === 0) result.exitCode = 1;
				result.errorMessage =
					result.errorMessage || `opencode turn failed: ${error instanceof Error ? error.message : String(error)}`;
				closeStdin();
			});
		turnInFlight = turn;
		turn.finally(() => {
			if (turnInFlight === turn) turnInFlight = undefined;
		});
		return turn;
	};

	const control: RpcControl = {
		pendingContinuations: 0,
		closed: false,
		sendCommand: async (cmd) => {
			try {
				if (cmd.type === "abort") {
					if (!sessionId || stdinClosed) return { success: false, error: "opencode session is not running" };
					notify("session/cancel", { sessionId });
					if (turnInFlight) {
						try {
							await turnInFlight;
						} catch {

						}
					}
					return { success: true };
				}
				if (cmd.type === "prompt") {
					if (!sessionId || stdinClosed) return { success: false, error: "opencode session is not running" };
					startTurn(String(cmd.message ?? ""));
					return { success: true };
				}
				return { success: false, error: `unsupported command: ${String(cmd.type)}` };
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};

	const handleUpdate = (update: any) => {
		if (!update) return;
		if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
			const text = String(update.content.text ?? "");
			if (text) {
				currentText += text;
				if (onUpdate) onUpdate(currentText);
			}
		}
	};

	const handleClientRequest = (message: any) => {
		try {
			switch (message.method) {
				case "session/request_permission": {
					const options: any[] = Array.isArray(message.params?.options) ? message.params.options : [];
					const pick =
						options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once") ?? options[0];
					write({
						jsonrpc: "2.0",
						id: message.id,
						result: pick
							? { outcome: { outcome: "selected", optionId: pick.optionId } }
							: { outcome: { outcome: "cancelled" } },
					});
					return;
				}
				case "fs/read_text_file": {
					write({
						jsonrpc: "2.0",
						id: message.id,
						result: { content: fs.readFileSync(String(message.params?.path), "utf-8") },
					});
					return;
				}
				case "fs/write_text_file": {
					fs.writeFileSync(String(message.params?.path), String(message.params?.content ?? ""));
					write({ jsonrpc: "2.0", id: message.id, result: {} });
					return;
				}
				case "elicitation/create": {
					write({ jsonrpc: "2.0", id: message.id, result: { action: "cancel" } });
					return;
				}
				default:
					write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unsupported client method: ${message.method}` } });
			}
		} catch (error) {
			write({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
			});
		}
	};

	const done = new Promise<RunResult>((resolve) => {
		proc = spawn(OPENCODE_BIN, ["acp"], {
			cwd: rec.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});
		let buffer = "";
		let stderrBuffer = "";

		const handleMessage = (message: any) => {
			if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
				const entry = pending.get(message.id);
				if (entry) {
					pending.delete(message.id);
					if (message.error) entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
					else entry.resolve(message.result);
				}
				return;
			}
			if (message.method && message.id !== undefined) {
				handleClientRequest(message);
				return;
			}
			if (message.method === "session/update") handleUpdate(message.params?.update);
		};

		proc.stdout!.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let message: any;
				try {
					message = JSON.parse(line);
				} catch {
					result.stderr += line + "\n";
					continue;
				}
				handleMessage(message);
			}
		});
		proc.stderr!.on("data", (data) => {
			stderrBuffer += data.toString();
			const lines = stderrBuffer.split("\n");
			stderrBuffer = lines.pop() || "";
			for (const line of lines) if (line.trim()) result.stderr += line + "\n";
		});
		proc.on("close", (code) => {
			if (buffer.trim()) {
				try {
					handleMessage(JSON.parse(buffer));
				} catch {

				}
			}
			if (stderrBuffer.trim()) result.stderr += stderrBuffer + "\n";
			result.exitCode = result.exitCode || (code ?? 0);
			resolve(result);
		});
		proc.on("error", (error) => {
			result.exitCode = 1;
			result.errorMessage =
				result.errorMessage || `Failed to launch ${OPENCODE_BIN}: ${error instanceof Error ? error.message : String(error)}`;
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

		void (async () => {
			try {
				await request("initialize", {
					protocolVersion: 1,
					clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
				});

				let createdNew = false;
				if (rec.opencodeSessionId) {
					try {
						await request("session/load", { sessionId: rec.opencodeSessionId, cwd: rec.cwd, mcpServers: [] });
						sessionId = rec.opencodeSessionId;
					} catch {
						rec.opencodeSessionId = undefined;
					}
				}
				if (!sessionId) {
					const created = await request("session/new", { cwd: rec.cwd, mcpServers: [] });
					sessionId = String(created?.sessionId ?? "");
					if (!sessionId) throw new Error("opencode did not return a session id");
					rec.opencodeSessionId = sessionId;
					createdNew = true;
					saveRecord(rec);
				}

				if (rec.model) {
					try {
						await request("session/set_config_option", { sessionId, configId: "model", value: rec.model });
					} catch {
						// Unknown/unavailable model id: keep opencode's default rather than failing the turn.
					}
				}
				// Ensure edits are allowed; a restored session could have been left in plan mode.
				try {
					await request("session/set_config_option", { sessionId, configId: "mode", value: "build" });
				} catch {

				}

				const isFirstTurn = createdNew || !rec.opencodeTurns;
				rec.opencodeTurns = (rec.opencodeTurns ?? 0) + 1;
				saveRecord(rec);
				startTurn(isFirstTurn ? buildOpencodeFirstPrompt(rec, userText) : userText);
			} catch (error) {
				result.exitCode = 1;
				result.errorMessage = error instanceof Error ? error.message : String(error);
				closeStdin();
			}
		})();
	});

	return { proc: proc!, done, control };
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
	rec.suspended = false;
	rec.activeTask = undefined;
	saveRecord(rec);
	return { output, failed: isFailedRun(run) };
}


const running = new Map<string, RunningEntry>();


function buildCompletionText(rec: SubagentRecord): string {
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


function notifyDone(pi: ExtensionAPI, ctx: ExtensionContext, rec: SubagentRecord) {
	const text = buildCompletionText(rec);
	const brief = rec.status === "error" ? `Subagent ${recordLabel(rec)} error` : `Subagent ${recordLabel(rec)} done`;
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
	if (extensionDisposed) return;
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


function buildResumePrompt(rec: SubagentRecord): string {
	const sessionPath = rec.sessionPath ?? sessionFileForRecord(rec);
	let hasSession = false;
	if (backendOf(rec) === "opencode") {
		// The opencode session lives in opencode's own store and is reloaded by id.
		hasSession = !!rec.opencodeSessionId;
	} else {
		try {
			hasSession = !!sessionPath && fs.existsSync(sessionPath);
		} catch {

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

async function reconcileAndAutoResume(api: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (isSubagentProcess || !getAutoResume()) return;
	const candidates = listRecords().filter((r) => r.status === "running");
	if (candidates.length === 0) return;

	const maxResumes = getMaxAutoResumes();
	const maxConcurrent = getMaxSubagents();
	let live = countRunningSubagents();
	const resumed: string[] = [];
	const skipped: string[] = [];

	for (const rec of candidates) {
		// A live pid means a previous pi process was hard-killed and left an orphan we
		// cannot reattach to. Stop it, then resume from its persisted session file.
		if (isPidAlive(rec.pid)) {
			try {
				process.kill(rec.pid!, "SIGTERM");
			} catch {

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
		if (live >= maxConcurrent) {
			skipped.push(rec.id);
			continue;
		}
		if (await resumeInterrupted(api, ctx, rec)) {
			live++;
			resumed.push(rec.id);
		} else {
			skipped.push(rec.id);
		}
	}

	if (resumed.length > 0) {
		try {
			ctx.ui.notify(`Auto-resumed ${resumed.length} interrupted subagent(s) after session resume.`, "info");
		} catch {

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

		}
	} else if (skipped.length > 0) {
		try {
			ctx.ui.notify(`Found ${skipped.length} interrupted subagent(s) but did not resume them (limit or concurrency).`, "warning");
		} catch {

		}
	}
}

/** Stop every in-flight child process without finalizing it, so it can be resumed later. */
function suspendAllRunning(): void {
	for (const entry of running.values()) {
		// Mutate the same record object the completion handler closes over, so its
		// suspended check sees the flag and skips finalize/notify.
		entry.rec.suspended = true;
		entry.rec.pid = undefined;
		saveRecord(entry.rec);
		try {
			entry.proc.kill("SIGTERM");
		} catch {

		}
	}
	running.clear();
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
	rec.suspended = false;
	rec.activeTask = userText;
	saveRecord(rec);

	let proc: ChildProcess;
	let done: Promise<RunResult>;
	let control: RpcControl | undefined;
	try {
		const spawnFn = backendOf(rec) === "opencode" ? spawnOpencodeProcess : spawnSubagentProcess;
		const spawned = await spawnFn(
			rec,
			userText,
			0,
			undefined,
			undefined,
			(bubble) => {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[subagent ${recordLabel(rec)}] ${firstLine(bubble.text).slice(0, PREVIEW_CHARS)}`,
						"info",
					);
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

	done.then(async (run) => {
		running.delete(rec.id);
		if (rec.suspended || entry.interrupted) {
			// Intentionally stopped (session switch/quit/interrupt): keep it
			// resumable rather than finalizing it as an error or a completion.
			rec.pid = undefined;
			saveRecord(rec);
			return;
		}
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
async function interruptRunning(rec: SubagentRecord, message: string): Promise<"aborted" | "restarted" | "idle"> {
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

		}
		const escalate = setTimeout(() => {
			try {
				if (entry.proc.exitCode === null) entry.proc.kill("SIGKILL");
			} catch {

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
	task: Type.Optional(Type.String({ description: "The task to delegate to the subagent (use tasks for multiple)." })),
	name: Type.Optional(
		Type.String({
			description: "Short, unique, human-readable name for this subagent (required). Used as its handle in listings, notifications, and subagent_interrupt/result/forget.",
		}),
	),
	tasks: Type.Optional(
		Type.Union([
			Type.Array(
				Type.Object({
					task: Type.String({ description: "The implementation task for this subagent.", minLength: 1 }),
					name: Type.String({ description: "Short, unique, human-readable name for this subagent." }),
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
			Type.String({ description: "A JSON-encoded array of task objects (accepted for models that stringify array arguments)." }),
		]),
	),
	prefillReads: Type.Optional(
		Type.Union([
			Type.Array(
				Type.String({
					description:
						"File paths to read once now and inject verbatim into every spawned subagent's context (before the task), so subagents don't each issue their own reads. The identical prefix maximizes provider prompt-cache hits across parallel subagents.",
				}),
				{ minItems: 1 },
			),
			Type.String({ description: "A JSON-encoded array of file paths (accepted for models that stringify array arguments)." }),
		]),
	),
	systemPrompt: Type.Optional(Type.String({ description: "Override the subagent system prompt (advanced)" })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override in provider/id form. Defaults to the user-configured model (/subagent model), falling back to the session model. An `opencode/...` id (e.g. opencode/big-pickle) selects the opencode backend automatically.",
		}),
	),
	backend: Type.Optional(
		Type.Union([Type.Literal("pi"), Type.Literal("opencode")], {
			description:
				"Which runtime executes the subagent. 'pi' (default) runs a pi subagent; 'opencode' drives the OpenCode CLI over ACP, using OpenCode's models — including its free models. Takes precedence over the configured backend and model.",
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

const ScopeParams = Type.Object({
	name: Type.String({ description: "Name returned by subagent_spawn" }),
	scope: Type.Optional(
		Type.Union([
			Type.String({
				description: "Directory or file path the subagent may edit (relative paths resolve against the subagent's cwd).",
			}),
			Type.Array(Type.String({ description: "A directory or file path the subagent may edit." }), { minItems: 1 }),
		]),
	),
	clear: Type.Optional(Type.Boolean({ description: "Remove the edit scope entirely, restoring unrestricted writes." })),
	allowTmp: Type.Optional(
		Type.Boolean({ description: "Whether writes to the system temp dir are allowed while a scope is set." }),
	),
});

const InterruptParams = Type.Object({
	name: Type.String({ description: "Name returned by subagent_spawn" }),
	message: Type.String({ description: "The urgent instruction to deliver immediately after interrupting the subagent" }),
});

const ListParams = Type.Object({});

const ResultParams = Type.Object({
	name: Type.String({ description: "Name returned by subagent_spawn" }),
});

const ForgetParams = Type.Object({
	name: Type.String({ description: "Name returned by subagent_spawn" }),
});

const ConfigParams = Type.Object({});


export default function (pi: ExtensionAPI) {
	extensionDisposed = false;

	pi.on("session_shutdown", () => {
		// A session replacement (switch/reload/new/fork) or a quit tears this extension
		// instance down. Mark in-flight runs suspended so their close handlers don't
		// finalize them, then stop the children. Interrupted runs are resumed by
		// reconcileAndAutoResume on the next session_start.
		extensionDisposed = true;
		suspendAllRunning();
	});


	let lastFlushCtx: ExtensionContext | undefined;
	const scheduleFlush = (ctx: ExtensionContext, delayMs: number) => {
		lastFlushCtx = ctx;
		setTimeout(() => {
			if (extensionDisposed) return;
			flushPendingNotifications(pi, ctx);
		}, delayMs);
	};
	pi.on("session_start", async (_event, ctx) => {
		activeSubagentDir = process.env.PI_SUBAGENT_DIR
			? path.resolve(process.env.PI_SUBAGENT_DIR)
			: path.join(getAgentDir(), "subagents", sessionScopeKey(ctx));
		currentMainSessionFile = sessionFileOf(ctx);
		fs.mkdirSync(activeSubagentDir, { recursive: true });
		scheduleFlush(ctx, SESSION_START_FLUSH_DELAY_MS);
		if (!isSubagentProcess) {
			await reconcileAndAutoResume(pi, ctx);
		}
	});
	pi.on("agent_end", (_event, ctx) => scheduleFlush(ctx, FLUSH_DELAY_MS));
	const flushTimer = setInterval(() => {
		if (!lastFlushCtx || extensionDisposed) return;
		try {
			flushPendingNotifications(pi, lastFlushCtx);
		} catch {

		}
	}, FLUSH_INTERVAL_MS);
	pi.on("session_shutdown", () => clearInterval(flushTimer));


	if (isSubagentProcess) {
		const envScope = toStringArray(process.env.PI_SUBAGENT_SCOPE);
		const envBlockTmp = process.env.PI_SUBAGENT_SCOPE_BLOCK_TMP === "1";
		const tmpDir = os.tmpdir();
		const taskBoardFile = process.env.PI_TASK_BASE ? path.resolve(path.join(process.env.PI_TASK_BASE, "TASK.md")) : undefined;
		// Always registered inside a subagent so a scope added/changed later (via
		// subagent_scope) takes effect live, even for a subagent spawned without one.
		pi.on("tool_call", (event, ctx) => {
			if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
			const target = (event.input as { path?: string }).path;
			if (!target) return undefined;
			const live = readLiveScope();
			const scope = live.found ? live.scope : envScope;
			if (!scope || scope.length === 0) return undefined;
			const blockTmp = live.found && typeof live.allowTmp === "boolean" ? !live.allowTmp : envBlockTmp;
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


	if (isSubagentProcess) {
		// pi redirects extension stdout to stderr in non-interactive modes, so write
		// directly to stderr to keep this channel reliable (the parent parses it).
		const bubble = (message: string) => {
			try {
				process.stderr.write(
					JSON.stringify({ type: "subagent_bubble", content: message }) + "\n",
				);
			} catch {

			}
		};
		pi.registerTool({
			name: "subagent_message",
			label: "Subagent Message",
			description:
				"Send a message back to the main agent. The main agent sees it (and can act on it) in its next turn. Use it for progress updates, findings, questions, blockers, or anything the main agent should know or decide.",
			promptSnippet: "Send a message back to the main agent",
			parameters: Type.Object({
				message: Type.String({ description: "The message to send to the main agent" }),
			}),
			async execute(_toolCallId, params) {
				bubble(params.message);
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
	}


	pi.registerTool({
		name: "subagent_spawn",
		label: "Subagent Spawn",
		description:
			"Spawn subagent(s) to work in isolated contexts (their own sessions). Pass task + name for one background subagent. Pass tasks (array of { task, name, scope? }) to spawn one background subagent per task. Provide exactly one of task or tasks, and a name for every subagent (names must be unique). All spawns are asynchronous: the tool returns immediately and you are notified when each subagent finishes. Subagents run on pi by default; pass backend: \"opencode\" (or an opencode/... model) to run them on the OpenCode CLI instead.",
		promptSnippet: "Spawn isolated subagent(s) to delegate work to",
		promptGuidelines: [
			"Always give every subagent a short unique name via name (single) or tasks[].name. The name is its handle in listings and notifications, and is what subagent_interrupt/subagent_result/subagent_forget use.",
			"Pass tasks (array of { task, name?, scope? }) to run several independent subagents in parallel; each runs in the background with automatic completion notifications.",
			"When multiple subagents need the same files, pass prefillReads (file paths): the files are read once and injected verbatim, identically, into every spawned subagent's context before the task — the subagents share that prompt-cache prefix instead of each issuing their own reads (better cache hits, fewer read calls).",
			"Spawns are always asynchronous: the tool returns immediately and the completion auto-bubbles. Keep working while subagents run.",
			"Give each task a narrow edit scope so the harness can block writes outside those files or directories — use this to keep parallel subagents from colliding on the same files.",
			"To run a subagent on OpenCode instead of pi, pass backend: \"opencode\" (or a model id like \"opencode/big-pickle\"). OpenCode runs as a separate agent with its own tools, including OpenCode's free models; give it a self-contained task since its transcript is not pi's.",
			"Use subagent_interrupt to steer a running subagent urgently — it kills the current turn and restarts it immediately with your message, keeping the subagent's full previous context.",
			"Change a subagent's edit scope after spawning with subagent_scope (it takes effect live, even mid-run).",
			"If a subagent errors, steer it to fix the error with subagent_interrupt or respawn it with subagent_spawn — don't just give up.",
			"Check subagent_config to see how many subagents are currently running vs the maxSubagents limit. Spawn only as many as you actually need.",
		],
		parameters: SpawnParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = params.task?.trim();
			const assignments = toAssignments(params.tasks);
			const prefillReads = toStringArray(params.prefillReads);

			if (task && assignments.length > 0) {
				return {
					content: [{ type: "text", text: "Error: pass either task (one subagent) or tasks (many), not both." }],
					details: { name: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}
			if (!task && assignments.length === 0) {
				return {
					content: [{ type: "text", text: "Error: task or tasks is required." }],
					details: { name: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}
			if (task && !sanitizeName(params.name)) {
				return {
					content: [{ type: "text", text: "Error: name is required — give this subagent a short unique name." }],
					details: { name: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}
			if (assignments.some((a) => !a.name)) {
				return {
					content: [{ type: "text", text: "Error: every task needs a name." }],
					details: { name: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
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
					details: { name: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
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
					details: { name: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
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
						details: { name: "", output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
						isError: true,
					};
				}
				const opts2 = resolveSpawnOptions(ctx, {
					model: params.model,
					backend: params.backend,
					systemPrompt: params.systemPrompt,
					cwd: params.cwd,
					tools: params.tools,
				});
				const cfg2 = loadConfig();
				const allowTmp2 = cfg2.allowTmp ?? true;
				const prefillBlock = buildPrefillBlock(prefillReads, opts2.cwd);
				const lines: string[] = [];
				const names: string[] = [];
				const taken = existingNames();
				for (const assignment of assignments) {
					const record: SubagentRecord = {
						id: newSubagentId(),
						name: uniqueName(assignment.name, taken),
						model: opts2.model,
						backend: opts2.backend,
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
					names.push(record.name);
					const userText = prefillBlock ? `${prefillBlock}\n\n${assignment.task}` : assignment.task;
					const bg = await startBackground(pi, ctx, record, userText);
					if (!bg.started) {
						record.status = "error";
						record.lastError = bg.error;
						saveRecord(record);
						lines.push(`- ${recordLabel(record)} [error] failed to start: ${bg.error ?? "unknown error"}`);
					} else {
						lines.push(
							`- ${recordLabel(record)} [running]${record.scope ? ` · scope: ${record.scope.join(", ")}` : ""} · ${firstLine(assignment.task)}`,
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
								`\nSteer with subagent_interrupt, inspect with subagent_result, forget with subagent_forget.`,
						},
					],
					details: {
						name: names[0] ?? "",
						names,
						model: opts2.model,
						output: "",
						status: "running",
						usage: EMPTY_USAGE(),
					} as SubagentDetails,
				};
			}

			const opts = resolveSpawnOptions(ctx, {
				model: params.model,
				backend: params.backend,
				systemPrompt: params.systemPrompt,
				cwd: params.cwd,
				tools: params.tools,
			});
			const cfg = loadConfig();
			const scope = normalizeScope(opts.cwd, params.scope ?? cfg.scope);
			const allowTmp = cfg.allowTmp ?? true;
			const prefillBlock = buildPrefillBlock(prefillReads, opts.cwd);

			const record: SubagentRecord = {
				id: newSubagentId(),
				name: uniqueName(sanitizeName(params.name), existingNames()),
				model: opts.model,
				backend: opts.backend,
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
			const bg = await startBackground(pi, ctx, record, userText);
			if (!bg.started) {
				record.status = "error";
				saveRecord(record);
				return {
					content: [{ type: "text", text: bg.error ?? "Failed to start subagent." }],
					details: {
						name: record.name,
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
							`Spawned subagent ${recordLabel(record)} in the background (model: ${record.model ?? "session model"}).\n` +
							(scope ? `Edit scope: ${scope.join(", ")} — writes outside are blocked.\n` : "") +
							`You will be notified when it finishes; read its transcript with subagent_result or redirect it with subagent_interrupt.`,
					},
				],
				details: {
					name: record.name,
					model: record.model,
					output: "",
					status: "running",
					usage: EMPTY_USAGE(),
				} as SubagentDetails,
			};
		},
	});


	pi.registerTool({
		name: "subagent_scope",
		label: "Subagent Scope",
		description:
			"Change a spawned subagent's edit scope (the directories/files its write/edit calls may touch). Paths resolve against the subagent's cwd; reads are always unrestricted. The change is live: an already-running subagent re-reads its scope before every write/edit, so no restart is needed. Use clear: true to remove the scope and restore full write access.",
		promptSnippet: "Change a subagent's edit scope",
		promptGuidelines: [
			"Use subagent_scope to widen or narrow a subagent's write scope after spawning — e.g. when parallel subagents need an extra shared file or one collided. It takes effect immediately, even for a running subagent.",
			"Pass scope as a directory or file path (or an array) to set it, or clear: true to allow writes anywhere again.",
		],
		parameters: ScopeParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const record = findRecordByName(params.name);
			if (!record) {
				return {
					content: [{ type: "text", text: `Unknown subagent "${params.name}". Spawn one first with subagent_spawn.` }],
					details: { name: params.name, output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}
			const clear = params.clear === true;
			const hasScope = params.scope !== undefined && params.scope !== null;
			if (!clear && !hasScope && typeof params.allowTmp !== "boolean") {
				return {
					content: [
						{
							type: "text",
							text: `Nothing to change. Pass scope: "<path>" (or an array), clear: true, or allowTmp: true|false.`,
						},
					],
					details: { name: record.name, output: "", status: record.status, usage: record.totalUsage } as SubagentDetails,
					isError: true,
				};
			}
			if (clear) {
				record.scope = undefined;
			} else if (hasScope) {
				const normalized = normalizeScope(record.cwd, params.scope as string | string[]);
				if (!normalized || normalized.length === 0) {
					return {
						content: [{ type: "text", text: "Error: scope must contain at least one path." }],
						details: { name: record.name, output: "", status: record.status, usage: record.totalUsage } as SubagentDetails,
						isError: true,
					};
				}
				record.scope = normalized;
			}
			if (typeof params.allowTmp === "boolean") record.allowTmp = params.allowTmp;
			saveRecord(record);
			writeScopeFile(record);
			const scopeText =
				record.scope && record.scope.length > 0 ? record.scope.join(", ") : "(none — writes unrestricted)";
			const live = record.status === "running" || running.has(record.id);
			return {
				content: [
					{
						type: "text",
						text:
							`Edit scope for subagent ${recordLabel(record)} is now: ${scopeText}` +
							(record.scope && record.scope.length > 0
								? ` (temp writes ${record.allowTmp === false ? "blocked" : "allowed"})`
								: "") +
							(live
								? `\nThe change is live: the running subagent re-reads its scope before every write/edit.`
								: `\nIt applies to the subagent's next turn.`),
					},
				],
				details: {
					name: record.name,
					model: record.model,
					output: "",
					status: record.status,
					usage: record.totalUsage,
				} as SubagentDetails,
			};
		},
	});


	pi.registerTool({
		name: "subagent_interrupt",
		label: "Subagent Interrupt",
		description:
			"Steer a spawned subagent by interrupting it right now and pushing a message to it immediately. If the subagent is running, its current turn is aborted (its process is killed, mid-tool if necessary), then it resumes from its full session context with your message as the next instruction — no waiting for the current turn to finish. If it is not running, your message starts a new background turn on its session. Use it to steer, redirect, ask for more detail, assign follow-up work, or fix an error.",
		promptSnippet: "Interrupt and steer a subagent immediately",
		promptGuidelines: [
			"Use subagent_interrupt to steer a subagent: it continues with its full previous context, and any in-flight turn is killed immediately so your message takes effect now.",
			"When a subagent errors (you receive a subagent-error message or a failed result), resolve it by steering it with subagent_interrupt (it resumes with full context) or respawning with subagent_spawn; use subagent_result to inspect the transcript first.",
			"After interrupting, the subagent keeps its full session history, so it can continue from where it was while following the new instruction.",
		],
		parameters: InterruptParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const message = params.message?.trim();
			if (!message) {
				return {
					content: [{ type: "text", text: "Error: message is required." }],
					details: { name: params.name, output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}
			const record = findRecordByName(params.name);
			if (!record) {
				return {
					content: [{ type: "text", text: `Unknown subagent "${params.name}". Spawn one first with subagent_spawn.` }],
					details: { name: params.name, output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}
			const emergencyText = `[emergency] ${message}`;
			const outcome = await interruptRunning(record, emergencyText);
			record.donePushedAt = undefined;
			saveRecord(record);

			if (outcome !== "aborted") {
				const started = await startBackground(pi, ctx, record, emergencyText);
				if (!started.started) {
					return {
						content: [{ type: "text", text: started.error ?? "Failed to start the subagent turn." }],
						details: {
							name: params.name,
							model: record.model,
							output: "",
							status: "error",
							usage: record.totalUsage,
						} as SubagentDetails,
						isError: true,
					};
				}
			}
			return {
				content: [
					{
						type: "text",
						text:
							outcome === "aborted"
								? `Interrupted subagent ${recordLabel(record)} with pi's abort and pushed your message into the same session — the in-flight tool call/stream was aborted and it is now running your instruction with full prior context. The result will auto-bubble when it finishes.`
								: outcome === "restarted"
									? `Interrupted subagent ${recordLabel(record)} (hard process restart) and pushed your message immediately. The result will auto-bubble when it finishes.`
									: `Subagent ${recordLabel(record)} was not running; pushed the message as a new turn. The result will auto-bubble when it finishes.`,
					},
				],
				details: {
					name: params.name,
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
			"List spawned subagents: name, id, status (running/idle/error), model, turn count, usage, and a preview of their latest output. Also shows how many are running vs the maxSubagents limit.",
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
						`- ${recordLabel(rec)} [${rec.status}] · model: ${rec.model ?? "session"} · created: ${new Date(rec.createdAt).toLocaleString()}` +
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
						name: rec.name,
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
			"Read the full transcript of a spawned subagent (name from subagent_spawn), including its task, all steering messages, tool activity, and outputs.",
		promptSnippet: "Read a subagent's full transcript",
		parameters: ResultParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const record = findRecordByName(params.name);
			if (!record) {
				return {
					content: [{ type: "text", text: `Unknown subagent "${params.name}". Spawn one with subagent_spawn.` }],
					details: { name: params.name, output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}

			const transcript = readTranscript(record.id) || record.lastOutput || "(no transcript available)";
			const usage = formatUsage(record.totalUsage, record.model);
			const text = `${transcript}${usage ? `\n\n[usage: ${usage}]` : ""}`;
			return {
				content: [{ type: "text", text }],
				details: {
					name: record.name,
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
			"Delete a spawned subagent and its private session (name from subagent_spawn). Kills it first if it is still running. Its work is gone; you can spawn a fresh one if needed.",
		promptSnippet: "Delete a spawned subagent",
		parameters: ForgetParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const record = findRecordByName(params.name);
			if (!record) {
				return {
					content: [{ type: "text", text: `Unknown subagent "${params.name}".` }],
					details: { name: params.name, output: "", status: "error", usage: EMPTY_USAGE() } as SubagentDetails,
					isError: true,
				};
			}
			const entry = running.get(record.id);
			if (entry) {
				try {
					entry.proc.kill("SIGTERM");
				} catch {

				}
				running.delete(record.id);
			}
			let removed = 0;
			for (const file of [recordFile(record.id), sessionFileForRecord(record), scopeFile(record.id)]) {
				try {
					fs.unlinkSync(file);
					removed++;
				} catch {

				}
			}
			return {
				content: [{ type: "text", text: `Forgot subagent ${recordLabel(record)} (removed ${removed} file(s)).` }],
				details: {
					name: params.name,
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
			out.push(
				`Subagent backend: ${
					cfg.backend ??
					(isOpencodeCliModel(cfg.model) && !modelKnownToPi(ctx, cfg.model)
						? "opencode (inferred from model)"
						: "pi")
				}`,
			);
			out.push(`OpenCode model (opencode backend): ${cfg.opencodeModel ?? DEFAULT_OPENCODE_MODEL}`);
			out.push(`Custom system prompt: ${cfg.systemPrompt ? `set (${cfg.systemPrompt.length} chars)` : "(default)"}`);
			out.push(`Working directory: ${cfg.cwd ?? "(current directory)"}`);
			out.push(`Tool allowlist: ${cfg.tools ?? "(all tools)"}`);
			out.push(`Subagents running: ${runningNow}/${maxSubagents} (maxSubagents)`);
			out.push(
				`Default edit scope: ${cfg.scope ? (Array.isArray(cfg.scope) ? cfg.scope.join(", ") : cfg.scope) : "(none — full access)"}`,
			);
			out.push(`Allow temp writes: ${cfg.allowTmp === false ? "no" : "yes"}`);
			out.push(`Auto-resume on session resume: ${cfg.autoResume === false ? "no" : "yes"} (limit ${getMaxAutoResumes()})`);
			out.push(
				"Set the model with `/subagent model <provider/id>` (or `opencode/<id>` for the opencode backend); " +
					"set the runtime with `/subagent config backend pi|opencode`; set the limit with `/subagent config maxSubagents N`.",
			);
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
			"Manage subagents: /subagent list | result <name> | interrupt <name> <msg> | scope <name> <path|none> | forget <name> | model [provider/id] | config (agents spawn subagents via the subagent_spawn tool)",
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
				if (key === "autoResume") {
					const v = parts[2]?.toLowerCase();
					if (v !== "yes" && v !== "no") {
						ctx.ui.notify("Usage: /subagent config autoResume yes|no", "info");
						return;
					}
					cfg.autoResume = v === "yes";
					saveConfig(cfg);
					ctx.ui.notify(`autoResume set to ${cfg.autoResume ? "yes" : "no"}.`, "info");
					return;
				}
				if (key === "maxAutoResumes") {
					const val = Number(parts[2]);
					if (!Number.isFinite(val) || val < 0) {
						ctx.ui.notify(`Usage: /subagent config ${key} <non-negative integer>`, "info");
						return;
					}
					cfg.maxAutoResumes = Math.floor(val);
					saveConfig(cfg);
					ctx.ui.notify(`maxAutoResumes set to ${cfg.maxAutoResumes}.`, "info");
					return;
				}
				if (key === "backend") {
					const v = parts[2]?.toLowerCase();
					if (v !== "pi" && v !== "opencode") {
						ctx.ui.notify("Usage: /subagent config backend pi|opencode", "info");
						return;
					}
					cfg.backend = v;
					saveConfig(cfg);
					ctx.ui.notify(
						v === "opencode"
							? `Subagent backend set to opencode (model: ${cfg.opencodeModel ?? DEFAULT_OPENCODE_MODEL}). Needs the opencode CLI on PATH.`
							: "Subagent backend set to pi.",
						"info",
					);
					return;
				}
				if (key === "opencodeModel") {
					const v = parts.slice(2).join(" ").trim();
					if (!v) {
						ctx.ui.notify("Usage: /subagent config opencodeModel <opencode/provider-model>", "info");
						return;
					}
					cfg.opencodeModel = v;
					saveConfig(cfg);
					ctx.ui.notify(`OpenCode model set to ${v}.`, "info");
					return;
				}
				if (key) {
					ctx.ui.notify(
						"Usage: /subagent config [maxSubagents <n> | autoResume yes|no | maxAutoResumes <n> | scope <path> | allowTmp yes|no | backend pi|opencode | opencodeModel <id>] — no args opens the settings panel.",
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
					(rec) => `${recordLabel(rec)} [${rec.status}] · ${rec.model ?? "session"} · ${firstLine(rec.lastOutput).slice(0, 80) || "(no output)"}`,
				);
				ctx.ui.notify(lines.length ? lines.join("\n") : "No subagents spawned yet.", "info");
				return;
			}
			if (first === "result" || first === "forget") {
				const name = parts[1];
				if (!name) {
					ctx.ui.notify(`Usage: /subagent ${first} <name>`, "info");
					return;
				}
				if (first === "result") {
					const rec = findRecordByName(name);
					if (!rec) {
						ctx.ui.notify(`Unknown subagent "${name}".`, "error");
						return;
					}
					const transcript = readTranscript(rec.id) || rec.lastOutput || "(no transcript available)";
					ctx.ui.notify(transcript.slice(0, 600), "info");
					return;
				}
				if (first === "forget") {
					const rec = findRecordByName(name);
					if (!rec) {
						ctx.ui.notify(`Unknown subagent "${name}".`, "error");
						return;
					}
					const entry = running.get(rec.id);
					if (entry) {
						try {
							entry.proc.kill("SIGTERM");
						} catch {

						}
						running.delete(rec.id);
					}
					for (const file of [recordFile(rec.id), sessionFileForRecord(rec), scopeFile(rec.id)]) {
						try {
							fs.unlinkSync(file);
						} catch {

						}
					}
					ctx.ui.notify(`Forgot subagent ${recordLabel(rec)}.`, "info");
					return;
				}
			}

			if (first === "scope") {
				const name = parts[1];
				const value = parts.slice(2).join(" ").trim();
				if (!name) {
					ctx.ui.notify("Usage: /subagent scope <name> <path[,path...]|none>", "info");
					return;
				}
				const rec = findRecordByName(name);
				if (!rec) {
					ctx.ui.notify(`Unknown subagent "${name}".`, "error");
					return;
				}
				if (!value || value === "none") {
					rec.scope = undefined;
				} else {
					const scope = value.includes(",")
						? value.split(",").map((x) => x.trim()).filter(Boolean)
						: value;
					rec.scope = normalizeScope(rec.cwd, scope);
				}
				saveRecord(rec);
				writeScopeFile(rec);
				const scopeText = rec.scope && rec.scope.length > 0 ? rec.scope.join(", ") : "(none — unrestricted)";
				ctx.ui.notify(`Edit scope for ${recordLabel(rec)}: ${scopeText}`, "info");
				return;
			}

			if (first === "interrupt") {
				const name = parts[1];
				const message = parts.slice(2).join(" ").trim();
				if (!name || !message) {
					ctx.ui.notify("Usage: /subagent interrupt <name> <message>", "info");
					return;
				}
				const rec = findRecordByName(name);
				if (!rec) {
					ctx.ui.notify(`Unknown subagent "${name}".`, "error");
					return;
				}
				const emergencyText = `[emergency] ${message}`;
				const outcome = await interruptRunning(rec, emergencyText);
				rec.donePushedAt = undefined;
				saveRecord(rec);
				if (outcome !== "aborted") {
					const started = await startBackground(pi, ctx, rec, emergencyText);
					if (!started.started) {
						ctx.ui.notify(started.error ?? "Failed to start subagent.", "error");
						return;
					}
				}
				ctx.ui.notify(
					outcome === "aborted"
						? `Interrupted ${recordLabel(rec)} with pi's abort and pushed your message into the same session.`
						: outcome === "restarted"
							? `Interrupted ${recordLabel(rec)} (hard restart) and pushed your message immediately.`
							: `Subagent ${recordLabel(rec)} was idle; pushed the message as a new turn.`,
					"info",
				);
				return;
			}

			ctx.ui.notify(
				"Usage: /subagent list | result <name> | interrupt <name> <msg> | scope <name> <path|none> | forget <name> | model [provider/id] | config",
				"info",
			);
		},
	});
}


function findExactModel(ctx: ExtensionCommandContext, arg: string): string | undefined {
	const q = arg.trim().toLowerCase();
	// OpenCode model ids are not in pi's registry, so accept them verbatim.
	if (isOpencodeModel(q)) return arg.trim();
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
				`autoResume: ${cfg.autoResume === false ? "no" : "yes"} (limit ${getMaxAutoResumes()})\n` +
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
		const rowValue = (id: string) => {
			if (id === "maxAutoResumes") return String(draft.maxAutoResumes ?? getMaxAutoResumes());
			return String(draft.maxSubagents ?? getMaxSubagents());
		};


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
			{
				id: "autoResume",
				label: "Auto-resume subagents",
				description: "Resume subagents interrupted by a quit or session switch when the session is resumed. Enter to toggle.",
				currentValue: draft.autoResume === false ? "no" : "yes",
				values: ["yes", "no"],
			},
			{
				id: "maxAutoResumes",
				label: "Auto-resume limit",
				description: "Maximum automatic resumes per subagent before it is marked as errored. Type a number directly.",
				currentValue: String(getMaxAutoResumes()),
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

		const numericIds = new Set(["maxSubagents", "maxAutoResumes"]);
		let selectedRowIndex = 0;
		let digitInput = "";

		const refreshRow = (id: string) => settingsList.updateValue(id, rowValue(id));

		const commitNumber = () => {
			const id = items[selectedRowIndex].id;
			const n = Number(digitInput);
			if (numericIds.has(id) && Number.isInteger(n) && n >= (id === "maxAutoResumes" ? 0 : 1)) {
				if (id === "maxAutoResumes") draft.maxAutoResumes = n;
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
				} else if (id === "autoResume") {
					draft.autoResume = newValue === "yes";
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
