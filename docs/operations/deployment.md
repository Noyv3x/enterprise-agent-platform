# 部署

本文定义 ubitech agent 唯一受支持的 Docker 部署方式。自动更新见[自动更新](auto-update.md)，持久目录见[数据布局](../reference/data-layout.md)，信任边界见[安全设计](../design/security-and-trust.md)。

## 唯一支持拓扑

宿主机只常驻 `ubitech-manager`。Manager 作为 user-systemd 服务运行，拥有公网监听、维护页、Docker 生命周期、release operation、宿主执行器和本地恢复命令。Platform、Agent Runtime、Camoufox、SearXNG、Firecrawl 及 Agent Sandbox 均由 Manager 按不可变镜像 digest 管理。

直接从 Git checkout 启动 Platform、Runtime 或集成服务不属于产品部署方式。部署机不需要产品源码、Git working tree、Python venv、Node build 或上游源码 checkout，也不存在向这些路径回退的运行分支。

只有 Manager 可以访问 Docker socket。Platform、Runtime、Sandbox 和集成容器不得挂载或代理 Docker socket。公网反向代理只连接 Manager；Platform backend 只发布到宿主回环，sidecar 只连接受管私有网络。该网络由 Manager 创建并验证，是跨 generation 保留的 external bridge network；Compose 切换不得删除它。若同名网络的 managed label、driver 或关键属性不匹配，Manager 必须拒绝接管。

固定服务栈包括：

- `platform`：Python 业务服务和已构建前端，Cognee 依赖构建在镜像中；
- `agent-runtime`：Pi 模型与工具协调器；
- `camofox`：共享浏览器服务，按 Agent 使用独立 Profile；
- `searxng` 与 Firecrawl 受管服务；
- `agent-sandbox`：按主 Agent 动态创建，不属于固定 Compose 数量。

固定服务的持久路径必须由 Compose 显式绑定到 Manager 数据根，不能接受镜像 `VOLUME` 自动创建的匿名卷。SearXNG 必须把受管 `config/` 目录整体只读绑定到 `/etc/searxng`，而不是只覆盖其中的 `settings.yml`；候选 generation 的真实容器探针必须确认 `/etc/searxng` 是该宿主目录的只读 bind，且没有额外 volume mount。

## 宿主要求与安装位置

宿主需要 Linux、Docker Engine、Docker Compose v2、user-systemd，以及能够使用 Docker 的部署用户。标准安装不依赖宿主 Python、Node、npm 或 Git。

默认位置：

```text
~/.local/bin/ubitech-manager
~/.config/ubitech-agent/manager.toml
~/.config/systemd/user/ubitech-agent-manager.service
~/.local/share/ubitech-agent/
```

安装和运行 Manager 的 Unix 用户必须一致。容器内需要写用户数据的进程映射为同一 UID/GID；服务镜像需要专用 UID 时，Manager 只准备该服务明确的数据子目录，不递归改写整个数据根。

全新安装只接受当前 release 的、经过 SHA-256 验证的 Manager 工件和 release manifest。安装器执行 preflight、写入 Manager 配置与 user-systemd unit，并提交 `install` operation；产品容器只能由常驻 Manager 启动。安装不得扫描当前目录寻找可执行文件，也不得导入未知环境、Compose project 或数据目录。

非交互安装必须显式传入 `--yes`，例如：

```bash
curl -fsSL https://github.com/Noyv3x/enterprise-agent-platform/releases/latest/download/install.sh | bash -s -- --yes
```

未传 `--yes` 时安装器只能从控制终端读取确认；没有控制终端必须明确失败，不能从承载脚本内容的标准输入读取。

Manager 激活前的安装失败必须删除本次创建的配置、二进制、unit 和 Manager 状态根，使同一全新安装命令可以安全重试；不得留下会被下一次安装误判为既有数据的半成品。Manager 已成功激活后，后续容器 operation 失败由常驻 Manager 的 journal 和恢复命令接管，安装器不得越过该所有权边界删除状态。

