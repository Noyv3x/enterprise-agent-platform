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
| runtime | `enterprise-agent-platform/agent-runtime/` | `npm ci && npm run check && npm run build && npm test` |
| camofox | `enterprise-agent-platform/camofox-runtime/` | `npm ci && npm test` |
| frontend | `enterprise-agent-platform/frontend/` | `npm ci && npm run check && npm test && npm run build` |
| containers | 仓库根目录 | `scripts/container-smoke.sh` |

可用 `PYTHON_BIN` 指定本地 Python。缺少 Docker Compose 时容器检查失败，不跳过。Quality CI 只检查一次文档、一次完整 Python unittest 和 compileall；Manager 使用 `go test -count=1 ./...`，Node 依赖保留高危级别审计。

## Manager M1

Manager 简化版只接受五镜像清单：`platform`、`agent-runtime`、`camofox`、`agent-sandbox`、`searxng`。回归须覆盖完整五镜像集合的接受，十镜像、未知镜像和不完整集合的拒绝，严格 schema 2 / protocol 2 解码、发布物传输和哈希验证，以及更新前沙箱预拉取和当前/上一代、运行沙箱镜像的精确 ID 保留。清单校验不依赖容量估算表；不再接受旧十镜像版本用于回滚。

在 `manager/` 执行 `go test -count=1 ./...`、`go vet ./...`、`go build -buildvcs=false ./cmd/agent-platform-manager`；沙箱测试必须观察 `docker create` 的 agent/chat 限额、chat 的 `--network none` 和无附件挂载，验证省略 profile 的旧请求及已绑定 profile 的漂移拒绝。安装器与发布目录检查执行根目录的 `scripts/container-smoke.sh`。真实生产二进制到 M1 的用户级 systemd 更新不能由单元测试代替，命令见下文。

## Agent Runtime

一轮只 build 一次，再运行 `npm test`（直接执行编译后的 node:test）。覆盖 Pi 会话、迁移、取消、工具执行隔离与持久化；确定性的模型流不能代替真实模型验证。容器内 MCP 的协议和安全测试也属于 Runtime 检查。

## 前端

运行上表命令；静态输出使用普通 Vite build，服务目录布局不变，可附加预压缩。组件测试沿用真实 Store、主题和 i18n，通过语义查询验证行为，不固定 CSS 或 DOM 形状。

按[前端设计](../design/frontend.md)在真实浏览器验证登录、导航、对话、电脑、设置和管理页，以及桌面/手机、浅色/深色、加载/空/错误/正常状态。确认长内容滚动、焦点和 Escape、媒体偏好，以及画面的独占读取和接管释放；迟到的结果不得污染继任身份。没有真实模型或服务时明确列出未验证的能力。

## 部署与冒烟

本地容器冒烟使用临时数据，不连接产品容器；不能代替[发布工作流](../../.github/workflows/container-release.yml)的真实 Compose、双架构镜像和用户级 systemd 验证。高风险安装、更新或打包变更需要一次真实安装或更新：

- 全新安装、同版本重复操作、预检拒绝、失败清理和原路径重试。
- 登录、消息、SSE、附件、搜索、浏览器接管与释放、沙箱与 MCP，以及凭据不泄漏。
- 更新维护门、迁移和快照、候选确认、失败回滚；超时或响应丢失不得造成不安全重放。
- 清理只删除受控临时目录和已确认的精确镜像 ID，不能使用 prune 或忽略清理失败。

### 发布检查

`scripts/container-smoke.sh` 负责隔离的安装器和 Compose 配置检查，不固定 Dockerfile 层顺序、工作流文本或页面标题。真实发布栈只有一个入口：`scripts/release-compose-smoke.sh`。在仓库根目录运行，先准备本次构建的 `artifacts/managed-images.json`（五个摘要固定的镜像：platform、agent-runtime、camofox、agent-sandbox、searxng），并设置 `RUNNER_TEMP`、`GITHUB_RUN_ID`、`GITHUB_RUN_ATTEMPT`、`GITHUB_WORKSPACE`；需要 Docker、Compose、免密 sudo 和脚本调用的标准工具。此版本要求先安装兼容五键与十键目录的 Manager M1。

真实脚本检查冷启动、Platform 健康与登录、Runtime 健康、浏览器控制路径和沙箱执行。它使用临时状态和本地绑定，不访问产品数据，不启动 Firecrawl，也不用假模型响应冒充端到端 agent 验证。CI 没有模型凭据时不能证明聊天、工具选择、上下文迁移后的回忆、压缩或缓存命中；发布前必须用生产数据副本和真实模型另行演练个人 AI、频道、标准聊天、网页搜索与抓取、浏览器、计划和 MCP。仅通过本地配置检查不能宣称真实服务或双架构发布已通过。

