/**
 * ACE 0.1 protocol types.
 *
 * Normative reference: `ACE-RFC-Draft-0.1.md` — §5 (ACE Protocol Layer), §7 (Activation
 * Semantics), §11 (Message Encoding), §12 (JSON Schema), §15 (Extensions).
 */
/** ACE protocol version implemented by this runtime. */
export const ACE_VERSION = "0.1";
/** Every ACE 0.1 activation value (RFC §7). */
export const ACTIVATIONS = ["immediate", "next_turn", "manual", "default"];
/** Every activation value a runtime can execute. */
export const CONCRETE_ACTIVATIONS = ["immediate", "next_turn", "manual"];
/** Whether `value` is one of the four ACE 0.1 activation values. */
export function isActivation(value) {
    return typeof value === "string" && ACTIVATIONS.includes(value);
}
/** Whether `value` is an activation a runtime can execute (RFC §7.1–§7.3). */
export function isConcreteActivation(value) {
    return typeof value === "string" && CONCRETE_ACTIVATIONS.includes(value);
}
//# sourceMappingURL=ace-message.js.map