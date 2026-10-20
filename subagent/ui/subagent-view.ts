/**
 * The `/subagent view` live transcript viewer.
 *
 * Renders a subagent's session with the same components the main chat uses
 * (markdown user/assistant messages, tool call cards, compaction summaries)
 * inside a centered overlay, and polls the session file while the subagent
 * runs so new messages appear live. OpenCode-backed subagents have no local
 * session file, so their streamed CLI output (plus the last recorded output
 * for older records) is shown instead.
 */

import * as fs from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	sessionEntryToContextMessages,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	Markdown,
	Text,
	getKeybindings,
	matchesKey,
	truncateToWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { backendOf } from "../models.ts";
import { findRecordByName, listRecords, loadRecord, readTranscript, recordLabel } from "../records.ts";
import { getLiveOutput, sessionFileForRecord } from "../state.ts";
import type { SubagentBackend, SubagentRecord } from "../types.ts";
import { extractText, firstLine, formatUsage } from "../usage.ts";
import { ListPickerComponent } from "./list-picker.ts";

const POLL_MS = 1000;
const MIN_VIEWPORT = 5;
const MAX_VIEWPORT = 30;
/** Rows reserved for the overlay chrome (border + header + footer + borders). */
const CHROME_ROWS = 11;

/** The subset of pi's theme API the viewer needs. */
export interface ViewTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface SubagentViewOptions {
	rec: SubagentRecord;
	tui: TUI;
	theme: ViewTheme;
	done: () => void;
	/** Poll interval in ms. */
	pollMs?: number;
	/** Set false to disable the internal poll timer (tests drive refresh()). */
	poll?: boolean;
}

function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

const timeAgo = (ts: number) => `${formatDuration(Date.now() - ts)} ago`;

const statusColor = (status: SubagentRecord["status"]) =>
	status === "running" ? "accent" : status === "error" ? "error" : "success";

export class SubagentViewComponent implements Component {
	private rec: SubagentRecord;
	private readonly tui: TUI;
	private readonly theme: ViewTheme;
	private readonly done: () => void;
	private readonly markdownTheme = getMarkdownTheme();
	private readonly transcript = new Container();
	private readonly file: string;
	private readonly backend: SubagentBackend;
	private readonly toolComponents: ToolExecutionComponent[] = [];
	private readonly assistantComponents: AssistantMessageComponent[] = [];
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();
	private liveMarkdown: Markdown | undefined;
	private lastLive = "";
	private filePos = 0;
	private leftover = "";
	private scrollTop = 0;
	private follow: boolean;
	private expandTools = false;
	private hideThinking = false;
	private closed = false;
	private changedAt = Date.now();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(opts: SubagentViewOptions) {
		this.rec = opts.rec;
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.done = opts.done;
		this.backend = backendOf(opts.rec);
		this.file = sessionFileForRecord(opts.rec);
		this.follow = opts.rec.status === "running";
		this.refresh(true);
		if (opts.poll !== false) {
			this.timer = setInterval(() => this.refresh(), opts.pollMs ?? POLL_MS);
			(this.timer as unknown as { unref?: () => void }).unref?.();
		}
	}

	// --- live data ------------------------------------------------------

	/** Reload the record and pull new transcript content. Returns true when something changed. */
	refresh(initial = false): boolean {
		if (this.closed) return false;
		let changed = false;
		try {
			const updated = loadRecord(this.rec.id);
			if (updated) {
				if (
					updated.status !== this.rec.status ||
					updated.updatedAt !== this.rec.updatedAt ||
					updated.lastOutput !== this.rec.lastOutput
				) {
					changed = true;
				}
				this.rec = updated;
			}
		} catch {
			// Keep the last known record.
		}
		changed = this.backend === "opencode" ? this.pullOpencode() || changed : this.pullSessionFile() || changed;
		if (changed && !initial) {
			this.changedAt = Date.now();
			this.tui.requestRender?.();
		}
		return changed;
	}

