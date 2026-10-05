import { describe, expect, it } from "vitest";
import type { DeadLetterRecord } from "../../src/runtime/dead-letter.ts";
import { parseDeadLetters, replayDeadLetters, summarizeReplay } from "../../src/runtime/dead-letter-replay.ts";

const record: DeadLetterRecord = {
	at: 1_000,
	subscription: "inbox",
	streamEntryId: "1791053000000-0",
	stream: "ace:in.a",
	field: "message",
	attempts: 3,
	reason: "after 3 delivery attempts",
	payload: '{"aceVersion":"0.1","id":"evt_1"}',
};

describe("parseDeadLetters", () => {
	it("reads records and ignores blank lines", () => {
		const parsed = parseDeadLetters(`${JSON.stringify(record)}\n\n${JSON.stringify(record)}\n`);

		expect(parsed.records).toHaveLength(2);
		expect(parsed.skipped).toBe(0);
	});

	it("skips malformed lines instead of guessing", () => {
		const parsed = parseDeadLetters(`not json\n${JSON.stringify(record)}\n`);

		expect(parsed.records).toHaveLength(1);
		expect(parsed.skipped).toBe(1);
	});

	it("skips records that cannot be replayed", () => {
		const withoutStream = { ...record, stream: undefined };
		const withoutPayload = { ...record, payload: undefined };
		const withoutField = { ...record, field: "" };
		const parsed = parseDeadLetters(
			[withoutStream, withoutPayload, withoutField].map((entry) => JSON.stringify(entry)).join("\n"),
		);

		expect(parsed.records).toEqual([]);
		expect(parsed.skipped).toBe(3);
	});
});

describe("replayDeadLetters", () => {
	it("publishes each payload back to its own stream, in file order", async () => {
		const published: Array<[string, string, string]> = [];
		const second = { ...record, streamEntryId: "1791053000001-0", stream: "ace:in.b", payload: "second" };

		const outcome = await replayDeadLetters([record, second], async (stream, field, payload) => {
			published.push([stream, field, payload]);
		});

		expect(published).toEqual([
			["ace:in.a", "message", '{"aceVersion":"0.1","id":"evt_1"}'],
			["ace:in.b", "message", "second"],
		]);
		expect(outcome).toEqual({ replayed: 2, skipped: 0, failed: [] });
	});

	it("skips a record whose entry had no payload", async () => {
		const outcome = await replayDeadLetters([{ ...record, payload: null }], async () => {
			throw new Error("must not be called");
		});

		expect(outcome).toEqual({ replayed: 0, skipped: 1, failed: [] });
	});

	it("keeps going when one stream rejects the write", async () => {
		const written: string[] = [];
		const outcome = await replayDeadLetters([record, { ...record, stream: "ace:in.b" }], async (stream) => {
			if (stream === "ace:in.a") throw new Error("stream gone");
			written.push(stream);
		});

		expect(written).toEqual(["ace:in.b"]);
		expect(outcome.replayed).toBe(1);
		expect(outcome.failed).toHaveLength(1);
		expect(outcome.failed[0]).toMatchObject({ stream: "ace:in.a", streamEntryId: record.streamEntryId });
	});
});

describe("summarizeReplay", () => {
	it("counts records per stream, sorted", () => {
		const summary = summarizeReplay([record, { ...record, stream: "ace:in.b" }, { ...record, stream: "ace:in.a" }]);

		expect(summary).toBe("ace:in.a: 2, ace:in.b: 1");
	});

	it("says nothing for an empty file", () => {
		expect(summarizeReplay([])).toBe("");
	});
});
