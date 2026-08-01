# 测试与验证

本文定义每类变更的最低验证范围。架构与源码边界见[仓库开发指南](repository.md)。

## 顶层检查

开发反馈与交付门禁是两个明确边界，但共用同一个顶层入口：

```bash
./scripts/test.sh affected  # 迭代期：根据 HEAD 到 WORKTREE 的变更闭包选择组件
./scripts/test.sh full      # 交付前：完整本地门禁
```

`affected` 先运行文档与生成契约检查，再根据已跟踪与未跟踪变更选择 scripts、Manager、Python Platform、Agent Runtime、前端和容器定义。共享契约、发布/容器边界、无法分类路径或选择器自身变化必须自动升级为 `full`；快速通过只是迭代反馈，不能作为发布证据。`full` 在普通 Git 工作树中以 `HEAD → WORKTREE` 运行文档双向同步检查，因此未提交的代码、文档、暂存和未跟踪文件都进入验收。不得用 `HEAD → HEAD` 的空变更检查代替这一边界。

完整命令先校验文档与生成契约，再并行运行相互独立的发布脚本、Manager、Python、Agent Runtime、前端和与 CI 相同的共享容器定义门禁；Python 在本地和 CI 都复用同一确定性四分片选择器。本地 `full` 不能用一次 Compose 渲染冒充完整 `container-smoke.sh`，缺少 Docker Compose 时必须失败而不是把未执行的门禁报告为通过。同一个 Node 工作区的 lockfile 未变且已有与其摘要匹配的 `node_modules` 时，本地迭代不重复执行 `npm ci`；CI 和缓存缺失时仍从 lockfile 干净安装。Runtime 在一轮门禁中只编译一次，不得以 `check → test 内建造 → build` 连续重复编译。前端构建会同步受版本控制的静态资源；提交前必须再次确认这些生成变化已纳入变更。仓库不提供第二个顶层测试入口。

温热工作区的目标是 `affected` 在 3 分钟内给出反馈、`full` 在 10 分钟内完成；Quality CI 继续以独立 job 全量并行。顶层脚本必须输出选中组件和每组耗时；普通变更连续超出目标时，先定位回归或拆分过宽测试域，不把增大全局超时当作默认解法。

## Manager 与容器

```bash
cd manager
go test ./...
go vet ./...
go build ./cmd/agent-platform-manager
cd ..
./scripts/container-smoke.sh
```

顶层测试脚本执行 Compose 静态校验时必须自行注入不可变的占位镜像引用和临时挂载路径，并忽略开发机的 `.env`；校验不能依赖生产部署变量，也不能连接或修改正在运行的容器。发布 Compose 冒烟中的 Manager contract stub 必须返回当前 `/v1/status` 的完整能力键集合；空能力使用显式 JSON `null`，不得用字段缺失意外模拟只为精确历史边界保留的旧协议。该 stub 取代真实 Manager 执行 fresh-install 前置阶段时，还必须显式创建 owner-only `data/workspaces/`，不能依赖候选 Platform 越权补建受管根。

Manager 测试覆盖 manifest schema、HTTPS、artifact 校验和与镜像 digest 校验、operation 幂等和阶段恢复、任务等待、维护 Gateway、Unix socket 权限、Sandbox identity、host/sandbox 执行审计、数据迁移、快照与回滚。镜像拉取测试必须覆盖精确 digest 本地命中、持续进度、无进展超时、绝对上限和可重试恢复，并证明预拉取不占用固定栈锁、能力 registry 故障不阻止核心 generation 提交。发布静态测试必须证明生成清单只有当前 Schema 的精确镜像键集合，并证明锁定的上游 revision 至少包含全部现役受管服务而不要求未采用的实验服务。容器 smoke test 必须验证安装脚本可通过 stdin 配合显式 `--yes` 运行，并注入 preflight 失败确认本次创建的数据根、配置、二进制和 unit 均被清理、同一路径可重试。容器 smoke test 还必须在临时数据根验证固定服务 readiness，不能连接开发数据库；启动容器模式 Platform 前必须运行能够校验 control token 并返回规范空闲状态的 Unix-socket Manager contract stub，不能只创建一个无人监听的 socket 文件。Firecrawl 发布验证必须使用与 Manager 相同的 `docker compose up --detach --wait --wait-timeout 600 firecrawl-api` 启动 PostgreSQL、Redis、RabbitMQ、Playwright 与 API，确认没有 FoundationDB 服务、环境或挂载；随后写入发布测试专用 PostgreSQL 数据哨兵，保留同一 bind 数据、强制重建 Firecrawl 服务并精确读回哨兵，同时验证 API liveness 和真实 `/v1/scrape`。只执行 Compose `create`、只测试空数据首次启动、仅复用目录却不读回数据，或只检查镜像可拉取都不能证明 entrypoint、启动顺序、幂等初始化、预算与 bind mount 契约兼容。

