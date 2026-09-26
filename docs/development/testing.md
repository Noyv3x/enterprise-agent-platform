# 测试与验证

本文定义最低的证据要求，不复制各设计文档的规则。静态检查或单元测试通过，不能报告成真实的模型、浏览器、服务或发布验证通过。

## 顶层检查

在仓库根目录：

```sh
./scripts/test.sh affected  # 开发迭代时
./scripts/test.sh full      # 交付、push 之前
```

- 两种模式都会先对当前文件树运行一次文档检查。
- `affected` 合并已暂存、未暂存和未跟踪的改动；不把重命名合并处理，保留两端的路径以及暂存后又还原的路径；Git 出错就失败。
- 改动涉及共享契约、脚本、容器、安装器、工作流、选择器本身或未知路径时，自动升级为 full，没有豁免。

| 门禁 | 必须包含 |
| --- | --- |
| full | 并行运行 scripts、Manager、全部 Python 分片、Runtime、Camoufox、前端，以及完整的容器冒烟测试。缺少 Docker Compose 就失败；只渲染配置不能代替冒烟测试 |
| Quality（CI） | 当前文件树的文档检查；container-definitions 先跑一次 scripts 再做冒烟；Manager 全量以 `-count=1` 运行一次；Python 3.11 的汇总门只有全部分片成功才通过 |
| 发布 | 同一个候选的双架构匿名镜像拉取和容量检查、真实的 Compose 和用户级 systemd、资产和通道检查。不能用 full 代替 |

[test.sh](../../scripts/test.sh) 和 [Quality 工作流](../../.github/workflows/quality.yml)的约定：

- scripts 只在顶层跑一次，冒烟测试不嵌套。
- Python 分成四片，分片确定、互斥、完整且不为空；CI 跑 0–3 全部分片，compileall 只跑一次。失败、取消或未完成都算失败。
- 每组测试严格按失败退出，计时逻辑不能覆盖退出码。在缓存温热时，affected 的目标时长约 3 分钟、full 约 10 分钟；变慢时不能靠加大超时解决。
- Node 依赖只有在 lock 摘要匹配且 node_modules 存在时才复用，`npm ci` 成功后才保存摘要；CI 或无缓存时干净安装，Quality 做高危级别的审计，lock 文件的差异要尽量小。Go 缓存绑定 go.sum，但不能代替执行测试；发布的二进制任务只做交叉编译和校验和，不重跑测试。

## 风险矩阵

- 沿用现有的测试框架：Go、unittest、Node 测试运行器、Vitest 和 Testing Library。
- 按影响的领域和风险，验证可以观察到的成功、拒绝、恢复和竞态行为；涉及竞争的状态转换，两种先后顺序都要覆盖。
- 使用临时数据、确定性的替身、可控的时钟和同步点。不靠 sleep、放宽超时、删除断言或生产代码里的后备路径来掩盖失败。

| 风险 | 至少要覆盖的反例或不变量 |
| --- | --- |
| 行为 | 真实的内容和副作用、预算、硬责任和有限的软恢复、部分结果；不要把文案、内部结构或生产默认值写死在测试里 |
| 授权 | 未登录、已停用、已撤权；Cookie 缺少 Origin/Referer 或跨源；未批准或伪造的审批、绕过无人值守限制；内网、回环、云元数据地址及重定向 |
| 身份 | 注入伪造的所有者、账号、对话范围、供应商、Run、工具、浏览器或生命周期；旧身份或迟到的结果不能污染继任者 |
| 竞态 | 授权与提交、领取与终态、重置与分页、准入与清理的两种顺序；不出现锁反转；取消后仍然隔离迟到的结果并释放容量 |
| 恢复 | 阶段、提交和确认的幂等；结果未知时不能假装成功或重放；保留引用和审计；独立的清理领域不能互相跳过 |
| 文件系统 | 路径穿越、软链接和硬链接、属主/类型/权限、inode 或父目录被替换、受保护目录和 Docker socket、超限；拒绝发生在写入之前，失败时字节不变 |
| 界面 | 真实的 Store、带类型的 action 和 Provider；输入、权限、内容隔离、焦点、媒体偏好；jsdom 不能代替真实浏览器 |
| 集成 | 协议、超时、限额、降级与恢复；隔离真实网络和凭据，不能伪装健康 |

