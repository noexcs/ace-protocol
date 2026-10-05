# ace-runtime 导出面摘要（宿主接线只需这一页）

**对应今天的形状**：`transport` / `config` / `EndpointConfig`。`docs/ace-plan.md` 里的
`Broker` / `dispatch` / `consume` 是**目标形状，尚未实施** —— 接线时别混用。
来源：`packages/ace-runtime/src/**`（2026-10-05 现状）。改 runtime 时请同步本页。
形状与术语以 [`ace-runtime-contracts.md`](ace-runtime-contracts.md) 为准；本页只是导出面速查。

一句话形状：**一条 channel 的名字就是它的地址**。一个会话的 sender 名
（`<ns>:<username>:<coding-agent>:<sessionId>`）就是它自动注册的收件箱 channel；stream key 与消费组
都从名字派生，宿主与工具都不自己拼字符串（生成处只有 `src/runtime/naming.ts`）。

## 1. 传输接缝

```ts
export type RawAceMessageHandler = (raw: unknown) => Promise<void>;

/** 传输只搬原始消息；ACE 才做校验。MQ 元数据（stream/group/offset）不出适配器。 */
export interface Transport {
	start(handler: RawAceMessageHandler): Promise<void>;
	stop(): Promise<void>;
}

export interface TransportFactoryOptions {
	onError: (error: unknown) => void;
	metrics?: AceMetrics;
	/** 达到 reclaimAttempts 上限、被传输放弃的条目（宿主接到死信 sink）。 */
	onDropped?: (subscription: string, entry: DroppedEntry) => void | Promise<void>;
}

/** 每个订阅建一个 transport，**按订阅名**作键 —— 这正是 AceRuntime 期望的键。 */
export function createTransports(
	subscriptions: readonly EndpointConfig[],
	options: TransportFactoryOptions,
): Record<string, Transport>;
```

没有 `SUPPORTED_TRANSPORTS` 这类常量：`createTransports` 目前只造 `redis-streams`；
测试与示例直接 `new InMemoryTransport()`。Redis 订阅在 `config` 里认这组键
（`REDIS_STREAMS_SUBSCRIPTION_KEYS`）：`stream` / `group` / `url` / `consumer` / `field` /
`count` / `blockMs` / `reclaimIdleMs` / `reclaimAttempts` / `retryDelayMs` / `maxRetryDelayMs`，
缺省见 `REDIS_STREAMS_DEFAULTS`（`field=message` 等）。

现成实现：`redis-streams-transport.ts`（真 broker）、`in-memory-transport.ts`（测试）。

## 2. AceRuntime

```ts
export interface AceRuntimeOptions {
	engine: AgentEngine;
	subscribe: readonly EndpointConfig[];
	/** 键 = **订阅名**；AceRuntime 会校验每个订阅都有对应 transport（缺一个就抛，重复用同一个也抛） */
	transports: Readonly<Record<string, Transport>>;
	defaultActivation?: ConcreteActivation;   // 缺省 next_turn
	/** 本会话自己的 sender 名（每台 server 一个）：命中即"自己发的事件又被自己读到"，注入块标 `self: yes` */
	selfSenders?: readonly string[];
	logger?: AceLogger; metrics?: AceMetrics;
	dedupCapacity?: number;                   // 默认 1024，(sender,id) 去重窗口，每订阅一份
	manual?: { max?: number; ttlMs?: number }; // 缺省 100 / 24h
	/** 突发落盘：只传目录与可选项；阈值取内置 DEFAULT_SPOOL_RULE，除非给 rule 覆盖 */
	spool?: Omit<EventSpoolOptions, "onBatch" | "onError" | "logger" | "rules"> & { rule?: SpoolRule };
	now?: () => number;
}

/** DispatchResult 就是 { activation, disposition }；disposition = injected|queued|stored|deduped|spooled|dropped */
export interface AceHandleResult extends DispatchResult {
	readonly subscriptionName: string;
}
```

