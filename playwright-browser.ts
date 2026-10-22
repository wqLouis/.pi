

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DAEMON_SPAWN_TIMEOUT_MS = 1500;
const SETUP_STATUS_LINE_CHARS = 90;
const SETUP_NOTIFY_LINES = 12;
const LAUNCH_PROBE_TIMEOUT_MS = 45_000;
const BROWSER_DIR = path.join(homedir(), ".pi", "agent", "browser");
const STATE_FILE = path.join(BROWSER_DIR, "daemon.json");
const DAEMON_FILE =
	process.env.PI_BROWSER_DAEMON_FILE ??
	path.join(path.dirname(new URL(import.meta.url).pathname), "browser-server.mjs");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));


const SESSION = process.env.PI_SUBAGENT_ID ?? "main";

/**
 * The main pi process. The browser daemon watches it and closes the browser
 * when it goes away, so a killed pi leaves no chromium behind. Subagents
 * inherit the variable, so a finished subagent turn never kills the main
 * agent's browser.
 */
const MAIN_PID = Number(process.env.PI_MAIN_PID ?? process.pid);
if (!process.env.PI_MAIN_PID) process.env.PI_MAIN_PID = String(process.pid);

/** Only the main process owns the browser daemon. */
const IS_SUBAGENT = Boolean(process.env.PI_SUBAGENT_ID);


function resolvePlaywrightImport(): string | undefined {

	const override = process.env.PI_PLAYWRIGHT_IMPORT;
	if (override && fs.existsSync(override)) return override;
	const tryResolve = (spec: string) => {
		try {
			return createRequire(import.meta.url).resolve(spec);
		} catch {
			return undefined;
		}
	};
	for (const spec of ["playwright", "playwright-core"]) {
		const entry = tryResolve(spec);
		if (entry) return entry;
	}

	for (const nm of globalNodeModulesDirs()) {
		for (const name of ["playwright", "playwright-core"]) {
			const pkgDir = path.join(nm, name);
			const pkgJson = path.join(pkgDir, "package.json");
			if (fs.existsSync(pkgJson)) {
				try {
					const pj = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
					return path.join(pkgDir, pj.main ?? "index.js");
				} catch {
					return path.join(pkgDir, "index.js");
				}
			}
		}
	}
	return undefined;
}


function globalNodeModulesDirs(): string[] {
	const dirs = new Set<string>();

	try {
		const req = createRequire(import.meta.url);
		let piPkg: string;
		try {
			piPkg = req.resolve("@earendil-works/pi-coding-agent/package.json");
		} catch {
			piPkg = req.resolve("@earendil-works/pi-coding-agent");
		}
		dirs.add(
			piPkg.includes("package.json")
				? path.dirname(path.dirname(path.dirname(piPkg)))
				: path.dirname(path.dirname(path.dirname(path.dirname(piPkg)))),
		);
	} catch {

	}
	dirs.add(path.join(homedir(), ".bun", "install", "global", "node_modules"));

	dirs.add(path.join(homedir(), "node_modules"));
	dirs.add(path.join(homedir(), ".npm-global", "lib", "node_modules"));
	dirs.add("/usr/local/lib/node_modules");
	dirs.add("/usr/lib/node_modules");

	if (process.env.PI_PLAYWRIGHT_GLOBAL_DIR) dirs.add(process.env.PI_PLAYWRIGHT_GLOBAL_DIR);
	return [...dirs];
}


function findOnPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {

		}
	}
	return undefined;
}


function resolvePackageInstaller(): { cmd: string; args: string[] } | undefined {
	const bun = findOnPath("bun");
	if (bun) return { cmd: bun, args: ["add", "-g", "playwright"] };
	const npm = findOnPath("npm");
	if (npm) return { cmd: npm, args: ["install", "-g", "playwright"] };
	return undefined;
}


interface DaemonInfo {
	port: number;
	token: string;
	pid: number;
}

function readDaemon(): DaemonInfo | undefined {
	try {
		const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
		if (typeof data?.port === "number" && typeof data?.token === "string") return data;
	} catch {

	}
	return undefined;
}

