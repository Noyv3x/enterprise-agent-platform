# 测试与验证

本页定义最低证据，不复制各设计契约。静态／单元通过不得报告成真实模型、浏览器、服务或发布通过。


## 顶层检查

仓库根：

```sh
./scripts/test.sh affected  # 迭代
./scripts/test.sh full      # 交付／push 前
```

两者先跑一次当前树 check。affected 合并 staged／unstaged／untracked，禁用 rename 合并、保留两端及暂存后还原的路径；Git 错误失败。共享契约、脚本、容器、安装器、workflow、选择器及未知路径选 full，无豁免。

| 门 | 必需证据 |
| --- | --- |
| full | 并行 scripts、Manager、全部 Python 分片、Runtime、Camoufox、前端、完整 container smoke；缺 Docker Compose 失败，渲染不代 smoke |
| Quality | Documentation 当前树 check；container-definitions 跑 scripts 一次再 smoke；Manager 全量 -count=1 一次；Python 3.11 聚合门仅全片成功才通过 |
| release | 同候选双架构匿名镜像／容量、真实 Compose／user-systemd、资产／通道；不由 full 代证 |

[test.sh](../../scripts/test.sh)／[Quality](../../.github/workflows/quality.yml)：scripts 只顶层一次，smoke 不嵌套；Python 四片确定性、互斥完整、不空，全跑 0–3、compileall 一次，失败／取消／未完成均失败。每组严格失败退出，计时 trap 不覆盖退出码；温热目标 affected 3／full 10 分钟，回归不靠扩超时。

Node 只在 lock 摘要匹配且 node_modules 存在时复用，npm ci 成功才存摘要；CI／无缓存干净安装，Quality high 审计、最小 lock diff。Go 缓存绑定 go.sum、不代执行；发布 binary job 只交叉编译／校验和，不重跑 suite。

## 风险矩阵

沿用 Go、unittest、Node runner、Vitest／Testing Library。按影响域和风险验证可观察的成功、拒绝、恢复及竞态行为；涉及竞争的状态转换覆盖两种顺序。使用临时数据、确定性 fake、可控时钟和同步点，不靠睡眠、放宽超时、删断言或生产回退掩盖失败。

| 风险 | 最低负例／不变量 |
| --- | --- |
| 行为 | 真实内容／副作用、预算、硬责任／软恢复、部分结果；不钉文案／内部结构／生产默认值 |
| 授权 | 未登录／停用／撤权、Cookie 缺 Origin/Referer／跨源、未批／伪造 approval／无人值守绕过、内网／回环／云元数据及重定向 |
| 身份 | owner/account/scope/provider/Run/tool/browser/lifecycle 注入，旧身份／迟到结果不污染继任者 |
| 竞态 | 授权／提交、领取／终态、reset／分页、admission／cleanup 两序；无锁反转，取消仍隔离迟到结果／释放容量 |
| 恢复 | phase／commit／ack 幂等，未知不伪成功／重放；保留引用／审计，独立清理域不互相跳过 |
| 文件系统 | traversal、软／硬链接、owner/type/mode、inode／父目录置换、受保护目录／Docker socket、超限；拒绝先于写入，失败字节不变 |
| UI | 真实 Store／typed action／Provider，输入／权限／内容隔离／焦点／媒体偏好；jsdom 不代原生浏览器 |
| 集成 | 协议／超时／限额／降级恢复；隔离真实网络／凭据，不伪健康 |

## Manager 与容器

在 `manager/`：

```sh
go test -count=1 ./...
go vet ./...
go build -buildvcs=false ./cmd/agent-platform-manager
```

dispatcher 可缓存测试，Quality 用 -count=1；候选 API 切换另需 `go test -race -count=1 ./cmd/agent-platform-manager ./internal/control`，full 未含 race。

场景：[control](../../manager/internal/control/)／[selfupdate](../../manager/internal/selfupdate/) 的身份、socket／锁、check 缓存及恢复；[原子清理](../../manager/internal/atomicfile/cleanup_test.go)须真实进程 rename 前退出；[裁剪](../../manager/internal/journal/terminal_cleanup_test.go)测引用／inode／fsync／审计。合法 fixture 用 releasetest builder，decoder 坏输入不修正。

根目录 `./scripts/container-smoke.sh` 隔离 .env、不可变占位镜像／临时挂载、不连产品容器。Platform stub 真实监听 socket、验 token、完整能力键（空 null）；fresh workspace 由正确所有者创建。

## Python 平台

在 `enterprise-agent-platform/`：

```sh
python3 -m unittest discover -s tests
python3 -m compileall enterprise_agent_platform tests
```

