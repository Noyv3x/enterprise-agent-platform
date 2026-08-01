# 外部集成

本文定义平台与模型 OAuth、SearXNG、Firecrawl、Camoufox、Cognee、Telegram 和邮箱的边界。部署方法见[部署](../operations/deployment.md)，配置入口见[配置参考](../reference/configuration.md)。

## 发布与通用原则

- 集成适配器属于产品代码；上游 Git 仓库和缓存不属于产品运行数据。
- Cognee 与 Firecrawl 的官方 URL 和精确 revision 由 [`upstream-sources.json`](../contracts/upstream-sources.json) 锁定。发布工作流和容器验收直接读取并校验该 JSON，在隔离构建上下文中获取、验证和构建；Platform 运行时不生成、导入或携带其 Python 副本，部署机只按 release manifest 拉取镜像，不下载上游源码。
- Platform、Runtime 和集成容器不得访问 Docker socket；生命周期由宿主管理器统一控制。
- 容器模式下 Platform 只读取 Manager 注入的 Camoufox、SearXNG、Firecrawl 私有 service URL。SQLite 中任何 manage、URL、command 或 source repo 行都不参与解析，Platform API 也不提供安装或重启这些固定服务的入口；修复和重启通过 Manager operation 完成。
- Platform 与 Agent Runtime 使用唯一的完整客户端契约。scope 清理、终端预览、模型目录、审批响应和活动 run 输入都是必需能力；缺少方法属于程序契约错误，不得按旧 Runtime 能力静默跳过、降级或重新排队。
- 配置、数据库、Profile、缓存和日志写入数据根的明确 bind mount，不能写进镜像或源码目录。
- 集成包描述、OCI/release 元数据、HTTP User-Agent 和审计日志前缀使用稳定的中性技术名称，不携带源码维护方或部署方品牌，也不从管理员可变品牌派生。当前容器路径、环境变量、进程身份和 Camoufox sidecar 只使用 `agent-platform` / `AGENT_PLATFORM_*` / `.agent-platform-runtime.json` target 接口，单个适配器不得引入第二套技术身份。
- 集成不可用时返回对应能力的明确 degraded/error，不得破坏消息、任务与本地知识数据。
- 凭据只注入需要它的服务，不能进入模型可控 metadata、Sandbox 环境或日志。
- Platform 对受管 SearXNG 与 Firecrawl 只保留实际被状态 API 和调用路径消费的健康探测；服务启动、等待就绪和重试由 Manager operation 负责，不保留无人调用的 Platform readiness 包装入口。
- 当前 release manifest 只接受当前 schema 的十镜像闭集，不包含迁移 helper 或第二套技术身份；历史镜像、目录或环境变量不能使已退役集成重新进入运行边界。

## 模型 OAuth

平台提供 Codex OAuth 和 Grok OAuth。Codex 使用设备码流程；Grok 使用浏览器授权后粘贴 callback URL 的流程。Python 完成 OAuth 会话、state/PKCE 校验、token 交换、刷新、导入导出和持久化。

Runtime 的锁定 Pi 元数据是可执行模型的唯一能力目录。供应商发现目录只能与 Runtime 目录求交或作为可用性提示，不能扩展可执行集合。目录失败时可以使用带 stale 标志的最近缓存。文档不得硬编码动态模型 ID 清单。

## SearXNG 搜索

网页搜索直接请求受管 SearXNG JSON `/search`，不经过 Firecrawl。请求固定为 general 类别，可带语言和页码；平台在统一预算内读取若干页，过滤重复、格式错误、本地地址和含敏感参数的 URL，直到达到请求数量。

返回给 Agent 的搜索项包括标题、URL、描述和稳定位置。搜索不会自动获取完整正文；部分搜索源失败时返回 warning，而不是丢弃已有结果。SearXNG 镜像与配置由发布清单锁定，只接入私有容器网络。SearXNG 容器必须显式以宿主部署用户 UID/GID 运行，使 Manager 创建的 `0600` settings 与 `0700` cache/config 根可以直接读写；不得依赖锁定镜像当前以 root 启动或由上游 entrypoint 递归改写 bind mount 所有权。Compose 必须把受管 `config/` 根整体只读挂载到 `/etc/searxng`，覆盖镜像声明的 volume 边界；单文件挂载会额外创建匿名卷，不能作为受支持的运行方式。

## Firecrawl 提取

