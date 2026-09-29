# 测试与验证

静态检查和单元测试不能冒充真实模型、浏览器、服务或发布验证。使用隔离的临时数据，验证可观察的成功、拒绝、恢复和竞态；不要以放宽断言、超时或生产后备路径掩盖失败。

## 顶层检查

先安装 Python 平台依赖：`python3 -m pip install --editable ./enterprise-agent-platform`。本地需要 Python 3.11、Node 24、Go（版本见 `manager/go.mod`）和 Docker Compose。

在仓库根目录：

```sh
./scripts/test.sh          # 完整门禁，与 full 相同
./scripts/test.sh full     # 交付、push 前
./scripts/test.sh runtime  # 只检查一个组件
```

可选组件是 `docs`、`scripts`、`manager`、`python`、`runtime`、`camofox`、`frontend`、`containers`。完整门禁按顺序运行，遇到失败立即停止；组件模式不推断 Git 改动。Node 组件每次先运行 `npm ci`，没有自定义依赖缓存或 Python 分片。

| 组件 | 工作目录 | 命令 |
| --- | --- | --- |
| docs | 仓库根目录 | `python3 scripts/docs_sync.py check` |
| scripts | 仓库根目录 | `python3 -m unittest discover -s scripts/tests` |
| manager | `manager/` | `go test ./... && go vet ./... && go build -buildvcs=false ./cmd/agent-platform-manager` |
| python | `enterprise-agent-platform/` | `python3 -m unittest discover -s tests && python3 -m compileall -q enterprise_agent_platform tests` |
| runtime | `enterprise-agent-platform/agent-runtime/` | `npm ci && npm run check && npm run build && npm run test:compiled` |
| camofox | `enterprise-agent-platform/camofox-runtime/` | `npm ci && npm test` |
| frontend | `enterprise-agent-platform/frontend/` | `npm ci && npm run check && npm test && npm run build` |
| containers | 仓库根目录 | `scripts/container-smoke.sh` |

可用 `PYTHON_BIN` 指定本地 Python。缺少 Docker Compose 时容器检查失败，不跳过。Quality CI 只检查一次文档、一次完整 Python unittest 和 compileall；Manager 使用 `go test -count=1 ./...`，Node 依赖保留高危级别审计。

## Agent Runtime

一轮只 build 一次，再运行 `test:compiled`，不要追加会重新编译的 `npm test`。覆盖执行隔离、审批、取消、恢复、限额和持久化；确定性的模型流不能代替真实模型验证。容器内 MCP 的协议和安全测试也属于 Runtime 检查。

## 前端

运行上表命令；静态输出使用普通 Vite build，服务目录布局不变，可附加预压缩。组件测试沿用真实 Store、主题和 i18n，通过语义查询验证行为，不固定 CSS 或 DOM 形状。

按[前端设计](../design/frontend.md)在真实浏览器验证登录、导航、对话、电脑、设置和管理页，以及桌面/手机、浅色/深色、加载/空/错误/正常状态。确认长内容滚动、焦点和 Escape、媒体偏好，以及画面的独占读取和接管释放；迟到的结果不得污染继任身份。没有真实模型或服务时明确列出未验证的能力。

## 部署与冒烟

本地容器冒烟使用临时数据，不连接产品容器；不能代替[发布工作流](../../.github/workflows/container-release.yml)的真实 Compose、双架构镜像和用户级 systemd 验证。高风险安装、更新或打包变更需要一次真实安装或更新：

- 全新安装、同版本重复操作、预检拒绝、失败清理和原路径重试。
- 登录、消息、SSE、附件、搜索、浏览器接管与释放、沙箱与 MCP，以及凭据不泄漏。
- 更新维护门、迁移和快照、候选确认、失败回滚；超时或响应丢失不得造成不安全重放。
- Firecrawl 冷启动后写入 PostgreSQL 哨兵，保留数据目录重建，再确认新容器、精确读回和真实抓取。
- 清理只删除受控临时目录和已确认的精确镜像 ID，不能使用 prune 或忽略清理失败。

用户级 systemd 需要可用的用户管理器、linger、`XDG_RUNTIME_DIR` 和 `DBUS_SESSION_BUS_ADDRESS`；在 `manager/` 运行：

```sh
AGENT_PLATFORM_SYSTEMD_INTEGRATION=1 go test -count=1 -v -run '^Test(RecoverySystemdQuiescenceIntegration|OrdinarySystemdActivationRestartIntegration)$' ./internal/selfupdate
```

修改 Manager 候选 API 切换时另运行 `go test -race -count=1 ./cmd/agent-platform-manager ./internal/control`。发布前按[发布通道](../operations/auto-update.md#发布通道)和[兼容性清单](documentation-workflow.md#发布兼容性清单)检查，不用本地门禁代替发布证据。
