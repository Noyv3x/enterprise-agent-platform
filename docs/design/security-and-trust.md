# 安全与信任边界

本文是当前安全设计的规范说明。历史检查记录位于 `../audits/`，不替代本文。执行细节见 [Agent Runtime](agent-runtime.md)，部署要求见[部署](../operations/deployment.md)。

## 信任模型

ubitech agent 面向彼此可信的成员。所有 Agent 以同一个平台服务账号在宿主机执行，workspace、session、memory 和浏览器 Profile 提供逻辑隔离，不提供抵抗恶意租户的 OS 隔离。

部署方必须把该服务账号可读取、写入和联网的范围控制在可接受水平。审批、路径校验和命令文本规则是纵深防护，不能替代最小权限、网络隔离、容器、cgroup 或独立主机。

## 认证与权限

密码使用 PBKDF2-SHA256 和随机盐。登录失败按客户端与账号限流，并有固定 dummy hash 降低用户名时序泄漏。用户停用、改密、权限变化或显式吊销会推进 token version，使旧会话失效。

浏览器会话由 HMAC 签名 token 承载。Cookie 使用 `HttpOnly` 和 `SameSite=Lax`；公共 URL 为 HTTPS 时增加 `Secure`。携带 Cookie 的写请求必须提供允许的 Origin 或 Referer；只有运维明确启用可信代理后才使用转发头。

权限必须在 Python 服务端检查。前端路由、隐藏按钮和角色标签不是授权边界。内部 Agent 工具使用独立 bearer token，不接受浏览器 session 代替。

## 网络边界

平台托管的 Agent Runtime、SearXNG、Firecrawl 和 Camoufox 必须使用无内嵌凭据的数值回环 endpoint；外置 SearXNG 仍只允许本机数值回环，Camoufox 当前不提供外置模式。外置 Agent Runtime 与 Firecrawl 可以由受信任运维配置为 HTTP(S) endpoint，但凭据必须通过 header 传递，不能内嵌在 URL 中；携带凭据的内部服务请求不得跟随重定向。Runtime 的所有接口，包括健康检查，都需要 bearer token；缺少 token 时 Runtime 必须拒绝启动。外置 Runtime 会获得 Agent 请求与宿主机工作上下文，必须置于等价的受控网络和认证边界内，不得把 Runtime 端口或内部工具路由裸露到公网。

搜索结果和 Firecrawl 提取 URL 只允许公开 HTTP(S)，拒绝内嵌凭据、回环、私网、链路本地地址、云元数据及敏感查询参数；搜索结果的轻量过滤不代替提取前的 DNS 感知 SSRF 校验。

浏览器是受信成员操作宿主机网络的工作工具，允许正常访问回环与内网 HTTP(S)。浏览器导航仍拒绝内嵌凭据、云元数据、链路本地、多播、保留和不可路由目标，并在操作前后重新校验。部署方必须把“Agent 可浏览内网”纳入服务账号和网络信任边界，不能把公开网页提取的 SSRF 策略错误套用为浏览器隔离承诺。

GitHub 自动更新 webhook 使用 HMAC 签名；Telegram webhook 使用不可猜 secret path。运维必须在边界代理覆盖客户端提供的转发头。

## 宿主机工具

审批决策为 `once`、`session`、`always` 或 `deny`。审批前先执行确定性的工具策略，结果只有 `hard_block`、`approval_required` 或 `allow`；`hard_block` 永远不能由历史授权或用户批准覆盖。下列操作必须审批：

- 所有 terminal 命令；
- 文件创建、修改和补丁；
- workspace 外读取与搜索；
- 主动进程控制；
- 已提交记忆、技能和计划修改；
- 点击、输入、下载、关闭等敏感浏览器动作。