跨 Manager 包复用的正向 release fixture 必须由 `manager/internal/releasetest` 从当前 canonical contract 生成并在返回前按对应技术身份严格验证；测试只能覆盖本用例关心的 generation、时间或真实 artifact 字节等语义。未知/重复字段、缺字段、错误 checksum、错误 basename 与其它 decoder 负例必须继续使用原始 JSON 或显式 struct，不能交给共享 builder 自动补全或修正。

### Bridge 历史阶段专用测试证据（非当前 Cleanup 门禁）

Bridge 阶段的 handoff 特权树测试使用真实不同 UID/GID 且部署用户不可读的 `0700` PostgreSQL/RabbitMQ 风格目录，证明 native 路径失败、只有 `container_owned_tree + byte_exact_tree` 进入注入的 `PrivilegedTreeFS`，且内容、owner/group、mode、mtime、size 和完整 inventory 在复制前后不变。负例覆盖结构化/secret/单文件滥用、未知 access class、mutable 或错误镜像引用、额外挂载/网络/拉取/能力、symlink、hardlink、FIFO/device/socket、跨 mount、路径逃逸、request/receipt/label/image 摘要篡改、取消和崩溃残留；删除测试同时证明缺少 writer lease、target fence 或 publication proof 时零删除，身份完整时只删除声明目标。

Bridge 阶段的 Manager 启动/CLI 竞态测试确定性交错 handoff、watchdog、`recover-current` 和本地 `preflight`，并验证 terminal observation、Router、helper participant、一次性能力和目标配置摘要的历史交接边界。release-transition attestation 测试另证明当时的长期 control API 没有私钥或签名路由，宿主 CLI 才能使用部署证明密钥；状态根、challenge、输出与路径竞态均按历史契约失败关闭。

上述用例只属于 Bridge 发布的隔离 orchestration/审计证据。Cleanup 与 target-baseline 的当前 Manager 源码和 `go test ./...` 不编译、不链接或运行已删除的 handoff privileged-tree、startup、Router、helper、observation lease 或 attestation 包/API；当前 source-tree gate 必须阻止这些生产路径或符号重新出现。

### 当前 Manager 与容器测试

Manager 自更新还必须在真实的 user-systemd manager 中验证，而不能只依赖 fake runner：发布门禁应实际启动独立 watchdog、由 watchdog 提交主 unit 的 `restart --no-block`、确认主进程切换到候选 inode、候选完成 acknowledgement/commit，并证明 watchdog 不随主 unit 停止、同一重启只提交一次且测试创建的瞬态 unit 被精确清理。受控恢复的主 unit/watchdog 隔离也必须使用同一真实 systemd 门禁验证；显式启用门禁后，缺少 systemd 前提或发现已有产品 watchdog 必须失败关闭，不能以跳过测试形成绿色结果。持久 unit 的回归还必须区分 systemd 命令行与普通属性语法：`ExecStart` 对 argv 逐项引用，`WorkingDirectory` 使用属性值的路径转义，不能复用会把双引号当成路径字符的命令行引用器。该门禁失败时不得发布或提升 latest channel。

