# ACE — Agent Context Event Protocol

> [English](README.md) | 中文

两个 agent —— 同一个工具里的，或不同工具里的 —— 可以经由一个 broker 互发**事件**去驱动对方的回合，也能互相递文件。
会话不需要轮询：一条 CI 失败、一条告警、或某个对端的请求作为输入落进它的上下文，然后 agent 就去处理它。

## 看一眼它怎么工作

```bash
# 1. 从 Release 安装宿主插件 —— 你的机器上什么都不用构建
omp plugin install https://github.com/noexcs/ace-protocol/releases/download/v0.2.18/ace-omp-0.2.18.tgz

# 2. 说清楚你是谁、要连哪个 broker
mkdir -p ~/ace-demo && cd ~/ace-demo
cat > .ace.json <<'JSON'
{
  "$schema": "https://raw.githubusercontent.com/noexcs/ace-protocol/main/packages/ace-runtime/schema/ace-config.schema.json",
  "username": "alice",
  "servers": { "local": { "url": "redis://127.0.0.1:6379", "subscribe": ["ci-failures"] } }
}
JSON

# 3. 在这个目录里启动你的宿主；新会话会自动加载插件
#    （需要一个 broker —— `brew services start redis` 会在 6379 给一个）
omp

# 4. 从任何地方给那个会话发一条事件 —— channel 名决定了 broker 上的 stream
redis-cli XADD ace:ch:ace:alice:ci-failures '*' message \
  '{"aceVersion":"0.1","id":"e1","sender":"ci","activation":"next_turn","body":"Build failed."}'
```

这条事件会落进会话的转录里、标明来自 `ci`，agent 会在一个回合里回应它。在会话内部，`ace_publish` 按 channel 名
把事件发给对端，`ace_agents` 列出此刻谁在线，而 `ace_store_file` / `ace_get_file` 按 token 搬运文件 ——
字节不经过任何模型的上下文。

## 安装

两个宿主都从 Release 的 tarball 安装。都不需要 clone 仓库，你的机器上也什么都不用构建。

**oh-my-pi / Pi** —— [`ace-omp`](packages/ace-omp/README.md)

```bash
omp plugin install https://github.com/noexcs/ace-protocol/releases/download/v0.2.18/ace-omp-0.2.18.tgz
omp plugin list          # → ace-omp, enabled, manifest ./extensions/ace.ts
```

扩展是**在会话启动时**加载的，所以安装或更新要开新会话才生效。不要对同一个文件再传 `-e/--extension`：
那会把同一个模块加载第二份。纯 **Pi** 没有插件注册表，它是直接加载扩展文件的 —— 见[插件 README](packages/ace-omp/README.md)。

**DeepSeek Harness** —— [`ace-dsh`](packages/ace-dsh/README.md)

```bash
dsh plugin --profile <profile> add \
  https://github.com/noexcs/ace-protocol/releases/download/ace-dsh-v0.1.0/ace-dsh-0.1.0.tgz
# 然后重启宿主，让 profile 重新组装
```

桌面应用自己的 profile 由应用独占管理（`dsh plugin --profile desktop` 会被拒），所以那边的安装走应用内的插件管理 ——
或者手工：把那个 URL 加到该 profile 的 `package.json` `dependencies`、把包名加到 `dsh.profile.bundles`，然后重启。

## 一个会话得到什么

