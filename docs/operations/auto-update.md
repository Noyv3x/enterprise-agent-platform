# 自动更新

本文定义当前 Docker 基线的发布检测、任务排空、维护、提交和回滚协议。部署拓扑见[部署](deployment.md)，持久目录见[数据布局](../reference/data-layout.md)。

## 唯一真相源

`ubitech-manager` 是部署机唯一更新控制器。部署机不读取 Git remote、branch 或 working tree，也不从仓库脚本启动产品。main 通道的 release manifest 是唯一版本目录；实际运行身份由清单中的完整 Manager 校验和、Compose 内容和镜像 digest 共同确定。

CI 只有在文档门禁、Python、Runtime、前端、Manager、容器构建、上游契约与真实 Compose smoke test 全部成功后才发布清单。全部受管镜像先生成唯一的已验证 digest 目录：双架构容量门、真实 Compose 验收与最终 release manifest 必须消费这一份目录。Compose 验收在启动前逐项确认解析后的服务镜像就是将发布的 digest，不得使用另一套默认值通过验收。每个 main commit 先产生不可变 `container-<commit>` release，main 通道再在全局 promotion 锁内只向已通过质量门的后代 commit 单调推进。较早 workflow 即使后完成，也不能改写 latest 或触发降级。发布清单必须最后出现，实例不能看到半套发布物。

Manager 将 `releases/<source-commit>/` 视为不可变身份：manifest 与 Compose 先下载到同目录 staging，完整验证并同步后原子发布。相同 commit 的工件必须逐字节一致；缺件或内容漂移视为 immutable-ID collision，必须在拉取镜像和进入维护前失败。

当前通道发布出的 release manifest 镜像目录必须与当前契约定义的服务集合精确相等；缺少必需镜像或由发布器携带未知、退役服务键都在发布前失败。JSON Schema、发布组装和静态验收共用同一集合，不能通过额外字段保留第二套运行基线。Manager 解析器只为协议前向演进接受名称和 digest 格式安全的额外镜像项，并将其视为不可执行的 opaque metadata；只有当前契约显式命名的镜像能够被拉取、启动或展示。

## 检测与预拉取

管理员可以启用 Manager 轮询、从管理界面提交检查，或使用宿主 CLI。其它进程不得实现第二套更新器。发现更新时，Manager 先校验 HTTPS、协议版本、宿主架构、数据库版本、磁盘空间、Manager 工件和全部镜像 digest，再在平台仍可使用时准备候选工件。切换前只强制预拉取 Platform 与 Agent Runtime 的精确 digest；本地已经存在的 digest 不访问 registry。每个缺失核心镜像的拉取同时受无输出空闲时限和较大的绝对上限约束，超时在进入维护前记录为可重试失败，继续保留 current generation。Camoufox、SearXNG、Firecrawl 与 Agent Sandbox 镜像由各自的后台收敛或首次使用独立拉取，不能因第三方 registry 缓慢阻塞核心更新。

所有受管镜像都使用同一份按镜像上限目录。能力服务或 Sandbox 在按需拉取前先精确检查本地 digest，只为缺失项累计压缩层与展开后上限，并对 Docker 文件系统执行普通进程可用字节和 inode 门禁。容量不足时只运行一次受控维护并重新计算；仍不足就保持现有服务、把能力标记为 degraded 或让本次 Sandbox 创建明确重试，不能继续拉取到磁盘耗尽。能力栈先逐 digest 完成有界拉取，再执行 Compose 收敛，不能让 Compose 隐式拉取绕过容量门。失败时只删除本次调用开始前不存在、仍无容器消费者的精确 digest；不得清理未知 layer 或其它项目资源。

镜像就绪后公开状态进入 `waiting_for_tasks`。Platform 继续服务，直到没有以下活动：

- Agent Run 以及 queued/running durable job；
- 已完成网络接收、正在把消息/附件/邮件 checkpoint 等权威状态原子提交到本地的短准入窗口；
- Manager 登记的 Sandbox 或 host 后台终端；
- 其它不能安全跨 generation 切换的写操作。

Manager 不为更新强行终止任务。任务自然结束后，排队更新自动继续。只有 Manager 本地进程登记为空闲后，它才请求 Platform 在对话锁内原子复核业务状态并建立 reservation。候选校验、下载和任务等待期间不持有固定容器切换锁；只要 `maintenance=false`，current generation 的能力后台仍可修复。Manager 取得 reservation 后才与能力收敛互斥并进入固定栈切换边界。

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

清理对象必须同时具备可验证的 Manager provenance 和零消费者。数据库 generation 快照使用 `migration_backup_retention_seconds` 的七天恢复窗口；不可达 release、对应受管 digest 镜像、旧 Manager binary 与可证明来源的 staging/download 临时工件使用独立的 `obsolete_artifact_retention_seconds` 一小时宽限，避免高频发布把镜像积累到磁盘耗尽。终态 recovery journal 与 activation plan 属于审计证据，不作为普通临时文件泛化删除。每轮依次尝试快照、release（连同其不可达镜像）和旧 Manager binary 三个独立清理域；一个域失败不得跳过其余安全域，最终聚合有界错误与各域删除计数。每个对象独立、非 force 删除并记录有界结果；未知文件、未知 label、符号链接、路径越界、仍被引用或状态读取失败都跳过。禁止 `docker system/image/volume prune`、按仓库名通配删除、递归清空 backups/data 或处理其它项目的 Docker 资源。

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

