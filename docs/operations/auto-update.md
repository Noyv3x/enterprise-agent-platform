# 自动更新

本文定义唯一 Docker 基线的发布、检测、排空、维护、提交、回滚和自动清理。部署拓扑见[部署](deployment.md)，持久目录见[数据布局](../reference/data-layout.md)。

## 目标

正常运维只需要向 `main` 推送通过质量门的提交。CI 产生不可变发布物，部署机 Manager 发现新 generation 后自行下载、排队、切换、验证、回滚和清理。普通更新不读取 Git remote、branch 或 working tree，也不需要登录部署机执行脚本。

当前安装器、Manager 和 CI 只接受一个 manifest schema、一个技术 profile 和一个线性 main 通道；发布协议没有阶段选择、部署回执或运行时身份转换分支。

## 发布通道

每个候选 main commit 都必须先通过完整 Quality（文档当前树、Python、Runtime、前端、Manager 和容器门禁）。自动 Container workflow 在构建前判定候选是否影响发布物；需要发布时仍执行以下完整流程：

1. 构建受支持架构的 Manager 与受管镜像；
2. 从同一精确镜像目录并行执行 AMD64、ARM64 匿名按 digest 拉取与容量验证和真实 AMD64 Compose 冒烟，发布只等待这些互不依赖的门禁汇合；
3. 组装唯一 `release.json`、Compose、安装器、Manager 工件及 sidecar；
4. 计算闭世界资产清单和 Actions provenance；
5. 创建不可变 `container-<40-hex-commit>` release；
6. 在全局 main-channel 锁内确认候选是当前公开 generation 的 Git 后代，再原子推进 latest。

候选级并发锁只去重同一完整 source commit 的构建／重放；最终 `publish` 独占 `container-channel-main` 通道全局锁，串行化不同 generation 对同一 latest 的提交。其它 workflow 不得修改 release visibility 或 latest；不能用候选锁代替通道锁。

自动发布的唯一跳过条件是：候选相对**当前已公开 generation**的累计差异只涉及明确列入白名单的、未打包的说明文件。白名单为根 `AGENTS.md`、根 `README.md`、`docs/README.md`，以及 `docs/design/`、`docs/reference/`、`docs/operations/`、`docs/development/`、`docs/decisions/` 下直接的普通 `.md` 文件。空差异也可跳过自动重放。不得按最近一次 push 或相邻提交判断，以免“产品改动发布失败后又提交文档”遗漏尚未发布的产品改动。

白名单之外一律执行完整发布，包括机器契约、域映射、脚本、工作流、测试、产品工作区及其 README／bundled Skill。禁止用 `*.md` 或 `docs/**` 泛化白名单。新增／删除与 rename 两端均须参与判断；符号链接、类型或异常 mode 变化不能被当作普通说明。未知合法路径需要发布；Git 差异读取失败、缺失历史、非法身份或非祖先关系必须失败，不能误报无需发布。资格判定没有公开基线时不能给出安全跳过；当前 prepare／publisher 仍必须取得经认证的现有公开 generation，查询缺失或失败即拒绝，不新增首发 bootstrap 或 API 错误回退。

白名单中的说明文件还必须是非可执行普通文件；控制字符等导致名称解释不明确的路径不得判为无需发布。

手工恢复入口仍是经过现有身份验证的明确强制发布／重放，不受自动说明文件跳过规则影响。跳过时不创建候选 release/tag、不构建或上传发布资产，不改变 latest；完整 Quality 证据照常保留。不引入另一套通道、manifest、部署协议或按镜像跨 generation 拼装机制。

较旧 workflow 后完成时不得降级 latest。连续 push 可以省略中间 deployment，但最新通过质量门且含尚未发布的发布物变化的 main 候选必须在队列收敛后自动成为 latest；只有说明变化的后代可以保留原 latest。相同 generation 的资产若已存在，只接受逐字节一致的幂等重放；任一内容、asset identity、tag commit 或 digest 漂移都失败关闭。

manifest 必须最后公开，部署机不能看到半套资产。品牌配置不是 release identity，不能改变 manifest URL、commit、digest、Manager 路径或更新幂等键。

