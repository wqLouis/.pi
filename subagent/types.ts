/**
 * Shared types for the subagent extension.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type SubagentStatus = "running" | "idle" | "error";
export type SubagentBackend = "pi" | "opencode";

export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface RunResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: RunUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;

	bubbles?: Array<{ text: string }>;
}

export interface SubagentRecord {
	/** Internal id; only for session-file management. Never shown to users or agents. */
	id: string;
	/** Short, unique, human-readable handle used by users and agents. */
	name: string;
	model?: string;
	/** Thinking level for pi-backed subagents (`--thinking`). */
	thinkingLevel?: ThinkingLevel;
	task?: string;
	sessionPath?: string;
	/** Steering messages queued while the subagent was running; delivered as its next turn when the current run finishes. */
	pendingMessages?: string[];
	systemPrompt: string;
	cwd: string;
	/** Tool allowlist passed to this run (`--tools`), fixed at spawn time. */
	tools?: string;

	/** Which runtime executes this subagent: the pi CLI (default) or the opencode CLI. */
	backend?: SubagentBackend;
	/** OpenCode effort/variant selected for this subagent (undefined = the model's default). */
	opencodeEffort?: string;
	/** Persistent opencode ACP session id, so a later turn resumes the same conversation. */
	opencodeSessionId?: string;
	/** opencode turns started so far; the subagent preamble is injected on the first one only. */
	opencodeTurns?: number;

	scope?: string[];

	allowTmp?: boolean;
	status: SubagentStatus;
	pid?: number;

	/** Main session file that owns this subagent, so it can be found and resumed across sessions. */
	mainSessionFile?: string;
	/** Set while the run was intentionally stopped by a session switch/quit; suppresses finalize/notify so it stays resumable. */
	suspended?: boolean;
	/** Number of automatic resumes performed after interruptions (bounds retry loops). */
	resumeCount?: number;
	/** The userText of the turn currently in flight (diagnostics and resume fallback). */
	activeTask?: string;

	lastError?: string;

	donePushedAt?: number;
	createdAt: number;
	updatedAt: number;
	lastOutput: string;
	totalUsage: RunUsage;
}

export interface SubagentDetails {
	name: string;
	/** All names for a multi-task spawn. */
	names?: string[];
	model?: string;
	output: string;
	status: SubagentStatus;
	usage: RunUsage;
}

export interface SubagentConfig {
	model?: string;
	/** Thinking level for pi-backed subagents; undefined lets the model default apply. */
	thinkingLevel?: ThinkingLevel;
	/** Default runtime for new subagents: the pi CLI (default) or the opencode CLI. */
	backend?: SubagentBackend;
	/** OpenCode model id used when the backend is opencode (default: a free model). */
	opencodeModel?: string;
	/** OpenCode effort/variant for opencode-backed subagents (undefined = model default). */
	opencodeEffort?: string;
	systemPrompt?: string;
	cwd?: string;
	/** Comma-separated tool allowlist passed to pi children as `--tools`; unset = child defaults. */
	tools?: string;

	maxSubagents?: number;
	/** Concurrent opencode-backed subagents allowed. Independent from maxSubagents (their own pool). */
	maxOpencodeSubagents?: number;
	/** Automatically resume interrupted subagents when a session is resumed/reloaded. Default true. */
	autoResume?: boolean;
	/** Maximum automatic resumes per subagent before it is marked as errored. Default 3. */
	maxAutoResumes?: number;

	scope?: string | string[];

	allowTmp?: boolean;

	/**
	 * Prefill the files the main agent recently read into a child's first
	 * message, so the child does not read them again and every child of a
	 * batch shares the same cached prefix. Default true.
	 */
	autoPrefill?: boolean;
}

export interface RunningEntry {
	proc: import("node:child_process").ChildProcess;
	done: Promise<RunResult>;
	rec: SubagentRecord;
	/** Set by subagent_interrupt so the completion handler skips finalize/notify on a killed run. */
	interrupted?: boolean;
	/** RPC transport control channel, used to abort gracefully and continue in the same process. */
	control?: RpcControl;
}

export interface RpcControl {
	/** Additional agent runs queued on top of the current settle, so the process is not shut down early. */
	pendingContinuations: number;
	/** True once stdin has been closed and the child is shutting down. */
	closed: boolean;
	/** Send an RPC command and resolve with its correlated response. */
	sendCommand: (cmd: Record<string, unknown>) => Promise<any>;
}

export interface TaskAssignment {
	task: string;
	name?: string;
	scope?: string | string[];
}