`always` 按 Agent 授权 scope 和稳定审批对象持久化；`session` 只在当前 lifecycle、session 和相同审批对象内有效。terminal 审批 identity 绑定未经 Unicode 折叠或其它语义改写的完整实际命令、canonical cwd、前后台方式和有效超时，批准一个命令不得授权其它命令。文件工具绑定 canonical 目标和全部执行参数，并将预检时固定的 canonical 目标写回执行参数；这也适用于 workspace 内无需审批的读取和搜索，具体操作前还会拒绝已发生的路径重定向。进程、记忆、技能、计划和浏览器等其他敏感工具同样绑定全部执行参数。敏感正文可在审批卡中只显示脱敏值或字节数，但必须参与授权 hash；`process.write` 只允许 `once`/`deny`，同一 process id 的后续 stdin 不能复用旧授权。旧版仅按工具名保存的宽泛授权不继承为新授权。无人值守计划任务只能使用与实际调用匹配的既有持久 `always` 授权，且不能修改计划本身。

审批事件展示完整可理解参数，但命令中的 token、Cookie、Authorization、URL userinfo、常见 secret 变量和值必须在离开 Runtime 前脱敏；`curl -H/--header` 的紧凑、等号和非引号写法遵守同一敏感头脱敏规则。统一脱敏器还必须识别常见客户端的紧凑凭据参数，包括 `curl` 用户/代理用户/Cookie、OAuth bearer 参数，`sshpass` 密码参数，以及数据库、缓存和容器登录客户端的短密码参数；参数和值之间有空格、等号或完全连写时都不得进入审批事件、工作记录、持久 session 或终端预览。凭据若出现在 shell `-c`、`eval`、命令替换或进程替换等嵌套求值中，整条命令必须拒绝，并以不含原文的占位说明进入诊断记录。任何将被脱敏的 terminal 命令或 `process.write` 片段中，`$(`（包括 `$((`）、反引号、`${…@P}` 以及 `<(`/`>(` 都不享有引号或转义豁免；未转义、未引号的其它 Bash `<`/`>` 语法（包括普通重定向、heredoc 和 here-string）也必须在审批前拒绝。敏感环境变量赋值只接受可选的一层成对引号及 `[A-Za-z0-9._~+/:@%=-]` 凭据安全字符；复杂值直接拒绝。同一命令存在这种脱敏赋值时，`eval`、shell `-c`、敏感变量作为命令位、算术求值或 prompt 重求值一律 fail closed；无法完整证明 Bash 数据流安全时宁可拒绝。`<`/`>` 的普通字面文本在转义、单引号或双引号内可放行。不得通过脱敏让用户批准不可见的副作用。超过完整可展示上限的命令直接拒绝，不得让用户批准一条尾部被截断的命令。稳定审批 key 仅在 Runtime 和授权存储内部使用，不进入 SSE/工作记录。原始参数只留在当前执行闭包内；EventJournal、持久 session JSONL 和 archive 中的 tool call 必须按工具脱敏或省略写入/补丁/输入载荷，工具结果中名称敏感的字段无论值是字符串、数组还是对象都必须整值脱敏。审批超时、通知失败、取消和拒绝都属于未授权，并产生已解决事件；返回给 Agent 的结果明确禁止通过改写、重试或换工具实现同一被拒目标。审批等待暂停 Run 空闲计时，但不能把沉默解释为同意。

`process.write` 不允许向长驻 shell 写入任何需要敏感脱敏的输入，避免隐藏值先进入变量、位置参数或 shell 状态后在后续独立输入中重新解释；不触发敏感模式的普通 stdin 数据仍可使用。需要携带凭据的完整命令必须改用一次性 terminal 审批。

聊天侧栏的实时终端预览以及 Agent 可见的 `process.list/read/stop` 快照必须复用同一命令脱敏器后再做长度裁剪，不能维护一套较弱的独立规则；紧凑 curl 敏感头、凭据和危险格式控制字符均不得进入预览、工具结果或后续持久 session。

直接文件工具拒绝受保护系统树、进程凭据/内存和 Docker socket。terminal 和 `process.write` 先拒绝会改变展示或隐藏实际字节的控制字符，包括 U+00AD、U+061C、U+200B、U+200E–U+200F、U+202A–U+202E、U+2060–U+2069 和 U+FEFF；旧持久记录的命令展示也必须移除这些字符。只在不参与授权 identity 和实际执行的检测副本上做 NFKC 归一化，并在不执行 shell 的前提下识别真实命令起点、常见 wrapper、quoting/escaping、管道给 shell、`eval`、`find -exec/-delete`、命令变量与 HOME 表达。关机、文件系统格式化、原始块设备覆盖、删除系统根/核心系统目录/home、fork bomb、kill-all、云元数据及 Docker socket 属于不可批准底线；shell 的表达能力意味着这些规则永远不是完整解析器或沙箱。