发布中的 draft 通过认证的 release identity 和数字 ID 读取、上传及复验；公开的按 tag REST 查询只用于已经可见的 release，不能作为发现 draft 的前提。这样发布任务在上传前、上传后和最终公开后始终校验同一个 release 对象。

来源绑定以 GitHub API 的精确 repository、source commit、Quality run/attempt 与 Container run/attempt 为准。自动入口只接受同仓库 `main` push 的成功 Quality；手工恢复可使用对当前 `origin/main` 精确 HEAD 显式触发的 Quality，并在准备与通道提交前复验仍为远端 HEAD。`workflow_run` 自身 head 不代表候选，候选由上游 Quality 与 prepare 输出绑定；手工入口自身 head 必须等于候选。提交前的 Container run 应为 `in_progress` 且无 conclusion，不能要求正在发布的 run 已完成。

四个自有镜像构建输出只收敛一次为闭世界 `managed-images` 目录，双架构匿名 digest 拉取／压缩与展开容量门、真实 Compose 和最终 manifest 共用它。发布直接等待目录、两个架构门与 Compose 成功，不重新拼接原始 `image-*` 输出。中间 artifact 下载显式绑定当前 repository/run 与必需的镜像、Manager family；禁止全量 `*` 下载或混入 `.dockerbuild` 诊断记录，缺任一必需 family 即失败。同一 run 的全量重跑可覆盖同名中间 artifact，但不取得跨 run 来源授权。

最终资产目录排序后绑定精确名称、SHA-256 和字节数，并与 release ID、asset ID/digest/size、lightweight tag 和 source commit 一同复验。重放逐项比较本地字节、重新下载字节和 API identity；禁止 `--clobber`、未知或重名资产。main 提升前后都匿名复验全部受管镜像，并复读 release/tag/target commit、draft/latest 与资产身份；公开后的验证失败必须明确报告为已可见事故，不能声称未发布。安装器只运行同一 release 中校验过的 Manager 工件，Manager 更新不下载执行网络脚本；不另造 promotion workflow、自定义 provenance 文件或部署回执。

耗时的匿名拉取、下载和逐字节验证完成后，最终公开操作紧前必须再次核对同一 release 的资产身份/摘要、精确 source commit、Quality run/attempt 的成功状态，以及本次 Container run/attempt 的来源绑定。可观察到任何漂移都应在 draft 公开前拒绝；公开后的复验不能替代这一提交前边界。

创建候选 lightweight tag 后，GitHub 控制面可能短暂返回 ref 不存在。发布器只对该次写后读取执行秒级、有界退避；可见后仍须验证 tag 精确指向候选 commit，超过预算、读到其它对象或其它 commit 都失败关闭，不能跳过验证或无限等待。

GHCR 登录共用固定的有界动作：同一最小权限 `GITHUB_TOKEN` 最多三次、间隔短暂退避，全部失败则关闭发布；不得扩权、忽略错误或发布缺镜像的 generation。Firecrawl 构建直接读取 canonical 上游 URL、revision 与全部 `required_paths`，缺项即失败。

## 检测与预拉取

Manager 默认每分钟读取 latest manifest。轮询保留上一份成功响应的 `ETag` 与 `Last-Modified`，后续请求使用条件头；上游返回 `304 Not Modified` 时不重复解码或落盘，但若最近已接受的目标仍不同于 Current 且上一次 operation 未成功提交，必须继续以同一目标建立有界、幂等的重试，不能把 `modified=false` 当作“无需更新”。只有 Current 已等于目标、目标被明确判定为不可重试失败，或出现更新的合法 manifest 时才能清除这份待收敛目标。校验器只在相同 manifest URL、通道和技术 profile 下复用，配置变化、无验证器响应或临时网络失败不会把未知内容当作未变化。

管理面板的“上次更新成功时间”读取 Manager 当前 generation 持久化的 `activated_at`，Platform 只做只读投影，不另建更新历史或以浏览器时间猜测。回滚后该值仍是被恢复 generation 原本成功启用的时间。

当前基线不依赖中心推送服务或逐部署 webhook secret；公开安装实例无需把地址和凭据登记到上游。检查可以刷新候选，但不创建更新 operation、不安装或切换 Current。候选必须满足：

