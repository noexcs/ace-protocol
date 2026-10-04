import { describe, expect, it } from "vitest";
import { AppServerClient } from "../src/client.ts";
import { createMemoryConnections } from "../src/memory-connection.ts";
import { AppServerError, ERROR_METHOD_NOT_FOUND } from "../src/protocol.ts";
import { FakeAppServer } from "./support/fake-app-server.ts";

/** Set up a client + fake server over an in-memory connection; wait for the handshake. */
async function setup() {
	const { a, b } = createMemoryConnections();
	const server = new FakeAppServer(b);
	const { client, ready } = AppServerClient.begin(a, { clientInfo: { name: "t", version: "0" } });
	const result = await ready;
	return { client, server, result, b };
}

describe("AppServerClient routing", () => {
	it("runs the initialize handshake and follows it with the initialized notification", async () => {
		const { client, server, result } = await setup();
		expect(result).toMatchObject({ codexHome: "/tmp/fake-codex-home" });
		// initialize is a request (carries an id); the initialized notification follows it.
		const initialize = server.requests.find((r) => r.method === "initialize");
		expect(initialize?.id).toBeDefined();
		const initialized = server.requests.find((r) => r.method === "initialized");
		expect(initialized).toBeDefined();
		expect(initialized?.id).toBeUndefined();
		expect(client.closed).toBe(false);
	});

	it("routes a response to the matching pending request by id", async () => {
		const { client, server } = await setup();
		const { thread } = await client.threadStart({ cwd: "/tmp" });
		expect(thread.id).toBe(server.threadId);
		expect(server.last("thread/start")?.params).toMatchObject({ cwd: "/tmp" });
	});

	it("rejects a request when the server answers with an error", async () => {
		const { client, server } = await setup();
		server.failNext = true;
		const error = await client.threadStart({}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AppServerError);
		expect((error as AppServerError).code).toBe(-32000);
	});

	it("routes a server -> client request to onServerRequest with the id", async () => {
		const { client, server } = await setup();
		const seen: Array<{ method: string; id: string | number }> = [];
		client.onServerRequest = (method, _params, id) => seen.push({ method, id });
		const id = server.serverRequest("execApproval/request", { some: "params" });
		// The routing is the capture; a handler that records (and does not answer)
		// never produces a response, so wait for the capture, not a response.
		const start = Date.now();
		while (seen.length === 0) {
			if (Date.now() - start > 2000) throw new Error("timed out waiting for onServerRequest");
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(seen).toEqual([{ method: "execApproval/request", id }]);
	});

	it("answers an unhandled server request with method-not-found so the server never hangs", async () => {
		const { server } = await setup();
		const id = server.serverRequest("someApproval/request", {});
		const response = await server.waitForResponse(id);
		expect(response.error).toMatchObject({ code: ERROR_METHOD_NOT_FOUND });
		expect(response.error?.message).toContain("bridge does not answer");
	});

	it("dispatches notifications to onNotification", async () => {
		const { client, server } = await setup();
		const methods: string[] = [];
		client.onNotification = (event) => methods.push(event.method);
		server.notify("turn/started", { threadId: server.threadId, turn: { id: "t1", status: "inProgress" } });
		server.notify("turn/completed", { threadId: server.threadId, turn: { id: "t1", status: "completed" } });
		await server.waitForNotification("turn/completed");
		expect(methods).toEqual(["turn/started", "turn/completed"]);
	});

	it("rejects in-flight requests when the connection ends", async () => {
		const { client, server, b } = await setup();
		server.holdNext = true; // keep the turn request pending
		const pending = client.turnStart({ threadId: server.threadId, input: [{ type: "text", text: "x" }] });
		await server.waitForRequest("turn/start");
		b.close();
		await expect(pending).rejects.toThrow(/app-server connection ended/);
		expect(client.closed).toBe(true);
	});
});
