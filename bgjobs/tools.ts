/**
 * Background job tools: bgjob_start / bgjob_list / bgjob_output / bgjob_kill.
 *
 * bgjob_start is the interesting one: it returns immediately and the harness
 * calls back with the result when the job ends. The other tools are for
 * inspecting and stopping jobs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findRecord, isAmbiguous, listRecords } from "./records.ts";
import { describeStatus, formatDuration, killJob, startJob, tailFile } from "./runtime.ts";
import type { JobRecord } from "./types.ts";

const JobHandle = Type.String({
	description:
		"Job id or name (a unique prefix of either works). Names are given to bgjob_start and shown in listings.",
});

function jobDetails(rec: JobRecord | undefined) {
	return {
		id: rec?.id ?? "",
		name: rec?.name ?? "",
		status: rec?.status ?? "missing",
		exitCode: rec?.exitCode ?? null,
		pid: rec?.pid ?? null,
	};
}

function errorResult(text: string, rec?: JobRecord) {
	return {
		content: [{ type: "text" as const, text }],
		details: jobDetails(rec),
		isError: true,
	};
}

/** A compact one-line summary of a job, used in listings. */
function jobLine(rec: JobRecord): string {
	const duration = rec.finishedAt
		? formatDuration(rec.finishedAt - rec.startedAt)
		: formatDuration(Date.now() - rec.startedAt);
	const state = rec.status === "running" ? "running" : describeStatus(rec);
	return `${rec.name} [${rec.id}] — ${state} — ${duration}`;
}

export function registerBgJobTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "bgjob_start",
		label: "Background Job Start",
		description:
			"Run a shell command in the background. The tool returns immediately with a job id; the job keeps running while you do other things, and the harness calls you back with its exit code and the tail of its output when it ends. Use this for long commands (builds, test suites, installs, dev servers, long scripts) instead of a blocking bash call. Never poll or sleep for a job: if the next step depends on the result, end your turn and continue when the callback arrives.",
		promptSnippet: "Run a shell command in the background and get called back when it finishes",
		promptGuidelines: [
			"Start long or slow commands with bgjob_start instead of bash: the job runs in the background and the harness notifies you as soon as it finishes, with the exit code and the tail of the output.",
			"bgjob_start returns immediately. Do not poll it, sleep, or wait for it — keep working on other things, or end your turn with a short summary of what is in flight; the completion callback wakes you up.",
			"Give every job a short, unique name so it can be found again: bgjob_output, bgjob_kill and the listings all take the name or the id.",
			"Use bgjob_output to look at a job's log while it runs, bgjob_list to see all jobs of this session, and bgjob_kill to stop a job that is not needed anymore.",
			"A non-zero exit code means the command failed: read the output tail in the callback, fix the problem, and start the job again.",
		],
		parameters: Type.Object({
			command: Type.String({
				description: "The shell command to run in the background (interpreted by /bin/sh).",
				minLength: 1,
			}),
			name: Type.Optional(
				Type.String({
					description:
						"Short, unique label for the job (used in listings, notifications, and as its handle). Derived from the command when omitted.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory for the command. Defaults to the session's working directory.",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: "Kill the job after this many seconds (safety net for jobs that never end).",
					minimum: 1,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const started = startJob(pi, ctx, {
				command: params.command,
				name: params.name,
				cwd: params.cwd,
				timeoutSec: params.timeout,
			});

			if (!started.ok) {
				return errorResult(`Error: ${started.error}`);
			}

			const rec = started.rec;
			return {
				content: [
					{
						type: "text",
						text:
							`Started background job "${rec.name}" (id ${rec.id}) in ${rec.cwd}.\n` +
							`Command: ${rec.command}\n` +
							`It runs in the background: you will be notified here when it ends, with its exit code and the tail of its output.\n` +
							`Do not poll or wait for it — keep working, or end your turn. Use bgjob_output to peek at the log meanwhile.`,
					},
				],
				details: jobDetails(rec),
			};
		},
	});

	pi.registerTool({
		name: "bgjob_list",
		label: "Background Job List",
		description:
			"List the background jobs of this session: name, id, state (running / finished successfully / failed / killed / timed out), exit code and how long it ran.",
		promptSnippet: "List the background jobs of this session",
		parameters: Type.Object({}),
		async execute() {
			const records = listRecords();
			if (records.length === 0) {
				return {
					content: [{ type: "text", text: "No background jobs in this session." }],
					details: { jobs: [] },
				};
			}
			return {
				content: [{ type: "text", text: records.map(jobLine).join("\n") }],
				details: {
					jobs: records.map((r) => ({
						id: r.id,
						name: r.name,
						status: r.status,
						exitCode: r.exitCode,
					})),
				},
			};
		},
	});

	pi.registerTool({
		name: "bgjob_output",
		label: "Background Job Output",
		description:
			"Show the output (stdout and stderr) of a background job — the tail of its log by default. Works while the job is still running.",
		promptSnippet: "Read the output log of a background job",
		parameters: Type.Object({
			job: JobHandle,
			lines: Type.Optional(
				Type.Number({
					description: "How many lines of output to show (default 50, max 500).",
					minimum: 1,
					maximum: 500,
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const handle = params.job.trim();
			if (!handle) return errorResult("Error: job is required.");
			if (isAmbiguous(handle)) {
				return errorResult(
					`Error: "${handle}" matches more than one job. Use the exact name or id (see bgjob_list).`,
				);
			}
			const rec = findRecord(handle);
			if (!rec) return errorResult(`Error: no background job matching "${handle}".`);

			const lines = Math.min(500, Math.max(1, Math.round(params.lines ?? 50)));
			const tail = tailFile(rec.logPath, lines, 64_000);
			const state = rec.status === "running" ? "still running" : describeStatus(rec);
			const header = `Job "${rec.name}" [${rec.id}] — ${state}\nCommand: ${rec.command}\n`;
			const body = tail ? `--- output ---\n${tail}` : "--- output ---\n(no output yet)";
			return {
				content: [{ type: "text", text: `${header}${body}` }],
				details: jobDetails(rec),
			};
		},
	});

	pi.registerTool({
		name: "bgjob_kill",
		label: "Background Job Kill",
		description:
			"Stop a running background job (the whole process group). The job is reported as killed.",
		promptSnippet: "Stop a running background job",
		parameters: Type.Object({
			job: JobHandle,
		}),
		async execute(_toolCallId, params) {
			const handle = params.job.trim();
			if (!handle) return errorResult("Error: job is required.");
			if (isAmbiguous(handle)) {
				return errorResult(
					`Error: "${handle}" matches more than one job. Use the exact name or id (see bgjob_list).`,
				);
			}
			const rec = findRecord(handle);
			if (!rec) return errorResult(`Error: no background job matching "${handle}".`);
			if (rec.status !== "running") {
				return {
					content: [
						{ type: "text", text: `Job "${rec.name}" is not running (it ${describeStatus(rec)}).` },
					],
					details: jobDetails(rec),
				};
			}
			const stopped = killJob(rec, "killed");
			return {
				content: [
					{
						type: "text",
						text: stopped
							? `Stopping background job "${rec.name}" [${rec.id}].`
							: `Could not stop job "${rec.name}" [${rec.id}].`,
					},
				],
				details: jobDetails(rec),
			};
		},
	});
}
