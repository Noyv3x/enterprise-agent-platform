# 自动更新

本文定义 Docker 发布物的检测、准入、维护、提交和回滚协议。部署拓扑见[部署](deployment.md)，状态目录见[数据布局](../reference/data-layout.md)。

## 更新真相源

迁移完成后管理器是唯一更新控制器。部署机不再读取 Git remote、branch 或 working tree；main 通道发布清单是唯一版本目录，实际运行身份是清单中完整镜像 digest 的集合。

CI 只有在文档门禁、Python/Runtime/前端/管理器测试、镜像构建、上游契约验证和真实 Compose smoke test全部成功后才发布清单。每个进入 `main` 的提交都有独立、不被后续 push 取消或替换的质量与 release generation，使已经拉取某个桥接提交的源码部署最终一定能取得对应 `container-<commit>` 发布物。发布清单必须最后出现，避免实例看到半套发布物。不可变 release 与 main 通道提升分成两个作业：前者可以并行，后者在全仓库唯一的 promotion 锁内比较当前 latest commit 与候选的 Git 祖先关系，只允许向后代单调前进。较旧 workflow 即使稍后完成，也只能公开不可变 commit release并显式排除出 `latest`，不能改写通道或触发降级；较新的 main 提交尚未通过质量门时，通道仍可提升到最近一个已经通过的祖先提交。

## 检测与预拉取

管理员可以启用 Manager 轮询或手工检查。迁移前已经配置的签名 Platform webhook 可以继续作为兼容触发器，但在容器模式下它只能向 Manager 提交一次 release channel 检查；不得启动 Git updater、读取 worktree 或执行 `deploy.sh`。发现比当前 generation 更新的清单后，管理器先校验协议、架构、磁盘与 digest，再在平台仍可使用时预拉取所有镜像。下载失败只记录候选错误，不进入维护。

本机 `releases/<source-commit>/` 也是不可变身份：Manager 必须先把 manifest 与 Compose 下载到同目录 staging，完整校验后原子发布。相同 commit 再次出现时，两个文件必须逐字节一致；缺件或内容不同视为 immutable-ID collision，并在拉镜像和进入维护前失败，不能覆盖 current/rollback 所引用的发布物。

镜像就绪后公开 state 进入 `waiting_for_tasks`。Platform 继续服务，直到确认没有活动 Agent Run、queued/running Agent job、消息或知识写入准入窗口、正在执行的 Cognee 摄取与 Telegram 外发、Manager 已登记的运行中后台终端或其它不可安全切换的业务任务。Manager 必须先检查本地 ProcessManager；只要 host 或 Sandbox 中任一已登记后台终端仍在运行（包括声明为 `terminate` 的进程），就保持 `waiting_for_tasks`、不请求 Platform reservation，并在本地进程清零后自动重试。只有本地检查通过后，Manager 才请求 Platform 在对话锁内原子复核 Agent 任务并建立 reservation。后台终端视为仍在运行的任务：Manager 不终止它，也不开始固定栈或自身更新；进程结束后排队的更新自动继续。如果目标版本要求重建该 Sandbox，则仍只在该 Sandbox 空闲后刷新镜像。

## 原子准入与维护

Platform 继续拥有业务空闲判断。管理器使用内部 token 请求 readiness/reserve，Platform 在对话锁内完成最后检查并持久化 reservation。预约成功后所有新 Agent 消息在持久化/入队边界前收到维护响应，不存在已写消息却未建 job 的窗口。每个容器 Platform 进程必须在启动任何 Agent、知识摄取、计划任务或 Telegram worker 前，从 Manager owner socket 恢复当前持久 maintenance/finalize reservation 及其 operation id；Manager 状态不可读时容器启动失败，不能把未知状态解释为空闲。只有 Manager 对同一 operation 明确 release 后才恢复这些 worker，因此候选 readiness 窗口和宿主重启都不会产生随后被快照回滚抹除的新副作用。

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

旧源码实例只保留一次桥接更新：先正常部署桥接代码并恢复产品，待完整 Docker 清单发布后再自动执行第二次维护切换。这样镜像构建速度不会把第一次 Git 更新长时间困在维护页。

桥接迁移成功并清理源码后，Git updater、dirty-tree、fast-forward 和 `git reset` 不再属于部署协议。仓库中的桥接兼容实现应在已部署实例完成迁移后的清理版本移除；新安装始终从管理器开始。

## 管理接口与测试

正常管理面板展示当前/目标版本、digest 摘要、operation、phase、下载与健康状态；失败恢复使用宿主 CLI。公共维护页只展示 operation id 和安全摘要。

测试至少覆盖预拉取失败、任务等待、消息准入竞态、重复 operation、并发冲突、每个 phase 断电、数据库快照恢复、Docker daemon 重启、管理器自更新失败、旧 generation 回滚、Sandbox 后台进程保留和维护入口连续可用。
