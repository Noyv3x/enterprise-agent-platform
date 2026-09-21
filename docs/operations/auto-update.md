# 自动更新

唯一当前 schema／技术 profile／main 通道，无历史解码、部署回执、第二提升协议或跨 generation 拼装。Manager 自动检测、切换和恢复，不依赖部署机 Git、中心推送或 webhook secret。安装见[部署](deployment.md)，持久边界见[数据布局](../reference/data-layout.md)。

## 发布通道

### 发布资格

所有候选先通过**完整 Quality**（当前树文档、Python、Runtime、前端、Manager、容器），跳过发布也保留证据。

自动跳过只允许相对**当前已公开 generation**的累计差异为空，或全部为下列未打包、非可执行的普通说明文件：

- 根 `AGENTS.md`、根 `README.md`、`docs/README.md`；
- `docs/design/`、`docs/reference/`、`docs/operations/`、`docs/development/`、`docs/decisions/` 下**直接**的普通 `.md` 文件。

不能按最近 push／相邻提交判断，不能泛化为 `*.md`／`docs/**`。新增、删除、rename 两端都参与；symlink、类型／异常 mode 变化、控制字符等歧义路径不能跳过。其它路径一律完整发布，包括未知合法路径、JSON／机器契约／域映射、代码、脚本、工作流、测试、产品工作区 README、bundled Skill。

Git 差异失败、缺历史、非法身份、非祖先关系必须失败。prepare／publisher 必须取得经认证的**现有公开 generation**；缺失、无效、查询失败即拒绝，无首发 bootstrap／API 错误回退。跳过不建 release/tag、不构建上传、不改 latest。

手工强制发布／重放不受自动跳过限制，但必须经身份验证：Quality 对当前 `origin/main` 精确 HEAD 显式触发，准备和通道提交前复验仍为远端 HEAD。

### 构建与工件封存

