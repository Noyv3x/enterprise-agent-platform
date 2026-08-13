# Agent Runtime 私有 API

本文定义 Python 平台与 Node Agent Runtime 之间的私有协议。Runtime 行为见 [Agent Runtime 设计](../design/agent-runtime.md)。Run 空闲、模型轮次和 terminal 默认超时的跨层值见 [`runtime-policy.json`](../contracts/runtime-policy.json)；其它协议边界见[配置参考](configuration.md)并由双方测试校验。

## 传输与认证

Runtime 只监听私有容器网络。所有 endpoint，包括健康检查，都要求 `Authorization: Bearer <token>`。比较必须使用定时安全方法；失败响应不返回内部 traceback。

JSON 请求使用 UTF-8、明确的 body 上限和完整读取 deadline。JSON 响应使用 `Cache-Control: no-store`；SSE journal 使用 `Cache-Control: no-cache, no-transform`，避免中间层缓存或改写事件流。Python client 对普通请求和 SSE 断链使用传输级 deadline，这些 deadline 不能作为 Agent 任务总时限。

## Endpoint

| 方法与路径 | 用途 |
|---|---|
| `GET /health` | Runtime 进程健康 |
| `GET /v1/models` | Runtime 唯一可执行模型目录 |
| `POST /v1/runs` | 创建或复用 Run |
| `GET /v1/runs/{run_id}` | 读取 Run 状态和终态结果 |
| `GET /v1/runs/{run_id}/events` | 可恢复 SSE journal |
| `POST /v1/runs/{run_id}/input` | 向活动 Run 提交追加输入 |
| `POST /v1/runs/{run_id}/approval` | 处理当前审批 |
| `POST /v1/runs/{run_id}/cancel` | 取消 Run |
| `POST /v1/sessions/compact` | 立即压缩一个空闲 session |
| `POST /v1/scopes/cleanup` | 取消 scope Run、进程并可删除 session |
| `GET /v1/scopes/processes` | 读取一个 scope/lifecycle 的终端预览 |
| `GET /v1/scopes/process-summary` | 读取进程摘要 |

未知路径和不支持的方法返回 404。模型目录、预览、Run、Input、Cleanup 与控制 endpoint 严格拒绝未知 query/body 字段。调用方不得依赖未记录字段；新增字段必须先更新本文、类型和双方测试。

## 模型目录

`GET /v1/models` 返回版本、`pi-runtime` 来源和 provider 目录。产品 provider id 只接受 `openai-codex` 和 `xai-oauth`，不解析简写或历史别名。每个模型条目包含 id、显示名称、reasoning、输入模态、context window 和最大输出等 Runtime 元数据。OAuth provider 的 `default_model` 始终为空；推荐值必须由账号级供应商目录决定，调用方不得擅自替换为 Runtime 列表第一项。

目录从锁定 Pi 依赖计算，本文不复制模型 ID。Python 必须将目录与当前 OAuth 账号可见模型求交，不能创造任一目录外模型；两个 provider 都以供应商返回顺序中的第一个安全交集模型作为推荐默认。已有显式选择只有仍在安全交集中才可执行，且不随推荐值变化而改写。

## 创建 Run

最小请求结构：

```json
{
  "scope_key": "private:42",
  "lifecycle_id": "lifecycle-id",
  "session_id": "session-id",
  "workspace": "/workspace",
  "execution_context": {
    "sandbox_id": "agent_opaque_id",
    "workspace_id": "user-42"
  },
  "system_prompt": "You are Agent.",
  "input": "处理这个任务",
  "model": {
    "provider": "openai-codex",
    "id": "runtime-catalog-model-id"
  }
}
```

