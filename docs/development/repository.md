# 仓库开发指南

文档怎么写、什么时候改见[文档工作流](documentation-workflow.md)；测试命令和证据要求见[测试与验证](testing.md)。

## 目录与所有权

| 任务 | 源码入口 | 规则所在文档 |
| --- | --- | --- |
| 业务路由、授权 | `enterprise-agent-platform/enterprise_agent_platform/` 下的 `server.py`、`service.py`、`auth.py` | [架构](../design/system-architecture.md)、[安全](../design/security-and-trust.md) |
| 数据、学习、会话 | 同一个包里的 `db.py`、`learning.py`、`agent_scopes.py` | [数据设计](../design/data-memory-sessions.md)、[数据布局](../reference/data-layout.md) |
| 模型、工具、审批、Run、提示词 | `enterprise-agent-platform/agent-runtime/src/` | [Runtime](../design/agent-runtime.md)、[API](../reference/runtime-api.md)、[产品](../design/product.md) |
| 界面 | `enterprise-agent-platform/frontend/src/` | [前端](../design/frontend.md) |
| 网关、执行、宿主机更新与恢复 | `manager/`；唯一的生产命令是 `cmd/agent-platform-manager` | [部署](../operations/deployment.md)、[自动更新](../operations/auto-update.md) |
| 外部能力 | Python 的 `runtimes.py`、`enterprise-agent-platform/camofox-runtime/`、`containers/` | [集成](../design/integrations.md)、[配置](../reference/configuration.md) |
| 镜像、安装、发布 | `containers/`、`install.sh`、`.github/workflows/`、`scripts/` | [部署](../operations/deployment.md)、[自动更新](../operations/auto-update.md) |
| 文档、生成的契约 | `docs/`、`scripts/docs_sync.py` | [文档工作流](documentation-workflow.md) |

- 数据库、日志、token、附件、工作区、托管配置和 Runtime 状态都属于数据目录，不是源码。
- 本地的 `.grok/`、研究用的源码 checkout、缓存和凭据都不是源码。用户的 Skill/MCP 只存在于 Agent 工作区，不作为发布输入。

## 上游源码

- Firecrawl 不以子模块或内置源码的方式引入。上游地址和精确版本只记录在 [upstream-sources.json](../contracts/upstream-sources.json)；CI 和验收时在隔离环境中获取并验证，部署机只拉取发布的镜像。
- 禁止在临时的上游 checkout 里做产品修改、建立提交/分支/PR、从缓存推送、跟随分支或 tag，或写入生成的配置。
- 产品修改应当放在本仓库的适配层、Runtime、沙箱客户端或生成的配置中。确实需要修改上游时，先获得关于 fork、分支和发布方式的授权。

## 源码约定

- Python：四个空格缩进、`snake_case`、接口带类型提示。Runtime 用严格模式的 TypeScript，Manager 用 Go，界面用 React/TypeScript 并按业务域组织。
- 版本以各组件的清单和 CI 为准；沿用 npm 的 lockfile 和 `npm ci`；Python 工具显式使用 `python3`。不为了本地方便更换包管理器。
- Manager 的职责不下放给业务容器；不保留一次性的部署转换或签名命令。
- Python 构建只包含 `pyproject.toml`、包说明和 Python 包，不含 Runtime、Camoufox、前端源码或测试；前端由独立的构建阶段覆盖到 wheel 中。被忽略的 `enterprise_agent_platform/static/` 禁止手改或提交。
- 预置 Skill 是功能资产，不是项目说明，只随技能功能一起修改。

## 实现原则

- 遵循各设计文档中的安全、状态和 Runtime 规则：授权在服务端完成，每个配置只有一个所有者。
- 有副作用的操作先记账、保证幂等；复用已有的事务助手和带类型的错误；超时后不盲目重放。
- 长任务依靠活动时间、心跳和恢复，而不是给 Run 设固定的总时长。
- 复用客户端和执行器的注入接口，不为测试在生产代码里加后备路径，也不写包办一切的临时脚本。
- 账号、对话范围、Run、生命周期的异步隔离不能用"取消"代替；每个退出路径都要释放锁、订阅和容量。
- 外部服务的替身要确定性；真实的网络和凭据要隔离。
- 保护用户的工作树：禁止 `git reset --hard`，也不能覆盖无关的改动。

## Git 变更

- 开始前说明交付物、不做的事、影响的领域和预计规模。实际涉及的领域或文件数超过预估的两倍，或者要引入新协议、迁移层或新的发布架构时，先重新报告。
- 无关的缺陷，除非阻塞当前工作，否则记为后续事项。
- 提交标题简短、用祈使语气，可以带组件范围。
- 同步修改真正受影响的契约、实现、行为测试和生成的代码，不用改文档来掩盖实现上的偏差。
- 不提交运行数据或生成的源码。只 push 通过了[完整门禁和相应验收](testing.md)的、可回滚的改动单元；调试留在本地，不要连续 push 来试 CI。
- 只改文档也要遵守[累计发布判定](../operations/auto-update.md#发布通道)；如实区分本地证据和发布证据。
