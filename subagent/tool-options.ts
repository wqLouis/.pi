/**
 * Tool catalog helpers for the subagent settings UI and command.
 *
 * A spawned pi child starts from the same registered tools as this process, so
 * the parent can present a checklist and pass the chosen names to the child as
 * `--tools`. Core tools toggle one by one; an extension's tools are one unit,
 * so a child gets all of an extension's tools or none.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseToolList } from "./config.ts";
import { toolUnits, unitsOfActiveTools, type ToolUnit } from "./tool-groups.ts";

/** The selectable units for a child: core tools plus one unit per extension. */
export function listSubagentToolUnits(pi: ExtensionAPI): ToolUnit[] {
	return toolUnits(pi.getAllTools().filter((tool) => tool.exposure === "direct" || tool.exposure === "model-only"));
}

/** Initial checklist state: the configured tool list, else the parent's current tools. */
export function initialSubagentToolUnits(
	pi: ExtensionAPI,
	configured: string | undefined,
	units: ToolUnit[] = listSubagentToolUnits(pi),
): string[] {
	const known = new Set(units.flatMap((unit) => unit.tools));
	const saved = parseToolList(configured).filter((name) => known.has(name));
	if (saved.length > 0) {
		// A legacy per-tool list: keep the units that contain those tools.
		return units
			.filter((unit) => unit.tools.some((tool) => saved.includes(tool)))
			.map((unit) => unit.id);
	}
	return unitsOfActiveTools(units, pi.getActiveTools());
}
