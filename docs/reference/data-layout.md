# 数据布局

本文定义平台管理状态的物理布局。逻辑所有权见[数据、记忆与会话](../design/data-memory-sessions.md)，配置来源见[配置参考](configuration.md)。

## 数据根

`ENTERPRISE_PLATFORM_DATA` 指定唯一状态根。仓库部署默认使用 `enterprise-agent-platform/data`。该目录不属于源代码，不能提交到 Git，也不能放在上游 submodule 内。

典型布局：

```text
$DATA/
├── .enterprise-platform.lock
├── platform.db
├── platform.db-wal
├── platform.db-shm
├── bootstrap-admin-password.txt
├── gateway-state.json
├── gateway-control.sock
├── auto-update-state.json
├── auto-update-state.lock
├── attachments/
├── workspaces/
│   ├── user-<id>/
│   └── channels/channel-<id>/
├── agent-skills/<scope-hash>/
├── logs/
│   └── auto-update.log
└── runtimes/
    ├── node/
    ├── agent/
    ├── camofox/
    ├── cognee/
    ├── searxng/
    └── firecrawl/
```

部分文件只在对应功能启用后出现。Unix domain socket 路径过长时，Gateway 会在按用户隔离的临时目录创建哈希 fallback socket，并继续用 peer credential 校验本机调用者。

## 平台数据库

`platform.db` 是产品业务数据权威存储；`-wal` 和 `-shm` 是活动 SQLite 的组成部分。数据库含密码 hash、OAuth token、session secret、内部 token、消息、附件路径、记忆、知识和任务账本，应按敏感数据保护。

数据目录启动时必须是服务账号所有、非符号链接且权限收紧。数据库和 sidecar 文件收紧为 owner-only。实例锁防止两个平台进程同时使用同一数据根。

## 附件

`attachments/` 保存上传文件和 Agent 生成文件的受管副本，SQLite 保存原文件名、规范 MIME、大小、hash、scope、message 和 uploader。数据库行与文件是一个逻辑单元；删除、失败回滚和启动修复必须同时处理两者。

Agent workspace 内的原文件不是产品附件。只有通过受控媒体提取并复制到附件存储后，才能生成可下载 URL。

## Workspace

- 私人 Agent：`workspaces/user-<id>/`
- 频道主 Agent：`workspaces/channels/channel-<id>/`

每个 workspace 包含 `.ubitech-agent-scope.json`，用于验证 scope、lifecycle、host backend 和 logical isolation。workspace 在会话轮换后继续存在；删除消息不自动删除用户文件。

子 Agent 与父 Agent 共享 workspace，不创建独立工作区。路径隔离是产品组织边界，不是宿主机权限边界。

## Skills

`agent-skills/<scope-hash>/` 保存用户 Skill 包，避免在路径中暴露原始 scope key。每个 Skill 目录包含 `SKILL.md`、`.skill.json` 和可选的 `references/`、`templates/`、`scripts/`、`assets/`。

预置技能位于 Python package 的 `bundled_skills/`，是源代码只读层，不复制到数据目录。用户技能可以遮蔽预置技能，但升级不能覆盖用户包。

## Agent Runtime

`runtimes/agent/` 由托管 Runtime 独占，主要包括：

```text
runtimes/agent/
├── app/             # 按 lockfile 发布的 Runtime 程序与依赖
├── sessions/        # 活动 JSONL、archive 和 lifecycle session 状态
├── approvals/       # 持久 always 授权
├── idempotency/     # Run 幂等终态索引
└── logs/            # 安装与运行日志
```

Runtime 安装使用 source signature 和原子 staging，更新回滚后会重新发布与当前 checkout 匹配的 sidecar。OAuth 凭据不得出现在该目录。

## Managed Node

`runtimes/node/` 保存 checksum 锁定的 Node fallback。`current` 必须是指向一个受验证版本目录的相对符号链接；部署只在系统 Node 不满足要求且允许运维自动安装时使用它。

## Camoufox

`runtimes/camofox/` 保存应用依赖、锁定浏览器资产、access key、profiles、cookies、traces、cache 和日志。Profile 按从 scope 派生的 browser user id 分离。该目录可能很大，备份策略应根据是否需要保留浏览器登录态单独决定。

## Cognee

`runtimes/cognee/` 保存 `.env`、data、system、cache 和 logs。`.env` 可能含外部 LLM、Embedding、数据库或对象存储凭据，属于 secret。Cognee 数据只是可选增强；本地知识文档仍以 `platform.db` 为权威。

## SearXNG 与 Firecrawl

`runtimes/searxng/` 保存平台生成的 Compose、settings、secret key、cache 和日志。`runtimes/firecrawl/` 保存平台生成的 env、Compose override 和日志。容器 volume 由相应 Compose project 管理。

生成文件不得写回 `searxng` 镜像或 `firecrawl/` submodule。停止托管栈时必须执行平台记录的 Compose teardown。

## Gateway 与更新状态

`gateway-state.json` 是持久 Gateway 的 generation、backend 和心跳快照；高频活动请求计数以本地 control socket 查询为权威。`auto-update-state.json` 是跨进程维护标记，旧 frontend、Gateway、旧 backend 和新 backend 都据此判断是否阻断使用。

Git 仓库级 update lock 位于 `.git` 路径，不在数据目录。`logs/auto-update.log` 记录 detached updater 输出，不得包含 secret。

## 备份与恢复

一致恢复至少需要：SQLite 在线备份、attachments、workspaces、agent-skills 和 `runtimes/agent`。若要保留浏览器登录态，再包含 Camoufox profile；Cognee、SearXNG 和 Firecrawl 可按集成恢复成本选择重建。

恢复到不同路径后必须通过 `ENTERPRISE_PLATFORM_DATA` 启动，并让平台重新验证所有权、权限和非符号链接约束。不要手工编辑 Runtime idempotency 或 JSONL session；格式迁移必须由版本化代码完成。