候选已经成为 current 后，恢复或 finalize 的暂时错误不再是 Manager 进程级致命错误：Manager 必须保持公网维护页和控制接口在线，持久保留原 operation，并由后台循环带退避重试。不可恢复错误同样不得形成 systemd 崩溃循环；它保持安全维护状态并向宿主 CLI 提供有界诊断和受控恢复入口。

候选固定服务启动或探针失败时，Manager 在删除容器前采集有界的 healthcheck 和日志诊断。所有诊断先脱敏再截断；采集失败可以附加错误，但不能阻止安全回滚。

## Manager 自更新

Manager 使用版本目录、持久 activation intent、独立 watchdog 和原子 current/previous 切换更新自身。候选二进制先完成自检、journal 解析和核心 operation 收敛，再绑定 control socket 与公网入口并通过探针；只有 watchdog 确认后才能成为 current。Manager 身份探针必须经过 owner-only control capability 认证，只返回运行 release version 与运行可执行文件 SHA-256，不得执行 Docker 或下游服务检查；完整服务目录与 Manager 进程存活是两个独立信号。任一提交前失败都恢复 previous Manager 二进制及其 unit，不能覆盖唯一可启动副本。

普通 activation 的独立 watchdog 不受 Manager 主 unit 停止影响。外部恢复遇到遗留 Candidate/Activation 时，必须先验证 Platform `finalize_pending`、Manager state、activation plan、不可变二进制和 stable hash 是同一提交链，再停止并证明主 unit与该 plan 的所有 watchdog 都已退出；仅持有新版本 recovery lock 不能证明旧 watchdog 已失活。隔离完成后先持久化绑定原始 journal/hash、Manager 配置和 unit 初始启用状态的 takeover transaction；随后临时禁用主 unit 的自动启动并证明该 fence 生效，再把旧 activation 收敛到登记 Current 的标准回滚 checkpoint。创建新 intent 时必须先把 stable 换成校验恢复二进制，之后才写带 `recover_current` 标记的 plan、Candidate 与 Activation，保证任一重启边界都不会启动旧 Candidate。新 plan 被 state 引用且新 watchdog 的进程身份得到证明后，只有新 watchdog 能执行 commit/rollback 或写 current/previous；外部命令只可按 takeover journal 单调确认 stable、激活 plan、恢复主 unit 启用状态并启动服务，随后成为只读观察者。所有状态写都必须带 transaction/plan/Candidate 条件校验，任何路径都不得产生两个 commit/rollback 所有者。恢复回滚必须清除可自动激活的 Candidate、恢复并验证登记 Current 服务；完整失败身份只保留在 takeover journal，旧 Manager 不得自行重试同一失败候选。

control API 在提交 2xx 前完整编码响应。mutation 只返回有界身份和状态确认；客户端对空、截断、超限或非法 JSON 的成功响应视为结果不确定，并使用原 idempotency key 与 operation journal 对账。外部错误正文写入 journal 前必须脱敏和限制大小，重复失败只保留初始上下文与最近错误，不能递归嵌套历史诊断。

若 current Manager 的旧二进制缺陷使其在启动恢复阶段持续退出，后台轮询本身不可达，不能声称继续推送普通 release 会自动获救。此时只使用[部署文档](deployment.md#manager-失联恢复)定义的校验恢复入口先替换 Manager；恢复成功后由同一 operation journal 补完原 finalize，再恢复普通更新。不得只覆盖 stable 文件而不登记 Manager Current，也不得手工清除 `finalize_pending`。

## 验证

发布门至少覆盖：

- 全新数据根安装与启动；
- 多个正常任务跨过轮询周期时继续排队更新；
- 数据库 schema 迁移成功、失败与外键回滚；
- 核心镜像拉取空闲/绝对超时、核心 readiness 和 Manager 自更新失败；
- Platform 已提交但旧 Candidate/Activation/watchdog 循环时，受控恢复能隔离旧 watchdog、结算到 Current checkpoint，并以新 recovery activation 完成或标准回滚；
- 受控恢复在 unit fence、stable 替换、intent、watchdog handoff、重新启用主 unit 和 terminal journal 的每个持久边界重启后均只能继续同一事务；
- watchdog 已提交 Manager state、Platform 已完成 finalize 但 recovery plan/journal 尚未终态化时，只补齐缺失元数据，不得再次移动 Current/Previous；
- operation 在每个持久 phase 被终止后的幂等恢复；
- current Manager 在 `finalize_pending` 核心探针暂时失败时保持控制接口在线、带退避重试，并在服务恢复后只 finalize 一次；
- Firecrawl 整体不可用或能力镜像 registry 卡住时 Platform 与 Runtime 仍完成 finalize、退出维护并将网页提取标记为 degraded；
- current/previous 镜像与数据 generation 的往返回滚；
- Firecrawl PostgreSQL 首次启动、保留同一 bind 数据后的幂等重建和真实提取请求。
