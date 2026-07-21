# 配置参考

本文说明 ubitech agent 的配置来源、优先级和变更生命周期。部署方式见[部署](../operations/deployment.md)，目录位置见[数据布局](data-layout.md)。跨 Python 与 Node 的 Run 空闲、模型轮次和 terminal 默认超时契约见 [`runtime-policy.json`](../contracts/runtime-policy.json)；其它配置由本文列出，并由对应实现与测试校验。

## 配置来源

平台没有一个适用于所有字段的全局优先级。每类配置必须按其所有者解析：

| 来源 | 所有者 | 用途 |
|---|---|---|
| 进程环境与 CLI | `PlatformConfig` / deployment | 首次启动基线、目录、监听和托管服务默认值 |
| SQLite `settings` | Python 平台 | 管理界面可更新的产品设置与 secret |
| systemd unit 环境 | deployment | 根据数据目录中的持久设置生成下一代服务进程环境 |
| Agent Runtime 环境 | `PlatformRuntimeManager` | 由有效平台设置生成托管 Node sidecar 配置 |
| Cognee `.env` | Cognee bridge | Cognee 自身的 provider、存储与内部目录配置 |
| 浏览器 localStorage | React 前端 | 语言和主题等非安全界面偏好 |

`ENTERPRISE_` 是现存兼容性环境变量前缀，不代表产品名称。重命名这些键需要独立兼容迁移，不能只修改文档。

## 启动配置

### 平台与认证

- `ENTERPRISE_PLATFORM_DATA`：平台状态根目录。
- `ENTERPRISE_PLATFORM_HOST`、`ENTERPRISE_PLATFORM_PORT`：期望的公共监听地址。
- `ENTERPRISE_PUBLIC_BASE_URL`：生成 webhook/public URL、Secure Cookie 和同源校验的基准。
- `ENTERPRISE_TRUSTED_PROXY`：是否信任反向代理重建的转发头。
- `ENTERPRISE_SESSION_SECRET`、`ENTERPRISE_SESSION_TTL_SECONDS`：会话签名和生命周期。
- `ENTERPRISE_ADMIN_PASSWORD`：首次创建管理员时使用，不覆盖已有账号。
- `ENTERPRISE_ALLOW_DEFAULT_ADMIN_PASSWORD`：仅用于明确的本地开发启动。
- `ENTERPRISE_AGENT_TOOL_TOKEN`：Python 内部 Agent 工具 token 的首次配置回退。

如果没有管理员密码，平台生成随机密码并写入数据目录的受限 bootstrap 文件。显式 `ENTERPRISE_SESSION_SECRET` 始终优先；否则复用数据库中已保存的 secret，最后才生成并持久化新值。

### Agent Runtime

- `ENTERPRISE_MANAGE_AGENT_RUNTIME`：是否由平台管理 sidecar。
- `ENTERPRISE_AGENT_RUNTIME_URL`、`ENTERPRISE_AGENT_RUNTIME_TOKEN`、`ENTERPRISE_AGENT_RUNTIME_HOME`：endpoint、认证与状态根。
- `ENTERPRISE_AGENT_RUNTIME_PROVIDER`、`ENTERPRISE_AGENT_RUNTIME_MODEL`：首次默认选择。
- `ENTERPRISE_AGENT_RUNTIME_IDLE_TIMEOUT_SECONDS`：首次无进展策略；管理界面的持久设置可以覆盖。
- `ENTERPRISE_MAX_CONCURRENT_AGENT_RUNS`：Python 调度门的首次并发值。

模型 provider 只接受 Codex OAuth 和 Grok OAuth。模型 ID 必须来自 Runtime 当前目录，不能以环境变量绕过验证。

`ENTERPRISE_MANAGE_AGENT_RUNTIME`、外置 Runtime URL/token 由直接启动、`./deploy.sh foreground` 或外部进程管理器读取。当前标准 `./deploy.sh service` 和管理界面不提供切换外置 Runtime endpoint 的入口；该部署方式使用平台托管 Runtime。不要通过手改 SQLite 或生成的 systemd unit 模拟受支持配置。

### 知识与托管工具

