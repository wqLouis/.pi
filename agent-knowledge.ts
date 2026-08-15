/**
 * Knowledge Base — cross-session, cross-subagent persistent notes.
 *
 * The agent can save findings, decisions, and reusable context to a shared
 * note store that survives restarts, new sessions, and is visible to every
 * subagent. Notes are plain markdown files under ~/.pi/agent/kb/, so they are
 * also human-readable and editable with the normal file tools.
 *
 * Tools: kb_save, kb_get, kb_search, kb_list, kb_delete (+ /kb command).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const KB_DIR = path.join(getAgentDir(), "kb");
const MAX_NOTE_BYTES = 100_000;

function ensureKbDir(): string {
	fs.mkdirSync(KB_DIR, { recursive: true });
	return KB_DIR;
}

/** Slug a note name into a safe filename. */
function slug(name: string): string {
	const s = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || "note";
}

function noteFile(name: string): string {
	return path.join(ensureKbDir(), `${slug(name)}.md`);
}

function resolveNote(name: string): string | undefined {
	const file = noteFile(name);
	return fs.existsSync(file) ? file : undefined;
}

function readNotes(): Array<{ name: string; file: string; content: string; updatedMs: number }> {
	const notes: Array<{ name: string; file: string; content: string; updatedMs: number }> = [];
	try {
		for (const file of fs.readdirSync(ensureKbDir())) {
			if (!file.endsWith(".md")) continue;
			const full = path.join(KB_DIR, file);
			try {
				const stat = fs.statSync(full);
				const content = fs.readFileSync(full, "utf-8");
				notes.push({ name: file.slice(0, -3), file: full, content, updatedMs: stat.mtimeMs });
			} catch {
				/* skip unreadable */
			}
		}
	} catch {
		/* dir missing */
	}
	return notes.sort((a, b) => b.updatedMs - a.updatedMs);
}