`execution_context` 由 Platform 从数据库 scope 派生，不能接受模型值；委派请求继承父值。可选字段包括 `history`、`attachments`、`thinking_level`、内部 Gateway 信息和 metadata。图片附件由 Platform 读取受限字节后放入 `input` image block；其它附件只携带 `path`、`name` 和 `mime_type`。`attachments` 不得带 `url` 或图片 MIME；Runtime 不把工作区文件再读成模型图片，也不直接读取 Platform 文件系统。metadata 可携带 parent/delegation、idempotency、source message、触发来源、计划任务和可用技能索引；scheduled occurrence 的 `schedule_recurring` 必须是 Platform 从权威 schedule type 派生的布尔值，interval/cron 为 true、once 为 false。OAuth token、宿主路径、Docker 身份和可覆盖 provider endpoint 的值不得出现。Platform 内部学习复盘还同时携带 `review_mode=memory_skill`、`trigger=learning_review`、`unattended=true` 和正整数 `review_job_id`，并把 session 与幂等身份固定为 `session_id=learning-review-<review_job_id>`、`metadata.idempotency_key=agent-learning-review:<review_job_id>`。Runtime 只有在 canonical private 顶层 scope、当前 source message、无 parent/delegation 且这两个派生身份精确匹配的完整组合下才启用受限能力；对应 session/idempotency 命名空间为内部保留，普通 Run 也不能预占。这些字段不是公共提权开关。

成功创建返回 HTTP 202：

```json
{
  "run_id": "run_...",
  "status": "queued",
  "events_url": "/v1/runs/run_.../events"
}
```

非空 `metadata.idempotency_key` 在 `scope_key` 内唯一。重复请求返回原 Run；已持久终态可以在重启后合成可重放事件。并发队列满时返回 429。

## 追加输入

请求包含稳定 `message_id`、与原 Run 一致的 `scope_key`、`lifecycle_id`、input 和可选附件。Runtime 必须拒绝跨 scope/lifecycle 注入。

响应状态为：

- `accepted`：已登记，等待模型循环消费；
- `injected`：已进入下一模型 turn；
- `unconsumed`：Run 已结束或无法消费，平台需要重新排队。

平台不能把 HTTP 接收成功等同于模型已经消费。

## 立即压缩 Session

`POST /v1/sessions/compact` 只接受以下严格 JSON；`model` 与 `gateway` 由已认证 Platform 从当前账号配置构造，仅用于这次摘要，不写入 session：

```json
{
  "scope_key": "private:42",
  "lifecycle_id": "lifecycle-id",
  "session_id": "session-id",
  "model": {"provider": "openai-codex", "id": "catalog-model-id"},
  "gateway": {"base_url": "http://platform:8765", "token": "internal-token"}
}
```

Runtime 验证三个身份字段并在同一 session 身份门闩下确认没有 queued/running Run，再串行执行 archive 与 journal 原子替换。存在活动 Run 返回 409；未知字段、空身份或非法身份返回 400。会话不存在或没有足够历史可省略不是错误，返回 HTTP 200：

```json
{
  "compacted": false,
  "omitted_messages": 0,
  "retained_messages": 4
}
```

实际压缩时 `compacted=true`；`omitted_messages` 只统计归档的真实会话消息，`retained_messages` 统计改写后的活动 journal 条目并包含一条 Runtime 内部结构化摘要。摘要由 Runtime-owned entry 标记识别，不能按正文识别。对已经压缩且没有新增可省略历史的 session 重复调用是幂等 no-op，不归档内部摘要、不增长 journal 或 archive。自动压缩则在同一 Run 的每个后续 provider turn 对“当前摘要 + 保留 tail + 新增消息”重新计算阈值；再次超限时迭代更新摘要、归档新省略的真实消息并丢弃旧摘要，不能把首次摘要当成永久免压缩标记。该 endpoint 不创建用户 Run、不写入命令消息，也不删除 archive；它会进行一次无工具的有界摘要模型请求，Platform 为该调用使用五分钟读取 deadline。HTTP 客户端断开、deadline、摘要失败或空摘要在最终提交点前都会取消本次操作，Runtime 在释放 session 门闩前确认摘要协作停止并保持 journal、archive 与 sidecar 原样；已进入最终提交点时则完成有界的 archive-first 原子替换，不把两份持久状态留在危险的半提交方向。

