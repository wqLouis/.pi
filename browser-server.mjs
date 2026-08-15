/**
 * Browser daemon for the pi browser extension.
 *
 * Owns a Playwright Chromium instance and exposes a tiny JSON HTTP API on
 * 127.0.0.1. It runs as a detached subprocess so it survives pi process
 * restarts and one-shot subagent turns — the extension proxies tool calls to
 * it, and browser state (URL, page) persists across turns.
 *
 * Sessions: each client (main agent, or each subagent) uses a stable session
 * id, so parallel clients get independent pages and don't collide.
 *
 * Usage:
 *   node browser-server.mjs --port 0 --token <token> --state <daemon.json>
 *
 * Playwright is imported via the PI_PLAYWRIGHT_IMPORT env var (absolute path
 * to the playwright entry file), falling back to bare specifiers.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const getArg = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(getArg("--port") ?? "0");
const token = getArg("--token") ?? "";
const statePath = getArg("--state") ?? path.join(process.env.HOME ?? ".", ".pi", "agent", "browser", "daemon.json");
const shotsDir = path.join(path.dirname(statePath), "shots");
fs.mkdirSync(shotsDir, { recursive: true });

/** sessions: sessionId -> { browser, context, page } */
const sessions = new Map();
let pw = null;

async function getPlaywright() {
	if (pw) return pw;
	// An explicit import path is authoritative (the extension resolves it).
	// Without one, fall back to bare specifiers (may resolve via global installs).
	const explicitImport = process.env.PI_PLAYWRIGHT_IMPORT;
	const specs = explicitImport ? [explicitImport] : ["playwright", "playwright-core"];
	let lastErr;
	for (const spec of specs) {
		try {
			const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
			const m = mod.default ?? mod;
			if (m?.chromium) {
				pw = m;
				return pw;
			}
			lastErr = new Error(`playwright module at "${spec}" has no chromium export`);
		} catch (e) {
			lastErr = e;
		}
	}
	throw lastErr ?? new Error("playwright not found");
}

async function getPage(session) {
	let s = sessions.get(session);
	if (s && s.page && !s.page.isClosed()) return s.page;
	if (!s || !s.browser || !s.browser.isConnected()) {
		const module = await getPlaywright();
		const browser = await module.chromium.launch({ headless: true });
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		s = { browser, context, page: null };
		sessions.set(session, s);
	}
	if (!s.page || s.page.isClosed()) s.page = await s.context.newPage();
	s.page.setDefaultTimeout(15000);
	return s.page;
}

async function closeSession(session) {
	const s = sessions.get(session);
	if (s) {
		try {
			await s.browser.close();
		} catch {
			/* ignore */
		}
		sessions.delete(session);
	}
}

const readBody = (req) =>
	new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > 5e6) {
				reject(new Error("request body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});

const send = (res, code, obj) => {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
	if (req.headers["x-browser-token"] !== token) {
		return send(res, 401, { error: "unauthorized" });
	}
	let body = {};
	try {
		body = JSON.parse((await readBody(req)) || "{}");
	} catch {
		return send(res, 400, { error: "bad json body" });
	}
	const route = (req.url ?? "/").split("?")[0];
	const session = typeof body.session === "string" && body.session ? body.session : "main";

	try {
		switch (route) {
			case "/status": {
				const info = { ok: true, sessions: [...sessions.keys()] };
				const s = sessions.get(session);
				if (s && s.page && !s.page.isClosed()) {
					try {
						info.url = s.page.url();
						info.title = await s.page.title();
					} catch {
						/* ignore */
					}
				}
				return send(res, 200, info);
			}
			case "/open": {
				if (!body.url) return send(res, 400, { error: "url required" });
				const page = await getPage(session);
				await page.goto(String(body.url), { waitUntil: "domcontentloaded", timeout: 30000 });
				return send(res, 200, { ok: true, url: page.url(), title: await page.title() });
			}
			case "/click": {
				if (!body.selector) return send(res, 400, { error: "selector required" });
				const page = await getPage(session);
				await page.waitForSelector(String(body.selector), { state: "visible", timeout: 15000 });
				await page.click(String(body.selector));
				return send(res, 200, { ok: true });
			}
			case "/type": {
				if (!body.selector) return send(res, 400, { error: "selector required" });
				const page = await getPage(session);
				await page.waitForSelector(String(body.selector), { state: "visible", timeout: 15000 });
				await page.fill(String(body.selector), String(body.text ?? ""));
				if (body.submit) await page.press(String(body.selector), "Enter");
				return send(res, 200, { ok: true });
			}
			case "/content": {
				const page = await getPage(session);
				const text = body.selector
					? await page.locator(String(body.selector)).first().textContent({ timeout: 15000 }).catch(() => null)
					: await page.evaluate(() => (document.body ? document.body.innerText : ""));
				return send(res, 200, { ok: true, text: String(text ?? "") });
			}
			case "/screenshot": {
				const page = await getPage(session);
				const safe = String(body.name ?? "").replace(/[^a-zA-Z0-9._-]/g, "") || `shot-${Date.now()}.png`;
				const file = path.join(shotsDir, safe.endsWith(".png") ? safe : `${safe}.png`);
				await page.screenshot({ path: file });
				return send(res, 200, { ok: true, path: file });
			}
			case "/eval": {
				if (typeof body.script !== "string") return send(res, 400, { error: "script required" });
				const page = await getPage(session);
				const result = await page.evaluate(body.script);
				const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
				return send(res, 200, { ok: true, result: text.slice(0, 20000) });
			}
			case "/close":
				await closeSession(session);
				return send(res, 200, { ok: true });
			default:
				return send(res, 404, { error: `unknown route ${route}` });
		}
	} catch (e) {
		return send(res, 500, {
			error: e instanceof Error ? e.message : String(e),
			hint: "If this mentions playwright: install it with `bun add -g playwright && playwright install chromium`.",
		});
	}
});

server.listen(port, "127.0.0.1", () => {
	const addr = server.address();
	const actualPort = typeof addr === "object" && addr ? addr.port : port;
	fs.writeFileSync(statePath, JSON.stringify({ port: actualPort, token, pid: process.pid, startedAt: Date.now() }));
	process.stdout.write(`browser daemon ready on 127.0.0.1:${actualPort}\n`);
});

process.on("SIGTERM", async () => {
	for (const s of sessions.values()) {
		try {
			await s.browser.close();
		} catch {
			/* ignore */
		}
	}
	process.exit(0);
});
