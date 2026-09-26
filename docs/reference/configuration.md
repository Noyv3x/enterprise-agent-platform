# 配置参考

每字段仅由所属权威解析，无全局覆盖顺序；生成环境不是用户配置。

## 配置所有权

| 权威 | 内容 |
|---|---|
| Manager `~/.config/agent-platform/manager.toml`／secret 文件 | 监听、数据根、更新、Docker、日志／registry、control、executor |
| Platform SQLite | 产品、认证、品牌、OAuth、模型、Telegram、邮箱 |
| manifest／Manager 生成环境、scope metadata | commit／schema／digest、endpoint／mount／token file／限制、Agent identity／Sandbox |
| localStorage | 语言、主题等非安全偏好 |

默认值／接口只查 [Runtime policy](../contracts/runtime-policy.json)、[容器契约](../contracts/container-platform.json)、[技术身份](../contracts/technical-profiles.json)、[Compose](../../containers/compose.yaml)；路径／marker／现役迁移例外只查[数据布局](data-layout.md)。

## Manager 配置

常用 TOML 键（完整解析见 [config.go](../../manager/internal/config/config.go)）：

- 根／入口：`data_root`、`listen`；Platform 固定为根下 `data/`，无 `data_dir`，容器端口由 Manager 选，bind 非 public URL。
- LAN：`lan_enabled`、`lan_listen`、`direct_access_cidrs`、`trusted_ingress_cidrs`，默认关闭。
- 更新：`release_manifest_url`、`release_channel`、`update_enabled`、`update_interval`，受信 main；条件请求 304 不建 Candidate／写盘。
- 限制：`sandbox_idle`（任务／后台进程共同适用）、`log_max_size`、`log_max_files`（Manager／容器轮转）。
- capability：`internal_token_file`，拒绝 TOML 明文 `internal_token`。

保存临时文件＋fsync＋原子替换。LAN/CIDR 先绑定新监听、成功才提交／替换，失败保留旧配置／监听；其它字段仅声明者热加载，listen／data root／control socket 改变需 restart。目录／CIDR／secret／有界脱敏诊断见[安全设计](../design/security-and-trust.md)；HTTPS、manifest 验证与手工也不绕过的空闲／快照门见[自动更新](../operations/auto-update.md)。

## 容器生成配置

Manager 独占镜像、mount、能力、command、服务生命周期，界面不能改变。内部用 Compose DNS，不用公网 URL；Runtime 经 Platform 调集成，不收其 endpoint／secret。`manager-token`（Platform／宿主 CLI）与 `manager-executor-token`（Runtime）独立，文件只读 owner-only，共 socket 不共权限；[安全设计](../design/security-and-trust.md)定义校验／最小注入／防泄漏。

## Platform 启动配置

完整键与固定 target 路径见 [Compose](../../containers/compose.yaml)／[PlatformConfig](../../enterprise-agent-platform/enterprise_agent_platform/config.py)：

- `AGENT_PLATFORM_TECHNICAL_PROFILE=agent-platform-v1`、`AGENT_PLATFORM_DEPLOYMENT_MODE=container` 必须显式；`AGENT_PLATFORM_DATA`、`AGENT_PLATFORM_MANAGER_SOCKET`、`AGENT_PLATFORM_MANAGER_TOKEN_FILE` 固定，socket／token 须绝对路径。
- `AGENT_PLATFORM_HOST_DATA_ROOT` 仅用于可信 scope 宿主映射提示，不用于宿主访问、入库／公共状态或模型覆盖。
- host/port、public URL／trusted proxy、Runtime／集成私有 URL、token file；媒体／HTTP/SSE／附件、job lease／Telegram delivery／schedule poll 限制均由 Manager 生成。
- `AGENT_PLATFORM_MAX_CONCURRENT_UPLOADS` 独立于 HTTP worker；`AGENT_PLATFORM_UPLOAD_IDLE_TIMEOUT_SECONDS` 限相邻读取空闲，不限上传总时长。

未知 profile／旧前缀／混合身份／未声明 baseline 在 writer 前拒绝，无 development／宿主模式或自动转换。CLI 显式 `serve --host --port --data`、无 writer 的 `migrate --data`及管理子命令；隐藏别名／未知参数拒绝。

首次密码不覆盖旧账号，无密码随机写 owner-only bootstrap。新库持久化 Manager session secret，旧库沿用；generation Agent tool／Runtime token 从文件原子同步，不导出产品 secret。

