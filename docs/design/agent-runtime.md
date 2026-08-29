# Agent Runtime 设计

本文定义平台自有 Node.js Agent Runtime 的职责。私有协议见 [Runtime API](../reference/runtime-api.md)，数据归属见[数据、记忆与会话](data-memory-sessions.md)，安全策略见[安全与信任边界](security-and-trust.md)。

## 所有权

Runtime 直接依赖 lockfile 中精确版本的 Pi Core 与 Pi AI，不经由外部 CLI 或源码子模块执行。它拥有：

- 模型与工具循环、流式增量和 Run 状态机；
- 工具策略、执行目标选择和审计事件；
- JSONL 会话、archive、上下文压缩与中断修复；
- 子 Agent 委派和父子活动传播；
- 幂等 Run 结果与可恢复事件 journal；
- Runtime 可执行模型目录。

Python Platform 拥有账号、产品消息、OAuth refresh token、记忆、技能、计划、邮箱和浏览器业务接口。宿主管理器拥有 Sandbox/host 进程、文件执行和容器生命周期。Runtime 不复制这些状态，也不访问 Docker socket。

Platform 还拥有当前部署的公开品牌投影，并把经过校验的 Agent 显示名称作为闭合结构化数据写入系统提示。Runtime 和工具说明使用中性 `Agent` 术语，不固化源码维护方名称，也不把品牌文本解释为指令、权限或内部 identity。

## 提示词组装与执行纪律

Runtime 必须以单一、确定性的组装边界构造模型系统提示，顺序固定为“Runtime 稳定策略前缀 → Platform-authored system context → Runtime 动态状态”。稳定前缀只放置当前 Run 类型和工具能力真正需要的执行、回复风格、记忆、Skill、追加输入或定时发生策略；对同一能力集合必须保持字节稳定，不混入时间、回忆结果、活动 sidecar 或技能索引。默认回复风格要求跟随用户语言、使用大白话、先说结果、简单问题简短，并避免套话、官话、无意义标题和重复；用户明确要求的语气与格式仍优先。Platform 仍通过现有私有协议的单个 `system_prompt` 传入品牌、模式、工作区与用户/频道上下文；其中稳定的身份、模式和工作区说明必须位于精确时间之前。Platform 是这个系统上下文的可信作者，但其中嵌入的用户、频道和品牌载荷仍保持各自闭合的不可信数据 framing。Runtime 不从其自然语言内容反向推断权限或执行身份。回忆记忆、活动 todo、有限后台责任和可用 Skill 索引等动态数据放在末层；其中的历史正文、todo 正文和 Skill 元数据继续使用闭合不可信数据 framing，Runtime-owned id、状态和后台责任则明确标识为权威状态。普通 Run 主组装路径不为空状态生成仅有形式的动态块。

这三个逻辑层最终仍形成一个 provider system prompt，不得把分层名称误称为三个独立缓存块。Codex 请求在保留 `session_id` 的会话、header 与 WebSocket 续传用途之外，使用版本化内容摘要作为 `prompt_cache_key`：摘要覆盖字节稳定的 Runtime 策略前缀、规范化后的实际工具 schema 与当前 Agent scope 的稳定分片，使同一 scope 内临时时间、回忆、todo、后台责任和 Skill 索引变化时仍路由到相同稳定前缀，策略、工具能力或 scope 变化时则确定失效，也不把多租户流量压入同一热点 key。该 key 只是供应商缓存亲和提示，供应商可以忽略；缓存未命中或 WebSocket 续传回退到完整上下文时，模型语义、工具权限和执行结果必须不变。当前 Codex OAuth 后端没有经过 canary 验证的显式 cache breakpoint，因此不得向私有端点猜测添加公共 API 新字段或把单元测试写成真实命中证明。

与单个工具选择相关的软策略应优先放在该工具的稳定 schema 说明中，不应为空状态在每个 Run 重复提高其显著性。Runtime 不按用户输入长度、关键词、模型供应商或已发生的工具次数猜测任务复杂度，也不自动代替模型建立执行清单。模型可在同一轮中请求彼此独立的读取、检索和其它明确允许并行的工具；Pi 工具循环依据每个工具的 `executionMode` 并发执行纯并行批次，包含任一顺序工具的批次保持有序。

提示词只负责比例适当的自主行动、真实工具证据、失败后替代路径和完成前验证等行为引导。Runtime 机械完成守卫仅约束已经形成的可验证责任，包括模型明确建立后仍活动的 todo、尚未观察终态的有限后台任务、recurring occurrence 决策和委派副作用的父 Agent 复验；不得把模型未选择的计划形式本身变成完成条件。普通本 Run 文件改动的聚焦验证仍是一次有界软提示，不是机械责任。这些硬守卫不能扩展工具权限、替代审批或伪造外部终态。

对没有建立这类机械责任的普通模型停止，Runtime 优先使用有界软恢复而不是把启发式判断升级为 `needs_review`。只有未执行行动的承诺式终稿时，最多追加一次不持久的继续提示；已经得到工具结果后模型以空终稿停止时，也最多追加一次不持久提示，要求基于已有证据给出自包含结果或真实 blocker。这些提示不得持久到 session、不得重发已产生可见增量的 provider request，也不得重放已完成的工具。软恢复预算耗尽后使用模型当前真实输出和 Run 状态收口，不伪造完成证据。

邮件唤醒的 durable Agent job 只保存 Platform 权威源消息引用；Platform 在队列调度和重启/中断恢复边界严格校验该引用后，在内存中重建有界预览任务再提交 Runtime。Runtime 不从 job 键、邮件正文或其它文本猜测账户与 scope 身份。