## SSE journal

每个 `data` 是递增 sequence 的 envelope：

```json
{
  "sequence": 1,
  "type": "run.queued",
  "run_id": "run_...",
  "timestamp": "RFC3339 timestamp",
  "data": {}
}
```

客户端可以使用 `Last-Event-ID` 或 `?after=` 恢复；Runtime 以两者中较大的合法 sequence 为起点。事件 journal 先记录再广播，慢或断开的客户端可在保留窗口内补读。

稳定事件族包括：

- `run.queued`、`run.started`、`run.reused` 及 Run 终态；
- `message.delta`、`message.final`、`thinking.delta`；
- `tool.arguments.delta`、`tool.started`、`tool.updated`、`tool.completed`、`tool.failed`；
- `execution.audit`，在 sandbox 或 host 执行开始前记录安全展示参数；
- `approval.requested`、`approval.resolved`；
- `input.accepted`、`input.injected`、`input.unconsumed`；
- `delegation.*`、`context.compacted`、`session.repaired`；
- `run.idle_timeout`、`run.turn_limit`、`run.cleanup_timeout`。

终态为 `run.completed`、`run.failed`、`run.cancelled` 或 `run.needs_review`。完成数据包含 output/content、session、model、usage、context usage 和输入消费信息。Runtime 可以在 Agent 主循环的单次模型 stream 尚未发布任何非空正文、思考或工具调用时，对明确的瞬时供应商错误做有界可取消重试；重试过程不产生额外 Run、工具工作记录或 session 消息。一旦 stream 已发布内容便不重试，上下文/输出大小、额度、账单、认证、内容策略错误也不重试；预算耗尽后继续使用原终态和 `sideEffectsStarted` 安全分类，Platform 不根据错误字符串重新提交整个 Run。该重试边界不包含 browser 工具结果的视觉辅助模型请求。若 Runtime 在一个含规范 `MEDIA: /workspace/<relative-path>` 的 assistant 回复后自动插入内部文件复验，只有相关变更已被成功复验清除时，`run.completed` 的 output/content 才把该交付标记去重保留下来，即使被持久化的最终 assistant 文本只报告复验结果；复验失败或仍有未确认变更时不恢复标记。Platform 仍是解析并授权附件的唯一边界。

由 Runtime 机械完成守卫产生的 `run.needs_review` 可以在同一个终态 data 中携带有界 `output`/`content`、session、model、usage 和 context usage。该正文只能取自最后一段真实 assistant 阶段性说明，表示尚未成功的进度或 blocker 诊断；`error` 必须继续给出独立的机械失败原因，状态仍是 `needs_review`。Python client 将正文暴露为 `AgentRuntimeRunError.partial_content`，但不得把它转成成功结果。幂等重放必须保持同一非成功状态与诊断。任何非成功终态中的 `MEDIA:` 都只是普通诊断文本，Platform 不解析、不复制也不发布附件。

`delegate_task` 的实时工具结果由 Runtime 添加结构化 child 证据：单任务包含 `child_run_id`、`status`、`content`、`side_effects_started`、`changed_files` 和 `unknown_change`；批量任务在有序 `results[]` 中逐项携带同一成功证据或失败摘要。这些字段不是模型参数，也不能从 child 文本解析。任一成功 child 的 `side_effects_started=true` 会在父 Run 建立待复验状态；只有随后成功的非委派聚焦验证工具才能清除，纯只读 child 不建立该状态。

## 审批与执行审计

审批 body 只接受 `approval_id` 和 `decision`。decision 是 `once`、`session`、`always` 或 `deny`。省略 `approval_id` 时处理该 Run 最新待决审批；未知字段或无效 decision 返回 400。

