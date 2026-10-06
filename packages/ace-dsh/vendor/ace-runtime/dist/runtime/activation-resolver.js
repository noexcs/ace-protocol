/** Effective activation when neither the subscription nor the message picks one (RFC §8). */
export const DEFAULT_RUNTIME_ACTIVATION = "next_turn";
/**
 * Effective activation precedence (RFC §8):
 *
 * ```text
 * subscribe.activation != default  -> subscribe.activation
 * message.activation != default -> message.activation
 * otherwise                     -> runtime.defaultActivation
 * ```
 *
 * The receiver's subscription configuration can therefore override the sender's
 * preference.
 */
export function resolveActivation(message, subscription, runtimeDefaultActivation = DEFAULT_RUNTIME_ACTIVATION) {
    const subscriptionActivation = subscription?.activation;
    if (subscriptionActivation !== undefined && subscriptionActivation !== "default") {
        return subscriptionActivation;
    }
    if (message.activation !== "default") {
        return message.activation;
    }
    return runtimeDefaultActivation;
}
//# sourceMappingURL=activation-resolver.js.map