# 系统架构

本文描述系统的组件边界和主要数据流。产品范围见[产品设计](product.md)，部署拓扑见[部署](../operations/deployment.md)，运行数据目录见[数据布局](../reference/data-layout.md)。

## 总览

```text
Browser / Telegram
        │
        ▼
Host Manager ───────────── maintenance / releases / host executor
        │
        ▼
Docker network
  ├── Platform ─────────── SQLite / attachments / workspaces
  ├── Agent Runtime ────── Pi model loop / tool coordination
  ├── Camoufox ─────────── shared browser, per-Agent profiles
  ├── SearXNG ──────────── search discovery
  ├── Firecrawl ────────── page extraction
  └── Agent Sandbox × N ── workspace / HOME / processes
```

系统只包含一个公网 HTTP 入口。宿主机 user-systemd 管理器持有监听 socket，正常时代理当前 Platform generation，维护或 Platform 不可用时直接返回维护页。只有管理器访问 Docker socket；业务容器不挂载 Docker socket，也不直接管理其它容器。管理器还持有一个跨 generation 保留的受管 bridge 网络；固定 Compose 栈和动态 Sandbox 只作为 external network 使用者，固定栈 `down` 不删除网络或断开 Sandbox。

## 品牌与技术身份

部署后的产品名称、标识图和其它品牌字段是 Platform 所有的展示数据，只能影响浏览器界面、通知、面向用户的 Agent 自称及其它明确的展示投影。管理员品牌字段不得派生或改写 Manager 二进制与 unit 名、配置和数据根、Compose project、网络、容器与 ownership label、环境变量、secret mount、Cookie、内部 API 路径、数据库 marker、workspace/session identity、包名或 release asset；这些对象属于发布协议和持久身份，不属于品牌。

系统只有一个运行时与内部协议身份：`agent-platform-manager` 二进制和 unit、`~/.config/agent-platform` 配置根、`~/.local/share/agent-platform` 状态根、容器内 `/var/lib/agent-platform` 数据根、`agent-platform` Compose project、`agent-platform_core` 网络、`AGENT_PLATFORM_*` 环境前缀、`io.agent-platform.*` ownership label、`agent-platform-sandbox-*` Sandbox 名以及 `.agent-platform` 内部目录。启动、安装、更新和恢复没有第二套 profile、旧路径发现或迁移执行分支。Manager 在 Platform 不可达或维护期间使用中性公共文案，不能为了读取展示品牌而依赖已停止的业务数据库。

源码仓库名、Python distribution/module 坐标和 Go module/import 坐标是开发坐标，不是管理员品牌设置的投影；其无状态重命名必须与持久部署协议分开评估。

## 管理平面

Manager 是源码树之外的稳定控制平面；唯一命令为 `agent-platform-manager`。它拥有：

- 公网 Gateway、维护状态和 owner-only Unix 控制 socket；
- 固定服务与按 Agent Sandbox 的创建、停止、对账和日志轮转；
- release manifest 校验、镜像预拉取、更新、快照、回滚和自恢复；
- target-only 配置、单实例启动、控制 socket 与 Gateway 所有权；
- sandbox/host 执行路由，以及宿主执行审计；
- 容器 generation、operation journal 和健康状态。

控制 socket 的 HTTP 响应与远程网络响应采用同一不确定性边界：服务端在提交状态码前编码完整 JSON，写 mutation 只返回固定大小确认；需要正文的客户端以有界 `limit+1` 读取并区分超限。2xx 正文丢失或损坏时，调用方使用原 idempotency key 和 operation journal 对账，不能因本地 JSON 解码失败推断 mutation 未执行。

管理器不拥有账号、频道、消息、OAuth 或 Agent 上下文。Platform 正常时，管理面板通过内部认证接口读取安全摘要并提交管理 operation；Platform 失败时只使用宿主 CLI 恢复。

## Python 平台

Python Platform 容器拥有产品业务状态：

