/**
 * Child-process-only hooks. Registered inside a subagent pi process
 * (PI_SUBAGENT_DEPTH >= 1): edit-scope enforcement and the message channel
 * back to the main agent.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isWithinScope, readLiveScope } from "./scope.ts";

/** Register the hooks that only exist inside a spawned subagent process. */
export function registerChildHooks(pi: ExtensionAPI): void {
	const envScope = (() => {
		const raw = process.env.PI_SUBAGENT_SCOPE;
		if (!raw) return undefined;
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string" && s.length > 0) : undefined;
		} catch {
			return undefined;
		}
	})();
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

	// pi redirects extension stdout to stderr in non-interactive modes, so write
	// directly to stderr to keep this channel reliable (the parent parses it).
	const bubble = (message: string) => {
		try {
			process.stderr.write(JSON.stringify({ type: "subagent_bubble", content: message }) + "\n");
		} catch {
			// The parent may be gone; nothing to do.
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
