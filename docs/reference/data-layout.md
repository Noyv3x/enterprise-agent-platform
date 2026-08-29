# 数据布局

本文定义 Docker 部署的宿主持久状态。逻辑所有权见[数据、记忆与会话](../design/data-memory-sessions.md)，部署见[部署](../operations/deployment.md)。

## 唯一根目录

用户级部署默认使用：

```text
~/.local/share/agent-platform/
├── manager/
│   ├── state.json
│   ├── operations/
│   ├── releases/
│   ├── manager-binaries/
│   ├── active-generation
│   ├── control/
│   ├── secrets/
│   └── logs/
├── data/
│   ├── platform.db
│   ├── platform.db-wal
│   ├── platform.db-shm
│   ├── attachments/
│   ├── upload-staging/
│   ├── workspaces/
│   ├── agent-envs/<scope-hash>/
│   ├── agent-skill-state/<scope-hash>/
│   ├── runtimes/
│   │   ├── agent/{sessions,approvals,idempotency,logs}/
│   │   ├── camofox/{profiles,cookies,traces,cache,logs}/
│   │   ├── searxng/{config,cache,logs}/
│   │   └── firecrawl/{redis,rabbitmq,postgres}/
│   └── logs/
└── backups/
```

`manager.toml` 位于 `~/.config/agent-platform/`。`data_root` 是唯一可配置的持久根，Platform 权威目录始终是 `$data_root/data`。容器内数据根固定为 `/var/lib/agent-platform`，内部工作目录固定为 `.agent-platform`。

当前代码只接受 `agent-platform-container-baseline-v1`、`.agent-platform-scope.json`、`.agent-platform-runtime.json` 和当前 Sandbox registry。旧根、旧 marker、旧 profile、未知字段或混合身份直接失败；普通启动、更新、repair、rollback 和恢复不提供旧格式转换或双读。

管理员品牌设置只保存在 Platform 业务数据中，不改变任何路径、数据库、workspace/session identity、Manager journal、备份、容器或文件名。

## 权威数据与文件安全

`platform.db` 是账号、平台凭据、消息、记忆、任务和设置的权威存储。SQLite 使用 WAL。备份必须使用 SQLite backup，或先停止唯一 writer 并 checkpoint；不得只复制主文件。

Platform 从逐段 no-follow 打开的数据根 fd 打开数据库。既有数据库、WAL 与 SHM 必须是当前 UID 所有、单硬链接的普通文件；缺失数据库只在固定父目录以 `O_CREAT | O_EXCL | O_NOFOLLOW` 创建为 `0600`。符号链接、硬链接、特殊文件、owner 异常或 inode 置换在 writer 启动前失败关闭。`.agent-platform.lock` 的独占 flock 贯穿 Platform 生命周期。

所有权威状态使用宿主 bind mount。Docker image、container writable layer、Engine metadata、缓存和有界日志不是备份数据；不得用匿名 volume 保存权威数据。

## Workspace、附件与 Skill

个人 AI 的默认 workspace 为 `data/workspaces/user-<id>/`，频道主 Agent 使用 `data/workspaces/channels/channel-<id>/`。数据库只保存相对 workspace identity。Sandbox 内统一映射为 `/workspace`；可信系统提示可同时说明该 scope 的精确宿主映射，但宿主绝对路径不得进入公共 API、普通 Runtime metadata 或数据库。

`agent-envs/<scope-hash>/home` 和 `env` 保存用户级工具与环境。每个 workspace 内的 `.agent-platform/skills/<skill-id>/` 只保存可移植 Skill 包，`.agent-platform/mcp.json` 保存 MCP 清单，`.agent-platform/mcp/<server-id>/` 保存本地 MCP server 包。不向 Sandbox 挂载的 `agent-skill-state/<scope-hash>/` 保存 Skill 的原子生命周期、授权与 usage 状态；workspace 中的同名 sidecar 始终是不可信输入。私人和频道主 Agent 各用自己的 workspace；委派子 Agent使用父主 Agent 的目录。

Multipart 上传增量写入 `upload-staging/` 下按请求隔离的 `0700` 目录和 `0600` 文件。完整校验后流式提交到 `attachments/`；成功、失败、取消或空闲超时都清除 staging。附件数据库路径必须是相对路径。每个 Sandbox 只读挂载当前 scope 的附件到 `/workspace/.agent-platform/attachments`。

## Sandbox

Sandbox registry 是容器 identity 的真相源；容器名和 writable layer 不是。registry 记录 sandbox/workspace identity、UID/GID、相对挂载与镜像 digest。首次绑定后 `sandbox_id` 不能改绑其它 workspace。

Manager 每次创建或启动容器前验证 workspace、HOME、env、附件源以及 workspace 内的 `.agent-platform/attachments` 挂载目标都位于数据目录内、无符号链接并由部署 UID/GID 拥有且为 `0700`；缺失挂载目标由 Manager 在调用 Docker 前创建，不能交给 Docker daemon 以 root 代建。registry 原子写入是 ensure 的提交边界；写入失败必须停止或删除本次创建的容器并恢复调用前记录。

Sandbox 系统层修改随容器重建丢失。需持久的软件和文件放入 `/opt/agent-env`、`/home/agent` 或 `/workspace`。

## Runtime 与集成服务

Agent Runtime 的 session、approval 与 idempotency 位于 `runtimes/agent`。程序和依赖在镜像内。

Camoufox 的 Profile、Cookie 和 trace 位于 `runtimes/camofox`；浏览器程序在镜像内。上传暂存位于受控 `upload-staging/` 并在请求完成或服务启动时清理。SearXNG 的完整 `config/` 只读映射到 `/etc/searxng`。Firecrawl 只使用 Redis、RabbitMQ 与 PostgreSQL 目录；当前布局没有 FoundationDB。

## Manager 状态、快照与清理

Manager 保存 Current/Previous/Candidate、operation journal、不可变 release、Manager version、control capability 和活动 generation。`active-generation` 明确指出停止、日志与恢复命令使用的 generation，不能按目录时间猜测。

可能改变数据库或 sidecar 的 operation 在停止 writer 后建立与目标 generation 绑定的快照。快照先写 owner-only staging，文件、manifest 和父目录全部 fsync 后再原子发布到 `backups/<operation-id>/`。发布前失败只精确清理本次 staging。

以下对象始终受保护：Current、Previous、Candidate、active/finalize operation、未 finalized journal、对应快照与被运行容器引用的 release/镜像。Manager 只在稳定 idle 状态，从单一保护快照精确删除过期且未引用的 operation、备份、release、Manager version、staging、容器和镜像；每个删除点复核 epoch、owner、类型、inode、label 与 digest。禁止全局 prune 和通配递归删除。

日志必须轮转，不能包含 secret、原始宿主执行凭据或 registry 凭据。

## 备份与恢复

一致备份至少包含 SQLite backup、attachments、workspaces、agent-envs、agent-skill-state、Runtime session/approval/idempotency 与 Manager release/operation state。workspace 已包含每个 Agent 的 Skill、MCP 清单、本地 server 包和用户自行保存的环境值。需要保留网页登录态时包含 Camoufox Profile；Firecrawl 数据按恢复成本纳入。

恢复先停止 Platform writer，完整验证快照 manifest、文件类型、大小和 SHA-256，再在同文件系统 staging 中准备全部文件，最后原子切换并同步目录。任一步失败必须补偿回提交前完整集合。不得手工编辑 Runtime JSONL、幂等记录或 Manager journal。