## Manager 与容器

在 `manager/`：

```sh
go test -count=1 ./...
go vet ./...
go build -buildvcs=false ./cmd/agent-platform-manager
```

- 本地运行可以使用测试缓存，Quality 使用 `-count=1`。修改候选版本的 API 切换时，另外运行 `go test -race -count=1 ./cmd/agent-platform-manager ./internal/control`；full 不包含 race 检测。
- 重点场景：
  - [control](../../manager/internal/control/) 和 [selfupdate](../../manager/internal/selfupdate/)：身份、socket 和锁、check 缓存、恢复；
  - [原子清理](../../manager/internal/atomicfile/cleanup_test.go)：必须用真实进程在重命名前退出来测试；
  - [终态清理](../../manager/internal/journal/terminal_cleanup_test.go)：引用、inode、落盘和审计。
- 合法的测试数据用 releasetest 构建器生成；解码器的坏输入测试不要去"修正"输入。
- 根目录的 `./scripts/container-smoke.sh` 使用隔离的 .env、不可变的占位镜像和临时挂载，不连接产品容器。Platform 的替身真实监听 socket、验证 token、提供完整的能力键（空值为 null）；全新的工作区由正确的属主创建。

## Python 平台

在 `enterprise-agent-platform/`：

```sh
python3 -m unittest discover -s tests
python3 -m compileall enterprise_agent_platform tests
```

- 在根目录运行 `python3 scripts/python_test_shard.py --shard-index 0 --shard-count 4 --list` 只列出一个分片的测试；去掉 `--list` 就只运行该分片。
- 主要[用例](../../enterprise-agent-platform/tests/)（都是 `test_*.py`）：schedules、learning_review 和 skills、db 和 platform_storage_safety、computer_previews 和 attachment_previews。
- 手动领取任务的测试要与自动调度隔离，并保留真实的调度器；学习的预算、授权和终态按风险矩阵验证。
- SQLite 执行或提交出错后，连接仍然可以复用；启动时的拒绝发生在任何写入之前。
- 预览测试覆盖：只能读工作区、禁止宿主机、隔离和上限、Office/PDF，以及 PPTX 的页序。

## Agent Runtime

在 `enterprise-agent-platform/agent-runtime/`：

```sh
npm ci
npm run check
npm run build
npm run test:compiled
```

- build 会清空 dist。一轮只编译一次，然后串行运行 `test:compiled`；不要再追加会重新编译的 `npm test` 或分类的测试套件。
- 包含 [MCP stdio 客户端测试](../../containers/agent-sandbox-mcp-client.test.mjs)：隔离、协议、审批、脱敏和限额、不可信结果、启动前固定文件描述符，以及持久记录中不泄露可逆请求或原始结果。

主要[用例](../../enterprise-agent-platform/agent-runtime/test/)（都是 `.test.ts`）：

| 场景 | 文件 |
| --- | --- |
| 硬责任和有限的软恢复；needs_review 的内容和错误；禁止 MEDIA 和完成通知；临时内容不持久化、不重放 | run-coordinator、todo-run-guard、scheduled-run-decision |
| task/service、wait、恢复和确认、复盘和取消、精确的清理屏障 | background-task-guard、background-task-store、managed-execution |
| 日志修改、压缩失败时保持原字节、脱敏、计量、归档限额 | session-store、repeated-compaction、request-context-usage |
| 父子责任、预算和取消；动态上下文与稳定缓存 | concurrency、prompt-cache-key、prompt-assembly |

- 确定性的模型流和实现了完整对账/确认的执行器替身，不能代替真实模型的评估。
- 时间统一使用规范的辅助函数。活动时间和空闲检测、轮次上限、容量释放，用可控的同步和"容量为一时的后续 Run"来证明，不依赖测试机器的延迟。
- 临时会话遇到 ENOTEMPTY 时有限次重试，用完后仍然失败。

## 前端

在 `enterprise-agent-platform/frontend/`：

```sh
npm ci
npm run check
npm test
npm run build
```

**组件测试**

