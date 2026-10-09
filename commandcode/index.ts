/**
 * Command Code provider extension for pi.
 *
 * Connects pi to Command Code's Provider API (https://commandcode.ai/docs/provider),
 * which exposes the same models as the Command Code coding agent through standard
 * OpenAI- and Anthropic-compatible endpoints:
 *
 *   - Claude models answer on `POST /provider/v1/messages` (Anthropic Messages).
 *   - Every other model answers on `POST /provider/v1/chat/completions`
 *     (OpenAI Chat Completions), and most of them on `/provider/v1/responses` too.
 *   - `GET /provider/v1/models` lists the live catalog.
 *
 * Because the wire protocols match, all request conversion, tool handling, usage
 * accounting and cancellation are delegated to pi-ai's built-in `anthropic-messages`
 * and `openai-completions` implementations. This extension only supplies the
 * endpoint, authentication, and per-model metadata.
 *
 * Authentication uses a Command Code API key (`COMMAND_CODE_API_KEY`), created in
 * Command Code Studio: https://commandcode.ai
 *
 * Usage:
 *   export COMMAND_CODE_API_KEY=cmd_...
 *   # or run /login and pick "Command Code", then /model commandcode/<id>
 */

import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	COMMANDCODE_ANTHROPIC_COMPAT,
	COMMANDCODE_MODELS,
	COMMANDCODE_OPENAI_COMPAT,
	COMMANDCODE_PROVIDER_BASE,
	COMMANDCODE_V1_BASE,
	type CommandCodeModel,
} from "./models.ts";

const PROVIDER_ID = "commandcode";
const PROVIDER_NAME = "Command Code";
const API_KEY_ENV = "COMMAND_CODE_API_KEY";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A model entry as returned by `GET /provider/v1/models`. */
interface LiveModel {
	id: string;
	name?: string;
	context_length?: number;
	supported_endpoints?: string[];
}

const KNOWN_MODELS = new Map<string, CommandCodeModel>(COMMANDCODE_MODELS.map((model) => [model.id, model]));

/** Pick the wire protocol from the routes the model is served on. */
function apiFor(model: LiveModel): CommandCodeModel["api"] {
	return model.supported_endpoints?.includes("/messages") ? "anthropic-messages" : "openai-completions";
}

/** The Anthropic SDK appends `/v1/messages`; the OpenAI SDK appends `/chat/completions`. */
function baseUrlFor(api: CommandCodeModel["api"]): string {
	return api === "anthropic-messages" ? COMMANDCODE_PROVIDER_BASE : COMMANDCODE_V1_BASE;
}

/**
 * Claude models served by Command Code require Anthropic adaptive thinking
 * (`thinking.type: "adaptive"` + `output_config.effort`); the legacy
 * budget-based `thinking.type: "enabled"` is rejected upstream. Every other
 * model uses OpenAI-style `reasoning_effort`.
 */
function compatFor(api: CommandCodeModel["api"]): CommandCodeModel["compat"] {
	return api === "anthropic-messages" ? COMMANDCODE_ANTHROPIC_COMPAT : COMMANDCODE_OPENAI_COMPAT;
}

/**
 * Project a live catalog entry onto a pi model config. Known models keep the
 * richer bundled metadata (pricing, modalities, reasoning levels); newly
 * discovered models get conservative defaults.
 */
function modelFromLive(model: LiveModel): ProviderModelConfig {
	const api = apiFor(model);
	const known = KNOWN_MODELS.get(model.id);
	if (known) {
		return {
			...known,
			api,
			baseUrl: baseUrlFor(api),
			name: model.name ?? known.name,
			contextWindow: model.context_length ?? known.contextWindow,
			compat: compatFor(api),
		};
	}
	return {
		id: model.id,
		name: model.name ?? model.id,
		api,
		baseUrl: baseUrlFor(api),
		reasoning: api === "anthropic-messages",
		input: api === "anthropic-messages" ? ["text", "image"] : ["text"],
		cost: { ...ZERO_COST },
		contextWindow: model.context_length ?? 128000,
		maxTokens: api === "anthropic-messages" ? 64000 : 32000,
		compat: compatFor(api),
	};
}

/** Fetch and normalize the live `/provider/v1/models` catalog. */
async function fetchLiveModels(signal: AbortSignal): Promise<ProviderModelConfig[]> {
	const response = await fetch(`${COMMANDCODE_V1_BASE}/models`, {
		headers: { accept: "application/json" },
		signal,
	});
	if (!response.ok) {
		throw new Error(`Command Code model list failed: HTTP ${response.status} ${response.statusText}`);
	}
	const payload = (await response.json()) as { data?: LiveModel[] };
	const models = Array.isArray(payload.data) ? payload.data : [];
	if (models.length === 0) {
		throw new Error("Command Code model list was empty");
	}
	return models.map(modelFromLive);
}

export default function commandCodeProvider(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: COMMANDCODE_V1_BASE,
		api: "openai-completions",
		apiKey: `$${API_KEY_ENV}`,
		models: COMMANDCODE_MODELS,
		async refreshModels(context) {
			if (!context.allowNetwork) {
				// Offline: fall back to the bundled catalog snapshot.
				return COMMANDCODE_MODELS;
			}
			try {
				return await fetchLiveModels(context.signal);
			} catch {
				// Keep the last known catalog when the network or upstream fails.
				return COMMANDCODE_MODELS;
			}
		},
	} satisfies ProviderConfig);
}
