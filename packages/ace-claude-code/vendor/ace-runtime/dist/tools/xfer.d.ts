/**
 * The transfer defaults and limits. Every one that a caller may move is an option on the function
 * that uses it (`parseIsoDuration`'s `maxMs`, `assertTransferSize`'s `maxBytes`); the byte values
 * here are the ones a configuration may not exceed.
 */
export declare const XFER_DEFAULTS: {
    /** TTL a `send` gets when the caller omits `ttl`. */
    readonly defaultTtl: "PT1H";
    /** {@link defaultTtl} in milliseconds. */
    readonly defaultTtlMs: 3600000;
    /** Longest TTL a `send` may request. */
    readonly maxTtl: "P1D";
    /** {@link maxTtl} in milliseconds. */
    readonly maxTtlMs: 86400000;
    /** Bytes one transfer may carry when `maxTransferBytes` is not configured. */
    readonly defaultMaxBytes: 8388608;
    /** Most a caller may raise `maxTransferBytes` to. */
    readonly hardMaxBytes: 67108864;
    /** Every transfer at or above this is refused: the Redis single-value ceiling. */
    readonly refuseAtBytes: 536870912;
};
/**
 * The messages this feature's tools return when they cannot do their job — read by the model, so
 * defined once. The house style: name the offending value, then the form that is expected.
 */
export declare const XFER_ERROR_TEXT: {
    readonly invalidPath: (value: unknown) => string;
    readonly invalidName: (value: unknown) => string;
    readonly missingFile: (value: string) => string;
    readonly notAFile: (value: string) => string;
    readonly unreadableFile: (value: string, reason: string) => string;
    readonly noBlobOnAnyServer: () => string;
    readonly invalidTtl: (value: unknown) => string;
    readonly invalidDuration: (value: unknown) => string;
    readonly durationTooLong: (value: string, max: string) => string;
    readonly invalidToken: (value: unknown) => string;
    readonly emptyName: (value: string) => string;
    readonly dotName: (value: string) => string;
    readonly invalidSize: (value: number) => string;
    readonly sizeAtCeiling: (value: number) => string;
    readonly maxBytesAboveHardMax: (value: number) => string;
    readonly sizeAboveMax: (value: number, max: number) => string;
    readonly blobWithoutMeta: (key: string) => string;
    readonly metaMalformed: (key: string) => string;
};
/**
 * An ISO 8601 duration to milliseconds. Case-insensitive; refuses anything the pattern does not name,
 * a duration that is not positive, and one longer than the maximum TTL (default `P1D`, or `maxMs`
 * when a caller allows a different ceiling, with `maxIso` naming it in the sentence).
 */
export declare function parseIsoDuration(value: unknown, options?: {
    maxMs?: number;
    maxIso?: string;
}): number;
/**
 * A fresh 128-bit token, as 32 lowercase hex characters. The token is the whole capability: it names
 * the keys and nothing else travels with it, so it is minted here and never derived from a path,
 * a name or a server.
 */
export declare function newToken(): string;
/**
 * The name this feature writes to disk: the last path segment of `raw`, with every control character
 * removed. `.` and `..` are refused, as is a result that is empty — each would have the write land on
 * a directory instead of a file. The original name is only metadata; the bytes on disk get this one.
 */
export declare function sanitizeName(raw: string): string;
/** `<ns>:xfer:<token>` — the blob key, in the same family as `<ns>:ch:<channel>`. */
export declare function xferBlobKey(namespace: string, token: string): string;
/** `<ns>:xfer:<token>:meta` — the metadata side key that travels with a blob. */
export declare function xferMetaKey(namespace: string, token: string): string;
/**
 * `<root>/.ace/xfer/<token>/<sessionId>/<name>` — the only path this feature ever writes.
 *
 * `name` is sanitised again here, so even a caller that forgot {@link sanitizeName} cannot make the
 * write leave the quarantine root; `token` and `sessionId` are module- or host-generated and are
 * used as written.
 */
export declare function quarantinePath(root: string, token: string, sessionId: string, name: string): string;
/**
 * The metadata side key's value: what the receiver needs to name the file and to check the bytes
 * itself. `createdAt` and `expiresAt` are epoch milliseconds; `sha256` is integrity only.
 */
