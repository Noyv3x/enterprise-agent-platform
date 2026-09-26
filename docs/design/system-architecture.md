# 系统架构

本文定义各组件负责什么，以及主要流程怎么走。部署步骤见[部署手册](../operations/deployment.md)，磁盘路径见[数据布局](../reference/data-layout.md)。

## 总览

```text
浏览器 → Manager 网关 → Platform ↔ Telegram / IMAP / SMTP
          └ 维护页        ├→ Runtime → 模型
                          └→ Camoufox / SearXNG / Firecrawl
Platform / Runtime → Manager 执行器 → 沙箱 → 工作区 MCP
                                    └→ 宿主机（显式指定、逐次审批）
```

- Manager 以宿主机的 user-systemd 服务运行，持有唯一的对外端口：正常时把请求转给当前的 Platform，更新或故障时返回维护页。
- 只有 Manager 能访问 Docker。它管理一个跨版本保留的私有网络；固定服务栈和沙箱都挂在这个网络上。停止 Compose 不会删除网络，也不会断开沙箱。

## 组件边界

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| Manager | 源码树外的单实例控制面：对外入口、执行器 socket（仅属主可访问）、容器和执行审计、发布、更新、快照、回滚及其日志 | 任何产品业务状态。它的操作由 Platform 管理面板认证后发起；Platform 不可用时用宿主机命令行 |
| Platform | 登录与授权、SQLite 业务数据、消息与附件、对话与持久任务、业务工具、集成、预览 | 服务生命周期、依赖安装、拉取源码、管理 Compose |
| Runtime | 基于 Node.js 和锁定版本的 Pi Core / Pi AI：执行模型与工具循环、推送事件、保存 JSONL 会话和幂等结果。业务工具回调 Platform，文件、终端、进程工具经 Manager 执行 | 访问 Docker |
| React 前端 | 随 Platform 镜像发布并由它提供；使用同源 API 和对话实时推送。维护页在登录和应用错误边界之外 | 授权判断或持久数据 |
| 沙箱 | 每个主 Agent 一个：工作区、HOME、环境变量和进程；委派子任务继承父 Agent 的身份。首次执行时创建，任务和登记的后台进程会延长存活期，空闲时只停止不删除，重建后数据保留。Skill 和 MCP 放在工作区里，由固定的一次性 stdio 客户端在沙箱内执行 | — |
| 外部能力 | Camoufox（每个 Agent 独立 Profile）、SearXNG、Firecrawl。CI 按锁定的地址和版本构建镜像，部署机上不保留上游源码 | 用户自己的 MCP（不属于固定服务） |

数据归属：

- SQLite 管业务数据，JSONL 管模型会话，工作区管文件；Manager 的日志和登记表管部署身份。预览只是派生结果。
- 技术身份只有一套，不自动发现旧身份，也不随[品牌](product.md#品牌配置)变化。

## 关键数据流

### 交互回复

1. Platform 确认没有待执行的更新预约，完成鉴权并保存消息和任务。触发 Agent 前，先按[接管规则](security-and-trust.md)释放发送者的浏览器接管。
2. 每个会话一个先进先出的处理队列，经过全局并发上限后创建 Run，消费可恢复的事件，分别维护工作过程和最终内容。
3. Runtime 调用 Platform 的业务工具，或带着可信的 Agent 身份经 Manager 执行命令。默认在沙箱里执行；每次执行先经过硬性拦截和审计，宿主机执行还需要逐次审批。
4. 最终回复和用量写入数据库后才算成功。文件转成结构化附件；预览只展示当前有权访问的对话里真实、有长度上限的内容。

用户在 AI 工作时追加的输入单独记账，没被消费的会重新排队。有限的后台进程在同一个 Run 里等待，不靠定时任务轮询。细节见 [Runtime](agent-runtime.md) 和 [API](../reference/runtime-api.md)。

### 后台学习复盘

个人 AI 回复后的学习复盘是低优先级的持久任务，失败不影响已交付的回复。资格、授权、预算和恢复见[数据与会话](data-memory-sessions.md)。

### 更新

1. Manager 验证并预先下载新版本，等系统自然空闲后预约更新并进入维护模式。
2. 停止旧的写入方、做快照、执行迁移、启动新版本。
3. 新版本的后台处理先冻结，所有核心就绪检查通过且预约解除后才恢复业务；任何一步失败都恢复或回滚。

详见[自动更新](../operations/auto-update.md)。

普通启动只接受与当前版本完全一致的数据库标记和结构，不会补建持久身份；只有能从权威数据重建的派生索引可以按约定修复。唯一的例外是紧邻上一版本的迁移，见[受控迁移](../reference/data-layout.md#受控迁移)。

## 故障边界

| 组件 | 出错时怎么恢复 |
| --- | --- |
| Platform | 恢复持久任务，回滚失败的事务。不盲目重放已经开始的副作用，也不凭内存里的旧状态猜测已经成功 |
| Runtime | 依靠幂等记录和会话区分"可以安全重放"和"需要人工复核"（needs_review）；没有终态不等于成功 |
| Manager | 依据日志和容器归属标签对账，而不是容器名；始终只有一个 Platform 在写数据；请求响应丢失或损坏时用原来的幂等身份对账 |
| 外部能力 | 只降级出问题的那项能力，不破坏消息和文件。MCP 不会换个目录兜底；邮件和通知不阻塞对话；维护期间不开始新的副作用或唤醒 |

相关文档：认证、文件和审批见[安全设计](security-and-trust.md)；OAuth 凭据、模型目录及降级见[集成](integrations.md)；界面呈现见[前端](frontend.md)。超时和模型轮次以 [runtime-policy.json](../contracts/runtime-policy.json) 为准，容器和更新状态以 [container-platform.json](../contracts/container-platform.json) 为准。
