import { appendFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the acknowledgement trail lives, next to the runtime's other ACE state (`.ace/spool`, dead
 * letters). The `UserPromptSubmit` hook appends; the MCP server reads. They agree on the path
 * because the host injects `CLAUDE_PROJECT_DIR` (the directory the session started in) into **both**
 * processes — the hook and the MCP server — and both resolve the trail from it.
 *
 * The server's own working directory is *not* the project directory: `.mcp.json` launches it with
 * `--cwd ${CLAUDE_PLUGIN_ROOT}`, so `process.cwd()` is the plugin root. That is why the server
 * resolves from `CLAUDE_PROJECT_DIR` rather than its cwd, and why it warns at startup when the
 * variable is missing — then it would fall back to the plugin root, not the session directory.
 * (The host does not guarantee it is set on every platform; see anthropics/claude-code#71924.)
 * It is also where `.ace.json` is read from, so `.ace/` holds the session's ACE state in one place.
 */
export const ACK_FILENAME = "ack-observed.jsonl";

export function ackFilePath(projectDir: string): string {
	return join(projectDir, ".ace", ACK_FILENAME);
}

/**
 * Extract the `<ace_event>` blocks from host text.
 *
 * This is the acknowledgement primitive: the host wraps our channel content verbatim in its own
 * `<channel source="…">…</channel>` tag, so the exact rendered block {@link renderAceEvent} produced
 * is a substring of the text the `UserPromptSubmit` hook sees. Non-greedy, so several batched events
 * in one prompt each come back whole. A body that itself contains a literal `<ace_event>` would
 * truncate at the first `</ace_event>` — an existing property of the rendered block, not something to
 * work around here.
 */
export function extractAceEvents(text: string): string[] {
	const blocks: string[] = [];
	for (const match of text.matchAll(/<ace_event>[\s\S]*?<\/ace_event>/g)) {
		blocks.push(match[0]);
	}
	return blocks;
}

/**
 * One line of the acknowledgement trail, as the hook appends it.
 *
 * `blocks` are the `<ace_event>` texts extracted from the prompt (a record of what the hook saw;
 * the smoke and the tests assert on them). `prompt` is the raw prompt the hook saw; the server's
 * observer substring-matches its pending rendered events against it — the host wraps the block in
 * its own `<channel>` tag, so the rendered text is a run inside a larger prompt, not the whole of it.
 */
export interface AckObservation {
	/** RFC 3339 timestamp the hook wrote the line, for log ordering. */
	t: string;
	blocks: string[];
	prompt: string;
}

/**
 * Append one observed turn to the trail.
 *
 * The hook calls this on every `UserPromptSubmit` whose prompt mentions an ACE event. It must be fast
 * (the hook blocks the turn while it runs) and must never throw in a way that surfaces to the session:
 * a failed write means the event is simply not acknowledged this pass, and the transport's reclaim
 * will redeliver it. The file is capped by keeping only its tail: the trail is a short sliding window,
 * not a log.
 */
export async function appendAckObservation(projectDir: string, observation: AckObservation): Promise<void> {
	const dir = join(projectDir, ".ace");
	const path = ackFilePath(projectDir);
	await mkdir(dir, { recursive: true });
	const line = `${JSON.stringify(observation)}\n`;
	await appendFile(path, line, "utf8");
	await capTrail(path, 256 * 1024);
}

/** Keep only the last `keepBytes` of the trail, at a line boundary, so it cannot grow unbounded. */
async function capTrail(path: string, keepBytes: number): Promise<void> {
	let size: number;
	try {
		size = (await stat(path)).size;
	} catch {
		return;
	}
	if (size <= keepBytes) return;
	const handle = await open(path, "r");
	try {
		const start = size - keepBytes;
		const buffer = Buffer.alloc(keepBytes);
		await handle.read(buffer, 0, keepBytes, start);
		const text = buffer.toString("utf8");
		// Drop the partial first line left by cutting mid-line.
		const cut = text.indexOf("\n");
		const tail = cut === -1 ? "" : `${text.slice(cut + 1)}\n`;
		await writeFile(path, tail, "utf8");
	} finally {
		await handle.close();
	}
}

export interface TrailRead {
	observations: AckObservation[];
	/** New byte offset for the next read; `undefined` when nothing new. */
	nextOffset?: number;
	/** The file shrank below `from` (the hook capped it); the reader resets to the start. */
	reset: boolean;
}

/**
 * Read the trail lines appended since `from`, returning only complete lines.
 *
 * A single writer (the hook) and a single reader (the server) share the file, so there is no torn-write
 * race to worry about beyond a final line that has not yet been flushed with its newline: that line is
 * held back until it is complete. When the writer caps the file below `from`, the reader is told to
 * reset to byte 0.
 */
export async function readNewTrail(projectDir: string, from: number): Promise<TrailRead> {
	const path = ackFilePath(projectDir);
	let size: number;
	try {
		const fileStat = await stat(path);
		size = fileStat.size;
	} catch {
		return { observations: [], reset: false };
	}

	let start = from;
	let reset = false;
	if (size < start) {
		// The trail was capped and is now shorter than where we left off: reread what remains.
		start = 0;
		reset = true;
	}

	if (size === start) return { observations: [], reset };
	const buffer = await readFile(path);
	const fromByte = Math.min(start, buffer.length);

	// Offsets are bytes, so find the newline by its byte value, not by string length: prompts can hold
	// multi-byte text, and a UTF-16 unit count would drift from the file position.
	const lastNewline = buffer.lastIndexOf(10);
	if (lastNewline < fromByte) return { observations: [], nextOffset: fromByte, reset };
	const consumed = lastNewline - fromByte + 1;
	const completeSegment = buffer.toString("utf8", fromByte, fromByte + consumed);

	const observations: AckObservation[] = [];
	for (const line of completeSegment.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const value = JSON.parse(line) as Partial<AckObservation>;
			if (typeof value.prompt === "string") {
				observations.push({
					t: typeof value.t === "string" ? value.t : "",
					blocks: Array.isArray(value.blocks) ? value.blocks.filter((b) => typeof b === "string") : [],
					prompt: value.prompt,
				});
			}
		} catch {
			// A malformed line is skipped; it names no observation to resolve.
		}
	}

	return { observations, nextOffset: fromByte + consumed, reset };
}