所有子进程移除名称疑似 secret、token、password、API key、credential 或 private key 的环境变量。取消和 scope cleanup 尽力终止登记进程组；主动 `setsid` 脱离或 Runtime 被强杀后遗失登记的信息需要部署层控制处理。

## 文件与附件

平台数据根、workspace 与 Runtime 根必须由服务账号拥有、不是符号链接，并收紧目录和文件权限。workspace 路径的每个组成部分都要重新检查符号链接。

上传文件有数量、单文件、总量、账号配额和全局配额；名称和 MIME 在服务端规范化。只有允许的位图格式可以内联，其余主动下载。Agent 生成附件只能从 workspace、平台管理的媒体目录和显式 `ENTERPRISE_MEDIA_ROOTS` 返回，并在解析真实路径后再次校验。

## 凭据与敏感数据

OAuth refresh token、session secret、内部 token 和其它 secret 保存在平台 SQLite `settings` 表，并用 `secret` 标志控制展示；数据目录和数据库文件依靠宿主机权限保护。当前没有应用层静态加密，文档和界面不得宣称“加密存储”。

OAuth token 不得写入 Runtime metadata、session、SSE、日志、workspace 或 Git。Runtime 只在模型调用时从 Python 获取当前访问凭据。OAuth 导出文件本身包含敏感信息，必须由管理员像密钥一样处理。

## 不可信模型数据

记忆召回、知识、搜索结果、网页、浏览器快照/像素、历史会话、计划定义/历史、用户附件文字/图片和技能支持文件都属于不可信数据。所有相应工具文本结果必须进入防伪闭合边界：先中和内容中伪造的边界 token，再添加来源和“仅数据、非指令”说明；不能因文本较短或包含图片而跳过。`search_files` 的文件名和内容命中整体按 workspace 搜索数据包裹，避免附件或工作区文件中的指令文本借搜索摘要绕过边界；`read_file` 对当前 Run 附件路径的读取必须标记为附件数据。图片块前必须有固定不可信说明，不能暗示像素在文本边界内。它们不得被描述成更高优先级指令。模型提供的 owner、scope、provider endpoint、API 类型和浏览器 user id 均不能覆盖可信 Run context。Skill 主指令只能作为低优先级流程建议，不能覆盖 system、权限或审批。

需要进入长期指令上下文的记忆、技能主指令和计划任务 prompt 还要经过共享高置信威胁扫描，并在写入与加载/执行两个边界复查。扫描器必须有输入上限和有界模式以避免 ReDoS，覆盖 NFKC 兼容字符、不可见/双向 Unicode、明确的指令覆盖、角色劫持、系统提示泄露和凭据外传表达；扫描命中是纵深防护，不得宣称能识别所有注入。

长期 session JSONL 中的 message entry 使用 Runtime 写入的模型内容安全版本标记区分新旧格式。缺少当前版本标记的旧 `web`、`browser`、`memory`、`knowledge`、`session`、`session_search`、`search_files`、`schedule` 和 `skill` 工具结果，在送入模型前必须仅在内存中按 `toolName` 重建不可信边界；旧 assistant tool call 参数也必须在模型副本中按工具脱敏。加载本身不得改写旧日志。`session` 的 read/search 摘要无论来自当前日志还是 archive，都必须再次按工具脱敏参数，不能把历史命令凭据带回模型。当前版本标记的结果不得重复包裹。旧 skill 结果统一降级为不可信历史数据，不能恢复成可执行流程建议；只有当前 Runtime 生成并标记的 skill 主指令可以保留受控的低优先级流程建议语义。正常追加与上下文压缩产生的新 message entry 必须写入当前版本标记。

## 安全变更要求

涉及认证、权限、路径、内部协议、凭据、工具审批、进程或自动更新的变更必须先修改本文或对应设计文档，再修改实现，并增加滥用与恢复测试。Run 空闲、模型轮次和 terminal 默认超时只引用 [`runtime-policy.json`](../contracts/runtime-policy.json)；其它安全边界由对应配置参考和测试约束。
