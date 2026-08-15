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

/** Extract search results in-page (google h3, bing h2, ddg h2): title, url, snippet. */
const SEARCH_EXTRACTOR = (maxResults) => {
	const results = [];
	const seen = new Set();
	const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
	const decodeUrl = (href) => {
		try {
			const u = new URL(href, location.origin);
			// google /url?q=...
			if (u.pathname === "/url" && u.searchParams.get("q")) return u.searchParams.get("q");
			// bing /ck/a?u=<base64>
			if (u.hostname.includes("bing.com") && u.searchParams.get("u")) {
				try {
					return atob(String(u.searchParams.get("u")).replace(/^a1/, ""));
			} catch {
					/* fall through */
				}
			}
			// duckduckgo /l/?uddg=...
			if (u.hostname.includes("duckduckgo.com") && u.searchParams.get("uddg")) return u.searchParams.get("uddg");
			if (u.protocol === "http:" || u.protocol === "https:") return u.href;
			return "https://" + location.host + u.pathname + u.search;
		} catch {
			return href;
		}
	};
	const SNIPPET_SELECTOR =
		".VwiC3b, [class*='VwiC3b'], [data-sncf], [class*='kb0PBd'], [class*='IsZvec'], .b_caption p, .result__snippet, [class*='result__snippet']";
	const CONTAINER_SELECTOR = "div.g, div[data-hveid], li.b_algo, div.result, [class*='result']";
	// skip the engine's own footer/nav links (they are not results)
	const isOwned = (url) => /duckduckgo\.com|start\.duckduckgo|google\.com\/search|bing\.com/.test(url) && !url.includes("/url?q=") && !url.includes("/ck/a");
	for (const h of document.querySelectorAll("h2, h3")) {
		const a = h.closest("a");
		if (!a || !a.href) continue;
		const rawTitle = clean(h.textContent);
		const url = decodeUrl(a.href);
		const title = rawTitle.replace(/https?:\/\/[^\s]+/g, "").trim() || rawTitle;
		if (!title || seen.has(url) || isOwned(url)) continue;
		const container = h.closest(CONTAINER_SELECTOR) || a.parentElement;
		let snippet = "";
		if (container) {
			const sn = container.querySelector(SNIPPET_SELECTOR);
			snippet = sn ? clean(sn.textContent) : clean(container.innerText).replace(title, "").slice(0, 300);
		}
		results.push({ title, url, snippet });
		seen.add(url);
		if (results.length >= maxResults) break;
	}
	if (results.length === 0) {
		for (const a of document.querySelectorAll("a[href^='http']")) {
			const rawTitle = clean(a.textContent);
			const title = rawTitle.replace(/https?:\/\/[^\s]+/g, "").trim();
			const url = decodeUrl(a.href);
			if (!title || title.length < 4 || seen.has(a.href) || isOwned(url)) continue;
			results.push({ title, url, snippet: "" });
			seen.add(a.href);
			if (results.length >= maxResults) break;
		}
	}
	return results;
};

/** Whether the current page is a bot/captcha/consent wall rather than results. */
async function isBlocked(page) {
	const url = page.url();
	if (url.includes("/sorry") || url.includes("consent.")) return true;
	try {
		const head = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 300) : ""));
		return /unusual traffic|verify you're a human|not a robot|captcha/i.test(head);
	} catch {
		return false;
	}
}

const SEARCH_ENGINE_DEFS = {
	google: { url: (q, count) => `https://www.google.com/search?q=${q}&num=${count}` },
	duckduckgo: { url: (q, count) => `https://duckduckgo.com/?q=${q}` },
	bing: { url: (q, count) => `https://www.bing.com/search?q=${q}&count=${count}` },
};

/** Active engines in order. Default: google, duckduckgo (no bing). Override with PI_SEARCH_ENGINES=google,duckduckgo,bing */
const SEARCH_ENGINES = (process.env.PI_SEARCH_ENGINES ?? "google,duckduckgo")
	.split(",")
	.map((s) => s.trim())
	.filter((s) => SEARCH_ENGINE_DEFS[s])
	.map((name) => ({ name, ...SEARCH_ENGINE_DEFS[name] }));

/** Search the web: google first, then duckduckgo (headless browsers are often blocked). */
async function searchWeb(page, query, count) {
	const q = encodeURIComponent(query);
	let lastUrl = "";
	for (const engine of SEARCH_ENGINES) {
		try {
			const url = engine.url(q, count);
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
			lastUrl = page.url();
			if (engine.name === "google") {
				// skip Google's consent wall
				try {
					const accept = page.locator("button:has-text('Accept all'), button:has-text('Accept'), form[action*='consent'] button").first();
					await accept.click({ timeout: 5000 });
					await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
				} catch {
					/* no consent wall */
				}
			}
			if (await isBlocked(page)) continue;
			try {
				await page.waitForSelector("h2, h3, #search, #rso, .b_algo, .result", { timeout: 10000 });
			} catch {
				/* results may still be loading */
			}
			await page.waitForTimeout(500);
			const results = await page.evaluate(SEARCH_EXTRACTOR, count);
			if (results.length > 0) {
				return { engine: engine.name, url: page.url(), title: await page.title().catch(() => ""), results };
			}
		} catch {
			/* try next engine */
		}
	}
	return { engine: "none", url: lastUrl, title: "", results: [] };
}

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
			case "/search": {
				if (!body.query) return send(res, 400, { error: "query required" });
				const page = await getPage(session);
				const count = Math.min(20, Math.max(1, Number(body.count) || 10));
				const data = await searchWeb(page, String(body.query), count);
				return send(res, 200, { ok: true, query: String(body.query), ...data });
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
