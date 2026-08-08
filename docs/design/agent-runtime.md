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

Python Platform 拥有账号、产品消息、OAuth refresh token、记忆、知识、技能、计划、邮箱和浏览器业务接口。宿主管理器拥有 Sandbox/host 进程、文件执行和容器生命周期。Runtime 不复制这些状态，也不访问 Docker socket。

Platform 还拥有当前部署的公开品牌投影，并把经过校验的 Agent 显示名称作为闭合结构化数据写入系统提示。Runtime 和工具说明使用中性 `Agent` 术语，不固化源码维护方名称，也不把品牌文本解释为指令、权限或内部 identity。

邮件唤醒的 durable Agent job 只保存 Platform 权威源消息引用；Platform 在队列调度和重启/中断恢复边界严格校验该引用后，在内存中重建有界预览任务再提交 Runtime。Runtime 不从 job 键、邮件正文或其它文本猜测账户与 scope 身份。

## Run 状态机

顶层 Run 先进入 FIFO 并发队列，再依次经历 `queued`、`running` 和一个终态。终态为 `completed`、`failed`、`cancelled` 或 `needs_review`。只有顶层 Run 消耗全局并发名额；委派子 Run 共享父 Run 的执行槽、Sandbox 与工作区，但保持派生 scope、独立 session 和事件。

创建请求的 `idempotency_key` 在 `scope_key` 内唯一。终态结果原子保存；重复创建返回既有 Run。重启时发现已经开始但没有终态的幂等 Run，必须返回 `needs_review`，不能自动重做。

私人交互 Run 可以接收追加输入。输入按 message id 持久化并返回 accepted、injected 或 unconsumed；只有模型循环确认注入后，Platform 才能把该输入视为已消费。

产品界面对用户本人频道消息的撤回不属于 Runtime 取消协议。消息已经形成 durable job 或进入 Run 后，撤回只隐藏 Platform 产品消息，不改写 session journal、不撤销输入，也不终止 Run；需要停止工作时仍必须使用明确的取消或 scope cleanup 语义。

## 模型目录与授权

Runtime 从锁定的 Pi 元数据计算受支持模型，校验 provider、API 类型和固定 endpoint。请求不能覆盖 base URL 或 API 类型。Python 可调用供应商 OAuth 模型发现，但其结果只能与 Runtime 目录求交或作为可用性提示，不能扩展可执行集合。

模型清单会随锁定依赖升级而改变，设计文档不得复制静态 ID 列表。Python 在调用时向内部授权端点请求当前访问凭据；OAuth token 不写入 Run metadata、session 或事件日志。

## 工具与执行目标

Runtime 提供 terminal、process、read_file、write_file、patch_file、search_files、memory、skill、knowledge、web、browser、mail、sylver_platform、schedule、session、session_search 和 delegate_task。

模型可见的 assistant tool call 参数必须始终保持对应活动工具 schema 的规范形状；审计展示对象与模型历史使用不同的序列化边界，不能把 `tool` 名称或其它展示字段写回下一轮上下文。读取旧 session 时只允许在内存模型副本中收敛精确匹配的历史展示 envelope，未知字段、身份字段或不匹配工具名继续由严格 schema 拒绝，原 JSONL 不改写。敏感值替换仍须满足字段的枚举、正则和路径约束；允许任意 JSON 的浏览器提取 schema 必须同时限制深度、条目、节点和字符串大小。

terminal、process 与文件工具的默认 `target` 是 `sandbox`。每个顶层 Run 接收由 Platform 解析的稳定主 Agent identity；委派 Run 必须继承它，模型不能构造其它 Agent identity。Runtime 把已规范化 cwd、路径、命令、环境和 deadline 发给管理器；管理器创建或唤醒对应 Sandbox，并在容器固定路径 `/workspace`、`/home/agent` 与 `/opt/agent-env` 下执行。Runtime 只消费有界输出和进程句柄，不把管理器控制 socket或容器身份暴露给模型。

Runtime 不创建、修复或推断宿主 workspace。每条 scope/runtime identity 对应的 workspace、当前 marker 与 alias 必须在接受 Run 前完整存在并匹配；任何未物化、缺失、旧格式或身份漂移都失败关闭，普通更新和恢复也没有放宽入口。

用户上传的安全位图由 Platform 作为有界 image block 内联，不要求中央 Runtime 挂载 Platform 数据。其它上传附件使用 `/workspace/.agent-platform/attachments/...`；Manager 在当前 scope 的只读附件挂载中解析。Runtime 不对中央容器不存在的宿主路径执行 `realpath`，也不能把一个 scope 的附件当成另一个 scope 的当前附件。

