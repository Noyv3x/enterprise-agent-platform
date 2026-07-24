# 配置参考

本文说明 Docker 部署后的配置所有权、来源和生命周期。部署方式见[部署](../operations/deployment.md)，目录位置见[数据布局](data-layout.md)。Run 策略见 [`runtime-policy.json`](../contracts/runtime-policy.json)，容器管理契约见 [`container-platform.json`](../contracts/container-platform.json)。

## 配置所有权

| 来源 | 所有者 | 用途 |
|---|---|---|
| `~/.config/ubitech-agent/manager.toml` | Manager | 公网监听、release channel、registry、数据根、更新轮询和 Docker 参数 |
| Manager secret 文件 | Manager | control/executor token 与 registry 凭据 |
| SQLite `settings` | Platform | 产品设置、OAuth、Telegram、模型、知识和可在管理界面更新的 secret |
| release manifest | CI / Manager | 源 commit、协议/数据库版本、Manager 校验和和镜像 digest |
| Manager 生成的容器环境 | Manager | 固定容器网络、mount、内部 endpoint、token file 和运行限制 |
| Agent scope metadata | Platform / Manager | 主 Agent identity、workspace 相对标识和 Sandbox 生命周期 |
| 浏览器 localStorage | React | 语言和主题等非安全界面偏好 |

配置没有一个跨所有字段的全局优先级。每个字段只能由表中所有者解析；容器环境是生成物，不能手改为第二套配置。

## Manager 配置

标准 TOML 字段：

```toml
data_root = "~/.local/share/ubitech-agent"
listen = "127.0.0.1:8080"
release_manifest_url = "https://example.invalid/ubitech-agent/main.json"
release_channel = "main"
update_enabled = true
update_interval = "5m"
sandbox_idle = "30m"
log_max_size = "20MiB"
log_max_files = 5
```

- `data_root` 是 Manager、Platform 数据和恢复备份的唯一宿主根；展开后必须为绝对、非符号链接、部署用户可写路径。Platform 数据目录固定为规范化后的 `$data_root/data`，Manager 的迁移、快照、Sandbox registry、容器环境和 Compose bind mount 必须全部使用该同一路径。`data_dir` 不是独立可配置项；为兼容曾写入该字段的配置，解析器只能接受其规范化后恰好等于 `$data_root/data`，任何分叉路径都必须在启动、preflight 或停止旧服务前 fail closed。
- `listen` 是唯一产品入口；生产反向代理连接此地址。Platform 容器端口由 Manager 动态选择，不单独配置公网监听。
- `release_manifest_url` 指向受信 main 通道清单；Manager 强制 HTTPS（仅测试允许回环 HTTP），并校验 schema、架构、commit、artifact SHA-256 和镜像 digest。首次源码迁移可以用 `install.sh --manifest-url` 绑定精确引导 release，但长期值由 `--channel-manifest-url` 或 `UBITECH_RELEASE_CHANNEL_MANIFEST_URL` 提供，不能持久化精确 commit URL。运行身份永远使用 digest，不使用 tag。
- `update_enabled` 与 `update_interval` 控制检测；手工 `check/update` 不绕过 manifest、任务空闲或快照门禁。
- `sandbox_idle` 默认值由机器契约生成；配置覆盖必须在受支持范围内，并同时作用于任务与后台进程判断。
- 日志限制应用于 Manager 文件日志和容器日志 driver；secret 与宿主执行原始凭据仍必须先脱敏。

Manager 配置修改通过临时文件、fsync 和原子替换保存。常驻进程只热加载明确声明可热更新的字段；listen、data root 和 control socket 变化需要 restart operation。

## 容器生成配置

Manager 为固定服务生成私有网络和下列路径：

