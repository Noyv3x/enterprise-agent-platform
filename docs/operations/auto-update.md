# 自动更新

本文定义唯一 Docker 基线的发布、检测、排空、维护、提交、回滚和自动清理。部署拓扑见[部署](deployment.md)，持久目录见[数据布局](../reference/data-layout.md)。

## 目标

正常运维只需要向 `main` 推送通过质量门的提交。CI 产生不可变发布物，部署机 Manager 发现新 generation 后自行下载、排队、切换、验证、回滚和清理。普通更新不读取 Git remote、branch 或 working tree，也不需要登录部署机执行脚本。

当前安装器、Manager 和 CI 只接受一个 manifest schema、一个技术 profile 和一个线性 main 通道；发布协议没有阶段选择、部署回执或运行时身份转换分支。

## 发布通道

每个可发布的 main commit 必须先通过文档同步、Python、Runtime、前端、Manager 和容器门禁。Container workflow 随后：

1. 构建受支持架构的 Manager 与受管镜像；
2. 验证镜像可匿名按 digest 拉取、容量上限和真实 Compose 冒烟；
3. 组装唯一 `release.json`、Compose、安装器、Manager 工件及 sidecar；
4. 计算闭世界资产清单和 Actions provenance；
5. 创建不可变 `container-<40-hex-commit>` release；
6. 在全局 main-channel 锁内确认候选是当前公开 generation 的 Git 后代，再原子推进 latest。

较旧 workflow 后完成时不得降级 latest。连续 push 可以省略中间 deployment，但最新通过质量门的 main head 必须在队列收敛后自动成为 latest。相同 generation 的资产若已存在，只接受逐字节一致的幂等重放；任一内容、asset identity、tag commit 或 digest 漂移都失败关闭。

manifest 必须最后公开，部署机不能看到半套资产。品牌配置不是 release identity，不能改变 manifest URL、commit、digest、Manager 路径或更新幂等键。

## 检测与预拉取

Manager 定时读取 latest manifest，也可由签名 webhook 唤醒。检查阶段只做纯读验证；没有更新时不创建 operation。候选必须满足：

- schema、protocol、技术 profile 与镜像键集合精确匹配当前契约；
- source commit 是 40 位小写十六进制，并且不是 current 的降级；
- Manager/Compose URL 使用 HTTPS 或精确回环 HTTP，无凭据、query 或 fragment；
- Manager version 等于 source commit，工件 basename、SHA-256 与只读 `version` 输出一致；
- Compose 和所有镜像都由完整 digest 固定。

核心镜像在进入维护前预拉取。Manager 先检查本地 RepoDigest，本地已有精确 digest 时不访问 registry。拉取使用“无进展超时 + 较大的绝对上限”；有持续字节进展不会被固定四分钟墙钟中断。原始 registry 输出只用于有界、脱敏诊断，不递归写入长期错误。

预拉取前与切换前分别检查磁盘空间和 inode。空间不足是可重试失败，不进入维护；后续空间恢复后自动重试。

## 排队与维护

发现更新后先建立持久 operation。存在运行中或排队的 Agent job、审批、文件提交、浏览器接管、后台学习或其它已准入副作用时，状态为 `waiting_for_tasks`；Manager 不停止服务，也不领取新的更新所有权。

达到自然空闲点后，Manager 用同一 operation id 取得 Platform reservation，并按顺序完成：

1. 关闭新业务准入，公共入口切换为维护页；
2. 等待已准入短操作退出；
3. 停止 current Platform writer 与需要切换的固定服务；
4. 建立并验证 generation 快照；
5. 运行候选数据库迁移；
6. 启动候选核心服务并探测；
7. 必要时激活候选 Manager；
8. 原子提交 Current、结算 reservation、恢复入口；
9. 在后台收敛可降级能力并执行维护清理。

任何时刻最多一个可写 Platform writer。`maintenance=true`、operation phase、Current/Candidate 与快照身份全部持久化；Manager 或宿主重启后只重放同一 operation，不开启第二次更新。

## 提交、回滚与能力降级

核心提交门只有 Manager、Platform、Agent Runtime 和公共入口。Camoufox、SearXNG、Firecrawl 与 Cognee 单项失败记录为 degraded，并由后台指数退避恢复；不得让已经健康的核心 generation 长期停在维护页。

数据库迁移、核心启动或核心 readiness 在提交前失败时，Manager 停止候选、恢复快照和 previous generation、结算 reservation，并把 operation 标为可重试失败。提交后的业务数据不得自动回滚到可能已经分叉的 previous 数据；后续恢复使用新的快照 operation。

operation 终态与 Manager state 的半提交窗口必须幂等收敛：

- failed 已落盘但 active id 未清除时只完成失败收尾；
- Current 已提交但 finalize 未完成时保持维护并重试核心探针与 Gate 结算；
- operation 已 finalized 但 pending state 尚未清除时重放同一幂等结算，再清引用；
- 不可恢复错误保持 Manager control 与维护页在线，不形成 systemd 崩溃循环。

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

Docker 空间达到预警阈值时，Manager 优先运行安全清理，再决定是否预拉取新版本；仍不足则保持 current 服务并报告可重试空间错误。日志按大小和数量轮转。

## 验证门

发布前至少验证：

- 发布组装器由 `python3` 显式调用，不依赖源码文件的可执行位；
- 全新数据根安装，其中 stable Manager 与 manifest 候选同摘要时不创建 activation；
- 一个普通 Manager 不同摘要自更新在真实 user-systemd 下提交和回滚；
- 多个正常任务跨过轮询周期时更新保持排队，空闲后自动继续；
- 数据库迁移成功、失败、外键回滚和各持久 phase 重启恢复；
- 核心 registry 无进展、ENOSPC、核心 readiness 与响应丢失；
- Firecrawl 等能力不可用时核心 generation 仍提交，能力恢复后自行健康；
- Current/Previous 快照往返回滚；
- 受保护对象永不删除，未引用 release、镜像、临时文件和终态 journal 会在保留期后自动回收；
- 快速连续 main push 最终把 latest 与部署机收敛到最新合格 generation。
