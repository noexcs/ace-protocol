import type { AceMessage, ConcreteActivation } from "../protocol/ace-message.ts";
import type { EndpointConfig } from "./endpoint-config.ts";
/** Effective activation when neither the subscription nor the message picks one (RFC §8). */
export declare const DEFAULT_RUNTIME_ACTIVATION: ConcreteActivation;
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
export declare function resolveActivation(message: AceMessage, subscription?: EndpointConfig, runtimeDefaultActivation?: ConcreteActivation): ConcreteActivation;
//# sourceMappingURL=activation-resolver.d.ts.map