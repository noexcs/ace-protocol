#!/usr/bin/env node
/**
 * Verify the browser half: `lib/client.js` as the module loader would load it, against a faithful fake of the
 * seat contract it depends on.
 *
 * This test exists because its absence shipped a boot failure: the chip registered into a seat that is not
 * declared yet at web boot, the registration threw while the client entry was activating, and the desktop app
 * refused to start. So the fake below reproduces that contract exactly — `register` into an undeclared seat
 * **throws**, `inject` waits — and the assertions are the properties that matter:
 *
 * 1. the entry activates no matter what the seat or the slots service does (a chip must never stop the app),
 * 2. when the seat does appear, exactly one contribution lands in it, and
 * 3. the component is total and never overclaims: before a read answers it says `ACE …`, a read that fails
 *    says `ACE !`, `ACE off` appears only when the host's own answer reports no channel, and a live session
 *    shows the channel tail.
 *
 * No browser and no host are involved: `window.__ModuleLoader__`, `require("react")` and `fetch` are stubs.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
async function scenario(name, body) {
	try {
		const detail = await body();
		results.push({ name, ok: true });
		console.log(`  ok    ${name}${detail === undefined ? "" : ` — ${detail}`}`);
	} catch (error) {
		results.push({ name, ok: false });
		console.log(`  FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The seat the chip contributes to, and the route it reads. Asserted as literals on purpose. */
const SEAT = "conversation.input.left";
const ROUTE = "api/ace.status";

/** The React implementation the component under test uses; the renderer swaps the delegate per pass. */
let reactImpl;

/** A tiny React that keeps hooks across explicit render passes and queues an effect once per hook. */
function makeRenderer(component, props) {
	const hooks = [];
	const ran = new Set();
	let cursor = 0;
	let queued = [];

	reactImpl = {
		createElement: (type, elementProps, ...children) => ({
			type,
			props: elementProps ?? {},
			children: children.flat(),
		}),
		useState: (initial) => {
			const index = cursor++;
			if (!(index in hooks)) hooks[index] = initial;
			return [
				hooks[index],
				(value) => {
					hooks[index] = typeof value === "function" ? value(hooks[index]) : value;
				},
			];
		},
		useEffect: (effect) => {
			const index = cursor++;
			if (ran.has(index)) return;
			ran.add(index);
			queued.push(effect);
		},
	};

	return {
		/** One render pass; the element it returns reflects the state as of now. */
		render() {
			cursor = 0;
			queued = [];
			return component(props);
		},
		/** Run the effects that pass queued (once per hook), let their promises settle, then unmount them. */
		async runEffects() {
			const effects = queued;
			queued = [];
			const cleanups = effects.map((effect) => effect()).filter((cleanup) => typeof cleanup === "function");
			await new Promise((resolve) => setTimeout(resolve, 0));
			// A mounted chip polls on an interval; leaving it mounted would keep this process alive forever.
			for (const cleanup of cleanups) cleanup();
		},
	};
}

/** Every text node in a rendered element tree, joined. */
function textOf(node) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join(" ");
	return textOf(node.children ?? []);
}

/** Load the bundle the way the browser module loader does, and hand back its exports. */
async function loadBundle() {
	let entry;
	const original = globalThis.window;
	globalThis.window = { __ModuleLoader__: { load: (value) => (entry = value) } };
	try {
		await import(`${join(root, "lib", "client.js")}?t=${Date.now()}`);
	} finally {
		globalThis.window = original;
	}
	if (entry === undefined) throw new Error("the bundle did not call window.__ModuleLoader__.load");
	if (entry.id !== "ace-dsh") throw new Error(`loader id is ${JSON.stringify(entry.id)}`);
	// A stable stub: the component captures *this* object at factory time, so a pass swaps the delegate
	// underneath it rather than the object the component already holds.
	const reactStub = {
		createElement: (...args) => reactImpl.createElement(...args),
		useState: (...args) => reactImpl.useState(...args),
		useEffect: (...args) => reactImpl.useEffect(...args),
	};
	return entry.factory((id) => {
		if (id !== "react") throw new Error(`unexpected require(${JSON.stringify(id)})`);
		return reactStub;
	});
}

/** A fake Slots service with the real contract: register into an undeclared seat throws. */
function fakeSlots() {
	const declared = new Set();
	const waiting = new Map();
	const registered = [];
	const slots = {
		inject: (seat, factory) => {
			// `register` records the contribution; `inject` only runs the factory, and never records for it.
			if (declared.has(seat)) factory();
			else waiting.set(seat, [...(waiting.get(seat) ?? []), factory]);
			return () => {};
		},
		register: (entry, component) => {
			if (!declared.has(entry.name)) throw new Error(`slots: no slot named ${JSON.stringify(entry.name)}`);
			registered.push({ entry, component });
			return () => {};
		},
	};
	return {
		slots,
		registered,
		/** The owner declares the seat: whatever waited on it now runs. */
		declare: (seat) => {
			declared.add(seat);
			const pending = waiting.get(seat) ?? [];
			waiting.delete(seat);
			for (const factory of pending) factory();
		},
	};
}

