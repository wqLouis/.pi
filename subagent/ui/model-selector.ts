/**
 * pi's built-in model selector (the same UI /model uses), embedded as a
 * component for the subagent settings panel and the `/subagent model` command.
 *
 * The session's real ModelRuntime is reached through the ModelRegistry facade so
 * extension-registered providers are listed too. No onSelectAsDefault callback is
 * passed, so Ctrl+S (set as pi's session default) is unavailable — this picks the
 * subagent model, not pi's session default.
 */

import {
	ModelSelectorComponent,
	type ExtensionCommandContext,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export function makeModelSelector(
	ctx: ExtensionCommandContext,
	tui: TUI,
	initialFilter: string,
	currentLabel: string | undefined,
	onDone: (model: string | undefined) => void,
): ModelSelectorComponent {
	const runtime = (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
	const [provider, ...rest] = (currentLabel ?? "").split("/");
	const currentModel = currentLabel ? ctx.modelRegistry.find(provider, rest.join("/")) : ctx.model;
	return new ModelSelectorComponent(
		tui,
		currentModel,
		runtime,
		ctx.scopedModels,
		(model) => onDone(`${model.provider}/${model.id}`),
		() => onDone(undefined),
		initialFilter,
	);
}

/** Open the model selector as a standalone dialog; resolves to the picked model label. */
export async function showModelPicker(
	ctx: ExtensionCommandContext,
	initialFilter: string,
	currentLabel?: string,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Model picker requires interactive mode. Use: /subagent model <provider/id>", "info");
		return undefined;
	}
	return await ctx.ui.custom<string | undefined>((tui, _theme, _kb, done) => {
		return makeModelSelector(ctx, tui, initialFilter, currentLabel, done) as unknown as Component;
	});
}
