import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { describeValue, isPlainObject } from "../utils.js";
import { rejectUnknownArguments } from "./publish.js";
/**
 * The core of the file-transfer feature (`docs/ace-file-transfer.md`): a sender stores a local file
 * under a random token on every server it is live on, and hands the token to a peer as the pickup
 * code; the peer reads the bytes back from its own servers and writes them into a quarantine
 * directory. The content never enters any model's context.
 *
 * What this module owns: the token, the two Redis keys per transfer, the one-pipeline write, the
 * non-destructive read, the name sanitiser, the quarantine path, the argument checks and the result
 * lines. What it deliberately does **not** own: reading or writing files, choosing servers, and
 * adjudicating hashes — `sha256` is computed and reported for the two sides to compare themselves,
 * because the hash comes from the same untrusted sender as the bytes.
 *
 * The binding rules from the doc, kept here so a later wiring step cannot drift from them:
 * - the only path this feature ever writes is {@link quarantinePath}; no caller and no event ever
 *   supplies a write path;
 * - the token is the whole capability: neither a namespace nor a server name travels with it;
 * - the blob and its metadata side key are written in one pipeline, so the window where one exists
 *   without the other is minimal (and a blob found without its metadata is an error, not a read).
 */
/** The names this feature's tools register under (the hosts add them to `spec.ts` in a later step). */
const XFER_TOOL_NAMES = { store: "ace_store_file", get: "ace_get_file" };
/** The arguments each tool declares; mirrors `TOOL_ARGUMENTS` once the hosts register the tools. */
const STORE_ARGUMENTS = ["path", "ttl", "name"];
const GET_ARGUMENTS = ["token"];
/** The quarantine directory under the workspace root; the feature never writes anywhere else. */
const QUARANTINE_DIR = [".ace", "xfer"];
/** Bytes in a mebibyte, only for the size sentences (limits are held in bytes). */
const MIB = 1_048_576;
/** A 128-bit token is 32 lowercase hex characters; `token` is the capability, so its shape is checked. */
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
/** A character a name may not carry onto disk: whitespace stays, but a control character is stripped. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
/** A value the one-line shape must quote: whitespace or a control character would break `key=value`. */
const FIELD_NEEDS_QUOTING = /[\s\u0000-\u001f\u007f-\u009f]/;
const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;
/**
 * The transfer defaults and limits. Every one that a caller may move is an option on the function
 * that uses it (`parseIsoDuration`'s `maxMs`, `assertTransferSize`'s `maxBytes`); the byte values
 * here are the ones a configuration may not exceed.
 */
export const XFER_DEFAULTS = {
    /** TTL a `send` gets when the caller omits `ttl`. */
    defaultTtl: "PT1H",
    /** {@link defaultTtl} in milliseconds. */
    defaultTtlMs: 3_600_000,
    /** Longest TTL a `send` may request. */
    maxTtl: "P1D",
    /** {@link maxTtl} in milliseconds. */
    maxTtlMs: 86_400_000,
    /** Bytes one transfer may carry when `maxTransferBytes` is not configured. */
    defaultMaxBytes: 8_388_608,
    /** Most a caller may raise `maxTransferBytes` to. */
    hardMaxBytes: 67_108_864,
    /** Every transfer at or above this is refused: the Redis single-value ceiling. */
    refuseAtBytes: 536_870_912,
};
/**
 * The messages this feature's tools return when they cannot do their job — read by the model, so
 * defined once. The house style: name the offending value, then the form that is expected.
 */
