# 部署

本文定义 ubitech agent 的 Docker 部署方式。自动更新见[自动更新](auto-update.md)，持久目录见[数据布局](../reference/data-layout.md)，信任边界见[安全设计](../design/security-and-trust.md)。

## 支持的拓扑

生产部署只保留一个宿主机常驻程序 `ubitech-manager`。管理器作为 user-systemd 服务运行，拥有公网监听 socket、维护页、Docker 生命周期、更新状态、宿主执行器和恢复 CLI。Platform、Agent Runtime、Camoufox、SearXNG、Firecrawl 以及 Agent Sandbox 均由它按不可变镜像 digest 管理。

只有管理器可以访问 Docker socket。Platform、Runtime、Sandbox 和外部集成容器不得挂载 Docker socket。公网反向代理只连接管理器；Platform backend 只发布到宿主回环，所有 sidecar 只位于受管 Docker 内网。该内网由管理器在启动固定栈前创建并校验，是带产品 managed label 的持久 external bridge network；Compose 更新和回滚不得删除它。若已存在同名网络却缺少受管 label、driver 不是 bridge 或关键属性不符，管理器必须停止并报告冲突，不能接管未知网络。

固定服务栈包括：

- `platform`：Python 业务服务和已构建前端；Cognee 依赖构建在此镜像中；
- `agent-runtime`：Pi 模型与工具协调器；
- `camofox`：共享浏览器服务，按 Agent 使用独立 Profile；
- `searxng` 与 Firecrawl 的受管服务；
- `agent-sandbox`：按主 Agent 动态创建，不属于固定 Compose 数量。

## 宿主要求与安装位置

宿主需要 Linux、Docker Engine、Docker Compose v2、user-systemd 和能够使用 Docker 的部署用户。标准安装不需要宿主 Python、Node、npm 或 Git；从旧源码部署首次迁移时只在桥接阶段继续使用原有依赖。

默认位置：

```text
~/.local/bin/ubitech-manager
~/.config/ubitech-agent/manager.toml
~/.config/systemd/user/ubitech-agent-manager.service
~/.local/share/ubitech-agent/
```

管理器安装和运行身份必须与原部署用户一致。容器内需要写入用户数据的进程使用相同 UID/GID；服务专用镜像所需的其它 UID 由管理器只对其明确数据子目录准备权限，不能递归改写整个数据根。

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

命令通过 owner-only Unix socket 连接常驻管理器，并从 Manager secret 读取 control capability。Platform 使用同一 control capability 代理已通过管理员授权的操作；Runtime 只有独立 executor capability，不能访问管理 operation。所有变更操作带 operation id、幂等键和期望 generation；Manager 必须先按幂等键查找并核对 operation 类型、manifest 与 source commit 指纹，再判断 generation。相同指纹的重复提交即使携带创建前的旧 generation，也返回原操作；相同 key 携带不同指纹必须冲突。只有上一 attempt 已明确失败且调用方重新读取并提交当前 generation 时，才以同 key 创建下一 attempt。并发冲突不启动第二个变更。管理器进程退出后根据持久 operation journal 继续、回滚或进入可诊断的 `failed`，不能猜测成功。generation 写入与提交后副作用之间必须有持久 `finalize_pending` 边界；新 Manager 先由旧二进制 watchdog 确认健康，再在仍持有 Platform 更新预约时完成并持久化旧部署完整恢复归档、旧运行物清理和 live-data cache 退役，最后才解除预约并标记 `finalized`。任一 finalize cleanup 失败都继续保持预约、维护和 `finalize_pending` 供幂等恢复，绝不能先开放后台任务再归档或删除其输入。启动恢复既要处理 operation 已完成但 generation 尚未写入，也要处理 generation 已写入但 finalize hooks 尚未完成的窗口。旧源码和数据的破坏性清理必须晚于新 Manager 健康确认，不能只以“已写 self-update intent”作为删除依据。

