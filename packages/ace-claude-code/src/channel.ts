/**
 * The one host-facing notification the plugin sends. Everything else (rendering the ACE event, the
 * acknowledgement trail, the MCP tools) feeds this or is fed by it.
 *
 * `content` is the rendered `<ace_event>` block; the host wraps it verbatim in its own
 * `<channel source="…">` tag. `meta` keys become attributes on that tag and must be identifiers —
 * `ace: "event"` marks the block as an ACE event so the model can tell it apart from a plain channel
 * message.
 */
export const CHANNEL_NOTIFICATION_METHOD = "notifications/claude/channel";

/** The notification params Claude Code expects for `notifications/claude/channel`. */
export interface ChannelNotificationParams {
	content: string;
	meta: Record<string, string>;
}

export interface ChannelNotification {
	method: string;
	params: ChannelNotificationParams;
}

/** Build the channel notification carrying one rendered ACE event. */
export function buildChannelNotification(content: string): ChannelNotification {
	return {
		method: CHANNEL_NOTIFICATION_METHOD,
		params: { content, meta: { ace: "event" } },
	};
}