export const XFER_ERROR_TEXT = {
    invalidPath: (value) => `ace_store_file \`path\` must be a non-empty string, received ${describeValue(value)}`,
    invalidName: (value) => `ace_store_file \`name\` must be a non-empty string, received ${describeValue(value)}`,
    missingFile: (value) => `file ${describeValue(value)} does not exist`,
    notAFile: (value) => `\`path\` ${describeValue(value)} is a directory, not a file`,
    unreadableFile: (value, reason) => `file ${describeValue(value)} cannot be read: ${reason}`,
    noBlobOnAnyServer: () => "no blob for that token on any of your servers: it may have expired, or you and the sender share no server",
    invalidTtl: (value) => `ace_store_file \`ttl\` must be an ISO 8601 duration such as "PT1H", received ${describeValue(value)}`,
    invalidDuration: (value) => `${describeValue(value)} is not a positive ISO 8601 duration; expected a form such as "PT1H" ` +
        `(days, hours, minutes and seconds)`,
    durationTooLong: (value, max) => `${describeValue(value)} is longer than the maximum ttl "${max}"`,
    invalidToken: (value) => `ace_get_file \`token\` must be a 128-bit hex token (32 hex characters), received ${describeValue(value)}`,
    emptyName: (value) => `file name ${describeValue(value)} is empty after removing path separators and control characters; ` +
        `expected a name with at least one such character`,
    dotName: (value) => `file name ${describeValue(value)} names a directory entry, not a file`,
    invalidSize: (value) => `transfer size ${value} must be a non-negative integer number of bytes`,
    sizeAtCeiling: (value) => `transfer of ${value} bytes (${mib(value)}) is refused: it is at or above the ${mib(XFER_DEFAULTS.refuseAtBytes)} Redis single-value ceiling`,
    maxBytesAboveHardMax: (value) => `maxTransferBytes ${value} (${mib(value)}) is above the hard maximum ${mib(XFER_DEFAULTS.hardMaxBytes)} (${XFER_DEFAULTS.hardMaxBytes} bytes)`,
    sizeAboveMax: (value, max) => `transfer of ${value} bytes (${mib(value)}) exceeds the configured maximum ${max} bytes (${mib(max)})`,
    blobWithoutMeta: (key) => `a blob exists without its metadata — likely an interrupted write (the key "${key}" is missing)`,
    metaMalformed: (key) => `the metadata at key "${key}" is not a valid transfer record`,
};
/** Bytes as a short mebibyte figure for the size sentences. */
function mib(bytes) {
    const value = bytes / MIB;
    return `${Number.isInteger(value) ? value : value.toFixed(1)} MiB`;
}
/**
 * The duration subset the TTL uses: `P[nW][nD][T[nH][nM][nS]]`. Kept as one pattern so `P`, `PT`
 * and a bare `P1DT` (a time designator with nothing after it) can be refused rather than read as
 * zero — a zero-second TTL is an expired key, not a transfer.
 */
const ISO_DURATION_PATTERN = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
/** Parse the pattern's groups to milliseconds; `undefined` when `text` names no duration. */
function isoDurationToMs(text) {
    const match = ISO_DURATION_PATTERN.exec(text);
    if (match === null)
        return undefined;
    const [, weeks, days, hours, minutes, seconds] = match;
    const hasComponent = weeks !== undefined ||
        days !== undefined ||
        hours !== undefined ||
        minutes !== undefined ||
        seconds !== undefined;
    if (!hasComponent)
        return undefined;
    // `...T` with no time component names nothing after the designator.
    const hasTime = text.includes("T");
    if (hasTime && hours === undefined && minutes === undefined && seconds === undefined)
        return undefined;
    return Math.round(Number(weeks ?? 0) * MS_PER_WEEK +
        Number(days ?? 0) * MS_PER_DAY +
        Number(hours ?? 0) * MS_PER_HOUR +
        Number(minutes ?? 0) * MS_PER_MINUTE +
        Number(seconds ?? 0) * MS_PER_SECOND);
}
/**
 * An ISO 8601 duration to milliseconds. Case-insensitive; refuses anything the pattern does not name,
 * a duration that is not positive, and one longer than the maximum TTL (default `P1D`, or `maxMs`
 * when a caller allows a different ceiling, with `maxIso` naming it in the sentence).
 */
export function parseIsoDuration(value, options = {}) {
    if (typeof value !== "string")
        throw new Error(XFER_ERROR_TEXT.invalidDuration(value));
    const ms = isoDurationToMs(value.trim().toUpperCase());
    if (ms === undefined || ms <= 0)
        throw new Error(XFER_ERROR_TEXT.invalidDuration(value));
    const maxMs = options.maxMs ?? XFER_DEFAULTS.maxTtlMs;
    if (ms > maxMs)
        throw new Error(XFER_ERROR_TEXT.durationTooLong(value, options.maxIso ?? XFER_DEFAULTS.maxTtl));
    return ms;
}
/**
 * A fresh 128-bit token, as 32 lowercase hex characters. The token is the whole capability: it names
 * the keys and nothing else travels with it, so it is minted here and never derived from a path,
 * a name or a server.
 */
export function newToken() {
    return randomBytes(16).toString("hex");
}
/**
 * The name this feature writes to disk: the last path segment of `raw`, with every control character
 * removed. `.` and `..` are refused, as is a result that is empty — each would have the write land on
 * a directory instead of a file. The original name is only metadata; the bytes on disk get this one.
 */
