/**
 * ACE 运行时 / 宿主契约（**非协议**）。
 *
 * 这里的东西跨实现**不必一致**：适配器接缝、派生视图、工具面。它们约束的是"这一套运行时与它的宿主"，
 * 不是 ACE 协议本身。协议在 `ace-contracts.ts`；语义叙述见 `docs/ACE-RFC-Draft-0.1.md`；
 * 落地形态与逐条细节见 `docs/ace-runtime-contracts.md`。
 *
 * ## 运行时规范
 *
 * 1. **观察到才确认**：事件进入会话、并且**被观察到**之后才 ack；观察键**就是渲染出来的那段文本** ——
 *    渲染两次、或丢掉到达上下文重渲染，都会破坏确认。
 * 2. `manual` 由**运行时**（pending store）持有，不由 transport、也不由 engine 持有；适配器只执行
 *    `immediate` / `next_turn`（`default` 是委派值）。
 * 3. 适配器呈现不了某条载荷时，只给**有界预览**，绝不猜更丰富的渲染。
 * 4. 视图（`ParticipantView` / `ChannelView`）是**派生只读**数据：不配置、不持久化、不作为真值来源。
 * 5. **频道与订阅关系住在注册中心**：本地 ACE 文件里只留**注册中心连接**。Channel（含投递/消费设置）、
 *    以及 Participant ↔ Channel 的订阅关系，都从注册中心读取与写入；运行时不再有"启动即固定的订阅表"，
 *    订阅可被动态增删（见 `ace_channel` 的 action）。
 */

import type { Activation, AceEnvelope, Body, EpochMillis } from "./ace-contracts.ts";

// ─────────────────────────── 一、两个接缝 ───────────────────────────

/** 一条收到的事件，以及运行时完成它所需的句柄。 */
export interface InboundEvent {
	envelope: AceEnvelope;
	/** 到达信息：本会话从哪个订阅读到、broker 地址是什么 —— 这是**事实**（对比 `fromChannel` 的声明）。 */
	arrival: { subscription: string; address?: string };
	/** 确认：**只在事件已被观察**之后调用（运行时规范 1）。 */
	ack(): Promise<void>;
	/** 放弃但不确认，让 transport 重投（RFC §9）。 */
	retry(reason: string): Promise<void>;
}

/** 一次投递的落点，供调用方逐个目标汇报成败。 */
export interface OutboundResult {
	/** 实际写入的 broker 地址。 */
	address?: string;
	/** broker 自己的写入标识（Redis stream id、Kafka offset…）。 */
	brokerId?: string;
}

/**
 * transport 接缝：broker ⇄ 信封。分帧、寻址、确认、重投、重连都在实现里。
 *
 * **目标形状 vs 现状**：这里是目标形状（显式 `InboundEvent.ack()`）。当前 Pi/oh-my-pi 实现用的是
 * `Transport.start(handler)` + `stop()`，确认由"handler 的 promise 在**观察到之后**才 resolve、
 * transport 随后 ack"隐式达成（`packages/ace-runtime/src/transport/transport.ts`）。
 */
export interface WireAdapter {
	/** 接收事件：异步、可批量；**每个事件自带 ack/retry 句柄**。 */
	inbound(): AsyncIterable<InboundEvent>;
	/** 把一个信封投递到一个目标（端点来自 Broker 实例，寻址来自 dispatch）；抛错表示未投递，由调用方汇报。 */
	outbound(envelope: AceEnvelope, target: PublishTarget): Promise<OutboundResult>;
}

/** 模型看到的文本。`<ace_event>` 包装与来源说明都在这一段里。 */
export type InjectedText = string;

/** ContextAdapter 渲染或构建时能拿到的一切。 */
export interface RuntimeContext {
	/** 本会话作为 Participant 的身份。 */
	participant: { name: string };
	/** 渲染收到的事件时存在。 */
	arrival?: { subscription: string; address?: string };
	/** 构建要发出的事件时存在。 */
	publication?: { name: string; address?: string };
}

/** 模型发起的一次工具调用（今天就是 `ace_publish` 的入参）。 */
export interface PublishCall {
	tool: "ace_publish";
	target: string | string[];
	body: Body;
	activation?: Activation;
}

