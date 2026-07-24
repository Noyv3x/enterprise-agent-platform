# Agent Runtime 设计

本文定义平台自有 Node.js Agent Runtime 的职责。私有协议见 [Runtime API](../reference/runtime-api.md)，数据归属见[数据、记忆与会话](data-memory-sessions.md)，安全策略见[安全与信任边界](security-and-trust.md)。

## 所有权

Runtime 直接依赖 lockfile 中精确版本的 Pi Core 与 Pi AI，不使用 Pi CLI、Pi submodule 或 Hermes 执行路径。它拥有：

- 模型与工具循环、流式增量和 Run 状态机；
- 工具策略、执行目标选择和审计事件；
- JSONL 会话、archive、上下文压缩与中断修复；
- 子 Agent 委派和父子活动传播；
- 幂等 Run 结果与可恢复事件 journal；
- Runtime 可执行模型目录。

Python Platform 拥有账号、产品消息、OAuth refresh token、记忆、知识、技能、计划和浏览器业务接口。宿主管理器拥有 Sandbox/host 进程、文件执行和容器生命周期。Runtime 不复制这些状态，也不访问 Docker socket。

## Run 状态机

顶层 Run 先进入 FIFO 并发队列，再依次经历 `queued`、`running` 和一个终态。终态为 `completed`、`failed`、`cancelled` 或 `needs_review`。只有顶层 Run 消耗全局并发名额；委派子 Run 共享父 Run 的执行槽、Sandbox 与工作区，但保持派生 scope、独立 session 和事件。

创建请求的 `idempotency_key` 在 `scope_key` 内唯一。终态结果原子保存；重复创建返回既有 Run。重启时发现已经开始但没有终态的幂等 Run，必须返回 `needs_review`，不能自动重做。

私人交互 Run 可以接收追加输入。输入按 message id 持久化并返回 accepted、injected 或 unconsumed；只有模型循环确认注入后，Platform 才能把该输入视为已消费。

## 模型目录与授权

Runtime 从锁定的 Pi 元数据计算受支持模型，校验 provider、API 类型和固定 endpoint。请求不能覆盖 base URL 或 API 类型。Python 可调用供应商 OAuth 模型发现，但其结果只能与 Runtime 目录求交或作为可用性提示，不能扩展可执行集合。

模型清单会随锁定依赖升级而改变，设计文档不得复制静态 ID 列表。Python 在调用时向内部授权端点请求当前访问凭据；OAuth token 不写入 Run metadata、session 或事件日志。

## 工具与执行目标

Runtime 提供 terminal、process、read_file、write_file、patch_file、search_files、memory、skill、knowledge、web、browser、schedule、session、session_search 和 delegate_task。

terminal、process 与文件工具的默认 `target` 是 `sandbox`。每个顶层 Run 接收由 Platform 解析的稳定主 Agent identity；委派 Run 必须继承它，模型不能构造其它 Agent identity。Runtime 把已规范化 cwd、路径、命令、环境和 deadline 发给管理器；管理器创建或唤醒对应 Sandbox，并在容器固定路径 `/workspace`、`/home/agent` 与 `/opt/agent-env` 下执行。Runtime 只消费有界输出和进程句柄，不把管理器控制 socket或容器身份暴露给模型。

用户上传的安全位图由 Platform 作为有界 image block 内联，不要求中央 Runtime 挂载 Platform 数据。其它上传附件只使用 `/workspace/.ubitech/attachments/...` 逻辑路径，经 Manager 在当前 scope 的只读附件挂载中解析；Runtime 不对中央容器不存在的宿主路径执行 `realpath`，也不能把一个 scope 的附件当成另一个 scope 的当前附件。

模型可为单次 terminal、process 或文件调用显式选择 `target=host`。该目标不等待用户审批：平台采用可信成员模型，管理器以部署用户在宿主机执行，并允许该用户已有的免密 `sudo`。每次调用仍必须在执行前发出可见审计事件，包含未经隐藏的实际命令参数或 canonical 文件路径、目标、cwd 和超时；凭据只做安全脱敏。宿主执行不能复用为后续调用的隐式授权，也不能把 host 变为 Run 默认值。

Sandbox/host 两个目标都执行不可绕过的 hard-block、路径规范化、参数上限、凭据脱敏和输出上限。Sandbox 是工作环境隔离，不是恶意租户安全边界；host target 等同授予本次调用部署用户权限。Docker socket、管理器状态根和宿主凭据目录始终由管理器拒绝，即使请求 `target=host`。

来自网页、浏览器、知识、记忆、session 和技能附件的模型可见文本由 Runtime 统一包装为防伪的不可信工具结果。包装函数必须重建文本块、中和攻击者提供的边界 token，并保留图片块；各工具不能自行拼一个可被内容提前闭合的提示前缀。这个边界同时适用于成功返回和上游失败文本。

terminal 的前台进程保持 Run 活动并有独立工具 deadline；后台进程立即返回并由对应 Sandbox 登记。进程输出、历史记录和同时运行数量有界。Run 空闲、模型轮次和 terminal 默认超时的精确跨层值见 [`runtime-policy.json`](../contracts/runtime-policy.json)；Sandbox 空闲值见 [`container-platform.json`](../contracts/container-platform.json)。

## 会话与压缩

每条模型或工具消息先追加到带 scope、lifecycle、session 身份的 JSONL journal。上下文超过策略阈值时，Runtime 计算压缩计划；被省略的已持久消息先 fsync 到去重 archive，再原子替换活动 journal。没有稳定 entry id 的消息不得被压缩。

中断留下的孤立 tool call 会在恢复时修复并发出 `session.repaired`。`session` 工具搜索当前 session 的活动 journal 和 archive；跨产品会话的 `session_search` 由 Python 提供。二者返回的历史都必须标记为不可信数据，而不是指令。

## 记忆与技能注入

顶层 Run 启动前，Runtime 尝试召回当前 Agent 记忆和用户资料记忆；失败不阻止 Run。注入采用独立字符预算、完整记录边界和明确的不可信数据标签。

只有规范私人、顶层、交互式 Run 可以免写审批提交候选记忆。候选不是已提交记忆，在用户批准前不得被召回。可用技能只在系统提示中注入精简索引；完整 `SKILL.md` 及支持文件必须由 Agent 按需加载。

## 委派

委派深度和每 Run 子任务数量受策略限制。子 Agent 使用派生 scope 和独立 session，但继承父主 Agent 的 Sandbox、workspace、HOME 与 env；临时记忆和浏览器身份仍按子 scope 隔离。子 Run 的模型输出、工具活动和等待要向父 Run 传播活动，避免父 Run 被误判无进展。

## 停止与恢复

用户取消、scope cleanup、管理器执行断开和无进展保护都会中止模型与当前前台工具。Runtime 等待有限清理窗口；如果发生副作用且无法确认安全终止，则使用 `needs_review`。后台进程属于 Sandbox 生命周期，不因单个 Run 完成而停止；管理器根据任务和进程登记决定空闲回收。

Runtime 没有活动任务的固定墙钟上限。无进展保护、模型轮次上限和 terminal 默认超时的精确跨层值由 [`runtime-policy.json`](../contracts/runtime-policy.json) 定义。审批、请求体、清理和保留等其它边界由[配置参考](../reference/configuration.md)列出，并由 Runtime 配置测试校验。