export function sanitizeName(raw) {
    const basename = raw.split(/[\\/]/).pop() ?? "";
    const cleaned = basename.replace(CONTROL_CHARACTERS, "");
    if (cleaned.length === 0)
        throw new Error(XFER_ERROR_TEXT.emptyName(raw));
    if (cleaned === "." || cleaned === "..")
        throw new Error(XFER_ERROR_TEXT.dotName(raw));
    return cleaned;
}
/** `<ns>:xfer:<token>` — the blob key, in the same family as `<ns>:ch:<channel>`. */
export function xferBlobKey(namespace, token) {
    return `${namespace}:xfer:${token}`;
}
/** `<ns>:xfer:<token>:meta` — the metadata side key that travels with a blob. */
export function xferMetaKey(namespace, token) {
    return `${namespace}:xfer:${token}:meta`;
}
/**
 * `<root>/.ace/xfer/<token>/<sessionId>/<name>` — the only path this feature ever writes.
 *
 * `name` is sanitised again here, so even a caller that forgot {@link sanitizeName} cannot make the
 * write leave the quarantine root; `token` and `sessionId` are module- or host-generated and are
 * used as written.
 */
export function quarantinePath(root, token, sessionId, name) {
    return join(root, ...QUARANTINE_DIR, token, sessionId, sanitizeName(name));
}
/**
 * Store one copy of a transfer: the blob and its metadata side key in one pipeline, each with the
 * same TTL. One call per server; the caller stores the same token on each.
 */
export async function putBlob(options) {
    const { client, namespace, token, bytes, meta, ttlMs } = options;
    await client.setMany([
        { key: xferBlobKey(namespace, token), value: bytes, ttlMs },
        { key: xferMetaKey(namespace, token), value: JSON.stringify(meta), ttlMs },
    ]);
}
const TEXT_DECODER = new TextDecoder();
/** Read the metadata side key's JSON, refusing a record that is not the shape `putBlob` writes. */
function parseMeta(raw, key) {
    let value;
    try {
        value = JSON.parse(TEXT_DECODER.decode(raw));
    }
    catch {
        throw new Error(XFER_ERROR_TEXT.metaMalformed(key));
    }
    if (!isPlainObject(value) ||
        typeof value.name !== "string" ||
        typeof value.size !== "number" ||
        typeof value.sha256 !== "string" ||
        typeof value.storedAt !== "number" ||
        typeof value.expiresAt !== "number") {
        throw new Error(XFER_ERROR_TEXT.metaMalformed(key));
    }
    return {
        name: value.name,
        size: value.size,
        sha256: value.sha256,
        storedAt: value.storedAt,
        expiresAt: value.expiresAt,
    };
}
/**
 * Read one copy back, without removing it: the blob and its metadata side key.
 *
 * `undefined` when this server has no such blob — the caller then tries its next server. A blob
 * without its metadata is an **error**, not a silent read: the two keys are written together, so it
 * means an interrupted write, and the receiver needs the metadata's name to choose a path.
 */
export async function takeBlob(options) {
    const { client, namespace, token } = options;
    const bytes = await client.get(xferBlobKey(namespace, token));
    if (bytes === undefined)
        return undefined;
    const metaKey = xferMetaKey(namespace, token);
    const rawMeta = await client.get(metaKey);
    if (rawMeta === undefined)
        throw new Error(XFER_ERROR_TEXT.blobWithoutMeta(metaKey));
    return { bytes, meta: parseMeta(rawMeta, metaKey), from: client.name };
}
/**
 * Refuse a transfer whose size is outside the limits: never at or above the Redis single-value
 * ceiling, never above `maxBytes` (default {@link XFER_DEFAULTS.defaultMaxBytes}), and `maxBytes`
 * itself never above {@link XFER_DEFAULTS.hardMaxBytes}. The limit is per copy: storing on N servers
 * costs N times the size.
 */
