# 安全与信任边界

本文是当前安全设计的规范说明。历史检查记录位于 `../audits/`，不替代本文。执行细节见 [Agent Runtime](agent-runtime.md)，部署要求见[部署](../operations/deployment.md)。

## 信任模型

平台面向彼此可信的内部成员，不试图在同一部署中抵抗恶意租户。每个私人 Agent 和频道主 Agent拥有独立 Sandbox、workspace、HOME、session、memory 与浏览器 Profile；memory 的 `memory` 与 `user` target 都受同一 Agent scope 隔离，不能作为跨 Agent 共享层，公共资料必须进入知识库。委派子 Agent继承父 Sandbox。该隔离减少环境互相污染和误操作，不是针对恶意用户、恶意模型或提示词注入的安全边界。

默认工具在 Sandbox 执行并免人工审批，但仍受不可绕过的 hard-block。模型可以为单次 terminal、文件或进程调用显式选择宿主目标；任何 `target=host` 调用都必须由用户逐次批准，不能形成会话或永久授权。管理器随后才以部署用户执行；terminal 还允许使用该用户已有的免密 `sudo`。这等同把该次操作授予部署用户乃至 root 能力。部署方必须只给可信成员使用，并把部署用户、宿主文件和网络权限控制在可接受范围。

## 认证与权限

密码使用 PBKDF2-SHA256 和随机盐。登录失败按客户端与账号限流，并使用固定 dummy hash 降低用户名时序泄漏。用户停用、改密、权限变化或显式吊销会推进 token version，使旧会话失效。

浏览器会话由 HMAC 签名 token 承载。Cookie 使用 `HttpOnly` 和 `SameSite=Lax`。开启 Manager 可信代理边界时，`Secure` 必须以 Manager 清洗并重建的当前请求 scheme 为准：HTTPS 请求增加 `Secure`，明文 LAN HTTP 请求不增加，不能因全局公网 URL 为 HTTPS 而使 LAN 会话无法登录。未开启可信代理时必须忽略客户端伪造的 `Forwarded`/`X-Forwarded-*`，并以公共 URL scheme 作为本地直连的安全回退。携带 Cookie 的写请求必须提供允许的 Origin 或 Referer。

权限必须在 Python 服务端检查。前端路由、隐藏按钮和角色标签不是授权边界。Platform、Runtime 与 Manager 的内部接口分别使用独立 bearer 或 owner-only Unix socket；浏览器 session 不能替代内部身份。

频道消息撤回是登录用户的受限写操作。Platform 必须在同一频道消息锁内重新读取当前活动账号和权限，并同时验证频道可读、仍有聊天权限、消息仍可见、消息类型为用户以及 `user_id` 与当前账号精确相等；管理员身份不绕过本人所有权，代删继续使用独立的管理审计接口。客户端提供的消息作者、scope 或可见按钮都不能替代这些检查。

## 容器与网络边界

只有宿主管理器访问 Docker socket。Platform、Runtime、Sandbox、Camoufox、SearXNG 和 Firecrawl 都不得挂载或代理 Docker socket。固定服务与 Sandbox 位于管理器预创建并持有的持久私有 bridge 网络；Compose generation 只引用该 external network，不创建或删除它，因此固定栈切换不能中断仍在运行的 Sandbox。管理器只接管带产品 managed label 且 driver 符合契约的网络；同名但来源或配置不明的网络必须拒绝而不是覆盖。只有 Platform backend 被管理器发布到宿主回环，sidecar 不发布公网端口。

当前 release 的闭世界镜像目录只有 canonical 容器契约中的十个现役镜像，不包含迁移 helper。Manager、Platform、Runtime、用户和模型均没有通过历史路径或摘要创建额外数据面的入口。

Sandbox 镜像只允许 PID 1 entrypoint 在启动映射阶段短暂以 root 运行。它必须验证管理器传入的正整数 UID/GID、拒绝与其它镜像账号冲突的 UID、验证 `/workspace`、`/home/agent` 与 `/opt/agent-env` 都是非符号链接目录，并且只调整这三个挂载根本身的所有权和模式；不得递归 `chown`、跟随符号链接或修改只读附件。验证完成后必须以映射后的 `agent` UID/GID `exec` 业务命令，不能保留 root shell 或 root 业务进程。管理器对该容器的每次 `docker exec` 也必须显式指定同一 UID/GID，不能依赖容器创建时的 root entrypoint 身份。

Runtime 和 Platform 的所有内部 HTTP 接口，包括健康检查，都需要 token。管理器容器控制 socket 位于独立的 owner-only `control/` 目录；Runtime/Platform 只读挂载该目录而不是单个 socket inode 或整个 Manager 状态根，使 Manager 原子重建 socket 后容器能看到新 inode，同时不能读取 journal、release 和其它 secret。管理器在单一 Unix socket 上同时校验同 UID peer credential 与严格的 `Authorization: Bearer <token>`，并按 capability 分离身份：`manager-token` 只允许 Platform、宿主 CLI 与 Manager 回调访问状态、配置、日志、迁移和变更 operation；独立的 `manager-executor-token` 只允许 Runtime 访问 `/v1/executor/*`。两枚 token 不得互相授权，Platform 不挂载 executor token，Runtime 不挂载 control token；知道 socket 路径、容器名称、网络地址或 scope key 均不能替代 capability 与主 Agent sandbox identity。

