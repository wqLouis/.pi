/**
 * Agent Memory Manager
 *
 * Lets the agent manage its own conversation memory — an alternative to
 * (and complement of) compaction.
 *
 *  - memory_index   – survey the whole conversation: for every turn, the first
 *                     few lines of the turn start (user message) and turn end
 *                     (last assistant message), plus size estimates.
 *  - memory_drop    – drop whole turns. Nothing is deleted from the session
 *                     file: on every subsequent LLM context build, the dropped
 *                     turn's messages are replaced by compact stubs holding the
 *                     first few lines of each message (roles and tool-call /
 *                     tool-result pairing are preserved), so the agent still
 *                     knows *something* about what happened there.
 *  - memory_restore – undo a drop and get the full detail back.
 *  - memory_status  – what is currently dropped + context usage.
 *
 * It also nudges the agent proactively: once context usage crosses 30% of the
 * model's context window (before a prompt is processed), it injects a message
 * the agent can see, telling it to drop memories it no longer needs. Re-nudges
 * at each escalation band: 30% → 50% → 70% (once per band).
 *
 * Drop state is persisted in the session as custom entries
 * (customType "agent-memory"), so it survives restarts, reloads, and
 * branching.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MEMORY_CUSTOM_TYPE = "agent-memory";
const DEFAULT_LINES = 4;
const MAX_PREVIEW_LINES = 20; // upper bound for stored previews (index can slice further)
const MAX_STUB_CHARS = 160; // max chars kept for tool-call arguments in stubs

// Context-usage nudge: the agent is told (via a custom message it can see) to
// drop memories it no longer needs, once per usage band. Bands are crossed at
// these percentages of the model's context window, so it nudges at 30% → 50%
// → 70% and never nags between bands.
const NUDGE_THRESHOLDS_PERCENT = [30, 50, 70];

/** Guards against racing nudge triggers (agent_end + idle timer) double-pushing. */
let nudgeInFlight = false;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface TurnInfo {
	turnId: string; // entry id of the turn's first user message — stable
	index: number; // 1-based, informational
	startEntryId: string;
	endEntryId: string;
	entryIds: string[]; // ids of all message entries in the turn
	startPreview: string; // first few lines of the user message
	endPreview: string; // first few lines of the last assistant message
	messageCount: number;
	approxTokens: number;
	timestamp: string; // ISO of the turn start entry
}

interface DroppedTurn {
	turnId: string;
	index: number;
	entryIds: string[];
	hashes: string[]; // content hashes of each message in the turn (order matters)
	startPreview: string;
	endPreview: string;
	lines: number;
	droppedAt: number;
	approxTokensSaved: number;
	messageCount: number;
}

interface MemoryState {
	version: 1;
	drops: DroppedTurn[];
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	// Defensive: a single content block object instead of an array
	// (old or hand-edited sessions can contain these).
	if (content && typeof content === "object" && !Array.isArray(content)) {
		const block = content as { type?: string; text?: unknown };
		if (block.type === "text" && typeof block.text === "string") return block.text;
		return "";
	}
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: string }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n");
}

function firstLines(text: string, n: number): string {
	return text
		.split("\n")
		.slice(0, Math.max(0, n))
		.join("\n");
}

function toolCallNames(msg: AgentMessage): string[] {
	const content = (msg as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	const names: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: string }).type === "toolCall" &&
			typeof (block as { name?: unknown }).name === "string"
		) {
			names.push((block as { name: string }).name);
		}
	}
	return names;
}

function estimateTokens(msg: AgentMessage): number {
	const m = msg as { content?: unknown; output?: unknown; command?: unknown };
	let chars = 0;
	if (typeof m.content === "string") chars += m.content.length;
	else if (Array.isArray(m.content)) chars += JSON.stringify(m.content).length;
	if (typeof m.output === "string") chars += m.output.length;
	if (typeof m.command === "string") chars += m.command.length;
	return Math.ceil(chars / 4);
}

function hashString(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(36);
}

/**
 * Stable fingerprint of a message. The same message object is what gets sent
 * in the context event (session entries -> buildSessionContext -> context),
 * so hashes computed here match hashes computed in the context handler.
 */
