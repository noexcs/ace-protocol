import { type JsonObject, validateToolArguments } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { ResolvedServer } from "../../src/runtime/ace-config.ts";
import {
	rejectUnknownArguments,
	resolveChannelTarget,
	resolvePublishTargets,
	type TargetServer,
	validatePublishInput,
} from "../../src/tools/publish.ts";
import { PUBLISH_PARAMETERS, TOOL_ARGUMENTS } from "../../src/tools/spec.ts";

/**
 * `resolveChannelTarget` is the one implementation of the `channel` rules every host shares. It used
 * to live twice (once per host) and the two copies had the defects these tests pin: a `<server>:`
 * prefix was matched only against *live* servers, so the prefix of a server that was down was
 * swallowed as a short name and the event was published to another server under a mangled name; and a
 * full name was accepted by the single live server whatever namespace it named, so an event for a
 * namespace nobody owned reported success while no configured server could ever store it.
 */

function server(name: string, namespace: string): ResolvedServer {
	return { name, url: `redis://${name}:6379/0`, namespace };
}

function live(entry: ResolvedServer, channels: readonly string[] = []): TargetServer {
	return {
		server: entry,
		sender: `${entry.namespace}:ana:oh-my-pi:sess`,
		list: async () => channels.map((channel) => ({ channel, description: "", expiresAt: Number.MAX_SAFE_INTEGER })),
	};
}

const local = server("local", "ace");
const second = server("second", "ace2");
const configured = [local, second];

describe("resolveChannelTarget: <server>: prefix", () => {
	it("fails when the named server is configured but did not come up, instead of completing it as a short name", async () => {
		await expect(
			resolveChannelTarget({ name: "second:remote", active: [live(local)], configured, username: "ana" }),
		).rejects.toThrow('server "second" did not come up (it is configured in .ace.json but is not reachable)');
	});

	it("completes the channel on the named server when it is live", async () => {
		const target = await resolveChannelTarget({
			name: "local:remote",
			active: [live(local)],
			configured,
			username: "ana",
		});
		expect(target.server.name).toBe("local");
		expect(target.channel).toBe("ace:ana:remote");
	});

	it("fails a two-segment remainder instead of completing it under the server's namespace", async () => {
		// The reported spelling: `second:noexcs:remote` used to become `ace2:noexcs:noexcs:remote` — a
		// channel nobody can read, reported as a successful publish with only a soft warning.
		await expect(
			resolveChannelTarget({
				name: "second:noexcs:remote",
				active: [live(local), live(second)],
				configured,
				username: "ana",
			}),
		).rejects.toThrow(
			'after the server prefix "second", "noexcs:remote" is a two-segment name and reads two ways — a local ' +
				"name that contains a colon, or a full name with its namespace left off; write the full name " +
				'"<ns>:<username>:<name>" or a one-segment name on "second"',
		);
	});

	it("fails the other two-segment spelling, a remainder that looks like a completed short name", async () => {
		await expect(
			resolveChannelTarget({ name: "local:ace:inbox", active: [live(local)], configured, username: "ana" }),
		).rejects.toThrow('after the server prefix "local", "ace:inbox" is a two-segment name');
	});

	it("still takes three or more segments after the prefix as written", async () => {
		const target = await resolveChannelTarget({
			name: "local:ace2:ana:remote",
			active: [live(local)],
			configured,
			username: "ana",
		});
		expect(target.server.name).toBe("local");
		expect(target.channel).toBe("ace2:ana:remote");
	});

	it("fails an empty remainder rather than completing it to an empty name", async () => {
		await expect(
			resolveChannelTarget({ name: "local:", active: [live(local)], configured, username: "ana" }),
		).rejects.toThrow('ace_publish `channel` "local:" has an empty segment');
	});
});