审批用于 host terminal、普通前台 Skill 修改、计划修改和其它明确需要用户决定的业务动作。自动记忆不使用审批；经过完整校验的内部学习复盘可以免批执行受限的 memory 与 agent-owned Skill create/patch，其它 Skill 动作仍失败关闭。`approval.requested` 只携带可展示的脱敏参数、复用范围和本次 choices；原始 secret 与内部稳定 key 不得进入事件日志。`approval.resolved` 的 outcome 除用户决定外还可为 `timeout`、`cancelled` 或 `notification_failed`，这些结果全部按未授权关闭。

terminal、process 和文件工具必须带 `target=sandbox|host`，省略时为 sandbox。Sandbox 不使用人工审批；host terminal 在调用 Manager 之前逐次请求审批，choices 固定为 `once|deny`，不支持 session/always 复用，也不能成为 Run 默认。terminal 在 `background=true` 时可额外使用 `background_kind=task|service`，省略为 `task`；前台调用携带该字段、未知值或任何其它 schema 外字段都会在工具执行前拒绝。该字段只控制 Runtime 是否必须观察进程终态，不原样进入 Manager executor 的 audit/terminal 请求；task 会由 Runtime 派生 `completion_required` 和不可逆 session owner 摘要，二者都不是模型参数。批准后 Runtime 写入 `execution.audit`，数据包含 target、完整安全展示参数、canonical cwd/路径、前后台方式和有效 timeout。Manager 响应回显不可伪造的 executor id、实际 target 和审计 id，Runtime 才能发出 `tool.started`。

子 Run 可以把审批所有权委托给顶层 Run，但 scope 和 session 必须来自可信 metadata。审批决定不能通过工具参数指定。

## Scope 与进程

`POST /v1/scopes/cleanup` 要求 `scope_key`，可带 `lifecycle_id` 和 `delete_sessions`。Runtime 先封锁并取消匹配 Run 与审批，再以 root scope/lifecycle 单次请求 Manager 停止整个 scope family；该请求不依赖 Runtime 进程内 execution-context 缓存。Manager 必须先安装 family/lifecycle 启动 admission fence，拒绝 fence 后到达的同边界 terminal start，并等待 fence 前已 admitted 的 start 登记进程或无副作用退出；等待不得持有 start 登记所需的互斥锁。fence 存续期间相邻 family 与未命中的 lifecycle 仍可启动，重叠 cleanup 有界失败。只有 pending start 已收敛后，Manager 才执行 evidence 上限预检、停止进程并确认 controller 收敛，保证 cleanup 返回后不会出现未纳入清理的迟到启动。Manager 随后返回有界、闭世界的未确认 completion-task evidence，但不得先 acknowledge 或裁剪这些记录。Runtime 通过同一文件队列删除精确 scope family/lifecycle 下的有限后台 task responsibility sidecar；journal、todo、approval 与普通 session 内容继续保留，`delete_sessions=true` 才删除整个 session family。本地状态提交成功后，Runtime 使用 evidence 中的精确 owner、process 与 execution context 逐项 acknowledge，全部确认后才删除内存 execution context。停止、文件提交或 acknowledge 任一步失败时请求失败；重试会重复停止、幂等提交本地状态并只确认剩余 evidence，不能报告部分成功。

终端预览要求同时提供 root scope 和 lifecycle，并可携带不透明 `since_revision`。预览、`running_terminal_count` 和 scope cleanup 都覆盖 root scope 本身及以 `root + "/delegate/"` 开头的委派 scope family；其它相似前缀不属于该 family。revision 是服务端游标，客户端不得解析其内部结构；游标必须随可展示输出或进程状态变化，并包含 Manager 进程实例身份，因此 Manager 重启后的旧游标必然失效。响应只用于只读展示。

进程预览数据来自 Manager executor，由 Runtime 按 scope/lifecycle 过滤和脱敏后返回。进程列表先展示活动状态（`running`、`orphaned`），同组再按 `started_at` 倒序排列。Platform 更新不停止独立 Sandbox 后台进程；目标版本需要刷新某个 Sandbox 时，只延迟该 Sandbox。库存不可确定时不能销毁容器。

