/** Handler a transport invokes for every raw inbound message. */
export type RawAceMessageHandler = (raw: unknown) => Promise<void>;

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
