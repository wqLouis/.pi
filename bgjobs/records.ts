/**
 * Background job record store: ids, names, persistence and lookup.
 *
 * Every job owns three files next to its record:
 *  - <id>.json  the record itself,
 *  - <id>.log   stdout + stderr of the job,
 *  - <id>.exit  the exit code the wrapper script writes when the job ends.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { jobsDir } from "./state.ts";
import type { JobRecord } from "./types.ts";

export function newJobId(): string {
	return `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function recordFile(id: string): string {
	return path.join(jobsDir(), `${id}.json`);
}

export function logFile(id: string): string {
	return path.join(jobsDir(), `${id}.log`);
}

export function exitFile(id: string): string {
	return path.join(jobsDir(), `${id}.exit`);
}

export function scriptFile(id: string): string {
	return path.join(jobsDir(), `${id}.sh`);
}

export function loadRecord(id: string): JobRecord | undefined {
	try {
		const raw = fs.readFileSync(recordFile(id), "utf-8");
		const rec = JSON.parse(raw) as JobRecord;
		if (rec && typeof rec.id === "string") {
			if (!rec.status) rec.status = "running";
			return rec;
		}
	} catch {
		// Missing or corrupt record: treated as absent.
	}
	return undefined;
}

export function saveRecord(rec: JobRecord): void {
	fs.writeFileSync(recordFile(rec.id), JSON.stringify(rec, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function listRecords(): JobRecord[] {
	const records: JobRecord[] = [];
	try {
		for (const file of fs.readdirSync(jobsDir())) {
			if (!file.endsWith(".json")) continue;
			const rec = loadRecord(file.slice(0, -5));
			if (rec) records.push(rec);
		}
	} catch {
		// No job dir yet: nothing to list.
	}
	return records.sort((a, b) => b.startedAt - a.startedAt);
}

export function sanitizeName(name: string | undefined): string | undefined {
	if (!name) return undefined;
	const cleaned = name.trim().replace(/\s+/g, " ").slice(0, 60);
	return cleaned || undefined;
}

/** A name derived from the command itself, used when the caller gives none. */
export function nameFromCommand(command: string): string {
	const first = command.trim().split(/\n/)[0] ?? "";
	const cleaned = first.replace(/\s+/g, " ").trim();
	return sanitizeName(cleaned.slice(0, 40)) ?? "job";
}

/** Return a name unique against `taken` (case-insensitive). */
export function uniqueName(base: string | undefined, taken: Set<string>): string {
	const root = sanitizeName(base) ?? "job";
	let candidate = root;
	let n = 2;
	while (taken.has(candidate.toLowerCase())) candidate = `${root} ${n++}`;
	taken.add(candidate.toLowerCase());
	return candidate;
}

/** Find a job by exact id, exact name, or a unique prefix of either. */
export function findRecord(handle: string): JobRecord | undefined {
	const target = handle.trim().toLowerCase();
	if (!target) return undefined;
	const all = listRecords();
	const byId = all.find((r) => r.id.toLowerCase() === target);
	if (byId) return byId;
	const byName = all.filter((r) => r.name.toLowerCase() === target);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) return byName[0];
	const prefixed = all.filter(
		(r) => r.name.toLowerCase().startsWith(target) || r.id.toLowerCase().startsWith(target),
	);
	return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** True when the handle matches more than one job (the agent has to be precise). */
export function isAmbiguous(handle: string): boolean {
	const target = handle.trim().toLowerCase();
	if (!target) return false;
	const all = listRecords();
	const exact = all.filter((r) => r.id.toLowerCase() === target || r.name.toLowerCase() === target);
	if (exact.length > 0) return false;
	return all.filter(
		(r) => r.name.toLowerCase().startsWith(target) || r.id.toLowerCase().startsWith(target),
	).length > 1;
}
