import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PROVIDER_ID = "command-code";
const PROVIDER_NAME = "Command Code";
const BASE_URL = "https://api.commandcode.ai/provider/v1";
const MODELS_URL = `${BASE_URL}/models`;
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_MAX_TOKENS = 32_000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const FETCH_TIMEOUT_MS = 15_000;

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

// The credential lives in ~/.pi/agent/auth.json (written by /login or the
// command-code key setup), falling back to the CMD_API_KEY env var.
function resolveApiKey(): string | undefined {
	if (environment.CMD_API_KEY) return environment.CMD_API_KEY;
	try {
		const home = environment.HOME ?? os.homedir();
		const authPath = path.join(home, ".pi", "agent", "auth.json");
		const auth = JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<string, { type?: string; key?: string }>;
		const entry = auth[PROVIDER_ID];
		if (entry?.type === "api_key" && entry.key) return entry.key;
	} catch {
		// no auth file yet — provider will be unconfigured until /login
	}
	return undefined;
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

export default async function (pi: ExtensionAPI): Promise<void> {
	// Fetch the live catalog during load so models are available synchronously
	// (subagent CLI runs resolve models before any async catalog refresh).
	let models: ProviderModelConfig[] = [];
	const apiKey = resolveApiKey();
	if (apiKey) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			models = await fetchCatalog(controller.signal, apiKey);
		} catch {
			// offline / no key — register empty; refreshModels will retry later
		} finally {
			clearTimeout(timer);
		}
	}

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		apiKey: "placeholder",
		authHeader: true,
		api: "openai-completions",
		models,
		async refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[] | undefined> {
			// IMPORTANT: return undefined (not []) when there is nothing new — the
			// composer only replaces the synchronous model list when this returns a
			// truthy array; returning [] would wipe the models registered at load.
			if (!context.allowNetwork) return undefined;
			// Stored credential (from /login or auth.json) wins; CMD_API_KEY is the fallback.
			const key = context.credential?.type === "api_key" ? context.credential.key : environment.CMD_API_KEY;
			if (!key) return undefined;
			return fetchCatalog(context.signal, key);
		},
		headers: environment.CMD_ZDR === "1" ? { "x-cmd-zdr": "1" } : undefined,
	});
}
