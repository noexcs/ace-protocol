import { describe, expect, it } from "vitest";
import {
	AppServerError,
	type AppServerFrame,
	createFrameDecoder,
	ERROR_INVALID_REQUEST,
	ERROR_METHOD_NOT_FOUND,
	EXPERIMENTAL_REQUIRED_SUFFIX,
	encodeFrame,
	isExperimentalRequired,
} from "../src/protocol.ts";

describe("encodeFrame", () => {
	it("appends a newline to a valid request frame", () => {
		expect(encodeFrame({ id: 1, method: "initialize", params: { a: 1 } })).toBe(
			'{"id":1,"method":"initialize","params":{"a":1}}\n',
		);
	});

	it("encodes a notification without an id", () => {
		expect(encodeFrame({ method: "initialized" })).toBe('{"method":"initialized"}\n');
	});

	it("rejects a frame with neither method nor id", () => {
		expect(() => encodeFrame({})).toThrow(/invalid app-server frame/);
	});

	it("rejects a frame that mixes a method with a result", () => {
		expect(() => encodeFrame({ id: 1, method: "x", result: {} })).toThrow(/invalid app-server frame/);
	});
});

describe("createFrameDecoder", () => {
	function decode(chunks: string[]): { frames: AppServerFrame[]; errors: string[] } {
		const frames: AppServerFrame[] = [];
		const errors: string[] = [];
		const decoder = createFrameDecoder(
			(frame) => frames.push(frame),
			(error) => errors.push(error.message),
		);
		for (const chunk of chunks) decoder(chunk);
		return { frames, errors };
	}

	it("parses one frame per complete line", () => {
		const { frames } = decode(['{"id":1,"method":"a"}\n{"id":2,"method":"b"}\n']);
		expect(frames).toEqual([
			{ id: 1, method: "a" },
			{ id: 2, method: "b" },
		]);
	});

	it("reassembles a frame split across arbitrary chunk boundaries", () => {
		const { frames } = decode(['{"i', 'd":1,"meth', 'od":"turn/start","params":{"x":"\\n"}}\n']);
		expect(frames).toEqual([{ id: 1, method: "turn/start", params: { x: "\n" } }]);
	});

	it("tolerates CRLF line endings and blank lines", () => {
		const { frames } = decode(['{"id":1,"method":"a"}\r\n\r\n{"id":2,"method":"b"}\r\n']);
		expect(frames.map((f) => f.method)).toEqual(["a", "b"]);
	});

	it("reports a malformed line and continues with the next", () => {
		const { frames, errors } = decode(['{not json\n{"id":3,"method":"c"}\n']);
		expect(frames).toEqual([{ id: 3, method: "c" }]);
		expect(errors).toHaveLength(1);
	});

	it("rejects a top-level array or scalar", () => {
		const { errors } = decode(['[1,2]\n"str"\n42\n']);
		expect(errors).toHaveLength(3);
	});
});

describe("error mapping", () => {
	it("surfaces code, message and data on an error response", () => {
		const error = new AppServerError({ code: ERROR_INVALID_REQUEST, message: "boom", data: { x: 1 } });
		expect(error.code).toBe(ERROR_INVALID_REQUEST);
		expect(error.data).toEqual({ x: 1 });
		expect(error.message).toContain("boom");
		expect(error.name).toBe("AppServerError");
	});

	it("maps the experimental gate by message suffix, not by code", () => {
		const gated = { code: ERROR_INVALID_REQUEST, message: `thread/queue/add ${EXPERIMENTAL_REQUIRED_SUFFIX}` };
		expect(isExperimentalRequired(gated)).toBe(true);
		// Other invalid requests share the code but are not the gate.
		expect(isExperimentalRequired({ code: ERROR_INVALID_REQUEST, message: "bad request" })).toBe(false);
		expect(
			isExperimentalRequired({ code: ERROR_METHOD_NOT_FOUND, message: `x ${EXPERIMENTAL_REQUIRED_SUFFIX}` }),
		).toBe(true);
	});
});
