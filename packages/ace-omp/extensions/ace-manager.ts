/**
 * The `/ace` manager view: a framed list of this session's channels, the shape the built-in `/mcp` manager
 * uses (title frame, selectable list, key hints in the footer). Selecting a channel shows what it is wired
 * to; nothing mutates — ACE keeps no channel policy, so there is nothing to act on.
 *
 * Only public APIs are used here: `ctx.ui.custom` plus `@earendil-works/pi-tui` primitives. The frame, the
 * rules and the key hints that `/mcp` borrows from internal modules are drawn locally.
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
import type { EndpointConfig } from "../vendor/ace-runtime/dist/index.js";

/** The slice of the host theme the view uses; structurally what `ctx.ui.custom` hands to the factory. */
interface AceTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** The slice of the host TUI the view uses. */
interface AceTui {
	requestRender(): void;
}

/** The slice of the host keybindings the view uses. */
interface AceKeybindings {
	matches(data: string, binding: string): boolean;
}

/** What the view draws: a framed title, optional header lines, and one row per channel. */
export interface ChannelMenu {
	title: string;
	details?: string;
	items: SelectItem[];
	empty?: string;
}

/** One row per channel: what this session reads. */
export function channelMenuItems(input: {
	subscriptions: readonly EndpointConfig[];
	selfChannels?: readonly string[];
}): SelectItem[] {
	const row = (endpoint: EndpointConfig): SelectItem => {
		const address = endpointAddressOf(endpoint);
		// The channel name is the address a peer publishes to; the local label is a note when it differs.
		const target = endpoint.channel ?? endpoint.name;
		const parts = [
			`${endpoint.transport}${address === undefined ? "" : ` ${address}`}`,
			"[in]",
			endpoint.activation === undefined ? undefined : `[${endpoint.activation}]`,
			endpoint.name === target ? undefined : `(as "${endpoint.name}")`,
			input.selfChannels?.includes(target) === true ? "(self — peers reply here)" : undefined,
			endpoint.description === undefined ? undefined : `"${endpoint.description}"`,
		];
		return {
			value: `${ROW_TARGET_PREFIX}${target}`,
			label: `● ${target}`,
			description: parts.filter((part) => part !== undefined).join(" · "),
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
 * peer writes to — which is *not* the row's local label when the two differ (`(as "<label>")` marks exactly
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

	/** The frame, the way `/mcp` builds it: rule, title, body, dim footer, rule. */
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

/**
 * Show `/ace`'s manager until the user closes it. Falls back to nothing when the host has no interactive
 * component surface, so the caller can print its text report instead.
 */
export async function showAceManager(
	ctx: ExtensionCommandContext,
	build: () => ChannelMenu,
	/** Details shown when a row is confirmed; `undefined` keeps the list read-only. */
	describe?: (value: string) => string[] | undefined,
): Promise<void> {
	await ctx.ui.custom((tui, theme, keybindings, done) => {
		const view = new AceManagerComponent(tui, theme);
		const bindings = keybindings as AceKeybindings;

		const showList = (): void => {
			const menu = build();
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
				view.setContent(
					view.frame(item.label.replace(/^● /, ""), [new Text(details.join("\n"), 1, 0)], "esc back"),
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
