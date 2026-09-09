/**
 * pi-loop — run a prompt repeatedly, Claude Code /loop style.
 *
 * Two ways to drive a loop:
 *   /loop 15m <prompt>   Fixed interval. Parsed at the command layer into a cron
 *                        schedule and run by a self-re-arming timer. Continuation
 *                        is the DEFAULT — it keeps firing until you stop it,
 *                        7 days elapse, or it hits maxFires. The model is never
 *                        responsible for keeping it alive.
 *   /loop <prompt>       Self-paced. Fires once, then only continues when the
 *                        model calls schedule_loop_wakeup (it may end the loop by
 *                        not calling it). This is the original behaviour, kept.
 *
 * The agent can also schedule cron / event / hybrid loops as background tasks via
 * the LoopCreate / LoopList / LoopDelete tools.
 *
 * Notes:
 *   - Loops persist to .pi/loops and are restored, if unexpired, on --resume.
 *     Set PI_LOOP=off for in-memory only, or PI_LOOP=<path> for a custom store.
 *   - A cron tick that lands while the agent is busy marks the loop "due" instead
 *     of queueing a stale prompt; the fire is delivered fresh as soon as the agent
 *     goes idle. Ticks landing while already due collapse into one fire, and
 *     fireCount only counts fires that were actually delivered.
 *   - Typing while a self-paced loop waits ends it (you took over). Fixed/event
 *     loops keep running across your messages until you /loop stop them.
 */

import { join, resolve } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { extractInterval, parseInterval } from "./src/loop-parse";
import { CronScheduler } from "./src/scheduler";
import { LoopStore } from "./src/store";
import { TriggerSystem } from "./src/triggers";
import type { LoopEntry, LoopFireEvent, Trigger } from "./src/types";

const STATUS_KEY = "loop";
const TICK_MS = 1000;
const DEFAULT_DEBOUNCE_MS = 30000;

// Lifecycle events bridged onto the events bus so event/hybrid loops can target
// them by name (e.g. trigger="tool_execution_end").
const BRIDGED_EVENTS = [
	"tool_execution_start",
	"tool_execution_end",
	"turn_start",
	"turn_end",
	"agent_start",
	"agent_end",
	"message_end",
] as const;

// Model-driven self-paced loop (Claude Code /loop style): the model continues
// the loop by calling schedule_loop_wakeup at the end of its turn, and ends it
// by NOT calling it (omit-to-end). The harness does not auto-continue — this is
// a faithful test of whether a clean, model-driven prompt holds up.
const SELF_PACED_HINT =
	"\n\n[Self-paced loop: do this iteration's work, then call schedule_loop_wakeup ONCE at the end of your turn and stop — the next iteration starts on its own. Omit the call to end the loop, which is how you finish once the task is done.]";

// Forever loops: harness-driven continuation with no fixed cadence. The loop
// refires the moment the agent goes idle. Context overflow is handled by
// queueing /compact before continuing (pi's auto-compaction is the first
// line of defense; this is the fallback). Every other error is met with an
// immediate retry — nothing stops a forever loop except /loop stop.
// Mirrors pi's known context-overflow error shapes (packages/ai overflow.ts).

function textResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: undefined,
	} as AgentToolResult<unknown>;
}

function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

function describeTrigger(trigger: Trigger): string {
	switch (trigger.type) {
		case "cron":
			return `cron: ${trigger.schedule}`;
		case "event":
			return `event: ${trigger.source}`;
		case "hybrid":
			return `hybrid: ${trigger.cron} + ${trigger.event.source}`;
		case "self-paced":
			return "self-paced";
		case "forever":
			return "forever";
	}
	return "unknown";
}

function inferTriggerType(input: string): "cron" | "event" | "hybrid" {
	if (
		input.includes("hybrid") ||
		(input.includes("cron") && input.includes("event"))
	)
		return "hybrid";
	const t = input.trim();
	if (/^\d+\s*[smhd]$/i.test(t)) return "cron";
	if (t.split(/\s+/).length === 5 && /^[*\d]/.test(t)) return "cron";
	return "event";
}

