/**
 * System prompt viewer.
 *
 * `/system` shows the system prompt the agent currently runs with as gray
 * text in the TUI, together with an approximate token count (characters / 4,
 * the same rough estimate pi uses for tool sections).
 *
 * The prompt is refreshed before every run, so the widget always shows what
 * the next request will use. The full prompt is long, so the widget shows a
 * short preview; `/system full` writes the whole prompt to a temp file and
 * reports the path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "system-prompt";
const PREVIEW_LINES = 6;
const PREVIEW_CHARS = 120;

/** Rough token estimate: ~4 characters per token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const formatTokens = (tokens: number): string =>
	tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

export default function (pi: ExtensionAPI) {
	let visible = false;
	let prompt = "";
	let lastRunAt = 0;

	const snapshot = (ctx: ExtensionContext): void => {
		try {
			prompt = ctx.getSystemPrompt() ?? "";
		} catch {
			prompt = "";
		}
		lastRunAt = Date.now();
	};

	const updateWidget = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		if (!visible) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const theme: Theme = ctx.ui.theme;
		const tokens = estimateTokens(prompt);
		const lines = prompt.split("\n");
		const preview = lines
			.slice(0, PREVIEW_LINES)
			.map((line) => {
				const text = line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
				return `  ${theme.fg("muted", text)}`;
			})
			.filter((line) => line.trim().length > 0);

		const header = theme.fg("dim", `system prompt · ~${formatTokens(tokens)} tokens · ${lines.length} lines`);
		ctx.ui.setWidget(WIDGET_KEY, [header, ...preview, theme.fg("dim", "  … /system full for the whole prompt")]);
	};

	const writeFullPrompt = (ctx: ExtensionContext): string => {
		const file = path.join(os.tmpdir(), `pi-system-prompt-${Date.now()}.md`);
		fs.writeFileSync(file, prompt, { encoding: "utf-8", mode: 0o600 });
		return file;
	};

	pi.on("before_agent_start", (_event, ctx) => {
		snapshot(ctx);
		updateWidget(ctx);
		return undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		snapshot(ctx);
		updateWidget(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.registerCommand("system", {
		description:
			"Show the current system prompt in the TUI. /system (toggle), /system on|off, /system show, /system tokens, /system full.",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();

			if (arg === "tokens" || arg === "count") {
				snapshot(ctx);
				const tokens = estimateTokens(prompt);
				ctx.ui.notify(
					`System prompt: ~${tokens} tokens (${prompt.length} characters, ${prompt.split("\n").length} lines).`,
					"info",
				);
				return;
			}

			if (arg === "full" || arg === "dump") {
				snapshot(ctx);
				const file = writeFullPrompt(ctx);
				ctx.ui.notify(`System prompt written to ${file} (~${estimateTokens(prompt)} tokens).`, "info");
				return;
			}

			if (arg === "on" || arg === "show" || arg === "off" || arg === "hide") {
				visible = arg === "on" || arg === "show";
				snapshot(ctx);
				updateWidget(ctx);
				ctx.ui.notify(visible ? "System prompt shown above the editor." : "System prompt hidden.", "info");
				return;
			}

			// Default: toggle.
			visible = !visible;
			snapshot(ctx);
			updateWidget(ctx);
			ctx.ui.notify(
				visible
					? `System prompt shown above the editor (~${estimateTokens(prompt)} tokens).`
					: "System prompt hidden.",
				"info",
			);
		},
	});
}