	/** Incrementally read the pi session file and render any new entries. */
	private pullSessionFile(): boolean {
		let chunk = "";
		try {
			const stat = fs.statSync(this.file);
			if (stat.size < this.filePos) {
				// File replaced/truncated: start over from the top.
				this.filePos = 0;
				this.leftover = "";
			}
			if (stat.size === this.filePos) return false;
			const length = stat.size - this.filePos;
			const buf = Buffer.alloc(length);
			const fd = fs.openSync(this.file, "r");
			let read = 0;
			try {
				read = fs.readSync(fd, buf, 0, length, this.filePos);
			} finally {
				fs.closeSync(fd);
			}
			if (read <= 0) return false;
			chunk = this.leftover + buf.subarray(0, read).toString("utf-8");
			this.filePos += read;
		} catch {
			return false;
		}

		const lines = chunk.split("\n");
		this.leftover = lines.pop() ?? "";
		let rendered = 0;
		for (const line of lines) {
			if (this.ingest(line)) rendered++;
		}
		return rendered > 0;
	}

	/** Show the streamed opencode output (or the last recorded output for old records). */
	private pullOpencode(): boolean {
		const live = getLiveOutput(this.rec.id);
		const text =
			this.rec.status === "running" ? live || this.rec.lastOutput || "" : this.rec.lastOutput || live || "";
		const first = this.liveMarkdown === undefined;
		if (!first && text === this.lastLive) return false;
		this.lastLive = text;
		const body = text || "_(waiting for output…)_";
		if (first) {
			this.transcript.addChild(
				new Text(this.theme.fg("dim", "  OpenCode session — live output streamed from the CLI."), 0, 0),
			);
			this.transcript.addChild(new Text("", 0, 0));
			this.liveMarkdown = new Markdown(body, 1, 0, this.markdownTheme);
			this.transcript.addChild(this.liveMarkdown);
		} else {
			this.liveMarkdown!.setText(body);
		}
		return true;
	}

	// --- transcript rendering ------------------------------------------

