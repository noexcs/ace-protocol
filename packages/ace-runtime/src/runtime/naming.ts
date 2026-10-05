/**
 * 全名约定的实现：**Namespace > Username > 主体**（见 `runtime-contracts.ts` §三）。
 *
 * ```
 * <server>:<ns>:<username>:<name>     ← 本地全名（多 server 时用；第一段只在本地区分）
 *         <ns>:<username>:<name>      ← 上传 / 存储名（server 段不在这里）
 * ```
 *
 * 前三段不含冒号、最后一段允许冒号，所以"按固定段数切开、余下全是名字"是无歧义的。
 * 这个模块是这套约定的唯一实现处：键名、member 名、频道名都从这里派生，宿主与工具都不再自己拼。
 */

/** 命名空间默认值。 */
export const NAMESPACE_DEFAULT = "ace";

/** 冒号：段的边界，也是禁止出现在前三段里的字符。 */
const SEGMENT_SEPARATOR = ":";

/** `agents` / `entry` / `events` / `ch` 这几个键段，是命名空间私有词汇，别处不要硬编码。 */
export const NAMESPACE_KEYS = {
	members: "agents",
	entry: "entry",
	events: "events",
	channels: "ch",
} as const;

/** 一台 server 的命名空间解析：缺省即 {@link NAMESPACE_DEFAULT}。 */
export function namespaceOf(descriptor: { namespace?: string }): string {
	return descriptor.namespace ?? NAMESPACE_DEFAULT;
}

/** 校验一段"不许含冒号"的值（server name / namespace / username）。 */
export function assertNoColon(value: string, label: string): void {
	if (value.length === 0) throw new Error(`${label} must not be empty`);
	if (value.includes(SEGMENT_SEPARATOR)) {
		throw new Error(`${label} must not contain "${SEGMENT_SEPARATOR}" (it separates the name segments)`);
	}
}

/** 上传形式的频道名：`<ns>:<username>:<name>`。 */
export function channelName(namespace: string, username: string, name: string): string {
	return [namespace, username, name].join(SEGMENT_SEPARATOR);
}

/** 上传形式的成员名：`<ns>:<username>:<codingAgent>:<sessionId>`。 */
export function memberName(options: {
	namespace: string;
	username: string;
	codingAgent: string;
	sessionId: string;
}): string {
	const { namespace, username, codingAgent, sessionId } = options;
	return [namespace, username, codingAgent, sessionId].join(SEGMENT_SEPARATOR);
}

/** 本地展示用的全名：多 server 时加 `<server>:` 前缀，单 server 时不加。 */
export function localName(server: string | undefined, uploaded: string): string {
	return server === undefined ? uploaded : `${server}${SEGMENT_SEPARATOR}${uploaded}`;
}

/**
 * 短名补全：把 `ci-failures` 变成 `<ns>:<username>:ci-failures`。
 *
 * 已经带够段数的名字原样返回（本地全名或上传形式都接受）；只有一段的名字才补全。
 * 判定方式是**数冒号**，不是猜内容 —— 前三段不许含冒号，所以段数就是结构。
 */
export function resolveLocalName(options: { namespace: string; username: string; name: string }): string {
	const segments = options.name.split(SEGMENT_SEPARATOR);
	if (segments.length >= 3) return options.name;
	return channelName(options.namespace, options.username, options.name);
}

/** 频道流键：`<ns>:ch:<上传名>`。 */
export function channelStreamKey(namespace: string, uploaded: string): string {
	return [namespace, NAMESPACE_KEYS.channels, uploaded].join(SEGMENT_SEPARATOR);
}

/** 会话收件箱流键：`<ns>:events:<member>`。 */
export function eventsStreamKey(namespace: string, member: string): string {
	return [namespace, NAMESPACE_KEYS.events, member].join(SEGMENT_SEPARATOR);
}

/** 成员目录键（ZSet）。 */
export function membersKey(namespace: string): string {
	return [namespace, NAMESPACE_KEYS.members].join(SEGMENT_SEPARATOR);
}

/** 成员条目键（Hash）。 */
export function entryKey(namespace: string): string {
	return [namespace, NAMESPACE_KEYS.entry].join(SEGMENT_SEPARATOR);
}

/**
 * 从上传名里取出 username（第二段）。用于把别人的频道归到某个人名下做展示，
 * 不用于鉴权 —— 名字是自称，同 server 的凭据域才是边界。
 */
export function usernameOf(uploaded: string): string | undefined {
	const segments = uploaded.split(SEGMENT_SEPARATOR);
	return segments.length >= 2 ? segments[1] : undefined;
}