Runtime 的进程与文件工具始终通过 Manager executor 接口执行，源码和配置不保留只供测试使用的本地执行后备；单元测试在同一接口注入确定性 fake。为避免共享 runner 调度影响亚秒真实计时断言，本地与 Quality 的 Runtime 测试入口直接用 Node test runner 串行执行全部编译测试；完整规则见[测试与验证](../development/testing.md)。

浏览器 live 调用只接受当前 schema 的 action 名，不为历史别名或 `tool` 字段做转换。附件只保留 path/name/mime 元数据；模型图片只来自已经内联的 input block。执行 target 闭世界只使用生成契约中的 `sandbox|host`。

## Run 状态机

顶层 Run 先进入 FIFO 并发队列，再依次经历 `queued`、`running` 和一个终态。终态为 `completed`、`failed`、`cancelled` 或 `needs_review`。只有顶层 Run 消耗全局并发名额；委派子 Run 共享父 Run 的执行槽、Sandbox 与工作区，但保持派生 scope、独立 session 和事件。

创建请求的 `idempotency_key` 在 `scope_key` 内唯一。终态结果原子保存；重复创建返回既有 Run。重启时发现已经开始但没有终态的幂等 Run，必须返回 `needs_review`，不能自动重做。

Agent 主循环中的模型供应商过载、限流、可重试服务端错误和瞬时网络故障，在单次模型请求边界进行有界指数退避与抖动重试。只有失败 attempt 尚未向 Agent loop 提交任何非空正文、思考或工具调用时才可丢弃并重发相同请求；一旦已有可见增量，或错误属于上下文/输出大小、额度、账单、认证、内容策略等非瞬时类别，就不得自动重试。这个机制可以重试工具完成后的下一次模型请求，但不能重新开始整个 Run、重放 session 中已完成的模型轮次或再次执行工具。退避等待可被 Run 取消并持续刷新活动；预算耗尽后仍按现有 `failed` / `needs_review` 与副作用事实终结。这个主循环策略不扩展到 browser 结果的视觉辅助分析；该辅助请求仍使用自身有界 timeout 与文本 fallback，不得因重试阻塞工具结果回到主循环。

私人交互 Run 可以接收追加输入。输入按 message id 持久化并返回 accepted、injected 或 unconsumed；只有模型循环确认注入后，Platform 才能把该输入视为已消费。

产品界面对用户本人频道消息的撤回不属于 Runtime 取消协议。消息已经形成 durable job 或进入 Run 后，撤回只隐藏 Platform 产品消息，不改写 session journal、不撤销输入，也不终止 Run；需要停止工作时仍必须使用明确的取消或 scope cleanup 语义。

## 模型目录与授权

Runtime 从锁定的 Pi 元数据计算受支持模型，校验 provider、API 类型和固定 endpoint。请求不能覆盖 base URL 或 API 类型。Python 使用当前 OAuth 凭据获取账号可用目录，并只向产品暴露供应商目录与 Runtime 能力目录的交集；供应商结果不能扩展可执行集合，Runtime 结果也不能扩展账号权限。

模型清单会随锁定依赖和供应商账号目录改变，设计文档不得复制静态 ID、退役名单、默认版本或辅助模型优先级。所有 OAuth provider 的 Runtime `default_model` 固定为空，推荐顺序完全由账号目录决定。账号尚未完成 OAuth、当前凭据从未成功取得目录，或安全交集为空时，产品目录为空且自动选择明确失败；同一凭据最近一次成功目录可以带 stale 标志继续使用，不能回退为完整 Runtime 清单。数据库中的明确选择可以作为尚未改写的 Run 意图保留，但不能因此取得 Token 或绕过执行前的当前交集复验。

Python 在调用时向内部授权端点请求当前访问凭据，并同时复验请求中的具体模型仍属于该账号目录。视觉辅助模型只按同一 provider 的 Pi 输入能力动态枚举，再通过这项账号目录复验选择；不能按模型名称或版本写优先级，也不能因主模型已获授权而给另一个隐藏模型复用 Token。OAuth token 不写入 Run metadata、session 或事件日志。

## 工具与执行目标

Runtime 提供 terminal、process、read_file、write_file、patch_file、search_files、todo、memory、skill、mcp、web、browser、mail、schedule、session、session_search 和 delegate_task。

`skill` 与 `mcp` 都以当前主 Agent 的工作区为唯一用户配置源。用户 Skill 位于 `/workspace/.agent-platform/skills/<skill-id>/SKILL.md`，MCP 清单位于 `/workspace/.agent-platform/mcp.json`，本地 MCP 包与虚拟环境位于 `/workspace/.agent-platform/mcp/<server-id>/`。Platform 系统规则必须要求 Agent 把面向 Claude Code 等其它客户端的 `.claude/skills`、`.claude/skill`、`.mcp.json` 或用户 HOME 安装步骤重定向到这些路径，不能同时维护第二份配置。工作区路径已经按私人或频道主 Agent 隔离；委派 Agent 继承父主 Agent 的同一配置。

用户 Skill 的 `list/load/read` 每次从盘读取，Run 开始时的有界 Skill 索引只在下一 Run 重建；MCP 的 `list/call` 每次重新读取并校验清单。因此保存后无需 watcher、reload API 或重启，当前 Run 可以显式读取新 Skill/MCP，已经发送给模型的工具 schema 与提示前缀则不在半轮中改写。直接安装的可移植 Skill 可以只有合法的 `SKILL.md` 和支持目录；Platform 首次扫描时先完成既有路径、大小、frontmatter、提示词注入与明文凭据校验，再原子补齐 `user-owned + active + enabled` 的平台 sidecar 和 usage 状态，不能把缺少平台私有文件误报为包损坏。仓库预置 Skill 仍是发布镜像中的只读层。

