---
title: "ACE — Agent Context Event Protocol"
subtitle: "RFC Draft / Working Document"
date: "2026-10-03"
status: "Draft"
version: "0.1-draft"
---

# ACE — Agent Context Event Protocol

> **Events in. Context updated. Agents awake.**

## 1. 文档状态

本文档是 ACE（Agent Context Event Protocol）0.1 的工作草案。

ACE 定义一种面向 Agent 的事件消息格式，以及外部事件进入 Agent Context 后的最小激活语义。

- **版本：** 0.1-draft
- **状态：** Working Draft
- **最后更新：** 2026-10-03
- **核心目标：** 让外界信息能够主动进入 Agent Context，并根据消息语义驱动 Agent 继续工作。
- **核心组成：**
  1. ACE Message Format
  2. Activation Semantics
- **基础设施：** ACE 可以建立在 Kafka、NATS、RabbitMQ、Redis Streams 等已有消息基础设施之上。

---

# 2. ACE 解决什么问题

Agent 获取信息的方式，通常可以概括为两类：

```text
                    Agent
                      │
          ┌───────────┴───────────┐
          │                       │
          ▼                       ▼
     用户主动输入            Agent 主动获取
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
                   Tool      MCP       Skill
```

这些方式的共同特点是：

> **Agent 主动发起信息获取。**

例如：

- 用户发送一条消息；
- Agent 调用 MCP Tool 查询数据库；
- Agent 调用 API 获取天气；
- Agent 使用 Skill 读取文件；
- Agent 主动查询某个外部系统。

但是现实世界中还有另一类信息：

```text
外部世界
   │
   │ 事件发生
   ▼
External Event
   │
   │ 主动进入
   ▼
Agent Context
   │
   ▼
Agent Loop
```

例如：

- CI 构建完成；
- Git 仓库收到新的 Commit；
- 服务发生故障；
- 数据库发生变化；
- 用户在另一个系统完成某项操作；
- 定时任务产生结果；
- 另一个 Agent 发送消息；
- 外部设备产生传感器事件。

这些信息并不需要等待 Agent 主动调用工具去查询。

ACE 解决的核心问题就是：

> **如何让外部事件成为 Agent Context 的主动输入，并定义该输入何时以及如何激活 Agent。**

因此，ACE 关注的是 Agent 的 **Information Ingress**：

```text
                Agent Information Input
                         │
            ┌────────────┴────────────┐
            │                         │
            ▼                         ▼
       Active Input              Passive Input
            │                         │
      User / Tool / MCP          External Event
      / Skill / API                    │
                                      ▼
                                     ACE
                                      │
                                      ▼
                               Agent Context
```

ACE 并不是为了解决消息队列本身的问题。

消息队列只是实现“外界信息主动进入 Agent”的一种基础设施。

---

# 3. 核心设计思想

## 3.1 ACE 是 Agent Event Message Protocol

ACE 的核心不是重新设计一套消息系统，而是定义：

```text
External Event
      ↓
ACE Message
      ↓
Agent Context
      ↓
Activation
      ↓
Agent Loop
```

ACE Message 负责携带：

- 消息来自哪个 Agent；
- 当前是哪一条消息；
- 消息采用哪个 ACE 版本；
- 消息希望如何激活 Agent；
- Agent 实际需要接收的消息本体。

---

## 3.2 三层消息模型

ACE Message 相关信息分为三个层次：

```text
┌────────────────────────────────────────────┐
│ Layer 3 — Agent Message Body              │
│                                            │
│ Agent 自己定义的消息内容                   │
│ ACE 0.1：String                            │
├────────────────────────────────────────────┤
│ Layer 2 — ACE Protocol                    │
│                                            │
│ aceVersion / id / sender / activation     │
├────────────────────────────────────────────┤
│ Layer 1 — MQ Metadata                     │
│                                            │
│ Topic / Queue / Subject / Routing Key     │
│ Partition / Offset / Consumer Group ...   │
└────────────────────────────────────────────┘
```

这三个层次分别回答三个不同的问题：

