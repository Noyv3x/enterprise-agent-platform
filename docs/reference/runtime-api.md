# Agent Runtime 私有 API

本文定义 Platform 与 Runtime 之间的接口格式（wire）。状态机、持久化顺序和工具行为见 [Runtime 设计](../design/agent-runtime.md)。跨层数值以 [`runtime-policy.json`](../contracts/runtime-policy.json) 为准，其它上限见[配置](configuration.md)。

记号约定：

- `?` 表示字段**可以省略**，不表示可以传 null；只有明确写出 null 的地方 null 才有含义。
- object 指非数组的对象；JSON 指任意 JSON 值（包括 null）。
- 除另有说明外，时间戳都是 RFC3339 字符串。

## 传输与认证

- 只在私有网络上提供。所有端点（包括 health）都要求 `Authorization: Bearer <token>`，使用恒定时间比较。
- 请求 JSON 为 UTF-8 的 `application/json`，受正文字节数和完整读取时限约束。cancel 可以没有正文，有正文时只能是 `{}`。
- JSON 响应为 `application/json; charset=utf-8`，带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: default-src 'none'`。

**错误**

- 错误正文为 `{error:string}`，不含 traceback。SSE 已经开始后出错就关闭连接，不再改发 JSON。

| 状态码 | 含义 |
|---|---|
| 400 | 请求、JSON、字段、身份或游标非法 |
| 401 | bearer 无效 |
| 404 | 路径、方法或 Run 不存在 |
| 408 | 读取正文超时（关闭连接） |
| 409 | 追加输入冲突，或会话忙 |
| 413 | 正文超限（关闭连接） |
| 415 | 不是 JSON |
| 429 | 队列已满 |
| 500 | 未分类的内部错误 |

- 传输或 SSE 的时限不等于 Run 的总时限；请求失败不能证明没有产生副作用。

## Endpoint

- 除下表列出的查询参数外，一律拒绝查询参数；未知或重复的查询参数在订阅或产生副作用之前就拒绝。
- 请求正文的顶层和标注为"闭对象"的对象都拒绝未知字段。
- `metadata` 是 Platform 内部的 JSON 容器，文档没有列出的键不提供授权，也不承诺兼容。

| 方法和路径 | 请求 → 成功响应 |
|---|---|
| `GET /health` | 200 `{status:"ok",service:"agent-platform-runtime",version:string,pid:number,uptime_seconds:number}` |
| `GET /v1/models` | 200 模型目录 |
| `POST /v1/runs` | 创建 Run 的正文 → 202 `{run_id:string,status:RunStatus,events_url:string}` |
| `GET /v1/runs/{run_id}` | 200 Run 快照 |
| `GET /v1/runs/{run_id}/events` | 查询参数 `after?` → 200 SSE |
| `POST /v1/runs/{run_id}/input` | 追加输入的正文 → accepted 时 202，injected 时 200 |
| `POST /v1/runs/{run_id}/approval` | 审批正文 → 200 `{run_id,approval_id:string\|null,decision,resolved:true}` |
| `POST /v1/runs/{run_id}/cancel` | 空正文或 `{}` → 202 `{run_id,status}`；这不代表清理已完成 |
| `POST /v1/sessions/compact` | 压缩正文 → 200 压缩结果 |
| `POST /v1/scopes/cleanup` | 清理正文 → 200 `{scope_key,cancelled_runs:number,sessions_deleted:boolean}` |
| `GET /v1/scopes/processes` | 查询参数 `scope_key,lifecycle_id,since_revision?` → 200 进程预览 |
| `GET /v1/scopes/process-summary` | 查询参数 `scope_key,lifecycle_id` → 200 `{running_terminal_count:number}` |

- 没标类型的 run_id、scope_key、decision 都是字符串。
- `RunStatus = queued | running | completed | failed | cancelled | needs_review`，后四个是终态；幂等创建可能直接返回终态。
- 产品里的"撤回消息"不是 Runtime 的 cancel。

## 模型目录

- 响应：`{version:1,source:"pi-runtime",providers:{"openai-codex":Provider}}`
- Provider：`{provider:string,runtime_provider:string,default_model:string,models:Model[]}`
- Model：`{id:string,name:string,reasoning:boolean,input:string[],context_window:number,max_tokens:number}`

规则：

- 只接受规范的供应商名 `openai-codex`，没有别名；`runtime_provider` 为 `openai-codex`；OAuth 的 `default_model` 固定为空字符串，不是 null。
- 锁定 Pi 目录与账号目录的交集、推荐、过期目录和空目录的规则见[集成](../design/integrations.md)。这里不固定模型 ID，也不能把 Runtime 列表的第一项当作默认。

## 创建 Run

| 字段 | 类型和约束 |
|---|---|
| `scope_key`、`lifecycle_id`、`session_id` | 必填非空字符串，各不超过 512 字符；scope 和 lifecycle 禁止 NUL |
| `workspace` | 必填字符串，固定为 `/workspace` |
| `execution_context` | 必填闭对象 `{sandbox_id:string,workspace_id:string}`；由 Platform 派生，委派时继承 |
| `system_prompt` | 必填字符串，是 Platform 的上下文；不能从正文推断权限 |
| `input` | 必填，字符串或内容块数组 |
| `model` | 必填闭对象 `{provider:string,id:string,reasoning?:boolean}`；provider 和 id 非空且在 Runtime 目录中；禁止 api、base_url、baseUrl |
| `history?` | 锁定版本 Pi 的 `AgentMessage[]`，只是上下文种子，不构成授权 |
| `attachments?` | 最多 64 个闭对象 `{path?:string,name?:string,mime_type?:string}`；禁止 url 和图片 MIME |
| `thinking_level?` | 字符串，取锁定 Pi 的 ThinkingLevel，默认 off |
| `gateway?` | 闭对象 `{base_url?:string,token?:string}`；这是内部工具网关，不是模型端点 |
| `metadata?` | Platform 内部对象，字段见下表 |

**身份字段**

- `sandbox_id` 匹配 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`；`workspace_id` 是不超过 512 字符的相对标识，每个 `/` 分段都符合同样的规则。
- 身份不能与已建立的对话范围或生命周期冲突。
- 禁止传入 OAuth token、宿主机路径、Docker 身份或供应商端点覆盖；物化准入见 Runtime 设计。

