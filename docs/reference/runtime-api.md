# Agent Runtime 私有 API

本文定义 Platform↔Runtime wire；状态机、耐久顺序和工具行为见 [Runtime 设计](../design/agent-runtime.md)。跨层数值以 [`runtime-policy.json`](../contracts/runtime-policy.json)为准，其它上限见[配置](configuration.md)。下文 `?` 表示可省略，**不是可传 null**；明确列出的 null 才有语义。object 指非数组对象，JSON 包括 null 等 JSON 值；除另有说明外，时间戳为 RFC3339 string。

## 传输与认证

仅私有网络；所有 endpoint（含 health）要求 `Authorization: Bearer <token>`、定时安全比较。JSON 为 UTF-8 `application/json`，受 body 字节/完整读取 deadline 限制；cancel 可无 body，否则只能 `{}`。JSON 响应为 `application/json; charset=utf-8`、`Cache-Control: no-store`；另有 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: default-src 'none'`。

错误 `{error:string}` 不含 traceback；SSE 已开始则关闭连接，不改发 JSON。HTTP：400 请求/JSON/字段/身份/游标非法；401 bearer 无效；404 路径/方法/Run 不存在；408 body 超时、413 超限（均关连接）；409 input 冲突/session busy；415 非 JSON；429 队列满；未分类内部错误 500。传输/SSE deadline 不等于 Run 总时限，失败不证明无副作用。

## Endpoint

除表列 query 外均拒绝查询参数；未知/重复 query 在订阅/副作用前拒绝。body 顶层与标注的闭对象拒未知字段。metadata 是 Platform 内部 JSON 容器，未记录键不提供授权或兼容承诺。

| 方法、路径 | 请求 → 成功响应 |
|---|---|
| `GET /health` | 200 `{status:"ok",service:"agent-platform-runtime",version:string,pid:number,uptime_seconds:number}` |
| `GET /v1/models` | 200 模型目录 |
| `POST /v1/runs` | Run body → 202 `{run_id:string,status:RunStatus,events_url:string}` |
| `GET /v1/runs/{run_id}` | 200 Run 快照 |
| `GET /v1/runs/{run_id}/events` | query `after?` → 200 SSE |
| `POST /v1/runs/{run_id}/input` | Input body → accepted 202 / injected 200 |
| `POST /v1/runs/{run_id}/approval` | 审批 body → 200 `{run_id,approval_id:string\|null,decision,resolved:true}` |
| `POST /v1/runs/{run_id}/cancel` | 空 body/`{}` → 202 `{run_id,status}`；不是清理已完成确认 |
| `POST /v1/sessions/compact` | compact body → 200 压缩结果 |
| `POST /v1/scopes/cleanup` | cleanup body → 200 `{scope_key,cancelled_runs:number,sessions_deleted:boolean}` |
| `GET /v1/scopes/processes` | query `scope_key,lifecycle_id,since_revision?` → 200 预览 |
| `GET /v1/scopes/process-summary` | query `scope_key,lifecycle_id` → 200 `{running_terminal_count:number}` |

未标类型的 run_id/scope_key/decision 为 string。`RunStatus=queued|running|completed|failed|cancelled|needs_review`，后四项终态；幂等创建可返回已终态状态。产品消息撤回不是 Runtime cancel。

## 模型目录

响应为 `{version:1,source:"pi-runtime",providers:{"openai-codex":Provider}}`。Provider 为 `{provider:string,runtime_provider:string,default_model:string,models:Model[]}`；Model 为 `{id:string,name:string,reasoning:boolean,input:string[],context_window:number,max_tokens:number}`。

只接受规范 provider `openai-codex`，无别名；runtime_provider 为 openai-codex，OAuth default_model 固定为空串而非 null。锁定 Pi 目录与账号目录的交集、推荐、stale 和空目录规则由[集成](../design/integrations.md)定义；不在此固定模型 ID，也不能从 Runtime 首项推默认。

## 创建 Run

| 字段 | 类型、约束 |
|---|---|
| `scope_key,lifecycle_id,session_id` | 必填非空 string，各≤512 字符；scope/lifecycle 禁 NUL |
| `workspace` | 必填 string，固定 `/workspace` |
| `execution_context` | 必填闭对象 `{sandbox_id:string,workspace_id:string}`；Platform 派生，委派继承 |
| `system_prompt` | 必填 string，Platform context，不从正文推权限 |
| `input` | 必填 string 或内容块数组 |
| `model` | 必填闭对象 `{provider:string,id:string,reasoning?:boolean}`；provider/id 非空且在 Runtime 目录，禁 api/base_url/baseUrl |
| `history?` | 锁定 Pi `AgentMessage[]`，上下文 seed，不是授权 |
| `attachments?` | ≤64 个闭对象 `{path?:string,name?:string,mime_type?:string}`；禁 url/image MIME |
| `thinking_level?` | string，锁定 Pi ThinkingLevel，缺省 off |
| `gateway?` | 闭对象 `{base_url?:string,token?:string}`；内部工具 Gateway，非模型 endpoint |
| `metadata?` | Platform 内部对象，字段见下表 |

sandbox_id 匹配 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`；workspace_id 为≤512 字符相对标识，每个 `/` 分段符合相同规则。身份不得与已建立 scope/lifecycle 冲突。禁 OAuth token、宿主路径、Docker 身份、provider endpoint 覆盖；物化准入见 Runtime 设计。

