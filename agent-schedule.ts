/**
 * Scheduler — deferred reminders for the agent.
 *
 * The agent can schedule a reminder ("remind me in 10 minutes to check on the
 * build"), persisted to ~/.pi/agent/schedule.json. A timer fires due items in
 * realtime (deliverAs followUp + triggerTurn, so an idle agent wakes up), and
 * items that came due while pi was closed are fired on startup.
 *
 * Tools: schedule_add, schedule_list, schedule_cancel (+ /schedule command).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SCHEDULE_FILE = path.join(getAgentDir(), "schedule.json");
const CHECK_INTERVAL_MS = 15_000;
const CUSTOM_TYPE = "scheduled-reminder";

interface ScheduledItem {
	id: string;
	text: string;
	dueAt: number;
	createdAt: number;
}

function loadSchedule(): ScheduledItem[] {
	try {
		const raw = JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf-8")) as ScheduledItem[];
		if (Array.isArray(raw)) return raw.filter((s) => s && typeof s.dueAt === "number");
	} catch {
		/* missing or corrupt */
	}
	return [];
}

function saveSchedule(items: ScheduledItem[]): void {
	fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(items, null, 2), { encoding: "utf-8", mode: 0o600 });
}

function fireDueItems(pi: ExtensionAPI, items: ScheduledItem[]): void {
	const now = Date.now();
	const due = items.filter((s) => s.dueAt <= now);
	if (due.length === 0) return;
	const remaining = items.filter((s) => s.dueAt > now);
	for (const item of due) {
		try {
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: `[scheduled reminder] ${item.text}`,
					display: true,
					details: { reminderId: item.id, text: item.text, scheduledAt: item.createdAt },
				},
				// Realtime: idle -> immediate new turn; streaming -> queued into current turn.
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			/* delivery failed — keep the item for a retry */
			remaining.push(item);
		}
	}
	saveSchedule(remaining);
}

const toolError = (error: unknown) => ({
	content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
	details: {},
	isError: true,
});

export default function (pi: ExtensionAPI) {
	// Fire reminders that came due while pi was closed, then poll periodically.
	let timer: ReturnType<typeof setInterval> | undefined;
	const start = () => {
		try {
			fireDueItems(pi, loadSchedule());
		} catch {
			/* ignore */
		}
		if (!timer) {
			timer = setInterval(() => {
				try {
					fireDueItems(pi, loadSchedule());
				} catch {
					/* ignore */
				}
			}, CHECK_INTERVAL_MS);
		}
	};
	start();
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
	});

	pi.registerTool({
		name: "schedule_add",
		label: "Schedule Add",
		description:
			"Schedule a reminder that will be delivered to you (realtime, even if idle) after the given delay. Use for 'check back in N minutes', delayed follow-ups, or anything that shouldn't be forgotten while you work on something else.",
		promptSnippet: "Schedule a reminder for later",
		parameters: Type.Object({
			text: Type.String({ description: "The reminder text (delivered to the agent verbatim)" }),
			inMinutes: Type.Number({ description: "Delay in minutes (fractions allowed, e.g. 0.5 = 30s)" }),
		}),
		async execute(_toolCallId, params) {
			const text = params.text?.trim();
			if (!text) return toolError("Error: text is required.");
			const mins = Number(params.inMinutes);
			if (!Number.isFinite(mins) || mins <= 0 || mins > 24 * 60) {
				return toolError("Error: inMinutes must be a positive number (max 1440 = 24h).");
			}
			const item: ScheduledItem = {
				id: randomBytes(4).toString("hex"),
				text,
				dueAt: Date.now() + Math.round(mins * 60_000),
				createdAt: Date.now(),
			};
			const items = loadSchedule();
			items.push(item);
			saveSchedule(items);
			const at = new Date(item.dueAt).toLocaleString();
			return {
				content: [
					{
						type: "text",
						text: `Scheduled reminder #${item.id} for ${at} (in ${mins} min): "${text}". It will be delivered automatically.`,
					},
				],
				details: { reminderId: item.id, text, dueAt: item.dueAt, dueAtDisplay: at },
			};
		},
	});

	pi.registerTool({
		name: "schedule_list",
		label: "Schedule List",
		description: "List pending scheduled reminders with their due times.",
		promptSnippet: "List scheduled reminders",
		parameters: Type.Object({}),
		async execute() {
			const items = loadSchedule().sort((a, b) => a.dueAt - b.dueAt);
			if (items.length === 0) {
				return {
					content: [{ type: "text", text: "No scheduled reminders." }],
					details: { items: [] },
				};
			}
			const text = [
				`${items.length} pending reminder(s):`,
				...items.map(
					(i) => `- #${i.id} due ${new Date(i.dueAt).toLocaleString()}: ${i.text}`,
				),
			].join("\n");
			return { content: [{ type: "text", text }], details: { items } };
		},
	});

	pi.registerTool({
		name: "schedule_cancel",
		label: "Schedule Cancel",
		description: "Cancel a scheduled reminder by its id (from schedule_list).",
		promptSnippet: "Cancel a scheduled reminder",
		parameters: Type.Object({
			id: Type.String({ description: "Reminder id" }),
		}),
		async execute(_toolCallId, params) {
			const id = params.id?.trim();
			if (!id) return toolError("Error: id is required.");
			const items = loadSchedule();
			const before = items.length;
			const remaining = items.filter((s) => s.id !== id);
			if (remaining.length === before) return toolError(`No scheduled reminder with id "${id}".`);
			saveSchedule(remaining);
			return { content: [{ type: "text", text: `Cancelled reminder #${id}.` }], details: { reminderId: id } };
		},
	});

	/* ---------------- /schedule command (for humans) ---------------- */
	pi.registerCommand("schedule", {
		description: "Scheduled reminders: /schedule list | cancel <id>",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const first = parts[0];
			if (first === "cancel") {
				const id = parts[1];
				if (!id) {
					ctx.ui.notify("Usage: /schedule cancel <id>", "info");
					return;
				}
				const items = loadSchedule();
				const remaining = items.filter((s) => s.id !== id);
				saveSchedule(remaining);
				ctx.ui.notify(remaining.length !== items.length ? `Cancelled #${id}.` : `No reminder #${id}.`, "info");
				return;
			}
			const items = loadSchedule().sort((a, b) => a.dueAt - b.dueAt);
			ctx.ui.notify(
				items.length
					? items.map((i) => `#${i.id} · ${new Date(i.dueAt).toLocaleString()} · ${i.text}`).join("\n")
					: "No scheduled reminders.",
				"info",
			);
		},
	});
}
