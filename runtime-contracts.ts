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
	/** 承载自己的写入标识（Redis stream id、Kafka offset…）。 */
	streamEntryId?: string;
}

/**
 * transport 接缝：broker ⇄ 信封。分帧、寻址、确认、重投、重连都在实现里。
 *
 * 注意词汇：**这一层的 "broker" 指的是承载本身（Redis）**，即模型里的一个 `Server`；而 `streamEntryId`
 * 是**承载自己的写入标识**（stream id、offset…），不是 `ServerName`。
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
	/**
	 * 直投落点就是**以它自己命名的 channel**（= `name`）✓ —— 所以这里没有单独的"收件箱"字段：
	 * 名字即频道名，目录只是"这些自动 channel 在线"的索引。
	 */
	addressable?: boolean;
}

/** 本会话接的一条 channel，即模型/UI 看到的视图：不含连接凭据，按需才带计数器。 */
export interface ChannelView {
	/** 展示用的全名：多 server 时带 `<server>:` 前缀，单 server 不带。 */
	name: string;
	direction: "in" | "out";
	/** 在哪台 server 上（模型据此决定往哪发）。 */
	server: ServerName;
	description?: string;
	/** 仅订阅侧：本接收方固定的激活方式。 */
	activation?: Activation;
	enabled: boolean;
	/** 由目录为本会话注册的那条收件箱。 */
	derived?: boolean;
	/** 地址（stream 名等），给人/UI 看；面向模型的视图可以省略。 */
	address?: string;
}

// ─────────────── 三、Server 与频道记录（模型） ───────────────

/**
 * 一个 **Server** = Redis 承载 + 成员目录 + 频道之家，三者同一个**凭据域**。
 *
 * 为什么不存在「registry」与「brokers[]」的分裂：目录条目的作用就是告诉别人"往哪投递"，而"往哪投递"
 * 就是承载的地址与凭据 —— 把它们拆开就会出现"能发现你、却到不了你的 broker"，而且会把解析后的 URL
 * （可能含密码 ✗）广播给每个目录读者。历史痕迹（现已删除的路径）：`publishEndpointOf()`、
 * `member "…" advertises transport "…", which this runtime cannot publish to`。
 *
 * **只支持 Redis** ✓：所以描述符里没有 `kind` ✗ —— 那是给多承载准备的字段，现在没有第二种，
 * 它是纯噪音；真要加第二种，那时再加一个字段也不迟。
 *
 * 「谁能看见你」因此等价于「谁和你在同一台 server 上」 ✓ —— 这既是限制也是天然的信任边界。
 */

/**
 * 本地配置里给一台 server 起的名字（map 的 key）。**只作用于本地**：server 自己不知道它，
 * 协议里不传、**不上传** ✗，也不要求唯一（你和同事各自把一台叫 `lan` 没问题）。
 * **不含冒号** —— 它是全名的第一段，冒号是分隔符。
 */
export type ServerName = string;

/** 起点。Redis 上映射到 **XGROUP CREATE 的起始 ID**：`latest` = `$`（组建立前的事件不投递）、`earliest` = `0`。默认 `latest`。 */
export type StartFrom = "latest" | "earliest";

/** Redis Streams 的写侧修剪策略，直接对应 node-redis `XAddOptions.TRIM`。 */
export interface TrimPolicy {
	strategy: "maxlen" | "minid";
	modifier?: "exact" | "approx";
	threshold: number;
	limit?: number;
}

/**
 * 本地 ACE 文件里的一个 Server 条目：**连接信息 + 命名空间**，就这两样。
 *
 * `url` 支持 `${ENV}` 插值 —— 凭据（ACL 用户名/密码、`rediss://` 的 TLS）随 URL 走，
 * **只留在本地文件里，永不被广播**。连接池参数等真需要时再加。
 */
export interface ServerDescriptor {
	/** Redis 连接信息：`redis://user:${PASS}@host:6379`、`rediss://…`，支持 `${ENV}` 插值。 */
	url: string;
	/**
	 * 这台 server 的**命名空间**：它拥有的键都落在其下 —— 成员目录、频道、每会话流。默认 `ace`。
	 * **不含冒号**（全名的第二段）。
	 *
	 * 键布局：`<ns>:agents`（在线 participant 目录 ZSet）、`<ns>:entry`（目录条目 hash）、
	 * `<ns>:ch:<name>`（频道流 —— **在线会话的收件箱也是其中之一** ✓）。**地址由约定派生** ✓，
	 * 所以频道记录里没有地址字段 ✓。
	 */
	namespace?: string;
	description?: string;
}