describe("resolveChannelTarget: full names and namespaces", () => {
	it("accepts a full name whose namespace is owned by a live server, as written", async () => {
		const target = await resolveChannelTarget({
			name: "ace:ana:topic",
			active: [live(local)],
			configured,
			username: "ana",
		});
		expect(target.server.name).toBe("local");
		expect(target.channel).toBe("ace:ana:topic");
	});

	it("fails a full name whose namespace belongs to a configured server that is down", async () => {
		await expect(
			resolveChannelTarget({ name: "ace2:ana:remote", active: [live(local)], configured, username: "ana" }),
		).rejects.toThrow(
			'namespace "ace2" belongs to server "second", which did not come up (it is configured in .ace.json but is not reachable)',
		);
	});

	it("fails a full name whose namespace no configured server owns", async () => {
		await expect(
			resolveChannelTarget({ name: "ghost:ana:whatever", active: [live(local)], configured, username: "ana" }),
		).rejects.toThrow('no configured server owns namespace "ghost", so nothing will store or deliver this event');
	});

	it("treats a two-segment name as short, so it lands under the live server's namespace", async () => {
		const target = await resolveChannelTarget({
			name: "ace:inbox",
			active: [live(local)],
			configured,
			username: "ana",
		});
		expect(target.server.name).toBe("local");
		expect(target.channel).toBe("ace:ana:ace:inbox");
	});
});

describe("resolveChannelTarget: short names", () => {
	it("uses the single live server, completing the name", async () => {
		const target = await resolveChannelTarget({
			name: "ci-ok",
			active: [live(local)],
			configured,
			username: "ana",
		});
		expect(target.server.name).toBe("local");
		expect(target.channel).toBe("ace:ana:ci-ok");
	});

	it("uses the directory for a namespace several live servers share, and refuses an ambiguous match", async () => {
		const alpha = server("alpha", "shared");
		const beta = server("beta", "shared");
		const shared = [alpha, beta];
		const peers = [live(alpha, ["shared:ana:a"]), live(beta, ["shared:ana:b"])];
		const unique = await resolveChannelTarget({
			name: "shared:ana:a",
			active: peers,
			configured: shared,
			username: "ana",
		});
		expect(unique.server.name).toBe("alpha");
		expect(unique.channel).toBe("shared:ana:a");

		const ambiguous = [live(alpha, ["shared:ana:topic"]), live(beta, ["shared:ana:topic"])];
		await expect(
			resolveChannelTarget({ name: "shared:ana:topic", active: ambiguous, configured: shared, username: "ana" }),
		).rejects.toThrow(/matches 2 live channels/);
	});

	it("fails a short name no live directory entry matches when several servers are live", async () => {
		const peers = [live(local, ["ace:ana:ci-ok"]), live(second, ["ace2:ana:other"])];
		await expect(resolveChannelTarget({ name: "ci-ok", active: peers, configured, username: "ana" })).rejects.toThrow(
			'no live channel matches "ci-ok"',
		);
	});

	it("reads a first segment that matches no configured server as part of a short name, not as a prefix", async () => {
		// Documented and pinned rather than accidental: `<server>:` is the form matched against configured
		// server names, so an unknown first segment leaves the name two short segments long and it is
		// completed — there is no server name to have meant, and a two-segment short name with a colon is a
		// legitimate local name. Only a prefixed remainder of two segments (above) is ambiguous enough to fail.
		const target = await resolveChannelTarget({
			name: "noserver:foo",
			active: [live(local)],
			configured,
			username: "ana",
		});
		expect(target.server.name).toBe("local");
		expect(target.channel).toBe("ace:ana:noserver:foo");
	});

	it("fails with noDirectory when no server is live", async () => {
		await expect(resolveChannelTarget({ name: "ci-ok", active: [], configured, username: "ana" })).rejects.toThrow(
			"no agent directory: no server from .ace.json is reachable",
		);
	});
});

