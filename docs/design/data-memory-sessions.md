# 数据、记忆与会话

本文定义持久数据的所有者、隔离键和生命周期。物理目录见[数据布局](../reference/data-layout.md)，Runtime 行为见 [Agent Runtime](agent-runtime.md)。

## 数据所有者

Python 平台的 SQLite 是账号、权限、频道、产品消息、附件元数据、token 用量、Agent scope、记忆、知识、设置、Telegram、邮箱、持久任务和计划任务的权威存储。Runtime 的 JSONL 文件只保存模型会话和工具历史，不替代产品消息库。

主要数据组如下：

- `users`、`channels`、`messages`、`attachments`、`conversation_revisions`；
- `agent_scopes`、`agent_runtime_scopes`、`agent_runtime_scope_sessions`；
- `durable_jobs`、`agent_run_inputs`；
- `agent_memories` 及其 FTS；
- `knowledge_documents`、`knowledge_document_files`、`knowledge_chunks`、`knowledge_index_generations`、`knowledge_document_index` 与 `knowledge_chunk_embeddings`；
- `agent_schedules`、`agent_schedule_runs`；
- `mail_accounts`、`mail_account_credentials`、`sylver_platform_connections`、`sylver_platform_credentials`、`settings`、`token_usage_events`、Telegram 与外部身份表。

数据库启用 WAL、外键和按线程连接。事务正文或 `commit` 失败时必须在复用该线程连接前尝试 `rollback`，磁盘满等提交错误不能把不确定事务遗留给后续请求。文件写入与对应数据库记录必须形成可恢复的逻辑事务；启动时清理未完成附件和孤立文件。

Sylver Lining 连接以本地用户 ID 为主键；连接行保存规范 base URL、已验证的远端身份投影和验证时间，独立凭据行只保存 Token。相同 origin 与远端用户身份不能同时绑定多个本地用户。删除本地用户或断开连接时凭据级联删除；Token 不进入 Runtime session、消息、workspace、Skill、备份清单或任何派生索引。

Agent session 映射只由 `agent_runtime_scopes` 和 `agent_runtime_scope_sessions` 承载。当前容器 schema marker 与最终表结构是唯一 baseline：空数据库直接创建该结构；普通启动只接受精确匹配当前 marker 和声明结构的非空数据库。全部业务表属于同一个原子 baseline，不允许各业务 store 在服务启动后补建表。发布中的专用 `migrate` 进程可仅从契约声明的直接前一 baseline 在 Manager 已停止 writer 并创建快照后原子迁移；其它 marker、未知业务表、额外列、缺失结构或退役表在任何写入前拒绝。

## Agent scope

规范私人 scope 为 `private:<user-id>`，频道主 Agent scope 为 `channel:<channel-id>:main-agent`。`agent_scopes.lifecycle_id` 属于稳定 logical scope 元数据；`agent_runtime_scopes.lifecycle_id` 与 session 属于当前 conversation runtime，可以独立轮换，二者没有相等关系。scope 保存稳定的相对 workspace 标识和不可由模型覆盖的主 Agent sandbox identity；workspace marker 绑定 logical scope 的 key/type/id、sandbox/workspace identity 与当前 Runtime lifecycle，而不是 logical scope lifecycle。历史 Runtime lifecycle/session 由 alias 表保留。委派 scope 继承父 sandbox identity，不建立新的工作目录。当前架构只有 Sandbox 执行路径，因此数据库和 workspace marker 不保存可选择的执行后端字段。

每个 workspace 写入 `.agent-platform-scope.json`。marker 只记录 scope、lifecycle、sandbox identity、workspace identity、`technical_profile` 和固定隔离边界，字段集合必须精确匹配当前 schema；多余、缺失或其它 profile 失败关闭。数据库不得保存容器内或宿主绝对 workspace 路径；Platform 在自己的数据根解析相对标识，Manager 将同一目录映射为 Sandbox `/workspace`。发现绝对路径、越界相对路径或任何不等于 scope 规范 identity 的 workspace 标识时，启动和后续读取都明确拒绝。每次使用都重新检查路径组成与符号链接，缓存不得绕过。