- 使用生产的主题、品牌和 i18n，以及真实的 Store 和带类型的 action；最多两个 worker；与动效无关的测试在"减少动态效果"下运行。
- 前置文本可以直接粘贴，但键盘、输入法和发送要逐键交互。
- 使用组件库的语义 API（按角色、名称查询），不要 mock 选择器，也不要断言 CSS、类名、固定像素或 DOM 结构。
- 主要入口：[chatActions](../../enterprise-agent-platform/frontend/src/data/chatActions.test.ts)（身份、发送、历史）、[preview](../../enterprise-agent-platform/frontend/src/components/preview/)（真实草稿和租约）、[overlay](../../enterprise-agent-platform/frontend/src/components/admin/admin-layout.test.tsx)（Escape、焦点、草稿）。品牌和通知通过正式的 Store action 测试。

**真实浏览器检查**

按[前端设计](../design/frontend.md)覆盖：登录、导航、对话、电脑和各种能力、设置、全部管理页面；桌面和手机、浅色和深色；加载中、空、错误和正常状态。缺少真实能力（例如没有可用模型）时要说明。以下几项必须亲眼确认：

- 长对话离开底部、窗口很矮、长输入、长代码和表格、动态视口或等效缩放下：画中画和"回到最新"按钮不占布局高度，没有白条，透明区域不挡滚轮；展开后始终在右侧一半，聊天仍然可用。
- 同一时刻只有一个画面在读取；缩放不重新挂载或抢租约；收起、切换对话和发送前释放接管并恢复焦点；时序和内容是真实的，HTML 写完后才挂载且没有同源能力。
- 原生 inert、键盘和子控件优先处理 Escape、过渡效果；动态切换媒体偏好时保留输入、展开状态和焦点；scroll 先于 resize 时不丢失阅读意图，也不增加未读。

**构建产物**

- [静态发布测试](../../enterprise-agent-platform/frontend/scripts/build-static.test.mjs)覆盖：identity/gzip/Brotli 的原子发布、旧依赖和陈旧资产（包括 Logo）的清理、预加载和慢速链路。被 Git 忽略的产物也必须能构建并验证可重现；生产环境重复构建后再打包。
- Camoufox 在它自己的目录里运行 `npm ci && npm test`，不属于 Runtime 的测试套件。

## 部署与冒烟

- 高风险的 Manager、容器、Runtime 打包或前端静态资源变更，必须用临时数据根做一次真实的安装或更新。
- 虚拟机、Compose、用户级 systemd 的证据分别保留；静态冒烟或 QEMU 构建不能冒充虚拟机安装。真实入口是 [container-release 工作流](../../.github/workflows/container-release.yml)。

### 安装、恢复与真实服务