export function assertTransferSize(sizeBytes, options = {}) {
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0)
        throw new Error(XFER_ERROR_TEXT.invalidSize(sizeBytes));
    if (sizeBytes >= XFER_DEFAULTS.refuseAtBytes)
        throw new Error(XFER_ERROR_TEXT.sizeAtCeiling(sizeBytes));
    const maxBytes = options.maxBytes ?? XFER_DEFAULTS.defaultMaxBytes;
    if (maxBytes > XFER_DEFAULTS.hardMaxBytes)
        throw new Error(XFER_ERROR_TEXT.maxBytesAboveHardMax(maxBytes));
    if (sizeBytes > maxBytes)
        throw new Error(XFER_ERROR_TEXT.sizeAboveMax(sizeBytes, maxBytes));
}
/** Validate the raw `ace_store_file` arguments; throws a usage error naming the offending value. */
export function validateStoreInput(params) {
    rejectUnknownArguments(XFER_TOOL_NAMES.store, params, STORE_ARGUMENTS);
    const path = params.path;
    // A path is read as written — leading/trailing spaces are legal in a name — so only the
    // whitespace-only and non-string shapes are refused here.
    if (typeof path !== "string" || path.trim().length === 0)
        throw new Error(XFER_ERROR_TEXT.invalidPath(path));
    // An override is normalised through the same sanitiser the receiver's write path uses, so a value
    // that could not be written (`..`, `.`, empty after stripping separators) is refused at the sender.
    const rawName = params.name;
    let name;
    if (rawName !== undefined) {
        if (typeof rawName !== "string" || rawName.trim().length === 0)
            throw new Error(XFER_ERROR_TEXT.invalidName(rawName));
        name = sanitizeName(rawName);
    }
    const ttl = params.ttl;
    if (ttl === undefined) {
        return {
            path,
            ttl: XFER_DEFAULTS.defaultTtl,
            ttlMs: XFER_DEFAULTS.defaultTtlMs,
            ...(name === undefined ? {} : { name }),
        };
    }
    if (typeof ttl !== "string" || ttl.trim().length === 0)
        throw new Error(XFER_ERROR_TEXT.invalidTtl(ttl));
    const normalised = ttl.trim().toUpperCase();
    return { path, ttl: normalised, ttlMs: parseIsoDuration(normalised), ...(name === undefined ? {} : { name }) };
}
/** Validate the raw `ace_get_file` arguments; throws a usage error naming the offending value. */
export function validateGetInput(params) {
    rejectUnknownArguments(XFER_TOOL_NAMES.get, params, GET_ARGUMENTS);
    const token = params.token;
    if (typeof token !== "string" || token.trim().length === 0)
        throw new Error(XFER_ERROR_TEXT.invalidToken(token));
    // The token's case carries no meaning, so a relayed code is normalised rather than refused; the
    // shape itself is still checked, so anything that is not 128 bits fails before a lookup.
    const normalised = token.trim().toLowerCase();
    if (!TOKEN_PATTERN.test(normalised))
        throw new Error(XFER_ERROR_TEXT.invalidToken(token));
    return { token: normalised };
}
/** `key=value`, quoted when the value would break the one-line shape. */
function field(key, value) {
    return `${key}=${FIELD_NEEDS_QUOTING.test(value) ? JSON.stringify(value) : value}`;
}
/**
 * The `ace_store_file` result: one line the model relays verbatim. `name=` is the **effective** name —
 * the basename after separator and control-character stripping, the same name the receiver will write
 * and the same one the blob's metadata carries — so the sender sees it without a round trip.
 * `stored_on=` is the servers the copy landed on (empty when none accepted it — the caller reports the
 * failures separately, per the doc's "no success/failure verdict"); `ttl=` echoes the requested ISO
 * 8601 duration and `stored_at=`/`expires_at=` are UTC instants with milliseconds, so a receiver can
 * tell when the token expires without re-fetching.
 */
export function formatSendResult(options) {
    return [
        `pickup=${options.token}`,
        `size=${options.size}`,
        `sha256=${options.sha256}`,
        field("name", options.name),
        `ttl=${options.ttl}`,
        `stored_at=${new Date(options.storedAt).toISOString()}`,
        `expires_at=${new Date(options.expiresAt).toISOString()}`,
        field("stored_on", options.storedOn.join(",")),
    ].join(" ");
}
/**
 * The `ace_get_file` result: the quarantine path the bytes landed at, the hash computed here, the
 * size, the name they were written under, the server they came from, and the blob's own
 * `stored_at=`/`expires_at=` read from its metadata — so the receiver learns when the pickup token
 * expires without a second fetch. The hash is reported, never adjudicated — the caller compares it
 * with the sender's and with the metadata's.
 */
export function formatGetResult(options) {
    return [
        field("path", options.path),
        `sha256=${options.sha256}`,
        `size=${options.size}`,
        field("name", options.name),
        field("from", options.from),
        `stored_at=${new Date(options.storedAt).toISOString()}`,
        `expires_at=${new Date(options.expiresAt).toISOString()}`,
    ].join(" ");
}
//# sourceMappingURL=xfer.js.map