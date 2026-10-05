# ACE 计划（决策记录 + 实施批次）

状态：**仅记录，未实施**。本轮只完善既有设施（见 §4）。
相关文件：`ace-contracts.ts`（协议）、`runtime-contracts.ts`（运行时/宿主契约）、`docs/ace-runtime-contracts.md`（逐条实现细节）。

## 1. 已定的决策（本次讨论）

### 1.1 拓扑真值来源：注册中心

- **Channel（含 dispatch/consume）与 Subscription 住注册中心**，本地 ACE 文件只留**部署信息**。
- 本地文件形状 = `LocalAceConfig`：`{ registry: { url, prefix? }, brokers: BrokerDescriptor[] }`。
  **现状（2026-10-05 核实）**：实现是 `{ username, servers }`（`schema/ace-config.schema.json`），每个 server 就是一个
  完整 ACE 域；下面的 `LocalAceConfig` 是将来把频道搬进注册中心时的形状，**尚未实施**。
- 端点（url/凭据）只在本地的 Broker 项里，**寻址不进本地文件、端点不进注册中心**；这条分工是 dispatch/consume
  能跨 kind 统一的前提。
- 协议层**不动**：0.1 的 `dispatch` / `consume` 本就是不透明的，改的只是实现侧的形状。

### 1.2 Broker 模型 —— **撤回（2026-10-05）**

> **本节不实施。** 实施后核实：代码是 **server 为中心** —— `.ace.json` 的 `servers` 就是一个完整 ACE 域
> （Redis + 成员目录 + 频道），`src/` 里没有任何 `Broker` / `BrokerKind` / `BrokerDescriptor`；而 `Transport`
> 是**真实存在且在用的线路接缝**（`src/transport/transport.ts`：`interface Transport { start, stop }`，每订阅一个实例，
> 实现有 `RedisStreamsTransport` + 测试用 `InMemoryTransport`，运行时只认 `Transport`、不认 Redis）。
> 只有一个成员的 `BrokerKind` 枚举 + 单一实现的 descriptor 属于**投机抽象**，而且会用第二个词盖掉已被约 21 个真实会话
> 验证过的 server 词汇（`servers=`、`<server>:` 前缀、`stored_on=`）。**保留两个概念**：**server** = 部署域（配置层），
> **transport** = 线路（实现层）。以下原文留档，将来真出现第二种 kind 时再取用。

- 概念从 `Transport` 改为 **`Broker`**：`BrokerId` = 本地**实例**名（`local-redis`），`BrokerKind` = **种类**。
- 本轮**只支持 `redis-streams`**；`nats-jetstream` / `kafka` / `mqtt` / 入站类 `http` / `file` 留在候选里，
  不进实现也不进类型（`BrokerKind` 单成员即此意）。`amqp` 因两段式寻址（exchange + routingKey）与统一写法
  不兼容，即便将来扩也不优先。
- 形状：`BrokerDescriptor`（`id` / `kind` / `url?` / `addressPrefix?` / `defaults?` / `options?`）、
  `Dispatch`（`address` / `field?` / `trim?`）、`Consume`（`address` / `group?` / `from?` / `field?` /
  `consumer?` / `count?` / `blockMs?` / `reclaimIdleMs?` / `reclaimAttempts?` /
  `retryDelayMs?` / `maxRetryDelayMs?`）、`PublishTarget`、`ChannelRecord`、`ChannelDraft`。
- 依据：四家客户端库（node-redis / KafkaJS / nats.js / MQTT.js）都把 API 分成**连接 / 写 / 读 / 控制面**四块，
  与上面一一对应（对照表见 `runtime-contracts.ts` §三 注释）。

### 1.3 默认值（减少 AI 的订阅/创建复杂度）

优先级：**内建默认 < `BrokerDescriptor.defaults` < 单条频道覆盖**。

| 字段 | 默认 | 理由 |
|---|---|---|
| `addressPrefix` | `ace:` | 由它 + 频道名派生出 `address` |
| `dispatch.address` / `consume.address` | `ace:<频道名>` | 唯一寻址来源；前缀避免撞键 |
| `dispatch.field` / `consume.field` | `message` | 传输配置：信封放 stream entry 的哪个字段，两侧必须一致 |
| `dispatch.trim` | `{ maxlen, approx, 10000 }` | 防流无限增长（**唯一的破坏性默认**，显式 `trim: null` 可关） |
| `consume.group` | 本 participant 名 | = 每订阅者独立组 = 广播 |
| `consume.from` | `latest`（`$`） | 组建立前的事件不投递 |
| `consume.consumer` | `ace-<pid>` | 组内消费者名 |
| `consume.count` / `blockMs` | 16 / 1000 | `XREADGROUP` 的 COUNT / BLOCK |
| `consume.reclaimIdleMs` / `reclaimAttempts` | 60000 / 3 | PEL 重投 |
| `consume.retryDelayMs` / `maxRetryDelayMs` | 200 / 5000 | 退避 |
| `BrokerDescriptor.url` | `redis://127.0.0.1:6379` | 本机默认 |

