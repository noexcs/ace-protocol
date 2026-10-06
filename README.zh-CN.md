# ACE — Agent Context Event Protocol

> [English](README.md) | 中文

外部事件 —— CI 结果、告警、其他 agent —— 作为 agent 上下文的**主动输入**，而不是需要 agent 自己去轮询的东西。

```text
外部世界 ──► Transport ──► ACE Runtime ──► Agent Engine ──► Agent Context ──► LLM
             (MQ 适配层)    parse → validate → resolve activation → dispatch
```

本仓库包含：协议草案、运行时实现，以及用来端到端验证这套设计的 Pi 集成。

| 路径 | 是什么 |
|---|---|
| [`docs/ACE-RFC-Draft-0.1.md`](docs/ACE-RFC-Draft-0.1.md) | 协议本身：消息信封、activation 语义、一致性要求 |
| [`docs/ace-v0.1.md`](docs/ace-v0.1.md) | 第一版实现的工程指南 |
| [`docs/ace-runtime-contracts.md`](docs/ace-runtime-contracts.md) | 实现契约：配置键、Redis 键布局、工具参数、投递语义、流程、不变量 |
| [`packages/ace-runtime/`](packages/ace-runtime) | 运行时：协议、transport、agent engine、Pi 扩展 |
| [`packages/ace-omp/`](packages/ace-omp) | oh-my-pi / Pi 宿主插件（参考宿主） |
| [`packages/ace-dsh/`](packages/ace-dsh) | DeepSeek Harness 宿主插件：同一套协议跑在第二个宿主上，核心一行未改 |
| [`oh-my-pi/`](oh-my-pi) | oh-my-pi 上游检出（已被 gitignore），用于对着源码做集成测试 |

## 现状

以 **Pi** 作为 agent engine 的可行性实验：一个外部事件抵达正在运行的 Pi 会话，驱动它跑一个回合（或按
`activation` 排队/延后），并且两个 Pi agent 能通过真实 broker 互相通信。**oh-my-pi / Pi 是经过验证的参考宿主** ——
插件是 [ace-omp](packages/ace-omp/README.md)；宿主边界见[运行时 README](packages/ace-runtime/README.md)。

现在有了第二个宿主：[`ace-dsh`](packages/ace-dsh/README.md) 把同一套协议跑进 **DeepSeek Harness**。它的进程同时承载多个会话，
所以运行时是**每个 agent 一个**、channel 随 agent 自己的生命周期注册与撤销、工具注册在 agent 作用域而不是全局。
核心一行未改：host-neutral 的模块本来就有这个缝（`AgentEngine`、`AgentRegistry`、`shutdownAce`），
它自己的测试覆盖了这层绑定（61 个测试、6 个构建产物场景、6 个浏览器半场景，外加 7 个对着真实 broker 的实盘场景）。
它已在一个 desktop profile 里运行，并做过**跨宿主**验证：一个 DSH 会话和一个 oh-my-pi 会话双向交换过事件、
各自指出对方的 channel，一端存储的文件在另一端取回并校验了 sha256。DSH 只读 live channel，所以 `.ace.json` 的
`subscribe`（持久化 channel）在那边只被报告、不被读取。

2026-10-06 验证：520 个测试通过、0 失败 —— 其中 481 个在 host-neutral 核心里（31 个测试文件），
39 个在 ace-omp 宿主插件里（3 个测试文件）。

`packages/ace-runtime` 的 `npm run verify:live` 覆盖 12 个对着真实 Redis Streams broker 的场景
（投递、poison 消息、投递失败后的 reclaim、去重、open inbound、manual 激活、突发缓冲、
agent 目录生命周期及其崩溃清扫、死信重放、按 channel 名直接发布）；**本机 9/12 通过**，
失败的三个（`valid event`、`poison message`、`reclaim after failure`，都报 `pending=1`）在
上一个 release 之前的提交上表现完全一致，所以不是这次引入的。`packages/ace-omp` 的 `npm run verify:omp`
覆盖真实 `omp --mode rpc` 会话里的 5 个场景（两个启动断言、系统提示里的策略抵达 provider 请求、
一个 `next_turn` 事件抵达对话并 settle、一个 `manual` 事件被保留而不启动回合）；4/5 通过，
失败的那个需要一个能正常作答的模型回合 —— 本机配置的 provider 不返回结果（`stopReason=error`）。