| 层次 | 回答的问题 |
|---|---|
| MQ Layer | 消息通过什么基础设施到达？ |
| ACE Layer | 这条 Agent Message 是什么、来自谁、如何激活？ |
| Agent Layer | Agent 实际需要理解的内容是什么？ |

---

# 4. MQ Layer

MQ Layer 是承载 ACE Message 的基础设施层。

不同消息系统已经定义了自己的消息地址、路由和投递模型。

例如：

| Infrastructure | 典型元数据 |
|---|---|
| Kafka | Topic, Partition, Offset, Consumer Group |
| RabbitMQ | Exchange, Queue, Routing Key, Delivery Tag |
| NATS | Subject, Queue Group, Message Metadata |
| Redis Streams | Stream, Consumer Group, Entry ID |

这些信息用于：

- 确定消息进入哪个消息通道；
- 确定消费者如何订阅；
- 确定消息如何路由；
- 确定消息如何被消费和确认。

ACE 使用这些已有基础设施承载 ACE Message。

MQ Metadata 与 ACE Message 是两个独立的层次。ACE 0.1 不要求 Kafka Header、RabbitMQ Header、NATS Metadata 或其他 Transport Metadata 映射为 ACE 字段；同样，ACE 字段也不要求映射到特定的 MQ Metadata。除非未来版本另行定义，否则二者保持独立。

## 4.1 通信目标由配置决定

ACE 0.1 中，Agent 所使用的通信目标由 Runtime 的配置决定。

例如：

```yaml
inputs:
  - name: build-events
    transport: kafka
    topic: build-events
    activation: default

  - name: deployment-events
    transport: nats
    subject: deployment.events
    activation: next_turn
```

这里：

```text
transport
topic
subject
```

属于 MQ Infrastructure Configuration。

Agent 不需要在消息中携带这些地址，也不需要在运行时通过推理决定底层 MQ 地址。

未来如果需要让 Agent 动态选择通信目标，可以在 ACE 后续版本中单独设计。

---

# 5. ACE Protocol Layer

ACE 0.1 定义一个最小的 ACE Envelope。

```json
{
  "aceVersion": "0.1",
  "id": "evt_123",
  "sender": "agent-A",
  "activation": "next_turn",
  "body": "Build failed for project foo."
}
```

其中 ACE Protocol Layer 定义：

| 字段 | 类型 | 必需 | 含义 |
|---|---|---:|---|
| `aceVersion` | string | 是 | ACE 协议版本 |
| `id` | string | 是 | 当前消息的标识 |
| `sender` | string | 是 | 发送方标识（名称承载会话含义，见 §5.4） |
| `activation` | string | 是 | 消息的激活语义 |
| `body` | string | 是 | Agent 实际需要接收的消息本体 |

ACE 0.1 的核心字段由以上字段组成，其中 `aceVersion` / `id` / `sender` / `activation` / `body` 为必需字段。

---

## 5.1 `aceVersion`

表示消息采用的 ACE Protocol Version。

```json
"aceVersion": "0.1"
```

它用于确定：

- Message Parser；
- Message Schema；
- Protocol Semantics；
- Compatibility Rules。

它不是 Agent Body 的业务版本。

---

## 5.2 `id`

`id` 表示当前 ACE Message 的标识。

它与 `sender` 的语义不同：

```text
sender
  ↓
哪个 Agent 发送？

id
  ↓
具体是哪一条消息？
```

ACE 0.1 不规定 ID 的具体生成算法。

以下方式均可以实现：

```text
UUID
ULID
Snowflake
数据库生成 ID
应用自定义 ID
```

ACE 使用 `(sender, id)` 作为消息标识组合：

```text
(sender=agent-A, id=123)
(sender=agent-B, id=123)
```

两条消息可以同时存在。

同一 Sender 在相关消息生命周期内不得重复使用相同的 `id`。ACE 0.1 不规定“相关消息生命周期”的具体保存时长，该范围由 Runtime 根据去重、幂等或基础设施能力自行决定。

---

## 5.3 `sender`

`sender` 表示发送该 ACE Message 的发送方标识（Sender Identifier）。

