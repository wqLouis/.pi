import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "command-code";
const PROVIDER_NAME = "Command Code";
const BASE_URL = "https://api.commandcode.ai/provider/v1";
const MODELS_URL = `${BASE_URL}/models`;
const API_KEY = "$CMD_API_KEY";
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_MAX_TOKENS = 32_000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const environment = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

interface CommandCodeModel {
	id: string;
	name?: string;
	context_window?: number;
	context_length?: number;
	max_tokens?: number;
	max_output_tokens?: number;
	capabilities?: {
		text?: boolean;
		vision?: boolean;
		reasoning?: boolean;
	};
}

interface ModelsResponse {
	data?: CommandCodeModel[];
}

function isAnthropicModel(id: string): boolean {
	return /^(?:anthropic\/)?claude(?:[-/]|$)/i.test(id);
}

function fromCatalog(entry: CommandCodeModel): ProviderModelConfig {
	const anthropic = isAnthropicModel(entry.id);
	const capabilities = entry.capabilities;
	return {
		id: entry.id,
		name: entry.name ?? entry.id,
		api: anthropic ? "anthropic-messages" : "openai-completions",
		reasoning: capabilities?.reasoning ?? !/haiku/i.test(entry.id),
		input: capabilities?.vision ? ["text", "image"] : ["text"],
		cost: ZERO_COST,
		contextWindow: entry.context_window ?? entry.context_length ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: entry.max_tokens ?? entry.max_output_tokens ?? DEFAULT_MAX_TOKENS,
	};
}

async function fetchCatalog(signal: AbortSignal, apiKey: string): Promise<ProviderModelConfig[]> {
	const response = await fetch(MODELS_URL, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal,
	});
	if (!response.ok) {
		throw new Error(`Command Code model catalog failed (${response.status} ${response.statusText})`);
	}

	const payload = (await response.json()) as ModelsResponse;
	if (!Array.isArray(payload.data)) throw new Error("Command Code model catalog returned an invalid response");
	return payload.data.filter((entry) => typeof entry?.id === "string").map(fromCatalog);
}

async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
	// pi already restores the persisted catalog (if any) into the synchronous model
	// list before invoking this; we only need the live list when network is allowed.
	if (!context.allowNetwork) return [];

	// Stored credential (from /login or auth.json) wins; CMD_API_KEY is the fallback.
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : environment.CMD_API_KEY;
	if (!apiKey) return [];

	return fetchCatalog(context.signal, apiKey);
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		apiKey: API_KEY,
		authHeader: true,
		api: "openai-completions",
		models: [],
		refreshModels,
		headers: environment.CMD_ZDR === "1" ? { "x-cmd-zdr": "1" } : undefined,
	});
}