describe("resolvePublishTargets: one delivery per resolved channel", () => {
	const resolve = (name: string) =>
		resolveChannelTarget({ name, active: [live(local), live(second)], configured, username: "ana" });

	it("reports a same-channel input as a duplicate of the earlier one instead of a second delivery", async () => {
		// `ace:ana:inbox` is a full name on `local`; `local:inbox` is the `<server>:` form for the same
		// channel. String de-duplication sees three targets, so de-duplication has to run after resolution.
		// The two *identical* inputs are kept too (defect 1): an exact repeat is an input like any other,
		// not silently collapsed before the resolved check can report it.
		const inputs = ["ace:ana:inbox", "ace:ana:inbox", "local:inbox"];
		expect(validatePublishInput({ body: "hi", channel: inputs }).targets).toEqual([
			"ace:ana:inbox",
			"ace:ana:inbox",
			"local:inbox",
		]);

		const outcomes = await resolvePublishTargets(inputs, resolve);

		expect(outcomes).toHaveLength(3);
		expect(outcomes[0]).toMatchObject({ kind: "target", name: "ace:ana:inbox" });
		expect(outcomes[1]).toEqual({ kind: "duplicate", name: "ace:ana:inbox", of: "ace:ana:inbox" });
		expect(outcomes[2]).toEqual({ kind: "duplicate", name: "local:inbox", of: "ace:ana:inbox" });
	});

	it("names the earlier resolved channel in `of`, not the earlier input string", async () => {
		// Defect 5: `local:inbox` is the earlier input and `ace:ana:inbox` is what it resolved to. The
		// duplicate row must name the delivery the delivered row shows (`of=ace:ana:inbox`), not the
		// input string `local:inbox`, which no delivered row displays.
		const outcomes = await resolvePublishTargets(["local:inbox", "ace:ana:inbox"], resolve);

		expect(outcomes[0]).toEqual({
			kind: "target",
			name: "local:inbox",
			target: expect.objectContaining({ channel: "ace:ana:inbox" }),
		});
		expect(outcomes[1]).toEqual({ kind: "duplicate", name: "ace:ana:inbox", of: "ace:ana:inbox" });
	});

	it("keeps targets on different servers apart, in input order", async () => {
		const outcomes = await resolvePublishTargets(["local:inbox", "second:remote"], resolve);

		expect(
			outcomes.map((outcome) =>
				outcome.kind === "target" ? `${outcome.target.server.name}:${outcome.target.channel}` : outcome.kind,
			),
		).toEqual(["local:ace:ana:inbox", "second:ace2:ana:remote"]);
	});

	it("reports every input that failed, even beside a delivered one, in input order", async () => {
		const outcomes = await resolvePublishTargets(["ace:ana:inbox", "ghost:ana:x"], resolve);

		expect(outcomes).toHaveLength(2);
		expect(outcomes[0]).toMatchObject({ kind: "target", name: "ace:ana:inbox" });
		expect(outcomes[1]).toEqual({
			kind: "failure",
			name: "ghost:ana:x",
			detail: 'no configured server owns namespace "ghost", so nothing will store or deliver this event',
		});
	});
});

