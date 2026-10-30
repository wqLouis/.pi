/**
 * `/bgjobs` — inspect the background jobs of this session.
 *
 *   /bgjobs              list all jobs
 *   /bgjobs results      list the result logs of finished jobs
 *   /bgjobs show <job>   show a job's output (a job name, or a result log path)
 *   /bgjobs kill <job>   stop a running job
 *   /bgjobs kill-all     stop every running job
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findRecord, listRecords, listResultLogs } from "./records.ts";
import { describeStatus, formatDuration, killAllJobs, killJob, tailFile } from "./runtime.ts";

export function registerBgJobCommand(pi: ExtensionAPI): void {
	pi.registerCommand("bgjobs", {
		description: "List background jobs, show their output, or kill them",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const handle = rest.join(" ");

			const display = (content: string) => {
				try {
					pi.sendMessage({ customType: "bgjobs", content, display: true });
				} catch {
					ctx.ui.notify(content.split("\n")[0] ?? "", "info");
				}
			};

			if (!sub || sub === "list") {
				const records = listRecords();
				if (records.length === 0) {
					display("No background jobs in this session.");
					return;
				}
				// Jobs are one-shot: what is left here is still running (or a
				// report that is still waiting to be delivered).
				const lines = records.map((rec) => {
					const duration = rec.finishedAt
						? formatDuration(rec.finishedAt - rec.startedAt)
						: formatDuration(Date.now() - rec.startedAt);
					const state = rec.status === "running" ? "running" : describeStatus(rec);
					return `${rec.name} [${rec.id}] — ${state} — ${duration}\n  ${rec.command}`;
				});
				display(lines.join("\n"));
				return;
			}

			if (sub === "results") {
				const results = listResultLogs(20);
				if (results.length === 0) {
					display("No result logs yet.");
					return;
				}
				display(
					results
						.map(
							(r) =>
								`${r.file} — ${Math.round(r.size / 1024)} KB — ${new Date(r.mtimeMs).toLocaleString()}\n  ${r.path}`,
						)
						.join("\n"),
				);
				return;
			}

			if (sub === "kill-all" || sub === "killall") {
				const count = killAllJobs("killed");
				display(count === 0 ? "No running background jobs." : `Stopping ${count} background job(s).`);
				return;
			}

			if (!handle) {
				display("Usage: /bgjobs [list | results | show <job|path> | kill <job> | kill-all]");
				return;
			}

			// A path: the result log of a finished job.
			if (handle.startsWith("/") || handle.startsWith("~")) {
				const file = handle.startsWith("~")
					? path.join(process.env.HOME ?? "/root", handle.slice(1))
					: handle;
				if (!fs.existsSync(file)) {
					display(`No file at "${file}".`);
					return;
				}
				display(tailFile(file, 40, 16_000) || "(empty)");
				return;
			}

			const rec = findRecord(handle);
			if (!rec) {
				display(
					`No background job matching "${handle}" (a finished job keeps only its result log — try /bgjobs results).`,
				);
				return;
			}

			if (sub === "kill") {
				const stopped = killJob(rec, "killed");
				display(stopped ? `Stopping "${rec.name}" [${rec.id}].` : `"${rec.name}" is not running.`);
				return;
			}

			// Default and "show": the job's log tail.
			const logPath = rec.resultPath ?? rec.logPath;
			const tail = tailFile(logPath, 40, 16_000);
			const state = rec.status === "running" ? "running" : describeStatus(rec);
			display(
				`${rec.name} [${rec.id}] — ${state}\n${rec.command}\nLog: ${logPath}\n--- output ---\n${tail || "(no output yet)"}`,
			);
		},
	});
}