Manager 启动并发测试必须覆盖：`serve.lock` 在 application 构造前取得并持有完整 serve 生命周期、第二 serve 非阻塞拒绝、全新 root 从已验证的非 group-writable state root 收紧权限后安全创建、root/lock 的 symlink/type/owner/mode 异常、fd 带 `CLOEXEC`，以及 `serve.lock → recovery.lock → plan lock` 不反转；还要证明旧服务停止释放 serve lock 后，新 recovery Manager 可在外部 recovery lock 仍繁忙时进入 identity probe。control listener 测试必须覆盖 live socket 保留、明确 `ECONNREFUSED` 的 stale socket 删除、连接超时/权限等模糊错误失败关闭、探测后 inode swap 不删除替换对象，以及旧 listener teardown 不删除继任者已绑定的新 inode。sibling bind lock 测试还必须覆盖两个并发 `Listen` 对同一 stale socket 只有一个成功、另一个在 probe/unlink 前非阻塞失败；崩溃或普通 Close 释放 flock 后同一持久 lock 可复用；symlink、hardlink、宽权限、owner/type/inode 异常和缺少 `CLOEXEC` 全部拒绝。pending Candidate 测试在 commit 前分别对 control token 的 identity 成功、status/mutation 拒绝和 executor token 拒绝，commit 后验证原子开放完整 API，并在 `-race` 下覆盖并发请求与切换。rollback-half 篡改测试逐项修改 Candidate platform-commit、version、source、SHA、verified time、managed path 与 Activation plan path，必须全部失败且不改写 state。

原子文件清理测试必须覆盖真实进程在 rename 前退出留下的 `.tmp-*` 工件，并直接验证当前 `os.CreateTemp(".tmp-*")` 的实际名称仍匹配精确清理契约。测试需证明 Manager 下次启动能在正确的域所有权下自动清理并继续枚举 recovery/operation journal，且无关目录中的新鲜残留不会制造额外启动循环。负向与竞态用例必须保留非精确名称、符号链接、目录、FIFO、异 UID、硬链接、宽限内文件、与 `lstat`/`fstat` inode 不一致的并发替换以及任何被持久引用的临时名称；这些情形必须失败关闭且不删除替换对象。测试还要确认每轮至少在成功 unlink 后 fsync 已打开的父目录，并且未持有域锁的维护不会删除新写入的临时文件。

operation journal 裁剪测试必须证明七天时间窗口与最新 `128` 条数量下限同时生效，pending/running、未 finalized、缺失有效 `completed_at` 和 active/finalize state 引用永不删除。还必须覆盖未知条目、损坏 JSON、符号链接、硬链接、owner/type/mode 不符、候选 inode 在删除前被替换以及父目录 fsync 失败；任一身份不可证明时不得删除替换对象。维护测试需证明 operation 域失败不会跳过快照、release/镜像或 Manager binary 清理，并且终态 operation 裁剪不会读取、改写或删除 recovery/activation 审计证据。

真实启动 SearXNG 后还必须检查容器 Mounts，证明 `/etc/searxng` 来自受管 config 根的只读 bind，且镜像声明没有额外生成匿名 volume；只检查 Compose 文本不足以覆盖镜像自身的 `VOLUME` 行为。

Camoufox 发布验收使用同一 Compose 中的真实 Platform/Camoufox 镜像与一个只接入临时 core network 的静态页面，不访问公网。测试必须经 Platform 登录和内部 browser Gateway 建立私人 scope/tab，再经浏览器同源控制 API 完成 `acquire → 坐标 click → text → key → wheel → frame/snapshot → release`；租约期间 Agent 变更型动作必须返回冲突，释放后必须重新可用。测试不得把管理员密码、session 或内部 bearer 放进命令参数和输出。

## Python 平台

```bash
cd enterprise-agent-platform
python3 -m unittest discover -s tests
python3 -m compileall enterprise_agent_platform tests
```

Quality 门禁把 `tests/test_*.py` 顶层测试模块作为不可拆分单元，按稳定排序确定性分配到四个并行分片；分片编号从 `0` 开始。Pull Request、`main` push 和手工触发都必须运行全部四个分片，四者的并集必须与闭世界枚举完全相等且交集为空，不能按测试方法拆分、按变更跳过模块或把空分片当作成功。可从仓库根用 `python3 scripts/python_test_shard.py --shard-index 0 --shard-count 4 --list` 查看任一分片；去掉 `--list` 会运行该分片。稳定命名的 `Python 3.11` 聚合门禁只有在全部分片成功时才成功，任一分片失败、取消或未完成都必须使聚合门禁失败。Python 字节码编译是与测试分片无关的完整源码检查，CI 只需由一个分片执行一次。

