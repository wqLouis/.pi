/**
 * Subagent record store: ids, names, persistence, pid checks, transcripts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { backendOf } from "./models.ts";
import {
	getCurrentMainSessionFile,
	recordFile,
	sessionFile,
	sessionFileForRecord,
	subagentDir,
} from "./state.ts";
import type { SubagentBackend, SubagentRecord } from "./types.ts";
import { extractText, sleep } from "./usage.ts";

export function newSubagentId(): string {
	return `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadRecord(id: string): SubagentRecord | undefined {
	try {
		const raw = fs.readFileSync(recordFile(id), "utf-8");
		const rec = JSON.parse(raw) as SubagentRecord;
		if (rec && typeof rec.id === "string") {
			if (!rec.status) rec.status = "idle";
			return rec;
		}
	} catch {
		// Missing/corrupt record: treated as absent.
	}
	return undefined;
}

export function saveRecord(rec: SubagentRecord): void {
	rec.updatedAt = Date.now();
	if (!rec.sessionPath) rec.sessionPath = sessionFile(rec.id);
	if (!rec.mainSessionFile && getCurrentMainSessionFile()) rec.mainSessionFile = getCurrentMainSessionFile();
	fs.writeFileSync(recordFile(rec.id), JSON.stringify(rec, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function listRecords(): SubagentRecord[] {
	const records: SubagentRecord[] = [];
	try {
		for (const file of fs.readdirSync(subagentDir())) {
			if (!file.endsWith(".json")) continue;
			const rec = loadRecord(file.slice(0, -5));
			if (rec) records.push(rec);
		}
	} catch {
		// No subagent dir yet: nothing to list.
	}
	return records;
}

export function sanitizeName(name: string | undefined): string | undefined {
	if (!name) return undefined;
	const cleaned = name.trim().replace(/\s+/g, " ").slice(0, 60);
	return cleaned || undefined;
}

/** The public handle for a subagent. Ids are internal and never shown. */
export function recordLabel(rec: Pick<SubagentRecord, "name">): string {
	return rec.name || "(unnamed)";
}

/** Existing subagent names (lowercased) for uniqueness checks. */
export function existingNames(): Set<string> {
	return new Set(listRecords().map((r) => r.name?.toLowerCase()).filter((n): n is string => !!n));
}

/** Return a name unique against `taken`, adding it to `taken` (case-insensitive). */
export function uniqueName(base: string | undefined, taken: Set<string>): string {
	const root = sanitizeName(base) ?? "subagent";
	let candidate = root;
	let n = 2;
	while (taken.has(candidate.toLowerCase())) candidate = `${root} ${n++}`;
	taken.add(candidate.toLowerCase());
	return candidate;
}

/** Resolve a subagent by exact name (case-insensitive) or a unique name prefix. */
export function findRecordByName(name: string): SubagentRecord | undefined {
	const target = name.trim().toLowerCase();
	if (!target) return undefined;
	const all = listRecords();
	const exact = all.find((r) => r.name?.toLowerCase() === target);
	if (exact) return exact;
	const prefixed = all.filter((r) => r.name?.toLowerCase().startsWith(target));
	return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * Number of live subagents across all sessions of this process's agent dir.
 * Pass a backend to count only that backend's pool (pi and opencode run
 * independently, each bounded by its own limit).
 */
export function countRunningSubagents(backend?: SubagentBackend): number {
	let count = 0;
	try {
		for (const file of fs.readdirSync(subagentDir())) {
			if (!file.endsWith(".json")) continue;
			try {
				const rec = JSON.parse(fs.readFileSync(path.join(subagentDir(), file), "utf-8")) as SubagentRecord;
				if (rec?.status !== "running") continue;
				if (backend && backendOf(rec) !== backend) continue;
				// A run with no live pid (killed/quit/suspended) is not actually consuming a slot.
				if (rec.suspended || rec.pid == null) continue;
				try {
					process.kill(rec.pid, 0);
				} catch {
					continue;
				}
				count++;
			} catch {
				// Unreadable record: skip it.
			}
		}
	} catch {
		// No subagent dir yet.
	}
	return count;
}

export function isPidAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string })?.code === "EPERM";
	}
}

export async function waitForPidExit(pid: number | undefined, timeoutMs: number): Promise<void> {
	if (!pid) return;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && isPidAlive(pid)) await sleep(50);
	if (isPidAlive(pid)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

/** Full transcript text for a subagent's private session file. */
export function readTranscript(id: string): string {
	try {
		const rec = loadRecord(id);
		const raw = fs.readFileSync(rec ? sessionFileForRecord(rec) : sessionFile(id), "utf-8");
		const parts: string[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== "message" || !entry.message) continue;
			const m = entry.message as { role?: string; content?: unknown; toolName?: string };
			const text = extractText(m.content);
			if (m.role === "user") parts.push(`[user] ${text}`);
			else if (m.role === "assistant") parts.push(`[assistant] ${text}`);
			else if (m.role === "toolResult")
				parts.push(`[tool ${m.toolName ?? ""}] ${text.slice(0, 500)}${text.length > 500 ? "…" : ""}`);
		}
		return parts.join("\n\n");
	} catch {
		return "";
	}
}
