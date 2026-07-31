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
| `POST /v1/scopes/cleanup` | 取消 scope Run、进程并可删除 session |
| `GET /v1/scopes/processes` | 读取一个 scope/lifecycle 的终端预览 |
| `GET /v1/scopes/process-summary` | 读取进程摘要 |

未知路径和不支持的方法返回 404。模型目录、预览、Run、Input、Cleanup 与控制 endpoint 严格拒绝未知 query/body 字段。调用方不得依赖未记录字段；新增字段必须先更新本文、类型和双方测试。

## 模型目录

`GET /v1/models` 返回版本、`pi-runtime` 来源和 provider 目录。产品 provider id 只接受 `openai-codex` 和 `xai-oauth`，不解析简写或历史别名。每个模型条目包含 id、显示名称、reasoning、输入模态、context window 和最大输出等 Runtime 元数据。

目录从锁定 Pi 依赖计算，本文不复制模型 ID。Python 可以将目录与当前 OAuth 账号可见模型合并，但不能创造目录外模型。

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
  "system_prompt": "You are ubitech agent.",
  "input": "处理这个任务",
  "model": {
    "provider": "openai-codex",
    "id": "runtime-catalog-model-id"
  }
}
```

`execution_context` 由 Platform 从数据库 scope 派生，不能接受模型值；委派请求继承父值。可选字段包括 `history`、`attachments`、`thinking_level`、内部 Gateway 信息和 metadata。图片附件由 Platform 读取受限字节后放入 `input` image block；附件列表只携带 `/workspace/.ubitech/attachments/...` 容器逻辑路径和安全 metadata，Runtime 不直接读取 Platform 文件系统。metadata 可携带 parent/delegation、idempotency、source message、触发来源、计划任务和可用技能索引；OAuth token、宿主路径、Docker 身份和可覆盖 provider endpoint 的值不得出现。Platform 内部学习复盘还同时携带 `review_mode=memory_skill`、`trigger=learning_review`、`unattended=true` 和正整数 `review_job_id`，并把 session 与幂等身份固定为 `session_id=learning-review-<review_job_id>`、`metadata.idempotency_key=agent-learning-review:<review_job_id>`。Runtime 只有在 canonical private 顶层 scope、当前 source message、无 parent/delegation 且这两个派生身份精确匹配的完整组合下才启用受限能力；对应 session/idempotency 命名空间为内部保留，普通 Run 也不能预占。这些字段不是公共提权开关。

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

终态为 `run.completed`、`run.failed`、`run.cancelled` 或 `run.needs_review`。完成数据包含 output/content、session、model、usage、context usage 和输入消费信息。

## 审批与执行审计

审批 body 只接受 `approval_id` 和 `decision`。decision 是 `once`、`session`、`always` 或 `deny`。省略 `approval_id` 时处理该 Run 最新待决审批；未知字段或无效 decision 返回 400。

审批用于 host terminal、普通前台 Skill 修改、计划修改和其它明确需要用户决定的业务动作。自动记忆不使用审批；经过完整校验的内部学习复盘可以免批执行受限的 memory 与 agent-owned Skill create/patch，其它 Skill 动作仍失败关闭。`approval.requested` 只携带可展示的脱敏参数、复用范围和本次 choices；原始 secret 与内部稳定 key 不得进入事件日志。`approval.resolved` 的 outcome 除用户决定外还可为 `timeout`、`cancelled` 或 `notification_failed`，这些结果全部按未授权关闭。

terminal、process 和文件工具必须带 `target=sandbox|host`，省略时为 sandbox。Sandbox 不使用人工审批；host terminal 在调用 Manager 之前逐次请求审批，choices 固定为 `once|deny`，不支持 session/always 复用，也不能成为 Run 默认。批准后 Runtime 写入 `execution.audit`，数据包含 target、完整安全展示参数、canonical cwd/路径、前后台方式和有效 timeout。Manager 响应回显不可伪造的 executor id、实际 target 和审计 id，Runtime 才能发出 `tool.started`。

子 Run 可以把审批所有权委托给顶层 Run，但 scope 和 session 必须来自可信 metadata。审批决定不能通过工具参数指定。

## Scope 与进程

`POST /v1/scopes/cleanup` 要求 `scope_key`，可带 `lifecycle_id` 和 `delete_sessions`。Runtime 取消匹配 Run和审批，并请求 Manager 清理对应前台执行；后台进程仍由 Sandbox 生命周期管理，只有显式 scope reset 才停止。响应返回取消数量、Manager 清理结果和 session 删除结果。

终端预览要求同时提供 root scope 和 lifecycle，并可携带不透明 `since_revision`。预览、`running_terminal_count` 和 scope cleanup 都覆盖 root scope 本身及以 `root + "/delegate/"` 开头的委派 scope family；其它相似前缀不属于该 family。revision 是服务端游标，客户端不得解析其内部结构；游标必须随可展示输出或进程状态变化，并包含 Manager 进程实例身份，因此 Manager 重启后的旧游标必然失效。响应只用于只读展示。

进程预览数据来自 Manager executor，由 Runtime 按 scope/lifecycle 过滤和脱敏后返回。进程列表先展示活动状态（`running`、`orphaned`），同组再按 `started_at` 倒序排列。Platform 更新不停止独立 Sandbox 后台进程；目标版本需要刷新某个 Sandbox 时，只延迟该 Sandbox。库存不可确定时不能销毁容器。

Manager 进程快照和预览的 `status` 只允许 `running`、`completed`、`failed`、`cancelled` 和 `orphaned`。`orphaned` 表示 Manager 无法确认进程已经终止或仍由原执行器可靠持有，不是完成态；它必须保持 `running: true`，计入运行中终端和更新阻塞，并保留对应 Sandbox，直至 Manager 明确确认终态。Runtime 与 Platform 必须原样接受该状态，不能拒绝响应，也不能把它降级为 `completed`。前端只读预览将其展示为“需关注、仍占用”，不提供交互或强制清理入口。

## Python 内部工具 Gateway

Runtime 使用与浏览器 session 分离的 bearer token 回调 Python。路由按平台现有所有者拆分：memory 使用 `/api/agent/tools/memory` 与 `/api/agent/tools/memory/search`，session search 使用 `/api/agent/tools/session/search`，knowledge 使用 `/api/agent/tools/knowledge/**`，模型访问凭据使用 `/api/agent/tools/credentials/resolve`；web、browser、schedule、skill 和其它 Runtime gateway 工具使用 `/internal/agent/tools/{tool}`。请求携带 Run、scope、lifecycle、session、workspace 和由平台提供的 actor/source message context。

Python 必须从可信 context 推导 memory owner、schedule owner、browser identity 和 credential provider；模型 arguments 中出现这些所有权字段时应拒绝，而不是覆盖 context。工具 action 只接受 Runtime schema 声明的当前名称：knowledge 为 `search|read`，web 为 `search|extract`，browser 为其 schema 中的规范 action。`/internal/agent/tools/{tool}` 只承载 web、browser、schedule、skill 和 mail；memory、session 与 knowledge 只走上述专用路由。未声明的 action 别名、参数别名或把专用工具改发到通用路由都必须失败，不做转换。

memory 额外支持原子 `reconcile`，其 `operations` 至多二十项且只含 `store|replace|forget`。skill 额外支持精确 `patch`：参数包含 id、可选 support `file_path`、`old_string`、`new_string` 与 `expected_replacements`。复盘 Gateway context 在 memory 的 `search|read|list` 与变更请求中都必须携带 `parent_run_id`、`delegation_depth`、`trigger`、`unattended`、`review_mode` 和 `review_job_id`，并结合已有 run/scope/lifecycle/owner/source message 构成完整主体。Python 在执行任何复盘记忆查询或写入前必须反查 running job、当前 lifecycle、激活账号与权限；过期或不完整主体返回 403，不读取记忆。复盘 Skill 不能 delete、enable/disable、完整 update 或 remove/write support，支持文件修改同样走精确 patch。

Gateway 中网页、浏览器、邮件、知识、记忆、技能、计划和会话来源的成功内容与失败文本都是不可信数据。Runtime 必须在将两种结果交给模型前使用同一防伪边界；Python 返回非 2xx 不得使错误正文绕过该边界。

`mail` Gateway 只接受由 Run context 派生的私人账户所有权。读取动作为 `accounts/folders/search/read`，副作用动作为 `send/reply/move/mark/save_attachment`；unattended trigger 只能使用读取动作。SMTP mutation 携带 `run_id + tool_call_id` 幂等身份，结果不确定时返回 `needs_review` 语义而不是自动重发。

浏览器人工接管不是 Runtime 工具。登录浏览器通过 Platform 同源 API申请当前 scope/tab 的短期租约并发送限幅输入；Runtime 的变更型 browser 工具在租约存续时收到可重试冲突。客户端提供的 user id、selector、脚本和任意导航 URL 一律不进入该协议。

## 协议演进

协议变更必须先更新本文和相关机器契约，再同步 TypeScript 类型、Python client、事件映射和双方测试。删除字段或改变状态语义需要提升协议版本并原子升级双方；不提供未声明字段、状态或执行路径的静默 fallback。