```ts
export class AceRuntime {
	readonly metrics: AceMetrics;
	constructor(options: AceRuntimeOptions);
	start(): Promise<void>;                       // 逐订阅 transport.start；缺 transport 在构造时就抛
	stop(): Promise<void>;                        // 停 transport → flush spool → engine.waitForIdle()
	handleRawMessage(raw: unknown, subscription: EndpointConfig): Promise<AceHandleResult>;
	handleMessage(raw: unknown, subscriptionName: string): Promise<AceHandleResult>;
	get pendingEvents(): ReturnType<PendingEventStore["list"]>;
	activatePendingEvent(sender: string, id: string): Promise<void>;   // 取出 manual 事件，以 next_turn 注入
	recordRunFailure(error: unknown): void;       // 引擎事后报告的回合失败，计到 runtime 作用域
	openSpoolWindows(): Array<{ subscription: string; buffered: number; path: string }>;
}
```

配套的实现（同一导出面）：

```ts
export const DEFAULT_SPOOL_RULE: SpoolRule = { afterEvents: 20, windowMs: 1000 };
export class EventSpool { /* 突发落盘 + manual 事件的跨会话持久化；offer/flush/openWindows/… */ }

export class DeadLetterSink {
	constructor(options: DeadLetterSinkOptions);   // { dir, retentionMs?=24h, maxFiles?=50, now?, logger?, onError? }
	record(subscription: string, entry: DroppedEntry): Promise<void>;  // 写失败会抛出，调用方据此不 XACK
	get count(): number;                           // 本运行时写下的条数
	get directory(): string;
}

export class AceMetrics {
	increment(scope: string, counter: AceCounter, amount = 1): void;  // scope = channel 名或 "runtime"
	snapshot(): AceMetricsSnapshot;
	render(): string[];
}
```

## 3. 配置（`.ace.json`）

```ts
export const ACE_CONFIG_FILENAME = ".ace.json";
export function loadAceConfig(options: {
	cwd: string;
	env?: Readonly<Record<string, string | undefined>>;
	/** 宿主自己的全局候选，按宿主给定的顺序；$ACE_CONFIG 与 <cwd>/.ace.json 排前面 */
	globalConfigPaths?: readonly string[];
}): LoadedAceConfig | undefined;
export function resolveAceConfig(options: { /* 同上 */ }): ResolvedAceConfig;
export function interpolateEnv(value: unknown, env, source: string, path?): unknown;  // ${VAR}；未设置即报错

export interface LoadedAceConfig {
	source: string;
	config: AceConfigFile;
	shadowed?: string;             // 被本文件压过的后一个候选，给 warning
	usernameFallback?: string;     // 本文件没写 username 时，全局文件提供的那个
}
```

```ts
/** 一条绑定的合法键（未知键会被拒）——由订阅派生，不写进 .ace.json */
// name, transport, description, activation（仅订阅）, enabled, config, options
export interface EndpointConfig { /* 上述键 */ }

/** `.ace.json` 的顶层键集；未知键一律报错 */
export interface AceConfigFile {
	/** 命名层级第二段（`<ns>:<username>:<name>`）；不含冒号。文件里可省，解析时按 文件→全局→$USER 继承 */
	username: string;
	/** 非空；`{ "<name>": { url, namespace?, description?, subscribe? } }`，名字与 namespace 不含冒号 */
	servers: Record<string, ServerEntry>;
	defaultActivation?: ConcreteActivation;   // immediate | next_turn | manual
	manual?: { max?: number; ttlMs?: number }; // 默认 100 / 24h
	projectConfig?: "ignore";                  // 只在全局文件里有意义：压过项目文件
}

export interface ServerEntry {
	url: string;
	namespace?: string;
	description?: string;
	/** 该 server 上本会话订阅的 channel 名；数组内不得重复。缺省 = 只收直投 */
	subscribe?: string[];
}

export interface ResolvedServer {
	name: string;
	url: string;
	namespace: string;
	description?: string;
	subscribe?: string[];
}

/** 配置层只有名字：地址、组、transport 设置都由 subscriptionEndpoint 派生 */
export interface ResolvedSubscription {
	server: ResolvedServer;
	channel: string;   // 上传形式的 channel 名（`<ns>:<username>:<name>`）
	name: string;      // 本地订阅标签（等于 channel 名，除非宿主改名）
}

export interface ResolvedAceConfig {
	username: string;
	servers: ResolvedServer[];
	subscriptions: ResolvedSubscription[];
	defaultActivation?: ConcreteActivation;
	manual: { max?: number; ttlMs?: number };
	warnings: string[];
	source: string;
}
```