- schema、protocol、技术 profile 与镜像键集合精确匹配当前契约；
- source commit 是 40 位小写十六进制，并且不是 current 的降级；
- Manager/Compose URL 使用 HTTPS 或精确回环 HTTP，无凭据、query 或 fragment；
- Manager version 等于 source commit，工件 basename、SHA-256 与只读 `version` 输出一致；
- Compose 和所有镜像都由完整 digest 固定。

候选数据库 schema 不得低于 Current 的已提交版本。该比较在接受候选前执行，并在实际更新进入预拉取、Manager 准备或维护之前复验；显式 rollback 继续使用它自己的已验证快照恢复语义。相同 schema 的 Git 先后关系仍由既有发布通道证明，不按 commit 字符串或构建时间猜测。

`/v1/check` 校验、保存 manifest 并可刷新持久 Candidate，但不开始安装或 generation 切换。容量受限的进程内结果缓存只在条目保留期间将幂等键绑定到精确 `manifest_url`：命中直接复用已选定结果，同键不同 URL 返回 `409`；缓存判定、候选刷新与结果选择在同一检查串行边界内完成，命中、冲突和并发同键请求不得重复候选变更。淘汰或重启即遗忘该检查的重放身份，后续即使用同键也是新检查；`reused` 只表示实际缓存命中。不建立独立持久 check journal、无限期 key 身份或 tombstone；该缓存不替代更新 operation 的耐久幂等所有权。

核心镜像在进入维护前预拉取。Manager 先检查本地 RepoDigest，本地已有精确 digest 时不访问 registry。拉取使用“无进展超时 + 较大的绝对上限”；有持续字节进展不会被固定四分钟墙钟中断。原始 registry 输出只用于有界、脱敏诊断，不递归写入长期错误。

预拉取前与切换前分别检查磁盘空间和 inode。空间不足是可重试失败，不进入维护；后续空间恢复后自动重试。

## 排队与维护

发现更新后先建立持久 operation。存在运行中或排队的 Agent job、审批、文件提交、浏览器接管、后台学习或其它已准入副作用时，状态为 `waiting_for_tasks`；Manager 不停止服务，也不领取新的更新所有权。

operation-first 的准入发布必须可恢复：若 operation 已耐久保存、state 所有权尚未提交时进程退出，重新打开 journal 只能在完整请求、精确 expected/next generation、唯一 pending 且尚未进入副作用阶段的证据闭合时补完同一 operation 的所有权。未知或冲突的孤立记录失败关闭，不能永久返回无人执行的 pending，也不能任意删除证据或自动重做已开始的操作。

达到自然空闲点后，Manager 用同一 operation id 取得 Platform reservation，并按顺序完成：

1. 关闭新业务准入，公共入口切换为维护页；
2. 等待已准入短操作退出；
3. 停止 current Platform writer 与需要切换的固定服务；
4. 建立并验证 generation 快照；
5. 由候选 Platform 的闭世界 entrypoint 规范化当前 baseline 声明的旧 Docker workspace mountpoint，立即降回部署 UID/GID并运行候选数据库迁移；没有匹配残留时兼容步骤无副作用；
6. 启动候选核心服务并探测；
7. 必要时激活候选 Manager；
8. 原子提交 Current、结算 reservation、恢复入口；
9. 在后台收敛可降级能力并执行维护清理。

任何时刻最多一个可写 Platform writer。`maintenance=true`、operation phase、Current/Candidate 与快照身份全部持久化；Manager 或宿主重启后只重放同一 operation，不开启第二次更新。

## 提交、回滚与能力降级

核心提交门只有 Manager、Platform、Agent Runtime 和公共入口。Camoufox、SearXNG 与 Firecrawl 单项失败记录为 degraded，并由后台指数退避恢复；不得让已经健康的核心 generation 长期停在维护页。用户工作区里的 MCP server 不属于更新 readiness，也不能阻止 generation 提交。