首次安装脚本只负责下载并校验管理器、执行 preflight、写 user-systemd unit 和提交 install operation。安装完成后源码目录不参与运行。源码首迁的 preflight 必须先由待安装的 Manager 使用正式配置解析器读取现有 `manager.toml`，并把其有效 `data_root`、公网 `listen`、长期 release manifest URL/channel、旧 Platform 回环 URL 和共享 control/executor Unix socket 与桥接输入逐项比较；任何不一致都必须在覆盖 Manager 二进制、写 unit 或停止旧服务前 fail-safe。下载或 operation 返回可重试状态时，安装器必须把 exact source commit、旧部署参数、legacy update id 与其状态记录器固化到 checkout 外的 owner-only retry 脚本；timer 进程不得依赖首次 transient worker 的环境继承。普通空机安装不携带这组首迁期望值，不受该一致性门影响。

## 公网入口与维护

user-systemd 监督的管理器进程持有平台端口。正常时管理器反向代理当前 Platform generation；维护时由管理器直接返回维护页和精简更新状态，因此应用容器完全不存在时页面仍可访问。管理器二进制自更新会由 systemd 做一次受 watchdog 保护的短重启；连接可以重试，但不能把 Platform 更新期间的长期入口可用性依赖在应用容器上。

维护页只展示公开 state、phase、重试时间和 support/operation id，并由管理器通过无脚本的短周期 `Refresh` 响应头自动重试；严格 CSP 不依赖或放行内联脚本。日志、宿主路径、镜像凭据、Docker 信息和恢复动作不进入公共页面。正常管理面板通过 Platform 代理管理器状态；Platform 失败时使用宿主 CLI 恢复。

## 镜像与发布物

main 的质量门完成后构建 linux/amd64 与 linux/arm64 镜像和对应管理器二进制。发布清单包含源提交、协议版本、数据库版本、管理器校验和及每个镜像的完整 registry digest。官方 main 通道不下发 registry 凭据，因此 Platform、Runtime、Camoufox 和 Agent Sandbox 四个 GHCR package 必须在公开清单前确认为 `public`；个人命名空间首次创建这些 package 后，仓库所有者需在 GHCR package settings 中完成一次性公开设置，在此之前发布必须 fail closed 且不生成 main 清单。CI 必须使用隔离且无认证的 Docker config 按 digest 重新 pull 四个镜像，已登录的构建会话不构成部署可用性证明。`install.sh` 是同一个 release 的必需可执行发布物；CI 必须对将上传的副本执行 shell 语法检查，并在 package 可见性、管理器二进制、Compose、安装器和镜像全部通过 smoke test 后，最后上传 `release.json` 再原子公开 main 通道。

管理器只按清单 digest 拉取，不使用 mutable tag 作为运行身份。部署机不拉取 Cognee/Firecrawl Git 源码：Cognee 在镜像构建阶段从精确契约 revision 安装；Firecrawl Compose 服务与 digest 在 CI 中对精确上游契约验证后进入发布清单。

托管集成的 bind mount 只能覆盖镜像声明的数据路径，不能遮蔽镜像 entrypoint、脚本、库或默认配置根。FoundationDB 的持久数据挂载到 `/var/fdb/data`，共享 cluster 目录挂载到 `/var/fdb/cluster`，server、初始化任务和 Firecrawl API 必须显式使用同一个 `/var/fdb/cluster/fdb.cluster`；不得把空宿主目录直接挂到 `/var/fdb`，也不能依赖 named-volume 的首次镜像内容复制语义来补齐可执行脚本。FoundationDB 镜像已用 Tini 作为 PID 1，因此该服务关闭 Compose 的通用 `init` 包装，避免嵌套 Tini 和误导性的 subreaper 警告。FoundationDB 的配置健康检查以数据库已配置为前提，因此一次性初始化任务只等待 server 进入 started，并对配置命令执行有界重试；Firecrawl API 必须同时等待初始化成功和 FoundationDB 健康，不能让初始化反向等待由它自己建立的健康条件。

