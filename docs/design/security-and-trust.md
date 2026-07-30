# 安全与信任边界

本文是当前安全设计的规范说明。历史检查记录位于 `../audits/`，不替代本文。执行细节见 [Agent Runtime](agent-runtime.md)，部署要求见[部署](../operations/deployment.md)。

## 信任模型

ubitech agent 面向彼此可信的内部成员，不试图在同一部署中抵抗恶意租户。每个私人 Agent 和频道主 Agent拥有独立 Sandbox、workspace、HOME、session、memory 与浏览器 Profile；委派子 Agent继承父 Sandbox。该隔离减少环境互相污染和误操作，不是针对恶意用户、恶意模型或提示词注入的安全边界。

默认工具在 Sandbox 执行并免人工审批，但仍受不可绕过的 hard-block。模型可以为单次 terminal、文件或进程调用显式选择宿主目标；任何 `target=host` 调用都必须由用户逐次批准，不能形成会话或永久授权。管理器随后才以部署用户执行；terminal 还允许使用该用户已有的免密 `sudo`。这等同把该次操作授予部署用户乃至 root 能力。部署方必须只给可信成员使用，并把部署用户、宿主文件和网络权限控制在可接受范围。

## 认证与权限

密码使用 PBKDF2-SHA256 和随机盐。登录失败按客户端与账号限流，并使用固定 dummy hash 降低用户名时序泄漏。用户停用、改密、权限变化或显式吊销会推进 token version，使旧会话失效。

浏览器会话由 HMAC 签名 token 承载。Cookie 使用 `HttpOnly` 和 `SameSite=Lax`；公共 URL 为 HTTPS 时增加 `Secure`。携带 Cookie 的写请求必须提供允许的 Origin 或 Referer；只有运维明确启用可信代理后才使用转发头。

权限必须在 Python 服务端检查。前端路由、隐藏按钮和角色标签不是授权边界。Platform、Runtime 与 Manager 的内部接口分别使用独立 bearer 或 owner-only Unix socket；浏览器 session 不能替代内部身份。

## 容器与网络边界

只有宿主管理器访问 Docker socket。Platform、Runtime、Sandbox、Camoufox、SearXNG 和 Firecrawl 都不得挂载或代理 Docker socket。固定服务与 Sandbox 位于管理器预创建并持有的持久私有 bridge 网络；Compose generation 只引用该 external network，不创建或删除它，因此固定栈切换不能中断仍在运行的 Sandbox。管理器只接管带产品 managed label 且 driver 符合契约的网络；同名但来源或配置不明的网络必须拒绝而不是覆盖。只有 Platform backend 被管理器发布到宿主回环，sidecar 不发布公网端口。

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

`target=host` 必须由模型在当前 terminal、文件或进程调用中显式选择，并逐次弹出用户审批；只允许 `once` 或 `deny`，不形成 session/always 授权。未批准、超时或通知失败时不得先调用 Manager。批准后管理器在执行前持久化并向聊天发送审计事件；terminal 展示完整实际命令参数、canonical cwd、前后台方式和有效超时，文件与进程工具展示 canonical 目标及完整操作参数。执行后记录结果与副作用。日志可脱敏 secret，但不能隐去影响语义的普通参数。浏览器、Skill、计划等独立业务审批不因命令策略变化而自动取消。邮件发送、回复、移动、标记和保存附件同样逐次审批，审批记录隐藏正文与凭据；邮件唤醒的 unattended Run 无条件拒绝这些动作。

命令中的 token、Cookie、Authorization、URL userinfo、常见 secret 变量和值必须在离开执行器前脱敏。统一脱敏器覆盖常见客户端的紧凑、等号和分离参数形式；无法安全解析嵌套 shell 求值中的 secret 时直接拒绝。原始 secret 只留在当前执行闭包，不能进入事件 journal、session、预览或错误文本。

