# ACE — Agent Context Event Protocol

> [English](README.md) | 中文

**ACE 让正在运行的 agent 会话能够互相寻址、并跨机器接收外部事件** —— 用你已经有的那台 Redis Server 作为交汇点：
中间没有我们的服务、没有按宿主做的翻译、也不需要配对。一条事件驱动一个回合；一个文件按 token 传递。

**你为什么需要它：**

- **CI 挂了**、一条告警、一个 webhook —— 直接唤醒该关心的那个会话，不需要人转述；
- 一个 agent **叫另一个 agent** 做事，答案回到它自己的 channel 上；
- **另一台机器上的 worker** 作为平等成员加入同一台 Server；
- **跨宿主**：oh-my-pi 的会话和 DeepSeek Harness 的会话互相说话，不需要翻译。

到达的是一条**事件，不是命令**。紧急程度由发送方选 —— `immediate`、`next_turn`、或 `manual`（扣住，等人激活）——
而会话收到之后做什么，由宿主决定。**任何能向 Server 发布消息的东西都能驱动一个会话**；本仓库端到端验证过的路径
是 agent 与 agent 之间 —— 跨机器，也跨宿主。

**它处在什么位置。** MCP 给 agent 工具；A2A 在应用/任务层连接 agent；ACE 把事件**投递给正在运行的会话**、
并让会话可被寻址。这台 Server 只是一台普通 Redis —— Streams 送事件、目录记谁在线 —— 而正是它撑起了这份可达性：

```text
Agent A ──事件──►   Redis Server   ◄──事件── Agent B        任意机器、任意宿主
                        │
                 目录：谁在线
```