例如：

```json
"sender": "agent-ci"
```

发送方不要求必须是 Agent，也可以是 System、Service、Device 或其他能够产生 ACE Message 的实体。

ACE 0.1 将 Sender Identifier 表示为 String。其具体生成、注册和解析方式由部署环境决定。

ACE 0.1 不定义全局 Sender Registry，也不规定 Identifier 的生成算法。

---

## 5.4 会话含义由 `sender` 承载（无独立字段）

ACE **不定义会话标识字段**："哪一个会话 / 哪一个实例"由 `sender` 本身承载。发布端按约定取名 `<coding-agent>:<sessionId>`，因此 `sender` 同时回答"谁"和"哪一次会话"。

```text
(sender, id)   标识一条消息
sender         既标识发送方角色，也承载其会话含义
```

- **易变但自明**：新会话产生新的 `sender`；会话恢复后沿用同一 `sender`。接收方据此判断"对方上下文是否已变更"。
- **不是身份凭证**：与字段级身份一样，`sender` 是发送方**声称**的值，不得用于认证、授权或任何信任判定（认证属 §18 的基础设施职责）。
- **必须满足字符集约束**（见 §5.3 与 §12）：接收方会把它渲染进 Agent Context，控制字符/换行会破坏渲染结构。
- **不参与消息去重以外的语义**：去重仍以 `(sender, id)` 为准。

---

# 6. Agent Message Body

ACE 0.1 的 Agent Message Body 是一个 String。

例如：

```json
{
  "aceVersion": "0.1",
  "id": "evt_123",
  "sender": "agent-ci",
  "activation": "next_turn",
  "body": "Build failed for project foo at commit abc123."
}
```

ACE 不需要理解 Body 的业务语义。

Agent 可以直接使用自然语言：

```text
Build failed for project foo.
```

也可以把结构化内容编码成字符串：

```json
{
  "aceVersion": "0.1",
  "id": "evt_124",
  "sender": "agent-ci",
  "activation": "next_turn",
  "body": "{\"type\":\"build_failed\",\"project\":\"foo\",\"commit\":\"abc123\"}"
}
```

这里：

```json
{"type":"build_failed", ...}
```

属于 Agent/Application Layer。

ACE 不建立全局 Event Type Registry，也不要求不同 Agent 使用相同的 Body Schema。

这样可以保持 ACE Message 与 Agent 内部消息模型之间的边界：

```text
ACE
  │
  │ String
  ▼
Agent
  │
  │ Agent-defined interpretation
  ▼
Application Semantics
```

---

# 7. Activation Semantics

`activation` 描述外部消息进入 Agent Context 后，Agent Runtime 如何处理这条消息。

ACE 0.1 定义四种值：

```text
immediate
next_turn
manual
default
```

---

## 7.1 `immediate`

消息要求 Runtime 尽快获得处理机会，并可以启动一个新的 reasoning turn。

如果 Agent 当前正在推理，Runtime 可以中断当前 Turn，以便优先处理该消息。ACE 0.1 定义的是激活紧迫性，不定义具体的取消、抢占或状态恢复机制。

概念上：

```text
Agent Loop
    │
    │ reasoning...
    │
    ├───────────────┐
    │               │
    │          ACE immediate
    │               │
    ▼               ▼
Current Turn     Interrupt
                    │
                    ▼
              Process Message
                    │
                    ▼
                New Turn
```

ACE 只定义这种行为语义。

具体的：

- LLM cancellation；
- 部分输出处理；
- Tool 执行中断；
- Checkpoint 恢复；
- 当前 Turn 的状态处理；

由 Agent Runtime 实现。

---

## 7.2 `next_turn`

消息不要求打断当前 reasoning turn。

如果 Agent 当前正在推理：

```text
Current Turn
     │
     ▼
继续完成
     │
     ▼
Next Turn
     │
     ▼
处理 ACE Message
```

如果 Agent 当前处于 idle 状态，则 Runtime 可以直接启动新的 Turn。