会话 ID 是持久 Runtime 引用，不是管理员品牌。Platform 对新建或显式轮换的会话使用 `agent-platform-private-u<id>` 与 `agent-platform-channel-<id>-main-agent` 前缀；历史会话正文、alias、消息 metadata 或 JSONL 不因展示品牌变化而改写。

当前 baseline 不接受已登记但尚未物化的 workspace。workspace 根、规范相对目录、marker 与 Runtime alias 必须在 Platform/Runtime 启动前完整存在并彼此一致；缺失、错误 marker、身份漂移或未知 residue 都失败关闭，普通更新不得创建、修复或推断这些对象。

停用账号保留私人 workspace、session 和 memory，以便重新启用。账号停用和产品消息隐藏都不隐式销毁这些持久上下文；需要重置时必须使用独立、显式的 lifecycle/session cleanup 语义。

## 产品消息与 Runtime 会话

产品消息用于界面、审计、Telegram 投递、跨会话搜索和回复关联。Runtime 会话用于模型上下文、工具调用配对和压缩恢复。两者用 source message、Run、scope、lifecycle 和 session 元数据关联，但任何一方都不能通过模糊文本推断另一方身份。

界面的 `/compact` 是当前 Runtime session 的本地控制操作，不写入产品消息库，也不作为用户消息追加到 Runtime journal。它只把可安全省略的活动 journal 条目归档并原子改写当前上下文；Runtime 生成的上下文提示由 entry 顶层结构化标记区分，正文相同但没有该标记的真实用户消息仍必须归档。archive、产品消息、附件、记忆、知识和 workspace 均不删除，因此压缩前历史仍可通过 `session` 或 `session_search` 找回。

持久 Runtime 会话中的 assistant tool call 是下一轮模型会直接看到的协议样例，因此其参数必须始终保持当前工具 schema 的规范形状。敏感正文只可在 schema 允许的位置替换为有界且符合字段约束的占位符；受正则、枚举或路径规则约束的标识符不能使用破坏约束的通用展示占位符。允许任意 JSON 的字段还必须限制投影深度、条目数、节点数和单字符串字节数。审计专用的 `tool` 名称、展示 envelope、拒绝原因或其它 schema 外字段不得写回模型历史。工具活动 journal 可以使用独立的展示对象，不能与模型历史共用同一个序列化函数。读取既有会话时，Runtime 在不改写 JSONL 的前提下把历史展示 envelope 归一为规范参数后再交给模型；未知字段和身份字段仍失败关闭，不能借归一化扩大工具权限。

管理审计中的单条删除、按时间删除和清空对话，以及用户对本人频道消息的撤回，都是产品消息的逻辑隐藏：它们不轮换 lifecycle/session，不清理 Runtime 上下文、memory、附件或 workspace，也不取消已经排队或运行的回复。用户撤回只允许精确匹配当前频道、`author_type=user` 且 `user_id` 等于当前登录账号的可见持久消息；乐观发送中的临时行没有服务端撤回语义。用户后续继续对话时，Runtime 仍可使用原会话历史。真正重置 Agent 上下文必须走显式的 lifecycle/session rotation 与 scope cleanup，不能从消息行是否可见来推断。

当前这些管理接口不执行物理消息清除。未来若增加不可恢复的 purge，必须把消息、附件、活动任务和 Agent scope 作为一个版本化操作共同设计，不能复用“隐藏”语义。

## 持久任务与追加输入

Agent 回复在消息写入后进入 `durable_jobs`。每个会话由一个 FIFO worker 消费，全局并发门只限制实际进入 Runtime 的任务。

用户消息任务可以把完整任务快照持久化在 job payload 中；邮件唤醒例外地使用引用载荷，只保存任务类型与权威 `source_message_id`。所有队列唤醒、重启恢复、中断复核和失败消息补偿路径都先校验 job scope 与源消息归属，再从消息和其可信 metadata 重建任务。源消息丢失、归属不一致或 metadata 不完整时失败关闭，不能从去重键或文本猜测身份。

