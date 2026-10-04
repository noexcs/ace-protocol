/**
 * Wire codec for the Codex `app-server` envelope.
 *
 * The protocol is JSON-RPC-like but not JSON-RPC: frames carry no `jsonrpc`
 * field. Three shapes share the same newline-delimited transport:
 *
 * - request:     `{ id, method, params? }`          (no result)
 * - response:    `{ id, result? }` or `{ id, error: { code, message, data? } }`
 * - notification:`{ method, params? }`              (no id)
 *
 * Framing is one JSON object per line (`\n`-terminated); a frame may arrive
 * split across arbitrary chunk boundaries, so decoding is incremental.
 *
 * Verified against `codex-rs/app-server-protocol/src/rpc.rs` (Frame enum,
 * `to_json`/`from_json` with `#[serde(untagged)]`) and `rpc_error.rs`
 * (code `-32600` / message `requires experimentalApi capability` for the
 * experimental gate).
 */

/** A raw envelope frame as parsed from one line of the stream. */
export interface AppServerFrame {
	/** Present on requests and responses; absent on notifications. Untagged string-or-number. */
	readonly id?: string | number | null;
	/** Present on requests and notifications; absent on responses. */
	readonly method?: string;
	/** Request parameters. */
	readonly params?: unknown;
	/** Response payload; absent on errored responses and notifications. */
	readonly result?: unknown;
	/** Response error; absent on successful responses. */
	readonly error?: AppServerProtocolError;
}

/** Error object inside a response frame. */
export interface AppServerProtocolError {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

/** Standard JSON-RPC error codes used by the server (rpc.rs: JsonRpcError). */
export const ERROR_INVALID_REQUEST = -32600;
export const ERROR_METHOD_NOT_FOUND = -32601;
export const ERROR_INVALID_PARAMS = -32602;
export const ERROR_INTERNAL = -32603;

/**
 * Error surfaced for an `error` response. Carries enough of the original
 * to map host-specific failures (see {@link isExperimentalRequired}).
 */
export class AppServerError extends Error {
	readonly frame: AppServerProtocolError;
	readonly code: number;
	readonly data?: unknown;

	constructor(frame: AppServerProtocolError) {
		super(`app-server error ${frame.code}: ${frame.message}`);
		this.name = "AppServerError";
		this.frame = frame;
		this.code = frame.code;
		this.data = frame.data;
	}
}

/**
 * Whether an `error` response is the experimental-capability gate.
 *
 * The server rejects experimental methods without the `experimentalApi`
 * capability with code `-32600` and a message that always ends with
 * `requires experimentalApi capability` (rpc_error.rs:
 * `experimental_required_message`). Matching the suffix — rather than the
 * code — keeps this precise: other invalid requests share the code.
 */
export function isExperimentalRequired(error: AppServerProtocolError): boolean {
	return (
		error.message.endsWith("requires experimentalApi capability") ||
		(typeof error.data === "string" && error.data.includes("requires experimentalApi capability"))
	);
}

/** Human-oriented error for the experimental gate, for config validation. */
export const EXPERIMENTAL_REQUIRED_SUFFIX = "requires experimentalApi capability";

/** Encode one frame for transmission. Throws on invalid frame shapes. */
export function encodeFrame(frame: AppServerFrame): string {
	if (
		(frame.method === undefined && frame.id === undefined) ||
		(frame.method !== undefined && frame.result !== undefined) ||
		(frame.error !== undefined && (frame.result !== undefined || frame.method !== undefined))
	) {
		throw new Error(`invalid app-server frame: ${JSON.stringify(frame)}`);
	}
	return `${JSON.stringify(frame)}\n`;
}

/**
 * Incremental line-based frame decoder. Feed it arbitrary chunks (the
 * transport's read events); it emits complete frames and tolerates
 * partial lines, leading blank lines, and CRLF.
 */
export function createFrameDecoder(
	onFrame: (frame: AppServerFrame) => void,
	onError: (error: Error, raw: string) => void,
): (chunk: string) => void {
	let buffer = "";
	return (chunk: string): void => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line === "") {
				newline = buffer.indexOf("\n");
				continue;
			}
			let frame: AppServerFrame;
			try {
				const parsed: unknown = JSON.parse(line);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					throw new Error("not an object");
				}
				frame = parsed as AppServerFrame;
			} catch (cause) {
				onError(cause instanceof Error ? cause : new Error(String(cause)), line);
				newline = buffer.indexOf("\n");
				continue;
			}
			onFrame(frame);
			newline = buffer.indexOf("\n");
		}
	};
}
