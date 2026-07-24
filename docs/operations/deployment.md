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

命令通过 owner-only Unix socket 连接常驻管理器，并从 Manager secret 读取 control capability。Platform 使用同一 control capability 代理已通过管理员授权的操作；Runtime 只有独立 executor capability，不能访问管理 operation。所有变更操作带 operation id、幂等键和期望 generation；重复提交返回同一操作，并发冲突不启动第二个变更。管理器进程退出后根据持久 operation journal 继续、回滚或进入可诊断的 `failed`，不能猜测成功。generation 写入与提交后副作用之间必须有持久 `finalize_pending` 边界；新 Manager 先由旧二进制 watchdog 确认健康，再在仍持有 Platform 更新预约时完成并持久化旧部署完整恢复归档、旧运行物清理和 live-data cache 退役，最后才解除预约并标记 `finalized`。任一 finalize cleanup 失败都继续保持预约、维护和 `finalize_pending` 供幂等恢复，绝不能先开放后台任务再归档或删除其输入。启动恢复既要处理 operation 已完成但 generation 尚未写入，也要处理 generation 已写入但 finalize hooks 尚未完成的窗口。旧源码和数据的破坏性清理必须晚于新 Manager 健康确认，不能只以“已写 self-update intent”作为删除依据。

首次安装脚本只负责下载并校验管理器、执行 preflight、写 user-systemd unit 和提交 install operation。安装完成后源码目录不参与运行。源码首迁的 preflight 必须先由待安装的 Manager 使用正式配置解析器读取现有 `manager.toml`，并把其有效 `data_root`、公网 `listen`、长期 release manifest URL/channel、旧 Platform 回环 URL 和共享 control/executor Unix socket 与桥接输入逐项比较；任何不一致都必须在覆盖 Manager 二进制、写 unit 或停止旧服务前 fail-safe。普通空机安装不携带这组首迁期望值，不受该一致性门影响。

## 公网入口与维护

user-systemd 监督的管理器进程持有平台端口。正常时管理器反向代理当前 Platform generation；维护时由管理器直接返回维护页和精简更新状态，因此应用容器完全不存在时页面仍可访问。管理器二进制自更新会由 systemd 做一次受 watchdog 保护的短重启；连接可以重试，但不能把 Platform 更新期间的长期入口可用性依赖在应用容器上。

维护页只展示公开 state、phase、重试时间和 support/operation id，并由管理器通过无脚本的短周期 `Refresh` 响应头自动重试；严格 CSP 不依赖或放行内联脚本。日志、宿主路径、镜像凭据、Docker 信息和恢复动作不进入公共页面。正常管理面板通过 Platform 代理管理器状态；Platform 失败时使用宿主 CLI 恢复。

## 镜像与发布物

main 的质量门完成后构建 linux/amd64 与 linux/arm64 镜像和对应管理器二进制。发布清单包含源提交、协议版本、数据库版本、管理器校验和及每个镜像的完整 registry digest。官方 main 通道不下发 registry 凭据，因此 Platform、Runtime、Camoufox 和 Agent Sandbox 四个 GHCR package 必须在公开清单前确认为 `public`；个人命名空间首次创建这些 package 后，仓库所有者需在 GHCR package settings 中完成一次性公开设置，在此之前发布必须 fail closed 且不生成 main 清单。CI 必须使用隔离且无认证的 Docker config 按 digest 重新 pull 四个镜像，已登录的构建会话不构成部署可用性证明。`install.sh` 是同一个 release 的必需可执行发布物；CI 必须对将上传的副本执行 shell 语法检查，并在 package 可见性、管理器二进制、Compose、安装器和镜像全部通过 smoke test 后，最后上传 `release.json` 再原子公开 main 通道。

管理器只按清单 digest 拉取，不使用 mutable tag 作为运行身份。部署机不拉取 Cognee/Firecrawl Git 源码：Cognee 在镜像构建阶段从精确契约 revision 安装；Firecrawl Compose 服务与 digest 在 CI 中对精确上游契约验证后进入发布清单。