Manager 启动必须重新验证 `control/`、`secrets/` 及两枚 token 的真实宿主对象。目录必须由部署 UID 拥有、是非符号链接目录并收紧为 `0700`；token 必须由部署 UID 拥有、是非符号链接普通文件并收紧为 `0600`。任何 owner、类型或符号链接异常都必须拒绝启动，不能通过 `ReadFile` 或 `MkdirAll` 跟随既有路径继续运行。只读 bind mount 与 `SO_PEERCRED` 是外层纵深防护，不能代替按路由的 token capability。

搜索结果和 Firecrawl 提取 URL 只允许公开 HTTP(S)，拒绝内嵌凭据、回环、私网、链路本地地址、云元数据及敏感查询参数；搜索结果轻量过滤不能替代提取前的 DNS 感知 SSRF 校验。

浏览器按可信成员模型允许正常访问回环与内网 HTTP(S)，但拒绝内嵌凭据、云元数据、链路本地、多播、保留和不可路由目标，并在操作前后重新校验。部署方必须把“Agent 可浏览内网”纳入网络信任边界。

自动更新 webhook 使用签名；Telegram webhook 使用不可猜 secret path。运维必须在边界代理覆盖客户端提供的转发头。

## 工具执行与审计

所有 terminal、process 和文件调用先执行确定性的 hard-block、参数/正文上限、canonical 路径校验和凭据脱敏，再进入执行器。hard-block 不可被目标、历史记录或模型参数覆盖。至少拒绝：

- Docker socket、管理器控制/状态目录和其它容器编排入口；
- 云元数据、进程凭据/内存、原始块设备和危险系统伪文件；
- 文件系统格式化、删除系统根或核心系统目录、fork bomb 与无边界 kill-all；
- 会改变或隐藏展示字节的双向/不可见控制字符；
- 超过完整可展示上限、因而无法让用户理解真实作用的命令。

`target=sandbox` 是默认值，在主 Agent 独立容器内执行。路径以 `/workspace` 为默认 cwd，只允许映射到该 Agent 的 workspace、HOME 和 env；后台进程登记在 Sandbox，决定其空闲生命周期。

Agent 回复中的 `MEDIA: /workspace/<relative-path>` 只是一条待校验的逻辑交付声明。Platform 必须从当前服务端 scope 取得权威 `workspace_path`，仅把精确 `/workspace` 后代映射到该根，再从根目录 fd 逐段使用 `O_DIRECTORY | O_NOFOLLOW` 固定父目录，并以 `O_NOFOLLOW` 打开普通、单链接文件；大小复核和读取都使用同一个文件 fd，路径或叶节点在检查期间被替换时失败关闭。模型文本、owner id 推测、其它 scope 路径、`..` 穿越、符号链接和中央容器中偶然存在的 `/workspace` 都不能获得读取权限。Runtime 在内部复验间保存标记只保留完整一行、具受支持后缀且不含穿越或控制字符的规范路径文本，不授予文件权限，也不能把临时回复的尾随说明带入终态输出。

`target=host` 必须由模型在当前 terminal、文件或进程调用中显式选择，并逐次弹出用户审批；只允许 `once` 或 `deny`，不形成 session/always 授权。未批准、超时或通知失败时不得先调用 Manager。批准后管理器在执行前持久化并向聊天发送审计事件；terminal 展示完整实际命令参数、canonical cwd、前后台方式和有效超时，文件与进程工具展示 canonical 目标及完整操作参数。执行后记录结果与副作用。日志可脱敏 secret，但不能隐去影响语义的普通参数。浏览器、Skill、计划等独立业务审批不因命令策略变化而自动取消。邮件发送、回复、移动、标记和保存附件同样逐次审批，审批记录隐藏正文与凭据；邮件唤醒的 unattended Run 无条件拒绝这些动作。

工具审计序列化不得复用于模型历史。模型可见的 tool call 必须保留活动 schema 的原始结构，脱敏占位符仍须符合字段约束；只有工具名精确匹配且仅含既知字段的历史展示 envelope 可以在内存中收敛。工具名不匹配、调用者身份字段或其它未知字段一律失败关闭，不能以兼容为由删除后继续执行。

命令中的 token、Cookie、Authorization、URL userinfo、常见 secret 变量和值必须在离开执行器前脱敏。统一脱敏器覆盖常见客户端的紧凑、等号和分离参数形式；无法安全解析嵌套 shell 求值中的 secret 时直接拒绝。原始 secret 只留在当前执行闭包，不能进入事件 journal、session、预览或错误文本。

终端预览和 `process.list/read/stop` 快照复用同一脱敏器后再裁剪。取消和 scope cleanup 尽力终止前台进程；一旦 Manager 报告终止已确认，就必须同时证明对应进程控制器的输出快照、持久登记和 Sandbox 活动计数已经收敛，不能让旧 goroutine 在授权边界返回后继续写 scope 状态。Sandbox 后台进程可跨 Run 保留，但必须有登记、输出上限和管理员可见状态。Sandbox 停止会终止其容器进程，持久挂载数据保留。

## 管理器与更新

