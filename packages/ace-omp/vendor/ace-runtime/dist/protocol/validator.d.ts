import { type AceMessage } from "./ace-message.ts";
/** One conformance failure of an ACE 0.1 message (RFC §13). */
export interface AceValidationIssue {
    /** Location of the offending field; `""` means the message itself. */
    path: string;
    message: string;
}
/** Thrown when a value is not a valid ACE 0.1 message (RFC §13). */
export declare class AceValidationError extends Error {
    readonly issues: readonly AceValidationIssue[];
    constructor(issues: readonly AceValidationIssue[]);
}
/**
 * Validate a decoded ACE 0.1 message (RFC §12, §13).
 *
 * Unknown fields are kept and never rejected (RFC §15). Every violation is
 * collected before throwing.
 */
export declare function validateAceMessage(value: unknown): AceMessage;
/** Parse a JSON-encoded ACE message and validate it (RFC §11). */
export declare function parseAceMessage(raw: string): AceMessage;
/**
 * Decode whatever a transport hands over — text, bytes, or an already decoded
 * object — into a validated ACE 0.1 message.
 */
export declare function decodeAceMessage(raw: unknown): AceMessage;
//# sourceMappingURL=validator.d.ts.map