function hashMessage(msg: AgentMessage): string {
	const m = msg as { content?: unknown; toolCallId?: unknown; toolName?: unknown; command?: unknown; output?: unknown };
	const fields: unknown[] = [msg.role];
	if (m.content !== undefined) fields.push(m.content);
	if (m.toolCallId !== undefined) fields.push(m.toolCallId);
	if (m.toolName !== undefined) fields.push(m.toolName);
	if (m.command !== undefined) fields.push(m.command);
	if (m.output !== undefined) fields.push(m.output);
	return hashString(JSON.stringify(fields));
}

function trimArgs(args: unknown): Record<string, unknown> {
	if (args === undefined || args === null) return {};
	if (typeof args === "string") {
		const s = args.length > MAX_STUB_CHARS ? `${args.slice(0, MAX_STUB_CHARS)}…` : args;
		return { value: s };
	}
	if (typeof args !== "object") return { value: args };
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args)) {
		const s = JSON.stringify(v);
		if (s !== undefined && s.length > MAX_STUB_CHARS) out[k] = `${s.slice(0, MAX_STUB_CHARS)}…`;
		else out[k] = v;
	}
	return out;
}

function formatTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function indentPreview(text: string): string {
	return text
		.split("\n")
		.map((line, i) => (i === 0 ? line : `      ${line}`))
		.join("\n");
}

/* ------------------------------------------------------------------ */
/* Turn grouping & index                                               */
/* ------------------------------------------------------------------ */

function buildTurns(entries: SessionEntry[]): TurnInfo[] {
	const turns: TurnInfo[] = [];
	let current: TurnInfo | null = null;

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "user") {
			if (current) turns.push(current);
			current = {
				turnId: entry.id,
				index: turns.length + 1,
				startEntryId: entry.id,
				endEntryId: entry.id,
				entryIds: [entry.id],
				startPreview: firstLines(extractText(msg.content), MAX_PREVIEW_LINES),
				endPreview: "",
				messageCount: 1,
				approxTokens: estimateTokens(msg),
				timestamp: entry.timestamp,
			};
		} else if (current) {
			current.entryIds.push(entry.id);
			current.messageCount += 1;
			current.approxTokens += estimateTokens(msg);
			if (msg.role === "assistant") {
				current.endEntryId = entry.id;
				const text = firstLines(extractText(msg.content), MAX_PREVIEW_LINES);
				const tools = toolCallNames(msg);
				current.endPreview =
					text.length > 0 ? text : tools.length > 0 ? `[tool calls: ${tools.join(", ")}]` : "";
			}
		}
	}
	if (current) turns.push(current);
	return turns;
}

function buildIndexText(turns: TurnInfo[], state: MemoryState, lines: number): string {
	const droppedById = new Map(state.drops.map((d) => [d.turnId, d]));
	const totalTokens = turns.reduce((acc, t) => acc + t.approxTokens, 0);
	const savedTokens = state.drops.reduce((acc, d) => acc + d.approxTokensSaved, 0);

	const out: string[] = [];
	out.push(
		`Memory index — ${turns.length} turn(s), ~${fmtTokens(totalTokens)} tokens total, ` +
			`${state.drops.length} dropped (saves ~${fmtTokens(savedTokens)} tokens)`,
	);
	out.push("");

	for (const turn of turns) {
		const drop = droppedById.get(turn.turnId);
		const status = drop ? "dropped" : "active";
		const time = formatTime(turn.timestamp);
		out.push(
			`Turn ${turn.index} (${turn.turnId}) [${status}]${time ? ` · ${time}` : ""} · ` +
				`${turn.messageCount} msgs · ~${fmtTokens(turn.approxTokens)} tokens`,
		);
		const start = firstLines(turn.startPreview, lines);
		out.push(start.length > 0 ? `  start: ${indentPreview(start)}` : "  start: (no text)");
		const end = turn.endPreview;
		out.push(end.length > 0 ? `  end: ${indentPreview(end)}` : "  end: (no assistant reply yet)");
		out.push("");
	}

	out.push("Tip: pass turn IDs (or numbers) to memory_drop to compress old turns.");
	return out.join("\n").trim();
}

