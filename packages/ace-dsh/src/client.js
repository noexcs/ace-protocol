/* ace-dsh — src/client.js
 *
 * Browser-side body of the channel chip: it contributes one entry to `conversation.input.left`, the compact
 * control row at the left of the composer, showing whether THIS session is registered with ACE — a green dot
 * with the channel's session tail when it is, a grey `ACE off` when it is not.
 *
 * It reads the host through `GET /api/ace.status?session=<id>`, an exact Fetch route on Connection: the
 * request passes Connection's Host/Origin fence and browser-session check before the host half sees it, and
 * the address is document-relative (no leading slash) exactly as the session-log export does it.
 *
 * ## Two rules this file learned the hard way
 *
 * 1. **`slots.inject(seat, factory)` first, never a bare `slots.register`.** A seat is declared by whichever
 *    entry owns it, and at web boot that owner may not have mounted yet; registering into an undeclared seat
 *    throws. That throw happens while the client entry is activating, and a client entry that fails to
 *    activate fails the whole web boot — the desktop app refuses to start and offers its recovery dialog.
 *    `inject` exists for exactly this: it records the interest now and runs the factory when the seat appears.
 *    (0.2.0-rc.2 first-party plugins — `dsh-client-ui-model-selection`, `dsh-client-ui-permission-presets` —
 *    all do it this way.)
 * 2. **A cosmetic chip must never be able to stop the app.** Everything below is total: the factory, the
 *    component, and the fetch all swallow their failures and degrade to "no chip" or "ACE off". The only
 *    thing `apply` may do is register interest; it throws nothing.
 *
 * Inlined into lib/client.js by scripts/bundle.mjs, which wraps it in the `__ModuleLoader__.load` factory —
 * so `require`, `exports`, and `module` are in scope here, as they are for every client plugin.
 */

const React = require("react");

/** The seat this contribution lives in: the composer tool row, left of the permission and model controls. */
const SEAT = "conversation.input.left";
/** The route, document-relative: resolved against `document.baseURI` by a plain `fetch`. */
const STATUS_ROUTE = "/api/ace.status".slice(1);
/** A chip is ambient state, not a live feed: one read at mount, one per poll, and one after a click. */
const POLL_MS = 15000;

const COLOR_LIVE = "#22c55e";
const COLOR_OFF = "#9ca3af";
/** Amber: the chip does not know — no session id, a read in flight, or a read that failed. */
const COLOR_UNKNOWN = "#f59e0b";

/** Read this session's registration state. Any failure reads as "unknown", never as a claim. */
async function readStatus(sessionId, signal) {
	try {
		const response = await fetch(`${STATUS_ROUTE}?session=${encodeURIComponent(sessionId)}`, {
			cache: "no-store",
			signal,
		});
		if (!response.ok) return undefined;
		const value = await response.json();
		return typeof value === "object" && value !== null ? value : undefined;
	} catch {
		// A carrier without the route (a host build that predates it, a refused request, an aborted read) is
		// "cannot tell", which the chip shows as `ACE !` — never as `ACE off`, which would claim a fact nothing
		// established.
		return undefined;
	}
}

/** The channel's last segment, shortened the way ACE's own reports shorten a session id. */
function channelTail(channel) {
	const last = typeof channel === "string" && channel !== "" ? (channel.split(":").pop() ?? "") : "";
	return last.length > 12 ? last.slice(-6) : last;
}

/**
 * The chip.
 *
 * @param props - the seat's standard session-scope props; `sessionId` is the only one used.
 */
function AceChannelChip(props) {
	const sessionId = props !== null && typeof props === "object" ? props.sessionId : undefined;
	// `undefined` = no read has answered yet; `null` = the read itself failed. Both used to be shown as "off",
	// which made a missing route and an unregistered session look identical — the one thing an indicator must
	// never do.
	const [status, setStatus] = React.useState(undefined);
	const [poking, setPoking] = React.useState(false);

	React.useEffect(() => {
		if (typeof sessionId !== "string" || sessionId === "") return undefined;
		const controller = new AbortController();
		const read = () => {
			void readStatus(sessionId, controller.signal).then((value) => {
				if (!controller.signal.aborted) setStatus(value ?? null);
			});
		};
		read();
		const timer = setInterval(read, POLL_MS);
		return () => {
			controller.abort();
			if (timer !== null) clearInterval(timer);
		};
	}, [sessionId]);

	const hasSession = typeof sessionId === "string" && sessionId !== "";
	const live = status !== undefined && status !== null && status.live === true;
	const channel = live && Array.isArray(status.channels) ? status.channels[0] : undefined;
	const tail = channelTail(channel);

	let label = "ACE off";
	let title = "ACE: the host reports no channel for this session — click to re-check";
	let color = COLOR_OFF;
	if (!hasSession) {
		label = "ACE ?";
		title = "ACE: this seat gave the chip no session id, so nothing could be asked";
		color = COLOR_UNKNOWN;
	} else if (status === undefined) {
		label = "ACE …";
		title = "ACE: reading this session's registration from the host…";
		color = COLOR_UNKNOWN;
	} else if (status === null) {
		label = "ACE !";
		title = "ACE: the host's /api/ace.status route could not be read — click to retry";
		color = COLOR_UNKNOWN;
	} else if (live) {
		label = tail === "" ? "ACE" : `ACE · ${tail}`;
		title = `ACE: this session is registered as ${channel} — click to re-check`;
		color = COLOR_LIVE;
	}

	return React.createElement(
		"button",
		{
			type: "button",
			style: {
				display: "inline-flex",
				alignItems: "center",
				gap: "5px",
				padding: "0 2px",
				border: "0",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "11px",
				lineHeight: "1.4",
				opacity: live ? "0.95" : "0.55",
				cursor: "pointer",
				whiteSpace: "nowrap",
			},
			title,
			"aria-label": title,
			onClick: () => {
				if (!hasSession) return;
				setPoking(true);
				void readStatus(sessionId, undefined).then((value) => {
					setStatus(value ?? null);
					setPoking(false);
				});
			},
		},
		React.createElement("span", {
			style: {
				width: "7px",
				height: "7px",
				borderRadius: "50%",
				background: color,
				boxShadow: live ? `0 0 0 2px ${COLOR_LIVE}22` : "none",
				flex: "0 0 auto",
			},
			"aria-hidden": "true",
		}),
		React.createElement(
			"span",
			{
				style: {
					fontFamily: live && tail !== "" ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "inherit",
				},
			},
			poking ? "ACE …" : label,
		),
	);
}

/** Client services this plugin needs before it can register a seat. */
const inject = ["slots"];

function apply(ctx) {
	// Everything is inside this try/catch on purpose: see rule 2 at the top of the file. A client entry that
	// throws while activating fails the web boot, and no chip is worth that.
	try {
		ctx.effect(
			() =>
				ctx.slots.inject(SEAT, () => {
					try {
						return ctx.slots.register({ name: SEAT, id: "ace-dsh-channel", order: 40 }, AceChannelChip);
					} catch (error) {
						console.warn("[ace-dsh] the channel chip could not register:", error);
						return () => {};
					}
				}),
			"ace-dsh: channel chip",
		);
	} catch (error) {
		console.warn("[ace-dsh] the channel chip is unavailable:", error);
	}
}

exports.apply = apply;
exports.inject = inject;