	/** Render one parsed session line; returns true when it produced output. */
	private ingest(line: string): boolean {
		const trimmed = line.trim();
		if (!trimmed) return false;
		let entry: { type?: string; message?: unknown } | undefined;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			return false;
		}
		if (!entry || typeof entry !== "object" || typeof entry.type !== "string") return false;
		const messages =
			entry.type === "message" && entry.message ? [entry.message] : sessionEntryToContextMessages(entry as SessionEntry);
		let rendered = false;
		for (const message of messages) {
			if (this.renderMessage(message)) rendered = true;
		}
		return rendered;
	}

	private renderMessage(message: unknown): boolean {
		if (!message || typeof message !== "object") return false;
		const msg = message as Record<string, unknown> & {
			role?: string;
			content?: unknown;
			toolCallId?: string;
			toolName?: string;
			isError?: boolean;
			durationMs?: number;
			details?: unknown;
		};
		switch (msg.role) {
			case "system":
				return false;
			case "user": {
				const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
				if (!text.trim()) return false;
				this.transcript.addChild(new UserMessageComponent(text, this.markdownTheme, 1));
				return true;
			}
			case "assistant": {
				const component = new AssistantMessageComponent(
					msg as unknown as AssistantMessage,
					this.hideThinking,
					this.markdownTheme,
					undefined,
					1,
				);
				this.transcript.addChild(component);
				this.assistantComponents.push(component);
				const content = Array.isArray(msg.content) ? msg.content : [];
				for (const part of content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
					if (!part || part.type !== "toolCall") continue;
					const tool = new ToolExecutionComponent(
						part.name ?? "tool",
						part.id ?? "",
						part.arguments ?? {},
						{ showImages: false, outputPad: 1 },
						{},
						this.tui,
						this.rec.cwd,
					);
					tool.setExpanded(this.expandTools);
					this.transcript.addChild(tool);
					this.toolComponents.push(tool);
					if (part.id) this.pendingTools.set(part.id, tool);
				}
				return true;
			}
			case "toolResult": {
				const result = {
					content: (Array.isArray(msg.content) ? msg.content : []) as Array<{
						type: string;
						text?: string;
						data?: string;
						mimeType?: string;
					}>,
					details: msg.details,
					isError: !!msg.isError,
					durationMs: msg.durationMs,
				};
				const pending = msg.toolCallId ? this.pendingTools.get(msg.toolCallId) : undefined;
				if (pending) {
					pending.updateResult(result);
					if (msg.toolCallId) this.pendingTools.delete(msg.toolCallId);
					return true;
				}
				// No matching call in view (compacted/resumed session): show it standalone.
				const tool = new ToolExecutionComponent(
					msg.toolName ?? "tool",
					msg.toolCallId ?? "",
					{},
					{ showImages: false, outputPad: 1 },
					{},
					this.tui,
					this.rec.cwd,
				);
				tool.updateResult(result);
				this.transcript.addChild(tool);
				this.toolComponents.push(tool);
				return true;
			}
			case "compactionSummary": {
				this.transcript.addChild(new CompactionSummaryMessageComponent(msg as never, this.markdownTheme, 1));
				return true;
			}
			case "branchSummary": {
				this.transcript.addChild(new BranchSummaryMessageComponent(msg as never, this.markdownTheme, 1));
				return true;
			}
			default:
				return false;
		}
	}

	// --- layout ---------------------------------------------------------

	private viewportHeight(): number {
		const rows = this.tui.terminal?.rows ?? 24;
		return Math.max(MIN_VIEWPORT, Math.min(MAX_VIEWPORT, rows - CHROME_ROWS));
	}

	private rule(width: number): string {
		return this.theme.fg("border", "─".repeat(width));
	}

	private headerLines(width: number): string[] {
		const rec = this.rec;
		const backend = this.backend === "opencode" ? "opencode" : "pi";
		const mode =
			backend === "opencode"
				? rec.opencodeEffort
					? `effort ${rec.opencodeEffort}`
					: "default effort"
				: rec.thinkingLevel
					? `thinking ${rec.thinkingLevel}`
					: "default thinking";
		const model = rec.model ?? "(session model)";
		const line1 = truncateToWidth(
			` ${this.theme.bold(rec.name)} ${this.theme.fg(statusColor(rec.status), `[${rec.status}]`)} · ${backend} · ${model} · ${mode}`,
			width,
		);

		const usage = formatUsage(rec.totalUsage);
		const task = firstLine(rec.activeTask ?? rec.task ?? "").slice(0, 140);
		const meta = [
			task ? `task: ${task}` : undefined,
			usage || undefined,
			`updated ${timeAgo(this.changedAt)}`,
			rec.status !== "running" ? `elapsed ${formatDuration(Date.now() - rec.createdAt)}` : undefined,
			rec.scope && rec.scope.length > 0 ? `scope: ${rec.scope.join(", ")}` : undefined,
		]
			.filter((part): part is string => !!part)
			.join(" · ");
		const line2 = this.theme.fg("dim", truncateToWidth(` ${meta}`, width));
		return [line1, line2];
	}

	private footerLine(width: number): string {
		const follow = this.follow ? this.theme.fg("success", "follow ●") : this.theme.fg("dim", "follow ○");
		const hint =
			`↑/↓ scroll · PgUp/PgDn page · End ${follow} · e tools${this.expandTools ? " ✔" : ""}` +
			`${this.hideThinking ? " · t thinking ✔" : ""} · r refresh · Esc close`;
		return truncateToWidth(` ${this.theme.fg("dim", hint)}`, width);
	}

	render(width: number): string[] {
		const w = Math.max(20, Math.floor(width));
		const content = this.transcript.children.length
			? this.transcript.render(w)
			: [this.theme.fg("dim", "  Waiting for the subagent's first output…")];
		const height = this.viewportHeight();
		const maxTop = Math.max(0, content.length - height);
		this.scrollTop = this.follow ? maxTop : Math.min(Math.max(0, this.scrollTop), maxTop);
		const visible = content.slice(this.scrollTop, this.scrollTop + height);
		const header = this.headerLines(w);
		const lines: string[] = [this.rule(w), ...header, ...visible];
		while (lines.length < 1 + header.length + height) lines.push("");
		lines.push(this.footerLine(w));
		lines.push(this.rule(w));
		return lines;
	}

	invalidate(): void {
		this.transcript.invalidate();
	}

	// --- input ----------------------------------------------------------

	handleInput(data: string): void {
		const kb = getKeybindings();
		const height = this.viewportHeight();
		if (matchesKey(data, Key.escape) || kb.matches(data, "tui.select.cancel")) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.up) || kb.matches(data, "tui.select.up")) this.scrollBy(-1);
		else if (matchesKey(data, Key.down) || kb.matches(data, "tui.select.down")) this.scrollBy(1);
		else if (matchesKey(data, Key.pageUp)) this.scrollBy(-(height - 1));
		else if (matchesKey(data, Key.pageDown)) this.scrollBy(height - 1);
		else if (matchesKey(data, Key.home)) {
			this.follow = false;
			this.scrollTop = 0;
			this.tui.requestRender?.();
		} else if (matchesKey(data, Key.end)) {
			this.follow = true;
			this.tui.requestRender?.();
		} else if (data === "e") {
			this.expandTools = !this.expandTools;
			for (const tool of this.toolComponents) tool.setExpanded(this.expandTools);
			this.tui.requestRender?.();
		} else if (data === "t") {
			this.hideThinking = !this.hideThinking;
			for (const assistant of this.assistantComponents) assistant.setHideThinkingBlock(this.hideThinking);
			this.tui.requestRender?.();
		} else if (data === "r") {
			this.refresh();
		}
	}

	private scrollBy(delta: number): void {
		this.follow = false;
		this.scrollTop = Math.max(0, this.scrollTop + delta);
		this.tui.requestRender?.();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.done();
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const runningFirst = (rec: SubagentRecord) => (rec.status === "running" ? 0 : 1);

async function pickRecord(
	ctx: ExtensionCommandContext,
	records: SubagentRecord[],
): Promise<SubagentRecord | undefined> {
	const byName = new Map(records.map((rec) => [rec.name, rec]));
	const picked = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) =>
		new ListPickerComponent({
			title: "View subagent",
			theme,
			items: records.map((rec) => ({
				value: rec.name,
				label: `${rec.name} [${rec.status}]`,
				description: `${rec.model ?? "session model"} · ${firstLine(rec.task ?? rec.activeTask ?? rec.lastOutput).slice(0, 60) || "(no output yet)"}`,
			})),
			selectedValue: records[0]?.name,
			hint: "Enter to view · Esc to cancel",
			onSelect: (value) => done(value),
			onCancel: () => done(undefined),
		}),
	);
	return picked ? byName.get(picked) : undefined;
}

