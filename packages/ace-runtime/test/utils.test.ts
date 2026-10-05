import { describe, expect, it } from "vitest";
import { formatIsoDuration, isPlainObject } from "../src/utils.ts";

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
