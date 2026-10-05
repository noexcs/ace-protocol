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
export async function shutdownAce(options) {
    const { runtime, registry, onError } = options;
    try {
        await runtime?.stop();
    }
    catch (error) {
        onError?.("runtime stop", error);
    }
    // `unregister` is a no-op when nothing was registered, so a session that lost the race with its own
    // startup still reaches the directory and gets cleaned up.
    try {
        await registry?.unregister();
    }
    catch (error) {
        onError?.("registry unregister", error);
    }
    try {
        await registry?.close();
    }
    catch (error) {
        onError?.("registry close", error);
    }
}
//# sourceMappingURL=shutdown.js.map