- Platform 数据：容器 `/var/lib/ubitech-agent`，宿主 `$DATA_ROOT/data`；
- Runtime 状态：容器 `/var/lib/ubitech-agent/runtime`；
- Camoufox/SearXNG/Firecrawl：各自明确的 `$DATA_ROOT/data/runtimes/*` 子目录；
- Sandbox：`/workspace`、`/home/agent`、`/opt/agent-env`，分别映射主 Agent 的 workspace、home 和 env。

Platform 与 Runtime 内部 URL 使用 Compose service name，不接受部署用户提供的公网 base URL。内部 bearer 通过 owner-only token file 或 Docker secret 风格只读挂载传入，不能出现在 Compose 命令行、环境 dump 或 Manager 公共状态。Manager control 使用 `manager-token`，仅挂载给 Platform；Manager executor 使用独立的 `manager-executor-token`，仅挂载给 Runtime。宿主 CLI 从 Manager owner-only secret 读取 control token。两枚 token 即使共享同一个 owner-only Unix socket，也不能访问对方的路由集合。

Manager 配置只记录 control token file 路径，不接受 TOML 中的 `internal_token` 明文值。读取 capability 前必须先完成 owner、普通文件、非符号链接与 mode 校验。

固定服务镜像、网络别名、健康检查和数据库迁移入口由 release manifest 与 Manager 模板决定。管理界面不能写镜像 tag、任意 mount、capability、privileged、Docker socket 或容器 command。

## Platform 启动配置

Platform 容器接受 Manager 生成的最小环境：

- `ENTERPRISE_PLATFORM_DATA=/var/lib/ubitech-agent`；
- 内部监听 host/port、public base URL 和 trusted proxy；
- Agent Runtime、Camoufox、SearXNG 与 Firecrawl 的私有 service URL；
- 对应内部 token file；
- 媒体、HTTP/SSE 并发、附件配额、job lease、Cognee retry、Telegram delivery 与 schedule poll 等运行限制。

`ENTERPRISE_` 是现存环境前缀，不代表产品名称。它们是 Manager 到容器的内部兼容接口，不是生产部署的首选用户入口。新增字段必须先归属 Manager TOML、Platform SQLite 或 release manifest 之一。

若无管理员密码，Platform 生成随机密码并写入数据根的 owner-only bootstrap 文件。显式首次 bootstrap 值不覆盖已有账号。容器首次接管已有数据库时，数据库中已持久化的 session secret 优先于 Manager 新建文件，从而保留现有登录会话；新库才使用 Manager 文件并把值持久化。Agent tool token 与 Runtime token 属于当前容器 generation 的内部能力，Platform 启动时把 Manager 文件中的值原子同步到自己的 secret store，使 Platform 与 Runtime 不会因旧数据库残值使用不同 token。该同步不导出 OAuth、Telegram 或其它产品 secret。

## Platform 动态设置

### 平台与认证

- `platform_public_base_url`
- `platform_trusted_proxy`
- `platform_session_ttl_seconds`

public URL、trusted proxy 和 session TTL 可影响请求处理。公网 listen 和容器端口属于 Manager，不再由 Platform 设置或数据库生成 systemd unit。

### Runtime 与模型

- `agent_runtime_provider`
- `agent_runtime_model`
- `agent_runtime_idle_timeout_seconds`
- `agent_runtime_max_concurrency`
- `agent_runtime_compaction_threshold`

模型 provider 只接受受支持 OAuth 类型，model ID 必须来自 Runtime 实时目录。更新这些设置使用单一事务；需要 Runtime restart 时由 Platform 请求 Manager operation，不能自行启动 Node 进程。

### 知识与集成

Cognee backend、dataset 与内部设置由管理入口持久化。托管 Cognee/Firecrawl/SearXNG/Camoufox 始终来自 release manifest，不提供通过数据库切换源码 repo、任意 endpoint 或 command 的生产入口。Firecrawl API key、Cognee provider secret 和 Telegram secret仍由 Platform secret store 管理。

### Telegram 与自动更新