当存在多条 `next_turn` 消息时，ACE 0.1 不规定消息必须一条消息对应一个 Turn，也不规定具体的排序、批处理或调度算法；这些属于 Runtime 的调度职责。

---

## 7.3 `manual`

Runtime 已经接收到消息，但不会因为该消息自动激活 Agent。

消息可以先被 Runtime 保留：

```text
ACE Message
    │
    ▼
Runtime
    │
    ├── Context 中暂不激活
    │
    └── 等待外部触发
```

何时处理消息由 Runtime 或用户控制。

ACE 0.1 不规定具体的人工确认或 Runtime 控制 API。

---

## 7.4 `default`

发送方不指定具体的激活行为。

```text
activation = default
```

表示：

> 激活行为由接收侧决定。

因此 `default` 是一个 delegation value，而不是一个固定的执行动作。

如果接收侧没有通过 Runtime Input Configuration 指定覆盖策略，且消息本身也是 `default`，ACE 0.1 的默认行为为 `next_turn`。

---

# 8. Activation Precedence

ACE Message 自身可以携带：

```json
"activation": "next_turn"
```

接收 Agent Runtime 的 Input Configuration 也可以为某个输入源定义激活策略：

```yaml
inputs:
  - name: build-events
    transport: kafka
    topic: build-events
    activation: immediate
```

这里的 `inputs` 是 Runtime Configuration，而不是 ACE Protocol 中定义的消息对象或通信抽象。

最终激活策略按以下顺序确定：

```text
Runtime Input Configuration activation != default
        │
        ▼
使用 Input Configuration activation

Input Configuration activation == default
        │
        ▼
Message activation != default
        │
        ▼
使用 Message activation

Message activation == default
        │
        ▼
使用 Runtime default activation
```

可以形式化为：

```text
if input.activation != default:
    effective = input.activation
else if message.activation != default:
    effective = message.activation
else:
    effective = runtime.defaultActivation
```

ACE 0.1 要求 `runtime.defaultActivation` 在未另行配置时为 `next_turn`。

因此，接收侧可以根据部署环境覆盖发送方给出的激活偏好。

例如：

```text
发送方：
    next_turn

Runtime Input Configuration：
    immediate
```

最终有效激活策略为：

```text
immediate
```

---

# 9. Agent Context Injection

ACE 的核心运行路径是：

```text
External Event
      │
      ▼
MQ Infrastructure
      │
      ▼
ACE Message
      │
      ▼
Agent Runtime
      │
      ├── Parse ACE Envelope
      ├── Read Agent Body
      └── Determine Activation
      │
      ▼
Agent Context
      │
      ▼
Agent Loop
      │
      ▼
LLM
```

当 ACE Message 被 Runtime 接受并按照其有效激活策略进入处理流程时，`body` 必须成为 Agent 后续推理可见的信息。

ACE 0.1 只规定这一最小语义，不规定 Agent Context 的内部数据结构。例如，Runtime 可以将 `body` 表示为一条 Context Message、事件记录、系统提示片段或其他内部结构。不同表示方式只要不改变消息内容的可见语义，都符合 ACE 0.1。

对于 `manual` 消息，`body` 在人工或 Runtime 后续激活之前不要求成为当前主动推理上下文的一部分。

ACE Message 进入哪个 Agent Context，由 Runtime 的输入配置决定。

ACE 0.1 不定义独立的 Context Routing 或消息订阅协议。Runtime 可以使用底层 MQ 自身的消费模型来确定消息进入哪个 Agent Runtime。

例如：

```text
Kafka Topic: build-events
          │
          ▼
Agent Runtime A
          │
          ▼
Agent A Context
```

另一个 Runtime 可以订阅同一个 Topic：

```text
Kafka Topic: build-events
          │
          ├──────────► Agent Runtime A
          │                  │
          │                  ▼
          │             Agent A Context
          │
          └──────────► Agent Runtime B
                             │
                             ▼
                        Agent B Context
```

ACE 本身不需要建立独立的 Context Routing 模型。

---

# 10. Runtime Configuration

ACE Protocol 与 Runtime Configuration 是两个不同层次。

