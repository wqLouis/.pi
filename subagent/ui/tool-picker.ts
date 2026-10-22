/**
 * Checklist submenu for the `/subagent config` panel: choose which tools are
 * declared to spawned pi subagents. The result is stored as a comma-separated
 * tool allowlist and passed to the child as `--tools`.
 */

import { getKeybindings, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { UiTheme } from "./list-picker.ts";

export interface ToolChoice {
	name: string;
	description?: string;
	/** Built-in tools are grouped first in the list. */
	builtin?: boolean;
}

export interface ToolChecklistOptions {
	title: string;
	theme: UiTheme;
	tools: ToolChoice[];
	/** Tool names to start checked. */
	selected: string[];
	hint?: string;
	onDone: (value: string[] | undefined) => void;
}

const MAX_VISIBLE = 14;

const compact = (value: string | undefined, max = 110): string => {
	const text = (value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

export class ToolChecklistComponent implements Component {
	private readonly selected: Set<string>;
	private index = 0;
	private offset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private readonly opts: ToolChecklistOptions) {
		this.selected = new Set(opts.selected.filter((name) => opts.tools.some((tool) => tool.name === name)));
		const firstSelected = opts.tools.findIndex((tool) => this.selected.has(tool.name));
		this.index = firstSelected >= 0 ? firstSelected : 0;
	}

	private move(delta: number): void {
		if (this.opts.tools.length === 0) return;
		this.index = (this.index + delta + this.opts.tools.length) % this.opts.tools.length;
		this.invalidate();
	}

	private toggle(): void {
		const tool = this.opts.tools[this.index];
		if (!tool) return;
		if (this.selected.has(tool.name)) this.selected.delete(tool.name);
		else this.selected.add(tool.name);
		this.invalidate();
	}

	private setAll(selected: boolean): void {
		this.selected.clear();
		if (selected) for (const tool of this.opts.tools) this.selected.add(tool.name);
		this.invalidate();
	}

	private chosen(): string[] {
		return this.opts.tools.filter((tool) => this.selected.has(tool.name)).map((tool) => tool.name);
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
			this.index = Math.max(0, this.opts.tools.length - 1);
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
		const selectedCount = this.selected.size;

		lines.push(border);
		lines.push(
			truncateToWidth(
				`${th.fg("accent", th.bold(` ${this.opts.title} `))}${th.fg("dim", `(${selectedCount}/${this.opts.tools.length} selected)`)}`,
				width,
			),
		);
		lines.push("");

		if (this.opts.tools.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No selectable tools are registered.")}`, width));
		} else {
			if (this.index < this.offset) this.offset = this.index;
			if (this.index >= this.offset + MAX_VISIBLE) this.offset = this.index - MAX_VISIBLE + 1;

			const end = Math.min(this.opts.tools.length, this.offset + MAX_VISIBLE);
			let lastGroup: string | undefined;
			for (let i = this.offset; i < end; i++) {
				const tool = this.opts.tools[i];
				if (!tool) continue;
				const group = tool.builtin ? "Built-in" : "Extension";
				if (group !== lastGroup) {
					if (lastGroup !== undefined) lines.push("");
					lines.push(truncateToWidth(`  ${th.fg("accent", th.bold(group))}`, width));
					lastGroup = group;
				}
				const active = i === this.index;
				const cursor = active ? th.fg("accent", "› ") : "  ";
				const checkbox = this.selected.has(tool.name) ? th.fg("success", "[x]") : th.fg("dim", "[ ]");
				const label = this.selected.has(tool.name) ? th.fg("text", tool.name) : th.fg("muted", tool.name);
				const description = tool.description ? `  ${th.fg("dim", compact(tool.description))}` : "";
				lines.push(truncateToWidth(`  ${cursor}${checkbox} ${label}${description}`, width));
			}

			if (this.offset > 0 || end < this.opts.tools.length) {
				lines.push(
					truncateToWidth(
						`  ${th.fg("dim", `${this.offset + 1}–${end} of ${this.opts.tools.length}`)}`,
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
