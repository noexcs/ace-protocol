import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** The subset of session events the adapter reacts to. */
export type StubSessionEvent =
	| { type: "agent_start" }
	| { type: "agent_settled" }
	| {
			type: "agent_end";
			willRetry: boolean;
			messages: Array<{ role: string; content: unknown; errorMessage?: string }>;
	  }
	| { type: "message_end"; message: { role: string; content: unknown } };

/**
 * Minimal stand-in for `AgentSession` that makes run/queue/settle ordering
 * deterministic; the real session is covered by the integration suite.
 */
export class FakeAgentSession {
	readonly prompted: string[] = [];
	readonly steered: string[] = [];
	readonly followedUp: string[] = [];
	streaming = false;
	clears = 0;
	promptError?: unknown;

	private readonly listeners = new Set<(event: StubSessionEvent) => void>();

	get isStreaming(): boolean {
		return this.streaming;
	}

	subscribe(listener: (event: StubSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: StubSessionEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	/** Emit the conversation message Pi produces when it injects queued text. */
	emitInjectedUserMessage(text: string): void {
		this.emit({ type: "message_end", message: { role: "user", content: text } });
	}

	async prompt(text: string): Promise<void> {
		this.prompted.push(text);
		if (this.promptError) throw this.promptError;
		this.emit({ type: "agent_start" });
	}

	async steer(text: string): Promise<void> {
		this.steered.push(text);
	}

	async followUp(text: string): Promise<void> {
		this.followedUp.push(text);
	}

	async waitForIdle(): Promise<void> {}

	clearQueue(): { steering: string[]; followUp: string[] } {
		this.clears += 1;
		this.steered.length = 0;
		this.followedUp.length = 0;
		return { steering: [], followUp: [] };
	}

	/** The adapter only needs the `AgentSession` surface used here. */
	asAgentSession(): AgentSession {
		return this as unknown as AgentSession;
	}
}
