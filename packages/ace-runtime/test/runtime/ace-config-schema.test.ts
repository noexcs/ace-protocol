import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAceConfig } from "../../src/runtime/ace-config.ts";
import { type JsonSchemaNode, schemaErrors } from "../support/json-schema.ts";

// Keeps the .ace.json schema document and the hand-written config validator from drifting apart.
const schema = JSON.parse(
	readFileSync(new URL("../../schema/ace-config.schema.json", import.meta.url), "utf8"),
) as JsonSchemaNode;

const inbox = { name: "inbox", transport: "redis-streams", config: { stream: "ace:in.a", group: "agent-a" } };
const toB = { name: "to-b", transport: "redis-streams", config: { stream: "ace:in.b" } };

describe("ACE runtime configuration JSON Schema", () => {
	it.each<[string, unknown]>([
		["one subscription", { subscribe: [inbox] }],
		["a default activation", { defaultActivation: "immediate", subscribe: [inbox] }],
		["publish channels with a sender", { sender: "agent-a", subscribe: [inbox], publish: [toB] }],
		["a channel description", { subscribe: [{ ...inbox, description: "direct messages from peers" }] }],
		["a disabled channel", { subscribe: [{ ...inbox, enabled: false }] }],
		["a subscription-level activation override", { subscribe: [{ ...inbox, activation: "immediate" }] }],
		["raw client options", { subscribe: [{ ...inbox, options: { socket: { connectTimeout: 5000 } } }] }],
		["a sender with allowed punctuation", { sender: "ci.runner-7@host:1", subscribe: [inbox], publish: [toB] }],

		["a non-object document", []],
		["missing subscribe", { defaultActivation: "next_turn" }],
		["empty subscribe", { subscribe: [] }],
		["a delegated defaultActivation", { defaultActivation: "default", subscribe: [inbox] }],
		["an unknown top-level key", { subscribe: [{ ...inbox, stram: "typo" }] }],
		["a channel missing name and transport", { subscribe: [{ config: { stream: "s", group: "g" } }] }],
		["a channel with an empty name", { subscribe: [{ ...inbox, name: "" }] }],
		["an unsupported transport kind", { subscribe: [{ name: "x", transport: "kafka", config: { topic: "t" } }] }],
		[
			"a subscription without a stream",
			{ subscribe: [{ name: "x", transport: "redis-streams", config: { group: "g" } }] },
		],
		[
			"a subscription without a group",
			{ subscribe: [{ name: "x", transport: "redis-streams", config: { stream: "s" } }] },
		],
		[
			"an unknown setting inside config",
			{ subscribe: [{ ...inbox, config: { stream: "s", group: "g", strem: "typo" } }] },
		],
		["a non-integer count", { subscribe: [{ ...inbox, config: { ...inbox.config, count: "8" } }] }],
		["a zero count", { subscribe: [{ ...inbox, config: { ...inbox.config, count: 0 } }] }],
		["an empty description", { subscribe: [{ ...inbox, description: "" }] }],
		["a non-boolean enabled", { subscribe: [{ ...inbox, enabled: "yes" }] }],
		["a non-object config", { subscribe: [{ ...inbox, config: "stream" }] }],
		["a non-object options", { subscribe: [{ ...inbox, options: 7 }] }],
		["an invalid activation", { subscribe: [{ ...inbox, activation: "soon" }] }],
		[
			"activation on a publish channel",
			{ sender: "agent-a", subscribe: [inbox], publish: [{ ...toB, activation: "immediate" }] },
		],
		["publish without a sender", { subscribe: [inbox], publish: [toB] }],
		["an empty publish array", { sender: "agent-a", subscribe: [inbox], publish: [] }],
		[
			"a publish channel without a stream",
			{ sender: "agent-a", subscribe: [inbox], publish: [{ name: "o", transport: "redis-streams", config: {} }] },
		],
		["a sender with a space", { sender: "agent a", subscribe: [inbox], publish: [toB] }],
		["a sender with a newline", { sender: "agent\na", subscribe: [inbox], publish: [toB] }],
		["an over-long sender", { sender: "a".repeat(129), subscribe: [inbox], publish: [toB] }],
		["a numeric sender", { sender: 7, subscribe: [inbox], publish: [toB] }],
	])("agrees with the config validator for %s", (_name, document) => {
		const schemaAccepts = schemaErrors(document, schema).length === 0;
		let validatorAccepts = true;
		try {
			parseAceConfig(document, ".ace.json");
		} catch {
			validatorAccepts = false;
		}
		expect(validatorAccepts).toBe(schemaAccepts);
	});

	// Semantic rules that JSON Schema cannot express: the validator owns them alone.
	it.each<[string, unknown]>([
		["duplicated publish names", { sender: "agent-a", subscribe: [inbox], publish: [toB, toB] }],
		["duplicated subscription names", { subscribe: [inbox, inbox] }],
	])("rejects %s in code although the schema cannot see it", (_name, document) => {
		expect(schemaErrors(document, schema)).toEqual([]);
		expect(() => parseAceConfig(document, ".ace.json")).toThrow(/configured twice/);
	});
});