`todo` 是当前 Runtime session 内的结构化执行清单，不是平台业务任务、计划任务或长期记忆。它只用于预计至少三个彼此独立、可追踪的执行步骤，或用户一次提出多个可分别完成的任务。直接回答、单一动作和一两个简单步骤直接执行；围绕同一个小改动的例行读取、修改与聚焦验证是一条线性工作，不为了形式拆成清单。执行中发现任务已经演变为这类复杂工作时可以再创建清单。

模型可以读取、整体替换或按稳定 id 合并至多 256 项 `pending|in_progress|completed|cancelled` 任务；每项正文有界。创建清单后，模型同一时刻只保持一项 `in_progress`，开始具体工作时及时更新，工作确已完成并经适当验证后立即标记 `completed`，放弃的工作标记 `cancelled`，仅为执行中新发现且确属必要的工作追加项目。Runtime 不自动创建 todo；空清单不向系统提示注入 todo 策略，选择门槛由稳定工具 schema 说明引导。权威清单保存在 Runtime-owned session sidecar，工具结果只作为模型可见审计副本，不能从 caller seed、用户正文或未配对的历史工具结果恢复授权状态。压缩只重新注入 `pending` 与 `in_progress` 项。普通 Run 准备结束时仍有活动项，且没有可验证的外部 blocker 时，Runtime 必须要求继续执行或显式更新状态；有界延续预算耗尽后只要仍有活动项，本 Run 就必须进入 `needs_review`，即使尚未记录其它副作用，也不能把未完成任务记为 `completed`。真实 blocker 对应的活动项保持原状态，供下一次同 session Run 恢复；只有全部项均为 `completed` 或 `cancelled` 时才允许正常完成。

Runtime 因未完成 todo、尚未观察到终态的有限后台任务或缺失 recurring occurrence 决策而机械转入 `needs_review` 时，必须保留模型最后一段非空、非 Runtime 临时指令的阶段性说明作为有界诊断结果，并在 `run.needs_review` 终态中同时携带该内容与明确 blocker。这个结果只表示“停止位置与已有进度”，其 Run 状态、持久幂等状态和 Platform durable job 都必须继续是 `needs_review`，不得因存在 `result` 或正文而升级为 `completed`。诊断结果不得恢复或发布 `MEDIA:` 交付标记；需要复核的 Run 没有附件交付权。

模型可见的 assistant tool call 参数必须始终保持对应活动工具 schema 的规范形状；审计展示对象与模型历史使用不同的序列化边界，不能把 `tool` 名称或其它展示字段写回下一轮上下文。读取旧 session 时只允许在内存模型副本中收敛精确匹配的历史展示 envelope，未知字段、身份字段或不匹配工具名继续由严格 schema 拒绝，原 JSONL 不改写。敏感值替换仍须满足字段的枚举、正则和路径约束；允许任意 JSON 的浏览器提取 schema 必须同时限制深度、条目、节点和字符串大小。

Codex OAuth 的可信模型目录固定到 `openai-codex-responses` API，因此 Runtime 可以消费 Pi 从 `response.function_call_arguments.delta` 形成的逐步解析工具参数。只有这条 provider/API 路径的 sandbox `write_file` 与 `patch_file` 可以产生文件草稿投影：前者取正在形成的 `content`，后者只取 `new_text` 并标记为替换片段。为同时保证缺省 sandbox 调用可实时投影、尚未闭合的参数又不能先误判最终 host 调用，这两个工具只在 Codex OAuth 暴露给模型的 schema 中要求显式 `target`；执行兼容层仍在 schema 校验前把完整调用中意外缺省的 target 补成 sandbox，其它 provider 与其它工具的默认 target 契约不变。Runtime 不转发原始 JSON delta，也不把未完成参数交给校验、审批或工具执行；它对完整累积字符串做凭据形状脱敏、保留尾部安全窗口、按总量有界的检查点发布 `tool.arguments.delta.file_draft`，并在 `toolcall_end` 发布最终草稿版本。前端可以在两个权威累积版本之间平滑揭示已经取得的字符，但不能借此缩小安全尾部、转发原始 fragment，或把动画进度说成新的 Runtime 版本。草稿事件必须携带稳定 tool call identity、规范 `/workspace` 相对路径、单调 revision、内容类型、完成与截断标记；`target=host`、工作区外路径、其它工具、其它 provider/API 和没有安全路径的增量只保留无正文进度标记。文件仍只在完整参数通过 schema 与策略后由原工具原子提交，草稿不得建立副作用或执行授权。

terminal、process 与文件工具的默认 `target` 是 `sandbox`。每个顶层 Run 接收由 Platform 解析的稳定主 Agent identity；委派 Run 必须继承它，模型不能构造其它 Agent identity。Runtime 把已规范化 cwd、路径、命令、环境和 deadline 发给管理器；管理器创建或唤醒对应 Sandbox，并在容器固定路径 `/workspace`、`/home/agent` 与 `/opt/agent-env` 下执行。Runtime 只消费有界输出和进程句柄，不把管理器控制 socket或容器身份暴露给模型。有限后台 task 的 Manager 私有请求额外携带由 Runtime 对 scope/lifecycle/session 计算的固定摘要和 `completion_required`；这不是模型参数，也不暴露 session 原文或 `background_kind`。

Runtime 不创建、修复或推断宿主 workspace。每条 scope/runtime identity 对应的 workspace、当前 marker 与 alias 必须在接受 Run 前完整存在并匹配；任何未物化、缺失、旧格式或身份漂移都失败关闭，普通更新和恢复也没有放宽入口。