Platform 启动恢复必须至多顺序扫描一次 Agent 消息 metadata，构建本次恢复使用的 `durable_job_id` 与完成状态索引；随后对失败、待复核和分组任务只做集合查询。不得为每条历史 job 重复读取并解析整张消息表，使启动成本退化为任务数与消息数的乘积。该索引只是一轮启动内的派生数据，不替代 SQLite 中的消息和 job 权威记录。

当前数据库基线必须携带合法的 durable-job 消息高水位：空库从 `0` 开始，正常启动只读取并验证该值；缺失或损坏时拒绝恢复，不得把当前消息最大值静默写回后跳过潜在任务。

私人 Agent 活动期间的新消息仍拥有独立 job，并在 `agent_run_inputs` 中经历 reserved、submitting、accepted、injected、unconsumed 或终态。服务重启时：

- 尚未提交的 reserved/unconsumed 输入可重新排队；
- 已提交或已注入但终态未知的输入与父 job 进入 `needs_review`；
- 已有确定回复的账本可进行幂等核对，不重复生成回复。

## 记忆模型

记忆有两个 target：

- `memory`：属于一个 Agent scope 的事实、规则与工作偏好；
- `user`：该 Agent scope 对当前用户资料的长期认识。

两个 target 只是同一 Agent 内的语义分区，不是共享层；它们都以完整 `scope_key` 作为首要所有权边界。任何查询、召回、人工维护和回复后复盘都只能读取或修改当前 Agent scope 的记录，即使另一 Agent 面向同一用户，也不能读取前者的 `memory` 或 `user` target。跨 Agent、面向全体的公共资料只属于知识库，不能通过省略、替换或弱化 memory scope 构造共享记忆。

每条记忆包含 tags、来源类型、source Run、source message、内容 hash 和时间。当前写入来源只能是 `manual` 或 `automatic`。所有权和是否允许自动写入从可信 Run context 派生；模型参数不能覆盖 owner 或把 unattended/channel/delegated Run 提升为可写。写入有配额、长度、注入扫描和去重约束，精确限制由代码契约和测试维护。

`agent_memory_fts` 是 `agent_memories` 的 FTS5 外部内容派生索引，投影列必须精确为 `content, tags_json`，并以 `content_rowid='id'` 关联源表。启动时必须检查实际虚拟表列、建表 SQL 和三个同步触发器；如果发现旧的 `tags` 投影或任何不符合当前契约的派生对象，只删除并重建该 FTS 虚拟表及其三个触发器，再从权威源表执行 `rebuild`。正确且已同步的索引在重复启动时不执行 DDL 或重建；索引契约错误不能被当作“SQLite 不支持 FTS5”而永久降级。

交互式私人顶层 Run 在对话中发现稳定且跨会话有价值的信息时直接写入、替换或忘记正式记忆，不弹出审批。Agent 应优先更新同一事实而不是追加冲突副本；临时任务状态和过程信息留在 session 或工作区。计划任务、邮件唤醒、频道 Agent 和委派 Agent 只能召回，不得自动修改记忆。普通自动写入也不是只凭 Runtime metadata 放行：Platform 必须持有该 scope 的 lifecycle start barrier，并在覆盖授权复验、记忆变更和返回快照的同一个 `BEGIN IMMEDIATE` 事务内确认 canonical private scope/current lifecycle、激活账号与私人权限、来源用户消息，以及 `agent_run_inputs.runtime_run_id` 所属父 `agent` durable job 仍为 running。撤权、reset、父任务终结和记忆写入据此线性化，不能在预检与落盘之间穿越。

前台即时维护之外还有 Hermes 风格的回复后复盘。每个私人 Agent 的节奏状态保存在 SQLite `settings`，触发任务保存在 `durable_jobs`；成功私人回合每十次触发记忆审查，成功工具调用累计十次可提前触发流程审查。计数和任务都绑定当前 lifecycle，轮换后从零开始；同一来源消息只能产生一个复盘任务。复盘使用近期产品消息和有界工具活动作为不可信历史，只保存稳定事实、消除冲突或忘记已明确失效的事实，不保存凭据、一次性错误、短期任务状态和未经用户确认的推断。

