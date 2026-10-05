import { describe, expect, it } from "vitest";
import {
	assertTransferSize,
	formatGetResult,
	formatSendResult,
	newToken,
	parseIsoDuration,
	putBlob,
	quarantinePath,
	sanitizeName,
	takeBlob,
	validateGetInput,
	validateStoreInput,
	XFER_DEFAULTS,
	type XferClient,
	type XferMeta,
	type XferSetCommand,
	xferBlobKey,
	xferMetaKey,
} from "../../src/tools/xfer.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const META: XferMeta = {
	name: "报告 v2.pdf",
	size: 4,
	sha256: SHA,
	createdAt: 1_000,
	expiresAt: 3_601_000,
};

/**
 * A fake `XferClient`: it keeps the bytes `setMany` wrote, normalising a string value to UTF-8 the
 * way the host adapter would, and it never deletes on `get` — the non-destructive read is a contract
 * worth testing against.
 */
class FakeClient implements XferClient {
	readonly name: string;
	readonly store = new Map<string, Uint8Array>();
	/** Every `setMany` call, so a test can assert both keys were written in one pipeline. */
	readonly pipelines: XferSetCommand[][] = [];

	constructor(name = "local") {
		this.name = name;
	}

	async get(key: string): Promise<Uint8Array | undefined> {
		return this.store.get(key);
	}

	async setMany(commands: readonly XferSetCommand[]): Promise<void> {
		this.pipelines.push([...commands]);
		for (const command of commands) {
			this.store.set(
				command.key,
				typeof command.value === "string" ? new TextEncoder().encode(command.value) : command.value,
			);
		}
	}
}

describe("XFER_DEFAULTS", () => {
	it("keeps the TTL strings and their millisecond forms in step", () => {
		expect(parseIsoDuration(XFER_DEFAULTS.defaultTtl)).toBe(XFER_DEFAULTS.defaultTtlMs);
		expect(parseIsoDuration(XFER_DEFAULTS.maxTtl)).toBe(XFER_DEFAULTS.maxTtlMs);
	});

	it("orders the byte limits: default < hard max < the Redis ceiling", () => {
		expect(XFER_DEFAULTS.defaultMaxBytes).toBeLessThan(XFER_DEFAULTS.hardMaxBytes);
		expect(XFER_DEFAULTS.hardMaxBytes).toBeLessThan(XFER_DEFAULTS.refuseAtBytes);
	});
});

describe("parseIsoDuration", () => {
	it("parses the duration forms a TTL uses", () => {
		expect(parseIsoDuration("PT1H")).toBe(3_600_000);
		expect(parseIsoDuration("P1D")).toBe(86_400_000);
		expect(parseIsoDuration("PT30M")).toBe(1_800_000);
		expect(parseIsoDuration("PT90S")).toBe(90_000);
		expect(parseIsoDuration("P0DT2H")).toBe(7_200_000);
		expect(parseIsoDuration("P1DT0H")).toBe(86_400_000);
		expect(parseIsoDuration("PT1.5S")).toBe(1_500);
	});

	it("accepts the duration case-insensitively", () => {
		expect(parseIsoDuration(" pt1h ")).toBe(3_600_000);
	});

	it("refuses a value that is not an ISO 8601 duration, naming it and the expected form", () => {
		for (const value of ["1h", "PT", "P", "P1DT", "PT0S", "", "tomorrow", 3600, null]) {
			expect(() => parseIsoDuration(value)).toThrow(/positive ISO 8601 duration/);
		}
	});

	it("refuses a duration above the maximum TTL and names it", () => {
		expect(() => parseIsoDuration("P2D")).toThrow('"P2D" is longer than the maximum ttl "P1D"');
		expect(parseIsoDuration("P1D")).toBe(XFER_DEFAULTS.maxTtlMs);
	});

	it("honours a caller's ceiling instead of the default one", () => {
		expect(parseIsoDuration("PT2H", { maxMs: 2 * 3_600_000 })).toBe(7_200_000);
		expect(parseIsoDuration("P1W", { maxMs: 8 * 86_400_000 })).toBe(604_800_000);
		expect(() => parseIsoDuration("PT2H", { maxMs: 3_600_000, maxIso: "PT1H" })).toThrow(
			'"PT2H" is longer than the maximum ttl "PT1H"',
		);
	});
});

describe("newToken", () => {
	it("mints a 128-bit lowercase hex token", () => {
		const token = newToken();
		expect(token).toMatch(/^[0-9a-f]{32}$/);
		expect(newToken()).not.toBe(token);
	});
});

describe("sanitizeName", () => {
	it("keeps only the basename on either path separator", () => {
		expect(sanitizeName("/etc/passwd")).toBe("passwd");
		expect(sanitizeName("C:\\Users\\ana\\report.txt")).toBe("report.txt");
		expect(sanitizeName("dir/sub/report.txt")).toBe("report.txt");
		// A traversal in the raw value is reduced to its last segment, not refused: the segment is safe.
		expect(sanitizeName("../evil")).toBe("evil");
	});

	it("strips control characters and keeps interior spaces", () => {
		expect(sanitizeName("a\u0000b\u001fc.txt")).toBe("abc.txt");
		expect(sanitizeName("my file.txt")).toBe("my file.txt");
	});

	it("refuses `..`, `.` and anything empty after sanitising", () => {
		for (const raw of ["..", ".", "", "/", "a/..", "dir/", "sub/.."]) {
			expect(() => sanitizeName(raw)).toThrow();
		}
	});
});

