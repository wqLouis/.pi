/**
 * Model identity helpers: backend inference, registry lookups, and the
 * thinking levels a model supports (for the settings panel).
 */

import { getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentBackend, SubagentRecord } from "./types.ts";

/** All thinking levels pi understands, in ascending order. */
export const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Short descriptions mirroring pi's built-in thinking selector. */
export const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (ALL_THINKING_LEVELS as readonly string[]).includes(value);
}

/** Any model in the OpenCode CLI's namespace (free models and OpenCode Go). */
export function isOpencodeModel(model: string | undefined | null): boolean {
	return !!model && /^opencode(-go)?\//.test(model);
}

/** Models that belong to the OpenCode CLI's own `opencode/` namespace. */
export function isOpencodeCliModel(model: string | undefined | null): boolean {
	return !!model && /^opencode\//.test(model);
}

/**
 * True when pi has its own provider entry for a model. This keeps models from
 * pi's `opencode-go` provider (a paid subscription) on the pi backend instead of
 * routing them through the OpenCode CLI.
 */
export function modelKnownToPi(ctx: ExtensionContext | undefined, model: string | undefined): boolean {
	if (!model || !model.includes("/")) return false;
	try {
		const [provider, ...rest] = model.split("/");
		return !!ctx?.modelRegistry?.find(provider, rest.join("/"));
	} catch {
		return false;
	}
}

/** The runtime a record uses, inferring it from the model for records written before backends existed. */
export function backendOf(rec: Pick<SubagentRecord, "backend" | "model">): SubagentBackend {
	if (rec.backend) return rec.backend;
	return isOpencodeCliModel(rec.model) ? "opencode" : "pi";
}

/** Split `provider/id` into its parts (id may itself contain slashes). */
export function splitModelLabel(label: string | undefined): { provider: string; id: string } | undefined {
	if (!label || !label.includes("/")) return undefined;
	const [provider, ...rest] = label.split("/");
	const id = rest.join("/");
	return provider && id ? { provider, id } : undefined;
}

/** Resolve a `provider/id` label against pi's model registry. */
export function resolveRegisteredModel(ctx: ExtensionContext, label: string | undefined): Model<any> | undefined {
	const parts = splitModelLabel(label);
	if (!parts) return undefined;
	try {
		return ctx.modelRegistry.find(parts.provider, parts.id);
	} catch {
		return undefined;
	}
}

/**
 * Thinking levels the given model supports. Falls back to every level when the
 * model cannot be resolved (e.g. opencode-only models or offline catalogs).
 */
export function supportedThinkingLevels(ctx: ExtensionContext, label: string | undefined): ModelThinkingLevel[] {
	const model = resolveRegisteredModel(ctx, label);
	if (!model) return [...ALL_THINKING_LEVELS];
	try {
		const levels = getSupportedThinkingLevels(model);
		return levels.length > 0 ? levels : [...ALL_THINKING_LEVELS];
	} catch {
		return [...ALL_THINKING_LEVELS];
	}
}
