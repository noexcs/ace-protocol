# ACE 0.1 第一版实现文档

> 本文是 ACE（Agent Context Event Protocol）0.1 的第一版实现指南。
>
> 目标是基于 **Pi Agent Runtime / pi-coding-agent** 实现一个最小可运行的 ACE Runtime，使外部事件能够进入 Agent Context，并按照 ACE 定义的 activation 语义驱动 Agent。
>
> 本文不是 ACE RFC 的替代品。协议语义以 `ACE-RFC-Draft-0.1.md` 为准；本文负责说明第一版工程如何落地。
>
> 本文写于实现之前。**实现级契约（配置键集、Redis 键与字段、工具参数、投递语义、流程与不变量）以
> [`ace-runtime-contracts.md`](ace-runtime-contracts.md) 为准**；末节「实现现状」记录本文之后新增的机制。

---

# 1. 实现目标

第一版只实现 ACE 最核心的能力：

```text
External Event
      │
      ▼
Transport
      │
      ▼
ACE Runtime
      │
      ├── Parse
      ├── Validate
      ├── Resolve Activation
      └── Dispatch
      │
      ▼
Pi Agent
      │
      ▼
Agent Context
      │
      ▼
Agent Turn
      │
      ▼
LLM
```

核心目标：

> 让一个运行中的 Agent 可以接收来自外部世界的 ACE Message，并使消息内容进入 Agent Context；根据 `activation` 决定何时启动下一次 Agent Turn。

第一版不追求完整的分布式 Agent 平台。

重点是验证：

1. ACE Message 能否正确解析。
2. ACE Message 能否正确验证。
3. Activation 是否按照 RFC 正确解析。
4. 外部事件能否进入 Pi Agent Context。
5. `next_turn` / `manual` / `default` 是否能够正确工作。
6. Agent 空闲时收到事件能否自动启动。
7. 后续可以在此基础上增加 `immediate`。

---

# 2. 第一版技术选择

## 2.1 Agent Runtime

使用：

**Pi / pi-coding-agent**

Pi 作为 Agent Engine，而不是 ACE Protocol 的一部分。

Pi 负责：

- Agent Session
- Agent Context
- Agent Turn
- LLM 调用
- Tool 调用
- Agent Loop

ACE Runtime 负责：

- 接收外部事件
- ACE Message 解析
- ACE Message 验证
- Activation Resolution
- 将事件交给 Pi

不要修改 Pi 内部代码来实现 ACE。

优先通过 Pi 提供的 SDK / Extension / RPC 等公开接口进行集成。

---

# 3. 第一版总体架构

推荐采用以下结构：

```text
                    External World
                         │
                         │
                  Kafka / NATS / ...
                         │
                         ▼
                ┌─────────────────┐
                │   Transport     │
                │    Adapter      │
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │   ACE Runtime   │
                │                 │
                │  1. Parse       │
                │  2. Validate    │
                │  3. Resolve     │
                │  4. Dispatch    │
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │   Pi Adapter    │
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │   Pi Session    │
                │                 │
                │    Context      │
                │       │         │
                │       ▼         │
                │   Agent Loop    │
                └─────────────────┘
```

注意：

**ACE Runtime 与 Pi Agent Engine 必须保持边界。**

不要把：

```text
ACE Message
Activation
Transport
Kafka
NATS
```

直接塞进 Pi 的 Agent 核心逻辑。

Pi 应该只是 ACE Runtime 的一个 Agent Engine Adapter。

---

# 4. 推荐项目结构

第一版可以采用：

```text
ace-runtime/
│
├── src/
│   │
│   ├── protocol/
│   │   ├── ace-message.ts
│   │   ├── activation.ts
│   │   └── validator.ts
│   │
│   ├── runtime/
│   │   ├── input-config.ts
│   │   ├── activation-resolver.ts
│   │   ├── event-dispatcher.ts
│   │   └── ace-runtime.ts
│   │
│   ├── transport/
│   │   ├── transport.ts
│   │   └── ...
│   │
│   ├── agent/
│   │   ├── agent-engine.ts
│   │   └── pi-adapter.ts
│   │
│   └── index.ts
│
├── test/
│   ├── protocol/
│   ├── runtime/
│   └── integration/
│
├── examples/
│   └── basic.ts
│
├── package.json
├── tsconfig.json
└── README.md
```