async function ping(info: DaemonInfo): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), DAEMON_SPAWN_TIMEOUT_MS);
		const res = await fetch(`http://127.0.0.1:${info.port}/status`, {
			headers: { "x-browser-token": info.token },
			signal: ctrl.signal,
		});
		clearTimeout(timer);
		return res.ok;
	} catch {
		return false;
	}
}

async function ensureDaemon(): Promise<{ base: string; token: string }> {

	const existing = readDaemon();
	if (existing && (await ping(existing))) {
		return { base: `http://127.0.0.1:${existing.port}`, token: existing.token };
	}
	if (existing?.pid) {
		try {
			process.kill(existing.pid, "SIGTERM");
		} catch {

		}
	}
	fs.rmSync(STATE_FILE, { force: true });

	const token = randomBytes(16).toString("hex");
	const child = spawn(
		process.execPath,
		[DAEMON_FILE, "--port", "0", "--token", token, "--state", STATE_FILE, "--owner-pid", String(MAIN_PID)],
		{
		stdio: "ignore",
		detached: true,
			env: { ...process.env, PI_PLAYWRIGHT_IMPORT: resolvePlaywrightImport() ?? "" },
		},
	);
	child.unref();


	const deadline = Date.now() + 12000;
	while (Date.now() < deadline) {
		const info = readDaemon();
		if (info) {
			if (info.token === token && (await ping(info))) {
				return { base: `http://127.0.0.1:${info.port}`, token };
			}

			if (info.token !== token && (await ping(info))) {
				try {
					child.kill("SIGTERM");
				} catch {

				}
				return { base: `http://127.0.0.1:${info.port}`, token: info.token };
			}
		}
		await sleep(100);
	}
	throw new Error(
		"Browser daemon failed to start. Is playwright installed? Run: `bun add -g playwright && playwright install chromium`",
	);
}