/** Open the live viewer for a subagent (picker when no name is given). */
export async function showSubagentView(ctx: ExtensionCommandContext, name?: string): Promise<void> {
	const records = listRecords().sort((a, b) => runningFirst(a) - runningFirst(b) || b.updatedAt - a.updatedAt);
	if (records.length === 0) {
		ctx.ui.notify("No subagents spawned yet.", "info");
		return;
	}
	const wanted = name?.trim();
	let rec = wanted ? findRecordByName(wanted) : undefined;
	if (wanted && !rec) {
		ctx.ui.notify(`Unknown subagent "${wanted}".`, "error");
		return;
	}
	if (!rec && (records.length === 1 || ctx.mode !== "tui")) rec = records[0];
	if (!rec && ctx.mode === "tui") {
		rec = await pickRecord(ctx, records);
		if (!rec) return;
	}
	if (!rec) return;

	if (ctx.mode !== "tui") {
		const text =
			rec.backend === "opencode" ? rec.lastOutput : readTranscript(rec.id) || rec.lastOutput || "(no output yet)";
		ctx.ui.notify(`${recordLabel(rec)} [${rec.status}] · ${rec.model ?? "session model"}\n${text.slice(0, 800)}`, "info");
		return;
	}

	const target = rec;
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => new SubagentViewComponent({ rec: target, tui, theme, done }),
		{ overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center", margin: 1 } },
	);
}