describe("key builders", () => {
	it("builds the blob and metadata side keys", () => {
		expect(xferBlobKey("ace", TOKEN)).toBe(`ace:xfer:${TOKEN}`);
		expect(xferMetaKey("ace", TOKEN)).toBe(`ace:xfer:${TOKEN}:meta`);
		expect(xferMetaKey("team", TOKEN)).toBe(`team:xfer:${TOKEN}:meta`);
	});
});

describe("quarantinePath", () => {
	it("puts every write under `.ace/xfer/<token>/<sessionId>/`", () => {
		expect(quarantinePath("/work", TOKEN, "sess-1", "report.txt")).toBe(`/work/.ace/xfer/${TOKEN}/sess-1/report.txt`);
	});

	it("cannot be made to leave the quarantine root, even by an unsanitised name", () => {
		expect(quarantinePath("/work", TOKEN, "sess-1", "../../etc/passwd")).toBe(
			`/work/.ace/xfer/${TOKEN}/sess-1/passwd`,
		);
		expect(() => quarantinePath("/work", TOKEN, "sess-1", "..")).toThrow();
	});
});

describe("putBlob / takeBlob", () => {
	it("writes the blob and its metadata in one pipeline, each with the TTL", async () => {
		const client = new FakeClient();
		const bytes = new TextEncoder().encode("hi!!");
		await putBlob({ client, namespace: "ace", token: TOKEN, bytes, meta: META, ttlMs: 3_600_000 });

		expect(client.pipelines).toHaveLength(1);
		expect(client.pipelines[0]).toEqual([
			{ key: `ace:xfer:${TOKEN}`, value: bytes, ttlMs: 3_600_000 },
			{ key: `ace:xfer:${TOKEN}:meta`, value: JSON.stringify(META), ttlMs: 3_600_000 },
		]);
	});

	it("reads both keys back non-destructively, with the server it came from", async () => {
		const client = new FakeClient("second");
		const bytes = new TextEncoder().encode("hi!!");
		await putBlob({ client, namespace: "ace", token: TOKEN, bytes, meta: META, ttlMs: 3_600_000 });

		const first = await takeBlob({ client, namespace: "ace", token: TOKEN });
		const second = await takeBlob({ client, namespace: "ace", token: TOKEN });

		expect(first?.bytes).toEqual(bytes);
		expect(first?.meta).toEqual(META);
		expect(first?.from).toBe("second");
		expect(second?.bytes).toEqual(bytes);
	});

	it("returns undefined when this server has no such blob", async () => {
		const client = new FakeClient();
		expect(await takeBlob({ client, namespace: "ace", token: TOKEN })).toBeUndefined();
	});

	it("errors when a blob exists without its metadata, naming the missing key", async () => {
		const client = new FakeClient();
		client.store.set(`ace:xfer:${TOKEN}`, new TextEncoder().encode("hi!!"));

		await expect(takeBlob({ client, namespace: "ace", token: TOKEN })).rejects.toThrow(
			`a blob exists without its metadata — likely an interrupted write (the key "ace:xfer:${TOKEN}:meta" is missing)`,
		);
	});

	it("errors when the metadata is not the shape putBlob writes", async () => {
		const client = new FakeClient();
		client.store.set(`ace:xfer:${TOKEN}`, new TextEncoder().encode("hi!!"));
		client.store.set(`ace:xfer:${TOKEN}:meta`, new TextEncoder().encode("{not json"));
		await expect(takeBlob({ client, namespace: "ace", token: TOKEN })).rejects.toThrow(/not a valid transfer record/);

		client.store.set(`ace:xfer:${TOKEN}:meta`, new TextEncoder().encode('{"name":"x"}'));
		await expect(takeBlob({ client, namespace: "ace", token: TOKEN })).rejects.toThrow(/not a valid transfer record/);
	});
});

describe("assertTransferSize", () => {
	it("accepts a size up to the default limit", () => {
		expect(() => assertTransferSize(0)).not.toThrow();
		expect(() => assertTransferSize(XFER_DEFAULTS.defaultMaxBytes)).not.toThrow();
	});

	it("refuses a size above the configured maximum", () => {
		expect(() => assertTransferSize(XFER_DEFAULTS.defaultMaxBytes + 1)).toThrow(/exceeds the configured maximum/);
		expect(() => assertTransferSize(2_000, { maxBytes: 1_000 })).toThrow(/exceeds the configured maximum/);
	});

	it("refuses a maximum above the hard maximum", () => {
		expect(() => assertTransferSize(1, { maxBytes: XFER_DEFAULTS.hardMaxBytes + 1 })).toThrow(
			/above the hard maximum/,
		);
	});

	it("refuses the Redis ceiling no matter the configuration", () => {
		expect(() => assertTransferSize(XFER_DEFAULTS.refuseAtBytes)).toThrow(/Redis single-value ceiling/);
	});

	it("refuses a size that is not a non-negative integer", () => {
		expect(() => assertTransferSize(-1)).toThrow(/non-negative integer/);
		expect(() => assertTransferSize(1.5)).toThrow(/non-negative integer/);
	});
});