- 登录、会话签名、账号和服务端权限；
- 频道、私人消息、附件、审计和 token 用量；
- Agent scope、消息准入、持久任务、短消息合并和计划任务；
- 自动记忆、工作区 Skill 管理、跨会话搜索、后台学习复盘和邮箱账户；
- OAuth 流程、凭据刷新和可见模型目录；
- Telegram 与面向 Runtime 的内部业务工具 Gateway。
- 浏览器预览代理、短期人工接管租约和有界原子指针轨迹；电脑画面所需的工作区文件正文、搜索命中投影与 HTML 呈现页读取；

SQLite 使用 WAL 和按线程连接。会产生外部副作用的 Agent 任务及 Telegram 投递通过持久任务账本记录；进程重启后，安全可重试的任务可重新排队，已开始副作用的任务进入人工复核。Platform 只接受当前数据库 marker 与精确结构，任何其它非空数据库都在修改前拒绝。直接前一 baseline 的迁移必须显式识别该版本自身生成的控制文件：安全校验后只作为源一致性证据，不复制、不改写，也不把未知输入放宽为兼容项。由权威业务表可重建的派生索引在启动时单独验证自身契约；只有这类派生对象可以从权威数据原地修复，具体边界见[数据、记忆与会话](data-memory-sessions.md)。Platform 不安装依赖、拉取上游源码、调用 Compose 或拥有服务生命周期。

## Agent Runtime

Node.js Runtime 容器直接使用锁定版本的 Pi Core 与 Pi AI。它拥有一次 Run 内的模型和工具循环、SSE 事件、工具策略、结构化 todo、受限并行委派、语义上下文压缩、JSONL 会话和幂等结果。Python 通过私有容器网络创建 Run 并消费可恢复事件；Runtime 通过独立 token 回调 Python 业务工具，并通过 Manager 在当前 Agent Sandbox 调用固定的一次性 stdio MCP 客户端。MCP 清单、Skill 与本地 server 包只存在于该主 Agent 的工作区，不进入中央 Runtime 文件系统。

Runtime 不拥有 Docker socket。terminal、process 和文件工具携带主 Agent sandbox identity 调用管理器的容器内 Unix 控制 socket；管理器确保 Sandbox 存在后执行。显式 `target=host` 的单次调用改由管理器以部署用户执行。具体职责见 [Agent Runtime](agent-runtime.md)，协议见 [Runtime API](../reference/runtime-api.md)。

## 前端

React 应用随 Platform 镜像发布，由 Python 作为静态资源服务。浏览器通过同源 `/api` 请求和 scope SSE 获取状态；自有 external store 负责会话、聊天、管理资源和竞态合并。维护门位于登录和应用错误边界之外，因此 Platform generation 切换时仍能可靠显示管理器维护页。详见[前端设计](frontend.md)。

## 外部能力

Camoufox、SearXNG 和 Firecrawl 是固定受管容器。工作区 MCP server 由用户自行安装，只继承当前 Agent Sandbox 的权限，不进入受管服务闭集。上游 URL 与 revision 由 canonical 契约锁定，CI 在构建时验证并产出不可变镜像；部署机不保留或更新上游 Git checkout。详见[外部集成](integrations.md)。

## 关键数据流

### 交互回复

1. Platform 先确认 Manager 持久更新预约已释放，再完成权限检查并持久化用户消息和 Agent job。若同一发送者正持有该 Agent root scope 的浏览器人工接管租约，Platform 必须在浏览器操作门内先撤销租约再把任务入队；其他用户租约保持不变。候选容器启动期间所有后台 worker 同样保持冻结。
2. 每个会话 FIFO worker 领取任务，全局并发门控制同时进入 Runtime 的数量。
3. Platform 创建 Runtime Run，随后消费事件；工具过程和最终内容分别写入状态和消息元数据。
4. Runtime 将产品工具回调 Platform；terminal、process 与文件工具按主 Agent identity 调用管理器，默认进入对应 Sandbox。短命令在前台等待；后台有终点进程由 `process.wait` 在同一 Run 内等待终态，不创建计划任务轮询。
5. Sandbox 执行在硬阻断和审计后直接运行；宿主命令必须先获得本次用户审批，管理器再产生带完整安全展示参数的审计事件，并记录 target、部署用户和 sudo 使用情况。
6. 最终回复和用量先持久化，再将任务账本转为成功。

