/**
 * The `/subagent` command: list/result/interrupt/scope/forget, model picking,
 * and the settings panel.
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_OPENCODE_MODEL } from "./constants.ts";
import {
	formatToolList,
	getMaxOpencodeSubagents,
	getMaxSubagents,
	loadConfig,
	parseToolList,
	saveConfig,
} from "./config.ts";
import { isOpencodeModel, isThinkingLevel } from "./models.ts";
import {
	countRunningSubagents,
	findRecordByName,
	isPidAlive,
	loadRecord,
	readTranscript,
	recordLabel,
	saveRecord,
	waitForPidExit,
} from "./records.ts";
import { interruptRunning, running, startBackground } from "./runtime.ts";
import { normalizeScope, writeScopeFile } from "./scope.ts";
import { recordFile, scopeFile, sessionFileForRecord, subagentDir } from "./state.ts";
import { showSubagentConfigUi } from "./ui/config-panel.ts";
import { ToolChecklistComponent } from "./ui/tool-picker.ts";
import { initialSubagentToolSelection, listSubagentTools } from "./tool-options.ts";
import { showModelPicker } from "./ui/model-selector.ts";
import { showSubagentView } from "./ui/subagent-view.ts";
import type { SubagentRecord } from "./types.ts";
import { firstLine } from "./usage.ts";

function findExactModel(ctx: ExtensionCommandContext, arg: string): string | undefined {
	const q = arg.trim().toLowerCase();
	// OpenCode model ids are not in pi's registry, so accept them verbatim.
	if (isOpencodeModel(q)) return arg.trim();
	try {
		for (const m of ctx.modelRegistry.getAll()) {
			if (`${m.provider}/${m.id}`.toLowerCase() === q) return `${m.provider}/${m.id}`;
		}
	} catch {
		// Registry unavailable: no exact match.
	}
	return undefined;
}

function sessionModelLabel(ctx: ExtensionCommandContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function listAllRecords(): SubagentRecord[] {
	const records: SubagentRecord[] = [];
	try {
		for (const file of fs.readdirSync(subagentDir())) {
			if (!file.endsWith(".json")) continue;
			const rec = loadRecord(file.slice(0, -5));
			if (rec) records.push(rec);
		}
	} catch {
		// No subagent dir yet.
	}
	records.sort((a, b) => b.createdAt - a.createdAt);
	return records;
}

const CONFIG_USAGE =
	"Usage: /subagent config [maxSubagents <n> | maxOpencodeSubagents <n> | autoResume yes|no | maxAutoResumes <n> | scope <path> | allowTmp yes|no | backend pi|opencode|auto | opencodeModel <id> | opencodeEffort <variant|default> | thinkingLevel <level|default> | tools <names|all|core|readonly|reset>] — no args opens the settings panel.";

export function registerSubagentCommand(pi: ExtensionAPI): void {
	pi.registerCommand("subagent", {
		description:
			"Manage subagents: /subagent list | view [name] | result <name> | interrupt <name> <msg> | scope <name> <path|none> | forget <name> | model [provider/id] | config (agents spawn subagents via the subagent_spawn tool)",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const first = parts[0];

			if (first === "model") {
				const cfg = loadConfig();
				const modelArg = parts[1];

				const setModel = (label: string) => {
					cfg.model = label;
					saveConfig(cfg);
					ctx.ui.notify(`Subagent model set to ${label}.`, "info");
				};

				if (modelArg) {
					const exact = findExactModel(ctx, modelArg);
					if (exact) {
						setModel(exact);
						return;
					}
					const picked = await showModelPicker(ctx, modelArg, cfg.model ?? sessionModelLabel(ctx));
					if (picked) setModel(picked);
					else ctx.ui.notify("Model selection cancelled.", "info");
					return;
				}

				const picked = await showModelPicker(ctx, "", cfg.model ?? sessionModelLabel(ctx));
				if (picked) setModel(picked);
				else ctx.ui.notify("Model selection cancelled.", "info");
				return;
			}

			if (first === "config") {
				const cfg = loadConfig();
				const key = parts[1];
				if (key === "maxSubagents" || key === "maxOpencodeSubagents" || key === "maxAutoResumes") {
					const val = Number(parts[2]);
					const min = key === "maxAutoResumes" ? 0 : 1;
					if (!Number.isFinite(val) || val < min) {
						ctx.ui.notify(`Usage: /subagent config ${key} <${min === 0 ? "non-negative" : "positive"} integer>`, "info");
						return;
					}
					cfg[key] = Math.floor(val);
					saveConfig(cfg);
					ctx.ui.notify(`${key} set to ${cfg[key]}.`, "info");
					return;
				}
				if (key === "scope") {
					const v = parts.slice(2).join(" ").trim();
					cfg.scope = v
						? v.includes(",")
							? v.split(",").map((x) => x.trim()).filter(Boolean)
							: v
						: undefined;
					saveConfig(cfg);
					ctx.ui.notify(v ? `Default edit scope set to: ${v}` : "Default edit scope cleared (full access).", "info");
					return;
				}
				if (key === "allowTmp" || key === "autoResume") {
					const v = parts[2]?.toLowerCase();
					if (v !== "yes" && v !== "no") {
						ctx.ui.notify(`Usage: /subagent config ${key} yes|no`, "info");
						return;
					}
					cfg[key] = v === "yes";
					saveConfig(cfg);
					ctx.ui.notify(`${key} set to ${cfg[key] ? "yes" : "no"}.`, "info");
					return;
				}
				if (key === "backend") {
					const v = parts[2]?.toLowerCase();
					if (v !== "pi" && v !== "opencode" && v !== "auto") {
						ctx.ui.notify("Usage: /subagent config backend pi|opencode|auto", "info");
						return;
					}
					cfg.backend = v === "auto" ? undefined : v;
					saveConfig(cfg);
					ctx.ui.notify(
						v === "auto"
							? "Subagent backend set to auto (inferred from the model)."
							: v === "opencode"
								? `Subagent backend set to opencode (model: ${cfg.opencodeModel ?? DEFAULT_OPENCODE_MODEL}). Needs the opencode CLI on PATH.`
								: "Subagent backend set to pi.",
						"info",
					);
					return;
				}
				if (key === "opencodeModel") {
					const v = parts.slice(2).join(" ").trim();
					if (!v) {
						ctx.ui.notify("Usage: /subagent config opencodeModel <opencode/provider-model>", "info");
						return;
					}
					cfg.opencodeModel = v;
					saveConfig(cfg);
					ctx.ui.notify(`OpenCode model set to ${v}.`, "info");
					return;
				}
				if (key === "opencodeEffort") {
					const v = parts.slice(2).join(" ").trim();
					if (!v) {
						ctx.ui.notify("Usage: /subagent config opencodeEffort <variant|default>", "info");
						return;
					}
					cfg.opencodeEffort = v === "default" ? undefined : v;
					saveConfig(cfg);
					ctx.ui.notify(v === "default" ? "OpenCode effort reset to the model default." : `OpenCode effort set to ${v}.`, "info");
					return;
				}
				if (key === "thinkingLevel") {
					const v = parts[2]?.toLowerCase();
					if (v === "default") {
						cfg.thinkingLevel = undefined;
						saveConfig(cfg);
						ctx.ui.notify("Thinking level reset to the model default.", "info");
						return;
					}
					if (!isThinkingLevel(v)) {
						ctx.ui.notify("Usage: /subagent config thinkingLevel off|minimal|low|medium|high|xhigh|max|default", "info");
						return;
					}
					cfg.thinkingLevel = v;
					saveConfig(cfg);
					ctx.ui.notify(`Thinking level set to ${v}.`, "info");
					return;
				}
				if (key === "tools") {
					const value = parts.slice(2).join(" ").trim();
					const tools = listSubagentTools(pi);
					if (!value) {
						if (ctx.mode !== "tui") {
							ctx.ui.notify(
								`Subagent tools: ${cfg.tools ?? "(inherit child defaults)"}. Use /subagent config tools <names|all|core|readonly|reset>.`,
								"info",
							);
							return;
						}
						await ctx.ui.custom<void>((_tui, theme, _kb, done) =>
							new ToolChecklistComponent({
								title: "Subagent tools",
								theme,
								tools,
								selected: initialSubagentToolSelection(pi, cfg.tools, tools),
								onDone: (picked) => {
									if (picked !== undefined) {
										cfg.tools = formatToolList(picked);
										saveConfig(cfg);
										ctx.ui.notify(
											cfg.tools
												? `Subagent tools set to: ${cfg.tools}.`
												: "Subagent tools reset to child defaults.",
											"info",
										);
									}
									done(undefined);
								},
							}),
						);
						return;
					}
					if (["reset", "default", "clear", "none"].includes(value.toLowerCase())) {
						cfg.tools = undefined;
						saveConfig(cfg);
						ctx.ui.notify("Subagent tools reset to child defaults.", "info");
						return;
					}
					const preset = value.toLowerCase();
					const names =
						preset === "all"
							? tools.map((tool) => tool.name)
							: preset === "core"
								? ["read", "bash", "edit", "write", "codemode"]
								: preset === "readonly"
									? ["read", "grep", "find", "ls"]
									: parseToolList(value);
					const known = new Set(tools.map((tool) => tool.name));
					const isPreset = preset === "all" || preset === "core" || preset === "readonly";
					const unknown = isPreset ? [] : names.filter((name) => !known.has(name));
					if (unknown.length > 0) {
						ctx.ui.notify(`Unknown or non-declarable tools: ${unknown.join(", ")}`, "warning");
						return;
					}
					cfg.tools = formatToolList(names.filter((name) => known.has(name)));
					saveConfig(cfg);
					ctx.ui.notify(
						cfg.tools ? `Subagent tools set to: ${cfg.tools}.` : "Subagent tools reset to child defaults.",
						"info",
					);
					return;
				}
				if (key) {
					ctx.ui.notify(CONFIG_USAGE, "info");
					return;
				}
				await showSubagentConfigUi(pi, ctx);
				return;
			}

			if (first === "view") {
				await showSubagentView(ctx, parts[1]);
				return;
			}

			if (first === "list") {
				const records = listAllRecords();
				const lines = records.map(
					(rec) =>
						`${recordLabel(rec)} [${rec.status}] · ${rec.model ?? "session"} · ${firstLine(rec.lastOutput).slice(0, 80) || "(no output)"}`,
				);
				ctx.ui.notify(lines.length ? lines.join("\n") : "No subagents spawned yet.", "info");
				return;
			}

			if (first === "result" || first === "forget") {
				const name = parts[1];
				if (!name) {
					ctx.ui.notify(`Usage: /subagent ${first} <name>`, "info");
					return;
				}
				if (first === "result") {
					const rec = findRecordByName(name);
					if (!rec) {
						ctx.ui.notify(`Unknown subagent "${name}".`, "error");
						return;
					}
					const transcript = readTranscript(rec.id) || rec.lastOutput || "(no transcript available)";
					ctx.ui.notify(transcript.slice(0, 600), "info");
					return;
				}
				const rec = findRecordByName(name);
				if (!rec) {
					ctx.ui.notify(`Unknown subagent "${name}".`, "error");
					return;
				}
				const entry = running.get(rec.id);
				if (entry) {
					entry.interrupted = true;
					entry.rec.suspended = true;
					try {
						entry.proc.kill("SIGTERM");
					} catch {
						// Already gone.
					}
					running.delete(rec.id);
				} else if (isPidAlive(rec.pid)) {
					rec.suspended = true;
					saveRecord(rec);
					await waitForPidExit(rec.pid, 1500);
					rec.suspended = false;
					rec.pid = undefined;
				}
				for (const file of [recordFile(rec.id), sessionFileForRecord(rec), scopeFile(rec.id)]) {
					try {
						fs.unlinkSync(file);
					} catch {
						// Already gone.
					}
				}
				ctx.ui.notify(`Forgot subagent ${recordLabel(rec)}.`, "info");
				return;
			}

			if (first === "scope") {
				const name = parts[1];
				const value = parts.slice(2).join(" ").trim();
				if (!name) {
					ctx.ui.notify("Usage: /subagent scope <name> <path[,path...]|none>", "info");
					return;
				}
				const rec = findRecordByName(name);
				if (!rec) {
					ctx.ui.notify(`Unknown subagent "${name}".`, "error");
					return;
				}
				if (!value || value === "none") {
					rec.scope = undefined;
				} else {
					const scope = value.includes(",") ? value.split(",").map((x) => x.trim()).filter(Boolean) : value;
					rec.scope = normalizeScope(rec.cwd, scope);
				}
				saveRecord(rec);
				writeScopeFile(rec);
				const scopeText = rec.scope && rec.scope.length > 0 ? rec.scope.join(", ") : "(none — unrestricted)";
				ctx.ui.notify(`Edit scope for ${recordLabel(rec)}: ${scopeText}`, "info");
				return;
			}

			if (first === "interrupt") {
				const name = parts[1];
				const message = parts.slice(2).join(" ").trim();
				if (!name || !message) {
					ctx.ui.notify("Usage: /subagent interrupt <name> <message>", "info");
					return;
				}
				const rec = findRecordByName(name);
				if (!rec) {
					ctx.ui.notify(`Unknown subagent "${name}".`, "error");
					return;
				}
				const emergencyText = `[emergency] ${message}`;
				const outcome = await interruptRunning(rec, emergencyText);
				rec.donePushedAt = undefined;
				saveRecord(rec);
				if (outcome !== "aborted") {
					const started = await startBackground(pi, ctx, rec, emergencyText);
					if (!started.started) {
						ctx.ui.notify(started.error ?? "Failed to start subagent.", "error");
						return;
					}
				}
				ctx.ui.notify(
					outcome === "aborted"
						? `Interrupted ${recordLabel(rec)} with pi's abort and pushed your message into the same session.`
						: outcome === "restarted"
							? `Interrupted ${recordLabel(rec)} (hard restart) and pushed your message immediately.`
							: `Subagent ${recordLabel(rec)} was idle; pushed the message as a new turn.`,
					"info",
				);
				return;
			}

			if (first === "status") {
				const records = listAllRecords();
				ctx.ui.notify(
					`Running — pi: ${countRunningSubagents("pi")}/${getMaxSubagents()} · opencode: ${countRunningSubagents("opencode")}/${getMaxOpencodeSubagents()} (independent pools) · total: ${records.length}`,
					"info",
				);
				return;
			}

			ctx.ui.notify(
				"Usage: /subagent list | view [name] | result <name> | interrupt <name> <msg> | scope <name> <path|none> | forget <name> | model [provider/id] | config",
				"info",
			);
		},
	});
}
