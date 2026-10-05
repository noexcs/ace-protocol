import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import {
	assertTransferSize,
	formatGetResult,
	formatSendResult,
	newToken,
	putBlob,
	quarantinePath,
	type StoreInput,
	sanitizeName,
	takeBlob,
	XFER_ERROR_TEXT,
	type XferClient,
	type XferMeta,
} from "./xfer.ts";

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

/** Refuse a missing path, a directory and an unreadable path by name, each in its own sentence. */
async function assertReadableFile(absolute: string, written: string): Promise<void> {
	let info: Stats;
	try {
		info = await stat(absolute);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const code =
			typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
				? error.code
				: undefined;
		if (code === "ENOENT") throw new Error(XFER_ERROR_TEXT.missingFile(written));
		throw new Error(XFER_ERROR_TEXT.unreadableFile(written, reason));
	}
	if (info.isDirectory()) throw new Error(XFER_ERROR_TEXT.notAFile(written));
}

/**
 * Read a local file and store one copy under a fresh token on **every** target, in order.
 *
 * Per the feature's settled decision the result reports only where a copy landed (`stored_on=`) and
 * defines no success/failure semantics: a target whose write threw is simply absent from the line,
 * and an empty `stored_on=` is the whole story. The file errors (missing, directory, unreadable,
 * over the size ceiling) still throw, each as its own sentence.
 */
export async function storeFile(options: {
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
}): Promise<StoreFileResult> {
	const { root, input, targets } = options;
	const absolute = resolve(root, input.path);
	await assertReadableFile(absolute, input.path);
	let bytes: Uint8Array;
	try {
		bytes = await readFile(absolute);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(XFER_ERROR_TEXT.unreadableFile(input.path, reason));
	}
	assertTransferSize(bytes.byteLength, options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes });

	const sha256 = createHash("sha256").update(bytes).digest("hex");
	// The name that lands on the receiver's disk, computed here rather than only at the write: control
	// characters and path separators are stripped, so `name=` in the result states the effective name
	// (finding F6) instead of leaving the receiver to discover it.
	const name = sanitizeName(input.name ?? basename(absolute));
	const token = newToken();
	const storedAt = (options.now ?? Date.now)();
	const meta: XferMeta = {
		name,
		size: bytes.byteLength,
		sha256,
		storedAt,
		expiresAt: storedAt + input.ttlMs,
	};

	const storedOn: string[] = [];
	for (const target of targets) {
		try {
			await putBlob({
				client: target.client,
				namespace: target.namespace,
				token,
				bytes,
				meta,
				ttlMs: input.ttlMs,
			});
			storedOn.push(target.name);
		} catch {
			// No success/failure verdict: a target that refused the copy is just absent from `stored_on=`.
		}
	}

	return {
		text: formatSendResult({
			token,
			size: bytes.byteLength,
			sha256,
			name,
			ttl: input.ttl,
			storedAt,
			expiresAt: meta.expiresAt,
			storedOn,
		}),
		token,
		size: bytes.byteLength,
		sha256,
		storedOn,
	};
}

/**
 * Fetch a token from the first target that has it (configuration order) and write the bytes into the
 * quarantine directory. The write path is derived here from the receiver's root, session id and the
 * sender's metadata name — no argument ever selects it. Throws the diagnostic sentence when no target
 * has the token, which is a normal outcome (it expired, or the two sides share no server).
 */
export async function receiveFile(options: {
	/** Workspace root: the quarantine directory sits under it. */
	root: string;
	/** The checked `ace_get_file` arguments. */
	token: string;
	/** This session's id, so two sessions on one host do not collide. */
	sessionId: string;
	/** The live servers, in configuration order; the first hit wins. */
	targets: readonly XferTarget[];
}): Promise<GetFileResult> {
	const { root, token, sessionId, targets } = options;
	for (const target of targets) {
		const found = await takeBlob({ client: target.client, namespace: target.namespace, token });
		if (found === undefined) continue;
		const sha256 = createHash("sha256").update(found.bytes).digest("hex");
		const path = await writeQuarantined(root, token, sessionId, found.meta.name, found.bytes);
		return {
			text: formatGetResult({
				path,
				sha256,
				size: found.bytes.byteLength,
				name: sanitizeName(found.meta.name),
				from: found.from,
				storedAt: found.meta.storedAt,
				expiresAt: found.meta.expiresAt,
			}),
			path,
			sha256,
			size: found.bytes.byteLength,
			from: found.from,
		};
	}
	throw new Error(XFER_ERROR_TEXT.noBlobOnAnyServer());
}

/** Write `bytes` into the quarantine directory, choosing a free (or byte-identical) path. */
async function writeQuarantined(
	root: string,
	token: string,
	sessionId: string,
	name: string,
	bytes: Uint8Array,
): Promise<string> {
	const base = quarantinePath(root, token, sessionId, name);
	await mkdir(dirname(base), { recursive: true });
	const target = await pickPath(base, bytes);
	await writeFile(target, bytes);
	return target;
}

/**
 * The base path when it is free or already holds identical bytes (a repeat fetch overwrites its own
 * copy); otherwise the first numeric suffix (`report (2).txt`, `report (3).txt`, …) that is.
 */
async function pickPath(base: string, bytes: Uint8Array): Promise<string> {
	const extension = extname(base);
	const stem = base.slice(0, base.length - extension.length);
	for (let index = 1; ; index += 1) {
		const candidate = index === 1 ? base : `${stem} (${index})${extension}`;
		try {
			if ((await readFile(candidate)).equals(bytes)) return candidate;
		} catch {
			return candidate;
		}
	}
}
