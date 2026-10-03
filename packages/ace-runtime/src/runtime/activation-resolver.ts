import type { AceMessage, ConcreteActivation } from "../protocol/ace-message.ts";
import type { EndpointConfig } from "./endpoint-config.ts";

/** Effective activation when neither the subscription nor the message picks one (RFC §8). */
export const DEFAULT_RUNTIME_ACTIVATION: ConcreteActivation = "next_turn";

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
export function resolveActivation(
	message: AceMessage,
	subscription?: EndpointConfig,
	runtimeDefaultActivation: ConcreteActivation = DEFAULT_RUNTIME_ACTIVATION,
): ConcreteActivation {
	const subscriptionActivation = subscription?.activation;
	if (subscriptionActivation !== undefined && subscriptionActivation !== "default") {
		return subscriptionActivation;
	}
	if (message.activation !== "default") {
		return message.activation;
	}
	return runtimeDefaultActivation;
}
