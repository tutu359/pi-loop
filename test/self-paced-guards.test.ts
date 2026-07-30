// Guards around the model-driven self-paced loop.
//
// Two failures these cover, both found by driving a real session against a
// local model:
//
//   1. continueOrEndSelfPaced ran on EVERY agent_end and ended any self-paced
//      loop that hadn't been re-scheduled during that particular turn — so a
//      loop waiting on a delayed wakeup, a second self-paced loop, or one
//      sharing a session with a cron loop (or another extension that drives
//      turns) was silently deleted mid-wait, orphaning its armed timer.
//
//   2. A model that calls schedule_loop_wakeup but doesn't end its turn calls
//      it again — ~300 times in one turn, measured. agent_end never arrives, so
//      the iteration never arms and every other loop starves waiting for idle.
//      A repeat call now answers with a plain "end your turn" instruction.

process.env.PI_LOOP = "off";

import assert from "node:assert/strict";
import { test } from "node:test";

const { default: loopExtension } = await import("../loop");

function makeEvents() {
	const handlers = new Map<string, Set<(d: unknown) => void>>();
	return {
		on(name: string, fn: (d: unknown) => void) {
			let set = handlers.get(name);
			if (!set) handlers.set(name, (set = new Set()));
			set.add(fn);
			return () => set!.delete(fn);
		},
		emit(name: string, payload: unknown) {
			for (const fn of handlers.get(name) ?? []) fn(payload);
		},
	};
}