一个会话的 channel 就是它的地址：活着的会话注册以它 sender 命名的 channel，对端可以在 Redis 上的
**agent directory** 里找到它（RFC §22 第 1 条）。`ace_agents` 列出当前在线的 channel（它的 `agent` 过滤
匹配会话运行的 coding agent，来源是会话的自述），而 `ace_publish` 的 `channel` 接受一个 channel 名 ——
配置了多个服务器时，`<server>:<channel>` 前缀用来选定服务器，前缀按**配置中的名字**匹配，
即使那台服务器已经宕机也会因此失败、而不是往别处发 —— 也接受一个 channel 列表，把同一条事件一次发给多个对端
（每个名字必须是非空字符串）。发到本会话自己也读的 channel 上的事件会回到自己的上下文里，标记为 `self: yes`
—— 除非 activation 是 `manual`，那种情况它被存下来而不注入，也就是说回显遵循与任何投递相同的 activation 规则。
见[实现契约](docs/ace-runtime-contracts.md)。

文件在会话之间传递时**不进入任何模型的上下文**：`ace_store_file` 把本地文件存到本会话所在的每一台服务器上，
用一个随机 token 和 TTL，只报告副本落在哪里（`stored_on=`）以及实际的 `name=`、请求的 `ttl=` 和
`stored_at=`/`expires_at=` 时刻；`ace_get_file` 用那个 token 从自己有副本的第一台服务器取回，返回
`name=` 以及与 blob 元数据一致的 `stored_at=`/`expires_at=`，并写入隔离目录。**token 本身就是能力** ——
存储不发布任何事件，所以这行文本由模型自己转达。见[文件传输设计](docs/ace-file-transfer.md)。

## 快速开始

```bash
cd packages/ace-omp
npm install --ignore-scripts   # 链接 packages/ace-runtime 的核心（先构建一次：npm run build）

# 1. 说清楚你是谁、要连哪些服务器（本仓库根目录有一份可用示例）
cat > /tmp/ace-demo/.ace.json <<'JSON'
{
  "$schema": "/path/to/ace-protocol/packages/ace-runtime/schema/ace-config.schema.json",
  "username": "alice",
  "servers": { "local": { "url": "redis://127.0.0.1:6379", "subscribe": ["ci-failures"] } }
}
JSON

# 2. 用扩展启动 Pi（需要 broker；`brew services start redis` 会在 6379 给一个）
#    如果插件已经安装或链接过，就直接正常启动宿主 —— 对同一个文件再传一次
#    `--extension` 会把它加载两遍，重复的那份是惰性的，于是 `/ace` 命令会落到那个从未启动运行时的副本上。
cd /tmp/ace-demo && pi --extension /path/to/ace-protocol/packages/ace-omp/extensions/ace.ts

# 3. 在任何地方发布；channel 名决定了 stream <namespace>:ch:<channel>
redis-cli XADD ace:ch:ace:alice:ci-failures '*' message \
  '{"aceVersion":"0.1","id":"e1","sender":"ci","activation":"next_turn","body":"Build failed."}'
```

会话里，光敲 `/ace` 会打开 channel 管理器（一个可用方向键翻、`esc` 关的框式视图），而 `/ace list`、`agents`、
`stats`、`pending`、`help` 会把报告**写进会话记录** —— 你阅读时没有任何东西被挂起，它们像普通输出一样往回滚动，
报告跨回合仍然可见。`ace_publish` 按 channel 名把事件发给对端。[ace-omp 的 README](packages/ace-omp/README.md)
记录了 `.ace.json` 和 Pi 上的 activation 语义；[运行时 README](packages/ace-runtime/README.md) 记录了
transport、投递保证与当前的限制。

## 安装宿主插件

一套协议、一份 `.ace.json`、一个 broker：插件按宿主各一份，核心共享 —— 所以 Pi 上的会话和 DeepSeek Harness
上的会话可以直接对话，不需要任何翻译。

### Pi / oh-my-pi —— [`ace-omp`](packages/ace-omp/README.md)

```bash
omp plugin install https://github.com/noexcs/ace-protocol/releases/download/v0.2.18/ace-omp-0.2.18.tgz
omp plugin list          # → ace-omp, enabled, manifest ./extensions/ace.ts
```

tarball 自带 vendored 核心，所以安装机器上什么都不用构建。想从源码装则是：
先 `cd packages/ace-runtime && npm install && npm run build`，再在 `packages/ace-omp` 里
`node ../../scripts/check-vendor-sync.ts --write && omp plugin link "$PWD"`。

- 扩展是**在会话启动时**加载的，所以安装或更新要**开新会话**才生效。
- **只链接一次。** 不要对同一个文件再传 `-e/--extension`：同一个模块的两份副本会在一个会话里注册同一个命令和同一批工具。
  （扩展能识别这种重复并让第二份委托给第一份，但这个参数本身仍是一次毫无意义的重复加载。）