复盘对 Skill 采用 Hermes 的主动信号与分层策略：用户对风格、格式、流程或工具使用的纠正，非平凡的可复用技巧，以及本轮已使用 Skill 暴露的缺漏都应触发维护；优先精确 patch 已检查且允许自动维护的现有 agent-owned Skill，没有合适目标时才创建可覆盖一类任务的 umbrella Skill。不得把一次性任务叙述、已经恢复的瞬时故障、环境暂缺或“某工具永远不可用”固化为 Skill；没有真实持久信号时允许不写入。

`memory.reconcile` 在一个 Platform 事务内执行至多二十个 `store`、`replace` 或 `forget` 动作，用于复盘时原子整理相关事实；不提供批量 `clear`。所有动作继续由 Platform 从可信 review job 派生 owner、scope、Run 和 source message，模型不能覆盖来源。复盘的 `search|read|list` 与写入使用同一完整主体契约；Python 必须持有 lifecycle start barrier，并在同一个 SQLite 事务快照中先重验当前 scope lifecycle、账号激活与权限、来源消息和 running job，再执行记忆查询，不能让 reset、撤权或 job 终止前已发出但延迟到达的查询越过授权边界。复盘写入还必须在覆盖复验、预算扣减、全部记忆变更和返回快照的同一个 `BEGIN IMMEDIATE` 事务内完成。撤权/reset 先提交时复盘读写失败关闭；复盘事务先线性化时完成该次快照或原子变更，后续撤权/reset 再生效。

每个 `agent_learning_review` durable job 具有持久、跨重启和重试共享的二十单位变更预算；模型 turn 上限不能替代该预算。每个 memory `store|replace|forget` 消耗一单位，`reconcile` 按内部动作数逐项计费；每个 Skill `create|patch` 消耗一单位，读操作不计费。记忆预算与实际变更同事务扣减，变更失败整体回滚。Skill 横跨 SQLite 与文件系统，Platform 在持有同一 lifecycle barrier 时先用独立 `BEGIN IMMEDIATE` 事务持久预扣一单位，再重新复验授权并执行文件提交；因此失败的 Skill 写入也可能消耗预算，这是防止“文件已提交但预算回滚”的 fail-closed 语义。预算耗尽后 Gateway 拒绝后续变更，任务重领、进程重启或 Runtime 重试不得重置计数。

## 召回与搜索

顶层 Run 启动前只在当前 Agent scope 内进行 query recall，并列出该 Agent 保存的当前用户资料记忆。空结果不注入；失败不使 Run 失败。注入内容按记录边界裁剪，并包在明确的不可信数据标签中。

`session` 搜索当前 Runtime session 的活动 JSONL 和 archive，适合找回压缩前的工具历史。`session_search` 搜索平台产品消息，可列出 session、全文搜索并读取指定 session；只有带当前 `session_id` 元数据或可由当前 reply 关系明确归属到该 session 的消息才进入索引，不为缺少会话来源的行合成兼容 session。只有规范私人 Agent 与频道主 Agent 可以使用，响应有统一字符预算。

知识库与记忆是不同数据域：知识文档由管理员/有权限成员管理，是全体 Agent 可检索的公共知识层；两个记忆 target 都属于单一 Agent scope，不能互相冒充来源，也不能用记忆承载跨 Agent 共享知识。

`knowledge_documents` 中的规范文本是检索、阅读和重建索引的权威来源；文件导入另以一对一的 `knowledge_document_files` 行保存不可变原件、规范文件名、媒体类型、字节数和 SHA-256，供用户下载与审计。两者与索引状态位于同一 SQLite 事务/备份边界，派生块不重新解析原件。Platform 使用稳定 content hash 和版本化分块器生成带文档 ID、字符偏移、标题路径与 chunk hash 的派生块，再通过管理员配置的 OpenAI-compatible Embeddings API 批量生成向量。向量维度从首个合法响应锁定或与显式配置精确比对；数量、顺序、数值、维度或响应大小不合法时整批失败。

