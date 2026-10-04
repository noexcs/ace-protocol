#!/usr/bin/env bun
/**
 * `ace-codex-bridge` — drive a live `codex app-server` session from ACE events.
 *
 * Assembles the bridge (see `src/bridge.ts`) from flags or `ACE_CODEX_*` env
 * vars and keeps it running until the process is signalled. `.ace.json` is
 * read from the working directory (the same directory the Codex thread runs
 * in), so configure the subscription channels there.
 *
 * Exit codes: `0` on a clean stop, the code of the fatal condition otherwise.
 */

import { createBridge } from "../src/bridge.ts";
import { CodexConfigError, resolveCodexConfig, type CodexConnectionConfig } from "../src/config.ts";

const USAGE = `usage: ace-codex-bridge [options]

Options (each also reads its ACE_CODEX_* env var; flags win):
  --listen <stdio|ws|unix>  how to reach the app-server (default stdio)
  --command <executable>    executable to spawn for stdio (default codex)
  --endpoint <url|path>     ws URL (ws://…) or unix socket path (unix://)
  --cwd <dir>               working dir + .ace.json location + thread cwd
  --model <model>           pin a model for new threads
  --thread <id>             resume this durable thread id (UUIDv7)
  --timeout <ms>            delivery-observation timeout (default 30000)
  --client-name <name>      initialize.clientInfo.name
  --client-version <ver>    initialize.clientInfo.version
  -h, --help                show this help
  -V, --version             print the package version

Environment:
  ACE_CODEX_LISTENER, ACE_CODEX_COMMAND, ACE_CODEX_ENDPOINT, ACE_CODEX_CWD,
  ACE_CODEX_MODEL, ACE_CODEX_THREAD_ID, ACE_CODEX_DELIVERY_TIMEOUT_MS,
  ACE_CODEX_CLIENT_NAME, ACE_CODEX_CLIENT_VERSION`;

function printMessage(stream: NodeJS.WriteStream, text: string): void {
	stream.write(`${text}\n`);
}

/** Parse `--flag value` / `--flag=value` / `-h` / `-V` into a key/value map. */
function parseFlags(argv: string[]): { flags: Map<string, string | boolean>; version: boolean } {
	const flags = new Map<string, string | boolean>();
	let version = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		const [rawKey, inlineValue] = arg.startsWith("--") ? arg.slice(2).split("=") : [arg, undefined];
		const key = (rawKey ?? "").replace(/^-/, "");
		if (key === "h" || key === "help") {
			printMessage(process.stdout, USAGE);
			process.exit(0);
		}
		if (key === "V" || key === "version") {
			version = true;
			continue;
		}
		if (inlineValue !== undefined) {
			flags.set(key, inlineValue);
			continue;
		}
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("-")) {
			flags.set(key, next);
			i++;
		} else {
			flags.set(key, true);
		}
	}
	return { flags, version };
}

function flagString(flags: Map<string, string | boolean>, key: string): string | undefined {
	const value = flags.get(key);
	return typeof value === "string" ? value : undefined;
}

function main(): void {
	const { flags, version } = parseFlags(process.argv.slice(2));
	if (version) {
		// Keep in step with package.json.
		printMessage(process.stdout, "ace-codex 0.1.0");
		return;
	}

	const overrides: Partial<CodexConnectionConfig> = {};
	const listen = flagString(flags, "listen");
	if (listen !== undefined) {
		if (listen !== "stdio" && listen !== "ws" && listen !== "unix") {
			printMessage(process.stderr, `[ace-codex-bridge] --listen must be stdio|ws|unix, got "${listen}"`);
			process.exit(1);
		}
		overrides.listener = listen;
	}
	const command = flagString(flags, "command");
	if (command !== undefined) overrides.command = command;
	const endpoint = flagString(flags, "endpoint");
	if (endpoint !== undefined) overrides.endpoint = endpoint;
	const cwd = flagString(flags, "cwd");
	if (cwd !== undefined) overrides.cwd = cwd;
	const model = flagString(flags, "model");
	if (model !== undefined) overrides.model = model;
	const thread = flagString(flags, "thread");
	if (thread !== undefined) overrides.threadId = thread;
	const clientName = flagString(flags, "client-name");
	if (clientName !== undefined) overrides.clientName = clientName;
	const clientVersion = flagString(flags, "client-version");
	if (clientVersion !== undefined) overrides.clientVersion = clientVersion;
	const timeout = flagString(flags, "timeout");
	if (timeout !== undefined) {
		const parsed = Number(timeout);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			printMessage(process.stderr, `[ace-codex-bridge] --timeout must be a positive number, got "${timeout}"`);
			process.exit(1);
		}
		overrides.deliveryTimeoutMs = parsed;
	}

	let config: CodexConnectionConfig;
	try {
		config = resolveCodexConfig(overrides);
	} catch (error) {
		if (error instanceof CodexConfigError) {
			printMessage(process.stderr, `[ace-codex-bridge] ${error.message}`);
			process.exit(1);
		}
		throw error;
	}

	const bridge = createBridge({ config, ...(cwd !== undefined ? { cwd } : {}) });

	// Graceful shutdown on a signal or on a startup failure. The exit code is the
	// fatal condition's, or 0 when the operator stopped a healthy bridge.
	let stopping = false;
	let fatalCode = 0;
	const stop = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		printMessage(process.stderr, "[ace-codex-bridge] stopping");
		try {
			await bridge.stop();
		} catch (error) {
			fatalCode = 1;
			printMessage(process.stderr, `[ace-codex-bridge] stop failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		process.exit(fatalCode);
	};
	process.on("SIGINT", () => void stop());
	process.on("SIGTERM", () => void stop());

	void (async () => {
		try {
			await bridge.ready;
			await bridge.start();
		} catch (error) {
			fatalCode = 1;
			printMessage(process.stderr, `[ace-codex-bridge] failed: ${error instanceof Error ? error.message : String(error)}`);
			void stop();
		}
	})();
}

main();
