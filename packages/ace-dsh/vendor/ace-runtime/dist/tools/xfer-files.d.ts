import { type StoreInput, type XferClient } from "./xfer.ts";
/**
 * The host-facing half of the file-transfer feature: reading a local file and fanning it out to the
 * servers a session is live on, and writing a fetched blob into the quarantine directory. The
 * protocol-level half — keys, tokens, the one-pipeline write, the result lines — lives in
 * `tools/xfer.ts`; this module only touches the filesystem and loops over the servers, so a host
 * binds it to its own connections and a test drives it with fakes.
 */
/** One server a transfer runs against: what to name it, its namespace, and its Redis seam. */
export interface XferTarget {
    /** Server name, exactly as `stored_on=` and `from=` report it. */
    name: string;
    /** The namespace that server owns; the blob and metadata keys live under it. */
    namespace: string;
    /** The non-destructive read and pipelined write against {@link name}. */
    client: XferClient;
}
/** The outcome of {@link storeFile}: the relayable line plus the fields the host may surface. */
export interface StoreFileResult {
    /** The one line the model relays verbatim. */
    text: string;
    /** The token, which is the whole capability. */
    token: string;
    /** Bytes stored per copy. */
    size: number;
    /** Hex SHA-256 of the bytes. */
    sha256: string;
    /** The servers a copy landed on, in target order; empty when none did. */
    storedOn: string[];
}
/** The outcome of {@link receiveFile}: the relayable line plus the fields the host may surface. */
export interface GetFileResult {
    /** The one line the model relays verbatim. */
    text: string;
    /** Where the bytes were written (the quarantine path). */
    path: string;
    /** Hex SHA-256 computed here, from the bytes written. */
    sha256: string;
    /** Bytes written. */
    size: number;
    /** The server the copy came from. */
    from: string;
}
/**
 * Read a local file and store one copy under a fresh token on **every** target, in order.
 *
 * Per the feature's settled decision the result reports only where a copy landed (`stored_on=`) and
 * defines no success/failure semantics: a target whose write threw is simply absent from the line,
 * and an empty `stored_on=` is the whole story. The file errors (missing, directory, unreadable,
 * over the size ceiling) still throw, each as its own sentence.
 */
export declare function storeFile(options: {
    /** Workspace root: a relative `path` resolves against it. */
    root: string;
    /** The checked `ace_store_file` arguments. */
    input: StoreInput;
    /** The live servers, in configuration order. */
    targets: readonly XferTarget[];
    /** Per-copy ceiling; defaults to {@link XFER_DEFAULTS.defaultMaxBytes} inside `assertTransferSize`. */
    maxBytes?: number;
    /** Injectable clock, for deterministic metadata in tests. */
    now?: () => number;
}): Promise<StoreFileResult>;
/**
 * Fetch a token from the first target that has it (configuration order) and write the bytes into the
 * quarantine directory. The write path is derived here from the receiver's root, session id and the
 * sender's metadata name — no argument ever selects it. Throws the diagnostic sentence when no target
 * has the token, which is a normal outcome (it expired, or the two sides share no server).
 */
export declare function receiveFile(options: {
    /** Workspace root: the quarantine directory sits under it. */
    root: string;
    /** The checked `ace_get_file` arguments. */
    token: string;
    /** This session's id, so two sessions on one host do not collide. */
    sessionId: string;
    /** The live servers, in configuration order; the first hit wins. */
    targets: readonly XferTarget[];
}): Promise<GetFileResult>;
//# sourceMappingURL=xfer-files.d.ts.map