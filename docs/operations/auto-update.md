# 自动更新

本文定义当前 Docker 基线的发布检测、任务排空、维护、提交和回滚协议。部署拓扑见[部署](deployment.md)，持久目录见[数据布局](../reference/data-layout.md)。

## 唯一真相源

`ubitech-manager` 是部署机唯一更新控制器。部署机不读取 Git remote、branch 或 working tree，也不从仓库脚本启动产品。main 通道的 release manifest 是唯一版本目录；实际运行身份由清单中的完整 Manager 校验和、Compose 内容和镜像 digest 共同确定。

CI 只有在文档门禁、Python、Runtime、前端、Manager、容器构建、上游契约与真实 Compose smoke test 全部成功后才发布清单。每个 main commit 先产生不可变 `container-<commit>` release，main 通道再在全局 promotion 锁内只向已通过质量门的后代 commit 单调推进。较早 workflow 即使后完成，也不能改写 latest 或触发降级。发布清单必须最后出现，实例不能看到半套发布物。

Manager 将 `releases/<source-commit>/` 视为不可变身份：manifest 与 Compose 先下载到同目录 staging，完整验证并同步后原子发布。相同 commit 的工件必须逐字节一致；缺件或内容漂移视为 immutable-ID collision，必须在拉取镜像和进入维护前失败。

## 检测与预拉取

管理员可以启用 Manager 轮询、从管理界面提交检查，或使用宿主 CLI。其它进程不得实现第二套更新器。发现更新时，Manager 先校验 HTTPS、协议版本、宿主架构、数据库版本、磁盘空间、Manager 工件和全部镜像 digest，再在平台仍可使用时预拉取候选工件。下载或验证失败只记录候选错误，不进入维护。

镜像就绪后公开状态进入 `waiting_for_tasks`。Platform 继续服务，直到没有以下活动：

- Agent Run 以及 queued/running durable job；
- 消息、知识、计划任务、Telegram 或其它副作用 worker 的准入窗口；
- Manager 登记的 Sandbox 或 host 后台终端；
- 其它不能安全跨 generation 切换的写操作。

Manager 不为更新强行终止任务。任务自然结束后，排队更新自动继续。只有 Manager 本地进程登记为空闲后，它才请求 Platform 在对话锁内原子复核业务状态并建立 reservation。

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

Platform 与 Agent Runtime 属于 generation 的核心 readiness；Manager 自身还必须持续持有公网入口和 owner-only 控制接口。Camoufox、SearXNG、Firecrawl 与 Cognee 是能力级服务：候选启动时应尽力拉起并逐项报告健康状态，但它们未收敛时只降级浏览器、搜索、网页提取或知识能力，不能回滚已经健康的核心 generation、阻止 finalize、让整个平台进入长期维护，或终止 Manager。release 若因不可分割的数据迁移确实依赖某项能力服务，必须在发布契约中显式声明本次临时门禁，并提供不依赖该服务自身健康的恢复路径，部署机不能临时猜测。

Firecrawl 后台收敛分别检查 Playwright、Redis、RabbitMQ、Postgres、FoundationDB、一次性 init 与 API，并把结果投影为独立服务状态。修复只可操作状态明确异常的组件，不能以 API 或其它依赖故障为由重启健康 FoundationDB，也不能仅因一次短探针超时就重启仍在恢复的有状态进程。失败后使用有界指数退避；Manager、Platform 与 Runtime 正常时，Firecrawl 修复不得占用全局维护门。

## 数据库迁移

数据库 schema version 随 release 单调递增。候选 Platform 镜像以一次性迁移命令打开数据目录，执行独立编号且创建后不可变的迁移。DDL、数据复制、外键校验和 migration marker 必须属于同一事务；失败时不得启动候选 writer。

重建被外键引用的表时，迁移必须显式处理所有当前子表，按子到父顺序切换，并在提交前执行完整外键检查。空表也必须验证其外键定义。数据库 migration 失败由 Manager 恢复与 previous generation 绑定的快照，不以运行时猜测结构或跳过版本来兼容。

## 回滚与崩溃恢复

候选 readiness 失败时，Manager 停止候选容器，验证并恢复 previous generation 对应的数据库与 sidecar 快照，再启动 previous generation。快照创建只有在内容、manifest 与父目录全部同步后才算成功。恢复必须先验证文件类型、大小和 hash，在独立 staging 准备完整集合，再以可补偿的原子切换替换数据库、WAL 和 SHM；失败时必须保持恢复前数据完整或同步补偿。

每次显式 rollback 先为当前 generation 创建一致快照。交换 current/previous 时，镜像 generation 和对应数据 generation 必须一起交换，使连续 A→B→A→B 始终使用正确数据。

Manager 在任一 phase 被终止、宿主重启或 Docker 重启后，从 operation journal 幂等收敛。数据库迁移 one-off 容器使用确定名称、Manager ownership label 和 Compose project label；恢复数据库前必须先清除已证明归属的残留迁移 writer。无法证明数据库和容器 generation 一致时保持维护，`repair` 不能绕过未完成的 `rolling_back`。

operation 终态与 Manager state 的半提交窗口必须显式收敛：失败 operation 已落盘但 active id 未清除时只能完成失败收尾；current 已提交但 finalize 尚未完成时保持 `finalize_pending` 和维护，重新执行核心探针及幂等 finalize hook，最后才释放 reservation。能力级服务的健康状态不参与该探针。任何 checkpoint 写入错误都必须可观察，不能伪造完成。

候选 Manager 尚未被 watchdog 接纳时，journal 损坏、核心 readiness 失败或控制入口不可用必须使候选进程退出，由 watchdog 恢复 previous Manager。候选已经成为 current 后，恢复或 finalize 的暂时错误不再是 Manager 进程级致命错误：Manager 必须保持公网维护页和控制接口在线，持久保留原 operation，并由后台循环带退避重试。不可恢复错误同样不得形成 systemd 崩溃循环；它保持安全维护状态并向宿主 CLI 提供有界诊断和受控恢复入口。

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
- 候选镜像、核心 readiness 和 Manager 自更新失败；
- Platform 已提交但旧 Candidate/Activation/watchdog 循环时，受控恢复能隔离旧 watchdog、结算到 Current checkpoint，并以新 recovery activation 完成或标准回滚；
- 受控恢复在 unit fence、stable 替换、intent、watchdog handoff、重新启用主 unit 和 terminal journal 的每个持久边界重启后均只能继续同一事务；
- watchdog 已提交 Manager state、Platform 已完成 finalize 但 recovery plan/journal 尚未终态化时，只补齐缺失元数据，不得再次移动 Current/Previous；
- operation 在每个持久 phase 被终止后的幂等恢复；
- current Manager 在 `finalize_pending` 核心探针暂时失败时保持控制接口在线、带退避重试，并在服务恢复后只 finalize 一次；
- Firecrawl 整体不可用时 Platform 与 Runtime 仍完成 finalize、退出维护并将网页提取标记为 degraded；
- current/previous 镜像与数据 generation 的往返回滚；
- Firecrawl FoundationDB 首次初始化和保留同一数据后的幂等重建。