- 纯 **Pi** 没有插件注册表，在那边
  `pi --extension /path/to/ace-protocol/packages/ace-omp/extensions/ace.ts` 是唯一的路径 —— 而且和上面一样，
  传两遍是同一个错误。

**用法。** 五个工具 —— `ace_publish`、`ace_agents`、`ace_channels`（本会话读什么）、`ace_store_file`、
`ace_get_file` —— 外加一套命令面：光敲 `/ace` 打开 channel 管理器，而 `/ace list`、
`/ace agents [filter]`、`/ace pending`、`/ace activate <sender> <id>`、`/ace stats`、`/ace help`
把报告**写进会话记录**。配置是 `<cwd>/.ace.json`，回落顺序到 `~/.omp/agent/ace.json`
（或 `$XDG_CONFIG_HOME/omp` 下），`$ACE_CONFIG` 覆盖前两者。与 DSH 不同，这个宿主**也读持久化 channel**：
`.ace.json` 的 `subscribe` 用来命名 topic/service channel，会话会把它们和自己的收件箱一起读。
activation 有 `immediate`、`next_turn`、`manual`，默认值来自 `.ace.json`；`manual` 事件被保留（24 小时），
直到 `/ace activate` 注入某一条。

### DeepSeek Harness —— [`ace-dsh`](packages/ace-dsh/README.md)

```bash
# 任何由 CLI 管理的 profile：
dsh plugin --profile <profile> add \
  https://github.com/noexcs/ace-protocol/releases/download/ace-dsh-v0.1.0/ace-dsh-0.1.0.tgz
# 然后重启宿主，让 profile 重新组装
```

`lib/index.js` 已经打包过（vendored 核心被内联），所以 tarball 是自包含的。这个包声明了
`dsh.bundle.patch`，所以 profile 只需要这一个条目。

**桌面应用自己的 profile 由应用独占管理**（`dsh plugin --profile desktop` 会被拒），所以那边的安装走应用内的插件管理，
或者手工：把 tarball URL 加到 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies`、
把包名加到 `dsh.profile.bundles`，然后重启。想从源码装则是：在 `packages/ace-dsh` 里
`npm run sync:vendor && npm run build`，再 `dsh plugin --profile <profile> add file:$PWD/dist-package`。

**用法。** 每个 agent 一个运行时。会话活着的时候注册以它 sender 命名的 channel，结束时撤销 ——
所以任何地方都没有 `.ace.json` 的会话是完全惰性的：没有连接、没有地址、没有工具。六个工具：
`ace_publish`、`ace_agents`、`ace_store_file`、`ace_get_file`，加上这个宿主自己的两个
`ace_pending` 和 `ace_activate` —— 它们替代了 DSH 客户端会话无法派发的命令面。输入框工具行里有一个
**channel chip**：会话注册中时是绿点加 channel 尾段，其余情况如实显示 `off` / `!` / `?` 三种状态，
数据来自宿主半的 `GET /api/ace.status`。配置是 `<cwd>/.ace.json`，回落到 `$DSH_HOME/ace.json`
（`~/.dsh/ace.json`）。这个宿主**只读 live channel**：`subscribe` 条目会被报告并忽略。

### 不属于协议本身

`open_session` —— 一个宿主能力：打开一个新的 root 会话，可以带第一句话和标题 —— 有自己的仓库
[noexcs/dsh-open-session](https://github.com/noexcs/dsh-open-session)。它不依赖 ACE 的任何部分：
它是一个普通的 DSH 宿主插件，禁用 ACE 也照样工作。

## 开发

```bash
cd packages/ace-runtime      # host-neutral 的核心
npm test                     # 单元 + 集成测试；不需要 broker，也不需要凭据
npm run check                # biome + tsc --noEmit + 共享契约
npm run verify:live          # 对着真实 broker（redis-server）跑运行时；不需要模型
npm run build

cd ../ace-omp                # Pi / oh-my-pi 宿主插件
npm test                     # 插件自己的测试，对着构建好的核心
npm run check                # biome + tsc --noEmit + 共享契约
npm run verify:omp           # 在真实 oh-my-pi 会话里跑插件（需要 omp 和一个模型）
```

`pi/` 是上游 Pi 仓库的检出。测试跑在已发布的 `@earendil-works/*` 包（用户实际安装的那些构建）上；
这个检出的用途是阅读 Pi 的源码，以及跑 `docs/ace-v0.1.md` 里的双 agent 实盘实验。

ACE 最初是在 Pi 的 fork [`noexcs/pi`](https://github.com/noexcs/pi) 里开发的，分支 `ace-0.1-runtime`；
那个分支保留了开发历史，而代码现在住在这个仓库里（为什么从 fork 搬出来，见 `28fcff8` 提交）。