CI 在 Manager 外部控制边界使用小型 Unix socket 测试替身：0600 socket、真实 token 校验，仅响应只读的 `/v1/status` 和 `/v1/config`，让 Platform 执行正常的启动恢复。它不提供 executor 或更新操作，不证明真实 Manager 的维护门恢复、沙箱生命周期或升级流程；这些仍需真实 Manager 的独立验证。

浏览器冒烟访问公开的 `https://example.com/` 并点击进入 IANA，依赖外网可达和页面链接结构；不通过核心网络上的测试页面绕过浏览器导航策略。公开页面或网络故障应作为冒烟失败报告，不替换为模拟浏览器结果。

每个同仓库 main push 直接启动发布工作流：完整的可复用 Quality 检查与 prepare → 镜像/Manager 构建 → smoke 并行；publish 必须等待全部 Quality、上游校验、双架构镜像验证和 Manager 构建、镜像目录、匿名验证、Core Compose 冒烟与用户级 systemd 激活检查成功。PR 和手动 Quality 运行只做质量检查，不启动发布。每次均执行全部质量检查和冒烟；四个构建镜像按完整输入指纹复用上一已发布 main 版本的精确摘要，Manager 始终按本次提交构建。新构建镜像匿名完整拉取，复用镜像匿名检查双架构清单和压缩容量；SearXNG 的检查不变。Quality 完成前上传的提交标签镜像不是已授权的发布。指纹规则、强制重建方法、发布资产兼容性、公开验证及 latest 的祖先顺序约束见[发布通道](../operations/auto-update.md#发布通道)。

沙箱镜像使用摘要固定的 Node 基础镜像、Debian 软件包快照和固定版本的 Python 包；需要构建时复用注册表缓存，不写入每次发布变化的版本/提交标签或证明附件，只加入稳定的构建输入指纹标签。更新基础镜像或快照需要显式修改 Dockerfile。相同输入直接复用已发布摘要；首次带标签构建、真实 BuildKit/GHCR 发布及后续复用仍需 main 发布验证，本地 Compose 配置检查不能证明可重复构建。

沙箱通过同一 Debian 快照中的 `python-is-python3` 提供 `python` 命令；构建后在容器内运行 `python --version`，确认模型常用的命令可用且指向 Python 3。

本地检查命令：

```sh
bash -n scripts/container-smoke.sh scripts/release-compose-smoke.sh scripts/verify-release-images-anonymous.sh
python3 -m unittest discover -s scripts/tests
python3 -c 'import pathlib,yaml; [yaml.safe_load(p.read_text()) for p in pathlib.Path(".github/workflows").glob("*.yml")]'
actionlint .github/workflows/quality.yml .github/workflows/container-release.yml
scripts/container-smoke.sh
```

本地 YAML/actionlint 与依赖图检查只能验证工作流定义，不能证明 GitHub 的可复用工作流调度和权限、main push 的实际并行运行、Quality 失败时发布被阻止，或串行发布下的过期提交拒绝；这些需要真实 main 发布运行观察，不能由 PR 替代。真实 GitHub 发布才能证明令牌权限、GHCR 匿名摘要读取、双架构镜像、完整公开资产下载和 latest 推进；还需要当前已安装 Manager 的真实更新与回滚验证，不能用工作流源文本断言或模拟 GitHub CLI 代替。

用户级 systemd 需要可用的用户管理器、linger、`XDG_RUNTIME_DIR` 和 `DBUS_SESSION_BUS_ADDRESS`；在 `manager/` 运行：

```sh
AGENT_PLATFORM_SYSTEMD_INTEGRATION=1 go test -count=1 -v -timeout=20m -run '^(TestBridgeSystemdBinaryUpgradeIntegration|TestProductionSystemdBinaryUpgradeIntegration)$' ./internal/selfupdate
```

两项检查保留真实已安装 launcher 的失败启动回退、checkpoint 收尾和重启覆盖，并以生产 `a791405075e7bd4ea883274f5b4553bfabb5d379` 二进制通过正常 `/v1/operations` 自更新到当前 Manager，确认提交收尾、生产版本作为回退、不可变 launcher 和服务重启后选择。不再导入旧 `state.json` / `operations/` 桥接状态。使用真实用户级 systemd、真实 Manager 二进制和 Alpine 核心容器；Platform 维护门为认证夹具，不能替代真实 Platform 迁移/预约/数据回滚验收。修改 Manager 控制 API 时另运行 `go test -race -count=1 ./cmd/agent-platform-manager ./internal/control`。发布前按[发布通道](../operations/auto-update.md#发布通道)和[兼容性清单](documentation-workflow.md#发布兼容性清单)检查，不用本地门禁代替发布证据。