Python 测试位于 `tests/test_*.py`。新增路由、配置、数据库迁移、权限、任务恢复、自动更新或托管服务行为时，应测试成功、拒绝、重启恢复和竞态边界。

学习闭环测试必须覆盖十回合/十工具节奏、重启恢复、来源幂等、lifecycle 轮换和所有非私人/非交互排除项；复盘失败不得影响已持久回复，更新预约期间不得领取新任务。还必须注入领取和终态落盘的短暂数据库错误，证明 worker 会有界退避并继续处理，已领取任务在未落盘时仍阻塞更新。前台 `skill.load/read` 的工具轨迹测试必须证明安全 Skill id（以及 read 的安全相对路径）进入复盘 payload，同时正文、patch 内容和工具结果不进入轨迹。Gateway 测试必须用确定性并发覆盖复盘 memory 查询的“授权复验与查询同一 SQLite 快照”、复盘写入返回快照不丢失 review identity，以及普通 automatic memory 写入与账号撤权、lifecycle reset、父任务终结的线性化；延迟到达的旧请求必须失败关闭。复盘 Skill `list/load/read` 还必须覆盖“终态或撤权先发生则不触碰文件”和“读取先线性化则撤权等待”的两种顺序，并证明 ledger 独立锁不会形成 conversation→DB / DB→conversation 反向死锁。每个复盘 durable job 的二十单位共享变更预算必须覆盖 reconcile 按子动作计费、memory 失败回滚、Skill 写入持久预扣且失败可计费、memory 与 Skill 跨调用累计、任务重排/进程重启不重置和耗尽拒绝。Skill 测试必须覆盖可信 created_by、既有状态默认 user-owned、精确 patch 次数、读前写、bundled/user/pinned/archived 拒绝、agent-created bundled id/名称冲突、注入扫描、高置信凭据拒绝与认证文档/占位符放行，以及原子状态文件损坏。Runtime 测试还要证明复盘工具白名单、免批仅限完整 review context、父 session 不被写入且临时 session 终态删除，并要证明复盘的第 `17` 个模型请求在发送前被独立硬上限拒绝、工具说明与提示词都公开二十单位计费，而普通 Run 仍遵循全局模型轮次上限。

SQLite 测试使用临时数据目录，不共享开发数据库；事务测试必须覆盖正文异常与 `commit` 异常都执行 rollback，并证明同一线程连接随后仍可安全写入。Platform 启动安全回归还必须对 profile 实例锁、SQLite 主文件和已有 WAL/SHM 分别覆盖 symlink、hardlink、owner/type/link-count 异常与取锁/建立连接窗口的确定性 inode swap；断言异常发生在 PID、基线、schema 或 WAL 写入前，替换对象和外部链接 inode 保持原样。OAuth、Telegram、Cognee、Firecrawl、SearXNG、Camoufox 和 Git 操作优先使用确定性 fake；没有显式凭据和服务时，不把真实网络集成作为单元测试前提。

## Agent Runtime

```bash
cd enterprise-agent-platform/agent-runtime
npm ci
npm run check
npm test
npm run build
```

Runtime 使用 Node test runner。模型流必须使用 deterministic stream fake，覆盖正常工具循环、审批、取消、input 注入、并发、幂等、session 修复、压缩、委派、超时分类和 cleanup。

涉及 Run 空闲、模型轮次和 terminal 默认超时时，测试期望应从 [`runtime-policy.json`](../contracts/runtime-policy.json) 或生成的共享常量获取，不能在多个测试中复制生产数值。其它时间边界从对应配置 helper 获取。长任务回归必须证明持续活动不会被无进展保护误杀，同时快速无限循环会被模型轮次上限停止。前台 terminal 回归必须在事件循环延迟下仍依赖有界执行生命周期而不是定时器回调先后；清理宽限回归必须在 `maxConcurrency=1` 下用后续排队 Run 获得执行槽证明释放，不能把共享 runner 的绝对墙钟延迟当作产品语义。重复压力门禁固定执行 12 轮、最多同时运行 2 个 Node 进程，并把每个进程内部的 `--test-concurrency` 固定为 `1`；它只能以这个有界并行放大测试自身已经确定性注入的竞态，不能靠占满双核 runner 制造 event-loop 调度饥饿。每个失败 worker 的完整 Node test 输出必须在 job 失败前回放，禁止用 `/dev/null` 隐去唯一诊断证据。

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
- operation 幂等键、expected generation 和 rollback 覆盖竞态。