Manager 进程快照和预览的 `status` 只允许 `running`、`completed`、`failed`、`cancelled` 和 `orphaned`。`orphaned` 表示 Manager 无法确认进程已经终止或仍由原执行器可靠持有，不是完成态；它必须保持 `running: true`，计入运行中终端和更新阻塞，并保留对应 Sandbox，直至 Manager 明确确认终态。Runtime 与 Platform 必须原样接受该状态，不能拒绝响应，也不能把它降级为 `completed`。前端只读预览将其展示为“需关注、仍占用”，不提供交互或强制清理入口。

模型侧 `process` action 还包含 `wait`：必须携带 `process_id`，可携带 `timeout_ms`，其上下限与 [`runtime-policy.json`](../contracts/runtime-policy.json) 一致。Manager 私有 executor 在验证精确 execution context、scope、lifecycle 与 target 后等待权威进程终态；超时返回当前快照并附 `wait_timed_out=true`，不发送终止信号。Runtime 到 Manager 的单次 HTTP deadline 必须至少覆盖本次有效等待时长和固定传输余量，不能因为通用 Manager 请求 timeout 更短而提前切断合法长等待。Runtime 在该请求期间暂停 Run idle guard，HTTP/Abort 取消只结束等待。对于当前 session 持久登记的 `background_kind=task`，只有 `wait`、`read` 或 `kill` 以匹配 target 对同一 id 返回 `completed`、`failed` 或 `cancelled` 才形成终态证据并原子解除责任；list、write、wait timeout、running 与 orphaned 均不能解除完成守卫。责任跨 Run 和 Runtime 重启恢复，直到取得终态证据或 scope/session cleanup 删除整个身份状态；损坏或身份不一致时请求失败关闭。责任仍活动时，Runtime preflight 必须拒绝 `schedule.create`，且不能向 Platform 发送请求或产生审批；全部解除后恢复正常，未登记责任的 service 不受影响。

委派 Run 的 scope/session 会在子 Run 终态后删除，不具备跨 Run 责任归属。Runtime 因此必须在工具执行、审批和 Manager 请求之前拒绝委派 Run 的所有 `terminal background=true` 调用；子 Agent 只能使用前台 terminal 并等待结果，不能创建 task 或 service 后把其生命周期遗留给父 Run。

Runtime 到 Manager 的私有 `POST /v1/executor/runs/cancel` 可携带 `preserve_process_ids`，但该字段不属于模型工具协议，只能由 Runtime 在 todo、有限后台 task 或 recurring decision 完成守卫产生 `needs_review` 时，从当前 session 的可信 task responsibility sidecar 计算。Manager 严格复验每个 id 属于同一 run/scope/lifecycle 且是后台进程，保留这些 task 并清理同 Run 其它进程。显式取消、idle timeout、普通失败、sidecar 不可验证和 scope cleanup 不携带该字段。

Manager 私有 task reconciliation/acknowledgement 路由只接受 Runtime bearer、精确 scope/lifecycle/execution context 和 Runtime 派生的固定 owner 摘要；不接受命令、目标 session 文本或模型工具参数。reconcile 返回该 owner 尚未确认的有界进程快照，Runtime 在模型启动前将其并入责任 sidecar。acknowledge 只接受同一 owner 已处于 `completed|failed|cancelled` 的单个 process id；Runtime 必须先把 sidecar 条目从 `active` 原子写成 `resolved` tombstone，失败时不发送 acknowledge，Manager 确认后才原子删除 tombstone。scope cleanup 是同一确认协议的批量取消边界：Manager 只返回已确认终止且仍未 acknowledge 的责任身份，不返回命令、输出或 session 原文；Runtime 只有在对应本地 scope 状态已经提交后才能使用这些身份确认。

## Python 内部工具 Gateway

