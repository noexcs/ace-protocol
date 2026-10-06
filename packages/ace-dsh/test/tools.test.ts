/**
 * The tool surface: what the model's call does to the broker, and what it reads back.
 *
 * Two sessions on one fake broker are a real two-agent conversation for these purposes — the event that
 * `ace_publish` stores is routed to the peer's transport, which the core's runtime then validates,
 * resolves and injects — so these tests cover the publish path end to end rather than up to a mock.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACE_TOOL_DESCRIPTORS, type AceToolDescriptor, HOST_TOOL_NAMES } from "../src/tools.ts";
import { ACE_TOOL_NAMES } from "../vendor/ace-runtime/dist/index.js";
import { aceEvent, FakeAgent, FakeBroker, openTestSession, streamOf, testConfig } from "./support/harness.ts";

function tool(name: string): AceToolDescriptor {
	const found = ACE_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === name);
	if (found === undefined) throw new Error(`no such tool: ${name}`);
	return found;
}

/** Every tool this host registers, and the one it deliberately does not. */
describe("the registered tool surface", () => {
	it("is ACE's four plus the host's two manual-activation tools, and not ace_channels", () => {
		expect(ACE_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual([
			"ace_publish",
			"ace_agents",
			"ace_store_file",
			"ace_get_file",
			// Not part of ACE's surface: ACE leaves activation to the user, and these two exist because the
			// host's `/ace` command was not dispatched by the client in the build this was installed into.
			"ace_pending",
			"ace_activate",
		]);
		// `ace_channels` reports persistent channels; this host reads live channels only, so a tool that would
		// always answer "none" is not registered at all.
		expect(ACE_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)).not.toContain("ace_channels");
	});

	it("declares a body for every tool and a reason for every declared parameter", () => {
		for (const descriptor of ACE_TOOL_DESCRIPTORS) {
			expect(descriptor.description.length, descriptor.name).toBeGreaterThan(0);
			for (const [name, parameter] of Object.entries(descriptor.parameters)) {
				expect(parameter.description.length, `${descriptor.name}.${name}`).toBeGreaterThan(0);
			}
		}
	});
});

