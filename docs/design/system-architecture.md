# 系统架构

本文描述 ubitech agent 的组件边界和主要数据流。产品范围见[产品设计](product.md)，部署拓扑见[部署](../operations/deployment.md)，运行数据目录见[数据布局](../reference/data-layout.md)。

## 总览

```text
Browser / Telegram
        │
        ▼
Host ubitech-manager ───── maintenance / releases / host executor
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

## 管理平面

`ubitech-manager` 是源码树之外的稳定控制平面，拥有：

- 公网 Gateway、维护状态和 owner-only Unix 控制 socket；
- 固定服务与按 Agent Sandbox 的创建、停止、对账和日志轮转；
- release manifest 校验、镜像预拉取、更新、快照、回滚和自恢复；
- sandbox/host 执行路由，以及宿主执行审计；
- 容器 generation、operation journal 和健康状态。

管理器不拥有账号、频道、消息、OAuth 或 Agent 上下文。Platform 正常时，管理面板通过内部认证接口读取安全摘要并提交管理 operation；Platform 失败时只使用宿主 CLI 恢复。

## Python 平台

Python Platform 容器拥有产品业务状态：

- 登录、会话签名、账号和服务端权限；
- 频道、私人消息、附件、审计和 token 用量；
- Agent scope、消息准入、持久任务、短消息合并和计划任务；
- 记忆、候选记忆、知识库、技能和跨会话搜索；
- OAuth 流程、凭据刷新和可见模型目录；
- Telegram 与面向 Runtime 的内部业务工具 Gateway。

SQLite 使用 WAL 和按线程连接。会产生外部副作用的 Agent 任务及 Telegram 投递通过持久任务账本记录；进程重启后，安全可重试的任务可重新排队，已开始副作用的任务进入人工复核。Platform 不再安装依赖、拉取上游源码、调用 Compose 或拥有服务生命周期。

## Agent Runtime

Node.js Runtime 容器直接使用锁定版本的 Pi Core 与 Pi AI。它拥有一次 Run 内的模型和工具循环、SSE 事件、工具策略、委派、上下文压缩、JSONL 会话和幂等结果。Python 通过私有容器网络创建 Run 并消费可恢复事件；Runtime 通过独立 token 回调 Python 业务工具。

Runtime 不拥有 Docker socket。terminal、process 和文件工具携带主 Agent sandbox identity 调用管理器的容器内 Unix 控制 socket；管理器确保 Sandbox 存在后执行。显式 `target=host` 的单次调用改由管理器以部署用户执行。具体职责见 [Agent Runtime](agent-runtime.md)，协议见 [Runtime API](../reference/runtime-api.md)。

## 前端

React 应用随 Platform 镜像发布，由 Python 作为静态资源服务。浏览器通过同源 `/api` 请求和 scope SSE 获取状态；自有 external store 负责会话、聊天、管理资源和竞态合并。维护门位于登录和应用错误边界之外，因此 Platform generation 切换时仍能可靠显示管理器维护页。详见[前端设计](frontend.md)。

## 外部能力

Camoufox、SearXNG 和 Firecrawl 是固定受管容器；Cognee 代码与依赖构建进 Platform 镜像。上游 URL 与 revision 由 canonical 契约锁定，CI 在构建时验证并产出不可变镜像；部署机不保留或更新上游 Git checkout。详见[外部集成](integrations.md)。

## 关键数据流

### 交互回复

1. Platform 先确认 Manager 持久更新预约已释放，再完成权限检查并持久化用户消息和 Agent job；候选容器启动期间所有后台 worker 同样保持冻结。
2. 每个会话 FIFO worker 领取任务，全局并发门控制同时进入 Runtime 的数量。
3. Platform 创建 Runtime Run，随后消费事件；工具过程和最终内容分别写入状态和消息元数据。
4. Runtime 将产品工具回调 Platform；terminal、process 与文件工具按主 Agent identity 调用管理器，默认进入对应 Sandbox。
5. 管理器在执行前产生带完整安全展示参数的审计事件，再将输出流回 Runtime；宿主目标还记录 target、部署用户和 sudo 使用情况。
6. 最终回复和用量先持久化，再将任务账本转为成功。

### 运行中追加输入

私人 Agent 的后续短消息先获得独立持久 job，再尝试绑定活动 Run。Runtime 明确返回 accepted、injected 或 unconsumed；未消费输入回到 FIFO 队列，不能静默丢失或被错误标记成功。

### Sandbox 生命周期

私人 Agent 和频道主 Agent各自对应一个稳定 sandbox identity；委派子 Agent继承父 identity。管理器首次调用时创建容器并挂载工作区、HOME 和环境目录；任务活动与已登记后台进程会延长生命周期。无任务且无后台进程达到契约空闲时间后只停止容器，数据目录不删除。

### 更新

管理器先验证 release manifest 并预拉取镜像，再等待 Platform 的全局自然空闲点。原子预约成功后入口切换为维护，旧 Platform 停止，数据库快照与迁移完成后启动新 generation；只有所有核心 readiness 通过才恢复业务。完整协议见[自动更新](../operations/auto-update.md)。

## 故障边界

- 两个可写 Platform generation 不能同时打开同一 SQLite。
- release manifest 中的数据库版本必须单调递增；DDL、外键校验和迁移标记形成一个原子提交，失败时由 Manager 保留快照并回滚 generation。
- Platform 重启不应重复执行已经开始副作用的 job。
- Runtime 重启通过幂等记录和会话日志区分可重放结果与 `needs_review`。
- 管理器重启从 operation journal 和容器 label 对账，不从容器名称猜测状态。
- 搜索、抓取、浏览器和 Cognee 失败只影响对应工具，不能破坏本地消息和知识数据。
- Run 空闲、模型轮次和 terminal 默认超时只在 [`runtime-policy.json`](../contracts/runtime-policy.json) 定义；容器与更新状态只在 [`container-platform.json`](../contracts/container-platform.json) 定义。