input 闭块为 `{type:"text",text:string}` 或 `{type:"image",data:string,mimeType:string}`；图片由 Platform 读取受限安全位图后内联 base64，Runtime 不从 attachments 读模型图片或直接访问 Platform 文件系统。

| metadata 可选字段 | 类型 |
|---|---|
| `parent_run_id,approval_owner_run_id,approval_scope_key,approval_session_id,idempotency_key,trigger,review_mode,schedule_id,schedule_run_id,scheduled_for` | string |
| `delegation_depth` / `delegation_role` | number / `"leaf"\|"orchestrator"` |
| `source_message_id,review_job_id` | 正安全整数 |
| `unattended,schedule_recurring` | boolean；recurring 由权威 interval/cron 派生 true，once=false |
| `available_skills` | 有界 `{id:string,name:string,description?:string,category?:string}[]` |

复盘组合：canonical `private:<正整数>` scope、正 source_message_id/review_job_id、无 parent（省略/空串）及 depth（省略/0）、`review_mode=memory_skill,trigger=learning_review,unattended=true`、`session_id=learning-review-<job>`、`idempotency_key=agent-learning-review:<job>`。排队/session 初始化前校验；两个命名空间为保留，普通 Run 不得预占。能力与 lifecycle 见[学习复盘](../design/agent-runtime.md#学习复盘-run)。

非空幂等键 scope 内唯一，重复复用原 Run；重启中断 Run 为 needs_review、不重做，持久终态仅合成重放事件。保留/提交规则见[状态机](../design/agent-runtime.md#run-状态机)。

快照 `{run_id,status,created_at,updated_at,session_id,scope_key,result?:RunResult,error?:string}`（除 status/result 外其余 string）。RunResult 为 `{content:string,messages:AgentMessage[],model:{provider:string,id:string},usage?:object,context_usage?:ContextUsage,input_message_ids?:string[],unconsumed_input_message_ids?:string[]}`。无可选值则省略；durable messages 脱敏且不存 live image base64，恢复 messages=[]，不恢复原消息流。

ContextUsage 为 `{used_tokens:number,max_tokens:number,percent:number,estimated:boolean}`，表示现役上下文非累计账单；含估算即 true，max 来自可信目录，percent 展示夹取不截断 used_tokens。[计量规则](../design/agent-runtime.md#会话与压缩)禁止复用失效/上个 Run 的 usage。

## 追加输入

闭 body `{message_id:string,scope_key:string,lifecycle_id:string,input,attachments?}`：id 非空≤512，input/attachments 同创建，仅私人顶层交互支持，须匹配原 scope/lifecycle。同 message_id 同内容复用，异内容/窗口关闭409。响应 `{run_id:string,message_id:string,state:"accepted"|"injected"}`；accepted只登记，injected才消费。未消费经 input.unconsumed/终态 ids 交回[原队列](../design/data-memory-sessions.md)，不重执行/假报消费。

## 立即压缩 Session

闭 body 为 `{scope_key:string,lifecycle_id:string,session_id:string,model,gateway?}`。身份非空、各≤512字符且禁控制字符，model/gateway 同创建，仅供本次摘要、不写 session。当前身份有 queued/running Run 或压缩时返回409，非法请求400。

200 响应 `{compacted:boolean,omitted_messages:number,retained_messages:number}`：omitted 只计真实消息，retained 在实际压缩时含现役摘要；无可省略历史为 false，重复调用不增长文件。控制操作不创建 Run/命令、不删除 archive。Platform 读取 deadline 为五分钟；取消、提交与删除边界见[压缩契约](../design/agent-runtime.md#会话与压缩)。

## SSE journal

头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`Connection: keep-alive`、`X-Accel-Buffering: no`。帧含 `id:<sequence>`、`event:<type>`、`data:<JSON>`；envelope `{sequence:number,type:string,run_id:string,timestamp:string,data:object}`。连接/heartbeat 为注释。

先记录再广播，单 journal sequence 递增。Last-Event-ID/after 必须完整非负安全整数十进制，取较大值并送后续事件；尾随字符/负数/溢出/重复 after 在订阅前拒绝。只补读**当前内存保留后缀**，无 gap sentinel、永久历史、跨重启稳定游标或 exactly-once 保证；越过保留窗口不能补齐。幂等重启恢复是新 journal 的 reused+终态，不复原旧消息/工具流，live 重复创建不发 reused。

每连接独立有界发送队列；背压解除按 sequence 排完整帧，超限断该连接，不阻塞 Agent/其它读者。heartbeat/终态同界，终态排空关闭。

以下为正常未截断 data：`T={turn_id:string,turn_index:number}`，`C={tool_call_id:string,tool_name:string}`；除明确标注外，identity/name/content/reason/error/status/decision/outcome 为 string，arguments/result/partial_result 为工具相关 JSON。JSON 复制省略 undefined、保留 null、去内部 approval key；超限可变成 `{truncated:true,original_bytes:number|"unserializable",…容得下的字段}`，省略不等于成功证据。

| 事件 | data |
|---|---|
| `run.queued / run.started` | `status:"queued" / "running"` |
| `run.reused` | `status,persisted:true` |
| `message.delta / thinking.delta` | `delta:string,content_index:number,...T` |
| `message.final` | `content,stop_reason:string,usage:object,...T`；可多次，非唯一终稿 |
| `tool.arguments.delta` | `content_index:number,...T`，可加下述草稿，无 raw delta |
| `execution.audit` | `audit_id,...C,operation:string,target:string,details:object`，非 receipt |
| `tool.started` | `...C,arguments,execution_started:true,audit_id?:string,executor_id?:string,target?:string`（后三项仅 receipt） |
| `tool.updated` | `...C,partial_result,execution_started:true`（已权威开始） |
| `tool.completed / tool.failed` | `...C,result,is_error:boolean,execution_started:boolean,unattended_authorization_required?:true,reason?:string` |
| 委派转发 `tool.failed` | `child_run_id,unattended_authorization_required:true,reason,tool_call_id?:string,tool_name?:string`，无其它常规结果保证 |
| `approval.requested` | `approval_id,tool_name,arguments,reason,allow_session:boolean,allow_permanent:boolean,choices:string[],scope_key,session_id` |
| `approval.resolved` | `approval_id,tool_name,decision,outcome`；后二者相同 resolution token |
| `input.accepted / input.injected` | `message_id,state:"accepted"` / `message_id,state:"injected",...T` |
| `input.unconsumed` | `message_id,state:"unconsumed",reason` |
| `delegation.started` | `child_run_id,depth:number` |
| `delegation.completed` | `child_run_id,content,side_effects_started:boolean,changed_files:string[],unknown_change:boolean` |
| `delegation.failed` | `child_run_id,status,error,side_effects_started:boolean` |
| `context.compacted / session.repaired` | `omitted_messages:number,retained_messages:number` / `interrupted_tool_messages:number` |
| `run.idle_timeout` | `timeout_ms:number,idle_ms:number,last_activity:string,last_activity_at:string` |
| `run.turn_limit / run.cleanup_timeout` | `max_turns:number,completed_turns:number,blocked_turn:number` / `cleanup_grace_ms:number` |

journal 图片用元数据/bytes/省略标志代 base64，敏感值脱敏；mail/MCP 结果仅省略投影。终态 `run.completed|run.failed|run.cancelled|run.needs_review` data 含 `status,input_message_ids:string[],unconsumed_input_message_ids:string[],error?:string`；有结果加 `output:string,content:string,session_id:string,model:{provider:string,id:string},usage:object,context_usage?:ContextUsage`，output/content 同文；无结果省略，恢复另加 reused:true。

needs_review 正文仅真实有界阶段诊断，error 独立给 blocker，Python 为 `AgentRuntimeRunError.partial_content`，幂等重放仍非成功；非成功 MEDIA 不解析/复制/发布附件。成功 output 仅在内部复验清除相关变更后保留中间回复规范 MEDIA，仍须 Platform 授权。[模型重试](../design/agent-runtime.md#run-状态机)仅无可见增量请求，不新增 Run/session/tool 记录，Platform 不按错误文字重提 Run。

### 文件草稿

仅 openai-codex + openai-codex-responses 的 sandbox write_file/patch_file、安全工作区路径可追加 `{...C,file_draft:{workspace_path:string,kind:"file"|"replacement",content?:string,revision:number,complete:boolean,truncated:boolean,discarded:boolean}}`。

write 取累积 content/kind=file，patch 仅 new_text/kind=replacement；路径为规范 workspace 相对路径。call identity 稳定、revision 严增；累积正文脱敏有界、非终结保留安全尾窗、仅检查点发布，toolcall_end 发最终版。complete 只指参数输出完，不是校验/审批/执行/提交。后续 target/path 不合格，同 identity discarded=true、**省略 content**撤回。

raw JSON fragment、old_text、host/工作区外正文、凭据不传；其它 provider/API/工具/无安全路径仅无正文进度。仅 Codex 两工具模型 schema 要显式 target；完整调用意外省略在校验/执行/历史前补 sandbox，显式 host 和其它 provider/工具默认不变。未完成参数不校验/审批/执行，不授权副作用。前端只能平滑揭示已收到字符，不缩安全窗/造 revision；正文只在当前 Run 临时预览，不进通用状态 SSE/持久工作记录。

delegate_task 实时单结果 `{child_run_id,status:"completed",content,side_effects_started:boolean,changed_files:string[],unknown_change:boolean}`；批量 `{results:[{index:number,...成功证据}|{index:number,status:"failed",error:string}]}` 按输入顺序。证据 Runtime 生成，非模型参数/文字解析；父[复验](../design/agent-runtime.md#委派)不由成功自述替代。

## 审批与执行审计

闭 body 为 `{approval_id?:string,decision:"once"|"session"|"always"|"deny"}`。显式 id 必须非空；省略时处理最新待决项，响应 approval_id=null。浏览器必须提交展示时的 run_id/approval_id/choice；迟到身份返回409，不得换成当前项。实际允许值以 choices 为准。resolution token 另含 timeout/cancelled/notification_failed，这些均按未授权关闭，不是内部 approved/denied。secret 与内部 key 不进事件；[审批范围和精确绑定](../design/security-and-trust.md#工具执行与审计)由安全设计定义。

执行 target 仅 sandbox/host，缺省 sandbox。terminal 仅在后台可携带 background_kind=task/service，缺省 task；前台携带或未知值拒绝。该字段不直接发送给 Manager，只派生 completion_required 和 owner 摘要。audit 包含完整脱敏参数、canonical 路径/cwd、target、前后台方式和有效 timeout；Manager receipt 回显 audit/executor id 与实际 target 后才发 tool.started。子审批的 scope/session 必须来自可信 metadata，不能由模型参数决定。

## Scope 与进程

cleanup 闭 body 为 `{scope_key:string,lifecycle_id?:string,delete_sessions?:boolean}`：scope 非空且≤512字符；lifecycle 若提供为≤512字符的 string，省略/空串表示不限 lifecycle；delete_sessions 缺省 false。普通 cleanup 清 task 责任，保留 journal/todo/普通 session；true 删除整个 session family。只有全部阶段确认才返回成功，不报告部分成功；[start fence、本地提交和 ack 顺序](../design/agent-runtime.md#停止与恢复)由 Runtime 设计定义。

预览/summary 的 scope/lifecycle query 各恰好一个，trim 后非空且≤512字符。family 是 root 本身及 `root+"/delegate/"` 后代，不含相似前缀。revision 不透明，展示输出/状态改变时必须变化，Manager 重启后旧值失效。预览响应为 `{processes:Preview[],revision:string}` 或 `{processes:[],revision:string,unchanged:true}`；普通空数组不是 unchanged。

| 对象 | 字段 |
|---|---|
| Preview 的 string 字段 | `id,title,command,cwd,output,started_at,updated_at` |
| Preview 其它字段 | `status:ProcessStatus,running:boolean,truncated:boolean,exit_code?:number\|null,finished_at?:string` |
| ProcessStatus | `running\|completed\|failed\|cancelled\|orphaned` |
| Snapshot 的 string 字段 | `id,run_id,scope_key,lifecycle_id,command,cwd,stdout,stderr,started_at` |
| Snapshot 其它字段 | `status:ProcessStatus,background:boolean,pid?:number,exit_code?:number\|null,finished_at?:string,stop_confirmed?:boolean` |

Manager 是清单权威，Runtime 过滤/脱敏。预览先活动组，同组按 started_at 倒序。orphaned 必须 running=true，计入运行数及更新阻塞，保留 Sandbox，不能降级为完成；[前端](../design/frontend.md)只读预览显示“需关注、仍占用”，不提供强制清理。summary 为非负安全整数，不等于有限预览长度；库存未知不能销毁容器，更新只延迟需要刷新的对应 Sandbox。

process.wait 必填 process_id，可选 timeout_ms（值取策略 JSON），返回 Snapshot 加 `wait_timed_out:boolean`。它观察精确 execution context/scope/lifecycle/target/id；超时或 Abort 只结束等待，不杀进程，重复等待可读同一终态。责任解除、idle 暂停与 HTTP 等待余量见[有限后台任务](../design/agent-runtime.md#有限后台任务)。

### Manager 私有控制

以下仅允许 Runtime bearer，不是模型接口。TaskIdentity 为 `{scope_id:string,lifecycle_id:string,execution_context,completion_owner_id:string}`；owner 是 Runtime 派生固定摘要，禁止 session 原文和命令。

| POST 路径 | 请求 → 响应 |
|---|---|
| `/v1/executor/tasks/reconcile` | TaskIdentity → `{processes:(Snapshot & {target:"sandbox"\|"host"})[]}`，有界未确认 task |
| `/v1/executor/tasks/acknowledge` | TaskIdentity 加 `process_id:string` → `{confirmed:boolean}`；只接受同 owner 终态，必须 confirmed=true |
| `/v1/executor/scopes/cleanup` | `{scope_id:string,lifecycle_id?:string}` → `{confirmed:true,completion_tasks:(TaskIdentity & {process_id:string,target:string})[]}`；闭世界 evidence 不含命令/输出/session |
| `/v1/executor/runs/cancel` | `{run_id:string,scope_id:string,lifecycle_id:string,execution_context,preserve_process_ids?:string[]}` → `{confirmed:boolean}` |

reconcile/ack 是必需方法。tombstone 提交顺序及可信保留集合见[Runtime](../design/agent-runtime.md#有限后台任务)，不能静默跳过。Manager HTTP 必须完整编码 JSON 后才提交状态码；operation mutation 的控制 ACK 只返回固定大小确认，executor cancel/ack 返回确认字段，scope cleanup 则必须返回有界 completion_tasks evidence。需要正文的客户端以 limit+1 有界读取并区分超限。2xx 正文丢失/损坏不能推断未执行，使用[原键和 journal 对账](../operations/auto-update.md)。

## Python 内部工具 Gateway

使用独立 bearer，不使用浏览器 session。已配置的 managed URL 是权威地址，Run 的 gateway.base_url 不能覆盖它；Run 的非空 gateway.token 只能替换发往该固定地址的默认 Token。未配置 managed URL 时才使用 Run 的 URL/Token，不能把 Run URL 与部署默认 Token 配对。

通用 envelope 为 `{tool:string,action:string,arguments:object,context:Context}`；专用路由不发送此 envelope：

| POST 路由 | wire |
|---|---|
| `/internal/agent/tools/{web\|browser\|schedule\|skill\|mail}` | 通用 envelope，仅当前 schema 的 action/参数，无别名；web 为 search/extract |
| `/api/agent/tools/memory/search` | 扁平 arguments 加可信身份，action 为 search/read/list |
| `/api/agent/tools/memory` | 同上；store/forget 映射为 add/remove，其它动作不变 |
| `/api/agent/tools/session/search` | 扁平 arguments 加身份，action 为 search/list/read；read.session_id 是已授权目标 |
| `/api/agent/tools/credentials/resolve` | `{provider:string,model:string,scope_key:string,force_refresh?:boolean}` → `{provider:string,access_token:string,token_type:"Bearer",expires_at:number\|null,base_url:string,model:string}`；expires_at 为 Unix 秒，无到期时间时为 null |

| Context 字段 | 类型 |
|---|---|
| `run_id,scope_key,lifecycle_id,session_id,workspace` | 必填 string |
| `owner_user_id,source_message_id,review_job_id,delegation_depth` | 可选 number |
| `tool_call_id,parent_run_id,trigger,review_mode,schedule_id,schedule_run_id` | 可选 string |
| `unattended,schedule_recurring` | 可选 boolean |

memory/session 扁平请求携带 run/scope/lifecycle/session；owner 和自动来源由可信 context 派生，模型不得指定。每次凭据请求（包括辅助视觉）必须使用本次实际 model 和当前 scope，复验[账号目录安全交集](../design/integrations.md)。

响应为 `{content?:string,data?:JSON,memories?:JSON[],memory?:JSON,found?:boolean,is_error?:boolean,error?:string}`；成功与失败（包括非2xx正文）都经过同一[不可信 framing](../design/security-and-trust.md#不可信内容与提示词注入)。

- **recurring**：Platform 签发完整 schedule context，continue_current/complete_current 只接受空 arguments；只有这两个动作例外于 unattended 计划管理禁令。非当前顶层 recurring、缺失/过期身份、错误标记或目标 id 均拒绝；仅成功 Gateway 结果构成[机械决策](../design/agent-runtime.md#完成守卫)。
- **memory/Skill**：reconcile 的原子 operations 至多20项，仅 store/replace/forget。Skill patch 为 `{id:string,file_path?:string,old_string:string,new_string:string,expected_replacements:integer}`。
- **复盘**：所有读写传递完整主体：parent_run_id/delegation_depth、trigger/unattended、review_mode/review_job_id，以及 owner、source message、run、scope、lifecycle。旧/不完整主体在访问数据前返回403；允许动作、逐读写授权与预算见[Runtime](../design/agent-runtime.md#学习复盘-run)和[Data](../design/data-memory-sessions.md#学习复盘)。
- **mail**：只使用可信私人 context；读取 accounts/folders/search/read，副作用 send/reply/move/mark/save_attachment；unattended 只读。SMTP mutation 用 run_id+tool_call_id 幂等，不确定结果为 needs_review，不能重发。
- **MCP** 不经过 Python：list 可选 server，call 必需 server/tool/有界 JSON arguments。完整参数审批、hard-block、stdio 生命周期及日志隐私见[集成](../design/integrations.md)。
- 人工 **browser** 接管不是 Runtime 工具；租约期间变更型工具收到可重试冲突。[Platform 租约](../design/frontend.md#浏览器接管与发送)与[输入校验边界](../design/security-and-trust.md#浏览器接管与局域网)不由模型指定。

## 协议演进

字段/状态变更先更新本文与机器契约，再同步 TypeScript、Python client、事件映射和双方测试；删除字段或改变状态语义须提升协议版本，双方原子升级。scope cleanup、空闲 session compact、终端 preview、model catalog、approval response、active input 都是完整客户端的必需方法；缺失属于编程契约错误，不能按旧 Runtime 静默跳过、降级或重新排队，也不提供未声明字段/执行路径的 fallback。
