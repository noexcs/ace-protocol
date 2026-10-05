import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	putBlob,
	validateStoreInput,
	type XferClient,
	type XferMeta,
	type XferSetCommand,
} from "../../src/tools/xfer.ts";
import { receiveFile, storeFile, type XferTarget } from "../../src/tools/xfer-files.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const TTL_MS = 3_600_000;
const NOW = 1_000_000;

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ace-xfer-"));
	dirs.push(dir);
	return dir;
}

/** A fake `XferClient`: bytes in memory, a `get` that never deletes, one pipeline per `setMany`. */
class FakeClient implements XferClient {
	readonly name: string;
	readonly store = new Map<string, Uint8Array>();

	constructor(name = "local") {
		this.name = name;
	}

	async get(key: string): Promise<Uint8Array | undefined> {
		return this.store.get(key);
	}

	async setMany(commands: readonly XferSetCommand[]): Promise<void> {
		for (const command of commands) {
			this.store.set(
				command.key,
				typeof command.value === "string" ? new TextEncoder().encode(command.value) : command.value,
			);
		}
	}
}

/** A server that refuses the write, the way a Redis without SET permission would. */
class FailingClient extends FakeClient {
	async setMany(): Promise<void> {
		throw new Error("NOPERM this user has no permissions to run the 'set' command");
	}
}

function target(name: string, client: XferClient): XferTarget {
	return { name, namespace: "ace", client };
}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("storeFile", () => {
	it("stores on every target and reports only where the copy landed", async () => {
		const root = await workspace();
		await writeFile(join(root, "report.txt"), "hello");
		const first = new FakeClient("first");
		const second = new FailingClient("second");

		const result = await storeFile({
			root,
			input: validateStoreInput({ path: "report.txt", ttl: "PT30M" }),
			targets: [target("first", first), target("second", second)],
			now: () => NOW,
		});

		expect(result.storedOn).toEqual(["first"]);
		expect(result.text).toBe(
			`pickup=${result.token} size=5 sha256=${sha256Of(new TextEncoder().encode("hello"))} ` +
				"name=report.txt ttl=PT30M stored_at=1970-01-01T00:16:40.000Z " +
				"expires_at=1970-01-01T00:46:40.000Z stored_on=first",
		);
		expect(first.store.has(`ace:xfer:${result.token}`)).toBe(true);
		expect(first.store.has(`ace:xfer:${result.token}:meta`)).toBe(true);
		expect(second.store.size).toBe(0);
	});

	it("reports an empty stored_on when no target accepted the copy", async () => {
		const root = await workspace();
		await writeFile(join(root, "report.txt"), "hi");

		const result = await storeFile({
			root,
			input: validateStoreInput({ path: "report.txt" }),
			targets: [target("first", new FailingClient("first")), target("second", new FailingClient("second"))],
		});

		expect(result.storedOn).toEqual([]);
		expect(result.text).toMatch(/ stored_on=$/);
	});

	it("stores under the `name` override instead of the basename", async () => {
		const root = await workspace();
		await writeFile(join(root, "report.txt"), "hi");
		const client = new FakeClient();

		const result = await storeFile({
			root,
			input: validateStoreInput({ path: "report.txt", name: "dir/renamed.bin" }),
			targets: [target("local", client)],
		});

		const meta = JSON.parse(new TextDecoder().decode(client.store.get(`ace:xfer:${result.token}:meta`))) as XferMeta;
		expect(meta.name).toBe("renamed.bin");
	});

	it("resolves a relative path against the root", async () => {
		const root = await workspace();
		await mkdir(join(root, "sub"));
		await writeFile(join(root, "sub", "report.txt"), "hi");

		const result = await storeFile({
			root,
			input: validateStoreInput({ path: "sub/report.txt" }),
			targets: [target("local", new FakeClient())],
		});

		expect(result.size).toBe(2);
	});

	it("fails a missing file, a directory and an unreadable path with their own sentences", async () => {
		const root = await workspace();
		await writeFile(join(root, "report.txt"), "hi");
		await mkdir(join(root, "folder"));

		await expect(storeFile({ root, input: validateStoreInput({ path: "nope.txt" }), targets: [] })).rejects.toThrow(
			/file "nope.txt" does not exist/,
		);
		await expect(storeFile({ root, input: validateStoreInput({ path: "folder" }), targets: [] })).rejects.toThrow(
			/`path` "folder" is a directory, not a file/,
		);
		// `report.txt/child` cannot be stated: the parent is a file, so `stat` fails with something other
		// than ENOENT — the unreadable branch, distinct from "does not exist".
		await expect(
			storeFile({ root, input: validateStoreInput({ path: "report.txt/child" }), targets: [] }),
		).rejects.toThrow(/file "report.txt\/child" cannot be read:/);
	});

	it("refuses a file over the configured ceiling, naming the size", async () => {
		const root = await workspace();
		await writeFile(join(root, "big.bin"), new Uint8Array(64));

		await expect(
			storeFile({
				root,
				input: validateStoreInput({ path: "big.bin" }),
				targets: [target("local", new FakeClient())],
				maxBytes: 32,
			}),
		).rejects.toThrow(/exceeds the configured maximum/);
	});
});