Manager control socket、配置、release manifest、operation journal 和 registry 凭据必须 owner-only。所有 install/update/restart/rollback/repair operation 带 idempotency key、期望 generation 和持久阶段；Manager 先核对 key 对应的不可变请求指纹，再判断 generation，使丢失响应后的原样重放只能观察原 operation，不能启动第二个变更或用同 key 替换请求。control 服务端先完整编码再提交成功状态，mutation 只返回有界确认；客户端把空、截断、超限或非法的 2xx 响应视为结果不确定并以原幂等身份对账，不能伪造成功或当作确定失败。外部错误正文属于不可信诊断数据：写入 state、operation 或 activation journal 前必须限制大小，重试只替换“最近一次失败”片段而不能递归拼接上一份完整错误；control API 也只返回有界诊断投影，不能让历史错误耗尽本地控制通道预算。候选 Platform readiness 失败时，Manager 在删除容器前先读取 healthcheck 再读取有界日志；两类内容必须先替换精确 Manager capability 和通用凭据模式、再截断并写入 operation，采集失败本身只能成为有界诊断，不能阻止回滚。

发布清单锁定 source commit、数据库版本、Manager 校验和与镜像 digest。Manager 不运行清单中的任意 shell，不接受 mutable tag 作为运行身份。更新先预拉取、等待业务空闲、原子关闭准入和进入维护；current Platform 停止后才能迁移 SQLite。任何时刻只允许一个可写 Platform writer。

Platform 在构造任何 SQLite 连接、worker 或外部副作用组件前，必须从逐段 no-follow 打开并保留的 target 数据根目录 fd 取得 `.agent-platform.lock` 实例锁。锁叶节只能是当前 Platform UID 拥有、单硬链接、`0600` 的普通文件，并以 `openat(O_CREAT | O_EXCL/O_RDWR | O_NOFOLLOW | O_CLOEXEC)` 安全创建或打开。只允许在 owner、类型、link count 和已打开 inode 都验明后通过 fd 收紧既有安全文件权限；符号链接、硬链接、owner/type 异常不得修复。取得非阻塞独占 flock 后、写入 PID 前后都要复核锁 fd、固定父目录项与当前规范数据根仍指向同一 inode；任一路径置换都释放锁并失败关闭。锁文件不在关闭时 unlink，锁 fd 与父目录 fd 贯穿 Platform 生命周期。

现役 Manager 的二进制、unit、配置/数据根、control 与 Gateway 路径、Compose/network、环境变量、ownership label、Sandbox、watchdog 和内部工作目录都来自唯一编译期 target profile；管理员品牌不能修改它们。当前 manifest、CLI、环境变量、目录或 Docker 对象都不能选择另一套 profile，也不存在第二套迁移描述符。release 和工件地址只允许 HTTPS 或精确 `127.0.0.1`/`::1` 回环 HTTP；每次重定向重新验证，策略拒绝属于确定性失败而非可重试网络故障。

当前 target-only Manager 的宿主入口先用闭合静态命令表解析完整 argv；未知命令、未知参数、重复 locator、相对或非规范路径必须在读取配置、state、secret 或 journal 前拒绝。默认 config 与 stable Manager 路径只从当前 UID 在操作系统账户数据库中的唯一 home 记录派生，忽略 ambient `HOME`、`XDG_CONFIG_HOME`、`XDG_BIN_HOME` 和 `XDG_DATA_HOME`；显式 config 也必须是规范绝对、当前 UID 控制、非符号链接的普通文件。启动只打开一次配置并绑定同一 inode 与字节快照，解析结果、RuntimePaths、单实例所有权、watchdog 和 application 构造都复用该绑定；运行中的 `/proc/self/exe`、stable 文件 inode 与已登记摘要不一致时失败关闭，不能按路径重开、basename 或环境重新推断身份。

### 更新与恢复

更新预拉取只把 Platform 与 Agent Runtime 作为切换前核心镜像。Manager 先用本地精确 RepoDigest 判断是否已经存在，不能为本地命中无条件访问 registry；缺失镜像的命令输出只用于刷新内存中的空闲期限，原始 registry 输出不得写入 operation、公共状态或长期日志。无进展和绝对超时都在 maintenance 前结束为可重试失败。Camoufox、SearXNG、Firecrawl 与 Sandbox 镜像由各自受限路径拉取，第三方 registry 故障不能扩展核心更新的信任或锁边界。

Manager 只接受当前 schema 2 target-only manifest，并对 canonical 十镜像目录执行精确闭世界校验。缺失、重复逻辑身份、额外镜像、已退役迁移镜像或描述符、profile 错配都会使整份 manifest 无效；不存在按历史 generation、摘要、本地路径或旧 schema 启用的专用解码器。已经退出当前 Compose 的服务不能因 journal、manifest 键或 Docker 残留重新进入运行边界。

Manager 的预约从首次 Platform reserve 到持久 `maintenance=true`、再用同一 operation id 确认 reserve 后才可执行破坏性操作。响应不确定时只有明确 release 才能回到非维护状态；Manager 不可达或预约身份不一致时所有管理写操作 fail closed。Platform 启动任何有副作用 worker 前必须恢复同一持久预约状态。当前普通 operation 不采集迁移前库存或历史交接证据，也不因旧工件扩大遍历、读取或写入范围。

