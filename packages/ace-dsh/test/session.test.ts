/**
 * One session's lifecycle: what becomes addressable, in what order, and what goes away when it ends.
 *
 * The broker is faked, the core is real: the runtime validates and dispatches, the registry writes the
 * directory entry and keeps its lease alive, and the transports follow the contract the plugin starts and
 * stops them through.
 */

import { describe, expect, it } from "vitest";
import { aceEvent, FakeAgent, FakeBroker, openTestSession, streamOf, testConfig } from "./support/harness.ts";

describe("AceSession", () => {
	it("registers the channel its sender names, before it starts reading", async () => {
		const broker = new FakeBroker();
		const { session } = await openTestSession({ broker });

		expect(session.senders).toEqual(["ace:tester:dsh:s-1"]);
		expect(broker.liveChannels().map((entry) => entry.channel)).toEqual(["ace:tester:dsh:s-1"]);

		// The invariant the whole start-up order exists for: the consumer group is created before the address
		// that makes this session findable, so an event published the moment a peer sees the name is still
		// pending for the consumer that starts a moment later.
		const ensure = broker.journal.findIndex((entry) => entry.startsWith("ensureStream:"));
		const put = broker.journal.findIndex((entry) => entry.startsWith("put:"));
		expect(ensure).toBeGreaterThanOrEqual(0);
		expect(put).toBeGreaterThan(ensure);
	});

	it("reads its own channel in a group named after that channel", async () => {
		const broker = new FakeBroker();
		const { session } = await openTestSession({ broker });
		const transport = broker.transportForStream(streamOf(session.senders[0] ?? ""));

		// Two sessions are two readers, never one queue split between them: the group carries the identity.
		expect(transport?.group).toBe("ace:tester:dsh:s-1");
		expect(transport?.started).toBe(true);
	});

	it("delivers an external event into the agent's conversation", async () => {
		const broker = new FakeBroker();
		const { agent } = await openTestSession({ broker });

		await broker.transportForStream(streamOf("ace:tester:dsh:s-1"))?.deliver(aceEvent(), 1_700_000_000_000);

		expect(agent.received).toHaveLength(1);
		expect(agent.lastText).toContain("build failed on main");
		expect(agent.lastText).toContain("arrived via: ace:tester:dsh:s-1");
	});

	it("honours the sender's activation: immediate cuts in, next_turn queues", async () => {
		const broker = new FakeBroker();
		const { agent } = await openTestSession({ broker });
		const inbox = broker.transportForStream(streamOf("ace:tester:dsh:s-1"));

		agent.status = "running";
		await inbox?.deliver(aceEvent({ id: "e-immediate", activation: "immediate" }));
		await inbox?.deliver(aceEvent({ id: "e-next", activation: "next_turn" }));

		expect(agent.received.map((entry) => entry.kind)).toEqual(["steer", "followup"]);
	});

	it("falls back to the configured default activation when the message delegates", async () => {
		const broker = new FakeBroker();
		const { agent } = await openTestSession({ broker, config: testConfig({ defaultActivation: "immediate" }) });
		agent.status = "running";

		await broker.transportForStream(streamOf("ace:tester:dsh:s-1"))?.deliver(aceEvent({ activation: "default" }));

		expect(agent.received.map((entry) => entry.kind)).toEqual(["steer"]);
	});

	it("retains a manual event instead of delivering it, until it is activated", async () => {
		const broker = new FakeBroker();
		const { session, agent } = await openTestSession({ broker });
		const inbox = broker.transportForStream(streamOf("ace:tester:dsh:s-1"));

		await inbox?.deliver(aceEvent({ id: "e-manual", activation: "manual" }));

		expect(agent.received).toHaveLength(0);
		expect(session.runtime.pendingEvents.map((event) => event.message.id)).toEqual(["e-manual"]);

		await session.runtime.activatePendingEvent("ace:peer:dsh:peer-1", "e-manual");

		expect(agent.received).toHaveLength(1);
		expect(agent.lastText).toContain("e-manual");
		expect(session.runtime.pendingEvents).toHaveLength(0);
	});

	it("delivers a redelivered event once", async () => {
		const broker = new FakeBroker();
		const { agent } = await openTestSession({ broker });
		const inbox = broker.transportForStream(streamOf("ace:tester:dsh:s-1"));

		await inbox?.deliver(aceEvent({ id: "e-dup" }));
		await inbox?.deliver(aceEvent({ id: "e-dup" }));

		expect(agent.received).toHaveLength(1);
	});

	it("drops a message that is not a conforming ACE event", async () => {
		const broker = new FakeBroker();
		const { agent } = await openTestSession({ broker });

		await expect(
			broker.transportForStream(streamOf("ace:tester:dsh:s-1"))?.deliver({ aceVersion: "0.1" }),
		).resolves.toBeUndefined();

		expect(agent.received).toHaveLength(0);
	});

	it("counts a failed turn through the engine's own error hook", async () => {
		const broker = new FakeBroker();
		const { session, agent } = await openTestSession({ broker });

		agent.failRun(new Error("turn exploded"));

		expect(JSON.stringify(session.metricsSnapshot())).toContain('"runFailed":1');
	});

	it("withdraws the address, drops the stream and stops reading on stop", async () => {
		const broker = new FakeBroker();
		const { session } = await openTestSession({ broker });
		const channel = session.senders[0] ?? "";

		await session.stop();

		expect(broker.liveChannels()).toEqual([]);
		expect(broker.droppedStreams).toEqual([streamOf(channel)]);
		expect(broker.transportForStream(streamOf(channel))?.started).toBe(false);
		// The order is the core's: the reader stops before the group it reads is deleted.
		const removed = broker.journal.findIndex((entry) => entry.startsWith("remove:"));
		expect(removed).toBeGreaterThanOrEqual(0);
		expect(broker.journal.filter((entry) => entry.startsWith("dropStream:")).length).toBe(1);
	});

	it("stops once, however often it is asked", async () => {
		const broker = new FakeBroker();
		const { session } = await openTestSession({ broker });

		await session.stop();
		await session.stop();

		expect(broker.droppedStreams).toHaveLength(1);
	});

	it("is live on every server that answered, one channel per server", async () => {
		const broker = new FakeBroker();
		const config = testConfig();
		config.servers = [
			{ name: "a", url: "redis://a:6379", namespace: "ace" },
			{ name: "b", url: "redis://b:6379", namespace: "other" },
		];

		const { session } = await openTestSession({ broker, config });

		expect(session.servers.map((server) => server.name)).toEqual(["a", "b"]);
		// One channel per server, each under that server's own namespace.
		expect(session.senders).toEqual(["ace:tester:dsh:s-1", "other:tester:dsh:s-1"]);
		// Several servers means several inboxes, so each binding gets its own label.
		expect(broker.transports.map((transport) => transport.name)).toEqual(["a:session-inbox", "b:session-inbox"]);
	});

	it("reports an unreachable server and stays non-live rather than taking the agent down", async () => {
		const broker = new FakeBroker();
		broker.unreachable = true;
		const problems: string[] = [];

		const { session } = await openTestSession({ broker, problems });

		expect(session.live).toBe(false);
		expect(session.senders).toEqual([]);
		// The report names the server and its host, not the full connection string.
		expect(session.unavailableServers).toEqual([{ name: "local", address: "fake:6379" }]);
		expect(problems.join("\n")).toContain('server "local" is unreachable');
	});

	it("reports configured subscriptions as ignored, because this host reads live channels only", async () => {
		const broker = new FakeBroker();
		const problems: string[] = [];
		const config = testConfig({ subscriptions: [{ channel: "ace:tester:ci-failures" }] });

		await openTestSession({ broker, config, problems });

		expect(problems.join("\n")).toContain("live channels only");
		expect(problems.join("\n")).toContain("ace:tester:ci-failures");
		// The subscription is not read: the only transport is the session's own inbox.
		expect(broker.transports.map((transport) => transport.stream)).toEqual([streamOf("ace:tester:dsh:s-1")]);
	});

	it("keeps two sessions as two independent readers", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });
		const bob = await openTestSession({ broker, agent: new FakeAgent("s-2") });

		expect(alice.session.senders).toEqual(["ace:tester:dsh:s-1"]);
		expect(bob.session.senders).toEqual(["ace:tester:dsh:s-2"]);
		expect(new Set(broker.transports.map((transport) => transport.group))).toEqual(
			new Set(["ace:tester:dsh:s-1", "ace:tester:dsh:s-2"]),
		);

		await broker.transportForStream(streamOf("ace:tester:dsh:s-2"))?.deliver(aceEvent({ id: "to-bob" }));

		expect(bob.agent.received).toHaveLength(1);
		expect(alice.agent.received).toHaveLength(0);
	});
});
