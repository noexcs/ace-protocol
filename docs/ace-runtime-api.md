# ace-runtime 导出面摘要（宿主接线只需这一页）

**对应今天的形状**：`transport` / `config` / `EndpointsConfig`。`docs/ace-plan.md` 里的
`Broker` / `dispatch` / `consume` 是**目标形状，尚未实施** —— 接线时别混用。
来源：`packages/ace-runtime/src/**`（2026-10-04 现状）。改 runtime 时请同步本页。

## 1. 传输接缝

```ts
export type RawAceMessageHandler = (raw: unknown) => Promise<void>;

/** 传输只搬原始消息；ACE 才做校验。MQ 元数据（stream/group/offset）不出适配器。 */
export interface Transport {
	start(handler: RawAceMessageHandler): Promise<void>;
	stop(): Promise<void>;
}

export const SUPPORTED_TRANSPORTS: readonly string[] = ["redis-streams"];

export interface TransportFactoryOptions { onError: (error: unknown) => void; metrics?: AceMetrics; /* + client 注入 */ }

/** 每个订阅建一个 transport，**按订阅名**作键 —— 这正是 AceRuntime 期望的键。 */
export function createTransports(
	subscriptions: readonly EndpointConfig[],
	options: TransportFactoryOptions,
): Record<string, Transport>;
```
现成实现：`redis-streams-transport.ts`（真 broker）、`in-memory-transport.ts`（测试）。

## 2. AceRuntime

```ts
export interface AceRuntimeOptions {
	engine: AgentEngine;
	subscribe: readonly EndpointConfig[];
	/** 键 = **订阅名**；AceRuntime 会校验每个订阅都有对应 transport（缺一个就抛） */
	transports: Readonly<Record<string, Transport>>;
	defaultActivation?: ConcreteActivation;
	logger?: AceLogger; metrics?: AceMetrics;
	dedupCapacity?: number;           // 默认 1024，(sender,id) 去重窗口
	manual?: { max?: number; ttlMs?: number };
	spool?: /* 突发落盘 */;
	now?: () => number;
}
```

## 3. 配置（`.ace.json`）

```ts
export const ACE_CONFIG_FILENAME = ".ace.json";
export function loadAceConfig(options): LoadedAceConfig | undefined;  // ACE_CONFIG 或 <cwd>/.ace.json
export function resolveAceConfig(options): ResolvedAceConfig;
export function interpolateEnv(value, env, source, path?): unknown;   // 配置字符串里的 ${VAR}
```

```ts
/** 一条绑定的合法键（未知键会被拒） */
// name, transport, description, enabled, config, options  +  subscribe 侧额外有 activation
export interface EndpointConfig { /* 上述键 */ }

export interface AceConfigFile {
	defaultActivation?: ConcreteActivation;   // immediate | next_turn | manual
	sender?: string;                          // 有 publish 时必需；^[A-Za-z0-9._@:-]{1,128}$
	subscribe: EndpointConfig[];              // 非空
	publish?: EndpointConfig[];
	manual?: { max?: number; ttlMs?: number };// 默认 100 / 24h
	registry?: { url: string; prefix?: string };// 缺省 = 不注册
}

export interface ResolvedAceConfig {
	subscribe: EndpointConfig[];   // 仅 enabled
	publish: EndpointConfig[];     // 仅 enabled
	disabled: string[];
	defaultActivation?: ConcreteActivation;
	sender?: string;
	warnings: string[];
	manual: { max?: number; ttlMs?: number };
	registry?: { url: string; prefix?: string };
	source: string;
}
```

## 4. 注册中心（agent directory）

```ts
export interface AgentRegistryStore {          // 7 个方法；测试用内存实现即可
	ensureStream(stream, group): Promise<void>;  // 幂等；组不存在就 MKSTREAM 建
	put(member, channel: RegistryChannel, expiresAt: number): Promise<void>;
	refresh(member, expiresAt: number): Promise<void>;
	remove(member): Promise<void>;
	dropStream(stream): Promise<void>;            // 会话关闭后，没人能再往它发
	list(now: number): Promise<RegistryEntry[]>;  // 顺带剪掉过期条目
	close(): Promise<void>;
}

export interface AgentRegistryOptions {
	store: AgentRegistryStore;
	prefix?: string;                     // 默认见 REGISTRY_DEFAULTS（"ace:agents"）
	ttlMs?: number; refreshMs?: number;
	now?: () => number;
	setTimer?: (cb: () => void, ms: number) => { cancel: () => void };  // ← 本包既有的可注入缝，照此加 factory 缝
	logger?: AceLogger;
	onError?: (error: unknown) => void;  // 注册中心问题绝不能让会话挂掉
}

export interface AgentRegistration {
	codingAgent: string;                 // "oh-my-pi" | "pi" | "codex"
	agentVersion?: string;
	sessionId: string;                   // member 由它拼出
	cwd: string;
	url: string;                         // 本会话流的 broker 地址（告诉别人往哪发）
}

export interface Registration { member: string; stream: string; group: string; channel: RegistryChannel }
export interface RegistryChannel {
	name: string; transport: string; description: string;
	config: { stream: string; group: string; url: string; field?: string };
}
export interface RegistryEntry { member: string; channel: RegistryChannel; expiresAt: number }

export class AgentRegistry {
	constructor(options: AgentRegistryOptions);
	/** register = member → ensureStream → put → 起心跳 timer；返回 Registration */
	register(registration: AgentRegistration): Promise<Registration>;
	/** unregister = 停 timer → remove(member) → dropStream(自己的流) */
	unregister(): Promise<void>;
}

export function createRedisAgentRegistry(options: RedisAgentRegistryOptions): AgentRegistryStore;

// 命名派生（别自己拼字符串）
export function registryMember(codingAgent: string, sessionId: string): string;  // `<agent>:<sessionId>`
export function registryStream(prefix: string, member: string): string;         // `<prefix>:events:<member>`
export function registryGroup(member: string): string;                          // `ace:<member>`
```

## 5. 发现与寻址

```ts
export function publishEndpointOf(entry: RegistryEntry, defaultField = "message"): PublishEndpoint;
// → { transport, url, stream, field }，用条目自报的 broker；说不了那个 transport 就要明说，别回退自己的

export type TargetResolution =
	| { ok: true; entry: RegistryEntry }
	| { ok: false; reason: "not-found" | "ambiguous"; candidates: string[] };
export function resolveTarget(entries: readonly RegistryEntry[], target: string): TargetResolution;
// target = 精确 member，或只匹配到一个的前缀
```

## 6. 装配与关闭顺序（宿主必须照做）

来自 `packages/ace-omp/extensions/ace.ts`（`SESSION_INBOX = "session-inbox"`）：

1. **注册**：`registry.register(...)` → 用返回的 `Registration` 组一个订阅（`new EndpointConfig`）：
   `{ name: "session-inbox", transport: "redis-streams",
      config: { stream: registration.stream, group: registration.group, url: resolved.registry.url } }`
   → 把它追加到传给 `AceRuntime` 的订阅列表 → `createTransports([...])` → runtime 起来。
2. **关闭**（顺序有原因，别调换）：
   `runtime.stop()` → **再** `registry.unregister()`（它删本会话的流与组） → `registry.close()`。
   先停 reader 是因为反过来的话 reader 会醒在一个被删掉的组上，收尾时报 NOGROUP。
