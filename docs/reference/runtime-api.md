# Agent Runtime 私有 API

本文定义 Python 平台与 Node Agent Runtime 之间的私有协议。Runtime 行为见 [Agent Runtime 设计](../design/agent-runtime.md)。Run 空闲、模型轮次和 terminal 默认超时的跨层值见 [`runtime-policy.json`](../contracts/runtime-policy.json)；其它协议边界见[配置参考](configuration.md)并由双方测试校验。

## 传输与认证

Runtime 默认只监听回环地址。所有 endpoint，包括健康检查，都要求 `Authorization: Bearer <token>`。比较必须使用定时安全方法；失败响应不返回内部 traceback。

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
| `GET /v1/processes/update-blockers` | 读取自动更新终端阻塞摘要 |

未知路径以及多数既有路径上的不支持方法返回 404。模型目录、预览与部分控制 endpoint 会严格拒绝未知 query/body 字段；Run、Input 和 Cleanup 的兼容请求目前只校验实际消费字段，不承诺统一拒绝所有额外 JSON 字段。新增协议不得依赖未记录字段，收紧兼容解析前必须先更新本文和双方测试。

## 模型目录

`GET /v1/models` 返回版本、`pi-runtime` 来源和 provider 目录。每个模型条目包含 id、显示名称、reasoning、输入模态、context window 和最大输出等 Runtime 元数据。

目录从锁定 Pi 依赖计算，本文不复制模型 ID。Python 可以将目录与当前 OAuth 账号可见模型合并，但不能创造目录外模型。

## 创建 Run

最小请求结构：

```json
{
  "scope_key": "private:42",
  "lifecycle_id": "lifecycle-id",
  "session_id": "session-id",
  "workspace": "/absolute/workspace",
  "system_prompt": "You are ubitech agent.",
  "input": "处理这个任务",
  "model": {
    "provider": "openai-codex",
    "id": "runtime-catalog-model-id"
  }
}
```

可选字段包括 `history`、`attachments`、`thinking_level`、内部 Gateway 信息和 metadata。metadata 可携带 parent/delegation、idempotency、source message、触发来源、计划任务和可用技能索引；OAuth token 和可覆盖 provider endpoint 的值不得出现。

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
- `approval.requested`、`approval.resolved`；
- `input.accepted`、`input.injected`、`input.unconsumed`；
- `delegation.*`、`context.compacted`、`session.repaired`；
- `run.idle_timeout`、`run.turn_limit`、`run.cleanup_timeout`。

终态为 `run.completed`、`run.failed`、`run.cancelled` 或 `run.needs_review`。完成数据包含 output/content、session、model、usage、context usage 和输入消费信息。

## 审批

审批 body 只接受 `approval_id` 和 `decision`。decision 是 `once`、`session`、`always` 或 `deny`。省略 `approval_id` 时处理该 Run 最新待决审批；未知字段或无效 decision 返回 400。

`approval.requested` 只携带可展示的脱敏参数、`allow_session`、`allow_permanent` 与本次可选 choices；原始 secret 和 Runtime 内部稳定授权 key 不得进入事件日志。审批对象对 terminal 绑定未经改写的实际命令及执行上下文，对文件与其它敏感工具绑定 canonical 目标和全部执行参数。展示层可脱敏或以字节数占位代替敏感正文，但不得改变授权 identity。`session` 和 `always` 都按该审批对象授权，而不是按工具名授权；`process.write` 等明示不可复用的动作只返回 `once`/`deny`。`approval.resolved` 的 outcome 除四种用户决策外还可为 `timeout`、`cancelled` 或 `notification_failed`；这些结果全部按未授权关闭，不能因超时或通知失败继续执行。旧版仅按工具名保存的 session/always 记录不升级为新授权。

子 Run 可以把审批所有权委托给顶层 Run，但 scope 和 session 必须来自可信 metadata。审批决定不能通过工具参数指定。

## Scope 与进程

`POST /v1/scopes/cleanup` 要求 `scope_key`，可带 `lifecycle_id` 和 `delete_sessions`。清理会取消匹配 Run、审批和登记进程，并等待进程退出确认；返回取消数量和 session 删除结果。

终端预览要求同时提供 scope 和 lifecycle，并可携带不透明 `since_revision`。revision 是服务端游标，客户端不得解析其内部结构。响应只用于只读展示。

自动更新 blocker endpoint 区分需要等待的受保护终端和可在部署切换时终止的普通后台终端。库存不可确定时必须阻止更新。

## Python 内部工具 Gateway

Runtime 使用与浏览器 session 分离的 bearer token 回调 Python。路由按平台现有所有者拆分：memory 使用 `/api/agent/tools/memory` 与 `/api/agent/tools/memory/search`，session search 使用 `/api/agent/tools/session/search`，knowledge 使用 `/api/agent/tools/knowledge/**`，模型访问凭据使用 `/api/agent/tools/credentials/resolve`；web、browser、schedule、skill 和其它 Runtime gateway 工具使用 `/internal/agent/tools/{tool}`。请求携带 Run、scope、lifecycle、session、workspace 和由平台提供的 actor/source message context。

Python 必须从可信 context 推导 memory owner、schedule owner、browser identity 和 credential provider；模型 arguments 中出现这些所有权字段时应拒绝，而不是覆盖 context。

Gateway 中网页、浏览器、知识、记忆、技能、计划和会话来源的成功内容与失败文本都是不可信数据。Runtime 必须在将两种结果交给模型前使用同一防伪边界；Python 返回非 2xx 不得使错误正文绕过该边界。

## 兼容规则

协议变更必须先更新本文和相关机器契约，再同步 TypeScript 类型、Python client、事件映射和双方测试。删除字段或改变状态语义需要显式版本迁移；不能用静默 fallback 重新引入旧 Runtime 路径。
