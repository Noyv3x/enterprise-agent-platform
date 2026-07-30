# 配置参考

本文说明 Docker 部署后的配置所有权、来源和生命周期。部署方式见[部署](../operations/deployment.md)，目录位置见[数据布局](data-layout.md)。Run 策略见 [`runtime-policy.json`](../contracts/runtime-policy.json)，容器管理契约见 [`container-platform.json`](../contracts/container-platform.json)。

Platform 只接受容器基线：`UBITECH_DEPLOYMENT_MODE` 必须显式为 `container`，Manager socket 与 token 文件必须是绝对路径。固定服务缺省地址使用 Compose DNS（`agent-runtime`、`camofox`、`searxng`、`firecrawl-api`）；产品代码不提供 development/source/宿主回环模式开关。

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
lan_enabled = false
lan_listen = "127.0.0.1:8081"
direct_access_cidrs = ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fd00::/8"]
trusted_ingress_cidrs = ["127.0.0.0/8", "::1/128"]
release_manifest_url = "https://example.invalid/ubitech-agent/main.json"
release_channel = "main"
update_enabled = true
update_interval = "5m"
sandbox_idle = "30m"
log_max_size = "20MiB"
log_max_files = 5
```

- `data_root` 是 Manager、Platform 数据和快照的唯一宿主根；展开后必须为绝对、非符号链接、部署用户可写路径。Platform 数据目录固定为规范化后的 `$data_root/data`，Manager 的 schema migration、快照、Sandbox registry、容器环境和 Compose bind mount 全部使用该路径。不存在独立 `data_dir` 配置。
- `listen` 是主产品入口；生产反向代理连接此地址。Platform 容器端口由 Manager 动态选择，不单独配置公网监听。可选 LAN listener 默认关闭；`lan_listen` 必须使用与主入口不冲突的独立端口，并只能绑定明确的私网或回环 IP，拒绝通配和公网 IP。启用时只接受 `direct_access_cidrs` 的真实远端地址，并推荐由局域网 TLS 反向代理访问。只有 `trusted_ingress_cidrs` 可以提供 forwarded headers，其它请求头会被 Manager 丢弃并重建。bind 地址不是 canonical public URL。
- `release_manifest_url` 指向受信 main 通道清单；Manager 强制 HTTPS（仅测试允许回环 HTTP），并校验 schema、架构、commit、artifact SHA-256 和镜像 digest。运行身份永远使用 digest，不使用 tag。
- `update_enabled` 与 `update_interval` 控制检测；手工 `check/update` 不绕过 manifest、任务空闲或快照门禁。
- `sandbox_idle` 默认值由机器契约生成；配置覆盖必须在受支持范围内，并同时作用于任务与后台进程判断。
- 日志限制应用于 Manager 文件日志和容器日志 driver；secret 与宿主执行原始凭据仍必须先脱敏。Manager 状态、operation 和 API 投影都必须使用明确的小型读取预算；提高客户端上限不能代替服务端限制诊断大小。

Manager 配置修改通过临时文件、fsync 和原子替换保存。`lan_enabled`、`lan_listen`、`direct_access_cidrs` 与 `trusted_ingress_cidrs` 由 Gateway 热收敛；Manager 先验证并绑定新监听，成功后才原子提交配置和替换旧监听。新监听无法绑定时保留原配置与原监听，主入口不受影响，并向管理员报告错误。其它常驻进程配置只热加载明确声明可热更新的字段；主 `listen`、data root 和 control socket 变化需要 restart operation。

## 容器生成配置

Manager 为固定服务生成私有网络和下列路径：

- Platform 数据：容器 `/var/lib/ubitech-agent`，宿主 `$DATA_ROOT/data`；
- Runtime 状态：容器 `/var/lib/ubitech-agent/runtime`；
- Camoufox/SearXNG/Firecrawl：各自明确的 `$DATA_ROOT/data/runtimes/*` 子目录；
- Sandbox：`/workspace`、`/home/agent`、`/opt/agent-env`，分别映射主 Agent 的 workspace、home 和 env。

Platform 额外接收只读的宿主数据根字符串，用于在当前 scope 的可信系统提示中计算工作区映射；它不能用该值访问宿主文件，不能写入数据库或公共状态，也不能接受模型覆盖。

Platform 的集成服务 URL 与 Runtime 的 Platform URL 使用 Compose service name，不接受部署用户提供的公网 base URL。Runtime 不直接接收 Camoufox、SearXNG、Firecrawl URL 或这些服务的 secret，相关工具统一回调 Platform。Platform 在容器模式下不暴露固定服务的 install/restart API；这些容器只由 Manager operation 管理。内部 bearer 通过 owner-only token file 或 Docker secret 风格只读挂载传入，不能出现在 Compose 命令行、环境 dump 或 Manager 公共状态。Manager control 使用 `manager-token`，仅挂载给 Platform；Manager executor 使用独立的 `manager-executor-token`，仅挂载给 Runtime。宿主 CLI 从 Manager owner-only secret 读取 control token。两枚 token 即使共享同一个 owner-only Unix socket，也不能访问对方的路由集合。

Manager 配置只记录 control token file 路径，不接受 TOML 中的 `internal_token` 明文值。读取 capability 前必须先完成 owner、普通文件、非符号链接与 mode 校验。

固定服务镜像、网络别名、健康检查和数据库迁移入口由 release manifest 与 Manager 模板决定。管理界面不能写镜像 tag、任意 mount、capability、privileged、Docker socket 或容器 command。

## Platform 启动配置

Platform 容器接受 Manager 生成的最小环境：

- `ENTERPRISE_PLATFORM_DATA=/var/lib/ubitech-agent`；
- 内部监听 host/port、public base URL 和 trusted proxy；
- Agent Runtime、Camoufox、SearXNG 与 Firecrawl 的私有 service URL；
- 对应内部 token file；
- 媒体、HTTP/SSE 并发、附件配额、job lease、Cognee retry、Telegram delivery 与 schedule poll 等运行限制；
- `ENTERPRISE_MAX_CONCURRENT_UPLOADS` 是独立于普通 HTTP worker 的上传并发上限，默认 `4`；`ENTERPRISE_UPLOAD_IDLE_TIMEOUT_SECONDS` 是相邻两次 socket 读取之间的空闲上限，默认 `120` 秒。它们都不构成上传总耗时上限。

`ENTERPRISE_` 是现存内部环境前缀，不代表产品名称。它们是 Manager 生成的容器启动接口，不是生产部署的用户配置入口。新增字段必须先归属 Manager TOML、Platform SQLite 或 release manifest 之一。

Platform 命令行只有当前容器入口使用的 `serve --host --port --data`、无业务 writer 的 `migrate --data`，以及明确的管理子命令。子命令必须显式提供；监听地址不提供隐藏别名；未知参数必须由参数解析器直接拒绝，不能静默映射到另一套启动接口。

若无管理员密码，Platform 生成随机密码并写入数据根的 owner-only bootstrap 文件。显式首次 bootstrap 值不覆盖已有账号。已有数据库使用其中持久化的 session secret；新库使用 Manager 文件并把值持久化。Agent tool token 与 Runtime token 属于当前容器 generation 的内部能力，Platform 启动时把 Manager 文件中的值原子同步到自己的 secret store。该同步不导出 OAuth、Telegram 或其它产品 secret。

## Platform 动态设置

### 平台与认证

- `platform_public_base_url`
- `platform_trusted_proxy`
- `platform_session_ttl_seconds`

public URL、trusted proxy 和 session TTL 可影响请求处理。公网 listen 和容器端口只属于 Manager，Platform 设置不能生成宿主 unit。

### Runtime 与模型

- `agent_runtime_provider`
- `agent_runtime_model`
- `agent_runtime_idle_timeout_seconds`
- `agent_runtime_max_concurrency`
- `agent_runtime_compaction_threshold`

模型 provider 只接受受支持 OAuth 类型，model ID 必须来自 Runtime 实时目录。更新这些设置使用单一事务并作用于后续 Run；固定 Runtime 容器的生命周期只属于 Manager，Platform 不因模型设置变化重启它。

### 知识与集成

Cognee backend、dataset 与内部设置由管理入口持久化。托管 Cognee/Firecrawl/SearXNG/Camoufox 始终来自 release manifest，不提供通过数据库切换源码 repo、任意 endpoint 或 command 的生产入口。Firecrawl API key、Cognee provider secret 和 Telegram secret仍由 Platform secret store 管理。

私人邮箱账户使用 IMAP/SMTP host、port、TLS 模式、用户名、启用状态、轮询间隔和收信唤醒开关；应用密码写入独立凭据行且 API 只返回 `credential_configured`。普通用户只能管理自己的账户。轮询间隔有服务端上下限，更新维护状态统一暂停轮询、投递与唤醒。

### Telegram 与自动更新

Telegram enabled、bot token、username、webhook secret 与 polling 属于 Platform。自动更新 enabled/interval/channel、current/target/previous generation 和 operation 属于 Manager；Platform 只显示状态并提交受限 operation，不能保存 Git remote、branch、worktree 或部署命令。Manager 轮询、管理界面和宿主 CLI 是更新入口。

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

Platform secret store 保存 OAuth、session、Agent tool、Runtime、Firecrawl、Cognee 和 Telegram secret。Manager secret 目录保存 registry 凭据与彼此分离的 control/executor token。二者不得相互整库注入；Sandbox 不接收这些 secret。

`secret` 标志不等于静态加密。安全性依赖数据目录所有权和文件权限；界面不得宣称“加密存储”。secret 值不能进入文档、日志、Run metadata、release manifest、operation journal 或 Git。

## 变更规则

新增、删除或改变配置字段时，先修改本文和需要的机器可读契约，再同步解析器、持久设置、Manager API、容器模板、管理界面、敏感字段掩码和测试。只在 Dockerfile、环境变量或数据库中加入字段视为未完成变更。
