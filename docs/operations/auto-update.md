# 自动更新

本文定义当前 Docker 基线的发布检测、任务排空、维护、提交和回滚协议。部署拓扑见[部署](deployment.md)，持久目录见[数据布局](../reference/data-layout.md)。

## 唯一真相源

`ubitech-manager` 是部署机唯一更新控制器。部署机不读取 Git remote、branch 或 working tree，也不从仓库脚本启动产品。main 通道的 release manifest 是唯一版本目录；实际运行身份由清单中的完整 Manager 校验和、Compose 内容和镜像 digest 共同确定。

CI 只有在文档门禁、Python、Runtime、前端、Manager、容器构建、上游契约与真实 Compose smoke test 全部成功后才发布清单。全部受管镜像先生成唯一的已验证 digest 目录：双架构容量门、真实 Compose 验收与最终 release manifest 必须消费这一份目录。Compose 验收在启动前逐项确认解析后的服务镜像就是将发布的 digest，不得使用另一套默认值通过验收。每个 main commit 先产生不可变 `container-<commit>` release，main 通道再在全局 promotion 锁内只向已通过质量门的后代 commit 单调推进。较早 workflow 即使后完成，也不能改写 latest 或触发降级。发布清单必须最后出现，实例不能看到半套发布物。

Manager 将 `releases/<source-commit>/` 视为不可变身份：manifest 与 Compose 先下载到同目录 staging，完整验证并同步后原子发布。相同 commit 的工件必须逐字节一致；缺件或内容漂移视为 immutable-ID collision，必须在拉取镜像和进入维护前失败。

当前通道发布出的 release manifest 镜像目录必须与当前契约定义的服务集合精确相等；缺少必需镜像或由发布器携带未知、退役服务键都在发布前失败。JSON Schema、发布组装和静态验收共用同一集合，不能通过额外字段保留第二套运行基线。Manager 解析器只为协议前向演进接受名称和 digest 格式安全的额外镜像项，并将其视为不可执行的 opaque metadata；只有当前契约显式命名的镜像能够被拉取、启动或展示。

管理员品牌配置不是 release identity。产品显示名称、标识图或其它展示字段变化不创建 generation，不改变清单 URL、commit、镜像 digest、Manager 路径、Compose/Docker identity、环境变量或任何更新幂等键；更新期间也不能从品牌值推断这些字段。Platform 不可达时，Manager 使用中性维护文案，不把读取业务数据库作为控制面健康或回滚前提。

### 技术命名空间迁移发布

