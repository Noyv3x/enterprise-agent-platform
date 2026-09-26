# 配置参考

每个配置项只由它的所属方解析，没有全局的覆盖顺序。Manager 生成的环境变量不是用户配置。

## 配置所有权

| 所属方 | 内容 |
|---|---|
| Manager：`~/.config/agent-platform/manager.toml` 和密钥文件 | 监听地址、数据根目录、更新、Docker、日志和镜像仓库、control、executor |
| Platform SQLite | 产品设置、认证、品牌、OAuth、模型、Telegram、邮箱 |
| 发布清单、Manager 生成的环境、对话范围元数据 | commit、schema、镜像摘要、端点、挂载、token 文件、限制、Agent 身份和沙箱 |
| 浏览器 localStorage | 语言、主题等与安全无关的偏好 |

默认值和接口只以这些文件为准：[runtime-policy.json](../contracts/runtime-policy.json)、[容器契约](../contracts/container-platform.json)、[技术身份](../contracts/technical-profiles.json)、[Compose](../../containers/compose.yaml)。路径、数据库标记和现役迁移例外只看[数据布局](data-layout.md)。

## Manager 配置

常用的 TOML 键（完整解析见 [config.go](../../manager/internal/config/config.go)）：

- **根目录与入口**：`data_root`、`listen`。Platform 的数据固定在根目录下的 `data/`，没有 `data_dir` 键；容器端口由 Manager 选择；监听地址不是公开网址。
- **局域网**：`lan_enabled`、`lan_listen`、`direct_access_cidrs`、`trusted_ingress_cidrs`，默认关闭。
- **更新**：`release_manifest_url`、`release_channel`、`update_enabled`、`update_interval`，信任 main 分支。条件请求返回 304 时不创建候选版本，也不写盘。
- **限制**：`sandbox_idle`（任务和后台进程共同适用）、`log_max_size`、`log_max_files`（Manager 和容器日志轮转）。
- **权限令牌**：`internal_token_file`。TOML 里明文写 `internal_token` 会被拒绝。

保存与生效：

- 保存时写临时文件、落盘、原子替换。
- 局域网和 CIDR 设置先绑定新的监听，成功后才提交并替换；失败时保留旧配置和旧监听。
- 其它字段只有声明支持热加载的才会热加载；修改 listen、数据根目录或 control socket 需要重启。
- 目录、CIDR、密钥和有上限的脱敏诊断见[安全设计](../design/security-and-trust.md)；HTTPS、清单验证，以及手动更新也不能绕过的空闲和快照门，见[自动更新](../operations/auto-update.md)。

## 容器生成配置

- 镜像、挂载、能力、启动命令和服务生命周期由 Manager 独占，界面无法修改。
- 容器之间用 Compose DNS 通信，不用公网网址。Runtime 经过 Platform 调用集成，拿不到集成的端点或密钥。
- `manager-token`（给 Platform 和宿主机命令行）与 `manager-executor-token`（给 Runtime）相互独立；token 文件只读且只有属主可访问。两者共用一个 socket，但权限不同。校验、最小注入和防泄漏见[安全设计](../design/security-and-trust.md)。

## Platform 启动配置

完整的键和固定路径见 [Compose](../../containers/compose.yaml) 和 [PlatformConfig](../../enterprise-agent-platform/enterprise_agent_platform/config.py)。

- 必须显式设置 `AGENT_PLATFORM_TECHNICAL_PROFILE=agent-platform-v1` 和 `AGENT_PLATFORM_DEPLOYMENT_MODE=container`。`AGENT_PLATFORM_DATA`、`AGENT_PLATFORM_MANAGER_SOCKET`、`AGENT_PLATFORM_MANAGER_TOKEN_FILE` 是固定值，socket 和 token 必须是绝对路径。
- `AGENT_PLATFORM_HOST_DATA_ROOT` 只用来给可信的对话范围提供宿主路径映射提示；不用于访问宿主机，不写入数据库或公共状态，模型也不能覆盖。
- 监听地址和端口、公开网址和可信代理、Runtime 与集成的私有网址、token 文件，以及媒体、HTTP/SSE、附件、任务租约、Telegram 投递、计划轮询的各种限制，都由 Manager 生成。
- `AGENT_PLATFORM_MAX_CONCURRENT_UPLOADS` 与 HTTP worker 数量无关；`AGENT_PLATFORM_UPLOAD_IDLE_TIMEOUT_SECONDS` 限制的是两次读取之间的空闲时间，不是上传总时长。

启动校验：

- 未知的技术身份、旧前缀、混合身份或未声明的基线，在任何写入之前就拒绝。没有开发模式或宿主机模式，也不自动转换。
- 命令行只接受显式的 `serve --host --port --data`、不启动写入者的 `migrate --data` 以及管理子命令；隐藏别名和未知参数一律拒绝。

首次启动与密钥：

