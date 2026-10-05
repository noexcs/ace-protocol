import { describe, expect, it } from "vitest";
import { validateAgentsInput } from "../../src/tools/agents.ts";

describe("validateAgentsInput", () => {
	it("treats a blank filter as no filter, so a live directory is not reported empty", () => {
		// Defect 1: `agent: ""` passed straight through as a filter that matched nothing, so a directory with
		// peers came back as `count=0` — indistinguishable from an empty one. A blank value names no coding
		// agent, so it is no filter at all and the rows are listed whole.
		expect(validateAgentsInput({})).toEqual({ limit: 20 });
		expect(validateAgentsInput({ agent: "" })).toEqual({ limit: 20 });
		expect(validateAgentsInput({ agent: "   " })).toEqual({ limit: 20 });
	});

	it("trims a filter and keeps it when it names a coding agent", () => {
		expect(validateAgentsInput({ agent: " oh-my-pi " })).toEqual({ agent: "oh-my-pi", limit: 20 });
		expect(validateAgentsInput({ agent: "pi" })).toEqual({ agent: "pi", limit: 20 });
	});

	it("rejects a non-string agent instead of coercing it, naming the value", () => {
		// Defect 2: the host stringified a declared-type mismatch, so `agent: 5` arrived as the filter "5".
		expect(() => validateAgentsInput({ agent: 5 })).toThrow("ace_agents `agent` must be a string, received 5");
		expect(() => validateAgentsInput({ agent: null })).toThrow("ace_agents `agent` must be a string, received null");
		expect(() => validateAgentsInput({ agent: ["pi"] })).toThrow(
			"ace_agents `agent` must be a string, received array",
		);
	});

	it("rejects a non-integer limit instead of coercing it, naming the value", () => {
		expect(() => validateAgentsInput({ limit: true })).toThrow(
			"ace_agents `limit` must be an integer, received true",
		);
		expect(() => validateAgentsInput({ limit: "5" })).toThrow('ace_agents `limit` must be an integer, received "5"');
		expect(() => validateAgentsInput({ limit: 2.5 })).toThrow("ace_agents `limit` must be an integer, received 2.5");
		expect(() => validateAgentsInput({ limit: Number.NaN })).toThrow(
			"ace_agents `limit` must be an integer, received NaN",
		);
	});

	it("keeps the documented clamp for an in-range integer", () => {
		expect(validateAgentsInput({ limit: 5 })).toEqual({ limit: 5 });
		expect(validateAgentsInput({ limit: 0 })).toEqual({ limit: 1 });
		expect(validateAgentsInput({ limit: 99 })).toEqual({ limit: 50 });
	});

	it("refuses an undeclared argument by name, like every ACE tool", () => {
		expect(() => validateAgentsInput({ bogus: true })).toThrow(
			'ace_agents does not take "bogus"; it takes `agent`, `limit`',
		);
	});
});
