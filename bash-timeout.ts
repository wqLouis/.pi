

import process from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_SECONDS = Number(process.env.PI_BASH_DEFAULT_TIMEOUT ?? "10");

const GUIDELINE =
	`When running bash commands, always pass an explicit timeout (e.g. "timeout": ${DEFAULT_TIMEOUT_SECONDS}) so commands cannot hang indefinitely. ` +
	`A default of ${DEFAULT_TIMEOUT_SECONDS}s is applied automatically when you omit it — pass a larger value for long-running commands such as builds, installs, or tests.`;

export default function (pi: ExtensionAPI) {

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;

		event.input.timeout = event.input.timeout ?? DEFAULT_TIMEOUT_SECONDS;
	});


	pi.on("before_agent_start", (event) => {
		if (event.systemPrompt.includes(GUIDELINE)) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${GUIDELINE}` };
	});
}