`.ace.json` 顶层**没有** `sender` / `publish` / `registry` / `disabled`，也没有
transport/stream/group/config/options —— 频道与订阅关系全部从名字派生，见 §5。
`docs/ace-plan.md` 里的 `registry: { url, prefix? }` 是旧形状，别照抄。

订阅的解析与派生：`resolveAceConfig` 逐 server 把它配置的 `subscribe` 名字补全为
`(server, channel)`（短名按**该 server** 的 namespace 补成 `<ns>:<username>:<name>`，段数 ≥ 3 的全名原样透传），
每台 server 各用它的 namespace，不跨 server 猜测。

```ts
/** 订阅的地址与消费组都从 channel 名派生，对端算出来的必与此一致 */
export function subscriptionEndpoint(options: {
	channel: string;
	url: string;
	namespace: string;
	sender: string;                 // 订阅方会话的 sender 名 —— 组就等于它
	name?: string;                  // 缺省 = channel
	activation?: ConcreteActivation;
	description?: string;
}): EndpointConfig;
// → { name, transport: "redis-streams",
//     config: { stream: channelStreamKey(ns, channel), group: sender, url, field: "message" } }
```

## 4. 注册中心（agent directory）

目录里只有**一种东西：channel** —— 一个在线会话的收件箱，就是以它自己的 sender 名命名的那条
channel（随会话自动注册、自动回收）。**没有 `member` 概念**，也没有地址字段：地址由名字派生。

```ts
export interface AgentRegistryStore {          // 7 个方法；测试用内存实现即可
	ensureStream(stream: string, group: string): Promise<void>;  // 幂等；组不存在就 MKSTREAM 建
	put(channel: string, description: string, expiresAt: number): Promise<void>;
	refresh(channel: string, expiresAt: number): Promise<void>;
	remove(channel: string): Promise<void>;
	dropStream(stream: string): Promise<void>;   // 会话关闭后，没人能再往它发
	list(now: number): Promise<RegistryEntry[]>; // 顺带剪掉过期条目
	close(): Promise<void>;
}

export interface AgentRegistryOptions {
	store: AgentRegistryStore;
	namespace?: string;                  // 缺省 "ace"；键都挂在它下面（无 prefix）
	ttlMs?: number; refreshMs?: number;  // 见 REGISTRY_DEFAULTS（90s / 30s；refreshMs=0 关心跳）
	now?: () => number;
	setTimer?: (cb: () => void, ms: number) => { cancel: () => void };  // ← 本包既有的可注入缝
	logger?: AceLogger;
	onError?: (error: unknown) => void;  // 注册中心问题绝不能让会话挂掉
}

export interface AgentRegistration {
	sender: string;                      // 本会话的 sender 名 = 它注册的 channel（宿主算出后交给它）
	codingAgent: string;                 // "oh-my-pi" | "pi" | "codex"
	agentVersion?: string;
	sessionId: string;                   // 只进自述文本（尾 6 位）
	cwd: string;
}

/** register 的产物；group 就等于 channel，stream = channelStreamKey(ns, channel) */
export interface Registration { channel: string; stream: string; group: string }

/** list() 的一行：channel 名、它自述的文本、ZSet 分数（过期时刻）。没有地址字段 */
export interface RegistryEntry { channel: string; description: string; expiresAt: number }

export class AgentRegistry {
	constructor(options: AgentRegistryOptions);
	/** register = ensureStream(channel 的流, group=channel) → put → 起心跳 timer；返回 Registration */
	register(registration: AgentRegistration): Promise<Registration>;
	/** unregister = 停 timer → remove(channel) → dropStream(自己的流) */
	unregister(): Promise<void>;
	list(): Promise<RegistryEntry[]>;    // 读路径顺带清扫过期
	close(): Promise<void>;
}

export const REGISTRY_DEFAULTS = { ttlMs: 90_000, refreshMs: 30_000 } as const;

export function createRedisAgentRegistry(options: {
	url: string;
	namespace?: string;                  // 缺省 "ace"
	clientOptions?: Record<string, unknown>;  // 原样交给 redis 包，不校验
	onError?: (error: unknown) => void;
}): AgentRegistryStore;
```

