import { createClient, type RedisClientOptions } from "redis";
import type { RedisStreamsClient } from "./redis-streams-client.ts";

/** Give up after this many failed attempts instead of retrying a dead broker forever. */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 150;

function isGroupAlreadyExistsError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("BUSYGROUP");
}

/** Resolve the field that carries the ACE message out of a stream entry. */
function payloadOf(entry: { message: Record<string, string> }, field: string): string | undefined {
	const value = entry.message[field];
	return typeof value === "string" ? value : undefined;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Adapt the `redis` package to {@link RedisStreamsClient}.
 *
 * Connection failures are reported through `onError` at most once per outage — the client would
 * otherwise emit one error per reconnect attempt — and reconnection is bounded so an unreachable
 * broker fails the start instead of retrying forever.
 */
export function createRedisStreamsClient(
	url: string,
	field: string,
	onError: (error: unknown) => void,
	clientOptions: Record<string, unknown> = {},
): RedisStreamsClient {
	// Operator-supplied passthrough (`.ace.json` `options`): the Redis client owns its own schema,
	// so this is the one place where configuration is handed over unchecked.
	const operatorOptions = clientOptions as RedisClientOptions;
	const operatorSocket = typeof operatorOptions.socket === "object" ? operatorOptions.socket : {};
	const client = createClient({
		...operatorOptions,
		url,
		socket: {
			...operatorSocket,
			// This transport always bounds reconnection so an unreachable broker fails the start.
			reconnectStrategy: (retries) =>
				retries > MAX_RECONNECT_ATTEMPTS ? new Error(`${url} is unreachable`) : retries * RECONNECT_DELAY_MS,
		},
	});

	// The initial connection failure is thrown by `connect()` (and reported once by the host);
	// afterwards each outage is reported at most once per successful command.
	let connected = false;
	let outageReported = false;
	client.on("error", (error) => {
		if (!connected || outageReported) return;
		outageReported = true;
		onError(new Error(`${url}: ${describeError(error)}`));
	});

	return {
		async connect() {
			await client.connect();
			connected = true;
		},

		async ensureGroup(stream, group) {
			try {
				// Start at the tail: ACE consumes events from now on; replay stays an
				// infrastructure capability we do not use yet (RFC §17).
				await client.xGroupCreate(stream, group, "$", { MKSTREAM: true });
				outageReported = false;
			} catch (error) {
				if (!isGroupAlreadyExistsError(error)) throw error;
				outageReported = false;
			}
		},

		async read(stream, group, consumer, count, blockMs) {
			const reply = await client.xReadGroup(group, consumer, [{ key: stream, id: ">" }], {
				COUNT: count,
				BLOCK: blockMs,
			});
			// A completed command means the connection is healthy again, so a later outage may be
			// reported once more.
			outageReported = false;
			const messages: Array<{ id: string; message: Record<string, string> }> = reply?.[0]?.messages ?? [];
			return messages.map((entry) => ({
				id: entry.id,
				payload: payloadOf(entry, field),
			}));
		},

		async ack(stream, group, id) {
			await client.xAck(stream, group, id);
		},

		async close() {
			if (client.isOpen) await client.quit();
		},
	};
}
