

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

const GUIDELINE_MARKER = "A shared task board lives at";
const MAX_NOTIFY_CHARS = 2000;

const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "session";


function taskFile(ctx: ExtensionContext): string {
	if (process.env.PI_TASK_BASE) return path.join(process.env.PI_TASK_BASE, "TASK.md");
	let sessionId = "session";
	try {
		sessionId = ctx.sessionManager.getSessionId() || sessionId;
	} catch {

	}
	return path.join(BASE_DIR, sanitizeId(sessionId), "TASK.md");
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

const guidelineFor = (file: string) =>
	`${GUIDELINE_MARKER} ${file} (plain markdown). Read it with read, update it directly with the edit tool as you work — keep it current: add tasks, mark progress, move finished items to Done.`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		if (event.systemPrompt.includes(GUIDELINE_MARKER)) return undefined;
		const file = taskFile(ctx);
		ensureTaskFile(file);
		return { systemPrompt: `${event.systemPrompt}\n\n${guidelineFor(file)}` };
	});

	pi.registerCommand("task", {
		description: "Show this session's task board (/tmp/<session_id>/TASK.md). /task init recreates it if missing.",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const file = taskFile(ctx);
			if (parts[0] === "init") {
				ensureTaskFile(file);
				ctx.ui.notify(`Task board ready at ${file}.`, "info");
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