`field` 的含义：Redis Stream 每条 entry 是 field→value 表，整个 ACE 信封 JSON 塞进**一个**字段，字段名就是它。
两侧不一致时订阅侧读到"entry 缺该字段"，现有实现记 notice 后 **ack**（不重投）= 静默丢事件。

### 1.4 `ace_channel` 工具（一个工具、四个动作）

`action: "list" | "subscribe" | "unsubscribe" | "create"`；`name` 支持正则（`create` 必须精确名）；
`dryRun` 只回报将发生什么。`create` 时 `broker` 默认取配置里唯一那台，`dispatch` / `consume` 全有默认值。

### 1.5 配置解析：全局兜底（已实现 2026-10-05）

- **顺序（首命中胜、不合并）**：`$ACE_CONFIG` → `<cwd>/.ace.json` → **宿主提供的全局候选**。
- **宿主提供位置，核心提供机制**：核心不知道自己在哪个宿主里跑，`globalConfigPaths` 由宿主算（omp 用
  `omp config path` 的目录：`~/.omp/agent/ace.json`，XDG 时 `$XDG_CONFIG_HOME/omp/ace.json`；claude/codex 将来各自定）。
  核心的 host-neutral 边界测试新增一条：**中性模块里不得出现宿主的状态路径/环境变量**（宿主的名字作为字段取值如
  `codingAgent: "oh-my-pi"` 是允许的，位置不行）。
- **可见性**：实际生效的文件始终打印（启动行 + `/ace list` 的 `source`）；项目文件覆盖全局时，`warnings` 里明确写出被覆盖的文件 ✗→✓。
- **谁可以被覆盖**：全局文件可写 `"projectConfig": "ignore"` 钉住自己 ✗→✓（防止克隆来的仓库把会话指到别人的 broker）。
- 将来与 §1.1 的 `LocalAceConfig` 合流：全局文件放"注册中心连接 + Broker 列表（端点/凭据/默认值）"，频道与订阅进注册中心。

## 2. 待拍板（会直接改变实现，尚未决定）

1. **正则边界**：建议默认只允许精确名/前缀，正则需显式开启，正则下强制先 `dryRun`，并设命中上限。
2. **冷启动**：注册中心不可达或从未订阅过时可订阅集为空 —— 留"上次订阅集"快照，还是接受"重启后重新订阅"？
3. **所有权/权限**：谁能 `create`、能否覆盖同名、谁能删（建议 `owner` + 不可覆盖 + 审计）。无认证现状下是软约束。
> **第 4、5 条随 §1.2 一并不实施（2026-10-05）**：两条都长在已撤回的 `BrokerDescriptor.defaults` 上；
> 现行实现里 `REDIS_STREAMS_DEFAULTS` 是内建常量，**没有** `trim` 这个旋钮，也没有可改默认组语义的
> `defaults.consume.group`。原文留档。
4. **`trim` 默认的破坏性**：接受"默认修剪 10000 条"，还是默认不修剪？
5. **默认交付语义**：`group` 默认 = participant 名（广播）；若想默认同组瓜分，改 `defaults.consume.group` 即可。

## 3. 实施批次（依赖顺序）

1. ~~**两个宿主收口**~~ —— **已完成（2026-10-05）**：两个宿主都接上了 agent directory 自注册；各过一轮
   独立评审（Codex 2 major + 5 minor、Claude 2 major + 3 minor），缺陷全修并带回归测试；门禁与 live smoke
   全绿，已提交。**各自的现状与缺口记在包内文档**（本轮追加）：
   `packages/ace-claude-code/README.md`、`packages/ace-codex/README.md` 的
   **"Current state and open gaps"** 两节 —— Claude：清单缺 `mcpServers` 声明（channel 不注册时工具可能一起消失）；
   Codex：无工具面，且 app-server 协议形状待与官方文档对齐。
2. ~~**拆包**~~ —— **已完成（2026-10-05）**：Pi / oh-my-pi 宿主插件拆成 `packages/ace-omp`（`extensions/ace.ts` +
   `extensions/ace-manager.ts` + 宿主侧测试与 `scripts/verify-omp.ts`），核心 `packages/ace-runtime` 保持
   host-neutral（边界测试守着"核心 src 里不得出现任何 Pi import"；原 `src/agent/pi-adapter.ts` 已删除——
   无宿主执行它，omp 扩展实例化的是 `PiExtensionAdapter`）。扩展改为**只经 `ace-runtime`
   公共入口**消费核心（ace-omp 新增 `test/architecture/package-boundary.test.ts` 守这条）。CI 的 `hosts`
   矩阵加上 `ace-omp`，`verify:omp` 步骤随之迁移。
   命名只用一个包（`ace-omp`）覆盖 Pi 与 oh-my-pi——两者共用同一扩展；将来若宿主分化再拆 `ace-pi`。