## 部署与冒烟

高风险 Manager、容器、Runtime packaging 或 static 发布变更还应在临时数据目录执行安装/更新冒烟，检查：

- `/healthz` 和搜索健康；
- Manager Gateway generation 切换；
- Runtime bearer 和 `/v1/models`；
- 登录、普通 API、SSE 与附件；
- 固定服务与 Agent Sandbox 启停不会遗留错误容器；
- 更新期间维护页阻断，完成后恢复。

容器构建上下文只能包含源码和明确的受管资产，必须排除本地 `build/`、`dist/`、`*.egg-info`、虚拟环境、缓存和测试产物，防止开发机旧工件被复制进生产镜像。发布测试必须检查构建上下文排除契约。

发布冒烟会故意把 Agent Sandbox 挂载根映射为与 CI runner 不同的 UID/GID。测试退出路径必须先尝试停止并移除相关容器，再以 runner 的受控提权只清理 `RUNNER_TEMP` 下由 `mktemp` 创建且带固定产品前缀的单一临时树；不能用普通 runner 身份递归删除已重映射的目录，也不能对未经前缀约束的路径执行提权删除。受控临时树清理失败仍应让发布失败，避免把残留数据掩盖为成功。

原子 release 组装只能下载经过匿名拉取、双架构容量和本地镜像身份验证后生成的单一 `verified-managed-images` 目录，以及独立的 `manager-*` 二进制 family；不得重新拼接原始 `image-*` 输出，也不得使用 `*` 下载当前 run 的全部 artifact。Compose 冒烟和最终 manifest 必须消费同一份已验证目录，不能各自维护镜像默认值。Buildx 自动生成的 `.dockerbuild` 记录属于诊断产物，不进入发布目录，也不能成为 release 下载、解压或文件冲突的额外故障面；缺少任一必需 family 时必须失败。

镜像身份与 Manager 二进制上传允许同一 workflow run 的全量重跑覆盖其同名中间 artifact。真正组装 GitHub Release 的 `publish` job 必须按 `prepare` 已解析的完整 source commit 跨 run 串行，不能使用可能指向同一提交的原始分支/ref 文本作为锁键；它只能生成并封印 draft，已公开 release 仍逐文件比较并拒绝漂移。封印测试必须覆盖除 `promotion.json` 外的精确资产名称/SHA-256/size，并对任一内容、大小、未知或重名资产漂移失败关闭；GitHub API 身份在上传后、promotion 紧邻前和切换后必须一致。每个成功 publish attempt 还要上传闭世 Actions 出处证明；测试覆盖 run id/attempt、workflow path/event/repository、Container execution head、built source commit、Quality run/attempt/workflow/head、dispatch ref/source 规则及 release/asset API identity 的任一错配，明确覆盖 default branch 已前进但合法旧 candidate、无关 run 唤醒、proof source 与上游 Quality head 不符，以及封印后、证明前中断的新 attempt 只能复验后补上自己的证明。promotion 门还要用无凭据 registry 请求覆盖候选 schema 的精确受管镜像闭集（schema 1 为十一项，schema 2 为十项）、摘要不符、私有/缺失和超时，并对 visibility 前后两次复验的缺失任一失败。同名 tag 测试覆盖不存在时 create-only 建立、精确 commit 复用、错误 commit、annotated tag 与竞争，并保证任一错配都发生在 visibility 修改前。main channel 的唯一 promotion evaluator 使用独立全局锁，测试必须证明它只选择唯一直接后继、不能跳过或重排已封印 source-owner→bridge→cleanup→target-baseline→target-baseline；发布图不再接受 source-owner 同阶段后继，也不再具有 P1 特殊目录或 `source_owner_compat` 输入。target-baseline 属于普通自动 promotion，只有 bridge 与 cleanup 必须经过签名部署回执门。回执测试还须覆盖闭世界 schema、Ed25519 公钥类型、Manager 摘要、过期时间及永久 challenge 防重放 ref。GitHub API 分页结果必须先聚合各页再做闭世界计数，不得把串联的多个 JSON 页误当单页。

