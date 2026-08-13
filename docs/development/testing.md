# 测试与验证

本文定义每类变更的最低验证范围。架构与源码边界见[仓库开发指南](repository.md)。

## 顶层检查

开发反馈与交付门禁是两个明确边界，但共用同一个顶层入口：

```bash
./scripts/test.sh affected  # 迭代期：根据 HEAD 到 WORKTREE 的变更闭包选择组件
./scripts/test.sh full      # 交付前：完整本地门禁
```

`affected` 先运行文档与生成契约检查，再根据已跟踪与未跟踪变更选择 scripts、Manager、Python Platform、Agent Runtime、前端和容器定义。共享契约、发布/容器边界、无法分类路径或选择器自身变化必须自动升级为 `full`；快速通过只是迭代反馈，不能作为发布证据。`full` 在普通 Git 工作树中以 `HEAD → WORKTREE` 运行文档方向同步检查，因此未提交的代码、文档、暂存和未跟踪文件都进入验收。不得用 `HEAD → HEAD` 的空变更检查代替这一边界。

完整命令先校验文档与生成契约，再并行运行相互独立的发布脚本、Manager、Python、Agent Runtime、前端和与 CI 相同的共享容器定义门禁；Python 在本地和 CI 都复用同一确定性四分片选择器。本地 `full` 不能用一次 Compose 渲染冒充完整 `container-smoke.sh`，缺少 Docker Compose 时必须失败而不是把未执行的门禁报告为通过。同一个 Node 工作区的 lockfile 未变且已有与其摘要匹配的 `node_modules` 时，本地迭代不重复执行 `npm ci`；CI 和缓存缺失时仍从 lockfile 干净安装。Node 工作区的 Quality job 还执行 high 级别依赖审计；新披露的传递依赖漏洞只通过最小 lockfile 更新修复，不能借机升级无关组件。Runtime 在一轮门禁中只编译一次，不得以 `check → test 内建造 → build` 连续重复编译。前端构建在忽略的产物目录中验证完整性、压缩与原子发布，不把可重现 bundle 写回 Git。仓库不提供第二个顶层测试入口。

温热工作区的目标是 `affected` 在 3 分钟内给出反馈、`full` 在 10 分钟内完成；Quality CI 继续以独立 job 全量并行。顶层脚本必须输出选中组件和每组耗时；普通变更连续超出目标时，先定位回归或拆分过宽测试域，不把增大全局超时当作默认解法。

每个可发布提交的 Manager 全量测试只在对应的成功 Quality run 中以 `go test -count=1 ./...` 真实执行一次。Container release 必须绑定该精确提交的成功 Quality 证据；自动入口只接受同仓库 `main` push，人工恢复入口可接受对当前 `origin/main` 精确 HEAD 显式触发的 Quality，但在发布开始和最终推进通道前都必须重新确认候选仍等于远端 HEAD。其两个 Manager 工件 job 只分别交叉编译 `linux/amd64` 与 `linux/arm64`、生成校验和并上传，不得再次运行全量测试。发布工作流在镜像构建前证明当前公开 generation 是候选提交的 Git 祖先，防止分叉或降级通道。Go 模块与构建缓存以 `manager/go.sum` 为精确依赖入口，仅用于加速且不替代测试、编译或工件校验。真实 user-systemd 集成测试仍是独立发布门禁，必须使用 `-count=1` 执行，不能由全量单元测试或缓存命中代替。

CI 中的 Python 仓库工具必须显式通过 `python3` 调用，不能依赖 Git 可执行位或 runner 的隐式命令解析；静态发布验收需要锁定这一调用形式。

原子发布使用 draft 隐藏未封印资产时，工作流必须通过认证的 release identity 取得数字 ID，再以 ID 读取 REST 元数据；不能假设公开的按 tag REST 端点能够发现 draft。静态门禁需保留这条查找链。

GHCR 登录属于发布前的外部瞬时边界。镜像构建与 Compose 发布验收统一使用仓库内固定实现的有界登录动作：同一最小权限 `GITHUB_TOKEN` 最多尝试三次并在重试间短暂退避；任一次成功后继续，全部失败则保持原子发布关闭。不得通过扩大 token 权限、忽略登录失败、无限重试或发布缺少镜像的 generation 来提高成功率。

## Manager 与容器

