# 自动更新

本文定义 Docker 发布物的检测、准入、维护、提交和回滚协议。部署拓扑见[部署](deployment.md)，状态目录见[数据布局](../reference/data-layout.md)。

## 更新真相源

迁移完成后管理器是唯一更新控制器。部署机不再读取 Git remote、branch 或 working tree；main 通道发布清单是唯一版本目录，实际运行身份是清单中完整镜像 digest 的集合。

CI 只有在文档门禁、Python/Runtime/前端/管理器测试、镜像构建、上游契约验证和真实 Compose smoke test全部成功后才发布清单。每个进入 `main` 的提交都有独立、不被后续 push 取消或替换的质量与 release generation，使已经拉取某个桥接提交的源码部署最终一定能取得对应 `container-<commit>` 发布物。发布清单必须最后出现，避免实例看到半套发布物。不可变 release 与 main 通道提升分成两个作业：前者可以并行，后者在全仓库唯一的 promotion 锁内比较当前 latest commit 与候选的 Git 祖先关系，只允许向后代单调前进。较旧 workflow 即使稍后完成，也只能公开不可变 commit release并显式排除出 `latest`，不能改写通道或触发降级；较新的 main 提交尚未通过质量门时，通道仍可提升到最近一个已经通过的祖先提交。

## 检测与预拉取

管理员可以启用 Manager 轮询或手工检查。迁移前已经配置的签名 Platform webhook 可以继续作为兼容触发器，但在容器模式下它只能向 Manager 提交一次 release channel 检查；不得启动 Git updater、读取 worktree 或执行 `deploy.sh`。发现比当前 generation 更新的清单后，管理器先校验协议、架构、磁盘与 digest，再在平台仍可使用时预拉取所有镜像。下载失败只记录候选错误，不进入维护。

本机 `releases/<source-commit>/` 也是不可变身份：Manager 必须先把 manifest 与 Compose 下载到同目录 staging，完整校验后原子发布。相同 commit 再次出现时，两个文件必须逐字节一致；缺件或内容不同视为 immutable-ID collision，并在拉镜像和进入维护前失败，不能覆盖 current/rollback 所引用的发布物。

源码自动更新在检测阶段得到完整 40 位 target commit 后，该 commit 就是本次事务的不可变目标。部署 worker 可以再次 fetch 以验证可达性，但必须只 fast-forward 到已检测的 commit；即使 remote branch 在检测与执行之间又推进，也不能追逐新 HEAD。marker 的 target/source revision、实际 checkout 和容器 release 必须始终一致，下一个 commit 由下一次事务处理。

镜像就绪后公开 state 进入 `waiting_for_tasks`。Platform 继续服务，直到确认没有活动 Agent Run、queued/running Agent job、消息或知识写入准入窗口、正在执行的 Cognee 摄取与 Telegram 外发、Manager 已登记的运行中后台终端或其它不可安全切换的业务任务。Manager 必须先检查本地 ProcessManager；只要 host 或 Sandbox 中任一已登记后台终端仍在运行（包括声明为 `terminate` 的进程），就保持 `waiting_for_tasks`、不请求 Platform reservation，并在本地进程清零后自动重试。只有本地检查通过后，Manager 才请求 Platform 在对话锁内原子复核 Agent 任务并建立 reservation。后台终端视为仍在运行的任务：Manager 不终止它，也不开始固定栈或自身更新；进程结束后排队的更新自动继续。如果目标版本要求重建该 Sandbox，则仍只在该 Sandbox 空闲后刷新镜像。

## 原子准入与维护

Platform 继续拥有业务空闲判断。管理器使用内部 token 请求 readiness/reserve，Platform 在对话锁内完成最后检查并建立 reservation。管理器收到首次成功响应后，必须立即把同一 operation 的 `maintenance=true` 持久化，再向 Platform 使用同一 operation id 重复 reserve 并取得确认；在第二次确认之前不得停止 Platform、快照或迁移。这使源码 Platform 恰好在两次请求之间重启时，能先从 Manager 恢复持久维护状态，然后由第二次 reserve 重新建立进程内准入栅栏。

