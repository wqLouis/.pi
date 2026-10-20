/**
 * The `/subagent config` settings panel.
 *
 * Behavior contract:
 *  - Every change saves immediately (no Ctrl+S); the footer flashes "✓ saved".
 *  - While a submenu (model picker, thinking picker, opencode picker) is open,
 *    ALL input is routed to the SettingsList (which delegates it to the open
 *    submenu) — the panel must not intercept keys, or the picker breaks.
 *  - The active row is read from SettingsList's real selection, never tracked
 *    separately, so navigation and number entry cannot drift apart.
 *  - Digits typed on a numeric row are bound to that row's id and committed on
 *    Enter or when the selection moves elsewhere.
 */

import {
	DynamicBorder,
	getSettingsListTheme,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	SettingsList,
	Text,
	getKeybindings,
	type Component,
	type SettingItem,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { OPENCODE_DEFAULT_EFFORT } from "../backends/opencode.ts";
import { configFile, getMaxAutoResumes, getMaxOpencodeSubagents, getMaxSubagents, loadConfig, saveConfig } from "../config.ts";
import { DEFAULT_OPENCODE_MODEL, SETTINGS_MAX_VISIBLE } from "../constants.ts";
import { THINKING_LEVEL_DESCRIPTIONS, isThinkingLevel, supportedThinkingLevels } from "../models.ts";
import { countRunningSubagents } from "../records.ts";
import type { SubagentBackend, SubagentConfig } from "../types.ts";
import { ListPickerComponent, type UiTheme } from "./list-picker.ts";
import { makeModelSelector } from "./model-selector.ts";
import { OpencodePickerComponent, type OpencodeChoice } from "./opencode-picker.ts";

const FOOTER_HINT = "↑/↓ navigate · Enter to change · type a number to set a limit · Esc close";
const SAVED_FLASH_MS = 2000;

/** Summary for non-interactive mode (no TUI). */
function notifyConfigSummary(ctx: ExtensionCommandContext): void {
	const cfg = loadConfig();
	const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
	ctx.ui.notify(
		`backend: ${cfg.backend ?? "auto (infer from model)"} · model: ${cfg.model ?? "(inherit)"} (session: ${sessionModel})\n` +
			`thinking level: ${cfg.thinkingLevel ?? "(model default)"}\n` +
			`opencode model: ${cfg.opencodeModel ?? DEFAULT_OPENCODE_MODEL}${cfg.opencodeEffort && cfg.opencodeEffort !== OPENCODE_DEFAULT_EFFORT ? ` · effort: ${cfg.opencodeEffort}` : ""}\n` +
			`maxSubagents: ${getMaxSubagents()} (pi running ${countRunningSubagents("pi")}) · maxOpencodeSubagents: ${getMaxOpencodeSubagents()} (opencode running ${countRunningSubagents("opencode")})\n` +
			`scope: ${cfg.scope ? (Array.isArray(cfg.scope) ? cfg.scope.join(", ") : cfg.scope) : "(none)"} · allowTmp: ${cfg.allowTmp === false ? "no" : "yes"}\n` +
			`autoResume: ${cfg.autoResume === false ? "no" : "yes"} (limit ${getMaxAutoResumes()})\n` +
			`file: ${configFile()}`,
		"info",
	);
}

export async function showSubagentConfigUi(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		notifyConfigSummary(ctx);
		return;
	}

	await ctx.ui.custom<void>((tui: TUI, theme: UiTheme, _kb, done) => {
		const draft: SubagentConfig = { ...loadConfig() };
		const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const sessionModelText = sessionModel ?? "(none)";
		let savedAt = 0;
		let closed = false;
		let flashTimer: ReturnType<typeof setTimeout> | undefined;

		// --- value helpers -------------------------------------------------
		/** Numeric rows: bounds, the effective value (config ?? env ?? default), and the draft setter. */
		const numericSpecs: Record<string, { min: number; effective: () => number; set: (n: number) => void }> = {
			maxSubagents: {
				min: 1,
				effective: () => draft.maxSubagents ?? getMaxSubagents(),
				set: (n) => (draft.maxSubagents = n),
			},
			maxOpencodeSubagents: {
				min: 1,
				effective: () => draft.maxOpencodeSubagents ?? getMaxOpencodeSubagents(),
				set: (n) => (draft.maxOpencodeSubagents = n),
			},
			maxAutoResumes: {
				min: 0,
				effective: () => draft.maxAutoResumes ?? getMaxAutoResumes(),
				set: (n) => (draft.maxAutoResumes = n),
			},
		};
		const numericValue = (id: string) => String(numericSpecs[id].effective());
		const maxSubagentsValue = () => numericValue("maxSubagents");
		const maxOpencodeValue = () => numericValue("maxOpencodeSubagents");
		const maxAutoResumesValue = () => numericValue("maxAutoResumes");
		const backendValue = () => draft.backend ?? "auto";
		const modelValue = () => draft.model ?? `inherit (${sessionModelText})`;
		const thinkingValue = () => draft.thinkingLevel ?? "default (model)";
		const opencodeValue = () => {
			const model = draft.opencodeModel ?? DEFAULT_OPENCODE_MODEL;
			const effort =
				draft.opencodeEffort && draft.opencodeEffort !== OPENCODE_DEFAULT_EFFORT ? draft.opencodeEffort : undefined;
			return effort ? `${model} · ${effort}` : model;
		};

		const finish = () => {
			if (closed) return;
			closed = true;
			if (flashTimer) clearTimeout(flashTimer);
			done(undefined);
		};

		const autoSave = () => {
			saveConfig(draft);
			savedAt = Date.now();
			if (flashTimer) clearTimeout(flashTimer);
			flashTimer = setTimeout(() => {
				if (closed) return;
				updateFooter();
				container.invalidate();
			}, SAVED_FLASH_MS);
			updateFooter();
			container.invalidate();
		};

		// --- rows ----------------------------------------------------------
		const items: SettingItem[] = [
			{
				id: "backend",
				label: "Backend",
				description:
					"Runtime for new subagents. 'auto' infers it from the model (an opencode/... model uses the OpenCode CLI). Enter to cycle.",
				currentValue: backendValue(),
				values: ["auto", "pi", "opencode"],
			},
			{
				id: "model",
				label: "Model",
				description:
					"Model used by new pi subagents. Enter opens pi's model picker (Tab toggles scoped models); inherits the session model when unset.",
				currentValue: modelValue(),
				submenu: (_current, subDone) =>
					makeModelSelector(ctx, tui, "", draft.model ?? sessionModel, (label) => {
						if (label && label !== draft.model) {
							draft.model = label;
							autoSave();
						}
						subDone(label);
					}) as unknown as Component,
			},
			{
				id: "thinking",
				label: "Thinking level",
				description:
					"Reasoning level passed to pi subagents (--thinking). 'default' lets the model decide. Enter to pick from the levels the model supports.",
				currentValue: thinkingValue(),
				submenu: (_current, subDone) => {
					const levels = supportedThinkingLevels(ctx, draft.model);
					const picker = new ListPickerComponent({
						title: "Thinking level",
						theme,
						items: [
							{ value: "default", label: "default", description: "Use the model's default thinking level" },
							...levels.map((level) => ({
								value: level,
								label: level,
								description: THINKING_LEVEL_DESCRIPTIONS[level as ThinkingLevel] ?? "",
							})),
						],
						selectedValue: draft.thinkingLevel ?? "default",
						hint: "Enter to pick · Esc to cancel",
						onSelect: (value) => {
							const next: ThinkingLevel | undefined = value === "default" ? undefined : (value as ThinkingLevel);
							if (next !== draft.thinkingLevel) {
								draft.thinkingLevel = next;
								autoSave();
							}
							subDone(value);
						},
						onCancel: () => subDone(undefined),
					});
					return picker;
				},
			},
			{
				id: "opencode",
				label: "OpenCode model",
				description:
					"Model and effort used when the backend runs on the OpenCode CLI. Enter to pick (probes the opencode CLI for models and effort variants).",
				currentValue: opencodeValue(),
				submenu: (_current, subDone) =>
					new OpencodePickerComponent({
						theme,
						initialModel: draft.opencodeModel ?? DEFAULT_OPENCODE_MODEL,
						initialEffort: draft.opencodeEffort,
						onDone: (choice: OpencodeChoice | undefined) => {
							if (!choice) {
								subDone(undefined);
								return;
							}
							draft.opencodeModel = choice.model;
							draft.opencodeEffort = choice.effort;
							autoSave();
							subDone(choice.effort ? `${choice.model} · ${choice.effort}` : choice.model);
						},
					}),
			},
			{
				id: "maxSubagents",
				label: "Concurrent subagents",
				description: "Maximum pi-backed subagents running at once. Type a number directly, then Enter.",
				currentValue: maxSubagentsValue(),
			},
			{
				id: "maxOpencodeSubagents",
				label: "OpenCode subagents",
				description:
					"Maximum opencode-backed subagents running at once — an independent pool, on top of the pi limit above. Type a number directly, then Enter.",
				currentValue: maxOpencodeValue(),
			},
			{
				id: "cwd",
				label: "Working directory",
				description: "Where new subagents run (edit subagent-config.json to change).",
				currentValue: draft.cwd ?? "(inherit — session cwd)",
			},
			{
				id: "scope",
				label: "Default edit scope",
				description:
					"Edit scope applied to spawned subagents (overridden by the spawn scope param). Set with /subagent config scope <path>.",
				currentValue: Array.isArray(draft.scope) ? draft.scope.join(", ") : (draft.scope ?? "(none — full access)"),
			},
			{
				id: "allowTmp",
				label: "Allow temp writes",
				description: "Whether subagents may write to the OS temp dir when scoped. Enter to toggle.",
				currentValue: draft.allowTmp === false ? "no" : "yes",
				values: ["yes", "no"],
			},
			{
				id: "autoResume",
				label: "Auto-resume subagents",
				description: "Resume subagents interrupted by a quit or session switch when the session is resumed. Enter to toggle.",
				currentValue: draft.autoResume === false ? "no" : "yes",
				values: ["yes", "no"],
			},
			{
				id: "maxAutoResumes",
				label: "Auto-resume limit",
				description: "Maximum automatic resumes per subagent before it is marked as errored. Type a number directly, then Enter.",
				currentValue: maxAutoResumesValue(),
			},
		];

		const numericIds = new Set(Object.keys(numericSpecs));
		let digitRowId: string | undefined;
		let digitInput = "";

		const settingsList = new SettingsList(
			items,
			SETTINGS_MAX_VISIBLE,
			getSettingsListTheme(),
			(id, newValue) => {
				// Submenu rows (`model`, `thinking`, `opencode`) mutate the draft inside
				// their submenu callbacks; their onChange is a no-op here.
				if (id === "backend") {
					draft.backend = newValue === "auto" ? undefined : (newValue as SubagentBackend);
				} else if (id === "allowTmp") {
					draft.allowTmp = newValue === "yes";
				} else if (id === "autoResume") {
					draft.autoResume = newValue === "yes";
				} else {
					return;
				}
				autoSave();
			},
			() => finish(),
			{ enableSearch: false },
		);

		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const footer = new Text(theme.fg("dim", FOOTER_HINT), 1, 0);
		const updateFooter = () => {
			if (Date.now() - savedAt < SAVED_FLASH_MS) footer.setText(theme.fg("success", "✓ saved"));
			else footer.setText(theme.fg("dim", FOOTER_HINT));
		};

		// SettingsList keeps `selectedIndex`/`submenuComponent` private; both are real
		// runtime fields, and reading them is the only way to stay in sync with its
		// actual selection and submenu state.
		const internals = settingsList as unknown as { selectedIndex: number; submenuComponent: unknown };
		const activeItem = (): SettingItem | undefined => items[internals.selectedIndex];
		const submenuOpen = () => internals.submenuComponent != null;

		const commitDigits = (id: string) => {
			const spec = numericSpecs[id];
			const n = Number(digitInput);
			const valid = digitInput.length > 0 && Number.isInteger(n) && n >= spec.min;
			const changed = valid && spec.effective() !== n;
			if (valid) spec.set(n);
			digitInput = "";
			digitRowId = undefined;
			if (changed) autoSave();
			else {
				settingsList.updateValue(id, numericValue(id));
				container.invalidate();
			}
		};

		updateFooter();
		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold("Subagent settings")), 1, 0));
		container.addChild(settingsList);
		container.addChild(footer);
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				// While a submenu is open the SettingsList owns all input (it delegates to
				// the picker). Intercepting here is what broke the model picker before.
				if (submenuOpen()) {
					settingsList.handleInput(data);
					return;
				}

				const kb = getKeybindings();
				const row = activeItem();
				const numericRow = row && numericIds.has(row.id) ? row : undefined;

				if (numericRow) {
					if (data.length === 1 && data >= "0" && data <= "9") {
						digitRowId = numericRow.id;
						digitInput = (digitInput + data).slice(0, 3);
						settingsList.updateValue(numericRow.id, digitInput);
						container.invalidate();
						return;
					}
					if (data === "\x7f" || data === "\b") {
						if (digitRowId === numericRow.id && digitInput) {
							digitInput = digitInput.slice(0, -1);
							settingsList.updateValue(numericRow.id, digitInput || numericValue(numericRow.id));
							container.invalidate();
						}
						return;
					}
					if (kb.matches(data, "tui.select.confirm") && digitRowId === numericRow.id && digitInput) {
						commitDigits(numericRow.id);
						return;
					}
					if (kb.matches(data, "tui.select.cancel") && digitRowId === numericRow.id && digitInput) {
						digitInput = "";
						digitRowId = undefined;
						settingsList.updateValue(numericRow.id, numericValue(numericRow.id));
						container.invalidate();
						return;
					}
				}

				const indexBefore = internals.selectedIndex;
				settingsList.handleInput(data);
				const indexAfter = internals.selectedIndex;
				if (digitRowId && digitInput && indexAfter !== indexBefore && items[indexAfter]?.id !== digitRowId) {
					// Selection moved off the edited row: commit the pending number.
					commitDigits(digitRowId);
				}
			},
		};
	});
}