```text
ACE Protocol
    │
    ▼
定义 ACE Message

Runtime Configuration
    │
    ▼
决定 Runtime 从哪里接收消息
以及接收后采用什么策略
```

例如：

```yaml
inputs:
  - name: build-events
    transport: kafka
    topic: build-events
    activation: next_turn

  - name: alerts
    transport: nats
    subject: alerts
    activation: immediate
```

配置中：

```text
transport
topic
subject
```

描述基础设施。

```text
activation
```

描述接收 Runtime 的激活策略。

ACE 0.1 不要求特定的配置文件名，也不要求 YAML/JSON 等具体配置格式。

---

# 11. Message Encoding

ACE 0.1 使用 JSON 表示 ACE Message。

最小合法消息：

```json
{
  "aceVersion": "0.1",
  "id": "evt_123",
  "sender": "agent-A",
  "activation": "next_turn",
  "body": "Build failed."
}
```

对应的逻辑结构：

```text
AceMessage {
    aceVersion: string
    id: string
    sender: string
    activation: Activation
    body: string
}

Activation =
    immediate
  | next_turn
  | manual
  | default
```

---

# 12. JSON Schema

ACE 0.1 的 JSON Schema：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ACE Message 0.1",
  "type": "object",
  "required": [
    "aceVersion",
    "id",
    "sender",
    "activation",
    "body"
  ],
  "properties": {
    "aceVersion": {
      "type": "string",
      "const": "0.1"
    },
    "id": {
      "type": "string",
      "minLength": 1
    },
    "sender": {
      "type": "string",
      "minLength": 1
    },
    "activation": {
      "type": "string",
      "enum": [
        "immediate",
        "next_turn",
        "manual",
        "default"
      ]
    },
    "body": {
      "type": "string"
    }
  },
  "additionalProperties": true
}
```

---

# 13. Message Conformance and Invalid Messages

一个数据对象只有在满足 ACE 0.1 JSON Schema，并且 `aceVersion` 为 `"0.1"` 时，才构成 ACE 0.1 Message。

以下情况均不构成合法的 ACE 0.1 Message：

- 缺少任何必需字段；
- 必需字段类型错误；
- `aceVersion` 不是 `"0.1"`；
- `activation` 不是 ACE 0.1 定义的枚举值；
- `id` 或 `sender` 为空字符串；
- `sender` 不满足字符集约束（含空格、换行或控制字符，或超过 128 字符）。

Runtime 对非法消息可以执行拒绝、记录、重试、隔离或其他错误处理，但这些行为不属于 ACE 0.1 Protocol Semantics。

---

# 14. Versioning

`aceVersion` 表示 ACE Protocol Version。

例如：

```json
"aceVersion": "0.1"
```

它用于确定：

```text
Message Format
Protocol Semantics
Compatibility Rules
```

ACE 0.1 属于 Draft / 0.x 阶段。

对于 ACE 0.1，只有 `aceVersion` 精确为 `"0.1"` 的消息才适用本 RFC 定义的 0.1 语义。

当 Runtime 收到无法识别或不支持的 ACE Version 时，不应将其自动视为 0.1，也不应自行猜测未知版本的协议语义。Runtime 可以拒绝该消息，或按照自身兼容/降级策略处理。

未来稳定版本可以进一步定义 Major / Minor Compatibility Rules。

---

# 15. Extensions

ACE 0.1 允许消息携带额外字段。

例如：

```json
{
  "aceVersion": "0.1",
  "id": "evt_123",
  "sender": "agent-A",
  "activation": "next_turn",
  "body": "hello",
  "futureField": "value"
}
```

未知字段默认忽略。

额外字段不会自动获得 ACE Standard Semantics。

当某个扩展需要成为跨实现的标准语义时，应在未来 ACE 版本中正式定义。

---

# 16. Message Lifecycle Boundary

ACE 0.1 需要区分消息传输与 Agent 内部处理生命周期。以下概念属于 Runtime 行为，而不是 ACE Message 的标准字段：

```text
received
injected
activated
processed
```

对于自动激活的消息，其基本关系可以理解为：

```text
received
   │
   ▼