| 边界 | 证据 |
| --- | --- |
| 来源 | GitHub API 的精确 repository、commit、Quality run/attempt、Container run/attempt。自动仅同仓库 `main` push 的成功 Quality；候选绑定上游 Quality／prepare 输出，不用 `workflow_run` 自身 head。手工入口 head 等于候选；提交中的 Container run 为 `in_progress`、无 conclusion。 |
| 目录 | 四自有镜像一次收敛成闭世界 `managed-images`，双架构门、Compose、manifest 共用，不重拼 `image-*`。artifact 下载限定当前 repository/run、必需镜像／Manager family；禁全量 `*`／`.dockerbuild`，缺 family 失败。同 run 重跑可覆盖中间物，不授权跨 run。 |
| 门禁 | Manager／镜像构建后，并行通过 AMD64、ARM64 匿名按 digest 拉取及压缩／展开容量门、真实 AMD64 Compose；发布等同一目录和三门汇合。真实 Compose／user-systemd 与本地全量门禁不可互替，命令见[部署与冒烟](../development/testing.md#部署与冒烟)。 |
| 清单 | 固定 commit、数据库版本、Manager/Compose SHA-256、全部镜像 digest；资产按名称排序绑定 SHA-256／字节数及 Actions provenance。不执行 manifest shell、不用 mutable tag。 |

**八公开资产：** `release.json`、`agent-platform-compose.yaml`、`install.sh`、`install.sh.sha256`、`agent-platform-manager-linux-amd64`、`agent-platform-manager-linux-amd64.sha256`、`agent-platform-manager-linux-arm64`、`agent-platform-manager-linux-arm64.sha256`。

**十镜像身份：** `platform`、`agent-runtime`、`camofox`、`agent-sandbox`、`searxng`、`firecrawl-api`、`firecrawl-playwright`、`firecrawl-postgres`、`firecrawl-redis`、`firecrawl-rabbitmq`。缺项、重复、额外／退役镜像、迁移描述符、profile 错配均拒绝；残留对象／journal 不能复活退役服务。

Firecrawl 构建直接读取[上游契约](../contracts/upstream-sources.json)的 URL、revision、全部 `required_paths`，缺项失败。GHCR 登录限同一最小权限 `GITHUB_TOKEN`、最多三次短退避；失败关闭，不扩权／漏镜像。

### 通道提交

1. 候选锁仅去重同完整 commit；`publish` 独占全局 `container-channel-main`，只有该 workflow 改 visibility/latest。
2. draft 按认证 identity／数字 release ID 读取、上传、复验，公开按 tag REST 只查已可见 release。lightweight tag 必须精确指向候选；创建后 ref 暂缺只允许该次写后读取的秒级有界退避，超时／对象或 commit 不符拒绝。
3. 封存绑定 release ID、asset ID/digest/size、tag、commit。重放逐项比较本地／重新下载字节和 API identity；漂移、未知／重名资产拒绝，禁 `--clobber`。
4. 公开前匿名复验全部镜像，复读 release/tag/target commit、draft/latest、资产身份。耗时检查后、公开**紧前**再核同 release 资产身份／摘要、commit、成功 Quality run/attempt、本次 Container run/attempt；漂移必须在公开前拒绝，不能靠事后复验。
5. 确认候选为当前公开 generation 的 Git 后代后，最后公开 manifest 并原子推进 `container-<40-hex-commit>` 的 latest，不暴露半套资产。公开后再次匿名复验全部镜像并复读 release/tag/target commit、draft/latest、资产身份；失败必须报“已可见事故”。
6. 旧 workflow 后完成不能降级 latest。可略过中间部署，但队列收敛后最新合格且含未发布产品变更的候选必须成为 latest；纯说明后代可保留原 latest。

品牌不改 URL、commit、digest、Manager 路径、幂等键。安装器只运行同 release 已校验 Manager；更新不下载执行网络脚本。

## 检测与预拉取

轮询见[配置](../reference/configuration.md)。仅同 manifest URL／通道／profile 复用成功响应的 `ETag`／`Last-Modified`；配置变更、无验证器响应、网络失败不表示未变化。`304` 只免解码落盘：目标未提交且异于 Current，仍同目标有界幂等重试；仅 Current 相等、明确不可重试或新合法 manifest 清除旧目标。“上次更新成功时间”只投影 Current 的 `activated_at`，回滚保留原值。

候选接受前及预拉取／Manager 准备／维护前均复验：当前 schema/protocol/profile／镜像闭集；40 位小写 hex commit 不降级；Manager/Compose URL 仅 HTTPS／精确回环 HTTP，无凭据/query/fragment；Manager version=commit，basename/SHA-256/只读 `version` 一致，Compose 校验和／镜像 digest 固定。DB schema 不低于 Current；同 schema 顺序由发布通道证明，不猜字符串／时间；显式 rollback 走验证快照。

`/v1/check` **可保存 manifest／持久 Candidate，不建 update operation、不安装／切换**。容量有界的内存缓存仅在条目保留期间绑定 key→精确 `manifest_url`：命中复用结果，异 URL `409`；缓存判定、Candidate 刷新、结果选择共用串行边界，命中／冲突／并发同键不重复变更。淘汰／重启后同键是新检查，`reused` 仅实际命中；无持久 check journal、无限 key／tombstone，不替代 operation 耐久幂等。

维护前仅预拉 Platform／Runtime，精确本地 RepoDigest 命中不访问 registry。拉取同时受无进展期限／较大绝对上限约束，持续进展不被固定短墙钟截断；原始输出只刷新内存进展，长期 state／日志仅有界脱敏诊断。能力／Sandbox 另走受限拉取路径。预拉取前／切换前查空间和 inode；不足或超时可重试，不开维护、保留 Current，条件恢复后重试。

## 排队与维护

所有 install/update/restart/rollback/repair 带 key、expected generation、耐久 phase。先核不可变请求指纹再判 generation：原样重放只观察原 operation，同键异请求拒绝，永不产生第二 owner。空／截断／超限／非法 2xx 以原 key／journal 对账，不能当成功或认定 mutation 未执行。

先存 operation 再发 state 所有权；中间崩溃仅以完整请求、精确 expected/next generation、唯一 pending、尚无副作用的闭合证据补同一 owner。冲突／未知孤立记录拒绝，不删证据、不留无人执行 pending、不重做副作用。

运行／排队 job、审批、文件提交、浏览器接管、后台学习等副作用存在时保持 `waiting_for_tasks`，不停服务／另取 owner。自然空闲后：

1. 同 id reserve → 耐久 `maintenance=true` → 同 id 再 reserve；关新准入、入口维护、等短操作退出后才破坏性操作。不确定响应仅明确 release 可解除；Manager 不可达／身份不符则管理写失败关闭。
2. 停 current writer／需切固定服务，验证 generation 快照，再[固定迁移](deployment.md#发布物启动与健康)。只有[受控迁移](../reference/data-layout.md#受控迁移)例外，普通 operation 不搜历史库存／扩大读写。
3. 启候选、纯读核心探测、必要时激活 Manager；原子提交 Current、结算 reservation 才恢复入口。Platform 先恢复持久预约再启副作用 worker，候选全部后台 worker 冻结到明确 release。
4. 后台恢复能力、安全清理。

始终最多一个可写 Platform；maintenance、phase、Current/Candidate、快照身份耐久。重启按同 journal／精确 ownership label 对账，不猜容器名或新开更新。

## 提交、回滚与能力降级

核心仅 Manager 控制面、Platform、Runtime、公共入口。Camoufox／SearXNG／Firecrawl 失败 degraded、指数退避恢复，不拖住健康核心；workspace MCP 不参与。候选纯读验证 workspace／marker／Runtime alias／Camoufox sidecar 从启动即满足 current schema；缺失、未物化、旧格式、漂移拒绝，普通更新不修复。

快照验证、核心 readiness、必要 watchdog 提交和 reservation release 全部完成才开放业务：

- `commit-release`／`abort-release` 独立认证，JSON 限大并拒绝重复／未知字段／尾随值。commit 仅普通更新 watchdog 耐久确认候选后；abort 只恢复准入，失败／取消／restart／repair／rollback 无 schema commit。
- 首次 Gate action 与 `Finalized=true` 同写；install/update 仅 watchdog 确認候选才记 commit，无 SelfUpdate 记实际 abort，非 generation 不记 commit。
- `gate_settlement` 只投影同锁 state/finalize 快照；缺失／损坏／错位拒绝，不猜 Current／maintenance／旧 journal。Gate 成功未清 state 时先重放同种幂等结算再清引用，不重复 SelfUpdate。

| 失败点 | 收敛 |
| --- | --- |
| 提交前迁移／核心失败 | 停候选、恢复快照／Previous、结算预约，记可重试失败；旧 mountpoint 收紧不反向放宽，其它 DB／sidecar 按快照，见受控迁移。 |
| Current 已提交、未 finalize | 保持维护，重试核心探针／Gate；新业务可能分叉，不自动倒退 previous 数据，后续恢复须新快照 operation。 |
| failed 已存、active id 未清 | 只补失败收尾。 |
| finalized 已存、pending 未清 | 重放原 Gate 再清引用。 |
| 不可恢复 | control／维护页保持在线，不 systemd 崩溃循环。 |

readiness 失败在删候选前依次取 healthcheck／有界日志；替换精确 Manager capability／通用凭据后截断，采集失败不阻回滚。外部错误入 state／operation／activation 前限大，重试仅替换最近失败、不递归拼接；control 仅有界诊断。

`/v1/status` 不得投影 manifest、快照或任何其它宿主绝对路径。

模型目录／推荐不迁移：逐字保留非空明确选择／空字符串自动状态；旧 Runtime 历史缓存 OAuth 默认仅重载目录时归一化，不改生产设置／账号／会话、不需人工修数。

## Manager 自更新

不可变版本、Candidate/Activation、原子 Current/Previous 由**主 unit cgroup 外的 user-systemd watchdog**唯一持久拥有。它验候选 inode／认证 identity，成功提交；失败恢复 previous stable、清自动激活 Candidate，原 Platform operation 回滚／收尾。

fresh stable 与 manifest version/SHA-256 一致即登记初始 Current，不造同字节 Candidate／Activation、不跑 watchdog／重启 unit。普通更新仅 SHA 改变才建 plan；首写绑定 candidate path、SHA、version、Platform commit、previous path、unit、socket。

`candidate_path`／`platform_commit` 在启动／回滚／接管／终态均匹配已验证 Candidate／Activation／Platform generation；缺失、漂移、推断补写、历史格式拒绝，终态删字段仍篡改。接管／watchdog／回滚／recovery 保留原 plan 字节哈希／完整身份链。watchdog 原子提交前只开认证 `/v1/identity`，status／executor／mutation 关闭，提交后完整 API。

## 恢复身份

`recover-current` 仅用于[部署故障表](deployment.md#日常管理)的控制器不可用；release 不能自动修复无法运行的 Manager。锁、零副作用检查、socket、probe 权限见[安全设计](../design/security-and-trust.md)。以下证据必须闭合，否则拒绝：

| 边界 | 条件 |
| --- | --- |
| takeover 耐久 | 即使 unit 未禁用也生效。`watchdog_owned` 前归外部恢复；之后仅 journal／recovery plan／state／stable／运行 inode 同事务 Candidate 可完整 acknowledge，重启与外部持锁规则相同。有效终态 journal 不永久依赖已合法清理的旧 version／operation／manifest。 |
| 终态 finalize 证明 | manifest commit + 当前架构完整 Manager SHA 唯一确定 journal；transaction、受管路径、manifest/operation 原始摘要、原 Candidate、superseded 普通 plan、committed recovery plan 双向闭合，只读验证。 |
| 健康 Current 接力 | 仅同一未结算 finalize，且 Current／stable／运行 inode／metadata 一致、Previous 精确为 journal 提交的 recovery Current；否则停服务前拒绝，不改历史证据。 |
| stable 先于 state | 仅外部 recovery lock 忙、旧 state 匹配 committed journal、新 stable／运行 inode／受管 recovery 工件／metadata 同 SHA/version 时进入 identity-only probe；锁空闲、rolled-back、身份缺口拒绝。 |
| 外部锁忙、无非终态 journal | 仅精确匹配 stable 的登记 Current／受管 recovery 工件可进入 `external_recovery_probe`。外部锁释放后重新取得 lease，证明运行 inode 已是原子登记、无 Candidate/Activation 的 Current；未登记 recovery 必须退出。 |
| journal 竞争 | mutation flock 不等待；只有外部全局锁仍持有时，才用稳定双快照处理短暂竞争。 |
| 无 journal Candidate-only | 当前 Platform state、唯一 live install/update、不可变 manifest、非终态 plan 完整证明本代 Prepare/Mark checkpoint；ownerless／终态拒绝。 |
| 普通半 checkpoint | rollback plan-first／commit state-first 仅完整反向绑定可补齐，不凭路径／单一 SHA。rollback 逐项验证 Candidate version/source/SHA/verified/platform-commit、精确受管 binary path、精确 activation plan path；格式无效但 hash 可读的工件也不能补写终态。 |

## 自动清理

仅 `idle`、非维护、无 active/finalize operation；保护集来自 Current/Previous/Candidate、operation／快照、Sandbox registry、容器、activation/recovery journal。只清未引用过期 release／staging／Manager version／终态 operation／普通快照、过宽限安全原子临时文件、无消费者且精确受管 label 的旧镜像、过期已停容器／空网络。

operation 须超过七天且保留最新 `128` 条；pending/running、未 finalized、无有效 `completed_at`、active/finalize 引用保护，不读写／删除 recovery/activation 审计。未知项、坏 JSON、身份／权限／inode 异常、父目录 fsync 失败关闭。

删除点复核 owner、类型、link count、路径、inode、label、digest、保护 epoch。递归清理保留发现身份，在 removal guard 内用固定父／候选 fd 复验并相对 fd 删除；禁重新按路径 `RemoveAll`，新对象／未知项／漂移保留。小批次、有界错误，一域失败不跳独立域；禁全局 prune、通配或归属不明删除。

空间预警先安全清理，仍不足保留 Current、报可重试错误；日志按大小／数量轮转。其余阈值见[容器契约](../contracts/container-platform.json)，验收见[测试与验证](../development/testing.md#部署与冒烟)。