不要一开始创建大量目录。

如果某个抽象没有实际使用，可以暂时不创建。

---

# 5. ACE Message

第一版严格实现 RFC 0.1。

TypeScript 类型：

```typescript
export interface AceMessage {
  aceVersion: "0.1";
  id: string;
  sender: string;
  sessionId?: string; // 可选：发送方的会话/实例标识
  activation: Activation;
  body: string;

  [key: string]: unknown;
}
```

Activation：

```typescript
export type Activation =
  | "immediate"
  | "next_turn"
  | "manual"
  | "default";
```

---

# 6. Message Validation

实现一个独立 Validator：

```typescript
export function validateAceMessage(
  value: unknown
): AceMessage;
```

Validator 必须检查：

```text
aceVersion === "0.1"
id 非空字符串
sender 非空字符串
activation 为合法枚举
body 为字符串
```

未知字段允许存在。

例如：

```json
{
  "aceVersion": "0.1",
  "id": "evt_123",
  "sender": "build-service",
  "activation": "next_turn",
  "body": "Build failed."
}
```

合法。

以下非法：

```json
{
  "aceVersion": "0.1",
  "id": "evt_123",
  "sender": "build-service",
  "activation": "unknown",
  "body": "Build failed."
}
```

---

# 7. Body 处理

ACE 0.1 中：

```text
body = string
```

ACE Runtime 不解释 body。

例如下面这些都合法：

```json
"Build failed."
```

或者：

```json
"{\"event\":\"build_failed\",\"project\":\"foo\"}"
```

或者：

```json
"User created a new GitHub issue."
```

Runtime 不应该根据字符串内容判断：

```text
event type
priority
source
project
tool
```

这些属于 Agent Message Body 的应用层语义。

---

# 8. Input Configuration

Runtime 需要知道：

> 从哪里接收 ACE Message，以及收到消息之后采用什么 activation 默认值。

第一版可以使用类似：

```yaml
inputs:
  - name: build-events
    transport: kafka
    topic: build-events
    activation: immediate
```

但是注意：

这些配置属于 Runtime。

它们不是 ACE Message。

例如：

```text
Kafka Topic
RabbitMQ Routing Key
NATS Subject
```

都不是 ACE Protocol Field。

---

# 9. Input Config

可以定义：

```typescript
interface InputConfig {
  name: string;

  transport: string;

  activation?: Activation;

  [key: string]: unknown;
}
```

具体 transport 参数由 Transport Adapter 自己解释。

例如 Kafka：

```yaml
inputs:
  - name: build-events
    transport: kafka
    topic: build-events
    activation: next_turn
```

Kafka Adapter 读取：

```text
topic
```

ACE Runtime 不需要理解 Kafka Topic 的语义。

---

# 10. Activation Resolution

必须实现独立的 Activation Resolver。

优先级：

```text
Input Config
      │
      ▼
Message.activation
      │
      ▼
Runtime Default
```

准确规则：

```typescript
if (input.activation !== undefined &&
    input.activation !== "default") {
    return input.activation;
}

if (message.activation !== "default") {
    return message.activation;
}

return runtime.defaultActivation;
```

Runtime Default：

```text
next_turn
```

因此：

```text
Input Config = immediate
Message      = next_turn
Effective    = immediate
```

---

# 11. Activation 语义

第一版必须支持：

```text
immediate
next_turn
manual
default
```

---

## 11.1 next_turn

第一版优先实现。

语义：

> 当前 Agent Turn 不需要被中断；消息应该在 Agent 的后续处理机会被处理。

如果 Agent 当前空闲：

```text
ACE Message
    ↓
Context Injection
    ↓
Start Agent Turn
```

如果 Agent 正在执行：

```text
Current Agent Turn
        │
        │ running
        ▼
ACE Message
        │
        ▼
Pending Event
        │
        ▼
Current Turn 完成
        │
        ▼
Next Agent Turn
```