用户上传的安全位图由 Platform 作为有界 image block 内联，不要求中央 Runtime 挂载 Platform 数据。其它上传附件使用 `/workspace/.agent-platform/attachments/...`；Manager 在当前 scope 的只读附件挂载中解析。Runtime 不对中央容器不存在的宿主路径执行 `realpath`，也不能把一个 scope 的附件当成另一个 scope 的当前附件。

Agent 生成的用户交付文件必须先写入当前 `/workspace`，再在最终回复中使用平台文件回传标记 `MEDIA: /workspace/<relative-path>`。受支持后缀包含既有交付格式以及 `.html` / `.htm`。XLSX、DOCX、PPTX 与 PDF 的聊天预览由 Platform 从已授权附件即时生成，不属于 Runtime 协议或模型上下文。用户可见的「AI 的电脑」是 Platform/前端对既有 `read_file` / `write_file` / `patch_file` / `search_files` / `terminal` / `process` / `web` / `browser` 生命周期以及工作区 HTML 写出或 HTML `MEDIA`/附件的投影；本版本不得新增呈现、桌面或静态站点 Runtime 工具。HTML 页面若要在电脑槽位渲染，由 Platform 按当前 scope 读取该文件或附件，不经过新的 Runtime 调用。该路径是 Sandbox 逻辑路径，不是中央 Platform 容器中的同名路径；Platform 只能把精确的 `/workspace` 后代映射到当前可信 scope 的 `workspace_path`，并从已固定的工作区根目录 fd 逐段以不跟随符号链接的方式打开，最终从同一文件 fd 完成身份、数量、单文件和总字节校验与读取，不能在检查后重新解析路径字符串。Platform 是把该标记转换为消息附件的唯一边界，Runtime 不能把任意宿主路径或纯文本文件名伪装成附件。如果 Runtime 在含交付标记的回复后自动追加内部文件复验，只有相关变更已由成功的复验工具清除时，才把被隐藏中间回复中的规范 `/workspace` 标记去重保留到 Run 终态 output；复验失败或仍有未确认变更时不得恢复标记，成功复验则不能让已声明的交付物消失。两种情况都不能跳过 Platform 校验。内置表格、文字文档、演示稿和 PDF Skill 应在相应产出请求中主动使用，默认交付 XLSX、DOCX、PPTX 或 PDF，而不是仅返回 Markdown 表格、代码片段或“文件已生成”的文字说明。Skill 必须把视觉质量作为交付条件：根据用途选择专业且克制的主题，建立一致层级、间距、对齐和色彩，避免默认库样式直接外露；同时要求生成后进行内容、结构与格式专属布局校验，清理自身临时产物并保留最终文件。

模型在一次 Run 中发出的、随后因真实工具调用而结束的阶段性说明属于用户已经看见的工作过程。Platform 必须在不改变 Runtime 流协议的前提下，将这些已结束的文本段与工具首次调用写入同一条带严格递增序号的时间线；工具更新按 `tool_call_id` 原位合并，最终消息的 `agent_work.activity` 直接从该时间线生成，不能用秒级时间重新排序或静默截取尾部。Platform 还可从已经过 journal 脱敏的工具参数和结果投影闭世界 `parameters` 与有界 `result`，供展开详情使用，但不能把 Runtime 事件原文、邮件正文或跨会话搜索原文写入消息 metadata。当前仍活动的最终回答不属于过程文本，不能在 metadata 中复制。没有真实工具事件时仍不得生成工作记录。异常事件或正文触发 Platform 的有界防滥用限制时必须携带明确的省略计数。

模型可为单次 terminal、process 或文件调用显式选择 `target=host`。Sandbox 命令不等待人工审批；terminal、process 与文件工具的宿主目标都必须逐次取得用户批准，并且只提供本次批准或拒绝，不能创建 session/permanent 规则。批准后管理器以部署用户在宿主机执行，并允许该用户已有的免密 `sudo`。每次调用仍必须在执行前发出可见审计事件，包含未经隐藏的实际命令参数或 canonical 文件路径、目标、cwd 和超时；凭据只做安全脱敏。宿主执行不能复用为后续调用的隐式授权，也不能把 host 变为 Run 默认值。

Sandbox/host 两个目标都执行不可绕过的 hard-block、路径规范化、参数上限、凭据脱敏和输出上限。Sandbox 是工作环境隔离，不是恶意租户安全边界；host target 等同授予本次调用部署用户权限。Docker socket、管理器状态根和宿主凭据目录始终由管理器拒绝，即使请求 `target=host`。

Runtime 的批准对象绑定原始调用参数、主 Agent Sandbox identity 和规范化逻辑路径；Manager 是宿主映射的最终可信边界。Manager 必须把 `/workspace`、`/home/agent`、`/opt/agent-env` 或绝对宿主路径解析为不可变的根与相对路径，从根目录 fd 逐段以不跟随符号链接的方式打开。文件 read/write/patch/search 与 terminal cwd 都不能在检查后重新按字符串解析；patch 在同一个已固定父目录中完成读取与原子替换，terminal 子进程从已固定目录 fd 切换 cwd。审批后路径被替换为符号链接、非目录或受保护路径时，本次调用失败且批准不可复用。

来自网页、浏览器、MCP、记忆、session 和 Skill 附件的模型可见文本由 Runtime 统一包装为防伪的不可信工具结果。包装函数必须重建文本块、中和攻击者提供的边界 token，并保留图片块；各工具不能自行拼一个可被内容提前闭合的提示前缀。这个边界同时适用于成功返回和上游失败文本。