Manager 已激活但首次容器 operation 失败时，不得重跑安装脚本或删除数据根。修复日志指向的环境问题后，使用安装器报告的原始 manifest URL 执行 `ubitech-manager install --config <manager.toml> --release-manifest-url <release.json>`；Manager 必须根据 journal 幂等继续或建立新 attempt。

## 唯一管理入口

日常运维使用：

```bash
ubitech-manager status
ubitech-manager preflight
ubitech-manager check
ubitech-manager update
ubitech-manager restart
ubitech-manager rollback
ubitech-manager repair
ubitech-manager logs
```

CLI 通过 owner-only Unix socket 连接常驻 Manager，并从 owner-only secret 读取 control capability。Platform 使用同一 control capability 代理管理员授权的 operation；Runtime 只有独立 executor capability，不能访问管理 operation。

所有变更带 operation id、幂等键和 expected generation。Manager 先按幂等键核对不可变请求指纹，再判断 generation：同一指纹重复提交返回原 operation，相同 key 携带不同指纹则冲突。上一 attempt 明确终结后，调用方必须重新读取 generation 才能提交下一 attempt。并发请求不能启动第二个变更。

## Manager 失联恢复

只有 Manager 因已知启动缺陷持续退出、owner-only 控制 socket 无法稳定提供服务，因而普通更新和 `repair` 均不可达时，才允许使用发布二进制自带的 `recover-current` 宿主命令。该入口不是第二套平台更新器：它只替换并登记 Manager 二进制，不修改 Platform generation、operation journal、SQLite、容器或能力服务数据。

操作方先从同一个不可变 release 下载当前架构的 Manager 与 `.sha256` sidecar，核对 HTTPS 来源后把期望 SHA-256 显式传给候选二进制。命令固定要求 `--config`、`--expected-sha256` 与 `--yes`。它必须验证执行用户、配置、stable 路径、数据根、当前 Platform generation、Manager 自更新状态及文件类型；存在未归属文件、符号链接、hash 不一致或候选版本无法验证时拒绝执行。普通 activation 只有在满足下述受控接管契约时才可处理，不能通过删除字段或覆盖 stable 绕过。

Manager 状态没有 Candidate/Activation 时，恢复命令把候选复制到 owner-only 不可变版本目录，停止同一 user-systemd Manager unit，原子替换 stable 二进制并重新启动。健康检查使用经过 control capability 认证、完全不查询 Docker 或下游服务的轻量身份端点；它必须连续返回候选 release version 与当前运行可执行文件 SHA-256，并确认 systemd unit 的主进程确实来自 stable 候选，不能用可能受慢容器探针影响的完整 `/v1/status` 代替。只有这些身份检查通过后，才原子登记新的 Manager `Current`；登记时 `SourceCommit` 保持当前 Platform generation，旧 Manager `Current` 保留为 `Previous`。

若故障位于 Platform 已提交、Manager Candidate 已标记 `platform_committed`、普通 activation/watchdog 尚未提交的窗口，恢复命令只能接管一条可完整证明的 finalize 链：Platform 必须处于维护状态且没有 active operation，唯一 `finalize_pending` operation 必须是已成功但未 finalized 的 install/update，operation target、Platform Current 与 Candidate source commit 必须完全一致；Current、Candidate、Activation 与 plan 的 version、SHA、受管路径、previous path、unit、socket、token path、boot id 和时间字段必须内部一致，stable 只能匹配登记 Current 或 Candidate。任何不一致都拒绝，不能猜测。

接管先停止 Manager 主 unit，并枚举、停止该 activation 精确派生的 normal/recovery watchdog transient unit；必须证明所有相关 unit inactive、MainPID 与 ControlPID 为零、cgroup 无残留进程，且不存在仍持有同一 plan 或身份未知的同用户 watchdog 进程。出现未知同名前缀 unit、停止结果不确定或任一 journal/hash 在隔离期间改变时，必须重新分类或拒绝。确认隔离并完成二次校验后，必须在第一次修改旧 stable、plan、state 或 unit 启用状态之前持久化并同步一个确定路径的 owner-only takeover journal；它绑定 recovery version/SHA/path、Platform state 与 operation 身份及摘要、原 Manager state 身份及摘要、旧 plan 路径与原始摘要、Manager state/stable/socket/token/unit 配置、unit 初始启用状态、初始 boot id、初始 stable SHA 和事务阶段，事务摘要覆盖全部不可变绑定。旧 plan 后续内容变化不能覆盖 takeover journal 中保存的原始身份。