根目录 `python3 scripts/python_test_shard.py --shard-index 0 --shard-count 4 --list` 只列一片，去 --list 只跑该片。

[用例入口](../../enterprise-agent-platform/tests/)：schedules、learning_review／skills、db／platform_storage_safety、computer_previews／attachment_previews（文件均为 test_*.py）。手动领取隔离自动调度、保留真实 dispatcher；学习预算／授权／终态按风险矩阵验证。SQLite 正文／commit 异常后连接仍可复用，启动拒绝先于写入；预览测 workspace-only／禁 host、隔离／上限、Office/PDF 及 PPTX 页序。

## Agent Runtime

在 `enterprise-agent-platform/agent-runtime/`：

```sh
npm ci
npm run check
npm run build
npm run test:compiled
```

build 清空 dist；一轮只编译一次再串行 test:compiled，不追加 npm test 重编译／分类 suite。包含 [MCP stdio](../../containers/agent-sandbox-mcp-client.test.mjs)：隔离、协议、审批、脱敏限额、不可信结果、fd 固定到启动，持久记录不泄露可逆请求／原始结果。

[用例入口](../../enterprise-agent-platform/agent-runtime/test/)（均为 .test.ts）：

| 场景 | 文件 |
| --- | --- |
| 硬责任与有界软恢复，needs_review 内容／error、禁 MEDIA／完成通知、ephemeral 不持久／重放 | run-coordinator、todo-run-guard、scheduled-run-decision |
| task/service、wait、恢复／ack、review／取消、精确 cleanup fence | background-task-guard、background-task-store、managed-execution |
| journal mutation、压缩失败原字节、去敏／计量／archive 限额 | session-store、repeated-compaction、request-context-usage |
| 父子责任／预算／取消、动态上下文与稳定缓存 | concurrency、prompt-cache-key、prompt-assembly |

deterministic stream 和完整 reconcile/ack 的 ExecutionManager fake 不代真实模型 eval。时间取 canonical helper；活动／idle、轮次限额和容量释放用可控同步、容量一的后续 Run 证明，不看 runner 延迟。临时 session ENOTEMPTY 有界重试耗尽仍失败。

## 前端

在 `enterprise-agent-platform/frontend/`：

```sh
npm ci
npm run check
npm test
npm run build
```

生产主题／品牌／i18n、真实 Store／typed action，最多两 worker，非动效走 reduced-motion。前置文本可粘贴，键盘／IME／发送逐键交互。用组件库语义 API，不用 selector mock、CSS／类名／固定像素／结构断言。

入口：[chatActions](../../enterprise-agent-platform/frontend/src/data/chatActions.test.ts)、[preview](../../enterprise-agent-platform/frontend/src/components/preview/)、[overlay](../../enterprise-agent-platform/frontend/src/components/admin/admin-layout.test.tsx)。分别维护身份／发送／历史、真实 draft／租约、Escape／焦点／草稿场景；品牌／通知走正式 Store action。

真实浏览器按[前端契约](../design/frontend.md)覆盖登录／导航／对话／能力／设置／全部管理资源，桌面／手机、浅／深色、加载／空／错误／可用；缺真实能力须说明。必须实看：

- 长对话离底、短窗、长输入／代码／表格、动态视口／等效缩放：浮动 PiP／跳转零 flow 高度、无白条／透明滚轮遮挡，展开恒右侧 50vw、聊天可用。
- 单消费者、缩放不重挂载／抢租约，收起／scope／发送前释放和焦点恢复；真实时序／内容，HTML 完成后挂载且无同源能力。
- 原生 inert、键盘／子控件先 Escape／过渡；动态媒体偏好保留输入／展开／焦点；scroll 先于 resize 不丢阅读意图／增未读。

[static](../../enterprise-agent-platform/frontend/scripts/build-static.test.mjs)测 identity/gzip/Brotli 原子发布、旧依赖／陈旧资产含 Logo、preload／慢链路；忽略产物也须构建／验可重现，生产重复构建后打包。Camoufox 自目录 `npm ci && npm test`，不属 Runtime suite。

## 部署与冒烟

高风险 Manager、容器、Runtime packaging／static 变更须临时数据根真实安装／更新。VM、Compose、user-systemd 分别留证，静态 smoke／QEMU 构建不能冒充 VM 安装。真实入口：[container-release](../../.github/workflows/container-release.yml)。

### 安装、恢复与真实服务