文件导入接受一次最多十个文件，每个不超过 50 MiB、请求总量不超过 100 MiB。当前格式闭集为 TXT、Markdown、CSV、JSON、HTML、PDF、DOCX、XLSX、PPTX 与 ODT；扩展名、声明媒体类型和容器签名必须相容。纯文本按明确编码解码，HTML 删除脚本/样式后保留可见结构，JSON 规范化，Office/OpenDocument 在有界 ZIP 条目数与解压字节预算内读取，PDF 只提取已有文本层。加密文件、损坏容器、扫描件/无文本 PDF、旧二进制 Office 格式、超大压缩包或提取后空正文全部明确拒绝，不运行宏、外链、公式、嵌入对象或 OCR。整批先完成验证与提取，再在一个事务中写入；任一文件失败时整批不产生知识条目。

文件下载优先逐字节返回保存的原件，并使用原媒体类型、同源鉴权和安全 `Content-Disposition`；手工创建的条目导出为 UTF-8 Markdown。下载不触发重新提取、索引或 provider 调用。列表与正文 API 只返回文件元数据，不把原件 BLOB 塞入 JSON。

聊天附件原件和附件元数据仍属于消息 scope。XLSX 预览是从已授权附件原件即时生成的有界派生 JSON，不单独持久化，也不进入知识索引、模型上下文或备份清单。解析只读取有限数量的工作表、行、列、单元格和字符串；响应明确标记工作表或内容截断。预览失败不修改附件，不改变下载语义。

索引以 generation 构建：文档与待摄取 job 同事务落库，job 只引用 `document_id + expected_hash + generation_id`，不复制原文。worker 重新读取权威文档，在完整写入所有块与向量时再原子标记该文档 ready；只有覆盖全部当前文档的 ready generation 可原子切为 active。配置或模型变化时在 shadow generation 重建，不让半成品混入查询。

检索只走 active generation 的查询向量与 cosine 相似度，然后按文档限额去重并在字符预算内返回邻接证据；结果始终包含可读的数字 `document_id`、稳定 `chunk_id`、来源偏移和 score。不存在 FTS、`LIKE`、第二检索后端或静默回退。缺少 API key 时知识库标记为 disabled；创建、重建和显式检索返回可诊断错误，文档列表/原文仍可用于配置与恢复。顶层 Run 的被动建议在未配置或 provider 短暂失败时 fail-open 并记录 degraded，不得返回伪装成“无命中”的空结果。

## 技能数据

用户技能存放在 `agent-skills/<scope-hash>/`，scope key 不直接出现在路径中。每个包以 `SKILL.md` 为可移植主体，`.skill.json` 只保存平台生命周期状态；支持文件只能位于 `references`、`templates`、`scripts` 和 `assets`。

仓库内 bundled skills 是全局只读层。用户显式创建的 Skill 可用相同 id 或不区分大小写的名称遮蔽预置版本，升级不能覆盖用户文件；后台复盘以 `created_by=agent` 创建时必须同时避开 bundled id 和名称，不能在免审批路径中静默替换预置工作流。

文档产出 bundled skills 以文件类型分工，至少覆盖 spreadsheet、document、presentation 和 PDF。它们共享同一交付契约：在当前 workspace 生成真实文件、验证、用 `MEDIA: /workspace/<relative-path>` 回传、保留最终产物并清理自己创建的中间文件；Platform 只按当前 Agent scope 的权威工作区解释该逻辑路径，Runtime 的成功内部复验不得丢失已经产生的交付标记，失败复验则不得恢复标记。表格请求默认产出 XLSX，除非用户明确只需要聊天内的简短 Markdown 表格。预置 Skill 不承担在线 Office 编辑或执行不可信文档内容。

bundled skill 中需要在 workspace 保存脚本、计划或中间文件的示例必须使用 `.agent-platform/`。Skill 不提供双路径回退，也不根据管理员品牌选择路径。

每个 scope 还保存 owner-only、原子写入的 `.skill-usage.json`。状态以不可变 skill id 为键，记录 `created_by=user|agent`、使用/patch 次数和时间、`active|stale|archived`、pin 与归档时间。既有技能缺少状态时必须安全解释为 `user + active`，自动流程不能因此取得维护权。普通界面或前台 Run 创建的 Skill 都是 user-owned；只有通过可信 `agent_learning_review` context 创建的 Skill 才标记为 agent-owned，模型参数不能声明来源。

