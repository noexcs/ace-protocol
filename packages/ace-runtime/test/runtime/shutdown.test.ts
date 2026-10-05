import { describe, expect, it } from "vitest";
import { shutdownAce } from "../../src/runtime/shutdown.ts";

/**
 * A host's teardown calls three things in one order, and a failure in any of them must not skip the
 * rest — a broker connection that died mid-session would otherwise strand the directory entry, or the
 * client, and the next start in the same process would find them.
 */
function recorder(failures: readonly string[] = []) {
	const calls: string[] = [];
	const step = (name: string) => async (): Promise<void> => {
		calls.push(name);
		if (failures.includes(name)) throw new Error(`${name} failed`);
	};
	return {
		calls,
		runtime: { stop: step("stop") },
		registry: { unregister: step("unregister"), close: step("close") },
	};
}

describe("shutdownAce", () => {
	it("stops the reader before the directory lets go of the session's stream", async () => {
		const r = recorder();

		await shutdownAce({ runtime: r.runtime, registry: r.registry });

		expect(r.calls).toEqual(["stop", "unregister", "close"]);
	});

	it("keeps going when a step fails, and names the step it reported", async () => {
		const r = recorder(["stop", "unregister"]);
		const reported: string[] = [];

		await shutdownAce({ runtime: r.runtime, registry: r.registry, onError: (step) => reported.push(step) });

		expect(r.calls).toEqual(["stop", "unregister", "close"]);
		expect(reported).toEqual(["runtime stop", "registry unregister"]);
	});

	it("tolerates a session that never started", async () => {
		await expect(shutdownAce({})).resolves.toBeUndefined();
	});
});