- `ENTERPRISE_KB_BACKEND`：`local`、`hybrid` 或 `cognee`。
- `ENTERPRISE_COGNEE_REPO`、`ENTERPRISE_COGNEE_DATASET`、`ENTERPRISE_COGNEE_INGEST_BACKGROUND`、`ENTERPRISE_MANAGE_COGNEE`。
- `ENTERPRISE_MANAGE_CAMOFOX`、`ENTERPRISE_CAMOFOX_URL`、`ENTERPRISE_CAMOFOX_COMMAND`。
- `ENTERPRISE_MANAGE_FIRECRAWL`、`ENTERPRISE_FIRECRAWL_REPO`、`ENTERPRISE_FIRECRAWL_API_URL`、`ENTERPRISE_FIRECRAWL_COMMAND`。
- `FIRECRAWL_API_KEY`：外置 Firecrawl 的可选 bearer secret。标准 service 部署从平台 secret store 读取；环境变量是 foreground 或外部进程管理方式的回退。
- `ENTERPRISE_MANAGE_SEARXNG`、`ENTERPRISE_SEARXNG_API_URL`。
- `ENTERPRISE_RUNTIME_STARTUP_WAIT_SECONDS` 以及 SearXNG/Compose 的部署等待配置。

托管 endpoint 必须使用无内嵌凭据的数值回环地址；外置 SearXNG 仍受同一约束。外置 Agent Runtime 与 Firecrawl 可以使用无内嵌凭据的 HTTP(S) base URL，并分别通过 Runtime bearer 与 Firecrawl API key 认证；Camoufox 关闭托管后浏览器能力不可用。服务启动等待由部署配置解析，并由托管服务测试覆盖，不属于 Runtime 跨层契约。

外置 Firecrawl 的 managed 开关、URL 和 command 与外置 Runtime 一样，只是 foreground/外部进程管理模式的兼容配置；当前标准 `./deploy.sh service` 与管理界面使用托管 Firecrawl，不提供切换入口。`FIRECRAWL_API_KEY` 可以先保存在平台 secret store，供上述外置模式读取。

### Telegram 与自动更新

- `ENTERPRISE_TELEGRAM_ENABLED`、`ENTERPRISE_TELEGRAM_BOT_TOKEN`、`ENTERPRISE_TELEGRAM_BOT_USERNAME`、`ENTERPRISE_TELEGRAM_WEBHOOK_SECRET`、`ENTERPRISE_TELEGRAM_POLLING`。
- `ENTERPRISE_AUTO_UPDATE_ENABLED`、`ENTERPRISE_AUTO_UPDATE_INTERVAL_SECONDS`、`ENTERPRISE_AUTO_UPDATE_REMOTE`、`ENTERPRISE_AUTO_UPDATE_BRANCH`、`ENTERPRISE_AUTO_UPDATE_WEBHOOK_SECRET`。

这些值用于首次启动；管理界面保存后，数据库设置是运行中行为的主要来源。

### 容量与运维

平台还提供附件总量、账号/全局附件配额、上传速率、Agent job lease、Cognee 重试、Telegram delivery、schedule poll、HTTP 请求并发、SSE 并发、媒体根、部署模式、服务名、自动安装 Node/APT 等运维变量。

此类字段通常在模块加载或进程启动时解析，修改后需要重启。其合法范围和默认值由对应配置解析器与测试保持一致；只有 Run 空闲、模型轮次和 terminal 默认超时三项同时受 Runtime 跨层契约约束。

## 数据库动态设置

### 平台设置

- `platform_public_base_url`
- `platform_trusted_proxy`
- `platform_host`
- `platform_port`
- `platform_session_ttl_seconds`

public URL、trusted proxy 和 session TTL 可立即影响请求处理；host/port 保存为期望值，下一次部署根据数据库生成 systemd 环境并生效。session secret 轮换需要重启现有 signer。

### Runtime 设置

- `agent_runtime_manage`
- `agent_runtime_url`
- `agent_runtime_provider`
- `agent_runtime_model`
- `agent_runtime_idle_timeout_seconds`
- `agent_runtime_max_concurrency`
- `agent_runtime_compaction_threshold`

更新 Runtime 设置时使用单一事务。托管 Runtime 随后重启，Python client 和模型目录缓存一起刷新；Python 并发门在并发值变化时同步 resize。