第一版不要求：

```text
一个事件 = 一个 Turn
```

也不要求：

```text
多个事件必须分别处理
```

具体 batching/scheduling 可以由 Runtime 自己决定。

---

# 12. manual

语义：

> Runtime 接收并保留消息，但不自动启动 Agent。

例如：

```text
ACE Message
    │
    ▼
Runtime
    │
    ▼
Stored/Pending Event
```

不会自动：

```text
Agent Turn
```

第一版可以简单保存在 Runtime 内存队列中。

暂时不需要设计：

```text
Message Query API
Event Inbox API
Persistent Event Store
```

如果程序重启导致 manual event 丢失，在 MVP 阶段可以接受。

但必须在 README 中明确这是第一版实现限制。

---

# 13. default

`default` 表示：

> Message Sender 不指定具体 activation 行为。

最终行为由 Runtime 决定。

第一版：

```text
default -> next_turn
```

---

# 14. immediate

`immediate` 是第一版最困难的部分。

它的语义：

> Message 应尽快处理，并允许 Runtime 在必要时中断当前 Agent Turn。

但是第一版不要试图同时解决所有问题。

不要在第一版设计：

```text
distributed cancellation
checkpoint protocol
partial token recovery
tool rollback
transaction rollback
exactly-once interruption
```

第一阶段可以先实现一个最小版本：

```text
Agent Idle
    ↓
immediate event
    ↓
Start Agent Turn
```

即：

**先让 immediate 在 idle 状态下工作。**

然后再考虑：

```text
Agent Running
    ↓
immediate event
    ↓
Interrupt
    ↓
Preserve/Discard current execution
    ↓
Inject Event
    ↓
New Turn
```

这部分应单独实现和测试。

---

# 15. Agent Engine 抽象

ACE Runtime 不应该直接依赖 Pi API。

定义一个很小的 Agent Engine 接口：

```typescript
interface AgentEngine {
  inject(message: AceMessage): Promise<void>;

  startTurn(): Promise<void>;

  isRunning(): boolean;
}
```

但是不要为了“未来扩展”设计大量接口。

第一版只需要支持：

```text
inject
startTurn
isRunning
```

如果 Pi 的实际 API 不完全符合，可以通过 Adapter 转换。

---

# 16. Pi Adapter

实现：

```text
PiAdapter
```

职责：

```text
ACE Runtime
     │
     ▼
PiAdapter
     │
     ▼
Pi Session
```

PiAdapter 负责把：

```text
AceMessage.body
```

转换为 Pi 可以接受的 Agent Context 输入。

例如：

```text
ACE:

body =
"Build failed for project foo."
```

PiAdapter 可以将它转换为 Agent 可见的信息。

具体采用：

```text
user message
system/context message
custom event
```

中的哪一种，应根据 Pi 实际 SDK 能力选择。

原则：

> ACE 只规定 body 进入 Agent Context，不规定 Pi 内部 Context 的具体数据结构。

---

# 17. Context Injection

核心流程：

```text
AceMessage
    │
    ▼
effectiveActivation
    │
    ▼
PiAdapter.inject()
    │
    ▼
Agent Context
```

最小要求：

> Message Body 必须能够被后续 Agent reasoning 看到。

例如收到：

```json
{
  "aceVersion": "0.1",
  "id": "evt_001",
  "sender": "build-service",
  "activation": "next_turn",
  "body": "Build failed for project foo."
}
```

Agent 下一次 reasoning 必须能够看到：

```text
Build failed for project foo.
```

---

# 18. 是否给 Agent 增加 ACE Metadata

第一版可以让 Agent Context 中包含：

```text
sender
id
body
```

例如：

```text
[ACE Event]
sender: build-service
id: evt_001

Build failed for project foo.
```

但这不是 ACE Protocol 对 Agent Context 格式的规定。

这是 PiAdapter 的实现选择。

如果消息带 `sessionId`，它的渲染同样属于**实现选择**：本实现会截短显示（例如只显示尾部 6 位）——会话标识通常较长，接收方只需要能**区分**"是不是同一次会话"。截断只发生在渲染层，协议字段保存完整值；截断后的标签不得用作标识符（不用于去重、授权或关联键）。

