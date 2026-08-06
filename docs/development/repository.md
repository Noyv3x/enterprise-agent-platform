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

运行数据库、日志、OAuth token、附件、workspace、生成的托管配置和 Runtime 状态位于平台数据目录，不属于仓库。

## 文档权威

设计变更必须先修改 `docs/` 中对应设计或契约，再修改代码和测试。根 `AGENTS.md` 只记录行为准则与文档先行工作方式，不记录代码库事实，也不替代本文；`CLAUDE.md` 已弃用。根 README 和组件 README 只提供启动/导航，不复制规范内容。

如果文档与实现不一致，默认视为实现尚未同步，而不是直接把文档改成现状。确需改变设计时，应在同一个变更中先明确新设计、必要时新增 ADR，然后同步实现。

## 上游源码

Firecrawl 不作为 submodule 或 vendored 源码进入本仓库。其官方 URL 和精确 revision 只在 [`upstream-sources.json`](../contracts/upstream-sources.json) 定义，由 CI 和容器验收直接读取、在隔离构建上下文中获取和验证；部署机只拉取发布清单中的镜像。常规平台任务不得：

- 在临时上游 checkout 中实现产品修改、创建提交、分支或 PR；
- 从构建缓存推送上游；
- 绕过源码契约跟随 branch/tag；
- 把平台生成配置写入源码 checkout。

集成行为应改在 Python adapter、Runtime 或平台生成配置。知识库是平台自有实现，不从研究用第三方 checkout 复制源码或引入其运行依赖。确实必须修改其它上游时，先取得目标 fork、branch 和发布方式的明确授权。

## 源码边界

- Python 需要 3.11+，四空格缩进，函数/模块使用 `snake_case`，类型提示用于说明接口。
- Runtime 使用严格 TypeScript 和 Node 22.19+；模型、工具、审批、session、进程和委派逻辑归 `agent-runtime/src`。
- Manager 使用 Go；唯一生产命令是 `manager/cmd/agent-platform-manager`，公网 Gateway、Docker 编排、operation journal、release 校验、自更新/恢复和宿主执行归 `manager/`，业务容器不得复制这些职责。生产树不保留一次性部署转换或部署签名命令与包。
- 前端使用 React + TypeScript；组件按 chat、shell、admin、preview、memory、skills 等领域组织。
- Platform 的 Python 构建阶段只接收 `pyproject.toml`、包说明和 `enterprise_agent_platform/`；Runtime、Camoufox、前端源码及测试不得进入该阶段。容器内的前端独立构建后只把生成的 `static/` 覆盖进 Platform wheel。
- `enterprise_agent_platform/static/` 是忽略的生成资源，禁止手改或提交；本地前端构建可随时完整重建它。
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

面向最终用户的 Agent 使用当前部署配置的 Agent 显示名称；未配置时自称 `Agent`，不提 Pi、Runtime、模型供应商、源码维护方或内部实现。品牌名称只能作为经过校验的结构化展示数据进入 prompt，不能被解释成指令。私人和频道 prompt 都要包含可用的用户姓名、职位和说话人上下文。

记忆、知识、网页、session 和 skill 文件作为不可信数据注入。Prompt 变更不得降低工具积极性、审批约束或所有权边界；相关设计见 [Agent Runtime](../design/agent-runtime.md)。

## Git 变更

提交主题使用简短祈使句，可带范围，例如 `runtime: ...`、`frontend: ...`、`docs: ...`。一个可交付变更集应同时包含规范、实现、测试和必要生成产物，避免文档与代码跨提交长期漂移。代码域允许多重匹配；修改跨域文件时必须同步每个声明域，并由评审补充路径映射无法识别的真实语义域。

开始实现时记录预期交付物、非目标、受影响域与大致变更规模。若实际受影响域或文件数超出预估两倍，或任务从组件变更演变为新协议、新迁移层或发布架构改造，必须在继续扩大变更前重新报告范围。发现的无关缺陷记入后续项，除非它直接阻断本交付物，不在当前变更中顺手扩展。

`main` 的每次 push 都会触发完整 Quality、不可变容器构建和通道提升，因此只推送已完成、已通过本地全量门禁的垂直交付单元。调试提交、只有文档或只有实现的中间检查点可保留在本地分支，交付前收敛为一个可回滚单元；不得为获取 CI 反馈而连续向自动发布分支推送试错提交。

不可变容器 release 同时发布 Manager 架构工件、精确 manifest、Compose、安装器、校验文件和全部镜像 digest。最终 publish job 在 `container-channel-main` 全局锁内复验成功 Quality、Git 祖先关系、资产封印、Actions provenance、tag identity 与匿名镜像可达性后，原子推进 latest。其它 workflow 不得修改 release visibility 或 latest；发布链没有迁移 stage、固定部署前任或人工回执分支。

最终 publish job 直接以排序后的闭世界目录绑定每个 release asset 的精确名称、SHA-256 和字节数，并经 GitHub API 重证本次 workflow run/attempt、实际 source commit、成功 Quality run/attempt、release ID、asset ID/digest/size 与 lightweight tag。重复发布同一 source commit 时必须逐项比较本地、重新下载字节和 API identity，禁止 `--clobber`、重名、未知资产或上传后漂移。main 通道提升前后都以匿名 registry 请求复验 manifest 中全部受管镜像 digest，并复读 release ID、tag、target commit、draft/latest 和资产 identity；任一公开前漂移都不得公开，公开后镜像后验失败必须明确报告为已可见事故。安装器只使用同一 release 中经过 SHA-256 验证的 Manager 工件和清单；Manager 更新不得下载并执行网络脚本。该边界不需要第二个 promotion workflow、自定义 provenance 文件或部署机回执。

提交前检查：

- `git status --short` 中没有意外运行数据或生成源码；
- 文档映射和相对链接通过；
- 相关 component test/check/build 通过；
- 前端变化已通过 static 重新生成验证，且产物没有进入 Git；
- 管理器、Compose 或 Dockerfile 变化已通过空数据启动和更新/回滚 smoke test；
- 配置、secret 和数据迁移变化已在文档明确说明。