```bash
cd manager
go test ./...
go vet ./...
go build -buildvcs=false ./cmd/agent-platform-manager
cd ..
./scripts/container-smoke.sh
```

本地 Manager 编译关闭 Go 的 VCS stamping；发布身份由已验证的 release manifest 与镜像 label 固定，不依赖开发工作树元数据。这也保证普通工作树和 Git worktree 使用同一构建入口。

顶层测试脚本执行 Compose 静态校验时必须自行注入不可变的占位镜像引用和临时挂载路径，并忽略开发机的 `.env`；校验不能依赖生产部署变量，也不能连接或修改正在运行的容器。发布 Compose 冒烟中的 Manager contract stub 必须返回当前 `/v1/status` 的完整能力键集合；空能力使用显式 JSON `null`，不得用字段缺失意外模拟只为精确历史边界保留的旧协议。该 stub 取代真实 Manager 执行 fresh-install 前置阶段时，还必须显式创建 owner-only `data/workspaces/`，不能依赖候选 Platform 越权补建受管根。

Manager 测试覆盖 manifest schema、HTTPS、artifact 校验和与镜像 digest 校验、operation 幂等和阶段恢复、任务等待、维护 Gateway、Unix socket 权限、Sandbox identity、host/sandbox 执行审计、数据迁移、快照与回滚。镜像拉取测试必须覆盖精确 digest 本地命中、持续进度、无进展超时、绝对上限和可重试恢复，并证明预拉取不占用固定栈锁、能力 registry 故障不阻止核心 generation 提交。发布静态测试必须证明生成清单只有当前 Schema 的精确镜像键集合，并证明锁定的上游 revision 至少包含全部现役受管服务而不要求未采用的实验服务。容器 smoke test 必须验证安装脚本可通过 stdin 配合显式 `--yes` 运行，并注入 preflight 失败确认本次创建的数据根、配置、二进制和 unit 均被清理、同一路径可重试。容器 smoke test 还必须在临时数据根验证固定服务 readiness，不能连接开发数据库；启动容器模式 Platform 前必须运行能够校验 control token 并返回规范空闲状态的 Unix-socket Manager contract stub，不能只创建一个无人监听的 socket 文件。Firecrawl 发布验证必须使用与 Manager 相同的 `docker compose up --detach --wait --wait-timeout 600 firecrawl-api` 启动 PostgreSQL、Redis、RabbitMQ、Playwright 与 API，确认没有 FoundationDB 服务、环境或挂载；随后写入发布测试专用 PostgreSQL 数据哨兵，保留同一 bind 数据、强制重建 Firecrawl 服务并精确读回哨兵，同时验证 API liveness 和真实 `/v1/scrape`。只执行 Compose `create`、只测试空数据首次启动、仅复用目录却不读回数据，或只检查镜像可拉取都不能证明 entrypoint、启动顺序、幂等初始化、预算与 bind mount 契约兼容。

跨 Manager 包复用的正向 release fixture 必须由 `manager/internal/releasetest` 从当前 canonical contract 生成并在返回前按对应技术身份严格验证；测试只能覆盖本用例关心的 generation、时间或真实 artifact 字节等语义。未知/重复字段、缺字段、错误 checksum、错误 basename 与其它 decoder 负例必须继续使用原始 JSON 或显式 struct，不能交给共享 builder 自动补全或修正。

### Manager 与容器测试

Manager 自更新还必须在真实的 user-systemd manager 中验证，而不能只依赖 fake runner：发布门禁应实际启动独立 watchdog、由 watchdog 提交主 unit 的 `restart --no-block`、确认主进程切换到候选 inode、候选完成 acknowledgement/commit，并证明 watchdog 不随主 unit 停止、同一重启只提交一次且测试创建的瞬态 unit 被精确清理。受控恢复的主 unit/watchdog 隔离也必须使用同一真实 systemd 门禁验证；显式启用门禁后，缺少 systemd 前提或发现已有产品 watchdog 必须失败关闭，不能以跳过测试形成绿色结果。持久 unit 的回归还必须区分 systemd 命令行与普通属性语法：`ExecStart` 对 argv 逐项引用，`WorkingDirectory` 使用属性值的路径转义，不能复用会把双引号当成路径字符的命令行引用器。该门禁失败时不得发布或提升 latest channel。

