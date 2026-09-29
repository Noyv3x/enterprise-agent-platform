# 数据布局

本文定义磁盘路径、身份标记文件、备份集合和数据库迁移边界。事务规则见[数据设计](../design/data-memory-sessions.md)，文件描述符和发布安全见[安全设计](../design/security-and-trust.md#文件与附件)，操作步骤见[部署](../operations/deployment.md)。

## 唯一根目录

| 对象 | 固定位置 |
| --- | --- |
| 宿主机入口程序 | `~/.local/bin/agent-platform-manager` |
| 配置 | `~/.config/agent-platform/manager.toml` |
| 用户级 systemd unit | `~/.config/systemd/user/agent-platform-manager.service` |
| 默认持久根目录 | `~/.local/share/agent-platform/` |
| Platform 权威数据 | `$data_root/data`；`data_root` 是唯一可配置的持久根目录 |
| 容器内数据根 / 工作区 / 内部工作目录 | `/var/lib/agent-platform` / `/workspace` / `.agent-platform` |

- `~` 只从当前 UID 在操作系统中唯一的账户记录里的 home 派生。安装器和 Manager 忽略环境中的 `HOME`、`XDG_BIN_HOME`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME`。
- control socket 可以使用经过安全验证的 `XDG_RUNTIME_DIR`，没有时回退到 `/run/user/<uid>`。

```text
<data_root>/
├── manager/
│   ├── update.json
│   ├── state.json       # N 的只读回退记录（若存在）
│   ├── operations/     # N 的只读回退记录（若存在）
│   ├── releases/
│   ├── manager-binaries/
│   ├── active-generation
│   ├── control/
│   ├── secrets/
│   └── logs/
├── data/
│   ├── .agent-platform.lock
│   ├── platform.db{,-wal,-shm}
│   ├── attachments/
│   ├── upload-staging/
│   ├── workspaces/
│   ├── agent-envs/<scope-hash>/{home,env}/
│   ├── agent-skill-state/<scope-hash>/
│   ├── runtimes/
│   │   ├── agent/{sessions,sessions.pre-pi,approvals,logs}/
│   │   ├── camofox/{profiles,cookies,traces,cache,logs}/
│   │   ├── searxng/{config,cache,logs}/
│   │   └── firecrawl/{redis,rabbitmq,postgres}/
│   └── logs/
└── backups/
```

- 只接受这几种身份标记：`agent-platform-container-baseline-v1`、`.agent-platform-scope.json`、`.agent-platform-runtime.json` 和当前的沙箱登记表。字段必须精确匹配；旧根目录、旧身份、旧标记、未知字段或混合身份一律拒绝。
- 普通操作不查找旧路径或修复历史格式。N+1 不提供旧激活或恢复协议；旧事务必须先由桥接版本 N 结算。唯一例外是由已确认的 N launcher 交接的本次监督升级，保留同一操作 ID 和预约继续收尾。
- Runtime 的 `sessions` 是活动 Pi 原生会话及附属状态；`sessions.pre-pi` 只在迁移已有会话时保留，是未经改写的迁移前目录，不参与搜索、追加、压缩或会话清理。Run、结果和 SSE journal 没有持久存储目录。
- 品牌不改变机器身份。

## 权威数据与文件安全

- 权威状态必须用宿主机目录挂载（bind mount），不用匿名卷。镜像、容器可写层、Docker 元数据、缓存和日志都不是备份数据。

| 对象 | 必须满足 |
| --- | --- |
| 数据库 | 从固定的数据根目录描述符逐段以不跟随链接的方式打开。DB、WAL、SHM 必须属于当前 UID、是只有一个硬链接的普通文件。数据库不存在时以 `O_CREAT \| O_EXCL \| O_NOFOLLOW`、权限 `0600` 创建。属主、类型、链接数或 inode 异常时，在任何写入之前拒绝。 |
| 实例锁 | 在打开 SQLite、启动后台处理或产生副作用之前，从同一个根目录描述符以 `O_NOFOLLOW \| O_CLOEXEC` 打开 `.agent-platform.lock`（首次独占创建）。必须属于当前 UID、是普通文件且只有一个硬链接；验证通过后才能通过描述符把权限收紧到 `0600`，异常时不自动修复。 |
| 锁的生命周期 | 非阻塞独占 flock。取得锁和写入 PID 前后，都复验锁描述符、父目录和规范数据根的 inode；被替换时释放锁并失败。锁和父目录描述符在整个生命周期内保持打开，关闭时不删除锁文件。 |
| 数据库备份 | 使用 SQLite backup，或者停止唯一的写入者后做 checkpoint；不能只复制正在使用的主文件。 |

## Workspace、附件与 Skill

| 状态 | 位置与身份 |
| --- | --- |
| 个人 / 频道工作区 | `data/workspaces/user-<id>/` 或 `data/workspaces/channels/channel-<id>/`，挂载为 `/workspace`；委派共用父目录 |
| 用户环境 | `agent-envs/<scope-hash>/{home,env}`，挂载为 `/home/agent` 和 `/opt/agent-env`；系统层在重建时丢弃 |
| Skill 包 | 工作区内的 `.agent-platform/skills/<skill-id>/`，只能包含 `SKILL.md`、`references/`、`templates/`、`scripts/`、`assets/` |
| Skill 状态 | 只在 Platform 的 `agent-skill-state/<scope-hash>/`，不挂载到沙箱；工作区里的附属文件不构成授权 |
| MCP | 工作区内的 `.agent-platform/mcp.json` 和 `.agent-platform/mcp/<server-id>/`；不双存，也不搜索其它客户端的路径 |
| 上传与附件 | `upload-staging/` 中每个请求一个目录（`0700`，文件 `0600`），提交后移到 `attachments/`；数据库里存相对路径。生命周期见[上传](../design/security-and-trust.md#上传交付与预览) |
| 附件挂载 | 只把当前对话范围的附件以只读方式挂到 `/workspace/.agent-platform/attachments`，不能挂载全局或其它对话范围的附件 |

- 对话范围标记精确包含：逻辑的 key、类型和 ID，当前 Runtime 生命周期，沙箱和工作区身份，`technical_profile`，以及固定的隔离边界。
- 数据库只存规范的相对工作区身份，不存绝对路径或可选的后端。越界、字段或身份漂移，在启动和每次读取时都会被拒绝，缓存不能豁免。
- 宿主机路径映射只能出现在当前对话范围的可信系统提示里，不进入公共 API、普通元数据或数据库。生命周期见[数据设计 · Agent scope](../design/data-memory-sessions.md#agent-scope)。

## Sandbox

- 登记表记录沙箱和工作区身份、UID/GID、相对挂载路径和镜像摘要。容器名或镜像层不构成身份；首次分配的 `sandbox_id` 不会改绑。
- 每次创建或启动之前，Manager 验证工作区、HOME、环境和附件的源与目标：位于数据目录内、没有符号链接、属于部署 UID/GID、权限 `0700`。缺少的挂载目标在调用 Docker 之前自行创建，不让以 root 运行的 Docker 守护进程代建。
- 登记表的原子写入是"确保沙箱存在"这一操作的提交点；写入失败时停止并删除本次新建的容器，恢复原来的记录。

## Runtime 与集成服务

- 程序和依赖都在镜像里。Runtime 状态在 `runtimes/agent`，Camoufox 状态在 `runtimes/camofox`；浏览器的暂存文件在请求结束或服务启动时清理。
- SearXNG 的完整 `config/` 目录以只读方式映射到 `/etc/searxng`。Firecrawl 不使用 FoundationDB。

**Camoufox 身份标记**

- 已有的部署必须存在 `runtimes/camofox/.agent-platform-runtime.json` 及其受管的父目录；普通启动或候选版本启动时缺失或身份错误都会拒绝。
- 只有 `serve` 或 `migrate` 在**创建数据库之前确认数据库不存在**的全新环境下，才可以创建这个标记。这个资格是显式传递的，不能从"文件缺失"推断，也不会误拒同一次新建的数据库。旧数据库迁移时保留原标记，不会补建；全新环境迁移后可以按已有部署启动。

## Manager 状态、快照与清理

- `active-generation` 决定停止、日志和恢复的目标，不按目录时间猜测。
- N+1 在第一次加载时只接受已完成监督接力、无在途旧激活或操作的 N 数据；不确定状态必须先由 N 结算。允许由 N launcher 精确绑定的本次监督升级沿原操作 ID 继续收尾。旧 `state.json`、`operations/` 和 `manager-binaries.json` 保留供离线回退读取，不再作为 N+1 的可变权威。
- N+1 将状态、操作幂等身份和预约结算写入同一 owner-only `manager/update.json`，原子替换并 fsync；进程服务锁串行化操作。
- `manager/manager-binaries/launcher` 是已验证的独立可执行文件，不随候选更新覆盖；同目录的 owner-only `launcher-state.json` 原子记录 launcher 身份、选择、上一版本和启动结果。自更新保存当前和一个上一份已验证二进制的版本、SHA-256 与受管路径；启动失败时只回退一次。监督接力完成的持久证明是接受后续更新的前提。
- 可能修改数据库或附属文件的操作，在停止写入者之后建立绑定到该版本的快照：写入只有属主可访问的暂存目录 → 文件、清单和父目录落盘 → 原子发布为 `backups/<operation-id>/`。失败时只清理本次的暂存目录。

**清理规则**

- 始终保留当前、上一版本及其回滚快照；在途候选和快照受保护。旧桥接记录不自动删除。
- 只在稳定空闲时清理明确不再引用的受管发布物。不自动删除 Docker 镜像、容器或网络，不影响独立沙箱；禁止全局 prune。
- 保留策略见[自动更新](../operations/auto-update.md)；临时文件的删除授权见[安全设计 · 管理器与更新](../design/security-and-trust.md#管理器与更新)。日志会轮转，不包含密钥、执行凭据或镜像仓库凭据。

## 备份与恢复

**一个恢复点至少包含**

- SQLite 备份、attachments、workspaces、agent-envs、agent-skill-state；
- Runtime 的活动会话、附属状态、审批记录，以及存在时的 `sessions.pre-pi` 原始备份；
- Manager 的发布、操作和版本记录。

工作区包含 Skill、MCP、服务和用户自己保存的环境变量值，不能跨对话范围混搭恢复。需要网页登录态时，把 Camoufox Profile 纳入备份；Firecrawl 按恢复成本决定是否纳入。

**恢复步骤**

1. 停止唯一的写入者。
2. 验证清单、类型、大小和 SHA-256。
3. 在同一文件系统的暂存区准备完整集合。
4. 原子切换并同步目录；失败时补偿恢复完整的原集合。

- 不手工修改 JSONL、迁移备份或操作日志。
- 新版本已经写入业务数据后，不回滚到会产生分叉的旧快照，而是走新的快照操作。

## 受控迁移

- Manager 停止唯一写入者并建立可回滚的快照后，运行固定的 `migrate` 命令；SQLite 结构变更只通过有版本的数据库迁移执行。
- 全新数据库初始化为当前 schema；当前版本迁移到当前版本不产生转换；高于当前程序支持版本的数据库拒绝打开。schema 版本不倒退。
- 已完成的 `2026080801 → 2026082901` 旧基线转换不再受支持；不再复制旧 Skill 目录、转换工作区或执行旧挂载点的 root 权限修复。现有数据与当前 `2026082901` 标记保留，已部署上一版本仍可读取。
- 迁移失败时仍按 Manager 的停止写入者、快照和原操作回滚规则恢复；新版本开放业务之后不得用旧快照覆盖新写入。
- Runtime 会话格式转换是候选 Runtime 在开放请求前执行的一次性启动迁移，不是 SQLite 结构迁移。已有 `sessions` 原目录原封不动保留为 `sessions.pre-pi`；完整转换到同文件系统暂存目录并校验后，才原子发布新的 `sessions`。崩溃中断可重复执行；已有备份不能覆盖，迁移失败不接受请求，成功后的普通启动不再导入旧目录。
- 本次发布前必须人工备份完整数据；仅恢复数据库或回滚镜像不能撤销 Pi 会话转换，Manager 不自动恢复该目录。手动回滚旧 Runtime 时必须停止写入者，并使用兼容且一致的恢复点；`sessions.pre-pi` 不包含迁移后的新历史，详见[部署](../operations/deployment.md#本次-runtime-升级的备份与手动回滚)。
