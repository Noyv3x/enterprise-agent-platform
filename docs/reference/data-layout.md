# 数据布局

本文定义磁盘路径、身份标记文件、备份集合和唯一的直接迁移例外。事务规则见[数据设计](../design/data-memory-sessions.md)，文件描述符和发布安全见[安全设计](../design/security-and-trust.md#文件与附件)，操作步骤见[部署](../operations/deployment.md)。

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
│   ├── state.json
│   ├── operations/
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
│   │   ├── agent/{sessions,approvals,idempotency,logs}/
│   │   ├── camofox/{profiles,cookies,traces,cache,logs}/
│   │   ├── searxng/{config,cache,logs}/
│   │   └── firecrawl/{redis,rabbitmq,postgres}/
│   └── logs/
└── backups/
```

- 只接受这几种身份标记：`agent-platform-container-baseline-v1`、`.agent-platform-scope.json`、`.agent-platform-runtime.json` 和当前的沙箱登记表。字段必须精确匹配；旧根目录、旧身份、旧标记、未知字段或混合身份一律拒绝。
- 普通操作不查找旧路径、不双读、不解码历史格式。唯一例外是[受控迁移](#受控迁移)。
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
- 可能修改数据库或附属文件的操作，在停止写入者之后建立绑定到该版本的快照：写入只有属主可访问的暂存目录 → 文件、清单和父目录落盘 → 原子发布为 `backups/<operation-id>/`。失败时只清理本次的暂存目录。

**清理规则**

- 始终保护：当前、上一个和候选版本，活动中或正在收尾的操作，未完成的操作日志，关联的快照，以及运行中的容器引用的发布和镜像。
- 只在稳定空闲时，根据同一份受保护快照删除过期且未被引用的对象；每个删除点都复验纪元、属主、类型、inode、标签和摘要。禁止全局 prune 或通配符递归删除。
- 保留策略见[自动更新](../operations/auto-update.md)；临时文件的删除授权见[安全设计 · 管理器与更新](../design/security-and-trust.md#管理器与更新)。日志会轮转，不包含密钥、执行凭据或镜像仓库凭据。

## 备份与恢复

**一个恢复点至少包含**

- SQLite 备份、attachments、workspaces、agent-envs、agent-skill-state；
- Runtime 的会话、审批和幂等记录；
- Manager 的发布、操作和版本记录。

工作区包含 Skill、MCP、服务和用户自己保存的环境变量值，不能跨对话范围混搭恢复。需要网页登录态时，把 Camoufox Profile 纳入备份；Firecrawl 按恢复成本决定是否纳入。

**恢复步骤**

1. 停止唯一的写入者。
2. 验证清单、类型、大小和 SHA-256。
3. 在同一文件系统的暂存区准备完整集合。
4. 原子切换并同步目录；失败时补偿恢复完整的原集合。

- 不手工修改 JSONL、幂等记录或操作日志。
- 新版本已经写入业务数据后，不回滚到会产生分叉的旧快照，而是走新的快照操作。

## 受控迁移

这是当前唯一有效的兼容例外，它不授权普通启动去修复旧目录。

- schema 版本单调递增。将来格式变化时，必须先更新文档、schema 和迁移测试，并且只接受当次明确声明的直接来源版本。

### 来源资格与转换范围

- **只支持 `2026080801 → 2026082901`**。Manager 停止当前写入者并建立可回滚的快照后，运行固定的 `migrate` 命令。精确验证业务表和列集合、关键的 CHECK、索引、唯一约束和外键；未知的标记、表或列，缺失的结构或不安全的数据库，在写入之前拒绝。
- 删除六张已退役的知识表、两张原生 Sylver 连接和凭据表、知识相关设置以及残留的知识索引任务；这些内容不会自动转成 MCP。需要保留的，要在升级前从旧版本或快照中导出。
- 旧的 `agent-skills/<scope-hash>/<skill-id>/` **不移动、不删除、不改写**：可移植内容复制到对应工作区的 Skill 包里；`.skill.json` 和对话范围根目录的 `.skill-usage.json` 规范化后复制到 Platform 专有的状态目录。旧的 Manager 快照不包含旧 Skill 根目录；恢复到上一版本的数据库后，旧的 Platform 仍依赖原来的目录树。当前版本不双读。
- 所有旧的对话范围一次性预先规划，按数据库中规范的对话范围类型和 ID 推导出唯一的工作区。遇到以下情况，在创建目录、执行 DDL、更新标记之前拒绝：未知的对话范围或根目录项、非规范的 key 或工作区、重复的目标、路径中的符号链接、硬链接或特殊文件、缺失的私有状态、目标内容不同或有多余项。没有旧来源的 Skill 目录不检查也不改写。
- 唯一允许的旧控制文件是对话范围根目录下的空 `.lock`：属于当前 UID、只有一个硬链接、权限 `0600` 的普通文件。它计入来源指纹，但不复制也不改写；这个例外不意味着接受其它残留文件。预检不缓存全部正文；执行时按对话范围重新读取并匹配有上限的来源指纹。

### 旧 Docker 挂载点权限例外

为了兼容仍在运行的旧 Manager，当前的 Compose 允许同一个 Platform 入口程序短暂以 root 启动；没有额外的辅助镜像。普通 root 命令的封闭白名单和立即降权见[安全设计 · 容器与网络边界](../design/security-and-trust.md#容器与网络边界)。只有固定的 `migrate` 命令、且镜像内带有 `2026080801-to-2026082901` 标记时，才按以下步骤处理：

1. 先以部署 UID/GID 身份（清除附加组，使用镜像内绝对路径、隔离模式的 Python，root 所有的工作目录）只读打开固定的 `platform.db` 检查来源。只有精确匹配旧标记才进入 root 兼容处理；全新或已是当前版本的跳过；未知或不安全的数据库拒绝。root 兼容处理本身不打开数据库、不读密钥，也不执行任意路径或命令。
2. 只在逐段不跟随链接地固定、且属于部署 UID/GID 的 `data/workspaces` 下处理规范的个人和频道工作区。部署用户所有的 `.agent-platform` 只允许精确地从 `0755` 改为 `0700`，不遍历内容，不改属主。
3. root 所有的对象只接受旧 Docker 留下的、精确为 `0755` 的 `.agent-platform/attachments` 两层空目录。允许的崩溃重试中间态只有：root 所有的父目录下唯一一个空的 `attachments`，已属于部署 UID/GID，权限为 `0755` 或 `0700`。多余的项、符号链接、跨设备挂载、其它属主/组/权限或身份漂移都拒绝。
4. 先子后父、非递归地改为部署 UID/GID 和 `0700`；完成后重新固定并完整复核 data 和 workspaces 的身份，立即清除附加组、禁止获得新特权并降权进入普通迁移，不保留 root shell、能力或业务进程。全新、当前版本或已经规范的对象没有任何副作用。

- 这次权限收紧是单调的，兼容旧版本；它不属于 SQLite 快照，失败回滚时也不会反向放宽。
- 下一个基线版本必须在删除直接迁移代码的同时，删除这个固定标记和 root 分支。

### 文件发布与数据库提交

沙箱可以在固定服务栈更新期间继续运行，所以维护状态**不等于工作区的排他锁**。

| 阶段 | 规则 |
| --- | --- |
| 固定对象 | 执行阶段从固定的 data/workspaces 描述符逐段不跟随链接地重新打开，并持有工作区、`.agent-platform`、受保护状态的父目录和暂存目录的描述符；不重新解析预检时的路径。 |
| 发布 | 缺失的目标先在同一父目录下的暂存区准备，逐个文件和目录落盘后，用 `renameat2(RENAME_NOREPLACE)` 发布；创建、写入、fsync、读取身份和复核全部使用固定的描述符。目标已存在时，只有完整的树、字节和权限都精确相同才算幂等成功，不合并也不覆盖。"精确最终态"的重试仍然要完成持久化屏障。 |
| 状态绑定 | 可移植的包发布并确认后，受保护的附属文件写入该包的 `device/inode/ctime`；同一 ID 被删除重建时，不能继承 Agent 自建的权限。 |
| 清理暂存区 | 只有同一父目录下的名称仍然指向固定的 inode 时，才通过不跟随链接的描述符递归删除；被替换、类型未知或身份漂移时保留证据并失败，不按路径字符串递归删除。 |
| 提交数据库 | 所有文件持久化后，再精确复核每个可移植包和状态树；通过后才在单个数据库事务中执行 DDL、更新标记、检查外键和精确验证结构。 |
| 失败与重试 | 数据库事务失败时，保留旧来源和已精确发布的目标，重试时只按相同内容收敛。回滚会恢复上一版本的数据库和版本号，旧来源仍然可用。之后普通启动和候选启动只验证当前身份，不补建目录、标记、别名或附属文件。 |
