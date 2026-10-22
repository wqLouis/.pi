/**
 * Tool units: what a user picks when choosing the tools of a session.
 *
 * Core tools (read, bash, edit, write, …) stay individually selectable, since
 * turning off `write` while keeping `read` is a normal thing to want.
 * Everything an *extension* registers is one unit: an extension's tools are
 * enabled or disabled as a whole, because half an extension (some of the
 * browser tools, some of the subagent tools) is rarely useful.
 *
 * Units are derived from the tool's `sourceInfo.path`:
 *  - `builtin:read` and friends are pi's core tools (one unit each),
 *  - `builtin:codemode` / `builtin:tool-search` are pi's built-in extensions
 *    (one unit each, holding all their tools),
 *  - any other path is the extension file that registered the tool (one unit
 *    holding all of its tools).
 */

import { getKeybindings, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/** pi's built-in extensions; their tools are grouped, not listed one by one. */
const BUILTIN_EXTENSIONS = new Set(["codemode", "tool-search"]);

export interface ToolUnit {
	/** Stable id: `tool:<name>` for a core tool, the extension path otherwise. */
	id: string;
	/** Display name. */
	label: string;
	/** "tool" for a single core tool, "group" for an extension's tools. */
	kind: "tool" | "group";
	/** Tool names in the unit. */
	tools: string[];
	/** Description of a single core tool. */
	description?: string;
}

/** The minimal theme API the checklist needs. */
export interface GroupTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const basenameLabel = (path: string): string => {
	const parts = path.split(/[\\/]/).filter(Boolean);
	const file = parts.pop() ?? path;
	// A folder extension's entry point is `index.ts`: use the folder name.
	if (/^index\.(ts|js|mjs|cjs)$/i.test(file) && parts.length > 0) {
		return parts[parts.length - 1] ?? file;
	}
	const name = file.replace(/\.(ts|js|mjs|cjs)$/i, "");
	return name || path;
};

/** Group the declarable tools into selectable units. */
export function toolUnits(tools: ToolInfo[]): ToolUnit[] {
	const units = new Map<string, ToolUnit>();

	for (const tool of tools) {
		const path = tool.sourceInfo.path;
		let id: string;
		let label: string;
		let kind: "tool" | "group";
		let description: string | undefined;

		if (path.startsWith("builtin:")) {
			const name = path.slice("builtin:".length);
			if (BUILTIN_EXTENSIONS.has(name)) {
				id = path;
				label = name.replace(/-/g, "_");
				kind = "group";
			} else {
				id = `tool:${name}`;
				label = name;
				kind = "tool";
				description = tool.description;
			}
		} else {
			id = path;
			label = basenameLabel(path);
			kind = "group";
		}

		const unit = units.get(id) ?? { id, label, kind, tools: [], description };
		unit.tools.push(tool.name);
		units.set(id, unit);
	}

	return [...units.values()].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "tool" ? -1 : 1;
		return a.label.localeCompare(b.label);
	});
}

/** The tool names of the given units, in unit order. */
export function toolsOfUnits(units: ToolUnit[], ids: string[]): string[] {
	const wanted = new Set(ids);
	const names: string[] = [];
	for (const unit of units) {
		if (wanted.has(unit.id)) names.push(...unit.tools);
	}
	return names;
}

/**
 * Unit ids for a legacy per-tool selection: a core tool counts as selected
 * when it was selected, and an extension's unit counts as selected when any of
 * its tools was (the whole extension is then used).
 */
export function unitsForTools(units: ToolUnit[], toolNames: string[]): string[] {
	const selected = new Set(toolNames);
	return units
		.filter((unit) => unit.tools.some((name) => selected.has(name)))
		.map((unit) => unit.id);
}

/** Unit ids whose tools are all currently active. */
export function unitsOfActiveTools(units: ToolUnit[], activeTools: string[]): string[] {
	const active = new Set(activeTools);
	return units
		.filter((unit) => unit.tools.length > 0 && unit.tools.every((name) => active.has(name)))
		.map((unit) => unit.id);
}

/** A compact summary of a unit: "read" or "subagent (7 tools)". */
export function unitSummary(unit: ToolUnit): string {
	if (unit.kind === "tool") return unit.label;
	return `${unit.label} (${unit.tools.length} tool${unit.tools.length === 1 ? "" : "s"})`;
}

const MAX_VISIBLE = 14;

export interface ToolUnitChecklistOptions {
	title: string;
	theme: GroupTheme;
	units: ToolUnit[];
	/** Unit ids to start checked. */
	selected: string[];
	/** Unit ids that are always on and cannot be switched off. */
	locked?: string[];
	hint?: string;
	onDone: (value: string[] | undefined) => void;
}