describe("validatePublishInput", () => {
	it("rejects a non-string or empty body, naming the value", () => {
		expect(() => validatePublishInput({ body: 12345, channel: "outbox" })).toThrow(
			"ace_publish `body` must contain at least one non-whitespace character, received 12345",
		);
		expect(() => validatePublishInput({ body: "", channel: "outbox" })).toThrow(/`body`/);
	});

	it("rejects an empty or non-string channel, naming the value", () => {
		expect(() => validatePublishInput({ body: "hi", channel: "" })).toThrow(
			'ace_publish `channel` must be a non-empty string or an array of non-empty strings, received ""',
		);
		expect(() => validatePublishInput({ body: "hi", channel: 5 })).toThrow(
			"ace_publish `channel` must be a non-empty string or an array of non-empty strings, received 5",
		);
	});

	it("rejects an empty list rather than reporting nothing published", () => {
		expect(() => validatePublishInput({ body: "hi", channel: [] })).toThrow(
			"ace_publish `channel` must be a non-empty string or an array of non-empty strings, received an empty list",
		);
	});

	it("rejects an invalid list entry, naming the entry and its position instead of dropping it", () => {
		expect(() => validatePublishInput({ body: "hi", channel: ["outbox", ""] })).toThrow(
			'ace_publish `channel` entry 2 of 2 must be a non-empty string, received ""',
		);
		expect(() => validatePublishInput({ body: "hi", channel: ["outbox", null] })).toThrow(
			"ace_publish `channel` entry 2 of 2 must be a non-empty string, received null",
		);
	});

	it("keeps every valid target in order, exact repeats included", () => {
		expect(validatePublishInput({ body: "hi", channel: "outbox" }).targets).toEqual(["outbox"]);
		// Defect 1: an exact repeat is not dropped here — one row per input is the contract, and the
		// resolved-target de-duplication reports the second copy as `status=duplicate`.
		expect(validatePublishInput({ body: "hi", channel: ["a", "a", "b"] }).targets).toEqual(["a", "a", "b"]);
	});

	it("trims a name before it becomes a target, and keeps the trimmed repeat", () => {
		expect(validatePublishInput({ body: "hi", channel: " ace:noexcs:team " }).targets).toEqual(["ace:noexcs:team"]);
		// The two spellings trim to one name; both stay inputs so the result can carry two rows.
		expect(validatePublishInput({ body: "hi", channel: [" ace:noexcs:team ", "ace:noexcs:team"] }).targets).toEqual([
			"ace:noexcs:team",
			"ace:noexcs:team",
		]);
	});

	it("refuses a whitespace-only body, naming the value", () => {
		// Defect 3: `"   "` used to pass the emptiness check and be published as a blank event.
		expect(() => validatePublishInput({ body: "   ", channel: "outbox" })).toThrow(
			'ace_publish `body` must contain at least one non-whitespace character, received "   "',
		);
		expect(() => validatePublishInput({ body: "\n\t", channel: "outbox" })).toThrow(/`body`/);
		// A body with content keeps leading and trailing whitespace: only emptiness is judged, never rewritten.
		expect(validatePublishInput({ body: "  hi  ", channel: "outbox" }).body).toBe("  hi  ");
	});

	it("rejects a name carrying whitespace or a control character, naming the value", () => {
		expect(() => validatePublishInput({ body: "hi", channel: "ace:noexcs:probe\nws" })).toThrow(
			'ace_publish `channel` "ace:noexcs:probe\\nws" contains interior whitespace or a control character, which a ' +
				"channel name cannot carry",
		);
		expect(() => validatePublishInput({ body: "hi", channel: "team chat" })).toThrow(
			/contains interior whitespace or a control character/,
		);
	});

	it("rejects a name with an empty segment, naming the value", () => {
		expect(() => validatePublishInput({ body: "hi", channel: "ace::foo" })).toThrow(
			'ace_publish `channel` "ace::foo" has an empty segment — ":" separates the segments, so every segment ' +
				"must be non-empty",
		);
	});

	it("names the position when the unusable name is a list entry", () => {
		expect(() => validatePublishInput({ body: "hi", channel: ["outbox", "bad name"] })).toThrow(
			'ace_publish `channel` entry 2 of 2 "bad name" contains interior whitespace or a control character, which a ' +
				"channel name cannot carry",
		);
		expect(() => validatePublishInput({ body: "hi", channel: ["ace::foo"] })).toThrow(
			'ace_publish `channel` entry 1 of 1 "ace::foo" has an empty segment',
		);
	});

	it("fails a key `ace_publish` does not take instead of ignoring it", () => {
		// Before this, `{"bogus": true}` reached the handler and was dropped: the call behaved exactly like
		// one made with no extra argument, so the caller could not tell it had been ignored.
		expect(() => validatePublishInput({ body: "hi", channel: "outbox", bogus: true })).toThrow(
			'ace_publish does not take "bogus"; it takes `body`, `channel`, `activation`',
		);
	});

	it("names every undeclared key, in call order", () => {
		expect(() => validatePublishInput({ body: "hi", channel: "outbox", target: "x", mode: "silent" })).toThrow(
			'ace_publish does not take "target", "mode"; it takes `body`, `channel`, `activation`',
		);
	});

	it("refuses an activation outside the four values, before the host's schema does", () => {
		// Item 4: the declared `enum` used to reject `"later"` in the host's own wording and echo the whole
		// tool document back. The schema no longer declares the enum, so the call reaches this check.
		expect(() => validatePublishInput({ body: "hi", channel: "outbox", activation: "later" })).toThrow(
			'ace_publish `activation` must be one of "immediate", "next_turn", "manual", "default", received "later"',
		);
		// A non-string is named too: the schema declares no type for it now, so this is where `true` fails.
		expect(() => validatePublishInput({ body: "hi", channel: "outbox", activation: true })).toThrow(
			'ace_publish `activation` must be one of "immediate", "next_turn", "manual", "default", received true',
		);
	});

	it("keeps the four legal activations, and carries an omitted one as undefined", () => {
		for (const activation of ["immediate", "next_turn", "manual", "default"]) {
			expect(validatePublishInput({ body: "hi", channel: "outbox", activation }).activation).toBe(activation);
		}
		expect(validatePublishInput({ body: "hi", channel: "outbox" }).activation).toBeUndefined();
	});

	it("refuses a <server>: prefix with a two-segment remainder before anything is sent", () => {
		// Bug 3: `second:noexcs:remote` used to pass validation, mint an id and come back as a
		// `status=failed` row beside an event id — the resolution path, not the usage-error path the tool
		// text promised. The check now runs with the configured server names, so nothing is ever minted.
		expect(() =>
			validatePublishInput({ body: "hi", channel: "second:noexcs:remote" }, { servers: ["local", "second"] }),
		).toThrow('after the server prefix "second", "noexcs:remote" is a two-segment name');
		expect(() =>
			validatePublishInput({ body: "hi", channel: ["outbox", "local:ace:inbox"] }, { servers: ["local"] }),
		).toThrow('after the server prefix "local", "ace:inbox" is a two-segment name');
	});

	it("leaves the legal prefix remainders alone", () => {
		const oneSegment = validatePublishInput({ body: "hi", channel: "local:remote" }, { servers: ["local"] });
		expect(oneSegment.targets).toEqual(["local:remote"]);

		const threeSegments = validatePublishInput(
			{ body: "hi", channel: "local:ace2:ana:remote" },
			{ servers: ["local"] },
		);
		expect(threeSegments.targets).toEqual(["local:ace2:ana:remote"]);

		// A first segment that is not a configured server name is not a prefix, so its two segments are a
		// plain local name (the single-server completion rule decides what it becomes, not this check).
		expect(validatePublishInput({ body: "hi", channel: "noexcs:inbox" }, { servers: ["local"] }).targets).toEqual([
			"noexcs:inbox",
		]);
	});
});

