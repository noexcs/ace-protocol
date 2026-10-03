/** Minimal ACE runtime logger. Log lines never contain a message body (RFC-facing §31). */
export interface AceLogger {
	info?(message: string): void;
	warn?(message: string): void;
	error?(message: string): void;
}

/** Logger that writes to the console. */
export const consoleAceLogger: AceLogger = {
	info: (message) => console.log(message),
	warn: (message) => console.warn(message),
	error: (message) => console.error(message),
};
