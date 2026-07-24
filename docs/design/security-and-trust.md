# 安全与信任边界

本文是当前安全设计的规范说明。历史检查记录位于 `../audits/`，不替代本文。执行细节见 [Agent Runtime](agent-runtime.md)，部署要求见[部署](../operations/deployment.md)。

## 信任模型

ubitech agent 面向彼此可信的内部成员，不试图在同一部署中抵抗恶意租户。每个私人 Agent 和频道主 Agent拥有独立 Sandbox、workspace、HOME、session、memory 与浏览器 Profile；委派子 Agent继承父 Sandbox。该隔离减少环境互相污染和误操作，不是针对恶意用户、恶意模型或提示词注入的安全边界。

默认工具在 Sandbox 执行。模型可以为单次工具显式选择宿主目标；管理器随即以部署用户执行，并允许使用该用户已有的免密 `sudo`。这等同把该次操作授予部署用户乃至 root 能力。部署方必须只给可信成员使用，并把部署用户、宿主文件和网络权限控制在可接受范围。

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

`target=host` 必须由模型在当前调用显式选择，不弹出用户审批，也不形成 session/always 授权。管理器在执行前持久化并向聊天发送审计事件，展示 target、完整实际命令参数或 canonical 文件路径、cwd、前后台方式和有效超时；执行后记录退出、时长与是否调用 sudo。日志可脱敏 secret，但不能隐去影响命令语义的普通参数。

命令中的 token、Cookie、Authorization、URL userinfo、常见 secret 变量和值必须在离开执行器前脱敏。统一脱敏器覆盖常见客户端的紧凑、等号和分离参数形式；无法安全解析嵌套 shell 求值中的 secret 时直接拒绝。原始 secret 只留在当前执行闭包，不能进入事件 journal、session、预览或错误文本。

终端预览和 `process.list/read/stop` 快照复用同一脱敏器后再裁剪。取消和 scope cleanup 尽力终止前台进程；Sandbox 后台进程可跨 Run 保留，但必须有登记、输出上限和管理员可见状态。Sandbox 停止会终止其容器进程，持久挂载数据保留。

## 管理器与更新

Manager control socket、配置、release manifest、operation journal 和 registry 凭据必须 owner-only。所有 install/update/restart/rollback/repair operation 带 idempotency key、期望 generation 和持久阶段；并发冲突不能启动第二个变更。

发布清单锁定源 commit、数据库版本、管理器校验和与镜像 digest。Manager 不运行清单中的任意 shell，不接受 mutable tag 作为运行身份。更新先预拉取、等待业务空闲、原子关闭准入和进入维护；旧 Platform 停止后才能迁移 SQLite。任何时刻只允许一个可写 Platform writer。

快照恢复、新 generation readiness 和管理器重启验证完成前不能删除旧源码或数据。首次迁移未知 ignored 文件随完整 checkout 进入至少保留七天的 recovery pack；清理只能处理迁移清单明确列出的路径，不能跟随符号链接或跨越配置根。

## 文件与附件

数据根、workspace、Runtime 根和 Agent env 必须由部署用户拥有、不是符号链接，并收紧权限。workspace 路径的每个组成部分都要重新检查符号链接。数据库保存相对 workspace 标识，不能把旧宿主绝对路径带入容器。

上传文件有数量、单文件、总量、账号配额和全局配额；名称和 MIME 在服务端规范化。只有允许的位图格式可以内联给模型；其余附件通过当前 scope 的只读 Sandbox 挂载 `/workspace/.ubitech/attachments` 访问。Platform 不得把自己的数据路径写进 prompt 或 Run，Manager 不得把其它 scope 或全局附件根挂入 Sandbox。Agent 生成附件只能从当前 workspace、平台管理的媒体目录和显式媒体根返回，并在解析真实路径后再次校验。

## 凭据与敏感数据

OAuth refresh token、session secret、内部 token 和其它 secret 保存在 Platform SQLite `settings` 表，并用 `secret` 标志控制展示；数据目录和数据库文件依靠宿主权限保护。当前没有应用层静态加密，文档和界面不得宣称“加密存储”。

OAuth token 不得写入 Runtime session、Run metadata、工具事件或错误。容器只获得其运行所需 secret；Sandbox 不继承 Platform、Manager、registry 或宿主环境的 secret。所有子进程从最小环境开始构造，不能整体透传服务环境。

## 不可信内容与提示词注入

用户显示名、职位、频道名、网页、浏览器、知识、记忆、历史 session、计划结果和 Skill 附件都作为不可信数据。Runtime 使用防伪、闭合的结构化边界包装工具结果，中和载荷伪造的边界 token；短文本、错误文本和历史数据不能豁免。

需要进入长期指令上下文的记忆、Skill 主指令和计划 prompt 在写入与加载/执行两个边界经过共享高置信威胁扫描。扫描有输入上限和有界模式，覆盖 NFKC 兼容字符、不可见/双向 Unicode、明确的指令覆盖、角色劫持、系统提示泄露和凭据外传；它是纵深防护，不能宣称识别所有注入。

旧 session 中未带当前安全版本的 web、browser、memory、knowledge、session、session_search、search_files、schedule 和 skill 工具结果，在重新进入模型上下文时只在内存中重建不可信边界；旧 assistant tool 参数按工具脱敏，不改写原日志。只有当前 Runtime 生成并标记的 Skill 主指令可以保留受控的低优先级流程语义。

## 安全变更要求

涉及认证、权限、路径、内部协议、凭据、工具目标、进程、容器或自动更新的变更必须先修改本文或对应设计文档，再修改实现，并增加滥用与恢复测试。Run 空闲、模型轮次和 terminal 默认超时引用 [`runtime-policy.json`](../contracts/runtime-policy.json)；容器路径、目标、状态和操作引用 [`container-platform.json`](../contracts/container-platform.json)。