/**
 * ContextAdapter 为一个目标构建的草稿；`id` / `createdAt` / `sender` / `aceVersion` 由运行时后补
 * （协议不变量 3）。
 */
export interface OutboundDraft {
	target: string;
	body: Body;
	activation?: Activation;
}

/**
 * context 接缝：信封 ⇄ 模型可见文本，工具调用 ⇄ 信封草稿。
 *
 * **现状一致**：`PiAdapter.renderEvent` 对应 `render`，`ace_publish` 工具内部的信封构建对应 `build`。
 */
export interface ContextAdapter {
	/** 运行时规范 1 落在它的返回值上：运行时观察这段文本，它出现即确认。 */
	render(envelope: AceEnvelope, ctx: RuntimeContext): InjectedText;
	build(call: PublishCall, ctx: RuntimeContext): OutboundDraft;
}

// ─────────────────────────── 二、派生视图 ───────────────────────────

/** 此刻**可达**的参与者（注册表派生；模型列出目标时看到的就是这些）。 */
export interface ParticipantView {
	name: string;
	description?: string;
	/** 新鲜度：让模型能区分"在线"与"还没过期但已陈旧"。 */
	lastSeen?: EpochMillis;
	/** 不续期即过期的时间点。 */
	expiresAt: EpochMillis;
	/** 可寻址时的落点：目录条目自报的收件箱（broker 实例 + 寻址）。 */
	inbox?: { broker: BrokerId; dispatch: Dispatch };
}

/** 本会话接的一条 channel，即模型/UI 看到的视图：不含 broker 凭据，按需才带计数器。 */
export interface ChannelView {
	name: string;
	direction: "in" | "out";
	/** 在哪台 Broker 上（模型据此决定往哪发）。 */
	broker: BrokerId;
	description?: string;
	/** 仅订阅侧：本接收方固定的激活方式。 */
	activation?: Activation;
	enabled: boolean;
	/** 由目录为本会话注册的那条收件箱。 */
	derived?: boolean;
	/** 地址（stream 名等），给人/UI 看；面向模型的视图可以省略。 */
	address?: string;
}

// ─────────────── 三、Broker 与频道记录（目标形态） ───────────────

/** 本地配置里给一个 Broker **实例**起的名字（如 `local-redis`）；频道记录用它引用。 */
export type BrokerId = string;

/**
 * Broker **种类**。现在**只支持** `redis-streams`。
 *
 * 候选（`nats-jetstream` / `kafka` / `mqtt` / 入站类 `http` / `file`）留在 §六 的短名单里，代码里不出现；
 * 将来加第二种时，把 `Dispatch` / `Consume` 与两个 override 改成按 kind 判别的联合即可，其余形状不变。
 */
export type BrokerKind = "redis-streams";

/** Redis Streams 的写侧修剪策略，直接对应 node-redis `XAddOptions.TRIM`。 */
export interface TrimPolicy {
	strategy: "maxlen" | "minid";
	modifier?: "exact" | "approx";
	threshold: number;
	limit?: number;
}

/**
 * Broker 级别的**频道默认值**：写在这里的值对所有频道生效（`address` 除外 —— 地址永远按
 * `addressPrefix + 频道名` 派生，写死一个字面地址对每个频道都成立才怪）。
 *
 * 优先级：**内建默认 < `BrokerDescriptor.defaults` < 单条频道的覆盖值**
 * （`ChannelDraft.dispatch` / `ChannelDraft.consume` / `ace_channel` 的入参）。
 */
export interface BrokerChannelDefaults {
	dispatch?: Omit<DispatchOverride, "address">;
	consume?: Omit<ConsumeOverride, "address">;
}