takeover journal 落盘后，先禁用 Manager 主 unit 的自动启动并证明其保持 disabled，再按普通 watchdog 回滚语义把 stable 恢复为登记 Current、把旧 plan 标记为受控 superseded，最后清除旧 Activation；旧 Candidate 和 plan 暂时保留为审计证据。主 unit 在恢复 plan 激活以前始终保持 fenced，因此主机在任何跨文件边界重启都不会让旧 Current 或旧 Candidate 越过事务自行启动。

随后先把 stable 原子替换为 recovery 不可变二进制，再以当前 Platform commit 建立带 `recover_current` 标记的新 activation plan。plan 绑定 takeover transaction id、recovery version/SHA/path、Platform commit、被接管 plan 的路径与原始摘要以及 journal 固化的全部 Manager 配置；新的 Candidate/Activation intent 必须在 stable 已为 recovery 后持久化，并从 recovery 不可变路径启动独立 watchdog。只有 state 已引用该 plan，且 systemd 已证明 recovery watchdog 的 PID、可执行文件、参数、cgroup 和 plan 完全匹配时，commit/rollback 及 current/previous 的唯一写权限才移交给 watchdog。外部命令此后只保留 activation bootstrap 权限，按 takeover journal 的单调阶段验证 stable、激活 plan、恢复主 unit enabled、启动 Manager；它不得直接提交或回滚，完成主 unit 启动后只能观察 watchdog 终态。跨 boot 重放必须检测当前 boot id 与 journal 固化的初始 boot id 不同，并从同一 recovery 不可变路径重新武装和证明唯一 watchdog；初始 boot id 仍是不可变事务绑定，不能通过改写 plan 形成第二个所有者。

恢复 Manager 仍走标准 pending-activation 协议，但其预提交探针只检查核心 Platform/Runtime 与公网入口，不检查 Firecrawl 等能力服务；启动确认还必须证明 systemd MainPID 执行的文件与 stable 为同一 inode。只有 recovery watchdog 经过认证身份连续确认后，才按标准切换 `Previous=旧 Current`、`Current=recovery` 并清除 Candidate/Activation。recovery watchdog 的 commit 与 rollback 都必须先条件校验 state 中的 plan path、transaction id、mode、Candidate path/SHA 仍归自己所有；失去所有权的旧 watchdog 不得写 stable、state、plan 或重启服务。

旧 activation 结算前失败保持原 state/stable；结算后任何失败统一回到登记 Current，不恢复已证明会循环的旧 Candidate，也不把失败的 recovery Candidate 留给普通 finalize 自动重激活。回滚先清空 Candidate/Activation、恢复 stable=Current、持久化 plan/journal 终态，再恢复主 unit enabled 并验证 Current 的 PID、inode、SHA 与轻量身份健康；终态写入和服务恢复之间中断时，同一命令只补做服务收敛。恢复进程在 plan、intent、stable 替换、服务重启、watchdog 提交，或 Manager state 已提交但 Platform 已先完成 finalize 的边界中断时，同一不可变二进制和期望 hash 必须识别 `recover_current` 事务并只补齐缺失阶段，不能要求人工编辑 journal，也不能再次移动 Current/Previous。一次 recovery 已明确 `rolled_back` 后不得用同一终态 journal 暗中重开；应先诊断失败原因并使用新的已验证 recovery release 建立新事务。恢复成功后由原 `finalize_pending` 补完 reservation release，再恢复普通自动更新。

受控接管使用以下单调阶段；每次阶段更新都在对应副作用已经原子落盘并同步后发生，重放时先检查副作用再补记阶段，不能重复执行未经所有权校验的写操作。

