import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAceConfig } from "../../src/runtime/ace-config.ts";
import { type JsonSchemaNode, schemaErrors } from "../support/json-schema.ts";

// Keeps the .ace.json schema document and the hand-written config validator from drifting apart.
const schema = JSON.parse(
	readFileSync(new URL("../../schema/ace-config.schema.json", import.meta.url), "utf8"),
) as JsonSchemaNode;

const servers = { local: { url: "redis://127.0.0.1:6379" } };

describe("ACE local configuration JSON Schema", () => {
	it.each<[string, unknown]>([
		["a minimal file", { username: "noexcs", servers }],
		["a username with punctuation", { username: "ci.runner-7@host", servers }],
		["a namespace", { username: "u", servers: { lan: { url: "redis://x", namespace: "lan" } } }],
		["a server description", { username: "u", servers: { lan: { url: "redis://x", description: "the LAN box" } } }],
		[
			"subscribe names inside a server",
			{
				username: "u",
				servers: { local: { url: "redis://127.0.0.1:6379", subscribe: ["inbox", "lan:ci-failures"] } },
			},
		],
		[
			"an empty subscribe list",
			{ username: "u", servers: { local: { url: "redis://127.0.0.1:6379", subscribe: [] } } },
		],
		["a server with no subscribe key", { username: "u", servers: { local: { url: "redis://127.0.0.1:6379" } } }],
		["a default activation", { username: "u", servers, defaultActivation: "manual" }],
		["manual retention", { username: "u", servers, manual: { max: 5, ttlMs: 60_000 } }],
		["a pinned global file", { username: "u", servers, projectConfig: "ignore" }],
		["an editor hint", { $schema: "…/ace-config.schema.json", username: "u", servers }],

		["a non-object document", []],
		["missing servers", { username: "u" }],
		["an empty servers object", { username: "u", servers: {} }],
		["a server without a url", { username: "u", servers: { lan: {} } }],
		["a server with an empty url", { username: "u", servers: { lan: { url: "" } } }],
		["an unknown key inside a server", { username: "u", servers: { lan: { url: "redis://x", prefix: "ace" } } }],
		["a colon in the username", { username: "a:b", servers }],
		["a colon in a namespace", { username: "u", servers: { lan: { url: "redis://x", namespace: "a:b" } } }],
		["a colon in a server name", { username: "u", servers: { "a:b": { url: "redis://x" } } }],
		["an empty username", { username: "", servers }],
		["a top-level subscribe", { username: "u", servers, subscribe: ["inbox"] }],
		["a non-string subscribe", { username: "u", servers: { local: { url: "redis://x", subscribe: "inbox" } } }],
		["an empty subscribe entry", { username: "u", servers: { local: { url: "redis://x", subscribe: [""] } } }],
		["a delegated defaultActivation", { username: "u", servers, defaultActivation: "default" }],
		["an unknown key inside manual", { username: "u", servers, manual: { keep: 5 } }],
		["a projectConfig other than ignore", { username: "u", servers, projectConfig: "merge" }],
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

	// Semantic rules JSON Schema cannot express: the validator owns them alone.
	it.each<[string, unknown]>([
		[
			"duplicated subscription names",
			{ username: "u", servers: { local: { url: "redis://127.0.0.1:6379", subscribe: ["inbox", "inbox"] } } },
		],
	])("rejects %s in code although the schema cannot see it", (_name, document) => {
		expect(schemaErrors(document, schema)).toEqual([]);
		expect(() => parseAceConfig(document, ".ace.json")).toThrow(/configured twice/);
	});
});