injected / made available to Agent Context
   │
   ▼
activated
   │
   ▼
processed
```

`manual` 消息可以停留在 `received` 或 Runtime 自定义的保留状态，而不进入主动推理流程。上述顺序描述的是概念关系，不是 ACE 0.1 要求的固定状态机。

实际 Runtime 可以根据其架构合并、拆分或重新安排这些阶段。ACE 0.1 不定义对应的状态字段、时间戳、状态查询 API 或生命周期事件。

特别地：

- **received**：Runtime 已从承载基础设施获得消息。
- **injected**：消息的 `body` 已成为 Agent 后续推理可见的信息。
- **activated**：Runtime 已根据有效激活策略安排或启动相应的 Agent 处理。
- **processed**：Runtime 已完成对该消息的处理；具体完成标准由 Runtime 决定。

`received` 不等于 `processed`。消息被接收并不意味着 Agent 已经处理它。

---

# 17. Reliability

ACE Message 运行在已有消息基础设施之上。

因此实际消息处理可以使用基础设施提供的：

```text
Ack
Retry
Redelivery
Offset
Ordering
Durability
Replay
Consumer Group
Backpressure
```

ACE Message 的 `id` 可以被 Runtime 用于：

```text
Deduplication
Idempotency
Tracing
Runtime Correlation
```

但这些机制的具体实现属于 Runtime。

ACE 0.1 不改变底层消息基础设施的投递模型。

---

# 18. Security

`sender` 表示消息声明的发送方：

```json
"sender": "agent-A"
```

它是消息语义的一部分。

实际的：

```text
Authentication
Authorization
Encryption
Integrity
Key Management
Trust Management
```

可以由消息基础设施、Transport Security 或 Agent Runtime 提供。

ACE 0.1 的核心消息格式不依赖特定的身份认证体系。

---

# 19. Message Direction and Application Semantics

ACE Message 可以用于多种信息来源：

```text
System      → Agent
Service     → Agent
Device      → Agent
Agent       → Agent
Agent       → Service
```

ACE 不要求消息一定代表某一种业务语义。

例如：

```json
{
  "aceVersion": "0.1",
  "id": "evt_001",
  "sender": "agent-A",
  "activation": "next_turn",
  "body": "Please inspect the failed deployment."
}
```

也可以由 Agent 自己在 Body 中定义结构：

```json
{
  "aceVersion": "0.1",
  "id": "evt_002",
  "sender": "agent-A",
  "activation": "next_turn",
  "body": "{\"type\":\"deployment.failed\",\"deployment\":\"foo\"}"
}
```

这里的 `type` 是 Agent/Application Layer 的内容。

---

# 20. Complete Example

## 20.1 Runtime Configuration

```yaml
inputs:
  - name: build-events
    transport: kafka
    topic: build-events
    activation: default
```

## 20.2 MQ Metadata

Kafka 实际传输时可能具有：

```text
Topic: build-events
Partition: 2
Offset: 101
Consumer Group: coding-agent
```

这些属于 Kafka。

## 20.3 ACE Message

```json
{
  "aceVersion": "0.1",
  "id": "evt_123",
  "sender": "agent-ci",
  "activation": "next_turn",
  "body": "Build failed for project foo at commit abc123."
}
```

## 20.4 Runtime Processing

```text
Kafka
  │
  │ External Event
  ▼
Agent Runtime
  │
  ├── Receive ACE Message
  ├── Parse ACE Envelope
  ├── Read Agent Body
  ├── Determine Effective Activation
  │
  ▼
Agent Context
  │
  ▼
Agent Loop
  │
  ▼
LLM
```

最终：

```text
MQ
负责承载信息
     ↓
ACE
定义 Agent 能理解的最小事件消息与激活语义
     ↓
