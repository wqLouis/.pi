/**
 * Tool Loadout — per-session tool selection without rewriting the cached prompt.
 *
 * At the start of a new session the user picks the tools for that session with
 * an interactive checklist; `/tools` changes the selection later. Resuming or
 * reloading a session restores the persisted choice. The chosen set is enforced
 * before every run.
 *
 * Cache safety: the extension never returns a replacement `systemPrompt`.
 * `pi.setActiveTools()` records the tool delta as a system-prompt patch
 * (`toolsAdded` / `toolsRemoved`), leaving the already-cached prefix intact.
 * On an in-flight change the current turn is aborted (the same "interrupt then
 * continue" model as `subagent_interrupt`) and a compact loadout message is
 * injected into the conversation, rather than editing the existing system
 * prompt in place.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
	Theme,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "tool-loadout";
const MAX_PROMPT_CHARS = 8_000;
const PICKER_MAX_VISIBLE = 14;

interface LoadoutState {
	tools?: string[];
}

interface PickerItem {
	value: string;
	label: string;
	description: string;
	group: string;
	selected: boolean;
}

class ToolPicker {
	private selectedIndex: number;
	private offset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly title: string,
		private readonly items: PickerItem[],
		private readonly done: (value: string[] | undefined) => void,
	) {
		const firstSelected = items.findIndex((item) => item.selected);
		this.selectedIndex = firstSelected >= 0 ? firstSelected : 0;
	}

	private selectedTools(): string[] {
		return this.items.filter((item) => item.selected).map((item) => item.value);
	}

	private move(delta: number): void {
		if (this.items.length === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + this.items.length) % this.items.length;
		this.invalidate();
		this.tui.requestRender();
	}

	private toggle(): void {
		const item = this.items[this.selectedIndex];
		if (!item) return;
		item.selected = !item.selected;
		this.invalidate();
		this.tui.requestRender();
	}

	private setAll(selected: boolean): void {
		for (const item of this.items) item.selected = selected;
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.done(this.selectedTools());
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.move(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.move(-PICKER_MAX_VISIBLE);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.move(PICKER_MAX_VISIBLE);
			return;
		}
		if (matchesKey(data, "home")) {
			this.selectedIndex = 0;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.selectedIndex = Math.max(0, this.items.length - 1);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "space") || data === " ") {
			this.toggle();
			return;
		}
		const lower = data.toLowerCase();
		if (lower === "a") {
			this.setAll(true);
			return;
		}
		if (lower === "n") {
			this.setAll(false);
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

		const th = this.theme;
		const lines: string[] = [];
		const selectedCount = this.items.filter((item) => item.selected).length;

		lines.push("");
		lines.push(
			truncateToWidth(
				`${th.fg("accent", th.bold(` ${this.title} `))}${th.fg("dim", `(${selectedCount}/${this.items.length} selected)`)}`,
				width,
			),
		);
		lines.push("");

		if (this.items.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No selectable tools are registered.")}`, width));
		} else {
			if (this.selectedIndex < this.offset) this.offset = this.selectedIndex;
			if (this.selectedIndex >= this.offset + PICKER_MAX_VISIBLE) {
				this.offset = this.selectedIndex - PICKER_MAX_VISIBLE + 1;
			}

			const end = Math.min(this.items.length, this.offset + PICKER_MAX_VISIBLE);
			let lastGroup: string | undefined;
			for (let index = this.offset; index < end; index++) {
				const item = this.items[index];
				if (!item) continue;
				if (item.group !== lastGroup) {
					if (lastGroup !== undefined) lines.push("");
					lines.push(truncateToWidth(`  ${th.fg("accent", th.bold(item.group))}`, width));
					lastGroup = item.group;
				}
				const active = index === this.selectedIndex;
				const cursor = active ? th.fg("accent", "› ") : "  ";
				const checkbox = item.selected ? th.fg("success", "[x]") : th.fg("dim", "[ ]");
				const label = item.selected ? th.fg("text", item.label) : th.fg("muted", item.label);
				const description = item.description ? `  ${th.fg("dim", item.description)}` : "";
				lines.push(truncateToWidth(`  ${cursor}${checkbox} ${label}${description}`, width));
			}

			if (this.offset > 0 || end < this.items.length) {
				lines.push(
					truncateToWidth(
						`  ${th.fg("dim", `${this.offset + 1}–${end} of ${this.items.length}`)}`,
						width,
					),
				);
			}
		}

		lines.push("");
		lines.push(
			truncateToWidth(
				`  ${th.fg("dim", "↑/↓ move · space toggle · a all · n none · enter apply · esc cancel")}`,
				width,
			),
		);
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

const sameTools = (a: string[], b: string[]): boolean =>
	a.length === b.length && a.every((value, index) => value === b[index]);

const compactText = (value: string, max = 120): string => {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

function readState(ctx: ExtensionContext): LoadoutState | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		const data = entry.data as LoadoutState | undefined;
		if (data && typeof data === "object") return data;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let selectedTools: string[] | undefined;
	let pendingInjection: string | undefined;

	const declarableTools = (): ToolInfo[] => {
		const tools = pi
			.getAllTools()
			.filter((tool) => tool.exposure === "direct" || tool.exposure === "model-only");
		const rank = (tool: ToolInfo) => (tool.sourceInfo.source === "builtin" ? 0 : 1);
		return tools.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
	};

	const sanitize = (names: string[]): string[] => {
		const known = new Set(declarableTools().map((tool) => tool.name));
		return unique(names).filter((name) => known.has(name));
	};

	const persist = (): void => {
		pi.appendEntry(CUSTOM_TYPE, {
			...(selectedTools !== undefined ? { tools: selectedTools } : {}),
		} satisfies LoadoutState);
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		const theme = ctx.ui.theme;
		const label = selectedTools === undefined ? "tools:auto" : `tools:${selectedTools.length}`;
		ctx.ui.setStatus("tool-loadout", theme.fg("accent", label));
	};

	const buildLoadoutPrompt = (next: string[], previous: string[]): string => {
		const infoByName = new Map(declarableTools().map((tool) => [tool.name, tool]));
		const added = next.filter((name) => !previous.includes(name));
		const removed = previous.filter((name) => !next.includes(name));

		const lines = [
			"[TOOL LOADOUT — ACTIVE SET]",
			`The active tool set for this session is now: ${next.length > 0 ? next.join(", ") : "(none)"}.`,
			"Use only these tools. Tools that are not listed are disabled or reachable only through codemode. If you need a tool that is not enabled, ask the user to enable it with /tools.",
		];
		if (added.length > 0) lines.push(`Newly enabled: ${added.join(", ")}.`);
		if (removed.length > 0) lines.push(`Disabled: ${removed.join(", ")}.`);
		lines.push(
			"If this update interrupted your previous turn, continue the interrupted task using the new tool set.",
		);

		const rules: string[] = [];
		for (const name of added) {
			const info = infoByName.get(name);
			const guidelines = info?.promptGuidelines?.map((line) => line.trim()).filter(Boolean) ?? [];
			if (guidelines.length > 0) rules.push(`- ${name}: ${guidelines.join(" ")}`);
		}
		if (rules.length > 0) {
			lines.push("", "Rules for newly enabled tools:", ...rules);
		}

		const text = lines.join("\n");
		return text.length > MAX_PROMPT_CHARS
			? `${text.slice(0, MAX_PROMPT_CHARS)}\n\n(Loadout details truncated.)`
			: text;
	};

	const applySelection = (ctx: ExtensionContext, names: string[]): boolean => {
		const hadSelection = selectedTools !== undefined;
		const previous = selectedTools ?? sanitize(pi.getActiveTools());
		const next = sanitize(names);
		const changed = !sameTools(previous, next);

		selectedTools = next;
		if (changed) {
			pi.setActiveTools(next);
			pendingInjection = buildLoadoutPrompt(next, previous);
		}
		if (changed || !hadSelection) persist();
		updateStatus(ctx);
		return changed;
	};

	const pickTools = async (
		ctx: ExtensionContext,
		title: string,
		current: string[],
	): Promise<string[] | undefined> => {
		if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
		const items: PickerItem[] = declarableTools().map((info) => ({
			value: info.name,
			label: info.name,
			description: compactText(
				info.description,
				120,
			),
			group: info.sourceInfo.source === "builtin" ? "Built-in" : "Extension",
			selected: current.includes(info.name),
		}));

		return await ctx.ui.custom<string[] | undefined>((tui, theme, _keybindings, done) => {
			const picker = new ToolPicker(tui, theme, title, items, done);
			return {
				render(width: number) {
					return picker.render(width);
				},
				invalidate() {
					picker.invalidate();
				},
				handleInput(data: string) {
					picker.handleInput(data);
				},
			};
		});
	};

	/**
	 * Apply a pending loadout message. If the agent is streaming, abort the
	 * in-flight turn and start a fresh one with the loadout injected. If it is
	 * idle, leave the message for the next user prompt.
	 */
	const deliver = async (ctx: ExtensionCommandContext): Promise<void> => {
		const message = pendingInjection;
		if (!message) return;

		if (ctx.isIdle()) {
			ctx.ui.notify("Tool loadout updated; it will be injected with your next prompt.", "info");
			return;
		}

		ctx.ui.notify("Interrupting the current turn to apply the new tool loadout...", "warning");
		ctx.abort();
		await ctx.waitForIdle();
		if (!ctx.isIdle()) {
			ctx.ui.notify("Could not interrupt the turn; the loadout will apply on the next prompt.", "warning");
			return;
		}

		pendingInjection = undefined;
		pi.sendMessage(
			{ customType: CUSTOM_TYPE, content: message, display: false },
			{ triggerTurn: true },
		);
	};

	const notifyCurrent = (ctx: ExtensionContext): void => {
		if (selectedTools === undefined) selectedTools = sanitize(pi.getActiveTools());
		const available = declarableTools().map((tool) => tool.name);
		ctx.ui.notify(
			`Active tools (${selectedTools.length}): ${selectedTools.join(", ") || "(none)"}\n` +
				`Available (${available.length}): ${available.join(", ")}`,
			"info",
		);
	};

	const restore = (ctx: ExtensionContext): void => {
		const state = readState(ctx);
		// Keep names that are not registered yet (for example MCP tools that
		// connect after session_start); they activate when they register.
		selectedTools = Array.isArray(state?.tools)
			? unique(state.tools.filter((name): name is string => typeof name === "string"))
			: sanitize(pi.getActiveTools());
		pendingInjection = undefined;
		if (!state || !Array.isArray(state.tools)) persist();
		updateStatus(ctx);
	};

	const chooseAtSessionStart = async (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
		const state = readState(ctx);
		selectedTools = Array.isArray(state?.tools)
			? unique(state.tools.filter((name): name is string => typeof name === "string"))
			: undefined;
		pendingInjection = undefined;

		// Like the system-prompt mode picker: ask on a new session, but restore
		// silently on resume/reload.
		const isNewish = event.reason === "startup" || event.reason === "new" || event.reason === "fork";
		const shouldPrompt =
			ctx.hasUI &&
			ctx.mode === "tui" &&
			isNewish &&
			(event.reason !== "startup" || selectedTools === undefined);

		if (shouldPrompt) {
			const current = selectedTools ?? sanitize(pi.getActiveTools());
			const picked = await pickTools(ctx, "Select tools for this session", current);
			if (picked) {
				applySelection(ctx, picked);
			} else if (selectedTools === undefined) {
				// Cancelled on a brand-new session: keep the normal default set.
				selectedTools = current;
				persist();
			}
		} else if (selectedTools === undefined) {
			selectedTools = sanitize(pi.getActiveTools());
			persist();
		}
		updateStatus(ctx);
	};

	pi.on("session_start", chooseAtSessionStart);
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_compact", () => {
		// Keep the choice after the compaction boundary so a later resume restores it.
		if (selectedTools !== undefined) persist();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (selectedTools === undefined) {
			selectedTools = sanitize(pi.getActiveTools());
			persist();
		}
		updateStatus(ctx);

		let injection = pendingInjection;
		pendingInjection = undefined;

		// Re-apply the chosen loadout before the request. Pi records tool changes
		// as a system-prompt patch, so the existing cached prefix is preserved.
		// Compare only registered tools; persisted names may be waiting to
		// register (for example tools of an MCP server still connecting).
		// Keep tools that codemode/tool_search loaded dynamically, so this
		// extension does not undo them on the next run.
		const toolInfo = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
		const known = new Set(declarableTools().map((tool) => tool.name));
		const keepDynamic = selectedTools.includes("tool_search") || selectedTools.includes("codemode");
		const dynamic = keepDynamic
			? pi.getActiveTools().filter((name) => {
					const exposure = toolInfo.get(name)?.exposure;
					return exposure === "deferred" || exposure === "codemode";
				})
			: [];
		const desired = unique([...selectedTools.filter((name) => known.has(name)), ...dynamic]);
		const active = pi.getActiveTools();
		if (!sameTools(active, desired)) {
			pi.setActiveTools(desired);
			injection ??= buildLoadoutPrompt(desired, active);
		}

		if (injection) {
			return {
				message: {
					customType: CUSTOM_TYPE,
					content: injection,
					display: false,
				},
			};
		}
		return undefined;
	});

	pi.registerCommand("tools", {
		description:
			"Pick the active tools. /tools (checklist), /tools read,bash,edit, /tools core|readonly|all|none, /tools show.",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const first = parts[0]?.toLowerCase();

			if (!first || first === "pick" || first === "select") {
				if (!ctx.hasUI || ctx.mode !== "tui") {
					ctx.ui.notify(
						"Interactive picker unavailable here. Use /tools <tool names> or /tools show.",
						"warning",
					);
					return;
				}
				const current = selectedTools ?? sanitize(pi.getActiveTools());
				const picked = await pickTools(ctx, "Select tools", current);
				if (!picked) return;
				const changed = applySelection(ctx, picked);
				if (!changed) {
					ctx.ui.notify("Tool loadout unchanged.", "info");
					return;
				}
				await deliver(ctx);
				return;
			}

			if (first === "show" || first === "list" || first === "status") {
				notifyCurrent(ctx);
				return;
			}

			let names: string[];
			if (first === "all") {
				names = declarableTools().map((tool) => tool.name);
			} else if (first === "core") {
				names = ["read", "bash", "edit", "write", "codemode"];
			} else if (first === "readonly" || first === "read-only") {
				names = ["read", "grep", "find", "ls"];
			} else if (first === "none") {
				names = [];
			} else {
				names = parts.join(" ").split(/[,\s]+/).filter(Boolean);
			}

			const known = new Set(declarableTools().map((tool) => tool.name));
			const unknown = names.filter((name) => !known.has(name));
			const picked = names.filter((name) => known.has(name));
			if (unknown.length > 0) {
				ctx.ui.notify(`Unknown or non-declarable tools ignored: ${unknown.join(", ")}`, "warning");
			}
			const changed = applySelection(ctx, picked);
			if (!changed) {
				ctx.ui.notify("Tool loadout unchanged.", "info");
				return;
			}
			await deliver(ctx);
		},
	});
}