Manager 启动并发测试必须覆盖：`serve.lock` 在 application 构造前取得并持有完整 serve 生命周期、第二 serve 非阻塞拒绝、全新 root 从已验证的非 group-writable state root 收紧权限后安全创建、root/lock 的 symlink/type/owner/mode 异常、fd 带 `CLOEXEC`，以及 `serve.lock → recovery.lock → plan lock` 不反转；还要证明旧服务停止释放 serve lock 后，新 recovery Manager 可在外部 recovery lock 仍繁忙时进入 identity probe。control listener 测试必须覆盖 live socket 保留、明确 `ECONNREFUSED` 的 stale socket 删除、连接超时/权限等模糊错误失败关闭、探测后 inode swap 不删除替换对象，以及旧 listener teardown 不删除继任者已绑定的新 inode。sibling bind lock 测试还必须覆盖两个并发 `Listen` 对同一 stale socket 只有一个成功、另一个在 probe/unlink 前非阻塞失败；崩溃或普通 Close 释放 flock 后同一持久 lock 可复用；symlink、hardlink、宽权限、owner/type/inode 异常和缺少 `CLOEXEC` 全部拒绝。pending Candidate 测试在 commit 前分别对 control token 的 identity 成功、status/mutation 拒绝和 executor token 拒绝，commit 后验证原子开放完整 API，并在 `-race` 下覆盖并发请求与切换。rollback-half 篡改测试逐项修改 Candidate platform-commit、version、source、SHA、verified time、managed path 与 Activation plan path，必须全部失败且不改写 state。

原子文件清理测试必须覆盖真实进程在 rename 前退出留下的 `.tmp-*` 工件，并直接验证当前 `os.CreateTemp(".tmp-*")` 的实际名称仍匹配精确清理契约。测试需证明 Manager 下次启动能在正确的域所有权下自动清理并继续枚举 recovery/operation journal，且无关目录中的新鲜残留不会制造额外启动循环。负向与竞态用例必须保留非精确名称、符号链接、目录、FIFO、异 UID、硬链接、宽限内文件、与 `lstat`/`fstat` inode 不一致的并发替换以及任何被持久引用的临时名称；这些情形必须失败关闭且不删除替换对象。测试还要确认每轮至少在成功 unlink 后 fsync 已打开的父目录，并且未持有域锁的维护不会删除新写入的临时文件。

operation journal 裁剪测试必须证明七天时间窗口与最新 `128` 条数量下限同时生效，pending/running、未 finalized、缺失有效 `completed_at` 和 active/finalize state 引用永不删除。还必须覆盖未知条目、损坏 JSON、符号链接、硬链接、owner/type/mode 不符、候选 inode 在删除前被替换以及父目录 fsync 失败；任一身份不可证明时不得删除替换对象。维护测试需证明 operation 域失败不会跳过快照、release/镜像或 Manager binary 清理，并且终态 operation 裁剪不会读取、改写或删除 recovery/activation 审计证据。

真实启动 SearXNG 后还必须检查容器 Mounts，证明 `/etc/searxng` 来自受管 config 根的只读 bind，且镜像声明没有额外生成匿名 volume；只检查 Compose 文本不足以覆盖镜像自身的 `VOLUME` 行为。

Camoufox 发布验收使用同一 Compose 中的真实 Platform/Camoufox 镜像与一个只接入临时 core network 的静态页面，不访问公网。测试必须经 Platform 登录和内部 browser Gateway 建立私人 scope/tab，再经浏览器同源控制 API 完成 `acquire → 真实滑块拖拽 → text → key → wheel → 交互帧/snapshot → release`，并验证成功轨迹已经抬键、重复 sequence 不重放、租约期间 Agent 变更型动作返回冲突以及释放后重新可用；独立补丁契约测试还必须确认异常路径由 `finally` 执行 `mouse.up`。测试不得把管理员密码、session 或内部 bearer 放进命令参数和输出。

## Python 平台

```bash
cd enterprise-agent-platform
python3 -m unittest discover -s tests
python3 -m compileall enterprise_agent_platform tests
```

