# 仓库开发指南

本文定义源码所有权和日常开发规则。文档先行流程见[文档工作流](documentation-workflow.md)，测试命令见[测试与验证](testing.md)。

## 目录与所有权

```text
.
├── docs/                         # 唯一设计真相源
├── manager/                      # 宿主管理器、Gateway、更新与执行路由
├── containers/                   # 镜像、Compose 与安装模板
├── enterprise-agent-platform/
│   ├── enterprise_agent_platform/ # Python 平台包
│   ├── frontend/                  # React/TypeScript 源码
│   ├── agent-runtime/             # 平台自有 Node Runtime
│   ├── camofox-runtime/           # 平台自有浏览器补丁/安装描述
│   └── tests/                     # Python unittest
└── scripts/                       # 文档同步与仓库工具
```

运行数据库、日志、OAuth token、附件、workspace、生成的托管配置和 Runtime 状态位于平台数据目录，不属于仓库。本地 `.grok/` 会话与 workflow 文件也不属于产品源码。

## 文档权威

规范与机器契约的权威、修改顺序和当前树检查统一由[文档工作流](documentation-workflow.md)定义。根 `AGENTS.md` 只提供行为与导航，根及组件 README 只提供启动入口；均不复制本文或产品规范。实现与既有契约不符时修复实现，不以改写文档掩盖偏差；确需改变设计时先明确新设计，必要时记录 ADR。

## 上游源码

Firecrawl 不作为 submodule 或 vendored 源码进入本仓库。其官方 URL 和精确 revision 只在 [`upstream-sources.json`](../contracts/upstream-sources.json) 定义，由 CI 和容器验收直接读取、在隔离构建上下文中获取和验证；部署机只拉取发布清单中的镜像。常规平台任务不得：

- 在临时上游 checkout 中实现产品修改、创建提交、分支或 PR；
- 从构建缓存推送上游；
- 绕过源码契约跟随 branch/tag；
- 把平台生成配置写入源码 checkout。

集成行为应改在 Python adapter、Runtime、Sandbox 客户端或平台生成配置。用户自行安装的 Skill/MCP 包只进入对应 Agent workspace，不纳入产品源码或发布输入。确实必须修改其它上游时，先取得目标 fork、branch 和发布方式的明确授权。

## 源码边界

- Python 需要 3.11+，四空格缩进，函数/模块使用 `snake_case`，类型提示用于说明接口。
- Runtime 使用严格 TypeScript 和 Node 22.19+；模型、工具、审批、session、进程和委派逻辑归 `agent-runtime/src`。
- Manager 使用 Go；唯一生产命令是 `manager/cmd/agent-platform-manager`，公网 Gateway、Docker 编排、operation journal、release 校验、自更新/恢复和宿主执行归 `manager/`，业务容器不得复制这些职责。生产树不保留一次性部署转换或部署签名命令与包。
- 前端使用 React + TypeScript；组件按 chat、shell、admin、preview、memory、skills 等领域组织。
- Platform 的 Python 构建阶段只接收 `pyproject.toml`、包说明和 `enterprise_agent_platform/`；Runtime、Camoufox、前端源码及测试不得进入该阶段。容器内的前端独立构建后只把生成的 `static/` 覆盖进 Platform wheel。
- `enterprise_agent_platform/static/` 是忽略的生成资源，禁止手改或提交；本地前端构建可随时完整重建它。
- bundled skills 是产品资产，不是项目说明文档；只有技能功能变更才修改。
- 工具链版本以组件 manifest 与 CI 为准；使用现有 npm lockfile 和 `npm ci`，不因本地工具方便而替换包管理器。仓库 Python 工具显式用 `python3`；测试命名与框架见[测试与验证](testing.md)。

## 实现原则

- 业务授权在服务端执行，前端只负责表达状态。
- 配置必须有单一所有者和明确回退顺序。
- 外部副作用先建立持久账本和幂等边界；复用已有事务助手与 typed error，不确定结果保持需复核，不能在超时后盲目重放 mutation。
- 长任务用活动、心跳和可恢复事件，不用固定 Run 墙钟时限。
- 不通过生成一个包办多种职责的临时脚本绕开已有专用工具或模块边界。
- 复用已有 client/executor 注入边界，不把测试专用执行回退放入生产代码。异步工作保留 account、scope、Run 与 lifecycle 栅栏；取消不代替迟到响应隔离，所有出口释放锁、订阅和容量。
- 保护用户工作树；不得使用 `git reset --hard` 或覆盖不相关本地变化。
- 对上游服务使用确定性 fake 测试，真实凭据/网络测试必须显式隔离。

## Prompt 约束

面向最终用户的 Agent 使用当前部署配置的 Agent 显示名称；未配置时自称 `Agent`，不提 Pi、Runtime、模型供应商、源码维护方或内部实现。品牌名称只能作为经过校验的结构化展示数据进入 prompt，不能被解释成指令。私人和频道 prompt 都要包含可用的用户姓名、职位和说话人上下文。

记忆、网页、MCP 结果、session 和 Skill 文件作为不可信数据注入。Prompt 变更不得降低工具积极性、审批约束或所有权边界；相关设计见 [Agent Runtime](../design/agent-runtime.md)。

## Git 变更

提交主题使用简短祈使句，可带范围，例如 `runtime: ...`、`frontend: ...`、`docs: ...`。可交付变更应完成实际受影响的规范、实现、行为测试和生成消费者同步；实现修复、重构、测试或文档维护可以独立交付。路径可匹配多个域，评审须核对各域的真实语义影响，不以“每个域都碰过文档”代替契约一致性。

开始实现时记录预期交付物、非目标、受影响域与大致变更规模。若实际受影响域或文件数超出预估两倍，或任务从组件变更演变为新协议、新迁移层或发布架构改造，必须在继续扩大变更前重新报告范围。发现的无关缺陷记入后续项，除非它直接阻断本交付物，不在当前变更中顺手扩展。

`main` 的每次 push 都触发完整 Quality，是否需要构建及提升 release 由[自动更新的发布通道](../operations/auto-update.md#发布通道)判定。只推送已完成且通过本地全量门禁的可回滚交付单元；调试和未完成的中间检查点留在本地分支，不为获取 CI 反馈连续推送试错提交。文档-only 维护不是未完成检查点，也不能让尚未发布的产品变化绕过累计发布判定。

提交前确认范围内没有意外运行数据或生成源码，实际契约变化已说明，生成消费者一致；按[测试与验证](testing.md)完成对应组件、实际界面及安装／更新／回滚验收，诚实区分本地证据与完整发布证据。