| Takeover phase | 写权限所有者 | 已持久化事实 | 中断后的唯一合法收敛 |
|---|---|---|---|
| `prepared` | 外部恢复命令 | takeover journal 已绑定全部原始 journal、plan、manifest、operation、Manager 配置、unit 初始状态与 hash | 禁用主 unit 自动启动、重新隔离旧 unit 并验证原始证据，尚不可改旧状态 |
| `stable_current` | 外部恢复命令 | 主 unit 已 fenced；stable 已恢复并验证为登记 Current | 继续标记旧 plan；不得恢复旧 Candidate |
| `plan_superseded` | 外部恢复命令 | 旧 plan 已终态化并反向绑定 takeover transaction | 清除旧 Activation；原始 plan SHA 仍取自 takeover journal |
| `activation_cleared` | 外部恢复命令 | 旧 Activation 已清除，旧 Candidate 身份已保存在 takeover journal，主 unit 仍 fenced | 先把 stable 替换为 recovery，再建立或重放 recovery intent |
| `recovery_intent_persisted` | 外部恢复命令 | stable 已验证为 recovery；recovery plan、Candidate 与 Activation 已绑定，主 unit 仍 fenced | 启动并证明 recovery watchdog；中断时不得启动旧 Current |
| `watchdog_owned` | watchdog 独占 commit/rollback；外部命令仅保留 bootstrap 权限 | recovery watchdog 的 PID、可执行文件、参数、cgroup、plan 与 transaction 已证明 | 外部命令只可继续验证 stable、激活 plan、恢复 unit 并启动 main，任何失败由 watchdog 回滚 |
| `stable_replaced` | 同上 | 对 intent 阶段已完成的 stable=recovery 做了幂等验证并补记 | 标记 plan activated；watchdog 超时则恢复登记 Current |
| `plan_activated` | 同上 | recovery plan 已允许候选确认 | 启动 Manager 主 unit；watchdog 仍是唯一回滚者 |
| `main_started` | watchdog；外部命令只读观察 | Manager 主 unit 已恢复 enabled 并启动，等待同 inode 确认和身份连续探测 | watchdog 条件式 commit 或条件式 rollback |
| `committed` | 当前 Manager | `Previous=原 Current`、`Current=recovery`，Candidate/Activation 已清除 | 补记 plan/journal 终态并继续原 finalize，不可再次移动 Previous |
| `rolled_back` | 登记 Current | stable 已恢复 Current，Candidate/Activation 已清除，失败 recovery 身份由审计 journal 保留，主 unit 已恢复 enabled | 幂等启动并验证 Current 控制面；不得自动重激活失败候选或伪报成功 |

## 公网入口与维护

Manager 持有唯一产品端口。正常时代理 current Platform generation；维护或 Platform 不可用时直接返回临时页面和精简更新状态，所以应用容器未启动时入口仍然可用。

维护页只展示公开 state、phase、重试时间和 support/operation id，并使用无脚本的短周期刷新。日志、宿主路径、镜像凭据、Docker 信息和恢复动作不能进入公共页面。正常管理面板通过 Platform 代理 Manager 状态；Platform 故障时使用宿主 CLI。

## 镜像与发布物

main 质量门构建受支持架构的镜像与 Manager 二进制。release manifest 包含 source commit、协议版本、数据库版本、Manager 校验和、Compose 摘要及每个镜像的完整 registry digest。Manager 只按 digest 拉取，不使用 mutable tag 作为运行身份。

官方清单引用的 Platform、Runtime、Camoufox 和 Sandbox package 必须能够在无 registry 登录状态下按 digest 拉取。CI 使用隔离的匿名 Docker 配置验证这一点，再执行 Compose smoke test；必需工件全部通过后才发布清单。

部署机不拉取 Cognee 或 Firecrawl Git 源码。Cognee 在镜像构建阶段从精确契约 revision 安装；Firecrawl Compose 服务和 digest 在 CI 中对上游契约验证后进入发布清单。

