# 数据布局

本文定义 Docker 部署的宿主持久状态。逻辑所有权见[数据、记忆与会话](../design/data-memory-sessions.md)，部署见[部署](../operations/deployment.md)。

## 根目录

用户级部署默认使用：

```text
~/.local/share/ubitech-agent/
├── manager/
│   ├── state.json
│   ├── operations/
│   ├── releases/
│   ├── active-generation
│   ├── control/
│   ├── secrets/
│   │   ├── manager-token
│   │   └── manager-executor-token
│   └── logs/
├── data/
│   ├── platform.db
│   ├── platform.db-wal
│   ├── platform.db-shm
│   ├── bootstrap-admin-password.txt
│   ├── attachments/
│   ├── workspaces/
│   │   ├── user-<id>/
│   │   └── channels/channel-<id>/
│   ├── agent-envs/<scope-hash>/
│   │   ├── home/
│   │   ├── env/
│   │   └── logs/
│   ├── agent-skills/<scope-hash>/
│   ├── runtimes/
│   │   ├── agent/{sessions,approvals,idempotency,logs}/
│   │   ├── camofox/{profiles,cookies,traces,cache,logs}/
│   │   ├── cognee/{data,system,cache,logs}/
│   │   ├── searxng/{config,cache,logs}/
│   │   └── firecrawl/{config,data,logs}/
│   └── logs/
└── backups/
```

`manager.toml` 位于 `~/.config/ubitech-agent/`，不属于数据根。`data_root` 是这个布局的唯一可配置根，Platform 权威数据目录始终是规范化后的 `$data_root/data`；Manager 不允许用独立 `data_dir` 把迁移、快照或 Sandbox 指向与容器 bind mount 不同的位置。明确配置在源码树外的旧 `$DATA` 仅在它本身就是目标 `$data_root/data` 时原地采用；否则由首次迁移复制到上述 `data/`。

所有产品持久状态使用宿主 bind mount。Docker 镜像、container writable layer、Engine metadata 和有界容器日志不属于备份数据。不得使用匿名 volume 保存产品权威状态。

## Platform 与文件数据

`platform.db` 是账号、凭据、消息、记忆、知识、任务和设置的权威存储。SQLite 使用 WAL；迁移和备份必须在线 backup 或在停止 writer 后 checkpoint，不能单独复制主文件。

附件、工作区和 Skill 的逻辑关系保持原设计。附件数据库路径为相对路径。工作区在数据库中保存相对标识，不保存宿主绝对路径；Platform 将其解析为宿主数据目录，Sandbox 内统一映射为 `/workspace`。管理器只把与当前私人或频道 scope 对应的附件子目录只读挂载到 `/workspace/.ubitech/attachments`；模型和 Runtime 只接收这个容器逻辑路径，不接收 Platform 或宿主绝对路径。

恢复或复制必须保留可执行位并按各子树修复所有权，不能对整个数据根递归使用同一种 chmod/chown。根目录和 secret 为 owner-only；Manager 每次启动都验证并收紧 `manager/control`、`manager/secrets` 与 capability token 的 owner、类型和权限，拒绝符号链接。对外部服务专用 UID 的授权只应用到明确子目录。

## Agent Sandbox

主 Agent 的工作文件仍位于稳定的 `workspaces/` 路径。`agent-envs/<scope-hash>/home` 和 `env` 保存用户级工具、虚拟环境与配置；scope hash 避免在基础设施路径暴露原始 scope key。

容器名称和 writable layer 不是身份真相源。管理器根据数据库 scope、持久 Sandbox metadata 和 Docker label 对账，缺失容器可以从镜像和挂载目录重建。持久 metadata 中的 `sandbox_id` 到 `workspace_id` 绑定在首次成功登记后不可变；同一 `sandbox_id` 携带不同 `workspace_id` 的请求必须在创建目录或操作容器前拒绝，身份迁移必须使用新的 Sandbox identity。委派子 Agent不创建新的目录，使用父主 Agent 的 Sandbox、workspace、HOME 和 env。

Sandbox 的持久目录保持宿主部署用户的 UID/GID，而不是假定为 `1000:1000`。管理器在每次创建或启动容器前，必须验证 workspace、HOME、env 和 scope 附件这四个宿主 bind root 均位于配置的数据目录内，是无符号链接、由部署用户 UID/GID 持有的真实目录；缺失目录只能在该受信数据目录下创建。已有路径类型或所有者不符时必须拒绝，不能借容器入口 `chown` 任意宿主路径。容器启动入口只把镜像内 `agent` 账号映射到管理器明确传入的 UID/GID，并只对 `/workspace`、`/home/agent`、`/opt/agent-env` 三个挂载根本身进行无符号链接的所有权与 `0700` 校正；禁止递归改写子树或触碰 `/workspace/.ubitech/attachments` 只读挂载。所有后续容器 exec 都以相同映射身份运行。