Agent 生成的用户交付文件必须先写入当前 `/workspace`，再在最终回复中使用平台文件回传标记 `MEDIA: /workspace/<relative-path>`。该路径是 Sandbox 逻辑路径，不是中央 Platform 容器中的同名路径；Platform 只能把精确的 `/workspace` 后代映射到当前可信 scope 的 `workspace_path`，并从已固定的工作区根目录 fd 逐段以不跟随符号链接的方式打开，最终从同一文件 fd 完成身份、数量、单文件和总字节校验与读取，不能在检查后重新解析路径字符串。Platform 是把该标记转换为消息附件的唯一边界，Runtime 不能把任意宿主路径或纯文本文件名伪装成附件。如果 Runtime 在含交付标记的回复后自动追加内部文件复验，只有相关变更已由成功的复验工具清除时，才把被隐藏中间回复中的规范 `/workspace` 标记去重保留到 Run 终态 output；复验失败或仍有未确认变更时不得恢复标记，成功复验则不能让已声明的交付物消失。两种情况都不能跳过 Platform 校验。内置表格、文字文档、演示稿和 PDF Skill 应在相应产出请求中主动使用，默认交付 XLSX、DOCX、PPTX 或 PDF，而不是仅返回 Markdown 表格、代码片段或“文件已生成”的文字说明。Skill 必须要求生成后进行内容与结构校验、清理自身临时产物，并保留最终文件。

模型可为单次 terminal、process 或文件调用显式选择 `target=host`。Sandbox 命令不等待人工审批；terminal、process 与文件工具的宿主目标都必须逐次取得用户批准，并且只提供本次批准或拒绝，不能创建 session/permanent 规则。批准后管理器以部署用户在宿主机执行，并允许该用户已有的免密 `sudo`。每次调用仍必须在执行前发出可见审计事件，包含未经隐藏的实际命令参数或 canonical 文件路径、目标、cwd 和超时；凭据只做安全脱敏。宿主执行不能复用为后续调用的隐式授权，也不能把 host 变为 Run 默认值。

Sandbox/host 两个目标都执行不可绕过的 hard-block、路径规范化、参数上限、凭据脱敏和输出上限。Sandbox 是工作环境隔离，不是恶意租户安全边界；host target 等同授予本次调用部署用户权限。Docker socket、管理器状态根和宿主凭据目录始终由管理器拒绝，即使请求 `target=host`。

Runtime 的批准对象绑定原始调用参数、主 Agent Sandbox identity 和规范化逻辑路径；Manager 是宿主映射的最终可信边界。Manager 必须把 `/workspace`、`/home/agent`、`/opt/agent-env` 或绝对宿主路径解析为不可变的根与相对路径，从根目录 fd 逐段以不跟随符号链接的方式打开。文件 read/write/patch/search 与 terminal cwd 都不能在检查后重新按字符串解析；patch 在同一个已固定父目录中完成读取与原子替换，terminal 子进程从已固定目录 fd 切换 cwd。审批后路径被替换为符号链接、非目录或受保护路径时，本次调用失败且批准不可复用。

来自网页、浏览器、知识、记忆、session 和技能附件的模型可见文本由 Runtime 统一包装为防伪的不可信工具结果。包装函数必须重建文本块、中和攻击者提供的边界 token，并保留图片块；各工具不能自行拼一个可被内容提前闭合的提示前缀。这个边界同时适用于成功返回和上游失败文本。

`sylver_platform` 只出现在规范私人 scope。它使用固定 action union 回调 Platform，不允许模型提供网络位置、认证或所有权字段；读取动作无需审批，创建任务、开始任务、记录活动、Wiki 提案和普通审批评论只允许交互式 Run 并逐次审批。审批对象绑定完整参数；Runtime 在任何脱敏前按原始完整参数计算 UTF-8 大小并拒绝不可见控制字符，通过后才生成完整、脱敏的短正文展示。原始参数或展示投影任一超过审批上限都在调用前失败关闭，不能截断、仅显示长度或借脱敏收缩绕过。Runtime 在发送任何写动作前标记副作用，且不暴露审批决定、跳过审查、强制完成、员工管理、通用 HTTP 或破坏性删除动作。