源码桥迁移使用 exact release 中的 Manager 二进制及其 SHA-256 sidecar，不扫描旧 checkout 中的任意 executable。`--manager-binary` 只作为运维显式指定的本地开发入口，永远不能由安装器从 `dist`、`.migration` 或其它旧目录自动发现。

## 健康与提交

Platform generation 的提交条件为：管理器存活并持有入口、Platform readiness、Agent Runtime、Camoufox 能力和 SearXNG 搜索健康。Firecrawl/Cognee 故障作为对应能力 degraded，除非目标版本的数据迁移声明把它列为必需项。

两个可写 Platform 实例不得同时打开同一 SQLite。候选镜像只能先运行无数据写入 preflight；实际数据库迁移和启动发生在维护门关闭、旧实例停止之后。

管理器在该写入门关闭后使用同一 Platform 镜像执行 `enterprise-agent-platform migrate --data /var/lib/ubitech-agent`。该命令只打开数据库、执行幂等 schema migration、输出已应用的最高 migration version 后退出；它不能启动 HTTP、Runtime、后台 worker、Gateway 或 bootstrap 用户。命令成功退出后管理器才可启动新 Platform writer。

## Agent Sandbox

每个私人 Agent 和频道主 Agent拥有独立 Sandbox 容器；委派子 Agent共享父容器和工作区。Sandbox 在第一次使用时创建，无任务且无后台进程达到机器契约规定的空闲时间后停止但不删除。

Sandbox 挂载 `/workspace`、`/home/agent` 和 `/opt/agent-env`。工作区、HOME 与专用环境落在数据根；平台升级可以重建容器而保留这些目录。管理器还把当前 scope 的附件目录只读挂载到 `/workspace/.ubitech/attachments`，不得把全局附件根暴露给 Sandbox。基础镜像变更只在该 Sandbox 无活动任务和进程时应用，容器 writable layer 与 apt 安装不属于持久数据。

Manager 在宿主侧读写这些挂载时必须从已验证的数据根 fd 开始逐级使用 `openat`，目录搜索仅从固定 fd 枚举名称，再以 `O_NOFOLLOW` 打开条目并检查 fd 类型；不能让语言运行时根据逻辑显示名重新解析宿主路径。发布门必须在 `manager/go.mod` 的最低 Go 版本验证嵌套文件搜索、附件覆盖层与符号链接逃逸，避免开发机较新工具链掩盖兼容缺陷。

同一 `sandbox_id` 首次登记的 `workspace_id` 不得重绑。管理器操作 Docker 前验证所有 bind root 均为数据目录内由部署用户持有的非符号链接目录；registry 原子写入失败时，必须撤销本次容器创建、启动或镜像替换并恢复原记录，不能留下未登记的运行容器。

Sandbox 容器创建时只让入口以 root 完成一次 UID/GID 映射与挂载根校验，随后 PID 1 立即降权为部署用户对应身份。入口不递归修改数据，也不提供 root 业务进程；管理器每次进入容器执行工具时显式传入相同 UID/GID。发布 smoke test 必须覆盖非 `1000:1000` 身份、无交互 sudo，以及固定 Compose 栈 `down`/重建时既有 Sandbox 和受管网络仍然存在。

## 首次从源码部署迁移

首次迁移采用两阶段自动切换：