不要让：

```text
[ACE Event]
```

变成 ACE 标准要求。

---

# 19. Event Dispatcher

Runtime 中实现：

```typescript
class EventDispatcher {
  async dispatch(
    message: AceMessage,
    activation: Activation
  ): Promise<void>
}
```

逻辑：

```text
                ACE Message
                     │
                     ▼
              Activation
               Resolution
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
    immediate    next_turn      manual
        │            │            │
        ▼            ▼            ▼
      Pi         Pending        Store
     Turn         Queue        Pending
```

第一版的核心是把这个逻辑写清楚。

不要把所有逻辑塞进 `AceRuntime` 一个类。

---

# 20. Runtime 主流程

可以设计：

```typescript
class AceRuntime {
  async handleRawMessage(
    raw: unknown,
    input: InputConfig
  ): Promise<void> {

    const message = validateAceMessage(raw);

    const activation =
      resolveActivation(
        message,
        input,
        this.defaultActivation
      );

    await this.dispatcher.dispatch(
      message,
      activation
    );
  }
}
```

这应该成为第一版的核心代码路径。

---

# 21. Transport Adapter

第一版不要直接把 Kafka/NATS 写死在 Runtime。

定义：

```typescript
interface Transport {
  start(
    handler: (message: unknown) => Promise<void>
  ): Promise<void>;

  stop(): Promise<void>;
}
```

Kafka：

```text
KafkaTransport
```

NATS：

```text
NatsTransport
```

可以后续添加。

第一版实际上甚至可以先提供：

```text
InMemoryTransport
```

用于测试。

---

# 22. 为什么先实现 InMemoryTransport

MVP 不应该一开始就依赖 Kafka。

首先验证：

```text
ACE Message
→ Validation
→ Activation
→ Context Injection
→ Agent Turn
```

因此：

```typescript
const transport = new InMemoryTransport();

transport.publish({
  aceVersion: "0.1",
  id: "evt_001",
  sender: "test",
  activation: "next_turn",
  body: "Build failed."
});
```

可以直接验证整个 ACE Runtime。

之后再：

```text
InMemoryTransport
        ↓
KafkaTransport
```

替换。

---

# 23. 第一版测试策略

必须有单元测试。

---

## 23.1 Message Validation

测试：

```text
valid message
missing aceVersion
wrong aceVersion
missing id
empty id
missing sender
missing activation
invalid activation
missing body
body not string
unknown fields
```

---

## 23.2 Activation Resolution

测试：

```text
Input immediate + Message next_turn
=> immediate

Input next_turn + Message immediate
=> next_turn

Input undefined + Message immediate
=> immediate

Input undefined + Message default
=> next_turn

Input next_turn + Message default
=> next_turn
```

---

## 23.3 next_turn

测试：

```text
Agent idle
+
next_turn event

=> Agent receives event
=> Agent starts turn
```

以及：

```text
Agent running
+
next_turn event

=> Current turn is not interrupted
=> Event is retained
=> Event is eventually injected
```

---

## 23.4 manual

测试：

```text
manual event
+
Agent idle

=> Agent does not start
```

并验证：

```text
event is retained
```

---

## 23.5 default

测试：

```text
default event
+
no input override

=> next_turn
```

---

# 24. MVP 集成测试

实现一个假的 Agent 或最小 Pi Agent。

测试：

```text
Test Producer
      │
      ▼
InMemoryTransport
      │
      ▼
ACE Runtime
      │
      ▼
Pi Adapter
      │
      ▼
Agent
```

发送：

```json
{
  "aceVersion": "0.1",
  "id": "evt_001",
  "sender": "test-producer",
  "activation": "next_turn",
  "body": "There is a new build failure."
}
```

最终验证：

```text
Agent Context contains:
"There is a new build failure."
```

并且 Agent 执行了一次新的 Turn。

---

# 25. 第一版 CLI

可以提供一个简单 CLI：

```bash
ace-runtime
```

例如：