Quality 门禁把 `tests/test_*.py` 顶层测试模块作为不可拆分单元，按稳定排序确定性分配到四个并行分片；分片编号从 `0` 开始。Pull Request、`main` push 和手工触发都必须运行全部四个分片，四者的并集必须与闭世界枚举完全相等且交集为空，不能按测试方法拆分、按变更跳过模块或把空分片当作成功。可从仓库根用 `python3 scripts/python_test_shard.py --shard-index 0 --shard-count 4 --list` 查看任一分片；去掉 `--list` 会运行该分片。稳定命名的 `Python 3.11` 聚合门禁只有在全部分片成功时才成功，任一分片失败、取消或未完成都必须使聚合门禁失败。Python 字节码编译是与测试分片无关的完整源码检查，CI 只需由一个分片执行一次。

Python 测试位于 `tests/test_*.py`。新增路由、配置、数据库迁移、权限、任务恢复、自动更新或托管服务行为时，应测试成功、拒绝、重启恢复和竞态边界。

学习闭环测试必须覆盖十回合/十工具节奏、重启恢复、来源幂等、lifecycle 轮换和所有非私人/非交互排除项；复盘失败不得影响已持久回复，更新预约期间不得领取新任务。还必须注入领取和终态落盘的短暂数据库错误，证明 worker 会有界退避并继续处理，已领取任务在未落盘时仍阻塞更新。前台 `skill.load/read` 的工具轨迹测试必须证明安全 Skill id（以及 read 的安全相对路径）进入复盘 payload，同时正文、patch 内容和工具结果不进入轨迹。Gateway 测试必须用确定性并发覆盖复盘 memory 查询的“授权复验与查询同一 SQLite 快照”、复盘写入返回快照不丢失 review identity，以及普通 automatic memory 写入与账号撤权、lifecycle reset、父任务终结的线性化；延迟到达的旧请求必须失败关闭。复盘 Skill `list/load/read` 还必须覆盖“终态或撤权先发生则不触碰文件”和“读取先线性化则撤权等待”的两种顺序，并证明 ledger 独立锁不会形成 conversation→DB / DB→conversation 反向死锁。每个复盘 durable job 的二十单位共享变更预算必须覆盖 reconcile 按子动作计费、memory 失败回滚、Skill 写入持久预扣且失败可计费、memory 与 Skill 跨调用累计、任务重排/进程重启不重置和耗尽拒绝。Skill 测试必须覆盖可信 created_by、既有状态默认 user-owned、精确 patch 次数、读前写、bundled/user/pinned/archived 拒绝、agent-created bundled id/名称冲突、注入扫描、高置信凭据拒绝与认证文档/占位符放行，以及原子状态文件损坏。Runtime 测试还要证明复盘工具白名单、免批仅限完整 review context、父 session 不被写入且临时 session 终态删除，并要证明复盘的第 `17` 个模型请求在发送前被独立硬上限拒绝、工具说明与提示词都公开二十单位计费，而普通 Run 仍遵循全局模型轮次上限。

SQLite 测试使用临时数据目录，不共享开发数据库；事务测试必须覆盖正文异常与 `commit` 异常都执行 rollback，并证明同一线程连接随后仍可安全写入。Platform 启动安全回归还必须对 profile 实例锁、SQLite 主文件和已有 WAL/SHM 分别覆盖 symlink、hardlink、owner/type/link-count 异常与取锁/建立连接窗口的确定性 inode swap；断言异常发生在 PID、基线、schema 或 WAL 写入前，替换对象和外部链接 inode 保持原样。OAuth、Telegram、Knowledge Embeddings、Firecrawl、SearXNG、Camoufox 和 Git 操作优先使用确定性 fake；没有显式凭据和服务时，不把真实网络集成作为单元测试前提。知识测试必须覆盖缺 key 禁用、响应数量/顺序/数值/维度拒绝、稳定分块、过期 hash 丢弃、重启恢复、shadow generation 原子切换、provider 重试与被动建议 fail-open，不允许单元测试访问真实 Embeddings API。文件导入测试必须用本地合成样本覆盖全部格式、批量原子性、原件逐字节下载、手工 Markdown 导出、文件名/MIME/签名不一致、加密或路径异常 ZIP、压缩炸弹预算、无文本 PDF、超大正文与非管理权限；解析测试不得访问网络或执行文档中的脚本、宏、外链和公式。

## Agent Runtime

```bash
cd enterprise-agent-platform/agent-runtime
npm ci
npm run check
npm test
npm run build
```

Runtime 使用 Node test runner。模型流必须使用 deterministic stream fake，覆盖正常工具循环、审批、取消、input 注入、并发、幂等、session 修复、压缩、委派、超时分类和 cleanup。

