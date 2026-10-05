import { createClient, RESP_TYPES, type RedisClientOptions } from "redis";
import type { XferClient, XferSetCommand } from "../tools/xfer.ts";

/** Give up after this many failed attempts instead of retrying a dead broker forever. */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 150;

/** A transfer client plus the teardown the host must run at shutdown. */
export interface RedisXferClient extends XferClient {
	close(): Promise<void>;
}

export interface RedisXferClientOptions {
	url: string;
	/** The server this client reaches, as `stored_on=` and `from=` name it. */
	name: string;
	/** Raw client options passed through to the `redis` package; never validated. */
	clientOptions?: Record<string, unknown>;
	/** Called when the broker connection fails, at most once per outage. */
	onError?: (error: unknown) => void;
}

/**
 * Adapt the `redis` package to {@link XferClient}: a non-destructive `GET` and one `MULTI`/`EXEC`
 * `SET` per key, all with `PX` expiry.
 *
 * The blob is binary, so `BLOB_STRING` is mapped to `Buffer` — the default mapping decodes a bulk
 * string as UTF-8 text and would corrupt it — while every other reply stays a string. Connection
 * failures are reported through `onError` at most once per outage, and reconnection is bounded so an
 * unreachable broker fails a transfer instead of retrying forever.
 */
export function createRedisXferClient(options: RedisXferClientOptions): RedisXferClient {
	const onError = options.onError ?? (() => {});
	// Library boundary: `clientOptions` is operator-supplied and never validated on our side.
	const operatorOptions = options.clientOptions as RedisClientOptions | undefined;
	const operatorSocket = typeof operatorOptions?.socket === "object" ? operatorOptions.socket : {};
	const client = createClient({
		...operatorOptions,
		url: options.url,
		commandOptions: { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } },
		socket: {
			...operatorSocket,
			reconnectStrategy: (retries) =>
				retries > MAX_RECONNECT_ATTEMPTS
					? new Error(`${options.url} is unreachable`)
					: retries * RECONNECT_DELAY_MS,
		},
	});

	let connected = false;
	let outageReported = false;
	client.on("error", (error) => {
		if (!connected || outageReported) return;
		outageReported = true;
		onError(new Error(`${options.url}: ${error instanceof Error ? error.message : String(error)}`));
	});

	/** Connect on demand; a completed command clears the outage latch so a later outage reports again. */
	async function connectIfNeeded(): Promise<void> {
		if (!client.isOpen) {
			await client.connect();
			connected = true;
		}
	}

	return {
		name: options.name,

		async get(key) {
			await connectIfNeeded();
			const reply = await client.get(key);
			outageReported = false;
			if (reply === null) return undefined;
			return typeof reply === "string" ? new TextEncoder().encode(reply) : reply;
		},

		async setMany(commands: readonly XferSetCommand[]) {
			await connectIfNeeded();
			const multi = client.multi();
			for (const command of commands) {
				const value = typeof command.value === "string" ? command.value : Buffer.from(command.value);
				multi.set(command.key, value, { expiration: { type: "PX", value: command.ttlMs } });
			}
			await multi.exec();
			outageReported = false;
		},

		async close() {
			if (client.isOpen) await client.quit();
		},
	};
}
