/**
 * The `/ace` views: the interactive channel manager and the read-only report panels.
 *
 * Both are drawn in the visual grammar of the built-in `/mcp` manager — a full-width rule, an accent bold
 * title, a muted context line, an accent name column, a coloured state tag and dim notes — but the furniture
 * is local. `/mcp` builds its block out of modules an extension cannot reach (`TranscriptBlock`,
 * `DynamicBorder`, `showCommandMessage`); an extension has the public `ctx.ui.custom` surface plus
 * `@earendil-works/pi-tui`, so the frame, the rules and the key hints are drawn here.
 *
 * The panels are read-only (there is nothing to act on, so nothing pretends to be selectable) and the manager
 * keeps its `SelectList` because a channel has a detail view to open.
 *
 * Modes other than `tui` never reach this file: measured on omp 18.5.0 in `--mode rpc --no-ui`,
 * `ctx.mode === "rpc"` and `ctx.hasUI === false`, `ctx.ui.theme.fg` returns real ANSI, and
 * `ctx.ui.custom(factory)` resolves `undefined` without ever calling the factory — a panel opened there would
 * silently show nothing, so every caller gates on `ctx.mode === "tui"` and prints the text report otherwise.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AceMetricsSnapshot, ChannelReport, EndpointConfig } from "../vendor/ace-runtime/dist/index.js";
import { formatDurationHuman } from "../vendor/ace-runtime/dist/index.js";

/** The slice of the host theme the views use; structurally what `ctx.ui.custom` hands to the factory. */
export interface AceTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** The slice of the host TUI the views use. */
interface AceTui {
	requestRender(): void;
}

/** The slice of the host keybindings the views use. */
interface AceKeybindings {
	matches(data: string, binding: string): boolean;
}

/**
 * What a row is doing. The words and the colours are `/mcp`'s (`● connected`, `◌ inactive`), so a reader who
 * knows that panel reads this one: a channel this session reads is connected, a peer on the directory is
 * live, a retained `manual` event is pending (or `expires soon` once its retention window starts closing),
 * and a configured thing that is not working is inactive.
 */
export type AcePanelStatus = "connected" | "live" | "pending" | "expiring" | "inactive";

/**
 * The tag each status is drawn as. The leading space is part of the tag, exactly as in `/mcp`: it is what
 * keeps the state column lined up across rows whose names have different lengths.
 */
const ACE_PANEL_STATUS: Record<AcePanelStatus, { tone: string; text: string }> = {
	connected: { tone: "success", text: " ● connected" },
	live: { tone: "success", text: " ● live" },
	pending: { tone: "muted", text: " ◌ pending" },
	expiring: { tone: "warning", text: " ◌ expires soon" },
	inactive: { tone: "warning", text: " ◌ inactive" },
};

/**
 * One entry row: the name column, the state tag, the dim note — `/mcp`'s row, as data rather than as a
 * string, so the content can be asserted without a terminal (see `test/extensions/ace-extension.test.ts`).
 *
 * A row without a status is a value rather than a state (a counter, a command's hint); inventing a state for
 * it would be a claim, and there is none to make.
 */
export interface AcePanelRow {
	/** The name column, printed verbatim: an address, a server name, a command. */
	name: string;
	status?: AcePanelStatus;
	/** The dim note after the state: the transport, an address, a description, a counter. */
	note?: string;
}

/** One line of a panel: a group heading, an entry row, or a prose line. */
export type AcePanelLine =
	| { kind: "section"; title: string; note?: string }
	| { kind: "row"; row: AcePanelRow }
	| { kind: "note"; text: string };

/** A read-only panel: what the content builders return and {@link showAcePanel} draws. */
export interface AcePanel {
	title: string;
	/** The muted line under the title: who this session is, or where the listing came from. */
	context?: string;
	lines: readonly AcePanelLine[];
	/** The dim key hint under the panel; `esc close` when a caller has nothing more specific to say. */
	footer?: string;
}

/**
 * Render a panel's lines, themed. Pure: the theme is the only host dependency, so the exact strings a panel
 * shows are testable with an identity theme — the shape `/mcp` uses for a row is
 * `` `  ${accent(name)}${status} ${dim(note)}` ``.
 */
export function renderAcePanelLines(theme: AceTheme, lines: readonly AcePanelLine[]): string[] {
	return lines.map((line) => {
		if (line.kind === "note") return theme.fg("muted", line.text);
		if (line.kind === "section") {
			return theme.fg("accent", line.title) + theme.fg("muted", line.note === undefined ? ":" : ` (${line.note}):`);
		}
		const status = line.row.status === undefined ? "" : renderStatusTag(theme, line.row.status);
		const note = line.row.note === undefined ? "" : ` ${theme.fg("dim", line.row.note)}`;
		return `  ${theme.fg("accent", line.row.name)}${status}${note}`;
	});
}

