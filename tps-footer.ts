/**
 * Average TPS footer.
 *
 * Pi's default footer shows the context percentage/window in its stats row.
 * This extension replaces the footer with an equivalent one that appends the
 * session's average response throughput next to the context window, e.g.
 *
 *   ↑12.4k ↓3.2k $0.042 8.1%/200k avg 43.7 t/s      gpt-5.6-luna • high
 *
 * Throughput is total output tokens divided by total response duration for all
 * assistant responses in the session that carry timing data. Pi stores
 * `durationMs` on each assistant message, so the value survives restarts,
 * resumes, and branches without tracking timers at runtime.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatTps(tps: number | undefined): string {
	if (tps === undefined || !Number.isFinite(tps)) return "? t/s";
	if (tps >= 100) return `${tps.toFixed(0)} t/s`;
	return `${tps.toFixed(1)} t/s`;
}

/** Replace the home directory prefix with ~, like the built-in footer. */
function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const normalizedCwd = cwd.replace(/\/$/, "");
	const normalizedHome = home.replace(/\/$/, "");
	if (normalizedCwd === normalizedHome) return "~";
	if (normalizedCwd.startsWith(`${normalizedHome}/`)) return `~${normalizedCwd.slice(normalizedHome.length)}`;
	return cwd;
}

interface FooterStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate?: number;
	tpsTokens: number;
	tpsMilliseconds: number;
}

function collectStats(entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>): FooterStats {
	const stats: FooterStats = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		tpsTokens: 0,
		tpsMilliseconds: 0,
	};

	const addUsage = (usage: AssistantMessage["usage"] | undefined) => {
		if (!usage) return;
		stats.input += usage.input;
		stats.output += usage.output;
		stats.cacheRead += usage.cacheRead;
		stats.cacheWrite += usage.cacheWrite;
		stats.cost += usage.cost.total;
	};

	for (const entry of entries) {
		if (entry.type === "usage") {
			addUsage(entry.usage);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message as AssistantMessage;
			addUsage(message.usage);
			const promptTokens =
				message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
			stats.latestCacheHitRate =
				promptTokens > 0 ? (message.usage.cacheRead / promptTokens) * 100 : undefined;
			if (message.durationMs !== undefined && message.durationMs > 0 && message.usage.output > 0) {
				stats.tpsTokens += message.usage.output;
				stats.tpsMilliseconds += message.durationMs;
			}
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			addUsage(entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsage(entry.usage);
		}
	}

	return stats;
}

function installFooter(ctx: ExtensionContext): void {
	let cache:
		| {
				sessionId: string;
				leafId: string | null;
				entryCount: number;
				stats: FooterStats;
		  }
		| undefined;

	// getEntryCount() exists on the runtime SessionManager but is omitted from the
	// readonly type. Use it when present so a cache hit never copies the whole session.
	const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & { getEntryCount?: () => number };

	const getStats = (): FooterStats => {
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		let entries: ReturnType<typeof sessionManager.getEntries> | undefined;
		const entryCount = sessionManager.getEntryCount
			? sessionManager.getEntryCount()
			: (entries = sessionManager.getEntries()).length;
		if (
			cache &&
			cache.sessionId === sessionId &&
			cache.leafId === leafId &&
			cache.entryCount === entryCount
		) {
			return cache.stats;
		}
		const stats = collectStats(entries ?? sessionManager.getEntries());
		cache = { sessionId, leafId, entryCount, stats };
		return stats;
	};

	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsubscribeBranch,
			invalidate() {},
			render(width: number): string[] {
				const stats = getStats();
				const usage: ContextUsage | undefined = ctx.getContextUsage();
				const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const hasPercent = typeof usage?.percent === "number";
				const contextPercentValue = hasPercent ? (usage?.percent as number) : 0;
				const contextPercent = hasPercent ? contextPercentValue.toFixed(1) : "?";
				const contextWindowDisplay = contextWindow > 0 ? formatTokens(contextWindow) : "?";

				let pwd = formatCwd(ctx.cwd);
				const branch = footerData.getGitBranch();
				if (branch) pwd = `${pwd} (${branch})`;
				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) pwd = `${pwd} • ${sessionName}`;

				const statsParts: string[] = [];
				if (stats.input) statsParts.push(`↑${formatTokens(stats.input)}`);
				if (stats.output) statsParts.push(`↓${formatTokens(stats.output)}`);
				if (stats.cacheRead) statsParts.push(`R${formatTokens(stats.cacheRead)}`);
				if (stats.cacheWrite) statsParts.push(`W${formatTokens(stats.cacheWrite)}`);
				if (
					(stats.cacheRead > 0 || stats.cacheWrite > 0) &&
					stats.latestCacheHitRate !== undefined
				) {
					statsParts.push(`CH${stats.latestCacheHitRate.toFixed(1)}%`);
				}
				if (stats.cost) statsParts.push(`$${stats.cost.toFixed(3)}`);

				const contextPercentDisplay = `${contextPercent}%/${contextWindowDisplay}`;
				let contextPercentStr: string;
				if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextPercentDisplay);
				else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextPercentDisplay);
				else contextPercentStr = contextPercentDisplay;
				statsParts.push(contextPercentStr);

				// The requested addition: average response TPS on the same row as the context window.
				const averageTps =
					stats.tpsMilliseconds > 0 ? stats.tpsTokens / (stats.tpsMilliseconds / 1000) : undefined;
				statsParts.push(`avg ${formatTps(averageTps)}`);

				if (process.env.PI_EXPERIMENTAL === "1") {
					statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
				}

				let statsLeft = statsParts.join(" ");
				let statsLeftWidth = visibleWidth(statsLeft);
				if (statsLeftWidth > width) {
					statsLeft = truncateToWidth(statsLeft, width, "...");
					statsLeftWidth = visibleWidth(statsLeft);
				}

				const modelName = ctx.model?.id || "no-model";
				let rightSide = modelName;
				if (ctx.model?.reasoning) {
					const thinkingLevel = ctx.thinkingLevel || "off";
					rightSide =
						thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
				}
				if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
					const withProvider = `(${ctx.model.provider}) ${rightSide}`;
					if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
				}

				const minPadding = 2;
				const rightSideWidth = visibleWidth(rightSide);
				const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
				let statsLine: string;
				if (totalNeeded <= width) {
					const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
					statsLine = statsLeft + padding + rightSide;
				} else {
					const availableForRight = width - statsLeftWidth - minPadding;
					if (availableForRight > 0) {
						const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
						const padding = " ".repeat(
							Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)),
						);
						statsLine = statsLeft + padding + truncatedRight;
					} else {
						statsLine = statsLeft;
					}
				}

				// statsLeft may contain the coloured context percentage, whose reset would clear
				// an outer dim wrapper. Dim the two regions independently.
				const dimStatsLeft = theme.fg("dim", statsLeft);
				const remainder = statsLine.slice(statsLeft.length);
				const dimRemainder = theme.fg("dim", remainder);

				const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
				const lines = [pwdLine, dimStatsLeft + dimRemainder];

				const extensionStatuses = footerData.getExtensionStatuses();
				if (extensionStatuses.size > 0) {
					const statusLine = Array.from(extensionStatuses.entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
						.join(" ");
					lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
				}

				return lines;
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		installFooter(ctx);
	});
}
