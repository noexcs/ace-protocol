import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { describeValue, isPlainObject } from "../utils.ts";
import { rejectUnknownArguments } from "./publish.ts";

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
const XFER_TOOL_NAMES = { store: "ace_store_file", get: "ace_get_file" } as const;

/** The arguments each tool declares; mirrors `TOOL_ARGUMENTS` once the hosts register the tools. */
const STORE_ARGUMENTS = ["path", "ttl", "name"] as const;
const GET_ARGUMENTS = ["token"] as const;

/** The quarantine directory under the workspace root; the feature never writes anywhere else. */
const QUARANTINE_DIR = [".ace", "xfer"] as const;

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
} as const;

/**
 * The messages this feature's tools return when they cannot do their job — read by the model, so
 * defined once. The house style: name the offending value, then the form that is expected.
 */
export const XFER_ERROR_TEXT = {
	invalidPath: (value: unknown): string =>
		`ace_store_file \`path\` must be a non-empty string, received ${describeValue(value)}`,
	invalidName: (value: unknown): string =>
		`ace_store_file \`name\` must be a non-empty string, received ${describeValue(value)}`,
	missingFile: (value: string): string => `file ${describeValue(value)} does not exist`,
	notAFile: (value: string): string => `\`path\` ${describeValue(value)} is a directory, not a file`,
	unreadableFile: (value: string, reason: string): string => `file ${describeValue(value)} cannot be read: ${reason}`,
	noBlobOnAnyServer: (): string =>
		"no blob for that token on any of your servers: it may have expired, or you and the sender share no server",
	invalidTtl: (value: unknown): string =>
		`ace_store_file \`ttl\` must be an ISO 8601 duration such as "PT1H", received ${describeValue(value)}`,
	invalidDuration: (value: unknown): string =>
		`${describeValue(value)} is not a positive ISO 8601 duration; expected a form such as "PT1H" ` +
		`(days, hours, minutes and seconds)`,
	durationTooLong: (value: string, max: string): string =>
		`${describeValue(value)} is longer than the maximum ttl "${max}"`,
	invalidToken: (value: unknown): string =>
		`ace_get_file \`token\` must be a 128-bit hex token (32 hex characters), received ${describeValue(value)}`,
	emptyName: (value: string): string =>
		`file name ${describeValue(value)} is empty after removing path separators and control characters; ` +
		`expected a name with at least one such character`,
	dotName: (value: string): string => `file name ${describeValue(value)} names a directory entry, not a file`,
	invalidSize: (value: number): string => `transfer size ${value} must be a non-negative integer number of bytes`,
	sizeAtCeiling: (value: number): string =>
		`transfer of ${value} bytes (${mib(value)}) is refused: it is at or above the ${mib(
			XFER_DEFAULTS.refuseAtBytes,
		)} Redis single-value ceiling`,
	maxBytesAboveHardMax: (value: number): string =>
		`maxTransferBytes ${value} (${mib(value)}) is above the hard maximum ${mib(
			XFER_DEFAULTS.hardMaxBytes,
		)} (${XFER_DEFAULTS.hardMaxBytes} bytes)`,
	sizeAboveMax: (value: number, max: number): string =>
		`transfer of ${value} bytes (${mib(value)}) exceeds the configured maximum ${max} bytes (${mib(max)})`,
	blobWithoutMeta: (key: string): string =>
		`a blob exists without its metadata — likely an interrupted write (the key "${key}" is missing)`,
	metaMalformed: (key: string): string => `the metadata at key "${key}" is not a valid transfer record`,
} as const;