后台 task 的反刷屏回归必须证明：只要当前 session 仍有活动责任，`schedule.create` 就在 Platform 调用和审批前被机械拒绝；取得匹配 target 的权威进程终态并解除全部责任后恢复允许；显式 service 不登记责任且不被误拦。

机械完成守卫的清理回归必须证明：由 todo、有限后台 task 或 recurring decision 触发的 `needs_review` 只保留责任 sidecar 精确登记且属于本 Run 的 task id，同 Run 的普通前台和未登记后台进程仍被清理；显式用户取消、idle timeout、普通异常和 sidecar 损坏不保留任何进程。Manager 重启恢复回归必须覆盖命令在停机窗口以 `0` 和非零退出、终态文件缺失/损坏/符号链接，以及仍运行/无法确认两类状态，证明只有真实 `0` 可恢复为 completed，真实非零保留 exit code，其余绝不伪成功。还必须覆盖启动意图已持久但 PID 证据尚未出现、host task 无法重接、确认后状态文件重新进入裁剪、同 owner 第 257 个 task 在启动前拒绝，以及委派 Run 在任何副作用、审批或 Manager 请求前拒绝后台进程。

scope cleanup 回归必须登记真实 session task responsibility，证明 Manager/本地进程清理确认后，即使 `delete_sessions=false` 也只删除精确 scope family/lifecycle 的 `.background-tasks.json`，同时保留 journal、todo、approval 与相邻 scope/lifecycle；`delete_sessions=true` 只在同一 Manager 确认后删除整个 family。还必须覆盖 Manager 已有 pre-start intent 而 Runtime context/sidecar 均为空、Manager stop 后本地提交失败并重试、Runtime 本地提交后 acknowledge 失败并重试两处崩溃窗口，证明 Manager evidence 在本地提交前保持 pinned、内存 context 只在全部确认后删除。Manager admission 竞态必须用确定性同步点证明 fence 等待 fence 前已 admitted 的 terminal start 完成登记、拒绝 fence 期间同 family/lifecycle 的新 start、允许相邻 family 与未命中 lifecycle 启动，并让 evidence 上限预检包含所有已 admitted 后登记的 task；重叠 cleanup 必须有界拒绝，测试不能依赖 sleep 推测时序。私有 HTTP 测试必须验证 scope-only 请求的 bearer 与闭世界字段、evidence 的数量上限和字段闭世界；任一步未确认都不得报告成功或影响相邻 scope/lifecycle。

Agent 自主执行回归还必须覆盖：`process.wait` 的自然成功、非零终态、超时不杀进程、取消与等待期间无 idle timeout；后台 terminal 的默认 `task`、显式 `service`、非法前台分类和闭世界 schema，并证明 task 未观察终态或 wait timeout 时阻止假完成、wait/read/kill 以匹配 target 观察 `completed|failed|cancelled` 后放行、Runtime-only 分类不进入 Manager 请求。后台 task 责任必须覆盖 needs_review 后的新 Run、新 Coordinator/Runtime 重启恢复与可信提示注入，以及 service 不落盘、session/scope cleanup 删除；独立 sidecar 的负例必须覆盖损坏 JSON、身份漂移、未知字段、符号链接、硬链接、错误 owner、非普通文件、宽松权限和原子替换失败保留旧状态。todo 的 session 隔离、原子恢复、限额、压缩后仅活动项注入和活动项阻止假完成，并证明 todo 文本即使伪造系统边界也只能作为不可信数据出现；todo、后台 task 与 recurring decision 三类机械完成守卫还必须分别断言终态仍为 `needs_review`、error 是独立明确 blocker、终态 content/Python `partial_content` 是最后一段真实诊断，并验证 Platform 以需复核样式持久化正文和真实工作记录且绝不从其中发布 `MEDIA:` 附件。语义压缩在工具历史超过摘要输入预算时仍保留最早目标/验收条件和最新用户请求，保留未完成目标、证据、文件、blocker 和下一步，摘要模型的输入与输出都清除 Token、认证头、JWT、私钥、带密码连接串、敏感配置字段和 URL 参数，同时保留普通 process/file id；同一 Run 首次自动压缩后必须继续对新增工具循环计量并支持二次及多次自动压缩，断言旧 handoff 被迭代更新而不归档或堆叠，活动 journal 始终只有一个 handoff。最终提交点前的摘要失败或客户端中断必须保持本轮压缩开始前的 journal/archive/state 完全不变并释放 session 门闩，提交点后的迟到断线则必须完成安全方向的有界提交。archive 总大小边界必须在写入任何新条目前整体拒绝，过界失败不能修改 archive 或 journal。批量委派的受限并发、输入顺序结果、leaf 默认不可递归、父取消和父复验提示，并证明父模型不能覆盖子 Agent 的可信系统提示；recurring scheduled Run 的 continue 决策保留 next、complete 决策停止计划、遗漏决策经有界提醒后进入 needs_review、once 不要求决策，以及 needs_review/blocked 在同一事务暂停计划并清空 next。current-occurrence 动作必须覆盖普通/委派/伪造 recurring 身份拒绝、重复幂等和 revision 竞态；测试不得通过自然语言匹配“已完成”或“继续”来授权计划变更。

