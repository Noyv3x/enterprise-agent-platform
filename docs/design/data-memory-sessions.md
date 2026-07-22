# 数据、记忆与会话

本文定义持久数据的所有者、隔离键和生命周期。物理目录见[数据布局](../reference/data-layout.md)，Runtime 行为见 [Agent Runtime](agent-runtime.md)。

## 数据所有者

Python 平台的 SQLite 是账号、权限、频道、产品消息、附件元数据、token 用量、Agent scope、记忆、知识、设置、Telegram、持久任务和计划任务的权威存储。Runtime 的 JSONL 文件只保存模型会话和工具历史，不替代产品消息库。

主要数据组如下：

- `users`、`channels`、`messages`、`attachments`、`conversation_revisions`；
- `agent_scopes`、`agent_runtime_scopes`、`agent_runtime_scope_sessions`；
- `durable_jobs`、`agent_run_inputs`；
- `agent_memories`、`agent_memory_candidates` 及其 FTS；
- `knowledge_documents` 及其 FTS；
- `agent_schedules`、`agent_schedule_runs`；
- `settings`、`token_usage_events`、Telegram 与外部身份表。

数据库启用 WAL、外键和按线程连接。文件写入与对应数据库记录必须形成可恢复的逻辑事务；启动时清理未完成附件和孤立文件。

## Agent scope

规范私人 scope 为 `private:<user-id>`，频道主 Agent scope 为 `channel:<channel-id>:main-agent`。scope 保存稳定工作区；Runtime lifecycle 和 session 可以独立轮换。

每个 workspace 写入 `.ubitech-agent-scope.json`，记录 scope、lifecycle 和 host/logical 执行边界。平台每次使用时重新解析路径并拒绝 workspace 路径中的符号链接，缓存不得绕过此检查。

停用账号保留私人 workspace、session 和 memory，以便重新启用。账号停用和产品消息隐藏都不隐式销毁这些持久上下文；需要重置时必须使用独立、显式的 lifecycle/session cleanup 语义。

## 产品消息与 Runtime 会话

产品消息用于界面、审计、Telegram 投递、跨会话搜索和回复关联。Runtime 会话用于模型上下文、工具调用配对和压缩恢复。两者用 source message、Run、scope、lifecycle 和 session 元数据关联，但任何一方都不能通过模糊文本推断另一方身份。

管理审计中的单条删除、按时间删除和清空对话都是产品消息的逻辑隐藏：它们不轮换 lifecycle/session，不清理 Runtime 上下文、memory 或 workspace，也不取消已经运行的回复。用户后续继续对话时，Runtime 仍可使用原会话历史。真正重置 Agent 上下文必须走显式的 lifecycle/session rotation 与 scope cleanup，不能从消息行是否可见来推断。

当前这些管理接口不执行物理消息清除。未来若增加不可恢复的 purge，必须把消息、附件、活动任务和 Agent scope 作为一个版本化操作共同设计，不能复用“隐藏”语义。

## 持久任务与追加输入

Agent 回复在消息写入后进入 `durable_jobs`。每个会话由一个 FIFO worker 消费，全局并发门只限制实际进入 Runtime 的任务。

私人 Agent 活动期间的新消息仍拥有独立 job，并在 `agent_run_inputs` 中经历 reserved、submitting、accepted、injected、unconsumed 或终态。服务重启时：

- 尚未提交的 reserved/unconsumed 输入可重新排队；
- 已提交或已注入但终态未知的输入与父 job 进入 `needs_review`；
- 已有确定回复的账本可进行幂等核对，不重复生成回复。

## 记忆模型

记忆有两个 target：

- `memory`：属于一个 Agent scope 的事实、规则与工作偏好；
- `user`：属于用户的资料，可被该用户的相关 Agent 使用。

每条已提交记忆包含 tags、来源类型、source Run、source message、内容 hash 和时间。所有权从可信 Run context 派生；模型参数不能覆盖 owner。写入有配额、长度和去重约束，精确限制由代码契约和测试维护。

交互式私人顶层 Run 可以提出 `pending` 候选。候选经过用户批准后才生成正式记忆，也可以被拒绝；已决定或过期候选按有界策略清理。计划任务、频道 Agent 和委派 Agent不能走免审批候选通道。

## 召回与搜索

顶层 Run 启动前进行 query recall，并列出当前用户资料记忆。空结果不注入；失败不使 Run 失败。注入内容按记录边界裁剪，并包在明确的不可信数据标签中。

`session` 搜索当前 Runtime session 的活动 JSONL 和 archive，适合找回压缩前的工具历史。`session_search` 搜索平台产品消息，可列出 session、全文搜索并读取指定 session；只有规范私人 Agent 与频道主 Agent 可以使用，响应有统一字符预算。

知识库与记忆是不同数据域：知识文档由管理员/有权限成员管理，记忆属于 Agent 或用户，不能互相冒充来源。可选 Cognee 增强在托管模式下必须使用部署已验证的 Python 安装；用于安装和版本校验的固定 source checkout 不是运行时导入路径，不得因知识查询或摄取生成字节码缓存而变脏。

## 技能数据

用户技能存放在 `agent-skills/<scope-hash>/`，scope key 不直接出现在路径中。每个包以 `SKILL.md` 为可移植主体，`.skill.json` 只保存平台生命周期状态；支持文件只能位于 `references`、`templates`、`scripts` 和 `assets`。

仓库内 bundled skills 是全局只读层。用户用相同 id 或不区分大小写的名称创建技能时可遮蔽预置版本，升级不能覆盖用户文件。

## 备份与迁移

备份必须把 `platform.db`、SQLite sidecar、attachments、workspaces、agent-skills 和 `runtimes/agent` 视为同一恢复点。复制活动数据库前应使用 SQLite 在线备份或先停止服务；直接只复制主数据库文件可能遗漏 WAL 中的数据。

当前系统没有 Hermes 兼容或迁移路径。任何未来数据格式迁移都必须先更新文档和版本化迁移测试，不能通过运行时猜测旧目录结构。