Bridge B 的同一原子候选必须同时切换 canonical transition stage、组装器和 target 工件；不能先推一个仍标为 source-owner 的“发布器准备”提交。测试必须从直接前任公开 release API/资产取 source Manager、Compose 与 manifest，把它们逐字段绑定到 `namespace_handoff.source`，并证明 target binding 与 B 顶层 Manager/Compose 完全相等。真实 target Compose 仅在 `AGENT_PLATFORM_*` 环境下执行 `config` 与核心 `up`，静态及运行时都拒绝 `UBITECH_*`、source data/secret/control 根、source project/network/label 和错误 UID/GID 前缀。Platform 必须分别用 source 与 target baseline/Workspace/Camoufox marker 启动，并对混合身份失败；Runtime、Camofox 与 Sandbox 也覆盖 target health、路径、token 与 ownership。

Bridge 发布证据由仓库内可重复执行的四层门禁共同组成，不再依赖仓库外维护的十六重启 harness、资格 JSON 或独立 qualification artifact：确定性的 phase/recovery 测试覆盖每个 durable phase、journal/state 边界、listener 转交、forward-only checkpoint 与完整 rollback；真实 user-systemd 集成测试对持久 helper 和 Manager 执行 `SIGKILL`，证明进程由正确 unit/cgroup 重启且同时只有一个所有者；Compose 发布冒烟使用同一份已验证镜像目录启动 target 实栈并验证身份、持久数据与能力；唯一部署机的短生命周期宿主 CLI 最后以 deployment-level Ed25519 密钥签署 challenge-bound `source_owner_ready` 或 `target_handoff_committed` 回执，证明实际 source-owner 空闲或目标交接已提交。任一层都不能单独代替其它层，签名回执、Bridge/Cleanup 直接后继顺序、不可逆提交边界与原子回滚门保持不变。Cleanup C 的 draft 还须在 B 公开前已通过 target schema-v2 parser、target-only Compose/镜像闭集与 source 常量/命令扫描；B 未提交时它保持不可选。

source-tree gate 测试必须直接构造最小仓库树，证明 Bridge 无条件跳过，而 Cleanup/target-baseline 对每个精确生产/构建根生效，并分别拒绝 source profile 常量、旧环境变量/路径/资产名、`ENTERPRISE_`、`SOURCE_TECHNICAL_PROFILE`、`enterprise_session`、`.enterprise-platform.lock`、`release-transition`/namespace handoff 命令与 parser、helper/coordinator/transformer 路径以及生成 P1 inventory。测试还要证明只有 `_test`、`tests`、`testdata` 和 `scripts/tests/fixtures` 中的历史用户数据夹具可保留这些字面值；生产迁移文件不能获得整文件豁免，扫描根缺失、符号链接、未知文件类型和非 UTF-8 内容均失败关闭。进入产品树但没有标准文本扩展名的文件只能按精确 basename 登记为文本输入并接受同一标量扫描，不能把整个未知后缀加入宽泛 allowlist。Quality 和 Container release 必须都调用同一脚本，不能各自复制 grep 清单。

普通 target-baseline 快速 push 回归必须覆盖至少三个线性后代：release workflow 全局串行，第二个候选在前一个密封 draft 尚未公开时不得生成同前任 draft；前一个公开后必须重新读取 latest 并继续封印，promotion evaluator 最终推进到最新已通过 Quality 的 main head。多候选唯一性检查仍失败关闭，不能靠选择任意一个或人工删除 draft 解锁；Bridge/Cleanup 的 B/C 双 draft 测试保持原语义。

release 时间测试必须把 `git show --format=%cI` 形式的带偏移时间交给真实 assembler，再把其 schema-2 输出交给 fresh installer 的 manifest 解析路径，证明资产中的 `generated_at` 已规范化为 UTC `Z` 并可安装。另需覆盖正负偏移的等价 UTC 转换，以及无时区、无效日期/偏移和非 RFC 3339 输入拒绝；不得把 installer 改为接受非 canonical 输出。

