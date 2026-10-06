/**
 * 全名约定的实现：**Namespace > Username > 主体**（见 `runtime-contracts.ts` §三）。
 *
 * ```
 * <server>:<ns>:<username>:<name>     ← 本地全名（多 server 时用；第一段只在本地区分）
 *         <ns>:<username>:<name>      ← 上传 / 存储名（server 段不在这里）
 * ```
 *
 * 前三段不含冒号、最后一段允许冒号，所以"按固定段数切开、余下全是名字"是无歧义的。
 * 这个模块是这套约定的唯一实现处：键名、sender 名、频道名都从这里派生，宿主与工具都不再自己拼。
 *
 * **只有一个名字空间：channel** ✓。一个在线 participant 的收件箱，就是**以它自己的 sender 名命名的
 * channel**（随会话自动注册、自动回收）✓ —— 所以没有单独的 "member" 概念：直投对方，就是往那个
 * channel 发；目录，就是这些自动 channel 的索引。
 */
/** 命名空间默认值。 */
export const NAMESPACE_DEFAULT = "ace";
/**
 * 本地订阅名：本会话读自己那条收件箱 channel 时用的**本地标签**（不上传、不参与寻址）。
 * 收件箱 channel 的名字是会话的 sender 名；这个名字只是配置/工具里对它的称呼。
 */
export const SESSION_INBOX = "session-inbox";
/** What a sender says for its session when the host gave it no session id. */
export const NO_SESSION_LABEL = "(no session)";
/** 冒号：段的边界，也是禁止出现在前三段里的字符。 */
const SEGMENT_SEPARATOR = ":";
/** 命名空间私有的键段，别处不要硬编码。 */
export const NAMESPACE_KEYS = {
    /** 在线 participant 目录（ZSet）。 */
    directory: "agents",
    /** 目录条目（Hash）。 */
    entry: "entry",
    /** 频道流。 */
    channels: "ch",
};
/** 一台 server 的命名空间解析：缺省即 {@link NAMESPACE_DEFAULT}。 */
export function namespaceOf(descriptor) {
    return descriptor.namespace ?? NAMESPACE_DEFAULT;
}
/** 校验一段"不许含冒号"的值（server name / namespace / username）。 */
export function assertNoColon(value, label) {
    if (value.length === 0)
        throw new Error(`${label} must not be empty`);
    if (value.includes(SEGMENT_SEPARATOR)) {
        throw new Error(`${label} must not contain "${SEGMENT_SEPARATOR}" (it separates the name segments)`);
    }
}
/** 上传形式的频道名：`<ns>:<username>:<name>`。 */
export function channelName(namespace, username, name) {
    return [namespace, username, name].join(SEGMENT_SEPARATOR);
}
/**
 * 一个会话的 **sender 名**，也就是它自动注册的那条收件箱 channel 的名字：
 * `<ns>:<username>:<codingAgent>:<sessionId>`。
 */
export function senderName(options) {
    const { namespace, username, codingAgent, sessionId } = options;
    return [namespace, username, codingAgent, sessionId].join(SEGMENT_SEPARATOR);
}
/** 本地展示用的全名：多 server 时加 `<server>:` 前缀，单 server 时不加。 */
export function localName(server, uploaded) {
    return server === undefined ? uploaded : `${server}${SEGMENT_SEPARATOR}${uploaded}`;
}
/**
 * 短名补全：把 `ci-failures` 变成 `<ns>:<username>:ci-failures`。
 *
 * 已经带够段数的名字原样返回（本地全名或上传形式都接受）；只有一段的名字才补全。
 * 判定方式是**数冒号**，不是猜内容 —— 前三段不许含冒号，所以段数就是结构。
 */
export function resolveLocalName(options) {
    const segments = options.name.split(SEGMENT_SEPARATOR);
    if (segments.length >= 3)
        return options.name;
    return channelName(options.namespace, options.username, options.name);
}
/** 频道流键：`<ns>:ch:<上传名>`。收件箱也是 channel，所以走同一条键路 ✓。 */
export function channelStreamKey(namespace, uploaded) {
    return [namespace, NAMESPACE_KEYS.channels, uploaded].join(SEGMENT_SEPARATOR);
}
/** 在线 participant 目录键（ZSet）。 */
export function directoryKey(namespace) {
    return [namespace, NAMESPACE_KEYS.directory].join(SEGMENT_SEPARATOR);
}
/** 目录条目键（Hash）。 */
export function directoryEntryKey(namespace) {
    return [namespace, NAMESPACE_KEYS.entry].join(SEGMENT_SEPARATOR);
}
/**
 * 从上传名里取出 username（第二段）。用于展示，**不用于鉴权** —— 名字是自称，
 * 同 server 的凭据域才是边界。
 */
export function usernameOf(uploaded) {
    const segments = uploaded.split(SEGMENT_SEPARATOR);
    return segments.length >= 2 ? segments[1] : undefined;
}
//# sourceMappingURL=naming.js.map