/**
 * 一个 Broker 实例（写在**本地** ACE 文件里）：端点与凭据属于部署信息，不进注册中心。
 *
 * 频道记录只引用它的 `id`，因此 `dispatch` / `consume` 里不含 url —— 这正是它们能跨 broker 统一的原因。
 *
 * 这条分工不是我们发明的，是四家客户端库的共同形状：连接设置（`kafka({brokers})` / `connect(url)` /
 * `jsm = jetstreamManager(nc)`）、写侧（`producer.send({topic,key})` / `js.publish(subject)` /
 * `publish(topic, msg, {qos, retain})` / `xAdd(key, id, {field}, {TRIM})`）、读侧（`consumer({groupId})` +
 * `subscribe({topics, fromBeginning})` / `jsm.consumers.add(stream, {durable_name})` /
 * `subscribe(topic, {qos})` / `xReadGroup(group, consumer, {COUNT, BLOCK, CLAIM})`）、控制面
 * （`admin.createTopics` / `jsm.streams.add({name, subjects})` / `xGroupCreate(key, group, id, {MKSTREAM})`）
 * —— 四块分别对应 `BrokerDescriptor` / `Dispatch` / `Consume` / provisioning。
 */
export interface BrokerDescriptor {
	id: BrokerId;
	kind: BrokerKind;
	/** 端点；支持 `${ENV}` 插值，凭据不进仓库。默认 `redis://127.0.0.1:6379`。 */
	url?: string;
	/** 频道名 → stream 键的前缀。默认 `ace:`（共享实例上应换成带归属的前缀，如 `noexcs:ace:`）。 */
	addressPrefix?: string;
	/** 本实例的频道/订阅默认值（保留策略、消费者调优、默认组名等）。 */
	defaults?: BrokerChannelDefaults;
	/** kind 专属连接设置，由该 kind 的实现校验。 */
	options?: Record<string, unknown>;
	description?: string;
}

/**
 * 本地 ACE 文件（目标形态）：**一个注册中心 + 多个 Broker**。
 * Channel 与订阅关系不在这里 —— 它们在注册中心（见 §六）。
 */
export interface LocalAceConfig {
	registry: { url: string; prefix?: string };
	brokers: BrokerDescriptor[];
}

/**
 * 起点。Redis 上映射到 **XGROUP CREATE 的起始 ID**：`latest` = `$`（组建立前的事件不投递）、
 * `earliest` = `0`（补投历史）。默认 `latest`。
 */
export type StartFrom = "latest" | "earliest";

/**
 * 投递侧：只回答"往哪写"。Redis Streams 上就是一次 `XADD`。
 *
 * 每个字段都有默认值（见表），**AI 通常只需要写频道名**。
 */
export interface Dispatch {
	kind: "redis-streams";
	/** 目标 stream 键。默认 `ace:<频道名>`。 */
	address: string;
	/**
	 * 信封 JSON 写在 stream entry 的**哪个字段**里。默认 `message`。
	 *
	 * Redis Stream 的每条 entry 是一张 field→value 表（`XADD key * f1 v1 f2 v2 …`），我们把整个 ACE
	 * 信封 JSON 放进**一个**字段，字段名就是它。所以：
	 *
	 * - **dispatch 与 consume 的 `field` 必须一致** —— 不一致时订阅侧读到的是"entry 缺该字段"，
	 *   既有实现会记一条 notice 然后 **ack**（消息被丢掉，不会重投），这是静默丢事件的坑；
	 * - 它的存在只为**互操作**：同一条流里可以和别的写入者共存，或改名以避开别人的约定；
	 * - 它是**传输配置**、不是 ACE 协议字段（代码注释里明确写了这一点），AI 不必碰它。
	 */
	field?: string;
	/** `XADD` 的 TRIM 写侧修剪。默认 `{ maxlen, approx, 10000 }`；显式 `null` = 不修剪（流会无限增长）。 */
	trim?: TrimPolicy | null;
}

/**
 * 消费侧：`XREADGROUP` + 组创建。每一项都有默认值（见下表），AI 一般只写 `action` + `name`。
 *
 * **`group` 就是交付语义**:默认取**本 participant 名** ⇒ 每个订阅者一个独立组 = 广播；
 * 显式给同一个组名 ⇒ 组内瓜分（竞争消费）。`from` 只在**组首次创建**时生效。
 */