快照完整验证、候选 generation 核心 readiness、Manager watchdog 提交和 reservation release 完成前不能开放业务。reservation 的 `commit-release` 与 `abort-release` 是两个独立认证能力，并使用限大、拒绝重复/未知字段/尾随值的闭世界 JSON：前者只在普通更新 watchdog 已耐久提交后调用；后者只恢复准入，失败、取消、restart、repair 和 rollback 都不得获得 schema commit 能力。Gate 已成功但 finalized operation 与 pending state 尚未原子收敛时，恢复必须在清 state 前重放同一种幂等 Gate 结算，不得重复 SelfUpdate。Manager 只可从同一锁内的 state/finalize operation 快照投影显式 `gate_settlement`；字段缺失、损坏或错位都失败关闭，不能凭 Current、maintenance 或历史 journal 片段猜测。普通 operation 的首次 Gate action 必须与 `Finalized=true` 同次写入；install/update 只有 watchdog 已确认 candidate Manager 才能记录 commit，无 SelfUpdate 模式记录实际 abort，非 generation operation 不能记录 commit。候选验证保持纯读；workspace、marker、Runtime alias 与 Camoufox sidecar 必须从启动起已经符合 current schema，未物化、旧格式、缺失或身份漂移都失败，普通更新没有修复能力。核心 readiness 只包含 Manager 控制面、Platform 与 Agent Runtime；能力服务失败保持 degraded。Manager 自更新 activation/watchdog 仍是唯一持久安全所有者；Docker 清理只处理精确 ownership/project/resource label 且无消费者的对象，禁止全局 prune。Manager `/v1/status` 不投影 manifest、快照或其它宿主绝对路径。

用于验证上述状态机的包内单元测试可通过私有、不序列化的时间注入加速 fake systemd/control 观测，但不得减少连续身份检查、重试、错误重置或 commit/rollback 断言。该注入不进入配置、环境、plan 或 control API；生产路径与真实 systemd 门禁始终使用默认时序。

当前基线的普通 activation plan 必须原生包含 `candidate_path` 与 `platform_commit`，并在启动确认、watchdog 回滚、外部恢复接管和终态收敛边界与已验证且已提交的 Candidate、Activation 和 Platform generation 精确匹配。任一字段缺失、部分绑定、身份漂移或文件篡改都必须失败关闭；不得根据 Current、Candidate、manifest 或路径规则推断或补写身份字段。即使 takeover 已经终结，事后同时删除这两个字段也仍是身份篡改，不能因 journal 已为 `committed` 或 `rolled_back` 而降级为可接受的历史格式。接管 journal、watchdog、回滚和 recovery activation 必须持续保留原始 plan 字节哈希和完整身份链作为证据。

recovery takeover journal 一旦持久化就是启动安全边界，即使主 unit 尚未被禁用也不得绕过。Manager serve 在任何会写宿主状态的 application 构造、activation acknowledgement、recovery loop 或 listener 创建前，必须以非阻塞方式协调全局 recovery flock 并安全枚举 owner-only、非符号链接的 `recoveries/`。未知或不安全工件、损坏 journal、多个非终态事务或任何配置/身份绑定漂移都必须在零副作用下拒绝启动。空闲全局锁必须作为 lease 保留到 listener 已建立且 pending activation 已结算，不能在检查后释放再执行副作用。`watchdog_owned` 之前的事务只属于外部恢复；从该阶段起只允许 journal、recovery plan、Manager state、stable 和 `/proc/self/exe` 精确证明同一 transaction 的 recovery Candidate执行完整 acknowledgement，主机重启后的空闲锁 Candidate 与外部仍持锁的 watchdog-owned Candidate 使用同一身份规则。完整验证的终态 journal 可作为历史审计证据，不能永久依赖已按策略清理的旧 version、operation 或 manifest。

终态 recovery 只有在 manifest source commit 与当前架构 Manager 完整 SHA-256 唯一确定 journal，且 transaction、受管路径、manifest/operation 原始摘要、原 Candidate、superseded 普通 plan 和 committed recovery plan 全部双向闭合时，才能只读充当 Platform finalize 证明。后继 recovery 还必须证明 Current、stable、运行 inode、metadata 一致且 Previous 精确等于该 journal 提交的 recovery Current；校验不得改写历史证据。只有同一未结算 finalize 满足这些条件时才可接力替换健康 Current，其余健康 Current 在停止服务前一律拒绝。

接力替换的 pre-commit 窗口不得因 stable 已先于 state 原子替换而扩大权限：只有外部 recovery lock 忙、旧 state 完整匹配 committed journal，且新 stable、运行 inode与受管 recovery 工件及 metadata 四者同 SHA/版本时，进程才可进入 identity-only probe。锁空闲、rolled-back journal 或任一身份缺口都失败关闭；probe 不得开放 status、executor、operation、gateway 或后台任务。

Manager serve 的更外层单实例边界是 Manager binary root 中的 owner-only `serve.lock`。它在 application 构造前用 `O_NOFOLLOW | O_CLOEXEC` 打开、校验当前 UID/普通文件/严格权限并以非阻塞独占 flock 取得，随后贯穿 control server、gateway、后台恢复和子进程管理的完整生命周期；第二个 serve 不得因 recovery lock 碰巧繁忙而降级为 recovery probe。全新 binary root 只能由该门安全创建为当前 UID 的非符号链接 `0700` 目录；既有 state root 仅在已证明同 UID、无符号链接且不可被其它身份写入后才可收紧为 `0700`，owner/type/path 异常始终失败关闭。锁序固定为 `serve.lock → recovery.lock → plan lock`，外部 `recover-current` 本身不取 serve lock，从而可停止旧 owner 后让 recovery Manager 在外部 recovery lock 仍持有时启动身份探针。

