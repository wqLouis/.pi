/**
 * Codemode by default.
 *
 * `codemode` is registered inactive by pi. This extension activates it at the
 * start of every session (and after `/reload`), so the agent always has the
 * codemode tool available without requiring a `defaultTools` setting.
 *
 * Explicit configuration wins: `--tools`, `--no-tools`, or a plain
 * `defaultTools` list that omits `codemode` is left alone. Opt out for one
 * process with `PI_CODEMODE_DEFAULT=0`. A subagent spawned with an explicit
 * `--tools` list sets `PI_SUBAGENT_TOOLS_SET=1`, so its tool selection is
 * respected exactly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEMODE_TOOL = "codemode";

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
}
