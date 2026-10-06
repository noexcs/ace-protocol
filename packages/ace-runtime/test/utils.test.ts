import { describe, expect, it } from "vitest";
import { formatDurationHuman, formatIsoDuration, isPlainObject } from "../src/utils.ts";

describe("formatDurationHuman", () => {
	it("renders the house examples as largest-unit-first, zero components dropped", () => {
		expect(formatDurationHuman(0)).toBe("0s");
		expect(formatDurationHuman(130)).toBe("2m 10s");
		expect(formatDurationHuman(3600)).toBe("1h");
		expect(formatDurationHuman(90_000)).toBe("1d 1h");
	});

	it("writes only the units that are non-zero, at most once each", () => {
		expect(formatDurationHuman(1)).toBe("1s");
		expect(formatDurationHuman(59)).toBe("59s");
		expect(formatDurationHuman(60)).toBe("1m");
		expect(formatDurationHuman(61)).toBe("1m 1s");
		expect(formatDurationHuman(3661)).toBe("1h 1m 1s");
		expect(formatDurationHuman(86_400)).toBe("1d");
		expect(formatDurationHuman(86_460)).toBe("1d 1m");
		expect(formatDurationHuman(90061)).toBe("1d 1h 1m 1s");
	});

	it("rounds fractional seconds and floors a negative or non-finite at zero", () => {
		expect(formatDurationHuman(59.6)).toBe("1m");
		expect(formatDurationHuman(0.4)).toBe("0s");
		expect(formatDurationHuman(-5)).toBe("0s");
		expect(formatDurationHuman(Number.NaN)).toBe("0s");
		expect(formatDurationHuman(Number.POSITIVE_INFINITY)).toBe("0s");
	});
});

describe("formatIsoDuration", () => {
	it("renders the seconds a remaining lease takes as ISO 8601", () => {
		expect(formatIsoDuration(0)).toBe("PT0S");
		expect(formatIsoDuration(33)).toBe("PT33S");
		expect(formatIsoDuration(90)).toBe("PT1M30S");
		expect(formatIsoDuration(3600)).toBe("PT1H");
	});

	it("carries the day component and never writes an empty time part", () => {
		expect(formatIsoDuration(86_400)).toBe("P1D");
		expect(formatIsoDuration(90_061)).toBe("P1DT1H1M1S");
		expect(formatIsoDuration(172_800)).toBe("P2D");
		expect(formatIsoDuration(86_460)).toBe("P1DT1M");
	});

	it("rounds fractional seconds and floors a negative at zero", () => {
		expect(formatIsoDuration(59.6)).toBe("PT1M");
		expect(formatIsoDuration(-5)).toBe("PT0S");
		expect(formatIsoDuration(Number.NaN)).toBe("PT0S");
		expect(formatIsoDuration(Number.POSITIVE_INFINITY)).toBe("PT0S");
	});
});

describe("isPlainObject", () => {
	it("accepts a plain object and refuses null and arrays", () => {
		expect(isPlainObject({})).toBe(true);
		expect(isPlainObject(null)).toBe(false);
		expect(isPlainObject([])).toBe(false);
		expect(isPlainObject("x")).toBe(false);
	});
});
