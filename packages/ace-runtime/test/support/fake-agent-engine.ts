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

	async inject(message: AceMessage, mode: InjectionMode): Promise<void> {
		this.injections.push({ message, mode });
	}

	isRunning(): boolean {
		return this.running;
	}

	async waitForIdle(): Promise<void> {}
}