`mcp` 是固定的通用工具，不把每个外部 server 的动态 schema 注册为新的顶层 Runtime 工具。`list` 返回当前清单中的 server 和其 `tools/list` 有界结果；`call` 接受清单内 server id、tool name 与有界 JSON arguments，并逐次请求用户批准。Runtime 通过 Manager 在当前 Sandbox 内调用镜像自带的一次性 stdio 客户端；客户端以 argv 而非 shell 启动清单中的命令，完成 `initialize → notifications/initialized → tools/list|tools/call` 后退出。清单、命令、环境、工作目录、协议消息和返回体都有大小、数量、路径与超时上限；server stderr 和不匹配的 JSON-RPC 消息不能越过工具结果边界。模型不能为一次调用改写 command、env、cwd、URL、owner、scope 或 transport。首版不实现 Streamable HTTP、OAuth、resources、prompts、sampling、elicitation、持久连接或后台 server；需要这些能力时由用户安装一个本地 stdio 适配器。

terminal 的前台进程在其有界工具 deadline 内以显式执行生命周期保持 Run 活动，不能只依赖与空闲 watchdog 竞争的定时心跳；有明确终点且能在工具上限内结束的复制、转换、扫描和批处理必须优先以前台方式执行，并给出足够的 `timeout_ms`。`background=true` 时模型还可以声明 Runtime-only 的 `background_kind=task|service`，省略时固定为 `task`；非后台调用不得携带该字段。`task` 表示当前 session 必须确认终点的有界工作：Runtime 从成功的 terminal 结果把 process id、执行 target 和登记时间写入独立、owner-only、原子替换且绑定精确 scope/lifecycle/session 的责任 sidecar；只有同一 session 的 `process.wait|read|kill` 对同一 id 与 target 返回 `completed|failed|cancelled` 才解除。wait timeout、`running`、`orphaned`、Runtime 重启或上一 Run 进入 `needs_review` 都不算完成。后续 Run 必须从 sidecar 恢复并以可信 Runtime 状态注入这些责任。模型试图在仍有活动 task 时结束，Runtime 进行有界延续并要求 `process.wait`，预算耗尽后强制 `needs_review`，即使没有其它副作用也不能报告成功；sidecar 损坏或身份漂移同样失败关闭。`service` 表示用户确实要求独立存续的长期服务，不登记完成责任且不阻止 Run 结束，但模型仍应检查其就绪状态。`background_kind` 本身不发送给 Manager；Runtime 只为 task 派生闭合的 completion-required 元数据，Manager 的执行绑定和审计仍只依据规范 command、target、cwd、background 与 timeout。

为关闭“Manager 已启动 task、Runtime 尚未登记 sidecar”之间的崩溃窗口，Manager 必须在启动命令前先持久化 completion-required intent。每次普通 Run 读取 sidecar 前，Runtime 以精确 scope/lifecycle/execution context 和 session 摘要向 Manager 对账未确认 task，并把缺失项原子登记后才允许模型运行；因此重启恢复不会把同一用户动作当成尚未执行而重复。Manager 不按普通一小时/数量规则裁剪未确认 task 的活动或终态记录。Runtime 得到权威终态时先把本地责任从 `active` 原子改为 `resolved` tombstone，再向 Manager acknowledge；Manager 确认后 Runtime 才删除 tombstone。任一边界崩溃后，下次对账都只会重试 acknowledge 或重新观察既有进程，不会重跑命令或伪造成功。只有 acknowledge 成功后该终态才进入普通有界裁剪。

后台模式用于需要独立句柄的长任务或服务；当前 Run 仍要等待其结果时，必须调用 `process.wait`，不得创建 interval/cron 计划来轮询本 Run 启动的进程。只要当前 session 仍有活动 task 责任，Runtime 的工具策略就必须在任何 Platform 调用或审批前拒绝 `schedule.create`；取得权威终态并解除全部责任后恢复允许。显式 service 不登记责任，因此不触发这项限制。`process.wait` 在精确 scope、lifecycle、target 和 process id 上长轮询至终态或调用超时：自然终态返回最终有界快照，等待超时返回仍在运行且不终止进程，取消会立即中断等待；等待全程暂停 Run 空闲保护，但不放宽模型轮次或进程 deadline。读取、等待和预览不会消费终态，重复等待同一已结束进程立即返回相同权威快照。

todo、有限后台 task 或 recurring occurrence 决策的机械完成守卫结束当前 Run 时，不等同于用户取消执行。若终态是由这些守卫产生的 `needs_review`，Runtime 只把当前 session 责任 sidecar 中仍活动且属于本 Run 的精确 task process id 作为保留集合交给 Manager；Manager 必须清理同 Run 的其它前台进程和未登记后台进程，只允许该闭合保留集合跨 Run 存续。显式用户取消、Run 空闲超时、scope cleanup、无法读取责任 sidecar或其它真正的取消/异常终止一律使用空保留集合并执行完整清理。模型不能提供、扩大或修改保留集合，service 分类也不能借机械守卫获得隐式保留权。