**input 内容块**

- 闭对象，只有两种：`{type:"text",text:string}` 或 `{type:"image",data:string,mimeType:string}`。
- 图片由 Platform 读取受限的安全位图后以 base64 内联；Runtime 不从 attachments 读取模型图片，也不直接访问 Platform 文件系统。

**metadata 可选字段**

| 字段 | 类型 |
|---|---|
| `parent_run_id`、`approval_owner_run_id`、`approval_scope_key`、`approval_session_id`、`idempotency_key`、`trigger`、`review_mode`、`schedule_id`、`schedule_run_id`、`scheduled_for` | 字符串 |
| `delegation_depth` / `delegation_role` | 数字 / `"leaf" \| "orchestrator"` |
| `source_message_id`、`review_job_id` | 正的安全整数 |
| `unattended`、`schedule_recurring` | 布尔；recurring 由权威的 interval/cron 派生为 true，一次性计划为 false |
| `available_skills` | 有上限的 `{id:string,name:string,description?:string,category?:string}[]` |

**学习复盘 Run 的固定组合**

- 规范的 `private:<正整数>` 对话范围；正的 `source_message_id` 和 `review_job_id`；没有父 Run（省略或空字符串）且深度为 0（或省略）；`review_mode=memory_skill`、`trigger=learning_review`、`unattended=true`；`session_id=learning-review-<job>`；`idempotency_key=agent-learning-review:<job>`。
- 在排队和初始化会话之前校验。这两个命名空间是保留的，普通 Run 不能占用。能力和生命周期见[学习复盘 Run](../design/agent-runtime.md#学习复盘-run)。

**幂等**

- 非空的幂等键在对话范围内唯一，重复创建会复用原 Run。重启时被中断的 Run 标为 needs_review，不重做；已持久化的终态只合成重放事件。保留和提交规则见 [Run 状态机](../design/agent-runtime.md#run-状态机)。

**Run 快照**

- `{run_id,status,created_at,updated_at,session_id,scope_key,result?:RunResult,error?:string}`，除 status 和 result 外都是字符串。
- `RunResult = {content:string,messages:AgentMessage[],model:{provider:string,id:string},usage?:object,context_usage?:ContextUsage,input_message_ids?:string[],unconsumed_input_message_ids?:string[]}`。
- `content` 是本 Run 最后一条助手回复的正文；不拼接中间回答，不扣留或恢复 MEDIA 标记。
- 没有值的可选字段直接省略。持久化的 messages 经过脱敏，不保存实时图片的 base64；恢复时 messages 为空数组，不恢复原消息流。

**ContextUsage**

- `{used_tokens:number,max_tokens:number,percent:number,estimated:boolean}`，表示当前有效的上下文占用，不是累计账单。
- 含有估算时 estimated 为 true；max_tokens 来自可信目录；percent 只为展示而夹取，不截断 used_tokens。
- [计量规则](../design/agent-runtime.md#会话与压缩)禁止复用失效的或上一个 Run 的用量。

## 追加输入

- 闭正文：`{message_id:string,scope_key:string,lifecycle_id:string,input,attachments?}`。message_id 非空且不超过 512 字符；input 和 attachments 与创建 Run 相同。
- 只有个人 AI 的顶层交互 Run 支持，必须匹配原来的对话范围和生命周期。
- 同一个 message_id 且内容相同时复用；内容不同或接收窗口已关闭时返回 409。
- 响应：`{run_id:string,message_id:string,state:"accepted"|"injected"}`。accepted 只表示已登记，injected 才表示已被消费。
- 未消费的输入通过 `input.unconsumed` 事件和终态里的 ID 列表交回[原队列](../design/data-memory-sessions.md)，不会被重新执行，也不会谎报已消费。

## 立即压缩 Session

- 闭正文：`{scope_key:string,lifecycle_id:string,session_id:string,model,gateway?}`。身份字段非空、各不超过 512 字符且禁止控制字符；model 和 gateway 与创建 Run 相同，只用于本次摘要，不写入会话。
- 该身份下有排队或运行中的 Run，或正在压缩时，返回 409；请求非法返回 400。
- 200 响应：`{compacted:boolean,omitted_messages:number,retained_messages:number}`。
  - omitted_messages 只计真实消息；实际发生压缩时，retained_messages 包含当前的摘要。
  - 没有可省略的历史时 compacted 为 false；重复调用不会让文件增长。
- 这是控制操作：不创建 Run 或命令消息，不删除归档。Platform 的读取时限为五分钟；取消、提交与删除的边界见[压缩规则](../design/agent-runtime.md#会话与压缩)。

## SSE journal

**格式**

- 响应头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`Connection: keep-alive`、`X-Accel-Buffering: no`。
- 每帧包含 `id:<sequence>`、`event:<type>`、`data:<JSON>`；信封为 `{sequence:number,type:string,run_id:string,timestamp:string,data:object}`。连接确认和心跳是 SSE 注释。

**顺序与补读**

- 先记录再广播；同一个 journal 的 sequence 单调递增。
- `Last-Event-ID` 和 `after` 必须是完整的、非负的安全整数十进制表示；两者都有时取较大值，只发送之后的事件。尾随字符、负数、溢出或重复的 after 在订阅之前就拒绝。
- 只能补读**当前内存中保留的后缀**：没有缺口标记、没有永久历史、没有跨重启稳定的游标，也不保证恰好一次。超出保留窗口的就补不回来。
- 幂等 Run 重启后的恢复，是一个新 journal 里的 reused 加终态事件，不复原旧的消息和工具流；运行中重复创建不发 reused。

**背压**

- 每个连接有独立的有上限发送队列；背压解除后按 sequence 发送完整帧，超限就断开该连接，不阻塞 Agent 或其它读者。心跳和终态事件同样受这个上限约束，终态发送完后关闭连接。

**事件数据**

下表中：`T = {turn_id:string,turn_index:number}`，`C = {tool_call_id:string,tool_name:string}`。除明确标注外，身份、名称、内容、原因、错误、状态、决定和结果都是字符串；arguments、result、partial_result 是与工具相关的 JSON。

- JSON 复制时省略 undefined、保留 null、去掉内部审批 key。超限时可能变成 `{truncated:true,original_bytes:number|"unserializable",…放得下的其它字段}`；被省略不等于成功的证据。

| 事件 | data |
|---|---|
| `run.queued` / `run.started` | `status:"queued"` / `status:"running"` |
| `run.reused` | `status,persisted:true` |
| `message.delta` / `thinking.delta` | `delta:string,content_index:number,...T` |
| `message.final` | `content,stop_reason:string,usage:object,...T`；可能多次出现，不是唯一的终稿 |
| `tool.arguments.delta` | `content_index:number,...T`，可以附带下文的文件草稿，不含原始增量 |
| `execution.audit` | `audit_id,...C,operation:string,target:string,details:object`；这不是执行回执 |
| `tool.started` | `...C,arguments,execution_started:true,audit_id?:string,executor_id?:string,target?:string`（后三项只在有回执时出现） |
| `tool.updated` | `...C,partial_result,execution_started:true`（已权威开始） |
| `tool.completed` / `tool.failed` | `...C,result,is_error:boolean,execution_started:boolean,unattended_authorization_required?:true,reason?:string` |
| 委派转发的 `tool.failed` | `child_run_id,unattended_authorization_required:true,reason,tool_call_id?:string,tool_name?:string`；不保证其它常规结果字段 |
| `approval.requested` | `approval_id,tool_name,arguments,reason,allow_session:boolean,allow_permanent:boolean,choices:string[],scope_key,session_id` |
| `approval.resolved` | `approval_id,tool_name,decision,outcome`；decision 和 outcome 是同一个结果标记 |
| `input.accepted` / `input.injected` | `message_id,state:"accepted"` / `message_id,state:"injected",...T` |
| `input.unconsumed` | `message_id,state:"unconsumed",reason` |
| `delegation.started` | `child_run_id,depth:number` |
| `delegation.completed` | `child_run_id,content,side_effects_started:boolean` |
| `delegation.failed` | `child_run_id,status,error,side_effects_started:boolean` |
| `context.compacted` / `session.repaired` | `omitted_messages:number,retained_messages:number` / `interrupted_tool_messages:number` |
| `run.idle_timeout` | `timeout_ms:number,idle_ms:number,last_activity:string,last_activity_at:string` |
| `run.turn_limit` / `run.cleanup_timeout` | `max_turns:number,completed_turns:number,blocked_turn:number` / `cleanup_grace_ms:number` |

- journal 里的图片用元数据、字节数和省略标记代替 base64；敏感值被脱敏；邮件和 MCP 的结果只有省略后的投影。

**终态事件**

- `run.completed | run.failed | run.cancelled | run.needs_review` 的 data 包含 `status,input_message_ids:string[],unconsumed_input_message_ids:string[],error?:string`。
- 有结果时再加 `output:string,content:string,session_id:string,model:{provider:string,id:string},usage:object,context_usage?:ContextUsage`，其中 output 和 content 相同。没有结果时省略这些字段；恢复时另加 `reused:true`。
- needs_review 的正文只是真实的、有上限的阶段诊断，error 单独给出阻塞原因；在 Python 中是 `AgentRuntimeRunError.partial_content`。幂等重放后仍然不是成功。非成功的 Run 中的 MEDIA 不解析、不复制、不发布为附件。
- 成功的 output 直接保留最终助手回复；其中的 MEDIA 标记仍须经 Platform 授权，不执行 Runtime 的中间回复标记恢复。
- [模型重试](../design/agent-runtime.md#run-状态机)只针对还没有可见增量的请求，不新增 Run、会话或工具记录；Platform 不根据错误文字重新提交 Run。

### 文件草稿

- 只有 openai-codex + openai-codex-responses 的沙箱 `write_file`/`patch_file`、且路径是安全的工作区路径时，才会附加：`{...C,file_draft:{workspace_path:string,kind:"file"|"replacement",content?:string,revision:number,complete:boolean,truncated:boolean,discarded:boolean}}`。
- write 取累积的完整内容（kind=file）；patch 只取 new_text（kind=replacement）。路径是规范的工作区相对路径。
- 调用身份保持稳定，revision 严格递增。累积正文经过脱敏、有上限；未完成时保留安全尾窗，只在检查点发布；`toolcall_end` 时发布最终版。
- complete 只表示参数已输出完毕，不代表通过了校验、审批、执行或提交。之后如果目标或路径变得不合格，同一身份以 `discarded=true` 且**省略 content** 撤回。
- 不传原始 JSON 片段、old_text、宿主机或工作区外的正文、凭据。其它供应商、API、工具或没有安全路径的情况只有不含正文的进度。
- 只有 Codex 这两个工具的 schema 要求显式 target；完整调用意外省略 target 时，在校验、执行和写入历史之前补为 sandbox；显式的 host 以及其它供应商和工具的默认值不变。未完成的参数不校验、不审批、不执行，也不授权副作用。
- 前端只能平滑地揭示已收到的字符，不能缩小安全窗口或伪造 revision。正文只在当前 Run 里临时预览，不进入通用的状态 SSE 或持久工作记录。

**delegate_task 的结果**

- 单个任务实时返回 `{child_run_id,status:"completed",content,side_effects_started:boolean}`。
- 批量返回 `{results:[{index:number,...成功结果}|{index:number,status:"failed",error:string}]}`，按输入顺序排列。
- 副作用标记由 Runtime 生成并传播到父 Run，失败或取消后的不确定结果仍须人工确认；成功委派不触发额外复验守卫。

## 审批与执行审计

**审批请求**

- 闭正文：`{approval_id?:string,decision:"once"|"session"|"always"|"deny"}`。显式给出的 ID 必须非空；省略时处理最新的待决项，响应里 approval_id 为 null。
- 浏览器必须提交展示时看到的 run_id、approval_id 和选项；身份过期返回 409，不能被换成当前待决项。实际允许的值以 `choices` 为准。
- 结果标记还可能是 timeout、cancelled、notification_failed，这些都按"未授权"关闭，不是内部的 approved/denied。
- 密钥和内部 key 不进入事件；[审批范围和精确绑定](../design/security-and-trust.md#工具执行与审计)由安全设计定义。

**执行审计**

- 执行目标只有 sandbox 和 host，默认 sandbox。
- terminal 只有在后台执行时才能带 `background_kind=task|service`，默认 task；前台带这个字段或值未知时拒绝。这个字段不直接发给 Manager，只用来派生 completion_required 和归属摘要。
- 审计包含完整的脱敏参数、规范的路径和工作目录、目标、前台或后台、实际超时。Manager 的回执回显审计 ID、执行器 ID 和实际目标之后，才发出 `tool.started`。
- 子 Run 审批的对话范围和会话必须来自可信的元数据，不能由模型参数决定。

## Scope 与进程

**清理**

- 闭正文：`{scope_key:string,lifecycle_id?:string,delete_sessions?:boolean}`。scope_key 非空且不超过 512 字符；lifecycle_id 如果提供，是不超过 512 字符的字符串，省略或空字符串表示不限生命周期；delete_sessions 默认 false。
- 普通清理会清掉 task 责任，保留 journal、todo 和普通会话；`delete_sessions=true` 删除整个会话家族。
- 只有所有阶段都确认后才返回成功，不报告部分成功；[启动屏障、本地提交和确认的顺序](../design/agent-runtime.md#停止与恢复)由 Runtime 设计定义。

**进程预览与计数**

- 预览和计数的 scope_key、lifecycle_id 查询参数各恰好一个，去掉首尾空格后非空且不超过 512 字符。
- 家族指根范围本身和 `root + "/delegate/"` 下的后代，不包括前缀相似的其它范围。
- revision 是不透明的值，展示的输出或状态改变时一定变化；Manager 重启后旧值失效。
- 预览响应为 `{processes:Preview[],revision:string}`，或者 `{processes:[],revision:string,unchanged:true}`；普通的空数组不表示 unchanged。

| 对象 | 字段 |
|---|---|
| Preview 的字符串字段 | `id,title,command,cwd,output,started_at,updated_at` |
| Preview 的其它字段 | `status:ProcessStatus,running:boolean,truncated:boolean,exit_code?:number\|null,finished_at?:string` |
| ProcessStatus | `running \| completed \| failed \| cancelled \| orphaned` |
| Snapshot 的字符串字段 | `id,run_id,scope_key,lifecycle_id,command,cwd,stdout,stderr,started_at` |
| Snapshot 的其它字段 | `status:ProcessStatus,background:boolean,pid?:number,exit_code?:number\|null,finished_at?:string,stop_confirmed?:boolean` |

- Manager 是进程清单的权威，Runtime 负责过滤和脱敏。预览先列活动组，同组内按 started_at 倒序。
- orphaned 必须 `running=true`，计入运行数和更新阻塞，保留沙箱，不能降级为已完成。[前端](../design/frontend.md)只读显示"需关注、仍占用"，不提供强制清理。
- 计数是非负的安全整数，不等于有上限的预览长度。进程清单未知时不能销毁容器；更新只延迟需要刷新的那个沙箱。

**process.wait**

- 必填 `process_id`，可选 `timeout_ms`（取值见策略 JSON）；返回 Snapshot 加 `wait_timed_out:boolean`。
- 观察的是精确的执行上下文、对话范围、生命周期、目标和 ID。超时或中止只结束等待，不杀进程；重复等待可以读到同一个终态。
- 责任解除、空闲检测暂停和 HTTP 等待余量见[有限后台任务](../design/agent-runtime.md#有限后台任务)。

### Manager 私有控制

以下接口只允许 Runtime 的 bearer，不是模型接口。

- `TaskIdentity = {scope_id:string,lifecycle_id:string,execution_context,completion_owner_id:string}`；owner 是 Runtime 派生的固定摘要，禁止包含会话原文和命令。

| POST 路径 | 请求 → 响应 |
|---|---|
| `/v1/executor/tasks/reconcile` | TaskIdentity → `{processes:(Snapshot & {target:"sandbox"\|"host"})[]}`，有上限的未确认 task |
| `/v1/executor/tasks/acknowledge` | TaskIdentity 加 `process_id:string` → `{confirmed:boolean}`；只接受同一归属的终态，必须 confirmed=true |
| `/v1/executor/scopes/cleanup` | `{scope_id:string,lifecycle_id?:string}` → `{confirmed:true,completion_tasks:(TaskIdentity & {process_id:string,target:string})[]}`；封闭的证据集合，不含命令、输出或会话 |
| `/v1/executor/runs/cancel` | `{run_id:string,scope_id:string,lifecycle_id:string,execution_context,preserve_process_ids?:string[]}` → `{confirmed:boolean}` |

- reconcile 和 acknowledge 是必需的方法。本地标记的提交顺序和可信的保留集合见 [Runtime · 有限后台任务](../design/agent-runtime.md#有限后台任务)，不能静默跳过。
- Manager 的 HTTP 响应必须在完整编码 JSON 之后才提交状态码。操作类修改的控制确认只返回固定大小的确认；executor 的 cancel 和 acknowledge 返回确认字段；清理必须返回有上限的 completion_tasks 证据。
- 需要读取正文的客户端以"上限 + 1"的方式有界读取，区分出超限。2xx 响应的正文丢失或损坏，不能推断为"没有执行"，要用[原键和日志对账](../operations/auto-update.md)。

## Python 内部工具 Gateway

**地址与认证**

- 使用独立的 bearer，不使用浏览器会话。
- 配置了受管地址时，它就是权威地址，Run 里的 `gateway.base_url` 不能覆盖；Run 里非空的 `gateway.token` 只能替换发往这个固定地址的默认 token。
- 只有没配置受管地址时，才使用 Run 提供的地址和 token；不能把 Run 的地址和部署默认 token 配对使用。

**请求格式**

- 通用信封：`{tool:string,action:string,arguments:object,context:Context}`。专用路由不使用这个信封。

| POST 路由 | 格式 |
|---|---|
| `/internal/agent/tools/{web\|browser\|schedule\|skill\|mail}` | 通用信封，只接受当前 schema 的 action 和参数，没有别名；web 的 action 为 search/extract |
| `/api/agent/tools/memory/search` | 扁平的参数加可信身份，action 为 search/read/list |
| `/api/agent/tools/memory` | 同上；store/forget 映射为 add/remove，其它动作不变 |
| `/api/agent/tools/session/search` | 扁平的参数加身份，action 为 search/list/read；read 的 session_id 是已授权的目标 |
| `/api/agent/tools/credentials/resolve` | `{provider:string,model:string,scope_key:string,force_refresh?:boolean}` → `{provider:string,access_token:string,token_type:"Bearer",expires_at:number\|null,base_url:string,model:string}`；expires_at 是 Unix 秒，没有到期时间时为 null |

| Context 字段 | 类型 |
|---|---|
| `run_id`、`scope_key`、`lifecycle_id`、`session_id`、`workspace` | 必填字符串 |
| `owner_user_id`、`source_message_id`、`review_job_id`、`delegation_depth` | 可选数字 |
| `tool_call_id`、`parent_run_id`、`trigger`、`review_mode`、`schedule_id`、`schedule_run_id` | 可选字符串 |
| `unattended`、`schedule_recurring` | 可选布尔 |

- memory 和 session 的扁平请求携带 run、scope、lifecycle、session；所有者和自动来源由可信上下文派生，模型不能指定。
- 每次凭据请求（包括辅助视觉模型）都必须使用本次实际的模型和当前对话范围，并复验[账号目录的安全交集](../design/integrations.md)。

**响应**

- `{content?:string,data?:JSON,memories?:JSON[],memory?:JSON,found?:boolean,is_error?:boolean,error?:string}`。成功和失败（包括非 2xx 的正文）都经过同样的[不可信内容封装](../design/security-and-trust.md#不可信内容与提示词注入)。

**各工具的特殊规则**

- **周期计划**：Platform 签发完整的计划上下文，`continue_current`/`complete_current` 只接受空参数；只有这两个动作是"无人值守不能管理计划"这一禁令的例外。不是当前顶层的周期执行、身份缺失或过期、标记错误或带了目标 ID，一律拒绝。只有成功的网关结果才构成[机械决策](../design/agent-runtime.md#完成守卫)。
- **记忆与 Skill**：reconcile 的原子操作最多 20 项，只能是 store/replace/forget。Skill patch 的格式为 `{id:string,file_path?:string,old_string:string,new_string:string,expected_replacements:integer}`。
- **复盘**：所有读写都传完整的主体：parent_run_id 和 delegation_depth、trigger 和 unattended、review_mode 和 review_job_id，以及所有者、来源消息、Run、对话范围和生命周期。旧的或不完整的主体在访问数据之前返回 403。允许的动作、逐次读写授权和预算见 [Runtime](../design/agent-runtime.md#学习复盘-run) 和[数据设计](../design/data-memory-sessions.md#学习复盘)。
- **邮件**：只使用可信的个人上下文。读取类动作为 accounts/folders/search/read；副作用类为 send/reply/move/mark/save_attachment；无人值守时只能读取。SMTP 修改以 run_id + tool_call_id 保证幂等，结果不确定时标为 needs_review，不能重发。
- **MCP** 不经过 Python：list 可以选 server；call 必须提供 server、tool 和有上限的 JSON 参数。完整参数审批、硬性拦截、stdio 生命周期和日志隐私见[集成](../design/integrations.md)。
- 人工**浏览器接管**不是 Runtime 工具；租约期间，修改型工具收到可重试的冲突。[Platform 的租约](../design/frontend.md#浏览器接管与发送)和[输入校验边界](../design/security-and-trust.md#浏览器接管与局域网)不由模型指定。

## 协议演进

- 修改字段或状态时，先更新本文和机器契约，再同步 TypeScript、Python 客户端、事件映射和双方的测试。删除字段或改变状态语义时要提升协议版本，双方原子升级。
- 对话范围清理、空闲会话压缩、终端预览、模型目录、审批响应和追加输入都是完整客户端的必需方法。缺失属于编程契约错误，不能当作旧版 Runtime 而静默跳过、降级或重新排队，也不为未声明的字段或执行路径提供后备。