1. 旧 Git 更新器正常拉取一次桥接版本并恢复服务。若发起更新的旧 `deploy.sh` 尚不包含桥接调用，本轮只允许提交健康的新源码；重启后的 bridge-capable Platform 必须在 `HEAD` 已追平 remote 时仍识别未完成首迁，并通过既有预约机制自动启动第二次当前脚本更新，不得等待另一个 Git commit；
2. 当前版本的 `deploy.sh update` 使用本次实际生效的 source commit、data、service、host 与 port 重启桥接服务，并从 `container-<source-commit>` 不可变 release 下载同一提交的管理器与引导清单；不得把先前的 latest generation 当成本次桥接目标。桥接 HEAD 作为 `expected_source_commit` 同时持久写入 legacy migration plan、install operation 和所有排队重试；Manager 在保存 candidate、拉镜像或进入维护前必须验证清单 `source_commit` 完全相等，URL 名称本身不构成证明。这个精确 URL 只绑定首次迁移 operation，Manager 持久配置必须仍指向 `releases/latest/download/release.json` 的 main 通道，否则迁移后会永久停在引导提交。若该提交的管理器二进制或完整清单尚未发布，安装器把同时携带精确引导 URL、expected commit 与长期通道 URL 的重试程序复制到 Manager control 目录并用 owner-only user-systemd timer 排队，不能依赖后续再次出现 Git commit；
3. 桥接服务只在显式 source-migration 模式下读取 Manager control socket/token；如果 bridge 四项环境在本次更新中新增、变化或移除，service 模式必须先在任何 Git 或 unit 变更前，从权限安全的当前 systemd unit 与稳定 MainPID 的实际环境共同捕获精确回滚基线，两者任一字段不一致或不可读都 fail closed。更新器 shell 环境不能覆盖这一真相；字段 set/unset、协议原值以及 unit 中 `%%` 对应的实际 `%` 都必须无损保留。之后在写入排空后完整重启旧 Gateway，使实际进程从新版 unit 读取目标环境，不能用继承旧环境的 SIGHUP re-exec 代替。首次转换前必须把原 unit 快照和独立事务 guard 外置到 checkout 之外，使仍在执行旧 `deploy.sh` 的 Git 回退或被拒绝的回退，只要没有同一 update id 与 exact source revision 的 durable handoff marker，都会恢复快照、完整重启并验证实际进程环境。重启后 Manager 的首次 reserve 以真实 token 对旧回环 Platform 完成认证，认证失败时不得进入维护或迁移；foreground 模式保留启动时 shell 基线，并在存活进程与目标四字段有任何差异（含路径变化或字段移除）时拒绝进入 cutover。Manager 迁移期通过旧回环 Platform URL完成空闲预约，切换成功后自动改用容器 Platform URL。control 与 executor API 共享同一个 owner-only Unix socket、使用不同 capability，因此该 socket 以及规范化后的 control token-file 路径都属于首迁一致性比较字段；
4. 发布物就绪后后台预拉取镜像，再等待平台自然空闲；
5. Gateway 排空并把入口交给已安装在源码树之外的管理器；
6. 管理器停止旧服务和 Compose 栈、建立一致数据库快照并迁移数据；
7. 新容器完成 readiness、迁移文件清单与 hash 校验和管理器重启验证后提交 generation；当前提交门证明迁移输入字节未丢失，但不宣称已逐业务表核对 schema migration 前后行数；
8. 新 Manager 经旧二进制 watchdog 确认 control socket 与公网入口健康后，在 Platform 更新预约仍保持关闭的条件下生成并校验旧部署的完整恢复归档，再永久 disable 旧 user-systemd service，删除旧 Compose project、已复制的旧数据路径和 Git checkout并退役 live-data cache；这些结果全部持久化后才解除预约。残留的 disabled unit 文件进入归档且不再参与启动。