全局 flock 已被外部恢复持有但不存在非终态 journal 时，精确匹配 stable 的登记 Current 或受管 recovery 工件只能获得 `external_recovery_probe` 权限：进程只开放 owner 认证的身份端点，所有 executor、operation、status、gateway、恢复和后台能力保持关闭；外部锁释放后必须重新取得 lease，并证明运行 inode 已成为原子登记的无 Candidate/Activation Current，未登记 recovery 必须退出。journal mutation flock 同样不得等待，只能在外部全局锁仍在时用稳定的双快照处理短暂竞争。无 journal 的普通 Candidate-only 只接受当前 Platform state、唯一 live install/update、不可变 manifest 和非终态 plan 可证明的本代 Prepare/Mark checkpoint；ownerless 或终态 Candidate 一律拒绝。普通 rollback 的 plan-first 和 commit 的 state-first 半 checkpoint也只能按当前协议的完整反向绑定补齐，不能据路径或单一 SHA 推断所有权。

Unix control socket 路径不是可抢占锁。绑定方必须先在同一已验证 control 目录中取得 `<socket>.lock` 的 durable owner-only 非阻塞 flock；锁通过目录 fd 与 `openat(O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600)` 打开，路径/fd inode 必须一致，且只能是当前 UID、严格权限、`nlink=1` 的普通文件。该锁从 probe 前持有至 listener 自身路径 unlink、监听 fd close 完成，随后才释放；文件本身保留供崩溃后复用。不同 Manager root 共享同一 socket 路径时仍由该锁串行，不能各自用 root 级 serve lock 绕开。锁繁忙或 symlink、hardlink、宽权限、owner/type/inode 异常均失败关闭。

持有 bind lock 后发现既有同 UID socket 时必须做有界连接：成功即证明 live owner，超时、权限和其它模糊错误都失败关闭；只有明确 `ECONNREFUSED` 才可进入 stale 删除，并在 unlink 前用 device/inode/type/uid 完整复核抵御路径交换。listener teardown 只能删除自身绑定的 inode，旧进程不得在关闭后按路径删除继任者。pending Candidate 在 watchdog 原子提交以前只通过不可变 identity-only handler 响应 control capability 认证的 `/v1/identity`；status、executor 和所有 mutation 必须拒绝，提交成功后才以原子指针切换到完整 API。普通 rollback 半 checkpoint 对 Candidate 的 version/source/SHA/verified/platform-commit、精确受管 binary path 和精确 activation plan path 逐项验证，不能让格式无效但 hash 可读的工件获得终态补写权限。

崩溃后的原子写入临时文件不能被当作未知 journal 永久锁死启动，但也不能仅凭 `.tmp-` 前缀扩大删除权限。Manager 只对原子写入器自身产生的精确安全名称执行 fd-rooted 单文件 unlink：父目录与文件的路径视图和已打开 inode 必须一致，owner 必须是当前 UID，对象必须是 `nlink=1` 的非符号链接普通文件。目录、FIFO、socket、device、硬链接、owner 异常、并发替换或任何持久引用均保留并报错。受管根只能从已验证的 Manager 配置和固定子目录派生，不能把 state/journal 中的路径字符串直接升格为删除权限；根外 Version 路径必须在任何清理副作用前失败。无独占 writer 证明时还必须等待统一宽限；只有能证明覆盖该目录全部 writer 的单实例启动门或域锁才可立即删除，全局 recovery flock 不能被误当作对不取该锁的 watchdog writer 也有排他性。启动只扫描随后严格验证的 operation、recovery 和已引用 version 目录；无关新鲜工件留给宽限后维护，不因清理扩大启动拒绝面。持久身份验证仍拒绝 `.tmp-*` 引用，这一清理特例不能用于容忍缺失、损坏或未知的正式工件。

## 文件与附件

数据根、workspace、Runtime 根和 Agent env 必须由部署用户拥有、不是符号链接，并收紧权限。workspace 路径的每个组成部分都要重新检查符号链接。数据库只保存相对 workspace 标识，不能写入宿主绝对路径。

跨 staging 与 workspace 父目录发布私有目录时，首次 rename 和 exact-final 崩溃重放必须使用同一耐久屏障：依次 `fsync` 已固定 child fd、staging/source parent 和 destination parent，即使 staging 名已消失或 exact 空 residue 已清理也不能省略。任一步失败只能在 final 仍是预期 inode，且本次 missing→rename 或已建立的空目录恢复身份仍为空时分类为 committed-but-not-durable；重试必须再走完整屏障。若在 rename 后的检查或 `fsync` 窗口出现内容、类型、权限或 inode 漂移，不得宣称已提交，不得删除证据或继续提交数据库状态。

上传文件有数量、单文件、总量、账号配额和全局配额；名称和 MIME 在服务端规范化。上传没有固定墙钟超时，但连续没有收到字节达到上传 socket 空闲上限、断线、取消、更新切换或大小越界仍会终止传输；持续前进的慢速上传不会因普通总耗时被中断，界面只展示浏览器已实际发送的字节进度。Multipart 读取期间只写 owner-only staging，不占用可无限延长的更新写准入；只有完整读取后的附件验证、权威复制、消息和 durable job 提交占用短准入。若更新先预约，旧请求可以中断并清除 staging，不能通过慢滴流永久阻止版本收敛。Platform 为上传使用独立的有界并发预算，超过预算时明确拒绝新上传，不能让大文件占满普通请求工作线程。

