# 仓库开发指南

精确多域所有权见 [domains.json](../domains.json)；语义 doc-first 见[文档工作流](documentation-workflow.md)，命令和证据见[测试与验证](testing.md)。

## 目录与所有权

| 任务 | 源码入口 | 契约所有者 |
| --- | --- | --- |
| 业务路由、授权 | `enterprise-agent-platform/enterprise_agent_platform/` 的 `server.py/service.py/auth.py` | [架构](../design/system-architecture.md)、[安全](../design/security-and-trust.md) |
| 数据、学习、会话 | 同包 `db.py/learning.py/agent_scopes.py` | [状态](../design/data-memory-sessions.md)、[布局](../reference/data-layout.md) |
| 模型、工具、审批、Run、Prompt | `enterprise-agent-platform/agent-runtime/src/` | [Runtime](../design/agent-runtime.md)、[API](../reference/runtime-api.md)、[产品身份](../design/product.md) |
| UI | `enterprise-agent-platform/frontend/src/` | [前端](../design/frontend.md) |
| Gateway、执行、宿主更新／恢复 | `manager/`；唯一生产命令 `cmd/agent-platform-manager` | [部署](../operations/deployment.md)、[更新](../operations/auto-update.md) |
| 外部能力 | Python `runtimes.py`、`enterprise-agent-platform/camofox-runtime/`、`containers/` | [集成](../design/integrations.md)、[配置](../reference/configuration.md) |
| 镜像、安装、发布 | `containers/`、`install.sh`、`.github/workflows/`、`scripts/` | [部署](../operations/deployment.md)、[更新](../operations/auto-update.md) |
| 文档、生成契约 | `docs/`、`scripts/docs_sync.py` | [文档工作流](documentation-workflow.md) |

数据库、日志、token、附件、workspace、托管配置和 Runtime 状态属于数据目录。本地 `.grok/`、研究 checkout、缓存、凭据不是源码；用户 Skill/MCP 只进 Agent workspace，不作发布输入。

## 上游源码

Firecrawl 不作 submodule/vendor。URL 和精确 revision 仅归 [upstream-sources.json](../contracts/upstream-sources.json)；CI／验收时隔离获取并验证，部署机只拉发布镜像。禁止在临时 checkout 做产品修改、建提交／分支／PR、从缓存推送、跟随 branch/tag 或写生成配置。产品修改应落在本仓库的 adapter、Runtime、Sandbox 客户端或生成配置；确需改上游，先获得 fork、branch 和发布方式的授权。

## 源码边界

- Python 四空格、`snake_case`、接口类型提示；Runtime 严格 TypeScript，Manager Go，React／TypeScript UI 按业务域组织。版本以组件 manifest／CI 为准，沿用 npm lockfile／`npm ci`，Python 工具显式 `python3`，不为本地方便换包管理器。
- Manager 职责不下放业务容器；不保留一次性部署转换／签名命令包。
- Python 构建只接收 `pyproject.toml`、包说明、Python 包，不含 Runtime／Camoufox／前端源码及测试；独立 frontend stage 覆盖 wheel。忽略的 `enterprise_agent_platform/static/` 禁止手改／提交。
- bundled skills 是功能资产，不作项目说明，只随技能功能修改。

## 实现原则

遵循表中安全、状态与 Runtime 契约：服务端授权、配置单一所有者；副作用先记账／幂等，复用事务助手／typed error，超时不盲重放。长任务用活动／心跳／恢复，不用固定 Run 墙钟截止。

复用 client/executor 注入接口，不加生产测试回退或包办临时脚本。异步 account/scope/Run/lifecycle 栅栏不能用取消替代；各出口释放锁／订阅／容量。外部服务 fake 确定，真实网络／凭据隔离。保护用户工作树，禁止 `git reset --hard` 或覆盖无关变化。

## Git 变更

开始说明交付物、非目标、影响域和规模；域／文件数超预估两倍，或升级为新协议、迁移层、发布架构前重新报告。无关缺陷除阻断外留后续项。提交主题简短祈使，可带组件范围。

同步真实受影响契约／实现／行为测试／生成消费者，不以改文档掩盖偏差。排除运行数据／生成源码，只 push 通过[完整门禁及相应验收](testing.md)的可回滚单元，调试留本地、不连续 push 试 CI。文档维护不豁免[累计发布判定](../operations/auto-update.md#发布通道)；如实区分本地与发布证据。
