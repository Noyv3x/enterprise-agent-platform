# 数据、记忆与会话

本文定义持久数据的所有者、隔离键和生命周期。物理目录见[数据布局](../reference/data-layout.md)，Runtime 行为见 [Agent Runtime](agent-runtime.md)。

## 数据所有者

Python 平台的 SQLite 是账号、权限、频道、产品消息、附件元数据、token 用量、Agent scope、记忆、知识、设置、Telegram、邮箱、持久任务和计划任务的权威存储。Runtime 的 JSONL 文件只保存模型会话和工具历史，不替代产品消息库。

主要数据组如下：

- `users`、`channels`、`messages`、`attachments`、`conversation_revisions`；
- `agent_scopes`、`agent_runtime_scopes`、`agent_runtime_scope_sessions`；
- `durable_jobs`、`agent_run_inputs`；
- `agent_memories` 及其 FTS；
- `knowledge_documents` 及其 FTS；
- `agent_schedules`、`agent_schedule_runs`；
- `mail_accounts`、`mail_account_credentials`、`settings`、`token_usage_events`、Telegram 与外部身份表。

数据库启用 WAL、外键和按线程连接。文件写入与对应数据库记录必须形成可恢复的逻辑事务；启动时清理未完成附件和孤立文件。

Agent session 映射只由 `agent_runtime_scopes` 和 `agent_runtime_scope_sessions` 承载。当前容器 schema marker 与最终表结构是唯一 baseline：空数据库直接创建该结构；非空数据库必须同时精确匹配当前 marker 和声明结构；全部业务表属于同一个原子 baseline，不允许各业务 store 在服务启动后补建表。任何其它 marker、未知业务表、额外列、缺失结构或退役表都必须在修改数据库前明确拒绝，当前版本不携带历史 baseline 升级入口。

## Agent scope

规范私人 scope 为 `private:<user-id>`，频道主 Agent scope 为 `channel:<channel-id>:main-agent`。scope 保存稳定的相对 workspace 标识和不可由模型覆盖的主 Agent sandbox identity；Runtime lifecycle 和 session 可以独立轮换。委派 scope 继承父 sandbox identity，不建立新的工作目录。当前架构只有 Sandbox 执行路径，因此数据库和 workspace marker 不保存可选择的执行后端字段。

每个 workspace 写入 `.ubitech-agent-scope.json`，只记录 scope、lifecycle、sandbox identity、workspace identity 和固定隔离边界。字段集合必须精确匹配当前格式；多余或缺失字段触发受控重写，不能把已退役的状态维度继续带入新基线。数据库不得保存容器内或宿主绝对 workspace 路径；Platform 在自己的数据根解析相对标识，Manager 将同一目录映射为 Sandbox `/workspace`。当前基线发现绝对路径、越界相对路径或任何不等于 scope 规范 identity 的 workspace 标识时，启动和后续读取都必须明确拒绝，不能把旧绝对路径静默换算或改写为当前 identity。每次使用都重新检查路径组成与符号链接，缓存不得绕过。

停用账号保留私人 workspace、session 和 memory，以便重新启用。账号停用和产品消息隐藏都不隐式销毁这些持久上下文；需要重置时必须使用独立、显式的 lifecycle/session cleanup 语义。

## 产品消息与 Runtime 会话

产品消息用于界面、审计、Telegram 投递、跨会话搜索和回复关联。Runtime 会话用于模型上下文、工具调用配对和压缩恢复。两者用 source message、Run、scope、lifecycle 和 session 元数据关联，但任何一方都不能通过模糊文本推断另一方身份。

持久 Runtime 会话中的 assistant tool call 是下一轮模型会直接看到的协议样例，因此其参数必须始终保持当前工具 schema 的规范形状。敏感正文只可在 schema 允许的位置替换为有界且符合字段约束的占位符；受正则、枚举或路径规则约束的标识符不能使用破坏约束的通用展示占位符。允许任意 JSON 的字段还必须限制投影深度、条目数、节点数和单字符串字节数。审计专用的 `tool` 名称、展示 envelope、拒绝原因或其它 schema 外字段不得写回模型历史。工具活动 journal 可以使用独立的展示对象，不能与模型历史共用同一个序列化函数。读取既有会话时，Runtime 在不改写 JSONL 的前提下把历史展示 envelope 归一为规范参数后再交给模型；未知字段和身份字段仍失败关闭，不能借归一化扩大工具权限。