export interface XferMeta {
    /** The sender's file name (its original, unsanitised form). */
    name: string;
    /** Size in bytes of the blob. */
    size: number;
    /** Hex SHA-256 of the blob, computed by the sender. */
    sha256: string;
    /** When the blob was stored, epoch ms. */
    createdAt: number;
    /** When the keys expire, epoch ms. */
    expiresAt: number;
}
/** One `SET` of the single pipeline {@link putBlob} issues. */
export interface XferSetCommand {
    readonly key: string;
    /** The blob is bytes; the metadata side key is the JSON text. */
    readonly value: Uint8Array | string;
    /** `PX` expiry for this key, in milliseconds. */
    readonly ttlMs: number;
}
/**
 * The narrow Redis surface the transfer needs: a non-destructive read and one pipelined multi-`SET`.
 *
 * Kept deliberately small so tests run without a broker; the host adapts the `redis` package to it.
 * A peer reads with `GET`, never `GETDEL` — the same pickup code stays readable by anyone until the
 * TTL expires.
 */
export interface XferClient {
    /** The server this client reaches, as `from=` and `stored_on=` name it. */
    readonly name: string;
    /** `GET key`, or `undefined` when the key is absent. Never removes the key. */
    get(key: string): Promise<Uint8Array | undefined>;
    /** Every `SET key value PX ttlMs`, in one round trip, so both keys land together. */
    setMany(commands: readonly XferSetCommand[]): Promise<void>;
}
/**
 * Store one copy of a transfer: the blob and its metadata side key in one pipeline, each with the
 * same TTL. One call per server; the caller stores the same token on each.
 */
export declare function putBlob(options: {
    client: XferClient;
    namespace: string;
    token: string;
    bytes: Uint8Array;
    meta: XferMeta;
    ttlMs: number;
}): Promise<void>;
/**
 * Read one copy back, without removing it: the blob and its metadata side key.
 *
 * `undefined` when this server has no such blob — the caller then tries its next server. A blob
 * without its metadata is an **error**, not a silent read: the two keys are written together, so it
 * means an interrupted write, and the receiver needs the metadata's name to choose a path.
 */
export declare function takeBlob(options: {
    client: XferClient;
    namespace: string;
    token: string;
}): Promise<{
    bytes: Uint8Array;
    meta: XferMeta;
    from: string;
} | undefined>;
/**
 * Refuse a transfer whose size is outside the limits: never at or above the Redis single-value
 * ceiling, never above `maxBytes` (default {@link XFER_DEFAULTS.defaultMaxBytes}), and `maxBytes`
 * itself never above {@link XFER_DEFAULTS.hardMaxBytes}. The limit is per copy: storing on N servers
 * costs N times the size.
 */
export declare function assertTransferSize(sizeBytes: number, options?: {
    maxBytes?: number;
}): void;
/** The checked `ace_store_file` arguments: a path to read and the TTL requested. */
export interface StoreInput {
    /** The path exactly as written; the host reads it after this check. */
    path: string;
    /** The requested TTL as normalised ISO 8601, defaulted to {@link XFER_DEFAULTS.defaultTtl}. */
    ttl: string;
    /** {@link ttl} in milliseconds. */
    ttlMs: number;
    /**
     * The name to store the bytes under, when the caller overrides the path's basename. Already run
     * through {@link sanitizeName}, so it is a single safe segment the receiver can write.
     */
    name?: string;
}
/** Validate the raw `ace_store_file` arguments; throws a usage error naming the offending value. */
export declare function validateStoreInput(params: Record<string, unknown>): StoreInput;
/** The checked `ace_get_file` arguments: the pickup code. */
export interface GetInput {
    /** The token, lowercased so a relay that changed its case still finds the keys. */
    token: string;
}
/** Validate the raw `ace_get_file` arguments; throws a usage error naming the offending value. */
export declare function validateGetInput(params: Record<string, unknown>): GetInput;
/**
 * The `ace_store_file` result: one line the model relays verbatim. `stored_on=` is the servers the
 * copy landed on (empty when none accepted it — the caller reports the failures separately, per the
 * doc's "no success/failure verdict"); `expires_in=` echoes the requested ISO 8601 duration.
 */
export declare function formatSendResult(options: {
    token: string;
    size: number;
    sha256: string;
    expiresIn: string;
    storedOn: readonly string[];
}): string;
/**
 * The `ace_get_file` result: the quarantine path the bytes landed at, the hash computed here, the
 * size, and the server they came from. The hash is reported, never adjudicated — the caller compares
 * it with the sender's and with the metadata's.
 */
export declare function formatGetResult(options: {
    path: string;
    sha256: string;
    size: number;
    from: string;
}): string;
//# sourceMappingURL=xfer.d.ts.map