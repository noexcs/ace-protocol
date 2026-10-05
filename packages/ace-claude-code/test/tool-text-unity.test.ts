import { readFileSync } from "node:fs";
import { ACE_TOOL_NAMES, channelsToolText, TOOL_TEXT } from "ace-runtime";
import { describe, expect, it } from "vitest";
import { buildToolDefinitions } from "../src/tools.ts";

/**
 * The tool surface is defined once, in `ace-runtime`, and every host binds it. This host used to keep
 * its own copy of the text — which drifts silently, leaving the model with two different descriptions
 * of the same tool depending on the host. These tests fail the moment a copy comes back.
 */
const shared = buildToolDefinitions();
const publishDef = shared.find((tool) => tool.name === ACE_TOOL_NAMES.publish);
const channelsDef = shared.find((tool) => tool.name === ACE_TOOL_NAMES.channels);

describe("tool text unity with the runtime spec", () => {
	it("registers the shared tools under the runtime's names", () => {
		expect(publishDef).toBeDefined();
		expect(channelsDef).toBeDefined();
	});

	it("uses the runtime's publish text verbatim when there is no member to name", () => {
		expect(publishDef?.description).toBe(TOOL_TEXT.publish.intro);
	});

	it("drops only the ace_agents pointer from the shared channels text", () => {
		// This host registers no `ace_agents` tool, so it takes the pointer-free composition…
		expect(channelsDef?.description).toBe(channelsToolText({ agentsTool: false }));
		// …and that composition is the runtime's own text, not a rewording of it.
		expect(channelsDef?.description).toBe(TOOL_TEXT.channels.description);
	});

	it("takes the publish parameter schema from the runtime", () => {
		const schema = publishDef?.inputSchema as { required?: string[]; properties?: Record<string, unknown> };

		// Item 4: `body` and `channel` used to be declared required, so the host rejected a missing one in
		// its own words and echoed the whole tool document before the tool ran. All three are optional in
		// the schema; `validatePublishInput` names the missing value and refuses a bad activation itself.
		expect(schema.required ?? []).toEqual([]);
		expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["activation", "body", "channel"]);
		// The declared activation node is untyped and has no `enum` keyword now, so the host has nothing to
		// reject: a guard keeps the read checked rather than casting an `unknown` property.
		const activation = schema.properties?.activation;
		const activationEnum =
			activation !== null && typeof activation === "object" && "enum" in activation ? activation.enum : undefined;
		expect(activationEnum).toBeUndefined();
	});

	it("adds the directory channel to the shared text instead of rewording it", () => {
		const sender = "ace:claude:claude-code:sess-1";
		const withSender = buildToolDefinitions([sender]).find((tool) => tool.name === ACE_TOOL_NAMES.publish);

		expect(withSender?.description.startsWith(TOOL_TEXT.publish.intro)).toBe(true);
		expect(withSender?.description).toContain(sender);
	});

	it("keeps no literal copy of the shared text in its sources", () => {
		// A literal here is a second source of truth: exactly what the model must never see. The shared
		// text belongs to `ace-runtime`, and this host reaches it through the import, by name.
		const sources = ["../src/tools.ts", "../src/server.ts"].map((path) =>
			readFileSync(new URL(path, import.meta.url), "utf8"),
		);
		const sharedText = [
			TOOL_TEXT.publish.intro,
			...TOOL_TEXT.publish.guidelines,
			...Object.values(TOOL_TEXT.publish.params),
			TOOL_TEXT.channels.description,
			TOOL_TEXT.channels.agentsPointer,
			...TOOL_TEXT.channels.guidelines,
		];

		for (const text of sharedText) {
			for (const source of sources) expect(source).not.toContain(text);
		}
	});
});
