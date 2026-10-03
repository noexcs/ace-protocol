import { describe, expect, it } from "vitest";
import type { Activation, ConcreteActivation } from "../../src/protocol/ace-message.ts";
import { DEFAULT_RUNTIME_ACTIVATION, resolveActivation } from "../../src/runtime/activation-resolver.ts";
import type { EndpointConfig } from "../../src/runtime/endpoint-config.ts";

function message(activation: Activation) {
	return { aceVersion: "0.1" as const, id: "evt_1", sender: "agent-ci", activation, body: "Build failed." };
}

function input(activation?: Activation): EndpointConfig {
	return { name: "build-events", transport: "memory", activation, config: {}, options: {} };
}

describe("resolveActivation (RFC §8)", () => {
	const cases: Array<[string, Activation | undefined, Activation, ConcreteActivation]> = [
		["input immediate overrides message next_turn", "immediate", "next_turn", "immediate"],
		["input next_turn overrides message immediate", "next_turn", "immediate", "next_turn"],
		["input manual overrides message immediate", "manual", "immediate", "manual"],
		["input default falls back to message immediate", "default", "immediate", "immediate"],
		["input default falls back to message next_turn", "default", "next_turn", "next_turn"],
		["input default + message default uses runtime default", "default", "default", DEFAULT_RUNTIME_ACTIVATION],
		["message default uses runtime default", undefined, "default", DEFAULT_RUNTIME_ACTIVATION],
	];

	it.each(cases)("%s", (_name, inputActivation, messageActivation, expected) => {
		expect(resolveActivation(message(messageActivation), input(inputActivation))).toBe(expected);
	});

	it("uses an explicitly configured runtime default", () => {
		const effective = resolveActivation(message("default"), input(undefined), "immediate");
		expect(effective).toBe("immediate");
	});

	it("defaults the runtime default to next_turn", () => {
		expect(DEFAULT_RUNTIME_ACTIVATION).toBe("next_turn");
	});

	it("treats a missing input as no override", () => {
		expect(resolveActivation(message("immediate"), undefined)).toBe("immediate");
	});
});