发布测试必须分别覆盖三个 stage 路由：Bridge 组装 schema 1/十一镜像/helper 并从 public final source-owner 取直接前任，封印 source 可发现的 `ubitech-compose.yaml` 与 `ubitech-manager-linux-*`；Cleanup 在 B 仍为 sealed draft 时从认证的分页 release 列表按精确 `container-<B>` tag 唯一解析前任，不能使用对 draft 返回 404 的 tag-name REST endpoint；随后复验前任、组装 schema 2/十镜像且不构建 helper，只封印 `agent-platform-compose.yaml` 与 `agent-platform-manager-linux-*`，并证明此时绝不公开；target-baseline 从 public target-only latest 走普通单调 promotion并保持同一中性资产集合。Bridge 历史 manifest 只由 release orchestration 的隔离验证器消费；进入 Cleanup 产品容器的 `release-manifest.schema.json` 必须收缩为 schema/protocol 2 与精确十镜像，不能保留 schema 1、helper 或 handoff 分支。Cleanup/target-baseline 的 fresh install、普通 startup、Candidate watchdog 与 finalize recovery 都必须在没有 handoff journal 时选择编译期 target profile，且 source 配置、路径、资产 basename、环境或可执行文件名不能重新选择身份。

确定性 Bridge phase/recovery 测试必须显式枚举 canonical durable phase，并分别覆盖崩溃前后 journal/state 写入顺序、幂等重放、forward commit 与 source rollback；测试中的 fake host 只用于精确交错和失败注入，不得伪造真实 systemd 或 Compose 结论。真实 user-systemd 门必须验证 helper `SIGKILL` 后取得不同 PID、仍处于同一宿主 boot epoch、由原持久 unit 恢复且旧 writer 不再存活；真实 Compose 门负责容器、网络、挂载、数据库、Runtime、Workspace、Camoufox 与 Sandbox 的发布身份。部署回执只证明部署机在 challenge 时刻的权威状态，不能由 CI 自签，也不能被测试自报布尔值替代。

普通更新测试必须证明未物化 workspace、缺 marker/alias、旧 marker 和未知 residue 全部在副作用前失败关闭，且不存在按历史 generation、摘要或路径启用的修复能力。Bridge 数据变换测试则只消费 canonical source inventory，并逐项证明 source workspace 已符合 current marker/alias 规则后才允许 staging。

fresh installer 隔离测试必须用可控账户查询 stub 返回当前 UID/GID 的权威 home，同时把 `HOME`、`XDG_BIN_HOME`、`XDG_CONFIG_HOME` 与 `XDG_DATA_HOME` 指向不同的恶意临时目录；stable Manager、配置、user unit 和数据根只能出现在账户 home 派生路径，四个 ambient 根必须保持未创建。`XDG_RUNTIME_DIR` 另行指向 owner-only 临时目录并验证 socket 写入该目录，并至少以非私有 runtime 根证明安装副作用前失败；实现还必须拒绝非绝对、符号链接或错误 owner 的 runtime 根。

部署等待和 deadline 不写在本文，由对应部署配置与测试约束；不得误用 Agent Runtime 的空闲或 terminal 契约代替部署策略。

## 文档同步检查

受管机器契约中的生产限额以 `docs/contracts/` 下的 canonical JSON 为唯一数值真源。同步器只校验字段闭世、整数类型、正值与消费端通用安全范围，不得在校验代码或测试中复制具体生产数值作为第二真源。合法限额变更必须同步驱动所有登记的 Python、TypeScript 和 Go 生成目标；生成目标与 canonical JSON 不一致时 `check` 失败。

每次提交都应运行仓库提供的 docs 校验，验证：

- Markdown 相对链接存在；
- docs domain 与代码路径映射完整；
- 受管代码变化同时包含对应规范变化；
- 机器可读契约和消费者测试一致，生成目标是普通且不可执行的文件；
- 已弃用的根规则文件没有重新出现。

历史审计、文档索引与 ADR 等未映射为当前代码域规范的文件可以独立修改。已登记为代码域真相源的设计、参考、运维与开发文档，以及所有受管生产代码，不设绕过双向同步门禁的 docs-only/code-only 例外。
