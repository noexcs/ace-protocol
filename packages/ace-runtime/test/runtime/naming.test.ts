import { describe, expect, it } from "vitest";
import {
	assertNoColon,
	channelName,
	channelStreamKey,
	directoryEntryKey,
	directoryKey,
	localName,
	NAMESPACE_DEFAULT,
	namespaceOf,
	resolveLocalName,
	senderName,
	usernameOf,
} from "../../src/runtime/naming.ts";

/**
 * The naming grammar is the one thing every host and tool must agree on, so it lives in one module and
 * is pinned here: `<server>:<ns>:<username>:<name>` locally, `<ns>:<username>:<name>` uploaded.
 * There is one name space — channels; a session's inbox is the channel named by its own sender.
 */
describe("naming", () => {
	it("builds the uploaded channel name", () => {
		expect(channelName("ace", "noexcs", "ci-failures")).toBe("ace:noexcs:ci-failures");
	});

	it("names a session's inbox channel after its sender", () => {
		const sender = senderName({ namespace: "ace", username: "noexcs", codingAgent: "oh-my-pi", sessionId: "01a10a" });

		expect(sender).toBe("ace:noexcs:oh-my-pi:01a10a");
		// The inbox is a channel like any other — same key path, no separate concept.
		expect(channelStreamKey("ace", sender)).toBe("ace:ch:ace:noexcs:oh-my-pi:01a10a");
	});

	it("defaults the namespace", () => {
		expect(namespaceOf({})).toBe(NAMESPACE_DEFAULT);
		expect(namespaceOf({ namespace: "lan" })).toBe("lan");
	});

	it("adds the server segment only when asked — that segment never travels", () => {
		const uploaded = channelName("ace", "noexcs", "ci-failures");

		expect(localName(undefined, uploaded)).toBe(uploaded);
		expect(localName("lan", uploaded)).toBe("lan:ace:noexcs:ci-failures");
	});

	it("completes a short name, and leaves a full one alone", () => {
		const options = { namespace: "ace", username: "noexcs" };

		expect(resolveLocalName({ ...options, name: "ci-failures" })).toBe("ace:noexcs:ci-failures");
		expect(resolveLocalName({ ...options, name: "ace:noexcs:ci-failures" })).toBe("ace:noexcs:ci-failures");
		expect(resolveLocalName({ ...options, name: "lan:ace:noexcs:ci-failures" })).toBe("lan:ace:noexcs:ci-failures");
	});

	it("derives the keys a namespace owns", () => {
		expect(directoryKey("ace")).toBe("ace:agents");
		expect(directoryEntryKey("ace")).toBe("ace:entry");
	});

	it("reads the username back out of an uploaded name", () => {
		expect(usernameOf("ace:noexcs:ci-failures")).toBe("noexcs");
		expect(usernameOf("ci-failures")).toBeUndefined();
	});

	it("refuses a colon in the three fixed segments", () => {
		expect(() => assertNoColon("lan", "server name")).not.toThrow();
		expect(() => assertNoColon("ace:lan", "namespace")).toThrow(/must not contain/);
		expect(() => assertNoColon("", "username")).toThrow(/must not be empty/);
	});
});
