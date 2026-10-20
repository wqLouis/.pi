/**
 * Two-step OpenCode picker for the settings panel: choose an opencode model
 * (catalog probed over ACP, CLI fallback), then one of its effort
 * (thought_level) variants. A model with no effort variants is accepted
 * directly with the default effort.
 */

import type { Component } from "@earendil-works/pi-tui";
import { OPENCODE_DEFAULT_EFFORT, loadOpencodeEfforts, loadOpencodeModelCatalog } from "../backends/opencode.ts";
import { ListPickerComponent, LoadingComponent, type UiTheme } from "./list-picker.ts";

const DEFAULT_CHOICE = "__opencode_default_effort__";

export interface OpencodeChoice {
	model: string;
	/** undefined = the model's default effort. */
	effort?: string;
}

export interface OpencodePickerOptions {
	theme: UiTheme;
	initialModel?: string;
	initialEffort?: string;
	/** Called exactly once with the selection, or undefined when cancelled. */
	onDone: (choice: OpencodeChoice | undefined) => void;
}

export class OpencodePickerComponent implements Component {
	private readonly theme: UiTheme;
	private readonly initialModel: string | undefined;
	private readonly initialEffort: string | undefined;
	private readonly onDone: (choice: OpencodeChoice | undefined) => void;
	private current: Component;
	private models: { value: string; name: string }[] | undefined;
	/** Bumped on every navigation so stale async continuations are ignored. */
	private epoch = 0;
	private finished = false;

	constructor(opts: OpencodePickerOptions) {
		this.theme = opts.theme;
		this.initialModel = opts.initialModel;
		this.initialEffort = opts.initialEffort;
		this.onDone = opts.onDone;
		this.current = new LoadingComponent(this.theme, "OpenCode", "Loading OpenCode models…", () => this.finish(undefined));
		void this.loadModels();
	}

	private finish(choice: OpencodeChoice | undefined): void {
		if (this.finished) return;
		this.finished = true;
		this.onDone(choice);
	}

	private async loadModels(): Promise<void> {
		const epoch = ++this.epoch;
		const models = await loadOpencodeModelCatalog();
		if (epoch !== this.epoch || this.finished) return;
		if (models.length === 0) {
			this.current = new LoadingComponent(
				this.theme,
				"OpenCode",
				"Could not load OpenCode models. Is the `opencode` CLI installed and on PATH?",
				() => this.finish(undefined),
			);
			return;
		}
		this.models = models;
		this.showModels();
	}

	private showModels(): void {
		++this.epoch;
		const models = this.models ?? [];
		this.current = new ListPickerComponent({
			title: "OpenCode model",
			theme: this.theme,
			items: models.map((m) => ({ value: m.value, label: m.name, description: m.value })),
			selectedValue: this.initialModel,
			hint: "Enter to pick · type to filter · Esc to cancel",
			onSelect: (value) => void this.pickModel(value),
			onCancel: () => this.finish(undefined),
		});
	}

	private async pickModel(model: string): Promise<void> {
		const epoch = ++this.epoch;
		this.current = new LoadingComponent(this.theme, "OpenCode", `Loading effort levels for ${model}…`, () => {
			if (epoch === this.epoch && !this.finished) this.showModels();
		});
		const efforts = await loadOpencodeEfforts(model);
		if (epoch !== this.epoch || this.finished) return;
		const variants = efforts.filter((e) => e.value !== OPENCODE_DEFAULT_EFFORT);
		if (variants.length === 0) {
			// No thought_level variants for this model: accept it with the default effort.
			this.finish({ model });
			return;
		}
		this.current = new ListPickerComponent({
			title: `Effort for ${model}`,
			theme: this.theme,
			items: [
				{ value: DEFAULT_CHOICE, label: "default", description: "Use the model's default effort" },
				...variants.map((e) => ({ value: e.value, label: e.name, description: e.description })),
			],
			selectedValue: this.initialEffort && this.initialEffort !== OPENCODE_DEFAULT_EFFORT ? this.initialEffort : DEFAULT_CHOICE,
			hint: "Enter to pick · Esc to go back",
			onSelect: (value) =>
				this.finish({ model, effort: value === DEFAULT_CHOICE ? undefined : value }),
			onCancel: () => this.showModels(),
		});
	}

	render(width: number): string[] {
		return this.current.render(width);
	}

	invalidate(): void {
		this.current.invalidate?.();
	}

	handleInput(data: string): void {
		this.current.handleInput?.(data);
	}
}
