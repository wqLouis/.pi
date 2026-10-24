/**
 * `/bgjobs` — inspect the background jobs of this session.
 *
 *   /bgjobs              list all jobs
 *   /bgjobs show <job>   show a job's output
 *   /bgjobs kill <job>   stop a running job
 *   /bgjobs kill-all     stop every running job
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findRecord, listRecords } from "./records.ts";
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

			if (sub === "kill-all" || sub === "killall") {
				const count = killAllJobs("killed");
				display(count === 0 ? "No running background jobs." : `Stopping ${count} background job(s).`);
				return;
			}

			if (!handle) {
				display("Usage: /bgjobs [list | show <job> | kill <job> | kill-all]");
				return;
			}

			const rec = findRecord(handle);
			if (!rec) {
				display(`No background job matching "${handle}".`);
				return;
			}

			if (sub === "kill") {
				const stopped = killJob(rec, "killed");
				display(stopped ? `Stopping "${rec.name}" [${rec.id}].` : `"${rec.name}" is not running.`);
				return;
			}

			// Default and "show": the job's log tail.
			const tail = tailFile(rec.logPath, 40, 16_000);
			const state = rec.status === "running" ? "running" : describeStatus(rec);
			display(
				`${rec.name} [${rec.id}] — ${state}\n${rec.command}\n--- output ---\n${tail || "(no output yet)"}`,
			);
		},
	});
}