```bash
ace-runtime --config ./ace.yaml
```

配置：

```yaml
agent:
  engine: pi

inputs:
  - name: test
    transport: memory
    activation: next_turn
```

之后可以：

```bash
ace-runtime --config ./ace.yaml
```

启动 Runtime。

第一版不需要做复杂 CLI。

---

# 26. Example

提供：

```text
examples/basic.ts
```

演示：

```text
1. 创建 Pi Agent
2. 创建 ACE Runtime
3. 注册 InMemoryTransport
4. 发布 ACE Message
5. Runtime 接收
6. Runtime 验证
7. Runtime 解析 activation
8. Pi Adapter 注入 Context
9. Agent 开始 Turn
```

示例消息：

```json
{
  "aceVersion": "0.1",
  "id": "evt_123",
  "sender": "build-service",
  "activation": "next_turn",
  "body": "Build failed for project foo."
}
```

---

# 27. 第一版不实现的内容

非常重要：

以下内容不要因为“未来可能需要”而提前实现。

## 不实现：

### 1. Agent Registry

暂时没有：

```text
Agent Registration
Agent Discovery
Agent ID Registry
```

---

### 2. Dynamic Target

暂时不允许 Agent 动态指定：

```text
Kafka Topic
NATS Subject
RabbitMQ Routing Key
```

---

### 3. ACE Broker

不要创建：

```text
ACE Broker
ACE Server
ACE Gateway
```

ACE Runtime 可以直接使用 Transport。

---

### 4. ACE Stream

不要创建：

```text
ACE Stream
Stream ID
Stream Registry
Stream Discovery
```

---

### 5. Subscription Protocol

Runtime 可以有 input configuration，但 ACE 本身不定义：

```text
subscribe()
unsubscribe()
```

---

### 6. Standard ACK API

不要定义：

```typescript
ack()
nack()
retry()
```

这些由 Transport / Infrastructure 负责。

---

### 7. Exactly Once

不承诺：

```text
Exactly Once Delivery
Exactly Once Processing
```

---

### 8. Persistent Event Store

MVP 可以使用：

```text
Memory Queue
```

不要为了“未来可靠性”立即引入数据库。

---

### 9. Context ID / Session ID

不要增加：

```text
contextId
conversationId
```

到 ACE Protocol。

**关于 `sessionId`（0.1 修订决定）**：最初 0.1 把 session 完全排除在协议之外，理由是"Pi 自己管理 Session"。实测多会话协作后该决定被推翻：

```text
同一个 sender 在一个项目里起多个 session
  → 接收方无法判断"对方的上下文是否已经变更"
  → 也无法把回复对应回发起它的那次会话
```

因此 `sessionId` 作为**可选**协议字段加入（见 RFC §5.4）。边界保持不变：

```text
ACE 不管理 Session
ACE 不认证 sessionId
sessionId 只是发送方声称的实例标识
去重仍以 (sender, id) 为准
```

---

### 10. Binding

不要创建：

```text
Binding
Context Binding
Agent Binding
```

---

### 11. Result Event

暂时不要定义：

```text
ResultEvent
ResponseEvent
ACE Response
```

ACE 0.1 首先解决：

```text
External World → Agent
```

而不是：

```text
Agent → External World
```

---

# 28. Immediate 第二阶段

完成 MVP 后，再实现：

```text
Agent Running
       │
       │
       │ ACE immediate event
       ▼
Runtime
       │
       ▼
Interrupt current execution
       │
       ▼
Preserve necessary state
       │
       ▼
Inject ACE event
       │
       ▼
Start new Agent Turn
```

这一阶段需要重点研究 Pi：

```text
Agent Loop
Streaming
Tool Execution
Abort
Event Handling
Session State
Partial Output
```

不要在没有理解 Pi 执行模型之前实现复杂的 interruption abstraction。

---

# 29. Immediate 的实现原则

不要把：

```text
immediate
```

理解成：

> “必须马上杀死当前线程。”

正确理解是：

> ACE 给 Runtime 一个“可以立即激活/允许打断当前 Turn”的语义信号。

具体：

