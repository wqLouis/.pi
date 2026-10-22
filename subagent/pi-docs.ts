/**
 * Pi's "docs" system-prompt section.
 *
 * pi always adds a `<docs>` section that points at its own documentation
 * (README, docs/, examples/). That is only useful when the session actually
 * works on pi itself, so the section is shown when the working directory is
 * under a `.pi` path (for example `~/.pi/agent/extensions`) and hidden
 * everywhere else.
 *
 * The mode can be overridden:
 *  - `PI_DOCS_SECTION=always|never|auto` (environment),
 *  - `/pi-docs always|never|auto` (command, stored in `~/.pi/agent/pi-docs.json`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type DocsMode = "auto" | "always" | "never";

const CONFIG_FILE = "pi-docs.json";

/** True when the path has a `.pi` path segment, e.g. `/home/u/.pi/agent`. */
export function isUnderPiPath(cwd: string): boolean {
	const normalized = cwd.replace(/\\/g, "/");
	return /(^|\/)\.pi(\/|$)/.test(normalized);
}

export function configPath(): string {
	return path.join(getAgentDir(), CONFIG_FILE);
}

export function loadDocsMode(): DocsMode {
	const env = process.env.PI_DOCS_SECTION?.trim().toLowerCase();
	if (env === "always" || env === "never" || env === "auto") return env;
	try {
		const raw = fs.readFileSync(configPath(), "utf-8");
		const parsed = JSON.parse(raw) as { mode?: DocsMode };
		if (parsed?.mode === "always" || parsed?.mode === "never" || parsed?.mode === "auto") return parsed.mode;
	} catch {
		// No config yet.
	}
	return "auto";
}

export function saveDocsMode(mode: DocsMode): void {
	fs.mkdirSync(getAgentDir(), { recursive: true });
	fs.writeFileSync(configPath(), JSON.stringify({ mode }, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/** Whether the docs section belongs in the prompt for this working directory. */
export function shouldShowDocs(cwd: string, mode: DocsMode = loadDocsMode()): boolean {
	if (mode === "always") return true;
	if (mode === "never") return false;
	return isUnderPiPath(cwd);
}

/** Remove the `<docs>…</docs>` block from a rendered system prompt. */
export function stripDocsSection(text: string): string {
	return text.replace(/\n?<docs>\n[\s\S]*?\n<\/docs>\n?/g, "\n");
}

/**
 * Remove the docs section from the system messages of a request. The section
 * map is pi's structured representation of the prompt; dropping the entry
 * keeps the transcript intact while the request no longer carries the docs.
 */
export function stripDocsFromMessages<T extends { role?: string; content?: unknown; sections?: Record<string, string | null> | undefined }>(
	messages: T[],
): T[] {
	let changed = false;
	const next = messages.map((message) => {
		if (message.role !== "system") return message;
		const sections = message.sections;
		if (!sections || sections.docs === undefined) return message;
		const updated = { ...sections };
		delete updated.docs;
		changed = true;
		return { ...message, sections: updated };
	});
	return changed ? next : messages;
}
