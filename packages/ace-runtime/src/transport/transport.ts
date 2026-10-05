/**
 * Handler a transport invokes for every raw inbound message.
 *
 * `receivedAt` is the broker's arrival time for the message, epoch milliseconds UTC, when the
 * transport can tell it — the Redis stream entry id carries it; transports without a broker-side
 * timestamp (the in-memory transport) omit the argument, and the rendered event drops its
 * `received at:` line rather than inventing render time (design doc §18).
 */
export type RawAceMessageHandler = (raw: unknown, receivedAt?: number) => Promise<void>;

/**
 * Transport adapter boundary (RFC §4, §21).
 *
 * Transports carry raw messages; ACE validates them. MQ metadata (Kafka topic,
 * NATS subject, RabbitMQ routing key, offsets, consumer groups) stays inside
 * the adapter and is never mapped to ACE fields (RFC §4).
 */
export interface Transport {
	start(handler: RawAceMessageHandler): Promise<void>;
	stop(): Promise<void>;
}
