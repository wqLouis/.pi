/**
 * Async Bash Jobs — run commands in the background, get results pushed back.
 *
 * The agent can start a long command without blocking: bash_job_start returns
 * a job id immediately, the job runs in the background, and when it finishes a
 * message is pushed to the agent in realtime (followUp + triggerTurn, so an
 * idle agent wakes up). The agent can either do other things or block on it
 * with bash_job_wait.
 *
 * Tools: bash_job_start, bash_job_wait, bash_job_list, bash_job_result,
 * bash_job_cancel (+ /bash-jobs command).
 *
 * Records persist in ~/.pi/agent/bash-jobs/ so results survive restarts;
 * jobs orphaned by a restart (dead pid, status running) are marked lost.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const JOBS_DIR = path.join(getAgentDir(), "bash-jobs");
const POLL_INTERVAL_MS = 500;
const MAX_OUTPUT_BYTES = 64_000;
const CUSTOM_TYPE = "bash-job-notify";

interface BashJobRecord {
	id: string;
	command: string;
	cwd: string;
	status: "running" | "done" | "error" | "timeout" | "cancelled" | "lost";
	exitCode?: number;
	output: string;
	pid?: number;
	startedAt: number;
	finishedAt?: number;
	note?: string;
}

interface RunningJob {
	proc: ChildProcess;
	done: Promise<BashJobRecord>;
	getOutput: () => string;
	notifyOnDone: boolean;
}

const running = new Map<string, RunningJob>();

function jobFile(id: string): string {
	return path.join(JOBS_DIR, `${id}.json`);
}

function loadRecord(id: string): BashJobRecord | undefined {
	try {
		const rec = JSON.parse(fs.readFileSync(jobFile(id), "utf-8")) as BashJobRecord;
		return rec && typeof rec.id === "string" ? rec : undefined;
	} catch {
		return undefined;
	}
}

function saveRecord(rec: BashJobRecord): void {
	fs.mkdirSync(JOBS_DIR, { recursive: true });
	fs.writeFileSync(jobFile(rec.id), JSON.stringify(rec, null, 2), { encoding: "utf-8", mode: 0o600 });
}

function listRecords(): BashJobRecord[] {
	const records: BashJobRecord[] = [];
	try {
		for (const file of fs.readdirSync(JOBS_DIR)) {
			if (!file.endsWith(".json")) continue;
			const rec = loadRecord(file.slice(0, -5));
			if (rec) records.push(rec);
		}
	} catch {
		/* dir missing */
	}
	return records.sort((a, b) => b.startedAt - a.startedAt);
}

const toolError = (error: unknown) => ({
	content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
	details: {},
	isError: true,
});

/** Reconcile records from before a restart: dead "running" jobs are lost. */
function reconcileOrphaned(): void {
	for (const rec of listRecords()) {
		if (rec.status !== "running") continue;
		if (rec.pid != null) {
			try {
				process.kill(rec.pid, 0);
				continue; // still alive
			} catch {
				/* dead */
			}
		}
		rec.status = "lost";
		rec.finishedAt = Date.now();
		rec.note = "process was lost (extension/pi restarted) — output up to that point";
		saveRecord(rec);
	}
}