管理审计中的单条删除、按时间删除和清空对话都是产品消息的逻辑隐藏：它们不轮换 lifecycle/session，不清理 Runtime 上下文、memory 或 workspace，也不取消已经运行的回复。用户后续继续对话时，Runtime 仍可使用原会话历史。真正重置 Agent 上下文必须走显式的 lifecycle/session rotation 与 scope cleanup，不能从消息行是否可见来推断。

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
- `user`：属于用户的资料，可被该用户的相关 Agent 使用。

每条记忆包含 tags、来源类型、source Run、source message、内容 hash 和时间。当前写入来源只能是 `manual` 或 `automatic`。所有权和是否允许自动写入从可信 Run context 派生；模型参数不能覆盖 owner 或把 unattended/channel/delegated Run 提升为可写。写入有配额、长度、注入扫描和去重约束，精确限制由代码契约和测试维护。

交互式私人顶层 Run 在对话中发现稳定且跨会话有价值的信息时直接写入、替换或忘记正式记忆，不弹出审批。Agent 应优先更新同一事实而不是追加冲突副本；临时任务状态和过程信息留在 session 或工作区。计划任务、邮件唤醒、频道 Agent 和委派 Agent 只能召回，不得自动修改记忆。

## 召回与搜索

顶层 Run 启动前进行 query recall，并列出当前用户资料记忆。空结果不注入；失败不使 Run 失败。注入内容按记录边界裁剪，并包在明确的不可信数据标签中。

`session` 搜索当前 Runtime session 的活动 JSONL 和 archive，适合找回压缩前的工具历史。`session_search` 搜索平台产品消息，可列出 session、全文搜索并读取指定 session；只有带当前 `session_id` 元数据或可由当前 reply 关系明确归属到该 session 的消息才进入索引，不为缺少会话来源的行合成兼容 session。只有规范私人 Agent 与频道主 Agent 可以使用，响应有统一字符预算。

知识库与记忆是不同数据域：知识文档由管理员/有权限成员管理，记忆属于 Agent 或用户，不能互相冒充来源。可选 Cognee 增强使用 Platform 镜像内经过构建验证的 Python distribution；运行时不加载构建 checkout，也不向镜像代码层写入字节码缓存。

## 技能数据

用户技能存放在 `agent-skills/<scope-hash>/`，scope key 不直接出现在路径中。每个包以 `SKILL.md` 为可移植主体，`.skill.json` 只保存平台生命周期状态；支持文件只能位于 `references`、`templates`、`scripts` 和 `assets`。

仓库内 bundled skills 是全局只读层。用户用相同 id 或不区分大小写的名称创建技能时可遮蔽预置版本，升级不能覆盖用户文件。

## 备份与迁移

备份必须把 `platform.db`、SQLite sidecar、attachments、workspaces、agent-envs、agent-skills、`runtimes/agent` 和 Manager generation 状态视为同一恢复点。复制活动数据库前应使用 SQLite 在线备份或先停止服务；直接只复制主数据库文件可能遗漏 WAL 中的数据。

Manager operation journal 是容器 generation、维护预约和更新恢复的唯一编排状态。Platform 只能按匹配 operation id 建立或释放进程内准入门，不能从数据库、容器状态或文件是否消失推断 Manager operation 已完成。

数据库 schema version 单调递增。当前版本只接受当前 baseline，不扫描旧源码布局、不猜测结构，也不携带历史升级入口。校验覆盖精确的业务表/列集合、关键 CHECK、索引、唯一约束与外键；任何未知业务表、额外列、缺失结构或退役表都拒绝启动。

未来数据格式变更必须先更新文档、schema version 和迁移测试；只支持当次发布明确声明的直接来源，不扫描其它产品目录或猜测未声明布局。