export interface Consume {
	kind: "redis-streams";
	/** 默认 `ace:<频道名>`（与 dispatch 相同）。 */
	address: string;
	/** 默认 = 本 participant 名。 */
	group?: string;
	/** 默认 `latest`。 */
	from?: StartFrom;
	/** 从 stream entry 的哪个字段读信封。默认 `message`；**必须与 `dispatch.field` 一致**。 */
	field?: string;
	/** 组内消费者名。默认 `ace-<pid>`。 */
	consumer?: string;
	/** `XREADGROUP COUNT`，默认 16。 */
	count?: number;
	/** `XREADGROUP BLOCK` 毫秒，默认 1000。 */
	blockMs?: number;
	/** PEL 认领空闲阈值毫秒，默认 60000。 */
	reclaimIdleMs?: number;
	/** PEL 认领次数上限，默认 3。 */
	reclaimAttempts?: number;
	/** 重试退避起始毫秒，默认 200。 */
	retryDelayMs?: number;
	/** 重试退避上限毫秒，默认 5000。 */
	maxRetryDelayMs?: number;
}

/**
 * AI 在 `create` / `subscribe` 里能覆盖的部分：与记录同形，但 `kind` 与全部默认值都不用写。
 * 加第二种 kind 时，这两个类型要改成按 kind 判别的联合。
 */
export type DispatchOverride = Partial<Omit<Dispatch, "kind">>;
export type ConsumeOverride = Partial<Omit<Consume, "kind">>;

/** `create` / `subscribe` 真正要写的东西：只有 `name` 必需。 */
export interface ChannelDraft {
	/** 频道名。既是 stream 键（`ace:<name>`）与默认组名的来源，也是 `subscribe` 的匹配目标。 */
	name: string;
	description?: string;
	dispatch?: DispatchOverride;
	consume?: ConsumeOverride;
}

/*
 * ## Redis Streams 默认值表（**内建默认 < Broker 项 `defaults` < 频道覆盖**；实现里已有同名常量）
 *
 * | 字段 | 默认 | 理由 |
 * |---|---|---|
 * | `addressPrefix` | `ace:` | 由它 + 频道名派生出 `address`（配置里可按实例换前缀） |
 * | `dispatch.address` / `consume.address` | `ace:<频道名>` | 唯一寻址来源；公共前缀避免与别人的键相撞 |
 * | `dispatch.field` / `consume.field` | `message` | 传输配置（信封放哪个 stream 字段），两侧必须一致 |
 * | `dispatch.trim` | `{ maxlen, approx, 10000 }` | 防流无限增长；要无限保留就显式写 `trim: null` |
 * | `consume.group` | 本 participant 名 | = 每订阅者独立组 = 广播（默认交付语义） |
 * | `consume.from` | `latest` | 等价 `$`：组建立前的事件不投递（既有约定） |
 * | `consume.consumer` | `ace-<pid>` | 组内消费者名 |
 * | `consume.count` / `blockMs` | 16 / 1000 | `XREADGROUP` 的 COUNT / BLOCK |
 * | `consume.reclaimIdleMs` / `reclaimAttempts` | 60000 / 3 | PEL 重投 |
 * | `consume.retryDelayMs` / `maxRetryDelayMs` | 200 / 5000 | 退避 |
 * | `BrokerDescriptor.url` | `redis://127.0.0.1:6379` | 本机默认 |
 *
 * 只有一台 Broker 时（现状：配置里只有 redis），`ChannelRecord.broker` 也默认取它。
 *
 * 配置示例（唯一一台 Broker 上收紧保留、并让默认订阅退回共享组）：
 * ```jsonc
 * { "registry": { "url": "redis://127.0.0.1:6379" },
 *   "brokers": [{ "id": "local-redis", "kind": "redis-streams", "addressPrefix": "noexcs:ace:",
 *                 "defaults": { "dispatch": { "trim": { "strategy": "maxlen", "modifier": "approx", "threshold": 1000 } },
 *                               "consume":  { "blockMs": 2000, "group": "workers" } } }] }
 * ```
 */

/** 投递一个信封所需的两样东西：端点（来自 `BrokerDescriptor`）与寻址（来自 `dispatch`）。 */
export interface PublishTarget {
	broker: BrokerDescriptor;
	dispatch: Dispatch;
}

/**
 * 注册中心里的一条频道记录（取代本地配置里的"通道条目"）；`ace_channel` 的 `create` 写的就是它。
 *
 * `owner` 与"能否覆盖同名"属于待定项（见 §六）。
 */
export interface ChannelRecord {
	name: string;
	broker: BrokerId;
	dispatch: Dispatch;
	/** 供订阅者取用的默认消费设置；订阅者可以覆盖 `group` / `from`。 */
	consume: Consume;
	description?: string;
	owner?: string;
}

