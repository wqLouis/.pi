/**
 * The `/subagent` command: list/result/interrupt/scope/forget, model picking,
 * and the settings panel.
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	formatToolList,
	getMaxOpencodeSubagents,
	getMaxSubagents,
	loadConfig,
	parseToolList,
	saveConfig,
} from "./config.ts";
import { isOpencodeCliModel, isOpencodeModel, isThinkingLevel } from "./models.ts";
import {
	countRunningSubagents,
	findRecordByName,
	loadRecord,
	readTranscript,
	recordLabel,
	saveRecord,
} from "./records.ts";
import { interruptRunning, running, startBackground, stopRunning } from "./runtime.ts";
import { normalizeScope, writeScopeFile } from "./scope.ts";
import { recordFile, scopeFile, sessionFileForRecord, subagentDir } from "./state.ts";
import { showSubagentConfigUi } from "./ui/config-panel.ts";
import { initialSubagentToolUnits, listSubagentToolUnits } from "./tool-options.ts";
import { ToolUnitChecklist, toolsOfUnits } from "./tool-groups.ts";
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
	"Usage: /subagent config [maxSubagents <n|0> | maxOpencodeSubagents <n|0> | autoResume yes|no | maxAutoResumes <n> | scope <path> | allowTmp yes|no | autoPrefill yes|no | opencodeModel <id> | opencodeEffort <variant|default> | thinkingLevel <level|default> | tools <names|all|reset>] — no args opens the settings panel. A pool limit of 0 disables that pool. The backend is chosen by which spawn tool is enabled (subagent_spawn = pi, subagent_spawn_opencode = OpenCode), not by this config.";

export function registerSubagentCommand(pi: ExtensionAPI): void {
	pi.registerCommand("subagent", {
		description:
			"Manage subagents: /subagent list | view [name] | result <name> | interrupt <name> <msg> | scope <name> <path|none> | forget <name> | model [provider/id] | config (agents spawn subagents via the enabled spawn tool: subagent_spawn = pi, subagent_spawn_opencode = OpenCode)",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const first = parts[0];

			if (first === "model") {
				const cfg = loadConfig();
				const modelArg = parts[1];

				const setModel = (label: string) => {
					// An OpenCode-CLI model is that backend's model; pi models stay pi's.
					if (isOpencodeCliModel(label)) {
						cfg.opencodeModel = label;
						saveConfig(cfg);
						ctx.ui.notify(`OpenCode subagent model set to ${label}.`, "info");
						return;
					}
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
					if (!Number.isFinite(val) || val < 0) {
						ctx.ui.notify(`Usage: /subagent config ${key} <non-negative integer>`, "info");
						return;
					}
					cfg[key] = Math.floor(val);
					saveConfig(cfg);
					ctx.ui.notify(
						key === "maxAutoResumes" || cfg[key] > 0
							? `${key} set to ${cfg[key]}.`
							: `${key} set to 0 — that subagent pool is disabled.`,
						"info",
					);
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
				if (key === "autoPrefill") {
					const v = parts[2]?.toLowerCase();
					if (v !== "yes" && v !== "no") {
						ctx.ui.notify("Usage: /subagent config autoPrefill yes|no", "info");
						return;
					}
					cfg.autoPrefill = v === "yes";
					saveConfig(cfg);
					ctx.ui.notify(
						cfg.autoPrefill
							? "Auto prefill on: the files you recently read are injected into a child's first message (fewer reads in the child, one shared cached prefix per batch)."
							: "Auto prefill off: children only get the files named in prefillReads.",
						"info",
					);
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
					const units = listSubagentToolUnits(pi);
					if (!value) {
						if (ctx.mode !== "tui") {
							ctx.ui.notify(
								`Subagent tools: ${cfg.tools ?? "(inherit child defaults)"}. Use /subagent config tools <names|all|reset>.`,
								"info",
							);
							return;
						}
						await ctx.ui.custom<void>((_tui, theme, _kb, done) =>
							new ToolUnitChecklist({
								title: "Subagent tools",
								theme,
								units,
								selected: initialSubagentToolUnits(pi, cfg.tools, units),
								onDone: (picked) => {
									if (picked !== undefined) {
										cfg.tools = formatToolList(toolsOfUnits(units, picked));
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
					if (["reset", "default", "clear"].includes(value.toLowerCase())) {
						cfg.tools = undefined;
						saveConfig(cfg);
						ctx.ui.notify("Subagent tools reset to child defaults.", "info");
						return;
					}
					const preset = value.toLowerCase();
					const known = new Set(units.flatMap((unit) => unit.tools));
					let names: string[];
					if (preset === "all") {
						names = units.flatMap((unit) => unit.tools);
					} else {
						const wanted = parseToolList(value).map((name) => name.toLowerCase());
						const matches = (part: string, unit: (typeof units)[number]) =>
							unit.label.toLowerCase() === part ||
							unit.id.toLowerCase() === part ||
							unit.tools.some((tool) => tool.toLowerCase() === part);
						const matched = units.filter((unit) => wanted.some((part) => matches(part, unit)));
						const unknown = wanted.filter((part) => !units.some((unit) => matches(part, unit)));
						if (unknown.length > 0) {
							ctx.ui.notify(`Unknown tools or extensions: ${unknown.join(", ")}`, "warning");
							return;
						}
						names = toolsOfUnits(matched, matched.map((unit) => unit.id));
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
				// Interrupt first, delete afterwards: the subagent is stopped cleanly
				// and no error notification bubbles up to the main agent.
				await stopRunning(rec);
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