源码桥迁移使用 exact release 中的 Manager 二进制及其 SHA-256 sidecar，不扫描旧 checkout 中的任意 executable。`--manager-binary` 只作为运维显式指定的本地开发入口，永远不能由安装器从 `dist`、`.migration` 或其它旧目录自动发现。

## 健康与提交

Platform generation 的提交条件为：管理器存活并持有入口、Platform readiness、Agent Runtime、Camoufox 能力和 SearXNG 搜索健康。Firecrawl/Cognee 故障作为对应能力 degraded，除非目标版本的数据迁移声明把它列为必需项。

两个可写 Platform 实例不得同时打开同一 SQLite。候选镜像只能先运行无数据写入 preflight；实际数据库迁移和启动发生在维护门关闭、旧实例停止之后。

管理器在该写入门关闭后使用同一 Platform 镜像执行 `enterprise-agent-platform migrate --data /var/lib/ubitech-agent`。该命令只打开数据库、执行幂等 schema migration、输出已应用的最高 migration version 后退出；它不能启动 HTTP、Runtime、后台 worker、Gateway 或 bootstrap 用户。命令成功退出后管理器才可启动新 Platform writer。

## Agent Sandbox

每个私人 Agent 和频道主 Agent拥有独立 Sandbox 容器；委派子 Agent共享父容器和工作区。Sandbox 在第一次使用时创建，无任务且无后台进程达到机器契约规定的空闲时间后停止但不删除。

Sandbox 挂载 `/workspace`、`/home/agent` 和 `/opt/agent-env`。工作区、HOME 与专用环境落在数据根；平台升级可以重建容器而保留这些目录。管理器还把当前 scope 的附件目录只读挂载到 `/workspace/.ubitech/attachments`，不得把全局附件根暴露给 Sandbox。基础镜像变更只在该 Sandbox 无活动任务和进程时应用，容器 writable layer 与 apt 安装不属于持久数据。

同一 `sandbox_id` 首次登记的 `workspace_id` 不得重绑。管理器操作 Docker 前验证所有 bind root 均为数据目录内由部署用户持有的非符号链接目录；registry 原子写入失败时，必须撤销本次容器创建、启动或镜像替换并恢复原记录，不能留下未登记的运行容器。

Sandbox 容器创建时只让入口以 root 完成一次 UID/GID 映射与挂载根校验，随后 PID 1 立即降权为部署用户对应身份。入口不递归修改数据，也不提供 root 业务进程；管理器每次进入容器执行工具时显式传入相同 UID/GID。发布 smoke test 必须覆盖非 `1000:1000` 身份、无交互 sudo，以及固定 Compose 栈 `down`/重建时既有 Sandbox 和受管网络仍然存在。

## 首次从源码部署迁移

首次迁移采用两阶段自动切换：

