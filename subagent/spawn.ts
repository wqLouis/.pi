/**
 * Spawn tool registries: one per backend.
 *
 * pi and OpenCode subagents are separate tool registries (`subagent-pi`,
 * `subagent-opencode`), so a session's tool selection enables only the backend
 * it uses. Both spawn tools share this implementation; the backend is fixed by
 * the tool, not a parameter.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, maxForBackend, resolveSpawnOptions } from "./config.ts";
import { buildPrefillBlock } from "./prompts.ts";
import { recentReads } from "./reads.ts";
import {
	countRunningSubagents,
	existingNames,
	newSubagentId,
	recordLabel,
	sanitizeName,
	saveRecord,
	uniqueName,
} from "./records.ts";
import { startBackground } from "./runtime.ts";
import { normalizeScope } from "./scope.ts";
import { isSubagentProcess } from "./state.ts";
import { errorDetails, poolDisabledMessage } from "./tool-messages.ts";
import type { SubagentBackend, SubagentDetails, SubagentRecord, TaskAssignment } from "./types.ts";
import { EMPTY_USAGE, firstLine } from "./usage.ts";

/** Arguments accepted by both spawn tools (the backend comes from the tool). */
interface SpawnArgs {
	task?: string;
	name?: string;
	tasks?: unknown;
	prefillReads?: unknown;
	scope?: string | string[];
}

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

/** A string list from an array or a JSON/CSV string (models sometimes stringify arguments). */
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

/** Tool name of a backend's spawn registry. */
export function spawnToolName(backend: SubagentBackend): string {
	return backend === "opencode" ? "subagent_spawn_opencode" : "subagent_spawn";
}

function spawnDescription(backend: SubagentBackend): string {
	const common =
		"Pass task + name for one background subagent. Pass tasks (array of { task, name, scope? }) to spawn one background subagent per task. Provide exactly one of task or tasks, and a name for every subagent (names must be unique). All spawns are asynchronous: the tool returns immediately. Do NOT sleep, poll, or wait for a subagent to finish — if you need a result to continue, end your turn with a short status summary of what is in flight; the harness notifies you as soon as each one completes and wakes you up. Models, thinking levels, efforts, cwd, and tools are user configuration (/subagent config) — this tool only chooses the tasks.";
	if (backend === "opencode") {
		return `Spawn OpenCode-backed subagent(s) to work in isolated contexts (their own sessions). OpenCode runs as a separate agent with its own tools and models, so give it a self-contained task. ${common}`;
	}
	return `Spawn pi-backed subagent(s) to work in isolated contexts (their own sessions). ${common}`;
}

function spawnGuidelines(backend: SubagentBackend): string[] {
	const tool = spawnToolName(backend);
	const other = spawnToolName(backend === "opencode" ? "pi" : "opencode");
	return [
		"Always give every subagent a short unique name via name (single) or tasks[].name. The name is its handle in listings and notifications, and is what subagent_interrupt/subagent_result/subagent_forget use.",
		"Pass tasks (array of { task, name?, scope? }) to run several independent subagents in parallel; each runs in the background with automatic completion notifications.",
		"When multiple subagents need the same files, pass prefillReads (file paths): the files are read once and injected verbatim, identically, into every spawned subagent's context before the task — the subagents share that prompt-cache prefix instead of each issuing their own reads (better cache hits, fewer read calls).",
		"Spawns are always asynchronous: the tool returns immediately and you are notified when each subagent finishes. Never sleep, poll, or wait for a subagent. If the next step depends on a result, end your turn now with a short summary of what is in flight and what remains; the completion message wakes you up and you continue from there. Otherwise keep working on other tasks.",
		"Give each task a narrow edit scope so the harness can block writes outside those files or directories — use this to keep parallel subagents from colliding on the same files.",
		`${tool} spawns ${backend === "opencode" ? "OpenCode" : "pi"} subagents; when ${other} is also enabled, use it for ${backend === "opencode" ? "pi" : "OpenCode"} subagents.`,
		"Use subagent_interrupt to steer a running subagent urgently — it kills the current turn and restarts it immediately with your message, keeping the subagent's full previous context.",
		"Change a subagent's edit scope after spawning with subagent_scope (it takes effect live, even mid-run).",
		`If a subagent errors, steer it to fix the error with subagent_interrupt or respawn it with ${tool} — don't just give up.`,
		"pi and opencode subagents draw on independent concurrency pools: pi is capped by maxSubagents, opencode by maxOpencodeSubagents — so spawning opencode subagents never blocks pi ones. A limit of 0 disables that pool. Check subagent_config for each pool's usage. Spawn only as many as you actually need.",
	];
}

/** Register one spawn tool per backend, each its own selectable unit. */
export function registerSpawnTools(pi: ExtensionAPI): void {
	for (const backend of ["pi", "opencode"] as const) registerSpawnTool(pi, backend);
}

function registerSpawnTool(pi: ExtensionAPI, backend: SubagentBackend): void {
	pi.registerTool({
		name: spawnToolName(backend),
		label: backend === "opencode" ? "Subagent Spawn (OpenCode)" : "Subagent Spawn",
		namespace: {
			name: `subagent-${backend}`,
			description: `Spawn ${backend === "opencode" ? "OpenCode" : "pi"}-backed subagents`,
		},
		description: spawnDescription(backend),
		promptSnippet:
			backend === "opencode"
				? "Spawn isolated OpenCode subagent(s) to delegate work to"
				: "Spawn isolated pi subagent(s) to delegate work to",
		promptGuidelines: spawnGuidelines(backend),
		parameters: SpawnParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeSpawn(pi, backend, params as SpawnArgs, ctx);
		},
	});
}

async function executeSpawn(pi: ExtensionAPI, backend: SubagentBackend, params: SpawnArgs, ctx: ExtensionContext) {
	const task = params.task?.trim();
	const assignments = toAssignments(params.tasks);
	const prefillReads: string[] = toStringArray(params.prefillReads) ?? [];

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
	// level/effort, cwd, tools); the backend is fixed by the tool.
	if (assignments.length > 0) {
		const opts2 = resolveSpawnOptions(ctx, { backend });

		// Pre-check this backend's pool before starting anything, so a batch
		// cannot half-start.
		const poolLimit = maxForBackend(opts2.backend);
		if (poolLimit === 0) {
			return {
				content: [{ type: "text", text: poolDisabledMessage(opts2.backend) }],
				details: errorDetails(""),
				isError: true,
			};
		}
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
						`\nDo not wait or poll for them. If you need their results to continue, end your turn with a short summary of what is in flight; the harness notifies you when each finishes and wakes you up. Steer with subagent_interrupt, inspect with subagent_result, forget with subagent_forget.`,
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

	const opts = resolveSpawnOptions(ctx, { backend });

	// Each backend has its own concurrency pool.
	const poolLimit = maxForBackend(opts.backend);
	if (poolLimit === 0) {
		return {
			content: [{ type: "text", text: poolDisabledMessage(opts.backend) }],
			details: errorDetails(""),
			isError: true,
		};
	}
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
	if (prefillReads.length === 0 && cfg.autoPrefill !== false) {
		// The files the main agent just read are the ones the child needs
		// most; prefilling them saves the child its own reads and gives
		// every child of the batch the same cached prefix.
		prefillReads.push(...recentReads(opts.cwd));
	}
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
					`You will be notified when it finishes. Do not sleep or poll for it. If you need its result to continue, end your turn with a short summary of what is in flight and what remains — the completion message wakes you up. Otherwise continue your own work; read its transcript with subagent_result or redirect it with subagent_interrupt.`,
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
}