const toolError = (error: unknown) => ({
	content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
	details: {},
	isError: true,
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "kb_save",
		label: "Knowledge Save",
		description:
			"Save or update a persistent note in the shared knowledge base (~/.pi/agent/kb/). Notes survive restarts and are visible to every subagent — use for findings, decisions, project facts, and reusable context you want beyond the current conversation.",
		promptSnippet: "Save a note to the knowledge base",
		promptGuidelines: [
			"Use kb_save to persist important findings, decisions, and project facts so they survive across sessions and are shared with subagents.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Note name (slugified into the filename, e.g. 'deployment steps')" }),
			content: Type.String({ description: "Note content (markdown)" }),
			overwrite: Type.Optional(Type.Boolean({ description: "Overwrite an existing note (default false)" })),
		}),
		async execute(_toolCallId, params) {
			const name = params.name?.trim();
			if (!name) return toolError("Error: name is required.");
			if (!params.content) return toolError("Error: content is required.");
			if (Buffer.byteLength(params.content, "utf-8") > MAX_NOTE_BYTES) {
				return toolError(`Note too large (max ${MAX_NOTE_BYTES / 1000}KB).`);
			}
			const file = noteFile(name);
			if (fs.existsSync(file) && !params.overwrite) {
				return toolError(`Note "${slug(name)}" already exists. Pass overwrite: true to replace it, or kb_get to read it first.`);
			}
			fs.writeFileSync(file, params.content, { encoding: "utf-8", mode: 0o600 });
			return {
				content: [{ type: "text", text: `Saved note "${slug(name)}" (${params.content.length} chars) to ${file}.` }],
				details: { name: slug(name), file },
			};
		},
	});

	pi.registerTool({
		name: "kb_get",
		label: "Knowledge Get",
		description: "Read a note from the knowledge base by name.",
		promptSnippet: "Read a knowledge base note",
		parameters: Type.Object({
			name: Type.String({ description: "Note name" }),
		}),
		async execute(_toolCallId, params) {
			const name = params.name?.trim();
			if (!name) return toolError("Error: name is required.");
			const file = resolveNote(name);
			if (!file) return toolError(`No note named "${slug(name)}". Use kb_list to see available notes.`);
			const content = fs.readFileSync(file, "utf-8");
			return {
				content: [{ type: "text", text: content.slice(0, 40000) }],
				details: { name: slug(name), file, length: content.length },
			};
		},
	});

	pi.registerTool({
		name: "kb_search",
		label: "Knowledge Search",
		description:
			"Search note names and contents in the knowledge base. Returns matching notes with title and snippet lines around the match.",
		promptSnippet: "Search the knowledge base",
		parameters: Type.Object({
			query: Type.String({ description: "Search terms (case-insensitive substring match)" }),
		}),
		async execute(_toolCallId, params) {
			const query = params.query?.trim().toLowerCase();
			if (!query) return toolError("Error: query is required.");
			const hits: Array<{ name: string; file: string; snippet: string }> = [];
			for (const note of readNotes()) {
				if (note.name.includes(query) || note.content.toLowerCase().includes(query)) {
					// snippet: first line containing the query (or the note's head)
					const lines = note.content.split("\n");
					const idx = lines.findIndex((l) => l.toLowerCase().includes(query));
					const snippet =
						idx >= 0
							? lines.slice(Math.max(0, idx - 1), idx + 3).join("\n").slice(0, 300)
							: lines.slice(0, 3).join("\n").slice(0, 300);
					hits.push({ name: note.name, file: note.file, snippet });
				}
			}
			if (hits.length === 0) {
				return {
					content: [{ type: "text", text: `No notes match "${params.query}".` }],
					details: { query: params.query, hits: [] },
				};
			}
			const text = [`${hits.length} note(s) match "${params.query}":`, ""]
				.concat(hits.map((h) => `### ${h.name}\n\n${h.snippet}`))
				.join("\n");
			return { content: [{ type: "text", text }], details: { query: params.query, hits } };
		},
	});

	pi.registerTool({
		name: "kb_list",
		label: "Knowledge List",
		description: "List all notes in the knowledge base with size and last-updated time.",
		promptSnippet: "List knowledge base notes",
		parameters: Type.Object({}),
		async execute() {
			const notes = readNotes();
			if (notes.length === 0) {
				return {
					content: [{ type: "text", text: "Knowledge base is empty. Save notes with kb_save." }],
					details: { notes: [] },
				};
			}
			const text = [
				`${notes.length} note(s) in the knowledge base:`,
				...notes.map(
					(n) =>
						`- ${n.name} (${n.content.length} chars · updated ${new Date(n.updatedMs).toLocaleString()})`,
				),
			].join("\n");
			return { content: [{ type: "text", text }], details: { notes: notes.map((n) => ({ name: n.name, file: n.file })) } };
		},
	});

	pi.registerTool({
		name: "kb_delete",
		label: "Knowledge Delete",
		description: "Delete a note from the knowledge base by name.",
		promptSnippet: "Delete a knowledge base note",
		parameters: Type.Object({
			name: Type.String({ description: "Note name" }),
		}),
		async execute(_toolCallId, params) {
			const name = params.name?.trim();
			if (!name) return toolError("Error: name is required.");
			const file = resolveNote(name);
			if (!file) return toolError(`No note named "${slug(name)}".`);
			fs.rmSync(file, { force: true });
			return { content: [{ type: "text", text: `Deleted note "${slug(name)}".` }], details: { name: slug(name) } };
		},
	});

	/* ---------------- /kb command (for humans) ---------------- */
	pi.registerCommand("kb", {
		description: "Knowledge base: /kb list | get <name> | search <query> | delete <name>",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const first = parts[0];
			if (first === "list") {
				const notes = readNotes();
				ctx.ui.notify(
					notes.length ? notes.map((n) => `${n.name} (${n.content.length} chars)`).join("\n") : "Knowledge base is empty.",
					"info",
				);
				return;
			}
			if (first === "get" || first === "delete") {
				const name = parts.slice(1).join(" ");
				if (!name) {
					ctx.ui.notify(`Usage: /kb ${first} <name>`, "info");
					return;
				}
				if (first === "get") {
					const file = resolveNote(name);
					ctx.ui.notify(file ? fs.readFileSync(file, "utf-8").slice(0, 600) : `No note named "${slug(name)}".`, "info");
				} else {
					const file = resolveNote(name);
					if (file) fs.rmSync(file, { force: true });
					ctx.ui.notify(file ? `Deleted "${slug(name)}".` : `No note named "${slug(name)}".`, "info");
				}
				return;
			}
			if (first === "search") {
				const query = parts.slice(1).join(" ").toLowerCase();
				const hits = readNotes().filter(
					(n) => !query || n.name.includes(query) || n.content.toLowerCase().includes(query),
				);
				ctx.ui.notify(
					hits.length ? hits.map((h) => `- ${h.name}: ${h.content.split("\n")[0].slice(0, 80)}`).join("\n") : "No matches.",
					"info",
				);
				return;
			}
			ctx.ui.notify("Knowledge base: /kb list | get <name> | search <query> | delete <name>", "info");
		},
	});
}