/**
 * A checklist over tool units. Space toggles a unit, so an extension's tools
 * are enabled or disabled together, while core tools toggle individually.
 */
export class ToolUnitChecklist implements Component {
	private readonly selected: Set<string>;
	private readonly locked: Set<string>;
	private index = 0;
	private offset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private readonly opts: ToolUnitChecklistOptions) {
		this.selected = new Set(opts.selected.filter((id) => opts.units.some((unit) => unit.id === id)));
		this.locked = new Set(opts.locked ?? []);
		// A locked unit is always part of the selection.
		for (const id of this.locked) {
			if (opts.units.some((unit) => unit.id === id)) this.selected.add(id);
		}
	}

	private move(delta: number): void {
		if (this.opts.units.length === 0) return;
		this.index = (this.index + delta + this.opts.units.length) % this.opts.units.length;
		this.invalidate();
	}

	private toggle(): void {
		const unit = this.opts.units[this.index];
		if (!unit) return;
		if (this.locked.has(unit.id)) return;
		if (this.selected.has(unit.id)) this.selected.delete(unit.id);
		else this.selected.add(unit.id);
		this.invalidate();
	}

	private setAll(selected: boolean): void {
		this.selected.clear();
		if (selected) for (const unit of this.opts.units) this.selected.add(unit.id);
		for (const id of this.locked) this.selected.add(id);
		this.invalidate();
	}

	private chosen(): string[] {
		return this.opts.units.filter((unit) => this.selected.has(unit.id)).map((unit) => unit.id);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.opts.onDone(undefined);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.opts.onDone(this.chosen());
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.move(-MAX_VISIBLE);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.move(MAX_VISIBLE);
			return;
		}
		if (matchesKey(data, "home")) {
			this.index = 0;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "end")) {
			this.index = Math.max(0, this.opts.units.length - 1);
			this.invalidate();
			return;
		}
		if (data === " ") {
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

		const th = this.opts.theme;
		const border = th.fg("accent", "─".repeat(Math.max(0, width)));
		const lines: string[] = [];

		lines.push(border);
		lines.push(
			truncateToWidth(
				`${th.fg("accent", th.bold(` ${this.opts.title} `))}${th.fg("dim", `(${this.selected.size}/${this.opts.units.length} selected)`)}`,
				width,
			),
		);
		lines.push("");

		if (this.opts.units.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No selectable tools are registered.")}`, width));
		} else {
			if (this.index < this.offset) this.offset = this.index;
			if (this.index >= this.offset + MAX_VISIBLE) this.offset = this.index - MAX_VISIBLE + 1;

			const end = Math.min(this.opts.units.length, this.offset + MAX_VISIBLE);
			let lastKind: string | undefined;
			for (let i = this.offset; i < end; i++) {
				const unit = this.opts.units[i];
				if (!unit) continue;
				if (unit.kind !== lastKind) {
					if (lastKind !== undefined) lines.push("");
					lines.push(
						truncateToWidth(
							`  ${th.fg("accent", th.bold(unit.kind === "tool" ? "Core tools" : "Extensions"))}`,
							width,
						),
					);
					lastKind = unit.kind;
				}
				const active = i === this.index;
				const cursor = active ? th.fg("accent", "› ") : "  ";
				const locked = this.locked.has(unit.id);
				const checkbox = locked
					? th.fg("accent", "[*]")
					: this.selected.has(unit.id)
						? th.fg("success", "[x]")
						: th.fg("dim", "[ ]");
				const label = this.selected.has(unit.id)
					? th.fg("text", unitSummary(unit))
					: th.fg("muted", unitSummary(unit));
				const lockNote = locked ? th.fg("dim", "  (always on)") : "";
				lines.push(truncateToWidth(`  ${cursor}${checkbox} ${label}${lockNote}`, width));
				const detail =
					unit.kind === "tool" ? (unit.description ?? "") : unit.tools.join(", ");
				if (detail) lines.push(truncateToWidth(`      ${th.fg("dim", detail)}`, width));
			}

			if (this.offset > 0 || end < this.opts.units.length) {
				lines.push(
					truncateToWidth(
						`  ${th.fg("dim", `${this.offset + 1}–${end} of ${this.opts.units.length}`)}`,
						width,
					),
				);
			}
		}

		lines.push("");
		lines.push(
			truncateToWidth(
				`  ${th.fg("dim", this.opts.hint ?? "↑/↓ move · space toggle · a all · n none · enter save · esc cancel")}`,
				width,
			),
		);
		lines.push(border);

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