scope cleanup 是对整个 scope family 的显式取消边界，不是允许 task 跨停机继续的普通 Run 守卫。Runtime 必须按 root scope/lifecycle 调用 Manager 的 family cleanup，不能依赖进程内 execution-context 映射发现进程。Manager 接受 cleanup 后必须先安装 family/lifecycle admission fence：拒绝同一边界内尚未进入启动临界区的新 terminal start，并等待已进入临界区的 start 原子地登记到进程清单或退出，之后才允许快照、evidence 上限预检和停止；fence 必须保持到 cleanup 返回，不能阻塞相邻 scope family 或其它 lifecycle。重叠 cleanup 要么共享同一次闭合结果，要么有界拒绝，不能并发穿透；等待时不得持有会阻止 start 完成登记的锁。Manager 确认全部进程已经停止后，把仍未确认的 completion task 身份作为有界闭世界 evidence 返回并保持记录 pinned；不能在 Runtime 本地提交前擅自 acknowledge。Runtime 通过责任存储自身的串行化删除路径清除精确 scope family/lifecycle 下所有有限 task sidecar，永久 scope reset 则删除整个 session family；本地提交成功后才逐项确认 Manager evidence，最后清除内存 context。任一阶段崩溃或失败后，同一 cleanup 可从 Manager 保留的 evidence 幂等重试，避免 pre-start intent 因 Runtime 尚无 sidecar/context 而漏清，也避免 Manager 已裁剪而 Runtime 留下幽灵责任。

后台进程立即返回并由对应 Sandbox 登记。Manager 是生产进程清单的唯一权威：同一主 scope 与其 `/delegate/` 子 scope 组成一个进程 family，共享同时运行上限，root cleanup 必须停止整个 family；单进程读写、等待和终止仍要求精确 scope，不允许越权访问子 Agent 句柄。cleanup 或显式终止报告已确认前，不仅要观察到进程终态，还必须等待对应控制器完成输出快照、持久状态、Sandbox 活动计数和终态裁剪；返回后不得再由该进程的 wait/watch goroutine 写入 scope 数据。进程输出、历史记录和同时运行数量有界；终态记录按时间和数量双重裁剪，但不得裁剪 `running` 或 `orphaned`。预览优先返回活动进程，其不透明 revision 在状态或输出变化时必须变化，Manager 重启后旧 revision 必须失效。Run 空闲、模型轮次、terminal 默认超时和单次 process wait 上限的精确跨层值见 [`runtime-policy.json`](../contracts/runtime-policy.json)；Sandbox 空闲值见 [`container-platform.json`](../contracts/container-platform.json)。

计划任务只用于真正基于时间的提醒、周期报告或与当前 Run 无关的未来检查，不能充当本地进程 watcher。Platform 对计划唤醒的 Run 签发可信 `schedule_id`、`schedule_run_id` 与布尔 `schedule_recurring`；后者只在当前权威定义为 interval/cron 时为 `true`，once 固定为 `false`，模型和调用方不能自行选择。当前顶层 recurring occurrence 结束前必须成功调用且只能以空参数调用 `schedule.continue_current` 或 `schedule.complete_current`：前者只原子复验并确认本轮保留下一次执行，不修改计划；后者原子结束本次所属计划，清除 `enabled/next_run_at`，使并发排队的旧 occurrence 失效。两者都不能选择目标 id 或取得其它计划权限，重复调用和竞态按当前 occurrence 身份幂等或失败关闭。

Runtime 不从最终回复中的“继续”“完成”文字猜测决策。recurring Run 准备结束却没有成功的 current-occurrence 决策时，它有界追加明确 follow-up；预算耗尽仍无决策则进入 `needs_review`，不能完成。once occurrence 不要求这项决策并继续在 dispatch 后自动结束。Platform 将 scheduled occurrence 的 `needs_review` 或授权 `blocked` 与“暂停所属当前 revision、关闭 enabled、清空 next_run_at”放在同一事务；重复恢复和迟到写入不得重开计划。这样一次模型遗漏至多产生一条需要关注的结果，不会继续按间隔刷屏。

## 会话与压缩

这里的 session 是 Runtime JSONL 模型上下文，不是浏览器登录 Cookie。登录态寿命由 Platform 认证策略决定，不因 Runtime 压缩、修复或删除模型 session 而改变。

每条模型或工具消息先追加到带 scope、lifecycle、session 身份的 JSONL journal。上下文超过策略阈值时，Runtime 先按合法 user/assistant/tool 边界保护最近 tail，并用当前已授权模型把待省略历史更新成一个结构化 handoff。首轮自动压缩后，Runtime 可以复用“handoff + tail”的模型投影，但每次新增消息后都必须重新计算该投影的上下文用量；同一 Run 的长工具循环再次越过阈值时必须再次自动压缩，不能因为已有 handoff 永久绕过阈值判断。后续压缩把上一轮 handoff 作为不可信历史迭代更新，只保留一个现役 handoff，旧 handoff 不写入 archive。摘要模型输入在总字符预算内必须为最早目标/验收条件和待省略段中最新用户请求分别预留首尾有界锚点，再把其余预算按时间倒序分给最近工具证据；大量工具输出不能把原始目标完全挤出摘要输入。摘要必须保留最新未完成用户请求、验收条件、已完成动作及证据、决策与约束、文件和关键工具结果、blocker、下一步，以及 Runtime-owned 活动 todo/process 状态；旧摘要采用迭代更新而不是作为普通历史重复堆叠。历史正文和既有摘要都属于不可信数据，不能授予工具、审批或身份。Runtime 使用同一集中敏感文本清洗器同时处理发送给摘要模型的历史和模型返回的摘要，覆盖常见供应商 Token、认证头、JWT、私钥、带密码连接串、敏感配置字段与 URL 参数；原始 journal/archive 仍按会话访问边界保存真实历史，不能把清洗后的摘要反向当作原文替换。摘要输出有独立大小上限；摘要请求失败、被取消、为空或不合法时，本次压缩不改活动 journal，也不丢任何上下文，已经安全提交的上一轮压缩保持有效。