/** Seed one client with a blob and its metadata, the way a store on that server would. */
async function seed(
	client: FakeClient,
	token: string,
	bytes: Uint8Array,
	name = "report.txt",
	namespace = "ace",
): Promise<XferMeta> {
	const meta: XferMeta = {
		name,
		size: bytes.byteLength,
		sha256: sha256Of(bytes),
		storedAt: NOW,
		expiresAt: NOW + TTL_MS,
	};
	await putBlob({ client, namespace, token, bytes, meta, ttlMs: TTL_MS });
	return meta;
}

describe("receiveFile", () => {
	it("takes the first hit in target order and writes into the quarantine directory", async () => {
		const root = await workspace();
		const first = new FakeClient("first");
		const second = new FakeClient("second");
		const bytes = new TextEncoder().encode("payload");
		await seed(first, TOKEN, bytes, "sub/report.txt");
		await seed(second, TOKEN, new TextEncoder().encode("other"), "sub/report.txt");

		const result = await receiveFile({
			root,
			token: TOKEN,
			sessionId: "sess-1",
			targets: [target("first", first), target("second", second)],
		});

		const expectedPath = join(root, ".ace", "xfer", TOKEN, "sess-1", "report.txt");
		expect(result.path).toBe(expectedPath);
		expect(result.from).toBe("first");
		expect(result.size).toBe(7);
		expect(result.sha256).toBe(sha256Of(bytes));
		expect(result.text).toBe(
			`path=${expectedPath} sha256=${sha256Of(bytes)} size=7 name=report.txt from=first ` +
				"stored_at=1970-01-01T00:16:40.000Z expires_at=1970-01-01T01:16:40.000Z",
		);
		expect(await readFile(expectedPath)).toEqual(Buffer.from(bytes));
	});

	it("overwrites the same path when the bytes are identical", async () => {
		const root = await workspace();
		const client = new FakeClient();
		await seed(client, TOKEN, new TextEncoder().encode("same"), "report.txt");

		const first = await receiveFile({ root, token: TOKEN, sessionId: "sess-1", targets: [target("local", client)] });
		const second = await receiveFile({ root, token: TOKEN, sessionId: "sess-1", targets: [target("local", client)] });

		expect(second.path).toBe(first.path);
		const entries = await readdir(join(root, ".ace", "xfer", TOKEN, "sess-1"));
		expect(entries).toEqual(["report.txt"]);
	});

	it("writes beside a differing file with a numeric suffix", async () => {
		const root = await workspace();
		const client = new FakeClient();
		await seed(client, TOKEN, new TextEncoder().encode("first"), "report.txt");
		await receiveFile({ root, token: TOKEN, sessionId: "sess-1", targets: [target("local", client)] });

		await seed(client, TOKEN, new TextEncoder().encode("second"), "report.txt");
		const second = await receiveFile({ root, token: TOKEN, sessionId: "sess-1", targets: [target("local", client)] });

		expect(second.path).toBe(join(root, ".ace", "xfer", TOKEN, "sess-1", "report (2).txt"));
		expect(await readFile(second.path, "utf8")).toBe("second");
	});

	it("reports the diagnosable message when no server has the token", async () => {
		const root = await workspace();

		await expect(
			receiveFile({ root, token: TOKEN, sessionId: "sess-1", targets: [target("local", new FakeClient("local"))] }),
		).rejects.toThrow(
			"no blob for that token on any of your servers: it may have expired, or you and the sender share no server",
		);
	});
});
