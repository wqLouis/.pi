/**
 * The opencode backend: spawn a subagent as an `opencode acp` process and drive
 * it over the Agent Client Protocol (newline-delimited JSON-RPC on stdio).
 *
 * This is how pi can use OpenCode's models — including its free models that are
 * rejected when called directly — because the model request originates inside
 * the opencode process. opencode runs its own agent loop and tools; pi receives
 * the final assistant text.
 *
 * This module also exposes the ACP probe used by the settings panel to list
 * opencode models and their thinking-effort (thought_level) variants.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { KILL_GRACE_MS, OPENCODE_BIN, OPENCODE_DEFAULT_EFFORT, OPENCODE_PROBE_TIMEOUT_MS } from "../constants.ts";
import { buildOpencodeFirstPrompt } from "../prompts.ts";
import { saveRecord } from "../records.ts";
import type { RpcControl, RunResult, SubagentRecord } from "../types.ts";
import { EMPTY_USAGE, sleep } from "../usage.ts";
import type { SpawnedProcess } from "./pi.ts";

/** A selectable opencode config value (model or effort variant). */
export interface OpencodeOption {
	value: string;
	name: string;
	description?: string;
}

/** Effort variants that mean "leave the model default alone". */
export { OPENCODE_DEFAULT_EFFORT };

// ---------------------------------------------------------------------------
// ACP probing (model catalog + effort variants), with per-process caches.
// ---------------------------------------------------------------------------

interface AcpProbeResult {
	models: OpencodeOption[];
	efforts: OpencodeOption[];
}

function parseOptions(raw: unknown): OpencodeOption[] {
	if (!Array.isArray(raw)) return [];
	const out: OpencodeOption[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const o = item as { value?: unknown; name?: unknown; description?: unknown };
		if (typeof o.value !== "string" || !o.value) continue;
		out.push({
			value: o.value,
			name: typeof o.name === "string" && o.name ? o.name : o.value,
			description: typeof o.description === "string" ? o.description : undefined,
		});
	}
	return out;
}

function pickConfigOption(configOptions: unknown, category: string, ids: string[]): any | undefined {
	if (!Array.isArray(configOptions)) return undefined;
	return configOptions.find(
		(o: any) => o && typeof o === "object" && (o.category === category || (typeof o.id === "string" && ids.includes(o.id))),
	);
}

/**
 * Run a short-lived `opencode acp` session to discover its configuration:
 * the model catalog from `session/new`, and — when `model` is given — the
 * effort variants that model supports, using the `model` config option's
 * response. Returns undefined on any failure (missing CLI, timeout, protocol
 * error); callers fall back to the CLI model list.
 */
async function acpProbe(model?: string, timeoutMs: number = OPENCODE_PROBE_TIMEOUT_MS): Promise<AcpProbeResult | undefined> {
	let proc: ChildProcess | undefined;
	let stdout = "";
	let seq = 0;
	const pending = new Map<string, (message: any) => void>();
	let timer: ReturnType<typeof setTimeout> | undefined;

	const stop = () => {
		try {
			proc?.stdin?.end();
		} catch {
			// Already closed.
		}
		try {
			proc?.kill("SIGTERM");
		} catch {
			// Already gone.
		}
	};

	try {
		proc = spawn(OPENCODE_BIN, ["acp"], {
			cwd: process.cwd(),
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});
		proc.on("error", () => {
			// Surfaced as a rejected request below.
		});
		proc.stderr?.on("data", () => {
			// opencode logs to stderr; irrelevant to probing.
		});
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
			const lines = stdout.split("\n");
			stdout = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let message: any;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.id === undefined) continue;
				const resolve = pending.get(message.id);
				if (resolve) {
					pending.delete(message.id);
					resolve(message);
				}
			}
		});

		const request = (method: string, params: Record<string, unknown>): Promise<any> => {
			const id = `probe-${++seq}`;
			return new Promise((resolve, reject) => {
				pending.set(id, (message: any) => {
					if (message.error) reject(new Error(message.error.message ?? JSON.stringify(message.error)));
					else resolve(message.result);
				});
				try {
					if (!proc?.stdin?.writable) throw new Error("opencode acp stdin is not writable");
					proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
				} catch (error) {
					pending.delete(id);
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
		};

		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`opencode probe timed out after ${timeoutMs}ms`)), timeoutMs);
		});

		const run = (async () => {
			await request("initialize", {
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
			});
			const created = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
			let configOptions = created?.configOptions;
			if (model) {
				try {
					const set = await request("session/set_config_option", {
						sessionId: created?.sessionId,
						configId: "model",
						value: model,
					});
					if (Array.isArray(set?.configOptions) && set.configOptions.length > 0) configOptions = set.configOptions;
				} catch {
					// Unknown model id: keep the session/new config options.
				}
			}
			return configOptions;
		})();
		void run.catch(() => {
			// Racing may settle before `run`; swallow late failures.
		});

		const configOptions = await Promise.race([run, timeout]);
		return {
			models: parseOptions(pickConfigOption(configOptions, "model", ["model"])?.options),
			efforts: parseOptions(pickConfigOption(configOptions, "thought_level", ["effort"])?.options),
		};
	} catch {
		return undefined;
	} finally {
		if (timer) clearTimeout(timer);
		stop();
	}
}

