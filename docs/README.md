# Agent Platform 文档

按要做的事找入口，不需要从头读完。每条规则只在一个地方完整定义，其它页面只做摘要并链接过去。

## 从任务开始

| 我想做什么 | 先读 | 需要深入时 |
|---|---|---|
| 了解产品能做什么、不做什么 | [产品设计](design/product.md) | [系统架构](design/system-architecture.md) |
| 安装、启动或排查部署 | [部署](operations/deployment.md) | [配置](reference/configuration.md)、[数据布局](reference/data-layout.md) |
| 理解发布、升级、维护或回滚 | [自动更新](operations/auto-update.md) | [数据设计](design/data-memory-sessions.md)、[测试与验证](development/testing.md) |
| 修改聊天、输入框、电脑画面或管理界面 | [前端设计](design/frontend.md) | [仓库开发指南](development/repository.md)、[安全设计](design/security-and-trust.md) |
| 修改模型循环、工具、委派或会话 | [Agent Runtime](design/agent-runtime.md) | [Runtime API](reference/runtime-api.md)、[数据设计](design/data-memory-sessions.md) |
| 接入模型、浏览器、搜索、邮件、Telegram、Skill 或 MCP | [外部集成](design/integrations.md) | [配置](reference/configuration.md)、[安全设计](design/security-and-trust.md) |
| 修改持久状态、文件访问或数据迁移 | [数据设计](design/data-memory-sessions.md) | [数据布局与迁移](reference/data-layout.md)、[安全设计](design/security-and-trust.md) |
| 找代码、运行检查或提交修改 | [仓库开发指南](development/repository.md) | [测试与验证](development/testing.md)、[文档工作流](development/documentation-workflow.md) |

## 信息放在哪里

- **设计**（`design/`）：职责、用户可见的行为、必须守住的规则。不写实现细节。
- **参考**（`reference/`）：接口字段、配置来源、磁盘布局。查参数或路径时从这里进。
- **运维**（`operations/`）：安装、发布、更新、恢复的操作顺序和失败处理。
- **开发**（`development/`）：代码入口、命令、验证要求和文档的写法。
- **[架构决策](decisions/README.md)**：重要选择的理由，不替代当前规范。

同一条规则只在它所属的页面完整定义：界面行为看前端设计，Run 的行为看 Runtime，网络和文件的信任规则看安全设计，发布协议看自动更新，验收方法看测试与验证。修 bug 或内部重构不需要为了"同步"而改文档，详见[文档工作流](development/documentation-workflow.md)。

## 机器契约

跨组件共享的精确值和封闭集合以机器契约为准，文档里不重复默认值：

| 契约 | 内容 |
|---|---|
| [runtime-policy.json](contracts/runtime-policy.json) | Run、工具和后台等待的精确策略 |
| [container-platform.json](contracts/container-platform.json) | 受管服务、资源和容器契约 |
| [technical-profiles.json](contracts/technical-profiles.json) | 技术身份和固定路径 |
| [upstream-sources.json](contracts/upstream-sources.json) | 上游源码的来源和锁定版本 |

生成和检查的命令见[文档工作流](development/documentation-workflow.md)。代码和文档冲突时，先确认正确的行为和它的权威来源，不靠改一句文档掩盖问题。