function resolveTurnIds(turns: TurnInfo[], ids: string[]): TurnInfo[] {
	const byId = new Map(turns.map((t) => [t.turnId, t]));
	const byIndex = new Map(turns.map((t) => [String(t.index), t]));
	const resolved: TurnInfo[] = [];
	for (const id of ids) {
		const turn = byId.get(id) ?? byIndex.get(id);
		if (turn && !resolved.includes(turn)) resolved.push(turn);
	}
	return resolved;
}

/* ------------------------------------------------------------------ */
/* State (persisted as custom entries in the session)                  */
/* ------------------------------------------------------------------ */

function loadState(ctx: ExtensionContext): MemoryState {
	let state: MemoryState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (
			entry.type === "custom" &&
			entry.customType === MEMORY_CUSTOM_TYPE &&
			entry.data &&
			typeof entry.data === "object" &&
			Array.isArray((entry.data as MemoryState).drops)
		) {
			state = entry.data as MemoryState;
		}
	}
	return state ?? { version: 1, drops: [] };
}

function saveState(state: MemoryState, pi: ExtensionAPI) {
	pi.appendEntry(MEMORY_CUSTOM_TYPE, state);
}

function updateStatusWidget(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	const state = loadState(ctx);
	if (state.drops.length === 0) {
		ctx.ui.setStatus("agent-memory", "");
		return;
	}
	const saved = state.drops.reduce((acc, d) => acc + d.approxTokensSaved, 0);
	const usage = ctx.getContextUsage();
	const pct = usage && usage.percent != null ? ` · ${Math.round(usage.percent)}% ctx` : "";
	ctx.ui.setStatus("agent-memory", `memory: ${state.drops.length} dropped (~${fmtTokens(saved)} saved)${pct}`);
}

/* ------------------------------------------------------------------ */
/* Context-usage nudge (tells the agent to drop unneeded memory)       */
/* ------------------------------------------------------------------ */

/** Most recent nudge percent on the branch, parsed from pushed user messages. */
function getLastNudge(ctx: ExtensionContext): { percentAtNudge: number } | undefined {
	let last: { percentAtNudge: number } | undefined;
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = (entry as { message?: unknown }).message as { role?: string; content?: unknown } | undefined;
			if (msg?.role !== "user") continue;
			const m = extractText(msg.content).match(/\[memory notice\][^\n]*?at (\d+)%/);
			if (m) {
				const p = Number(m[1]);
				if (!last || p > last.percentAtNudge) last = { percentAtNudge: p };
			}
		}
	} catch {
		/* ignore */
	}
	return last;
}

function buildNudgeText(percent: number, tokens: number | null, contextWindow: number, droppedCount: number, droppableCount: number): string {
	const out: string[] = [];
	out.push(
		`[memory notice] Context usage is at ${Math.round(percent)}%` +
			` (${tokens != null ? fmtTokens(tokens) : "?"} / ${fmtTokens(contextWindow)} tokens).`,
	);
	if (droppedCount === 0) {
		out.push(
			`Consider calling memory_drop on old turns you no longer need — ${droppableCount} turn(s) are droppable (memory_index lists them).`,
		);
	} else {
		out.push(
			`You have already dropped ${droppedCount} turn(s); consider dropping more — ${droppableCount} further turn(s) are droppable.`,
		);
	}
	out.push("Dropped turns keep their first few lines and can be restored anytime with memory_restore.");
	return out.join("\n");
}

/**
 * Nudge the agent by pushing a REAL user steering message (sendUserMessage),
 * which always triggers a turn and is visible in the chat — unlike a hidden
 * custom message injected into the context. Fires at most once per usage band
 * (30%, 50%, 70%) and only when there are turns worth dropping.
 */