委派安全测试还必须覆盖 child 写入后父直接结束被阻止、父执行后续聚焦验证才放行、纯只读 child 不阻止、batch 任一 child 有副作用即触发复验、嵌套子 Agent 共享根树总创建预算，以及全局 admission 饱和立即拒绝且取消已启动 child 能释放名额；不能把每层独立计数或模型 metadata 当作可信预算。

涉及 Run 空闲、模型轮次和 terminal 默认超时时，测试期望应从 [`runtime-policy.json`](../contracts/runtime-policy.json) 或生成的共享常量获取，不能在多个测试中复制生产数值。其它时间边界从对应配置 helper 获取。长任务回归必须证明持续活动不会被无进展保护误杀，同时快速无限循环会被模型轮次上限停止。前台 terminal 回归必须在事件循环延迟下仍依赖有界执行生命周期而不是定时器回调先后；清理宽限回归必须在 `maxConcurrency=1` 下用后续排队 Run 获得执行槽证明释放，不能把共享 runner 的绝对墙钟延迟当作产品语义。该用例删除临时 session 根时必须使用 Node `rm` 对 `ENOTEMPTY` 的有界重试，覆盖公开 completion 与内部 finally/锁释放之间的正常微任务窗口；重试耗尽仍须失败，不能无限等待或吞掉持久写入。使用亚秒真实计时器、或与这些断言共享 waitUntil/deadline 窗口的文件，必须由 Runtime 测试入口放进独立的 `--test-concurrency=1` 进程；其余编译后的 `*.test.js` 才允许有界并行。Quality 与顶层 `test.sh` 都只通过 `npm run test:compiled` 跑这一次完整入口，不得再开第二套并发 suite 来模拟压力。串行名单是闭世界：名单中的文件必须存在于编译产物，其余 `*.test.js` 自动进入并行进程；新增亚秒墙钟用例必须先加入该名单。需要扩大竞态覆盖时应使用确定性交错、可控时钟或事件屏障，而不是墙钟循环。

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
- 工作记录仅在工具调用时出现，运行中保持无折叠控件的紧凑进度行，Run 终态后自动折叠且可展开查看完整详情与持久化阶段性说明；还必须覆盖超过旧 8 段/30 条窗口的长 Run、多个事件落在同一秒时仍按单调 `sequence` 排序、同一 `tool_call_id` 完成时原位更新、阶段性说明进入时间线后不再残留于 `stream_messages` 或重复渲染完整气泡，以及条目、单项详情和总详情达到防滥用硬界后出现带准确计数的显式截断标记；
- 审批、失败发送恢复和连续短消息；
- 浏览器首帧加载与终端预览可用性；
- 手机动态视口、长代码/表格和 Composer 不扩大页面；
- 三种 locale 的 key 完整性；
- 更新维护页在 Store/登录失败时仍可接管。

`npm run build` 是前端变更验证的一部分，它在本地忽略目录中生成并校验 static；生产镜像在独立 frontend build stage 中重复同一步骤后再打包 Platform。测试通过但未构建 static 仍视为未完成。

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