| 证据 | 必测场景 |
| --- | --- |
| 安装 | fresh／stdin --yes、同摘要直接 Current；preflight 精确清理／原路径重试；恶意 HOME/XDG、runtime 根拒绝 |
| 迁移 | [唯一例外](../reference/data-layout.md#受控迁移)的危险残留、shadow Python/sitecustomize、半转换重试、真实降权／空 capability、任意 root 命令拒绝；fresh/current 无兼容副作用，Docker 前安全建 attachments |
| 就绪 | Manager active/enabled、无未完成更新；Platform／Runtime／公共 health、bearer/models、登录／消息／SSE／附件／搜索、同 generation 多端撤回 |
| 恢复 | 排空／维护、所有持久 phase、迁移／外键失败、Current/Previous 快照与 SQLite/journal 一致；registry 无进展、ENOSPC、核心 readiness、响应丢失，能力降级后恢复；预拉取不占栈锁，Sandbox 保 workspace、保护／过期对象清理 |
| Firecrawl | 真实 Compose 冷启动写 PostgreSQL 哨兵、保留 bind 重建：新容器 ID、精确读回、liveness／真实 scrape；create／一次空库不算 |
| SearXNG | 真实 Mounts 的受管只读 config bind、无匿名 volume |
| 浏览器／Sandbox | [control smoke](../../scripts/browser-control-compose-smoke.py)：真实 Platform 登录／同源 Gateway、临时 core 页，acquire→原子拖拽→text/key/wheel→CSS-pixel screenshot/snapshot→release；不重放、finally 抬键、Agent 租约冲突／恢复；固定依赖离线生成可打开 Office/PDF 并真实附件交付，验证 MCP；凭据不入 argv／输出 |

Firecrawl 用同一 Manager 启动方式：`docker compose -f containers/compose.yaml up --detach --wait --wait-timeout 600 firecrawl-api`。

user-systemd 需 user manager／linger、正确 XDG_RUNTIME_DIR／DBUS_SESSION_BUS_ADDRESS，先证明 systemd-run --user 可用、无产品 watchdog。在 `manager/`：

```sh
AGENT_PLATFORM_SYSTEMD_INTEGRATION=1 go test -count=1 -v -run '^Test(RecoverySystemdQuiescenceIntegration|OrdinarySystemdActivationRestartIntegration)$' ./internal/selfupdate
```

启用后缺前提失败。观察独立 watchdog restart --no-block、候选 inode／ack／commit、失败回滚、主 unit 停止不杀 watchdog、单次重启／精确清瞬态 unit；ExecStart argv／WorkingDirectory 转义分测。

### 发布资格、资产与通道

以[完整发布协议](../operations/auto-update.md#发布通道)为验收表，不另复制准入规则：

- [eligibility](../../scripts/tests/test_release_eligibility.py)用真实 Git 覆盖累计差异、产品后追加说明、白名单／空差异、增删／rename／模式／类型／歧义／未知路径、坏历史／身份；缺有效公开基线失败，无首发回退，手工 force 仍验身份，noop 无发布物／latest 副作用，Quality 完整。
- [governance](../../scripts/tests/test_governance.py)注入缺／混 artifact family、通配／跨 run、错误 tag／资产／Quality／字节／digest；下载后、公开紧前再验，公开后失败报告已可见事故；重试／合法重跑不放宽身份。
- 默认 head／候选、手工 HEAD、in_progress 分开；三个线性后代证明乱序不降级、最新产品收敛、说明后代不动 latest、分叉拒绝、候选锁不代 channel 锁。GHCR 三次内恢复／耗尽失败、不扩权限。
- 真 assembler→fresh installer 测正负时区转 UTC Z；无时区、坏日期／偏移、非 RFC3339 拒绝。

### 静态边界与隔离清理

按 job 查权限／依赖／锁／artifact 来源与实际入口，静态不代执行。测试 canonical 上游输入、构建排除本地 static／开发产物、generation 仅最后文件系统指令后作 label、Camoufox 禁整树跨阶段复制、bind 不遮入口／脚本／配置根、容量与镜像键精确相等。

先移容器，再受控提权仅删 RUNNER_TEMP 下 mktemp 的固定产品前缀单树；拒绝无约束路径，异 UID 挂载不普通递归删，失败不吞。镜像只删刚观察的精确 ID，漂移／缺失／Docker 不可读失败关闭，禁 prune。部署 deadline 不借 Runtime 策略；生产恢复遵守[部署](../operations/deployment.md)。

## 文档同步检查

命令归[文档工作流](documentation-workflow.md)，顶层／CI 只查一次当前树。回归驱动全部语言消费者，拒绝缺／旧目标、不安全／可执行路径、未知字段、非法边界、无消费者，不锁生产值／owner 清单／措辞。锚点／语义人工审查；安全检查不依赖可选搜索工具。
