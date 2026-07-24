# 测试与验证

本文定义每类变更的最低验证范围。架构与源码边界见[仓库开发指南](repository.md)。

## 顶层检查

从仓库根执行：

```bash
./scripts/test.sh
```

该命令先校验文档与生成契约，再运行 Manager、Python、Agent Runtime 和前端测试与构建。前端构建会同步受版本控制的静态资源；提交前必须再次确认这些生成变化已纳入变更。`./deploy.sh test` 在桥接版本中可以转发到该命令，但迁移后不再是运行管理入口。

## Manager 与容器

```bash
cd manager
go test ./...
go vet ./...
go build ./cmd/ubitech-manager
cd ..
docker compose -f containers/compose.yaml config
```

Manager 测试覆盖 manifest schema、HTTPS、artifact 校验和与镜像 digest 校验、operation 幂等和阶段恢复、任务等待、维护 Gateway、Unix socket 权限、Sandbox identity、host/sandbox 执行审计、数据迁移、快照与回滚。容器 smoke test 必须在临时数据根验证固定服务 readiness，不能连接开发数据库；启动容器模式 Platform 前必须运行能够校验 control token 并返回规范空闲状态的 Unix-socket Manager contract stub，不能只创建一个无人监听的 socket 文件。

## Python 平台

```bash
cd enterprise-agent-platform
python3 -m unittest discover -s tests
python3 -m compileall enterprise_agent_platform tests
```

Python 测试位于 `tests/test_*.py`。新增路由、配置、数据库迁移、权限、任务恢复、自动更新或托管服务行为时，应测试成功、拒绝、重启恢复和竞态边界。

SQLite 测试使用临时数据目录，不共享开发数据库。OAuth、Telegram、Cognee、Firecrawl、SearXNG、Camoufox 和 Git 操作优先使用确定性 fake；没有显式凭据和服务时，不把真实网络集成作为单元测试前提。

## Agent Runtime

```bash
cd enterprise-agent-platform/agent-runtime
npm ci
npm run check
npm test
npm run build
```

Runtime 使用 Node test runner。模型流必须使用 deterministic stream fake，覆盖正常工具循环、审批、取消、input 注入、并发、幂等、session 修复、压缩、委派、超时分类和 cleanup。

涉及 Run 空闲、模型轮次和 terminal 默认超时时，测试期望应从 [`runtime-policy.json`](../contracts/runtime-policy.json) 或生成的共享常量获取，不能在多个测试中复制生产数值。其它时间边界从对应配置 helper 获取。长任务回归必须证明持续活动不会被无进展保护误杀，同时快速无限循环会被模型轮次上限停止。

## 前端

```bash
cd enterprise-agent-platform/frontend
npm ci
npm run check
npm test
npm run build
```

前端使用 Vitest、Testing Library 和 jsdom。组件测试应尽量使用真实 Provider、真实 Store 和 typed data action；不要用 selector mock 掩盖 `useSyncExternalStore` 引用稳定性问题。

关键回归范围包括：

- 登录、401 会话失效和账号切换取消；
- 空数组/对象 selector 的稳定 snapshot；
- SSE 与轮询竞态、频道切换和迟到响应；
- 工作记录仅在工具调用时出现，最终输出时自动折叠；
- 审批、失败发送恢复和连续短消息；
- 浏览器首帧加载与终端预览可用性；
- 手机动态视口、长代码/表格和 Composer 不扩大页面；
- 三种 locale 的 key 完整性；
- 更新维护页在 Store/登录失败时仍可接管。

`npm run build` 是前端变更验证的一部分，并会更新受版本控制的静态资源。测试通过但未构建 static 仍视为未完成。

## 安全测试

涉及安全边界时至少加入负例：

- 未登录、权限不足、停用/被吊销 session；
- Cookie 写请求缺 Origin/Referer 或跨源；
- 路径 traversal、符号链接、受保护目录和 Docker socket；
- 内网/回环/云元数据 URL 与重定向；
- owner/scope/provider/browser identity 参数注入；
- 超大 body、附件、工具输出或搜索响应；
- 未审批工具、伪造 approval id、无人值守授权绕过；
- dirty tree、非 fast-forward 和 rollback 覆盖竞态。

## 部署与冒烟

高风险 Manager、容器、Runtime packaging 或 static 发布变更还应在临时数据目录执行安装/更新冒烟，检查：

- `/healthz` 和搜索健康；
- Manager Gateway generation 切换；
- Runtime bearer 和 `/v1/models`；
- 登录、普通 API、SSE 与附件；
- 固定服务与 Agent Sandbox 启停不会遗留错误容器；
- 更新期间维护页阻断，完成后恢复。

发布冒烟会故意把 Agent Sandbox 挂载根映射为与 CI runner 不同的 UID/GID。测试退出路径必须先尝试停止并移除相关容器，再以 runner 的受控提权只清理 `RUNNER_TEMP` 下由 `mktemp` 创建且带固定产品前缀的单一临时树；不能用普通 runner 身份递归删除已重映射的目录，也不能对未经前缀约束的路径执行提权删除。受控临时树清理失败仍应让发布失败，避免把残留数据掩盖为成功。

部署等待和 deadline 不写在本文，由对应部署配置与测试约束；不得误用 Agent Runtime 的空闲或 terminal 契约代替部署策略。

## 文档同步检查

每次提交都应运行仓库提供的 docs 校验，验证：

- Markdown 相对链接存在；
- docs domain 与代码路径映射完整；
- 受管代码变化同时包含对应规范变化；
- 机器可读契约和消费者测试一致，生成目标是普通且不可执行的文件；
- 已弃用的根规则文件没有重新出现。

历史审计、文档索引与 ADR 等未映射为当前代码域规范的文件可以独立修改。已登记为代码域真相源的设计、参考、运维与开发文档，以及所有受管生产代码，不设绕过双向同步门禁的 docs-only/code-only 例外。