Redis 键全部来自 `naming.ts`（见 §5）：`directoryKey(ns)` = `<ns>:agents`（ZSet，member = channel 名，
score = `expiresAt`）、`directoryEntryKey(ns)` = `<ns>:entry`（Hash，field = channel）、
`channelStreamKey(ns, channel)` = `<ns>:ch:<channel>`。

## 5. 发现与寻址

```ts
export function resolveTarget(entries: readonly RegistryEntry[], target: string): TargetResolution;
export type TargetResolution =
	| { ok: true; entry: RegistryEntry }
	| { ok: false; reason: "not-found" | "ambiguous"; candidates: string[] };
// target = 精确 channel 名，或只匹配到一个的前缀；不猜（多个候选直接返回 ambiguous + candidates）
export function codingAgentOf(entry: RegistryEntry): string | undefined;
// 条目自述里 `agent=` 的**首个 token**（如 oh-my-pi，版本后缀不算）：ace_agents 的 `agent` 过滤用它，
// 精确匹配；它不是 channel 名前缀（channel 名只在第三段带 coding agent，多 server 时前面还有 `<server>:`）。

// tools/publish.ts —— ace_publish 的入参校验与 target 解析，各宿主共用同一实现
export function rejectUnknownArguments(tool: string, params: unknown, known: readonly string[]): void;
// 工具不认识的参数键 → 失败并点名（工具参数表见 spec.ts 的 `TOOL_ARGUMENTS`，与 schema 放在一起）
export function validatePublishInput(
	params: Record<string, unknown>,
	options?: { servers?: readonly string[] },   // 已配置 server 名：发送前拒绝 `<server>:` + 2 段残余要用
): {
	body: string;
	activation?: Activation;   // 省略 → 宿主发 next_turn；四个值之外点名拒绝
	targets: string[];   // 顺序保留、精确重复保留（去重发生在解析之后）
};
// 名字先 trim（首尾空白直接接受），再拒绝**名字内部**含空白或控制字符、或含空段（`ace::foo`）的名字并点名该值；
// **`<server>:` 前缀 + 2 段残余**（`second:noexcs:remote`）也在这里、发送前按用法错误拒绝，点名 server 与残余——
// `resolveChannelTarget` 里的同名检查保留为兜底，宿主路径不会再把它降级成 `status=failed` 行；
// `activation` 同样在这里校验（parameter schema 不再声明 enum，否则宿主会用自己的措辞拒绝并回显整份工具文档）；
// body/channel/activation 以及 agents 的 agent/limit 的 parameter schema 不声明类型，正是为了不让宿主把数字/对象改写成本来看起来合法的值
export function validateAgentsInput(params: Record<string, unknown>): { agent?: string; limit: number };
// tools/agents.ts —— ace_agents 的入参校验：agent 必须是字符串、limit 必须是整数（`true`/`"5"` 报错并点名该值）；
// agent 先 trim，空串/纯空白视为没有过滤（目录整体列出，不退化成像空目录的 count=0）；limit 保留 1..50 的钳制
export interface TargetServer { server: ResolvedServer; sender: string; list(): Promise<RegistryEntry[]>; }
export interface ResolvedChannelTarget { server: ResolvedServer; channel: string; sender: string; }
export async function resolveChannelTarget(options: {
	name: string;
	active: readonly TargetServer[];
	configured: readonly ResolvedServer[];   // .ace.json 里的全部 server（含没起来的）
	username: string;
}): Promise<ResolvedChannelTarget>;
// `<server>:` 前缀按**已配置 server 名**匹配（含未上线 → serverNotUp，不再当短名补全）；前缀之后
// 只接受 1 段（补全）或 ≥3 段（原样），**2 段残余报 ambiguousServerRemainder**（它既像含冒号的本地名、
// 又像漏了 namespace 的全名，任选一种都会写出一条没人能读的 channel）；
// 未加前缀的 ≥3 段是全名、首段是 namespace，只有它的 owner 能存（owner 没起来 → namespaceNotUp；无人拥有 → namespaceUnclaimed）；
// 1–2 段是短名（单台在线 server 直接用它；首段不是已配置 server 名就不是前缀）；其余查目录。见 contracts §4.1。
```

