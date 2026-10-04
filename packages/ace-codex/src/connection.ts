/**
 * Duplex connections to a `codex app-server` endpoint.
 *
 * The envelope protocol is transport-agnostic (newline-delimited JSON
 * frames), but the CLI exposes three listeners (`--listen`):
 *
 * - `stdio://` — the bridge spawns `codex app-server --listen stdio://`
 *   as a child and speaks newline-JSON over its stdio. This is the
 *   default and the primary "honest plugin form": the bridge process
 *   owns the Codex session.
 * - `ws://IP:PORT` — the bridge connects out with a WebSocket client
 *   (text frames).
 * - `unix://PATH` — the CLI serves this with a WebSocket over a unix
 *   domain socket; the bridge opens the socket with `net.connect` and
 *   runs the WS handshake over it via `ws`'s `createConnection` hook.
 *
 * All three build an {@link AppServerConnection}: the same duplex
 * interface the {@link AppServerClient} consumes. `stdio` is fully
 * unit-tested (fake app-server as an in-memory peer); `unix`/`ws` are
 * exercised by the live smoke script when a `codex` binary is present.
 */

import { spawn } from "node:child_process";
import { connect as netConnect, type Socket } from "node:net";
import * as WS from "ws";

export type AppServerConnectionKind = "stdio" | "ws" | "unix";

/** A duplex over which newline-delimited JSON frames flow both ways. */
export interface AppServerConnection {
	readonly kind: AppServerConnectionKind;
	/** Subscribe to incoming raw text (may be partial lines). */
	onChunk(handler: (chunk: string) => void): void;
	/** Write raw text to the peer. */
	write(chunk: string): void;
	/** Fired once when the stream ends or fails. */
	onEnd(handler: (reason?: string) => void): void;
	close(): void;
}

export interface SpawnOptions {
	/** Executable. Defaults to `codex`. */
	command?: string;
	/** Argument list. Defaults to `["app-server", "--listen", "stdio://"]`. */
	args?: string[];
	cwd?: string;
}

/** Create a connection by spawning `codex app-server` as a child. */
export function createStdioConnection(options: SpawnOptions = {}): AppServerConnection {
	const command = options.command ?? "codex";
	const args = options.args ?? ["app-server", "--listen", "stdio://"];
	const child = spawn(command, args, {
		cwd: options.cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});

	let chunkHandler: ((chunk: string) => void) | undefined;
	let endHandler: ((reason?: string) => void) | undefined;
	let closed = false;

	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (data: string) => chunkHandler?.(data));
	child.stderr?.setEncoding("utf8");
	// Surface server stderr for diagnostics but never let it kill the bridge.
	child.stderr?.on("data", (data: string) => {
		process.stderr.write(`[codex app-server] ${data}`);
	});
	child.on("error", (error) => {
		endHandler?.(`spawn failed: ${error.message}`);
	});
	child.on("close", (code) => {
		endHandler?.(code === 0 || code === null ? undefined : `exited with code ${code}`);
	});

	return {
		kind: "stdio",
		onChunk: (handler) => {
			chunkHandler = handler;
		},
		write: (text) => {
			child.stdin?.write(text);
		},
		onEnd: (handler) => {
			endHandler = handler;
		},
		close: () => {
			if (closed) return;
			closed = true;
			child.stdin?.end();
			child.kill();
		},
	};
}

export interface WebSocketOptions {
	/** WebSocket URL: `ws://host:port`. */
	url: string;
	/** Unix socket path for `unix://` endpoints (handshake runs over `net.connect`). */
	unixPath?: string;
}

/** Create a connection to an already-running server (`ws://` or `unix://`). */
export function createWebSocketConnection(options: WebSocketOptions): AppServerConnection {
	let chunkHandler: ((chunk: string) => void) | undefined;
	let endHandler: ((reason?: string) => void) | undefined;
	let closed = false;

	const finish = (reason?: string) => {
		if (closed) return;
		closed = true;
		endHandler?.(reason);
	};

	// `ws` hands the open socket to the handshake; for `unix://` we open the
	// unix socket ourselves (its `createConnection` is synchronous, and
	// `net.connect` returns the socket immediately, connecting in the background).
	const wsOptions: WS.ClientOptions = {};
	let unixSocket: Socket | undefined;
	if (options.unixPath !== undefined) {
		const path = options.unixPath;
		wsOptions.createConnection = () => {
			unixSocket = netConnect({ path });
			return unixSocket;
		};
	}

	const ws = new WS.WebSocket(options.url, wsOptions);
	ws.on("message", (data, isBinary) => {
		if (isBinary) return;
		chunkHandler?.(data.toString("utf8"));
	});
	ws.on("close", () => finish());
	ws.on("error", (error) => finish(error.message));

	return {
		kind: options.unixPath !== undefined ? "unix" : "ws",
		onChunk: (handler) => {
			chunkHandler = handler;
		},
		write: (text) => {
			if (ws.readyState === WS.WebSocket.OPEN) ws.send(text);
		},
		onEnd: (handler) => {
			endHandler = handler;
		},
		close: () => {
			try {
				ws.close();
			} catch {
				// best effort; finish() already ran or will via 'close'
			}
			unixSocket?.destroy();
		},
	};
}