Agent Runtime
负责把信息进入 Context 并驱动 Agent
```

---

# 21. Design Decisions

ACE 0.1 当前核心设计：

| 项目 | 决定 |
|---|---|
| ACE 的核心问题 | 外界信息主动进入 Agent Context |
| 信息输入模型 | 支持 Passive / Event-driven Input |
| MQ 的角色 | 承载 ACE Message 的基础设施 |
| 通信目标 | Runtime 配置决定 |
| 动态目标选择 | Future Extension |
| 消息层次 | MQ / ACE / Agent 三层 |
| ACE Message 编码 | JSON |
| ACE Envelope | `aceVersion` / `id` / `sender` / `activation` |
| Agent Body | String |
| Body 语义 | Agent/Application 自己定义 |
| `type` | Agent Body 内容 |
| Message ID | `(sender, id)` |
| ID 生成算法 | 实现自行决定 |
| Sender | Sender Identifier |
| 会话含义 | 由 `sender` 承载（约定 `<coding-agent>:<sessionId>`）；无独立字段；不参与认证与去重 |
| Activation | `immediate` / `next_turn` / `manual` / `default` |
| Input Configuration Activation | 可以覆盖 Message Activation |
| Effective Activation | Input Configuration → Message → Runtime Default |
| Unknown Fields | 默认忽略 |
| Context | 由 Runtime 根据输入配置与底层消息消费模型决定 |
| Delivery | 使用底层消息基础设施能力 |
| JSON Schema | 0.1 定义 |
| Runtime Configuration | 独立于 ACE Message Format |
| Default Activation | 未配置时为 `next_turn` |
| Message Conformance | 必须符合 ACE 0.1 Schema 且 `aceVersion` 为 `0.1` |
| Message Lifecycle | Runtime 定义，不作为 ACE 标准字段 |

---

# 22. Future Extensions

ACE 0.1 的核心模型已经可以支持外部事件进入 Agent Context。

未来可以根据实际使用需求进一步研究：

1. **Agent Registration and Discovery**
   - 标准化 Agent 注册、发现与寻址机制。
   - 该能力不属于 ACE 0.1。

2. **Dynamic Target Selection**
   - 允许 Agent 在运行时选择通信目标。

3. **Agent Identity**
   - 标准化 Agent Identifier、认证和信任模型。

4. **Structured Agent Body**
   - 支持 JSON Object、Bytes 或其他结构化 Body。

5. **Correlation / Causation**
   - 标准化跨消息关系。

6. **CloudEvents Mapping**
   - 定义 ACE 与 CloudEvents 的映射。

7. **MQ Header Mapping**
   - 定义 ACE 字段与 Kafka / NATS / RabbitMQ 等 Header 的标准映射。

8. **Protocol Compatibility**
   - 定义稳定版本之后的 Major / Minor Compatibility Rules。

---

# 23. ACE 0.1 核心模型

ACE 最终可以浓缩为：

```text
                         External World
                              │
                              │ Event
                              ▼
                    ┌──────────────────┐
                    │ Existing MQ      │
                    │ Infrastructure   │
                    └────────┬─────────┘
                             │
                             │ ACE Message
                             ▼
              ┌─────────────────────────────┐
              │       ACE Protocol          │
              │                             │
              │ aceVersion                  │
              │ id                          │
              │ sender                      │
              │ activation                  │
              │                             │
              │ body: String                │
              └──────────────┬──────────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Agent Runtime   │
                    │                  │
                    │ Context Update   │
                    │ + Activation     │
                    └────────┬─────────┘
                             │
                             ▼
                       Agent Context
                             │
                             ▼
                        Agent Loop
                             │
                             ▼
                            LLM
```

ACE 的核心职责可以浓缩为两句话：

> **1. 定义外部事件进入 Agent 时携带的最小标准消息格式。**

> **2. 定义这条消息进入 Agent Context 后如何激活 Agent 的最小语义。**

因此，ACE 的价值不在于创造新的消息基础设施，而在于补上 Agent 信息输入模型中长期缺少的一条路径：

```text
用户输入 ────────────────► Agent Context
Agent Tool / MCP / Skill ─► Agent Context

外部事件 ── ACE ─────────► Agent Context
```

**ACE 让 Agent 不仅能够主动获取信息，也能够被外部世界主动提供信息。**
