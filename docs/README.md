# Agent Platform 文档

按要完成的任务进入，不必顺读全部文档。设计约束、接口、配置和操作步骤各有一个维护位置；其他页面只做摘要和链接。

## 从任务开始

| 我想做什么 | 首先阅读 | 需要深入时 |
|---|---|---|
| 了解产品能做什么、不能做什么 | [产品范围](design/product.md) | [系统架构](design/system-architecture.md) |
| 安装、启动或排查部署 | [部署指南](operations/deployment.md) | [配置](reference/configuration.md)、[数据目录](reference/data-layout.md) |
| 理解发布、升级、维护或回滚 | [自动更新](operations/auto-update.md) | [数据与恢复边界](design/data-memory-sessions.md)、[验收](development/testing.md) |
| 修改聊天、输入、电脑画面或管理界面 | [前端行为](design/frontend.md) | [开发入口](development/repository.md)、[安全边界](design/security-and-trust.md) |
| 修改模型循环、工具、委派或会话处理 | [Agent Runtime](design/agent-runtime.md) | [Runtime API](reference/runtime-api.md)、[数据与会话](design/data-memory-sessions.md) |
| 接入模型、浏览器、搜索、邮件、Telegram、Skill 或 MCP | [外部集成](design/integrations.md) | [配置](reference/configuration.md)、[安全边界](design/security-and-trust.md) |
| 修改持久状态、文件访问或数据迁移 | [数据与会话](design/data-memory-sessions.md) | [目录与迁移边界](reference/data-layout.md)、[安全边界](design/security-and-trust.md) |
| 找代码、运行检查或提交修改 | [仓库开发指南](development/repository.md) | [测试与 QA](development/testing.md)、[文档流程](development/documentation-workflow.md) |

## 信息放在哪里

- **设计**说明职责、可观察行为和必须保持的不变量，不复述每个函数或测试用例。
- **参考**集中说明接口字段、配置来源和磁盘布局；查参数或路径时从这里进入。
- **运维**给出安装、发布、更新、恢复的操作顺序和失败处理。
- **开发**说明修改入口、工具命令、验证要求和文档维护方式。
- **[架构决策](decisions/README.md)**解释重要选择的理由，不替代当前规范。

同一规则只在所属页面完整定义。例如：界面行为看前端文档，Run 行为看 Runtime 文档，网络和文件信任规则看安全文档，发布协议看自动更新，验收方法看测试指南。实现修复或内部整理不需要为“同步”而追加一段文档。

## 机器契约

稳定的跨组件值和闭世界集合以机器契约为准，不在多份说明里复制默认值：

| 契约 | 内容 |
|---|---|
| [runtime-policy.json](contracts/runtime-policy.json) | Run、工具与后台等待的精确策略 |
| [container-platform.json](contracts/container-platform.json) | 受管服务、资源与容器契约 |
| [technical-profiles.json](contracts/technical-profiles.json) | 技术身份及固定路径约束 |
| [upstream-sources.json](contracts/upstream-sources.json) | 上游源码来源与锁定版本 |

[domains.json](domains.json) 登记代码、规范、测试和生成消费者的关系。检查和生成命令见[文档流程](development/documentation-workflow.md)。代码与说明有冲突时，先确认所需行为及其权威来源，不靠改一句文档掩盖问题。
