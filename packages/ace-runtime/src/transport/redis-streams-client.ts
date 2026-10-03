/** One stream entry handed to the transport, reduced to identity + ACE payload. */
export interface RedisStreamEntry {
	/** Redis Streams entry ID (MQ metadata; stays inside the adapter, RFC §4). */
	readonly id: string;
	/** Value of the configured payload field; `undefined` when the producer omitted it. */
	readonly payload: string | undefined;
}

/**
 * The narrow Redis surface this transport needs.
 *
 * Kept deliberately small so tests can run without a broker;
 * `redis-streams-node-client.ts` adapts the `redis` package to it.
 */
export interface RedisStreamsClient {
	connect(): Promise<void>;
	/** Create `stream`/`group` when missing; resolve when the group already exists. */
	ensureGroup(stream: string, group: string): Promise<void>;
	/** Read up to `count` new entries for `group`, blocking at most `blockMs`. */
	read(stream: string, group: string, consumer: string, count: number, blockMs: number): Promise<RedisStreamEntry[]>;
	/** Acknowledge one entry so it leaves the group's pending entries list. */
	ack(stream: string, group: string, id: string): Promise<void>;
	close(): Promise<void>;
}
