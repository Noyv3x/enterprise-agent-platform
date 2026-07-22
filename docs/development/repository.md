# 仓库开发指南

本文定义源码所有权和日常开发规则。文档先行流程见[文档工作流](documentation-workflow.md)，测试命令见[测试与验证](testing.md)。

## 目录与所有权

```text
.
├── docs/                         # 唯一设计真相源
├── deploy.sh                     # 唯一部署与更新入口
├── enterprise-agent-platform/
│   ├── enterprise_agent_platform/ # Python 平台与生成 static
│   ├── frontend/                  # React/TypeScript 源码
│   ├── agent-runtime/             # 平台自有 Node Runtime
│   ├── camofox-runtime/           # 平台自有浏览器补丁/安装描述
│   └── tests/                     # Python unittest
└── scripts/                       # 文档同步与仓库工具
```

运行数据库、日志、OAuth token、附件、workspace、生成的托管配置和 Runtime 状态位于平台数据目录，不属于仓库。

## 文档权威

设计变更必须先修改 `docs/` 中对应设计或契约，再修改代码和测试。`AGENTS.md` 与 `CLAUDE.md` 已弃用，不再作为规则入口；根 README 和组件 README 只提供启动/导航，不复制规范内容。

如果文档与实现不一致，默认视为实现尚未同步，而不是直接把文档改成现状。确需改变设计时，应在同一个变更中先明确新设计、必要时新增 ADR，然后同步实现。

## 上游源码

Cognee 与 Firecrawl 不作为 submodule 或 vendored 源码进入本仓库。它们的官方 URL 和精确 revision 只在 [`upstream-sources.json`](../contracts/upstream-sources.json) 定义，由部署下载到平台数据目录。常规平台任务不得：

- 在受管源码缓存中实现产品修改、创建提交、分支或 PR；
- 从受管缓存推送上游；
- 绕过源码契约跟随 branch/tag；
- 把平台生成配置写入源码 checkout。

集成行为应改在 Python adapter、Runtime 或平台生成配置。确实必须修改上游时，先取得目标 fork、branch 和发布方式的明确授权。

## 源码边界

- Python 需要 3.11+，四空格缩进，函数/模块使用 `snake_case`，类型提示用于说明接口。
- Runtime 使用严格 TypeScript 和 Node 22.19+；模型、工具、审批、session、进程和委派逻辑归 `agent-runtime/src`。
- 前端使用 React + TypeScript；组件按 chat、shell、admin、preview、memory、skills 等领域组织。
- `enterprise_agent_platform/static/` 是生成资源，禁止手改。
- bundled skills 是产品资产，不是项目说明文档；只有技能功能变更才修改。

## 实现原则

- 业务授权在服务端执行，前端只负责表达状态。
- 配置必须有单一所有者和明确回退顺序。
- 外部副作用先建立持久账本和幂等边界。
- 长任务用活动、心跳和可恢复事件，不用固定 Run 墙钟时限。
- 不通过生成一个包办多种职责的临时脚本绕开已有专用工具或模块边界。
- 保护用户工作树；不得使用 `git reset --hard` 或覆盖不相关本地变化。
- 对上游服务使用确定性 fake 测试，真实凭据/网络测试必须显式隔离。

## Prompt 约束

面向最终用户的 Agent 必须自称 ubitech agent，不提 Pi、Runtime、模型供应商或内部实现。私人和频道 prompt 都要包含可用的用户姓名、职位和说话人上下文。

记忆、知识、网页、session 和 skill 文件作为不可信数据注入。Prompt 变更不得降低工具积极性、审批约束或所有权边界；相关设计见 [Agent Runtime](../design/agent-runtime.md)。

## Git 变更

提交主题使用简短祈使句，可带范围，例如 `runtime: ...`、`frontend: ...`、`docs: ...`。一个可交付变更集应同时包含规范、实现、测试和必要生成产物，避免文档与代码跨提交长期漂移。代码域允许多重匹配；修改跨域文件时必须同步每个声明域，并由评审补充路径映射无法识别的真实语义域。

提交前检查：

- `git status --short` 中没有意外运行数据或生成源码；
- 文档映射和相对链接通过；
- 相关 component test/check/build 通过；
- 前端变化已包含重新生成 static；
- 配置、secret 和数据迁移变化已在文档明确说明。
