/**
 * Tool catalog helpers for the subagent settings UI and command.
 *
 * A spawned pi child starts from the same registered tools as this process, so
 * the parent can present a checklist and pass the chosen names to the child as
 * `--tools`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseToolList } from "./config.ts";

export interface SubagentToolChoice {
	name: string;
	description: string;
	builtin: boolean;
}

/** Tools a subagent can be given directly (direct/model-only exposure). */
export function listSubagentTools(pi: ExtensionAPI): SubagentToolChoice[] {
	return pi
		.getAllTools()
		.filter((tool) => tool.exposure === "direct" || tool.exposure === "model-only")
		.sort((a, b) => {
			const rank = (tool: typeof a) => (tool.sourceInfo.source === "builtin" ? 0 : 1);
			return rank(a) - rank(b) || a.name.localeCompare(b.name);
		})
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			builtin: tool.sourceInfo.source === "builtin",
		}));
}

/** Initial checklist state: the configured set, else the parent's current tools. */
export function initialSubagentToolSelection(
	pi: ExtensionAPI,
	configured: string | undefined,
	tools: SubagentToolChoice[] = listSubagentTools(pi),
): string[] {
	const known = new Set(tools.map((tool) => tool.name));
	const saved = parseToolList(configured).filter((name) => known.has(name));
	if (saved.length > 0) return saved;
	return pi.getActiveTools().filter((name) => known.has(name));
}