function setup() {
	const sent: Array<{ msg: string; opts: unknown }> = [];
	const notes: string[] = [];
	const lifecycle = new Map<string, Array<(ev: unknown, ctx: unknown) => unknown>>();
	// biome-ignore lint/suspicious/noExplicitAny: mock shape
	const tools = new Map<string, any>();
	// biome-ignore lint/suspicious/noExplicitAny: mock shape
	let command: any;
	const events = makeEvents();

	// biome-ignore lint/suspicious/noExplicitAny: mock shape
	const pi: any = {
		events,
		// biome-ignore lint/suspicious/noExplicitAny: mock shape
		on(event: string, handler: any) {
			let arr = lifecycle.get(event);
			if (!arr) lifecycle.set(event, (arr = []));
			arr.push(handler);
		},
		sendUserMessage(msg: string, opts: unknown) { sent.push({ msg, opts }); },
		// biome-ignore lint/suspicious/noExplicitAny: mock shape
		registerTool(def: any) { tools.set(def.name, def); },
		// biome-ignore lint/suspicious/noExplicitAny: mock shape
		registerCommand(name: string, def: any) { if (name === "loop") command = def; },
	};
	loopExtension(pi);

	// biome-ignore lint/suspicious/noExplicitAny: mock shape
	const ctx: any = {
		ui: { notify: (m: string) => notes.push(m), setStatus() {}, setWidget() {}, select: async () => "" },
		hasUI: true,
		cwd: "/tmp/pi-loop-test",
		sessionManager: { getSessionId: () => "test-session" },
		modelRegistry: {},
		model: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
		abort() {}, shutdown() {}, getContextUsage() {}, compact() {},
		getSystemPrompt: () => "",
	};

	const dispatch = async (event: string, ev?: unknown) => {
		for (const h of lifecycle.get(event) ?? []) await h(ev ?? { type: event }, ctx);
	};
	const callTool = async (name: string, params: unknown) => {
		const res = await tools.get(name).execute("call-id", params);
		// biome-ignore lint/suspicious/noExplicitAny: mock shape
		return res.content.map((c: any) => c.text).join("\n");
	};
	return { sent, notes, command, ctx, dispatch, callTool };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// ── 1. Unrelated agent runs must not end a loop ──────────────────────────────

test("a loop waiting on a delayed wakeup survives an unrelated agent run", async () => {
	const { command, ctx, dispatch, callTool } = setup();
	await command.handler("poll the build", ctx);

	await callTool("schedule_loop_wakeup", { delaySeconds: 300 });
	await dispatch("agent_end"); // arms the 5-minute wakeup
	await tick();

	// Another turn happens during the wait — a cron loop firing, another
	// extension's continuation, anything.
	await dispatch("agent_end");
	await tick();

	const list = await callTool("LoopList", {});
	assert.doesNotMatch(list, /No loops configured/i, "the waiting loop still exists");
	assert.match(list, /wakeup in/i, "its wakeup is still armed");
});

// Omit-to-end is per loop: each loop that fired this turn needs its own call.
// The repeat-call guard is keyed by loop id, so continuing two loops in one turn
// is two accepted calls, not a call plus a rejected repeat.
test("two self-paced loops both continue when each is scheduled by id", async () => {
	const { command, ctx, dispatch, callTool } = setup();
	await command.handler("loop A work", ctx);
	await command.handler("loop B work", ctx);

	const a = await callTool("schedule_loop_wakeup", { delaySeconds: 0, loopId: "1" });
	const b = await callTool("schedule_loop_wakeup", { delaySeconds: 0, loopId: "2" });
	assert.match(a, /next iteration/i, "loop #1 scheduled");
	assert.match(b, /next iteration/i, "loop #2 scheduled — not rejected as a repeat");

	await dispatch("agent_end");
	await tick();

	const list = await callTool("LoopList", {});
	assert.match(list, /#1/, "loop #1 continues");
	assert.match(list, /#2/, "loop #2 continues");
});

// A loop mid-wait is not a loop the model declined to continue.
test("a waiting loop survives a turn that continued a different self-paced loop", async () => {
	const { command, ctx, dispatch, callTool } = setup();
	await command.handler("slow poll", ctx);
	await callTool("schedule_loop_wakeup", { delaySeconds: 300, loopId: "1" });
	await dispatch("agent_end"); // #1 now waiting on an armed wakeup
	await tick();

	await command.handler("fast work", ctx);
	await callTool("schedule_loop_wakeup", { delaySeconds: 0, loopId: "2" });
	await dispatch("agent_end");
	await tick();

	const list = await callTool("LoopList", {});
	assert.match(list, /#1/, "the waiting loop is untouched");
	assert.match(list, /#2/, "the continued loop keeps going");
});

test("a cron loop's turn does not end a waiting self-paced loop", async () => {
	const { command, ctx, dispatch, callTool } = setup();
	await callTool("LoopCreate", { trigger: "5m", prompt: "poll CI" });
	await command.handler("do local work", ctx);

	await callTool("schedule_loop_wakeup", { delaySeconds: 120 });
	await dispatch("agent_end");
	await tick();

	// The cron loop fires later; that turn ends with no wakeup call.
	await dispatch("agent_end");
	await tick();

	const list = await callTool("LoopList", {});
	assert.match(list, /self-paced/, "the waiting self-paced loop survives");
	assert.match(list, /cron/, "the cron loop is untouched");
});

// The omit-to-end contract still has to hold for the loop that actually ran.
test("the loop that ran this turn still ends when the model omits the call", async () => {
	const { sent, command, ctx, dispatch, callTool } = setup();
	await command.handler("grind", ctx);
	assert.equal(sent.length, 1);

	await dispatch("agent_end");
	await tick();

	assert.equal(sent.length, 1, "no continuation");
	const list = await callTool("LoopList", {});
	assert.match(list, /No loops configured/i, "the loop ended");
});

// ── 2. Repeat wakeup calls in one turn ───────────────────────────────────────

test("a repeat wakeup call in the same turn tells the model to end its turn", async () => {
	const { command, ctx, callTool } = setup();
	await command.handler("poll something", ctx);

	const first = await callTool("schedule_loop_wakeup", { delaySeconds: 0, reason: "continuing" });
	assert.match(first, /next iteration/i);

	const second = await callTool("schedule_loop_wakeup", { delaySeconds: 0, reason: "continuing" });
	assert.match(second, /already scheduled/i);
	assert.match(second, /do not call this tool again/i);
	assert.match(second, /end your turn/i);
});

test("repeat wakeup calls do not spam the user with notifications", async () => {
	const { notes, command, ctx, callTool } = setup();
	await command.handler("poll something", ctx);
	notes.length = 0;

	for (let i = 0; i < 5; i++) {
		await callTool("schedule_loop_wakeup", { delaySeconds: 0, reason: "checking again" });
	}

	const reasonNotes = notes.filter((n) => n.includes("checking again"));
	assert.equal(reasonNotes.length, 1, "only the call that actually scheduled notifies");
});

test("a repeat call does not change the already-scheduled delay", async () => {
	const { sent, command, ctx, dispatch, callTool } = setup();
	await command.handler("poll something", ctx);

	await callTool("schedule_loop_wakeup", { delaySeconds: 300 });
	await callTool("schedule_loop_wakeup", { delaySeconds: 0 }); // ignored
	await dispatch("agent_end");
	await tick();

	assert.equal(sent.length, 1, "still waiting on the original 5-minute delay");
});

test("the next turn can schedule again", async () => {
	const { sent, command, ctx, dispatch, callTool } = setup();
	await command.handler("grind", ctx);

	await callTool("schedule_loop_wakeup", { delaySeconds: 0 });
	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 2, "second iteration fired");

	// New turn, new call — not treated as a repeat.
	const again = await callTool("schedule_loop_wakeup", { delaySeconds: 0 });
	assert.match(again, /next iteration/i, "a fresh turn schedules normally");
	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 3, "third iteration fired");
});

// ── 3. A waiting loop must not be postponed by calls from other turns ────────

test("scheduling a loop that is already waiting does not push its countdown out", async () => {
	const { sent, command, ctx, dispatch, callTool } = setup();
	await command.handler("slow poll", ctx);

	// Arm a short wakeup, then have a later turn try to re-schedule it far out.
	// If the call re-armed the timer, the pending iteration would be pushed to
	// five minutes and never fire inside this test.
	await callTool("schedule_loop_wakeup", { delaySeconds: 0.3 });
	await dispatch("agent_end");
	await tick();
	assert.equal(sent.length, 1, "still waiting on the 300ms wakeup");

	const res = await callTool("schedule_loop_wakeup", { delaySeconds: 300 });
	assert.match(res, /already waiting/i);
	assert.match(res, /nothing to schedule/i);
	await dispatch("agent_end");

	await new Promise((r) => setTimeout(r, 500));
	assert.equal(sent.length, 2, "the original wakeup fired on its own schedule");
});

test("a loop with no armed wakeup can still be scheduled", async () => {
	const { command, ctx, callTool } = setup();
	await command.handler("work", ctx);
	// Fired this turn, nothing armed yet — the normal path.
	const res = await callTool("schedule_loop_wakeup", { delaySeconds: 0 });
	assert.match(res, /next iteration/i);
});

// ── 4. The fire hint ─────────────────────────────────────────────────────────

test("the self-paced hint asks for one call and does not forbid stopping", async () => {
	const { sent, command, ctx } = setup();
	await command.handler("count to ten", ctx);

	assert.match(sent[0].msg, /ONCE at the end of your turn/i, "asks for a single call");
	assert.match(sent[0].msg, /Omit the call to end the loop/i, "omit-to-end is stated");
	assert.doesNotMatch(sent[0].msg, /will not stop/i, "nothing tells the model it may never stop");
});