任一 reserve 请求如果响应丢失或返回不确定错误，Manager 必须对同一 operation 尝试 release；只有 release 明确成功才能回到非维护失败状态。release 也失败时必须持久保持 `failed + maintenance=true`，等待恢复循环重试，不能假定 Platform 没有建立预约。`update/install`、`restart`和显式 `rollback` 都使用这一两阶段协议，且任何维护状态持久化失败都在破坏性操作前 fail closed。预约成功后所有新 Agent 消息在持久化/入队边界前收到维护响应，不存在已写消息却未建 job 的窗口。每个容器 Platform 进程必须在启动任何 Agent、知识摄取、计划任务或 Telegram worker 前，从 Manager owner socket 恢复当前持久 maintenance/finalize reservation 及其 operation id；Manager 状态不可读时容器启动失败，不能把未知状态解释为空闲。只有 Manager 对同一 operation 明确 release 后才恢复这些 worker；如果源码 marker 此时又进入阻断态，Platform 必须先重新同步 marker，不能在 Manager owner 释放和 marker owner 建立之间短暂唤醒 worker。

管理器随后切换入口到维护、排空写请求并停止旧 Platform。公开状态保持：

- `idle`：当前 generation 正常；
- `waiting_for_tasks`：候选已准备，仍允许使用；
- `updating`：维护生效，正在切换；
- `failed`：无法安全恢复，继续维护并等待 CLI 修复。

内部 operation 为 install、update、restart、rollback、repair；phase 为 validating、pulling、preparing、draining、snapshotting、migrating、starting、probing、committing 或 rolling_back。operation journal、当前/目标/上一 generation、心跳和错误写入管理器状态根并原子 fsync。

## 更新事务

进入维护后的顺序固定为：

1. 锁定 operation 与目标发布清单；
2. 停止旧可写 Platform，确认没有第二个数据库 writer；
3. 对需要迁移的 SQLite 和 sidecar 建立一致快照并记录文件迁移计划；
4. 执行版本化、事务化数据库和文件迁移；
5. 启动目标固定服务并探测 readiness；
6. 更新 manager current/previous generation；
7. 若为源码首迁，在同一 reservation 下完成并持久化旧部署恢复归档、旧 Compose/源码清理与 live-data cache 退役；
8. 所有 finalize cleanup 均已成功且持久化后，最后清除 reservation 并恢复入口；
9. 在各 Sandbox 空闲时独立刷新其基础镜像。

Platform、Runtime、Camoufox 与 SearXNG 属于核心 readiness；Firecrawl/Cognee 默认只影响对应能力。目标发布可以显式提高迁移所依赖服务的门禁，但不能在部署机临时猜测。

## 回滚与恢复

新 generation readiness 失败时，管理器停止候选容器，恢复上一份 digest 清单；数据库已升级时先恢复对应快照和 sidecar 状态，再启动旧 Platform。快照创建只有在内容和 manifest 全部同步、并且新快照目录的父目录也完成同步后才能向 operation journal 返回成功。快照恢复必须先完整验证所有类型、大小与 hash，并在独立 staging 中准备完整结果，再以可补偿的原子切换替换数据库、WAL 和 SHM；任何校验、复制或切换失败都必须保持恢复前数据逐字节不变或同步补偿回来，不能留下缺失或混合代际。回滚也必须通过完整核心 readiness 才能解除维护。

每次显式 rollback 都先保存当前 generation 的一致快照。交换 current/previous 后，这份新快照必须绑定到新的 current，作为下一次反向 rollback 的恢复源；连续 A→B→A→B 回滚必须始终同时交换镜像 generation 与对应数据 generation，不能把快照绑定到新的 previous。

管理器在每个 phase 被 SIGKILL、宿主重启或 Docker 重启后，从 operation journal 判断下一步；无法证明数据库和容器 generation 一致时保持 `failed`，不能开放产品。数据库迁移 one-off 容器必须使用确定名称、Manager ownership label 和 Compose project label；所有正常停止、失败回滚和启动恢复都先按这两个 label 强制停止并删除遗留迁移容器，复查不存在后才可恢复 SQLite 快照或启动任一 Platform writer。回滚失败不能把 operation 写成已完成或清除 active id：operation 必须持久停留在 `rolling_back`，入口保持维护，后台与重启恢复串行重试同一回滚；只有旧 generation 的数据恢复、启动、完整核心探针和预约释放全部成功后，才能把原 operation 记为失败终态并重新开放业务。`repair` 不能绕过仍待完成的回滚。