终端预览和 `process.list/read/stop` 快照复用同一脱敏器后再裁剪。取消和 scope cleanup 尽力终止前台进程；Sandbox 后台进程可跨 Run 保留，但必须有登记、输出上限和管理员可见状态。Sandbox 停止会终止其容器进程，持久挂载数据保留。

## 管理器与更新

Manager control socket、配置、release manifest、operation journal 和 registry 凭据必须 owner-only。所有 install/update/restart/rollback/repair operation 带 idempotency key、期望 generation 和持久阶段；Manager 先核对 key 对应的不可变请求指纹，再判断 generation，使丢失响应后的原样重放只能观察原 operation，不能启动第二个变更或用同 key 替换请求。control 服务端先完整编码再提交成功状态，mutation 只返回有界确认；客户端把空、截断、超限或非法的 2xx 响应视为结果不确定并以原幂等身份对账，不能伪造成功或当作确定失败。外部错误正文属于不可信诊断数据：写入 state、operation 或 activation journal 前必须限制大小，重试只替换“最近一次失败”片段而不能递归拼接上一份完整错误；control API 也只返回有界诊断投影，不能让历史错误耗尽本地控制通道预算。候选 Platform readiness 失败时，Manager 在删除容器前先读取 healthcheck 再读取有界日志；两类内容必须先替换精确 Manager capability 和通用凭据模式、再截断并写入 operation，采集失败本身只能成为有界诊断，不能阻止回滚。

发布清单锁定 source commit、数据库版本、Manager 校验和与镜像 digest。Manager 不运行清单中的任意 shell，不接受 mutable tag 作为运行身份。更新先预拉取、等待业务空闲、原子关闭准入和进入维护；current Platform 停止后才能迁移 SQLite。任何时刻只允许一个可写 Platform writer。

更新预拉取只把 Platform 与 Agent Runtime 作为切换前核心镜像。Manager 先用本地精确 RepoDigest 判断是否已经存在，不能为本地命中无条件访问 registry；缺失镜像的命令输出只用于刷新内存中的空闲期限，原始 registry 输出不得写入 operation、公共状态或长期日志。无进展和绝对超时都在 maintenance 前结束为可重试失败。Camoufox、SearXNG、Firecrawl 与 Sandbox 镜像由各自受限路径拉取，第三方 registry 故障不能扩展核心更新的信任或锁边界。

Manager 只把当前镜像白名单写入 Compose 环境和服务状态投影；未被当前契约命名的 manifest 扩展项即使通过格式校验，也只能保留为不可执行的 opaque metadata，不能获得环境变量、Compose 引用、镜像拉取或控制 API 可见性。已经退出当前 Compose 的服务不能因 journal、额外 manifest 键或 Docker 残留重新进入运行边界。

Manager 的预约从首次 Platform reserve 到持久 `maintenance=true`、再用同一 operation id 确认 reserve 后才可执行破坏性操作。响应不确定时只有明确 release 才能回到非维护状态；Manager 不可达或预约身份不一致时所有管理写操作 fail closed。Platform 启动任何有副作用 worker 前必须恢复同一持久预约状态。

快照完整验证、候选 generation 核心 readiness、Manager watchdog 提交和 reservation release 完成前不能开放业务。核心 readiness 只包含 Manager 控制面、Platform 与 Agent Runtime；Camoufox、SearXNG、Firecrawl 和 Cognee 失败时保持能力级 degraded，不能终止 Manager、关闭控制接口或阻止健康核心 generation 完成 finalize。Manager 自更新的 activation plan 与独立 watchdog 是持久安全所有者；外部恢复不能仅凭主 unit 停止或 recovery lock 抢占它，必须验证完整提交链、停止并证明相关 watchdog 退出，再通过新的持久 recovery activation 转移所有权。Docker 资源清理只能处理同时匹配 Manager ownership label、Compose project/resource label 且无 attachment 的对象，禁止全局 prune。Manager `/v1/status` 的 generation 只返回 id、source commit、数据库版本、镜像与激活时间，不投影 manifest、快照或其它宿主绝对路径。