async function daemonRequest(route: string, body: Record<string, unknown>, timeoutMs = 60000): Promise<any> {
	const daemon = await ensureDaemon();
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(`${daemon.base}${route}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-browser-token": daemon.token },
			body: JSON.stringify({ ...body, session: SESSION }),
			signal: ctrl.signal,
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error ?? data.hint ?? `browser daemon error (${res.status})`);
		return data;
	} finally {
		clearTimeout(timer);
	}
}

const toolError = (error: unknown) => ({
	content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
	details: {},
	isError: true,
});


const chromiumCacheDir = () => path.join(homedir(), ".cache", "ms-playwright");

function hasChromium(): boolean {
	try {
		const names = fs.readdirSync(chromiumCacheDir());
		return names.some((n) => /^chromium(_headless_shell)?-\d+$/.test(n));
	} catch {
		return false;
	}
}


function playwrightCliPath(entry: string): string | undefined {
	const cli = path.join(path.dirname(entry), "cli.js");
	return fs.existsSync(cli) ? cli : undefined;
}


function runStreamed(
	command: string,
	args: string[],
	onLine: (line: string) => void,
): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const collect = (chunk: Buffer) => {
			const text = chunk.toString();
			output += text;
			for (const line of text.split(/\r?\n/)) {
				if (line.trim()) onLine(line);
			}
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.on("close", (code) => resolve({ code: code ?? -1, output }));
		child.on("error", (error) => resolve({ code: -1, output: `spawn error: ${error.message}` }));
	});
}

const tailOutput = (text: string, max = 1500) => {
	const lines = text.split(/\r?\n/).filter(Boolean);
	const tail = lines.slice(-40).join("\n");
	return tail.length > max ? tail.slice(-max) : tail;
};

async function showSetupPanel(ctx: ExtensionCommandContext, text: string, ok: boolean) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(text.split("\n").slice(0, SETUP_NOTIFY_LINES).join("\n"), ok ? "info" : "error");
		return;
	}
	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg(ok ? "success" : "error", s));
		const mdTheme = getMarkdownTheme();
		container.addChild(border);
		container.addChild(new Text(theme.fg(ok ? "success" : "error", theme.bold(ok ? "Playwright ready" : "Playwright setup failed")), 1, 0));
		container.addChild(new Markdown(text, 1, 1, mdTheme));
		container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
		container.addChild(border);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
					done(undefined);
				}
			},
		};
	});
}

async function runPlaywrightSetup(ctx: ExtensionCommandContext, force: boolean) {
	const status = (text: string) => {
		if (ctx.hasUI) ctx.ui.setStatus("playwright-setup", text);
	};
	const log: string[] = [];
	const push = (line: string) => {
		log.push(line);
		if (log.length > 100) log.splice(0, log.length - 100);
	};
	const finish = async (ok: boolean, text: string) => {
		if (ctx.hasUI) ctx.ui.setStatus("playwright-setup", "");
		ctx.ui.notify(ok ? "Playwright is ready." : "Playwright setup failed — see details.", ok ? "info" : "error");
		await showSetupPanel(ctx, text, ok);
	};

	const hasPackage = !!resolvePlaywrightImport();

	if (hasPackage && hasChromium() && !force) {
		await finish(
			true,
			"playwright + chromium are already installed and ready to use.\n\n" +
				"Use the browser_* tools (browser_open, browser_click, browser_type, browser_content, browser_eval, browser_screenshot, browser_status, browser_close).\n\n" +
				"Run `/playwright-setup force` to reinstall anyway.",
		);
		return;
	}


	let entry = resolvePlaywrightImport();
	if (!entry) {
		const installer = resolvePackageInstaller();
		if (!installer) {
			await finish(
				false,
				"Could not find a package manager (bun or npm) on PATH. Install playwright manually:\n`bun add -g playwright` or `npm install -g playwright`",
			);
			return;
		}
		const manager = path.basename(installer.cmd);
		status(`Installing playwright package (${manager} add -g playwright)...`);
		const r = await runStreamed(installer.cmd, installer.args, (line) => {
			push(line);
			status(line.slice(0, SETUP_STATUS_LINE_CHARS));
		});
		if (r.code !== 0) {
			await finish(
				false,
				"Could not install the playwright package.\n\n```\n" + tailOutput(r.output) + "\n```\n\n" +
					`Try manually: \`bun add -g playwright\` or \`npm install -g playwright\``,
			);
			return;
		}
		push("playwright package installed.");
		entry = resolvePlaywrightImport();
	}
	if (!entry) {
		await finish(false, "playwright is installed but could not be resolved by the extension. Try `/reload` then `/playwright-setup` again.");
		return;
	}


	if (force || !hasChromium()) {
		const cli = playwrightCliPath(entry);
		if (!cli) {
			await finish(false, "Found playwright but not its cli.js — reinstall the package with `bun add -g playwright`.");
			return;
		}
		status("Installing chromium browser (playwright install chromium)...");
		const r = await runStreamed(process.execPath, [cli, "install", "chromium"], (line) => {
			push(line);
			status(line.slice(0, SETUP_STATUS_LINE_CHARS));
		});
		if (r.code !== 0) {
			const hints =
				process.platform === "linux"
					? "\n\nOn Linux, missing system libraries are common — try: `sudo " +
						`${process.execPath} ${cli} install-deps chromium` + "`"
					: "";
			await finish(false, "Could not install the chromium browser.\n\n```\n" + tailOutput(r.output) + "\n```" + hints);
			return;
		}
		push("chromium installed.");
	}


	status("Verifying browser launch...");
	try {
		const probe = await daemonRequest("/open", { url: "about:blank" }, LAUNCH_PROBE_TIMEOUT_MS);
		await daemonRequest("/close", {}, 5000).catch(() => {});
		await finish(
			true,
			"playwright + chromium installed and verified (headless browser launches).\n\n" +
				"Browser tools now available:\n" +
				"- browser_open, browser_click, browser_type, browser_content\n" +
				"- browser_eval, browser_screenshot, browser_status, browser_close\n\n" +
				"- The main agent can call them directly.\n" +
				"- Subagents can drive the browser too — each gets its own page session.\n" +
				`- Screenshots are saved to ${path.join(homedir(), ".pi", "agent", "browser", "shots")}.`,
		);
	} catch (error) {
		await finish(
			false,
			"playwright + chromium are installed, but launching the browser failed.\n\n```\n" +
				(error instanceof Error ? error.message : String(error)) +
				"\n```\n\n" +
				(process.platform === "linux" ? "On Linux, try: `sudo <bun> <cli> install-deps chromium` for missing system libraries." : ""),
		);
	}
}


