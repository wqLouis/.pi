/**
 * Codemode by default, and explicitly recommended.
 *
 * `codemode` is registered inactive by pi. This extension activates it at the
 * start of every session (and after `/reload`) and keeps it active: it is the
 * harness's scripting layer, so it is never switched off by the tool loadout.
 *
 * It also adds a system-prompt section that tells the agent to work through
 * codemode scripts instead of chaining single tool calls.
 *
 * Explicit configuration wins: `--tools`, `--no-tools`, or a plain
 * `defaultTools` list that omits `codemode` is left alone. Opt out for one
 * process with `PI_CODEMODE_DEFAULT=0`. A subagent spawned with an explicit
 * `--tools` list sets `PI_SUBAGENT_TOOLS_SET=1`, so its tool selection is
 * respected exactly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEMODE_TOOL = "codemode";
const SECTION_NAME = "codemode";

const CODEMODE_SECTION = [
	"Use the codemode tool for all tool work. Do not call tools directly.",
	"",
	"- Never call a tool directly. Write one codemode script per step instead: it runs the calls (independent ones with `Promise.allSettled`), chains them, and returns only the part you need.",
	"- A direct tool call is a mistake, not a shortcut: even a single step belongs in a script.",
	"- The script output is what reaches you, so filter large results inside the script instead of pulling everything into the conversation.",
].join("\n");

function explicitToolsOmitCodemode(pi: ExtensionAPI): boolean {
	const configured = pi.getSettings().defaultTools;
	if (Array.isArray(configured)) {
		if (configured.includes(`-${CODEMODE_TOOL}`)) return true;
		const plain = configured.filter((name) => !name.startsWith("+") && !name.startsWith("-"));
		if (plain.length > 0 && !plain.includes(CODEMODE_TOOL)) return true;
	}

	const args = process.argv.slice(2);
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--no-tools" || arg === "-nt") return true;
		let value: string | undefined;
		if (arg === "--tools" || arg === "-t") value = args[index + 1];
		else if (arg.startsWith("--tools=")) value = arg.slice("--tools=".length);
		if (value === undefined) continue;
		const names = value.split(",").map((name) => name.trim()).filter(Boolean);
		if (names.includes(`-${CODEMODE_TOOL}`)) return true;
		const plain = names.filter((name) => !name.startsWith("+") && !name.startsWith("-"));
		if (plain.length > 0 && !plain.includes(CODEMODE_TOOL)) return true;
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	const enable = () => {
		const optOut = process.env.PI_CODEMODE_DEFAULT;
		if (optOut === "0" || optOut === "false" || optOut === "no") return;
		if (process.env.PI_SUBAGENT_TOOLS_SET === "1") return;
		if (explicitToolsOmitCodemode(pi)) return;

		const active = pi.getActiveTools();
		if (active.includes(CODEMODE_TOOL)) return;
		pi.setActiveTools([...active, CODEMODE_TOOL]);
	};

	pi.on("session_start", enable);

	pi.on("before_agent_start", (event) => {
		// Only when codemode is really available: a subagent with an explicit
		// tool list may not have it.
		if (!pi.getActiveTools().includes(CODEMODE_TOOL)) return undefined;
		// The section is a structured part of the prompt, so pi's section
		// machinery (and the prompt cache) keep working.
		const sections = event.systemPromptOptions.sections;
		if (sections[SECTION_NAME] === CODEMODE_SECTION) return undefined;
		sections[SECTION_NAME] = CODEMODE_SECTION;
		return undefined;
	});
}
