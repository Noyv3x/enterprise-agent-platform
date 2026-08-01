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

当前 Bridge 只把 `ubitech-manager`、`ubitech-agent`、`UBITECH_*`、`ENTERPRISE_*`、`.ubitech*` 与 `enterprise_*` 等既有值作为已完成 source-profile/source-owner 发布留下的精确交接源身份继续读取，绝不把它们作为用户可见产品名称回退。Bridge 把内部身份交接到固定的中性 `agent-platform` 命名空间，紧随其后的 Cleanup 基线删除源名称、迁移器和兼容读取。Manager 在 Platform 不可达或维护期间始终使用中性公共文案，不能为了读取品牌而依赖已停止的 Platform 数据库。

目标身份固定为 `agent-platform-manager` 二进制和 unit、`~/.config/agent-platform` 配置根、`~/.local/share/agent-platform` 状态根、容器内 `/var/lib/agent-platform` 数据根及其 `.agent-platform.lock` 单实例锁、`agent-platform` Compose project、`agent-platform_core` 网络、`AGENT_PLATFORM_*` 环境前缀、`io.agent-platform.*` ownership label、`agent-platform-sandbox-*` Sandbox 名以及 `.agent-platform` 内部工作目录。普通 generation 更新、管理员保存品牌或源码全局替换都不得直接承担这项迁移；唯一流程是[部署文档](../operations/deployment.md#技术命名空间交接)定义的两发布 Manager handoff。

Manager 在解析默认配置路径、打开状态根、恢复普通 operation 或取得 control/Gateway 所有权之前先构造身份 Router。无交接事务时 Router 只能注入编译期 source profile；target profile 只能由位于源/目标数据根之外、经过完整身份与阶段校验的 handoff journal 选择。命令行、环境变量、管理员品牌、release manifest 本身或目标目录恰好存在都不能选择 target。Router 还在普通 update/self-update owner 之前识别 `namespace_handoff`：描述符存在时只能交给独立 handoff coordinator，普通 operation 不得先创建 Candidate、Activation、维护状态或其它所有权事实。

## 管理平面

Manager 是源码树之外的稳定控制平面；当前桥接源命令为 `ubitech-manager`，交接后的唯一命令为 `agent-platform-manager`。它拥有：

- 公网 Gateway、维护状态和 owner-only Unix 控制 socket；
- 固定服务与按 Agent Sandbox 的创建、停止、对账和日志轮转；
- release manifest 校验、镜像预拉取、更新、快照、回滚和自恢复；
- 技术身份 Router、独立 handoff coordinator 与跨重启 helper 所有权；
- sandbox/host 执行路由，以及宿主执行审计；
- 容器 generation、operation journal 和健康状态。

控制 socket 的 HTTP 响应与远程网络响应采用同一不确定性边界：服务端在提交状态码前编码完整 JSON，写 mutation 只返回固定大小确认；需要正文的客户端以有界 `limit+1` 读取并区分超限。2xx 正文丢失或损坏时，调用方使用原 idempotency key 和 operation journal 对账，不能因本地 JSON 解码失败推断 mutation 未执行。

管理器不拥有账号、频道、消息、OAuth 或 Agent 上下文。Platform 正常时，管理面板通过内部认证接口读取安全摘要并提交管理 operation；Platform 失败时只使用宿主 CLI 恢复。

## Python 平台

Python Platform 容器拥有产品业务状态：

- 登录、会话签名、账号和服务端权限；
- 频道、私人消息、附件、审计和 token 用量；
- Agent scope、消息准入、持久任务、短消息合并和计划任务；
- 自动记忆、知识库、技能、跨会话搜索、后台学习复盘和邮箱账户；
- OAuth 流程、凭据刷新和可见模型目录；
- Telegram 与面向 Runtime 的内部业务工具 Gateway。

SQLite 使用 WAL 和按线程连接。会产生外部副作用的 Agent 任务及 Telegram 投递通过持久任务账本记录；进程重启后，安全可重试的任务可重新排队，已开始副作用的任务进入人工复核。Platform 只接受当前数据库 marker 与精确结构，任何其它非空数据库都在修改前拒绝。Platform 不安装依赖、拉取上游源码、调用 Compose 或拥有服务生命周期。

## Agent Runtime

Node.js Runtime 容器直接使用锁定版本的 Pi Core 与 Pi AI。它拥有一次 Run 内的模型和工具循环、SSE 事件、工具策略、委派、上下文压缩、JSONL 会话和幂等结果。Python 通过私有容器网络创建 Run 并消费可恢复事件；Runtime 通过独立 token 回调 Python 业务工具。

Runtime 不拥有 Docker socket。terminal、process 和文件工具携带主 Agent sandbox identity 调用管理器的容器内 Unix 控制 socket；管理器确保 Sandbox 存在后执行。显式 `target=host` 的单次调用改由管理器以部署用户执行。具体职责见 [Agent Runtime](agent-runtime.md)，协议见 [Runtime API](../reference/runtime-api.md)。

## 前端

React 应用随 Platform 镜像发布，由 Python 作为静态资源服务。浏览器通过同源 `/api` 请求和 scope SSE 获取状态；自有 external store 负责会话、聊天、管理资源和竞态合并。维护门位于登录和应用错误边界之外，因此 Platform generation 切换时仍能可靠显示管理器维护页。详见[前端设计](frontend.md)。

## 外部能力

Camoufox、SearXNG 和 Firecrawl 是固定受管容器；Cognee 代码与依赖构建进 Platform 镜像。上游 URL 与 revision 由 canonical 契约锁定，CI 在构建时验证并产出不可变镜像；部署机不保留或更新上游 Git checkout。详见[外部集成](integrations.md)。

## 关键数据流

### 交互回复

1. Platform 先确认 Manager 持久更新预约已释放，再完成权限检查并持久化用户消息和 Agent job。若同一发送者正持有该 Agent root scope 的浏览器人工接管租约，Platform 必须在浏览器操作门内先撤销租约再把任务入队；其他用户租约保持不变。候选容器启动期间所有后台 worker 同样保持冻结。
2. 每个会话 FIFO worker 领取任务，全局并发门控制同时进入 Runtime 的数量。
3. Platform 创建 Runtime Run，随后消费事件；工具过程和最终内容分别写入状态和消息元数据。
4. Runtime 将产品工具回调 Platform；terminal、process 与文件工具按主 Agent identity 调用管理器，默认进入对应 Sandbox。
5. Sandbox 执行在硬阻断和审计后直接运行；宿主命令必须先获得本次用户审批，管理器再产生带完整安全展示参数的审计事件，并记录 target、部署用户和 sudo 使用情况。
6. 最终回复和用量先持久化，再将任务账本转为成功。

### 后台学习复盘

只有规范私人、顶层、交互式任务在最终回复与主任务成功后才累计学习节奏。Platform 分别累计成功用户回合和已完成工具调用；任一计数达到十次时，以来源消息和 lifecycle 为幂等边界写入低优先级 `agent_learning_review` 持久任务。频道、计划、邮件唤醒、委派、失败、中断和复盘任务本身不累计也不触发复盘。

学习 worker 在业务回复之外串行领取任务，重新校验账号、scope、lifecycle 和来源消息，只向 Runtime 提交有界的近期私人会话。账号激活状态和私人 Agent 权限不只在领取时检查；复盘 memory 读操作在 lifecycle 门和同一 SQLite 快照中完成授权复验与查询，memory 写操作在同一个 `BEGIN IMMEDIATE` 事务内完成复验、持久预算扣减、变更和返回快照。普通交互 Run 的 automatic memory 写入也在 lifecycle 门与单一写事务中通过来源消息、runtime Run 到 running 父任务映射复验。Skill 写入横跨 DB/文件系统，故在持有 lifecycle 门时先持久预扣预算，再重新复验并提交文件；失败可消耗预算，不能出现文件成功而计费回滚。每个 review durable job 的 payload 持久保存二十单位总预算用量，memory 子动作与 Skill create/patch 共享，进程重启、任务重排或 Runtime 重试不会刷新。该 Run 使用独立临时 session，不产生产品消息、工作记录或通知；Runtime 只暴露 memory 与 skill，并在终态后删除临时 session。复盘失败不改变已经交付的回复，安全重试依靠持久任务的幂等键；领取、重排或终态落盘遇到短暂存储错误时，worker 使用有上限的退避持续恢复，不得因单次异常静默永久退出；已领取任务在无法确认终态时保持为更新阻塞项，关闭则留给启动恢复。更新预约建立后不领取新复盘，正在运行的复盘是更新阻塞项，完成或受控取消并重排后才切换版本。

### 运行中追加输入

私人 Agent 的后续短消息先获得独立持久 job，再尝试绑定活动 Run。Runtime 明确返回 accepted、injected 或 unconsumed；未消费输入回到 FIFO 队列，不能静默丢失或被错误标记成功。

### Sandbox 生命周期

私人 Agent 和频道主 Agent各自对应一个稳定 sandbox identity；委派子 Agent继承父 identity。管理器首次调用时创建容器并挂载工作区、HOME 和环境目录；任务活动与已登记后台进程会延长生命周期。无任务且无后台进程达到契约空闲时间后只停止容器，数据目录不删除。

### 更新

管理器先验证 release manifest 并预拉取镜像，再等待 Platform 的全局自然空闲点。原子预约成功后入口切换为维护，旧 Platform 停止，数据库快照与迁移完成后启动新 generation；只有所有核心 readiness 通过才恢复业务。完整协议见[自动更新](../operations/auto-update.md)。

技术命名空间交接不复用上述普通 generation operation。source-owner 只负责建立事务并把所有权耐久移交给源码树和两套数据根之外的持久 helper；从移交完成到 terminal phase，helper 是 journal、数据位置、unit 和 listener 切换的唯一 writer。源 Manager 失去写权；目标 Manager 只对执行中的目标 stable inode、目标 profile 和当前事务产出权威 `target_ack` 证明，不能推进其它交接阶段。helper 验证并持久化该证明，但不能自行生成或替目标签署。目标 Manager 使用全新的 Manager state、自更新和普通 operation 根，不能复制或改写源 Candidate、Activation、watchdog、recovery 或历史 operation 来伪造连续所有权。完整状态机、恢复与 listener 规则见[自动更新](../operations/auto-update.md#技术命名空间迁移发布)和[部署](../operations/deployment.md#技术命名空间交接)。

helper 启动的 source/target 参与者在事务 terminal 前只运行 owner-only 受限控制面和等待接管的 Gateway，不启动普通恢复、自动更新、Sandbox 或后台维护。为让已绑定 Manager socket 的 Platform 在维护预约下启动，受限控制面只合成 transaction-bound、`maintenance=true` 的只读状态；其它普通 API 全部关闭。参与者先在线并通过 helper challenge，helper 才启动相应固定容器栈。目标 listener 接管后，helper 先耐久写入 forward-only 的 `target_commit_planned`，再让目标 Platform 提交 machine schema、持久化 transaction/generation/binding 绑定的 receipt 并释放预约；receipt 与 terminal `committed` 同步后，同一目标进程才取得普通启动所有权并原子提升 handler。terminal 因而已经包含目标准入结算证明，不存在“先报告 committed、重启后再猜测是否释放”的窗口。

持久 helper 还是唯一的目标宿主安装 owner：目标数据发布后，它从 journal 与已验证目标 artifact 确定性生成并原子安装目标 stable binary、配置和 user unit，之后目标 participant 才可启动。普通 source/target Manager、自更新和环境 locator 均不能安装或选择这些对象；崩溃只重放完全相同安装，回滚在 writer fence 后精确删除，提交保留。source preflight 必须把目标 runtime socket 解析成唯一规范绝对路径并写入 journal；participant 证明、目标配置、PID/token 连接、listener challenge 与 Compose control mount 都使用该同一个字符串，不允许逻辑/实际双重身份。`target_commit_planned` 重启时 target participant 仍可消费这一严格绑定的 startup capability，helper 先恢复/证明 participant，再继续 forward-only commit。

完整 Manager 的所有后台可变循环都通过同一 routed handoff admission，而不只是 operation 和 executor HTTP 路由。每次 Capability/Firecrawl 对账、Sandbox lifecycle/镜像刷新、维护清理、自动更新发布与异步进程终态落盘先持有 handoff global observation，再进入 runtime、maintenance 或 fixed-stack 子边界。一旦有非终态 journal，这些循环与其 audit 保持零写入；journal terminal 后不需人工重启，下一轮重新取得观测即恢复。

## 故障边界

- 两个可写 Platform generation 不能同时打开同一 SQLite。
- release manifest 中的数据库版本必须单调递增；DDL、外键校验和迁移标记形成一个原子提交，失败时由 Manager 保留快照并回滚 generation。
- Platform 重启不应重复执行已经开始副作用的 job。
- Runtime 重启通过幂等记录和会话日志区分可重放结果与 `needs_review`。
- 管理器重启从 operation journal 和容器 label 对账，不从容器名称猜测状态。
- handoff 任一阶段只能有一个 journal writer；target profile 选择和 `target_ack` 必须分别来自已验证 journal 与目标 Manager，不从目录、进程名或普通 operation 推断。
- 命名空间转换只改写机器拥有的路径引用、marker、协议键与 ownership metadata；用户消息、记忆、Skill、session 正文、附件内容和其它用户文本不做品牌或命名空间字符串替换。
- 搜索、抓取、浏览器和 Cognee 失败只影响对应工具，不能破坏本地消息和知识数据。
- 邮件轮询和回复通知失败只降级对应集成，不阻断对话；更新维护期间不启动新的邮件副作用或唤醒。
- Run 空闲、模型轮次和 terminal 默认超时只在 [`runtime-policy.json`](../contracts/runtime-policy.json) 定义；容器与更新状态只在 [`container-platform.json`](../contracts/container-platform.json) 定义。