`web extract/read` 调用受管 Firecrawl `/v1/scrape`，请求 markdown 与 HTML并优先返回 markdown。每个原始 URL 和最终 URL 都经过公开 URL 与 DNS 感知 SSRF 校验；内容按调用预算裁剪。

CI 从源码契约指定的 revision 和 Compose 文件确认平台实际使用的上游服务，再构建或锁定当前受管服务的全部镜像 digest。Firecrawl 唯一基线为 PostgreSQL 队列；上游标记为实验性且仅在 `NUQ_BACKEND=fdb` 使用的 FoundationDB 不进入源码契约的受管服务集合、release manifest、Compose 或健康目录。release manifest 只接受当前服务的精确镜像键集合。Manager 用稳定 project label、显式 bind mount 和私有网络启动当前服务；Compose 成功后仍需 HTTP 探测，停止上一 generation 时移除其受管容器。部署机不保留 Firecrawl checkout。

Firecrawl API key 作为 Platform secret 注入调用方，不写入 Compose 文件、Manager journal 或 URL；携带 key 的请求拒绝重定向。

## Camoufox 浏览器

共享 Camoufox 容器包含平台拥有的 camoufox-js 补丁、Playwright Core、锁定浏览器资产和 Xvfb/headless 依赖，不读取宿主 `DISPLAY`。Profile、Cookie、下载与 trace 按 scope identity 写入 bind mount。浏览器包的 `version.json` 必须记录锁定 GitHub tag 的真实 release（当前为 `beta.25`），不能把架构资产文件名中的 `alpha.*` 构建号当作 release；Camofox server 与 camoufox-js 必须解析到同一个持久 cache 目录。容器主 API 可以监听私有容器网络的 `0.0.0.0`，但浏览器进程使用的 connection-pinning proxy 必须始终只监听并返回 loopback 地址；两者不得复用 bind host。

Camoufox 镜像的构建层把锁定浏览器目录、已打补丁的 Node 依赖和小型运行源文件分开，并在文件系统层完成后才写入发布 revision/version label。该边界只优化构建缓存与推送体积，不改变 `/opt/camofox` 中的文件集、所有权、启动命令或浏览器版本约束。

浏览器身份由 scope key 哈希派生，模型不能指定 user id、profile 路径或 session key。每次操作都带派生身份，URL 在操作前后重新校验。浏览器按可信成员模型允许普通内网和回环页面，但拒绝云元数据、链路本地、多播、保留、不可路由目标及 URL 内嵌凭据。

支持 tab、导航、snapshot、截图/vision、链接、图片、下载列表、结构化提取和常见交互；console 不执行任意 JavaScript。预览只读取已有 tab 的低频 viewport 帧，打开预览不能启动浏览器、创建 tab、导航或改变当前 tab。

用户可以对当前已授权 tab 取得短期人工接管租约，用限幅坐标鼠标、滚动、文本与按键协助处理验证码或卡住的页面。Platform 每次操作都重新校验登录用户、scope family、tab 与租约，不接受客户端指定的 Camoufox user id、selector、脚本或任意导航 URL。同一 root scope 的人工取得/释放、人工输入与 Agent 变更型动作必须经过同一串行操作门，锁覆盖实际 Camoufox 调用及调用后的状态提交；因此 Agent 不能在“确认无租约”之后与正在取得租约或执行中的人工输入交叠。租约期间 Agent 的变更型浏览器动作返回可重试冲突；只读截图仍可继续。人工输入还按租约绑定的 tab 与单调序列串行，不能因并发 HTTP 请求乱序。

同一界面提交新消息时，前端立即把该 scope 的本地接管状态降为只读，并等待已经在途的 acquire/input 及其对应 release 收敛后再发送消息；凡该消息将触发 Agent，Platform 还必须在任务入队前、同一浏览器操作门内撤销发送者本人持有的该 root scope 租约。不同用户持有的租约不能被消息发送者夺取，未触发 Agent 的普通频道消息也不能由服务端隐式撤销他人的协助。这样“人工处理后让 Agent 再试”不依赖 90 秒自然过期，也不会让异步前端释放与 Agent 导航形成竞态。明确结束、失焦、页面隐藏、到期、tab 变化、服务端租约冲突、tab 关闭或 scope cleanup 同样立即把界面降为只读，并尽力释放原租约。共享 Xvfb 不直接暴露为远程桌面。

