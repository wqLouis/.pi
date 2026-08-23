

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

const GUIDELINE_MARKER = "A shared task board is available as `TASK.md`.";
const MAX_NOTIFY_CHARS = 2000;
const TASK_FILE_NAME = "TASK.md";
const TASK_TOOLS = new Set(["read", "write", "edit"]);

const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "session";


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
	`${GUIDELINE_MARKER} (plain markdown). Use the logical path TASK.md with read, write, or edit; the task extension routes it to this session's shared board. Track only substantial, multi-step work that will take more than one or two turns. Do not add trivial actions such as routine commits, quick checks, or other work that can be completed in one or two turns. Keep substantial tasks current: add them, mark progress, and move finished items to Done.`;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		redirectTaskPath(event, ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (event.systemPrompt.includes(GUIDELINE_MARKER)) return undefined;
		ensureTaskFile(taskFile(ctx));
		return { systemPrompt: `${event.systemPrompt}\n\n${guidelineFor()}` };
	});

	pi.registerCommand("task", {
		description: "Show this session's shared TASK.md board. /task init recreates it if missing.",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const file = taskFile(ctx);
			if (parts[0] === "init") {
				ensureTaskFile(file);
				ctx.ui.notify("Shared TASK.md board is ready.", "info");
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
