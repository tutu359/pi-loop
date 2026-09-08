// Loop manager panel + stop semantics.
//
// Covers the redesigned loop management:
//   - /loop stop with no args stops NOTHING (explicit all / id / panel only)
//   - /loop stop all stops every loop (including paused and forever)
//   - /loop stop <id> stops exactly that loop
//   - the manager panel edits prompt, pauses, resumes, stops
//   - forever loops cannot be edited by the model (LoopDelete refused),
//     but the user CAN edit them via the panel

process.env.PI_LOOP = "off";

const { default: loopExtension } = await import("../loop");

import { strict as assert } from "node:assert";
import { test } from "node:test";

await import("../loop");

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

function setup(uiOverrides: Record<string, unknown> = {}) {
	const sent: Array<{ msg: string; opts: unknown }> = [];
	const notes: string[] = [];
	const lifecycle = new Map<
		string,
		Array<(ev: unknown, ctx: unknown) => unknown>
	>();
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
		sendUserMessage(msg: string, opts: unknown) {
			sent.push({ msg, opts });
		},
		// biome-ignore lint/suspicious/noExplicitAny: mock shape
		registerTool(def: any) {
			tools.set(def.name, def);
		},
		// biome-ignore lint/suspicious/noExplicitAny: mock shape
		registerCommand(name: string, def: any) {
			if (name === "loop") command = def;
		},
	};

	// biome-ignore lint/suspicious/noExplicitAny: mock shape
	const ctx: any = {
		ui: {
			notify: (m: string) => notes.push(m),
			setStatus() {},
			setWidget() {},
			select: async () => "",
			editor: async (_title: string, prefill: string) => prefill,
			...uiOverrides,
		},
		hasUI: true,
		cwd: "/tmp/pi-loop-test",
		sessionManager: { getSessionId: () => "test-session" },
		modelRegistry: {},
		model: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
		abort() {},
		shutdown() {},
		getContextUsage() {},
		compact() {},
		getSystemPrompt: () => "",
	};

	const dispatch = async (event: string, ev?: unknown) => {
		for (const h of lifecycle.get(event) ?? [])
			await h(ev ?? { type: event }, ctx);
	};
	const callTool = async (name: string, params: unknown) => {
		const res = await tools.get(name).execute("call-id", params);
		// biome-ignore lint/suspicious/noExplicitAny: mock shape
		return res.content.map((c: any) => c.text).join("\n");
	};
	loopExtension(pi);
	return { sent, notes, command, ctx, dispatch, callTool };
}

// ── stop semantics ───────────────────────────────────────────────────────────

