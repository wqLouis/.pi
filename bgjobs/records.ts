/**
 * Background job record store: ids, names, persistence and lookup.
 *
 * Every job owns four files next to its record:
 *  - <id>.json  the record itself,
 *  - <id>.log   stdout + stderr of the job,
 *  - <id>.exit  the exit code the wrapper script writes when the job ends,
 *  - <id>.sh    the wrapper script that runs the command.
 *
 * A job is transient: once it has been reported to the agent, its record,
 * exit file and wrapper script are deleted. Only its result log survives, in
 * the results directory, so the agent can still read the whole output.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { jobsDir, jobsRoot, resultsRoot } from "./state.ts";
import type { JobRecord } from "./types.ts";

export function newJobId(): string {
	return `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function recordFileIn(dir: string, id: string): string {
	return path.join(dir, `${id}.json`);
}

function logFileIn(dir: string, id: string): string {
	return path.join(dir, `${id}.log`);
}

function exitFileIn(dir: string, id: string): string {
	return path.join(dir, `${id}.exit`);
}

function scriptFileIn(dir: string, id: string): string {
	return path.join(dir, `${id}.sh`);
}

export function recordFile(id: string): string {
	return recordFileIn(jobsDir(), id);
}

export function logFile(id: string): string {
	return logFileIn(jobsDir(), id);
}

export function exitFile(id: string): string {
	return exitFileIn(jobsDir(), id);
}

export function scriptFile(id: string): string {
	return scriptFileIn(jobsDir(), id);
}

export function loadRecordIn(dir: string, id: string): JobRecord | undefined {
	try {
		const raw = fs.readFileSync(recordFileIn(dir, id), "utf-8");
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

export function loadRecord(id: string): JobRecord | undefined {
	return loadRecordIn(jobsDir(), id);
}

export function saveRecord(rec: JobRecord): void {
	fs.writeFileSync(recordFile(rec.id), JSON.stringify(rec, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function listRecordsIn(dir: string): JobRecord[] {
	const records: JobRecord[] = [];
	try {
		for (const file of fs.readdirSync(dir)) {
			if (!file.endsWith(".json")) continue;
			const rec = loadRecordIn(dir, file.slice(0, -5));
			if (rec) records.push(rec);
		}
	} catch {
		// No job dir yet: nothing to list.
	}
	return records.sort((a, b) => b.startedAt - a.startedAt);
}

export function listRecords(): JobRecord[] {
	return listRecordsIn(jobsDir());
}

/**
 * Delete a job's record and all of its files.
 *
 * Used when a job never made it to the end (a failed spawn): nothing of it
 * is worth keeping.
 */
export function deleteJobFilesIn(dir: string, rec: JobRecord): void {
	for (const file of [
		recordFileIn(dir, rec.id),
		logFileIn(dir, rec.id),
		exitFileIn(dir, rec.id),
		scriptFileIn(dir, rec.id),
	]) {
		try {
			fs.rmSync(file, { force: true });
		} catch {
			// Already gone.
		}
	}
}

export function deleteJobFiles(rec: JobRecord): void {
	deleteJobFilesIn(jobsDir(), rec);
}

/**
 * Delete the *state* of a job (its record, exit file and wrapper script) but
 * keep its result log: the job is over, the output stays readable.
 */
export function deleteJobStateIn(dir: string, rec: JobRecord): void {
	for (const file of [recordFileIn(dir, rec.id), exitFileIn(dir, rec.id), scriptFileIn(dir, rec.id)]) {
		try {
			fs.rmSync(file, { force: true });
		} catch {
			// Already gone.
		}
	}
}

export function deleteJobState(rec: JobRecord): void {
	deleteJobStateIn(jobsDir(), rec);
}

/** A file-name-safe version of a job name. */
export function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "job";
}

/** Where the result log of a job is kept: <tmp>/results/<name>--<id>.log */
export function resultLogPath(rec: JobRecord): string {
	return path.join(resultsRoot(), `${slugify(rec.name)}--${rec.id}.log`);
}

/**
 * Move a finished job's log into the results directory under a readable name.
 *
 * The copy is the point: the agent gets a path it can read (cat, grep, tail)
 * after the job itself is gone. Returns the path of the result log.
 */
export function promoteResultLog(rec: JobRecord): string | undefined {
	if (rec.resultPath) {
		// Already promoted: keep the existing result.
		if (fs.existsSync(rec.resultPath)) return rec.resultPath;
	}
	const target = resultLogPath(rec);
	try {
		if (!fs.existsSync(rec.logPath)) return undefined;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(rec.logPath, target);
		fs.rmSync(rec.logPath, { force: true });
		return target;
	} catch {
		return undefined;
	}
}

export interface ResultLog {
	/** Absolute path of the result log. */
	path: string;
	/** File name of the result log. */
	file: string;
	/** Size in bytes. */
	size: number;
	/** Last modification time (ms since epoch). */
	mtimeMs: number;
}

/** The result logs of finished jobs, newest first. */
export function listResultLogs(limit = 20): ResultLog[] {
	const logs: ResultLog[] = [];
	try {
		for (const file of fs.readdirSync(resultsRoot())) {
			if (!file.endsWith(".log")) continue;
			const full = path.join(resultsRoot(), file);
			const stat = fs.statSync(full);
			logs.push({ path: full, file, size: stat.size, mtimeMs: stat.mtimeMs });
		}
	} catch {
		// No results yet.
	}
	return logs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

/** Delete result logs that are older than the given age (temp dir hygiene). */
export function pruneOldResults(maxAgeMs: number): void {
	let files: string[];
	try {
		files = fs.readdirSync(resultsRoot());
	} catch {
		return;
	}
	const cutoff = Date.now() - maxAgeMs;
	for (const file of files) {
		const full = path.join(resultsRoot(), file);
		try {
			if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
		} catch {
			// Already gone.
		}
	}
}

/** Delete the files of the jobs of one directory that were already reported. */
export function pruneReportedArtifacts(dir: string): void {
	for (const rec of listRecordsIn(dir)) {
		if (rec.status === "running" || !rec.notifiedAt) continue;
		deleteJobFilesIn(dir, rec);
	}
}

/** Delete the files of every already-reported job of every session directory. */
export function pruneAllReportedArtifacts(): void {
	let dirs: string[];
	try {
		const root = jobsRoot();
		dirs = fs
			.readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(root, entry.name));
	} catch {
		return;
	}
	for (const dir of dirs) {
		try {
			pruneReportedArtifacts(dir);
		} catch {
			// Nothing to prune in this directory.
		}
	}
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