- 首次设置的管理员密码不覆盖已有账号；没有提供密码时，随机生成并写入只有属主可访问的 bootstrap 文件。
- 新数据库持久保存 Manager 提供的会话密钥，旧数据库沿用已有的值。每个版本的 Agent 工具 token 和 Runtime token 从文件原子同步，不导出产品密钥。
- SQLite 里的机器密钥键只有 `AGENT_PLATFORM_SESSION_SECRET`、`AGENT_PLATFORM_TELEGRAM_BOT_TOKEN`、`AGENT_PLATFORM_TELEGRAM_WEBHOOK_SECRET`。`AGENT_PLATFORM_LOGIN_FAILURE_V1:` 开头的是内部限流记录，随窗口清理，不是配置、密钥列表或环境入口。其它机器前缀和旧键一律拒绝，不双读也不补写。

## Platform 动态设置

### 品牌

- Platform 独占两项非密钥设置：`ui_branding_v1`（schema、版本号、名称、主色、Logo 元数据）和 `ui_branding_logo_v1`（位图）。环境变量、TOML 和发布清单都不能覆盖。
- 默认值：`Agent Platform`、`Agent`、`#1677ff`、没有 Logo。

| API | 载荷或结果 |
|---|---|
| `GET /api/platform/branding`；管理员用 `GET /api/system/branding/config` | `{schema_version:1,revision,product_name,agent_name,primary_color,logo_url}` |
| `PUT /api/system/branding/config` | `{expected_revision,product_name,agent_name,primary_color}` |
| `PUT /api/system/branding/logo` | `{expected_revision,mime_type,data_base64}` |
| `DELETE /api/system/branding/logo` | `{expected_revision}` |

- 成功时返回新快照；版本号过旧时返回 `409`，不做任何修改。
- 名称去掉首尾空格并做 NFC 规范化后为 1–64 个码点，拒绝控制类字符（Unicode `C*` 类别）以及 `U+2028`/`U+2029`。
- Logo 只能是 PNG 或 WebP，不超过 256 KiB，地址为同源的 `/api/platform/branding/logo?v=<revision>`，不接受远程网址。图片正文不进入 bootstrap、普通 JSON 或静态目录。
- 写入时完整解码为单帧（所需依赖通过 `pyproject.toml` 安装）；匿名读取只校验严格的 base64、大小、SHA-256 和元数据，不解码像素。详见[安全设计](../design/security-and-trust.md)。

### 平台与认证

- `platform_public_base_url`、`platform_trusted_proxy`、`platform_session_ttl_seconds`。
- 修改有效期只影响之后的签发和续期，规则见[安全设计](../design/security-and-trust.md)。
- 监听地址只以只读的 `applied_host`/`applied_port` 展示，不写入数据库，也不能在这里修改绑定。

### Runtime 与模型

- `agent_runtime_model`、`agent_runtime_idle_timeout_seconds`、`agent_runtime_max_concurrency`、`agent_runtime_compaction_threshold` 在同一事务中更新，只对之后的 Run 生效，不需要重启 Runtime。
- 供应商固定为 Codex，不是可配置项；可选模型受 [OAuth 安全交集](../design/integrations.md#模型-oauth)约束。
- 部署级 `agent_runtime_model=""` 表示自动推荐；账号级 `model_name=""` 表示继承部署策略。执行时按供应商的顺序求候选，不回写。
- 显式选择不会因为目录变化、出现新模型、重新验证或修改其它字段而被改写；执行时仍会复验。

### 集成

- **Platform 负责**：Firecrawl key；Telegram 的启用、token、用户名、webhook 密钥和轮询。
- **Manager 负责**：更新的启用、间隔、通道，以及当前/目标/上一个版本和操作。Platform 不保存 Git 或部署命令。
- **邮箱**：只有本人能管理 IMAP/SMTP 的主机、端口、TLS、用户名、启用状态、有上限的轮询间隔和唤醒。密码单独存放，接口只返回 `credential_configured`。
- 固定服务不可被覆盖；维护期间暂停收发和唤醒。
- 工作区 Skill/MCP 的路径以及 `mcpServers/command/args/env/cwd` 格式（没有全局配置、重载或副本）见[集成](../design/integrations.md)。

## Agent Runtime 环境

- Manager 生成 `AGENT_RUNTIME_HOME`、监听地址/端口/token、Platform 网址/token、executor socket/token、审批/正文/清理/保留期/并发的限制，以及工作区、HOME、环境变量。完整键表见 [config.ts](../../enterprise-agent-platform/agent-runtime/src/config.ts)。
- `AGENT_RUNTIME_RUN_IDLE_TIMEOUT_MS`、`AGENT_RUNTIME_MAX_TURNS`、`AGENT_RUNTIME_TERMINAL_TIMEOUT_MS` 使用 runtime-policy 生成的值；沙箱空闲时间和执行目标使用容器契约。
- 没有本地执行器；executor socket 或 token 缺失时启动失败。Runtime token 必须非空，健康检查也需要认证。

## 密钥

- 产品密钥不从环境变量双读；Manager 和 Platform 不互相整库注入，沙箱拿不到平台密钥。
- MCP 的环境变量值只属于当前工作区及其备份。
- 权限、脱敏以及"不能宣称静态加密"见[安全设计](../design/security-and-trust.md)。

## 变更规则

新增或修改配置项时，先确定它属于 TOML、SQLite 还是发布清单，再同步修改文档、机器契约、解析器、持久设置、API、模板、界面、掩码和测试。只加了环境变量、Dockerfile 或数据库字段不算完成。