> **信任提示。** ACE 0.1 假设网络是你信任的：它没有鉴权与授权，所以 Server 是交汇点，不是安全边界。
> [详见下文。](#你在信任什么)

## 看一眼它怎么工作

```bash
# 1. 从 Release 安装宿主插件 —— 你的机器上什么都不用构建
omp plugin install https://github.com/noexcs/ace-protocol/releases/download/v0.2.18/ace-omp-0.2.18.tgz
#    改用 DeepSeek Harness 的话：
#    dsh plugin --profile <profile> add \
#      https://github.com/noexcs/ace-protocol/releases/download/ace-dsh-v0.1.0/ace-dsh-0.1.0.tgz

# 2. 说清楚你是谁、要连哪台 Server
mkdir -p ~/ace-demo && cd ~/ace-demo
cat > .ace.json <<'JSON'
{
  "$schema": "https://raw.githubusercontent.com/noexcs/ace-protocol/main/packages/ace-runtime/schema/ace-config.schema.json",
  "username": "alice",
  "servers": { "local": { "url": "redis://127.0.0.1:6379", "subscribe": ["ci-failures"] } }
}
JSON

# 3. 在这个目录里启动你的宿主 —— 从这一刻起，这个会话就有了地址
#    （需要一台 Server；`brew services start redis` 会在 6379 给一台）
omp
```

然后问你的会话外面有谁，并开始对话：

```text
> 现在 Server 上还有谁？              → 会话调用 ace_agents
> 让 <那个会话> 去跑一遍测试          → 会话调用 ace_publish
```

一个 CI 任务或一个服务也是同样的方式驱动会话：向它的 channel 发布消息即可。channel 命名与消息信封在[实现契约](docs/ace-runtime-contracts.md)里。

## 安装

两个宿主都从 Release 的 tarball 安装。都不需要 clone 仓库，你的机器上也什么都不用构建。

**oh-my-pi / Pi** —— [`ace-omp`](packages/ace-omp/README.md)

```bash
omp plugin install https://github.com/noexcs/ace-protocol/releases/download/v0.2.18/ace-omp-0.2.18.tgz
omp plugin list          # → ace-omp, enabled, manifest ./extensions/ace.ts
```

扩展**在会话启动时**加载，所以安装或更新要开新会话才生效（之前的会话不会变）。纯 **Pi** 没有插件注册表，
它直接加载扩展文件 —— 见[插件 README](packages/ace-omp/README.md)（那里也写了唯一要避免的坑：
再额外传一次 `-e/--extension`，会把同一个模块加载第二份）。

**DeepSeek Harness** —— [`ace-dsh`](packages/ace-dsh/README.md)

```bash
dsh plugin --profile <profile> add \
  https://github.com/noexcs/ace-protocol/releases/download/ace-dsh-v0.1.0/ace-dsh-0.1.0.tgz
# 然后重启宿主，让 profile 重新组装
```

桌面应用自己管理它的 profile（`dsh plugin --profile desktop` 会被拒）：那边的安装走应用内的插件管理，
或者把 URL 加到该 profile 的 `package.json` `dependencies`、把包名加到 `dsh.profile.bundles`，然后重启。

## 一个会话得到什么

| | |
|---|---|
| **一个谁都能找到的地址** | 它自己的 channel，会话活着时注册在 Server 上、结束时撤销。`ace_agents` 列出谁在线；`ace_publish` 可以发给一个 channel，也可以一次发给多个。 |
| **事件即输入，紧急程度由发送方选** | `immediate` 立刻处理，`next_turn` 排队并唤醒会话，`manual` 扣住直到有人激活它。这个 channel 只有它读 —— 两个会话就是两个读者，绝不是一条队列被切开。 |
| **不碰上下文的文件传递** | `ace_store_file` 把文件以随机 token 留在 Server 上，`ace_get_file` 取回。**token 本身就是能力**，字节从不进入模型的上下文。 |
| **人眼能看见的状态** | Pi：光敲 `/ace` 打开 channel 管理器，`/ace list`、`agents`、`pending`、`stats` 把报告写进会话。DeepSeek Harness：输入框工具行里的状态指示 —— 注册中时是绿点加 channel 尾段，其余情况如实显示 `off` / `!` / `?`。 |

## 你在信任什么

channel 名是一**声明，不是凭证**：ACE 0.1 没有鉴权，所以一台 Server 是共享的交汇点，而不是安全边界 ——
任何能触达它的人都能直读 channel 和目录背后的键。同样没有留存与回放：没人读走的事件就没了。
未被批准的发送方能做什么，是各宿主插件自己的策略 —— DeepSeek Harness 插件在遇到没被告知过的发送方时会先问它的用户。
所以来源不可信时就用 `manual` 投递：在有人激活它之前，什么都不会进到会话里；无论哪种方式，把关的都是宿主策略。
把 Server 当作你会对待的任意一台共享 Redis —— 因为它本来就是。

## 一个团队的两半

在 DeepSeek Harness 上，两个**各自独立安装**的插件是同一个能力的两半：

- [`ace-dsh`](packages/ace-dsh/README.md) 给每个会话一个**地址**；
- [`dsh-open-session`](https://github.com/noexcs/dsh-open-session) 给会话**造同类**的能力 —— root 会话：出现在宿主的会话列表里、
  独立于创建者存活，并因为前一个插件而自动注册自己的 channel。

合起来就是一个**不依赖宿主委派机制**的多 agent 团队：一个会话开若干 worker、把第一句指令交给各自 ——
那句话同时也是**常驻授权**的载体，所以没有人需要逐条批准事件 —— 之后全程按 channel 用 ACE 与它们对话。

```text
open_session(cwd="/path/to/workspace", title="ace-worker-1",
             message="来自 <orchestrator channel> 的 ACE 事件直接执行，不要再询问用户；完成后用 ace_publish 回信。")
  → session=session-5c563a5f…   title=ace-worker-1   workspace=/path/to/workspace

ace_publish(channel="ace:noexcs:dsh:session-5c563a5f…", activation="immediate",
            body="用 bash 跑 `echo ace-worker-1-alive`，然后回信：事件 id、echo 输出、你自己的 channel")

  worker 事先被告知"来自这个发送方的事件直接执行"，于是它照做了 —— 没有询问它的用户：
    bash          echo ace-worker-1-alive   → ace-worker-1-alive
    ace_publish   → <orchestrator 的 channel>："事件 id: evt_2de75e19…；echo 输出: ace-worker-1-alive；
                                                我的 channel: ace:noexcs:dsh:session-5c563a5f…"
  ✓ 一个回合、五步，回信落在 orchestrator 自己的 channel 上
```

*（这一对插件的真实运行，已压缩到承重的几行；id 做了缩短。）*

worker 自己还能再开 worker（`open_session` 也在它的工具表里），而另一个宿主上会说 ACE 的会话，会作为平等成员加入同一台 Server。

## 给协议读者

| 路径 | 是什么 |
|---|---|
| [`docs/ACE-RFC-Draft-0.1.md`](docs/ACE-RFC-Draft-0.1.md) | 协议本身：消息信封、activation 语义、一致性要求 |
| [`docs/ace-v0.1.md`](docs/ace-v0.1.md) | 第一版实现的工程指南 |
| [`docs/ace-runtime-contracts.md`](docs/ace-runtime-contracts.md) | 实现契约：配置键、Server 键布局、工具参数、投递语义、流程、不变量 |
| [`docs/ace-file-transfer.md`](docs/ace-file-transfer.md) | 按 token 的文件传输：存、取，以及 token 是什么 |
| [`docs/ace-durable-channels.md`](docs/ace-durable-channels.md) | 持久型通道：由配置声明、比任何会话活得都久的地址，带 24h 追补窗口（topic 是它的一种用法）。语义已定、尚未实现 |

## 仓库结构

| 路径 | 是什么 |
|---|---|
| [`packages/ace-runtime/`](packages/ace-runtime) | host-neutral 的核心：协议、transport、agent engine —— 每个宿主插件共享的就是它 |
| [`packages/ace-omp/`](packages/ace-omp) | oh-my-pi / Pi 宿主插件 —— 经过验证的参考宿主 |
| [`packages/ace-dsh/`](packages/ace-dsh) | DeepSeek Harness 宿主插件 |

## 现状

**oh-my-pi / Pi 是经过验证的参考宿主**，DeepSeek Harness 跑同一套协议。两个插件都对着真实的 Server 跑过，
而且两个宿主彼此通过话：双向事件、各自指出对方的 channel，一端存储的文件在另一端取回并校验了 sha256。