3. **动态频道模型**：registry 承载频道目录与订阅关系；`ace_channel` 四动作；`Transport` → **可热插拔**
   （按订阅动态 start/stop，去重窗口、指标、pending、派生视图跟着订阅生命周期走）。
4. **工具 spec 下沉 + 跨宿主一致性测试** —— **本体已完成（2026-10-05）**：工具名（`ACE_TOOL_NAMES`）、
   描述与指引文本（`TOOL_TEXT`、`buildPublishToolText`）、参数 schema（`PUBLISH/AGENTS/CHANNELS_PARAMETERS`）
   以及所有面向模型的列表/报告格式化（`src/tools/listing.ts`：`describeDiscovered` / `describeEndpoint` /
   `formatChannelListing` / `channelListingInput` / `formatChannelReport`）都搬进了核心，并纳入 host-neutral
   边界测试；ace-omp 只剩**绑定**（展开核心 spec + `execute` + `pi.registerTool`），依赖因此清掉了
   `typebox` 与 `@earendil-works/pi-ai`。**剩余**：`ace-claude-code/src/tools.ts` 仍抄着一份文本 ✗ → 改为
   引用核心 spec（它经 vendor dist 消费；本次 `--write` 已把统一后的 dist 同步过去），并补跨宿主文本一致性测试。
   **绑定的硬事实（已取证）**：`oh-my-pi`/pi 有**原生工具 API**（`pi.registerTool`）；**Claude Code 与 Codex
   都没有原生工具扩展点** —— Claude 插件的组件全集（skills / commands / agents / hooks / mcpServers /
   lspServers / outputStyles / workflows / themes·monitors·evals / settings / channels）里只有 `mcpServers`
   能加"模型可调用的工具"；Codex 插件 = skills / app integrations / MCP servers（hooks 可拦 MCP 工具调用）。
   因此这两个宿主的工具面**只能**是 MCP。另需始终分清：**工具（出站）与 Channel（入站）是两条正交的轴** ——
   Claude 上两者恰好同源（同一个 MCP server），Codex 上则是 MCP 工具 + app-server 两套。
5. **迁移项**（`runtime-contracts.ts` §五）：删 `sessionId`、`ace_agents` → `ace_participants`、
   `config` → `dispatch`/`consume`、`body` 不透明化。
   ~~**`Transport` → `Broker` 改名**（代码、`.ace.json` 的键、工具文本、docs、两个宿主 README 一次改齐）~~
   —— **撤回（2026-10-05）**：见 §1.2。`Transport` 保留原名与"线路接缝"职责（它已在用：每订阅一个实例，
   `RedisStreamsTransport` + 测试用 `InMemoryTransport`），`server` 保留为配置域的词，不做这次改名。

## 4. 宿主侧工作（**暂停，只记录，不动手**）

> 决定（2026-10-05）：**当前只做 omp 插件**。下面这些留给以后，届时按序取用。

| 宿主 | 剩余事项 | 状态 |
|---|---|---|
| `ace-claude-code` | **工具 spec 引用**：已改为从 `ace-runtime` 取名字/描述/schema（`src/tools.ts` 只剩 `ace_pending`/`ace_activate` 的宿主专属文本）✓；跨宿主一致性测试 `test/tool-text-unity.test.ts`（含"源码里不得出现共享文本的字面量"）✓ | **已完成** |
| `ace-claude-code` | **解绑核心入口里的 Pi 适配器**：~~核心 `index` 仍 `export * from "./agent/pi-adapter.js"` → 消费者（claude/codex）被迫安装 Pi SDK~~ —— **已解决（2026-10-06）**：死掉的 `PiAdapter` 与 `QueuedEvent` 已删除，核心入口不再导出任何 Pi 适配器；承重的渲染/策略助手移到 `src/agent/event-rendering.ts`，`PiExtensionAdapter` 结构化地只依赖 `sendUserMessage` | **已完成** |
| `ace-claude-code` | 工具**结果与错误**的文案也归核心（`TOOL_ERROR_TEXT`、`formatPublishResult`、`deliveredChannel`/`deliveredMember`/`failedTarget`、`formatDiscoveredSessions`）；claude 侧的 `ace_pending`/`ace_activate`/`ace_channels`/`ace_publish` 结果文案仍是自己一份 ✗ → 改为引用 | 待做 |
| `ace-claude-code` | 清单加 `mcpServers` 条目（channel 不注册时工具仍可用）+ 真机验证同名 server 同时出现在两处 | 待做 |
| `ace-codex` | 补 **MCP 工具面**（现在无工具面，只能入站）；并**按官方参考对齐 app-server envelope**（我们记的形状与公开文档的 JSON-RPC 2.0 有出入） | 待做 |