export default function loopExtension(pi: ExtensionAPI) {
	const piLoopEnv = process.env.PI_LOOP;

	function resolveStorePath(sessionId?: string): string | undefined {
		if (piLoopEnv === "off") return undefined;
		if (piLoopEnv?.startsWith("/")) return piLoopEnv;
		if (piLoopEnv?.startsWith(".")) return resolve(piLoopEnv);
		if (piLoopEnv) return resolve(piLoopEnv);
		if (!sessionId) return undefined;
		return join(process.cwd(), ".pi", "loops", `loops-${sessionId}.json`);
	}

	const store = new LoopStore(resolveStorePath());

	let latestCtx: ExtensionContext | undefined;
	let latestUI: ExtensionUIContext | undefined;
	let boundSessionId: string | undefined;
	let lastSelfPacedId: string | undefined;
	const selfPacedTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Wall-clock ms a self-paced loop's next iteration will fire, so the status
	// widget can show a live countdown to the next run.
	const selfPacedFireTimes = new Map<string, number>();
	// Self-paced loops the model asked to continue THIS turn (via
	// schedule_loop_wakeup), mapped to the requested delay. Read + cleared at
	// agent_end: present → arm the next iteration; absent → the model omitted the
	// call, so the loop ends (Claude-style omit-to-end).
	const scheduledThisTurn = new Map<string, number>();
	// Self-paced loops whose iteration was actually delivered since the last
	// agent_end. Only these are candidates for omit-to-end: an agent run that has
	// nothing to do with a loop must not be read as "the model declined to
	// continue it".
	const firedSinceAgentEnd = new Set<string>();
	// Cron loops whose tick landed mid-turn; they fire when the agent goes idle.
	const dueLoops = new Set<string>();
	let ticker: ReturnType<typeof setInterval> | undefined;

	const notify = (msg: string, type: "info" | "warning" | "error" = "info") =>
		latestUI?.notify(msg, type);

	// ── Firing ────────────────────────────────────────────────────────────

	// Deliver a fire: this is the only place fireCount moves, so the count always
	// equals fires the agent actually received.
	function deliverFire(entry: LoopEntry): void {
		dueLoops.delete(entry.id);
		if (entry.trigger.type === "self-paced") firedSinceAgentEnd.add(entry.id);
		const updated =
			store.update(entry.id, { fireCount: (entry.fireCount ?? 0) + 1 }) ?? entry;

		const payload: LoopFireEvent = {
			loopId: entry.id,
			iteration: updated.fireCount ?? 1,
			prompt: entry.prompt,
			trigger: entry.trigger,
			timestamp: Date.now(),
			readOnly: entry.readOnly,
			recurring: entry.recurring,
		};
		pi.events.emit("loop:fire", payload);

		if (updated.maxFires && (updated.fireCount ?? 0) >= updated.maxFires) {
			store.setStatus(entry.id, "expired");
			triggers.remove(entry.id);
		}
		renderStatus();
	}

	function onLoopFire(entry: LoopEntry): void {
		if (entry.maxFires && (entry.fireCount ?? 0) >= entry.maxFires) {
			store.setStatus(entry.id, "expired");
			return;
		}
		if (entry.trigger.type === "self-paced") {
			lastSelfPacedId = entry.id;
			deliverFire(entry);
			return;
		}
		if (entry.trigger.type === "cron") {
			// A tick that lands mid-turn doesn't queue a stale prompt — it marks the
			// loop due, and the fire is delivered fresh once the agent goes idle.
			// Further ticks while due collapse into that one pending fire.
			const busy = latestCtx
				? !latestCtx.isIdle() || latestCtx.hasPendingMessages()
				: false;
			if (busy) {
				dueLoops.add(entry.id);
				renderStatus();
				return;
			}
			deliverFire(entry);
			return;
		}
		// event / hybrid: deliver as a follow-up to the turn that caused the event,
		// but never stack fires while one is already queued.
		if (entry.recurring && latestCtx?.hasPendingMessages()) return;
		deliverFire(entry);
	}

	const scheduler = new CronScheduler(store, onLoopFire);
	const triggers = new TriggerSystem(pi, scheduler, store, onLoopFire);

	// Turn a delivered fire into an actual user message (followUp: starts a turn
	// when idle, otherwise lands right after the current turn).
	pi.events.on("loop:fire", (raw: unknown) => {
		const data = raw as LoopFireEvent;
		const selfPaced = data.trigger.type === "self-paced";
		const hint = selfPaced ? SELF_PACED_HINT : "";
		// Self-paced loops lead with the climbing iteration count (matches the
		// status widget), so consecutive fires read as #1, #2, #3 — not the same
		// "Loop #1" repeated. Other triggers keep the stable loop id.
		const header = selfPaced
			? `[pi-loop] Iteration #${data.iteration ?? 1} (self-paced).`
			: `[pi-loop] Loop #${data.loopId} fired (${describeTrigger(data.trigger)}).`;
		const message = `${header}\n\n${data.prompt}${hint}`;
		pi.sendUserMessage(message, { deliverAs: "followUp" });
		renderStatus();
	});

	// Fire any loops that came due while the agent was busy.
	function deliverDue(): void {
		for (const id of [...dueLoops]) {
			dueLoops.delete(id);
			const entry = store.get(id);
			if (entry && entry.status === "active") deliverFire(entry);
		}
	}

	function fireSelfPacedNow(entry: LoopEntry): void {
		onLoopFire(entry);
		renderStatus();
	}

	// Arm (or re-arm) the timer that delivers a self-paced loop's next iteration,
	// as requested by the model's schedule_loop_wakeup call. Tracked in
	// selfPacedTimers so a stop cancels it cleanly.
	function armSelfPacedWakeup(id: string, delayMs: number): void {
		const existing = selfPacedTimers.get(id);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			selfPacedTimers.delete(id);
			selfPacedFireTimes.delete(id);
			const fresh = store.get(id);
			if (!fresh || fresh.status !== "active") return;
			if (Date.now() >= fresh.expiresAt) {
				stopLoop(id, "expired");
				return;
			}
			fireSelfPacedNow(fresh);
		}, delayMs);
		(timer as { unref?: () => void }).unref?.();
		selfPacedTimers.set(id, timer);
		selfPacedFireTimes.set(id, Date.now() + delayMs);
		renderStatus();
	}

	// Continuation is the MODEL's job (Claude-style): at the end of a turn, a
	// self-paced loop continues only if the model called schedule_loop_wakeup
	// (recorded in scheduledThisTurn); otherwise it ends. No harness auto-continue.
	function continueOrEndSelfPaced(): void {
		const fired = new Set(firedSinceAgentEnd);
		firedSinceAgentEnd.clear();

		for (const l of store.listActive()) {
			if (l.trigger.type !== "self-paced") continue;
			const delay = scheduledThisTurn.get(l.id);
			scheduledThisTurn.delete(l.id);
			if (delay === undefined) {
				// Omit-to-end applies only to a loop whose iteration ran in the turn
				// that just finished. A loop already waiting on an armed wakeup, or one
				// that never fired this turn (a second self-paced loop, a cron loop's
				// turn, another extension's continuation), keeps running — otherwise
				// any unrelated agent run silently deletes it.
				if (selfPacedTimers.has(l.id) || !fired.has(l.id)) continue;
				stopLoop(l.id, "loop ended — no schedule_loop_wakeup call");
				continue;
			}
			if (l.maxFires && (l.fireCount ?? 0) >= l.maxFires) {
				stopLoop(l.id, "maxFires reached");
				continue;
			}
			armSelfPacedWakeup(l.id, delay);
		}
	}

	// ── Forever loops ────────────────────────────────────────────────────


	// Refire every active forever loop the instant the agent is idle.
	function continueForever(): void {
		for (const l of store.listActive()) {
			if (l.trigger.type !== "forever") continue;
			const busy = latestCtx
				? !latestCtx.isIdle() || latestCtx.hasPendingMessages()
				: true;
			if (busy) continue;
			deliverFire(l);
		}
	}

	// ── Status widget ────────────────────────────────────────────────────────

	function renderStatus(): void {
		if (!latestUI) return;
		const active = store.listActive();
		if (active.length === 0) {
			latestUI.setStatus(STATUS_KEY, undefined);
			latestUI.setWidget(STATUS_KEY, undefined);
			stopTicker();
			return;
		}
		latestUI.setStatus(STATUS_KEY, `⟳ loop · ${active.length} active`);
		startTicker();
		const lines = active.map((l) => {
			const next = scheduler.nextFire(l.id);
			const wakeup = selfPacedFireTimes.get(l.id);
			const isSelfPaced = l.trigger.type === "self-paced";
			const isForever = l.trigger.type === "forever";
			const when = isForever
				? "refires on idle"
				: isSelfPaced
					? wakeup
						? `next in ${formatRemaining(wakeup - Date.now())}`
						: "running"
					: dueLoops.has(l.id)
						? "due — fires when agent is idle"
						: next
							? `next ${formatRemaining(next - Date.now())}`
							: l.trigger.type === "event"
								? "on event"
								: "pending";
			// Self-paced loops lead with the climbing iteration count (#1 → #2 → …) —
			// the stable loop id lives in /loop list. Other loops lead with their id
			// plus a fire tally.
			const lead = isSelfPaced ? `#${l.fireCount ?? 0}` : `#${l.id}`;
			const fires = isSelfPaced
				? ""
				: l.maxFires
					? ` ${l.fireCount ?? 0}/${l.maxFires}`
					: l.fireCount
						? ` ${l.fireCount}×`
						: "";
			return `⟳ ${lead} ${l.prompt.slice(0, 48)} — ${describeTrigger(l.trigger)} · ${when}${fires}`;
		});
		latestUI.setWidget(STATUS_KEY, lines);
	}

	function startTicker(): void {
		if (ticker) return;
		ticker = setInterval(() => renderStatus(), TICK_MS);
		(ticker as { unref?: () => void }).unref?.();
	}

	function stopTicker(): void {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	}

	// ── Loop lifecycle helpers ────────────────────────────────────────────

	function stopLoop(id: string, reason: string): boolean {
		triggers.remove(id);
		const t = selfPacedTimers.get(id);
		if (t) clearTimeout(t);
		selfPacedTimers.delete(id);
		selfPacedFireTimes.delete(id);
		scheduledThisTurn.delete(id);
		dueLoops.delete(id);
		const existed = store.delete(id);
		if (existed) {
			renderStatus();
			notify(`Loop #${id} stopped (${reason}).`);
		}
		return existed;
	}

	function activateLoop(entry: LoopEntry): void {
		triggers.add(entry);
		if (entry.trigger.type === "self-paced") fireSelfPacedNow(entry);
		if (entry.trigger.type === "forever") {
			// Kick off the first iteration right away; a mid-turn creation queues as
			// a followUp and runs the moment the current turn ends.
			deliverFire(entry);
		}
		startTicker();
		renderStatus();
	}

	function validateTrigger(trigger: Trigger): string | null {
		if (
			trigger.type === "cron" &&
			trigger.schedule.trim().split(/\s+/).length !== 5
		) {
			return `Invalid cron schedule "${trigger.schedule}". Expected 5 fields. Use "5m", "1h", or "0 9 * * 1-5".`;
		}
		if (
			trigger.type === "hybrid" &&
			trigger.cron.trim().split(/\s+/).length !== 5
		) {
			return `Invalid hybrid cron part "${trigger.cron}". Expected 5 fields.`;
		}
		if (
			(trigger.type === "event" && !trigger.source.trim()) ||
			(trigger.type === "hybrid" && !trigger.event.source.trim())
		) {
			return "Event source must be non-empty (e.g. tool_execution_end).";
		}
		return null;
	}

	// ── Tools ─────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "LoopCreate",
		label: "LoopCreate",
		description: `Schedule a repeating task that runs a prompt on a timer or when a pi event fires.

Trigger types:
- cron: time interval — "30s" (rounds to 1m), "5m", "2h", "1d", or a full cron like "0 9 * * 1-5".
- event: a pi event-bus channel — e.g. "tool_execution_end", "turn_end", "monitor:done".
- hybrid: cron + event with debounce.

Prefer LoopCreate over raw Bash sleep/while loops: it survives across turns and the scheduler owns the timing. Set maxFires on polling loops to bound token use, and call LoopDelete on a loop's own id when there's nothing left to do.`,
		promptGuidelines: [
			"Use LoopCreate for any repeating/periodic/scheduled task — never a raw Bash sleep/while loop.",
			"Default to a 5m interval unless the user asks otherwise; use event triggers when an exact pi event fits.",
			"Always set maxFires on polling loops (e.g. 20-50) to bound token usage.",
			"Tell the user the loop id so they can stop it with LoopDelete or /loop stop <id>.",
		],
		parameters: Type.Object({
			trigger: Type.String({
				description:
					'Interval ("5m", "1h", "0 9 * * *"), event source ("tool_execution_end"), or hybrid spec.',
			}),
			prompt: Type.String({ description: "Prompt to run when the loop fires." }),
			triggerType: Type.Optional(
				Type.String({
					description: "cron | event | hybrid (inferred if omitted)",
					enum: ["cron", "event", "hybrid"],
				}),
			),
			recurring: Type.Optional(
				Type.Boolean({
					description: "Repeat (default true for cron/hybrid, false for event).",
				}),
			),
			readOnly: Type.Optional(
				Type.Boolean({
					description: "Restrict the agent to read-only tools on each fire.",
				}),
			),
			maxFires: Type.Optional(
				Type.Number({ description: "Auto-stop after N fires." }),
			),
			debounceMs: Type.Optional(
				Type.Number({
					description: "Debounce for hybrid triggers (default 30000).",
				}),
			),
			filter: Type.Optional(
				Type.String({
					description:
						'Event filter: JSON match (e.g. {"monitorId":"1"}) or "regex:..."',
				}),
			),
		}),
		execute: (_id, params) => {
			if (store.atCapacity())
				return Promise.resolve(
					textResult("Maximum active loops reached (25). Delete some first."),
				);

			const inferred = params.triggerType ?? inferTriggerType(params.trigger);
			let trigger: Trigger;
			try {
				if (inferred === "cron") {
					trigger = { type: "cron", schedule: parseInterval(params.trigger).cron };
				} else if (inferred === "event") {
					trigger = {
						type: "event",
						source: params.trigger.trim(),
						filter: params.filter,
					};
				} else {
					const cronPart = params.trigger.match(/cron:?\s*(\S.*\S|\S)/)?.[1] ?? "5m";
					const eventPart =
						params.trigger.match(/event:?\s*(\S+)/)?.[1] ?? "tool_execution_end";
					trigger = {
						type: "hybrid",
						cron: parseInterval(cronPart).cron,
						event: { source: eventPart, filter: params.filter },
						debounceMs: params.debounceMs ?? DEFAULT_DEBOUNCE_MS,
					};
				}
			} catch (err) {
				return Promise.resolve(textResult((err as Error).message));
			}

			const validation = validateTrigger(trigger);
			if (validation) return Promise.resolve(textResult(validation));

			const entry = store.create(trigger, params.prompt, {
				recurring: params.recurring,
				readOnly: params.readOnly,
				maxFires: params.maxFires,
				source: "tool",
			});
			activateLoop(entry);

			return Promise.resolve(
				textResult(
					`Loop #${entry.id} created — ${describeTrigger(trigger)}\n` +
						`Recurring: ${entry.recurring}${entry.maxFires ? ` · maxFires ${entry.maxFires}` : ""}${entry.readOnly ? " · read-only" : ""}\n` +
						`Stop with LoopDelete id="${entry.id}" or /loop stop ${entry.id}.`,
				),
			);
		},
	});

	pi.registerTool({
		name: "LoopList",
		label: "LoopList",
		description:
			"List active scheduled loops with their ids, triggers, fire counts, and next-fire times.",
		parameters: Type.Object({}),
		execute: () => {
			const loops = store.list();
			if (loops.length === 0)
				return Promise.resolve(textResult("No loops configured."));
			const lines = loops.map((l) => {
				const next =
					l.trigger.type === "cron" || l.trigger.type === "hybrid"
						? scheduler.nextFire(l.id)
						: undefined;
				const wakeup =
					l.trigger.type === "self-paced" ? selfPacedFireTimes.get(l.id) : undefined;
				const when = next
					? ` · next ${formatRemaining(next - Date.now())}`
					: wakeup
						? ` · wakeup in ${formatRemaining(wakeup - Date.now())}`
						: l.trigger.type === "self-paced" && l.status === "active"
							? " · running"
							: "";
				const fires = l.fireCount ? ` · ${l.fireCount} fires` : "";
				return `#${l.id} [${l.status}] ${l.prompt.slice(0, 60)} (${describeTrigger(l.trigger)})${when}${fires}`;
			});
			return Promise.resolve(textResult(lines.join("\n")));
		},
	});

	pi.registerTool({
		name: "LoopDelete",
		label: "LoopDelete",
		description:
			"Stop a loop by id (delete), or pause it to keep it in the list without firing.",
		parameters: Type.Object({
			id: Type.String({ description: "Loop id." }),
			action: Type.Optional(
				Type.String({
					description: "delete | pause (default delete)",
					enum: ["delete", "pause"],
				}),
			),
		}),
		execute: (_id, params) => {
			const entry = store.get(params.id);
			if (!entry)
				return Promise.resolve(textResult(`Loop #${params.id} not found.`));
			// User-created loops are user-owned: the model has no authority to
			// delete or pause them (this is what previously let the model silently
			// replace a user's loop with its own). Only the user can stop them
			// (via /loop, the manager panel, or /loop stop <id>).
			if (entry.source === "command") {
				return Promise.resolve(
					textResult(
						`Loop #${params.id} was created by the user and is user-owned — you cannot modify it. Ask the user to run /loop stop ${params.id} if it should end.`,
					),
				);
			}
			if (params.action === "pause") {
				triggers.remove(params.id);
				store.setStatus(params.id, "paused");
				renderStatus();
				return Promise.resolve(textResult(`Loop #${params.id} paused.`));
			}
			stopLoop(params.id, "deleted");
			return Promise.resolve(textResult(`Loop #${params.id} deleted.`));
		},
	});

	pi.registerTool({
		name: "schedule_loop_wakeup",
		label: "Schedule Loop Wakeup",
		description: `Schedule when to resume work in this self-paced /loop — you invoked /loop to self-pace iterations of a specific task.

Call this at the end of your turn to run the next iteration. Omit the call to end the loop.

## Picking delaySeconds

- 0 — continue immediately. The default; right for ongoing local work with nothing to wait on.
- A positive value — wait that long before the next iteration, when there's no point continuing sooner: polling something external (a file, a build, a remote state) that changes on its own schedule.

Think about what you're actually waiting for, not just "how long should I sleep." If you're polling something that updates every few minutes, match the delay to that; if you're just doing the next unit of work, use 0.

## The reason field

One short sentence on what you chose and why. It's shown back to the user, so make it specific — "incremented the counter to 5" beats "continuing".`,
		promptSnippet:
			"Continue a self-paced /loop by scheduling the next iteration (omit to end).",
		promptGuidelines: [
			"In a self-paced /loop, call schedule_loop_wakeup once at the end of your turn to run the next iteration; omit it to end the loop.",
			"Use delaySeconds 0 to continue immediately, or a positive value to wait before the next iteration.",
		],
		parameters: Type.Object({
			reason: Type.Optional(
				Type.String({
					description:
						"One short, specific sentence on what you chose and why (shown to the user).",
				}),
			),
			delaySeconds: Type.Optional(
				Type.Number({
					description: "Gap before the next iteration. 0 (default) = immediately.",
				}),
			),
			loopId: Type.Optional(
				Type.String({
					description:
						"Which self-paced loop to continue (defaults to the one that just fired).",
				}),
			),
		}),
		execute: (_id, params) => {
			const targetId = params.loopId ?? lastSelfPacedId;
			const entry = targetId ? store.get(targetId) : undefined;
			if (
				!entry ||
				entry.trigger.type !== "self-paced" ||
				entry.status !== "active"
			) {
				return Promise.resolve(textResult("No active self-paced loop; ignoring."));
			}
			// One call per turn is all it takes. A weaker model that doesn't end its
			// turn after calling will call again, and again — measured at ~300 calls
			// in a single turn, which never reaches agent_end, so the iteration never
			// arms and every other loop starves waiting for the agent to go idle.
			// Answering the repeat with a plain instruction (and no second notify)
			// breaks that livelock. The cost is that a delay can't be revised
			// mid-turn, which is worth it.
			if (scheduledThisTurn.has(entry.id)) {
				return Promise.resolve(
					textResult(
						`Loop #${entry.id} is already scheduled for its next iteration. Do not call this tool again — end your turn now so the iteration can run.`,
					),
				);
			}
			// A loop that is already waiting and did not run this turn has nothing to
			// schedule. Re-arming it here would push its countdown out by the full
			// delay — and since the tool defaults to the last self-paced loop, a model
			// that calls it during someone else's turn (a cron fire, a user request)
			// postpones the iteration indefinitely. Observed live: a 60s loop that
			// fired once in four and a half minutes.
			if (!firedSinceAgentEnd.has(entry.id) && selfPacedTimers.has(entry.id)) {
				const at = selfPacedFireTimes.get(entry.id);
				const when = at ? ` in ${formatRemaining(at - Date.now())}` : " shortly";
				return Promise.resolve(
					textResult(
						`Loop #${entry.id} is already waiting for its next iteration${when}; nothing to schedule.`,
					),
				);
			}

			const delayMs = Math.max(0, Math.round((params.delaySeconds ?? 0) * 1000));
			// Record the intent; the next iteration is actually armed at agent_end (so
			// a delay=0 timer can't fire mid-turn and race the omit-to-end decision).
			scheduledThisTurn.set(entry.id, delayMs);
			if (params.reason) notify(`Loop #${entry.id}: ${params.reason}`);
			const when = delayMs ? ` in ${formatRemaining(delayMs)}` : " immediately";
			return Promise.resolve(
				textResult(
					`Loop #${entry.id} will run its next iteration${when} (after this turn).`,
				),
			);
		},
	});

	// ── Manager panel ───────────────────────────────────────────────────

	// One row per loop for the manager list: id, status, trigger, fire count,
	// next fire (cron) and a prompt preview.
	function managerLine(l: LoopEntry): string {
		const next =
			l.status === "active" &&
			(l.trigger.type === "cron" || l.trigger.type === "hybrid")
				? scheduler.nextFire(l.id)
				: undefined;
		const when = next ? ` · next ${formatRemaining(next - Date.now())}` : "";
		const status = l.status === "active" ? "active" : l.status;
		return `#${l.id} [${status}] ${describeTrigger(l.trigger)} · ${l.fireCount ?? 0}×${when} · ${l.prompt.slice(0, 48)}`;
	}

	// Inspect and manage every loop from one place: pick a loop to edit,
	// pause/resume or stop it; or stop everything. The panel closes after one
	// pick — re-open with /loop list for the next action (no in-process loop,
	// so a mock or a user can never spin it forever).
	async function manageLoops(ctx: ExtensionCommandContext): Promise<void> {
		const loops = store.list();
		if (loops.length === 0) {
			notify("All loops removed.");
			return;
		}
		const choice = await ctx.ui.select("Loops — pick one to manage", [
			...loops.map(managerLine),
			"⚠️ Stop all",
			"← Close",
		]);
		if (!choice || choice === "← Close") {
			return;
		}
		if (choice === "⚠️ Stop all") {
			const all = store.list();
			for (const l of all) stopLoop(l.id, "requested");
			notify(`Stopped ${all.length} loop${all.length === 1 ? "" : "s"}.`);
			return;
		}
		const id = choice.slice(1).split(/\s/)[0];
		await manageOne(id, ctx);
	}

	// Actions for a single loop: edit / pause-resume / stop.
	async function manageOne(
		id: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const entry = store.get(id);
		if (!entry) {
			notify(`Loop #${id} not found.`, "warning");
			return;
		}
		const actions = [
			"✏️ Edit prompt",
			entry.status === "paused" ? "▶️ Resume" : "⏸️ Pause",
			"🛑 Stop",
			"← Back",
		];
		const action = await ctx.ui.select(
			`Loop #${id} — ${entry.prompt.slice(0, 60)}`,
			actions,
		);
		if (action === "✏️ Edit prompt") {
			const updated = await ctx.ui.editor("Prompt:", entry.prompt);
			const next = typeof updated === "string" ? updated.trim() : "";
			if (!next) {
				notify("Edit cancelled (empty prompt).");
				return;
			}
			if (next === entry.prompt) {
				notify("Prompt unchanged.");
				return;
			}
			store.update(id, { prompt: next });
			notify(`Loop #${id} prompt updated — takes effect on its next fire.`);
		} else if (action === "⏸️ Pause") {
			triggers.remove(id);
			store.setStatus(id, "paused");
			renderStatus();
			notify(`Loop #${id} paused — /loop (manager) to resume.`);
		} else if (action === "▶️ Resume") {
			const fresh = store.get(id);
			if (!fresh) return;
			store.setStatus(id, "active");
			triggers.add(fresh);
			const resumed = store.get(id);
			if (!resumed) return;
			if (fresh.trigger.type === "forever") {
				// Forever loops live on the idle→fire chain, not on a timer: resume
				// must kick one immediately or it sits silent until the next agent_end.
				if (latestCtx?.isIdle() && !latestCtx.hasPendingMessages())
					deliverFire(resumed);
			} else if (fresh.trigger.type === "self-paced") {
				// Same silence hazard: pause cancelled nothing but resume arms no
				// wakeup timer (triggers.add is a no-op for self-paced), and the
				// model never gets a turn to schedule one. Fire now so it gets a
				// turn; the model then re-arms the normal way.
				fireSelfPacedNow(resumed);
			}
			renderStatus();
			notify(`Loop #${id} resumed.`);
		} else if (action === "🛑 Stop") {
			stopLoop(id, "requested");
		}
	}

	// ── /loop command ─────────────────────────────────────────────────────

	pi.registerCommand("loop", {
		description:
			"Run a prompt repeatedly: /loop [interval] <prompt>. E.g. /loop 15m check the deploy. /loop stop to end.",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			if (/\s/.test(prefix)) return null;
			// The manager panel owns stop (single + all); creation stays on the
			// command line. Bare /loop already opens the panel, so no suggestions
			// are needed.
			return null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			bindSession(ctx);

			const trimmed = args.trim();
			const first = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";

			// Stop
			if (first === "stop" || first === "off") {
				const rest = trimmed.split(/\s+/)[1]?.toLowerCase() ?? "";
				if (rest === "all") {
					const all = store.list();
					if (all.length === 0) {
						notify("No active loops.");
						return;
					}
					for (const l of all) stopLoop(l.id, "requested");
					notify(`Stopped ${all.length} loop${all.length === 1 ? "" : "s"}.`);
					return;
				}
				if (rest) {
					if (!stopLoop(rest, "requested"))
						notify(`Loop #${rest} not found.`, "warning");
					return;
				}
				// Bare /loop stop stops nothing — direct the user to the manager.
				notify(
					"Nothing stopped. Use /loop (manager), /loop stop <id>, or /loop stop all.",
				);
				return;
			}

			// Manager panel: /loop (bare) or /loop list opens it — bare is the
			// primary form; "list" stays as an alias for habit and scripts.
			if (first === "list" || !trimmed) {
				if (store.list().length === 0) {
					notify(
						"No loops. Create one: /loop 15m <prompt> or /loop forever <prompt>",
					);
					return;
				}
				await manageLoops(ctx);
				return;
			}

			if (!trimmed) {
				notify(
					"Usage: /loop [interval|forever] <prompt> · /loop (manager) · /loop stop [id|all]",
				);
				return;
			}

			const foreverMatch = trimmed.match(/^forever\s+([\s\S]+)$/i);
			if (foreverMatch) {
				const foreverPrompt = foreverMatch[1].trim();
				if (!foreverPrompt) {
					notify("Provide a prompt: /loop forever check the deploy", "warning");
					return;
				}
				const entry = store.create({ type: "forever" }, foreverPrompt, {
					recurring: true,
					source: "command",
				});
				// Forever loops don't expire after 7 days — only /loop stop ends them.
				store.update(entry.id, {
					expiresAt: Date.now() + 3650 * 24 * 60 * 60 * 1000,
				});
				activateLoop(store.get(entry.id) ?? entry);
				notify(
					`Forever loop #${entry.id} started — refires on idle and never stops. Only /loop stop ${entry.id} ends it.`,
				);
				return;
			}

			// Create: interval present → fixed cron loop; otherwise → self-paced.
			const { interval, prompt } = extractInterval(trimmed);
			if (interval) {
				if (!prompt) {
					notify("Provide a prompt: /loop 15m check the deploy", "warning");
					return;
				}
				let parsed: ReturnType<typeof parseInterval>;
				try {
					parsed = parseInterval(interval);
				} catch (err) {
					notify((err as Error).message, "error");
					return;
				}
				// User-created cron loops are also 10-year like forever: only the user
				// ends them. They're not expired by the 7-day cap.
				const entry = store.create(
					{ type: "cron", schedule: parsed.cron },
					prompt,
					{ recurring: true, source: "command" },
				);
				store.update(entry.id, {
					expiresAt: Date.now() + 3650 * 24 * 60 * 60 * 1000,
				});
				activateLoop(store.get(entry.id) ?? entry);
				notify(
					`Loop #${entry.id} started — every ${parsed.description}. /loop stop ${entry.id} to end.`,
				);
				return;
			}

			const entry = store.create({ type: "self-paced" }, prompt, {
				recurring: true,
				source: "command",
			});
			notify(
				`Auto-looping #${entry.id} started — it repeats after each turn on its own. /loop stop ${entry.id} (or the model calling LoopDelete) ends it.`,
			);
			activateLoop(entry);
		},
	});

	// ── Lifecycle ─────────────────────────────────────────────────────────

	// Bind the store, jitter seed, and timers to the current session. Runs at
	// session start (so restored loops arm and fire without waiting for the user
	// to type) and re-runs whenever the session id changes (/new, fork, resume),
	// so a new session never keeps firing the previous session's loops.
	function bindSession(ctx: ExtensionContext): void {
		latestCtx = ctx;
		latestUI = ctx.ui;
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId === boundSessionId) return;
		boundSessionId = sessionId;

		triggers.stop();
		for (const t of selfPacedTimers.values()) clearTimeout(t);
		selfPacedTimers.clear();
		selfPacedFireTimes.clear();
		scheduledThisTurn.clear();
		dueLoops.clear();

		if (piLoopEnv !== "off") {
			try {
				store.setPath(resolveStorePath(sessionId));
			} catch {
				// keep in-memory store
			}
		}
		store.clearExpired();
		scheduler.setSeed(sessionId);
		triggers.start();
		renderStatus();
	}

	function captureCtx(ctx: ExtensionContext): void {
		bindSession(ctx);
		renderStatus();
	}

	pi.on("session_start", async (_event, ctx) => bindSession(ctx));
	pi.on("before_agent_start", async (_event, ctx) => captureCtx(ctx));
	pi.on("turn_start", async (_event, ctx) => captureCtx(ctx));
	pi.on("agent_end", async (_event, ctx) => {
		captureCtx(ctx);
		deliverDue();
		continueOrEndSelfPaced();
	});

	// agent_settled = the session is truly idle (no run, no compaction, no retry,
	// no queued continuation). agent_end fires while the session still counts
	// as busy, so forever continuation must happen here — not at agent_end —
	// or the busy check would skip every fire and the loop would die after one
	// iteration.
	//
	// The loop deliberately does NOT classify errors (overflow, overload, auth —
	// none of its business). Whatever the failure, it retries when idle.
	// Compaction is likewise somebody else's job (built-in compaction or an
	// auto-compact extension); the one thing this loop must handle is the
	// moment compaction finishes: agent_settled already fired during the
	// compaction window and was skipped as busy, so re-check on completion —
	// otherwise a forever loop sleeps forever after one compaction.
	pi.on("agent_settled", async (_event, ctx) => {
		captureCtx(ctx);
		continueForever();
	});

	pi.on("session_compact", async (_event, ctx) => {
		captureCtx(ctx);
		// Compaction rewrote the context and closed its window; whatever paused
		// the loop's chain, this is a fresh idle moment — try again.
		continueForever();
	});

	// Typing while a self-paced loop is waiting ends it — you took over. Fixed and
	// event loops keep running (they fire between your turns by design).
	pi.on("input", (event) => {
		if (event.source === "interactive") {
			for (const l of store.listActive()) {
				if (l.trigger.type === "self-paced") stopLoop(l.id, "you took over");
			}
		}
		return { action: "continue" };
	});

	// Bridge selected lifecycle events onto the bus for event/hybrid triggers.
	// Cast past the per-event overloads — we only need a uniform (name, data) shape.
	// SAFETY: pi.on's typed overloads only accept the known event names; we
	// deliberately bridge a fixed list of lifecycle names with a uniform
	// (name, data) shape, which the overloads cannot express.
	const onAny = pi.on.bind(pi) as unknown as (
		event: string,
		handler: (data: unknown) => void,
	) => void;
	for (const ev of BRIDGED_EVENTS) {
		onAny(ev, (data: unknown) => pi.events.emit(ev, data));
	}

	pi.on("session_shutdown", async () => {
		triggers.stop();
		for (const t of selfPacedTimers.values()) clearTimeout(t);
		selfPacedTimers.clear();
		selfPacedFireTimes.clear();
		scheduledThisTurn.clear();
		dueLoops.clear();
		stopTicker();
	});
}
