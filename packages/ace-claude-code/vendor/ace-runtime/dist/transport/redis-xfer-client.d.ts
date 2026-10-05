import type { XferClient } from "../tools/xfer.ts";
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
export declare function createRedisXferClient(options: RedisXferClientOptions): RedisXferClient;
//# sourceMappingURL=redis-xfer-client.d.ts.map