托管集成的 bind mount 只能覆盖镜像声明的数据路径，不能遮蔽 entrypoint、脚本、库或默认配置。Firecrawl 固定注入 `NUQ_BACKEND=pg`，Postgres、Redis 与 RabbitMQ 分别使用明确的宿主 bind 数据目录；部署环境不能覆盖队列后端。不得注入 `FDB_CLUSTER_FILE`、启动 FoundationDB、声明其镜像或数据目录，或让 API 等待实验性 FoundationDB 后端。

## 健康与提交

Platform generation 的核心提交门为：Manager 存活并持有公网入口与控制接口、Platform readiness 和 Agent Runtime readiness。核心门通过后可以提交 generation 并退出维护；Camoufox、SearXNG、Firecrawl 与 Cognee 的状态独立显示为 healthy、starting 或 degraded，任何单项故障都不能让 Manager 退出或把健康的 Platform 锁成 503。

Manager 启动固定栈时先等待核心服务，再异步收敛能力服务。Firecrawl 收敛以 `docker compose up --detach --wait firecrawl-api` 幂等启动 Playwright、Redis、RabbitMQ、Postgres 与 API；失败后记录有界诊断并指数退避，不自行删除或改写持久数据。该预算只约束 Firecrawl 能力收敛，不是更新维护时间或 Agent run 执行超时。

任何时刻最多一个可写 Platform 打开 SQLite。候选镜像先运行无业务 writer 的 preflight；Manager 在维护门关闭并停止 current writer 后，使用同一 Platform 镜像执行：

```text
enterprise-agent-platform migrate --data /var/lib/ubitech-agent
```

该命令只执行幂等 schema migration 并输出最高 migration version，不启动 HTTP、Runtime、后台 worker 或 bootstrap 用户。成功退出后才能启动候选 Platform writer。

Platform 固定容器的启动命令只使用 `serve --host <host> --port <port> --data <dir>`。`--listen-host`、`--listen-port` 或其它隐藏监听别名不属于当前接口，必须失败而不是兼容解析。

## Agent Sandbox

每个私人 Agent 和频道主 Agent拥有独立 Sandbox 容器；委派子 Agent共享父容器和工作区。Sandbox 第一次执行工具时按需创建，无任务且无后台进程达到契约空闲时间后停止但不删除。

Sandbox 挂载 `/workspace`、`/home/agent` 和 `/opt/agent-env`。工作区、HOME 与专用环境位于数据根；容器可以重建，持久目录不变。当前 scope 的附件目录只读挂载到 `/workspace/.ubitech/attachments`，不得暴露全局附件根。容器 writable layer 与系统包安装不属于持久数据。

Manager 对宿主挂载逐级使用已验证数据根和无符号链接路径检查。首次登记后，`sandbox_id` 不能重绑到不同 `workspace_id`；registry 原子写入失败时必须撤销本次容器创建、启动或镜像替换，不能留下未登记容器。

Sandbox entrypoint 只允许在启动映射 UID/GID 时短暂以 root 运行，随后立即降权为部署用户对应身份。它不得递归修改挂载树，也不提供 root 业务进程。Manager 每次 exec 都显式使用相同 UID/GID。

## 运维验收

部署或更新完成后至少验证：

- Manager service 为 active/enabled，`status` 没有 active/finalize operation；
- Platform 与 Runtime 核心探针健康；
- 登录、首页、普通消息、SSE 与附件可用；
- Agent Sandbox 能按需创建、停止并保留工作区；
- terminal 路径可用；搜索、浏览器和网页提取分别报告实际能力状态，故障时不影响普通消息与 Agent Runtime；
- Firecrawl 在空数据首次启动与保留 PostgreSQL 数据重建两种场景均健康，并通过真实提取请求；若暂时 degraded，Manager 保持在线并继续有界自愈；
- 数据库完整性检查通过，current generation 与 Manager journal 一致。

生产故障只能通过 Manager operation、当前数据库快照和 current/previous generation 处理。不得手工编辑 journal、切换镜像 tag、直接运行 Platform 或创建第二套 Compose 栈。
