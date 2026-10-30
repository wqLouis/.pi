/**
 * Small result helpers shared by the subagent tool registries.
 */

import type { SubagentBackend, SubagentDetails } from "./types.ts";
import { EMPTY_USAGE } from "./usage.ts";

/** An error result for a tool call that failed before a record existed. */
export function errorDetails(name: string): SubagentDetails {
	return { name, output: "", status: "error", usage: EMPTY_USAGE() };
}

/** Message for a pool disabled with a limit of 0 (no subagents of that backend). */
export function poolDisabledMessage(backend: SubagentBackend): string {
	const key = backend === "opencode" ? "maxOpencodeSubagents" : "maxSubagents";
	const label = backend === "opencode" ? "OpenCode" : "pi";
	return `${label} subagents are disabled: ${key} is 0. Enable them with /subagent config ${key} N (N greater than 0).`;
}

/** A pool limit for display; 0 means the pool is disabled. */
export function poolLimitText(limit: number): string {
	return limit === 0 ? "0 (disabled)" : String(limit);
}