operation 终态与 Manager state 分两次原子写时，恢复必须显式收敛两个半提交窗口：`failed` 已写而 active id 尚未清除时只清理失败状态，绝不能重新执行；`succeeded/current` 已写而 finalize hooks 未完成时保持维护并从持久 `finalize_pending` 幂等补完 Manager activation、watchdog 健康确认、旧部署恢复归档校验与清理，确认这些 cleanup 的最终状态已经持久化后才允许释放预约，最后写 `finalized`。源码首迁的 Platform reservation 必须覆盖 archive、旧 Compose/checkout 清理和 live-data cache 退役全过程；任一 cleanup 或其状态落盘失败都保持 `finalize_pending`、maintenance 与 reservation，由重启恢复或后台循环幂等重试，不能先 release 后清理，也不能因重试形成永久死锁。`restart`、显式 `rollback` 与 `repair` 也必须先把成功结果写入 `finalize_pending`，只有对应 reservation 已确认释放后才能写 `finalized`、清除维护并开放入口；释放失败由重启恢复或后台循环重试，不能丢弃错误。跨进程补完 `succeeded` 半提交或 `finalize_pending` 前必须重新执行 Platform、Runtime、Camoufox、SearXNG 和公网入口的完整探针；容器仅处于 `running` 不构成 readiness，所有核心服务必须存在并报告 `healthy`。探针失败时继续保持持久维护，绝不能清理旧部署。旧部署破坏性清理必须发生在新 Manager watchdog 已提交 current 之后；activation 仅建立 intent 或新进程仅完成一次启动都不够。`repair` 只执行状态中声明的安全动作，不删除未知文件或伪造成功 marker。

管理器自更新使用版本目录、持久 activation intent、独立旧二进制 watchdog 和原子 current/previous 切换。新二进制必须先通过自检，读取并验证持久 operation journal，完成不依赖本次 watchdog 提交的 operation recovery，并成功绑定控制与公网监听、通过健康检查后才能向 watchdog 确认 current；`finalize_pending` 中依赖“新 Manager 已正式提交”的破坏性 hook 只能在 watchdog 提交后继续。崩溃、journal 不兼容或恢复失败由 watchdog 原子恢复上一二进制并重启服务。每个“写 intent、替换稳定二进制、确认、回退”的断电窗口都必须能够幂等收敛。

## 首次桥接

旧源码实例的 Git 更新与 Docker 首迁是两个连续但独立的事务。启动更新的 `deploy.sh` 能力由拉取前的提交决定；运行中的 Bash 在 Git fast-forward 后不会自动获得目标提交中新加入的函数。因此，从桥接功能出现前的版本升级时，第一次更新可以只安装并启动 bridge-capable 源码，不能假定同一个旧 shell 会继续调用新安装器。

已经具有第代桥接函数但尚未具有环境回滚保护的旧 shell，可能在目标 bootstrap 失败后把 `UBITECH_SOURCE_MIGRATION_BRIDGE` 和 Manager 路径误写回旧 service unit。目标 bootstrap 必须识别缺少当前桥接协议标识的调用者；如果这类 bootstrap 失败，在返回旧 shell 前先把 owner-only 回滚守护程序固化到 checkout 外。systemd 源码更新必须用新的独立 `systemd-run --user` transient unit 启动守护，不能只 `setsid` 后留在原更新 unit 的 cgroup 内；前台部署才可使用独立 session 子进程。守护程序等旧 shell 结束后删除 service unit 中的三个桥接环境项、daemon-reload 并重启已回滚源码，使其普通自动更新继续工作。当前 shell 必须显式传入协议标识，并在自己的 rollback 路径恢复原环境，不得依赖该兼容守护。

bridge-capable 源码启动后必须幂等检查当前部署是否仍需首迁。只要当前 checkout 同时包含受支持的容器契约和可执行安装器、仍处于源码部署且没有显式跳过迁移，它就把“容器首迁尚未交接”视为待处理更新；即使 `HEAD` 已等于 Git remote，也要通过既有空闲预约与独立 systemd worker 再运行当前版本的更新入口。已经进入桥接状态后的恢复只能调用不执行 fetch、merge、bootstrap 或 Git rollback 的迁移恢复入口，并继续使用 marker 绑定的 exact HEAD；不得借恢复机会取得更新提交。该自举不得依赖未来碰巧出现另一个 main 提交，也不得在缺少完整桥接资产时伪造成功。

旧源码的 `auto-update-state.json` 只描述 Git/源码事务，不是 Docker generation 的真相源。源码健康重启后，桥接更新先停止 heartbeat、解除业务维护并进入非阻塞的 `source_bridge_ready`；随后安装器结果按以下方式收敛：