## Cognee

本地 SQLite/FTS 知识库始终可用。`local` 模式不调用 Cognee；`hybrid` 和 `cognee` 模式尝试摄取到指定 dataset，并合并 Cognee 与本地结果。

Cognee 精确 revision 在 Platform 镜像构建时安装为分发版，运行时不把源码加入 `sys.path`。其 data、system、cache、logs 与 `.env` 位于 bind mount。Platform 后台 worker 是摄取异步边界；调用要等待 graph construction 的真实终态，不能留下短生命周期 event loop 的伪成功任务。

## 不可信内容

搜索、提取、浏览器文本、邮件、知识结果、记忆、历史会话、计划定义/历史和 Skill 附件都可能包含间接提示词注入。返回模型前必须进入防伪闭合的 `untrusted_tool_result` 数据边界，并先中和载荷伪造的同名标签；图片保持图片块，伴随文本仍使用相同边界。

结构化边界是主要语义防线。共享威胁扫描器只作纵深防护：输入先 NFKC 归一化，检测不可见/双向 Unicode，并使用有界规则。长期记忆、Skill 主指令和计划 prompt 在写入及加载/执行时复查；普通网页内容不因关键词被删除，而是保持可见并始终作为不可信数据。

## Skill 学习边界

Skill 采用 Hermes 风格的“索引后按需读取”机制：正常 Run 只收到有界元数据索引，必须显式 `load`/`read` 才能取得正文或附件。后台学习复盘可以创建新的私有 Skill，也可以在同一次复盘中先读取、再精确替换自己此前创建的 Skill；它不得自动改写用户创建、用户置顶、已归档、已停用或仓库预置的 Skill，也不得删除或停用任何 Skill。`.skill-usage.json` 是 owner-only 的可信来源，记录 `user/agent` 来源、状态、置顶、使用与修补计数；缺失或旧记录一律按用户所有处理并失败关闭。所有自动写入在最终文件系统提交前重新核验私人 scope、lifecycle、活动账户、运行中的复盘 job 和持久变更预算，并重复执行提示词注入、凭据与大小检查。

## Telegram

Telegram Gateway 只处理私聊，忽略群组、超级群组和频道。用户在私人 Agent 界面生成短时绑定码，通过 `/link CODE` 或 `/start CODE` 绑定身份。

update id 是入站去重边界；未确认 update 可在重启后重新领取。出站回复使用持久 delivery job；已开始发送但结果未知的任务进入 `needs_review`，不能盲目重复。停用或轮换 bot 时先吊销旧 sender generation，再停止 transport。

## 邮箱

私人 Agent 可以配置标准 IMAP/SMTP 邮箱账户与应用专用密码。Platform 使用系统 CA 验证 IMAPS、SMTPS 或 STARTTLS，不增加邮件容器，也不把密码交给 Runtime、Sandbox、日志或工具结果。界面只管理账户、测试连接、立即检查和收信唤醒开关，不实现第二个完整邮件客户端。

`mail` 工具支持列账户、文件夹、搜索、读取、发送、回复、移动、标记与把附件安全保存到当前工作区。所有权由可信私人 scope 派生；频道、委派或其他用户不能访问账户。交互式搜索也必须先用 `UIDNEXT` 限定最近的有界 UID 窗口，不能让 `SEARCH ALL` 为大邮箱生成无界响应；读取完整正文前先读取 `RFC822.SIZE` 并拒绝超限或缺失大小的响应。邮件正文、头部和附件名始终作为不可信工具结果。发送使用持久幂等投递记录：明确成功才完成，明确失败可由新请求重试，结果未知进入 `needs_review`，不得盲目重发；“删除”只移动到 Trash，不执行不可恢复 expunge。

保存邮件附件时，Platform 必须从可信 scope 的工作区根目录 fd 开始，逐段以 `O_DIRECTORY | O_NOFOLLOW` 打开或以 `mkdirat` 创建目标父目录，并验证每一段都是部署用户拥有的真实目录。最终文件只能相对已固定的父目录 fd 使用 `O_CREAT | O_EXCL | O_NOFOLLOW` 创建，再验证其类型与 owner；不得先按路径检查、随后重新按字符串路径打开。父目录在保存过程中被替换、重命名或改成符号链接时，写入也不能越过当前 scope 的工作区边界。