条目里没有地址可读：发布端拿到 channel 名后，自己用 `channelStreamKey(ns, channel)` 算 stream key
（`<ns>:ch:<channel>`），用与接收端相同的派生保证两边一致。

文件传输（核心 `tools/xfer.ts` + 宿主面 `tools/xfer-files.ts`；契约见 contracts §4.7 与
`docs/ace-file-transfer.md`）：

```ts
// tools/xfer.ts —— 协议面：token、两枚键、一次 pipeline 写、非破坏性读、名字净化、隔离路径、结果行
export const XFER_DEFAULTS: { defaultTtl; defaultTtlMs; maxTtl; maxTtlMs; defaultMaxBytes; hardMaxBytes; refuseAtBytes };
export const XFER_ERROR_TEXT: { … };    // 各错误句子，含 noBlobOnAnyServer（已定 21）
export function parseIsoDuration(value: unknown, options?: { maxMs?: number; maxIso?: string }): number;
export function newToken(): string;     // 128-bit，32 位小写 hex；token 即凭证，不含 namespace / server
export function sanitizeName(raw: string): string;   // 只取 basename、剥控制字符、拒 `.` / `..` / 空
export function xferBlobKey(namespace: string, token: string): string;   // `<ns>:xfer:<token>`
export function xferMetaKey(namespace: string, token: string): string;   // `<ns>:xfer:<token>:meta`
export function quarantinePath(root, token, sessionId, name): string;    // `<root>/.ace/xfer/<token>/<sessionId>/<name>`，唯一写点
export interface XferClient { name: string; get(key): Promise<Uint8Array | undefined>; setMany(commands): Promise<void>; }
export async function putBlob(options: { client; namespace; token; bytes; meta; ttlMs }): Promise<void>;  // blob + :meta 同一 pipeline、同一 TTL
export async function takeBlob(options: { client; namespace; token }): Promise<{ bytes; meta; from } | undefined>;  // GET 非破坏性；有 blob 无 meta 报错
export function assertTransferSize(sizeBytes, options?: { maxBytes?: number }): void;  // 默认 8 MiB、硬上限 64 MiB、≥512 MiB 拒（每份副本）
export function validateStoreInput(params): { path: string; ttl: string; ttlMs: number; name?: string };  // ace_store_file 入参
export function validateGetInput(params): { token: string };                                             // ace_get_file 入参
export function formatSendResult(options): string;   // `pickup=… size=… sha256=… expires_in=… stored_on=…`
export function formatGetResult(options): string;    // `path=… sha256=… size=… from=…`

// tools/xfer-files.ts —— 宿主面：读文件、逐 server fan-out、写隔离目录（只有这里碰 fs）
export interface XferTarget { name: string; namespace: string; client: XferClient; }
export async function storeFile(options: { root; input; targets; maxBytes?; now? }): Promise<StoreFileResult>;
export async function receiveFile(options: { root; token; sessionId; targets }): Promise<GetFileResult>;

// transport/redis-xfer-client.ts —— 把 redis 包适配成 XferClient（BLOB_STRING→Buffer，MULTI/EXEC 一次写）
export function createRedisXferClient(options: { url; name; clientOptions?; onError? }): RedisXferClient;
```

`storeFile` 只报事实：`stored_on=` 列出写入成功的 server，某台失败即缺席、全部失败即空（不定义成败语义）；
读文件的三种失败（不存在 / 目录 / 不可读）各自一句。`receiveFile` 按 **target 顺序**第一台命中即取，
只写入 `<root>/.ace/xfer/<token>/<sessionId>/<name>`（name 取自 `:meta`，调用方不能指定写盘路径）；
同名且字节相同则覆盖，不同则加数字后缀（`report (2).txt`）；逐台都没有该 token 时抛 `noBlobOnAnyServer`。