Multipart 正文必须增量读取并先写入 Platform 数据根内 owner-only 的请求 staging 目录；解析过程只保留边界探测所需的小型缓冲区，不得把完整请求或附件复制到内存。服务端完成数量、大小、配额、文件类型和摘要校验后再把 staging 文件流式提交到附件目录；请求成功、失败、取消或超时后都必须清理 staging。只有允许的位图格式可以内联给模型；其余附件通过当前 scope 的只读 Sandbox 挂载访问，路径固定为 `/workspace/.agent-platform/attachments`。Platform 不得把自己的数据路径写进普通 Run metadata；唯一例外是由可信配置派生、只进入当前 scope 系统提示的宿主工作区映射。Manager 不得把其它 scope 或全局附件根挂入 Sandbox。Agent 生成附件只能从当前 workspace、平台管理的媒体目录和显式媒体根返回，并在解析真实路径后再次校验。

XLSX 消息预览复用附件读取权限，不提供匿名或跨 scope 入口。Platform 对空 MIME 和 `application/octet-stream` 使用内置、确定性的允许后缀映射，不能依赖基础镜像是否安装 `/etc/mime.types`；该规范化只赋予候选解析器，不能替代内容验证，也不能覆盖调用方明确声明的其它非通用媒体类型。服务端在解析前同时校验规范扩展名、媒体类型、ZIP/Office 容器身份、加密标志、条目路径、条目数、单项大小和累计展开大小；解析仅提取有界工作表、行列、单元格和字符串，公式作为惰性文本展示，不计算、不跟随外部关系、不加载宏或嵌入对象。响应只含纯文本单元格和截断元数据，并设置私有、禁止嗅探的 JSON 头。解析失败返回有界通用错误，原件下载继续可用。

邮件附件保存不能使用“父目录 `lstat` 后再按完整路径 `open`”的检查/使用分离流程。Platform 必须固定可信 scope 的 workspace 根 fd，逐段相对父 fd 使用 `O_DIRECTORY | O_NOFOLLOW` 打开目录；缺失目录以 `mkdirat` 创建后重新打开并校验类型与部署用户 owner。最终文件相对固定父 fd 使用 `O_CREAT | O_EXCL | O_NOFOLLOW` 创建，随后用 fd 校验普通文件类型与 owner、收紧为 `0600` 并持久化。任何符号链接、特殊文件、owner 异常或并发路径替换都必须 fail closed，且失败清理只能针对同一固定父目录中由本次调用创建的 inode。

Manager 的 Sandbox 文件工具从已固定的挂载根目录 fd 逐级处理不可信路径。目录枚举只能从该 fd 读取名称，不能根据 `os.File` 的逻辑显示名重新解析宿主路径；每个名称随后以 `O_NOFOLLOW` 和非阻塞模式相对父目录 fd 打开，并以 fd 元数据决定是否读取或递归。符号链接不得跟随，FIFO、设备、socket 与其它特殊文件不得读取；附件覆盖层必须先于普通 workspace 映射并保持只读。该路径必须在 Manager 声明的最低 Go 版本与当前受支持版本上保持相同行为。

同一 fd-rooted 契约也适用于 `target=host`。Manager 先把批准中绑定的逻辑路径映射为宿主根和相对路径，拒绝 Docker socket、当前 Manager 状态根、标准 Manager 配置/运行目录及按操作类型禁止的宿主路径；随后从可信根逐段使用 `O_NOFOLLOW` 打开。host 搜索从固定目录 fd 枚举并跳过其下受保护子树，不能因为搜索根是其祖先而读取 Manager secret。host patch 必须在同一个固定父目录 fd 内完成读取、临时文件写入和原子替换；host terminal cwd 必须固定目录 fd，并让子进程从该 fd 切换目录。路径审批、一次性执行收据、Sandbox identity 和这次可信映射共同绑定一次执行；检查与实际文件操作之间不得重新解析可被替换的路径字符串。

## 凭据与敏感数据

OAuth refresh token、邮箱应用密码、session secret、内部 token 和其它 secret 保存在 Platform SQLite 的专用凭据表或 `settings` 表，并只返回“已配置”状态；数据目录和数据库文件依靠宿主权限保护。当前没有应用层静态加密，文档和界面不得宣称“加密存储”。

Sylver Lining 工作平台的 Personal API Token 使用每用户专用凭据行，并只接受可安全放入 Bearer header 的非空可见 ASCII。出站 origin 固定为代码锁定的官方 HTTPS 地址，产品请求、用户、模型和数据库内容均不能覆盖；候选 Token 必须先完成 `/api/auth/me` 验证再保存，验证失败不得覆盖既有连接。连接、重连和断开按本地用户从入口起串行，消除慢验证覆盖较新决定的竞态。模型、Runtime、Sandbox、工具参数、审批展示、事件和错误均不得取得 Token。远端 JSON 在离开连接器前递归清除敏感字段值和当前 Token 的任何精确回显；身份响应出现 Token 回显时必须拒绝整次验证，不能存储脱敏后的伪身份。连接器拒绝由模型指定 HTTP path/header，拒绝携凭据重定向，并对未知或未分类业务动作失败关闭。外部写动作先按原始完整审批参数计算 UTF-8 上限并拒绝不可见控制字符，只有通过后才生成完整、脱敏的短正文展示；不能让脱敏或控制字符移除把超限正文压缩后绕过限制。写请求发出后的不确定结果必须显式要求读取远端状态，不能诱导盲目重放。审批决定、跳过审查、员工管理、原始 REST 和破坏性删除不因持有远端 Token 获得工具入口。

