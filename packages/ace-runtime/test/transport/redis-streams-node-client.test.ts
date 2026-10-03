import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { RedisStreamsTransport } from "../../src/transport/redis-streams-transport.ts";

/** Reserve a port, then close it so connecting there is refused deterministically. */
async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

describe("RedisStreamsTransport against an unreachable broker", () => {
	it("fails the start with one error instead of retrying forever", async () => {
		const port = await closedPort();
		const errors: unknown[] = [];
		const transport = new RedisStreamsTransport(
			{
				name: "build-events",
				transport: "redis-streams",
				config: { stream: "ace:events", group: "ace-pi", url: `redis://127.0.0.1:${port}` },
				options: {},
			},
			{ onError: (error) => errors.push(error) },
		);

		await expect(transport.start(async () => {})).rejects.toThrow(/unreachable/);

		// The start failure carries the diagnosis; reconnection is bounded, so there is no
		// per-attempt error storm (one notification per outage at most).
		expect(errors).toEqual([]);
	}, 10000);
});
