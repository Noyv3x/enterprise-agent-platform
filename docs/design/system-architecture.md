# 系统架构

本文定义组件所有权与主流程。部署见[部署手册](../operations/deployment.md)，持久路径见[数据布局](../reference/data-layout.md)。

## 总览

```text
Browser → Manager Gateway → Platform ↔ Telegram / IMAP / SMTP
           └维护页           ├→ Runtime → 模型
                             └→ Camoufox / SearXNG / Firecrawl
Platform / Runtime → Manager executor → Sandbox → 工作区 MCP
                                      └→ 宿主（显式目标、逐次审批）
```

宿主 user-systemd Manager 持有唯一公网 socket，代理当前 Platform 或返回维护页。仅 Manager 有 Docker socket；它持有跨 generation 私有 bridge，固定栈与 Sandbox 引用 external network，Compose 停止不删网络、不断开 Sandbox。

## 组件边界

| 组件 | 所有权与限制 |
| --- | --- |
| Manager | 源码树外的稳定单实例控制面：入口、owner-only socket、容器／执行审计、发布／更新／快照／回滚与 journal。无产品业务状态；由 Platform 面板认证操作，离线用宿主 CLI |
| Platform | 认证授权、SQLite 业务、消息／附件、scope／持久任务、业务工具／集成／预览。无服务生命周期、依赖安装、源码拉取或 Compose 管理 |
| Runtime | Node.js＋锁定 Pi Core/Pi AI：Run 模型／工具循环、SSE、JSONL／幂等结果。业务工具回调 Platform，文件／terminal／process 经 Manager；无 Docker socket |
| React 前端 | 随 Platform 镜像发布，由 Python 服务；同源 API、scope SSE、external store。维护门在登录和应用错误边界之外，不承担授权或持久权威 |
| Sandbox | 每主 Agent 的工作区／HOME／环境／进程，委派继承父 identity；首次执行创建，任务与登记后台进程延长活动期，空闲仅停、重建保留数据。Skill/MCP 留在工作区，固定一次性 stdio 客户端在此执行 |
| 外部能力 | Camoufox／分 Agent Profile、SearXNG、Firecrawl；CI 按锁定 URL/revision 构建镜像，部署机不保留上游 checkout。用户 MCP 不属固定服务 |

SQLite、JSONL、工作区分别管业务、模型会话和文件，Manager journal／registry 管部署身份；预览只派生。技术 profile 唯一，不发现旧身份，也不随[品牌](product.md#品牌配置)变化。

## 关键数据流

### 交互回复

1. Platform 确认更新预约释放、鉴权并持久化消息／job；触发 Agent 时先按[接管规则](security-and-trust.md)释放发送者租约。
2. 会话 FIFO worker 经全局执行并发门创建 Run，消费可恢复事件，分别维护工作过程与最终内容。
3. Runtime 调 Platform 业务工具或携可信 Agent identity 经 Manager 执行；默认 Sandbox，执行先过硬阻断和审计，宿主另需逐次审批。
4. 最终回复／用量落库后才标记成功；文件转结构化附件，预览仅投影当前授权 scope 的真实有界内容。

追加输入独立建账，未消费回队；有限后台进程在同 Run 等待，不用计划轮询。细则见 [Runtime](agent-runtime.md)和 [API](../reference/runtime-api.md)。

### 后台学习复盘

私人回复后的学习复盘是低优先级持久任务，失败不影响交付；资格、授权、预算和恢复见[数据与会话](data-memory-sessions.md)。

### 更新

Manager 验证／预拉 release，等自然空闲后预约并进入维护；停旧 writer、快照、迁移、启候选。候选 worker 冻结，核心 readiness 全通过且预约解除才恢复业务，失败恢复／回滚，见[自动更新](../operations/auto-update.md)。

普通启动只认精确当前 DB marker／结构，不补建持久身份；仅可从权威数据重建的派生索引按契约修复。直接前 baseline 迁移及当前版本例外仅见[受控迁移](../reference/data-layout.md#受控迁移)。

## 故障边界

| 负责方 | 恢复边界 |
| --- | --- |
| Platform | 持久任务恢复、失败事务回滚；不盲重放已开始副作用或以旧内存猜成功 |
| Runtime | 幂等记录／会话区分重放与 `needs_review`；缺失终态不是成功 |
| Manager | journal＋ownership label 对账而非容器名；始终单一 Platform writer；响应丢失／损坏以原幂等身份对账 |
| 外部能力 | 只降级该能力，不破坏消息／文件；MCP 不换目录兜底；邮件／通知不阻断对话，维护不开始新副作用／唤醒 |

认证／文件／审批见[安全设计](security-and-trust.md)，OAuth 同世代凭据／目录及降级见[集成](integrations.md)，呈现见[前端](frontend.md)。超时／模型轮次以 [runtime-policy.json](../contracts/runtime-policy.json)为准，容器／更新状态以 [container-platform.json](../contracts/container-platform.json)为准。
