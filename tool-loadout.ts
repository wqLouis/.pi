/**
 * Tool Loadout — per-session tool selection without rewriting the cached prompt.
 *
 * At the start of a new session the user picks the tools for that session.
 * Core tools (read, bash, edit, write, …) toggle individually; everything an
 * extension registers is one unit, so an extension's tools are enabled or
 * disabled as a whole. `/tools` changes the selection later. Resuming or
 * reloading a session restores the persisted choice. The chosen set is
 * enforced before every run.
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
import {
	ToolUnitChecklist,
	toolUnits,
	toolsOfUnits,
	unitsForTools,
	unitsOfActiveTools,
	type ToolUnit,
} from "./subagent/tool-groups.ts";
import { loadSelection, saveSelection, selectionFile } from "./subagent/tool-selection.ts";

const CUSTOM_TYPE = "tool-loadout";
const MAX_PROMPT_CHARS = 8_000;

/**
 * Tools that are always active. `codemode` is the harness's scripting layer:
 * it is how multi-step work is done, so it is never switched off.
 */
const ALWAYS_ON_TOOLS = process.env.PI_SUBAGENT_TOOLS_SET === "1" ? [] : ["codemode"];

interface LoadoutState {
	/** Enabled unit ids. */
	units?: string[];
	/** Legacy per-tool selection (older sessions). */
	tools?: string[];
}

const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