源码更新与 Manager 首迁的提交边界不得混用。文档、Git、源码 bootstrap 或源码状态提交失败发生在新源码健康确认前，继续使用既有 Git rollback；一旦新源码已健康并进入 `source_bridge_ready`，此后安装器可能已经写入 Manager 配置、unit 或 operation journal，任何失败都不得再执行 Git reset。安装器退出码约定为：`75` 仅表示当前将执行的重试入口、unit、timer、依赖的 installer/CLI 及父目录均已同步到稳定存储，并且 timer 的 enable 链接已核验；`0` 表示 Manager operation 到达 succeeded，其它值表示需要记录的迁移交接失败。从 release 下载重试改写为 operation 直接重试也必须再次通过这一门禁，门禁成功后才能提交 `container_migration_queued`。直接重试进程必须先非阻塞取得同一 repository update lock，再确认冻结 checkout、update marker 与 revision 未变；若父安装器尚未释放锁，则保留 timer 并以 `75` 结束该轮。永久失败保留健康源码服务并记录非阻塞 `container_migration_failed`，不能显示成全局成功，也不能留下无错误说明的 bridge 模式；timer 只有在 exact failed marker 文件和父目录成功 `fsync` 后才能清理，避免可见但尚未持久的 marker 与已删除重试入口形成断电裂缝。

Manager 的本地 control socket 仍是跨进程网络边界。CLI 对迁移 plan、operation 创建或 operation 查询收到 2xx 却无法完整解码 JSON 时，服务端提交结果未知；首迁安装器必须按临时交接状态持久排队，而不是当作永久退出。所有可能重放的 mutation 都必须具有由同一迁移输入导出的稳定幂等身份，重连后先以 Manager state/journal 对账。服务端必须在写出状态码前完成 JSON 编码，编码失败返回结构化非 2xx；写 mutation 只返回固定大小确认，不回传可无限增长的迁移清单。客户端仍需防御进程重启、socket 断开和有界读取超限造成的截断成功响应。

当前 bridge shell 在调用源码 bootstrap 时传入显式协议版本，并在 bootstrap 失败的 Git rollback 重部署前恢复原始 bridge/Manager 环境。为已部署的旧桥接 shell 保留一次兼容保护：目标 bootstrap 在缺少该协议版本且失败时，安装 checkout 外的有界回滚守护，等旧 shell 退出后清除它误持久的 bridge/Manager unit 环境并重启旧服务。该守护只恢复更新能力，不自行改变数据、checkout 或开始 Manager 迁移。正常 bootstrap 写入 bridge 环境后也必须验证运行进程而非 unit 文件：长期 Gateway 的进程环境不因 `daemon-reload` 改变，源码 bridge readiness 以受控重启后的实际四项环境为准；之后的 Manager cutover/admission readiness 还必须使用真实 Bearer 完成 reserve，不能把前一 marker 当作认证成功。

支持容器首迁的 checkout 必须同时具有可执行 `install.sh` 和容器契约；只存在其中一项属于损坏发布并应 fail closed，不能静默跳过。源码更新日志位于对应 transient auto-update unit（前台模式才写旧数据目录日志），排队重试看 `ubitech-agent-migrate.service`，Manager 阶段看 `ubitech-agent-manager.service` 及 Manager state/journal。旧 `auto-update-state.json` 的成功只说明源码事务，不能用来判断容器迁移完成。

在上述流程开始等待空闲和停止旧服务之前，Manager preflight 还必须通过可等待且自动回收的 `systemd-run --user` oneshot `true` transient unit 验证用户会话具备启动独立 watchdog 的能力。这个探针不修改产品状态；无法创建、等待或收集 transient unit 时首迁必须终止并保持旧服务运行，不能等到 Manager 自更新阶段才发现 watchdog 不可用。由于 release 排队可能持续很久，Manager 在取得全局空闲预约后、切换维护和停止旧服务前，必须再次读取配置、核对首次预检绑定的关键配置指纹并重跑 transient-unit 探针；复检失败要释放预约且保持旧系统运行。