摘要成功后，被省略的已持久消息先 fsync 到去重 archive，再原子替换活动 journal。archive 追加前必须按写入后的 UTF-8 总字节执行上限检查，不能先写过界再让后续读取永久失败；没有稳定 entry id 的消息不得被压缩。Runtime-owned todo sidecar 不依赖模型摘要，活动项以独立可信段重新注入；完成和取消项保留在 sidecar 审计中但不占后续模型上下文。

`/compact` 是 Platform 调用的会话控制操作，不是模型输入。Runtime 只接受严格的 scope、lifecycle、session、模型和内部 Gateway 身份；当前身份存在 queued/running Run 时拒绝，在会话锁内复用自动压缩的同一摘要、边界计算、archive 去重与 journal 原子替换。活动消息不足以安全省略时返回成功但 `compacted=false`，不创建伪消息；内部摘要必须用 journal entry 的 Runtime-owned 结构化标记识别，不能从用户可伪造的正文推断。连续调用不得把上一轮内部摘要当作用户历史再次归档，也不得无新历史时增长 journal 或 archive。被省略的历史仍可由 `session` 搜索。命令执行期间的新 Run 必须由同一身份门闩隔离，不能与摘要调用或 journal 替换竞态。该同步控制请求使用独立的长模型调用 deadline；客户端断开或 deadline 在模型摘要及提交准备阶段会取消本次操作并释放门闩，不改 archive/journal。一旦越过最终提交点，Runtime 忽略迟到断线并完成有界的 archive-first 原子替换后再释放门闩，不能停在活动 journal 已替换但 archive 缺失的状态。

中断留下的孤立 tool call 会在恢复时修复并发出 `session.repaired`。`session` 工具搜索当前 session 的活动 journal 和 archive；跨产品会话的 `session_search` 由 Python 提供。二者返回的历史都必须标记为不可信数据，而不是指令。

## 记忆与技能注入

顶层 Run 启动前，Runtime 尝试召回当前 Agent scope 内的 Agent 记忆和用户资料记忆；失败不阻止 Run。两个 target 都不能跨 Agent 召回；共享资料由用户放入明确共享的外部系统或频道文件，而不是借记忆跨 Agent 传播。注入采用独立字符预算、完整记录边界和明确的不可信数据标签。

只有规范私人、顶层、交互式 Run 可以自动写入或整理正式记忆，不再经过候选审批。记忆只保存稳定身份、长期偏好、持续约束和跨会话有价值的事实；任务进度、临时 TODO、一次性路径或当前回复内容不得写入长期记忆，重复或过时事实应合并或替换。计划任务、邮件唤醒、频道和委派 Run 默认只读记忆，不能被外部内容诱导修改。可用技能只在系统提示中注入精简索引；完整 `SKILL.md` 及支持文件必须由 Agent 按需加载。

每个主 Agent 的系统提示同时说明 Sandbox 逻辑工作区 `/workspace` 和由可信部署配置派生的当前宿主映射。Agent 默认在工作区创建并保存交付物，保持目录有序，并在确认无用后清理自己产生的临时中间文件；不得以“整理”为由删除上传附件、用户文件或含义不明的内容。提示还明确给出 Skill/MCP 标准路径和重定向规则：收到其它客户端的安装说明时只提取可移植包、命令与参数，改写目标路径到 `.agent-platform`，不创建 `.claude` 等影子配置。宿主映射只用于帮助理解路径关系，不改变 Sandbox 默认执行目标，也不进入公共状态、数据库或普通工具 metadata。

## 学习复盘 Run

Platform 可创建 `metadata.review_mode=memory_skill`、`trigger=learning_review`、`unattended=true` 的内部 Run。Runtime 只在规范私人顶层 scope、无 parent/delegation、带正整数 `review_job_id` 和来源消息，且 `session_id=learning-review-<review_job_id>`、`metadata.idempotency_key=agent-learning-review:<review_job_id>` 时接受该组合。`learning-review-<正整数>` session 和 `agent-learning-review:<正整数>` 幂等命名空间只保留给完整复盘身份；普通 Run 即使不声明 review metadata 也不能占用。校验发生在排队和 session 初始化前；普通请求不能通过单独设置字段或借用普通 session 取得复盘权限。Platform 提交复盘时必须进入与普通 Run 相同的每 scope lifecycle start barrier，在持有门闩时立即重验账号、权限、lifecycle、来源消息和 running job，并把门闩保持到 Runtime 明确接受 Run。停用、撤权或显式 lifecycle reset 必须终结该 scope 的 queued/running 复盘任务，并在同一 lifecycle 门闩下清理先于 reset 被接受的 Run。接受回调再次发现 job 或 lifecycle 已失效时还必须终结 job 并取消该 Run，使旧 lifecycle 的复盘不可在清理完成后留存。

复盘沿用 Hermes 的“先交付回复，再独立审查”原则，但使用平台持久任务而不是进程内 daemon。它使用独立 session 和有界近期历史，不接受追加输入，不委派，不显示流式内容，也不写父 session；终态后 Runtime 精确删除该临时 session。复盘每次最多发起 `16` 个模型 turn；若全局 `maxTurnsPerRun` 更小则取较小值，不得通过调高普通 Run 上限扩大这条免审批自动写路径。每个 review job 另有由 Platform 权威执行且跨重启保留的二十单位总变更预算：memory 单动作、reconcile 子动作和 Skill create/patch 共享计费，读取免费；工具说明与复盘系统提示必须明确该限制，Runtime 自身不能把一次 reconcile 错算成一次。前台工具轨迹只保存有界、安全摘要；`skill.load` 与 `skill.read` 必须保留严格校验后的 Skill id，使复盘能优先检查本轮实际使用的 Skill，`skill.read` 可附安全相对文件路径，但 Skill 正文、patch 内容和工具结果不得进入轨迹。工具集合硬限制为 memory 与 skill：memory 可读并可 `store|replace|forget|reconcile`，不能 clear；skill 可 `list|load|read|create|patch`，现有 Skill 必须先在同一 Run load/read。terminal、process、文件、web、browser、mail、mcp、schedule、session 和 delegate 都不存在于模型工具表。

