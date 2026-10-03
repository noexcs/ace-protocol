import type { AgentEngine, InjectionMode } from "../../src/agent/agent-engine.ts";
import type { AceMessage } from "../../src/protocol/ace-message.ts";

export interface InjectionRecord {
	readonly message: AceMessage;
	readonly mode: InjectionMode;
}

/** Minimal {@link AgentEngine} that records injections instead of driving a real agent. */
export class FakeAgentEngine implements AgentEngine {
	readonly injections: InjectionRecord[] = [];
	running = false;
	/** Upcoming `inject` calls that fail instead of recording, for redelivery tests. */
	failures = 0;
	private readonly runErrorListeners: Array<(error: unknown) => void> = [];

	async inject(message: AceMessage, mode: InjectionMode): Promise<void> {
		if (this.failures > 0) {
			this.failures -= 1;
			throw new Error("fake engine unavailable");
		}
		this.injections.push({ message, mode });
	}

	isRunning(): boolean {
		return this.running;
	}

	async waitForIdle(): Promise<void> {}

	/** The runtime registers here to count failed runs. */
	onRunError(listener: (error: unknown) => void): void {
		this.runErrorListeners.push(listener);
	}

	/** Simulate a turn that ended in failure. */
	reportRunFailure(error: unknown = new Error("fake engine run failed")): void {
		for (const listener of this.runErrorListeners) listener(error);
	}
}
