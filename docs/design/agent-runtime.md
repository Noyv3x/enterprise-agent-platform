# Agent Runtime 设计

本文定义平台自有 Node.js Agent Runtime 的职责。私有协议见 [Runtime API](../reference/runtime-api.md)，数据归属见[数据、记忆与会话](data-memory-sessions.md)，安全策略见[安全与信任边界](security-and-trust.md)。

## 所有权

Runtime 直接依赖 lockfile 中精确版本的 Pi Core 与 Pi AI，不使用 Pi CLI、Pi submodule 或 Hermes 执行路径。它拥有：

- 模型与工具循环、流式增量和 Run 状态机；
- 工具策略、审批等待及已授权调用校验；
- 宿主机进程登记、输出、取消和 scope 清理；
- JSONL 会话、archive、上下文压缩与中断修复；
- 子 Agent 委派和父子活动传播；
- 幂等 Run 结果与可恢复 SSE journal；
- Runtime 可执行模型目录。

Python 平台拥有账号、产品消息、OAuth refresh token、记忆记录、知识、技能、计划和浏览器服务。Runtime 通过内部 Gateway 使用这些能力，不复制其业务状态。

## Run 状态机

顶层 Run 先进入 FIFO 并发队列，再依次经历 `queued`、`running` 和一个终态。终态为 `completed`、`failed`、`cancelled` 或 `needs_review`。只有顶层 Run 消耗全局并发名额；委派子 Run 共享父 Run 的执行槽，但保持自己的 scope 派生身份、会话和事件。

创建请求的 `idempotency_key` 在 `scope_key` 内唯一。终态结果原子保存；重复创建返回既有 Run。重启时发现已经开始但没有终态的幂等 Run，必须返回 `needs_review`，不能自动重做。

私人交互 Run 可以接收追加输入。输入按 message id 持久化并返回 accepted、injected 或 unconsumed；只有模型循环确认注入后，平台才能把该输入视为已消费。

## 模型目录与授权

Runtime 从锁定的 Pi 元数据计算受支持模型，校验 provider、API 类型和固定 endpoint。请求不能覆盖 base URL 或 API 类型。Python 可调用供应商 OAuth 模型发现，但其结果只能与 Runtime 目录求交或作为可用性提示，不能扩展可执行集合。

模型清单会随锁定依赖升级而改变，设计文档不得复制静态 ID 列表。Python 在调用时向内部授权端点请求当前访问凭据；OAuth token 不写入 Run metadata、session 或事件日志。

## 工具系统

Runtime 提供 terminal、process、read_file、write_file、patch_file、search_files、memory、skill、knowledge、web、browser、schedule、session、session_search 和 delegate_task。

文件与命令路径默认以 Agent workspace 为基准。只读工作区操作可直接执行；文件写入、所有宿主机命令、工作区外访问、进程控制、持久记忆/技能/计划修改和敏感浏览器动作按[安全策略](security-and-trust.md)请求审批。工具只有通过同一次调用的 preflight 后才能进入 execute，避免绕过审批钩子。审批缓存使用策略产生的稳定对象键而不是工具名；terminal 的 session/always 授权绑定未经语义改写的完整实际命令、canonical cwd、前后台方式与有效超时，文件和其它敏感动作绑定 canonical 目标与全部执行参数。敏感正文可在审批卡脱敏或只显示字节数，但必须参与授权 hash；`process.write` 只允许 `once`，不得把一次输入的授权复用到后续 stdin。

来自网页、浏览器、知识、记忆、session 和技能附件的模型可见文本由 Runtime 统一包装为防伪的不可信工具结果。包装函数必须重建文本块、中和攻击者提供的边界 token，并保留图片块；各工具不能自行拼一个可被内容提前闭合的提示前缀。这个边界同时适用于成功返回和上游 HTTP/工具失败文本；异常不得成为绕过包装的第二条输出路径。升级前 session 中未带边界的历史工具结果必须在重新进入模型上下文时补包装，不改写原始 JSONL。

terminal 的前台进程保持 Run 活动并有独立工具 deadline；后台进程立即返回，不得在 Run 已结束后继续刷新其活动。进程输出、历史记录和同时运行数量有界。Run 空闲、模型轮次和 terminal 默认超时的精确跨层值见 [`runtime-policy.json`](../contracts/runtime-policy.json)；其它边界由 Runtime 配置和测试约束。

## 会话与压缩

每条模型或工具消息先追加到带 scope、lifecycle、session 身份的 JSONL journal。上下文超过策略阈值时，Runtime 计算压缩计划；被省略的已持久消息先 fsync 到去重 archive，再原子替换活动 journal。没有稳定 entry id 的消息不得被压缩。

中断留下的孤立 tool call 会在恢复时修复并发出 `session.repaired`。`session` 工具搜索当前 session 的活动 journal 和 archive；跨产品会话的 `session_search` 由 Python 提供。二者返回的历史都必须标记为不可信数据，而不是指令。

## 记忆与技能注入

顶层 Run 启动前，Runtime 尝试召回当前 Agent 记忆和用户资料记忆；失败不阻止 Run。注入采用独立字符预算、完整记录边界和明确的不可信数据标签。

只有规范私人、顶层、交互式 Run 可以免写审批提交候选记忆。候选不是已提交记忆，在用户批准前不得被召回。可用技能只在系统提示中注入精简索引；完整 `SKILL.md` 及支持文件必须由 Agent 按需加载。

## 委派

委派深度和每 Run 子任务数量受策略限制。子 Agent 共享父工作区，但使用派生 scope、独立 session、临时记忆和浏览器身份；完成后清理其 disposable 状态。子 Run 的模型输出、工具活动和审批等待要向父 Run 传播活动，避免父 Run被误判无进展。

## 停止与恢复

用户取消、scope cleanup、进程退出和无进展保护都会中止模型、内部 Gateway 请求、审批和已登记进程组。Runtime 等待有限清理窗口；如果发生副作用且无法确认安全终止，则使用 `needs_review`。主动脱离进程组的程序仍需要部署层 cgroup/systemd scope 才能获得更强回收保证。

Runtime 没有活动任务的固定墙钟上限。无进展保护、模型轮次上限和 terminal 默认超时的精确跨层值由 [`runtime-policy.json`](../contracts/runtime-policy.json) 定义。审批、请求体、清理和保留等其它边界由 [配置参考](../reference/configuration.md)列出，并由 Runtime 配置测试校验。