启用收信唤醒后，一个有界轮询器按 `UIDVALIDITY + UID` 做 checkpoint 和去重。首次启用或 `UIDVALIDITY` 变化时必须用服务器 `UIDNEXT` 建立当前高水位，不能执行 `SEARCH ALL`、把整个邮箱 UID 列表载入内存或把历史邮箱当成新邮件；服务器未返回有效 `UIDVALIDITY/UIDNEXT` 时 fail closed。增量检查只搜索从 checkpoint 开始的有界 UID 数值窗口，每批新邮件数量另有更小上限；有剩余窗口时把账户标记为立即到期，由公平的后台轮询循环继续追赶，而不是等待用户配置的常规周期。公平顺序按持久化的下次到期时间排列；追赶一个窗口后，该账户仍立即到期，但必须移到其他已到期账户之后。这个顺序必须跨轮询循环和进程重启保留，不能让前一批持续积压的账户固定占满批次。只有成功处理完整窗口才持久化已扫描边界；批内超过上限时只能推进到最后一个已选择 UID，读取或落库失败不得越过失败 UID。这样既不让大邮箱一次占满 worker，也不会让稀疏 UID 或持续流量积压数小时。

唤醒背压是 IMAP 读取的前置门。每个邮箱账户最多同时保留 `4` 个、每个私人 scope 最多同时保留 `8` 个处于 `queued/running` 的邮件唤醒 Agent job；任一上限到达时，本轮不建立 IMAP 读取、不获取正文、不推进 `UIDVALIDITY/last_uid` checkpoint，只按账户的正常轮询周期退避。同一私人 scope 的后台轮询与手工“立即检查”共用同一串行门，并在落库事务内再次检查两级容量；因此释放容量后必须从原 checkpoint 的同一 UID 精确续跑，不能丢信或产生重复模型调用。

唤醒触发消息只保留严格有界的预览：主题、发件人、收件人、抄送、日期和 Message-ID 每字段最多 `512` 字符，正文预览最多 `4096` 字符，只附带附件数量而不嵌入附件内容。触发文案必须明确告知 Agent 使用 `mail/read` 和可信的 `account/folder/uid` 重新读取权威全文。权威预览只存于产品消息；durable job 只持久化 `source_message_id` 和最小任务类型，调度、重启恢复和终态补偿都必须从该权威消息重建内存任务，不得在 `task.content`、`user_message.content` 和 job payload 中重复持久化正文。

后台 IMAP 网络读取不持有更新写准入；每个 checkpoint、触发消息/durable job 事务和检查状态落库前重新取得短准入，更新已经预约时放弃未提交结果并在新 generation 从原 checkpoint 重试。新邮件以 system trigger 写入私人对话，并和 Agent durable job、checkpoint 在同一事务提交。唤醒 Run 标记为 unattended，只能读取和汇报，不能因邮件正文自行发送、移动、删除、修改记忆或执行宿主命令。维护期间不开始轮询、投递或唤醒，解除后从 checkpoint 继续。

公平轮转中的“立即到期”指下一调度秒即可再次被领取，不等待账户的常规周期。每次追赶后持久化的到期边界必须严格前进，不能因秒级时钟相同而再次与未处理账户并列。

## 上游边界

本仓库不包含 Cognee 或 Firecrawl 的 gitlink、vendored tree 或镜像副本。临时构建 checkout 不得承载产品修改或被推送。平台行为实现于 Python adapter、Agent Runtime、Manager 或平台生成配置；浏览器补丁实现于 `camofox-runtime/`。升级上游先修改源码契约并通过镜像集成验证。

Manager 更新预约是所有有副作用集成 worker 的共同门：maintenance 生效时，Cognee 摄取、Telegram 收发、计划任务和恢复中的 Agent job 都不得启动。只有匹配 operation id 的内部 release 明确解除预约后，Platform 才能统一唤醒这些 worker。

候选启动期间对 workspace、Runtime 与集成 checkpoint 的只读验证不构成解除预约，也不能唤醒邮件、Telegram、计划任务、学习或知识摄取；只有同一 operation 的 Gate 结算明确释放 reservation 后，这些 worker 才按原 checkpoint 恢复。

开发环境同样通过外部 Compose/Manager 启动固定服务，再把私有 service URL 注入 Platform；Platform 不提供进程 runner、安装器、Compose 包装器或源码目录配置。测试替身只实现 HTTP 契约，不能重新引入第二套生命周期。