// ─────────────────────────── 四、工具契约 ───────────────────────────

/**
 * 核心三件是跨宿主一致的工具面；宿主可以再加自己的：Claude 插件额外提供 `ace_pending` /
 * `ace_activate` 来管理 `manual` 事件（实测该插件暴露的就是这四件）。
 *
 * **待迁移**：运行时当前叫 `ace_agents`，契约改为 `ace_participants`。
 */

/** `ace_publish`：把一个事件发给一个或多个目标。 */
export interface AcePublishTool {
	name: "ace_publish";
	input: { body: Body; target: string | string[]; activation?: Activation };
	output: { id: string; delivered: string[]; failed: string[] };
}

/** `ace_participants`：列出此刻可达的参与者（不含本会话）。 */
export interface AceParticipantsTool {
	name: "ace_participants";
	input: { agent?: string; limit?: number };
	output: ParticipantView[];
}

/** `ace_channel`：一个工具、四个动作。`subscribe` / `unsubscribe` 支持正则匹配频道名。 */
export type ChannelAction = "list" | "subscribe" | "unsubscribe" | "create";

/**
 * 频道工具的动作用法：
 *
 * - `list`：列出可见频道（默认可订阅/已订阅的集合），支持 `name`（正则）过滤；
 * - `subscribe` / `unsubscribe`：按 `name` 增删自己的订阅；**`name` 允许正则**，因此
 *   `dryRun: true` 时必须先回报**将要命中/取消的集合与数量**，再由调用方决定是否真做；
 * - `create`：创建一条频道（要求**精确名**，不接受正则）。**只有 `name` 必需** —— `broker` 默认取配置里
 *   唯一的 Broker，`dispatch` / `consume` 的每一项都有默认值（见 §三 默认值表），AI 想改才写覆盖值。
 *
 * 待定（见文件末"待定项"）：正则的默认开关与命中上限、`create` 的所有权/覆盖规则、冷启动没有
 * 订阅时的行为。
 */
export interface AceChannelTool {
	name: "ace_channel";
	input: {
		action: ChannelAction;
		/** 频道名或正则（`create` 必须精确名）。 */
		name?: string;
		/** 只回报将发生什么，不改任何状态。`subscribe` / `unsubscribe` / `create` 都支持。 */
		dryRun?: boolean;
		/** `create` 的投递覆盖值；不写就用 Broker 项 `defaults.dispatch` → 内建默认。 */
		dispatch?: DispatchOverride;
		/** `create` 的消费覆盖值；不写就用 Broker 项 `defaults.consume` → 内建默认。 */
		consume?: ConsumeOverride;
		description?: string;
	};
	output: {
		/** 动作之后（或 dryRun 时"即将"）的频道视图。 */
		channels: ChannelView[];
		/** 命中的频道数，便于调用方判断正则是否过宽。 */
		matched?: number;
		/** 是否真的改动了状态（`dryRun` 为 true 时恒为 false）。 */
		applied: boolean;
	};
}

// ─────────────── 五、实现现状与待迁移（参考信息，非规范） ───────────────