describe("ace_publish", () => {
	it("stores one event on a peer's live channel and reports it as stored", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });
		const bob = await openTestSession({ broker, agent: new FakeAgent("s-2") });
		const bobChannel = bob.session.senders[0] ?? "";

		const text = await tool(ACE_TOOL_NAMES.publish).run(
			{ body: "deploy is green", channel: bobChannel },
			alice.session,
		);

		expect(text).toContain("stored=1");
		expect(text).toContain(`target=${bobChannel} status=stored`);
		// The peer's agent receives it, the publisher's does not.
		expect(bob.agent.received).toHaveLength(1);
		expect(bob.agent.lastText).toContain("deploy is green");
		expect(bob.agent.lastText).toContain("sender: ace:tester:dsh:s-1");
		expect(alice.agent.received).toHaveLength(0);
	});

	it("carries the sender's session id and self-description in the envelope", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });
		const bob = await openTestSession({ broker, agent: new FakeAgent("s-2") });

		await tool(ACE_TOOL_NAMES.publish).run(
			{ body: "hello", channel: bob.session.senders[0] ?? "", activation: "immediate" },
			alice.session,
		);

		const stored = broker.published.at(-1)?.payload as Record<string, unknown>;
		expect(stored.aceVersion).toBe("0.1");
		expect(stored.sender).toBe("ace:tester:dsh:s-1");
		expect(stored.sessionId).toBe("s-1");
		expect(stored.activation).toBe("immediate");
		expect(stored.body).toBe("hello");
		expect(String(stored.senderDescription)).toContain("agent=dsh");
		expect(String(stored.senderDescription)).toContain("session=s-1");
		// The event id belongs to the runtime, not the caller: it is generated and returned, never accepted.
		expect(String(stored.id)).toMatch(/^evt_/);
	});

	it("comes back into the publisher's own context marked as a self-echo", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });

		await tool(ACE_TOOL_NAMES.publish).run(
			{ body: "note to self", channel: alice.session.senders[0] ?? "" },
			alice.session,
		);

		expect(alice.agent.received).toHaveLength(1);
		expect(alice.agent.lastText).toContain("self: yes");
		expect(alice.agent.lastText).toContain("note to self");
	});

	it("keeps a mixed list non-atomic and reports the rows that failed", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });
		const bob = await openTestSession({ broker, agent: new FakeAgent("s-2") });

		const text = await tool(ACE_TOOL_NAMES.publish).run(
			// The second name carries a namespace no configured server owns, which is the one shape that cannot
			// be stored at all: a channel is a name, but nothing here could ever read it.
			{ body: "one event, two targets", channel: [bob.session.senders[0] ?? "", "nope:tester:ghost"] },
			alice.session,
		);

		expect(text).toContain("stored=1");
		expect(text).toContain("failed=1");
		expect(text).toContain("status=failed");
	});

	it("stores to a full name under a live namespace even when no live session names it", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });

		// ACE's rule, kept intact: a channel is a name, not a mailbox. The row says both reader checks are `no`
		// rather than pretending the event reached someone — that is what `peer_named`/`self_reads` are for.
		const text = await tool(ACE_TOOL_NAMES.publish).run(
			{ body: "for a service", channel: "ace:tester:ci-ok" },
			alice.session,
		);

		expect(text).toContain("stored=1");
		expect(text).toContain("peer_named=no self_reads=no");
	});

	it("fails the call when nothing was stored, with the same field list", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });

		await expect(
			tool(ACE_TOOL_NAMES.publish).run({ body: "nowhere", channel: "nope:tester:ghost" }, alice.session),
		).rejects.toThrow(/stored=0/);
	});

	it("refuses an undeclared argument instead of dropping it", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });

		await expect(
			tool(ACE_TOOL_NAMES.publish).run(
				{ body: "x", channel: alice.session.senders[0] ?? "", foo: 1 },
				alice.session,
			),
		).rejects.toThrow(/foo/);
	});

	it("says so when the session has no usable configuration at all", async () => {
		await expect(tool(ACE_TOOL_NAMES.publish).run({ body: "x", channel: "a" }, undefined)).rejects.toThrow(
			/missing or did not load/,
		);
	});

	it("says so when no server is reachable", async () => {
		const broker = new FakeBroker();
		broker.unreachable = true;
		const alice = await openTestSession({ broker, problems: [] });

		await expect(
			tool(ACE_TOOL_NAMES.publish).run({ body: "x", channel: "ace:tester:dsh:s-2" }, alice.session),
		).rejects.toThrow(/no agent directory/);
	});
});

describe("ace_agents", () => {
	it("lists the other live sessions and not this one", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });
		await openTestSession({ broker, agent: new FakeAgent("s-2") });

		const text = await tool(ACE_TOOL_NAMES.agents).run({}, alice.session);

		// The tool answers "who else can I reach": this session's own channel is in the directory, and listing
		// it would invite a session to publish to itself and read its own name as a peer's.
		expect(text).toContain("ace:tester:dsh:s-2");
		expect(text).not.toContain("ace:tester:dsh:s-1");
	});

	it("prefixes a peer's row with its server only when several are live", async () => {
		const broker = new FakeBroker();
		const config = testConfig();
		config.servers = [
			{ name: "a", url: "redis://a:6379", namespace: "ace" },
			{ name: "b", url: "redis://b:6379", namespace: "ace" },
		];
		const alice = await openTestSession({ broker, config });
		await openTestSession({ broker, agent: new FakeAgent("s-2") });

		const text = await tool(ACE_TOOL_NAMES.agents).run({}, alice.session);

		// The prefix is the `<server>:<channel>` target `ace_publish` accepts, so it is what a peer row must
		// carry when the name alone would not say which server holds it.
		expect(text).toContain("channel=a:ace:tester:dsh:s-2");
		expect(text).toContain("channel=b:ace:tester:dsh:s-2");
	});

	it("filters by the coding agent a channel says it runs", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });
		await openTestSession({ broker, agent: new FakeAgent("s-2") });

		const other = await tool(ACE_TOOL_NAMES.agents).run({ agent: "oh-my-pi" }, alice.session);

		expect(other).toContain("No other agent sessions");
	});

	it("drops a session that is no longer live", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });
		const bob = await openTestSession({ broker, agent: new FakeAgent("s-2") });

		await bob.session.stop();

		const text = await tool(ACE_TOOL_NAMES.agents).run({}, alice.session);
		expect(text).not.toContain("ace:tester:dsh:s-2");
	});
});

