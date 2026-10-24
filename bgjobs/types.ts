/**
 * Background job record types.
 */

export type JobStatus = "running" | "done" | "failed" | "killed" | "timeout" | "lost";

export interface JobRecord {
	/** Internal id (also the log file's stem). */
	id: string;
	/** Human-readable handle: unique, short, used in listings and notifications. */
	name: string;
	/** The command the job runs. */
	command: string;
	/** Working directory of the job. */
	cwd: string;
	/** Current state of the job. */
	status: JobStatus;
	/** Exit code of the command (null while running, or when it was signalled). */
	exitCode: number | null;
	/** Terminating signal, when the job was killed. */
	signal: string | null;
	/** Pid of the job's shell (its own process group leader). */
	pid?: number;
	/** Start time (ms since epoch). */
	startedAt: number;
	/** Finish time (ms since epoch). */
	finishedAt?: number;
	/** Log file: stdout and stderr of the job. */
	logPath: string;
	/** File the wrapper writes the command's exit code to. */
	exitFile: string;
	/** Wrapper script that runs the command and records its exit code. */
	scriptPath: string;
	/** Optional kill-after timeout in seconds. */
	timeoutSec?: number;
	/** When the completion message was pushed to the agent. */
	notifiedAt?: number;
	/** Free-form note ("killed by the agent", "timed out", ...). */
	note?: string;
}