## 文件与附件

数据根、workspace、Runtime 根和 Agent env 必须由部署用户拥有、不是符号链接，并收紧权限。workspace 路径的每个组成部分都要重新检查符号链接。数据库只保存相对 workspace 标识，不能写入宿主绝对路径。

上传文件有数量、单文件、总量、账号配额和全局配额；名称和 MIME 在服务端规范化。上传没有固定墙钟超时，但连续没有收到字节达到上传 socket 空闲上限、断线、取消、更新切换或大小越界仍会终止传输；持续前进的慢速上传不会因普通总耗时被中断，界面只展示浏览器已实际发送的字节进度。Multipart 读取期间只写 owner-only staging，不占用可无限延长的更新写准入；只有完整读取后的附件验证、权威复制、消息和 durable job 提交占用短准入。若更新先预约，旧请求可以中断并清除 staging，不能通过慢滴流永久阻止版本收敛。Platform 为上传使用独立的有界并发预算，超过预算时明确拒绝新上传，不能让大文件占满普通请求工作线程。

Multipart 正文必须增量读取并先写入 Platform 数据根内 owner-only 的请求 staging 目录；解析过程只保留边界探测所需的小型缓冲区，不得把完整请求或附件复制到内存。服务端完成数量、大小、配额、文件类型和摘要校验后再把 staging 文件流式提交到附件目录；请求成功、失败、取消或超时后都必须清理 staging。只有允许的位图格式可以内联给模型；其余附件通过当前 scope 的只读 Sandbox 挂载 `/workspace/.ubitech/attachments` 访问。Platform 不得把自己的数据路径写进普通 Run metadata；唯一例外是由可信配置派生、只进入当前 scope 系统提示的宿主工作区映射。Manager 不得把其它 scope 或全局附件根挂入 Sandbox。Agent 生成附件只能从当前 workspace、平台管理的媒体目录和显式媒体根返回，并在解析真实路径后再次校验。

邮件附件保存不能使用“父目录 `lstat` 后再按完整路径 `open`”的检查/使用分离流程。Platform 必须固定可信 scope 的 workspace 根 fd，逐段相对父 fd 使用 `O_DIRECTORY | O_NOFOLLOW` 打开目录；缺失目录以 `mkdirat` 创建后重新打开并校验类型与部署用户 owner。最终文件相对固定父 fd 使用 `O_CREAT | O_EXCL | O_NOFOLLOW` 创建，随后用 fd 校验普通文件类型与 owner、收紧为 `0600` 并持久化。任何符号链接、特殊文件、owner 异常或并发路径替换都必须 fail closed，且失败清理只能针对同一固定父目录中由本次调用创建的 inode。

Manager 的 Sandbox 文件工具从已固定的挂载根目录 fd 逐级处理不可信路径。目录枚举只能从该 fd 读取名称，不能根据 `os.File` 的逻辑显示名重新解析宿主路径；每个名称随后以 `O_NOFOLLOW` 和非阻塞模式相对父目录 fd 打开，并以 fd 元数据决定是否读取或递归。符号链接不得跟随，FIFO、设备、socket 与其它特殊文件不得读取；附件覆盖层必须先于普通 workspace 映射并保持只读。该路径必须在 Manager 声明的最低 Go 版本与当前受支持版本上保持相同行为。

同一 fd-rooted 契约也适用于 `target=host`。Manager 先把批准中绑定的逻辑路径映射为宿主根和相对路径，拒绝 Docker socket、当前 Manager 状态根、标准 Manager 配置/运行目录及按操作类型禁止的宿主路径；随后从可信根逐段使用 `O_NOFOLLOW` 打开。host 搜索从固定目录 fd 枚举并跳过其下受保护子树，不能因为搜索根是其祖先而读取 Manager secret。host patch 必须在同一个固定父目录 fd 内完成读取、临时文件写入和原子替换；host terminal cwd 必须固定目录 fd，并让子进程从该 fd 切换目录。路径审批、一次性执行收据、Sandbox identity 和这次可信映射共同绑定一次执行；检查与实际文件操作之间不得重新解析可被替换的路径字符串。