四个镜像构建完成后必须先把原始 `image-*` identity 收敛为闭世界的单一 `managed-images` 目录。双架构匿名拉取/容量验证、Compose 冒烟与最终 manifest 只能消费这同一目录，不能各自维护镜像默认值；原子 publish 必须直接依赖目录生成、两个架构验证与 Compose 三类成功结果，不能在验证完成前运行。发布组装不得重新拼接原始 `image-*` 输出，也不得使用 `*` 下载当前 run 的全部 artifact。Buildx 自动生成的 `.dockerbuild` 记录属于诊断产物，不进入发布目录，也不能成为 release 下载、解压或文件冲突的额外故障面；缺少任一必需 family 时必须失败。

镜像身份与 Manager 二进制上传允许同一 workflow run 的全量重跑覆盖同名中间 artifact。最终 `publish` job 必须使用完整 source commit 作为跨 run 全局锁，并在同一发布步骤中直接复验成功 Quality run、构建 source、workflow run/attempt、release ID、tag commit 和精确资产名称/SHA-256/size；不再生成第二套 promotion 或 provenance 文件。GitHub 在创建 lightweight tag 后可能短暂读不到同一 ref，发布器必须只对这次写后读取做有界重试并最终重证 tag 的精确 commit，不能跳过验证或无限等待。相同 generation 的重放只接受逐字节一致资产；错误 tag、未知/重名资产、无关 Quality run、镜像不可匿名拉取或 digest 漂移都必须在推进 latest 前失败。

main 通道测试必须覆盖至少三个线性后代：较旧 workflow 后完成不能降级 latest，连续 push 最终自动推进到最新通过 Quality 的 main head，分叉 candidate 在构建前或发布前拒绝。发布链没有阶段选择器、固定迁移前任、部署 challenge 或人工 promotion 分支。

release 时间测试必须把 `git show --format=%cI` 形式的带偏移时间交给真实 assembler，再把其 schema-2 输出交给 fresh installer 的 manifest 解析路径，证明资产中的 `generated_at` 已规范化为 UTC `Z` 并可安装。另需覆盖正负偏移的等价 UTC 转换，以及无时区、无效日期/偏移和非 RFC 3339 输入拒绝；不得把 installer 改为接受非 canonical 输出。

发布测试只覆盖当前 manifest schema、十个受管镜像和中性 Compose/Manager 资产。fresh install、普通 startup、Candidate watchdog 与 finalize recovery 始终使用编译期唯一 profile；配置、路径、环境或可执行文件名不能选择另一身份。普通更新还要证明未物化 workspace、缺 marker/alias、未知 residue 都在副作用前失败，且不存在按历史 generation、摘要或路径启用的修复能力。

fresh installer 隔离测试必须用可控账户查询 stub 返回当前 UID/GID 的权威 home，同时把 `HOME`、`XDG_BIN_HOME`、`XDG_CONFIG_HOME` 与 `XDG_DATA_HOME` 指向不同的恶意临时目录；stable Manager、配置、user unit 和数据根只能出现在账户 home 派生路径，四个 ambient 根必须保持未创建。`XDG_RUNTIME_DIR` 另行指向 owner-only 临时目录并验证 socket 写入该目录，并至少以非私有 runtime 根证明安装副作用前失败；实现还必须拒绝非绝对、符号链接或错误 owner 的 runtime 根。

部署等待和 deadline 不写在本文，由对应部署配置与测试约束；不得误用 Agent Runtime 的空闲或 terminal 契约代替部署策略。

## 文档同步检查

受管机器契约中的生产限额以 `docs/contracts/` 下的 canonical JSON 为唯一数值真源。同步器只校验字段闭世、整数类型、正值与消费端通用安全范围，不得在校验代码或测试中复制具体生产数值作为第二真源。合法限额变更必须同步驱动所有登记的 Python、TypeScript 和 Go 生成目标；生成目标与 canonical JSON 不一致时 `check` 失败。

每次提交都应运行仓库提供的 docs 校验，验证：

- Markdown 相对链接存在；
- docs domain 与代码路径映射完整；
- 受管代码变化同时包含对应规范变化；
- 机器可读契约和消费者测试一致，生成目标是普通且不可执行的文件；
- 根规则文件只保留受管行为入口；工具兼容入口只引用该入口，不复制规则或 canonical 设计。

受管生产代码不得绕过“代码变化必须同步 canonical 文档”的门禁。纯文档澄清、索引整理和删除过时叙述可以独立修改，不要求制造无语义的代码或测试变化；机器契约修改仍必须同步全部生成消费者并通过当前树校验。