Sandbox registry 的原子落盘是容器可用的提交边界。一次 ensure 若创建或重新启动了容器，但 registry 持久化失败，管理器必须恢复调用前的内存记录，并同步停止该次启动的既有容器或停止并删除该次新建的容器；镜像替换还必须恢复原登记镜像的容器状态。不得留下只存在于 Docker、却没有相符持久 identity 记录的运行中 Sandbox。

空闲回收与 ensure、调用登记、进程退出和 activity touch 必须按同一 Sandbox identity 串行。管理器在真正停止容器前重新检查最后活动时间和计数；一个刚完成 ensure 或已经登记的调用不能被先前取得的过期空闲快照停止。

Sandbox 内 apt 或其它系统层修改随容器重建丢失。需要跨更新保存的软件必须安装到 `/opt/agent-env`、`/home/agent` 或 workspace 环境。

## Runtime 与外部服务

Agent Runtime 的 session、approval 和 idempotency 继续保存在 `runtimes/agent`，Runtime 程序和 `node_modules` 位于镜像而不是数据根。

Camoufox 使用共享服务和按 scope 派生的独立 Profile。浏览器二进制位于镜像；登录态、Cookie、Profile 和需要保留的 trace 位于 bind mount。

Cognee 代码和依赖位于 Platform 镜像，数据、system、cache、logs 与 `.env` 位于数据根。Firecrawl 与 SearXNG 的配置及服务数据全部映射到各自目录；旧 Docker named volumes 在一致迁移或确认可重建后移除。

## 管理状态、快照和清理

管理器状态根保存 current/previous/target release、generation、operation journal、心跳和 owner-only control socket。每个本地 `releases/<commit>/` 的 manifest 与 Compose 是不可变发布物；可变的 `compose.env` 只包含该宿主生成的路径与镜像 digest。`active-generation` 由 Manager 原子写入，明确指出停止、日志和恢复命令应使用的 Compose generation，不能按目录修改时间猜测。Platform 的业务数据库不得成为容器编排状态的唯一存储，否则 Platform 失败时无法恢复。

首次迁移在 `backups/<operation-id>-legacy/` 保留可恢复的旧 checkout、配置、systemd unit、Compose 归属清单和未原地采用的外部 data，至少七天。归档清单记录每项类型、mode、大小、link target 和内容 hash，并记录迁移前后文件数、总字节数与集合摘要；归档只有在逐项校验完成后才可成为删除旧路径的依据。同文件系统优先以原子 rename 保存完整旧树，跨文件系统使用 staging copy、fsync、校验和原子发布。普通数据库 schema 更新也建立与 operation 绑定的快照，至少保留上一可回滚 generation。工作区、附件、Profile 已作为新数据目录权威内容且迁移前后对账一致时，只在旧部署归档中保存清单，不重复复制巨大数据树。

旧 checkout 中无法识别的 ignored 内容随完整 checkout 一起进入 `backups/<operation-id>-legacy/` recovery pack，不能单独静默删除。Manager 的 legacy retention 只清理当前迁移 journal 明确提交、达到保留期并再次通过 receipt 与逐树 hash 校验的 recovery pack；未知、迁移中或 `cleanup_pending` 的 `*-legacy` 目录必须保留。它也不能误删仍被 current/previous generation 引用的普通数据库快照。

应用与容器日志必须轮转。默认限制和保留数量由管理器实现与测试约束；日志不得无限增长，也不得包含 secret、原始宿主执行凭据或 Docker registry 凭据。

## 备份与恢复

一致备份至少包含 SQLite backup、attachments、workspaces、agent-envs、agent-skills、Runtime session/approval/idempotency 和管理器 release/operation state。需要保留网页登录态时包含 Camoufox Profile；Cognee 和 Firecrawl 数据按恢复成本纳入。

恢复时先停止 Platform writer，再恢复数据与 manager generation，最后由管理器重建容器。数据库快照恢复必须在改动当前数据前完整校验 manifest、文件类型、大小与校验和，把全部目标文件复制并同步到数据目录同文件系统的 staging；提交时先把现有数据库、WAL、SHM 和快照包含的其它受管文件移入事务备份，再切换 staging 文件并同步目录。任一复制、rename 或目录同步失败都必须补偿恢复提交前的完整文件集合，不能留下缺失或跨 generation 混合的 SQLite 文件。不得手工编辑 Runtime JSONL、幂等记录或 manager operation journal。
