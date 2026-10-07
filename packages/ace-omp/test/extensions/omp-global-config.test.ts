import { describe, expect, it } from "vitest";
import { ompGlobalConfigPath } from "../../extensions/ace.ts";

/**
 * The global fallback the host hands to the runtime: the file a session reads when the directory it
 * started in has no `.ace.json`. It has to follow oh-my-pi's own convention, which is why it lives
 * here and not in the shared runtime.
 */
describe("ompGlobalConfigPath", () => {
	it("sits in the config directory `omp config path` reports", () => {
		expect(ompGlobalConfigPath({ HOME: "/home/u" })).toBe("/home/u/.omp/agent/ace.json");
	});

	it("treats an empty XDG_CONFIG_HOME as unset, not as the current directory", () => {
		expect(ompGlobalConfigPath({ HOME: "/home/u", XDG_CONFIG_HOME: "" })).toBe("/home/u/.omp/agent/ace.json");
	});

	it("follows XDG when oh-my-pi was initialised that way", () => {
		expect(ompGlobalConfigPath({ HOME: "/home/u", XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/omp/ace.json");
	});
});
