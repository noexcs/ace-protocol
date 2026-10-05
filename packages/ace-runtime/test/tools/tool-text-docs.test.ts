import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACE_TRUST_POLICY } from "../../src/agent/event-rendering.ts";
import { channelsToolText, TOOL_TEXT } from "../../src/tools/spec.ts";

/**
 * The contracts document is a norm: it says what the model is told, so it has to quote the tool text
 * verbatim. Comparing on whitespace-collapsed text lets either side wrap its lines.
 */
const contracts = readFileSync(new URL("../../../../docs/ace-runtime-contracts.md", import.meta.url), "utf8");
const collapse = (text: string): string => text.replace(/\s+/g, " ");

const documented = [
	ACE_TRUST_POLICY,
	TOOL_TEXT.publish.intro,
	...TOOL_TEXT.publish.guidelines,
	...Object.values(TOOL_TEXT.publish.params),
	TOOL_TEXT.agents.description,
	...TOOL_TEXT.agents.guidelines,
	...Object.values(TOOL_TEXT.agents.params),
	channelsToolText(),
	...TOOL_TEXT.channels.guidelines,
	TOOL_TEXT.storeFile.description,
	...TOOL_TEXT.storeFile.guidelines,
	...Object.values(TOOL_TEXT.storeFile.params),
	TOOL_TEXT.getFile.description,
	...TOOL_TEXT.getFile.guidelines,
	...Object.values(TOOL_TEXT.getFile.params),
];

describe("documented tool text", () => {
	it("quotes every tool description, guideline and parameter description", () => {
		const document = collapse(contracts);

		for (const text of documented) {
			expect(document).toContain(collapse(text));
		}
	});
});
