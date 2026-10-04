/**
 * Client for the `codex app-server` protocol.
 *
 * Manages request ids, response/notification routing, the
 * `initialize` -> `initialized` handshake, and typed wrappers for the
 * methods the bridge uses. Every method name, param key, and response
 * shape was verified against the protocol the live `codex 0.153.0`
 * binary emits (`codex app-server generate-json-schema`), not against
 * the Rust source: params and responses are camelCase on the wire.
 *
 * - `initialize` (v1) -> `{ clientInfo }`; the `initialized` notification
 *   must follow before any other method.
 * - `thread/start`, `thread/resume` (v2, non-experimental) ->
 *   `{ thread: { id, sessionId, ... } }`.
 * - `turn/start` (non-experimental) -> `{ turn: { id, status, ... } }`.
 * - `turn/steer` (non-experimental) -> `{ turnId }`; requires the active
 *   `expectedTurnId`.
 * - `turn/interrupt` (non-experimental) -> `{}`.
 *
 * The bridge deliberately uses only these non-experimental methods, so no
 * capability is requested on `initialize`: the ACE runtime holds `manual`
 * events itself and re-dispatches them as `next_turn`, so the experimental
 * queue methods are never needed here.
 *
 * Server -> client requests (e.g. approval prompts the agent may raise
 * mid-turn) are surfaced through {@link onServerRequest}; the default
 * answers with a method-not-found error so the server never hangs on a
 * request the bridge will not answer.
 */

import type { AppServerConnection } from "./connection.ts";
import {
	AppServerError,
	type AppServerFrame,
	createFrameDecoder,
	ERROR_METHOD_NOT_FOUND,
	encodeFrame,
} from "./protocol.ts";

/** Wire shape of the initialize handshake (v1). */
export interface InitializeParams {
	clientInfo: { name: string; title?: string; version: string };
}

export interface InitializeResult {
	codexHome: string;
	platformFamily: string;
	platformOs: string;
	userAgent: string;
}

/** One unit of user input; the bridge only ever sends text. */
export interface UserInput {
	type: "text";
	text: string;
}

/** Codex thread (v2/Thread): `id` is the durable UUIDv7, `sessionId` the session id. */
export interface CodexThread {
	id: string;
	sessionId: string;
	status?: unknown;
	[key: string]: unknown;
}

export type CodexTurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

/** Codex turn (v2/Turn). `error` is only populated when `status === "failed"`. */
export interface CodexTurn {
	id: string;
	status: CodexTurnStatus;
	items?: unknown[];
	error?: { message: string; additionalDetails?: string | null } | null;
	[key: string]: unknown;
}

export interface NotificationEvent {
	readonly method: string;
	readonly params: unknown;
}

type ServerRequestHandler = (method: string, params: unknown, id: string | number) => void;
interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/**
 * A client bound to one app-server connection. Call {@link begin} to create
 * the client and run the `initialize` handshake; every typed method rejects
 * until it completes.
 */
export class AppServerClient {
	/** Set when the peer closes; in-flight requests reject with it. */
	closed = false;

	/** Server -> client request hook (approvals, elicitation, ...). */
	onServerRequest: ServerRequestHandler = (method, _params, id) => {
		this.#send({ id, error: { code: ERROR_METHOD_NOT_FOUND, message: `bridge does not answer: ${method}` } });
	};

	/** Fired for every notification the server sends. */
	onNotification: ((event: NotificationEvent) => void) | undefined;

	/** Fired once when the connection ends. */
	onConnectionEnd: ((reason?: string) => void) | undefined;

	private nextId = 1;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly handshake = Promise.withResolvers<InitializeResult>();
	readonly connection: AppServerConnection;

	constructor(connection: AppServerConnection) {
		this.connection = connection;
		const decode = createFrameDecoder(
			(frame) => this.#onFrame(frame),
			(error, raw) => {
				process.stderr.write(`[ace-codex] bad frame (${error.message}): ${raw.slice(0, 200)}\n`);
			},
		);
		connection.onChunk(decode);
		connection.onEnd((reason) => this.#onConnectionEnd(reason));
	}

	/**
	 * Create a client on the connection and run the handshake. The client is
	 * usable as soon as this returns a promise; the handshake's result is the
	 * returned promise (or reject on connection loss), so callers that need the
	 * client object synchronously can wire listeners before it settles.
	 */
	static begin(
		connection: AppServerConnection,
		params: InitializeParams,
	): { client: AppServerClient; ready: Promise<InitializeResult> } {
		const client = new AppServerClient(connection);
		return { client, ready: client.initialize(params) };
	}

	/** The initialize handshake; the `initialized` notification follows. */
	async initialize(params: InitializeParams): Promise<InitializeResult> {
		const result = await this.#request<InitializeResult>("initialize", params);
		this.#notify("initialized", undefined);
		this.handshake.resolve(result);
		return result;
	}

	/** Promise that settles with the initialize result (or connection-loss). */
	ready(): Promise<InitializeResult> {
		return this.handshake.promise;
	}

	threadStart(params?: Record<string, unknown>): Promise<{ thread: CodexThread }> {
		return this.#request("thread/start", params ?? {});
	}

	threadResume(params: { threadId: string; [key: string]: unknown }): Promise<{ thread: CodexThread }> {
		return this.#request("thread/resume", params);
	}

	turnStart(params: { threadId: string; input: UserInput[]; [key: string]: unknown }): Promise<{ turn: CodexTurn }> {
		return this.#request("turn/start", params);
	}

	turnSteer(params: {
		threadId: string;
		input: UserInput[];
		expectedTurnId: string;
		[key: string]: unknown;
	}): Promise<{ turnId: string }> {
		return this.#request("turn/steer", params);
	}

	turnInterrupt(params: { threadId: string; turnId: string }): Promise<unknown> {
		return this.#request("turn/interrupt", params);
	}

	/** Close the underlying connection. */
	close(): void {
		this.connection.close();
	}

	#onConnectionEnd(reason?: string): void {
		if (this.closed) return;
		this.closed = true;
		const error = new Error(`app-server connection ended${reason ? `: ${reason}` : ""}`);
		for (const [key, waiter] of this.pending) {
			this.pending.delete(key);
			waiter.reject(error);
		}
		this.handshake.reject(error);
		this.onConnectionEnd?.(reason);
	}

	#onFrame(frame: AppServerFrame): void {
		const id = frame.id ?? null;
		if (frame.method === undefined) {
			// A response: always carries the id of the request it answers.
			if (id === null) return;
			const waiter = this.pending.get(String(id));
			if (!waiter) return;
			this.pending.delete(String(id));
			if (frame.error !== undefined) {
				waiter.reject(new AppServerError(frame.error));
			} else {
				waiter.resolve(frame.result);
			}
			return;
		}
		if (id !== null) {
			// A server -> client request (carries an id; the bridge must answer).
			this.onServerRequest(frame.method, frame.params, id);
			return;
		}
		// A notification: has a method and no id (or a null id).
		this.onNotification?.({ method: frame.method, params: frame.params });
	}

	#request<T>(method: string, params: unknown): Promise<T> {
		if (this.closed) {
			return Promise.reject(new Error(`connection closed before ${method}`));
		}
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const id = this.nextId++;
		this.pending.set(String(id), { resolve, reject });
		this.#send({ id, method, params });
		return promise.then((value) => value as T);
	}

	#notify(method: string, params: unknown): void {
		this.#send({ method, ...(params === undefined ? {} : { params }) });
	}

	#send(frame: AppServerFrame): void {
		this.connection.write(encodeFrame(frame));
	}
}
