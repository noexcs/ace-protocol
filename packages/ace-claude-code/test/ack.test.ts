import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAceEvent } from "ace-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ackFilePath, appendAckObservation, extractAceEvents, readNewTrail } from "../src/ack.ts";

const eventA = renderAceEvent({
	aceVersion: "0.1",
	id: "evt_a",
	sender: "ci",
	activation: "next_turn",
	body: "build failed",
});
const eventB = renderAceEvent({
	aceVersion: "0.1",
	id: "evt_b",
	sender: "ci",
	activation: "next_turn",
	body: "another one",
});

describe("extractAceEvents", () => {
	it("finds each <ace_event> block, including several in one prompt", () => {
		const prompt = `user: go\n<channel source="plugin:ace-claude-code:ace" ace="event">\n${eventA}\n</channel>\nand also\n<channel source="plugin:ace-claude-code:ace" ace="event">\n${eventB}\n</channel>`;
		expect(extractAceEvents(prompt)).toEqual([eventA, eventB]);
	});

	it("returns nothing when there is no ACE block", () => {
		expect(extractAceEvents("just a user prompt")).toEqual([]);
	});
});

describe("ack trail roundtrip", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "ace-ack-"));
		mkdirSync(join(dir, ".ace"), { recursive: true });
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("resolves the path under .ace next to the other ACE state", () => {
		expect(ackFilePath(dir)).toBe(join(dir, ".ace", "ack-observed.jsonl"));
	});

	it("appends and reads back only new complete lines", async () => {
		await appendAckObservation(dir, { t: "t0", blocks: [eventA], prompt: `x\n${eventA}` });
		const first = await readNewTrail(dir, 0);
		expect(first.observations).toHaveLength(1);
		expect(first.observations[0].blocks).toEqual([eventA]);

		// Nothing new on the same offset.
		const none = await readNewTrail(dir, first.nextOffset ?? 0);
		expect(none.observations).toHaveLength(0);

		// A second observation is only visible past the new offset.
		await appendAckObservation(dir, { t: "t1", blocks: [eventB], prompt: `y\n${eventB}` });
		const second = await readNewTrail(dir, first.nextOffset ?? 0);
		expect(second.observations).toHaveLength(1);
		expect(second.observations[0].blocks).toEqual([eventB]);
	});
});
