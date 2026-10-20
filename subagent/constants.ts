/**
 * Static tunables and defaults for the subagent extension.
 *
 * Kept dependency-free so every other module can import from here without
 * creating cycles.
 */

export const DEFAULT_MAX_SUBAGENTS = 4;
/** Concurrent opencode-backed subagents allowed, on top of (independent from) the pi pool. */
export const DEFAULT_MAX_OPENCODE_SUBAGENTS = 2;
export const DEFAULT_MAX_AUTO_RESUMES = 3;

/** Characters of a subagent's output kept for previews in notifications. */
export const PREVIEW_CHARS = 200;
/** Characters of error detail kept on a failed record. */
export const DETAIL_CHARS = 300;

/** Grace period before escalating SIGTERM to SIGKILL. */
export const KILL_GRACE_MS = 5000;
/** How long to wait for an orphaned child pid to exit before resuming it. */
export const RESUME_WAIT_MS = 3000;

/** Delays for re-delivering completion notifications that may have been missed. */
export const FLUSH_DELAY_MS = 50;
export const SESSION_START_FLUSH_DELAY_MS = 200;
export const FLUSH_INTERVAL_MS = 30_000;

/** Rows visible at once in the subagent settings panel. */
export const SETTINGS_MAX_VISIBLE = 10;

/** Limits for the shared context-prefill block injected into spawned subagents. */
export const PREFILL_MAX_FILE_CHARS = 100_000;
export const PREFILL_MAX_TOTAL_CHARS = 400_000;

/** Default model used for opencode-backed subagents (one of OpenCode's free models). */
export const DEFAULT_OPENCODE_MODEL = "opencode/big-pickle";
/** Effort variant that means "leave the model default alone". */
export const OPENCODE_DEFAULT_EFFORT = "default";
/** Override with PI_OPENCODE_BIN when the opencode CLI is not on PATH. */
export const OPENCODE_BIN = process.env.PI_OPENCODE_BIN || "opencode";
/** How long an ACP probe (model catalog / effort variants) may take. */
export const OPENCODE_PROBE_TIMEOUT_MS = 20_000;

export const DEFAULT_SUBAGENT_PROMPT = [
	"You are a subagent working for a main agent. You run in an isolated context, so the main agent's conversation is not visible to you — only the task you receive and any follow-up instructions.",
	"",
	"Guidelines:",
	"- Complete the assigned task autonomously, using your tools as needed.",
	"- The main agent may send follow-up messages to steer or redirect you. Treat them as updated instructions and adapt your work accordingly.",
	"- When done, report concisely with concrete details (file paths, findings, decisions) that the main agent can act on without re-reading the code.",
	"- If something is blocked or impossible, say so clearly instead of guessing.",
].join("\n");
