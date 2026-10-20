/**
 * A small reusable list picker with fuzzy filtering, built on pi-tui's
 * SelectList + Input. Used as the submenu component for the thinking-level,
 * opencode-model, and opencode-effort settings rows.
 */

import {
	Container,
	Input,
	SelectList,
	Spacer,
	Text,
	fuzzyFilter,
	getKeybindings,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";

/** The subset of pi's theme API the config UI uses. */
export interface UiTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface ListPickerItem {
	value: string;
	/** Display text; falls back to `value`. */
	label?: string;
	description?: string;
}

export interface ListPickerOptions {
	title: string;
	theme: UiTheme;
	items: ListPickerItem[];
	/** Pre-select the item with this value. */
	selectedValue?: string;
	/** Dim hint line under the list. */
	hint?: string;
	emptyText?: string;
	maxVisible?: number;
	onSelect: (value: string) => void;
	onCancel: () => void;
}

const LIST_LAYOUT = { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 44 };

export class ListPickerComponent extends Container implements Focusable {
	private readonly input = new Input();
	private list!: SelectList;
	private listSlotIndex = 0;
	private readonly allItems: ListPickerItem[];
	private readonly opts: ListPickerOptions;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(opts: ListPickerOptions) {
		super();
		this.opts = opts;
		this.allItems = opts.items;
		const border = (s: string) => opts.theme.fg("accent", s);
		this.addChild(new DynamicBorder(border));
		this.addChild(new Text(opts.theme.fg("accent", opts.theme.bold(opts.title)), 1, 0));
		if (this.needsFilterInput()) {
			this.addChild(new Spacer(1));
			this.addChild(this.input);
		}
		this.addChild(new Spacer(1));
		this.listSlotIndex = this.children.length;
		this.list = this.buildList(this.allItems);
		this.addChild(this.list);
		if (opts.hint) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(opts.theme.fg("dim", `  ${opts.hint}`), 0, 0));
		}
		this.addChild(new DynamicBorder(border));
	}

	private needsFilterInput(): boolean {
		return this.allItems.length > 8;
	}

	private buildList(items: ListPickerItem[]): SelectList {
		const list = new SelectList(
			items.map((item) => ({ ...item, label: item.label ?? item.value })),
			Math.min(this.opts.maxVisible ?? 12, Math.max(1, items.length)),
			getSelectListTheme(),
			LIST_LAYOUT,
		);
		list.onSelect = (item) => this.opts.onSelect(item.value);
		list.onCancel = () => this.opts.onCancel();
		list.onSelectionChange = () => this.invalidate();
		const selected = this.opts.selectedValue;
		if (selected !== undefined) {
			const index = items.findIndex((item) => item.value === selected);
			if (index !== -1) list.setSelectedIndex(index);
		}
		return list;
	}

	private applyFilter(query: string): void {
		const filtered = query
			? fuzzyFilter(this.allItems, query, (item) => `${item.label ?? ""} ${item.value} ${item.description ?? ""}`)
			: this.allItems;
		const selectedValue = this.list.getSelectedItem()?.value;
		const next = this.buildList(filtered);
		if (selectedValue !== undefined) {
			const index = filtered.findIndex((item) => item.value === selectedValue);
			if (index !== -1) next.setSelectedIndex(index);
		}
		this.children[this.listSlotIndex] = next;
		this.list = next;
		this.invalidate();
	}

	/** The underlying list (for tests). */
	getList(): SelectList {
		return this.list;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const isNav =
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.confirm") ||
			kb.matches(data, "tui.select.cancel");
		if (isNav) {
			this.list.handleInput(data);
			return;
		}
		if (this.needsFilterInput()) {
			this.input.handleInput(data);
			this.applyFilter(this.input.getValue());
		}
	}
}

/** A non-interactive message component (loading/empty states inside submenus). */
export class MessageComponent extends Container {
	constructor(theme: UiTheme, title: string, message: string, hint?: string) {
		super();
		const border = (s: string) => theme.fg("accent", s);
		this.addChild(new DynamicBorder(border));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", `  ${message}`), 0, 0));
		if (hint) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", `  ${hint}`), 0, 0));
		}
		this.addChild(new DynamicBorder(border));
	}
}

/** A loading message that can be cancelled with Escape. */
export class LoadingComponent extends MessageComponent implements Component {
	private readonly onCancel: (() => void) | undefined;

	constructor(theme: UiTheme, title: string, message: string, onCancel?: () => void) {
		super(theme, title, message, onCancel ? "Esc to cancel" : undefined);
		this.onCancel = onCancel;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) this.onCancel?.();
	}
}