function maybePushNudge(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
	let usage;
	try {
		usage = ctx.getContextUsage();
	} catch {
		return false;
	}
	if (!usage || usage.percent == null) return false;
	const percent = usage.percent;

	// Current band = highest threshold at or below the current usage.
	const band = NUDGE_THRESHOLDS_PERCENT.filter((t) => percent >= t).pop();
	if (!band) return false;

	// Only nudge when there is something worth dropping (exclude the current turn).
	const state = loadState(ctx);
	const turns = buildTurns(ctx.sessionManager.getBranch());
	const lastTurn = turns[turns.length - 1];
	const dropped = new Set(state.drops.map((d) => d.turnId));
	const droppable = turns.filter((t) => !dropped.has(t.turnId) && (!lastTurn || t.turnId !== lastTurn.turnId));
	if (droppable.length === 0) return false;

	// Once per band: skip if the last nudge already happened at or above this band.
	const lastNudge = getLastNudge(ctx);
	if (lastNudge && lastNudge.percentAtNudge >= band) return false;

	// Guard against racing triggers (agent_end + idle timer) pushing twice.
	if (nudgeInFlight) return false;
	nudgeInFlight = true;
	try {
		pi.sendUserMessage(buildNudgeText(usage.percent, usage.tokens, usage.contextWindow, dropped.size, droppable.length));
	} catch {
		/* delivery failed — try again later */
	}
	setTimeout(() => {
		nudgeInFlight = false;
	}, 5000);
	return true;
}

/* ------------------------------------------------------------------ */
/* Stubbing (context rewriting)                                        */
/* ------------------------------------------------------------------ */

function stubMessage(msg: AgentMessage, turn: DroppedTurn, firstInTurn: boolean): AgentMessage {
	const m = msg as unknown as Record<string, unknown>;
	const clone = { ...msg } as unknown as Record<string, unknown>;
	const lines = Math.max(1, turn.lines);

	switch (msg.role) {
		case "user": {
			const preview = firstLines(extractText(m.content), lines);
			const marker = firstInTurn
				? `[memory: turn ${turn.index} dropped — ${turn.messageCount} messages compressed to first ${lines} line(s)]`
				: "";
			const text = [marker, preview].filter((s) => s.trim().length > 0).join("\n");
			clone.content = [{ type: "text", text: text || "[memory: message content omitted]" }];
			break;
		}
		case "assistant": {
			const content = Array.isArray(m.content) ? m.content : [];
			const newBlocks: Array<Record<string, unknown>> = [];
			const preview = firstLines(extractText(content), lines);
			if (preview) newBlocks.push({ type: "text", text: preview });
			for (const block of content) {
				if (block && typeof block === "object" && (block as { type?: string }).type === "toolCall") {
					const tc = block as { id?: unknown; name?: unknown; arguments?: unknown };
					newBlocks.push({
						type: "toolCall",
						id: tc.id ?? "",
						name: tc.name ?? "",
						arguments: trimArgs(tc.arguments),
					});
				}
			}
			if (newBlocks.length === 0) {
				newBlocks.push({ type: "text", text: "[memory: assistant reply omitted]" });
			}
			clone.content = newBlocks;
			break;
		}
		case "toolResult": {
			const preview = firstLines(extractText(m.content), Math.max(1, Math.min(lines, 2)));
			const name = typeof m.toolName === "string" ? m.toolName : "tool";
			clone.content = [{ type: "text", text: preview || `[${name}: no text output]` }];
			delete clone.details; // tool details are usually the bulk — drop them too
			break;
		}
		case "bashExecution": {
			if (typeof m.command === "string") clone.command = m.command;
			if (typeof m.output === "string") clone.output = firstLines(m.output, 2);
			break;
		}
		default: {
			// custom / other roles: keep role, keep only the first lines of text
			const text = extractText(m.content);
			if (text) clone.content = [{ type: "text", text: firstLines(text, lines) }];
		}
	}

	return clone as unknown as AgentMessage;
}