/** The state tag, coloured: `/mcp`'s shape, leading space included. */
function renderStatusTag(theme: AceTheme, status: AcePanelStatus): string {
	const tag = ACE_PANEL_STATUS[status];
	return theme.fg(tag.tone, tag.text);
}

/** A channel's notes, in the order the printed report uses: what carries it, then what is set on it. */
function channelNotes(endpoint: EndpointConfig, target: string, self: boolean, removed: boolean): string {
	return [
		`[${endpoint.transport}]`,
		endpoint.activation === undefined ? undefined : `[${endpoint.activation}]`,
		endpoint.name === target ? undefined : `as "${endpoint.name}"`,
		self ? "self — peers reply here" : undefined,
		endpoint.description === undefined ? undefined : `"${endpoint.description}"`,
		removed ? "config-removed" : undefined,
	]
		.filter((note) => note !== undefined)
		.join(" · ");
}

/**
 * `/ace list` as a panel: **the same {@link ChannelReport}** `formatChannelReport` prints, in `/mcp`'s row
 * shape. One report object, two renderings — the panel and the printed report cannot disagree about what this
 * session is wired to.
 *
 * The row names are the report's own (`endpoint.channel ?? endpoint.name`, prefixed with the server when
 * several are live) and they are printed **verbatim**: the report shortens a self channel's trailing session
 * id (`…1325bb`) because its rows are prose, while a panel row has a column of its own and the address is
 * what a peer publishes to.
 */
export function channelPanel(report: ChannelReport): AcePanel {
	const removing = new Set(report.configRemoved ?? []);
	const lines: AcePanelLine[] = [];
	if (report.shadowed !== undefined) {
		lines.push({
			kind: "note",
			text: `config: ${report.source ?? "this file"} (project file shadows ${report.shadowed})`,
		});
	}
	const count = report.subscriptions.length;
	lines.push({
		kind: "section",
		title: "subscribe",
		note: count === 0 ? undefined : `${count} channel${count === 1 ? "" : "s"}`,
	});
	if (count === 0) {
		lines.push({
			kind: "note",
			text: `(none) add channels under a server's "subscribe" in .ace.json to read them.`,
		});
	}
	for (const [index, endpoint] of report.subscriptions.entries()) {
		const target = endpoint.channel ?? endpoint.name;
		const server = report.servers?.[index];
		lines.push({
			kind: "row",
			row: {
				name: server === undefined ? target : `${server}:${target}`,
				status: "connected",
				note: channelNotes(endpoint, target, report.selfChannels?.includes(target) === true, removing.has(target)),
			},
		});
	}
	const deadServers = report.unavailableServers ?? [];
	const unavailable = report.unavailableSubscriptions ?? [];
	if (deadServers.length > 0 || unavailable.length > 0) {
		lines.push({ kind: "section", title: "unavailable" });
		for (const entry of deadServers) {
			lines.push({
				kind: "row",
				row: { name: entry.name, status: "inactive", note: `did not come up · ${entry.address}` },
			});
		}
		for (const entry of unavailable) {
			lines.push({
				kind: "row",
				row: { name: entry.channel, status: "inactive", note: `server "${entry.server}" did not come up` },
			});
		}
	}
	const directory = report.deadLetters.directory;
	lines.push({
		kind: "note",
		text: `manual: ${report.pendingManual} pending, dead letters: ${report.deadLetters.count}${
			report.deadLetters.count > 0 && directory !== undefined ? ` at ${directory}` : ""
		}`,
	});
	return {
		title: "ACE channels",
		context: `${report.identity} (agent ${report.agentState})${
			report.source === undefined ? "" : ` — ${report.source}`
		}`,
		lines,
	};
}

/** One live peer on the agent directory: what `/ace agents` prints, as a row both renderings share. */
export interface AgentRow {
	/** The publish-ready target — `ace_publish` accepts exactly this, `<server>:` prefix included. */
	target: string;
	/** The peer's remaining lease, in seconds. */
	renewsIn: number;
	/** The peer's compacted self-description, already JSON-quoted by the caller that reads the entry. */
	description: string;
}

