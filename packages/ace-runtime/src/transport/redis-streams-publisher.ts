import { createClient, type RedisClientOptions } from "redis";
import type { AceMessage } from "../protocol/ace-message.ts";
import { validateAceMessage } from "../protocol/validator.ts";

/** Give up after this many failed attempts instead of retrying a dead broker forever. */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 150;

/**
 * Publishes ACE messages to a configured target (RFC §19: Agent → Agent, Agent → Service).
 *
 * The target address lives in runtime configuration, never in the message (RFC §4.1), so a
 * publisher is bound to one destination.
 */
export interface AcePublisher {
	publish(message: AceMessage): Promise<void>;
	close(): Promise<void>;
}

/** The narrow Redis surface the publisher needs; keeps tests broker-free. */
export interface RedisStreamsAddClient {
	/** Append one entry and return its id. */
	add(stream: string, field: string, value: string): Promise<string>;
	close(): Promise<void>;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Adapt the `redis` package to {@link RedisStreamsAddClient}.
 *
 * Connects on the first publish so a session can start while a publish target is down; failures
 * are reported through `onError` at most once per outage, and reconnection is bounded.
 */
export function createRedisStreamsAddClient(
	url: string,
	onError: (error: unknown) => void,
	clientOptions: Record<string, unknown> = {},
): RedisStreamsAddClient {
	// Operator-supplied passthrough (`.ace.json` `options`); see the consumer client for the rationale.
	const operatorOptions = clientOptions as RedisClientOptions;
	const operatorSocket = typeof operatorOptions.socket === "object" ? operatorOptions.socket : {};
	const client = createClient({
		...operatorOptions,
		url,
		socket: {
			...operatorSocket,
			reconnectStrategy: (retries) =>
				retries > MAX_RECONNECT_ATTEMPTS ? new Error(`${url} is unreachable`) : retries * RECONNECT_DELAY_MS,
		},
	});

	let connected = false;
	let outageReported = false;
	client.on("error", (error) => {
		if (!connected || outageReported) return;
		outageReported = true;
		onError(new Error(`${url}: ${describeError(error)}`));
	});

	return {
		async add(stream, field, value) {
			if (!client.isOpen) {
				await client.connect();
				connected = true;
			}
			const entryId = await client.xAdd(stream, "*", { [field]: value });
			outageReported = false;
			return entryId;
		},

		async close() {
			if (client.isOpen) await client.quit();
		},
	};
}

export interface RedisStreamsPublisherOptions {
	url: string;
	stream: string;
	/** Stream entry field carrying the ACE message JSON; mirrors the consumer side. */
	field: string;
	/** Injected client; defaults to a `redis` client for `url`. */
	client?: RedisStreamsAddClient;
	/** Raw client options passed through to the `redis` package. */
	clientOptions?: Record<string, unknown>;
	/** Called when the broker connection fails. */
	onError?: (error: unknown) => void;
}

/** Publishes ACE messages as Redis Stream entries. */
export class RedisStreamsPublisher implements AcePublisher {
	readonly stream: string;

	private readonly field: string;
	private readonly client: RedisStreamsAddClient;
	private readonly onError: (error: unknown) => void;

	constructor(options: RedisStreamsPublisherOptions) {
		this.stream = options.stream;
		this.field = options.field;
		this.onError = options.onError ?? (() => {});
		this.client =
			options.client ??
			createRedisStreamsAddClient(
				options.url,
				(error) => {
					try {
						this.onError(error);
					} catch {
						// A failing error hook must not break publishing.
					}
				},
				options.clientOptions,
			);
	}

	/** Validate before emitting: this runtime never publishes a non-conforming message (RFC §13). */
	async publish(message: AceMessage): Promise<void> {
		const validated = validateAceMessage(message);
		await this.client.add(this.stream, this.field, JSON.stringify(validated));
	}

	async close(): Promise<void> {
		await this.client.close();
	}
}
