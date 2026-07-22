# 系统架构

本文描述 ubitech agent 的组件边界和主要数据流。产品范围见[产品设计](product.md)，部署拓扑见[部署](../operations/deployment.md)，运行数据目录见[数据布局](../reference/data-layout.md)。

## 总览

```text
Browser / Telegram
        │
        ▼
Persistent Gateway
        │
        ▼
Python Platform ───────── SQLite / attachments / workspaces
        │
        ├── Agent Runtime ── OAuth model endpoints / host tools
        ├── SearXNG ──────── search result discovery
        ├── Firecrawl ────── page extraction
        ├── Camoufox ─────── browser sessions and preview frames
        └── Cognee ───────── optional knowledge augmentation
```

系统只包含一个公网 HTTP 入口。托管服务和 Agent Runtime 默认监听宿主机回环地址，不应由反向代理直接公开。

## 持久 Gateway

Gateway 持有产品监听端口，将业务请求代理到动态分配的回环 backend。Python backend 可以在不释放公网监听 socket 的情况下更换。Gateway 同时维护本地控制 socket、backend generation、活动请求计数和心跳状态。

部署与自动更新期间，Gateway 先停止新的业务准入并排空写请求，再停止旧 backend。处于维护状态时，健康与更新状态接口仍然可用，其余请求返回结构化的 `platform_updating` 响应，浏览器据此展示全屏维护页。新 backend 健康后才恢复业务流量。

## Python 平台

Python 平台使用标准库线程式 HTTP 服务并拥有产品业务状态：

- 登录、会话签名、账号和服务端权限；
- 频道、私人消息、附件、审计和 token 用量；
- Agent scope、消息准入、持久任务、短消息合并和计划任务；
- 记忆、候选记忆、知识库、技能和跨会话搜索；
- OAuth 流程、凭据刷新和可见模型目录；
- Telegram、自动更新及托管服务生命周期；
- 面向 Runtime 的内部工具 Gateway。

SQLite 使用 WAL 和按线程连接。会产生外部副作用的 Agent 任务及 Telegram 投递通过持久任务账本记录；进程重启后，安全可重试的任务可重新排队，已开始副作用的任务进入人工复核。

## Agent Runtime

Node.js sidecar 直接使用锁定版本的 Pi Core 与 Pi AI。它拥有一次 Run 内的模型和工具循环、SSE 事件、审批等待、进程登记、委派、上下文压缩、JSONL 会话和幂等结果。Python 通过私有 HTTP 创建 Run，并消费可恢复的 SSE 日志；Runtime 通过带独立 token 的反向请求访问 Python 所有的业务工具。

Runtime 不拥有账号、频道、OAuth refresh token 或产品消息库。具体职责见 [Agent Runtime](agent-runtime.md)，协议见 [Runtime API](../reference/runtime-api.md)。

## 前端

React 应用由 Python 作为静态资源服务。浏览器通过同源 `/api` 请求和 scope SSE 获取状态；自有 external store 负责会话、聊天、管理资源和竞态合并。维护门位于登录和应用错误边界之外，因此 backend 切换时即使原应用状态失效，也能可靠进入维护页。详见[前端设计](frontend.md)。

## 托管服务

`PlatformRuntimeManager` 统一准备、启动、探测、重启和停止 Agent Runtime、Camoufox、SearXNG、Firecrawl，并准备 Cognee 环境。所有上游 checkout、生成配置、安装产物、profile、日志和数据库位于平台数据目录；Cognee/Firecrawl 的来源和 revision 由 canonical 源码契约锁定，不进入产品仓库。详见[外部集成](integrations.md)。

## 关键数据流

### 交互回复

1. Python 完成权限检查并持久化用户消息和 Agent job。
2. 每个会话 FIFO worker 领取任务，全局并发门控制同时进入 Runtime 的数量。
3. Python 创建 Runtime Run，随后消费 SSE；工具过程和最终内容分别写入状态和消息元数据。
4. Runtime 请求业务工具时回调 Python；宿主机文件、命令与进程工具直接在 Runtime 执行。
5. 最终回复和用量先持久化，再将任务账本转为成功。

### 运行中追加输入

私人 Agent 的后续短消息先获得独立持久 job，再尝试绑定活动 Run。Runtime 明确返回 accepted、injected 或 unconsumed；未消费输入回到 FIFO 队列，不能静默丢失或被错误标记成功。

### 更新

自动更新先等待全局自然空闲点，再原子保留 Agent 准入，建立持久维护标记并把部署交给 `deploy.sh update`。完整协议见[自动更新](../operations/auto-update.md)。

## 故障边界

- Python 重启不应重复执行已经开始副作用的 job。
- Runtime 重启通过幂等记录和会话日志区分可重放结果与 `needs_review`。
- 托管搜索、抓取、浏览器和 Cognee 失败只应影响对应工具，不能破坏本地消息和知识数据。
- 生成静态资源采用验证、分阶段复制和入口文件最后提交，避免半套前端发布。
- Run 空闲、模型轮次和 terminal 默认超时的跨层值只在 [`runtime-policy.json`](../contracts/runtime-policy.json) 定义；传输、维护和其它工具边界由各自参考文档及测试约束。