/** Fallback model catalog from the `opencode models` CLI (one provider/id per line). */
async function listOpencodeModelsCli(timeoutMs: number = OPENCODE_PROBE_TIMEOUT_MS): Promise<OpencodeOption[]> {
	return await new Promise<OpencodeOption[]>((resolve) => {
		let proc: ChildProcess | undefined;
		let out = "";
		const finish = (result: OpencodeOption[]) => resolve(result);
		try {
			proc = spawn(OPENCODE_BIN, ["models"], { shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
		} catch {
			resolve([]);
			return;
		}
		const timer = setTimeout(() => {
			try {
				proc?.kill("SIGTERM");
			} catch {
				// Already gone.
			}
			finish([]);
		}, timeoutMs);
		proc.stdout?.on("data", (data) => {
			out += data.toString();
		});
		proc.on("error", () => {
			clearTimeout(timer);
			finish([]);
		});
		proc.on("close", () => {
			clearTimeout(timer);
			const models = out
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => /^[\w.-]+\/[\w./-]+$/.test(line))
				.map((line) => ({ value: line, name: line }));
			finish(models);
		});
	});
}

let catalogCache: OpencodeOption[] | undefined;
let catalogPromise: Promise<OpencodeOption[]> | undefined;

/**
 * The opencode model catalog for the settings picker: `provider/id` values
 * with display names. Probed over ACP once per process, with the
 * `opencode models` CLI as fallback; the result is cached.
 */
export async function loadOpencodeModelCatalog(force = false): Promise<OpencodeOption[]> {
	if (force) {
		catalogCache = undefined;
		catalogPromise = undefined;
	}
	if (catalogCache) return catalogCache;
	if (!catalogPromise) {
		catalogPromise = (async () => {
			const probe = await acpProbe();
			if (probe && probe.models.length > 0) return probe.models;
			return await listOpencodeModelsCli();
		})()
			.then((models) => {
				catalogCache = models;
				return models;
			})
			.catch(() => [] as OpencodeOption[])
			.finally(() => {
				catalogPromise = undefined;
			});
	}
	return await catalogPromise;
}

const effortsCache = new Map<string, OpencodeOption[]>();
const effortsPromises = new Map<string, Promise<OpencodeOption[]>>();

/**
 * Effort (thought_level) variants the given opencode model supports, probed
 * over ACP by selecting the model in a throwaway session. Cached per model;
 * an empty array means "unknown / no variants".
 */
export async function loadOpencodeEfforts(model: string): Promise<OpencodeOption[]> {
	const cached = effortsCache.get(model);
	if (cached) return cached;
	const existing = effortsPromises.get(model);
	if (existing) return await existing;
	const promise = (async () => {
		const probe = await acpProbe(model);
		return probe?.efforts ?? [];
	})()
		.then((efforts) => {
			effortsCache.set(model, efforts);
			return efforts;
		})
		.catch(() => [] as OpencodeOption[])
		.finally(() => {
			effortsPromises.delete(model);
		});
	effortsPromises.set(model, promise);
	return await promise;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

export async function spawnOpencodeProcess(
	rec: SubagentRecord,
	userText: string,
	_depth: number,
	signal: AbortSignal | undefined,
	onUpdate?: (text: string) => void,
	_onBubble?: (bubble: { text: string }) => void,
	_taskBase?: string,
): Promise<SpawnedProcess> {
	const result: RunResult = {
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: EMPTY_USAGE(),
		bubbles: [],
	};

	let proc: ChildProcess | undefined;
	let stdinClosed = false;
	let seq = 0;
	let sessionId: string | undefined;
	let currentText = "";
	let turnInFlight: Promise<unknown> | undefined;
	const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();

	const write = (message: Record<string, unknown>) => {
		try {
			if (!stdinClosed && proc?.stdin?.writable) proc.stdin.write(`${JSON.stringify(message)}\n`);
		} catch {
			// A closed stdin means the child is already shutting down.
		}
	};
	const notify = (method: string, params: Record<string, unknown>) => write({ jsonrpc: "2.0", method, params });
	const request = (method: string, params: Record<string, unknown>) => {
		const id = `oc-${++seq}`;
		return new Promise<any>((resolve, reject) => {
			pending.set(id, { resolve, reject });
			write({ jsonrpc: "2.0", id, method, params });
		});
	};
	const closeStdin = () => {
		if (stdinClosed) return;
		stdinClosed = true;
		control.closed = true;
		try {
			proc?.stdin?.end();
		} catch {
			// Already closed.
		}
	};

	const finishTurn = (text: string, response: any) => {
		result.usage.turns += 1;
		const usage = response?.usage;
		if (usage) {
			result.usage.input += usage.inputTokens || 0;
			result.usage.output += usage.outputTokens || 0;
			result.usage.cacheRead += usage.cachedReadTokens || 0;
			result.usage.contextTokens = usage.totalTokens || result.usage.contextTokens;
		}
		if (!result.model && rec.model) result.model = rec.model;
		const stopReason = typeof response?.stopReason === "string" ? response.stopReason : undefined;
		if (stopReason) result.stopReason = stopReason;
		result.messages.push({
			role: "assistant",
			content: [{ type: "text", text: text || "(no output)" }],
			model: rec.model,
			stopReason,
		} as unknown as Message);
		if (onUpdate) onUpdate(text || "(working...)");
		// A settle consumes one reserved continuation (an interrupt that aborted a
		// turn and queued a follow-up); otherwise the process is done for this turn.
		if (control.pendingContinuations > 0) control.pendingContinuations -= 1;
		else closeStdin();
	};

	const startTurn = (message: string) => {
		currentText = "";
		const turn = request("session/prompt", { sessionId, prompt: [{ type: "text", text: message }] })
			.then((response) => finishTurn(currentText, response))
			.catch((error) => {
				if (result.exitCode === 0) result.exitCode = 1;
				result.errorMessage =
					result.errorMessage || `opencode turn failed: ${error instanceof Error ? error.message : String(error)}`;
				closeStdin();
			});
		turnInFlight = turn;
		turn.finally(() => {
			if (turnInFlight === turn) turnInFlight = undefined;
		});
		return turn;
	};

	const control: RpcControl = {
		pendingContinuations: 0,
		closed: false,
		sendCommand: async (cmd) => {
			try {
				if (cmd.type === "abort") {
					if (!sessionId || stdinClosed) return { success: false, error: "opencode session is not running" };
					notify("session/cancel", { sessionId });
					if (turnInFlight) {
						try {
							await turnInFlight;
						} catch {
							// The aborted turn rejects; that is expected here.
						}
					}
					return { success: true };
				}
				if (cmd.type === "prompt") {
					if (!sessionId || stdinClosed) return { success: false, error: "opencode session is not running" };
					startTurn(String(cmd.message ?? ""));
					return { success: true };
				}
				return { success: false, error: `unsupported command: ${String(cmd.type)}` };
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};

	const handleUpdate = (update: any) => {
		if (!update) return;
		if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
			const text = String(update.content.text ?? "");
			if (text) {
				currentText += text;
				if (onUpdate) onUpdate(currentText);
			}
		}
	};

	const handleClientRequest = (message: any) => {
		try {
			switch (message.method) {
				case "session/request_permission": {
					const options: any[] = Array.isArray(message.params?.options) ? message.params.options : [];
					const pick =
						options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once") ?? options[0];
					write({
						jsonrpc: "2.0",
						id: message.id,
						result: pick
							? { outcome: { outcome: "selected", optionId: pick.optionId } }
							: { outcome: { outcome: "cancelled" } },
					});
					return;
				}
				case "fs/read_text_file": {
					write({
						jsonrpc: "2.0",
						id: message.id,
						result: { content: fs.readFileSync(String(message.params?.path), "utf-8") },
					});
					return;
				}
				case "fs/write_text_file": {
					fs.writeFileSync(String(message.params?.path), String(message.params?.content ?? ""));
					write({ jsonrpc: "2.0", id: message.id, result: {} });
					return;
				}
				case "elicitation/create": {
					write({ jsonrpc: "2.0", id: message.id, result: { action: "cancel" } });
					return;
				}
				default:
					write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unsupported client method: ${message.method}` } });
			}
		} catch (error) {
			write({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
			});
		}
	};

	const done = new Promise<RunResult>((resolve) => {
		proc = spawn(OPENCODE_BIN, ["acp"], {
			cwd: rec.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});
		let buffer = "";
		let stderrBuffer = "";

		const handleMessage = (message: any) => {
			if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
				const entry = pending.get(message.id);
				if (entry) {
					pending.delete(message.id);
					if (message.error) entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
					else entry.resolve(message.result);
				}
				return;
			}
			if (message.method && message.id !== undefined) {
				handleClientRequest(message);
				return;
			}
			if (message.method === "session/update") handleUpdate(message.params?.update);
		};

		proc.stdout!.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let message: any;
				try {
					message = JSON.parse(line);
				} catch {
					result.stderr += line + "\n";
					continue;
				}
				handleMessage(message);
			}
		});
		proc.stderr!.on("data", (data) => {
			stderrBuffer += data.toString();
			const lines = stderrBuffer.split("\n");
			stderrBuffer = lines.pop() || "";
			for (const line of lines) if (line.trim()) result.stderr += line + "\n";
		});
		proc.on("close", (code) => {
			if (buffer.trim()) {
				try {
					handleMessage(JSON.parse(buffer));
				} catch {
					// Trailing partial line: ignore.
				}
			}
			if (stderrBuffer.trim()) result.stderr += stderrBuffer + "\n";
			result.exitCode = result.exitCode || (code ?? 0);
			resolve(result);
		});
		proc.on("error", (error) => {
			result.exitCode = 1;
			result.errorMessage =
				result.errorMessage || `Failed to launch ${OPENCODE_BIN}: ${error instanceof Error ? error.message : String(error)}`;
			resolve(result);
		});
		if (signal) {
			const killProc = () => {
				proc!.kill("SIGTERM");
				setTimeout(() => {
					if (!proc!.killed) proc!.kill("SIGKILL");
				}, KILL_GRACE_MS);
			};
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}

		void (async () => {
			try {
				await request("initialize", {
					protocolVersion: 1,
					clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
				});

				let createdNew = false;
				if (rec.opencodeSessionId) {
					try {
						await request("session/load", { sessionId: rec.opencodeSessionId, cwd: rec.cwd, mcpServers: [] });
						sessionId = rec.opencodeSessionId;
					} catch {
						rec.opencodeSessionId = undefined;
					}
				}
				if (!sessionId) {
					const created = await request("session/new", { cwd: rec.cwd, mcpServers: [] });
					sessionId = String(created?.sessionId ?? "");
					if (!sessionId) throw new Error("opencode did not return a session id");
					rec.opencodeSessionId = sessionId;
					createdNew = true;
					saveRecord(rec);
				}

				if (rec.model) {
					try {
						await request("session/set_config_option", { sessionId, configId: "model", value: rec.model });
					} catch {
						// Unknown/unavailable model id: keep opencode's default rather than failing the turn.
					}
				}
				if (rec.opencodeEffort && rec.opencodeEffort !== OPENCODE_DEFAULT_EFFORT) {
					try {
						await request("session/set_config_option", { sessionId, configId: "effort", value: rec.opencodeEffort });
					} catch {
						// Unsupported effort for this model: keep the model default.
					}
				}
				// Ensure edits are allowed; a restored session could have been left in plan mode.
				try {
					await request("session/set_config_option", { sessionId, configId: "mode", value: "build" });
				} catch {
					// Older opencode builds may not expose the mode option.
				}

				const isFirstTurn = createdNew || !rec.opencodeTurns;
				rec.opencodeTurns = (rec.opencodeTurns ?? 0) + 1;
				saveRecord(rec);
				startTurn(isFirstTurn ? buildOpencodeFirstPrompt(rec, userText) : userText);
			} catch (error) {
				result.exitCode = 1;
				result.errorMessage = error instanceof Error ? error.message : String(error);
				closeStdin();
			}
		})();
	});

	return { proc: proc!, done, control };
}