describe("validateStoreInput", () => {
	it("defaults the TTL to PT1H", () => {
		expect(validateStoreInput({ path: "/tmp/report.txt" })).toEqual({
			path: "/tmp/report.txt",
			ttl: "PT1H",
			ttlMs: 3_600_000,
		});
	});

	it("normalises an explicit TTL", () => {
		expect(validateStoreInput({ path: "a.bin", ttl: " pt30m " })).toEqual({
			path: "a.bin",
			ttl: "PT30M",
			ttlMs: 1_800_000,
		});
	});

	it("takes an optional `name`, sanitised to a single safe segment", () => {
		expect(validateStoreInput({ path: "a.bin", name: "dir/report.txt" })).toEqual({
			path: "a.bin",
			ttl: "PT1H",
			ttlMs: 3_600_000,
			name: "report.txt",
		});
	});

	it("refuses an unknown argument, a bad path, a bad name and a bad TTL", () => {
		expect(() => validateStoreInput({ path: "a", server: "local" })).toThrow(/does not take "server"/);
		for (const path of ["", "   ", 42, null, undefined, ["a"]]) {
			expect(() => validateStoreInput({ path })).toThrow(/`path` must be a non-empty string/);
		}
		for (const name of ["", "   ", 42, null]) {
			expect(() => validateStoreInput({ path: "a", name })).toThrow(/`name` must be/);
		}
		for (const name of ["..", "."]) {
			expect(() => validateStoreInput({ path: "a", name })).toThrow(/names a directory entry/);
		}
		expect(() => validateStoreInput({ path: "a", ttl: 3600 })).toThrow(/`ttl` must be an ISO 8601 duration/);
		expect(() => validateStoreInput({ path: "a", ttl: "P2D" })).toThrow(/longer than the maximum ttl/);
	});
});

describe("validateGetInput", () => {
	it("accepts a token and lowercases it", () => {
		expect(validateGetInput({ token: TOKEN.toUpperCase() })).toEqual({ token: TOKEN });
		expect(validateGetInput({ token: ` ${TOKEN} ` })).toEqual({ token: TOKEN });
	});

	it("refuses an unknown argument and a token that is not 128 bits", () => {
		expect(() => validateGetInput({ token: TOKEN, server: "local" })).toThrow(/does not take "server"/);
		for (const token of ["", "   ", "abc", "g".repeat(32), 128, null]) {
			expect(() => validateGetInput({ token })).toThrow(/128-bit hex token/);
		}
	});
});

describe("formatSendResult", () => {
	it("renders the one-line pickup information", () => {
		expect(
			formatSendResult({ token: TOKEN, size: 1024, sha256: SHA, expiresIn: "PT1H", storedOn: ["local", "second"] }),
		).toBe(`pickup=${TOKEN} size=1024 sha256=${SHA} expires_in=PT1H stored_on=local,second`);
	});

	it("reports an empty stored_on when no server accepted the copy", () => {
		expect(formatSendResult({ token: TOKEN, size: 0, sha256: SHA, expiresIn: "PT1H", storedOn: [] })).toBe(
			`pickup=${TOKEN} size=0 sha256=${SHA} expires_in=PT1H stored_on=`,
		);
	});

	it("quotes a stored_on value that carries whitespace, keeping the one-line shape", () => {
		expect(
			formatSendResult({ token: TOKEN, size: 1, sha256: SHA, expiresIn: "PT1H", storedOn: ["my host", "second"] }),
		).toBe(`pickup=${TOKEN} size=1 sha256=${SHA} expires_in=PT1H stored_on="my host,second"`);
		expect(formatSendResult({ token: TOKEN, size: 1, sha256: SHA, expiresIn: "PT1H", storedOn: ["my host"] })).toBe(
			`pickup=${TOKEN} size=1 sha256=${SHA} expires_in=PT1H stored_on="my host"`,
		);
	});
});

describe("formatGetResult", () => {
	it("renders the path, hash, size and server", () => {
		expect(
			formatGetResult({
				path: `/work/.ace/xfer/${TOKEN}/sess-1/report.txt`,
				sha256: SHA,
				size: 1024,
				from: "local",
			}),
		).toBe(`path=/work/.ace/xfer/${TOKEN}/sess-1/report.txt sha256=${SHA} size=1024 from=local`);
	});

	it("quotes a path that carries whitespace, keeping the one-line shape", () => {
		expect(formatGetResult({ path: "/work/.ace/xfer/x/s/report v2.txt", sha256: SHA, size: 4, from: "local" })).toBe(
			`path="/work/.ace/xfer/x/s/report v2.txt" sha256=${SHA} size=4 from=local`,
		);
	});
});