## 凭据与敏感数据

OAuth refresh token、邮箱应用密码、session secret、内部 token 和其它 secret 保存在 Platform SQLite 的专用凭据表或 `settings` 表，并只返回“已配置”状态；数据目录和数据库文件依靠宿主权限保护。当前没有应用层静态加密，文档和界面不得宣称“加密存储”。

OAuth token 不得写入 Runtime session、Run metadata、工具事件或错误。容器只获得其运行所需 secret；Sandbox 不继承 Platform、Manager、registry 或宿主环境的 secret。所有子进程从最小环境开始构造，不能整体透传服务环境。

## 不可信内容与提示词注入

用户显示名、职位、频道名、网页、浏览器、邮件正文与头部、知识、记忆、历史 session、计划结果和 Skill 附件都作为不可信数据。Runtime 使用防伪、闭合的结构化边界包装工具结果，中和载荷伪造的边界 token；短文本、错误文本和历史数据不能豁免。邮件唤醒是 unattended Run，只允许读取和汇报，不得把邮件内容当成发送、移动、删除或宿主执行授权。

## 浏览器接管与局域网

浏览器人工接管使用当前 scope/tab 的短期租约。服务端从登录身份重新派生 scope 与 Camoufox user identity，客户端不能提供 user id、selector、脚本或任意内部 URL；只接受限幅后的鼠标、滚动、文本和按键动作。同一 root scope 的租约取得/释放、人工输入与 Agent 变更型动作共享串行操作门，互斥范围覆盖真实 Camoufox 调用，不能留下“Agent 已检查无租约、人工随后取得租约、两者同时修改页面”的窗口。租约期间 Agent 的变更型浏览器工具返回可重试冲突；结束、失焦、页面隐藏、过期、tab 变化、409 冲突或 tab 关闭后客户端立即降为只读并尽力释放，服务端到期与 scope cleanup 负责最终回收。共享 X display 不能直接暴露为 noVNC/VNC，因为那会跨 scope 泄露页面。

局域网入口默认关闭，只能绑定明确的私网或回环 IP，拒绝通配和公网 IP。启用时 Manager 以真实 `RemoteAddr` 和显式 CIDR 判断准入，丢弃非可信来源携带的 `Forwarded`/`X-Forwarded-*` 并自行重建；不能用客户端头判断来源。推荐局域网 DNS/TLS 反代到 Manager 回环入口，以维持 Secure Cookie、Web Notification 和统一 Origin/CSRF 语义。若管理员明确启用明文局域网入口，界面必须显示风险且浏览器不声称支持需要 secure context 的通知能力。

需要进入长期指令上下文的记忆、Skill 主指令和计划 prompt 在写入与加载/执行两个边界经过共享高置信威胁扫描。扫描有输入上限和有界模式，覆盖 NFKC 兼容字符、不可见/双向 Unicode、明确的指令覆盖、角色劫持、系统提示泄露和凭据外传；它是纵深防护，不能宣称识别所有注入。

持久 session 中未带当前安全 envelope 的 web、browser、memory、knowledge、session、session_search、search_files、schedule 和 skill 工具结果，在重新进入模型上下文时只在内存中重建不可信边界；assistant tool 参数按工具脱敏，不改写原日志。只有当前 Runtime 生成并标记的 Skill 主指令可以保留受控的低优先级流程语义。

## 安全变更要求

涉及认证、权限、路径、内部协议、凭据、工具目标、进程、容器或自动更新的变更必须先修改本文或对应设计文档，再修改实现，并增加滥用与恢复测试。Run 空闲、模型轮次和 terminal 默认超时引用 [`runtime-policy.json`](../contracts/runtime-policy.json)；容器路径、目标、状态和操作引用 [`container-platform.json`](../contracts/container-platform.json)。