复盘中的 memory/skill 允许动作不弹用户审批，但 Runtime Gateway 必须在 memory 读写和全部 Skill 请求中透传完整的可信复盘主体：parent/delegation、trigger、unattended、review mode/job、owner、source message、scope 和 lifecycle。Python Gateway 在任何记忆查询、Skill 读取或写入之前都必须反查对应 `agent_learning_review` durable job 仍在 running，并重新校验账号激活与权限、owner、canonical scope、lifecycle 与 source message；旧 lifecycle、终态 job 或已撤权账号发出的延迟读请求必须在访问数据前以 403 失败关闭。复盘 Skill `list/load/read` 的最终复验、文件读取和 read-ledger 登记处于同一个 lifecycle gate 与 `BEGIN IMMEDIATE` 边界内，但不扣变更预算。Skill 创建来源由 Gateway 标为 agent；patch 只能作用于未 pin、active 且 agent-owned 的包。任何校验失败、模型失败或临时 session 清理失败都不能撤回或改写前台回复，也不能递归触发另一轮学习。

## 委派

委派深度和整棵顶层 Run 委派树的总创建数量受策略限制。`delegate_task` 接受一个任务或有界 `tasks[]`；批量任务在同一父 Run 内受限并发执行，结果按输入顺序合并，父 Run 必须等待全部子 Run 终态。每层不能各自重新取得一份数量预算；Runtime 从可信的内存父子关系定位根 Run，并让所有后代原子共享根预算，模型 metadata 不能补充或重置余额。全局同时活动的子 Run 还受同一策略值派生的 admission cap 约束；达到上限立即拒绝新子 Run 而不排队等待，避免多个顶层 Run 放大并发，也避免持有执行槽的 orchestrator 相互等待形成死锁。父取消仍会取消所有已经创建的后代。委派 scope/session 是临时执行上下文，子 Run 终态后会被整体清理，因此子 Agent 不得启动任何后台进程；Runtime 必须在产生副作用、请求审批或调用 Manager 前稳定拒绝 `background=true`，子 Agent 需要等待的命令必须以前台方式完成。

子 Agent 始终继承 Platform 为父 Run 建立的可信系统提示与安全策略；父模型只能提供作为用户任务数据传入的 `prompt`，不能替换或追加子 Agent 的系统提示。默认子 Agent 是 leaf，不再获得委派工具；只有父 Agent 显式请求且仍处于深度与根树总预算内的 orchestrator 子 Agent 才能继续委派。这样避免无意递归和提示词提权，同时保留复杂任务的分层编排。

子 Agent 使用派生 scope 和独立 session，但继承父主 Agent 的 Sandbox、workspace、HOME 与 env；临时记忆和浏览器身份仍按子 scope 隔离。并行任务默认用于相互独立的读取、分析或不同输出，多个子 Agent 不得并发修改同一文件或共享外部对象。子 Run 的模型输出、工具活动、`process.wait` 和压缩要向父 Run 传播活动，避免父 Run 被误判无进展；父取消会取消所有仍活动子 Run。

子 Agent 的成功结果是待复验的自述。Runtime 在 `delegate_task` 结果中加入由自身生成、不能由模型填写的 child id、是否已开始副作用、已知变更文件和未知变更标记；批量结果逐项保留该证据。只读子 Run 不增加父 Run 的完成条件；任一成功子 Run 开始过副作用，则父 Run 在该委派之后至少执行一次成功、非 `delegate_task` 的聚焦验证工具才可完成。已知文件优先复用 read/search/针对该路径的 terminal 检查，未知或外部变更保守要求综合 terminal 验证。自然语言声称“已检查”不算证据；Runtime 有界提示后仍没有成功验证时强制 `needs_review`，新一批带副作用的委派会使旧验证失效并要求再次复验。

## 停止与恢复

用户取消、scope cleanup、管理器执行断开和无进展保护都会中止模型与当前前台工具。Runtime 等待有限清理窗口；如果发生副作用且无法确认安全终止，则使用 `needs_review`。后台服务属于 Sandbox 生命周期，不因单个 Run 完成而停止；当前任务启动但尚未观察终态的有界后台进程不是“完成”，模型必须等待、明确转为独立服务，或进入可恢复的复核状态。管理器根据任务和进程登记决定空闲回收。

普通 Run 只有在没有活动 todo、没有尚未观察完成的有界进程、文件变更已经聚焦验证且不存在未解决的执行承诺时才可完成。Runtime 可以有界追加模型 follow-up 要求继续执行或修正 todo；follow-up 预算耗尽不能把原来的进度陈述升级为成功。真实需要用户输入、授权或外部状态变化时应明确说明 blocker；可能已有副作用而无法确认结果时使用 `needs_review`。

Runtime 没有活动任务的固定墙钟上限。无进展保护、模型轮次上限和 terminal 默认超时的精确跨层值由 [`runtime-policy.json`](../contracts/runtime-policy.json) 定义。审批、请求体、清理和保留等其它边界由[配置参考](../reference/configuration.md)列出，并由 Runtime 配置测试校验。

## 验证稳定性

Runtime 的 Node 测试文件并发数固定为 4，避免共享 CI runner 的调度竞争饿死短时异步观测。等待 journal 事件等测试条件的观测预算可以高于产品超时，但测试不得借此放宽产品配置值或删除对应时序与终态断言。