当前白标发布只清除产品展示绑定，不宣称具备命名空间迁移所有权。其后必须先发布一个普通、不会触发迁移的源侧交接能力 generation；该 generation 在全部现役实例上稳定并通过真实断电恢复矩阵后，下一 release 才执行[技术命名空间交接](deployment.md#技术命名空间交接)，并再由一个清理发布形成连续的两发布事务，不能伪装成普通镜像 generation 更新。桥接发布继续提供现役 Manager 能发现并校验的原技术资产，同时把签名目标固定为 `agent-platform-manager`、`agent-platform-manager.service`、`~/.config/agent-platform`、`~/.local/share/agent-platform`、`/var/lib/agent-platform`、`agent-platform`、`agent-platform_core`、`AGENT_PLATFORM_*`、`io.agent-platform.*`、`agent-platform-sandbox-*` 和 `.agent-platform`。在进入维护前它必须证明系统处于无 operation、无 activation/watchdog、无执行调用的稳定边界，并先持久化绑定源/目标全部身份的 handoff journal。其公开 operation 只有在目标 Manager 已接管、目标核心 generation 健康、自动更新轮询可达且源身份已安全退役后才能 finalize；仅复制数据、启动目标 unit 或返回健康页都不构成成功。

桥接失败必须由同一 journal 回到唯一源 Manager 和原业务入口。目标状态不完整、两套 unit 同时可能启动、源/目标路径包含符号链接、Docker ownership 无法证明或任一持久摘要变化时保持维护并失败关闭。后续清理发布在确认 bridge terminal commit 后移除一次性识别与迁移实现；普通发布不得永久同时接受两套路径、unit、label、Cookie、API 或 release asset。CI 必须从上一公开基线真实执行桥接、在每个持久阶段注入终止并验证只存在一个更新所有者，再验证清理发布不能重新识别源命名空间。main 通道不得在全部现役实例尚未写入桥接 `target_ack` 且提交 `committed` 时把 latest 推进到只支持目标身份的清理发布；单实例部署也必须用该实例回执作为 promotion 门，不能依赖轮询恰好先看到中间 release。

#### 第一发布的触发与所有权

桥接能力必须先随当前白标基线之后的一个普通 source-identity generation 到达并完成 Manager 自更新；承载该能力的 release manifest 仍为普通清单，不能触发交接。只有其后的桥接清单携带严格版本化的 `namespace_handoff` 描述符时，已稳定运行的 Current Manager 才能自动建立交接事务。这样现役旧 Manager 不需要解析未知字段，桥接 Candidate 也不会在普通 activation/watchdog 尚未结算时搬移自己的状态根。描述符必须同时提供现役 Manager 可读取的源 Compose/Manager 工件和目标 Manager、目标 Compose 工件，所有 URL、摘要、源/目标 identity 和 bridge generation 都属于同一不可变清单；缺少任一目标工件时只能把该发布视为不可执行，不能退回普通 update。

建立 journal 前必须同时满足：当前 Platform generation 与桥接清单声明的 predecessor 完全相等；Manager 自更新 `Current` 已稳定且 `Candidate`、`Activation`、普通或恢复 watchdog 均为空；Manager state 没有 active 或 finalize-pending operation，全部旧 operation 均为可验证终态；`maintenance=false`、公开状态为 `idle`；Platform reservation、Agent Run、durable job、Sandbox active call、Sandbox/host 后台进程和文件提交窗口均为空；源 unit、stable binary、配置、数据根、socket、Compose project、网络和 ownership label 与清单声明精确匹配；目标 unit、binary、配置、数据根、socket、Compose project、网络及 label 不存在；源和目标父目录是当前 UID 所有、不可被其它身份写入的真实目录，且数据 relocation 使用同一文件系统或经过完整 staging manifest 验证。等待任务只进入 `waiting_for_tasks`，不会提前创建目标对象；任一身份不确定都在零副作用边界失败。

交接不是普通 `runUpdate` 的一个 phase。源 Manager 先持久化独立 handoff journal，再从已验证的不可变 Manager 工件安装并启动 owner-only、事务期间持久化的 user-systemd helper unit，并证明 helper 的 unit 文件、PID、可执行文件 SHA、参数、cgroup 和 journal 完全相符。该 unit 必须启用到事务 terminal，确保宿主重启后仍能按同一 journal 续作；写入 `committed` 或 `rolled_back` 并完成验收后才禁用和删除。普通 transient unit 不具备跨重启所有权，不能用于此事务。helper 是停止源 unit 后唯一有权写 handoff journal、切换数据根和启动目标 unit 的进程；源、目标 Manager 与 watchdog 均不得同时拥有该事务。公网 listener 还必须由 helper 以继承文件描述符或等价的单一 socket owner 继续提供维护页，直至目标 Manager 接管，不能在两个 Manager 间竞态重绑端口。

#### Handoff journal schema

journal 使用 schema 1、`0600` owner-only 普通文件和同目录 flock，事务目录本身为 `0700`、不位于会被直接 rename 的源或目标根内。每次变化都以临时文件、file fsync、rename 和 parent fsync 原子提交；`binding_sha256` 覆盖 `source`、`target`、`release` 与首次 `evidence` 的规范 JSON，后续重放不得改写这些字段。结构固定为：

```json
{
  "schema_version": 1,
  "transaction_id": "handoff_<32 hex>",
  "status": "running|committed|rolled_back|failed",
  "phase": "planned|helper_armed|admission_reserved|snapshot_ready|writers_stopped|source_fenced|target_staged|data_relocated|target_started|target_verified|source_retired|committed|rollback_planned|target_stopped|data_restored|source_started|rolled_back",
  "binding_sha256": "<64 hex>",
  "release": {
    "predecessor_generation": "<40 hex>",
    "bridge_generation": "<40 hex>",
    "manifest_path": "<absolute path>",
    "manifest_sha256": "<64 hex>",
    "target_manager_sha256": "<64 hex>",
    "target_compose_sha256": "<64 hex>"
  },
  "source": {
    "namespace": "ubitech-agent-v1",
    "unit": "ubitech-agent-manager.service",
    "unit_enabled": true,
    "unit_path": "<absolute path>",
    "unit_sha256": "<64 hex>",
    "stable_binary": "<absolute path>",
    "stable_sha256": "<64 hex>",
    "config_path": "<absolute path>",
    "config_sha256": "<64 hex>",
    "data_root": "<absolute path>",
    "socket_path": "<absolute path>",
    "compose_project": "ubitech-agent",
    "core_network": "ubitech-agent_core",
    "core_network_id": "<docker object id>",
    "label_prefix": "org.ubitech.agent."
  },
  "target": {
    "namespace": "agent-platform-v1",
    "unit": "agent-platform-manager.service",
    "unit_path": "<absolute path>",
    "stable_binary": "<absolute path>",
    "config_path": "<absolute path>",
    "data_root": "<absolute path>",
    "socket_path": "$XDG_RUNTIME_DIR/agent-platform-manager/manager.sock",
    "compose_project": "agent-platform",
    "core_network": "agent-platform_core",
    "label_prefix": "io.agent-platform."
  },
  "evidence": {
    "manager_state_sha256": "<64 hex>",
    "self_update_state_sha256": "<64 hex>",
    "sandbox_registry_sha256": "<64 hex>",
    "docker_inventory_sha256": "<64 hex>",
    "database_schema_version": 1,
    "database_integrity": "ok",
    "runtime_identity_sha256": "<64 hex>",
    "workspace_identity_sha256": "<64 hex>",
    "snapshot_path": "<absolute path>",
    "snapshot_manifest_sha256": "<64 hex>",
    "boot_id": "<uuid>"
  },
  "helper": {
    "unit": "agent-platform-namespace-handoff-<12 hex>.service",
    "executable": "<absolute immutable path>",
    "sha256": "<64 hex>",
    "pid": 1234,
    "control_group": "<exact systemd cgroup>"
  },
  "target_ack": {
    "manager_version": "<release version>",
    "executable_sha256": "<64 hex>",
    "source_commit": "<40 hex>",
    "pid": 1234,
    "socket_path": "$XDG_RUNTIME_DIR/agent-platform-manager/manager.sock",
    "auto_update_check_at": "<RFC3339>"
  },
  "history": [{"phase": "planned", "at": "<RFC3339>", "note": ""}],
  "error": "",
  "created_at": "<RFC3339>",
  "updated_at": "<RFC3339>",
  "completed_at": null
}
```

示例中的数据库 schema 数字只是类型占位，真实值必须等于桥接清单与数据库 marker。`target_ack` 只能由执行目标 stable inode 的目标 Manager 通过 owner-only handoff capability 写入；helper 只能验证，不能代签。secret 内容、token 和原始数据库内容不得进入 journal，只记录路径身份与摘要。每个 phase 只接受上一 phase 或该 phase 已完成事实的幂等重放；发现后继事实时只能按明确列出的半提交规则补 checkpoint，不能跳阶段。进入 `source_fenced` 后的任何不可恢复错误先写 `rollback_planned`；回滚按反向 phase 恢复数据位置、源 Docker ownership、源 unit enabled 状态、源 Manager inode及公网入口，全部探针通过后才写 `rolled_back`。若回滚证据不完整则保持 `failed + maintenance=true`，不得同时启动两套 unit。

#### 实现切点与发布门

桥接实现必须作为一个完整变更同时接通以下边界，不能只增加 CLI 或目录复制脚本：

- `containers/release-manifest.schema.json`、`manager/internal/release/manifest.go` 与 release workflow：加入版本化 handoff 描述符、predecessor、目标 Manager 和目标 Compose 工件，并确保桥接前普通清单不触发；
- `manager/internal/model`、`manager/internal/journal` 与 `manager/internal/operation`：公开等待/维护投影与 handoff transaction 互斥；独立 handoff journal 不能放进将被搬移的普通 operation 根，也不能走 `runUpdate` 的失败回滚；
- 新的 `manager/internal/handoff` 与 Manager helper 子命令：实现 owner/type/no-symlink 校验、flock、phase 重放、systemd helper 身份证明、单 listener 交接、源/目标 unit fencing及反向恢复；完整实现以前不得注册该命令；
- `manager/cmd/.../main.go` 与 `manager/internal/selfupdate`：普通 Candidate 必须先完成 watchdog commit，再允许 handoff；stable path、unit、socket、token 和 startup ownership 必须显式绑定 source/target profile，目标 Manager 只能用 `target_ack` 接管；
- `manager/internal/config`、`manager/internal/driver`、`manager/internal/sandbox` 与 `manager/internal/snapshot`：生成固定目标配置，迁移数据根，重建 neutral Compose/network/label/container ownership，转换已停止的 Sandbox registry，并保留精确源快照；ownership 守卫必须认识“当前事务指定的一次转换”，不能永久接受双前缀；
- Platform、Agent Runtime、Camoufox、Compose 与容器入口：桥接 generation 同时能在源环境启动、在目标环境完成一次迁移，显式转换数据库 marker、Runtime/session/idempotency、workspace marker、Cookie 和浏览器持久状态；清理 generation 随即删除源读取；
- Gateway 与 control API：handoff 期间持续返回中性维护页，状态端点从源路径一次性交接到中性路径；目标自动更新至少成功执行一次带认证的 `check` 后才允许 commit；
- CI：从上一真实公开 release 安装，不从当前源码夹具伪造源状态；对上述每个 phase 和 journal/状态双文件边界注入 kill/断电，证明自动继续或完整回滚、始终只有一个 Manager/Docker owner，并在清理 release 验证所有源常量与迁移入口已消失。

在这些切点全部实现并通过端到端崩溃矩阵之前，任何 release 都只能作为源侧能力的前置基线，不能发布 `namespace_handoff` 描述符，也不能暴露一个表面成功的 handoff 命令。当前普通 operation journal、自更新 plan、配置默认值、Compose environment、Docker ownership 和 Sandbox registry 都绑定源身份；在该状态下直接启用交接会使恢复 watchdog 找不到原路径、目标 Manager 无法证明 Current、或两套控制面竞争同一端口和 Docker 对象。失败关闭比在唯一部署机上生成不可回滚的半迁移更安全。

## 检测与预拉取

管理员可以启用 Manager 轮询、从管理界面提交检查，或使用宿主 CLI。其它进程不得实现第二套更新器。发现更新时，Manager 先校验 HTTPS、协议版本、宿主架构、数据库版本、磁盘空间、Manager 工件和全部镜像 digest，再在平台仍可使用时准备候选工件。切换前只强制预拉取 Platform 与 Agent Runtime 的精确 digest；本地已经存在的 digest 不访问 registry。每个缺失核心镜像的拉取同时受无输出空闲时限和较大的绝对上限约束，超时在进入维护前记录为可重试失败，继续保留 current generation。Camoufox、SearXNG、Firecrawl 与 Agent Sandbox 镜像由各自的后台收敛或首次使用独立拉取，不能因第三方 registry 缓慢阻塞核心更新。

所有受管镜像都使用同一份按镜像上限目录。能力服务或 Sandbox 在按需拉取前先精确检查本地 digest，只为缺失项累计压缩层与展开后上限，并对 Docker 文件系统执行普通进程可用字节和 inode 门禁。容量不足时只运行一次受控维护并重新计算；仍不足就保持现有服务、把能力标记为 degraded 或让本次 Sandbox 创建明确重试，不能继续拉取到磁盘耗尽。能力栈先逐 digest 完成有界拉取，再执行 Compose 收敛，不能让 Compose 隐式拉取绕过容量门。失败时只删除本次调用开始前不存在、仍无容器消费者的精确 digest；不得清理未知 layer 或其它项目资源。

镜像就绪后公开状态进入 `waiting_for_tasks`。Platform 继续服务，直到没有以下活动：

- Agent Run 以及 queued/running durable job；
- 已完成网络接收、正在把消息/附件/邮件 checkpoint 等权威状态原子提交到本地的短准入窗口；
- Manager 登记的 Sandbox 或 host 后台终端；
- 其它不能安全跨 generation 切换的写操作。

Manager 不为更新强行终止任务。任务自然结束后，排队更新自动继续。只有 Manager 本地进程登记为空闲后，它才请求 Platform 在对话锁内原子复核业务状态并建立 reservation。候选校验、下载和任务等待期间不持有固定容器切换锁；只要 `maintenance=false`，current generation 的能力后台仍可修复。Manager 取得 reservation 后才与能力收敛互斥并进入固定栈切换边界。

自动学习复盘遵循同一静默边界，但排队与执行必须区分：尚未领取的复盘 durable job 可以跨 generation 保留，不单独阻塞更新；一旦 worker 领取复盘并登记为活动，它就和前台 Agent Run 一样阻塞 reservation，直到结果已持久结算或失败重排。reservation 建立后不得领取新复盘；进程关闭时仍在执行的复盘必须先取消 Runtime，再把同一 job 安全重排，不能丢弃计数、重置变更预算或把半完成结果当成成功。

网络接收或只读外部探测不能无限占有 Platform 写准入。持续前进的附件上传没有普通墙钟总时限，但 multipart 只写非权威 staging；完整请求读完后才竞争短提交准入。若更新先取得 reservation，上传连接可以随旧 Platform 停止，staging 在请求清理或下次启动时删除，客户端明确重试。后台 IMAP 轮询同样在准入外读取；每个 checkpoint、消息/任务事务和错误状态落库前重新竞争短准入，更新已经预约时放弃本轮并由新 generation 从旧 checkpoint 重试。交互式邮件调用属于正在运行的 Agent Run，仍由任务本身自然阻塞更新；不能再用一个额外、不可收敛的网络 admission 重复阻塞。任何可能产生本地写入的网络结果都不得在 reservation 后补写。

## 原子准入与维护

Manager 使用 control capability 请求 Platform readiness/reserve。Platform 在同一个锁边界内完成最终空闲检查并关闭新消息、后台 worker 和写任务准入。Manager 收到成功响应后先持久化同一 operation 的 `maintenance=true`，再用相同 operation id 重复 reserve 并取得确认；第二次确认前不得停止 Platform 或修改数据。

任一 reserve 响应丢失或结果不确定时，Manager 必须对同一 operation 尝试 release。只有 release 明确成功才可回到非维护失败状态；release 失败则保持 `failed + maintenance=true` 并由恢复循环继续对账。每个 Platform 进程在启动 Agent、知识摄取、计划任务或 Telegram worker 前都必须读取 Manager 的持久 reservation；状态不可读时启动失败，不能把未知状态解释为空闲。

公开状态固定为：

- `idle`：当前 generation 正常；
- `waiting_for_tasks`：候选已准备，等待业务自然空闲；
- `updating`：维护生效，正在切换；
- `failed`：无法证明安全运行，继续显示维护页并等待修复。

公开 `/api/platform/update-status` 载荷固定为 `state`、`phase`、`operation_id` 和 `retry_after_ms`；`operation_id` 直接来自 Manager 当前 operation，不使用第二套实例标识。

operation 为 `install`、`update`、`restart`、`rollback` 或 `repair`；phase 由 [`container-platform.json`](../contracts/container-platform.json) 定义。operation journal、current/target/previous generation、心跳和有界错误均写入 Manager 状态根并原子同步。

## 更新事务

进入维护后的顺序固定为：

1. 锁定 operation 与不可变目标清单；
2. 停止当前可写 Platform，并证明没有第二个数据库 writer；
3. 对 SQLite 和需要同步切换的 sidecar 数据建立一致快照；
4. 运行版本化、幂等、事务化 schema 与文件迁移；
5. 启动候选核心服务并执行核心 readiness，同时异步启动受管能力服务；
6. 原子提交 current/previous generation；
7. 完成 Manager 自更新确认和其它当前 generation finalize hook；
8. 明确释放 reservation，恢复公网入口和后台 worker；
9. 各 Sandbox 空闲时独立刷新其基础镜像。

提交前必须在 reservation 仍生效时再次探测 Manager 控制面、Platform、Runtime 与公网入口，确认运行中的核心容器与目标 digest 完全一致；不能只复用较早的 readiness 结果。能力服务继续按独立 degraded 语义收敛。

Platform 与 Agent Runtime 属于 generation 的核心 readiness；Manager 自身还必须持续持有公网入口和 owner-only 控制接口。Camoufox、SearXNG、Firecrawl 与 Cognee 是能力级服务：核心 generation 提交后由后台收敛器逐项拉取和启动，它们未收敛时只降级浏览器、搜索、网页提取或知识能力，不能回滚已经健康的核心 generation、阻止 finalize、让整个平台进入长期维护，或终止 Manager。Agent Sandbox 镜像在对应 Sandbox 首次创建时执行相同的本地 digest 检查和有界按需拉取。release 若因不可分割的数据迁移确实依赖某项能力服务，必须在发布契约中显式声明本次临时门禁，并提供不依赖该服务自身健康的恢复路径，部署机不能临时猜测。

Firecrawl 显式使用 `NUQ_BACKEND=pg` 的 PostgreSQL 队列基线。后台收敛检查 Playwright、Redis、RabbitMQ、Postgres 与 API，并把结果投影为独立服务状态；FoundationDB 及其初始化任务不属于当前发布、运行或健康目录。收敛使用有界等待和指数退避，失败只把网页提取标记为 degraded。只要 Manager、Platform 与 Runtime 正常且未进入维护，Firecrawl 修复可与候选校验、核心镜像预拉取和任务等待并行，不能占用全局维护门。

## 自维护与空间回收

Manager 在启动、更新成功后和低频定时器中运行同一幂等维护循环。只有 `idle + maintenance=false`、没有 activation/active/finalize operation 且 Sandbox/host 执行登记稳定时才允许删除；仅由更新检查产生、尚未进入 operation 的候选可以存在，但必须进入保护集合。更新 preflight 为释放容量而显式允许当前 operation 进入维护循环时，该 operation 必须是唯一未终结 operation，其 `target_generation` 与 `snapshot_path` 也必须分别作为 release 与快照保护项；任一 operation journal 不可读、身份不一致或出现第二个未终结 operation 都失败关闭。清理准入与 operation 创建、候选发布及按需 Sandbox 注册共用短临界区，不能在读取空闲状态后与新执行交错。每轮先计算保护集合：current、previous、候选、自更新 activation、未终结 operation、回滚快照、正在运行或已登记 Sandbox，以及全部现有容器引用的镜像和挂载。

清理对象必须同时具备可验证的 Manager provenance 和零消费者。数据库 generation 快照使用 `migration_backup_retention_seconds` 的七天恢复窗口；不可达 release、对应受管 digest 镜像、旧 Manager binary 与可证明来源的 staging/download 临时工件使用独立的 `obsolete_artifact_retention_seconds` 一小时宽限，避免高频发布把镜像积累到磁盘耗尽。已 finalized 且具有有效 `completed_at` 的终态 operation journal 只在同时超过七天窗口、不属于按完成时间排序的最新 `128` 条，且不被 Manager state 的 active/finalize id 引用时才可删除；非终态、未 finalized、缺失完成时间或被 state 引用的 journal 永不进入裁剪候选集。这个有界尾部同时定义历史 operation 查询和 idempotency replay 的最小持久保证；裁剪后的更旧终态 id 不再是可查询 API。终态 recovery journal 与 activation plan 属于独立审计证据，不进入 operation journal 裁剪，也不作为普通临时文件泛化删除。每轮依次尝试快照、release（连同其不可达镜像）、operation journal 和旧 Manager binary 四个独立清理域；一个域失败不得跳过其余安全域，最终聚合有界错误与各域删除计数。每个对象独立、非 force 删除并记录有界结果；未知文件、未知 label、符号链接、路径越界、仍被引用或状态读取失败都跳过。禁止 `docker system/image/volume prune`、按仓库名通配删除、递归清空 backups/data 或处理其它项目的 Docker 资源。

原子写入中断后只能把同目录下名称精确匹配 `.tmp-` 加无前导零的 `uint32` ASCII 十进制表示（1–10 位）的工件视为 Manager 临时文件；这是当前原子写入器的完整命名契约，构建测试必须证明实际 writer 产生的名称仍可被识别，实现差异只能失败关闭。持久 state、operation、activation、recovery 和 manifest 引用不得指向这类名称。共享清理器只在已打开并证明为绝对 canonical、当前 UID 所有、非符号链接的精确受管目录上工作，比较目录和候选文件的 `lstat`/`fstat` inode，并且只删除同 UID、普通、非链接、`nlink=1` 的文件；删除后同步已打开的父目录。清理目录必须由 canonical Manager 根与定长子路径派生；即使持久 Version 记录包含绝对路径，也只能在它精确指向固定 `Root/versions/<identity>/ubitech-manager` 后用其直接父目录作为清理根；根外路径必须在任何 unlink 前拒绝。平时必须等待 `obsolete_artifact_retention_seconds` 宽限；只有启动前同时具备单实例证明与相应写域锁，或持有对应域的独占 single-writer 锁并证明没有 writer 时才可不等宽限。精确名称但类型、owner、inode 或链接数异常的对象始终保留并报错。仍在宽限内的对象也保留：若其位于随后将严格枚举或验证的启动关键目录，本次启动失败关闭；若它不参与启动身份验证，启动路径不扫描该目录，由低频维护在宽限后收敛，不能为清理无关工件人为制造长时间启动循环。Manager 每次启动在任何 journal 枚举前只清理 recovery/operation 和已引用 version 等严格启动关键目录，周期维护在自身域锁内使用同一原语收敛非关键残留，不放宽未知文件规则。对于名称为精确 commit 的非保护 `releases/<commit>/` 目录，周期维护只在取得维护准入锁、重新确认保护集后，用这一原语删除已超过一小时宽限的精确原子残留，然后从头严格验证 manifest、Compose 和闭世界目录内容，才允许其参与 release 及镜像裁剪。新鲜残留、任何 `.tmp-` 近似名、未知文件、持久引用异常或对象身份变化都必须保留证据并阻止该 release 与镜像被删除；只要其核心 manifest 与 Compose 仍可验证，维护循环就把其中的受管镜像加入本轮保护集，避免另一个共享 digest 的 release 越过这一阻断边界。

更新 preflight 在下载前检查数据根与 Docker root 所在文件系统的普通进程可用字节和普通用户可用 inode。Manager 先按精确 digest 检查本机，仅为缺失的 Platform/Runtime 镜像累计 [`container-platform.json`](../contracts/container-platform.json) 中的压缩层上限与展开后上限，再加下载安全余量。切换前的字节门槛不是一个孤立常数：Manager 对每个当前受管快照源取逻辑文件大小和已分配块大小中的较大者并安全求和，再加契约中的 `update_pre_cutover_min_free_bytes` 固定安全余量；文件类型、大小计数或整数边界不可证明时失败关闭。发布 CI 必须对两个受支持架构逐项验证压缩层和展开后尺寸不超过这些上限，超限 release 不得发布。当前严格 manifest 协议保持原 JSON 形状，以免尚未接收本次 Manager 更新的实例因未知字段自阻断；容量估算与同一 source commit 的 canonical contract 和发布门绑定，而不是由部署机猜测。

数据根与 Docker root 位于同一文件系统时只采用该文件系统所需门槛的最大值，位于不同文件系统时分别满足各自门槛；字节使用普通进程可用块，inode 使用普通用户可用 inode。第一次切换容量检查发生在建立 Platform reservation 前，容量不足时当前 generation 继续在线并先尝试一次受控维护。reservation 成功后、停止任何 writer 之前必须重新读取快照源和文件系统余量；此时不再删除工件，若余量因并发增长而不足，Manager 必须明确释放同一 reservation，再把 operation 作为可重试的切换前失败结束。无法确认 reservation 已释放时继续保持维护状态，不能冒充在线失败。

首次容量检查不足时，Manager 先运行一次受控自维护：只清理超过宽限、可证明归属且没有消费者的旧工件，然后重新读取缺失 digest、快照源大小和文件系统余量；维护不能满足门槛时才把 operation 标为可重试失败。失败的镜像拉取只清理本次调用开始前不存在、能够由目标 immutable digest 证明归属且仍无容器消费者的候选镜像；Docker 全局缓存、未知 layer 和其它项目资源绝不泛化清理。成功提交后尽快再次运行维护循环，再按指数退避处理暂时仍被 Docker 引用的旧对象。两阶段均至少保留契约 inode 门槛；同一文件系统只计算一次。清理失败只报告独立 degraded 状态，不能回滚已经健康的 generation 或把业务长期锁在维护页。

维护循环把准入快照与慢速检查分离：短临界区记录状态 epoch 和保护集合，目录校验、hash 与 Docker 枚举在锁外执行；每个删除边界都必须重新取得准入锁并确认 epoch、current/previous/candidate、未终结 operation、Sandbox 与容器消费者仍与计划一致。Manager binary 由更窄的 recovery lock 和其自身 state 二次校验串行化，不能与通用准入锁形成反向锁序。保护集发生变化时放弃本轮对象而不是沿用旧快照。

## 数据库迁移

数据库 schema version 随 release 单调递增。候选 Platform 镜像以一次性迁移命令打开数据目录，执行独立编号且创建后不可变的迁移。DDL、数据复制、外键校验和 migration marker 必须属于同一事务；失败时不得启动候选 writer。

重建被外键引用的表时，迁移必须显式处理所有当前子表，按子到父顺序切换，并在提交前执行完整外键检查。空表也必须验证其外键定义。数据库 migration 失败由 Manager 恢复与 previous generation 绑定的快照，不以运行时猜测结构或跳过版本来兼容。

## 回滚与崩溃恢复

候选 readiness 失败时，Manager 停止候选容器，验证并恢复 previous generation 对应的数据库与 sidecar 快照，再启动 previous generation。快照创建只有在内容、manifest 与父目录全部同步后才算成功。恢复必须先验证文件类型、大小和 hash，在独立 staging 准备完整集合，再以可补偿的原子切换替换数据库、WAL 和 SHM；失败时必须保持恢复前数据完整或同步补偿。

每次显式 rollback 在进入维护前先按本地精确 digest 检查并有界准备 previous 的 Platform/Runtime 镜像；准备失败保持 current 在线并作为可重试操作结束。镜像就绪后才建立 reservation，并为当前 generation 创建一致快照。交换 current/previous 时，镜像 generation 和对应数据 generation 必须一起交换，使连续 A→B→A→B 始终使用正确数据。

Manager 在任一 phase 被终止、宿主重启或 Docker 重启后，从 operation journal 幂等收敛。数据库迁移 one-off 容器使用确定名称、Manager ownership label 和 Compose project label；恢复数据库前必须先清除已证明归属的残留迁移 writer。无法证明数据库和容器 generation 一致时保持维护，`repair` 不能绕过未完成的 `rolling_back`。

operation 终态与 Manager state 的半提交窗口必须显式收敛：失败 operation 已落盘但 active id 未清除时只能完成失败收尾；current 已提交但 finalize 尚未完成时保持 `finalize_pending` 和维护，重新执行核心探针及幂等 finalize hook，最后才释放 reservation。能力级服务的健康状态不参与该探针。任何 checkpoint 写入错误都必须可观察，不能伪造完成。

候选 Manager 尚未被 watchdog 接纳时，journal 损坏、核心 readiness 失败或控制入口不可用必须使候选进程退出，由 watchdog 恢复 previous Manager。普通 activation 一旦由 watchdog 判定失败，必须把失败 Candidate 从可自动激活状态原子移除并在终态 plan 中保留身份；previous Manager 重启后不得再次激活同一二进制。若 Platform generation 已经提交但仍在等待这次 Manager activation，恢复循环使用原 operation、原 reservation 和原更新前快照自动停止失败 generation、恢复 previous generation 与数据、释放 reservation，并把本次更新终结为可重试失败。该回退在每个 journal 半提交窗口都必须幂等；不能留下永久 `finalize_pending`，也不能要求人工清除 Candidate。

当前基线不接受未完整绑定身份的 activation plan。普通 plan 必须在首次持久化时同时写入 `candidate_path` 与 `platform_commit`，并在启动确认、watchdog 回滚、外部恢复接管和终态收敛的每个边界与已验证且已提交的 Candidate、Activation 和 Platform generation 精确匹配。任一字段缺失、部分绑定、身份漂移或文件篡改都必须失败关闭；恢复路径不得从 Current、Candidate、manifest 或路径规则推断、补写这两个字段。接管 journal、watchdog、回滚和 recovery activation 仍保留原始 plan 字节哈希与完整身份链作为持久证据。

普通 rollback 的 plan-first 半 checkpoint 只有在 Candidate 的 version、source commit、SHA-256、验证时间和 `platform_committed=true` 均完整，Candidate 路径精确等于其受管 version 目录中的 `ubitech-manager`，Activation 的 plan path 精确等于该 Candidate 的受管 plan 路径，且 plan/state/stable/运行 inode 全链一致时才可由启动流程补清。`pathWithin`、目录名前缀或单独 hash 命中都不足以建立该终态所有权；任一字段篡改必须保持 state 不变并失败关闭。

候选已经成为 current 后，恢复或 finalize 的暂时错误不再是 Manager 进程级致命错误：Manager 必须保持公网维护页和控制接口在线，持久保留原 operation，并由后台循环带退避重试。不可恢复错误同样不得形成 systemd 崩溃循环；它保持安全维护状态并向宿主 CLI 提供有界诊断和受控恢复入口。

候选固定服务启动或探针失败时，Manager 在删除容器前采集有界的 healthcheck 和日志诊断。所有诊断先脱敏再截断；采集失败可以附加错误，但不能阻止安全回滚。

## Manager 自更新

Manager 使用版本目录、持久 activation intent、独立 watchdog 和原子 current/previous 切换更新自身。候选二进制先完成自检、journal 解析和核心 operation 收敛，再绑定 control socket 与公网入口并通过探针；只有 watchdog 确认后才能成为 current。Manager 身份探针必须经过 owner-only control capability 认证，只返回运行 release version 与运行可执行文件 SHA-256，不得执行 Docker 或下游服务检查；完整服务目录与 Manager 进程存活是两个独立信号。任一提交前失败都恢复 previous Manager 二进制及其 unit，不能覆盖唯一可启动副本。

每次 `serve` 在自更新检查以前先取得贯穿整个进程生命周期的 owner-only 单实例锁；该锁不由 `recover-current` 外部命令持有，锁序固定先单实例锁、后全局 recovery lock，保证外部命令停止旧服务后新 recovery Manager 仍可启动探测，同时任何第二个普通 serve 都非阻塞失败。Candidate control listener 在 watchdog 提交前必须由原子 handler 栅栏限制为认证 `/v1/identity`；只有 acknowledgement 与 commit 都完成后才开放 status、executor 和 operation。每个 Unix socket 路径另有 owner-only、`O_NOFOLLOW | O_CLOEXEC` 打开的 durable sibling bind flock；它跨越 probe、stale unlink、bind 和 listener teardown，并在 socket unlink 与 fd close 后才释放，使不同 Manager root 也不能并发 claim 同一路径。已有 socket 只有在持有该锁时有界连接明确 `ECONNREFUSED` 且 unlink 前同 inode/type/owner 复核通过，才能作为 stale 删除；live、锁繁忙或模糊状态一律保留并拒绝启动。listener teardown 也只能删除自己绑定的 inode，不能按旧路径删除继任 socket。

下载 Manager 候选前必须先按固定顺序持久化唯一所有权：operation 的 `target_generation`、Platform `Candidate`，最后才是自更新 `Candidate`。这样任一进程退出后，自更新启动门都能从同一未终结 operation、受管 manifest 与 Platform Candidate 精确证明候选归属。Platform generation 尚未提交时，任何正常失败都必须按相反依赖顺序清理：先通过严格 `DiscardPrepared(manifest)` 只清除版本、source commit、SHA、受管路径完全一致且 `platform_committed=false`、没有 Activation 的自更新 Candidate，再条件清除仍属于同一 active operation 的 Platform Candidate，最后才允许把 operation 写成终态。候选二进制本体由受控维护循环按保护集合和宽限期回收，不在失败路径递归删除。

反向清理本身是持久事务。首次触碰自更新 Candidate 前，operation 必须原子记录 `prepared_cleanup_pending=true`、原始失败原因和 retryable 分类；该 marker 一旦落盘，普通恢复不得再进入 `runUpdate`、重新下载、Prepare 或 reservation，只能从受管 `releases/<target>/manifest.json` 与 operation target 重建同一清理意图。重放依次接受并验证四个单调 checkpoint：两个 Candidate 都在、自更新 Candidate 已清而 Platform Candidate 仍在、两个 Candidate 都已清但 active operation 尚在、失败 operation 已落盘但 state 仍指向它。`DiscardPrepared` 必须幂等并在返回前重读证明 Candidate/Activation 均为空；Platform Candidate 只能在完整等于受管 manifest generation 时清除，也可接受已经为空。最后以一次 operation 原子写同时清除 marker 并写成 finalized failed，再清 active owner 并恢复 idle；若进程在两次 journal 写之间退出，恢复只补做失败 state 收尾，不能再经过 reservation 分支。marker 写入前崩溃可按原 phase 正常重跑；marker 写入后、终态 operation 写入前的任何身份不一致、文件不可读或写入结果不确定都必须保留 marker 与 active owner、更新有界诊断并失败关闭，不能覆盖原始原因或伪造终态。

普通 activation 先将绑定 Candidate、Platform commit 和 previous 不可变二进制的 plan 与 state intent 持久化，再启动唯一的独立 watchdog。finalize 在激活候选前查询本 release 是否已被 watchdog 回滚时，只有已存在且完整匹配的 activation plan 才能进入加锁对账；这条纯查询路径不得创建 activation 目录或 lock。全新 Manager root 尚无 plan 时必须返回“未回滚”，随后由 `Activate` 安全创建 owner-only activation 目录并开始首次切换。重放只能继续同一份已绑定的非终态 plan：不得重写为 `prepared`、不得为同一 plan 创建第二个 watchdog。同名 transient unit 已存在时必须验证其 PID、不可变可执行文件、参数、cgroup 和 plan 路径后将其视为现有所有者；身份不可证明时失败关闭。每份普通 plan 具有 owner-only 的跨进程 mutation flock；Activate 按“全局 recovery lock → plan lock”取得锁，候选确认与普通 watchdog 只取得 plan lock且不得反向取得全局锁。plan/state/stable 的每次普通提交或回滚都必须在 plan lock 内重新读取并验证所有权，不能用锁外快照覆盖另一进程已经写入的终态；普通提交在锁内必须重新读取 plan 并确认其为同一完整绑定、`activated=true`、`acknowledged=true`、状态为 `acknowledged`，重新确认 Candidate/Activation 全部身份仍匹配，并在写 state 前即时验证 stable SHA 等于 Candidate。若 state 已原子提升为 Candidate Current、引用已清除，但进程在 terminal plan 写前退出，generation finalize 屏障本身必须在同一 plan flock 内用 manifest、Current/Previous、stable 与完整 `acknowledged` plan 精确证明该半 checkpoint并只补写 `committed`；不依赖原 watchdog 仍存活，任何可解析但冲突的 plan 都拒绝。没有该 release plan 的既有 Current 快速路径保持只读。恢复接管的提交使用独立的 takeover 所有权契约，不能借用普通提交的判断。候选启动确认和等待提交必须直接校验 Linux `/proc/self/exe` 所代表的运行中 inode，不能对 `os.Executable()` 返回的启动路径求 hash；stable 路径被原子回滚后，仍运行的旧 Candidate 不得把恢复后的 Current 路径误认成自己。启动或重启 systemd unit、控制 socket 探针等可能阻塞的外部调用不占用 plan lock，调用返回后必须重新取锁对账再写入。watchdog 在看到已持久的 `activated` 后从自己的 systemd cgroup 提交 Manager 主 unit 重启，并在同一进程内最多成功提交一次；Manager 主进程不得在自己将被停止的 cgroup 内同步等待 `systemctl restart`，也不得把该调用被 systemd 终止误判为候选失败。若 state intent 已持久但 stable 尚未替换时 previous Manager 重启，该尝试已经失去连续所有权：必须与 watchdog 回退一样写入标准 `rolled_back` 终态并同时清除 Candidate/Activation，不得留下只有 Candidate 而没有 Activation 的中间状态。若回滚已恢复 stable、但在写 `rolled_back` plan 或清除 Candidate/Activation 前中断，周期性的回滚屏障检查必须在 plan lock 内重新证明 Current、Candidate、Activation、不可变二进制与 stable 全部精确匹配；`activated`/`acknowledged` plan 可先补写有界错误的 `rolled_back`，随后只补做 state 清除，`prepared` plan 不得据此推断已回滚。无论当前仍是旧进程还是候选进程都不得因可执行文件身份不同跳过收敛，任何不匹配则不改写引用。watchdog 必须将 `committed`、`rolled_back` 和受控 superseded 识别为终态，迟到或重放的 watchdog 不能再恢复 previous。watchdog 取得完整绑定后 plan 丢失或损坏时，只能用内存中最后一份已验证快照与当前 state、Candidate、Current 和 stable 二次对账；精确 state 已提交且 stable 仍为 Candidate 时重建 `committed` plan，仍完整持有未提交状态时才可恢复 Current 并重建回滚证据，无法证明所有权则不得改写任何状态。

普通 activation 的独立 watchdog 不受 Manager 主 unit 停止影响。外部恢复遇到遗留 Candidate/Activation 时，必须先验证 Platform `finalize_pending`、Manager state、activation plan、不可变二进制和 stable hash 是同一提交链，再停止并证明主 unit与该 plan 的所有 watchdog 都已退出；仅持有新版本 recovery lock 不能证明旧 watchdog 已失活。若普通 plan 已为 `rolled_back`、Candidate 与 Activation 仍保持完整原绑定且 stable 已精确恢复 Current，外部恢复在全局锁内再取得 plan lock，只能先补清这条标准回滚半提交，再重读 state 进入无 activation 的恢复路径；绑定被篡改时失败关闭，这不是对缺失 Activation 的旧状态兼容。隔离完成后先持久化绑定原始 journal/hash、Manager 配置和 unit 初始启用状态的 takeover transaction；随后临时禁用主 unit 的自动启动并证明该 fence 生效，再把旧 activation 收敛到登记 Current 的标准回滚 checkpoint。只有 journal 已持久化且仍在 `plan_superseded`、旧 plan 精确反向绑定同一 transaction、stable 精确为 Current 时，才允许把“旧 Activation 已清除但阶段写未完成”的 Candidate-only 状态识别为事务内部崩溃 checkpoint 并补记 `activation_cleared`；无 journal 的同形状态始终拒绝。`activation_cleared` 之后 stable 可以处于 Current 或精确 recovery SHA；若 recovery plan 已在 state intent 前落盘，它必须是 journal 唯一确定的 `prepared` plan，缺失时可幂等创建、可解析但身份不同则不得覆盖。创建新 intent 时必须先把 stable 换成校验恢复二进制，之后才写带 `recover_current` 标记的 plan、Candidate 与 Activation，保证任一重启边界都不会启动旧 Candidate。新 plan 被 state 引用且新 watchdog 的进程身份得到证明后，只有新 watchdog 能执行 commit/rollback 或写 current/previous；外部命令只可按 takeover journal 单调确认 stable、激活 plan、恢复主 unit 启用状态并启动服务，随后成为只读观察者。所有状态写都必须带 transaction/plan/Candidate 条件校验，任何路径都不得产生两个 commit/rollback 所有者。恢复 plan 的不可变内容必须完全由 takeover journal 确定。若 plan 文件丢失或语法损坏，watchdog 可用最后验证快照，外部终态恢复可用 journal 确定性重建；两者都必须在同一 mutation lock 内重新证明当前 state/stable 的精确提交或回滚边界。已存在且可解析但身份不匹配的 plan 不得覆盖。无法证明任一精确边界时不得改写状态。恢复回滚必须清除可自动激活的 Candidate、恢复并验证登记 Current 服务；完整失败身份只保留在 takeover journal，旧 Manager 不得自行重试同一失败候选。

control API 在提交 2xx 前完整编码响应。mutation 只返回有界身份和状态确认；客户端对空、截断、超限或非法 JSON 的成功响应视为结果不确定，并使用原 idempotency key 与 operation journal 对账。外部错误正文写入 journal 前必须脱敏和限制大小，重复失败只保留初始上下文与最近错误，不能递归嵌套历史诊断。

若 current Manager 的旧二进制缺陷使其在启动恢复阶段持续退出，后台轮询本身不可达，不能声称继续推送普通 release 会自动获救。此时只使用[部署文档](deployment.md#manager-失联恢复)定义的校验恢复入口先替换 Manager；恢复成功后由同一 operation journal 补完原 finalize，再恢复普通更新。不得只覆盖 stable 文件而不登记 Manager Current，也不得手工清除 `finalize_pending`。

## 验证

发布门至少覆盖：

- 全新数据根安装与启动；
- 多个正常任务跨过轮询周期时继续排队更新；
- 数据库 schema 迁移成功、失败与外键回滚；
- 核心镜像拉取空闲/绝对超时、核心 readiness 和 Manager 自更新失败；
- Manager 主 unit 自重启的真实 systemd cgroup 语义，并证明只有独立 watchdog 提交重启、`signal: terminated` 可重试、同一非终态 plan 不被重写、已有精确 watchdog 不被重复创建，且迟到终态 watchdog 不再回滚；
- Platform 已提交但旧 Candidate/Activation/watchdog 循环时，受控恢复能隔离旧 watchdog、结算到 Current checkpoint，并以新 recovery activation 完成或标准回滚；
- 受控恢复在 unit fence、stable 替换、intent、watchdog handoff、重新启用主 unit 和 terminal journal 的每个持久边界重启后均只能继续同一事务；
- watchdog 已提交 Manager state、Platform 已完成 finalize 但 recovery plan/journal 尚未终态化时，只补齐缺失元数据，不得再次移动 Current/Previous；
- operation 在每个持久 phase 被终止后的幂等恢复；
- current Manager 在 `finalize_pending` 核心探针暂时失败时保持控制接口在线、带退避重试，并在服务恢复后只 finalize 一次；
- Firecrawl 整体不可用或能力镜像 registry 卡住时 Platform 与 Runtime 仍完成 finalize、退出维护并将网页提取标记为 degraded；
- current/previous 镜像与数据 generation 的往返回滚；
- Firecrawl PostgreSQL 首次启动、保留同一 bind 数据后的幂等重建和真实提取请求。
