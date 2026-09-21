# 测试与验证

本文定义每类变更的最低验证范围。架构与源码边界见[仓库开发指南](repository.md)。

## 顶层检查

开发反馈与交付门禁共用一个入口：

```bash
./scripts/test.sh affected  # 迭代期：选择受影响组件
./scripts/test.sh full      # 交付前：完整本地门禁
```

两种模式都先执行一次当前树文档与生成契约 `check`。`affected` 分别纳入 staged、unstaged 和 untracked 变化，Git diff 禁用 rename 合并，让移动前后路径都参与选择；暂存后又在工作树还原的路径也不能丢失。Git 读取失败必须失败。共享契约、`scripts/`、容器、安装器、workflow、选择器自身和无法分类路径保守升级为 `full`，不提供绕过检查的标记。文档检查不再认证 Git 历史或代码／文档共改，语义责任见[文档工作流](documentation-workflow.md)。

`full` 在文档检查后并行运行 scripts、Manager、Python、Runtime、前端和共享容器定义门禁。`scripts/tests` 由顶层脚本发现并运行一次；`container-smoke.sh` 只负责容器／安装器检查，不再嵌套该 suite。Quality 的 `container-definitions` job 显式运行一次 scripts suite，再运行 container smoke；`Documentation` job 只执行同一当前树检查。Python 本地与 CI 使用同一确定性四分片选择器。

本地 `full` 必须执行完整 `container-smoke.sh`，不能用一次 Compose 渲染代替，缺少 Docker Compose 必须失败。但它不是整条 release 的证明：双架构匿名镜像／容量、真实服务 Compose、真实 user-systemd、资产发布和通道提交仍需各自发布门禁。不得把未运行的模型、容器或外部服务验收报告为通过。

温热工作区以 `affected` 三分钟、`full` 十分钟为反馈目标；脚本输出选中组件和每组耗时。持续超出目标时定位回归或过宽测试域，不默认增大全局超时。组件在独立严格错误处理子 shell 中执行，任一步失败立即终止；EXIT trap 只记录耗时，不覆盖退出码。

Node 本地依赖只在 lockfile 摘要匹配且 `node_modules` 存在时复用，摘要仅在 `npm ci` 成功后保存；CI 和缓存缺失时干净安装。Quality 对 Node 工作区执行 high 级别依赖审计，修复保持最小 lockfile 变化。Runtime 每轮只编译一次；前端在忽略目录构建并校验可重现 static，不提交 bundle。