/**
 * 本地 ACE 文件：**一个 map，key 就是 server name**，外加一个 `username`。
 *
 * `username` 是**真实用户的名字或昵称**，衡量"这台 server 上谁在说话"：共享同一台 server 的多个用户
 * 因此不会撞名。它**只作用于本地**：不写进任何远端字段、**不单独存储** —— 零代价的实现方式就是
 * **拼到名字前面**，于是 Namespace > Username > 主体（sender / channel）成为**命名层级**。
 *
 * ### 全名约定（本地形式 vs 上传形式）
 *
 * ```
 * <server>:<ns>:<username>:<name>     ← 本地全名（多 server 时用；第一段只在本地区分）
 *         <ns>:<username>:<name>      ← 上传 / 存储名（server 段不在这里）
 * ```
 *
 * 前三段（server、ns、username）**不含冒号**；最后一段（sender 名 / channel 名）**允许冒号** ——
 * 于是"按前 3 个冒号切开（本地形式）／前 2 个（上传形式），余下全是名字"是无歧义的
 * （sender 名本身形如 `<agent>:<sessionId>`）。
 *
 * ```
 * lan:ace:noexcs:oh-my-pi:01a10a…   ↔   ace:noexcs:oh-my-pi:01a10a…
 * lan:ace:noexcs:ci-failures        ↔   ace:noexcs:ci-failures
 * ```
 *
 * 代价可接受：`ns` 既是键前缀、又在名字里出现一次（键形如 `ace:events:ace:noexcs:…`），
 * 换来"看到名字就知道归属"。
 *
 * ### `username` 的取值顺序（已定）
 *
 * 本文件写了就用 ✓ → 没写则**继承全局文件**的 ✓ → 全局也没有则取 `$USER` ✓ → 三者皆无则报错 ✓。
 * 这是"不合并"的一条明确例外：**只继承这一个字段** ✓（其它字段仍是整份覆盖 ✓）。
 *
 * ### 名字解析（已定）
 *
 * - **短名自动补全**：模型或人说 `ci-failures` → 本地解析为 `<ns>:<username>:ci-failures` ✓
 *   （多 server 时再带上 `<server>:` 前缀 ✓）；工具输出始终显示全名，归属始终看得见 ✓。
 * - **冲突硬报错**：候选在多处出现（多 server 同名，或默认 server 上没有而别处有）→ **报错并列出候选** ✓，
 *   绝不静默挑一个 ✓。
 *
 * ```jsonc
 * { "username": "noexcs",
 *   "servers": { "lan": { "url": "redis://127.0.0.1:6379", "namespace": "lan" } } }
 * ```
 */
export interface ServerConfigFile {
	username: string;
	servers: Record<ServerName, ServerDescriptor>;
}

/**
 * 一次注册的产物：**一个会话在某一台 server 上的存在**。
 *
 * 只有两样：在哪台 server 上 ✓、它的 channel 名是什么 ✓ —— 而那正是它的 **sender 名**
 * （`<ns>:<username>:<codingAgent>:<sessionId>` ✓）。收件箱流、组、心跳都从这两样派生 ✓，
 * 所以这里**没有 member 字段** ✗：member 曾经只是 sender 的另一个说法 ✓，而它本质上就是
 * "该 sender 自动注册的接收 channel" ✓。
 */
export interface ServerRegistration {
	server: ServerName;
	/** = 该会话的 sender 名；也是它的收件箱 channel 名，别人拿它当 `target` ✓。 */
	channel: string;
}

/**
 * 注册中心里的一条**频道记录**：**没有 broker、也没有地址** —— 它在 `server` 上，地址由约定派生。
 *
 * 注意：**在线会话的收件箱也是频道** ✓（名为该会话的 sender ✓，随会话自动注册/回收）——
 * 所以这张表只有一种"东西"，目录只是"哪些自动频道现在在线"的索引 ✓，不存在第二种名字 ✗。
 */
export interface ServerChannelRecord {
	server: ServerName;
	/** 上传形式的名字：**`<ns>:<username>:<name>`**（如 `ace:noexcs:ci-failures`；最后一段允许冒号）。 */
	name: string;
	/** 写侧：修剪策略（不写 = 流无限增长）。 */
	publish?: { trim?: TrimPolicy | null };
	/** 读侧：组（有无 = 瓜分/广播）、起点。 */
	consume?: { group?: string; from?: StartFrom };
	description?: string;
	owner?: string;
}

/** 投递一个事件所需的全部：那一台 server，以及目标频道全名（直投对方 = 填它的 sender 名 ✓）。 */
export interface PublishTarget {
	server: ServerName;
	target: string;
}

/** `ace_channel` 的 `create` 真正要写的东西：名字必需，其余用默认值。 */
export interface ChannelDraft {
	/** 频道名（不含 ns/username —— 它们由本地的 server 与配置补上）。 */
	name: string;
	description?: string;
	publish?: { trim?: TrimPolicy | null };
	consume?: { group?: string; from?: StartFrom };
}

