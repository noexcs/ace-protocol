/**
 * In-memory {@link AppServerConnection} pairs for tests.
 *
 * A real connection is a duplex over which newline-delimited JSON frames
 * flow both ways; the stdio/ws/unix builders each produce one. For unit
 * tests the peer is a scripted object that speaks the protocol in memory,
 * so we need two {@link AppServerConnection} ends joined by an in-process
 * pipe. {@link createMemoryConnections} returns such a pair: a `write` on
 * one side is delivered (asynchronously) to the other side's `onChunk`
 * handler, and a `close` on either side ends both.
 */

import type { AppServerConnection } from "./connection.ts";

interface MemoryEnd {
	chunkHandler: ((chunk: string) => void) | undefined;
	endHandler: ((reason?: string) => void) | undefined;
	peer: MemoryEnd;
	closed: boolean;
}

function makeEnd(): MemoryEnd {
	return { chunkHandler: undefined, endHandler: undefined, peer: undefined as unknown as MemoryEnd, closed: false };
}

/** Two joined {@link AppServerConnection} ends; writes on one become chunks on the other. */
export function createMemoryConnections(): { a: AppServerConnection; b: AppServerConnection } {
	// `peer` is a self-referential link, so it is wired up after both ends exist.
	const a = makeEnd();
	const b = makeEnd();
	a.peer = b;
	b.peer = a;

	const finish = (self: MemoryEnd, reason?: string) => {
		if (self.closed) return;
		self.closed = true;
		self.endHandler?.(reason);
		const peer = self.peer;
		if (!peer.closed) {
			peer.closed = true;
			peer.endHandler?.(reason);
		}
	};

	const build = (self: MemoryEnd, kind: "stdio" | "ws" | "unix"): AppServerConnection => ({
		kind,
		onChunk: (handler) => {
			self.chunkHandler = handler;
		},
		write: (text) => {
			const peer = self.peer;
			if (!peer.closed) queueMicrotask(() => peer.chunkHandler?.(text));
		},
		onEnd: (handler) => {
			self.endHandler = handler;
		},
		close: () => finish(self),
	});

	return { a: build(a, "stdio"), b: build(b, "stdio") };
}