function applyDrops(messages: AgentMessage[], state: MemoryState): AgentMessage[] | undefined {
	if (state.drops.length === 0) return undefined;

	// Order drops by where their first message appears in the context so the
	// greedy subsequence matching below walks turns in conversation order,
	// even when they were dropped out of order. Drops whose messages are no
	// longer present (e.g. already compacted away) sort last and never match.
	const messageHashes = messages.map((m) => hashMessage(m));
	const positioned = state.drops
		.map((drop) => {
			let pos = -1;
			const h0 = drop.hashes[0];
			if (h0 !== undefined) {
				for (let i = 0; i < messageHashes.length; i++) {
					if (messageHashes[i] === h0) {
						pos = i;
						break;
					}
				}
			}
			return { drop, pos };
		})
		.sort((a, b) => (a.pos === -1 ? 1 : 0) - (b.pos === -1 ? 1 : 0) || a.pos - b.pos);

	// Flatten all dropped turns into one ordered (turn, hash) sequence.
	const sequence: Array<{ turn: DroppedTurn; hash: string; firstInTurn: boolean }> = [];
	for (const { drop } of positioned) {
		drop.hashes.forEach((hash, i) => {
			sequence.push({ turn: drop, hash, firstInTurn: i === 0 });
		});
	}

	let ptr = 0;
	let changed = false;
	const newMessages = messages.map((msg, i) => {
		if (ptr < sequence.length && messageHashes[i] === sequence[ptr].hash) {
			const { turn, firstInTurn } = sequence[ptr];
			ptr++;
			changed = true;
			return stubMessage(msg, turn, firstInTurn);
		}
		return msg;
	});

	return changed ? newMessages : undefined;
}

/* ------------------------------------------------------------------ */
/* Tool param schemas                                                  */
/* ------------------------------------------------------------------ */

const IndexParams = Type.Object({
	lines: Type.Optional(
		Type.Integer({ description: "Preview lines per turn start/end (default 4)", minimum: 1, maximum: 20 }),
	),
	offset: Type.Optional(
		Type.Integer({ description: "Only list turns with number >= this value (1-based)", minimum: 1 }),
	),
	maxTurns: Type.Optional(Type.Integer({ description: "Maximum number of turns to list", minimum: 1 })),
});

const DropParams = Type.Object({
	turnIds: Type.Array(
		Type.String({
			description:
				"Turn IDs (or 1-based turn numbers) to drop, e.g. ['a1b2c3d4', '3']. Get them from memory_index.",
		}),
	),
	lines: Type.Optional(
		Type.Integer({ description: "Lines of each message to keep in the compressed stub (default 4)", minimum: 1, maximum: 20 }),
	),
	includeCurrent: Type.Optional(
		Type.Boolean({ description: "Also allow dropping the current in-progress turn (default false)", default: false }),
	),
});

const RestoreParams = Type.Object({
	turnIds: Type.Optional(
		Type.Array(Type.String({ description: "Turn IDs (or numbers) to restore. Omit to restore everything." })),
	),
});

const StatusParams = Type.Object({});