知识 Embeddings API key 同样属于 Platform secret：管理接口只接受写入或保留既有值，读取只返回是否已配置和有界掩码，不能回传原文。配置提交前必须对目标 provider 做最小探测；请求禁止携带凭据重定向，并限制 URL、响应体、超时、向量数量、顺序、数值和维度。缺少 key 时知识创建、重建和显式检索以 `knowledge_embedding_unconfigured` 失败关闭，不启动本地模型、不回退关键词检索；聊天启动时的被动知识召回则失败开放，只记录 disabled/degraded，不能因此阻断普通回复。

OAuth token 不得写入 Runtime session、Run metadata、工具事件或错误。每个 OAuth provider 的账号目录只能与 Runtime 从锁定 Pi 元数据得到的 provider、API、endpoint 和模型能力目录求交；供应商返回的未知模型不能因为排序更高而直接获得执行权限，Runtime 已知但账号目录未返回的模型也不能取得 Token。推荐默认来自交集后的账号顺序，不能通过硬编码旧模型、退役名单或直接采用未校验 ID 绕过这条边界。内部凭据请求必须绑定具体 provider、模型和 scope，并在返回 Token 前用当前账号目录复验。容器只获得其运行所需 secret；Sandbox 不继承 Platform、Manager、registry 或宿主环境的 secret。所有子进程从最小环境开始构造，不能整体透传服务环境。

## 品牌输入与公开读取

品牌配置只允许管理员写入，并以单调 revision 防止并发管理请求覆盖较新的值。公开读取端点无需登录，但只能返回产品名、Agent 名、规范主色、同源 Logo URL 和 revision；不得借此暴露通用 `settings`、更新时间、管理员身份、文件路径或 secret。产品名和 Agent 名必须拒绝控制字符、Unicode 行/段分隔符并限制长度；进入 Agent 系统提示时作为闭合结构化数据而不是可执行指令。

品牌 Logo 只接受经过服务端完整解码、声明 MIME 和尺寸复核的有界 PNG 或 WebP。完整 Pillow 解码只允许发生在管理员 `PUT` 的写入路径，并且必须在持久化之前完成；读取请求正文、打开解码器和解码完成后都必须复核 `256 KiB`、单边 `4096` 像素和总计 `16,777,216` 像素上限。容器头、尺寸字段或图片库的惰性 `open` 成功都不能替代写入时的完整像素解码。每个文件必须恰好包含一张可解码位图：拒绝 SVG、远程 URL、截断数据、header-only WebP、无 IDAT 的 PNG、动画/多帧、重复图像 bitstream、格式与声明不符、尾随数据、零尺寸和任一超限。

匿名公开 Logo `GET` 只能读取已经验证并持久化的内容，不得再次打开图片解码器或调用像素 `load`。读取路径只执行严格 base64 解码、`1..256 KiB` 大小校验，以及正文大小和 SHA-256 与已规范化 metadata 的一致性校验；发现存储损坏返回服务端错误。响应使用 metadata 白名单 MIME、`nosniff`、ETag 和公开缓存语义。Logo 与配置 revision 在同一 SQLite 写事务内提交，读取到的公开快照不能把旧 Logo 内容与新 revision 混合。

## 不可信内容与提示词注入

用户显示名、职位、频道名、网页、浏览器、邮件正文与头部、知识、记忆、历史 session、计划结果和 Skill 附件都作为不可信数据。Runtime 使用防伪、闭合的结构化边界包装工具结果，中和载荷伪造的边界 token；短文本、错误文本和历史数据不能豁免。邮件唤醒是 unattended Run，只允许读取和汇报，不得把邮件内容当成发送、移动、删除或宿主执行授权。

知识上传文件是不可信输入。文件名必须规范化并只用于展示/下载头，不能成为宿主路径；媒体类型不能单独决定解析器。ZIP 容器在解压前检查闭合格式身份、条目数、路径、加密标志和累计展开大小，拒绝绝对路径、`..`、符号链接式条目与压缩炸弹。文档解析不执行宏、公式、脚本、外链或嵌入对象；PDF/Office/OpenDocument 解析异常只返回有界通用错误，不能把原始载荷、内部路径或解析器诊断注入日志和模型上下文。原件下载始终使用 `attachment` disposition、`nosniff` 与同源鉴权，不能以内联 HTML/SVG/Office 内容响应。

## 浏览器接管与局域网

浏览器人工接管使用当前 scope/tab 的短期租约。服务端从登录身份重新派生 scope 与 Camoufox user identity，客户端不能提供 user id、selector、脚本或任意内部 URL；只接受限幅后的鼠标、滚动、文本和按键动作。同一 root scope 的租约取得/释放、人工输入与 Agent 变更型动作共享串行操作门，互斥范围覆盖真实 Camoufox 调用，不能留下“Agent 已检查无租约、人工随后取得租约、两者同时修改页面”的窗口。租约期间 Agent 的变更型浏览器工具返回可重试冲突。发送会触发 Agent 的新消息时，前端先等待本地接管队列收敛，Platform 再在同一操作门内、入队前只撤销发送者本人持有的对应 root scope 租约；不能撤销其他用户租约，也不能让不触发 Agent 的普通频道消息取得该能力。结束、失焦、页面隐藏、过期、tab 变化、409 冲突或 tab 关闭后客户端立即降为只读并尽力释放，服务端到期与 scope cleanup 负责最终回收。共享 X display 不能直接暴露为 noVNC/VNC，因为那会跨 scope 泄露页面。

