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
│   ├── upload-staging/             # 仅在上传请求存活期间存在的 owner-only 暂存文件
│   ├── workspaces/
│   │   ├── user-<id>/
│   │   └── channels/channel-<id>/
│   ├── agent-envs/<scope-hash>/
│   │   ├── home/
│   │   ├── env/
│   │   └── logs/
│   ├── agent-skills/<scope-hash>/  # Skill 包及原子 .skill-usage.json
│   ├── runtimes/
│   │   ├── agent/{sessions,approvals,idempotency,logs}/
│   │   ├── camofox/{profiles,cookies,traces,cache,logs}/
│   │   ├── cognee/{data,system,cache,logs}/
│   │   ├── searxng/{config,cache,logs}/
│   │   └── firecrawl/
│   │       ├── redis/
│   │       ├── rabbitmq/
│   │       └── postgres/
│   └── logs/
└── backups/
```

`manager.toml` 位于 `~/.config/ubitech-agent/`，不属于数据根。`data_root` 是这个布局的唯一可配置根，Platform 权威数据目录始终是规范化后的 `$data_root/data`；schema migration、快照、Sandbox registry 和容器 bind mount 必须引用同一数据目录，不接受第二个 `data_dir`。

Manager 只在已证明 `Current=nil` 的 fresh install 写入边界创建 `data/workspaces/` 这个 owner-only、非符号链接的受管根；普通更新、restart、repair、rollback 与恢复在 migration 或候选 Platform 启动前都只能验证已存在根，缺失、owner 或 mode 异常必须失败，不能借公共 data-layout helper 修复。Platform 候选同样只读打开该根，不能为了通过 readiness 自行创建或 chmod。具体 Agent 子目录仍只由 Platform 在正常已提交运行期创建，或由唯一 P1 的受认证 `commit-release` 归一化流程发布。

上述 `ubitech-*`、`.ubitech*` 和 `enterprise_*` 名称只是当前白标发布读取的桥接源身份，不是可定制品牌或最终基线。品牌设置保存在 Platform 权威数据中，但不得改变数据根、数据库文件、Runtime 目录、workspace/session identity、附件挂载、Skill 状态、Manager journal 或备份路径；品牌修改也不搬移任何文件。备份与恢复必须按真实技术路径工作，不能把管理员显示名称拼入文件名或目录。

紧随本发布的数据布局交接只能由[四阶段发布序列](../operations/deployment.md#技术命名空间交接)执行：source-profile 建立不可变身份边界，source-owner 让 coordinator/helper 完整接通并待命但不触发搬运，桥接发布搬运一次，清理发布删除 source 识别。目标宿主根固定为 `~/.local/share/agent-platform`，容器数据根固定为 `/var/lib/agent-platform`，内部工作目录固定为 `.agent-platform`。禁止用符号链接、活跃数据库复制、双根写入、目录内全局字符串替换或递归猜测来维持兼容。

所有产品持久状态使用宿主 bind mount。Docker 镜像、container writable layer、Engine metadata 和有界容器日志不属于备份数据。不得使用匿名 volume 保存产品权威状态。

## 命名空间交接的数据变换

桥接先把 source 数据 checkpoint 和快照，再停止所有 writer。source 的 `~/.local/share/ubitech-agent/`、source 配置和 source Manager 状态从此只读保留，直到 target 提交确认和清理发布的保留期结束；它们是回滚证据，不能原地 rename、改写 marker 或作为 target 的可写 bind。target 数据先写入 `~/.local/share/` 下与 transaction id 绑定的 owner-only sibling staging，完整校验并同步后才原子发布为 `~/.local/share/agent-platform/`。最终 target 已存在、staging 不空或任一路径的 owner、类型、link count、mount/device 不符合 journal 时，交接在写入前拒绝。

target `manager/` 必须从空状态建立。它只包含由签名桥接 manifest 和 source-owner journal 证明的 target Current、target release、桥接回执、新 activation 事实以及重新创建的 control 目录。以下 source 工件只保留在 source 根并以摘要进入回执，绝不能复制、路径替换或导入 target：`operations/`、Manager self-update state 与 binary history、Candidate/Activation plan、recovery/takeover journal、watchdog 状态、`serve.lock`、`recovery.lock`、control socket、日志和临时下载。这样 target 不会把一个已在 source identity 结算的 operation 当作可重放工作，也不会因绝对 source path 产生伪 Current。为使 target participant 在提交后能够转入普通 Manager，桥接事务必须从已校验的 target Manager 发布物另行生成一个全新的 self-update Current、对应的单个不可变 version 目录及空的 owner-only `serve.lock`、`recovery.lock`、`operations/` 和 `logs/`；这些对象不表达 source 历史，也不得包含 Previous、Candidate、Activation、旧 operation 或旧 binary。target Manager token、executor token、Runtime token、session secret、Camoufox access key 和集成凭据只能按 canonical contract 的精确文件名闭集逐个原值复制：目录中缺少或多出任何名称都在 staging 前失败关闭；每个文件精确保留 owner/group/mode，并对源/目标普通文件做 hash 与无链接校验。source socket、lock 和 staging secret 不在复制范围，任何不安全的源权限都失败关闭而不是在交接时改写。

业务数据只按下表做结构化变换；每一类必须有版本化 reader、明确字段白名单、变换前后不变量和独立校验。任何未知 schema、未知绝对 source path 或同名 target marker 冲突都失败关闭，不降级为文本替换。

| 数据类 | target 变换 | 必须保持与验证的不变量 |
|---|---|---|
| SQLite `platform.db` | 在停止 writer 且完成 WAL checkpoint 后从单一完整主文件建立 target 副本；桥接只把唯一 `schema_migrations` 基线名称从 `ubitech-agent-container-baseline-v2` 改为 `agent-platform-container-baseline-v1`，版本号必须等于签名桥接 manifest 的 `database_schema_version`。当前 schema 的 workspace、附件和 Runtime identity 本来就是相对标识，不允许为了“看起来完成迁移”搜索或改写其它 TEXT/BLOB | `integrity_check`、`foreign_key_check`、`journal_mode`、完整 `sqlite_master` 结构、账号/消息/记忆/会话/附件等每张权威表的行数与有主键表的主键集合；除唯一基线名称外每个表的行内容摘要逐字节不变。健康检查只需取得第一个完整性错误或外键违例就必须失败，不得在 evidence 进程中物化全部违例。source 的 `-wal`/`-shm` 只作为 checkpoint 前一致性集合验证，不能复制到 target |
| Agent Runtime | 当前闭世界只接受 `sessions/`、`approvals/always.json` 与 `idempotency/index.json`；保留 scope、session、lifecycle、approval 与 idempotency id。每个 JSON/JSONL 由对应版本 reader 校验，当前格式没有 technical-profile 或绝对宿主路径，因此文件字节保持不变；`logs/` 是明确登记的临时工件且不迁移。唯一 P1 前驱还可带 canonical contract 登记的 `app/`、空 `home/`、空 `memory/` 与单一 `migration/hermes-cutover.json`：它们是已退役的 Runtime checkout/迁移证据，候选与 evidence 只能按完整库存、owner/mode/link、install/package identity、四个精确 npm 相对 symlink 和 hermes-cutover 闭世界 schema 纯读验明，不得把任意同名目录当作可忽略项；桥接 drain 后用同一规则复验并整体省略，不在 A2 中删除，最终随失去所有权的 source 根由清理发布删除 | JSON/JSONL 逐条可解析、目录哈希与记录 identity 对应、引用的 scope/session 存在、幂等结果与审批状态不变；transcript、模型输入输出、工具正文和错误文本不搜索替换；当前根、明确临时根、精确 P1 退役根以外的顶层节点或未知机器字段失败关闭。机器 schema/version 必须是 JSON integer，布尔值和浮点表示均不等价。JSONL 单文件最多 256 MiB、最多 1,048,576 条非空记录；实现忽略纯空白行并在解码前剥离行首尾空白。Runtime identity 总数最多 16,384，Platform evidence 的 SQLite identity 查询必须在 SQL 层以“限额 + 1”截断后才物化；任一目录最多枚举 65,536 个直接子项，枚举必须流式计数后才排序。P1 checkout 在生成契约中的精确库存条目和非目录字节计数同时也是遍历预算：超过预算必须在继续递归或读取文件内容前拒绝，Platform evidence 与 transformer 必须消费同一份生成契约和一致测试向量 |

`runtime-retired-tree-v1` 的字节流跨实现固定：每条记录依次写入 ASCII kind `D`/`F`/`L`、四字节大端 UTF-8 相对路径长度与路径、四字节大端 mode、八字节大端 size、四字节大端 detail 长度与 detail。目录 size/detail 为零；普通文件 detail 是原始 32-byte SHA-256；symlink size/detail 是 UTF-8 target。先写 `.` 根记录；每层先按名称写全部直接子目录记录，再按名称写全部非目录记录，最后按同一目录顺序递归。条目计数包含根；历史字段 `inventory_regular_bytes` 实际为所有非目录 size 总和（含四个 symlink target bytes）。每层在 `stat` 后、读取普通文件前先验证本层非目录 size 不会超出剩余总预算；每个普通文件再以剩余预算为硬上限 no-follow 打开，并在读取前后复核 inode/size。symlink 必须逐项匹配生成契约且规范化后仍在 `app/` 内。
| workspace / `agent-envs` / `agent-skills` | 用户工作文件原样复制；每个 SQLite 权威 workspace 根把平台内部目录 `.ubitech/` 闭世界映射为 `.agent-platform/`，其下 Agent 用户数据只改这一段目录前缀，文件 bytes、mode、mtime 与可执行位不变；workspace 根另把平台拥有的 `.ubitech-agent-scope.json` schema 1 变换为 `.agent-platform-scope.json` schema 1，并只改 `technical_profile`。source/target 内部目录或两个 marker 同时存在均为冲突。唯一 P1 前驱可有“SQLite 已登记、但该 Agent 从未执行”而完全未物化的 workspace：A2 候选只读确认精确相对身份和安全的现有祖先，并逐 scope 记录根、现存目录链 inode 与首个缺失组件；普通 activation 的 `commit-release` 只能按这份候选观察复验后逐段安全创建并发布 source marker，原本存在的目录不得在同一候选中降级成 missing。桥接 evidence 开始前所有登记 workspace 必须已经物化并符合当前 marker schema。`agent-envs` 与 `agent-skills` 全树按普通文件复制，不解释用户内容；`logs/` 子树不进入 target | workspace id、映射后的相对路径、除 source marker 外的文件内容和元数据按契约保持；marker identity 必须与 SQLite scope 行一致。未物化、缺 alias 及缺失/legacy marker 兼容只接受同一精确 P1 capability；其它 reservation 必须从候选启动起已经具备完整目录、current marker 与 alias。未物化兼容只接受从首个缺失目录起没有任何对象的 P1 scope，不接受损坏、错误 owner/mode、符号链接或 marker 冲突。唯一 owner 例外是 canonical contract 登记的 P1 root-owned 空 `attachments/` 挂载占位：它只可位于 source 内部目录的精确直接子路径、必须为 `0755` 空目录；若其 `.ubitech/` 父目录也是 root-owned，则整个父树只能由这一个空占位构成。两者在 target 归一为部署身份；其它 root-owned 路径失败关闭，不能把 root 加入整个 workspace 的泛化 owner 白名单。用户创建的其它同名文本、嵌套目录或源码不按名称猜测修改，target 冲突直接拒绝 |
| 附件与上传 | 权威附件按相对路径复制；提交前存在的非活跃 `upload-staging` 按临时工件规则丢弃，不迁移为权威数据 | 数据库附件记录、大小和内容 hash 一致；不得把宿主绝对路径写回数据库 |
| Camoufox | `profiles/`、`cookies/` 及 `traces/` 按普通文件逐字节复制；平台 sidecar 从 `.ubitech-agent-runtime.json` schema 1 变换为 `.agent-platform-runtime.json` schema 1，只改 `technical_profile`。`cache/`、`logs/` 和镜像内程序不迁移，绝不解析或改写第三方 Cookie DB、IndexedDB 或网页存储 | 每个受管 Profile 能由 target Camoufox 以同 scope 打开并读取；sidecar 相对路径集合与 Profile 目录命名格式保持；失败则整体交接回滚。管理界面的 source 技术 Cookie 不迁移，用户在 target 上执行一次重新登录 |
| Sandbox registry | 从 source 记录生成全新 target registry；保持 `sandbox_id`、`workspace_id`、scope hash、UID/GID 和持久目录绑定，计算 target 容器名、network 与 label；不复制 container id、PID、running/activity 临时态 | 每条绑定唯一且目录在 target data 下；target ensure 后 Docker label、bind、UID/GID、image digest 与 registry 一致，未知或冲突对象不接管 |
| Docker 固定栈 | 用 target Compose project `agent-platform`、network `agent-platform_core`、`io.agent-platform.*` label 和 target bind 根重新创建；transform manifest 预先声明 target-only `data/.home/` 与 `data/runtimes/camofox/home/`，绝不从 source 复制，启动后其容器同 UID 生成的 cache/home 子树仍受该 transaction publication 根约束 | 不 rename/relabel source 容器，不复用匿名 volume，不删除未知对象；核心服务只连接 target network/data，source/target writer 不同时运行；rollback 只接受上述显式 generated 根内同 target UID/GID 的普通目录/单链接文件，根外新增对象继续失败关闭 |

唯一 P1 source 的即时目录库存也是闭世界，不能把“未作为资源复制”误写成“任意文件均可忽略”。桥接每次构造或重放请求都必须复验根、`data/`、`data/runtimes/`、四个固定 Runtime 根以及 `manager/` 的完整直接子项集合；未知、缺失或类型变化均在创建 staging 前失败。其处置语义固定如下：

| P1 source 对象 | 处置 |
|---|---|
| `backups/`、`manager/migration.json`、Cognee `python-install.json`、SearXNG/Firecrawl 的旧 `docker-compose.*.yaml`、Camoufox `access-key` 与 SearXNG `secret-key` | `retired`：只按精确 owner/mode、闭世界 schema/固定非秘密摘要或 secret 形状复验；不进入 target。历史 Runtime-local key 不等同于当前 `manager/secrets/` capability，禁止覆盖当前 secret |
| `data/runtimes/.upstream-sources.lock`、Camoufox `.install.lock`、`manager/processes/`、`manager/control/` | `ephemeral`：P1 锁必须是 owner-only 空普通文件，processes 必须是 owner-only 空目录；停止 writer 后省略，不复制旧 socket/process 身份 |
| `data/.home/`、SQLite WAL/SHM 与实例锁、`upload-staging/`、各固定 Runtime 的 `cache/`/`logs/` 及 Camoufox `home/` | `generated`：source 内容不复制；target 只按 transform manifest 重新建立明确登记的空根。P1 `data/.home/` 必须为空；Camoufox `home/` 只接受已审计的 `.cache/`、`.camoufox/`、`Downloads/`、`camoufox/` 顶层及三个指向镜像 `/opt/camofox/browser/` 的精确 symlink，且全树只能含部署用户拥有的普通目录、单链接普通文件和这三个 symlink |
| SQLite、workspace marker 与内部 `.ubitech/`→`.agent-platform/` 映射、Agent Runtime 当前状态、Camoufox sidecar 与 Sandbox registry | `retained`：由版本 reader 结构化变换并验证身份不变量 |
| 附件、Skill、Agent 环境非日志内容、Camoufox profiles/cookies/traces，以及 Cognee/SearXNG/Firecrawl 明确数据根 | `copied`：按声明的普通文件树和精确 owner 集复制；未列出的同级对象不因“可能是上游文件”而放行 |

P1 `manager/migration.json` 只接受 schema 1、顶层精确八字段、`status=purged`，以及 retirement 精确九字段、`status=completed` 和四个完成布尔值全为 true；`operation_id`、generation/commit、时间字段必须符合各自固定格式。Firecrawl `.env` 只接受四个已知键及原 P1 引号格式，认证值只做长度/字符集检查而不写入 canonical 文档或日志。三个旧 Compose 与 Cognee install marker 使用经生产只读盘点锁定的 SHA-256；这些摘要只证明唯一 P1 非秘密发布工件，任何内容变化都必须先更新 canonical 设计和验收，不能退回按扩展名放行。

其余明确的数据子树按“停止对应 writer 后的普通文件集合”迁移：`attachments/`、`agent-envs/`（排除 `logs/`）、`agent-skills/`、Cognee 的 `data/`/`system/`/`cache/`、SearXNG 的 `config/`/`cache/`、Firecrawl 的 `redis/`/`rabbitmq/`/`postgres/`。这些资源只允许真实目录和单链接普通文件，逐项保留 mode、owner/group、mtime、size 和 hash；符号链接、设备、socket、FIFO、跨文件系统 mount、未知 runtime 顶层目录都失败关闭。`bootstrap-admin-password.txt` 作为 owner-only secret 单独复制；`.enterprise-platform.lock`、`upload-staging/` 及任意 `logs/` 不迁移。scope marker 更新只在 commit 期间短暂使用数据根目录中的 owner-only 隐藏 staging 名，名称精确绑定 scope、旧 bytes 与新 bytes 三个 SHA-256；Agent 不能看到该根目录。交换后崩溃的新 owner 必须用当前 DB alias、final marker 和该精确旧版 marker 重建唯一 old→new 证明后才删除残留；未知名称、hash 或身份保留并失败关闭。

每项资源还必须声明访问类别。`native` 只允许部署 UID/GID 可直接安全读取和写入的资源；`container_owned_tree` 只允许上段明确列出的 `byte_exact_tree` Runtime 数据树，不能用于结构化数据、单文件、secret、Manager 状态或任意路径。后者由 Engine 注入的 `PrivilegedTreeFS` 完成库存、复制、复验与删除，普通宿主遍历不能因为 owner 白名单包含容器 UID 就假装具备读取能力。生产实现只能运行桥接 release 中 `handoff-fs-helper` 的完整 digest 引用，使用 `--pull=never`、无网络、只读根文件系统、root 身份、仅 `CHOWN`/`DAC_OVERRIDE`/`FOWNER` 能力、`no-new-privileges` 和有界 PID；source 只读挂载、当前 transaction staging 读写挂载、owner-only control 读写挂载之外不得出现其它 bind、volume、device 或 Docker socket。

`container_owned_tree` 的 owner 集合不是“非 Manager UID 都允许”的通配符，而是 [`container-platform.json`](../contracts/container-platform.json) 中逐服务版本化的精确 UID/GID；部署 UID/GID 由 Manager 在运行时加入。当前 Cognee 与 SearXNG 只允许部署身份；Firecrawl 三个 bind root 允许锁定镜像入口建立的 `999:0`，Redis 内容只再允许 `999:1000`，RabbitMQ 与 PostgreSQL 内容只再允许 `999:999`。升级相应镜像并改变运行身份时，必须先修改 canonical 契约和验收，再修改迁移实现。

helper 请求与回执是闭世界 JSON，并共同绑定 schema、operation、transaction、request SHA-256、resource 名称、访问类别、精确 helper image digest、source/target 相对路径和前后清单摘要。worker 从固定挂载根目录 fd 使用 `openat2` 的 `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV`（或语义完全等价且受测试证明的 fd-relative 实现）枚举和操作，拒绝硬链接普通文件、特殊对象、路径逃逸和挂载穿越；复制前后均验证内容 hash、owner/group、mode、mtime、size 与完整相对路径集合。Manager 只接受与请求逐字段一致且摘要正确的 receipt，并在容器退出后重新检查持久 receipt；取消、崩溃和重放只按精确 transaction/request/resource/image ownership label 清理同一 helper 容器与 control 工件。

`container_owned_tree` 的删除不是一般递归删除能力。只有 helper 持有 handoff writer lease、target writer fence 已被独立证明、publication marker/manifest 与本次 request 完全匹配，并且删除前清单仍属于声明资源时才可执行；删除回执必须证明目标已不存在。source 始终只读且永不由该接口删除。任何请求、receipt、镜像摘要、owner、inventory 或 fence 不可证明都保留整棵树并失败关闭。

Platform 管理界面切换 technical Cookie name 时明确选择一次重新登录，而不是在 target 保留 source Cookie 兼容读取分支。用于签名 session、服务间调用和浏览器服务的 secret 仍按原值复制，因此该决定不会隐式轮换 API capability 或清空 Camoufox 中的第三方网站登录态。

source-owner 发布先把三类机器拥有的身份记录升级为可封闭读取的 schema，桥接不能再从目录名反推缺失字段：

- workspace 的现役 source marker 文件名保持 `.ubitech-agent-scope.json`，显式 `schema_version: 1`，字段集合固定为 `kind`、`technical_profile`、`scope_key`、`scope_type`、`scope_id`、`lifecycle_id`、`sandbox_id`、`workspace_id`、`workspace_relative_path` 与 `isolation`。`technical_profile` 必须是 `ubitech-agent-v1`，`workspace_relative_path` 必须精确等于 `workspaces/<workspace_id>`；旧无版本 marker 只有在 owner/type/link/mode、所在目录以及每个身份字段均与 SQLite scope 行完全一致时才原子升级，缺失、未知字段或冲突一律拒绝启动。
- `manager/sandboxes.json` 使用 `schema_version: 2` 并在顶层固定 `technical_profile`。每条记录除原有稳定 identity 外，必须持久保存部署 `uid`/`gid`，以及相对 Platform data root 的 `workspace_path`、`home_path`、`environment_path`、`attachments_path`。Manager 只接受这些路径与当前受信配置按 `workspace_id`/scope hash 推导出的精确绑定；启动时旧 v1 记录必须在四个真实目录均无符号链接、owner 与当前部署身份一致且路径无冲突后一次性原子升级，不能创建缺失目录来“证明”旧记录。Manager binary 仍处于 candidate/watchdog 窗口时只在内存中完成验证，保留磁盘 v1 供上一版回滚；只有 candidate 已被 watchdog 提交，或启动身份本来就是 Current，才原子落盘 v2 并开放完整 control API。
- 平台自有 Camoufox sidecar 固定为 `runtimes/camofox/.ubitech-agent-runtime.json`，`schema_version: 1`，闭世界字段为 `kind`、`technical_profile`、`runtime_relative_path`、`profiles_relative_path`、`cookies_relative_path`、`traces_relative_path` 和 `profile_directory_format`。它只声明 Platform 受管目录和上游 Profile 哈希布局；`profiles/` 内的 `storage-state.json`、`meta.json`、Cookie、IndexedDB、LocalStorage 与其它网页数据仍是第三方格式，source-owner 不解析或改写它们。
- workspace marker 与 Camoufox sidecar 的读写都从已验证数据/workspace 根逐段 `openat(O_NOFOLLOW)` 到固定父目录，并在整个读、复核、发布期间持有目录 fd。读取必须比较打开前、打开后和读完后的 leaf device/inode；写入先用 `O_TMPFILE` 在 fd 上完成 mode、内容和 fsync，再以 no-replace 链接首次 sidecar，绝不暴露半成品或在发布后按路径 `chmod`。workspace marker 替换只在 commit 阶段把完整匿名 inode 链接到 Agent 不可见的数据根隐藏 staging 名，再以同文件系统 `renameat2(RENAME_EXCHANGE)` 交换；交换后必须同时证明 staging 捕获的是预期旧 inode/bytes、final 是准备好的新 inode/bytes，才可删除旧 inode。任一端不匹配时禁止无条件交换回去或删除，保留两端并失败关闭供显式恢复；重放只接受精确 staging/final bytes，未知或冲突对象继续失败关闭。文件系统先决条件探测只允许匿名 inode、目录 fd metadata 与无命名空间副作用的 syscall 可用性检查；`RENAME_EXCHANGE` 的真实支持只由当前 transaction 已绑定的 staging/final 交换证明，失败时保留该精确 staging 供重放。探针不得交换固定名或任何既存目录项。候选启动仅只读验证现有 marker，不申请匿名 inode、不创建 staging，也不做写入型文件系统能力探测。

target staging 的提交门至少包括：文件 manifest 的类型/mode/size/hash、SQLite 完整性与外键、权威行数和 id 集合、Runtime 引用图、所有 workspace 与附件映射、Skill 状态、每个 Camoufox Profile、Sandbox registry/Docker 对账、Platform/Runtime readiness、登录和自动更新 check。通过后先原子发布 target 根，再由持久 helper 取得 target Manager 的事务绑定确认并切换唯一 gateway/control owner；确认前不能删除 source 根或报告成功。

target `manager/` 的生成集合也是闭世界：`state.json`、`active-generation`、`releases/<bridge-generation>/{manifest.json,compose.yaml,compose.env}`、逐个 secret、`sandboxes.json`、owner-only 空 `control/`、`operations/` 与 `logs/`，以及 `manager-binaries.json`、空的 `manager-binaries/{serve.lock,recovery.lock}` 和唯一的 `manager-binaries/versions/<target-version-id>/{agent-platform-manager,metadata.json}`。`state.json` 从签名桥接 manifest 生成 schema 1 idle Current，`Previous`/`Candidate`/`Activation`/active/finalize operation 均为空；`manager-binaries.json` 只登记同一桥接发布的 target Current，version 二进制必须逐字节匹配 manifest 的目标 Manager SHA-256，metadata 必须逐字段匹配该 Current；`compose.env` 只能由 target compile-time profile 和 canonical target 路径生成。固定栈启动或崩溃重放再次生成 `compose.env` 与 `active-generation` 时，若现存对象经 `O_NOFOLLOW` 打开并证明为当前 Manager 用户拥有、单硬链接的普通文件，且权限和预期字节完全相同，必须保留原 inode、mtime 与阶段库存而不执行原子替换；安全对象的字节或权限不同才按正常原子写流程更新，符号链接、非本用户对象、多硬链接或非普通文件一律失败关闭。target 根在交接终态前还保留 engine 生成的 `.handoff-staging.json` 与 `handoff-manifest.json`，它们是 `RestoreData`/崩溃重放使用的 owner-only publication identity，不是普通 Manager operation；清理发布在 target committed 回执后精确删除它们。上述文件连同 transaction id、source/target root、manifest/Compose/Manager 摘要形成发布身份；崩溃重放只接受完全相同的 staging 或已经原子发布且身份完全相同的 target。任何 source operation、self-update history、Candidate/Activation、recovery、日志内容、lock 内容、socket、下载目录或未知 Manager 文件出现在 target 都是验证失败。

失败回滚始终以未改写的 source 根为真相：先 fence target Manager 与所有 target writer，只删除本 transaction 创建且身份摘要匹配的 target staging、unit、容器和网络，然后重启 source unit/Compose 并验证 source SQLite、Runtime、workspace、Sandbox 和公网入口。固定栈 writer fence 不复用 UI health：它闭世界列出 Docker 容器，逐个核验 technical profile、Compose project/service、不可变镜像、container id、`State.Running` 与 `State.Pid`；只接受相关容器不存在或明确 `Running=false,Pid=0`，同 project 未知/重复 service、额外 profile writer或任何 list/inspect/daemon/权限/解码不确定性都保留数据并失败关闭。target core network 是 transaction-owned 资源：创建时必须带 target profile ownership、transaction id 与 binding SHA-256 标签；删除前必须在 writer fence 之后按精确名称重新 inspect driver、全部标签、Docker network id 和 endpoint 数，只有本事务标签完全匹配且 endpoint 为零时才按刚读取的 id 删除。不存在是幂等成功；既有/未知网络、身份变化、inspect 不确定或任何消费者都失败关闭，绝不调用全局 network prune。目标固定栈在提交前可能已在声明路径内写入实例锁、SQLite WAL/SHM、control bind lock 或 Runtime 临时状态，因此删除门重新验证的是原始 transaction marker、完整 manifest 资源绑定、闭世界路径、类型、owner、link 与 device，而不是错误地要求启动前的每个文件 hash、size 和 mtime 仍未变化；任何未由 manifest 声明的新增路径、异常 owner/type/link 或 publication/staging 身份冲突仍必须保留整棵 target 并失败关闭。任何阶段都不允许两个 Manager、两个 Platform writer 或两个公共入口所有者并存。target 一旦完成确认并开放公共写入，source 数据可能开始落后；此后不得自动切回 source，只能按 target 正常 snapshot/operation 恢复。清理发布只有在 target 重启、自动更新和 source-owner committed 回执全部验证后，才可按保留策略精确删除 source 根及一次性 handoff 工件。

## Platform 与文件数据

`platform.db` 是账号、凭据、消息、记忆、知识、任务和设置的权威存储。SQLite 使用 WAL；迁移和备份必须在线 backup 或在停止 writer 后 checkpoint，不能单独复制主文件。

附件、工作区和 Skill 的逻辑关系保持原设计。附件数据库路径为相对路径。Multipart 上传先增量写入 `upload-staging/` 下按请求隔离的 `0700` 目录和 `0600` 普通文件，提交后流式复制到 `attachments/`；staging 不是权威数据，不进入备份，并在请求成功、失败、取消或超时后删除。Platform 启动可以清理不属于活跃请求的遗留 staging 目录。工作区在数据库中保存相对标识，不保存宿主绝对路径；Platform 将其解析为宿主数据目录，Sandbox 内统一映射为 `/workspace`。管理器只把与当前私人或频道 scope 对应的附件子目录只读挂载到 `/workspace/.ubitech/attachments`。当前 scope 的可信系统提示可以同时说明 `/workspace` 和由 Manager 数据根派生的精确宿主映射，帮助 Agent 在获批宿主命令中理解同一文件；该绝对路径不得写入数据库、公共 API、普通 Runtime metadata 或日志。

Skill 使用与来源状态位于每个 scope 根的 `.skill-usage.json`，与包一起进入平台快照。文件为部署用户 owner-only 普通文件，以临时文件、fsync、rename 和父目录 fsync 原子替换；不是目录、符号链接、硬链接或未知 schema 时失败关闭。缺少单个 skill id 的状态不补猜历史来源，而按 user-owned active 处理。

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

Cognee 代码和依赖位于 Platform 镜像，数据、system、cache、logs 与 `.env` 位于数据根。SearXNG 的整个 `config/` 目录只读映射到容器 `/etc/searxng`，`cache/` 单独读写映射；不能只覆盖 `settings.yml`，否则上游镜像声明的 `/etc/searxng` volume 会在每次 generation 切换时生成无法追踪的匿名卷。Firecrawl 的运行配置由 Compose 环境提供，Redis、RabbitMQ 与 PostgreSQL 数据分别映射到上图所列目录。当前数据布局不声明 FoundationDB 目录，release 也不得为它创建或挂载路径。权威数据不得只存在于匿名 Docker volume，固定服务的 Compose 也不得因镜像内 `VOLUME` 声明产生匿名持久卷。

## 管理状态与 generation 快照

管理器状态根保存 current/previous/target release、generation、operation journal、心跳和 owner-only control socket。`operations/` 内任何非终态、未 finalized 或被 active/finalize state id 引用的 journal 都是永久保护项；其余终态 journal 保留七天且至少保留最新 `128` 条，由稳定空闲状态的维护循环使用 owner/type/path/inode 复核与父目录 fsync 精确裁剪。裁剪不遍历或删除 recovery journal 和 activation plan。每个本地 `releases/<commit>/` 的 manifest 与 Compose 是不可变发布物；可变的 `compose.env` 只包含该宿主生成的路径与镜像 digest。`active-generation` 由 Manager 原子写入，明确指出停止、日志和恢复命令应使用的 Compose generation，不能按目录修改时间猜测。Platform 的业务数据库不得成为容器编排状态的唯一存储，否则 Platform 失败时无法恢复。

每次可能改变数据库或 sidecar 格式的 operation 都建立与目标 generation 绑定的一致快照，至少保留 previous generation 所需的回滚点。容量门禁对每个受管快照源采用 `max(逻辑大小, 已分配块大小)`，并在 reservation 前以及 reservation 后、停止 writer 前各检查一次，避免稀疏文件、WAL 增长或并发文件变化把实际回滚成本低估。快照 manifest 记录受管文件的类型、mode、大小与内容 hash；只有文件和 manifest 全部同步、父目录也完成同步后，快照才能写入 operation journal。所有受管镜像还共享 canonical 的压缩层与展开后容量上限；核心预拉取、能力后台收敛和 Sandbox 按需拉取都必须按本地缺失 digest 使用该目录，不能只有更新主链路执行容量门禁。

快照不得直接向最终 `backups/<operation-id>/` 写入半成品。Manager 先在 `backups/` 下创建名称绑定 operation id 的 owner-only staging，增量复制受管文件、写 manifest 并同步 staging；全部成功后才原子 rename 为最终目录并同步 `backups/`。复制、manifest、校验、同步或 ENOSPC 在发布边界前失败时，只精确清理本次 staging 并保持最终路径不存在。进程在清理前崩溃时，维护循环只识别符合受管命名、类型、所有权和内容白名单的 staging，并在 `obsolete_artifact_retention_seconds` 宽限后删除；未知目录或附加证据继续保留。

快照清理由 generation 引用和明确保留策略驱动。current、previous、活动或 finalize-pending operation 引用的快照绝不能删除；不得按普通最终目录名称或修改时间猜测归属，也不得对 `backups/` 使用全局递归清理。唯一按较短工件宽限处理的是上述带 operation 身份且通过严格白名单复核的崩溃 staging。Manager 只在稳定空闲状态执行维护：从状态、operation journal、Sandbox registry 和 release manifest 计算带 epoch 的保护集合，再裁剪已过保留期且具备完整归属的快照、旧 release、旧 Manager binary、staging/recovery 临时工件和不再被任何容器使用的受管镜像。慢速目录/hash/Docker 检查在准入锁外执行，每个删除边界重新核对 epoch 和保护集；变化即保留。清理只允许精确对象删除且失败可重试，禁止全局 Docker prune、通配路径删除或触碰未证明归属的数据、镜像和 volume。

应用与容器日志必须轮转。默认限制和保留数量由管理器实现与测试约束；日志不得无限增长，也不得包含 secret、原始宿主执行凭据或 Docker registry 凭据。

## 备份与恢复

一致备份至少包含 SQLite backup、attachments、workspaces、agent-envs、agent-skills、Runtime session/approval/idempotency 和 Manager release/operation state。需要保留网页登录态时包含 Camoufox Profile；Cognee 和 Firecrawl 数据按恢复成本纳入。

恢复时先停止 Platform writer，再恢复数据与 manager generation，最后由管理器重建容器。数据库快照恢复必须在改动当前数据前完整校验 manifest、文件类型、大小与校验和，把全部目标文件复制并同步到数据目录同文件系统的 staging；提交时先把现有数据库、WAL、SHM 和快照包含的其它受管文件移入事务备份，再切换 staging 文件并同步目录。任一复制、rename 或目录同步失败都必须补偿恢复提交前的完整文件集合，不能留下缺失或跨 generation 混合的 SQLite 文件。不得手工编辑 Runtime JSONL、幂等记录或 manager operation journal。