1. 旧 Git 更新器正常拉取一次桥接版本并恢复服务；
2. `deploy.sh update` 使用本次更新实际生效的 source commit、data、service、host 与 port 重启桥接服务，并从 `container-<source-commit>` 不可变 release 下载同一提交的管理器与引导清单；不得把先前的 latest generation 当成本次桥接目标。桥接 HEAD 作为 `expected_source_commit` 同时持久写入 legacy migration plan、install operation 和所有排队重试；Manager 在保存 candidate、拉镜像或进入维护前必须验证清单 `source_commit` 完全相等，URL 名称本身不构成证明。这个精确 URL 只绑定首次迁移 operation，Manager 持久配置必须仍指向 `releases/latest/download/release.json` 的 main 通道，否则迁移后会永久停在引导提交。若该提交的管理器二进制或完整清单尚未发布，安装器把同时携带精确引导 URL、expected commit 与长期通道 URL 的重试程序复制到 Manager control 目录并用 owner-only user-systemd timer 排队，不能依赖后续再次出现 Git commit；
3. 桥接服务只在显式 source-migration 模式下读取 Manager control socket/token；Manager 迁移期通过旧回环 Platform URL完成空闲预约，切换成功后自动改用容器 Platform URL。control 与 executor API 共享同一个 owner-only Unix socket、使用不同 capability，因此该 socket 也属于首迁一致性比较字段；
4. 发布物就绪后后台预拉取镜像，再等待平台自然空闲；
5. Gateway 排空并把入口交给已安装在源码树之外的管理器；
6. 管理器停止旧服务和 Compose 栈、建立一致数据库快照并迁移数据；
7. 新容器完成 readiness、迁移文件清单与 hash 校验和管理器重启验证后提交 generation；当前提交门证明迁移输入字节未丢失，但不宣称已逐业务表核对 schema migration 前后行数；
8. 新 Manager 经旧二进制 watchdog 确认 control socket 与公网入口健康后，在 Platform 更新预约仍保持关闭的条件下生成并校验旧部署的完整恢复归档，再永久 disable 旧 user-systemd service，删除旧 Compose project、已复制的旧数据路径和 Git checkout并退役 live-data cache；这些结果全部持久化后才解除预约。残留的 disabled unit 文件进入归档且不再参与启动。

在上述流程开始等待空闲和停止旧服务之前，Manager preflight 还必须通过可等待且自动回收的 `systemd-run --user` oneshot `true` transient unit 验证用户会话具备启动独立 watchdog 的能力。这个探针不修改产品状态；无法创建、等待或收集 transient unit 时首迁必须终止并保持旧服务运行，不能等到 Manager 自更新阶段才发现 watchdog 不可用。由于 release 排队可能持续很久，Manager 在取得全局空闲预约后、切换维护和停止旧服务前，必须再次读取配置、核对首次预检绑定的关键配置指纹并重跑 transient-unit 探针；复检失败要释放预约且保持旧系统运行。

源码树内的默认数据移动到 XDG 数据根；明确配置在源码树外的数据原地复用。旧源码 checkout 与新数据目录不得在任一方向形成祖先/后代关系；旧数据根与新数据根也必须拒绝任一方向的重叠（两者规范化后完全相同的原地采用除外），避免 staging 递归复制自身或清理旧 checkout 时触碰新权威数据。清理前必须把旧 checkout、配置、systemd unit、Compose 元数据和不与新数据目录共享的外部 data 形成 operation 绑定的可恢复归档，并记录类型、mode、size、link target 与内容 hash 清单。位于同一文件系统且不再被运行路径引用的树优先原子 rename 到备份根；跨文件系统则 copy、fsync、逐项校验后才允许删除源。工作区、附件和 Profile 已由新数据目录权威持有时可以只在归档中保存经双方计数、总字节数和 hash 对账的迁移清单，避免第二份巨大副本。未知 ignored 文件纳入同一七天隔离归档，不能静默删除。归档和迁移清单至少保留七天，并提供将 checkout、配置、unit 与外部 data 恢复到原路径的验证流程。

新数据目录只按固定白名单退役旧宿主构建物：`runtimes/cognee/source`、`runtimes/firecrawl/source`、`runtimes/camofox/app`、`runtimes/camofox/browser`、`runtimes/camofox/browser.previous` 和 `runtimes/node`。这些路径在新 Manager watchdog 健康确认后原子移入同一七天 recovery pack 并写校验清单。迁移器不得用模糊名称或递归猜测扩展白名单；尤其不得移动 Camoufox 的 `profiles`、`cookies`、`traces`，Cognee/Firecrawl 的 index、数据库、session、配置、日志或任何用户工作区。

