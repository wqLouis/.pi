/**
 * Main-agent tools: subagent_spawn/scope/interrupt/list/result/forget/config.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	configFile,
	getMaxAutoResumes,
	getMaxOpencodeSubagents,
	getMaxSubagents,
	loadConfig,
	maxForBackend,
	resolveSpawnOptions,
} from "./config.ts";
import { DEFAULT_OPENCODE_MODEL, DEFAULT_SUBAGENT_PROMPT, OPENCODE_DEFAULT_EFFORT } from "./constants.ts";
import { isOpencodeCliModel, modelKnownToPi } from "./models.ts";
import { buildPrefillBlock } from "./prompts.ts";
import {
	countRunningSubagents,
	existingNames,
	findRecordByName,
	loadRecord,
	newSubagentId,
	readTranscript,
	recordLabel,
	sanitizeName,
	saveRecord,
	uniqueName,
} from "./records.ts";
import { interruptRunning, running, startBackground } from "./runtime.ts";
import { normalizeScope, writeScopeFile } from "./scope.ts";
import { isSubagentProcess, recordFile, scopeFile, sessionFileForRecord, subagentDir } from "./state.ts";
import type { SubagentDetails, SubagentRecord, TaskAssignment } from "./types.ts";
import { EMPTY_USAGE, firstLine, formatUsage } from "./usage.ts";

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

const BackendParam = Type.Optional(
	Type.Union([Type.Literal("pi"), Type.Literal("opencode")], {
		description:
			"Which runtime executes the subagent. 'pi' (default) runs a pi subagent; 'opencode' drives the OpenCode CLI over ACP, using OpenCode's models — including its free models. Overrides the configured backend; the model, thinking level, and effort for each backend come from the user's configuration (/subagent config).",
	}),
);

const SpawnParams = Type.Object({
	task: Type.Optional(Type.String({ description: "The task to delegate to the subagent (use tasks for multiple)." })),
	name: Type.Optional(
		Type.String({
			description:
				"Short, unique, human-readable name for this subagent (required). Used as its handle in listings, notifications, and subagent_interrupt/result/forget.",
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
	backend: BackendParam,
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

function errorDetails(name: string): SubagentDetails {
	return { name, output: "", status: "error", usage: EMPTY_USAGE() };
}

export function registerMainTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_spawn",
		label: "Subagent Spawn",
		description:
			"Spawn subagent(s) to work in isolated contexts (their own sessions). Pass task + name for one background subagent. Pass tasks (array of { task, name, scope? }) to spawn one background subagent per task. Provide exactly one of task or tasks, and a name for every subagent (names must be unique). All spawns are asynchronous: the tool returns immediately. Do NOT sleep, poll, or wait for a subagent to finish — the harness notifies you as soon as each one completes. Subagents run on pi by default; pass backend: \"opencode\" to run them on the OpenCode CLI instead. Models, thinking levels, efforts, cwd, and tools are user configuration (/subagent config) — this tool only chooses the tasks and the backend.",
		promptSnippet: "Spawn isolated subagent(s) to delegate work to",
		promptGuidelines: [
			"Always give every subagent a short unique name via name (single) or tasks[].name. The name is its handle in listings and notifications, and is what subagent_interrupt/subagent_result/subagent_forget use.",
			"Pass tasks (array of { task, name?, scope? }) to run several independent subagents in parallel; each runs in the background with automatic completion notifications.",
			"When multiple subagents need the same files, pass prefillReads (file paths): the files are read once and injected verbatim, identically, into every spawned subagent's context before the task — the subagents share that prompt-cache prefix instead of each issuing their own reads (better cache hits, fewer read calls).",
			"Spawns are always asynchronous: the tool returns immediately and you are notified when each subagent finishes. Never sleep, poll, or wait for subagents — keep working on other tasks and let the harness wake you when a result arrives.",
			"Give each task a narrow edit scope so the harness can block writes outside those files or directories — use this to keep parallel subagents from colliding on the same files.",
			"To run a subagent on OpenCode instead of pi, pass backend: \"opencode\". OpenCode runs as a separate agent with its own tools, including OpenCode's free models; give it a self-contained task since its transcript is not pi's. Its model and effort are set by the user in /subagent config — do not try to pass them per spawn.",
			"Use subagent_interrupt to steer a running subagent urgently — it kills the current turn and restarts it immediately with your message, keeping the subagent's full previous context.",
			"Change a subagent's edit scope after spawning with subagent_scope (it takes effect live, even mid-run).",
			"If a subagent errors, steer it to fix the error with subagent_interrupt or respawn it with subagent_spawn — don't just give up.",
			"pi and opencode subagents draw on independent concurrency pools: pi is capped by maxSubagents, opencode by maxOpencodeSubagents — so spawning opencode subagents never blocks pi ones. Check subagent_config for each pool's usage. Spawn only as many as you actually need.",
		],
		parameters: SpawnParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = params.task?.trim();
			const assignments = toAssignments(params.tasks);
			const prefillReads = toStringArray(params.prefillReads);

			if (task && assignments.length > 0) {
				return {
					content: [{ type: "text", text: "Error: pass either task (one subagent) or tasks (many), not both." }],
					details: errorDetails(""),
					isError: true,
				};
			}
			if (!task && assignments.length === 0) {
				return {
					content: [{ type: "text", text: "Error: task or tasks is required." }],
					details: errorDetails(""),
					isError: true,
				};
			}
			if (task && !sanitizeName(params.name)) {
				return {
					content: [{ type: "text", text: "Error: name is required — give this subagent a short unique name." }],
					details: errorDetails(""),
					isError: true,
				};
			}
			if (assignments.some((a) => !a.name)) {
				return {
					content: [{ type: "text", text: "Error: every task needs a name." }],
					details: errorDetails(""),
					isError: true,
				};
			}

			if (isSubagentProcess) {
				return {
					content: [{ type: "text", text: "Nested subagents are not supported." }],
					details: errorDetails(""),
					isError: true,
				};
			}

			// Multi-task path: one independent background subagent per task, no shared
			// exploration. Tasks share the user's configuration (model, thinking
			// level/effort, cwd, tools); only the backend is chosen per spawn.
			if (assignments.length > 0) {
				const opts2 = resolveSpawnOptions(ctx, { backend: params.backend });

				// Pre-check this backend's pool before starting anything, so a batch
				// cannot half-start.
				const poolLimit = maxForBackend(opts2.backend);
				const free = Math.max(0, poolLimit - countRunningSubagents(opts2.backend));
				if (assignments.length > free) {
					const label = opts2.backend === "opencode" ? "opencode subagent" : "subagent";
					const key = opts2.backend === "opencode" ? "maxOpencodeSubagents" : "maxSubagents";
					return {
						content: [
							{
								type: "text",
								text: `This spawn has ${assignments.length} ${label} task(s) but only ${free} of ${poolLimit} ${label} slots are free (pi and opencode pools are independent). Spawn fewer tasks or raise ${key} (/subagent config ${key} N).`,
							},
						],
						details: errorDetails(""),
						isError: true,
					};
				}

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
						thinkingLevel: opts2.thinkingLevel,
						opencodeEffort: opts2.opencodeEffort,
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
							`- ${recordLabel(record)} [running]${record.scope ? ` · scope: ${record.scope.join(", ")}` : ""}${opts2.backend === "opencode" ? ` · opencode${opts2.opencodeEffort ? ` (effort: ${opts2.opencodeEffort})` : ""}` : opts2.thinkingLevel ? ` · thinking: ${opts2.thinkingLevel}` : ""} · ${firstLine(assignment.task)}`,
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
								`\nDo not wait or poll for them — keep working; the harness notifies you when each finishes. Steer with subagent_interrupt, inspect with subagent_result, forget with subagent_forget.`,
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

			if (!task) {
				// Unreachable: the validation above requires task when no assignments exist.
				return {
					content: [{ type: "text", text: "Error: task is required." }],
					details: errorDetails(""),
					isError: true,
				};
			}

			const opts = resolveSpawnOptions(ctx, { backend: params.backend });

			// Each backend has its own concurrency pool.
			const poolLimit = maxForBackend(opts.backend);
			const poolRunning = countRunningSubagents(opts.backend);
			if (poolRunning >= poolLimit) {
				const label = opts.backend === "opencode" ? "opencode subagents" : "subagents";
				const key = opts.backend === "opencode" ? "maxOpencodeSubagents" : "maxSubagents";
				return {
					content: [
						{
							type: "text",
							text:
								`Maximum concurrent ${label} reached (${poolRunning}/${poolLimit} running). Wait for completion notifications or forget agents (subagent_forget) before spawning more. Raise ${key} in the settings (/subagent config ${key} N) if you need more.`,
						},
					],
					details: errorDetails(""),
					isError: true,
				};
			}

			const cfg = loadConfig();
			const scope = normalizeScope(opts.cwd, params.scope ?? cfg.scope);
			const allowTmp = cfg.allowTmp ?? true;
			const prefillBlock = buildPrefillBlock(prefillReads, opts.cwd);

			const record: SubagentRecord = {
				id: newSubagentId(),
				name: uniqueName(sanitizeName(params.name), existingNames()),
				model: opts.model,
				backend: opts.backend,
				thinkingLevel: opts.thinkingLevel,
				opencodeEffort: opts.opencodeEffort,
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
							`Spawned subagent ${recordLabel(record)} in the background (model: ${record.model ?? "session model"}${record.thinkingLevel ? `, thinking: ${record.thinkingLevel}` : ""}${record.opencodeEffort ? `, effort: ${record.opencodeEffort}` : ""}).\n` +
							(scope ? `Edit scope: ${scope.join(", ")} — writes outside are blocked.\n` : "") +
							`You will be notified when it finishes. Do not sleep or poll for it — continue your own work; read its transcript with subagent_result or redirect it with subagent_interrupt.`,
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
			"When a subagent errors (you receive a subagent-error message or a failed result), resolve it by steering it with subagent_interrupt (it resumes with full context) or respawning with subagent_spawn; use subagent_result to inspect the transcript first.",
			"After interrupting, the subagent keeps its full session history, so it can continue from where it was while following the new instruction. You do not need to wait for it — the harness notifies you when the new turn finishes.",
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
					content: [{ type: "text", text: `Unknown subagent "${params.name}". Spawn one first with subagent_spawn.` }],
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
				`Running: ${countRunningSubagents("pi")}/${maxSubagents} pi · ${countRunningSubagents("opencode")}/${maxOpencodeSubagents} opencode (independent pools) · total spawned: ${records.length}`,
			);
			if (records.length === 0) {
				out.push("No subagents spawned yet. Use subagent_spawn to delegate work.");
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
			"Read the full transcript of a spawned subagent (name from subagent_spawn), including its task, all steering messages, tool activity, and outputs.",
		promptSnippet: "Read a subagent's full transcript",
		parameters: ResultParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const record = findRecordByName(params.name);
			if (!record) {
				return {
					content: [{ type: "text", text: `Unknown subagent "${params.name}". Spawn one with subagent_spawn.` }],
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
			"Delete a spawned subagent and its private session (name from subagent_spawn). Kills it first if it is still running. Its work is gone; you can spawn a fresh one if needed.",
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
			const entry = running.get(record.id);
			if (entry) {
				try {
					entry.proc.kill("SIGTERM");
				} catch {
					// Already gone.
				}
				running.delete(record.id);
			}
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
			out.push(`Subagent backend: ${cfg.backend ?? "auto (inferred from the model)"}`);
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
				`Subagents running — pi: ${piRunning}/${maxSubagents} (maxSubagents) · opencode: ${opencodeRunning}/${maxOpencodeSubagents} (maxOpencodeSubagents, independent pools)`,
			);
			out.push(
				`Default edit scope: ${cfg.scope ? (Array.isArray(cfg.scope) ? cfg.scope.join(", ") : cfg.scope) : "(none — full access)"}`,
			);
			out.push(`Allow temp writes: ${cfg.allowTmp === false ? "no" : "yes"}`);
			out.push(`Auto-resume on session resume: ${cfg.autoResume === false ? "no" : "yes"} (limit ${getMaxAutoResumes()})`);
			out.push(
				"Set the model with `/subagent model <provider/id>` (or `opencode/<id>` for the opencode backend); " +
					"open the panel with `/subagent config` to set the backend, thinking level, opencode model/effort, and limits. " +
					"Per spawn, subagent_spawn only chooses the backend; models, thinking levels, and efforts are set here.",
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