当前受支持的管理界面只写 provider、model、idle timeout、max concurrency 和 compaction threshold。Runtime manager 仍能读取既有的 `agent_runtime_manage`、`agent_runtime_url` 行以保持内部兼容，但它们不是当前产品配置入口；不得依赖手工写数据库来设计部署。

### 集成设置

Cognee 的 backend、dataset 和内部配置由对应管理入口持久化。Runtime manager 保留读取既有 Camoufox/Firecrawl managed、repo、endpoint 和 command 设置的能力，但当前产品管理界面不写这些键。Telegram 和自动更新保存各自 enabled、polling/interval、remote/branch 等字段。

有效设置通常是“数据库非空值，否则 `PlatformConfig` 启动基线”。每个新增字段必须在实现和本参考中明确自己的回退方式，不得假设这一规则自动适用。

## Secret

以下 secret 保存在 SQLite `settings`，并用 `secret=1` 控制 API 展示：

- Codex OAuth access/refresh token；
- Grok OAuth access/refresh/id token；
- session secret；
- Agent tool token 与 Agent Runtime token；
- 外置 Firecrawl API key；
- Telegram bot/webhook secret；
- 自动更新 webhook secret。

一般 secret 读取是数据库优先、同名环境变量回退。systemd service 不把 secret 明文复制到 unit；应通过管理界面写入平台 secret store。session secret 和托管 Runtime token 存在明确的启动优先级例外，修改代码时必须保留对应测试。

`secret` 标志不等于静态加密。安全性依赖数据目录所有权和文件权限，详见[安全与信任边界](../design/security-and-trust.md)。不得把 secret 值写入文档、日志、Run metadata 或 Git。

## Cognee 内部配置

管理界面编辑 Cognee 内部字段时，平台原子更新 `$DATA/runtimes/cognee/.env`。该文件包含 LLM、Embedding、存储、关系/图/向量数据库、安全、抓取和可观测性配置。敏感字段在 API 中只返回 configured/masked 状态。

平台管理的 data、system、cache、logs 路径优先作为安全默认值；`.env` 中显式配置可以覆盖 Cognee 自身字段。此文件属于运行数据，不能提交。

## Agent Runtime 直接环境

托管 Runtime 使用以下配置族：

- `AGENT_RUNTIME_HOME`、`AGENT_RUNTIME_HOST`、`AGENT_RUNTIME_PORT`、`AGENT_RUNTIME_TOKEN` 或 `AGENT_RUNTIME_TOKEN_FILE`；
- `AGENT_PLATFORM_INTERNAL_URL`、`AGENT_PLATFORM_INTERNAL_TOKEN`；
- `AGENT_RUNTIME_APPROVAL_TIMEOUT_MS`、`AGENT_RUNTIME_RUN_RETENTION_MS`；
- `AGENT_RUNTIME_MAX_DELEGATION_DEPTH`、`AGENT_RUNTIME_MAX_DELEGATES`；
- `AGENT_RUNTIME_MAX_BODY_BYTES`、`AGENT_RUNTIME_REQUEST_BODY_TIMEOUT_MS`；
- `AGENT_RUNTIME_COMPACTION_THRESHOLD`；
- `AGENT_RUNTIME_RUN_IDLE_TIMEOUT_MS`、`AGENT_RUNTIME_MAX_TURNS`、`AGENT_RUNTIME_TERMINAL_TIMEOUT_MS`；
- `AGENT_RUNTIME_CLEANUP_GRACE_MS`、`AGENT_RUNTIME_MAX_CONCURRENCY`、`AGENT_RUNTIME_MAX_QUEUED_RUNS`。

托管模式下这些值由 Python 生成，运维不应同时维护第二套手写启动脚本。Runtime token 是必填项；空 token 不代表“仅本机免认证”。外置 Runtime 的运维者必须保证 Run 空闲、模型轮次和 terminal 默认超时与 [`runtime-policy.json`](../contracts/runtime-policy.json) 一致；其余字段按本参考及 Runtime 配置校验执行。

## 变更规则

新增、删除或改变配置字段时，先修改本文和需要的机器可读契约，再同步：解析器、持久设置、管理 API、前端表单、部署环境、敏感字段掩码和测试。只在代码中增加环境变量视为未完成变更。