test("bare /loop stop stops nothing", async () => {
	const { command, ctx, notes, callTool } = setup();
	await command.handler("forever do work", ctx);
	await command.handler("15m poll things", ctx);

	await command.handler("stop", ctx);

	const list = await callTool("LoopList", {});
	assert.match(list, /#1/);
	assert.match(list, /#2/);
	assert.match(notes.join("\n"), /Nothing stopped/);
});

test("/loop stop <id> stops exactly that loop", async () => {
	const { command, ctx, callTool } = setup();
	await command.handler("forever do work", ctx);
	await command.handler("15m poll things", ctx);

	await command.handler("stop 1", ctx);

	const list = await callTool("LoopList", {});
	assert.doesNotMatch(list, /#1 /);
	assert.match(list, /#2/);
});

test("/loop stop all stops every loop including forever", async () => {
	const { command, ctx, callTool } = setup();
	await command.handler("forever do work", ctx);
	await command.handler("15m poll things", ctx);
	await command.handler("30m third task", ctx);

	await command.handler("stop all", ctx);

	const list = await callTool("LoopList", {});
	assert.match(list, /No loops configured/i);
});

test("stop all with no loops is a no-op", async () => {
	const { command, ctx, notes } = setup();
	await command.handler("stop all", ctx);
	assert.match(notes.join("\n"), /No active loops/i);
});

// ── manager panel ────────────────────────────────────────────────────────────

test("panel: stop action removes the loop", async () => {
	const selects: string[][] = [];
	// biome-ignore lint/suspicious/noExplicitAny: mock shape
	const { command, ctx, callTool } = setup({
		select: async (_title: string, items: string[]) => {
			selects.push(items);
			if (selects.length === 1) return items[0]; // pick loop #1
			return "🛑 Stop"; // then stop it
		},
	});
	await command.handler("forever do work", ctx);
	await command.handler("list", ctx);

	const list = await callTool("LoopList", {});
	assert.match(list, /No loops configured/i);
});

test("panel: edit updates the prompt, id and fires kept", async () => {
	const selects: string[][] = [];
	// biome-ignore lint/suspicious/noExplicitAny: mock shape
	const { command, ctx, callTool } = setup({
		select: async (_title: string, items: string[]) => {
			selects.push(items);
			if (selects.length === 1) return items[0]; // pick loop #1
			return "✏️ Edit prompt";
		},
		editor: async () => "brand new task",
	});
	await command.handler("forever original task", ctx);
	await command.handler("list", ctx);

	const list = await callTool("LoopList", {});
	assert.match(list, /brand new task/);
	assert.match(list, /forever/); // trigger type preserved
});

test("panel: empty edit is a cancel, prompt unchanged", async () => {
	const selects: string[][] = [];
	// biome-ignore lint/suspicious/noExplicitAny: mock shape
	const { command, ctx, callTool } = setup({
		select: async (_t: string, items: string[]) => {
			selects.push(items);
			if (selects.length === 1) return items[0];
			return "✏️ Edit prompt";
		},
		editor: async () => "   ",
	});
	await command.handler("forever keep me", ctx);
	await command.handler("list", ctx);

	const list = await callTool("LoopList", {});
	assert.match(list, /keep me/);
});

test("panel: pause then resume keeps the loop alive", async () => {
	const picks: string[] = ["⏸️ Pause", "▶️ Resume"];
	let round = 0;
	// biome-ignore lint/suspicious/noExplicitAny: mock shape
	const { command, ctx, callTool } = setup({
		select: async (_t: string, items: string[]) => {
			if (items.some((i) => i.startsWith("#"))) return items[0]; // always pick loop #1
			return picks[round++];
		},
	});
	await command.handler("forever do work", ctx);
	await command.handler("list", ctx); // pause

	let list = await callTool("LoopList", {});
	assert.match(list, /\[paused\]/);

	await command.handler("list", ctx); // resume
	list = await callTool("LoopList", {});
	assert.match(list, /\[active\]/);
});

test("panel: pause a forever loop and resume fires it again when idle", async () => {
	const picks: string[] = ["⏸️ Pause", "▶️ Resume"];
	let round = 0;
	const { command, ctx, sent } = setup({
		select: async (_t: string, items: string[]) => {
			if (items.some((i) => i.startsWith("#"))) return items[0];
			return picks[round++];
		},
	});
	await command.handler("forever do work", ctx);
	sent.length = 0; // drop the initial creation fire

	await command.handler("list", ctx); // pause
	assert.equal(sent.length, 0);

	await command.handler("list", ctx); // resume → immediate refire
	assert.ok(
		sent.some((s) => s.msg.includes("[pi-loop]")),
		"forever refires on resume",
	);
});

test("panel: stop all entry clears everything", async () => {
	// biome-ignore lint/suspicious/noExplicitAny: mock shape
	const { command, ctx, callTool } = setup({
		select: async () => "⚠️ Stop all",
	});
	await command.handler("forever one", ctx);
	await command.handler("15m two", ctx);

	await command.handler("list", ctx);

	const list = await callTool("LoopList", {});
	assert.match(list, /No loops configured/i);
});

// ── forever guardrails unchanged ─────────────────────────────────────────────

test("model still cannot pause or delete a forever loop", async () => {
	const { command, ctx, callTool } = setup();
	await command.handler("forever do work", ctx);

	const del = await callTool("LoopDelete", { id: "1" });
	assert.match(del, /created by the user/i);
	const paused = await callTool("LoopDelete", { id: "1", action: "pause" });
	assert.match(paused, /created by the user/i);
});

// ── user-owned cron loops (guardrail widened to all command-created loops) ──

test("model cannot pause or delete a user-created cron loop either", async () => {
	const { command, ctx, callTool } = setup();
	await command.handler("15m poll things", ctx);

	const del = await callTool("LoopDelete", { id: "1" });
	assert.match(del, /created by the user/i);
	const paused = await callTool("LoopDelete", { id: "1", action: "pause" });
	assert.match(paused, /created by the user/i);
});

test("user-created cron loop gets the 10-year expiry, like forever", async () => {
	const { command, ctx, callTool } = setup();
	await command.handler("15m poll things", ctx);
	const list = await callTool("LoopList", {});
	assert.match(list, /#1/);
	assert.doesNotMatch(list, /expired/i);
});