describe("rejectUnknownArguments", () => {
	it("refuses any key for a tool that declares no arguments", () => {
		expect(() => rejectUnknownArguments("ace_channels", { foo: 1 }, TOOL_ARGUMENTS.channels)).toThrow(
			'ace_channels does not take "foo"; it takes no arguments',
		);
	});

	it("accepts the declared keys, and a tool is free to pass nothing at all", () => {
		expect(() =>
			rejectUnknownArguments("ace_agents", { agent: "pi", limit: 3 }, TOOL_ARGUMENTS.agents),
		).not.toThrow();
		expect(() => rejectUnknownArguments("ace_channels", {}, TOOL_ARGUMENTS.channels)).not.toThrow();
	});
});

/** The wrong-typed values two evaluators fed the tools, all of which used to become strings. */
const COERCION_INPUTS: JsonObject[] = [
	{ body: "hello", channel: 42 },
	{ body: 12345, channel: "outbox" },
	{ body: { n: 12345, s: "x" }, channel: "outbox" },
	{ body: ["array", "body"], channel: "outbox" },
	{ body: "hi", channel: [5, null] },
];

/**
 * `body` and `channel` declare no type, and that is the fix for host coercion — not a style choice.
 *
 * Pi runs TypeBox's `Value.Convert` over tool arguments before every call, and oh-my-pi repairs every
 * type issue its validator reports by stringifying the value (`42` → `"42"`, `{...}` → its compact
 * JSON). Both rewrites key on the declared type, so a node declaring `type: "string"` — plain or
 * `Type.String()` — turns a number into a valid-looking channel before the tool sees it; the earlier
 * round's plain node defeated `Value.Convert` but not the issue-driven repair, which is why the
 * evaluator still got `ace:noexcs:42` from `channel: 42`. With no declared type the validator reports
 * no issue and the converter has nothing to convert, so the value reaches the tool as written and
 * {@link validatePublishInput} refuses it, naming it. What a caller must do: pass strings.
 */