Runtime 使用与浏览器 session 分离的 bearer token 回调 Python。路由按平台现有所有者拆分：memory 使用 `/api/agent/tools/memory` 与 `/api/agent/tools/memory/search`，session search 使用 `/api/agent/tools/session/search`，knowledge 使用 `/api/agent/tools/knowledge/**`，模型访问凭据使用 `/api/agent/tools/credentials/resolve`；web、browser、schedule、skill 和其它 Runtime gateway 工具使用 `/internal/agent/tools/{tool}`。请求携带 Run、scope、lifecycle、session、workspace 和由平台提供的 actor/source message context。

Python 必须从可信 context 推导 memory owner、schedule owner、browser identity、Sylver Lining 连接 owner 和 credential provider；模型 arguments 中出现这些所有权字段时应拒绝，而不是覆盖 context。工具 action 只接受 Runtime schema 声明的当前名称：knowledge 为 `search|read`，web 为 `search|extract`，browser 为其 schema 中的规范 action。`/internal/agent/tools/{tool}` 只承载 web、browser、schedule、skill、mail 和 `sylver_platform`；memory、session 与 knowledge 只走上述专用路由。未声明的 action 别名、参数别名或把专用工具改发到通用路由都必须失败，不做转换。

scheduled Run 的 Gateway context 额外包含 Platform 签发的 `schedule_id`、`schedule_run_id` 与 `schedule_recurring`。`schedule.continue_current` 和 `schedule.complete_current` 的模型参数都必须是空对象；Python 只用可信 context 定位当前 occurrence。`continue_current` 原子复验当前 recurring occurrence、确认仍保留已经计算的下一次执行但不修改 schedule，`complete_current` 原子结束该计划。普通 Run、委派 Run、once occurrence、缺少任一身份、过期 occurrence、错误 recurring 标记或企图提供目标 id 都失败关闭。这两个窄 current-occurrence 动作是 unattended schedule 管理禁令的唯一例外；Runtime 只把 Gateway 成功的其中一个结果视为本轮机械决策，不能根据自然语言推断。

顶层 recurring scheduled Run 若在有界 follow-up 后仍没有机械决策，Runtime 以 `needs_review` 结束。Platform 把对应 schedule run 的 `needs_review` 或 `blocked` 终态与暂停所属计划放在同一 SQLite 事务：仅当 run 仍属于计划当前 `last_run_id` 和当前 revision 时设置 `state=paused`、`enabled=0`、`next_run_at=NULL`，重复执行保持幂等，迟到旧 occurrence 不得暂停或改写新 revision。

模型访问凭据请求只接受必填的 `provider`、`model`、`scope_key` 和可选的内部 `force_refresh`；`provider` 必须是规范 OAuth product id，`model` 必须是本次实际调用的非空模型 ID，`scope_key` 必须是当前 Run scope。Platform 在返回 Token 前确认 provider 是当前支持的 OAuth 类型，并确认 model 仍在同一凭据最近成功发现的账号目录与 Runtime 目录交集中。目录未配置、从未成功获取、已被新凭据替代或模型不在交集时失败关闭；Runtime 为视觉辅助模型请求 Token 时同样使用该模型自己的 ID，不能沿用主模型的授权判断。

knowledge `search` 只返回 active 向量索引的稳定结果，每项包含可交给 `read` 的正整数 `document_id`、`chunk_id`、来源偏移、excerpt 和 score。未配置 Embeddings API key、尚无 active generation 或 provider 失败时返回可区分的错误代码，不以空列表伪装成“无命中”，也不改走本地关键词检索。

知识库产品 API 以 `multipart/form-data` 向 `/api/knowledge/documents/import` 提交一至十个重复 `files` 字段；成功只返回按输入顺序排列的文档元数据和去重状态，不在批量响应中重复正文，任一文件失败时整批失败。`GET /api/knowledge/documents/{id}/download` 对有原件的条目返回原始字节，对手工条目返回 UTF-8 Markdown；两者都要求知识读取权限并只使用附件下载语义。Agent `knowledge` 工具仍只有 `search|read`，不获得文件上传或原件二进制读取能力。