/** A host context as the client plugin sees it. */
function fakeClientContext(slots, options = {}) {
	const effects = [];
	const broken = {
		inject: () => {
			throw new Error("slots service is unavailable");
		},
		register: () => {
			throw new Error("slots service is unavailable");
		},
	};
	return {
		effects,
		ctx: {
			slots: options.breakingSlots ? broken : slots,
			effect: (callback, label) => {
				effects.push({ label, dispose: callback() });
				return () => {};
			},
		},
	};
}

const bundle = await loadBundle();
if (bundle.inject?.join(",") !== "slots") throw new Error(`unexpected inject list: ${JSON.stringify(bundle.inject)}`);
if (typeof bundle.apply !== "function") throw new Error("the bundle exports no apply()");

console.log(`ACE browser-half verification · inject=${bundle.inject.join(",")} · seat ${SEAT}`);

await scenario("the entry activates even though the seat does not exist yet", async () => {
	const seats = fakeSlots();
	const { ctx, effects } = fakeClientContext(seats.slots);

	bundle.apply(ctx);

	if (effects.length !== 1) throw new Error(`expected one effect, saw ${effects.length}`);
	if (seats.registered.length !== 0) throw new Error("registered into a seat that was never declared");
	return "registered interest only, nothing threw";
});

await scenario("the contribution lands when the owner declares the seat", async () => {
	const seats = fakeSlots();
	const { ctx } = fakeClientContext(seats.slots);

	bundle.apply(ctx);
	seats.declare(SEAT);

	if (seats.registered.length !== 1) throw new Error(`expected one contribution, saw ${seats.registered.length}`);
	const { entry, component } = seats.registered[0];
	if (entry.name !== SEAT) throw new Error(`entry name ${entry.name}`);
	if (entry.id !== "ace-dsh-channel") throw new Error(`entry id ${entry.id}`);
	if (typeof entry.order !== "number") throw new Error("entry order is not a number");
	if (typeof component !== "function") throw new Error("the contribution is not a component");
	return `${entry.name} id=${entry.id} order=${entry.order}`;
});

await scenario("a broken slots service cannot fail the entry", async () => {
	const { ctx } = fakeClientContext(undefined, { breakingSlots: true });

	// The whole point of the fail-safe: this must not throw, or the app refuses to boot.
	bundle.apply(ctx);
	return "apply() survived a throwing slots service";
});

await scenario("the chip paints no claim, then the channel tail the route reported", async () => {
	const seats = fakeSlots();
	const { ctx } = fakeClientContext(seats.slots);
	bundle.apply(ctx);
	seats.declare(SEAT);
	const { component } = seats.registered[0];

	const channel = "ace:noexcs:dsh:session-abcdef123456";
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return { ok: true, json: async () => ({ live: true, channels: [channel], servers: ["local"] }) };
	};
	try {
		const renderer = makeRenderer(component, { sessionId: "s" });
		const before = textOf(renderer.render());
		// Before any read answers, the chip must not claim a state: it says so, rather than "off".
		if (before.includes("ACE off")) throw new Error(`first paint claims a state: ${JSON.stringify(before)}`);
		if (!before.includes("ACE …")) throw new Error(`first paint reads ${JSON.stringify(before)}`);

		await renderer.runEffects();
		const after = textOf(renderer.render());
		if (!after.includes("123456")) throw new Error(`after the read it reads ${JSON.stringify(after)}`);
		if (calls.length !== 1) throw new Error(`expected one read, saw ${calls.length}`);
		if (calls[0] !== `${ROUTE}?session=s`) {
			throw new Error(`read ${calls[0]}, expected the document-relative ${ROUTE}?session=s`);
		}
		return `${before.trim()} → ${after.trim()}`;
	} finally {
		globalThis.fetch = originalFetch;
	}
});

await scenario("an answer that reports no channel reads as off", async () => {
	const seats = fakeSlots();
	const { ctx } = fakeClientContext(seats.slots);
	bundle.apply(ctx);
	seats.declare(SEAT);
	const { component } = seats.registered[0];

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ live: false, channels: [], servers: [] }) });
	try {
		const renderer = makeRenderer(component, { sessionId: "s" });
		renderer.render();
		await renderer.runEffects();
		const text = textOf(renderer.render());
		if (!text.includes("ACE off")) throw new Error(`reads ${JSON.stringify(text)}`);
		return "off, because the host said so";
	} finally {
		globalThis.fetch = originalFetch;
	}
});

await scenario("a route that never answers reads as cannot-tell, and does not throw", async () => {
	const seats = fakeSlots();
	const { ctx } = fakeClientContext(seats.slots);
	bundle.apply(ctx);
	seats.declare(SEAT);
	const { component } = seats.registered[0];

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("no carrier");
	};
	try {
		const renderer = makeRenderer(component, { sessionId: "s" });
		renderer.render();
		await renderer.runEffects();
		const text = textOf(renderer.render());
		if (!text.includes("ACE !")) throw new Error(`reads ${JSON.stringify(text)}`);
		if (text.includes("ACE off")) throw new Error("a failed read claimed the session is off");
		return "cannot tell, no throw";
	} finally {
		globalThis.fetch = originalFetch;
	}
});

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
// Explicit: a leaked timer from the component under test must not hang a verification run.
process.exit(failed.length === 0 ? 0 : 1);