| 证据 | 必测场景 |
| --- | --- |
| 安装 | 全新安装和通过 stdin 传 `--yes`；相同摘要直接成为当前版本；预检失败后精确清理并可在原路径重试；恶意的 HOME/XDG 和运行时根目录被拒绝 |
| 迁移 | [唯一例外](../reference/data-layout.md#受控迁移)的危险残留、伪造的 Python 或 sitecustomize、半途转换后的重试、真实的降权和空能力集、任意 root 命令被拒绝；全新或当前版本没有兼容性副作用；在调用 Docker 前安全创建 attachments |
| 就绪 | Manager 为 active/enabled 且没有未完成的更新；Platform、Runtime 和公共入口健康；bearer 和模型列表；登录、消息、SSE、附件、搜索；同一版本下多端撤回 |
| 恢复 | 排空与维护、所有持久化阶段、迁移或外键失败、当前/上一版本的快照与 SQLite 和日志一致；镜像仓库无进展、磁盘满、核心就绪失败、响应丢失；能力降级后恢复；预拉取不占用服务栈锁；沙箱保留工作区；受保护和过期对象的清理 |
| Firecrawl | 用真实 Compose 冷启动，写入 PostgreSQL 哨兵数据，保留目录挂载后重建：新的容器 ID、精确读回、存活检查和真实的抓取。只 create 或只用一次空库不算 |
| SearXNG | 真实挂载中存在受管的只读 config 目录挂载，没有匿名卷 |
| 浏览器与沙箱 | [控制冒烟测试](../../scripts/browser-control-compose-smoke.py)：真实的 Platform 登录和同源网关、临时的核心页面，依次执行接管 → 原子拖拽 → 文本/按键/滚轮 → CSS 像素截图和快照 → 释放；不重放、finally 中松开按键、与 Agent 的租约冲突及恢复；用固定依赖离线生成可以打开的 Office/PDF 并作为真实附件交付；验证 MCP；凭据不出现在参数或输出中 |

- Firecrawl 使用与 Manager 相同的启动方式：`docker compose -f containers/compose.yaml up --detach --wait --wait-timeout 600 firecrawl-api`。

**用户级 systemd**

- 需要用户级的 systemd 管理器和 linger，以及正确的 `XDG_RUNTIME_DIR` 和 `DBUS_SESSION_BUS_ADDRESS`；先证明 `systemd-run --user` 可用，并且没有产品的看门狗在运行。在 `manager/`：

```sh
AGENT_PLATFORM_SYSTEMD_INTEGRATION=1 go test -count=1 -v -run '^Test(RecoverySystemdQuiescenceIntegration|OrdinarySystemdActivationRestartIntegration)$' ./internal/selfupdate
```

- 开启后缺少前提条件就失败。要观察到：独立的看门狗以 `restart --no-block` 重启、候选 inode 的确认和提交、失败回滚、主 unit 停止时不杀看门狗、只重启一次并精确清理临时 unit。ExecStart 参数和 WorkingDirectory 的转义单独测试。

### 发布资格、资产与通道

以[完整的发布协议](../operations/auto-update.md#发布通道)作为验收表，这里不重复准入规则：

- [发布资格测试](../../scripts/tests/test_release_eligibility.py)用真实 Git 覆盖：累计差异、产品改动之后又追加说明、白名单和空差异、增删和重命名、权限/类型变化、含义不明和未知的路径、损坏的历史和身份。缺少有效的公开基线就失败，没有首发回退；手动强制发布仍验证身份；跳过时没有发布物或 latest 的副作用；Quality 完整运行。
- [治理测试](../../scripts/tests/test_governance.py)注入：缺少或混杂的工件类别、通配或跨 run 下载、错误的 tag/资产/Quality/字节/摘要。下载后和公开紧前都要再验证；公开后失败要报告为"已可见的事故"；重试和合法的重跑不放宽身份要求。
- 默认的 head 与候选、手动的 HEAD、`in_progress` 状态分开测试。用三个线性的后代版本证明：乱序完成不会降级、最终收敛到最新的产品版本、只改说明的后代不动 latest、分叉被拒绝、候选锁不能代替通道锁。GHCR 在三次以内恢复或耗尽后失败，不扩大权限。
- 用真实的组装器加全新的安装器，测试正负时区都转换为 UTC 的 Z 格式；没有时区、日期或偏移非法、不是 RFC3339 的都拒绝。

### 静态边界与隔离清理

- 按 job 检查权限、依赖、锁、工件来源和实际入口；静态检查不能代替执行。
- 测试规范的上游输入；构建排除本地的 static 和开发产物；版本号只在最后一条文件系统指令之后作为标签；Camoufox 禁止跨阶段复制整个目录树；目录挂载不遮住入口、脚本或配置根目录；容量与镜像的键集合精确相等。
- 清理时先移除容器，再受控提权，只删除 RUNNER_TEMP 下由 mktemp 创建、带固定产品前缀的单个目录树；拒绝不受约束的路径，其它 UID 的挂载不做普通递归删除，失败不能被吞掉。
- 镜像只删除刚观察到的精确 ID；漂移、缺失或 Docker 不可读时失败关闭，禁止 prune。部署的截止时间不借用 Runtime 的策略；生产恢复遵守[部署](../operations/deployment.md)。

## 文档同步检查

- 命令见[文档工作流](documentation-workflow.md)。顶层和 CI 都只对当前文件树检查一次。
- 回归测试要驱动全部语言的生成代码，拒绝缺失或过期的目标、不安全或可执行的路径、未知字段、非法边界；不把生产值或文字措辞写死在测试里。
- 文档的语义正确性靠人工审查；安全检查不依赖可选的搜索工具。