memory 额外支持原子 `reconcile`，其 `operations` 至多二十项且只含 `store|replace|forget`。skill 额外支持精确 `patch`：参数包含 id、可选 support `file_path`、`old_string`、`new_string` 与 `expected_replacements`。复盘 Gateway context 在 memory 的 `search|read|list` 与变更请求中都必须携带 `parent_run_id`、`delegation_depth`、`trigger`、`unattended`、`review_mode` 和 `review_job_id`，并结合已有 run/scope/lifecycle/owner/source message 构成完整主体。Python 在执行任何复盘记忆查询或写入前必须反查 running job、当前 lifecycle、激活账号与权限；过期或不完整主体返回 403，不读取记忆。复盘 Skill 不能 delete、enable/disable、完整 update 或 remove/write support，支持文件修改同样走精确 patch。

Gateway 中网页、浏览器、邮件、知识、记忆、技能、计划和会话来源的成功内容与失败文本都是不可信数据。Runtime 必须在将两种结果交给模型前使用同一防伪边界；Python 返回非 2xx 不得使错误正文绕过该边界。

`mail` Gateway 只接受由 Run context 派生的私人账户所有权。读取动作为 `accounts/folders/search/read`，副作用动作为 `send/reply/move/mark/save_attachment`；unattended trigger 只能使用读取动作。SMTP mutation 携带 `run_id + tool_call_id` 幂等身份，结果不确定时返回 `needs_review` 语义而不是自动重发。

`sylver_platform` Gateway 只接受 canonical private scope，并从当前 lifecycle、活动账号和个人 AI 权限推导连接 owner。Runtime schema 与 Python dispatcher 使用同一个闭世界 action 集：读取 `whoami|projects|project|project_context|tasks|task|task_activity|wiki_list|wiki_read|approvals|approval|approval_comments|notifications`；写入 `create_task|start_task|add_task_activity|propose_wiki|comment_approval`。`tasks.assigned_to_me` 和 `notifications.unread_only` 缺省均为 `true`，显式 `false` 才读取相应全集；`approvals.box` 缺省为 `inbox`。`create_task` 必须包含非空唯一 `tag_ids`、起止日期，以及必填的 `milestone_id`；后者为正整数时选择真实里程碑，为 `null` 时表示用户明确确认跳过，description 若存在则必须是首行摘要和后续 `- ` 要点。其 Python 复合动作根据项目 workflow 是否存在唯一 `proposed` category 决定省略 status 走提案闸，否则只允许唯一 `backlog` status；`proposal_approver_id` 只允许用于前一条提案路径。`start_task.note`、`propose_wiki.content_format` 和 `propose_wiki.order` 都是显式必填参数，避免审批内容与实际写请求出现隐藏默认值。模型参数不得包含 base URL、Token、HTTP method/path/header、owner 或 scope。全部写动作要求本次审批和 `tool_call_id`，unattended context 直接拒绝；原始完整参数在脱敏前超过 16 KiB 或含不可见控制字符时在调用前失败关闭，脱敏展示也不得超限。审批决定、跳过审查、强制完成、员工管理、通用 REST 和删除动作没有协议表示。

浏览器人工接管不是 Runtime 工具。登录浏览器通过 Platform 同源 API 申请当前 scope/tab 的短期租约并发送限幅输入；连续拖拽只接受有界、单调计时的 `down → move[] → up` 完整轨迹，Camoufox 在异常路径保证最终抬键。Runtime 的变更型 browser 工具在租约存续时收到可重试冲突。客户端提供的 user id、selector、脚本和任意导航 URL 一律不进入该协议。

## 协议演进

协议变更必须先更新本文和相关机器契约，再同步 TypeScript 类型、Python client、事件映射和双方测试。删除字段或改变状态语义需要提升协议版本并原子升级双方；不提供未声明字段、状态或执行路径的静默 fallback。