/**
 * Stop the browser daemon (and with it every browser it holds). The daemon
 * also watches the owning pi process, so a hard kill of pi is covered too.
 */
function killDaemon(): void {
	const info = readDaemon();
	if (info?.pid) {
		try {
			process.kill(info.pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	}
	try {
		fs.rmSync(STATE_FILE, { force: true });
	} catch {
		// Nothing to remove.
	}
}

export default function (pi: ExtensionAPI) {

	pi.registerCommand("playwright-setup", {
		description:
			"Install playwright + chromium for the browser tools. Usage: /playwright-setup [force] — force reinstalls even if already present.",
		handler: async (args, ctx) => {
			const force = (args ?? "").trim().split(/\s+/).includes("force");
			await runPlaywrightSetup(ctx, force);
		},
	});

	const requireText = (params: Record<string, unknown>, name: string): string | undefined => {
		const v = params[name];
		return typeof v === "string" && v.trim() ? v.trim() : undefined;
	};

	pi.registerTool({
		name: "browser_open",
		label: "Browser Open",
		description:
			"Open a URL in the shared browser (headless Chromium) and wait for the page to load. Returns the final URL and page title. The browser persists across turns, so later browser_eval calls act on the same page. If the browser isn't set up yet, the user can run /playwright-setup.",
		promptSnippet: "Open a web page in the browser",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to open (http(s):// or file://)" }),
		}),
		async execute(_toolCallId, params) {
			const url = requireText(params, "url");
			if (!url) return toolError("Error: url is required.");
			try {
				const data = await daemonRequest("/open", { url });
				return {
					content: [{ type: "text", text: `Opened ${data.url} — title: ${data.title}` }],
					details: { url: data.url, title: data.title },
				};
			} catch (error) {
				return toolError(error);
			}
		},
	});

	pi.registerTool({
		name: "browser_eval",
		label: "Browser Eval",
		description:
			"Evaluate a JavaScript expression in the current page and return its result (stringified). This is the main way to drive a page: read text (document.body.innerText), query the DOM (document.querySelector), click (el.click()), fill inputs (el.value = 'x'; el.dispatchEvent(new Event('input', { bubbles: true }))), scroll, and extract structured data. Use browser_open first to load a page.",
		promptSnippet: "Run JavaScript in the current page (click, type, read)",
		parameters: Type.Object({
			script: Type.String({ description: "JavaScript expression to evaluate in the page" }),
		}),
		async execute(_toolCallId, params) {
			const script = requireText(params, "script");
			if (!script) return toolError("Error: script is required.");
			try {
				const data = await daemonRequest("/eval", { script });
				return {
					content: [{ type: "text", text: String(data.result ?? "(no result)") }],
					details: {},
				};
			} catch (error) {
				return toolError(error);
			}
		},
	});

	pi.registerTool({
		name: "browser_close",
		label: "Browser Close",
		description: "Close this session's browser page (frees memory). The daemon stays alive; the next browser_open starts fresh.",
		promptSnippet: "Close the browser session",
		parameters: Type.Object({}),
		async execute() {
			try {
				await daemonRequest("/close", {});
				return { content: [{ type: "text", text: "Browser session closed." }], details: {} };
			} catch (error) {
				return toolError(error);
			}
		},
	});


	pi.on("session_shutdown", () => {
		if (IS_SUBAGENT) {
			// A subagent only closes its own page; the daemon belongs to the main
			// pi process and must outlive this turn.
			daemonRequest("/close", {}, 3000).catch(() => {});
			return;
		}
		// The session is going away (quit, reload, or a session switch): close
		// the browser and stop the daemon instead of leaving chromium running.
		killDaemon();
	});
}


export const _browserSetupInternals = {
	findOnPath,
	resolvePackageInstaller,
	resolvePlaywrightImport,
	globalNodeModulesDirs,
};
