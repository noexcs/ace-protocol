/**
 * ACE 0.1 protocol types.
 *
 * Normative reference: `ACE-RFC-Draft-0.1.md` — §5 (ACE Protocol Layer), §7 (Activation
 * Semantics), §11 (Message Encoding), §12 (JSON Schema), §15 (Extensions).
 */
/** ACE protocol version implemented by this runtime. */
export declare const ACE_VERSION = "0.1";
/** Protocol version literal carried by {@link AceMessage.aceVersion}. */
export type AceVersion = typeof ACE_VERSION;
/** ACE 0.1 activation semantics (RFC §7). */
export type Activation = "immediate" | "next_turn" | "manual" | "default";
/** Every ACE 0.1 activation value (RFC §7). */
export declare const ACTIVATIONS: readonly Activation[];
/**
 * Activation values a runtime can execute.
 *
 * `default` is a delegation value: the sender leaves the choice to the receiver
 * (RFC §7.4), so it never reaches a {@link AgentEngine}.
 */
export type ConcreteActivation = Exclude<Activation, "default">;
/** Every activation value a runtime can execute. */
export declare const CONCRETE_ACTIVATIONS: readonly ConcreteActivation[];
/**
 * ACE 0.1 message envelope (RFC §5, §12).
 *
 * - `body` is an opaque string; ACE never interprets it (RFC §6).
 * - `(sender, id)` identifies the message, `(sender, sessionId)` the sender's
 *   conversation/instance (RFC §5.2) — `sessionId` is deliberately unstable across sessions and
 *   never an authorization credential.
 * - Unknown fields are allowed and must be ignored (RFC §15).
 */
export interface AceMessage {
    aceVersion: AceVersion;
    id: string;
    sender: string;
    /** Sender's session/instance identifier (RFC §5.4); optional, opaque, deployment-defined. */
    sessionId?: string;
    /**
     * What the sender says about itself: where it runs (agent, session, cwd, host, ip, platform, pid).
     *
     * Sender-supplied and display-only: an event can be produced by anything on the channel, so this
     * is a courtesy for the reader and never an authorization (RFC §18, §22 item 3).
     */
    senderDescription?: string;
    activation: Activation;
    body: string;
    [key: string]: unknown;
}
/** Whether `value` is one of the four ACE 0.1 activation values. */
export declare function isActivation(value: unknown): value is Activation;
/** Whether `value` is an activation a runtime can execute (RFC §7.1–§7.3). */
export declare function isConcreteActivation(value: unknown): value is ConcreteActivation;
//# sourceMappingURL=ace-message.d.ts.map