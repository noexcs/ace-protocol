import { describeValue, isPlainObject } from "../utils.js";
import { ACE_VERSION, isActivation } from "./ace-message.js";
/** Thrown when a value is not a valid ACE 0.1 message (RFC §13). */
export class AceValidationError extends Error {
    issues;
    constructor(issues) {
        super(`Invalid ACE ${ACE_VERSION} message: ${issues.map((issue) => `${issue.path || "<message>"}: ${issue.message}`).join("; ")}`);
        this.name = "AceValidationError";
        this.issues = issues;
    }
}
const utf8 = new TextDecoder();
/** Longest accepted `sessionId`; the value is opaque but gets rendered into agent context. */
const MAX_SESSION_ID_LENGTH = 128;
/** Longest accepted sender description: enough for the host facts, short enough to keep headers readable. */
const MAX_SENDER_DESCRIPTION_LENGTH = 512;
/** Control characters would let a session id forge lines in the rendered event header. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/**
 * Validate a decoded ACE 0.1 message (RFC §12, §13).
 *
 * Unknown fields are kept and never rejected (RFC §15). Every violation is
 * collected before throwing.
 */
export function validateAceMessage(value) {
    if (!isPlainObject(value)) {
        throw new AceValidationError([{ path: "", message: `expected an object, received ${describeValue(value)}` }]);
    }
    const issues = [];
    const { aceVersion, id, sender, sessionId, senderDescription, activation, body } = value;
    if (aceVersion !== ACE_VERSION) {
        issues.push({
            path: "aceVersion",
            message: `must be "${ACE_VERSION}", received ${describeValue(aceVersion)}`,
        });
    }
    if (typeof id !== "string" || id.length === 0) {
        issues.push({ path: "id", message: `must be a non-empty string, received ${describeValue(id)}` });
    }
    if (typeof sender !== "string" || sender.length === 0) {
        issues.push({ path: "sender", message: `must be a non-empty string, received ${describeValue(sender)}` });
    }
    if (sessionId !== undefined) {
        if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) {
            issues.push({
                path: "sessionId",
                message: `must be a string of 1..${MAX_SESSION_ID_LENGTH} characters or absent, received ${describeValue(sessionId)}`,
            });
        }
        else if (CONTROL_CHARACTERS.test(sessionId)) {
            issues.push({ path: "sessionId", message: "must not contain control characters" });
        }
    }
    if (!isActivation(activation)) {
        issues.push({
            path: "activation",
            message: `must be one of immediate|next_turn|manual|default, received ${describeValue(activation)}`,
        });
    }
    if (senderDescription !== undefined) {
        if (typeof senderDescription !== "string" ||
            senderDescription.length === 0 ||
            senderDescription.length > MAX_SENDER_DESCRIPTION_LENGTH) {
            issues.push({
                path: "senderDescription",
                message: `must be a string of 1..${MAX_SENDER_DESCRIPTION_LENGTH} characters or absent, received ${describeValue(senderDescription)}`,
            });
        }
        else if (CONTROL_CHARACTERS.test(senderDescription)) {
            issues.push({ path: "senderDescription", message: "must not contain control characters" });
        }
    }
    if (typeof body !== "string") {
        issues.push({ path: "body", message: `must be a string, received ${describeValue(body)}` });
    }
    if (issues.length > 0)
        throw new AceValidationError(issues);
    return {
        ...value,
        aceVersion: ACE_VERSION,
        id: id,
        sender: sender,
        ...(sessionId === undefined ? {} : { sessionId: sessionId }),
        ...(senderDescription === undefined ? {} : { senderDescription: senderDescription }),
        activation: activation,
        body: body,
    };
}
/** Parse a JSON-encoded ACE message and validate it (RFC §11). */
export function parseAceMessage(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new AceValidationError([{ path: "", message: "must be valid JSON" }]);
    }
    return validateAceMessage(parsed);
}
/**
 * Decode whatever a transport hands over — text, bytes, or an already decoded
 * object — into a validated ACE 0.1 message.
 */
export function decodeAceMessage(raw) {
    if (typeof raw === "string")
        return parseAceMessage(raw);
    if (raw instanceof Uint8Array)
        return parseAceMessage(utf8.decode(raw));
    return validateAceMessage(raw);
}
//# sourceMappingURL=validator.js.map