terminal 的前台进程在其有界工具 deadline 内以显式执行生命周期保持 Run 活动，不能只依赖与空闲 watchdog 竞争的定时心跳；后台进程立即返回并由对应 Sandbox 登记。Manager 是生产进程清单的唯一权威：同一主 scope 与其 `/delegate/` 子 scope 组成一个进程 family，共享同时运行上限，root cleanup 必须停止整个 family；单进程读写和终止仍要求精确 scope，不允许越权访问子 Agent 句柄。cleanup 或显式终止报告已确认前，不仅要观察到进程终态，还必须等待对应控制器完成输出快照、持久状态、Sandbox 活动计数和终态裁剪；返回后不得再由该进程的 wait/watch goroutine 写入 scope 数据。进程输出、历史记录和同时运行数量有界；终态记录按时间和数量双重裁剪，但不得裁剪 `running` 或 `orphaned`。预览优先返回活动进程，其不透明 revision 在状态或输出变化时必须变化，Manager 重启后旧 revision 必须失效。Run 空闲、模型轮次和 terminal 默认超时的精确跨层值见 [`runtime-policy.json`](../contracts/runtime-policy.json)；Sandbox 空闲值见 [`container-platform.json`](../contracts/container-platform.json)。

## 会话与压缩

每条模型或工具消息先追加到带 scope、lifecycle、session 身份的 JSONL journal。上下文超过策略阈值时，Runtime 计算压缩计划；被省略的已持久消息先 fsync 到去重 archive，再原子替换活动 journal。没有稳定 entry id 的消息不得被压缩。

`/compact` 是 Platform 调用的会话控制操作，不是模型输入。Runtime 只接受严格的 scope、lifecycle 与 session 身份；当前身份存在 queued/running Run 时拒绝，在会话锁内复用自动压缩的边界计算、archive 去重与 journal 原子替换。活动消息不足以安全省略时返回成功但 `compacted=false`，不创建伪消息；内部压缩提示必须用 journal entry 的 Runtime-owned 结构化标记识别，不能从用户可伪造的正文推断。连续调用不得把上一轮内部压缩提示当作用户历史再次归档，也不得增长 journal 或 archive。被省略的历史仍可由 `session` 搜索。命令执行期间的新 Run 必须由同一身份门闩隔离，不能与 journal 替换竞态。

中断留下的孤立 tool call 会在恢复时修复并发出 `session.repaired`。`session` 工具搜索当前 session 的活动 journal 和 archive；跨产品会话的 `session_search` 由 Python 提供。二者返回的历史都必须标记为不可信数据，而不是指令。

## 记忆与技能注入

顶层 Run 启动前，Runtime 尝试召回当前 Agent scope 内的 Agent 记忆和用户资料记忆；失败不阻止 Run。两个 target 都不能跨 Agent 召回，公共知识只从平台知识库检索。注入采用独立字符预算、完整记录边界和明确的不可信数据标签。

只有规范私人、顶层、交互式 Run 可以自动写入或整理正式记忆，不再经过候选审批。记忆只保存稳定身份、长期偏好、持续约束和跨会话有价值的事实；任务进度、临时 TODO、一次性路径或当前回复内容不得写入长期记忆，重复或过时事实应合并或替换。计划任务、邮件唤醒、频道和委派 Run 默认只读记忆，不能被外部内容诱导修改。可用技能只在系统提示中注入精简索引；完整 `SKILL.md` 及支持文件必须由 Agent 按需加载。

每个主 Agent 的系统提示同时说明 Sandbox 逻辑工作区 `/workspace` 和由可信部署配置派生的当前宿主映射。Agent 默认在工作区创建并保存交付物，保持目录有序，并在确认无用后清理自己产生的临时中间文件；不得以“整理”为由删除上传附件、用户文件或含义不明的内容。宿主映射只用于帮助理解路径关系，不改变 Sandbox 默认执行目标，也不进入公共状态、数据库或普通工具 metadata。

## 学习复盘 Run