Manager 全量测试在每个候选的成功 Quality run 中以 `go test -count=1 ./...` 执行一次；Container 的两个 Manager 工件 job 只交叉编译 AMD64／ARM64 并上传校验和，不重复单元 suite。Go 缓存绑定 `manager/go.sum`，不能替代实际测试、编译或真实 user-systemd 的 `-count=1` 门禁。精确 Quality 与发布来源绑定由[自动更新](../operations/auto-update.md#发布通道)定义。

测试沿用 Go `*_test.go`、Python `test_*.py`、Runtime Node runner 和前端 Vitest/Testing Library。测试可观察行为、拒绝、恢复和竞态，不锁死文案或内部结构；使用隔离临时数据、确定性外部服务 fake 和明确同步点，不用睡眠、增大超时或削弱断言掩盖失败。

## Manager 与容器

```bash
cd manager
go test -count=1 ./...
go vet ./...
go build -buildvcs=false ./cmd/agent-platform-manager
cd ..
./scripts/container-smoke.sh
```

本地构建关闭 VCS stamping，工作树与 worktree 使用同一入口；发布身份来自已验证 manifest 与镜像 label。Compose 静态校验自行注入不可变占位镜像和临时挂载，忽略 `.env`，不连接产品容器。运行容器模式 Platform 时使用真正监听、校验 control token、返回规范空闲状态的 Unix-socket Manager contract stub；stub 的 `/v1/status` 包含全部能力键，空能力为 `null`，并在 fresh 阶段显式创建 owner-only `data/workspaces/`，不让 Platform 越权补建。

### 更新与启动所有权

- 覆盖 manifest schema、HTTPS、artifact basename／校验和、精确镜像 digest、operation 幂等与各阶段恢复、任务等待、维护 Gateway、Unix socket、Sandbox identity、host/sandbox 审计、迁移、快照和回滚。
- 镜像拉取覆盖本地精确 digest 命中、持续进度、无进展与绝对上限、空间恢复后的重试；预拉取不能占用固定栈锁，能力 registry 故障不阻止核心提交。
- `/v1/check` 验证 manifest／Candidate 可刷新，但不创建更新 operation、不安装或切换 generation。覆盖保留条目的精确 URL 绑定、同键冲突与并发胜者，证明命中／冲突请求不重复候选变更；淘汰／重启后同键是新检查，`reused` 反映实际命中，不留独立持久 check journal 或无限期 key 身份。
- 真实 user-systemd 必须启动独立 watchdog，由它提交 `restart --no-block`，观察候选 inode、acknowledgement 与 commit，并验证失败回滚、主 unit 停止不杀 watchdog、同一重启只提交一次和瞬态 unit 精确清理。受控恢复复用该门；显式启用后缺前提或已有产品 watchdog 必须失败，不能跳过后发布。持久 unit 同时验证 `ExecStart` argv 引用与 `WorkingDirectory` 属性路径转义，不能混用。
- 单实例覆盖 `serve.lock` 先于 application 构造并保持整个 serve 生命周期、第二 serve 非阻塞拒绝、安全 fresh root 收紧、root/lock 的 symlink/type/owner/mode 和 `CLOEXEC`；保持 `serve.lock → recovery.lock → plan lock` 顺序。旧 serve 退出后，新 recovery Manager 在外部 recovery lock 忙时仍能进入合法 identity probe。
- control socket 覆盖 live owner 保留、仅明确 `ECONNREFUSED` 才删除 stale、模糊错误拒绝、探测后 inode swap 保留和旧 teardown 不删继任者。sibling bind flock 保证并发 `Listen` 只有一个进入 probe/unlink；退出／崩溃后可复用，并拒绝 symlink、hardlink、宽权限、owner/type/inode 异常或缺 `CLOEXEC`。
- pending Candidate 提交前仅 control token 的 identity 可用，status/mutation 和 executor token 拒绝；commit 后原子开放完整 API，并以 `-race` 覆盖切换。rollback-half 篡改 Candidate platform-commit、version、source、SHA、verified time、managed path 或 Activation plan path 均失败且不改 state。

正向 release fixture 由 `manager/internal/releasetest` 从 canonical contract 生成并严格验证，只覆盖用例关心的 generation、时间或真实字节。decoder 的未知／重复／缺失字段、checksum、basename 等负例保留原始输入，不让 builder 自动修正。

### 清理与耐久恢复

- 用真实进程在 rename 前退出留下原子写入器实际 `.tmp-*` 名称，证明下次启动在正确域锁下清理并继续枚举 journal；其它目录的新鲜残留不能触发启动循环。
- 保留非精确名称、symlink、目录、FIFO、异 UID、hardlink、宽限内文件、`lstat/fstat` 不一致或并发替换、任何持久引用。成功 unlink 后 fsync 已固定父目录；未持域锁不能删除新写入文件。
- operation 裁剪同时满足七天窗口与最新 `128` 条下限；pending/running、未 finalized、无有效 `completed_at` 或 active/finalize 引用永不删除。未知项、坏 JSON、身份／权限异常、inode swap 和父目录 fsync 失败均失败关闭。
- operation 域失败不跳过独立快照、release／镜像和 Manager binary 清理；终态 operation 裁剪不得读写或删除 recovery/activation 审计证据。

### 真实外部服务

- Firecrawl 使用与 Manager 相同的 `docker compose up --detach --wait --wait-timeout 600 firecrawl-api` 启动 PostgreSQL、Redis、RabbitMQ、Playwright 与 API，确认无 FoundationDB 服务、环境或挂载。写入专用 PostgreSQL 哨兵后保留 bind 数据、强制重建服务，以新容器 ID、精确读回哨兵、API liveness 和真实 `/v1/scrape` 证明幂等初始化、启动顺序、容量与挂载契约；`create`、一次空库启动或仅复用目录不足以证明。
- 真实 SearXNG 的 Mounts 必须显示受管 config 根只读 bind 到 `/etc/searxng` 且没有匿名 volume，不能只检查 Compose。
- Camoufox 使用同一 Compose 的真实 Platform／Camoufox 与仅在临时 core network 的页面，不访问公网。经 Platform 登录、内部 Gateway 建立私人 scope/tab，再经同源控制 API 完成 `acquire → 滑块拖拽 → text → key → wheel → 帧/snapshot → release`；验证抬键、sequence 不重放、租约中 Agent mutation 冲突及释放后恢复。补丁异常路径也须证明 `finally` 抬键。密码、session、bearer 不进入命令参数或输出。

## Python 平台

```bash
cd enterprise-agent-platform
python3 -m unittest discover -s tests
python3 -m compileall enterprise_agent_platform tests
```

Quality 将排序后的顶层 `tests/test_*.py` 模块不可拆分地分入四片，编号从 `0` 开始；所有入口都运行全部分片，交集为空、并集等于完整枚举，空片不算成功。仓库根执行 `python3 scripts/python_test_shard.py --shard-index 0 --shard-count 4 --list` 查看选择，去掉 `--list` 运行。稳定的 `Python 3.11` 聚合门只有全部分片成功才通过，失败／取消／未完成均失败；完整源码字节码编译只由一片执行一次。

路由、配置、迁移、权限、任务恢复、更新和受管服务变化覆盖成功、拒绝、重启与竞态。测试数据库位于独立临时目录；OAuth、Telegram、Firecrawl、SearXNG、Camoufox 和 Git 优先确定性 fake，真实网络／凭据另行显式隔离。

### 业务状态与后台学习

- 手动领取计划任务的测试在构造服务前隔离自动调度线程，保留真实 dispatcher、作业执行、终态同步、暂停与幂等断言；不允许两个领取者竞争，也不模拟 dispatcher 返回值或延长等待掩盖竞争。
- 学习覆盖十回合／十工具触发、重启、来源幂等、lifecycle 轮换和所有非私人／非交互排除项。复盘失败不影响持久回复，更新预约后不领取任务；领取／终态短暂 DB 错误后有界退避继续，未确认终态仍阻塞更新。
- `skill.load/read` 轨迹只把安全 Skill id 与 read 相对路径送入复盘，不含正文、patch 或结果。Gateway 确定性竞态验证 memory 授权复验与查询同一快照、写入返回保留 review identity，以及 automatic memory 与撤权、reset、父任务终结的线性化；迟到请求拒绝。
- Skill 读取验证“先终态／撤权则不碰文件”和“先读取线性化则撤权等待”两个顺序，ledger 不造成 conversation→DB / DB→conversation 反向死锁。
- 每个 durable review 的二十单位共享预算覆盖 reconcile 子动作计费、memory 失败回滚、Skill 持久预扣且失败可计费、跨调用累计、重排／重启不重置与耗尽拒绝。Skill 覆盖可信 `created_by`、既有包默认 user-owned、精确 patch 次数、先读后写、bundled/user/pinned/archived 拒绝、agent-created id／名称冲突、注入扫描、真实凭据拒绝与认证说明／占位符放行、原子状态损坏。
- Runtime 配套证明复盘白名单、完整 review context 才免批、不写父 session、终态删除临时 session；第 `17` 次模型请求发送前拒绝，工具和提示公开二十单位计费，普通 Run 仍受全局轮次上限。

### 数据、预览与执行安全

- SQLite 事务正文或 `commit` 异常均 rollback，同线程随后可安全写入。启动对实例锁、主库和已有 WAL/SHM 覆盖 symlink、hardlink、owner/type/link-count 与取锁／连接窗口 inode swap；拒绝先于 PID、基线、schema 或 WAL 写入，外部 inode 与替换对象不变。
- 电脑线索来自既有工具生命周期，不新增 Runtime 工具；文件路径只接受当前 `/workspace` 后代，host 拒读正文。`.html/.htm` 可交付，但聊天预览仅 XLSX/DOCX/PPTX/PDF。文件与呈现页使用 `MEDIA` 同级 fd-rooted 鉴权，拒绝穿越、symlink、跨 scope 与过大正文。
- MCP 使用本地合成 stdio server，覆盖热读配置、workspace 隔离、argv 启动、初始化、list/call、审批、协议／超时／输出上限和不可信结果。普通复杂参数须完整展示，敏感字段脱敏，控制／双向字符与完整展示超限拒绝。
- Manager 快照、输出文件、终端预览及 Runtime 工作事件不得出现可逆 MCP 请求或原始结果，当前 Manager→Runtime 响应仍交付结果；config/cwd/工作区 command 从 fd 固定到实际启动都抵御父目录置换。

## Agent Runtime

```bash
cd enterprise-agent-platform/agent-runtime
npm ci
npm run check
npm run build
npm run test:compiled
```

build 先清空 `dist`；Quality 与本地每轮只用一次 `test:compiled`，串行运行 `node --test --test-concurrency=1 dist/test/*.test.js ../../containers/agent-sandbox-mcp-client.test.mjs`。不再维护分类器、串行名单或第二套 suite。

### 执行与完成边界

- 使用 deterministic model stream 覆盖工具循环、审批、取消、input、并发、幂等、session 修复、压缩、委派、超时分类与 cleanup。进程／文件 fake 注入生产的 `ExecutionManager` 接口，完整实现 reconcile/ack，不提供生产本地执行回退。
- 系统提示顺序、动态不可信 framing 与权威状态分开验证。时间、回忆、sidecar、Skill 索引变化不改稳定前缀／Codex key；策略、实际有序工具 schema 或 scope 改变须失效，工具对象字段顺序不影响 key，空状态无占位。provider payload 不含原始 scope，保留真实 session/header；确定性 key 不等于供应商 cache hit，代表性真实模型行为 eval 独立执行。
- todo 选择覆盖直接回答、单读、一两个动作、小改动的线性读改验、多独立步骤、多任务与复杂度升级；Runtime 不自动建清单，空清单不注入。验证 session 隔离、原子恢复、限额、压缩后只注入活动项、不可信正文和活动项阻止假完成。
- 区分硬责任与软恢复：todo、task、recurring decision 和委派复验不能因提示预算耗尽变成功；普通文件复验、承诺式／空终稿只按[执行纪律](../design/agent-runtime.md#提示词组装与执行纪律)有界恢复，ephemeral 提示不落 journal、不重放工具。
- 三类 todo/task/recurring 机械终态均保持 `needs_review`，独立 error/blocker 与最后真实 content／Python `partial_content` 并存；Platform 保存需复核正文和工作记录，不发布其中 `MEDIA:` 或完成通知。

### 后台 task 与清理

- `process.wait` 覆盖成功、非零、等待超时不杀进程、取消和等待期间无 idle timeout。后台 terminal 默认 task、显式 service、前台非法分类及闭世界 schema 分开验证；Runtime-only 分类不进入 Manager 参数，只有匹配 id/target 的 `wait/read/kill` 权威终态能解除责任。
- 活动 task 在 Platform 调用或审批前阻止 `schedule.create`，全部解除后放行；service 不落责任、不误拦。新 Run、新 Coordinator／Runtime 重启都恢复可信责任，损坏 JSON、未知字段、身份漂移、symlink、hardlink、owner/type/mode 异常均拒绝，原子替换失败保留旧状态。
- 覆盖 Manager intent 已持久而 PID／Runtime sidecar 尚无记录、终态 `0`／非零、缺失／损坏／symlink 终态文件、仍运行与无法确认、host task 不能重接；未知结果绝不伪成功。resolved→ack→本地删除的每个失败窗口可重试但不重跑命令，ack 后才恢复裁剪，同 owner 第 `257` 个 task 在启动前拒绝。
- 机械 `needs_review` 仅保留责任中精确登记且属于本 Run 的 task；同 Run 前台和未登记后台仍清理。显式取消、idle timeout、普通异常或 sidecar 损坏不保留进程；委派后台启动在副作用、审批与 Manager 请求前拒绝。
- scope cleanup 从 Manager family evidence 而非内存 context 发现责任。确认停止后，`delete_sessions=false` 只清精确 family/lifecycle 的 task sidecar，保留 journal/todo/approval 与相邻身份；为 true 才删除整个 family。覆盖 Manager 停止后本地提交失败、本地提交后 ack 失败与两侧 context/sidecar 为空，evidence 先 pinned，全部确认后才删除内存 context。
- 用同步点证明 admission fence 等待已 admitted start 登记，拒绝同 family/lifecycle 新 start，放行邻域，evidence 上限包含所有已准入任务；重叠 cleanup 有界拒绝。私有 HTTP 覆盖 scope-only bearer、字段闭世界及 evidence 数量／字段上限；未确认不能报成功。

### 会话、压缩与委派

- 同 journal 初始化、尾部修复、追加、压缩和删除共享 mutation 边界；并发初始化只建立一份 header/seed，失败可重试，邻近 session 独立。cleanup 后旧摘要／快照不能重建已删 journal。
- 摘要预算保留最早目标／验收条件、最新请求、未完成目标、证据、文件、blocker 和下一步；输入输出清除 Token、认证头、JWT、私钥、密码连接串、敏感配置与 URL 参数，保留普通 process/file id。
- 同 Run 多次自动压缩持续计量，迭代单一 handoff，旧 handoff 不归档／堆叠。系统提示与工具 schema 也计入估算；供应商用量不重复加固定开销，恢复／压缩后旧 usage 不再作锚点，终态回退只估 handoff + tail，图片不按 base64 长度计费。
- 摘要截断、超限、工具调用、模型失败与提交前取消保持原 journal/archive/state 字节不变、释放门闩、不发 `context.compacted`；提交后的迟到断线完成有界 archive-first 提交。archive 总量在任何追加前检查，过界不能修改文件。
- 委派验证受限并发、输入序结果、默认 leaf、父取消、可信系统提示不可覆盖、整树共享创建预算、全局饱和立即拒绝与取消释放容量。只读 child 不增加完成条件；任一 child 副作用要求父在其后成功聚焦复验，新批次使旧验证失效。
- recurring 的 continue 保留 next，complete 停止，遗漏经有界提醒后需复核；once 不要求决策。`needs_review/blocked` 同事务暂停当前 revision 并清空 next；普通／委派／伪造身份拒绝，重复幂等与 revision 竞态不重开计划，不能从自然语言授权。

时间期望从 canonical 共享策略或相应配置 helper 获取，不复制生产数值。持续活动不被 idle 守卫误杀，快速无限循环受模型轮次限制；前台 deadline 依赖执行生命周期而非 timer 回调先后。用 `maxConcurrency=1` 的后续排队 Run 证明清理释放容量，不用 runner 绝对延迟代替语义。观测预算应容纳调度抖动但不放宽产品值；扩大竞态覆盖用可控时钟、事件屏障。临时 session 根在 completion/finally 间仍可能写入，Node `rm` 可对 `ENOTEMPTY` 有界重试，耗尽仍失败。

## 前端

```bash
cd enterprise-agent-platform/frontend
npm ci
npm run check
npm test
npm run build
```

Vitest／Testing Library／jsdom 使用生产组件前缀、主题、品牌、i18n Provider、真实 Store 和 typed action，不用 selector mock 掩盖稳定引用。最多两个 worker；非动效用例走真实 reduced-motion 分支。文本只是前置数据时可粘贴，按键、IME 与发送状态机仍逐键交互，不延长超时或删除并发断言。

### 状态与交互

- 登录、401、账号切换、稳定空 selector、SSE／轮询竞争、重连、scope 切换与迟到响应、维护门在 Store／登录失败时接管。
- 审批身份、失败发送恢复、连续短消息及发送前接管队列释放；旧账号 payload 不进新 Store，同账号旧 scope 恢复不覆盖新草稿。
- 多页历史加载后离开／返回保留缓存前缀；reset 与迟到分页不复活已撤回消息。通知从真实旧 scope Store 经正式 action 导航，标题与消息隔离，历史／重复事件不补发。
- 工作记录只来自真实工具，运行中紧凑、终态折叠；有实质详情才可展开，对象／结果优先。长 Run 和同秒事件保持 sequence 与 tool-call 原位更新，阶段性说明不重复成气泡，契约硬界有准确省略计数；个人 AI 头像旁不重复作者名。
- XLSX/DOCX/PPTX/PDF 展示有界真实预览，失败仍可下载；PPTX 以声明 relationship 页序处理，安全负例见下节。
- 品牌中性默认、metadata 与全生命周期一致；缓存／ETag 重验证、非法响应降级、revision 保存冲突／回滚、跨标签页通知与迟到响应不会覆盖权威快照。三语 key 完整，未发送输入与偏好持久保留。
- 原生 overlay 的 Select 弹层先消费 Escape，嵌套确认只关闭顶层并恢复焦点，底层编辑器和未保存输入保留；不能以 document-capture 关闭器抢占子控件。

### 电脑与实际浏览器

按[电脑画面](../design/frontend.md#电脑画面)验证真实状态到只读呈现的闭环：

- 空闲／仅排队无资源时无空监视器，replying／approval 可显示等待画中画；真实线索到达后展示文件、终端、浏览器、搜索或呈现页。计时只用同一权威 `started_at`，终态停止。
- 画中画与固定右半屏非模态区域只有一个实时消费者；仅用户动作展开，缩放不重挂载、重复接管或无故释放租约，聊天可操作；收起／scope 切换释放资源并恢复焦点，Escape 只处理区域内未被子控件消费的事件。
- draft 单在途追赶最新 revision、标明未提交，仅揭示权威字符；非前缀替换与动态偏好安全收敛。started 404 等待，完成读取最终快照、同路径 patch 刷新；短命令显示真实最终输出。
- HTML 完成前不挂载，完成后同路径重写可刷新，不透明源 iframe 禁止 `allow-same-origin`；三语电脑名称、独立记忆／技能／任务、显式接管、发送前释放与旧 scope/Run/tool/target 请求拒绝均保留。
- 实际浏览器覆盖长对话滚离底部、短窗口、长输入和等效缩放：浮动跳转按钮／画中画不占阅读高度、不留下白色占位或上下元数据白条、不拦透明区域滚轮；HTML 缩略视口完整，输入不遮挡，展开始终右半屏。
- 动态偏好实时切换保留输入、展开和焦点；布局 scroll 先于 resize 仍保持跟随／阅读意图、不增未读。手机动态视口、长代码／表格与 Composer 不撑宽页面；原生 `inert`、键盘顺序及过渡生命周期必须在浏览器验证。

完整视觉变更覆盖登录、导航、对话、上下文能力、设置和全部管理资源，包含桌面／手机、浅色／深色、加载／空／错误／可用状态。删除纯 CSS、源码、旧类名、固定比例／像素／列数与组件结构断言，不换一组新实现钉死；保留操作、权限、输入、内容安全和异步身份行为。使用组件库公开语义 API；缺少真实外部能力时明确说明，不伪造健康或回复。

build 必须生成并校验忽略的 static；验证 identity/gzip/Brotli 入口提交前旧依赖可读、提交后陈旧受管资产（含旧 Logo）原子清理，以及首屏 preload／gzip 与慢链路反馈。生产 frontend stage 重复构建后才打包 Platform；只测不构建仍未完成。

## 安全测试

涉及安全边界时至少加入负例：

- 未登录、权限不足、停用/被吊销 session；
- Cookie 写请求缺 Origin/Referer 或跨源；
- 路径 traversal、符号链接、受保护目录和 Docker socket；
- 内网/回环/云元数据 URL 与重定向；
- owner/scope/provider/browser identity 参数注入；
- 超大 body、附件、工具输出、搜索响应或 HTML 呈现页；
- 电脑呈现页 iframe 获得产品同源、Cookie 或父页面 DOM，以及文件预览读取宿主路径；
- 未审批工具、伪造 approval id、无人值守授权绕过；
- operation 幂等键、expected generation 和 rollback 覆盖竞态。

## 部署与冒烟

发布协议只由[自动更新](../operations/auto-update.md#发布通道)定义；本节规定证明方式，不维护另一套提升条件。高风险 Manager、容器、Runtime packaging 或 static 变化在临时数据根完成安装／更新冒烟，并保留独立发布门禁证据。

### 安装、恢复与真实服务

- fresh root 安装，stable Manager 与 manifest 同摘要时直接成为 Current、不建 activation；安装器经 stdin 配合 `--yes` 可用，preflight 失败精确清理本次创建的数据根、配置、二进制和 unit，同路径可重试。
- Manager active/enabled、无 active/finalize operation，Platform／Runtime／公共 `/healthz`、Runtime bearer 与 `/v1/models` 正常；登录、首页、API、消息、SSE、附件、搜索可用。本人频道消息撤回在同 generation 多客户端按 reset revision 收敛。
- 多任务跨轮询时更新排队，空闲后继续；Gateway 进入维护并恢复。数据库迁移成功／失败／外键回滚、各持久 phase 重启、Current/Previous 快照往返、SQLite 与 journal 一致；不同摘要 Manager 的真实 systemd 提交／回滚见上节。
- 注入 registry 无进展、ENOSPC、核心 readiness、响应丢失，证明可重试恢复；Firecrawl 等单项降级仍允许核心提交，恢复后自行健康。受保护对象不删，过保留期的未引用 release、镜像、临时文件与终态 journal 自动回收。
- 固定服务与 Sandbox 启停不遗留错误容器且保留工作区；Sandbox 离线生成可打开的 XLSX/DOCX/PPTX/PDF 并通过消息附件交付。terminal、搜索、浏览器和抓取报告真实状态；Firecrawl 保留 PostgreSQL 重建和浏览器接管链路按上节真实服务验收。

当前 schema、十个受管镜像和中性资产是唯一发布基线；fresh/startup/watchdog/finalize 使用编译期唯一 profile，环境、路径或可执行名称不能另选身份。普通更新对未物化 workspace、缺 marker/alias、未知 residue 在副作用前拒绝；仅保留 `2026080801 → 2026082901` 的明确兼容例外：

- root entrypoint 只接受闭合 CLI；非迁移命令在数据／secret 操作前降权。`migrate` 同时要求镜像内固定标记及部署身份 isolated Python 只读确认的精确旧 marker。
- 兼容拒绝未知 owner/group/mode/type、额外／非空项、symlink、跨设备与 inode 置换，只非递归收紧固定旧 Docker 空 mountpoint，随后清除附加组、以部署 UID/GID 真实迁移。
- 数据根放 shadow Python 包及 `sitecustomize`，证明 root helper 不加载；覆盖子已转换／父未转换的重试，PID 1 全部 capability 为空。fresh/current、规范布局无兼容副作用，任意 root shell／命令拒绝。
- Manager 在 Docker 调用前安全创建 workspace 内 `0700 .agent-platform/attachments`，拒绝各父级／叶级 symlink 与 owner 漂移。

fresh installer 用账户查询 stub 返回当前 UID/GID 的权威 home，将 `HOME`、`XDG_BIN_HOME`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME` 分别指向恶意临时目录；stable、配置、unit、数据只落账户 home，ambient 根不创建。安全 owner-only `XDG_RUNTIME_DIR` 单独接收 socket；非私有、非绝对、symlink 或错误 owner 的 runtime 根在安装副作用前拒绝。

### 静态边界与隔离清理

- 按顶层 job 边界检查权限、依赖、锁、artifact 来源和清理，不能在整份 workflow 搜索相同片段。`compose-smoke` 包含异 UID 临时树的前缀／路径 guard 与提权清理；`publish` 包含精确 family、来源复验与通道锁。静态检查只能证明实际验收入口仍被调用，不能替代真实链路。
- 仓库 Python 工具显式由 `python3` 调用。Manager 全量 suite、双架构编译、真实 systemd 与 Go 缓存边界符合顶层规则；上游直接消费 canonical URL/revision/全部 required_paths，不要求未采用的实验服务。
- 构建上下文排除 `build/`、`dist/`、`*.egg-info`、venv、缓存、测试产物和本地 static。generation revision/version 只在最后一个文件系统构建指令之后用于 label；Camoufox 锁定浏览器、依赖与小型运行源文件不能整体跨阶段复制。
- bind 不能遮蔽镜像入口、脚本或配置根；镜像声明的配置 volume 用完整受管目录覆盖并检查真实 Mounts。manifest 镜像键与当前 schema 精确相等，容量目录和消费者一致。
- 发布退出先尝试移除相关容器，再由 runner 受控提权仅清理 `RUNNER_TEMP` 下 `mktemp` 创建、固定产品前缀的单一树；异 UID 挂载不能普通递归删，不受约束路径不能提权删，清理失败仍使发布失败。
- 每次临时拉取只按刚观察的精确 image ID 清理；身份漂移、缺失或 Docker 状态不可读失败关闭，禁止 prune 或忽略删除错误。

### 发布资格、资产与通道

- 用真实 Git 临时仓库证明累计 published→candidate 差异：精确普通非执行说明白名单和空差异可跳过，产品变更后追加说明仍发布；新增／删除／rename 两端、模式／类型／名称歧义、未知路径、缺历史、Git 错误、非法／分叉身份均保守处理。资格 helper 无基线不能判为安全跳过，但 prepare／publisher 缺经认证的现有公开 generation 仍失败，不提供首发／API 错误回退。身份验证后的手工恢复强制发布；noop 不建候选 tag/release/assets，不改 latest，Quality 保留。
- 单一 `managed-images` 目录供 AMD64／ARM64 匿名 digest／容量、真实 Compose 与 manifest 使用，发布直接等待全部门。缺 family、混入 `.dockerbuild`、全量 artifact 通配或跨 run 身份必须拒绝；同 run 的合法重跑不放宽 release 重放。
- 精确 Quality/source/run/attempt/release/asset/tag 绑定：错误 tag、未知／重名资产、字节漂移、无关 Quality、非匿名镜像与 digest 漂移都在公开前失败。draft 通过认证数字 ID 查找；刚写 tag 的有限可见性重试不能跳过精确 commit 验证。
- 下载／匿名拉取后再次注入身份漂移，证明最终公开紧前仍复验；`workflow_run` 默认分支 head 与真实候选分离、手工 HEAD 不匹配、正在发布的 `in_progress` run 均按协议处理。公开后后验失败明确报告已可见事故。
- 至少三个线性后代覆盖乱序完成不降级、连续 push 收敛到最新有发布物变化的合格候选、说明-only 后代保留 latest、分叉拒绝；候选锁不能替代不同 generation 共用的 channel 锁。
- GHCR 瞬时失败可在既定三次预算内恢复，耗尽不发布；不扩 token 权限。
- 把 `git show --format=%cI` 的偏移时间交给真实 assembler，再交 fresh installer 解析 schema-2 输出，验证 UTC `Z` 可安装；覆盖正负偏移等价转换，无时区、无效日期／偏移与非 RFC3339 拒绝，不放宽 installer。

部署等待和 deadline 从部署配置取值，不能套用 Runtime idle／terminal 策略；生产恢复操作遵守[部署](../operations/deployment.md)。

## 文档同步检查

```bash
python3 scripts/docs_sync.py sync   # 仅机器契约改变时生成
python3 scripts/docs_sync.py check
```

`full`／`affected` 和 CI 已按顶层规则各执行一次当前树检查，不重复追加历史／暂存认证。完整检查范围与 docs-first 语义责任见[文档工作流](documentation-workflow.md)：路径／所有权／本地链接、闭世界机器契约和全部生成消费者必须一致。

同步器回归以合法契约变化驱动所有登记语言消费者，并拒绝缺失／陈旧生成目标、不安全路径或可执行目标、未知字段、非法边界与无消费者登记；不复制生产限额或锁死 owner 列表／文档措辞。标题锚点及实际行为一致性由评审确认，不能以文档被修改过作为证明。