- 返回 `75`：安装器已经持久化 owner-only retry service/timer，源码继续服务，旧 marker 记为 `container_migration_queued`；
- 返回其它非零值：不得回滚已经健康运行的源码或与可能已建立的 Manager journal 竞争，旧 marker 以非阻塞 `container_migration_failed` 保存退出码和错误，等待下一次受控修复；
- 返回 `0`：Manager install operation 已到 succeeded，之后由 Manager journal、`finalize_pending` 和恢复循环继续；旧 checkout 可能已经被归档，调用方不得再依赖其中的脚本或状态文件。

`source_bridge_ready` 不是完成态：如果原 bridge worker 在安装器返回前中断，新源码必须在确认旧 owner 已退出后，通过同一个 update id 和无 Git 恢复入口续跑。协调器的“需要启动”只依赖持久 handoff phase，不依赖启动瞬间能否取得 repository flock；真正恢复前才检查锁，因此新 Platform 在旧 updater 仍持锁时启动也不会永久丢失续跑机会。`container_migration_queued` 与 `container_migration_failed` 是 checkout 冻结态；普通或手工 Git update 都不得覆盖它们。retry 脚本必须在 checkout 之外以 owner-only 权限固化 update id、旧数据路径、exact HEAD 和可执行 Python 路径，不能依赖 transient systemd unit 的进程环境。一次 `75` 之后的永久失败必须把同一 marker 从 queued 单向收敛为 failed；继续返回 `75` 保持 queued，成功后完全交由 Manager journal。

`container_migration_failed` 不是需要手改 JSON 的死路。运维修复 Docker、systemd、网络或配置后，使用 `deploy.sh migrate-container --repair`：该入口必须持有 repository flock，从 marker 恢复同一 update id，核对 exact source revision，并只把 failed 回收为 `source_bridge_ready` 后重跑安装器。它不 fetch、不改变 checkout，普通 `migrate-container` 也不得隐式覆盖失败。

Git 回滚边界以持久 marker 为准，不以 helper 进程的最终退出码为准。如果 `source_bridge_ready`、`container_migration_queued` 或 `container_migration_failed` 已经为同一 update id 原子替换到目标文件，即使 helper 随后在权限收紧、目录 fsync 或进程退出时报错，调用方也必须重读 marker 并视为源码已提交，绝不得 Git reset。

完整迁移成功不能根据旧 marker 的 `phase=success`、安装器退出 `0` 或源码服务健康来推断；必须同时由 Manager 证明 current generation 已提交、operation 已 finalized、`finalize_pending` 为空且 maintenance 已解除。bridge intent 一旦建立，源码控制器停止 Git fetch/merge；它至多检查本地 marker 并运行无 Git 的迁移恢复入口，避免 checkout 越过已绑定的 exact `expected_source_commit`。Manager socket 在首迁期间暂不可用是预期状态：源码 Platform 的状态、配置与任务准入必须回退到旧 marker，只有容器部署才要求 Manager 状态不可读时 fail closed。

这样镜像构建速度不会把第一次 Git 更新长时间困在维护页：完整 release 尚未出现时，源码继续可用；发布物就绪后 Manager 再等待自然空闲并执行维护切换。

首迁安装器的 Manager 二进制和 checksum 下载必须同时设置有界的 connect timeout 与总时限。超时与其它下载失败使用同一持久 retry/timer 路径并返回 `75`；不能让半开连接在 timer 建立之前无限持有 repository flock。

桥接迁移成功并清理源码后，Git updater、dirty-tree、fast-forward 和 `git reset` 不再属于部署协议。仓库中的桥接兼容实现应在已部署实例完成迁移后的清理版本移除；新安装始终从管理器开始。

## 管理接口与测试

正常管理面板展示当前/目标版本、digest 摘要、operation、phase、下载与健康状态；失败恢复使用宿主 CLI。公共维护页只展示 operation id 和安全摘要。

测试至少覆盖预拉取失败、任务等待、消息准入竞态、重复 operation、并发冲突、每个 phase 断电、数据库快照恢复、Docker daemon 重启、管理器自更新失败、旧 generation 回滚、Sandbox 后台进程保留和维护入口连续可用。源码首迁还必须使用桥接功能加入前的真实旧脚本发起更新，证明第一次只安装新源码后，无 Git revision 差异也会由新源码再次触发当前桥接入口；用已经包含桥接函数的脚本伪装旧版本不构成该回归测试。
