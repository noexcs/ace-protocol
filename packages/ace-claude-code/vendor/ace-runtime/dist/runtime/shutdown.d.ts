import type { AceRuntime } from "./ace-runtime.ts";
import type { AgentRegistry } from "./agent-registry.ts";
/** A shutdown step that failed, named the way the log line will read. */
export type ShutdownStep = "runtime stop" | "registry unregister" | "registry close";
/**
 * Shut a session down in the only order that is safe: **the reader stops first**, then the directory
 * entry and the session's own stream go away, then the registry client closes.
 *
 * Dropping the stream first would leave the reader waking up on a deleted group and reporting NOGROUP
 * on the way out — the reason every host carries the same comment today. Encoding the order here means
 * the hosts cannot get it wrong, and a host's own extras (spare publishers, spool files) still run
 * after this returns.
 *
 * Every step is best-effort: a failure while shutting down is reported through `onError` and never
 * thrown, so one dead connection cannot skip the rest of the teardown.
 */
export declare function shutdownAce(options: {
    runtime?: Pick<AceRuntime, "stop">;
    registry?: Pick<AgentRegistry, "unregister" | "close">;
    onError?: (step: ShutdownStep, error: unknown) => void;
}): Promise<void>;
//# sourceMappingURL=shutdown.d.ts.map