`skill.patch` 对 `SKILL.md` 或一个支持文件执行精确字符串替换，调用方声明期望替换次数；不使用模糊匹配。目标正文在 scope lock 内通过单文件原子替换提交，主指令完成后重新解析 frontmatter、检查配额并执行提示词注入扫描。patch 不改变 `created_by/state/pinned/enabled` 等授权字段；`.skill.json.updated_at` 与 usage 的 patch 时间/次数只是非授权 telemetry，存储异常后的尽力回滚失败可使其滞后，调用方收到失败时必须重新读取目标正文确认结果，不能盲目重放。所有可变 Skill 写入口（create、完整 update、精确 patch 和 support write）还必须拒绝高置信明文凭据，包括真实 token/PAT、完整 PEM 私钥和带实际值的 Bearer 凭据；普通认证说明、占位符和不含密钥正文的格式示例不得仅因出现相关术语而被拒绝。`skill.load` 记录实际使用；patch 记录维护活动。后台复盘的 `list/load/read` 必须持有 lifecycle/review 串行门，并在覆盖最终授权复验、Skill 文件读取和 read-ledger 登记的同一个 `BEGIN IMMEDIATE` 边界内完成；它们不扣变更预算，但旧 lifecycle、撤权账号或终态 job 不得读取当前 Skill。后台复盘只能创建 Skill，或在本次 Run 已 load/read 后 patch 未 pin、未归档且由后台复盘创建的 Skill；bundled、user-owned、pinned 和 archived Skill 永远不能被自动修改。后台复盘的 create 和 patch 都不能使用一个独立的“先检查”结果授权；Platform 必须先持有 lifecycle/review 串行门，在一个保持到文件提交结束的 `BEGIN IMMEDIATE` 事务内重验当前 scope、账号、权限、来源消息和 running job，再进入 Skill scope lock 完成包创建或精确 patch，使撤权、lifecycle 轮换或删除/重建都不能在验证与写入之间穿越。对自动 patch，该 scope lock 内还必须重新读取当前包和 usage 状态，验证 `created_by=agent + active + unpinned`并随即完成替换。自动 patch 还必须在提交前以当前不可变 package id 和重新解析后的 frontmatter name 复核 bundled 冲突；无论目标事后曾被用户改名，还是本次 patch 企图改名，都不得在免审批路径中遮蔽 bundled Skill。自动复盘不删除、禁用或物理移动 Skill，也不执行 Skill 中的 shell。长期清理只允许未来的确定性 curator 对 agent-owned 状态做可恢复的逻辑 stale/archive，不能自动永久删除。

## 备份与迁移

备份必须把 `platform.db`、SQLite sidecar、attachments、workspaces、agent-envs、agent-skills、`runtimes/agent` 和 Manager generation 状态视为同一恢复点。复制活动数据库前应使用 SQLite 在线备份或先停止服务；直接只复制主数据库文件可能遗漏 WAL 中的数据。知识规范文本、导入原件、分块、索引状态与 active generation 位于同一 SQLite 恢复点；向量可由规范文本重建，但恢复后不得把未完整 generation 标记为 active。

Manager operation journal 是容器 generation、维护预约和更新恢复的唯一编排状态。Platform 只能按匹配 operation id 建立或释放进程内准入门，不能从数据库、容器状态或文件是否消失推断 Manager operation 已完成。

数据库 schema version 单调递增。本次发布只支持从直接前一 baseline `2026080602` 到当前 baseline `2026080801` 的精确迁移：完整保留既有业务数据与结构，并原子新增初始为空的 `sylver_platform_connections` 和 `sylver_platform_credentials`。迁移只在 Manager 已停止 current writer 且快照完成后执行，DDL、marker 更新、外键与精确结构验证位于同一事务。普通启动仍只接受当前 baseline，不扫描旧源码布局、不猜测结构。校验覆盖精确的业务表/列集合、关键 CHECK、索引、唯一约束与外键；任何其它来源 marker、未知业务表、额外列或缺失结构都拒绝。

未来数据格式变更必须先更新文档、schema version 和迁移测试；只支持当次发布明确声明的直接来源，不扫描其它产品目录或猜测未声明布局。
