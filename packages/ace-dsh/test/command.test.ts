/**
 * `/ace` — the human face. It must say the same things the model's tools say, and never invent a state it
 * cannot observe: a session with no configuration, no server, or no held events reads as exactly that.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

async function workspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ace-dsh-dlq-"));
	directories.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

import { runAceCommand } from "../src/command.ts";
import { aceEvent, FakeAgent, FakeBroker, openTestSession, streamOf, testConfig } from "./support/harness.ts";

describe("/ace", () => {
	it("writes a dead letter the reader gives up on, and counts it", async () => {
		const broker = new FakeBroker();
		const cwd = await workspace();
		const { session } = await openTestSession({ broker, cwd });
		expect(broker.capturedOnDropped).toBeDefined();

		await broker.capturedOnDropped?.("inbox", {
			streamEntryId: "9-0",
			stream: "ace:ch:inbox",
			field: "message",
			payload: "{}",
			attempts: 3,
			reason: "after 3 delivery attempts",
		});

		// The entry leaves the PEL only once the record is on disk, in the `.ace/` directory the Pi host uses.
		const files = await readdir(join(cwd, ".ace"));
		const deadLetter = files.find((name) => name.startsWith("dead-letter."));
		expect(deadLetter).toBeDefined();
		const written = await readFile(join(cwd, ".ace", deadLetter ?? ""), "utf8");
		expect(written).toContain('"streamEntryId":"9-0"');
		expect(written).toContain('"attempts":3');

		// `/ace` (the status report) is where this host surfaces the count.
		const reply = await runAceCommand("", session);
		expect(reply.text).toContain("dead letters: 1");
	});

	it("reports this session's identity, configuration and liveness", async () => {
		const broker = new FakeBroker();
		const { session } = await openTestSession({ broker });

		const reply = await runAceCommand("", session);

		expect(reply.kind).toBe("success");
		expect(reply.text).toContain("ace:tester:dsh:s-1");
		expect(reply.text).toContain("/work/.ace.json");
		expect(reply.text).toContain("live");
	});

	it("lists held events with the identity activation takes", async () => {
		const broker = new FakeBroker();
		const { session } = await openTestSession({ broker });
		await broker
			.transportForStream(streamOf("ace:tester:dsh:s-1"))
			?.deliver(aceEvent({ id: "e-manual", activation: "manual" }));

		const reply = await runAceCommand("pending", session);

		expect(reply.text).toContain("sender=ace:peer:dsh:peer-1");
		expect(reply.text).toContain("id=e-manual");
		expect(reply.text).toContain("total=1");
	});

	it("delivers a held event when asked to activate it", async () => {
		const broker = new FakeBroker();
		const { session, agent } = await openTestSession({ broker });
		await broker
			.transportForStream(streamOf("ace:tester:dsh:s-1"))
			?.deliver(aceEvent({ id: "e-manual", activation: "manual" }));

		const reply = await runAceCommand("activate ace:peer:dsh:peer-1 e-manual", session);

		expect(reply.kind).toBe("success");
		expect(agent.received).toHaveLength(1);
		expect(session.runtime.pendingEvents).toHaveLength(0);
	});

	it("refuses an incomplete activation instead of guessing", async () => {
		const broker = new FakeBroker();
		const { session } = await openTestSession({ broker });

		const reply = await runAceCommand("activate ace:peer:dsh:peer-1", session);

		expect(reply.kind).toBe("error");
		expect(reply.text).toContain("usage: /ace activate");
	});

	it("says nothing is held rather than showing an empty list", async () => {
		const broker = new FakeBroker();
		const { session } = await openTestSession({ broker });

		const reply = await runAceCommand("pending", session);

		expect(reply.text).toBe("No ACE events are held for manual activation.");
	});

	it("names the sessions that can be addressed right now", async () => {
		const broker = new FakeBroker();
		const alice = await openTestSession({ broker });
		await openTestSession({ broker, agent: new FakeAgent("s-2") });

		const reply = await runAceCommand("agents", alice.session);

		expect(reply.kind).toBe("success");
		expect(reply.text).toContain("ace:tester:dsh:s-2");
	});

	it("shows a configured persistent channel as one this host does not read", async () => {
		const broker = new FakeBroker();
		const { session } = await openTestSession({
			broker,
			config: testConfig({ subscriptions: [{ channel: "ace:tester:ci-failures" }] }),
		});

		const reply = await runAceCommand("status", session);

		expect(reply.text).toContain("ace:tester:ci-failures");
	});

	it("rejects an unknown subcommand and shows the usage", async () => {
		const broker = new FakeBroker();
		const { session } = await openTestSession({ broker });

		const reply = await runAceCommand("frobnicate", session);

		expect(reply.kind).toBe("error");
		expect(reply.text).toContain("unknown subcommand");
		expect(reply.text).toContain("/ace activate");
	});

	it("explains itself when the session has no ACE at all", async () => {
		const reply = await runAceCommand("", undefined);

		expect(reply.kind).toBe("error");
		expect(reply.text).toContain("ACE is not running in this session");
	});
});
