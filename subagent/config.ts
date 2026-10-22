/**
 * Subagent configuration: persistence in `~/.pi/agent/subagent-config.json`
 * and the spawn-option resolution that applies it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_AUTO_RESUMES,
	DEFAULT_MAX_OPENCODE_SUBAGENTS,
	DEFAULT_MAX_SUBAGENTS,
	DEFAULT_OPENCODE_MODEL,
	DEFAULT_SUBAGENT_PROMPT,
	OPENCODE_DEFAULT_EFFORT,
} from "./constants.ts";
import { isThinkingLevel, isOpencodeCliModel, isOpencodeModel, modelKnownToPi } from "./models.ts";
import type { SubagentBackend, SubagentConfig } from "./types.ts";

/** Parse the comma/space-separated tools setting into a list of names or modifiers. */
export function parseToolList(value?: string): string[] {
	if (!value) return [];
	return [...new Set(value.split(/[,\s]+/).map((name) => name.trim()).filter(Boolean))];
}

/** Store a tool selection as the comma-separated form `--tools` accepts. Empty means inherit defaults. */
export function formatToolList(names: string[]): string | undefined {
	const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
	return unique.length > 0 ? unique.join(",") : undefined;
}

export function configFile(): string {
	return path.join(getAgentDir(), "subagent-config.json");
}

export function loadConfig(): SubagentConfig {
	try {
		const raw = fs.readFileSync(configFile(), "utf-8");
		const cfg = JSON.parse(raw) as SubagentConfig;
		if (cfg && typeof cfg === "object") return cfg;
	} catch {
		// Missing/invalid config: use built-in defaults.
	}
	return {};
}

export function saveConfig(cfg: SubagentConfig): void {
	fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function getMaxSubagents(): number {
	const cfg = loadConfig();
	if (typeof cfg.maxSubagents === "number" && Number.isFinite(cfg.maxSubagents) && cfg.maxSubagents >= 1)
		return Math.floor(cfg.maxSubagents);
	const env = Number(process.env.PI_SUBAGENT_MAX_SUBAGENTS);
	if (Number.isFinite(env) && env >= 1) return Math.floor(env);
	return DEFAULT_MAX_SUBAGENTS;
}

/**
 * Concurrent opencode-backed subagents allowed. This is an independent pool:
 * the pi backend is governed by maxSubagents, the opencode backend by this
 * limit, so both can run up to their own maximum at the same time.
 */
export function getMaxOpencodeSubagents(): number {
	const cfg = loadConfig();
	if (
		typeof cfg.maxOpencodeSubagents === "number" &&
		Number.isFinite(cfg.maxOpencodeSubagents) &&
		cfg.maxOpencodeSubagents >= 1
	)
		return Math.floor(cfg.maxOpencodeSubagents);
	const env = Number(process.env.PI_SUBAGENT_MAX_OPENCODE_SUBAGENTS);
	if (Number.isFinite(env) && env >= 1) return Math.floor(env);
	return DEFAULT_MAX_OPENCODE_SUBAGENTS;
}

/** The concurrency limit governing a backend's pool. */
export function maxForBackend(backend: SubagentBackend): number {
	return backend === "opencode" ? getMaxOpencodeSubagents() : getMaxSubagents();
}

export function getAutoResume(): boolean {
	return loadConfig().autoResume !== false;
}

export function getMaxAutoResumes(): number {
	const cfg = loadConfig();
	if (typeof cfg.maxAutoResumes === "number" && Number.isFinite(cfg.maxAutoResumes) && cfg.maxAutoResumes >= 0)
		return Math.floor(cfg.maxAutoResumes);
	return DEFAULT_MAX_AUTO_RESUMES;
}

export interface SpawnOptionsInput {
	/** Per-spawn runtime override; everything else comes from the user's config. */
	backend?: SubagentBackend;
}

export interface ResolvedSpawnOptions {
	model?: string;
	backend: SubagentBackend;
	systemPrompt: string;
	cwd: string;
	tools?: string;
	/** Thinking level for pi-backed subagents. */
	thinkingLevel?: ThinkingLevel;
	/** OpenCode effort/variant for opencode-backed subagents. */
	opencodeEffort?: string;
}

/**
 * Resolve the user's configuration into spawn options. The spawn tool may only
 * choose the backend (`params.backend`); models, thinking levels, efforts,
 * system prompt, cwd, and tools are all user configuration.
 */
export function resolveSpawnOptions(ctx: ExtensionContext, params: SpawnOptionsInput = {}): ResolvedSpawnOptions {
	const cfg = loadConfig();
	const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const systemPrompt = (cfg.systemPrompt ?? "").trim();
	// A model means the OpenCode CLI backend only when it lives in the opencode/
	// namespace *and* pi has no provider entry for it (opencode-go/... is pi's own).
	const opencodeCliModel = (m?: string) => isOpencodeCliModel(m) && !modelKnownToPi(ctx, m);

	// Precedence: an explicit backend param wins; otherwise the configured backend;
	// otherwise an opencode/-namespaced config model selects the opencode backend.
	const backend: SubagentBackend = params.backend ?? cfg.backend ?? (opencodeCliModel(cfg.model) ? "opencode" : "pi");
	const model =
		backend === "opencode"
			? isOpencodeModel(cfg.model)
				? cfg.model
				: (cfg.opencodeModel ?? DEFAULT_OPENCODE_MODEL)
			: (cfg.model ?? sessionModel);

	return {
		model,
		backend,
		systemPrompt: systemPrompt || DEFAULT_SUBAGENT_PROMPT,
		cwd: cfg.cwd ?? ctx.cwd,
		tools: cfg.tools,
		thinkingLevel: isThinkingLevel(cfg.thinkingLevel) ? cfg.thinkingLevel : undefined,
		opencodeEffort:
			cfg.opencodeEffort && cfg.opencodeEffort !== OPENCODE_DEFAULT_EFFORT ? cfg.opencodeEffort : undefined,
	};
}
