# 数据布局

本页拥有路径、marker、备份集合和直接迁移例外；事务见[数据设计](../design/data-memory-sessions.md)，fd/发布安全见[安全设计](../design/security-and-trust.md#文件与附件)，步骤见[部署](../operations/deployment.md)。

## 唯一根目录

| 对象 | 固定位置 |
| --- | --- |
| 宿主入口 | `~/.local/bin/agent-platform-manager` |
| 配置 | `~/.config/agent-platform/manager.toml` |
| 用户 unit | `~/.config/systemd/user/agent-platform-manager.service` |
| 默认持久根 | `~/.local/share/agent-platform/` |
| Platform 权威目录 | `$data_root/data`；`data_root` 是唯一可配置持久根 |
| 容器数据根 / 工作区 / 内部工作目录 | `/var/lib/agent-platform` / `/workspace` / `.agent-platform` |

`~` 只从当前 UID 的唯一操作系统账户 home 记录派生；安装器与 Manager 忽略 ambient `HOME`、`XDG_BIN_HOME`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME`。control socket 可使用安全验证后的 `XDG_RUNTIME_DIR`，缺失时回退 `/run/user/<uid>`。

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

仅接受 `agent-platform-container-baseline-v1`、`.agent-platform-scope.json`、`.agent-platform-runtime.json` 和当前 Sandbox registry；字段精确闭合，旧根/profile/marker、未知字段或混合身份拒绝。普通操作无旧路径发现、双读或历史解码，唯一例外是[受控迁移](#受控迁移)。品牌不改变机器身份。

## 权威数据与文件安全

权威状态必须宿主 bind mount，不用匿名 volume。镜像、writable layer、Engine metadata、缓存与日志不是备份数据。

| 对象 / 时点 | 必须成立 |
| --- | --- |
| 数据库 | 固定数据根 fd 逐段 no-follow 打开；DB/WAL/SHM 必须当前 UID、单链接普通文件，缺 DB 以 `O_CREAT | O_EXCL | O_NOFOLLOW`、`0600` 创建。owner/type/link/inode 异常在 writer 前拒绝。 |
| 实例锁 | SQLite/worker/副作用前从同根 fd 打开 `.agent-platform.lock`，`O_NOFOLLOW | O_CLOEXEC`、创建 exclusive；当前 UID、普通/nlink=1，验明后才可 fd 收紧 `0600`，异常不修复。 |
| 锁生命周期 | 非阻塞独占 flock；取得及写 PID 前后复验锁 fd、父项、规范数据根 inode。置换即释放失败，锁/父 fd 持生命周期，关闭不 unlink。 |
| DB 备份 | SQLite backup，或停唯一 writer 后 checkpoint；不能仅复制活动主文件。 |

## Workspace、附件与 Skill

| 状态 | 位置与身份 |
| --- | --- |
| 私人 / 频道 workspace | `data/workspaces/user-<id>/` / `data/workspaces/channels/channel-<id>/` → `/workspace`；委派共用父目录。 |
| 用户环境 | `agent-envs/<scope-hash>/{home,env}` → `/home/agent`、`/opt/agent-env`；系统层随重建丢失。 |
| Skill 包 | workspace `.agent-platform/skills/<skill-id>/`，仅 `SKILL.md`、`references/`、`templates/`、`scripts/`、`assets/`。 |
| Skill 状态 | Platform-only `agent-skill-state/<scope-hash>/`，不挂 Sandbox；workspace sidecar 不授权。 |
| MCP | workspace `.agent-platform/mcp.json`、`.agent-platform/mcp/<server-id>/`；不双存/搜索其它客户端路径。 |
| 上传 / 附件 | `upload-staging/` 请求目录 `0700`、文件 `0600`；提交到 `attachments/`，DB 路径相对。生命周期见[上传](../design/security-and-trust.md#上传交付与预览)。 |
| 附件挂载 | 当前 scope 只读 `/workspace/.agent-platform/attachments`，不能挂全局/其它 scope。 |

scope marker 精确含 logical key/type/id、当前 Runtime lifecycle、sandbox/workspace identity、`technical_profile`、固定隔离边界。DB 仅存 canonical 相对 workspace identity，不存绝对路径/可选后端；越界、字段/profile/身份漂移在启动及每次读取拒绝，缓存不豁免。宿主映射仅可进入当前 scope 可信系统提示，不入公共 API/普通 metadata/DB；生命周期见[数据设计](../design/data-memory-sessions.md#agent-scope)。

## Sandbox

registry 记录 sandbox/workspace identity、UID/GID、相对挂载、image digest；名称/layer 不授身份，首次 `sandbox_id` 不改绑。每次创建/启动前 Manager 验 workspace/HOME/env/附件源与目标：数据目录内、无 symlink、部署 UID/GID、`0700`；缺挂载目标在 Docker 前创建，不由 root daemon 代建。registry 原子写是 ensure 提交点，失败停/删本次新容器并恢复原记录。

## Runtime 与集成服务

程序/依赖在镜像，Runtime 状态在 `runtimes/agent`，Camoufox 状态在 `runtimes/camofox`；浏览器 staging 在请求结束/服务启动清理。SearXNG 完整 `config/` 只读映射 `/etc/searxng`；Firecrawl 无 FoundationDB。

既有部署必须有 `runtimes/camofox/.agent-platform-runtime.json` 及受管父目录；普通/候选启动缺失或错身份拒绝。`serve/migrate` 仅在**建 DB 前确认 DB 不存在**的 fresh 上下文可创建 sidecar，资格显式传递，不从缺失推断、不误拒同次新 DB；旧库迁移保留而不补建，fresh migrate 后可按既有部署启动。

## Manager 状态、快照与清理

`active-generation` 决定停止/日志/恢复目标，不按目录时间猜测。可能改 DB/sidecar 的 operation 停 writer 后建绑定 generation 的快照：owner-only staging → 文件/manifest/父目录 fsync → 原子发布 `backups/<operation-id>/`，失败仅清本次 staging。

始终保护 Current/Previous/Candidate、active/finalize operation、未 finalized journal、关联快照及运行容器引用的 release/镜像。仅稳定 idle 从单一保护快照删过期未引用对象，每个删除点复验 epoch/owner/type/inode/label/digest，禁全局 prune/通配递归。保留策略见[自动更新](../operations/auto-update.md)，tmp 删除授权见[安全设计](../design/security-and-trust.md#管理器与更新)。日志轮转，不含 secret/执行或 registry 凭据。

## 备份与恢复

一个恢复点至少含 SQLite backup、attachments、workspaces、agent-envs、agent-skill-state、Runtime session/approval/idempotency、Manager release/operation/generation。workspace 包含 Skill/MCP/server/自存环境值，不跨 scope 配回；需网页登录态纳入 Camoufox Profile，Firecrawl 按恢复成本纳入。

恢复停唯一 writer，验 manifest/type/size/SHA-256，同文件系统 staging 准备完整集合，再原子切换并同步目录；失败补偿完整原集合。不手改 JSONL/idempotency/journal；新 generation 已写业务后不回滚分叉旧快照，走新快照 operation。

## 受控迁移

这是当前唯一活动兼容例外，不授权普通启动修复旧目录。schema 单调递增；未来格式变化须先更新文档、schema 和迁移测试，并只接受当次明确声明的直接来源。

### 来源资格与转换范围

- 仅 `2026080801 → 2026082901`；Manager 停 current writer 并建可回滚快照后运行固定 `migrate`。精确验证业务表/列集合、关键 CHECK、索引、唯一约束、外键；未知 marker/table/column、缺失结构或不安全 DB 在写入前拒绝。
- 删除退役的六张知识表、两张原生 Sylver 连接/凭据表、知识设置及残留知识索引任务；不自动转成 MCP。需保留者升级前从旧版/快照导出。
- 旧 `agent-skills/<scope-hash>/<skill-id>/` **不移动、不删除、不改写**：便携内容复制到对应 workspace Skill 包，`.skill.json` 与 scope 根 `.skill-usage.json` 规范化复制到 Platform-only 状态。旧 Manager 快照不含旧 Skill 根；恢复前一 DB 后旧 Platform 仍依赖原树。当前版本不双读。
- 全部旧 scope 一次预规划，以 DB canonical scope type/id 推导唯一 workspace；未知 scope/root 项、非规范 key/workspace、重复目标、symlink 组件、hardlink/特殊文件、缺失私有状态、目标差异/额外项，须在目录创建、DDL、marker 更新前拒绝。没有旧 source 的 Skill 目录不检查、不改写。
- 唯一允许的旧控制文件是 scope 根空 `.lock`：当前 UID、单链接、`0600` 普通文件，纳入源指纹但不复制/改写；不因该例外接受其它 residue。预检不缓存所有正文；apply 按 scope 重读并匹配有界源指纹。

### 旧 Docker 挂载点权限例外

当前 Compose 可让同一 Platform entrypoint 短暂 root 启动，以兼容仍运行的旧 Manager；没有额外 helper 镜像。普通 root 命令的闭合白名单与立即降权见[安全设计](../design/security-and-trust.md#容器与网络边界)。仅固定 `migrate` 带镜像内 `2026080801-to-2026082901` 标记时：

1. 先以部署 UID/GID、清附加组、镜像内绝对 isolated Python、root-owned cwd，只读固定 `platform.db` 检查来源。精确旧 marker 才进入 root 兼容；fresh/current 跳过，未知/不安全 DB 拒绝。root 兼容本身不打开 DB、不读 secret、不执行任意路径/命令。
2. 只在逐段 no-follow 固定、部署 UID/GID 所有的 `data/workspaces` 下处理规范私人/频道 workspace；部署用户所有 `.agent-platform` 只允许精确 `0755 → 0700`，不遍历内容、不改 owner。
3. root 所有对象只接受旧 Docker 精确 `0755 .agent-platform/attachments` 两层空目录。允许的崩溃重试中间态仅为 root 父下唯一空 `attachments` 已属部署 UID/GID、模式 `0755` 或 `0700`。额外项、symlink、跨设备挂载、其它 owner/group/mode 或身份漂移都拒绝。
4. 子后父、非递归改为部署 UID/GID 与 `0700`；完成后重新固定并完整复核 data/workspaces 身份，立即清附加组、禁止新特权并降权进入普通迁移，不保留 root shell/能力/业务进程。fresh/current 或已规范对象无副作用。

这次权限收紧单调且兼容旧 generation，不属于 SQLite 快照，失败回滚也不反向放宽。后续 baseline 必须随直接迁移消费者删除固定标记及 root 分支。

### 文件发布与数据库提交

Sandbox 可跨 fixed-stack 更新存活，维护态**不等于 workspace 排他锁**。

| 阶段 | 不变量 |
| --- | --- |
| 固定对象 | apply 从固定 data/workspaces fd 逐段 no-follow 重开并持有 workspace、`.agent-platform`、protected state parent、staging fd；不重新解析预检 Path。 |
| 发布 | 缺失目标用同父 staging，逐文件/目录持久化后 `renameat2(RENAME_NOREPLACE)`；创建、写入、fsync、身份读取与复核全用固定 fd。既有目标仅完整树、字节、权限精确相同时幂等成功，不合并/覆盖。exact-final 重试仍须完成耐久屏障。 |
| 状态绑定 | portable 包发布/确认后，protected sidecar 写入该包 `device/inode/ctime`，同 id 重建不得继承 agent-owned 权限。 |
| 清 staging | 只在同父名称仍等于固定 inode 时 no-follow fd 递归；替换、未知类型、身份漂移保留证据并失败，不按字符串递归删除。 |
| 提交 DB | 所有文件耐久后，再精确复核每个 portable/state 树；通过后才在单一 DB 事务中执行 DDL、marker 更新、外键及精确结构验证。 |
| 失败 / 重试 | DB 事务失败保留旧 source 与已发布精确目标，重试仅按相同内容收敛；回滚恢复前一 DB 与 generation，旧 source 仍可用。普通/候选启动随后只验证当前身份，不补目录/marker/alias/sidecar。 |
