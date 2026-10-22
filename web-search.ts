/**
 * Web search — one generic tool, several providers.
 *
 * `web_search { query, count?, provider?, includeContent?, context? }` searches
 * the live web through:
 *
 *  - **deepseek**: DeepSeek's own Search API (`POST /v1/tools/search`), which
 *    supports the search operators `site:`, `-site:`, `lang:`, `after:`,
 *    `before:`, `"..."` and `-`. The key comes from the `deepseek` provider
 *    configured in pi, or from `DEEPSEEK_API_KEY`.
 *  - **exa**: EXA's search API (`POST https://api.exa.ai/search`). The key comes
 *    from `EXA_API_KEY` or from an `exa` entry in `~/.pi/agent/auth.json`.
 *
 * `web_fetch { url, provider? }` retrieves one page as Markdown (DeepSeek's
 * Fetch API, or EXA's contents API).
 *
 * The default provider can be pinned with `/web-search provider <name>`; the
 * setting is stored in `~/.pi/agent/web-search.json`. "auto" uses the first
 * provider with a key, in the order deepseek, exa.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const CONFIG_FILE = "web-search.json";

const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
const MAX_SNIPPET_CHARS = 600;
const MAX_CONTENT_CHARS = 8_000;
const REQUEST_TIMEOUT_MS = 30_000;

type Provider = "deepseek" | "exa";
type ProviderChoice = Provider | "auto";

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	content?: string;
	date?: string;
	score?: number;
}

interface WebSearchConfig {
	provider?: ProviderChoice;
}

// ---------------------------------------------------------------------------
// Configuration and credentials
// ---------------------------------------------------------------------------

function configPath(): string {
	return path.join(getAgentDir(), CONFIG_FILE);
}

function loadConfig(): WebSearchConfig {
	try {
		const raw = fs.readFileSync(configPath(), "utf-8");
		const parsed = JSON.parse(raw) as WebSearchConfig;
		if (parsed && typeof parsed === "object") return parsed;
	} catch {
		// No config yet.
	}
	return {};
}

function saveConfig(config: WebSearchConfig): void {
	fs.mkdirSync(getAgentDir(), { recursive: true });
	fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/** Read an api key from ~/.pi/agent/auth.json for a provider id. */
function keyFromAuthFile(provider: string): string | undefined {
	try {
		const raw = fs.readFileSync(path.join(getAgentDir(), "auth.json"), "utf-8");
		const auth = JSON.parse(raw) as Record<string, { type?: string; key?: string } | undefined>;
		const entry = auth?.[provider];
		if (entry && typeof entry.key === "string" && entry.key.trim()) return entry.key.trim();
	} catch {
		// No auth file or unreadable.
	}
	return undefined;
}

async function deepseekKey(ctx: ExtensionContext): Promise<string | undefined> {
	const env = process.env.DEEPSEEK_API_KEY?.trim();
	if (env) return env;
	try {
		const key = await ctx.modelRegistry.getApiKeyForProvider("deepseek");
		if (key) return key;
	} catch {
		// Provider not registered.
	}
	return keyFromAuthFile("deepseek");
}

async function exaKey(ctx: ExtensionContext): Promise<string | undefined> {
	const env = process.env.EXA_API_KEY?.trim();
	if (env) return env;
	try {
		const key = await ctx.modelRegistry.getApiKeyForProvider("exa");
		if (key) return key;
	} catch {
		// Provider not registered.
	}
	return keyFromAuthFile("exa");
}

async function keyFor(provider: Provider, ctx: ExtensionContext): Promise<string | undefined> {
	return provider === "deepseek" ? deepseekKey(ctx) : exaKey(ctx);
}

/** Which providers have a key right now. */
async function providerStatus(ctx: ExtensionContext): Promise<Record<Provider, boolean>> {
	return {
		deepseek: Boolean(await deepseekKey(ctx)),
		exa: Boolean(await exaKey(ctx)),
	};
}

