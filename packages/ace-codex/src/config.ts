/**
 * Bridge configuration.
 *
 * The bridge is driven by flags/env (`codex.json` is intentionally not
 * read: the bridge is a thin driver, and mixing in Codex's own config
 * file would couple it to Codex internals). Resolution order per key is
 * flag/env, then default.
 *
 * Only non-experimental `app-server` methods are used, so no capability is
 * requested on `initialize`: the ACE runtime holds `manual` events itself
 * and re-dispatches them as `next_turn`, so the experimental queue methods
 * are never needed here.
 */

export interface CodexConnectionConfig {
	/**
	 * How to reach the app-server. `stdio` (default) spawns
	 * `codex app-server --listen stdio://`; `ws`/`unix` connect out to an
	 * already-running server.
	 */
	listener: "stdio" | "ws" | "unix";
	/** Executable to spawn for `stdio`. Defaults to `codex`. */
	command?: string;
	/** Argument list to spawn with; defaults to `["app-server", "--listen", "stdio://"]`. */
	args?: string[];
	/** URL for `ws` (e.g. `ws://127.0.0.1:8080`) or path for `unix` (e.g. `/tmp/codex.sock`). */
	endpoint?: string;
	/** Working directory for a spawned child and the thread's `cwd`. Defaults to the process cwd. */
	cwd?: string;
	/** Model to pin for new threads (`thread/start.model`); defaults to Codex's own default. */
	model?: string;
	/** Resume this durable thread id (UUIDv7) instead of starting a new one. */
	threadId?: string;
	/** Timeout for waiting on an observed delivery of an injected event (ms). Defaults to 30000. */
	deliveryTimeoutMs?: number;
	/** Client info advertised on `initialize.clientInfo`. */
	clientName?: string;
	/** Version advertised on `initialize.clientInfo`. Defaults to the package version. */
	clientVersion?: string;
}

export class CodexConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexConfigError";
	}
}

const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000;

function readString(
	env: Readonly<Record<string, string | undefined>>,
	key: string,
	fallback: string | undefined,
): string | undefined {
	const value = env[key];
	return value !== undefined && value !== "" ? value : fallback;
}

/**
 * Resolve bridge configuration from explicit overrides and the
 * environment (`ACE_CODEX_*` keys). Explicit overrides win.
 */
export function resolveCodexConfig(
	overrides: Partial<CodexConnectionConfig> = {},
	env: Readonly<Record<string, string | undefined>> = process.env,
): CodexConnectionConfig {
	const listener = (overrides.listener ?? readString(env, "ACE_CODEX_LISTENER", undefined)) as
		| CodexConnectionConfig["listener"]
		| undefined;
	const config: CodexConnectionConfig = {
		listener: listener ?? "stdio",
		command: overrides.command ?? readString(env, "ACE_CODEX_COMMAND", undefined),
		args: overrides.args,
		endpoint: overrides.endpoint ?? readString(env, "ACE_CODEX_ENDPOINT", undefined),
		cwd: overrides.cwd ?? readString(env, "ACE_CODEX_CWD", undefined),
		model: overrides.model ?? readString(env, "ACE_CODEX_MODEL", undefined),
		threadId: overrides.threadId ?? readString(env, "ACE_CODEX_THREAD_ID", undefined),
		deliveryTimeoutMs: overrides.deliveryTimeoutMs,
		clientName: overrides.clientName,
		clientVersion: overrides.clientVersion,
	};
	if (config.deliveryTimeoutMs === undefined) {
		const raw = readString(env, "ACE_CODEX_DELIVERY_TIMEOUT_MS", undefined);
		if (raw !== undefined) {
			const parsed = Number(raw);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new CodexConfigError(`ACE_CODEX_DELIVERY_TIMEOUT_MS must be a positive number, got "${raw}"`);
			}
			config.deliveryTimeoutMs = parsed;
		}
	}
	if (config.deliveryTimeoutMs === undefined) {
		config.deliveryTimeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS;
	}
	validateCodexConfig(config);
	return config;
}

/** Validate the parts that must agree; construction is the only honest place to fail. */
export function validateCodexConfig(config: CodexConnectionConfig): void {
	if (config.listener === "ws" || config.listener === "unix") {
		if (config.endpoint === undefined || config.endpoint === "") {
			throw new CodexConfigError(`listener "${config.listener}" requires an endpoint (ACE_CODEX_ENDPOINT)`);
		}
		if (config.listener === "unix" && !config.endpoint.startsWith("/")) {
			throw new CodexConfigError(`unix endpoint must be an absolute socket path, got "${config.endpoint}"`);
		}
	}
	if (config.threadId !== undefined && !/^[0-9a-f-]{8,}$/i.test(config.threadId)) {
		throw new CodexConfigError(`threadId does not look like a durable thread id (UUIDv7), got "${config.threadId}"`);
	}
}