SQLite 机器 secret 键仅 `AGENT_PLATFORM_SESSION_SECRET`、`AGENT_PLATFORM_TELEGRAM_BOT_TOKEN`、`AGENT_PLATFORM_TELEGRAM_WEBHOOK_SECRET`。`AGENT_PLATFORM_LOGIN_FAILURE_V1:` 为随窗口清理的内部限流行，非配置／Secret 列表／环境入口；其它机器前缀／旧键拒绝，不双读／补写。

## Platform 动态设置

### 品牌

Platform 独占非 secret `ui_branding_v1`（schema／revision／名称／主色／Logo metadata）和 `ui_branding_logo_v1`（位图），环境／TOML／manifest 不覆盖。默认 `Agent Platform`、`Agent`、`#1677ff`、无 Logo。

| API | 载荷／结果 |
|---|---|
| `GET /api/platform/branding`；管理员 `GET /api/system/branding/config` | `{schema_version:1,revision,product_name,agent_name,primary_color,logo_url}` |
| `PUT /api/system/branding/config` | `{expected_revision,product_name,agent_name,primary_color}` |
| `PUT /api/system/branding/logo` | `{expected_revision,mime_type,data_base64}` |
| `DELETE /api/system/branding/logo` | `{expected_revision}` |

成功返回新快照，旧 revision `409` 且不变更。名称 trim＋NFC 后 1–64 码点，拒绝 `C*`、`U+2028/U+2029`。Logo 仅 PNG/WebP、≤256 KiB、同源 `/api/platform/branding/logo?v=<revision>`，无远程 URL；正文不进 bootstrap／普通 JSON／静态目录。写入完整解码单帧，构建从 `pyproject.toml` 安装声明依赖；匿名读只验严格 base64／大小／SHA-256／metadata，不解码像素，详见[安全设计](../design/security-and-trust.md)。

### 平台与认证

`platform_public_base_url`、`platform_trusted_proxy`、`platform_session_ttl_seconds`；TTL 仅影响后续签发／续期，规则见[安全设计](../design/security-and-trust.md)。listen 只读投影 `applied_host/applied_port`，不入库／改绑。

### Runtime 与模型

`agent_runtime_model`、`agent_runtime_idle_timeout_seconds`、`agent_runtime_max_concurrency`、`agent_runtime_compaction_threshold` 同事务更新，仅后续 Run 生效、不重启 Runtime。

供应商固定为 Codex，不是配置项；model 受[OAuth 安全交集](../design/integrations.md#模型-oauth)约束。部署 `agent_runtime_model=""` 为自动推荐，账号 `model_name=""` 为继承部署策略；执行时依供应商顺序求候选、不反写。显式选择不因目录、新模型、重验或其它字段更新改写，执行仍复验。

### 集成

Firecrawl key；Telegram enabled/token/username/webhook secret/polling 属 Platform。更新 enabled/interval/channel、current/target/previous generation／operation 属 Manager，Platform 不存 Git／部署命令。邮箱仅本人管理 IMAP/SMTP host/port/TLS、用户名、enabled、限界轮询间隔、唤醒；密码独立行，仅回 `credential_configured`。固定服务不可覆盖，维护暂停收发唤醒；工作区 Skill/MCP 路径及 `mcpServers/command/args/env/cwd`、无全局配置／reload／副本见[集成](../design/integrations.md)。

## Agent Runtime 环境

Manager 生成 `AGENT_RUNTIME_HOME`、host/port/token、Platform URL/token、executor socket/token、approval/body/cleanup/retention／并发和 workspace/HOME/env，键表见 [config.ts](../../enterprise-agent-platform/agent-runtime/src/config.ts)。`AGENT_RUNTIME_RUN_IDLE_TIMEOUT_MS`、`AGENT_RUNTIME_MAX_TURNS`、`AGENT_RUNTIME_TERMINAL_TIMEOUT_MS` 使用 runtime-policy 生成值；Sandbox idle／target 使用容器契约。无 local executor；executor socket/token 缺失启动失败；Runtime token 非空，health 也认证。

## Secret

产品 secret 不双读环境；Manager／Platform 不整库互注，Sandbox 不收平台 secret。MCP 值只属当前工作区／备份。权限、脱敏和禁止宣称静态加密见[安全设计](../design/security-and-trust.md)。

## 变更规则

先定 TOML／SQLite／manifest 所有权，再同步文档、机器契约、解析器、持久设置、API、模板、界面、掩码、测试；只加环境／Dockerfile／数据库字段不算完成。
