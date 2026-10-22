/**
 * Agent mode — selectable system-prompt templates.
 *
 * At the start of a new session (and after every compaction) the user picks:
 *
 *  - TOKEN MAXING: the main agent only decomposes, dispatches subagents,
 *    reviews their patches from /tmp, and merges them. It must not explore or
 *    implement on its own.
 *  - SINGLE AGENT: pi's normal system prompt, unchanged.
 *
 * The choice is persisted as a custom session entry and restored on
 * resume/reload. `/mode` changes it at any time.
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent, Theme } from "@earendil-works/pi-coding-agent";

type AgentMode = "token-maxing" | "single-agent";

const CUSTOM_TYPE = "agent-mode";
const TOKEN_MAXING_MARKER = "## TOKEN MAXING MODE — ORCHESTRATE, REVIEW, MERGE";
/** Section name in the structured system prompt (lowercase, per pi's rules). */
const SECTION_NAME = "token_maxing";

const MODE_LABELS: Record<AgentMode, string> = {
	"token-maxing": "TOKEN MAXING — delegate all work to subagents; review and merge patches",
	"single-agent": "SINGLE AGENT — normal system prompt (no extra instructions)",
};

const TOKEN_MAXING_PROMPT = `${TOKEN_MAXING_MARKER}

You are the lead architect, reviewer, and integrator. Your context is the most
expensive resource in the system, so you preserve it by delegating the work.

Hard rules:
0. Check the active tool loadout first. You need the subagent tools
   (subagent_spawn, subagent_interrupt, subagent_list, subagent_result),
   read, bash, and a merge path (edit/write or bash + git apply). If any are
   missing, ask the user to enable them with /tools before starting.
1. Never perform open-ended investigation or implementation yourself. Delegate
   every exploration, edit, and fix to subagents with \`subagent_spawn\`.
2. You may use \`read\` and \`bash\` only to review diffs, inspect git state,
   apply patches, and run tests/builds. If you catch yourself exploring or
   writing production code, stop and delegate it.
3. Split the request into small, independent work packets. Spawn independent
   packets in parallel. Give every subagent a unique name, an exact scope,
   acceptance criteria, and the files it may touch. Use the spawn \`scope\` so
   subagents cannot collide.
4. Subagents must hand off patches, not edit the main tree. Require each one to
   write its diff under \`/tmp/pi-patches/<name>/\` (for example
   \`git diff > /tmp/pi-patches/<name>/patch.diff\`) and to report:
   patch path, changed files, tests run, risks, and anything left undone.
   If a subagent genuinely must write in-tree, give it an isolated worktree or
   copy of the repository.
5. Review every patch before merging. Read the full diff and check design fit,
   correctness, edge cases, tests, style, and scope. Reject or revise with
   \`subagent_interrupt\` and specific instructions. Never merge unreviewed work.
6. Only you write to the main tree, and only by applying reviewed patches or
   making small merge-conflict resolutions. Keep the architecture coherent.
7. After merging, run the focused tests/build. On failure, dispatch a fix
   subagent with the exact error output and the relevant patch path. Do not
   debug it yourself.
8. Do not accept "done" without evidence: a patch path, a diff you have read,
   and test/build output. If an output lacks a patch, ask for one before review.
9. Keep substantial multi-step work on the shared task board. Mark progress and
   move finished items to Done.

The goal is maximum useful work per token of main-agent context, not maximum
speed at the cost of quality.`;

const isAgentMode = (value: unknown): value is AgentMode =>
	value === "token-maxing" || value === "single-agent";

/** Subagent children have no user to answer a mode dialog (and must not recurse). */
const IS_SUBAGENT = Boolean(process.env.PI_SUBAGENT_ID) || Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0;

function readPersistedMode(ctx: ExtensionContext): AgentMode | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		const data = entry.data as { mode?: unknown } | undefined;
		if (isAgentMode(data?.mode)) return data.mode;
	}
	return undefined;
}

function updateStatus(ctx: ExtensionContext, mode: AgentMode | undefined): void {
	if (ctx.mode !== "tui") return;
	const theme: Theme = ctx.ui.theme;
	ctx.ui.setStatus(
		"agent-mode",
		mode === "token-maxing" ? theme.fg("warning", "mode:token-maxing") : theme.fg("dim", "mode:single"),
	);
}