数据库迁移、核心启动或核心 readiness 在提交前失败时，Manager 停止候选、恢复快照和 previous generation、结算 reservation，并把 operation 标为可重试失败。直接 baseline 兼容步骤对旧 Docker 空 mountpoint 的 owner/mode 收紧是单调且与旧 generation 兼容的 workspace 变更，不属于 SQLite 快照，也不在失败回滚时反向放宽；其余数据库与 sidecar 仍按快照边界恢复。提交后的业务数据不得自动回滚到可能已经分叉的 previous 数据；后续恢复使用新的快照 operation。

operation 终态与 Manager state 的半提交窗口必须幂等收敛：

- failed 已落盘但 active id 未清除时只完成失败收尾；
- Current 已提交但 finalize 未完成时保持维护并重试核心探针与 Gate 结算；
- operation 已 finalized 但 pending state 尚未清除时重放同一幂等结算，再清引用；
- 不可恢复错误保持 Manager control 与维护页在线，不形成 systemd 崩溃循环。

模型目录与自动推荐的变化不构成数据库迁移。更新必须逐字保留所有非空的明确模型选择和空字符串表示的自动状态；Runtime 历史缓存中由旧实现写入的任一 OAuth provider 默认值只在重新装载目录时归一化，不能据此改写生产设置、账号或会话。部署机不需要为目录更新执行人工数据操作。

## Manager 自更新

Manager 使用不可变版本目录、Candidate/Activation、独立 user-systemd watchdog 和原子 Current/Previous 更新自身。watchdog 不属于 Manager 主 unit 的 cgroup；它验证候选进程 inode与认证 identity，成功后提交，失败则恢复 previous stable 并清除可自动激活的 Candidate。

fresh install 是独立边界：安装器刚写入并启动的 stable Manager 若与 manifest Manager 的 version 和 SHA-256 完全一致，Manager 直接把它登记为初始 Current，并跳过 Candidate、Activation、watchdog 与主 unit 重启。不得为同一字节制造无法区分的 Current/Candidate。

普通更新只有在候选 SHA-256 不同于 Current 时才创建 activation plan。plan 从首次落盘起必须绑定 candidate path、SHA-256、version、Platform commit、previous path、unit 与 control socket；不接受缺字段、推断补写或历史格式。pending Candidate 在 watchdog 提交前只开放认证 identity 路由，提交后才开放完整 control API。

Manager 自更新失败时，previous Manager 恢复并由原 Platform operation 完成回滚或失败收尾。只有 control socket 因已知 Manager 启动缺陷持续不可达时，才使用部署文档的受控 `recover-current`；普通 release 不能声称能自动修复一个无法运行的更新控制器。

## 自动清理

清理只在 `idle`、`maintenance=false` 且无 active/finalize operation 时运行。Manager 从 Current、Previous、active operation、快照、Sandbox registry、容器和 activation/recovery journal 计算保护集合，然后精确清理：

- 超过保留期且未被引用的 release 目录与下载 staging；
- 未被 Current/Previous/Candidate 引用的 Manager version；
- 超过策略的终态 operation journal 与普通快照；
- 已过宽限且身份完整的原子写临时文件；
- 没有容器引用、带精确受管 label 的旧镜像；
- 已停止且超过保留期的无用受管容器与空网络资源。

删除前重新校验 owner、类型、link count、路径、inode、label、digest 和保护 epoch；状态变化即保留。清理按小批次执行并记录有界错误，一类失败不阻止其它独立类别。禁止 `docker system prune`、全局 image/volume/network prune、通配删除或触碰无法证明由本部署拥有的对象。

递归目录清理必须保留发现时的目录/条目身份，在取得 removal guard 后用固定父目录和候选 fd 复验同一对象，并只相对这些 fd 删除已经验证的条目。不能在 guard 之后重新按可替换路径执行 `RemoveAll`；新对象、未知条目和身份漂移必须保留。

Docker 空间达到预警阈值时，Manager 优先运行安全清理，再决定是否预拉取新版本；仍不足则保持 current 服务并报告可重试空间错误。日志按大小和数量轮转。

## 验证门

安装、真实 user-systemd、任务排空、迁移／回滚／phase 恢复、能力降级、清理及累计发布／通道竞态的验收统一由[测试与验证](../development/testing.md#部署与冒烟)定义。本地全量门禁不替代同一候选的真实发布门禁。
