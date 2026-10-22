/**
 * Pi docs section — show it only when the session works under a `.pi` path.
 *
 * pi's system prompt always carries a `<docs>` section pointing at pi's own
 * documentation. It is noise in an ordinary project, so this extension removes
 * it from the request unless the working directory is under a `.pi` path
 * (`~/.pi/agent/extensions`, a project with a `.pi/` directory, …).
 *
 * The transcript keeps pi's structured sections untouched: only the request is
 * changed, so the tool-patch mechanism (and the prompt cache) keep working.
 *
 * `/pi-docs always|never|auto` overrides the rule; `PI_DOCS_SECTION` does the
 * same from the environment.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	loadDocsMode,
	saveDocsMode,
	shouldShowDocs,
	stripDocsFromMessages,
	type DocsMode,
} from "./subagent/pi-docs.ts";

export default function (pi: ExtensionAPI) {
	pi.on("context_with_system", (event, ctx: ExtensionContext) => {
		if (shouldShowDocs(ctx.cwd)) return undefined;
		const messages = stripDocsFromMessages(event.messages as Parameters<typeof stripDocsFromMessages>[0]);
		if (messages === event.messages) return undefined;
		return { messages: messages as typeof event.messages };
	});

	pi.registerCommand("pi-docs", {
		description:
			"Control pi's docs section in the system prompt. /pi-docs (status), /pi-docs always|never|auto.",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			const mode = loadDocsMode();

			if (arg === "always" || arg === "never" || arg === "auto") {
				saveDocsMode(arg as DocsMode);
				const shown = shouldShowDocs(ctx.cwd, arg as DocsMode);
				ctx.ui.notify(
					`Pi docs section: ${arg} (${shown ? "shown" : "hidden"} for ${ctx.cwd}).`,
					"info",
				);
				return;
			}

			const shown = shouldShowDocs(ctx.cwd, mode);
			ctx.ui.notify(
				`Pi docs section: ${shown ? "shown" : "hidden"}\n` +
					`mode: ${mode} · cwd: ${ctx.cwd}\n` +
					"Use /pi-docs always|never|auto to override.",
				"info",
			);
		},
	});
}