/*
 * ## 默认值表（内建默认 < Server 项 defaults ✗未定 < 频道覆盖）
 *
 * | 字段 | 默认 | 理由 |
 * |---|---|---|
 * | `namespace` | `ace` | 键前缀，也是上传名的一部分 |
 * | 频道地址 | `<ns>:ch:<ns>:<username>:<name>`（派生） | 唯一寻址来源；无字段可写 |
 * | 信封字段名 `field` | `message` | 传输配置：信封写在 stream entry 的哪个字段，两侧必须一致 |
 * | `publish.trim` | `{ maxlen, approx, 10000 }` | 防流无限增长；要全留就显式 `trim: null` |
 * | `consume.group` | 本 participant 名 | = 每订阅者独立组 = 广播（默认交付语义） |
 * | `consume.from` | `latest` | 等价 `$`：组建立前的事件不投递（既有约定） |
 * | consumer / count / blockMs / reclaim* / retry* | `ace-<pid>` / 16 / 1000 / 60000 / 3 / 200 / 5000 | 与既有实现一致 |
 *
 * ## 删掉的东西（这次改动的价值，净减法）
 *
 *   - `publishEndpointOf()` 与"member 自报 broker"的整条投递路径 ✗；
 *   - `TOOL_ERROR_TEXT.transportUnsupported` ✗；
 *   - `BrokerDescriptor` / `BrokerId` / `BrokerKind` / `BrokerChannelDefaults`、`ChannelRecord.broker` ✗；
 *   - `Dispatch` / `Consume`（带 `address` 的那两个联合）✗ —— 只剩 `publish.trim` / `consume.group|from`；
 *   - 多承载的 `kind` 字段 ✗（只支持 Redis）。
 *
 * ## 改名与迁移（实现时一次改齐）
 *
 *   - `BrokerId` / `ServerId` → **`ServerName`**；`prefix` → **`namespace`**（代码里 `RegistryDefaults.prefix`、
 *     配置键、文档、两个宿主 README 全改）；
 *   - 默认命名空间由 `ace:agents` 改为 **`ace`**（覆盖目录 + 频道 + 会话流），键布局随之变为
 *     `<ns>:agents` / `<ns>:entry` / `<ns>:ch:<name>`（**没有第 4 族键**：收件箱就是频道 ✓）—— 现存部署是一次键名迁移；
 *   - **sender 名带 ns 与 username 前缀**：`<codingAgent>:<sessionId>` → `<ns>:<username>:<codingAgent>:<sessionId>`
 *     （**线上可见**的变化，两个宿主的 vendored 核心一起同步）；它就是该会话的收件箱 channel 名 ✓，频道名同理
 *     `<ns>:<username>:<name>`；
 *   - 配置文件由 `registry` + `brokers[]` → `username` + `servers{}`；
 *   - **描述符归位（已定）**：`ChannelDescriptor` / `ParticipantDescriptor` / `Subscription` 从协议文件
 *     （`ace-contracts.ts`）移到本文件 —— 信封里本来就没有 channel 字段，它们都是运行时/配置概念 ✓。
 *     其中 `Subscription` **不再作为配置描述符存在**：订阅是**运行时派生**的（本会话在频道流上建自己的组），
 *     配置里只声明"订阅哪些名字" ✓；
 *   - **收件箱生命周期（已定）**：每会话新建收件箱流，会话结束即删；崩溃时靠条目 TTL 过期 + 清扫回收 ✓。
 *     "同 agent 继承旧收件箱"（真正的持久收件箱）**不做** ✗（它需要 claim/所有权语义 ✓）。
 *
 * ## 仍未定（见 §六 待拍板）
 *
 *   1. 跨 server：只支持"同在多个 server"，还是将来做 relay？
 *   2. 短名解析：模型说 `ci-failures` 时自动补成 `<ns>:<username>:ci-failures`，还是要求写全？
 *   3. 持久收件箱：新会话继承同一 agent 的旧收件箱，还是每次新建、旧的按 TTL 回收？
 *   4. 某台 server 不可达：跳过并告警，还是拒绝启动？
 *   5. `username` 的继承：项目 `.ace.json` 未写 `username` 时，是从全局文件继承，还是每个文件都必须写？
 *   6. `ChannelDescriptor` / `ParticipantDescriptor` / `Subscription` 留在协议文件，还是挪到本文件
 *      （协议只留信封）？
 */

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
 * - `create`：创建一条频道（要求**精确名**，不接受正则）。**只有 `name` 必需** —— `server` 默认取配置里
 *   唯一（或默认）那台，`publish` / `consume` 的每一项都有默认值（见 §三 默认值表），AI 想改才写覆盖值。
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
		/** `create`：写到哪台 server；不写就是配置里唯一（或默认）那台。 */
		server?: ServerName;
		/** `create` 的写侧覆盖值；不写就用内建默认（见 §三 默认值表）。 */
		publish?: ChannelDraft["publish"];
		/** `create` 的读侧覆盖值；不写就用内建默认。 */
		consume?: ChannelDraft["consume"];
		/** `create` 的说明。 */
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
 *    三个宿主待改；注册表**内部**的 `sessionId` 保留 —— 它用来拼 sender 名（也就是收件箱 channel 名））。
 * 3. **载荷类型**：实现里是 `body: string`，契约是不透明的 `Body`（`unknown`）。
 * 4. **通道配置**：实现里是 `.ace.json` 的 `config`；目标是频道记录（`ServerChannelRecord`，只有
 *    `publish`/`consume` 策略与元数据）住进 server，本地文件只剩 `username` + `servers{}`
 *    （`ServerConfigFile`）。
 * 5. **出站接缝**：`WireAdapter.inbound()` / `InboundEvent.ack()` 是目标形状，现状见上文。
 * 6. **Codex 宿主**：桥实现了入站驱动（ACE → 回合、忙时 steer、FIFO 持有），但**未注册 ACE 工具面**
 *    （Codex 会话目前不能 `ace_publish`）——见 `docs/ace-plan.md` §4（宿主侧工作暂停）。
 * 7. **配置退化**：`.ace.json` 只保留 `username` + server 列表；Channel 与订阅关系改由 server 承载，
 *    同时承载层要从"启动时按配置建好"变成**可热插拔**（按订阅动态 start/stop，去重窗口、指标、pending、
 *    派生视图跟着订阅生命周期走）。
 * 8. **词汇统一（一次改齐，别留两套词）**：`Transport` → **`Server`**、`transport` 键 → server 概念、
 *    `prefix` → **`namespace`**、本地实例名 → **`ServerName`**；涉及 `src/transport/*`、`.ace.json` 的键、
 *    工具文本、`docs/`、两个宿主 README —— 与 §三 的"改名与迁移"清单合并执行。
 */

