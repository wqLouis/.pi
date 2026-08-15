/**
 * Bash Guard — default timeout for bash commands + a reminder guideline.
 *
 * pi's bash tool has no default timeout, so when the agent forgets to pass one
 * a command can hang indefinitely. This extension fixes that in every pi
 * process (including spawned subagents):
 *
 *   1. Default timeout — every bash tool call is mutated to carry a 10s
 *      timeout when the agent didn't specify one. Explicit timeouts are
 *      respected. Override the default with the PI_BASH_DEFAULT_TIMEOUT
 *      environment variable (seconds).
 *
 *   2. Reminder guideline — a bullet is appended to the system prompt telling
 *      the agent to always pass a bash timeout (use larger values for long
 *      builds/installs/tests).
 */

import process from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_SECONDS = Number(process.env.PI_BASH_DEFAULT_TIMEOUT ?? "10");

const GUIDELINE =
	`When running bash commands, always pass an explicit timeout (e.g. "timeout": ${DEFAULT_TIMEOUT_SECONDS}) so commands cannot hang indefinitely. ` +
	`A default of ${DEFAULT_TIMEOUT_SECONDS}s is applied automatically when you omit it — pass a larger value for long-running commands such as builds, installs, or tests.`;

export default function (pi: ExtensionAPI) {
	/* ---------------- 1. enforce the default timeout ---------------- */
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		// Mutate in place: later handlers and the tool itself see the patched input.
		event.input.timeout = event.input.timeout ?? DEFAULT_TIMEOUT_SECONDS;
	});

	/* ---------------- 2. remind the agent to pass bash timeouts ---------------- */
	pi.on("before_agent_start", (event) => {
		if (event.systemPrompt.includes(GUIDELINE)) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${GUIDELINE}` };
	});
}