/** Set comparison: the order of the declared tools does not matter. */
const sameTools = (a: string[], b: string[]): boolean => {
	if (a.length !== b.length) return false;
	const other = new Set(b);
	return a.every((value) => other.has(value));
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
	/** Enabled unit ids; undefined until the user picks (or a session restores one). */
	let selectedUnits: string[] | undefined;
	let pendingInjection: string | undefined;

	/** The tools the user picks between. The always-on tools are not part of it. */
	const declarableTools = (): ToolInfo[] =>
		pi
			.getAllTools()
			.filter(
				(tool) =>
					(tool.exposure === "direct" || tool.exposure === "model-only") &&
					!ALWAYS_ON_TOOLS.includes(tool.name),
			);

	const units = (): ToolUnit[] => toolUnits(declarableTools());

	/**
	 * The always-on tools. `codemode` is not part of the selection: it never
	 * appears in the checklist and is always active.
	 */
	const alwaysOnToolNames = (): string[] =>
		ALWAYS_ON_TOOLS.filter((name) => pi.getAllTools().some((tool) => tool.name === name));

	/** Tool names of the enabled units, restricted to the registered ones. */
	const selectedToolNames = (): string[] => {
		const known = new Set(declarableTools().map((tool) => tool.name));
		return toolsOfUnits(units(), selectedUnits ?? []).filter((name) => known.has(name));
	};

	/** The enabled tools plus the always-on ones. */
	const effectiveToolNames = (): string[] =>
		unique([...selectedToolNames(), ...alwaysOnToolNames()]);

	const persist = (): void => {
		pi.appendEntry(CUSTOM_TYPE, {
			...(selectedUnits !== undefined ? { units: selectedUnits } : {}),
		} satisfies LoadoutState);
		// Remembered across sessions, so a new one starts from the last choice.
		if (selectedUnits !== undefined) saveSelection(selectedUnits);
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		const theme = ctx.ui.theme;
		const all = units();
		const label =
			selectedUnits === undefined ? "tools:auto" : `tools:${selectedUnits.length}/${all.length}`;
		ctx.ui.setStatus("tool-loadout", theme.fg("accent", label));
	};

	const buildLoadoutPrompt = (next: string[], previous: string[]): string => {
		const all = units();
		const enabled = all.filter((unit) => unit.tools.some((name) => next.includes(name)));
		const disabled = all.filter((unit) => !unit.tools.some((name) => next.includes(name)));
		const added = next.filter((name) => !previous.includes(name));
		const removed = previous.filter((name) => !next.includes(name));

		const lines = [
			"[TOOL LOADOUT — ACTIVE TOOLS]",
			`Enabled: ${enabled.length > 0 ? enabled.map((unit) => unit.label).join(", ") : "(none)"}.`,
			"Core tools are enabled one by one; an extension's tools are enabled or disabled as a whole. Use only the enabled tools. If you need a tool that is not enabled, ask the user to enable it with /tools.",
			"codemode is always enabled and is not part of this selection: do the tool work through codemode scripts instead of calling the tools one by one.",
		];
		if (added.length > 0) lines.push(`Newly available: ${added.join(", ")}.`);
		if (removed.length > 0) lines.push(`No longer available: ${removed.join(", ")}.`);
		if (disabled.length > 0) {
			lines.push(`Disabled: ${disabled.map((unit) => unit.label).join(", ")}.`);
		}
		lines.push(
			"If this update interrupted your previous turn, continue the interrupted task using the new tool set.",
		);

		const text = lines.join("\n");
		return text.length > MAX_PROMPT_CHARS
			? `${text.slice(0, MAX_PROMPT_CHARS)}\n\n(Loadout details truncated.)`
			: text;
	};

	/** Accept unit ids as well as plain tool names, and map both to unit ids. */
	const resolveUnitIds = (all: ToolUnit[], ids: string[]): string[] => {
		const resolved: string[] = [];
		for (const id of ids) {
			const unit = all.find((candidate) => candidate.id === id);
			if (unit) {
				resolved.push(unit.id);
				continue;
			}
			for (const candidate of all) {
				if (candidate.tools.includes(id)) {
					resolved.push(candidate.id);
					break;
				}
			}
		}
		return unique(resolved);
	};

	const applySelection = (ctx: ExtensionContext, unitIds: string[]): boolean => {
		const all = units();
		const valid = resolveUnitIds(all, unitIds);
		const previous = selectedUnits !== undefined ? effectiveToolNames() : pi.getActiveTools();
		const known = new Set(declarableTools().map((tool) => tool.name));
		const next = unique([
			...toolsOfUnits(all, valid).filter((name) => known.has(name)),
			...alwaysOnToolNames(),
		]);

		const changed = !sameTools(previous, next);
		selectedUnits = valid;
		if (changed) {
			pi.setActiveTools(next);
			pendingInjection = buildLoadoutPrompt(next, previous);
		}
		persist();
		updateStatus(ctx);
		return changed;
	};

	const pickUnits = async (
		ctx: ExtensionContext,
		title: string,
		current: string[],
	): Promise<string[] | undefined> => {
		if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
		return await ctx.ui.custom<string[] | undefined>((tui, theme, _keybindings, done) => {
			const checklist = new ToolUnitChecklist({
				title,
				theme,
				units: units(),
				selected: current,
				onDone: (value) => done(value),
			});
			return {
				render(width: number) {
					return checklist.render(width);
				},
				invalidate() {
					checklist.invalidate();
				},
				handleInput(data: string) {
					checklist.handleInput(data);
					tui.requestRender();
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
		const all = units();
		const enabled = all.filter((unit) => selectedUnits?.includes(unit.id));
		const available = all.filter((unit) => !selectedUnits?.includes(unit.id));
		ctx.ui.notify(
			`Enabled (${enabled.length}): ${enabled.map((unit) => unit.label).join(", ") || "(none)"}\n` +
				`Available (${available.length}): ${available.map((unit) => unit.label).join(", ") || "(none)"}\n` +
				`Active tools: ${effectiveToolNames().join(", ") || "(none)"}\n` +
				`Always on (not selectable): ${alwaysOnToolNames().join(", ")} · remembered in ${selectionFile()}`,
			"info",
		);
	};

	/**
	 * Unit ids for this session: the session entry first (it follows the
	 * branch), then the selection remembered from an earlier session, then
	 * nothing (the user picks at session start).
	 */
	const restoredUnitIds = (ctx: ExtensionContext): string[] | undefined => {
		const all = units();
		const state = readState(ctx);
		if (state) {
			if (Array.isArray(state.units)) {
				return state.units.filter((id) => all.some((unit) => unit.id === id));
			}
			if (Array.isArray(state.tools)) {
				return unitsForTools(all, state.tools);
			}
		}
		const remembered = loadSelection();
		if (remembered) return remembered.filter((id) => all.some((unit) => unit.id === id));
		return undefined;
	};

	const restore = (ctx: ExtensionContext): void => {
		selectedUnits = restoredUnitIds(ctx) ?? unitsOfActiveTools(units(), pi.getActiveTools());
		pendingInjection = undefined;
		persist();
		updateStatus(ctx);
	};

	const chooseAtSessionStart = async (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
		const restored = restoredUnitIds(ctx);
		selectedUnits = restored;
		pendingInjection = undefined;

		// Like the system-prompt mode picker: ask on a new session, but restore
		// silently on resume/reload.
		const isNewish = event.reason === "startup" || event.reason === "new" || event.reason === "fork";
		const shouldPrompt =
			ctx.hasUI &&
			ctx.mode === "tui" &&
			isNewish &&
			(event.reason !== "startup" || selectedUnits === undefined);

		if (shouldPrompt) {
			const current = selectedUnits ?? unitsOfActiveTools(units(), pi.getActiveTools());
			const picked = await pickUnits(ctx, "Select tools for this session", current);
			if (picked) {
				applySelection(ctx, picked);
			} else if (selectedUnits === undefined) {
				// Cancelled on a brand-new session: keep the normal default set.
				selectedUnits = current;
				persist();
			}
		} else if (selectedUnits === undefined) {
			selectedUnits = unitsOfActiveTools(units(), pi.getActiveTools());
			persist();
		}
		updateStatus(ctx);
	};

	pi.on("session_start", chooseAtSessionStart);
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_compact", () => {
		// Keep the choice after the compaction boundary so a later resume restores it.
		if (selectedUnits !== undefined) persist();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (selectedUnits === undefined) {
			selectedUnits = unitsOfActiveTools(units(), pi.getActiveTools());
			persist();
		}
		updateStatus(ctx);

		let injection = pendingInjection;
		pendingInjection = undefined;

		// Re-apply the chosen loadout before the request. Pi records tool changes
		// as a system-prompt patch, so the existing cached prefix is preserved.
		// Keep tools that codemode/tool_search loaded dynamically, so this
		// extension does not undo them on the next run.
		const toolInfo = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
		const known = new Set(declarableTools().map((tool) => tool.name));
		const keepDynamic = selectedToolNames().includes("tool_search") || selectedToolNames().includes("codemode");
		const dynamic = keepDynamic
			? pi.getActiveTools().filter((name) => {
					const exposure = toolInfo.get(name)?.exposure;
					return exposure === "deferred" || exposure === "codemode";
				})
			: [];
		const alwaysOn = alwaysOnToolNames();
		const desired = unique([
			...effectiveToolNames().filter((name) => known.has(name) || alwaysOn.includes(name)),
			...dynamic,
		]);
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
			"Pick the enabled tools. /tools (checklist), /tools all|none, /tools <names> (replace), /tools +name / -name (add/remove), /tools show.",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/[\s,]+/).filter(Boolean);
			const first = parts[0]?.toLowerCase();
			const all = units();

			if (!first || first === "pick" || first === "select") {
				if (!ctx.hasUI || ctx.mode !== "tui") {
					ctx.ui.notify(
						"Interactive picker unavailable here. Use /tools <names> or /tools show.",
						"warning",
					);
					return;
				}
				const current = selectedUnits ?? unitsOfActiveTools(all, pi.getActiveTools());
				const picked = await pickUnits(ctx, "Select tools", current);
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

			// Plain names replace the selection; "+name" adds, "-name" removes.
			const wants = parts.map((part) => {
				if (part.startsWith("+")) return { part: part.slice(1).toLowerCase(), mode: "add" as const };
				if (part.startsWith("-")) return { part: part.slice(1).toLowerCase(), mode: "remove" as const };
				return { part: part.toLowerCase(), mode: "replace" as const };
			});
			const matches = (part: string, unit: ToolUnit) =>
				unit.label.toLowerCase() === part ||
				unit.id.toLowerCase() === part ||
				unit.tools.some((tool) => tool.toLowerCase() === part);
			let unitIds: string[];
			if (first === "all") {
				unitIds = all.map((unit) => unit.id);
			} else if (first === "none") {
				unitIds = [];
			} else {
				const matched = all.filter((unit) => wants.some((want) => matches(want.part, unit)));
				const alwaysOn = alwaysOnToolNames();
				const unknown = wants
					.filter(
						(want) =>
							!all.some((unit) => matches(want.part, unit)) && !alwaysOn.includes(want.part),
					)
					.map((want) => want.part);
				if (unknown.length > 0) {
					ctx.ui.notify(`Unknown tools or extensions: ${unknown.join(", ")}`, "warning");
					return;
				}
				const ignored = wants
					.filter((want) => alwaysOn.includes(want.part))
					.map((want) => want.part);
				if (ignored.length > 0) {
					ctx.ui.notify(`${ignored.join(", ")} is always on and is not part of the selection.`, "info");
				}

				const matchedIds = matched.map((unit) => unit.id);
				if (wants.every((want) => want.mode === "replace")) {
					unitIds = matchedIds;
				} else {
					const current = selectedUnits ?? unitsOfActiveTools(all, pi.getActiveTools());
					unitIds = [...current];
					for (const want of wants) {
						const ids = all.filter((unit) => matches(want.part, unit)).map((unit) => unit.id);
						if (want.mode === "add") {
							unitIds = unique([...unitIds, ...ids]);
						} else {
							unitIds = unitIds.filter((id) => !ids.includes(id));
						}
					}
				}
			}

			const changed = applySelection(ctx, unitIds);
			if (!changed) {
				ctx.ui.notify("Tool loadout unchanged.", "info");
				return;
			}
			await deliver(ctx);
		},
	});
}