冻结在旧 bridge 的恢复可以使用较新 release 中经过 SHA-256 校验的 installer 与 recovery CLI，但原 update id、source revision 和 exact Platform release manifest 仍保持不变。release 必须同时发布 installer 的 checksum sidecar，不能要求操作员直接执行未经校验的网络脚本。经过校验的 installer 以显式 `--repair-failed-handoff` 进入恢复模式，自行取得冻结 checkout 的 repository flock，确认 clean HEAD 与 expected commit 相等，并通过旧 checkout 的状态 helper 完成唯一允许的 failed → source-bridge-ready 转换；不能靠编辑 JSON 或先解冻 Git 更新。旧安装器未携带 token-file expectation 时，新 CLI 只能从绝对 `data_root` 推导标准 owner-only token 路径后执行同样的配置比对；不得把兼容解释为允许任意 token 文件或越过 preflight。下载的新 CLI 必须安装到 owner-only 的独立 recovery 路径，所有持久 retry 也引用该路径；只要旧 Manager service 仍是权威进程，安装器就不能预先覆盖其稳定 `ExecStart` 文件、重写 unit 或仅为加载新控制协议而重启它。若历史失败已污染稳定路径，只有旧 unit/ExecStart、MainPID 与启动时间、`/proc` 运行 SHA、旧 exact manifest artifact，以及存在时无 Activation 的 self-update Current 路径/记录 SHA/实算 SHA 全部一致，才允许原子恢复 stable；校验前后 PID、启动时间、unit fragment 与 self-update state 必须保持不变。稳定 Manager 只能在 operation 提交 Platform 后经既有 self-update watchdog 切换，这样 previous binary 仍是真实旧版本，进程意外退出也不会越过 watchdog。recovery CLI 与旧 Manager 交接时，readiness 和幂等 Configure 使用 status-only 成功语义，不能因旧 `/v1/status` 或迁移 plan 携带超大历史诊断而阻断；需要读取 operation 时兼容预算覆盖单个合法旧 journal，迁移到新 Manager 后则由有界 journal/API 契约收敛。

源码树内的默认数据移动到 XDG 数据根；明确配置在源码树外的数据原地复用。旧源码 checkout 与新数据目录不得在任一方向形成祖先/后代关系；旧数据根与新数据根也必须拒绝任一方向的重叠（两者规范化后完全相同的原地采用除外），避免 staging 递归复制自身或清理旧 checkout 时触碰新权威数据。清理前必须把旧 checkout、配置、systemd unit、Compose 元数据和不与新数据目录共享的外部 data 形成 operation 绑定的可恢复归档，并记录类型、mode、size、link target 与内容 hash 清单。位于同一文件系统且不再被运行路径引用的树优先原子 rename 到备份根；跨文件系统则 copy、fsync、逐项校验后才允许删除源。工作区、附件和 Profile 已由新数据目录权威持有时可以只在归档中保存经双方计数、总字节数和 hash 对账的迁移清单，避免第二份巨大副本。未知 ignored 文件纳入同一七天隔离归档，不能静默删除。归档和迁移清单至少保留七天，并提供将 checkout、配置、unit 与外部 data 恢复到原路径的验证流程。

新数据目录只按固定白名单退役旧宿主构建物：`runtimes/cognee/source`、`runtimes/firecrawl/source`、`runtimes/camofox/app`、`runtimes/camofox/browser`、`runtimes/camofox/browser.previous` 和 `runtimes/node`。这些路径在新 Manager watchdog 健康确认后原子移入同一七天 recovery pack 并写校验清单。迁移器不得用模糊名称或递归猜测扩展白名单；尤其不得移动 Camoufox 的 `profiles`、`cookies`、`traces`，Cognee/Firecrawl 的 index、数据库、session、配置、日志或任何用户工作区。

