/**
 * Main-agent management tools: subagent_scope/interrupt/list/result/forget/config.
 * The two spawn tool registries live in spawn.ts.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { configFile, getMaxAutoResumes, getMaxOpencodeSubagents, getMaxSubagents, loadConfig } from "./config.ts";
import { DEFAULT_OPENCODE_MODEL, DEFAULT_SUBAGENT_PROMPT, OPENCODE_DEFAULT_EFFORT } from "./constants.ts";
import { isOpencodeCliModel, modelKnownToPi } from "./models.ts";
import {
	countRunningSubagents,
	findRecordByName,
	loadRecord,
	readTranscript,
	recordLabel,
	saveRecord,
} from "./records.ts";
import { interruptRunning, running, startBackground, stopRunning } from "./runtime.ts";
import { registerSpawnTools } from "./spawn.ts";
import { normalizeScope, writeScopeFile } from "./scope.ts";
import { recordFile, scopeFile, sessionFileForRecord, subagentDir } from "./state.ts";
import { errorDetails, poolLimitText } from "./tool-messages.ts";
import type { SubagentDetails, SubagentRecord } from "./types.ts";
import { EMPTY_USAGE, firstLine, formatUsage } from "./usage.ts";

const ScopeParams = Type.Object({
	name: Type.String({ description: "Name returned by a subagent spawn tool" }),
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
	name: Type.String({ description: "Name returned by a subagent spawn tool" }),
	message: Type.String({ description: "The urgent instruction to deliver immediately after interrupting the subagent" }),
});

const ListParams = Type.Object({});

const ResultParams = Type.Object({
	name: Type.String({ description: "Name returned by a subagent spawn tool" }),
});

const ForgetParams = Type.Object({
	name: Type.String({ description: "Name returned by a subagent spawn tool" }),
});

const ConfigParams = Type.Object({});

export function registerMainTools(pi: ExtensionAPI): void {
	registerSpawnTools(pi);

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
					content: [{ type: "text", text: `Unknown subagent "${params.name}". Spawn one first with a subagent spawn tool.` }],
					details: errorDetails(params.name),
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
			const scopeText = record.scope && record.scope.length > 0 ? record.scope.join(", ") : "(none — writes unrestricted)";
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
			"When a subagent errors (you receive a subagent-error message or a failed result), resolve it by steering it with subagent_interrupt (it resumes with full context) or respawning with a subagent spawn tool; use subagent_result to inspect the transcript first.",
			"After interrupting, the subagent keeps its full session history, so it can continue from where it was while following the new instruction. You do not need to wait for it — end your turn with a short status summary if you need the new result to continue; the harness notifies you when the new turn finishes and wakes you up.",
		],
		parameters: InterruptParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const message = params.message?.trim();
			if (!message) {
				return {
					content: [{ type: "text", text: "Error: message is required." }],
					details: errorDetails(params.name),
					isError: true,
				};
			}
			const record = findRecordByName(params.name);
			if (!record) {
				return {
					content: [{ type: "text", text: `Unknown subagent "${params.name}". Spawn one first with a subagent spawn tool.` }],
					details: errorDetails(params.name),
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
			"List spawned subagents: name, id, status (running/idle/error), model, turn count, usage, and a preview of their latest output. Also shows each pool's running count vs its limit (pi: maxSubagents, opencode: maxOpencodeSubagents — independent pools).",
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
				// No subagent dir yet.
			}
			records.sort((a, b) => b.createdAt - a.createdAt);

			const out: string[] = [];
			const maxSubagents = getMaxSubagents();
			const maxOpencodeSubagents = getMaxOpencodeSubagents();
			out.push(
				`Running: ${countRunningSubagents("pi")}/${poolLimitText(maxSubagents)} pi · ${countRunningSubagents("opencode")}/${poolLimitText(maxOpencodeSubagents)} opencode (independent pools) · total spawned: ${records.length}`,
			);
			if (records.length === 0) {
				out.push("No subagents spawned yet. Use a subagent spawn tool to delegate work.");
			} else {
				out.push(`${records.length} subagent(s):`);
				for (const rec of records) {
					const usage = formatUsage(rec.totalUsage, rec.model);
					out.push(
						`- ${recordLabel(rec)} [${rec.status}] · model: ${rec.model ?? "session"}${rec.thinkingLevel ? ` · thinking: ${rec.thinkingLevel}` : ""}${rec.opencodeEffort ? ` · effort: ${rec.opencodeEffort}` : ""} · created: ${new Date(rec.createdAt).toLocaleString()}` +
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
			"Read the full transcript of a spawned subagent (name from a subagent spawn tool), including its task, all steering messages, tool activity, and outputs.",
		promptSnippet: "Read a subagent's full transcript",
		parameters: ResultParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const record = findRecordByName(params.name);
			if (!record) {
				return {
					content: [{ type: "text", text: `Unknown subagent "${params.name}". Spawn one with a subagent spawn tool.` }],
					details: errorDetails(params.name),
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
			"Delete a spawned subagent and its private session (name from a subagent spawn tool). Kills it first if it is still running. Its work is gone; you can spawn a fresh one if needed.",
		promptSnippet: "Delete a spawned subagent",
		parameters: ForgetParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const record = findRecordByName(params.name);
			if (!record) {
				return {
					content: [{ type: "text", text: `Unknown subagent "${params.name}".` }],
					details: errorDetails(params.name),
					isError: true,
				};
			}
			// Interrupt first, delete afterwards: a running subagent is stopped
			// cleanly (no error notification bubbling up to the main agent) and
			// its files are removed once it is gone.
			await stopRunning(record);
			let removed = 0;
			for (const file of [recordFile(record.id), sessionFileForRecord(record), scopeFile(record.id)]) {
				try {
					fs.unlinkSync(file);
					removed++;
				} catch {
					// Already gone.
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
			"Show the effective subagent configuration: the user-configured backend/model/thinking level/system prompt/cwd/tools/limits (from ~/.pi/agent/subagent-config.json), the opencode model+effort, the current session model fallback, and how many subagents are running right now vs each pool's limit.",
		promptSnippet: "Show subagent configuration and current usage",
		parameters: ConfigParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const cfg = loadConfig();
			const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const piRunning = countRunningSubagents("pi");
			const opencodeRunning = countRunningSubagents("opencode");
			const maxSubagents = getMaxSubagents();
			const maxOpencodeSubagents = getMaxOpencodeSubagents();
			const out: string[] = [];
			out.push(`Config file: ${configFile()}`);
			out.push(
				"Spawn tools: subagent_spawn = pi · subagent_spawn_opencode = OpenCode — the enabled spawn tool picks the backend (enable one with /tools).",
			);
			out.push(`User-configured model: ${cfg.model ?? "(not set — inherits session model)"}`);
			out.push(`Current session model: ${sessionModel ?? "(none)"}`);
			out.push(`Effective model for new subagents: ${cfg.model ?? sessionModel ?? "(none)"}`);
			out.push(
				`Thinking level (pi backend): ${cfg.thinkingLevel ?? "(model default)"}${
					isOpencodeCliModel(cfg.model) && !modelKnownToPi(ctx, cfg.model) ? " (model is opencode-backed)" : ""
				}`,
			);
			out.push(`OpenCode model (opencode backend): ${cfg.opencodeModel ?? DEFAULT_OPENCODE_MODEL}`);
			out.push(
				`OpenCode effort: ${cfg.opencodeEffort && cfg.opencodeEffort !== OPENCODE_DEFAULT_EFFORT ? cfg.opencodeEffort : "(model default)"}`,
			);
			out.push(`Custom system prompt: ${cfg.systemPrompt ? `set (${cfg.systemPrompt.length} chars)` : `(default, ${DEFAULT_SUBAGENT_PROMPT.length} chars)`}`);
			out.push(`Working directory: ${cfg.cwd ?? "(current directory)"}`);
			out.push(`Tool allowlist: ${cfg.tools ?? "(all tools)"}`);
			out.push(
				`Subagents running — pi: ${piRunning}/${poolLimitText(maxSubagents)} (maxSubagents) · opencode: ${opencodeRunning}/${poolLimitText(maxOpencodeSubagents)} (maxOpencodeSubagents, independent pools)`,
			);
			out.push(
				`Default edit scope: ${cfg.scope ? (Array.isArray(cfg.scope) ? cfg.scope.join(", ") : cfg.scope) : "(none — full access)"}`,
			);
			out.push(`Allow temp writes: ${cfg.allowTmp === false ? "no" : "yes"}`);
			out.push(`Auto-resume on session resume: ${cfg.autoResume === false ? "no" : "yes"} (limit ${getMaxAutoResumes()})`);
			out.push(
				"Set the model with `/subagent model <provider/id>` (or `opencode/<id>` for the opencode backend); " +
					"open the panel with `/subagent config` to set the thinking level, opencode model/effort, and limits. " +
					"The backend is chosen by the enabled spawn tool, not here; models, thinking levels, and efforts are set here.",
			);
			return {
				content: [{ type: "text", text: out.join("\n") }],
				details: {
					config: cfg,
					sessionModel,
					effectiveModel: cfg.model ?? sessionModel,
					runningSubagents: piRunning + opencodeRunning,
					runningPi: piRunning,
					runningOpencode: opencodeRunning,
					maxSubagents,
					maxOpencodeSubagents,
					defaultScope: cfg.scope,
					allowTmp: cfg.allowTmp !== false,
				},
			};
		},
	});
}
