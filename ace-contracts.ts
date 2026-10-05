/**
 * ACE 协议规范 —— 数据契约（协议层）。
 *
 * 本文件只包含**协议**：跨实现必须一致、且不解内容就能校验、不需要共享状态、不需要知道宿主的那部分。
 * 运行时与宿主的契约（适配器接缝、派生视图、工具面）在 `runtime-contracts.ts`；语义叙述见
 * `docs/ACE-RFC-Draft-0.1.md`；落地形态见 `docs/ace-runtime-contracts.md`。
 *
 * ## 三个主体与一条关系
 *
 * - **Participant**：能收发 ACE 事件的参与者。**名称即身份**，约定 `<coding-agent>:<sessionId>` ——
 *   会话含义由名称承载，协议没有独立的 `sessionId` 字段（RFC §5.4）。
 * - **Channel**：一条有名字、由某种 transport 承载的管道。**只有配置**：怎么投递、谁承载；
 *   不携带任何实时状态。
 * - **Subscription**：Participant ↔ Channel 的关系：消费设置 + 启用开关 + 接收方激活固定。
 *   只声明一次，两端都不得再复制一份。
 *
 * ## 协议不变量
 *
 * 能进这里的只有"形状与不变量"，不是"事实与语义"（例如 `fromChannel` 是字段，而"它必须等于实际来源"
 * 不是协议能保证的事）。
 *
 * 1. `body` 对协议**不透明**：ACE 没有 content-type 层。载荷长什么样（纯文本、JSON、模型 API 那种内容块、
 *    块里的 base64）是两端适配器之间的约定，不是协议字段（RFC §6）。**回复/线程关系同理**：谁在回复谁
 *    属于载荷语义，由适配器约定，协议不设 `replyTo` 之类的字段。
 * 2. 信封里的**未知字段必须被忽略**：新增可选字段不升版本，接收方照旧工作（前向兼容）。
 * 3. `aceVersion` / `id` / `createdAt` / `sender` 由**发送端生成**；调用方与适配器都不得自选。
 * 4. `(sender, id)` 是事件身份：同一发送方内 `id` 唯一；去重以此为准。
 * 5. 投递语义是**至少一次**：接收方可能重复收到同一条，实现必须按 4 去重。
 * 6. `dispatch` / `consume` 的形状**不属于协议**：broker 配置面无法穷举，由 `transport` 指名的实现
 *    负责校验与解释。
 */

/** ACE 协议版本。 */
export type AceVersion = "0.1";

/** Unix 纪元毫秒（UTC）。选它而不是时间文本，是因为可排序、可比较。 */
export type EpochMillis = number;

/** 激活语义（RFC §7）：`default` 表示把选择权交给接收方（§7.4）。 */
export type Activation = "immediate" | "next_turn" | "manual" | "default";

/** 接收方能**执行**的激活值：`default` 永不进入 engine。 */
export type ConcreteActivation = Exclude<Activation, "default">;

/** `sender` 字符集：让渲染出的头部不可伪造（无空格、换行、控制字符）。 */
export const PARTICIPANT_NAME_PATTERN = /^[A-Za-z0-9._@:-]{1,128}$/;

/** 载荷：对协议不透明（不变量 1）。形状由两端适配器约定。 */
export type Body = unknown;

// ─────────────────────────── 一、ACE 信封 ───────────────────────────

/**
 * ACE 信封（RFC §5、§12）。
 *
 * 新增的可选字段保持 0.1 兼容：不认识的接收方忽略它们（不变量 2）。
 */
export interface AceEnvelope {
	aceVersion: AceVersion;
	/** 在同一个 `sender` 内唯一（RFC §5.2）：`(sender, id)` 是事件身份。发送端生成。 */
	id: string;
	/** 发送端接受该事件派发的时刻。发送端生成。 */
	createdAt: EpochMillis;
	/**
	 * 发送方身份（`Participant.name`），须满足 {@link PARTICIPANT_NAME_PATTERN}。
	 * 会话含义同样由它承载：约定 `<coding-agent>:<sessionId>`（RFC §5.4）。
	 */
	sender: string;
	/** 发送方自述（agent / session / cwd / host / ip / platform / pid）。自称，仅用于展示。 */
	senderDescription?: string;
	/**
	 * 发送方**声明**它从哪条 Channel 发出：只是声明。Channel 名只存在于各自的配置里，接收方无从验证。
	 */
	fromChannel?: string;
	/** 发送方请求的激活方式；接收方可以按订阅固定自己的（RFC §8）。 */
	activation: Activation;
	/** 载荷（见 {@link Body}）：对协议不透明。 */
	body: Body;
	/** 未来的协议扩展（`sig`、`nonce` 等）落在这里；接收方忽略不认识的键（不变量 2）。 */
	extensions?: Record<string, unknown>;
}

// ─────────────── 二、运行时/配置描述符 —— 不属于协议 ───────────────

/*
 * 信封里**没有** channel 字段（只有可选的 `fromChannel` 声明），所以 Channel、Participant、Subscription
 * 三个描述符**不属于协议**，已移到运行时契约（见 `runtime-contracts.ts` §三）：
 *
 *   - Channel      → `ServerChannelRecord`（server 上的频道记录：策略 + 元数据，地址由约定派生）
 *                    与 `ChannelDraft`（`ace_channel create` 真正要写的东西）；
 *   - Participant  → `ServerMembership`（一个会话在一台 server 上的身份：member / stream / group）
 *                    加上配置里的身份约定 `<ns>:<username>:<codingAgent>:<sessionId>`；
 *   - Subscription → **不再是描述符**：订阅由运行时派生（本会话在频道流上建自己的组），
 *                    配置里只声明"订阅哪些名字"。
 *
 * 协议这一层只保留：**信封**（上文）与它的不变量。
 */

