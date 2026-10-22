/**
 * Remembered tool selection.
 *
 * The per-session choice is also stored in `~/.pi/agent/tool-loadout.json`, so
 * a new session starts from the last selection instead of the default tool
 * set. The session entry stays the source of truth inside one session (it
 * follows the branch); this file is the cross-session memory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = "tool-loadout.json";

export function selectionFile(): string {
	return path.join(getAgentDir(), CONFIG_FILE);
}

/** The remembered unit ids, or undefined when nothing was ever selected. */
export function loadSelection(): string[] | undefined {
	try {
		const raw = fs.readFileSync(selectionFile(), "utf-8");
		const parsed = JSON.parse(raw) as { units?: unknown };
		if (Array.isArray(parsed?.units)) {
			return [...new Set(parsed.units.filter((id): id is string => typeof id === "string"))];
		}
	} catch {
		// No remembered selection yet.
	}
	return undefined;
}

export function saveSelection(unitIds: string[]): void {
	fs.mkdirSync(getAgentDir(), { recursive: true });
	fs.writeFileSync(
		selectionFile(),
		JSON.stringify({ units: [...new Set(unitIds)] }, null, 2),
		{ encoding: "utf-8", mode: 0o600 },
	);
}
