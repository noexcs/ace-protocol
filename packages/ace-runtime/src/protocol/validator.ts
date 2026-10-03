import { describeValue, isPlainObject } from "../utils.ts";
import { ACE_VERSION, type AceMessage, type AceVersion, type Activation, isActivation } from "./ace-message.ts";

/** One conformance failure of an ACE 0.1 message (RFC §13). */
export interface AceValidationIssue {
	/** Location of the offending field; `""` means the message itself. */
	path: string;
	message: string;
}

/** Thrown when a value is not a valid ACE 0.1 message (RFC §13). */
export class AceValidationError extends Error {
	readonly issues: readonly AceValidationIssue[];

	constructor(issues: readonly AceValidationIssue[]) {
		super(
			`Invalid ACE ${ACE_VERSION} message: ${issues.map((issue) => `${issue.path || "<message>"}: ${issue.message}`).join("; ")}`,
		);
		this.name = "AceValidationError";
		this.issues = issues;
	}
}

const utf8 = new TextDecoder();

/** Longest accepted `sessionId`; the value is opaque but gets rendered into agent context. */
const MAX_SESSION_ID_LENGTH = 128;

/** Control characters would let a session id forge lines in the rendered event header. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Validate a decoded ACE 0.1 message (RFC §12, §13).
 *
 * Unknown fields are kept and never rejected (RFC §15). Every violation is
 * collected before throwing.
 */
export function validateAceMessage(value: unknown): AceMessage {
	if (!isPlainObject(value)) {
		throw new AceValidationError([{ path: "", message: `expected an object, received ${describeValue(value)}` }]);
	}

	const issues: AceValidationIssue[] = [];
	const { aceVersion, id, sender, sessionId, activation, body } = value;

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
		} else if (CONTROL_CHARACTERS.test(sessionId)) {
			issues.push({ path: "sessionId", message: "must not contain control characters" });
		}
	}
	if (!isActivation(activation)) {
		issues.push({
			path: "activation",
			message: `must be one of immediate|next_turn|manual|default, received ${describeValue(activation)}`,
		});
	}
	if (typeof body !== "string") {
		issues.push({ path: "body", message: `must be a string, received ${describeValue(body)}` });
	}

	if (issues.length > 0) throw new AceValidationError(issues);

	return {
		...value,
		aceVersion: ACE_VERSION as AceVersion,
		id: id as string,
		sender: sender as string,
		...(sessionId === undefined ? {} : { sessionId: sessionId as string }),
		activation: activation as Activation,
		body: body as string,
	};
}

/** Parse a JSON-encoded ACE message and validate it (RFC §11). */
export function parseAceMessage(raw: string): AceMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new AceValidationError([{ path: "", message: "must be valid JSON" }]);
	}
	return validateAceMessage(parsed);
}

/**
 * Decode whatever a transport hands over — text, bytes, or an already decoded
 * object — into a validated ACE 0.1 message.
 */
export function decodeAceMessage(raw: unknown): AceMessage {
	if (typeof raw === "string") return parseAceMessage(raw);
	if (raw instanceof Uint8Array) return parseAceMessage(utf8.decode(raw));
	return validateAceMessage(raw);
}