旧 Compose 清理只能操作迁移计划中显式记录且能够证明归属的 project 与容器 allowlist。桥接版本生成的 Firecrawl/SearXNG Compose 必须为全部服务补上产品 managed label；对桥接前已经存在且尚未被 Compose 重建的无标签容器，只能在 Compose project、service 名称同时命中固定 allowlist，且 `com.docker.compose.project.working_dir` 规范化后位于对应旧数据 runtime 目录内时视为等价的遗留归属证明。任一标签不可解析、路径越界或 service 未知都必须保留容器并让迁移停在 `cleanup_pending`，不能按 project 名单独删除。不能证明归属的 network 与 volume 只报告而不删除；任何清理失败都保留 `cleanup_pending` 并幂等重试，不能把错误仅写入报告后标记 committed。后台 retention 必须与 Configure、PreCutover、Cutover、FinalizeCleanup、Rollback 和 Restore 使用同一变更锁；它只能删除当前持久计划明确标记为 `committed`、`archive_ready`、超过保留期且重新通过 receipt 和逐树 hash 校验的 recovery pack。`cleanup_pending`、迁移中、校验失败或来源未知的 `*-legacy` 目录一律保留并报告，不能仅凭目录名和 mtime 删除。

迁移变更锁只负责串行化上述会修改持久计划、服务或文件系统的操作，不能被 Gateway 和控制面公开的 `Plan`、`Active` 等只读状态查询获取或等待。迁移服务每次成功原子落盘后必须在独立短锁下发布不可变的内存快照；读端返回快照的深拷贝，并且在首次读取时也只使用独立状态锁从原子状态文件初始化。这样即使首次复制、归档或回滚长期占用变更锁，维护页仍能快速看到最近一次已持久化状态，同时读写双方不得共享可变 slice 或产生数据竞争。

任何预检、复制、迁移或 readiness 失败都在清理旧目录前恢复旧源码服务；监听入口继续展示维护或安全恢复状态。切换旧 systemd 服务前先读取并持久记录原 `UnitFileState` 与 stop intent，再执行可逆的 `disable --now`，避免此后任一主机重启让旧 unit 抢占公网端口。命令返回后任何状态落盘失败都必须同步补偿：原 enabled unit 使用 `enable --now`，原 disabled unit 只恢复运行而不改变其启用语义。恢复看到 stop intent 时不能依赖可能尚未写入的 `old_service_stopped` 结果位，而要按持久的原状态保守恢复；只有新 Manager watchdog 已健康提交后，Commit 才确认永久 disabled。

数据复制使用同一文件系统内的 staging 目录。校验完成后必须先按自底向上顺序同步 staging 中的文件和每层目录，再持久化 `copy_prepared` 和文件清单。把 staging 原子 rename 为目标后，还必须成功同步目标父目录，最后才允许持久化 `copied`；任一同步失败都必须保持旧服务可恢复，不得在另一状态目录中先行承诺迁移已完成。回滚和重新武装迁移必须同时处理 `copy_prepared`、`copied`、staging 已存在以及 rename 已完成这几种组合，确认旧数据仍存在后幂等删除未提交目标，不能让断电留下的完整副本阻塞后续自动重试。

清理完成是不可逆提交点，此后只使用镜像和数据库快照回滚。

桥接版本在等待完整发布清单期间仍可用旧的源码进程运行。该兼容路径必须显式把 Runtime 设为 local executor，并使用宿主 workspace 绝对路径；它只用于迁移等待和开发测试，不能成为 Docker 生产拓扑的隐式回退。`UBITECH_SOURCE_MIGRATION_BRIDGE=1` 只能与绝对 Manager socket/token-file 路径同时启用，且不会把 Platform 切成 container execution。容器模式必须显式设置部署模式，缺少 Manager socket/token 或执行器时直接失败，不能静默切回宿主本地执行。

## 验证

部署完成至少验证管理器 health/readiness、登录、消息、Agent Sandbox、Runtime、搜索和浏览器。发布门必须覆盖空主机安装、旧数据迁移、跨文件系统复制、管理器进程终止、镜像启动失败、数据库迁移失败和旧 generation 回滚。