局域网入口默认关闭，只能绑定明确的私网或回环 IP，拒绝通配和公网 IP。启用时 Manager 以真实 `RemoteAddr` 和显式 CIDR 判断准入，丢弃非可信来源携带的 `Forwarded`/`X-Forwarded-*` 并自行重建；不能用客户端头判断来源。推荐局域网 DNS/TLS 反代到 Manager 回环入口，以维持 Secure Cookie、Web Notification 和统一 Origin/CSRF 语义。若管理员明确启用明文局域网入口，界面必须显示风险且浏览器不声称支持需要 secure context 的通知能力。

需要进入长期指令上下文的记忆、Skill 主指令和计划 prompt 在写入与加载/执行两个边界经过共享高置信威胁扫描。扫描有输入上限和有界模式，覆盖 NFKC 兼容字符、不可见/双向 Unicode、明确的指令覆盖、角色劫持、系统提示泄露和凭据外传；它是纵深防护，不能宣称识别所有注入。

后台学习复盘是唯一可跳过 Skill 用户审批的内部路径。它必须同时具有 Platform 生成的 `review_mode`、trigger、unattended、review job、owner、source message、canonical scope 和当前 lifecycle；临时 `session_id` 与幂等 key 必须分别精确等于 `learning-review-<review_job_id>` 和 `agent-learning-review:<review_job_id>`，Runtime 在排队或写入 session 前拒绝任何错配，不能让伪造复盘身份删除普通会话。Runtime 必须将这个完整主体透传到每次复盘 memory 读写和 Skill 请求；Gateway 在任何记忆查询、Skill 读取或副作用前都从 SQLite 反查 running job、当前 lifecycle、激活账号与权限，不能只信 Runtime metadata。复盘 memory `search|read|list` 必须在 lifecycle/review 串行门内，用同一个 SQLite 事务快照完成授权复验和查询；写入则在同一个 `BEGIN IMMEDIATE` 事务内完成复验、预算扣减、变更和返回快照，使 reset、撤权或 job 终结与读写具有明确线性化边界。复盘 Skill `list/load/read` 同样必须把最终复验、文件系统读取与 read-ledger 登记纳入一个保持到读取结束的 lifecycle gate 和 `BEGIN IMMEDIATE` 边界，防止旧 lifecycle 或撤权请求读取当前 Skill。普通私人交互 Run 的 automatic memory 写入同样必须在 lifecycle 门和单一 `BEGIN IMMEDIATE` 事务内，依据当前 scope/lifecycle、账号权限、来源用户消息和 `agent_run_inputs.runtime_run_id` 到 running 父 Agent job 的权威映射复验，不能把早先预检当作持久授权。Runtime 工具白名单和 Platform 动作白名单形成双重边界。复盘不能访问 Sandbox、终端、文件、网络、浏览器、邮件、计划、委派或凭据；Skill create 和 patch 都必须在 lifecycle/review 串行门内重验 scope、账号、权限、来源消息与 running job。Skill 更新还要求同一 Run 先读，再在同一 scope lock 内完成目标包身份重读、`agent-owned + active + unpinned` 资格复核和精确 patch，不接受一个锁外先检查结果作为持久授权。自动 patch 前后都要以 package id 和重新解析的 frontmatter name 拒绝 bundled 遮蔽，并继续执行注入与高置信明文凭据扫描。该扫描覆盖全部可变 Skill 内容写入口，并区分真实 token、PAT、完整 PEM 私钥、实际 Bearer 值与普通认证说明/占位符。复盘创建还必须拒绝 bundled id 或名称冲突，不能用新建包绕过 bundled 只读边界。复盘历史和工具结果仍是不可信数据，用户文本不能把自己变成学习策略或授权。

复盘还必须使用独立、不可被全局调大的 `16` 个模型 turn 硬上限；全局上限更小时取较小值。除此之外，每个 review durable job 只有持久共享的二十单位总变更预算：memory 单动作和 Skill create/patch 各计一单位，reconcile 按子动作计费，读操作不计费，重启或重试不重置。memory 在实际变更事务内原子扣减；Skill 因跨数据库/文件系统而在同一 lifecycle 门内先持久预扣，失败也可能耗费单位，以保证任何文件提交都不会逃逸计费。两种限制共同防止异常模型循环耗尽记忆或 Skill 配额。

持久 session 中未带当前安全 envelope 的 web、browser、memory、knowledge、session、session_search、search_files、schedule 和 skill 工具结果，在重新进入模型上下文时只在内存中重建不可信边界；assistant tool 参数按工具脱敏，不改写原日志。只有当前 Runtime 生成并标记的 Skill 主指令可以保留受控的低优先级流程语义。

## 安全变更要求

涉及认证、权限、路径、内部协议、凭据、工具目标、进程、容器或自动更新的变更必须先修改本文或对应设计文档，再修改实现，并增加滥用与恢复测试。Run 空闲、模型轮次和 terminal 默认超时引用 [`runtime-policy.json`](../contracts/runtime-policy.json)；容器路径、目标、状态和操作引用 [`container-platform.json`](../contracts/container-platform.json)。