/** `/ace agents`'s input: one set of rows, rendered as a panel in a TUI and as lines everywhere else. */
export interface AgentsPanelInput {
	rows: readonly AgentRow[];
	servers: readonly string[];
	/** This session's own channels, which the directory lists but the rows above exclude. */
	mine: readonly string[];
	filter?: string;
}

/** `/ace agents` as a panel: live sessions, each with the lease it has left. */
export function agentsPanel(input: AgentsPanelInput): AcePanel {
	const lines: AcePanelLine[] = [];
	if (input.rows.length === 0) {
		lines.push({
			kind: "note",
			text:
				input.filter === undefined
					? "no other live sessions"
					: `no live session matches agent filter ${JSON.stringify(input.filter)}`,
		});
	} else {
		for (const row of input.rows) {
			lines.push({
				kind: "row",
				row: {
					name: row.target,
					status: "live",
					note: `renews in ${formatDurationHuman(row.renewsIn)} · ${row.description}`,
				},
			});
		}
		lines.push({ kind: "note", text: `this session: ${input.mine.join(", ")} — not listed` });
	}
	const count = input.rows.length;
	return {
		title: `ACE live agents${count === 0 ? "" : ` (${count})`}`,
		context: `servers: ${input.servers.join(", ")}${
			input.filter === undefined ? "" : ` · filter ${JSON.stringify(input.filter)}`
		}`,
		lines,
	};
}

/** One retained `manual` event: what `/ace pending` prints, as a row both renderings share. */
export interface PendingRow {
	/** The publishing sender, verbatim: it is half of the pair `/ace activate` takes. */
	sender: string;
	/** The event id's tail — a label that tells two retained events apart, never a value to type. */
	idLabel: string;
	/** The publishing session's short id, when the event carried one. */
	sessionLabel?: string;
	/** How long the event has been retained, in seconds, as the report measures it. */
	ageSeconds: number;
	/** The subscription that retained it. */
	subscription: string;
	/** Whether the retention window is closing; the row then warns instead of waiting quietly. */
	expiring: boolean;
	body: string;
}

/** `/ace pending` as a panel: what is waiting, how long it has waited, and how to release it. */
export function pendingPanel(rows: readonly PendingRow[]): AcePanel {
	if (rows.length === 0) {
		return {
			title: "ACE pending manual events",
			lines: [
				{
					kind: "note",
					text:
						'(none) publish to a channel whose activation is "manual" and the event waits here ' +
						"until /ace activate <sender> <id> releases it",
				},
			],
		};
	}
	return {
		title: `ACE pending manual events (${rows.length})`,
		context: "activate with: /ace activate <sender> <id>",
		lines: rows.map((row) => ({
			kind: "row" as const,
			row: {
				name: row.sender,
				status: row.expiring ? "expiring" : "pending",
				note: [
					`id ${row.idLabel}`,
					row.sessionLabel === undefined ? undefined : `session ${row.sessionLabel}`,
					`${formatDurationHuman(row.ageSeconds)} ago`,
					`manual: ${row.subscription}`,
					JSON.stringify(row.body),
				]
					.filter((note) => note !== undefined)
					.join(" · "),
			},
		})),
	};
}

/** A spool window: events held on disk until the session can inject them. */
export interface SpoolRow {
	subscription: string;
	buffered: number;
	path: string;
}

/** `/ace stats`'s panel input: the runtime's own counters, its spool windows, and the transport's state. */
export interface StatsPanelInput {
	/** The runtime's counters, straight from `AceMetrics.snapshot()`. */
	counters: AceMetricsSnapshot;
	windows: readonly SpoolRow[];
	deadLetters: { count: number; directory?: string };
	transport: "ok" | "down";
}

/** `/ace stats` as a panel: the transport's state, one row per channel of counters, and the spool windows. */
export function statsPanel(input: StatsPanelInput): AcePanel {
	const lines: AcePanelLine[] = [
		{
			kind: "row",
			row: { name: "transport", status: input.transport === "ok" ? "connected" : "inactive" },
		},
	];
	const scopes = Object.entries(input.counters);
	if (scopes.length === 0) {
		lines.push({
			kind: "note",
			text:
				"no counters yet — one line per channel appears here as events arrive, counting received, " +
				"injected, deduped, spooled, reclaimed and dropped",
		});
	}
	for (const [scope, counters] of scopes) {
		lines.push({
			kind: "row",
			row: {
				name: scope,
				note: Object.entries(counters)
					.map(([name, value]) => `${name}=${value}`)
					.join(" "),
			},
		});
	}
	if (input.windows.length > 0) {
		lines.push({ kind: "section", title: "spooling" });
		for (const window of input.windows) {
			lines.push({
				kind: "row",
				row: {
					name: window.subscription,
					status: "pending",
					note: `${window.buffered} buffered · ${window.path}`,
				},
			});
		}
	}
	const directory = input.deadLetters.directory;
	return {
		title: "ACE stats",
		context: `dead letters: ${input.deadLetters.count}${
			input.deadLetters.count > 0 && directory !== undefined ? ` → ${directory}` : ""
		}`,
		lines,
	};
}