**文本归属规则（本轮的判据）**：**模型能读到的文本 → 核心**（工具名/描述/指引/参数说明/工具结果/工具错误 —— 已全部下沉 ✓，这样机制一变只改一处 ✓）；**只有人看得到的输出**（`/ace` 命令的回显、用法行、补全候选、TUI 管理器）留在宿主 ✓。

**vendor 机制注意（已踩过）**：核心改一行 → 必须 `npm run build` → `node scripts/check-vendor-sync.ts --write`
（现在同时同步 `ace-claude-code` 与 `ace-omp` 两份拷贝，缺目录时会 bootstrap ✓）。两个消费方都是**自包含**的：
`ace-claude-code` 一直如此，`ace-omp` 在 2026-10-05 补上——因为 **omp 的扩展加载器解析不了指向"同级链接包"的 bare
`ace-runtime`**（同一探针显示 `redis`/`typebox` 能解析 ✓，所以问题出在"被链接的同级包"而不是 bare import 本身），
扩展于是改为经包内 `vendor/ace-runtime/dist/index.js` 相对导入；消费包还要自己声明 vendored 运行时的依赖
（`typebox`、`@earendil-works/pi-coding-agent`），`file:` 依赖不会替它装 ✗。

## 5. 现有设施的缺口（本轮要完善的）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| A | **CI 只覆盖 `ace-runtime`** | `.github/workflows/ci.yml` 只有一个 job；`ace-claude-code` / `ace-codex` 的 `check` / `test` 无人执行 | 宿主包里的坏测试（如 `this.calls`）能静默存活 |
| B | **根目录两份契约文件无门禁** | 仓库根部没有 `package.json`/工作区，`ace-contracts.ts` / `runtime-contracts.ts` 只能手工 `tsc` | 契约改动不会被拦住 |
| C | **runtime 的 vendor 快照无同步/校验** | `ace-claude-code` 依赖 `file:./vendor/ace-runtime`（只有 `dist`+`package.json`，**手工拷贝、无同步脚本、无标记**）；`ace-codex` 依赖 `file:../ace-runtime`（链工作区） | 一边手工、一边链接，改 runtime 后两边行为会静默分叉 |
| D | **Codex 桥评审缺失** | `CodexBridgeReview` aborted | 出口在无人复核的状态下被人重写 |

| E | **仓库根部没有工作区** | 根目录无 `package.json` / 锁文件，根部 `biome.json`、两份契约只能靠各包转调 | 新工具的落脚点不明确（本次用 `ace-runtime` 转调解决 B） |
| F | **没有 `ace-runtime` 导出面摘要** | 两个宿主各自为接线重读 6~8 次 `src` / vendor `.d.ts`（`.d.ts` 还被 read 工具截断，只能 `cat` 拿全文） | 每次都从 vendored 编译产物里考古 —— 两个子代理一半以上的耗时都在这里 |

**A、B 已在本次改动中修掉**：CI 新增 `hosts` job（bun + 两个宿主包矩阵，跑各自的 `check` / `test`）；
`ace-runtime` 的 `check` 链上新增 `check:contracts`（对根部两份契约跑 `tsc --strict`，CI 无需再加步骤）。
**C 完成**（`scripts/check-vendor-sync.ts`）：默认纯检查 —— 按 sha256 逐文件比 `packages/ace-runtime/dist` 与
vendor 的 `dist`、并比版本；`--write` 就地刷新（只拷贝不同的文件、删掉构建里已不存在的、同步版本字段）；
已接入 CI（`ace-runtime` job 的 `Build` 之后）。实测：基线 in sync ✓ → 人为造漂移被杀掉（exit 1）✓ →
`--write` 修回 ✓ → 再检查 in sync ✓ → 两侧 sha256 一致 ✓。
注意：`hosts` job 的实际结果要等两个子代理收口后才有意义 —— 它们正在改这两个包的代码与测试。

## 5. 派活前置件（本次已建）

- **`docs/ace-runtime-api.md`** —— `ace-runtime` 导出面单页摘要：传输接缝 / `AceRuntimeOptions` /
  `.ace.json` 形状 / 注册中心 `store`+`options`+命名派生 / 发现与寻址 / **装配与关闭顺序**。开头明确标注
  "对应今天的 `transport` + `config` 形状，不是计划里的 `Broker` + `dispatch`/`consume`"。
  **下次给宿主派活时直接附这一页**（缺口 F 的直接原因就是没有它）。
- 待办：把它改成**由脚本从 `dist/**/*.d.ts` 生成 + CI 校验**，免得手抄随代码漂移。