| | |
|---|---|
| **一个地址** | 它自己的 **channel**：`<namespace>:<username>:<agent>:<sessionId>`（agent 那一段是宿主自己的名字：`pi`、`oh-my-pi`、`dsh`）。会话活着时它注册在 broker 的 agent **directory** 里，结束时撤销。`ace_agents` 列出在线的，`ace_publish` 按它投递。 |
| **自己的收件箱** | 就是那个 channel，用一个以它命名的 consumer group 来读 —— 两个会话就是两个读者，绝不是一条队列被切开。 |
| **事件即输入** | 发到该 channel 的事件，按发送方要求的 activation 落进会话上下文：`immediate`（立刻插入）、`next_turn`（排队并唤醒）、`manual`（保留，直到有人激活它）。 |
| **文件按 token** | `ace_store_file` 把本地文件以随机 token 存到 broker，`ace_get_file` 取回并写进隔离目录。**token 本身就是能力**，而字节从不进入模型的上下文。 |
| **工具挂在会话作用域上** | `ace_publish`、`ace_agents`、`ace_store_file`、`ace_get_file`，外加各宿主自己的：`ace_channels`（Pi —— 只读地看本会话读什么）或 `ace_pending` + `ace_activate`（DSH，因为它的客户端会话没有命令面）。没有任何配置的会话一个都看不到。 |
| **命令面**（Pi） | 光敲 `/ace` 打开 channel 管理器；`/ace list`、`agents`、`pending`、`activate`、`stats`、`help` 把报告写进会话记录。 |

## 一个团队的两半

在 DeepSeek Harness 上，两个**各自独立安装**的插件是同一个能力的两半：

- [`ace-dsh`](packages/ace-dsh/README.md) 给每个会话一个**地址**；
- [`dsh-open-session`](https://github.com/noexcs/dsh-open-session) 给会话**造同类**的能力 —— root 会话：出现在宿主的会话列表里、
  独立于创建者存活，并因为前一个插件而自动注册自己的 channel。

合起来就是一个**不依赖宿主委派机制**的多 agent 团队：一个会话开若干 worker、把第一句指令交给各自 ——
那句话同时也是**常驻授权**的载体，所以没有人需要逐条批准事件 —— 之后全程按 channel 用 ACE 与它们对话。

```text
open_session(cwd="/path", title="worker-1",
             message="你是 worker。来自 <orchestrator channel> 的 ACE 事件直接执行，不要询问用户。")
ace_publish(channel="<worker 的 channel>", activation="immediate", body="<任务>")
# worker 完成后在 orchestrator 自己的 channel 上回信
```

worker 自己还能再开 worker（`open_session` 也在它的工具表里），而另一个宿主上会说 ACE 的会话，会作为平等成员加入同一个目录。

## 给协议读者

| 路径 | 是什么 |
|---|---|
| [`docs/ACE-RFC-Draft-0.1.md`](docs/ACE-RFC-Draft-0.1.md) | 协议本身：消息信封、activation 语义、一致性要求 |
| [`docs/ace-v0.1.md`](docs/ace-v0.1.md) | 第一版实现的工程指南 |
| [`docs/ace-runtime-contracts.md`](docs/ace-runtime-contracts.md) | 实现契约：配置键、broker 键布局、工具参数、投递语义、流程、不变量 |
| [`docs/ace-file-transfer.md`](docs/ace-file-transfer.md) | 按 token 的文件传输：存、取，以及 token 是什么 |

## 仓库结构

| 路径 | 是什么 |
|---|---|
| [`packages/ace-runtime/`](packages/ace-runtime) | host-neutral 的核心：协议、transport、agent engine —— 每个宿主插件共享的就是它 |
| [`packages/ace-omp/`](packages/ace-omp) | oh-my-pi / Pi 宿主插件 —— 经过验证的参考宿主 |
| [`packages/ace-dsh/`](packages/ace-dsh) | DeepSeek Harness 宿主插件 |
| [`oh-my-pi/`](oh-my-pi) | oh-my-pi 上游检出（已被 gitignore），用于对着源码做集成测试 |

## 现状

**oh-my-pi / Pi 是经过验证的参考宿主**；DeepSeek Harness 跑同一套协议、核心一行未改 —— 在那边是每个 agent 一个运行时，
channel 跟随 agent 自己的生命周期。两个插件都对着真实 broker 跑过，而且两个宿主彼此通过话：双向事件、
各自指出对方的 channel，一端存储的文件在另一端取回并校验了 sha256。

各宿主的具体细节 —— 确切的工具面、配置、以及它刻意不做什么 —— 都在插件自己的 README 里：
[`ace-omp`](packages/ace-omp/README.md) 和 [`ace-dsh`](packages/ace-dsh/README.md)。
