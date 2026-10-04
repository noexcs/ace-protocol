/**
 * Read a dead-letter file (JSONL, one record per line) into the records a replay can use.
 *
 * Records written by an older runtime — or before a replay existed at all — may lack `stream` or
 * `field`; those lines are skipped rather than guessed at, and counted so the caller can say so.
 */
export function parseDeadLetters(content) {
    const records = [];
    let skipped = 0;
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            skipped += 1;
            continue;
        }
        if (!isReplayable(parsed)) {
            skipped += 1;
            continue;
        }
        records.push(parsed);
    }
    return { records, skipped };
}
function isReplayable(value) {
    if (typeof value !== "object" || value === null)
        return false;
    if (!("stream" in value) || typeof value.stream !== "string" || value.stream.length === 0)
        return false;
    if (!("field" in value) || typeof value.field !== "string" || value.field.length === 0)
        return false;
    if (!("payload" in value) || typeof value.payload !== "string")
        return false;
    if (!("brokerId" in value) || typeof value.brokerId !== "string")
        return false;
    return true;
}
/**
 * Publish the recorded events back to the streams they came from, in file order.
 *
 * The payload is written verbatim: the receiving runtime validates it again, so a replay does not
 * depend on ACE's parser succeeding here. A record whose publish fails is reported and the rest
 * continue — one broken stream must not block the others.
 */
export async function replayDeadLetters(records, publish) {
    const outcome = { replayed: 0, skipped: 0, failed: [] };
    for (const record of records) {
        if (record.payload === null) {
            outcome.skipped += 1;
            continue;
        }
        try {
            await publish(record.stream, record.field, record.payload);
            outcome.replayed += 1;
        }
        catch (error) {
            outcome.failed.push({ stream: record.stream, brokerId: record.brokerId, error });
        }
    }
    return outcome;
}
/** One line per stream, for the CLI's summary. */
export function summarizeReplay(records) {
    const counts = new Map();
    for (const record of records)
        counts.set(record.stream, (counts.get(record.stream) ?? 0) + 1);
    return [...counts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([stream, count]) => `${stream}: ${count}`)
        .join(", ");
}
//# sourceMappingURL=dead-letter-replay.js.map