```ts
// 命名派生（别自己拼字符串）：src/runtime/naming.ts
export const NAMESPACE_DEFAULT = "ace";
export const SESSION_INBOX = "session-inbox";   // 本会话读自己收件箱时的本地标签（不上传）
export const NO_SESSION_LABEL = "(no session)";
export function namespaceOf(descriptor: { namespace?: string }): string;
export function channelName(namespace: string, username: string, name: string): string;   // `<ns>:<username>:<name>`
export function senderName(options: {
	namespace: string; username: string; codingAgent: string; sessionId: string;
}): string;                                     // `<ns>:<username>:<coding-agent>:<sessionId>`
export function channelStreamKey(namespace: string, uploaded: string): string;  // `<ns>:ch:<channel>`
export function directoryKey(namespace: string): string;                        // `<ns>:agents`（ZSet）
export function directoryEntryKey(namespace: string): string;                   // `<ns>:entry`（Hash）
export function resolveLocalName(options: { namespace; username; name }): string; // 段数 <3 才补全
export function localName(server: string | undefined, uploaded: string): string;  // 多 server 时加 `<server>:`
```

自述文本与目录渲染：

```ts
export function hostFacts(options: { codingAgent; agentVersion?; sessionId; cwd }): HostFacts;  // 采集 host/ip/…
export function describeSender(facts: HostFacts): string;    // `agent=… | session=… | cwd=… | host=… | ip=… | platform=… | pid=…`
// 目录条目的自述就是这个字符串本身：加固定前缀只会让每个会话的自述都变得一样。

// tools/listing.ts
export function describeDiscovered(entry: RegistryEntry, options?: { server?; self? }): string;  // `channel=<target> renews_in=<Ns>s self=<yes|no> description="<自述>"`
export function addressOf(endpoint: EndpointConfig): string;
```

## 6. 装配与关闭顺序（宿主必须照做）

来自 `packages/ace-omp/extensions/ace.ts`（`SESSION_INBOX = "session-inbox"`；多 server 时本地名加
`<server>:` 前缀）：

1. **配置**：`resolveAceConfig({ cwd, env, globalConfigPaths })` → 逐台 `server`：
   - `sender = senderName({ namespace: server.namespace, username, codingAgent, sessionId })`；
   - `registry = new AgentRegistry({ store: createRedisAgentRegistry({ url: server.url, namespace: server.namespace, onError }) })`；
   - `await registry.register({ sender, codingAgent, sessionId, cwd })` → `Registration { channel, stream, group }`。
     注册失败就 `registry.close()` 并跳过该 server（目录不可用不该拦住会话）；
   - 收件箱订阅 = `subscriptionEndpoint({ channel: sender, name: SESSION_INBOX（多 server 加前缀）, url: server.url, namespace: server.namespace, sender })`。
2. **订阅**：逐 server，把它配置的 `subscribe` 名字在该 server 的 namespace 下补全为 `(server, channel)`
   （全名原样透传），再用 `subscriptionEndpoint` 派生（`group = 该 server 的 sender`）。
3. **装配**：`subscriptions = [...各 server 的收件箱订阅, ...配置订阅]` →
   `createTransports(subscriptions, { onError, metrics, onDropped })` →
   `new AceRuntime({ engine, subscribe: subscriptions, transports, ... })` → `await runtime.start()`。
4. **关闭**（顺序有原因，别调换）：
   `shutdownAce({ runtime })`（先停 reader、flush spool）→ 逐 server `shutdownAce({ registry })`
   （`unregister` 删本会话的条目与流，再 `close`）。
   先停 reader 是因为反过来的话 reader 会醒在一个被删掉的组上，收尾时报 NOGROUP。
   `shutdownAce` 每步都是 best-effort：失败经 `onError` 上报、绝不抛出，一个死连接不会跳过其余清理。