```text
如何 interrupt
如何 cancel LLM
如何 cancel tool
是否保留 partial output
是否重新构建 Context
是否创建新的 Turn
```

属于 Agent Runtime / Agent Engine。

因此：

```text
ACE
  ↓
Activation = immediate
  ↓
Runtime
  ↓
Pi-specific interruption mechanism
```

---

# 30. 错误处理

第一版至少区分：

```text
Invalid ACE Message
Transport Error
Agent Injection Error
Agent Turn Error
```

但不要建立复杂错误协议。

例如：

```typescript
try {
  const message = validateAceMessage(raw);

  const activation =
    resolveActivation(...);

  await dispatcher.dispatch(
    message,
    activation
  );
} catch (error) {
  // log / runtime-specific handling
}
```

具体：

```text
retry
dead letter
ack
redelivery
```

交给 Transport / Runtime。

---

# 31. Logging

第一版需要基本日志。

至少包含：

```text
aceMessage.id
aceMessage.sender
activation
input.name
```

例如：

```text
[ACE] received id=evt_123 sender=build-service
[ACE] activation=next_turn
[ACE] injecting id=evt_123 into agent
[ACE] agent turn started
```

不要把完整 body 默认打进日志。

避免敏感数据泄漏和日志污染。

---

# 32. ID 处理

ACE Runtime 不负责生成 sender。

`sender` 是发送方提供的语义标识。

`id` 也是消息自身的标识。

Runtime 可以利用：

```text
(sender, id)
```

进行：

```text
deduplication
correlation
tracing
```

但第一版可以暂时不实现持久化去重。

可以保留一个简单：

```text
Set<string>
```

用于测试。

---

# 33. Runtime 生命周期

第一版 Runtime：

```text
create
  ↓
configure
  ↓
start
  ↓
receive events
  ↓
dispatch
  ↓
stop
```

建议：

```typescript
interface Runtime {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

不要增加复杂生命周期状态机。

---

# 34. 第一版运行模式

推荐：

```text
Single Process
Single Agent
Single Pi Session
```

即：

```text
Process
 ├── ACE Runtime
 ├── Transport
 └── Pi Agent
```

不要第一版就设计：

```text
Multi Agent
Distributed Runtime
Agent Cluster
Agent Registry
Load Balancing
```

---

# 35. 第一阶段完成标准

完成以下功能后，就认为 ACE 0.1 MVP 成功：

### Protocol

- [ ] AceMessage 类型
- [ ] Activation 类型
- [ ] Message Validator
- [ ] JSON Schema
- [ ] unknown fields 支持

### Runtime

- [ ] InputConfig
- [ ] ActivationResolver
- [ ] EventDispatcher
- [ ] AceRuntime

### Transport

- [ ] InMemoryTransport

### Agent

- [ ] AgentEngine interface
- [ ] PiAdapter
- [ ] Pi Session
- [ ] Context Injection

### Activation

- [ ] next_turn
- [ ] manual
- [ ] default
- [ ] immediate（至少 idle 状态）

### Tests

- [ ] Protocol tests
- [ ] Activation tests
- [ ] Context injection test
- [ ] Integration test

---

# 36. MVP 验收场景

最终必须可以运行下面的完整流程：

```text
1. 启动 Pi Agent

2. 启动 ACE Runtime

3. Runtime 连接 InMemoryTransport

4. 外部 Producer 发送：

{
  "aceVersion": "0.1",
  "id": "evt_001",
  "sender": "build-service",
  "activation": "next_turn",
  "body": "Build failed for project foo."
}

5. ACE Runtime 接收消息

6. Validator 验证通过

7. ActivationResolver 得到：

next_turn

8. Dispatcher 将消息交给 PiAdapter

9. PiAdapter 将 body 注入 Agent Context

10. Pi Agent 开始下一次 Agent Turn

11. Agent 能够看到：

Build failed for project foo.
```

这条链路必须真实跑通。

---

# 37. 推荐实现顺序

不要同时实现所有东西。

严格按照下面顺序：

```text
Step 1
ACE Message
      ↓
Validator
```

↓

```text
Step 2
Activation
      ↓