describe("PUBLISH_PARAMETERS", () => {
	it("gives Value.Convert and the host's check nothing to rewrite, and nothing to refuse", () => {
		for (const input of COERCION_INPUTS) {
			const args = structuredClone(input);
			Value.Convert(PUBLISH_PARAMETERS, args);

			expect(args).toEqual(input);
			// A host that repairs only reported type issues has none here, so the raw value survives.
			expect(Value.Check(PUBLISH_PARAMETERS, args)).toBe(true);
		}
	});

	it("still accepts a string or a list of strings", () => {
		expect(Value.Check(PUBLISH_PARAMETERS, { body: "hi", channel: "outbox" })).toBe(true);
		expect(Value.Check(PUBLISH_PARAMETERS, { body: "hi", channel: ["a", "b"] })).toBe(true);
	});

	it("lets a missing body or channel reach the tool, so its own sentence is the one the model reads", () => {
		// Item 4: declared required, a missing `body`/`channel` was rejected by the host's validator in the
		// host's wording, with the whole tool document echoed back. Optional, the call reaches the handler,
		// whose `validatePublishInput` names the missing value. `validateToolArguments` is the real Pi host
		// pipeline, not a model of it.
		const tool = { name: "ace_publish", description: "", parameters: PUBLISH_PARAMETERS };
		const cases: JsonObject[] = [{ channel: "outbox" }, { body: "hi" }];

		for (const args of cases) {
			const validated: Record<string, unknown> = validateToolArguments(tool, {
				type: "toolCall",
				id: "call_1",
				name: "ace_publish",
				arguments: args,
			});
			expect(validated).toEqual(args);
		}
		expect(() => validatePublishInput({ channel: "outbox" })).toThrow(
			"ace_publish `body` must contain at least one non-whitespace character, received undefined",
		);
		expect(() => validatePublishInput({ body: "hi" })).toThrow(
			"ace_publish `channel` must be a non-empty string or an array of non-empty strings, received undefined",
		);
	});

	it("keeps the Pi host's own argument pipeline from stringifying any of them", () => {
		// The real thing, not a model of it: `validateToolArguments` is what the Pi host calls before a
		// tool runs, with `Value.Convert`, its validator and its JSON-schema coercion pass inside.
		const tool = { name: "ace_publish", description: "", parameters: PUBLISH_PARAMETERS };

		for (const input of COERCION_INPUTS) {
			const validated: Record<string, unknown> = validateToolArguments(tool, {
				type: "toolCall",
				id: "call_1",
				name: "ace_publish",
				arguments: structuredClone(input),
			});

			expect(validated).toEqual(input);
			expect(() => validatePublishInput(validated)).toThrow(
				/must be a non-empty string|must contain at least one non-whitespace character|must not carry|empty segment/,
			);
		}
	});

	it("refuses each coercion input by the value the caller actually wrote", () => {
		const messages = COERCION_INPUTS.map((input) => {
			try {
				validatePublishInput(structuredClone(input));
			} catch (error) {
				return (error as Error).message;
			}
			throw new Error(`validatePublishInput accepted ${JSON.stringify(input)}`);
		});

		expect(messages).toEqual([
			"ace_publish `channel` must be a non-empty string or an array of non-empty strings, received 42",
			"ace_publish `body` must contain at least one non-whitespace character, received 12345",
			"ace_publish `body` must contain at least one non-whitespace character, received object",
			"ace_publish `body` must contain at least one non-whitespace character, received array",
			"ace_publish `channel` entry 1 of 2 must be a non-empty string, received 5",
		]);
	});
});