### 后台学习复盘

只有规范私人、顶层、交互式任务在最终回复与主任务成功后才累计学习节奏。Platform 分别累计成功用户回合和已完成工具调用；任一计数达到十次时，以来源消息和 lifecycle 为幂等边界写入低优先级 `agent_learning_review` 持久任务。频道、计划、邮件唤醒、委派、失败、中断和复盘任务本身不累计也不触发复盘。

学习 worker 在业务回复之外串行领取任务，重新校验账号、scope、lifecycle 和来源消息，只向 Runtime 提交有界的近期私人会话。账号激活状态和个人 AI 权限不只在领取时检查；复盘 memory 读操作在 lifecycle 门和同一 SQLite 快照中完成授权复验与查询，memory 写操作在同一个 `BEGIN IMMEDIATE` 事务内完成复验、持久预算扣减、变更和返回快照。普通交互 Run 的 automatic memory 写入也在 lifecycle 门与单一写事务中通过来源消息、runtime Run 到 running 父任务映射复验。Skill 写入横跨 DB/文件系统，故在持有 lifecycle 门时先持久预扣预算，再重新复验并提交文件；失败可消耗预算，不能出现文件成功而计费回滚。每个 review durable job 的 payload 持久保存二十单位总预算用量，memory 子动作与 Skill create/patch 共享，进程重启、任务重排或 Runtime 重试不会刷新。该 Run 使用独立临时 session，不产生产品消息、工作记录或通知；Runtime 只暴露 memory 与 skill，并在终态后删除临时 session。复盘失败不改变已经交付的回复，安全重试依靠持久任务的幂等键；领取、重排或终态落盘遇到短暂存储错误时，worker 使用有上限的退避持续恢复，不得因单次异常静默永久退出；已领取任务在无法确认终态时保持为更新阻塞项，关闭则留给启动恢复。更新预约建立后不领取新复盘，正在运行的复盘是更新阻塞项，完成或受控取消并重排后才切换版本。

### 运行中追加输入

个人 AI 的后续短消息先获得独立持久 job，再尝试绑定活动 Run。Runtime 明确返回 accepted、injected 或 unconsumed；未消费输入回到 FIFO 队列，不能静默丢失或被错误标记成功。

### Sandbox 生命周期

个人 AI 和频道主 Agent各自对应一个稳定 sandbox identity；委派子 Agent继承父 identity。管理器首次调用时创建容器并挂载工作区、HOME 和环境目录；任务活动与已登记后台进程会延长生命周期。无任务且无后台进程达到契约空闲时间后只停止容器，数据目录不删除。

### 更新

管理器先验证 release manifest 并预拉取镜像，再等待 Platform 的全局自然空闲点。原子预约成功后入口切换为维护，旧 Platform 停止，数据库快照与迁移完成后启动新 generation；只有所有核心 readiness 通过才恢复业务。完整协议见[自动更新](../operations/auto-update.md)。

## 故障边界

- 两个可写 Platform generation 不能同时打开同一 SQLite。
- release manifest 中的数据库版本必须单调递增；DDL、外键校验和迁移标记形成一个原子提交，失败时由 Manager 保留快照并回滚 generation。
- Platform 重启不应重复执行已经开始副作用的 job。
- Runtime 重启通过幂等记录和会话日志区分可重放结果与 `needs_review`。
- 管理器重启从 operation journal 和容器 label 对账，不从容器名称猜测状态。
- 启动只能使用当前技术 profile 和配置根；旧目录、进程名或普通 operation 都不能改变技术身份。
- 搜索、抓取、浏览器和工作区 MCP server 失败只影响对应能力，不能破坏本地消息与工作区文件；MCP 失败必须明确返回，不能静默改走其它客户端目录。
- 邮件轮询和回复通知失败只降级对应集成，不阻断对话；更新维护期间不启动新的邮件副作用或唤醒。
- Run 空闲、模型轮次和 terminal 默认超时只在 [`runtime-policy.json`](../contracts/runtime-policy.json) 定义；容器与更新状态只在 [`container-platform.json`](../contracts/container-platform.json) 定义。