ActivationResolver
```

↓

```text
Step 3
InMemoryTransport
```

↓

```text
Step 4
EventDispatcher
```

↓

```text
Step 5
AgentEngine interface
```

↓

```text
Step 6
PiAdapter
```

↓

```text
Step 7
Context Injection
```

↓

```text
Step 8
next_turn
```

↓

```text
Step 9
manual
```

↓

```text
Step 10
default
```

↓

```text
Step 11
immediate + idle Agent
```

↓

```text
Step 12
Integration Test
```

↓

```text
Step 13
Kafka/NATS Transport
```

↓

```text
Step 14
研究 running Agent 的 immediate interruption
```

---

# 38. 工程实现原则

这是第一版非常重要的部分。

## 原则 1：Protocol 与 Runtime 分离

不要：

```text
Pi Code
 └── ACE logic
```

而应该：

```text
ACE Runtime
 └── Pi Adapter
       └── Pi
```

---

## 原则 2：Transport 与 ACE 分离

不要让：

```text
Kafka
```

成为 ACE Protocol 的一部分。

应该：

```text
Transport
   ↓
Raw Message
   ↓
ACE Runtime
```

---

## 原则 3：ACE 不理解 Body

Runtime 不应该解析：

```text
body
```

内部业务语义。

---

## 原则 4：不要提前抽象

如果某个 abstraction：

```text
当前没有第二个实现
当前没有第二个调用场景
```

优先不要创建。

---

## 原则 5：优先跑通链路

第一版最重要的不是：

```text
代码漂亮
抽象完整
插件化
分布式
```

而是：

```text
External Event
   ↓
ACE
   ↓
Pi Context
   ↓
Agent Turn
```

真实跑通。

---

# 39. 给实现 AI 的特别要求

实现时不要自行扩大 ACE 0.1 的协议范围。

如果发现某个问题 RFC 没有定义：

1. 先判断它是不是 Runtime 实现问题。
2. 如果是 Runtime 问题，在 Runtime 内解决。
3. 不要为了方便修改 ACE Protocol。
4. 不要自动增加新的 ACE Message 字段。
5. 不要自动增加新的抽象。
6. 不要为了未来需求实现分布式能力。

特别是不要自行加入：

```text
contextId
target
stream
topic
subscription
binding
result
ack
priority
timestamp
metadata
eventType
```

除非实现过程中发现确实存在无法通过 Runtime/Transport 解决的协议级问题。

如果确实发现 RFC 0.1 存在问题：

```text
记录问题
说明原因
提出最小修改建议
```

不要直接修改协议。

---

# 40. 最终架构边界

第一版完成后，代码应该大致体现下面这个关系：

```text
┌─────────────────────────────────────────────┐
│                External World               │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│                  Transport                  │
│             Kafka / NATS / Memory           │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│                ACE Runtime                  │
│                                             │
│   Parse → Validate → Resolve → Dispatch    │
│                                             │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│                Agent Adapter                │
│                                             │
│                 PiAdapter                   │
│                                             │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│                    Pi                      │
│                                             │
│              Agent Session                  │
│                    │                        │
│                 Context                    │
│                    │                        │
│                Agent Loop                  │
│                    │                        │
│                   LLM                      │
└─────────────────────────────────────────────┘
```

其中最重要的边界是：

```text
ACE Protocol
     ≠
ACE Runtime
     ≠
Transport
     ≠
Pi Agent Engine
```

第一版只需要把这四层之间的边界建立起来。

---

# 41. 第一版最终目标

ACE 0.1 的第一个实现不应该试图证明 ACE 可以构建一个完整的 Agent 网络。

它只需要证明一个非常核心的事情：

> **一个原本只能主动获取外部信息的 Agent，现在可以被外部世界主动推送信息，并让这些信息进入 Agent Context，进而驱动 Agent 的后续 reasoning。**

最小成功案例：

```text
Build System
     │
     │ "Build failed"
     ▼
ACE Runtime
     │
     ▼
Pi Agent Context
     │
     ▼
Agent
     │
     ▼
