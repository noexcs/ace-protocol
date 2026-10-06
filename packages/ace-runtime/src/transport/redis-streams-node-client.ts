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
	const socketOptions = {
		...operatorSocket,
		// Bounded so an unreachable broker fails `connect()` instead of retrying forever. That bound is
		// about *starting*: after start, recovery is this adapter's job (see `ensureUsable`), because a
		// client that spent its budget cannot be reused.
		reconnectStrategy: (retries: number) =>
			retries > MAX_RECONNECT_ATTEMPTS ? new Error(`${url} is unreachable`) : retries * RECONNECT_DELAY_MS,
	};

	// The initial connection failure is thrown by `connect()` (and reported once by the host);
	// afterwards each outage is reported at most once per successful command.
	let connected = false;
	let outageReported = false;
	const reportOutage = (error: unknown): void => {
		if (!connected || outageReported) return;
		outageReported = true;
		onError(new Error(`${url}: ${describeError(error)}`));
	};

	type Client = ReturnType<typeof createClient>;
	const spawn = (): Client => {
		const fresh = createClient({ ...operatorOptions, url, socket: socketOptions });
		fresh.on("error", reportOutage);
		return fresh;
	};

	let client: Client = spawn();

	/**
	 * Replace a client that cannot be used any more.
	 *
	 * `reconnectStrategy` above is bounded on purpose, so once its budget is spent the client's socket
	 * is gone for good and every command on it fails. Retrying such a corpse is how one broker blip
	 * used to leave a live session deaf until it restarted; the cure is a new client, not another
	 * command on the old one.
	 */
	const replaceClient = async (): Promise<void> => {
		const stale = client;
		client = spawn();
		try {
			stale.destroy();
		} catch {
			// Already gone; nothing to release.
		}
		outageReported = false;
		await client.connect();
		connected = true;
	};

	const ensureUsable = async (): Promise<void> => {
		if (client.isOpen && client.isReady) return;
		if (!connected) {
			// A client that never connected: `connect()` owns the failure (and the start gate).
			await client.connect();
			connected = true;
			return;
		}
		await replaceClient();
	};

	/** Run one command, replacing a dead client first and once more if it dies mid-command. */
	const command = async <T>(run: (client: Client) => Promise<T>): Promise<T> => {
		await ensureUsable();
		try {
			return await run(client);
		} catch (error) {
			if (client.isOpen && client.isReady) throw error;
			await replaceClient();
			return await run(client);
		}
	};

	return {
		async connect() {
			await ensureUsable();
		},

		async ensureGroup(stream, group) {
			await command(async (client) => {
				try {
					// Start at the tail: ACE consumes events from now on; replay stays an
					// infrastructure capability we do not use yet (RFC §17).
					await client.xGroupCreate(stream, group, "$", { MKSTREAM: true });
					outageReported = false;
				} catch (error) {
					if (!isGroupAlreadyExistsError(error)) throw error;
					outageReported = false;
				}
			});
		},

		async read(stream, group, consumer, count, blockMs) {
			return await command(async (client) => {
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
			});
		},

		async reclaim(stream, group, consumer, minIdleMs, count) {
			// Scanning from 0-0 each time is enough for a runtime that keeps its PEL small; a
			// long-lived PEL would want to carry `nextId` between calls.
			return await command(async (client) => {
				const reply = await client.xAutoClaim(stream, group, consumer, minIdleMs, "0-0", { COUNT: count });
				const messages = (reply.messages ?? []).filter(
					(entry): entry is { id: string; message: Record<string, string> } => entry !== null,
				);
				return messages.map((entry) => ({ id: entry.id, payload: payloadOf(entry, field) }));
			});
		},

		async ack(stream, group, id) {
			await command(async (client) => {
				await client.xAck(stream, group, id);
			});
		},

		async close() {
			if (client.isOpen) {
				try {
					await client.quit();
					return;
				} catch {
					// Fall through: a client that refused `quit()` still owns a socket.
				}
			}
			try {
				client.destroy();
			} catch {
				// Already gone.
			}
		},
	};
}