/** Bytes as a short mebibyte figure for the size sentences. */
function mib(bytes: number): string {
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
function isoDurationToMs(text: string): number | undefined {
	const match = ISO_DURATION_PATTERN.exec(text);
	if (match === null) return undefined;
	const [, weeks, days, hours, minutes, seconds] = match;
	const hasComponent =
		weeks !== undefined ||
		days !== undefined ||
		hours !== undefined ||
		minutes !== undefined ||
		seconds !== undefined;
	if (!hasComponent) return undefined;
	// `...T` with no time component names nothing after the designator.
	const hasTime = text.includes("T");
	if (hasTime && hours === undefined && minutes === undefined && seconds === undefined) return undefined;
	return Math.round(
		Number(weeks ?? 0) * MS_PER_WEEK +
			Number(days ?? 0) * MS_PER_DAY +
			Number(hours ?? 0) * MS_PER_HOUR +
			Number(minutes ?? 0) * MS_PER_MINUTE +
			Number(seconds ?? 0) * MS_PER_SECOND,
	);
}

/**
 * An ISO 8601 duration to milliseconds. Case-insensitive; refuses anything the pattern does not name,
 * a duration that is not positive, and one longer than the maximum TTL (default `P1D`, or `maxMs`
 * when a caller allows a different ceiling, with `maxIso` naming it in the sentence).
 */
export function parseIsoDuration(value: unknown, options: { maxMs?: number; maxIso?: string } = {}): number {
	if (typeof value !== "string") throw new Error(XFER_ERROR_TEXT.invalidDuration(value));
	const ms = isoDurationToMs(value.trim().toUpperCase());
	if (ms === undefined || ms <= 0) throw new Error(XFER_ERROR_TEXT.invalidDuration(value));
	const maxMs = options.maxMs ?? XFER_DEFAULTS.maxTtlMs;
	if (ms > maxMs) throw new Error(XFER_ERROR_TEXT.durationTooLong(value, options.maxIso ?? XFER_DEFAULTS.maxTtl));
	return ms;
}

/**
 * A fresh 128-bit token, as 32 lowercase hex characters. The token is the whole capability: it names
 * the keys and nothing else travels with it, so it is minted here and never derived from a path,
 * a name or a server.
 */
export function newToken(): string {
	return randomBytes(16).toString("hex");
}

/**
 * The name this feature writes to disk: the last path segment of `raw`, with every control character
 * removed. `.` and `..` are refused, as is a result that is empty — each would have the write land on
 * a directory instead of a file. The original name is only metadata; the bytes on disk get this one.
 */
export function sanitizeName(raw: string): string {
	const basename = raw.split(/[\\/]/).pop() ?? "";
	const cleaned = basename.replace(CONTROL_CHARACTERS, "");
	if (cleaned.length === 0) throw new Error(XFER_ERROR_TEXT.emptyName(raw));
	if (cleaned === "." || cleaned === "..") throw new Error(XFER_ERROR_TEXT.dotName(raw));
	return cleaned;
}

/** `<ns>:xfer:<token>` — the blob key, in the same family as `<ns>:ch:<channel>`. */
export function xferBlobKey(namespace: string, token: string): string {
	return `${namespace}:xfer:${token}`;
}

/** `<ns>:xfer:<token>:meta` — the metadata side key that travels with a blob. */
export function xferMetaKey(namespace: string, token: string): string {
	return `${namespace}:xfer:${token}:meta`;
}

/**
 * `<root>/.ace/xfer/<token>/<sessionId>/<name>` — the only path this feature ever writes.
 *
 * `name` is sanitised again here, so even a caller that forgot {@link sanitizeName} cannot make the
 * write leave the quarantine root; `token` and `sessionId` are module- or host-generated and are
 * used as written.
 */
export function quarantinePath(root: string, token: string, sessionId: string, name: string): string {
	return join(root, ...QUARANTINE_DIR, token, sessionId, sanitizeName(name));
}

/**
 * The metadata side key's value: what the receiver needs to name the file and to check the bytes
 * itself. `storedAt` and `expiresAt` are epoch milliseconds; `sha256` is integrity only.
 */
export interface XferMeta {
	/** The effective file name the receiver writes: the sender's name after separator and control-character stripping. */
	name: string;
	/** Size in bytes of the blob. */
	size: number;
	/** Hex SHA-256 of the blob, computed by the sender. */
	sha256: string;
	/** When the blob was stored, epoch ms. */
	storedAt: number;
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
export async function putBlob(options: {
	client: XferClient;
	namespace: string;
	token: string;
	bytes: Uint8Array;
	meta: XferMeta;
	ttlMs: number;
}): Promise<void> {
	const { client, namespace, token, bytes, meta, ttlMs } = options;
	await client.setMany([
		{ key: xferBlobKey(namespace, token), value: bytes, ttlMs },
		{ key: xferMetaKey(namespace, token), value: JSON.stringify(meta), ttlMs },
	]);
}

const TEXT_DECODER = new TextDecoder();

/** Read the metadata side key's JSON, refusing a record that is not the shape `putBlob` writes. */
function parseMeta(raw: Uint8Array, key: string): XferMeta {
	let value: unknown;
	try {
		value = JSON.parse(TEXT_DECODER.decode(raw));
	} catch {
		throw new Error(XFER_ERROR_TEXT.metaMalformed(key));
	}
	if (
		!isPlainObject(value) ||
		typeof value.name !== "string" ||
		typeof value.size !== "number" ||
		typeof value.sha256 !== "string" ||
		typeof value.storedAt !== "number" ||
		typeof value.expiresAt !== "number"
	) {
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
export async function takeBlob(options: {
	client: XferClient;
	namespace: string;
	token: string;
}): Promise<{ bytes: Uint8Array; meta: XferMeta; from: string } | undefined> {
	const { client, namespace, token } = options;
	const bytes = await client.get(xferBlobKey(namespace, token));
	if (bytes === undefined) return undefined;
	const metaKey = xferMetaKey(namespace, token);
	const rawMeta = await client.get(metaKey);
	if (rawMeta === undefined) throw new Error(XFER_ERROR_TEXT.blobWithoutMeta(metaKey));
	return { bytes, meta: parseMeta(rawMeta, metaKey), from: client.name };
}

/**
 * Refuse a transfer whose size is outside the limits: never at or above the Redis single-value
 * ceiling, never above `maxBytes` (default {@link XFER_DEFAULTS.defaultMaxBytes}), and `maxBytes`
 * itself never above {@link XFER_DEFAULTS.hardMaxBytes}. The limit is per copy: storing on N servers
 * costs N times the size.
 */
export function assertTransferSize(sizeBytes: number, options: { maxBytes?: number } = {}): void {
	if (!Number.isInteger(sizeBytes) || sizeBytes < 0) throw new Error(XFER_ERROR_TEXT.invalidSize(sizeBytes));
	if (sizeBytes >= XFER_DEFAULTS.refuseAtBytes) throw new Error(XFER_ERROR_TEXT.sizeAtCeiling(sizeBytes));
	const maxBytes = options.maxBytes ?? XFER_DEFAULTS.defaultMaxBytes;
	if (maxBytes > XFER_DEFAULTS.hardMaxBytes) throw new Error(XFER_ERROR_TEXT.maxBytesAboveHardMax(maxBytes));
	if (sizeBytes > maxBytes) throw new Error(XFER_ERROR_TEXT.sizeAboveMax(sizeBytes, maxBytes));
}

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
export function validateStoreInput(params: Record<string, unknown>): StoreInput {
	rejectUnknownArguments(XFER_TOOL_NAMES.store, params, STORE_ARGUMENTS);
	const path = params.path;
	// A path is read as written — leading/trailing spaces are legal in a name — so only the
	// whitespace-only and non-string shapes are refused here.
	if (typeof path !== "string" || path.trim().length === 0) throw new Error(XFER_ERROR_TEXT.invalidPath(path));
	// An override is normalised through the same sanitiser the receiver's write path uses, so a value
	// that could not be written (`..`, `.`, empty after stripping separators) is refused at the sender.
	const rawName = params.name;
	let name: string | undefined;
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
	if (typeof ttl !== "string" || ttl.trim().length === 0) throw new Error(XFER_ERROR_TEXT.invalidTtl(ttl));
	const normalised = ttl.trim().toUpperCase();
	return { path, ttl: normalised, ttlMs: parseIsoDuration(normalised), ...(name === undefined ? {} : { name }) };
}

/** The checked `ace_get_file` arguments: the pickup code. */
export interface GetInput {
	/** The token, lowercased so a relay that changed its case still finds the keys. */
	token: string;
}

/** Validate the raw `ace_get_file` arguments; throws a usage error naming the offending value. */
export function validateGetInput(params: Record<string, unknown>): GetInput {
	rejectUnknownArguments(XFER_TOOL_NAMES.get, params, GET_ARGUMENTS);
	const token = params.token;
	if (typeof token !== "string" || token.trim().length === 0) throw new Error(XFER_ERROR_TEXT.invalidToken(token));
	// The token's case carries no meaning, so a relayed code is normalised rather than refused; the
	// shape itself is still checked, so anything that is not 128 bits fails before a lookup.
	const normalised = token.trim().toLowerCase();
	if (!TOKEN_PATTERN.test(normalised)) throw new Error(XFER_ERROR_TEXT.invalidToken(token));
	return { token: normalised };
}

/** `key=value`, quoted when the value would break the one-line shape. */
function field(key: string, value: string): string {
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
export function formatSendResult(options: {
	token: string;
	size: number;
	sha256: string;
	name: string;
	ttl: string;
	storedAt: number;
	expiresAt: number;
	storedOn: readonly string[];
}): string {
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
export function formatGetResult(options: {
	path: string;
	sha256: string;
	size: number;
	name: string;
	from: string;
	storedAt: number;
	expiresAt: number;
}): string {
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