async function resolveProvider(
	requested: ProviderChoice,
	ctx: ExtensionContext,
): Promise<{ provider: Provider; key: string } | { error: string }> {
	const order: Provider[] = requested === "auto" ? ["deepseek", "exa"] : [requested];
	for (const provider of order) {
		const key = await keyFor(provider, ctx);
		if (key) return { provider, key };
	}
	if (requested === "auto") {
		return { error: "No search provider configured (set DEEPSEEK_API_KEY or EXA_API_KEY, or configure a provider in pi)." };
	}
	return {
		error: `No ${requested} API key configured (set ${requested.toUpperCase()}_API_KEY or configure the ${requested} provider in pi).`,
	};
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * The fetch APIs return markdown with escaped punctuation (`\/`, `\#`, `\,`).
 * Unescape a backslash before any non-word character so the text reads
 * normally; a doubled backslash still becomes a single one.
 */
const unescapeMarkdown = (value: string): string => value.replace(/\\([^\w\s])/g, "$1");

const truncate = (value: string | undefined, max: number): string => {
	const text = (value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

async function searchDeepseek(
	key: string,
	query: string,
	count: number,
	includeContent: boolean,
	context?: string,
): Promise<SearchResult[]> {
	const body: Record<string, unknown> = { query, count, need_content: includeContent };
	if (context) body.ori_question = context.slice(0, 128);
	const response = await fetch(DEEPSEEK_SEARCH_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`DeepSeek search failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
	}
	const payload = (await response.json()) as {
		results?: Array<{
			title?: string;
			url?: string;
			snippet?: string;
			summary?: string;
			content?: string;
			date?: string;
			rerank_score?: number;
		}>;
	};
	return (payload.results ?? []).map((result) => ({
		title: result.title ?? "(untitled)",
		url: result.url ?? "",
		snippet: truncate(result.summary ?? result.snippet, MAX_SNIPPET_CHARS),
		content: includeContent ? truncate(result.content, MAX_CONTENT_CHARS) : undefined,
		date: result.date,
		score: result.rerank_score,
	}));
}

async function searchExa(
	key: string,
	query: string,
	count: number,
	includeContent: boolean,
): Promise<SearchResult[]> {
	const response = await fetch(EXA_SEARCH_URL, {
		method: "POST",
		headers: { "x-api-key": key, "Content-Type": "application/json" },
		body: JSON.stringify({
			query,
			numResults: count,
			type: "auto",
			contents: includeContent
				? { text: { maxCharacters: MAX_CONTENT_CHARS }, highlights: true }
				: { highlights: true },
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`EXA search failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
	}
	const payload = (await response.json()) as {
		results?: Array<{
			title?: string;
			url?: string;
			text?: string;
			highlights?: string[];
			summary?: string;
			publishedDate?: string;
			score?: number;
		}>;
	};
	return (payload.results ?? []).map((result) => ({
		title: result.title ?? "(untitled)",
		url: result.url ?? "",
		snippet: truncate(result.summary ?? result.highlights?.join(" ") ?? result.text, MAX_SNIPPET_CHARS),
		content: includeContent ? truncate(result.text, MAX_CONTENT_CHARS) : undefined,
		date: result.publishedDate,
		score: result.score,
	}));
}

async function fetchDeepseek(key: string, url: string): Promise<{ title: string; content: string }> {
	const response = await fetch(DEEPSEEK_FETCH_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({ url }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`DeepSeek fetch failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
	}
	const payload = (await response.json()) as { title?: string; content?: string };
	return { title: payload.title ?? url, content: payload.content ?? "" };
}

async function fetchExa(key: string, url: string): Promise<{ title: string; content: string }> {
	const response = await fetch(EXA_CONTENTS_URL, {
		method: "POST",
		headers: { "x-api-key": key, "Content-Type": "application/json" },
		body: JSON.stringify({ urls: [url], text: { maxCharacters: MAX_CONTENT_CHARS }, highlights: true }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`EXA contents failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
	}
	const payload = (await response.json()) as {
		results?: Array<{ title?: string; text?: string; highlights?: string[] }>;
	};
	const first = payload.results?.[0];
	return {
		title: first?.title ?? url,
		content: first?.text ?? first?.highlights?.join("\n") ?? "",
	};
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatResults(provider: Provider, results: SearchResult[]): string {
	if (results.length === 0) return "No results.";
	const lines: string[] = [`${results.length} result(s) via ${provider}:`];
	results.forEach((result, index) => {
		lines.push("");
		lines.push(`${index + 1}. ${result.title}`);
		if (result.url) lines.push(`   ${result.url}`);
		const meta = [result.date, result.score !== undefined ? `score ${result.score.toFixed(2)}` : undefined]
			.filter(Boolean)
			.join(" · ");
		if (meta) lines.push(`   ${meta}`);
		if (result.snippet) lines.push(`   ${result.snippet}`);
		if (result.content) lines.push(`   --- content ---\n   ${result.content}`);
	});
	return lines.join("\n");
}

const errorResult = (message: string, details: Record<string, unknown> = {}) => ({
	content: [{ type: "text" as const, text: `Error: ${message}` }],
	details: { error: message, ...details },
	isError: true,
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const defaultProvider = (): ProviderChoice => loadConfig().provider ?? "auto";

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the live web and return ranked results with title, url, snippet and (optionally) page content. Providers: deepseek (supports operators like site:, -site:, lang:, after:, before:, \"exact phrase\") or exa. Use it for facts you cannot verify from the repository, for documentation of external APIs, or for anything that changed recently.",
		promptSnippet: "Search the web for information",
		promptGuidelines: [
			"Quote the URLs you used and prefer primary sources (official docs, release notes) over summaries.",
			"Search before answering questions about external APIs, versions, or anything newer than your knowledge.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"The search query (1-128 characters). Supports DeepSeek operators: site:, -site:, lang:, after:, before:, \"exact phrase\".",
			}),
			count: Type.Optional(
				Type.Number({
					description: `How many results to return (1-${MAX_COUNT}, default ${DEFAULT_COUNT}).`,
					minimum: 1,
					maximum: MAX_COUNT,
				}),
			),
			provider: Type.Optional(
				Type.String({
					description: "Search provider: auto (default), deepseek, or exa.",
					enum: ["auto", "deepseek", "exa"],
				}),
			),
			includeContent: Type.Optional(
				Type.Boolean({
					description: "Also return the page content of each result (uses more tokens). Default false.",
				}),
			),
			context: Type.Optional(
				Type.String({
					description:
						"The original question this search answers, for better query understanding (DeepSeek only, max 128 characters).",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const query = String(params.query ?? "").trim();
			if (!query) return errorResult("query is required");
			if (query.length > 128) return errorResult("query must be at most 128 characters");

			const count = Math.min(MAX_COUNT, Math.max(1, Math.floor(Number(params.count ?? DEFAULT_COUNT))));
			const includeContent = params.includeContent === true;
			const context = params.context ? String(params.context).trim() : undefined;
			const requested = (params.provider as ProviderChoice | undefined) ?? defaultProvider();

			const resolved = await resolveProvider(requested, ctx);
			if ("error" in resolved) return errorResult(resolved.error);

			try {
				const results =
					resolved.provider === "deepseek"
						? await searchDeepseek(resolved.key, query, count, includeContent, context)
						: await searchExa(resolved.key, query, count, includeContent);
				return {
					content: [{ type: "text" as const, text: formatResults(resolved.provider, results) }],
					details: { provider: resolved.provider, query, count: results.length, results },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(message, { provider: resolved.provider });
			}
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch one web page and return its content as Markdown. Use it to read a specific URL that web_search returned, or any page the user points at.",
		promptSnippet: "Fetch a web page as Markdown",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch (http/https)" }),
			provider: Type.Optional(
				Type.String({
					description: "Fetch provider: auto (default), deepseek, or exa.",
					enum: ["auto", "deepseek", "exa"],
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const url = String(params.url ?? "").trim();
			if (!url) return errorResult("url is required");
			if (!/^https?:\/\//i.test(url)) return errorResult("url must start with http:// or https://");

			const requested = (params.provider as ProviderChoice | undefined) ?? defaultProvider();
			const resolved = await resolveProvider(requested, ctx);
			if ("error" in resolved) return errorResult(resolved.error);

			try {
				const page =
					resolved.provider === "deepseek"
						? await fetchDeepseek(resolved.key, url)
						: await fetchExa(resolved.key, url);
				const text = unescapeMarkdown(page.content).trim();
				return {
					content: [
						{
							type: "text" as const,
							text: `# ${page.title}\n${url}\n\n${text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS)}\n\n(truncated)` : text}`,
						},
					],
					details: {
						provider: resolved.provider,
						url,
						title: page.title,
						length: text.length,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(message, { provider: resolved.provider, url });
			}
		},
	});

	pi.registerCommand("web-search", {
		description:
			"Web search settings. /web-search (status), /web-search provider auto|deepseek|exa, /web-search test <query>.",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const first = parts[0]?.toLowerCase();

			if (first === "provider") {
				const value = (parts[1] ?? "").toLowerCase();
				if (value !== "auto" && value !== "deepseek" && value !== "exa") {
					ctx.ui.notify("Usage: /web-search provider auto|deepseek|exa", "warning");
					return;
				}
				const config = loadConfig();
				config.provider = value;
				saveConfig(config);
				ctx.ui.notify(`Default web search provider: ${value}.`, "info");
				return;
			}

			if (first === "test") {
				const query = parts.slice(1).join(" ").trim() || "pi coding agent";
				const resolved = await resolveProvider(defaultProvider(), ctx);
				if ("error" in resolved) {
					ctx.ui.notify(resolved.error, "warning");
					return;
				}
				try {
					const results =
						resolved.provider === "deepseek"
							? await searchDeepseek(resolved.key, query, 3, false)
							: await searchExa(resolved.key, query, 3, false);
					const lines = results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}`);
					ctx.ui.notify(
						`${resolved.provider} returned ${results.length} result(s) for "${query}":\n${lines.join("\n") || "(none)"}`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(`Search failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}

			const status = await providerStatus(ctx);
			const config = loadConfig();
			ctx.ui.notify(
				`Default provider: ${config.provider ?? "auto"}\n` +
					`deepseek key: ${status.deepseek ? "found" : "missing"}\n` +
					`exa key: ${status.exa ? "found" : "missing"}\n` +
					`config: ${configPath()}`,
				"info",
			);
		},
	});
}
