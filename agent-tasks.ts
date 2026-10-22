import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

const BASE_DIR = process.env.PI_TASK_DIR || "/tmp";

const TEMPLATE = `# Task Board

Shared task file for this session. Update it directly with the edit tool as you work.

Open:
- [ ] 

In progress:
- 

Done:
- 

Notes:
- 
`;

/** Section name in the structured system prompt (lowercase, per pi's rules). */
const TASK_SECTION_NAME = "task_board";
const MAX_NOTIFY_CHARS = 2000;
const TASK_FILE_NAME = "TASK.md";
const TASK_TOOLS = new Set(["read", "write", "edit"]);
const CONFIG_FILE = "task-board.json";

const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "session";

function configPath(): string {
	return path.join(getAgentDir(), CONFIG_FILE);
}

/** The task board is opt-in: disabled until the user enables it with `/task on`. */
function isEnabled(): boolean {
	try {
		const cfg = JSON.parse(fs.readFileSync(configPath(), "utf-8")) as { enabled?: boolean };
		return cfg?.enabled === true;
	} catch {
		return false;
	}
}

function setEnabled(enabled: boolean): void {
	fs.mkdirSync(getAgentDir(), { recursive: true });
	fs.writeFileSync(configPath(), JSON.stringify({ enabled }, null, 2), { encoding: "utf-8", mode: 0o600 });
}

function taskFile(ctx: ExtensionContext): string {
	if (process.env.PI_TASK_BASE) return path.join(process.env.PI_TASK_BASE, TASK_FILE_NAME);
	let sessionId = "session";
	try {
		sessionId = ctx.sessionManager.getSessionId() || sessionId;
	} catch {

	}
	return path.join(BASE_DIR, sanitizeId(sessionId), TASK_FILE_NAME);
}

function isTaskBoardPath(inputPath: string, ctx: ExtensionContext, actualFile: string): boolean {
	const normalized = inputPath.replaceAll("\\", "/").replace(/^@/, "");
	if (normalized === TASK_FILE_NAME || normalized === `./${TASK_FILE_NAME}`) return true;
	try {
		const candidate = path.resolve(ctx.cwd, inputPath.replace(/^@/, ""));
		if (candidate === path.resolve(actualFile)) return true;
		if (process.env.PI_TASK_BASE) {
			const sharedBase = path.resolve(process.env.PI_TASK_BASE);
			return candidate.startsWith(`${sharedBase}${path.sep}`) && path.basename(candidate) === TASK_FILE_NAME;
		}
	} catch {

	}
	return false;
}

function redirectTaskPath(event: { toolName: string; input: Record<string, unknown> }, ctx: ExtensionContext): void {
	if (!TASK_TOOLS.has(event.toolName)) return;
	const inputPath = event.input.path;
	if (typeof inputPath !== "string") return;
	const actualFile = taskFile(ctx);
	if (isTaskBoardPath(inputPath, ctx, actualFile)) event.input.path = actualFile;
}

function ensureTaskFile(file: string): void {
	try {
		if (!fs.existsSync(file)) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, TEMPLATE, { encoding: "utf-8", mode: 0o600 });
		}
	} catch {

	}
}

const guidelineFor = () =>
	`A shared task board is available as \`TASK.md\` (plain markdown). Use the logical path TASK.md with read, write, or edit; the task extension routes it to this session's shared board. Track only substantial, multi-step work that will take more than one or two turns. Do not add trivial actions such as routine commits, quick checks, or other work that can be completed in one or two turns. Keep substantial tasks current: add them, mark progress, and move finished items to Done.`;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		if (!isEnabled()) return;
		redirectTaskPath(event, ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!isEnabled()) return undefined;
		// A structured section, so pi's prompt sections (and the cache) stay intact.
		const sections = event.systemPromptOptions.sections;
		if (sections[TASK_SECTION_NAME] !== undefined) return undefined;
		ensureTaskFile(taskFile(ctx));
		sections[TASK_SECTION_NAME] = guidelineFor();
		return undefined;
	});

	pi.registerCommand("task", {
		description: "Show this session's shared TASK.md board. /task on|off enables/disables the board (off by default); /task init recreates it.",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const first = parts[0];
			if (first === "on" || first === "enable") {
				setEnabled(true);
				ensureTaskFile(taskFile(ctx));
				ctx.ui.notify(
					"Task board enabled (persists across sessions; shared by this session and its subagents). Applies to new agent turns immediately.",
					"info",
				);
				return;
			}
			if (first === "off" || first === "disable") {
				setEnabled(false);
				ctx.ui.notify("Task board disabled. Re-enable with /task on.", "info");
				return;
			}
			const file = taskFile(ctx);
			if (first === "init") {
				ensureTaskFile(file);
				ctx.ui.notify("Shared TASK.md board is ready.", "info");
				return;
			}
			if (!isEnabled()) {
				ctx.ui.notify("Task board is disabled — /task on to enable it (off by default).", "info");
				return;
			}
			ensureTaskFile(file);
			try {
				const content = fs.readFileSync(file, "utf-8");
				ctx.ui.notify(content.slice(0, MAX_NOTIFY_CHARS), "info");
			} catch (error) {
				ctx.ui.notify(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