function notifyJobDone(pi: ExtensionAPI, rec: BashJobRecord): void {
	const failed = rec.status !== "done";
	const preview = rec.output.split("\n").find((l) => l.trim())?.slice(0, 200) ?? "(no output)";
	const label = rec.status === "done" ? "done" : rec.status;
	const text =
		`[bash job ${rec.id} ${label}] exit ${rec.exitCode ?? "?"} · ${preview}` +
		(failed
			? `\n\nGet the full output with bash_job_result { jobId: "${rec.id}" }${rec.status === "running" ? "" : ""}. You can rerun the command or adjust and retry.`
			: "");
	pi.sendMessage(
		{
			customType: CUSTOM_TYPE,
			content: text,
			display: true,
			details: { jobId: rec.id, status: rec.status, exitCode: rec.exitCode, command: rec.command, output: rec.output },
		},
		// Realtime: idle -> immediate new turn; streaming -> queued into current turn.
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

export default function (pi: ExtensionAPI) {
	reconcileOrphaned();

	pi.registerTool({
		name: "bash_job_start",
		label: "Bash Job Start",
		description:
			"Start a bash command in the background and return immediately with a job id. The command keeps running while you do other things; when it finishes you get a message with the result. Block on it with bash_job_wait, or collect output with bash_job_result.",
		promptSnippet: "Run a bash command in the background",
		promptGuidelines: [
			"Use bash_job_start for long-running commands (builds, tests, installs) — it returns immediately, and you get a message when it finishes. You can do other work in the meantime or block with bash_job_wait.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The command to run (via the shell)" }),
			timeout: Type.Optional(
				Type.Number({ description: "Kill the job after this many seconds (optional; default none)" }),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: current directory)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const command = params.command?.trim();
			if (!command) return toolError("Error: command is required.");
			const id = randomBytes(4).toString("hex");
			const cwd = params.cwd ?? ctx.cwd ?? process.cwd();
			let output = "";
			let killed = false;
			const rec: BashJobRecord = {
				id,
				command,
				cwd,
				status: "running",
				output: "",
				startedAt: Date.now(),
				pid: undefined,
			};
			saveRecord(rec);

			let proc: ChildProcess;
			let done: Promise<BashJobRecord>;
			try {
				proc = spawn(command, { shell: true, cwd });
			} catch (error) {
				rec.status = "error";
				rec.note = error instanceof Error ? error.message : String(error);
				rec.finishedAt = Date.now();
				saveRecord(rec);
				return toolError(`Failed to start job: ${rec.note}`);
			}
			rec.pid = proc.pid;
			saveRecord(rec);

			const cap = (chunk: Buffer) => {
				output += chunk.toString();
				if (output.length > MAX_OUTPUT_BYTES) output = output.slice(-MAX_OUTPUT_BYTES);
			};
			proc.stdout?.on("data", cap);
			proc.stderr?.on("data", cap);

			let timer: ReturnType<typeof setTimeout> | undefined;
			if (params.timeout && params.timeout > 0) {
				timer = setTimeout(() => {
					killed = true;
					try {
						proc.kill("SIGTERM");
					} catch {
						/* ignore */
					}
					setTimeout(() => {
						try {
							proc.kill("SIGKILL");
						} catch {
							/* ignore */
						}
					}, 3000);
				}, params.timeout * 1000);
			}

			done = new Promise<BashJobRecord>((resolve) => {
				proc.on("close", (code, _signal) => {
					if (timer) clearTimeout(timer);
					const timedOut = killed && code !== 0;
					rec.status = timedOut ? "timeout" : code === 0 ? "done" : "error";
					if (timedOut) rec.note = `killed after timeout (${params.timeout}s)`;
					rec.exitCode = code ?? (timedOut ? -1 : 1);
					rec.output = output;
					rec.finishedAt = Date.now();
					rec.pid = undefined;
					saveRecord(rec);
					resolve(rec);
				});
				proc.on("error", (error) => {
					if (timer) clearTimeout(timer);
					rec.status = "error";
					rec.note = error.message;
					rec.exitCode = 1;
					rec.output = output;
					rec.finishedAt = Date.now();
					saveRecord(rec);
					resolve(rec);
				});
			});

			running.set(id, { proc, done, getOutput: () => output, notifyOnDone: true });

			done.then((finalRec) => {
				const entry = running.get(id);
				const shouldNotify = entry ? entry.notifyOnDone : true;
				running.delete(id);
				if (finalRec.status !== "cancelled" && shouldNotify) notifyJobDone(pi, finalRec);
			}).catch(() => {
				running.delete(id);
			});

			return {
				content: [
					{
						type: "text",
						text: `Started bash job #${id} in the background (pid ${proc.pid}): "${command}". You'll be notified when it finishes; check bash_job_list, collect with bash_job_result, or block with bash_job_wait.`,
					},
				],
				details: { jobId: id, pid: proc.pid, command, status: "running" },
			};
		},
	});

	pi.registerTool({
		name: "bash_job_wait",
		label: "Bash Job Wait",
		description:
			"Block until a background bash job (jobId from bash_job_start) finishes, streaming progress updates. Returns the final output + exit code. If the job already finished, returns immediately. Suppresses the completion push (you're already waiting on it).",
		promptSnippet: "Wait for a background bash job to finish",
		parameters: Type.Object({
			jobId: Type.String({ description: "Job id" }),
			timeoutMs: Type.Optional(
				Type.Number({ description: "Max wait in ms (0 = wait indefinitely; default 0)" }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const id = params.jobId?.trim();
			if (!id) return toolError("Error: jobId is required.");
			const deadline = params.timeoutMs ? Date.now() + params.timeoutMs : Infinity;

			const entry = running.get(id);
			if (entry) entry.notifyOnDone = false; // we're waiting; skip the push

			while (true) {
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: `Wait for job #${id} aborted — it is still running.` }],
						details: { jobId: id, status: "running" },
						isError: true,
					};
				}
				if (Date.now() > deadline) {
					return {
						content: [{ type: "text", text: `Timed out waiting for job #${id} — it is still running. Check bash_job_list or wait longer.` }],
						details: { jobId: id, status: "running" },
					};
				}
				const rec = loadRecord(id);
				if (!rec) return toolError(`Unknown job "#${id}". Start one with bash_job_start.`);
				if (rec.status !== "running") {
					return {
						content: [
							{
								type: "text",
								text: `[bash job ${id} ${rec.status}] exit ${rec.exitCode ?? "?"}\n\n${rec.output || "(no output)"}${rec.note ? `\n\n(${rec.note})` : ""}`,
							},
						],
						details: { jobId: id, status: rec.status, exitCode: rec.exitCode, output: rec.output },
					};
				}
				if (onUpdate) {
					const cur = entry ? entry.getOutput() : "";
					onUpdate({
						content: [{ type: "text", text: `Waiting for job #${id}...\n\n${cur.slice(-4000) || "(no output yet)"}` }],
						details: { jobId: id, status: "running", output: cur },
					});
				}
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			}
		},
	});

	pi.registerTool({
		name: "bash_job_list",
		label: "Bash Job List",
		description: "List bash jobs: id, status, command, duration, output preview.",
		promptSnippet: "List bash jobs",
		parameters: Type.Object({}),
		async execute() {
			const records = listRecords().slice(0, 20);
			if (records.length === 0) {
				return {
					content: [{ type: "text", text: "No bash jobs yet. Start one with bash_job_start." }],
					details: { jobs: [] },
				};
			}
			const text = [
				`${records.length} bash job(s):`,
				...records.map((r) => {
					const dur = r.finishedAt ? `${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s` : "running";
					return `- #${r.id} [${r.status}] ${dur} · ${r.command.slice(0, 60)}${r.note ? ` (${r.note})` : ""}`;
				}),
			].join("\n");
			return { content: [{ type: "text", text }], details: { jobs: records.map((r) => ({ id: r.id, status: r.status, command: r.command })) } };
		},
	});

	pi.registerTool({
		name: "bash_job_result",
		label: "Bash Job Result",
		description: "Get the full output and exit code of a finished bash job (id from bash_job_start/list).",
		promptSnippet: "Get a bash job's output",
		parameters: Type.Object({
			jobId: Type.String({ description: "Job id" }),
		}),
		async execute(_toolCallId, params) {
			const id = params.jobId?.trim();
			if (!id) return toolError("Error: jobId is required.");
			const rec = loadRecord(id);
			if (!rec) return toolError(`Unknown job "#${id}".`);
			if (rec.status === "running") {
				return {
					content: [
						{
							type: "text",
							text: `Job #${id} is still running.\n\n${rec.output.slice(-4000) || "(no output yet)"}`,
						},
					],
					details: { jobId: id, status: "running", output: rec.output },
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `[bash job ${id} ${rec.status}] exit ${rec.exitCode ?? "?"}\n\n${rec.output || "(no output)"}${rec.note ? `\n\n(${rec.note})` : ""}`,
					},
				],
				details: { jobId: id, status: rec.status, exitCode: rec.exitCode, command: rec.command, output: rec.output },
			};
		},
	});

	pi.registerTool({
		name: "bash_job_cancel",
		label: "Bash Job Cancel",
		description: "Kill a running bash job (jobId from bash_job_start).",
		promptSnippet: "Cancel a running bash job",
		parameters: Type.Object({
			jobId: Type.String({ description: "Job id" }),
		}),
		async execute(_toolCallId, params) {
			const id = params.jobId?.trim();
			if (!id) return toolError("Error: jobId is required.");
			const entry = running.get(id);
			const rec = loadRecord(id);
			if (!rec) return toolError(`Unknown job "#${id}".`);
			if (rec.status !== "running" || !entry) {
				return {
					content: [{ type: "text", text: `Job #${id} is not running (status: ${rec.status}).` }],
					details: { jobId: id, status: rec.status },
				};
			}
			try {
				entry.proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			// mark cancelled — the done handler skips the notify
			rec.status = "cancelled";
			rec.note = "cancelled by the agent";
			rec.finishedAt = Date.now();
			saveRecord(rec);
			running.delete(id);
			return { content: [{ type: "text", text: `Cancelled job #${id}.` }], details: { jobId: id, status: "cancelled" } };
		},
	});

	/* ---------------- /bash-jobs command (for humans) ---------------- */
	pi.registerCommand("bash-jobs", {
		description: "List bash jobs: /bash-jobs",
		handler: async (_args, ctx) => {
			const records = listRecords().slice(0, 20);
			ctx.ui.notify(
				records.length
					? records.map((r) => `#${r.id} [${r.status}] ${r.command.slice(0, 60)}`).join("\n")
					: "No bash jobs yet.",
				"info",
			);
		},
	});
}