旧 Compose 清理只能操作迁移计划中显式记录且能够证明归属的 project 与容器 allowlist。桥接版本生成的 Firecrawl/SearXNG Compose 必须为全部服务补上产品 managed label；对桥接前已经存在且尚未被 Compose 重建的无标签容器，只能在 Compose project、service 名称同时命中固定 allowlist，且 `com.docker.compose.project.working_dir` 规范化后位于对应旧数据 runtime 目录内时视为等价的遗留归属证明。任一标签不可解析、路径越界或 service 未知都必须保留容器并让迁移停在 `cleanup_pending`，不能按 project 名单独删除。不能证明归属的 network 与 volume 只报告而不删除；任何清理失败都保留 `cleanup_pending` 并幂等重试，不能把错误仅写入报告后标记 committed。后台 retention 必须与 Configure、PreCutover、Cutover、FinalizeCleanup、Rollback 和 Restore 使用同一变更锁；它只能删除当前持久计划明确标记为 `committed`、`archive_ready`、超过保留期且重新通过 receipt 和逐树 hash 校验的 recovery pack。`cleanup_pending`、迁移中、校验失败或来源未知的 `*-legacy` 目录一律保留并报告，不能仅凭目录名和 mtime 删除。

迁移变更锁只负责串行化上述会修改持久计划、服务或文件系统的操作，不能被 Gateway 和控制面公开的 `Plan`、`Active` 等只读状态查询获取或等待。迁移服务每次成功原子落盘后必须在独立短锁下发布不可变的内存快照；读端返回快照的深拷贝，并且在首次读取时也只使用独立状态锁从原子状态文件初始化。这样即使首次复制、归档或回滚长期占用变更锁，维护页仍能快速看到最近一次已持久化状态，同时读写双方不得共享可变 slice 或产生数据竞争。

任何预检、复制、迁移或 readiness 失败都在清理旧目录前恢复旧源码服务；监听入口继续展示维护或安全恢复状态。数据库迁移版本随 release 单调递增，Platform 必须把结构变更、外键完整性检查和版本标记作为一个原子事务；即使遗留子表为空，也要验证或清理其外键定义，不能只按数据行违规数判断成功。切换旧 systemd 服务前先读取并持久记录原 `UnitFileState` 与 stop intent，再执行可逆的 `disable --now`，避免此后任一主机重启让旧 unit 抢占公网端口。命令返回后任何状态落盘失败都必须同步补偿：原 enabled unit 使用 `enable --now`，原 disabled unit 只恢复运行而不改变其启用语义。恢复看到 stop intent 时不能依赖可能尚未写入的 `old_service_stopped` 结果位，而要按持久的原状态保守恢复；只有新 Manager watchdog 已健康提交后，Commit 才确认永久 disabled。

数据复制使用同一文件系统内的 staging 目录。校验完成后必须先按自底向上顺序同步 staging 中的文件和每层目录，再持久化 `copy_prepared` 和文件清单。把 staging 原子 rename 为目标后，还必须成功同步目标父目录，最后才允许持久化 `copied`；任一同步失败都必须保持旧服务可恢复，不得在另一状态目录中先行承诺迁移已完成。回滚和重新武装迁移必须同时处理 `copy_prepared`、`copied`、staging 已存在以及 rename 已完成这几种组合，确认旧数据仍存在后幂等删除未提交目标，不能让断电留下的完整副本阻塞后续自动重试。

首次 Configure 与 operation journal 的 active claim 使用同一进程锁串行化：Configure 先提交 plan 时，随后 install 必须读取并绑定它；operation 先取得 claim 时，Configure 必须拒绝创建计划，不能把运行中的 fresh install 改造成未预约的 source cutover。重复配置同一 legacy migration 只能返回现有 plan，不能把 `rolled_back` 重新武装为 `configured`；只有上一 operation 已明确终结、下一次显式 install attempt 已在 operation journal 中原子取得 active claim 后，才由该 operation 重新武装。重新武装、是否需要 legacy reservation 和后续 Cutover 必须绑定同一个 operation id，不能在两次状态读取之间改变判定。迁移 timer 观察到运行中 operation 时只等待其 journal，不能通过 Configure 改写其回滚状态，也不能为非 retryable 的失败自动创建下一 attempt。