/**
 * 已实现、但不表现为上面的类型面的机制（逐条细节见 `docs/ace-runtime-contracts.md`）：
 *
 * - 去重窗口 `(sender, id)`；重投与死信文件；突发落盘（spool）；逐通道指标计数器；
 * - 目录/注册表：TTL + 心跳 + 成员自报的收件箱（`ParticipantView` 的数据来源）；
 * - `manual` 的 pending store，以及 `/ace` 命令与 TUI 管理器（人机面）。
 *
 * 与实现的差异（迁移项，按依赖顺序）：
 *
 * 1. **工具名**：`ace_agents` → `ace_participants`（工具描述、文档、两条一致性测试一起改）。
 * 2. **信封字段**：删除 `sessionId`（协议与 RFC 已删；代码、`schema/ace-message-0.1.schema.json`、
 *    三个宿主待改；注册表**内部**的 `sessionId` 保留 —— 它用来拼 member 名与收件箱流名）。
 * 3. **载荷类型**：实现里是 `body: string`，契约是不透明的 `Body`（`unknown`）。
 * 4. **通道配置**：实现里是 `.ace.json` 的 `config`；目标是频道记录（`ChannelRecord`，含 `broker` /
 *    `dispatch` / `consume`）住进注册中心，本地文件只剩 `registry` + `brokers[]`（`LocalAceConfig`）。
 * 5. **出站接缝**：`WireAdapter.inbound()` / `InboundEvent.ack()` 是目标形状，现状见上文。
 * 6. **Codex 宿主**：桥实现了入站驱动（ACE → 回合、忙时 steer、FIFO 持有），但**未注册 ACE 工具面**
 *    （Codex 会话目前不能 `ace_publish`）——待定项。
 * 7. **配置退化**：`.ace.json` 只保留注册中心连接（及其前缀）与 Broker 列表；Channel 与订阅关系改由注册
 *    中心承载，同时 Broker 层要从"启动时按配置建好"变成**可热插拔**（按订阅动态 start/stop，去重窗口、
 *    指标、pending、派生视图跟着订阅生命周期走）。
 * 8. **改名 `Transport` → `Broker`**：概念与标识（`BrokerId` = 本地实例名、`BrokerKind` = 种类）在契约里已
 *    统一；代码与文档里仍是 `Transport` / `transport` 键（`src/transport/*`、`.ace.json` 的 `transport`、
 *    四处工具文本、`docs/` 与两个宿主的 README）——一次改齐，别留两套词。
 */

// ─────────────── 六、注册中心承载的内容（目标形态） ───────────────

/**
 * 注册中心（今天的 Redis）承载三样东西，它们是这套模型里唯一的**拓扑真值来源**：
 *
 * 1. **Participant 目录**：成员、TTL、心跳、自报收件箱（`ParticipantView` 的来源）；
 * 2. **Channel 目录**：`ChannelRecord`（`broker` + `dispatch` / `consume` + `description` / `owner`）；
 * 3. **订阅关系**：`Subscription`（participant ↔ channel，含 `activation` / `enabled`）。
 *
 * 本地文件（`LocalAceConfig`）只留**部署信息**：一个注册中心连接 + 多个 `BrokerDescriptor`（端点与凭据）。
 * 端点不进注册中心、寻址不进本地文件 —— 这条分工是 dispatch/consume 能跨 kind 统一的前提。
 *
 * 决策记录、实施批次与默认值表见 `docs/ace-plan.md`（**当前仅计划，未实施**）。
 *
 * ## 待你拍板（这三条会直接改变实现，我没有替你定）
 *
 * - **正则的边界**：正则订阅一个过宽的表达式（如 `.*`）会瞬间订阅海量流。建议：默认只允许**精确名/前缀**
 *   匹配，正则需显式开启，并且 `subscribe`/`unsubscribe` 在正则下**强制先 dryRun**（先看命中数量与集合），
 *   再加一个命中上限。
 * - **冷启动**：注册中心不可达、或本会话从未订阅过时，可订阅集为空。要么允许本地留一份"上次订阅集"快照，
 *   要么接受"重启后需重新订阅（或由模型再订一次）"。你倾向哪个？
 * - **所有权与权限**：谁能 `create`、能否覆盖同名频道、谁能删、`create` 出来的频道归谁（建议 `owner` +
 *   不可覆盖 + 审计字段）。在没有任何认证的现状下，这些都是**软约束**，需要明确写下来。
 * - **Broker 范围（已定）**：本轮**只支持 `redis-streams`**，其余候选（`nats-jetstream` / `kafka` / `mqtt` /
 *   入站类 `http` / `file`）不进实现、不进类型；`BrokerKind` 单成员即此意。将来扩第二家时，把
 *   `Dispatch` / `Consume` 与两个 override 改成按 kind 判别的联合即可。`amqp` 因两段式寻址
 *   （exchange + routingKey）与统一写法不兼容，即便扩也不优先。
 * - **默认值**：§三 的默认值表是本轮定的（`ace:<name>` / `message` / `latest` / participant 名建组 /
 *   默认 trim 10000）。**其中 `trim` 是唯一有破坏性的默认**（会丢弃旧事件）：若你不接受，改成
 *   `trim: null` 为默认，或干脆不默认修剪，一句话即可。
 */