describe("file transfer", () => {
	it("stores a file under a token and fetches it into the session's quarantine directory", async () => {
		const broker = new FakeBroker();
		const workspace = await mkdtemp(join(tmpdir(), "ace-dsh-xfer-"));
		const payload = join(workspace, "report.txt");
		await writeFile(payload, "the payload\n", "utf8");
		const alice = await openTestSession({ broker, agent: new FakeAgent("s-1", workspace) });

		const stored = await tool(ACE_TOOL_NAMES.storeFile).run({ path: payload }, alice.session);
		expect(stored).toContain("stored_on=local");
		// The token is the capability: the store publishes nothing, and the model relays this line itself.
		const token = /pickup=(\S+)/.exec(stored)?.[1];
		expect(token).toBeTruthy();

		const fetched = await tool(ACE_TOOL_NAMES.getFile).run({ token: token ?? "" }, alice.session);
		expect(fetched).toContain("report.txt");
		// The fetched copy lands in quarantine, not back at the original path, and the bytes survive the trip.
		const written = /path=(\S+)/.exec(fetched)?.[1];
		expect(written).toBeTruthy();
		expect(written).not.toBe(payload);
		expect(await readFile(written ?? "", "utf8")).toBe("the payload\n");
	});

	it("fails a transfer with no live server instead of pretending it worked", async () => {
		const broker = new FakeBroker();
		broker.unreachable = true;
		const alice = await openTestSession({ broker, problems: [], config: testConfig() });

		await expect(tool(ACE_TOOL_NAMES.storeFile).run({ path: "/tmp/whatever" }, alice.session)).rejects.toThrow(
			/no agent directory/,
		);
	});
});

describe("manual activation", () => {
	it("lists what is held, then delivers the named event", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });
		await broker
			.transportForStream(streamOf("ace:tester:dsh:s-1"))
			?.deliver(aceEvent({ id: "evt-held", activation: "manual" }));

		const listing = await tool(HOST_TOOL_NAMES.pending).run({}, alice.session);
		expect(listing).toContain("sender=ace:peer:dsh:peer-1");
		expect(listing).toContain("id=evt-held");
		expect(listing).toContain("total=1");
		// Nothing is delivered by listing it.
		expect(alice.agent.received).toHaveLength(0);

		const activated = await tool(HOST_TOOL_NAMES.activate).run(
			{ sender: "ace:peer:dsh:peer-1", id: "evt-held" },
			alice.session,
		);

		expect(activated).toContain("Activated");
		expect(alice.agent.received).toHaveLength(1);
		expect(alice.agent.lastText).toContain("evt-held");
		expect(alice.session.runtime.pendingEvents).toHaveLength(0);
	});

	it("says nothing is held rather than showing an empty list", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });

		await expect(tool(HOST_TOOL_NAMES.pending).run({}, alice.session)).resolves.toBe(
			"No ACE events are held for manual activation.",
		);
	});

	it("refuses an incomplete activation, and one that names no held event", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });

		await expect(
			tool(HOST_TOOL_NAMES.activate).run({ sender: "ace:peer:dsh:peer-1" }, alice.session),
		).rejects.toThrow(/needs both/);
		await expect(
			tool(HOST_TOOL_NAMES.activate).run({ sender: "ace:peer:dsh:peer-1", id: "evt-missing" }, alice.session),
		).rejects.toThrow();
	});

	it("reports an unconfigured session instead of inventing an empty listing", async () => {
		await expect(tool(HOST_TOOL_NAMES.pending).run({}, undefined)).rejects.toThrow(/missing or did not load/);
		await expect(tool(HOST_TOOL_NAMES.activate).run({ sender: "a", id: "b" }, undefined)).rejects.toThrow(
			/missing or did not load/,
		);
	});
});