Platform 可创建 `metadata.review_mode=memory_skill`、`trigger=learning_review`、`unattended=true` 的内部 Run。Runtime 只在规范私人顶层 scope、无 parent/delegation、带正整数 `review_job_id` 和来源消息，且 `session_id=learning-review-<review_job_id>`、`metadata.idempotency_key=agent-learning-review:<review_job_id>` 时接受该组合。`learning-review-<正整数>` session 和 `agent-learning-review:<正整数>` 幂等命名空间只保留给完整复盘身份；普通 Run 即使不声明 review metadata 也不能占用。校验发生在排队和 session 初始化前；普通请求不能通过单独设置字段或借用普通 session 取得复盘权限。Platform 提交复盘时必须进入与普通 Run 相同的每 scope lifecycle start barrier，在持有门闩时立即重验账号、权限、lifecycle、来源消息和 running job，并把门闩保持到 Runtime 明确接受 Run。停用、撤权或显式 lifecycle reset 必须终结该 scope 的 queued/running 复盘任务，并在同一 lifecycle 门闩下清理先于 reset 被接受的 Run。接受回调再次发现 job 或 lifecycle 已失效时还必须终结 job 并取消该 Run，使旧 lifecycle 的复盘不可在清理完成后留存。

复盘沿用 Hermes 的“先交付回复，再独立审查”原则，但使用平台持久任务而不是进程内 daemon。它使用独立 session 和有界近期历史，不接受追加输入，不委派，不显示流式内容，也不写父 session；终态后 Runtime 精确删除该临时 session。复盘每次最多发起 `16` 个模型 turn；若全局 `maxTurnsPerRun` 更小则取较小值，不得通过调高普通 Run 上限扩大这条免审批自动写路径。每个 review job 另有由 Platform 权威执行且跨重启保留的二十单位总变更预算：memory 单动作、reconcile 子动作和 Skill create/patch 共享计费，读取免费；工具说明与复盘系统提示必须明确该限制，Runtime 自身不能把一次 reconcile 错算成一次。前台工具轨迹只保存有界、安全摘要；`skill.load` 与 `skill.read` 必须保留严格校验后的 Skill id，使复盘能优先检查本轮实际使用的 Skill，`skill.read` 可附安全相对文件路径，但 Skill 正文、patch 内容和工具结果不得进入轨迹。工具集合硬限制为 memory 与 skill：memory 可读并可 `store|replace|forget|reconcile`，不能 clear；skill 可 `list|load|read|create|patch`，现有 Skill 必须先在同一 Run load/read。terminal、process、文件、web、browser、mail、schedule、knowledge、session 和 delegate 都不存在于模型工具表。

复盘中的 memory/skill 允许动作不弹用户审批，但 Runtime Gateway 必须在 memory 读写和全部 Skill 请求中透传完整的可信复盘主体：parent/delegation、trigger、unattended、review mode/job、owner、source message、scope 和 lifecycle。Python Gateway 在任何记忆查询、Skill 读取或写入之前都必须反查对应 `agent_learning_review` durable job 仍在 running，并重新校验账号激活与权限、owner、canonical scope、lifecycle 与 source message；旧 lifecycle、终态 job 或已撤权账号发出的延迟读请求必须在访问数据前以 403 失败关闭。复盘 Skill `list/load/read` 的最终复验、文件读取和 read-ledger 登记处于同一个 lifecycle gate 与 `BEGIN IMMEDIATE` 边界内，但不扣变更预算。Skill 创建来源由 Gateway 标为 agent；patch 只能作用于未 pin、active 且 agent-owned 的包。任何校验失败、模型失败或临时 session 清理失败都不能撤回或改写前台回复，也不能递归触发另一轮学习。

## 委派

委派深度和每 Run 子任务数量受策略限制。子 Agent 使用派生 scope 和独立 session，但继承父主 Agent 的 Sandbox、workspace、HOME 与 env；临时记忆和浏览器身份仍按子 scope 隔离。子 Run 的模型输出、工具活动和等待要向父 Run 传播活动，避免父 Run 被误判无进展。

## 停止与恢复

用户取消、scope cleanup、管理器执行断开和无进展保护都会中止模型与当前前台工具。Runtime 等待有限清理窗口；如果发生副作用且无法确认安全终止，则使用 `needs_review`。后台进程属于 Sandbox 生命周期，不因单个 Run 完成而停止；管理器根据任务和进程登记决定空闲回收。

Runtime 没有活动任务的固定墙钟上限。无进展保护、模型轮次上限和 terminal 默认超时的精确跨层值由 [`runtime-policy.json`](../contracts/runtime-policy.json) 定义。审批、请求体、清理和保留等其它边界由[配置参考](../reference/configuration.md)列出，并由 Runtime 配置测试校验。

## 验证稳定性

Runtime 的 Node 测试文件并发数固定为 4，避免共享 CI runner 的调度竞争饿死短时异步观测。等待 journal 事件等测试条件的观测预算可以高于产品超时，但测试不得借此放宽产品配置值或删除对应时序与终态断言。