Telegram enabled、bot token、username、webhook secret 与 polling 仍属于 Platform。自动更新 enabled/interval/channel、当前/候选 generation 和 operation 则属于 Manager；Platform 只显示和提交受限 operation，不再保存 Git remote、branch、worktree 或 deploy command。旧部署已经保存的自动更新 webhook secret 可继续验证兼容 webhook，但验证成功后只能调用 Manager channel check，不能唤醒源码更新器；新部署以 Manager 轮询和管理界面手工检查为标准入口。

## Agent Runtime 环境

Manager 生成：

- `AGENT_RUNTIME_HOME`、内部 host/port 和 token file；
- Platform 内部 URL/token file；
- Manager executor socket/token file；
- approval/request body/cleanup/retention 与并发上限；
- `AGENT_RUNTIME_RUN_IDLE_TIMEOUT_MS`、`AGENT_RUNTIME_MAX_TURNS`、`AGENT_RUNTIME_TERMINAL_TIMEOUT_MS`；
- 容器固定 workspace/HOME/env 路径。

Run 空闲、模型轮次和 terminal 默认超时必须等于 `runtime-policy.json` 的生成值。Sandbox 空闲和 execution target 必须来自 `container-platform.json`。Runtime token 不能为空；健康检查也需要 token。

## Secret

Platform secret store保存 OAuth、session、Agent tool、Runtime、Firecrawl、Cognee、Telegram，以及迁移后仍需接受兼容更新 webhook 时的验证 secret。Manager secret目录保存 registry 凭据与彼此分离的 control/executor token。二者不得相互整库注入；Sandbox 不接收这些 secret。

`secret` 标志不等于静态加密。安全性依赖数据目录所有权和文件权限；界面不得宣称“加密存储”。secret 值不能进入文档、日志、Run metadata、release manifest、operation journal 或 Git。

## 首次源码迁移输入

桥接版本只迁移有明确所有权的有效配置，不把整个旧进程环境或 `deploy.env` 复制进容器。旧更新器把本次 handoff 实际使用的 data、service、host 和 port 原样交给安装器；SQLite 随数据迁移继续保存账号、OAuth、Telegram、模型、知识和其它 Platform 动态设置。Manager 为容器基础设施生成新的 capability 与 service 配置，不能让旧 source command、repo path 或任意环境覆盖镜像拓扑。

Manager 的公网 `listen` 保留旧监听地址，`legacy_platform_gate_url` 使用通配监听对应的回环地址；长期 `platform_gate_url` 仍指向容器 Platform。桥接源码服务仅在 `UBITECH_SOURCE_MIGRATION_BRIDGE=1` 时接受 `UBITECH_MANAGER_SOCKET` 与 `UBITECH_MANAGER_TOKEN_FILE`，二者必须是绝对路径且 token file 由 Manager owner-only 创建。缺任一字段均拒绝启动桥接控制面，不能降级为未认证内部接口。无法归属到上述字段或 SQLite 的旧 unit 环境只进入七天恢复包，不自动注入新容器。

若安装目标已经存在 `manager.toml`，安装器不得自行用 shell 提取或猜测字段，也不得静默沿用与本次源码桥输入不同的配置。它把桥接期望值交给下载并校验过的 Manager，由 Manager 正式解析器比较有效 `data_root`、`listen`、`release_manifest_url`、`release_channel`、`legacy_platform_gate_url` 和 `socket_path`；任一有效值为空或不一致均在安装 unit 和切换服务前失败。`socket_path` 同时承载 capability 分离的 control/executor API，因此必须等于桥接源码服务实际连接的路径。

迁移成功后删除旧 unit、源码 checkout 和源码内数据；这些环境变量不再由宿主 systemd 直接启动产品。桥接读取器只服务首次迁移，不得成为长期双配置兼容层。

## 变更规则

新增、删除或改变配置字段时，先修改本文和需要的机器可读契约，再同步解析器、持久设置、Manager API、容器模板、管理界面、敏感字段掩码和测试。只在 Dockerfile、环境变量或数据库中加入字段视为未完成变更。