第一代 bridge 的 Manager 状态可能包含超过旧 Platform 客户端上限的历史诊断。新版 install retry CLI 在停止旧服务前必须先用 release check 读取 exact manifest，并让服务端在写 Candidate 或清除错误前核对 expected source commit；旧 Manager 不认识该字段时，CLI 只可在确定的 400 unknown-field 响应后回退到其旧 check 契约。每次独立 retry 都使用新的 check 身份，不能被同进程的旧缓存跳过。当前 Platform 客户端仍保留有界的兼容读取预算。候选启动不允许依赖无限状态正文，新的 Manager API 必须持续输出有界诊断。

若运行中的旧 Manager 已卡在 `rolling_back`，仅替换调用它的 CLI 无法改变服务端恢复逻辑。受支持入口是同一不可变 release 中校验过的 `recover-rolling-back`：第一道门通过 owner-only socket 绑定 exact active operation、源码提交和迁移状态，并在旧 API 提供路径时一并核对；随后确认旧宿主服务健康、暂停迁移 timer、取得源码更新锁并受控停止 Manager service。第二道门由新二进制直接读取 owner-only journal，对 legacy 路径、service 和目标数据目录执行不可省略的 exact 复核，然后才离线恢复。恢复默认允许 30 分钟，可由显式参数在 1 分钟至 2 小时内调整，避免大型数据库仍受旧的短 wall-clock 限制。所有退出路径都必须在仍持有源码锁时恢复原 Manager service 与 timer 状态。它不得修改 stable Manager binary、unit、release manifest 或 Git checkout；只有 operation 已成为失败终态、maintenance 已解除且旧 Manager 重新健康后才返回成功。运维不得用手工 `mkdir`、编辑 journal 或清除 active id 代替该入口。

清理完成是不可逆提交点，此后只使用镜像和数据库快照回滚。

对于 `source-v1-retirement-2026-07` 之前已经完成且未恢复的唯一存量源码迁移，下一次容器 release 会在普通更新完全提交、服务恢复空闲后自动执行一次源码部署退役。该活动是从“可恢复旧源码服务”到“只支持容器 generation/数据库快照回滚”的明确不可逆转换：它重新校验当前 Manager、核心容器、公网入口和 Firecrawl 完整链路，逐项核对迁移归档、systemd 文件、source retry/recovery 文件、宿主构建缓存及旧 Compose 标签后才删除。任一对象不能证明归属时只记录错误并后台重试，不扩大路径匹配，也不影响当前容器服务。

退役活动完成的宿主机不得再保留可启动的 `enterprise-agent-platform.service`、迁移 timer/retry/guard、旧 checkout recovery pack、source updater marker/log、旧 Platform gate 值或旧 Firecrawl/SearXNG Compose 容器/network/volume。它仍必须保留所有业务数据、Agent 工作区/记忆/会话、浏览器状态、当前外部服务 bind mount、Manager 状态、当前与 previous generation、普通数据库快照以及回滚所需镜像。Manager 把活动结果压缩为不含旧绝对路径的 `purged` receipt；只有观察到该 receipt 后，后续版本才可删除源码桥接兼容实现。

桥接版本在等待完整发布清单期间仍可用旧的源码进程运行。该兼容路径必须显式把 Runtime 设为 local executor，并使用宿主 workspace 绝对路径；它只用于迁移等待和开发测试，不能成为 Docker 生产拓扑的隐式回退。`UBITECH_SOURCE_MIGRATION_BRIDGE=1` 只能与绝对 Manager socket/token-file 路径同时启用，且不会把 Platform 切成 container execution。容器模式必须显式设置部署模式，缺少 Manager socket/token 或执行器时直接失败，不能静默切回宿主本地执行。

## 验证

部署完成至少验证管理器 health/readiness、登录、消息、Agent Sandbox、Runtime、搜索和浏览器。发布门必须覆盖空主机安装、旧数据迁移、跨文件系统复制、管理器进程终止、镜像启动失败、数据库迁移失败和旧 generation 回滚。