"Build failed. I should inspect the build logs."
```

当这条链路真实运行起来之后，再进入：

```text
immediate interruption
       ↓
persistent delivery
       ↓
multi-agent
       ↓
agent discovery
       ↓
dynamic routing
       ↓
distributed runtime
```

不要反过来。

---

# 41.1 实现现状（2026-10-04）

阶梯的逐级状态，以及本文发布之后实现中新增的机制。细节见
[`ace-runtime-contracts.md`](ace-runtime-contracts.md)。

| 阶梯 | 状态 | 说明 |
|---|---|---|
| immediate interruption | ✅ | 运行中 `steer` 抢占，idle 起 turn；打断时机由宿主的 `interruptMode` 决定 |
| persistent delivery | 🟡 部分 | 成功才 ack、PEL 重投、死信落盘、突发落盘；**未做**：backlog 重放（消费组从队尾起）、持久化去重 |
| multi-agent | ✅ | 两个会话互发已验证；发布时盖章 `sessionId`（RFC §5.4） |
| agent discovery | ✅ 基础版 | `registry` + `ace_agents` + 按 member 发布（本文未涵盖；RFC §22 第 1 项） |
| dynamic routing | 🟡 部分 | 按 member / 唯一前缀寻址已做；能力广告与多副本挑选未做 |
| distributed runtime | ❌ | 多 broker、多集群未涉及 |

本文未写、实现中新增的机制：

1. **确认点后移**：注入后要等事件文本真的出现在会话里才 ack（oh-my-pi 上 idle 的 `steer`/`followUp` 只入队、不会自排空），超时不 ack、留 PEL 重投。
2. **突发落盘 + 摘要**：超过阈值的窗口写 JSONL，只注入一条摘要事件。
3. **死信文件**：超过 `reclaimAttempts` 先写 `dead-letter.<ts>.jsonl`（fsync）再 ack；写失败则不 ack。
4. **Agent 目录**：`ZSet`（在线）+ `Hash`（档案）+ 每会话独占 `Stream`（收件箱），心跳续期，读路径清扫崩溃残留。
5. **子代理门控**：oh-my-pi 会把扩展重绑到它 spawn 的每个会话，因此只在 `ctx.agent.kind === "main"` 时注册与订阅。
6. **验证资产**：`npm run verify:live`（真 broker，9 场景）、`npm run verify:omp`（真 oh-my-pi 会话，2 场景）、CI 跑 test/check/build/verify:live。

---

# 42. 给 Code Agent 的执行指令

你现在负责实现 ACE 0.1 MVP。

请遵循以下原则：

1. 先阅读 `ACE-RFC-Draft-0.1.md`。
2. RFC 是协议语义的最高依据。
3. 使用 Pi / pi-coding-agent 作为 Agent Engine。
4. 不修改 Pi 核心源码。
5. 通过 Pi 官方公开接口实现 Adapter。
6. 先实现 InMemoryTransport。
7. 先跑通 `next_turn`。
8. 再实现 `manual` 和 `default`。
9. `immediate` 第一阶段只要求 idle Agent 能工作。
10. 不提前实现复杂 interruption。
11. 不实现 Agent Registry。
12. 不实现动态 Target。
13. 不实现 ACE Stream。
14. 不实现 Binding。
15. 不实现 Result Event。
16. 不实现标准 ACK API。
17. 不实现持久化 Event Store。
18. 不增加 RFC 中没有定义的 ACE 字段。
19. 所有新增抽象必须有明确的当前使用场景。
20. 优先保证代码简单、可读、可测试。

实现过程中，如果发现 RFC 与 Pi 实际 API 存在冲突：

```text
不要擅自修改 RFC。
```

先记录：

```text
问题
当前 Pi API
冲突原因
建议方案
```

然后继续采用最小 Runtime 层解决。

第一阶段的最终验收条件只有一个：

```text
External Event
    ↓
ACE Message
    ↓
ACE Runtime
    ↓
Pi Context
    ↓
Pi Agent Turn
    ↓
Agent 能够看到并处理外部事件
```

这条链路必须真实运行，而不是只存在于 mock 或单元测试中。