export default function (pi: ExtensionAPI) {
	let mode: AgentMode | undefined;

	const persist = (next: AgentMode) => {
		mode = next;
		pi.appendEntry(CUSTOM_TYPE, { mode: next });
	};

	const choose = async (ctx: ExtensionContext, title: string): Promise<AgentMode> => {
		if (IS_SUBAGENT || !ctx.hasUI) return mode ?? "single-agent";
		const choice = await ctx.ui.select(title, [
			MODE_LABELS["token-maxing"],
			MODE_LABELS["single-agent"],
		]);
		if (choice === MODE_LABELS["token-maxing"]) return "token-maxing";
		if (choice === MODE_LABELS["single-agent"]) return "single-agent";
		// Escape/cancel: keep the current mode. On a brand-new session there is
		// none yet, so use the safe normal prompt.
		return mode ?? "single-agent";
	};

	const apply = (ctx: ExtensionContext, next: AgentMode, notify: boolean) => {
		const changed = mode !== next;
		persist(next);
		updateStatus(ctx, next);
		if (notify && ctx.hasUI) {
			ctx.ui.notify(
				next === "token-maxing"
					? "Agent mode: TOKEN MAXING (delegate, review patches, merge)."
					: "Agent mode: SINGLE AGENT (normal system prompt).",
				"info",
			);
		}
		return changed;
	};

	const chooseAndApply = async (ctx: ExtensionContext, title: string) => {
		const next = await choose(ctx, title);
		apply(ctx, next, true);
		return next;
	};

	pi.on("session_start", async (event: SessionStartEvent, ctx) => {
		const restored = readPersistedMode(ctx);
		mode = restored;

		// Ask on startup, on `/new`, and on fork; restore silently on resume and
		// reload. Startup is also used when pi continues/resumes a session, so
		// only prompt when the session has no persisted choice.
		const isNewish = event.reason === "startup" || event.reason === "new" || event.reason === "fork";
		if (isNewish && (event.reason !== "startup" || !restored)) {
			await chooseAndApply(ctx, "Agent mode for this session");
			return;
		}

		mode ??= "single-agent";
		updateStatus(ctx, mode);
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Re-select after compaction: the summary is a natural checkpoint, and
		// the mode lives in a custom entry that survives the compaction.
		await chooseAndApply(ctx, "Context compacted — agent mode for the next stretch");
	});

	pi.on("session_tree", (_event, ctx) => {
		// Follow the active branch: a different branch may have another mode.
		const restored = readPersistedMode(ctx);
		mode = restored ?? "single-agent";
		updateStatus(ctx, mode);
	});

	pi.on("before_agent_start", (event) => {
		if (IS_SUBAGENT) return undefined;
		if (mode !== "token-maxing") return undefined;
		// A structured section, not a forced prompt: the rest of the prompt keeps
		// pi's section machinery (and the prompt cache) intact.
		const sections = event.systemPromptOptions.sections;
		if (sections[SECTION_NAME] === TOKEN_MAXING_PROMPT) return undefined;
		sections[SECTION_NAME] = TOKEN_MAXING_PROMPT;
		return undefined;
	});

	pi.registerCommand("mode", {
		description:
			"Select the system-prompt mode. /mode (picker), /mode token-maxing, /mode single-agent, /mode status.",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (!arg || arg === "pick" || arg === "select") {
				await chooseAndApply(ctx, "Agent mode");
				return;
			}
			if (arg === "status" || arg === "show") {
				ctx.ui.notify(
					`Agent mode: ${mode ?? "unset (single-agent default)"}. ` +
						"Use /mode token-maxing or /mode single-agent to change.",
					"info",
				);
				return;
			}
			if (["token-maxing", "tokenmax", "token", "max", "tm"].includes(arg)) {
				apply(ctx, "token-maxing", true);
				return;
			}
			if (["single-agent", "single", "agent", "normal", "off", "sa"].includes(arg)) {
				apply(ctx, "single-agent", true);
				return;
			}
			ctx.ui.notify("Usage: /mode [token-maxing|single-agent|status]", "warning");
		},
	});
}