/** `/ace help` as a panel: the command list, one accent entry per row. */
export function helpPanel(commands: readonly { name: string; description: string }[]): AcePanel {
	return {
		title: "ACE commands",
		context: "usage: /ace (no argument opens the channel manager), /ace <command> [<argument>]",
		lines: commands.map((command) => ({
			kind: "row" as const,
			row: { name: `/ace ${command.name}`, note: command.description },
		})),
	};
}

/** What the manager view draws: a framed title, optional header lines, and one row per channel. */
export interface ChannelMenu {
	title: string;
	details?: string;
	items: SelectItem[];
	empty?: string;
}

/**
 * One row per channel: what this session reads.
 *
 * Each row is the same shape as a panel row — an accent name, a coloured state tag, dim notes — which is why
 * the theme is a parameter. `SelectList` takes `label` verbatim but lays it out in a fixed-width column it
 * truncates (`DEFAULT_PRIMARY_COLUMN_WIDTH`, 32), so the tag goes at the head of the description column,
 * where it is never the part that gets cut. Both strings pass through ANSI-aware helpers
 * (`visibleWidth`, `truncateToWidth`).
 */
export function channelMenuItems(input: {
	subscriptions: readonly EndpointConfig[];
	selfChannels?: readonly string[];
	theme: AceTheme;
}): SelectItem[] {
	const { theme } = input;
	const row = (endpoint: EndpointConfig): SelectItem => {
		const address = endpointAddressOf(endpoint);
		// The channel name is the address a peer publishes to; the local label is a note when it differs.
		const target = endpoint.channel ?? endpoint.name;
		const notes = [
			`[${endpoint.transport}]`,
			address,
			endpoint.activation === undefined ? undefined : `[${endpoint.activation}]`,
			endpoint.name === target ? undefined : `as "${endpoint.name}"`,
			input.selfChannels?.includes(target) === true ? "self — peers reply here" : undefined,
			endpoint.description === undefined ? undefined : `"${endpoint.description}"`,
		].filter((note) => note !== undefined);
		return {
			value: `${ROW_TARGET_PREFIX}${target}`,
			label: theme.fg("accent", target),
			description: `${renderStatusTag(theme, "connected")} ${theme.fg("dim", notes.join(" · "))}`,
		};
	};
	return input.subscriptions.map(row);
}

/** The address a channel carries, without importing the runtime just for one field. */
function endpointAddressOf(endpoint: EndpointConfig): string | undefined {
	const address = endpoint.config.stream ?? endpoint.config.subject ?? endpoint.config.topic ?? endpoint.config.queue;
	return typeof address === "string" ? address : undefined;
}

/** The prefix a manager row's `value` carries: the direction, then the channel the row addresses. */
const ROW_TARGET_PREFIX = "in:";

/**
 * The channel a manager row's `value` names, or `undefined` when the value is not one of this session's
 * channels.
 *
 * Two traps, and every row fell into one of them: the value addresses the **channel** — the publishable name a
 * peer writes to — which is *not* the row's local label when the two differ (`as "<label>"` marks exactly
 * that), and a channel name carries colons of its own (`ace:ana:from-wsl`), so only the `in:` prefix is
 * stripped. Looking the row up by its label, or splitting the value on every colon (which reads the name as
 * `ace`), leaves `enter` on an aliased row with no detail view and no message.
 */
export function channelForMenuValue(
	subscriptions: readonly EndpointConfig[],
	value: string,
): EndpointConfig | undefined {
	if (!value.startsWith(ROW_TARGET_PREFIX)) return undefined;
	const target = value.slice(ROW_TARGET_PREFIX.length);
	return subscriptions.find((candidate) => (candidate.channel ?? candidate.name) === target);
}

/** A full-width rule, the border `/mcp` draws with its internal `DynamicBorder`. */
class Rule implements Component {
	private readonly theme: AceTheme;

	constructor(theme: AceTheme) {
		this.theme = theme;
	}

	render(width: number): string[] {
		return [this.theme.fg("accent", "─".repeat(Math.max(0, width)))];
	}

	invalidate(): void {}
}