// ─────────────── 六、Server 承载的内容（模型） ───────────────

/**
 * 一台 **Server**（今天的 Redis）承载三样东西，它们是这套模型里唯一的**拓扑真值来源**：
 *
 * 1. **participant 目录**：在线 sender（= 它们各自自动注册的收件箱 channel）、TTL、心跳
 *    （`ParticipantView` 的来源），键 `<ns>:agents` / `<ns>:entry`；
 * 2. **频道目录**：`ServerChannelRecord`（只有策略与元数据 —— 地址由约定派生，没有端点字段）；
 * 3. **频道流**：`<ns>:ch:<name>` —— 普通频道与在线会话的收件箱**走同一条键路** ✓。
 *
 * 本地文件（`ServerConfigFile`）只留**部署信息**：`username` + 每个 server 的连接与命名空间。
 * 端点与凭据**永不进 server** ✗ —— 这正是本期改动的核心：目录条目再也不会广播别人的连接信息。
 *
 * 决策记录与实施批次见 `docs/ace-plan.md`；本节只列**当前仍未拍板**的条目。
 *
 * ## 已定（本轮）
 *
 * 1. **`username` 取值顺序**：本文件 → 全局文件 → `$USER` → 报错 ✓（只继承这一个字段，其余仍整份覆盖 ✓）；
 * 2. **短名解析**：自动补 `<ns>:<username>:` ✓；工具输出显示全名；**冲突硬报错**并列出候选 ✓；
 * 3. **描述符归位**：`ChannelDescriptor` / `ParticipantDescriptor` / `Subscription` 移入本文件（协议只留信封 ✓）；
 *    其中 `Subscription` 不再作为配置描述符 —— 订阅由运行时派生 ✓；
 * 4. **收件箱**：每会话新建、结束即删、崩溃靠 TTL 回收 ✓（**不做**持久收件箱 ✗）；
 * 5. **不可达 server**：**跳过并告警**，其余照常 ✓（状态在启动日志与 `/ace list` 里明确标出 ✓）；
 * 6. **跨 server**：只支持"同在多个 server" ✓，不做 relay ✗。
 *
 * ## 不阻塞、实现中后期再定
 *
 * - **正则订阅的边界**：建议默认只允许**精确名/前缀**，正则需显式开启，且正则下**强制先 dryRun**，并设命中上限；
 * - **`create` 的所有权/覆盖/删除**：`owner` 是否强制、能否覆盖同名、谁能删（同 server 即同凭据域 ✓，
 *   权限可以更多交给 Redis ACL ✓，我们只需写清软约束）；
 * - **`trim` 的破坏性默认**：默认修剪 10000（会丢旧事件）还是默认不修剪（流会无限增长）；
 * - **冷启动**：注册中心不可达、或本会话从未订阅过时的可订阅集来源。
 */