/* ------------------------------------------------------------------ */
/* Extension factory                                                   */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
	/* ---------------- context rewriting ---------------- */
	pi.on("context", (event, ctx) => {
		const state = loadState(ctx);
		const result = applyDrops(event.messages, state);
		return result ? { messages: result } : undefined;
	});

	/* ---------------- lifecycle ---------------- */
	let lastEventCtx: ExtensionContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		lastEventCtx = ctx;
		updateStatusWidget(ctx);
		// Check shortly after start (context may already be high from prior work).
		setTimeout(() => maybePushNudge(pi, ctx), 200);
	});
	pi.on("session_tree", async (_event, ctx) => updateStatusWidget(ctx));
	pi.on("turn_end", async (_event, ctx) => updateStatusWidget(ctx));

	/* ---------------- context-usage nudge ---------------- */
	// Push a REAL user steering message (sendUserMessage) when context usage
	// crosses 30/50/70% — after each turn settles, and from an idle timer so a
	// long-running idle session still gets nudged.
	pi.on("agent_end", async (_event, ctx) => {
		lastEventCtx = ctx;
		// Defer until the turn fully settles so the push triggers a fresh turn.
		setTimeout(() => maybePushNudge(pi, ctx), 100);
	});
	const nudgeTimer = setInterval(() => {
		if (!lastEventCtx) return;
		try {
			maybePushNudge(pi, lastEventCtx);
		} catch {
			/* ignore */
		}
	}, 30_000);
	pi.on("session_shutdown", () => clearInterval(nudgeTimer));

	/* ---------------- memory_index ---------------- */
	pi.registerTool({
		name: "memory_index",
		label: "Memory Index",
		description:
			"Survey the conversation. For every turn (a user request plus all assistant work until the next request) shows the FIRST FEW LINES of the turn start (user message) and the FIRST FEW LINES of the turn end (last assistant message), plus message count and estimated tokens. Use this to get an overview of the whole conversation when context feels long, or to find old turns worth dropping.",
		promptSnippet: "List the conversation as an index of turn start/end previews",
		promptGuidelines: [
			"Use memory_index to survey earlier conversation turns and find old turns to compress with memory_drop.",
		],
		parameters: IndexParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = loadState(ctx);
			const turns = buildTurns(ctx.sessionManager.getBranch());
			const offset = params.offset;
			let listed = offset !== undefined ? turns.filter((t) => t.index >= offset) : turns;
			if (params.maxTurns !== undefined) listed = listed.slice(0, params.maxTurns);
			const lines = params.lines ?? DEFAULT_LINES;

			const text = buildIndexText(listed, state, lines);
			return {
				content: [{ type: "text", text }],
				details: {
					totalTurns: turns.length,
					listedTurns: listed.length,
					droppedTurns: state.drops.length,
					tokensTotal: turns.reduce((a, t) => a + t.approxTokens, 0),
					tokensSaved: state.drops.reduce((a, d) => a + d.approxTokensSaved, 0),
					turns: turns.map((t) => ({
						turnId: t.turnId,
						index: t.index,
						status: state.drops.some((d) => d.turnId === t.turnId) ? "dropped" : "active",
						messageCount: t.messageCount,
						approxTokens: t.approxTokens,
					})),
				},
			};
		},
	});

	/* ---------------- memory_drop ---------------- */
	pi.registerTool({
		name: "memory_drop",
		label: "Memory Drop",
		description:
			"Drop (compress) one or more turns from your context. The full text is NOT deleted from the session file — instead, on every future LLM context build, each message of the dropped turn is replaced by its first few lines (roles and tool-call/tool-result pairing are preserved), so you still know roughly what happened without the detail. Use on old turns that are no longer actively needed to free context space.",
		promptSnippet: "Compress old conversation turns down to their first few lines",
		promptGuidelines: [
			"Use memory_drop to free context space on old turns that are no longer actively needed; prefer dropping older turns and keep recent ones intact.",
			"Dropped turns can be restored with memory_restore — nothing is actually deleted.",
		],
		parameters: DropParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = loadState(ctx);
			const entries = ctx.sessionManager.getBranch();
			const turns = buildTurns(entries);
			const requested = resolveTurnIds(turns, params.turnIds);
			const lines = params.lines ?? DEFAULT_LINES;
			const lastTurn = turns[turns.length - 1];

			const entryById = new Map(entries.map((e) => [e.id, e]));
			const dropped: string[] = [];
			const skipped: string[] = [];
			const already: string[] = [];

			for (const turn of requested) {
				if (state.drops.some((d) => d.turnId === turn.turnId)) {
					already.push(turn.turnId);
					continue;
				}
				if (!params.includeCurrent && lastTurn && turn.turnId === lastTurn.turnId) {
					skipped.push(turn.turnId);
					continue;
				}

				const hashes: string[] = [];
				let tokensBefore = 0;
				for (const id of turn.entryIds) {
					const entry = entryById.get(id);
					if (entry && entry.type === "message") {
						hashes.push(hashMessage(entry.message));
						tokensBefore += estimateTokens(entry.message);
					}
				}
				// rough stub size: each message keeps ~lines lines of text
				const stubChars = turn.messageCount * lines * 40;
				const saved = Math.max(0, tokensBefore - Math.ceil(stubChars / 4));

				state.drops.push({
					turnId: turn.turnId,
					index: turn.index,
					entryIds: [...turn.entryIds],
					hashes,
					startPreview: turn.startPreview,
					endPreview: turn.endPreview,
					lines,
					droppedAt: Date.now(),
					approxTokensSaved: saved,
					messageCount: turn.messageCount,
				});
				dropped.push(turn.turnId);
			}

			saveState(state, pi);
			updateStatusWidget(ctx);

			const linesText: string[] = [];
			if (dropped.length > 0) {
				linesText.push(`Dropped turn(s) — now compressed to the first ${lines} line(s) of each message:`);
				for (const id of dropped) {
					const d = state.drops.find((x) => x.turnId === id)!;
					linesText.push(
						`  - turn ${d.index} (${d.turnId}): ${d.messageCount} msgs, ~${fmtTokens(d.approxTokensSaved)} tokens saved`,
					);
				}
			}
			if (skipped.length > 0) {
				linesText.push(`Skipped (current turn — pass includeCurrent=true to force): ${skipped.join(", ")}`);
			}
			if (already.length > 0) {
				linesText.push(`Already dropped (no change): ${already.join(", ")}`);
			}
			if (requested.length === 0) {
				linesText.push("No matching turns found. Check memory_index for valid turn IDs/numbers.");
			}

			return {
				content: [{ type: "text", text: linesText.join("\n") || "Nothing dropped." }],
				details: {
					dropped,
					skipped,
					alreadyDropped: already,
					drops: state.drops.map((d) => ({
						turnId: d.turnId,
						index: d.index,
						lines: d.lines,
						messageCount: d.messageCount,
						approxTokensSaved: d.approxTokensSaved,
					})),
				},
			};
		},
	});

	/* ---------------- memory_restore ---------------- */
	pi.registerTool({
		name: "memory_restore",
		label: "Memory Restore",
		description:
			"Restore previously dropped turns back to full detail. Omit turnIds to restore everything. Use when you need the complete original content of a dropped turn again.",
		promptSnippet: "Restore dropped conversation turns to full detail",
		parameters: RestoreParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = loadState(ctx);
			const restored: string[] = [];

			if (params.turnIds && params.turnIds.length > 0) {
				const set = new Set(params.turnIds);
				state.drops = state.drops.filter((d) => {
					const matches = set.has(d.turnId) || set.has(String(d.index));
					if (matches) restored.push(d.turnId);
					return !matches;
				});
			} else {
				restored.push(...state.drops.map((d) => d.turnId));
				state.drops = [];
			}

			saveState(state, pi);
			updateStatusWidget(ctx);

			return {
				content: [
					{
						type: "text",
						text:
							restored.length > 0
								? `Restored ${restored.length} turn(s) to full detail: ${restored.join(", ")}`
								: "Nothing to restore (no dropped turns).",
					},
				],
				details: {
					restored,
					remaining: state.drops.length,
				},
			};
		},
	});

	/* ---------------- memory_status ---------------- */
	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description:
			"Show what is currently dropped (compressed) in this conversation, estimated token savings, and current context usage.",
		promptSnippet: "Show dropped memory turns and context usage",
		parameters: StatusParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const state = loadState(ctx);
			const turns = buildTurns(ctx.sessionManager.getBranch());
			const usage = ctx.getContextUsage();

			const totalTokens = turns.reduce((a, t) => a + t.approxTokens, 0);
			const savedTokens = state.drops.reduce((a, d) => a + d.approxTokensSaved, 0);

			const out: string[] = [];
			out.push(`Memory status — ${turns.length} turns, ~${fmtTokens(totalTokens)} tokens in session`);
			if (usage) {
				out.push(
					`Context: ${usage.tokens != null ? fmtTokens(usage.tokens) : "?"} / ${fmtTokens(usage.contextWindow)}` +
						(usage.percent != null ? ` (${Math.round(usage.percent)}%)` : ""),
				);
			}
			if (state.drops.length === 0) {
				out.push("Nothing dropped. Use memory_drop to compress old turns.");
			} else {
				out.push(`Dropped: ${state.drops.length} turn(s), ~${fmtTokens(savedTokens)} tokens saved per request`);
				for (const d of state.drops) {
					out.push(
						`  - turn ${d.index} (${d.turnId}): ${d.messageCount} msgs, first ${d.lines} line(s) kept, ` +
							`start: ${firstLines(d.startPreview, 1)}`,
					);
				}
			}
			return {
				content: [{ type: "text", text: out.join("\n") }],
				details: {
					droppedTurns: state.drops.length,
					tokensSaved: savedTokens,
					contextUsage: usage ?? null,
					drops: state.drops.map((d) => ({
						turnId: d.turnId,
						index: d.index,
						lines: d.lines,
						messageCount: d.messageCount,
						approxTokensSaved: d.approxTokensSaved,
					})),
				},
			};
		},
	});

	/* ---------------- /memory command (for humans) ---------------- */
	pi.registerCommand("memory", {
		description: "Inspect conversation memory: index | drop <ids> | restore [ids] | status",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const action = parts[0] ?? "index";

			if (action === "index" || action === "list") {
				await showIndexUi(ctx);
				return;
			}
			if (action === "status") {
				const state = loadState(ctx);
				const turns = buildTurns(ctx.sessionManager.getBranch());
				const total = turns.reduce((a, t) => a + t.approxTokens, 0);
				const saved = state.drops.reduce((a, d) => a + d.approxTokensSaved, 0);
				ctx.ui.notify(
					`Memory: ${turns.length} turns (~${fmtTokens(total)} tokens) · ${state.drops.length} dropped (~${fmtTokens(saved)} saved)`,
					"info",
				);
				return;
			}
			if (action === "drop" || action === "restore") {
				const ids = parts.slice(1);
				const state = loadState(ctx);
				const turns = buildTurns(ctx.sessionManager.getBranch());
				if (action === "drop") {
					const requested = resolveTurnIds(turns, ids);
					const lastTurn = turns[turns.length - 1];
					const dropped: string[] = [];
					for (const turn of requested) {
						if (state.drops.some((d) => d.turnId === turn.turnId)) continue;
						if (lastTurn && turn.turnId === lastTurn.turnId) continue;
						const entryById = new Map(ctx.sessionManager.getBranch().map((e) => [e.id, e]));
						const hashes: string[] = [];
						let tokensBefore = 0;
						for (const id of turn.entryIds) {
							const entry = entryById.get(id);
							if (entry && entry.type === "message") {
								hashes.push(hashMessage(entry.message));
								tokensBefore += estimateTokens(entry.message);
							}
						}
						state.drops.push({
							turnId: turn.turnId,
							index: turn.index,
							entryIds: [...turn.entryIds],
							hashes,
							startPreview: turn.startPreview,
							endPreview: turn.endPreview,
							lines: DEFAULT_LINES,
							droppedAt: Date.now(),
							approxTokensSaved: Math.max(0, tokensBefore - Math.ceil((turn.messageCount * DEFAULT_LINES * 40) / 4)),
							messageCount: turn.messageCount,
						});
						dropped.push(turn.turnId);
					}
					saveState(state, pi);
					updateStatusWidget(ctx);
					ctx.ui.notify(dropped.length > 0 ? `Dropped ${dropped.length} turn(s)` : "No turns dropped", "info");
				} else {
					const set = new Set(ids);
					const restored: string[] = [];
					state.drops = state.drops.filter((d) => {
						const matches = set.size === 0 || set.has(d.turnId) || set.has(String(d.index));
						if (matches) restored.push(d.turnId);
						return !matches;
					});
					saveState(state, pi);
					updateStatusWidget(ctx);
					ctx.ui.notify(restored.length > 0 ? `Restored ${restored.length} turn(s)` : "Nothing to restore", "info");
				}
				return;
			}
			ctx.ui.notify("Usage: /memory [index | status | drop <ids> | restore [ids]]", "info");
		},
	});
}

/* ------------------------------------------------------------------ */
/* Index UI (interactive)                                              */
/* ------------------------------------------------------------------ */

async function showIndexUi(ctx: ExtensionCommandContext) {
	const state = loadState(ctx);
	const turns = buildTurns(ctx.sessionManager.getBranch());
	const text = buildIndexText(turns, state, DEFAULT_LINES);

	if (ctx.mode !== "tui") {
		ctx.ui.notify(text.split("\n").slice(0, 15).join("\n"), "info");
		return;
	}

	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const mdTheme = getMarkdownTheme();
		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold("Conversation Memory")), 1, 0));
		container.addChild(new Markdown(text, 1, 1, mdTheme));
		container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
		container.addChild(border);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
					done(undefined);
				}
			},
		};
	});
}