/** The view itself: it swaps between the list and a channel's details, both inside the same frame. */
class AceManagerComponent implements Component {
	private readonly tui: AceTui;
	private readonly theme: AceTheme;
	private content: Component;
	private inputHandler?: (data: string) => void;

	constructor(tui: AceTui, theme: AceTheme) {
		this.tui = tui;
		this.theme = theme;
		this.content = new Text("", 0, 0);
	}

	setContent(content: Component, inputHandler?: (data: string) => void): void {
		this.content = content;
		this.inputHandler = inputHandler;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		this.inputHandler?.(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.content
			.render(width)
			.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
	}

	invalidate(): void {
		this.content.invalidate();
	}

	/** The frame, the way `/mcp` builds it: rule, title, body, dim footer hint, rule. */
	frame(title: string, body: Component[], footer: string): Container {
		const container = new Container();
		container.addChild(new Rule(this.theme));
		container.addChild(new Text(this.theme.fg("accent", this.theme.bold(title)), 1, 0));
		for (const child of body) container.addChild(child);
		container.addChild(new Spacer(1));
		container.addChild(new Text(this.theme.fg("dim", footer), 1, 0));
		container.addChild(new Rule(this.theme));
		return container;
	}

	selectListTheme(): SelectListTheme {
		return {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.bold(text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("muted", text),
		};
	}
}

/** What the manager's detail view draws when a row is confirmed: a title and the channel's fields. */
export interface ChannelDetails {
	title: string;
	lines: readonly string[];
}

/**
 * Show `/ace`'s manager until the user closes it. Falls back to nothing when the host has no interactive
 * component surface, so the caller can print its text report instead.
 */
export async function showAceManager(
	ctx: ExtensionCommandContext,
	build: (theme: AceTheme) => ChannelMenu,
	/** Details shown when a row is confirmed; `undefined` keeps the list read-only. */
	describe?: (value: string) => ChannelDetails | undefined,
): Promise<void> {
	await ctx.ui.custom((tui, theme, keybindings, done) => {
		const view = new AceManagerComponent(tui, theme);
		const bindings = keybindings as AceKeybindings;

		const showList = (): void => {
			const menu = build(theme);
			const body: Component[] = [];
			if (menu.details !== undefined) body.push(new Text(theme.fg("muted", menu.details), 1, 0));
			body.push(new Spacer(1));
			if (menu.items.length === 0) {
				body.push(new Text(theme.fg("muted", menu.empty ?? "Nothing to show."), 1, 0));
				view.setContent(view.frame(menu.title, body, "esc close"), (data) => {
					if (bindings.matches(data, "tui.select.cancel")) done(undefined);
				});
				return;
			}
			const list = new SelectList(menu.items, Math.min(menu.items.length, 12), view.selectListTheme());
			list.onSelect = (item) => {
				const details = describe?.(item.value);
				if (details === undefined) return;
				// The title is the caller's own plain text: the row's label is styled for the terminal, so it is
				// not a title.
				view.setContent(
					view.frame(details.title, [new Text(details.lines.join("\n"), 1, 0)], "esc back"),
					(data) => {
						if (bindings.matches(data, "tui.select.cancel")) showList();
					},
				);
			};
			list.onCancel = () => done(undefined);
			body.push(list);
			view.setContent(view.frame(menu.title, body, "↑↓ select · enter details · esc close"), (data) =>
				list.handleInput(data),
			);
		};

		showList();
		return view;
	});
}

/**
 * Show a read-only ACE panel until the user closes it, and report whether it was shown.
 *
 * `false` means "this host cannot draw one, print the report instead": either the mode is not `tui` (measured
 * above) or the host has no `ctx.ui.custom`. A failure throws, so the caller decides; the `false` path never
 * swallows a report.
 */
export async function showAcePanel(ctx: ExtensionCommandContext, panel: AcePanel): Promise<boolean> {
	if (typeof ctx.ui.custom !== "function") return false;
	await ctx.ui.custom((tui, theme, keybindings, done) => {
		const view = new AceManagerComponent(tui, theme);
		const body: Component[] = [];
		if (panel.context !== undefined) {
			body.push(new Text(theme.fg("muted", panel.context), 1, 0));
			body.push(new Spacer(1));
		}
		body.push(new Text(renderAcePanelLines(theme, panel.lines).join("\n"), 1, 0));
		view.setContent(view.frame(panel.title, body, panel.footer ?? "esc close"), (data) => {
			if ((keybindings as AceKeybindings).matches(data, "tui.select.cancel")) done(undefined);
		});
		return view;
	});
	return true;
}
